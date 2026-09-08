#!/usr/bin/env node
//
// Conformance runner for DIP-06 (../06.md) and DIP-05 (../05.md).
//
//   node run.js --base http://localhost:8080
//   node run.js --base http://localhost:8080 --group core,caching
//   node run.js --base http://localhost:8080 --group corpus     # needs corpus.json ingested
//   node run.js --canonicalizer 'node my-client-canonicalize.js' --group canonical
//
// Everything this knows about the spec is in fixtures.json. This file is a
// harness, not a second copy of the spec: a runner in another language reads
// the same fixtures and reimplements the dozen primitives below.
//
// Output is TAP-ish. Exit status is 0 if every selected case passed.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// The body transport's content type. Not JSON: the body is the same query
// string the GET carries, per DIP-06.
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

// MARK: - Arguments

function parse_args(argv) {
  const args = {
    base: null,
    path: '/req',
    fixtures: path.join(__dirname, 'fixtures.json'),
    corpus: path.join(__dirname, 'corpus.json'),
    groups: null,
    skip: [],
    canonicalizer: null,
    encoder: null,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    switch (arg) {
      case '--base': args.base = next().replace(/\/$/, ''); break
      case '--path': args.path = next(); break
      case '--fixtures': args.fixtures = next(); break
      case '--corpus': args.corpus = next(); break
      case '--group': args.groups = next().split(','); break
      case '--skip-group': args.skip = next().split(','); break
      case '--canonicalizer': args.canonicalizer = next(); break
      case '--encoder': args.encoder = next(); break
      case '--verbose': case '-v': args.verbose = true; break
      case '--help': case '-h': args.help = true; break
      default: throw new Error(`unknown argument ${arg}`)
    }
  }
  return args
}

const USAGE = `usage: run.js --base <url> [options]

  --base <url>            origin to test, e.g. http://localhost:8080
  --path <path>           resource path (default /req)
  --group <a,b>           only these groups (default: every group except
                          corpus and canonical)
  --skip-group <a,b>      exclude these groups
  --canonicalizer <cmd>   command that reads a query value on stdin and writes
                          its canonical form on stdout; enables the canonical
                          group, which needs no server
  --encoder <cmd>         command that reads a NIP-01 filter as JSON on stdin
                          and writes its canonical nfilter on stdout; enables
                          the encode group, which needs no server
  --fixtures <path>       default ./fixtures.json
  --corpus <path>         default ./corpus.json
  -v, --verbose           print request and response detail for every case

Groups: core, caching, conditional, cors, corpus, canonical, encode.

  corpus     needs the events in corpus.json ingested into the store under
             test, and nothing else matching its queries. Skipped by default.
  canonical  needs --canonicalizer, not a server.
  encode     needs --encoder, not a server. This is how a client that only
             builds queries -- rather than reading them -- gets checked.
`

// MARK: - Assertions

class Fail extends Error {}

function check(condition, message) {
  if (!condition) throw new Fail(message)
}

function show(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

// MARK: - Generated query values
//
// Three generators, so that a deployment with different caps edits `profile` in
// fixtures.json rather than editing fixtures. A second runner implements these
// three functions and nothing else.

function hex_id(n) {
  return String(n).padStart(64, '0')
}

function generate(kind, profile) {
  switch (kind) {
    case 'field_over_limit':
      return 'kinds=' + Array.from({ length: profile.max_field_elements + 1 }, (_, i) => i).join(',')

    case 'tag_value_over_limit':
      return '%23d=' + 'x'.repeat(profile.max_tag_value_bytes + 1)

    case 'url_over_limit': {
      // Over the URL budget and nothing else: every author is well formed and
      // the count stays well under max_field_elements, so a 400 here would be
      // the wrong refusal rather than a stricter one.
      const per_author = 65 // 64 hex plus a comma
      const count = Math.ceil((profile.max_url_query_bytes + 200) / per_author)
      check(count <= profile.max_field_elements,
        `cannot exceed max_url_query_bytes without also exceeding max_field_elements`)
      return 'authors=' + Array.from({ length: count }, (_, i) => hex_id(i + 1)).join(',')
    }

    default:
      throw new Error(`unknown generator ${kind}`)
  }
}

// MARK: - Decoding an nfilter, for the `matches_filter` check
//
// The runner needs the query it sent as a filter object to check the events
// that came back against it. This is the decoding half of DIP-05 and
// nothing more -- it does not canonicalise, and it is deliberately permissive,
// because a fixture whose query value is meant to be refused reaches it too.

function decode_element(text) {
  return decodeURIComponent(text.replace(/\+/g, ' '))
}

/** The query value as a NIP-01 filter, or null if it is not one. */
function decode_nfilter(query) {
  if (!query) return null
  const filter = {}
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=')
    if (at < 0) return null
    let key, value
    try {
      key = decode_element(pair.slice(0, at))
      value = pair.slice(at + 1)
      if (value === '') return null
      switch (key) {
        case 'ids': case 'authors':
          filter[key] = value.split(',').map(decode_element)
          break
        case 'kinds':
          filter.kinds = value.split(',').map(Number)
          break
        case 'since': case 'until': case 'limit':
          filter[key] = Number(value)
          break
        default:
          if (!/^#[a-zA-Z]$/.test(key)) return null
          filter[key] = value.split(',').map(decode_element)
      }
    } catch {
      return null // a malformed escape; the fixture expects a refusal
    }
  }
  return filter
}

// MARK: - NIP-01 matching, for the `matches_filter` check
//
// Deliberately the whole of it: a check that every returned event matches the
// filter is the difference between testing headers and testing the query.

function tag_values(event, letter) {
  return event.tags.filter((tag) => tag[0] === letter).map((tag) => tag[1])
}

function matches_filter(event, filter) {
  for (const [name, value] of Object.entries(filter)) {
    switch (name) {
      case 'ids': if (!value.includes(event.id)) return false; break
      case 'authors': if (!value.map((v) => v.toLowerCase()).includes(event.pubkey)) return false; break
      case 'kinds': if (!value.includes(event.kind)) return false; break
      case 'since': if (!(event.created_at >= value)) return false; break
      case 'until': if (!(event.created_at <= value)) return false; break
      case 'limit': break
      default: {
        if (!name.startsWith('#')) return false
        const values = tag_values(event, name.slice(1))
        if (!values.some((v) => value.includes(v))) return false
      }
    }
  }
  return true
}

// MARK: - HTTP

async function request(args, spec) {
  // The query string is spliced in as written rather than through
  // `URLSearchParams`, which would re-encode it: the fixture's text IS the
  // query value, escapes and all, and re-encoding `%23d` to `%2523d` would
  // test a different query than the one the fixture states.
  let url = args.base + args.path
  const init = { method: spec.method, headers: { ...(spec.headers || {}) }, redirect: 'manual' }

  if (spec.method === 'GET' || spec.method === 'OPTIONS') {
    if (spec.query !== undefined) url += `?${spec.query}`
  } else if (spec.query !== undefined) {
    init.body = spec.query
    init.headers['Content-Type'] = spec.content_type || FORM_CONTENT_TYPE
  } else if (spec.content_type) {
    init.headers['Content-Type'] = spec.content_type
  }

  const response = await fetch(url, init)
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    etag: response.headers.get('etag'),
  }
}

// MARK: - Header matching
//
//   "value"   exact, case-insensitively for the name
//   "~value"  the header contains this substring
//   "*"       present and non-empty
//   "@key"    the value of profile[key]
//   null      absent

function assert_headers(response, expected, profile) {
  for (const [name, rule] of Object.entries(expected || {})) {
    const actual = response.headers.get(name)
    if (rule === null) {
      check(actual === null, `${name}: expected absent, got ${show(actual)}`)
      continue
    }
    check(actual !== null, `${name}: expected ${show(rule)}, header absent`)
    if (rule === '*') {
      check(actual.length > 0, `${name}: present but empty`)
    } else if (rule.startsWith('~')) {
      check(actual.includes(rule.slice(1)),
        `${name}: expected to contain ${show(rule.slice(1))}, got ${show(actual)}`)
    } else {
      const want = rule.startsWith('@') ? profile[rule.slice(1)] : rule
      check(actual === want, `${name}: expected ${show(want)}, got ${show(actual)}`)
    }
  }
}

// The one caching rule that does not depend on the server's declared profile:
// a query a new event could enter must carry no freshness lifetime. A server is
// free to set every `*_cache_control` in the profile to whatever it likes, so
// this is the only thing standing between the suite and a server that declares
// `public, max-age=3600` for open-ended queries and passes.
function assert_no_freshness(response) {
  const value = response.headers.get('cache-control')
  check(value !== null, 'no Cache-Control at all, so a cache is free to invent a lifetime')

  const directives = value.toLowerCase().split(',').map((one) => one.trim())
  if (directives.includes('no-cache') || directives.includes('no-store')) return

  for (const directive of directives) {
    const match = /^(max-age|s-maxage)=(\d+)$/.exec(directive)
    check(!match || Number(match[2]) === 0,
      `${directive}: this query can be entered by an event published a second from now, ` +
      `so it must carry no freshness lifetime (got ${show(value)})`)
  }
}

function assert_body(response, expect) {
  // A case that asserts only on status and headers -- a preflight, say -- says
  // nothing about the body and gets nothing checked.
  if (!expect.body && !expect.ids) return null

  if (expect.body === 'empty') {
    check(response.text.length === 0, `expected an empty body, got ${show(response.text)}`)
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(response.text)
  } catch (err) {
    throw new Fail(`body is not JSON (${err.message}): ${show(response.text)}`)
  }

  if (expect.body === 'error') {
    check(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      `an error body must be a JSON object, got ${show(parsed)}`)
    check(typeof parsed.error === 'string',
      `an error body must have a string "error" member, got ${show(parsed)}`)
    return parsed
  }

  if (expect.body === 'events' || expect.ids) {
    check(Array.isArray(parsed), `expected a JSON array of events, got ${show(parsed)}`)
    for (const event of parsed) {
      for (const field of ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']) {
        check(event && Object.prototype.hasOwnProperty.call(event, field),
          `an event is missing "${field}": ${show(event)}`)
      }
    }
  }
  return parsed
}

function assert_checks(events, names, context) {
  for (const name of names || []) {
    switch (name) {
      case 'empty':
        check(events.length === 0, `expected no events, got ${events.length}`)
        break

      case 'ordered':
        for (let i = 1; i < events.length; i++) {
          const [a, b] = [events[i - 1], events[i]]
          const ok = b.created_at < a.created_at ||
                     (b.created_at === a.created_at && a.id < b.id)
          check(ok, `not sorted by created_at descending, id ascending at index ${i}: ` +
            `${a.created_at}/${a.id.slice(0, 8)} then ${b.created_at}/${b.id.slice(0, 8)}`)
        }
        break

      case 'unique_ids': {
        const seen = new Set()
        for (const event of events) {
          check(!seen.has(event.id), `event ${event.id.slice(0, 8)} appears more than once`)
          seen.add(event.id)
        }
        break
      }

      case 'within_cap':
        check(events.length <= context.profile.max_events,
          `${events.length} events, over the max_events cap of ${context.profile.max_events}`)
        break

      case 'matches_filter': {
        if (!context.filter) break // the fixture's query value is deliberately unparseable
        for (const event of events) {
          check(matches_filter(event, context.filter),
            `event ${event.id.slice(0, 8)} (kind ${event.kind}) does not match the query`)
        }
        break
      }

      case 'events_match_corpus': {
        check(context.corpus, 'events_match_corpus needs corpus.json')
        for (const event of events) {
          const original = context.corpus.find((e) => e.id === event.id)
          check(original, `event ${event.id.slice(0, 8)} is not in the corpus`)
          check(JSON.stringify(event) === JSON.stringify(original),
            `event ${event.id.slice(0, 8)} was re-encoded:\n  got  ${show(event)}\n  want ${show(original)}`)
        }
        break
      }

      default:
        throw new Error(`unknown check ${name}`)
    }
  }
}

// MARK: - One case

function transports_of(kase) {
  switch (kase.transport) {
    case 'both': return ['GET', 'POST']
    case 'get': return ['GET']
    case 'post': return ['POST']
    case 'options': return ['OPTIONS']
    default: throw new Error(`${kase.name}: unknown transport ${kase.transport}`)
  }
}

async function run_case(args, fixtures, kase, results) {
  const profile = fixtures.profile
  const expect = kase.expect || {}

  let query
  if (kase.generate) query = generate(kase.generate, profile)
  else if (!kase.omit_query && !kase.omit_body) query = kase.query

  // A fixture whose query value is deliberately malformed decodes to null, and
  // `matches_filter` skips rather than failing on it.
  const filter = decode_nfilter(query)

  const responses = []
  for (const method of transports_of(kase)) {
    let headers = { ...(kase.request_headers || {}) }

    // A conditional case is two requests: one to learn the validator, one to
    // present it.
    if (kase.if_none_match) {
      const first = await request(args, { method, query, headers: kase.request_headers })
      check(first.etag, `no ETag on the unconditional request, so If-None-Match cannot be tested`)
      headers['If-None-Match'] = kase.if_none_match.replace('@etag', first.etag)
    }

    const response = await request(args, {
      method,
      query,
      headers,
      content_type: kase.content_type,
    })

    if (args.verbose) {
      console.log(`#   ${method} ${show(query)} -> ${response.status} ${show(response.text)}`)
    }

    const wanted = Array.isArray(expect.status) ? expect.status : [expect.status]
    check(wanted.includes(response.status),
      `expected status ${wanted.join(' or ')}, got ${response.status}: ${show(response.text)}`)

    // An "either answer is conforming" case only asserts further on the
    // branch it actually took.
    const permissive = Array.isArray(expect.status) && response.status >= 400
    if (!permissive) {
      assert_headers(response, expect.headers, profile)
      if (expect.no_freshness) assert_no_freshness(response)
      const body = assert_body(response, expect)
      if (Array.isArray(body)) {
        assert_checks(body, expect.checks, {
          profile,
          filter,
          corpus: fixtures.corpus,
        })
        if (expect.ids) {
          const got = body.map((event) => event.id)
          check(JSON.stringify(got) === JSON.stringify(expect.ids),
            `expected ids\n  ${expect.ids.join('\n  ')}\ngot\n  ${got.join('\n  ') || '(none)'}`)
        }
      }
    }

    responses.push({ method, response })
  }

  // "One shape, two transports" is a claim the suite gets to check for free.
  if (responses.length === 2) {
    const [a, b] = responses
    check(a.response.text === b.response.text,
      `GET and POST answered differently:\n  GET  ${show(a.response.text)}\n  POST ${show(b.response.text)}`)
    for (const header of ['etag', 'cache-control']) {
      check(a.response.headers.get(header) === b.response.headers.get(header),
        `GET and POST disagree on ${header}: ` +
        `${show(a.response.headers.get(header))} vs ${show(b.response.headers.get(header))}`)
    }
  }

  const primary = responses[0].response
  results.set(kase.name, primary)

  if (kase.same_as) {
    const other = results.get(kase.same_as)
    check(other, `same_as names ${kase.same_as}, which did not run`)
    check(primary.text === other.text,
      `two spellings of one query answered differently:\n  ${show(primary.text)}\n  ${show(other.text)}`)
    for (const header of ['etag', 'cache-control']) {
      check(primary.headers.get(header) === other.headers.get(header),
        `two spellings of one query disagree on ${header}: ` +
        `${show(primary.headers.get(header))} vs ${show(other.headers.get(header))}`)
    }
  }

  if (kase.differs_from) {
    const other = results.get(kase.differs_from)
    check(other, `differs_from names ${kase.differs_from}, which did not run`)
    check(primary.headers.get('etag') !== other.headers.get('etag'),
      `two different queries share an ETag (${show(primary.headers.get('etag'))}), ` +
      `so a client cannot tell their answers apart by validator`)
  }
}

// MARK: - Canonical form, which needs no server

function run_canonical_case(args, kase) {
  const got = execSync(args.canonicalizer, { input: kase.input, encoding: 'utf8' }).trim()
  check(got === kase.canonical,
    `canonical form differs:\n  got  ${got}\n  want ${kase.canonical}`)
}

// MARK: - Encoding, which also needs no server
//
// The canonical group checks a decoder: query value in, canonical query value
// out. A client that only ever *builds* a query has no decoder to check, and is
// exactly where a canonical-form mistake costs a silent cache miss. So this
// group goes the other way: a NIP-01 filter as JSON in, a canonical nfilter out.

function run_encode_case(args, kase) {
  const got = execSync(args.encoder, {
    input: JSON.stringify(kase.filter), encoding: 'utf8',
  }).trim()
  check(got === kase.canonical,
    `encoding differs:\n  got  ${got}\n  want ${kase.canonical}`)
}

// MARK: - Main

const DEFAULT_SKIPPED = ['corpus', 'canonical', 'encode']

async function main() {
  let args
  try {
    args = parse_args(process.argv.slice(2))
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(USAGE)
    return
  }

  const fixtures = JSON.parse(fs.readFileSync(args.fixtures, 'utf8'))
  if (fs.existsSync(args.corpus)) {
    fixtures.corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8'))
  }

  const selected = (group) => {
    if (args.skip.includes(group)) return false
    if (args.groups) return args.groups.includes(group)
    return !DEFAULT_SKIPPED.includes(group)
  }

  const server_cases = fixtures.cases.filter((kase) => selected(kase.group))
  const canonical_cases = selected('canonical') ? (fixtures.canonical_cases || []) : []
  const encode_cases = selected('encode') ? (fixtures.encode_cases || []) : []

  if (server_cases.length && !args.base) {
    console.error(`--base is required to run server cases\n\n${USAGE}`)
    process.exit(2)
  }
  if (canonical_cases.length && !args.canonicalizer) {
    console.error(`--canonicalizer is required to run the canonical group\n\n${USAGE}`)
    process.exit(2)
  }
  if (encode_cases.length && !args.encoder) {
    console.error(`--encoder is required to run the encode group\n\n${USAGE}`)
    process.exit(2)
  }

  const total = server_cases.length + canonical_cases.length + encode_cases.length
  console.log(`1..${total}`)

  const results = new Map()
  let number = 0
  let failed = 0

  for (const kase of server_cases) {
    number++
    try {
      await run_case(args, fixtures, kase, results)
      console.log(`ok ${number} - ${kase.name}`)
    } catch (err) {
      failed++
      console.log(`not ok ${number} - ${kase.name}`)
      console.log(`  ---`)
      console.log(`  group: ${kase.group}`)
      console.log(`  spec: ${kase.section}`)
      if (kase.note) console.log(`  note: ${kase.note}`)
      for (const line of String(err.message).split('\n')) console.log(`  ${line}`)
      console.log(`  ...`)
    }
  }

  for (const kase of canonical_cases) {
    number++
    try {
      run_canonical_case(args, kase)
      console.log(`ok ${number} - canonical: ${kase.name}`)
    } catch (err) {
      failed++
      console.log(`not ok ${number} - canonical: ${kase.name}`)
      console.log(`  ---`)
      if (kase.note) console.log(`  note: ${kase.note}`)
      for (const line of String(err.message).split('\n')) console.log(`  ${line}`)
      console.log(`  ...`)
    }
  }

  for (const kase of encode_cases) {
    number++
    try {
      run_encode_case(args, kase)
      console.log(`ok ${number} - encode: ${kase.name}`)
    } catch (err) {
      failed++
      console.log(`not ok ${number} - encode: ${kase.name}`)
      console.log(`  ---`)
      if (kase.note) console.log(`  note: ${kase.note}`)
      for (const line of String(err.message).split('\n')) console.log(`  ${line}`)
      console.log(`  ...`)
    }
  }

  console.log(`# ${total - failed}/${total} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
