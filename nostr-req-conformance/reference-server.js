#!/usr/bin/env node
//
// A reference implementation of DIP-06 (../06.md) and DIP-05 (../05.md), in
// memory.
//
//   node reference-server.js --port 8080 [--corpus corpus.json]
//   echo 'kinds=1&limit=10' | node reference-server.js --canonicalize
//   echo '{"kinds":[1],"limit":10}' | node reference-server.js --encode
//
// This is NOT a production server: no rate limiting, no persistence, a linear
// scan of the store, and it trusts the corpus rather than verifying signatures.
//
// It exists so the conformance suite can be shown to do something. A fixture
// that no implementation has ever failed is a fixture nobody has checked is
// reachable; with this here, `run.js` can be pointed at a known-good server to
// see it go green, and at a deliberately broken one -- drop the id tiebreak, or
// the re-encoding in `canonicalize` -- to see the case that catches it go red.
//
// It doubles as the `--canonicalizer` and the `--encoder` for the two groups
// that need no server.

const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'))
const PROFILE = FIXTURES.profile

const ADDRESSABLE = (kind) => kind >= 30000 && kind <= 39999
const ALLOWED_ORIGINS = ['https://damus.io', 'http://localhost:3000']

// The body transport's content type. Also CORS-safelisted, which is why a
// cross-origin POST here is a simple request; QUERY is preflighted regardless.
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

// MARK: - Canonicalisation
//
// DIP-05. The whole of it: decode, validate, re-encode.

class Refused extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

/** Everything outside RFC 3986's `unreserved` is escaped, with uppercase hex. */
function encode_element(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

/**
 * `+` is a space, per application/x-www-form-urlencoded, and the substitution
 * has to happen before the percent-decoding or `%2B` would become one too.
 */
function decode_element(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    throw new Refused(`${JSON.stringify(text)} is not valid percent-encoded UTF-8`)
  }
}

// Encoded elements are ASCII, so a bytewise comparison is the default string
// comparison -- which is the reason DIP-05 orders on the encoded text
// rather than on the decoded values, where JavaScript's default sort compares
// UTF-16 code units and is wrong outside the BMP.
function by_bytes(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function unique(values, compare) {
  return [...values].sort(compare).filter((value, i, all) => i === 0 || compare(all[i - 1], value) !== 0)
}

function integer(name, text) {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Refused(`${name} must be a non-negative integer, got ${JSON.stringify(text)}`)
  }
  return Number(text)
}

function elements(name, value) {
  const parts = value.split(',')
  if (parts.length > PROFILE.max_field_elements) {
    throw new Refused(`${name} has ${parts.length} elements, over the ${PROFILE.max_field_elements} limit`)
  }
  if (parts.some((part) => part === '')) throw new Refused(`${name} has an empty element`)
  return parts
}

function hex_set(name, value) {
  return unique(elements(name, value).map((element) => {
    if (!/^[0-9a-fA-F]{64}$/.test(element)) {
      throw new Refused(`${name} values must be 64 hex characters`)
    }
    return element.toLowerCase()
  }), by_bytes)
}

/**
 * A query string to `{ text, filter }` -- the canonical form, and the filter it
 * denotes with its tag values decoded, which is what `query` matches against.
 */
function canonicalize(text) {
  const query = text.trim()
  if (query === '') throw new Refused('a filter query string is required')

  const pairs = []
  const filter = {}
  const seen = new Set()

  for (const pair of query.split('&')) {
    const at = pair.indexOf('=')
    if (at < 0) throw new Refused(`${JSON.stringify(pair)} is not a key=value pair`)

    const key = decode_element(pair.slice(0, at))
    const value = pair.slice(at + 1)
    if (seen.has(key)) {
      throw new Refused(`${key} appears twice; join the values with a comma instead`)
    }
    seen.add(key)
    if (value === '') throw new Refused(`${key} must not be empty`)

    switch (key) {
      case 'ids': case 'authors': {
        const set = hex_set(key, value)
        pairs.push([key, set.join(',')])
        filter[key] = set
        break
      }
      case 'kinds': {
        const set = unique(elements(key, value).map((k) => integer('kinds', k)), (a, b) => a - b)
        pairs.push([key, set.join(',')])
        filter.kinds = set
        break
      }
      case 'since': case 'until': {
        const n = integer(key, value)
        pairs.push([key, String(n)])
        filter[key] = n
        break
      }
      case 'limit': {
        // Clamped here, not at query time, so every over-cap limit is one key.
        const n = Math.min(integer(key, value), PROFILE.max_events)
        pairs.push([key, String(n)])
        filter.limit = n
        break
      }
      case 'search': case 'relays':
        // Defined by nfilter, not implemented here. Refused rather than
        // ignored: answering without the constraint answers a different
        // question.
        throw new Refused(`${key} is part of the nfilter encoding but is not served here`)
      default: {
        if (!/^#[a-zA-Z]$/.test(key)) throw new Refused(`unknown field ${JSON.stringify(key)}`)
        const decoded = elements(key, value).map((element) => {
          const one = decode_element(element)
          if (Buffer.byteLength(one) > PROFILE.max_tag_value_bytes) {
            throw new Refused(`a ${key} value is over the ${PROFILE.max_tag_value_bytes} byte limit`)
          }
          return one
        })
        // Re-encoded rather than kept as it arrived, so that `%2c` and `%2C`,
        // and an escape that was never needed, are all one element.
        const encoded = unique(decoded.map(encode_element), by_bytes)
        pairs.push([`%23${key.slice(1)}`, encoded.join(',')])
        filter[key] = encoded.map(decode_element)
      }
    }
  }

  pairs.sort((a, b) => by_bytes(a[0], b[0]))
  return { text: pairs.map(([key, value]) => `${key}=${value}`).join('&'), filter }
}

/**
 * A NIP-01 filter as JSON to a canonical nfilter -- the `--encoder` contract.
 *
 * Assembled naively and then handed to `canonicalize`, rather than sorted here:
 * a second copy of the ordering rules is a second place for them to be wrong,
 * and this is the file the suite is meant to be demonstrably correct in.
 */
function encode(filter) {
  const pairs = Object.entries(filter).map(([key, value]) => {
    const name = /^#[a-zA-Z]$/.test(key) ? `%23${key.slice(1)}` : key
    const text = Array.isArray(value)
      ? value.map((one) => encode_element(String(one))).join(',')
      : String(value)
    return `${name}=${text}`
  })
  if (pairs.length === 0) throw new Refused('a filter with no fields has no encoding')
  return canonicalize(pairs.join('&')).text
}

// MARK: - Query

function tag_values(event, letter) {
  return event.tags.filter((tag) => tag[0] === letter).map((tag) => tag[1])
}

function matches(event, filter) {
  for (const [name, value] of Object.entries(filter)) {
    if (name === 'ids' && !value.includes(event.id)) return false
    if (name === 'authors' && !value.includes(event.pubkey)) return false
    if (name === 'kinds' && !value.includes(event.kind)) return false
    if (name === 'since' && event.created_at < value) return false
    if (name === 'until' && event.created_at > value) return false
    if (name.startsWith('#')) {
      const values = tag_values(event, name.slice(1))
      if (!values.some((one) => value.includes(one))) return false
    }
  }
  return true
}

function newest_first(a, b) {
  return b.created_at - a.created_at || by_bytes(a.id, b.id)
}

function query(store, filter) {
  const limit = filter.limit === undefined ? PROFILE.max_events : filter.limit
  return store
    .filter((event) => matches(event, filter))
    .sort(newest_first)
    .slice(0, Math.min(limit, PROFILE.max_events))
}

function cacheability(filter, now) {
  if (filter.until !== undefined && filter.until <= now) return 'anchored'
  const pinned = filter.kinds && filter.kinds.length > 0 && filter.kinds.every(ADDRESSABLE) &&
    filter.authors && filter.authors.length > 0 &&
    filter['#d'] && filter['#d'].length > 0
  return pinned ? 'addressable' : 'open_ended'
}

function etag_of(events) {
  const hash = crypto.createHash('sha256')
  for (const event of events) hash.update(Buffer.from(event.id, 'hex'))
  return `"${hash.digest('hex')}"`
}

function if_none_match(header, etag) {
  if (!header) return false
  if (header.trim() === '*') return true
  return header.split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag)
}

// MARK: - HTTP

function cors_headers(request, preflight) {
  const origin = request.headers.origin
  const headers = { Vary: preflight ? 'Origin, Access-Control-Request-Headers' : 'Origin' }
  if (origin && ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function send(response, status, headers, body) {
  response.writeHead(status, headers)
  response.end(body)
}

function refuse(request, response, error) {
  send(response, error.status || 400,
    { 'Content-Type': 'application/json', ...cors_headers(request, false) },
    JSON.stringify({ error: error.message }))
}

function serve(store, request, response) {
  const url = new URL(request.url, 'http://localhost')

  if (url.pathname !== '/req') {
    return send(response, 404, cors_headers(request, false), '')
  }

  if (request.method === 'OPTIONS') {
    const headers = {
      ...cors_headers(request, true),
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,QUERY',
      'Content-Length': '0',
    }
    if (request.headers['access-control-request-headers']) {
      headers['Access-Control-Allow-Headers'] = request.headers['access-control-request-headers']
    }
    return send(response, 204, headers, '')
  }

  const answer = (text) => {
    let canonical
    try {
      canonical = canonicalize(text)
    } catch (err) {
      return refuse(request, response, err)
    }

    const events = query(store, canonical.filter)
    const etag = etag_of(events)
    const cache_control = PROFILE[`${cacheability(canonical.filter, Math.floor(Date.now() / 1000))}_cache_control`]
    const headers = {
      'Content-Type': 'application/json',
      ETag: etag,
      'Cache-Control': cache_control,
      ...cors_headers(request, false),
    }

    if (if_none_match(request.headers['if-none-match'], etag)) {
      return send(response, 304, headers, '')
    }
    // Serialised as stored: re-encoding an event is how a signature stops
    // verifying at the client.
    send(response, 200, headers, `[${events.map((event) => event.json).join(',')}]`)
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    // The raw query string, not `searchParams`: it IS the query value, and
    // round-tripping it through `URLSearchParams` would re-encode it.
    const query_string = url.search.startsWith('?') ? url.search.slice(1) : url.search
    if (query_string === '') {
      return refuse(request, response, new Refused('a filter query string is required'))
    }
    if (Buffer.byteLength(query_string) > PROFILE.max_url_query_bytes) {
      return refuse(request, response, new Refused(
        `the query string is ${Buffer.byteLength(query_string)} bytes, over the ` +
        `${PROFILE.max_url_query_bytes} byte limit; POST the same query string instead, ` +
        `as ${FORM_CONTENT_TYPE}`, 414))
    }
    return answer(query_string)
  }

  if (request.method === 'POST' || request.method === 'QUERY') {
    const type = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (type !== FORM_CONTENT_TYPE) {
      return refuse(request, response, new Refused(
        `a filter query string is required as the request body, with Content-Type: ${FORM_CONTENT_TYPE}`))
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      if (body.length === 0) {
        return refuse(request, response, new Refused('the request body is required'))
      }
      answer(body.toString('utf8'))
    })
    return
  }

  send(response, 405, cors_headers(request, false), '')
}

// MARK: - Main

function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--canonicalize')) {
    const input = fs.readFileSync(0, 'utf8')
    process.stdout.write(canonicalize(input).text + '\n')
    return
  }

  if (argv.includes('--encode')) {
    const input = fs.readFileSync(0, 'utf8')
    process.stdout.write(encode(JSON.parse(input)) + '\n')
    return
  }

  const port = Number(argv[argv.indexOf('--port') + 1]) || 8080
  const corpus_at = argv.includes('--corpus')
    ? argv[argv.indexOf('--corpus') + 1]
    : path.join(__dirname, 'corpus.json')

  let store = []
  if (fs.existsSync(corpus_at)) {
    // `json` is the event exactly as it arrived, which is what gets served.
    store = JSON.parse(fs.readFileSync(corpus_at, 'utf8'))
      .map((event) => ({ ...event, json: JSON.stringify(event) }))
  }

  http.createServer((request, response) => serve(store, request, response))
    .listen(port, () => console.error(`reference server on :${port}, ${store.length} events`))
}

main()
