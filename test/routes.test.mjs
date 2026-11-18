import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_BODY_BYTES, mountRoutes, parseSessionId, parseThreshold, parseWindow } from '../routes.js'

/** Fake composition: a route table and a fence that rejects forged Host headers. */
function createComposition() {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    connection: {
      requestRejection(req) {
        return req.headers.host === 'evil.example' ? 403 : undefined
      },
    },
  }
  return { ctx, routes }
}

/** A host policy facade with the same shape index.js supplies. */
function createApi() {
  const calls = []
  return {
    calls,
    defaultPercent: () => 60,
    minPercent: () => 30,
    setDefaultPercent(percent) { calls.push(['default', percent]); return true },
    allowForce: () => false,
    setAllowForce(value) { calls.push(['force', value]); return true },
    describeSession(id) {
      return {
        id,
        threshold: { kind: 'percent', percent: 55 },
        pending: false,
        status: 'ok',
        percent: 55,
        thresholdTokens: 576_716,
        rail: 727_040,
        railPercent: 69.3,
        maxPercent: 67,
        clamped: false,
        last: null,
      }
    },
    setSessionThreshold(id, threshold) { calls.push(['session', id, threshold]); return { id, threshold } },
  }
}

/** Issue one request against a registered route. */
async function call(routes, path, { method = 'GET', headers = {}, body, url } = {}) {
  const route = routes.get(path)
  assert.ok(route, `no route for ${path}`)
  const req = {
    method,
    url: url ?? path,
    headers: { host: '127.0.0.1:59593', 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
    resume() {},
  }
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(payload) { this.body = payload === undefined ? '' : String(payload) },
  }
  await route.handler(req, res)
  return {
    status: res.statusCode,
    headers: res.headers,
    json: res.body === undefined || res.body === '' ? undefined : JSON.parse(res.body),
    raw: res.body,
  }
}

test('GET /state returns the default and the session view', async () => {
  const { ctx, routes } = createComposition()
  mountRoutes(ctx, createApi())
  const all = await call(routes, '/smart-compact/state')
  assert.equal(all.status, 200)
  assert.equal(all.headers['cache-control'], 'no-store')
  assert.equal(all.json.defaultPercent, 60)
  assert.equal(all.json.allowForce, false)
  assert.equal(all.json.session, null)

  const withId = await call(routes, '/smart-compact/state', {
    url: '/smart-compact/state?sessionId=session-1',
  })
  assert.equal(withId.status, 200)
  assert.equal(withId.json.session.id, 'session-1')
  assert.equal(withId.json.session.maxPercent, 67)
})

test('an invalid sessionId or a non-GET method is refused', async () => {
  const { ctx, routes } = createComposition()
  mountRoutes(ctx, createApi())
  const bad = await call(routes, '/smart-compact/state', {
    url: '/smart-compact/state?sessionId=../etc',
  })
  assert.equal(bad.status, 400)
  const post = await call(routes, '/smart-compact/state', { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('the trust fence rejects a forged Host before any work', async () => {
  const { ctx, routes } = createComposition()
  const api = createApi()
  mountRoutes(ctx, api)
  const forged = await call(routes, '/smart-compact/state', { headers: { host: 'evil.example' } })
  assert.equal(forged.status, 403)
  assert.equal(forged.raw, '')
  const write = await call(routes, '/smart-compact/default', {
    method: 'POST',
    headers: { host: 'evil.example' },
    body: '{"defaultPercent":50}',
  })
  assert.equal(write.status, 403)
  assert.equal(api.calls.length, 0, 'a rejected request must not reach the policy')
})

test('POST /session validates and applies a threshold', async () => {
  const { ctx, routes } = createComposition()
  const api = createApi()
  mountRoutes(ctx, api)
  const ok = await call(routes, '/smart-compact/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-9', threshold: { kind: 'percent', percent: 55 } }),
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json.threshold, { kind: 'percent', percent: 55 })
  assert.deepEqual(api.calls.at(-1), ['session', 'session-9', { kind: 'percent', percent: 55 }])

  const badKind = await call(routes, '/smart-compact/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-9', threshold: { kind: 'wat' } }),
  })
  assert.equal(badKind.status, 400)

  const badPercent = await call(routes, '/smart-compact/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-9', threshold: { kind: 'percent', percent: 140 } }),
  })
  assert.equal(badPercent.status, 400)

  const noId = await call(routes, '/smart-compact/session', {
    method: 'POST',
    body: JSON.stringify({ threshold: { kind: 'off' } }),
  })
  assert.equal(noId.status, 400)

  const off = await call(routes, '/smart-compact/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-9', threshold: { kind: 'off' } }),
  })
  assert.equal(off.status, 200)
})

test('POST /default validates media type, size, and range', async () => {
  const { ctx, routes } = createComposition()
  const api = createApi()
  mountRoutes(ctx, api)

  const wrongType = await call(routes, '/smart-compact/default', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(wrongType.status, 415)

  const tooBig = await call(routes, '/smart-compact/default', {
    method: 'POST',
    body: JSON.stringify({ defaultPercent: 55, pad: 'x'.repeat(MAX_BODY_BYTES) }),
  })
  assert.equal(tooBig.status, 413)

  const notJson = await call(routes, '/smart-compact/default', { method: 'POST', body: 'not json' })
  assert.equal(notJson.status, 400)

  const outOfRange = await call(routes, '/smart-compact/default', {
    method: 'POST',
    body: JSON.stringify({ defaultPercent: 10 }),
  })
  assert.equal(outOfRange.status, 400)

  const ok = await call(routes, '/smart-compact/default', {
    method: 'POST',
    body: JSON.stringify({ defaultPercent: 50 }),
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { defaultPercent: 50 })
  assert.deepEqual(api.calls.at(-1), ['default', 50])
})

test('POST /force toggles the bypass switch and validates its body', async () => {
  const { ctx, routes } = createComposition()
  const api = createApi()
  mountRoutes(ctx, api)

  const on = await call(routes, '/smart-compact/force', { method: 'POST', body: '{"allowForce":true}' })
  assert.equal(on.status, 200)
  assert.deepEqual(on.json, { allowForce: true })
  assert.deepEqual(api.calls.at(-1), ['force', true])

  const bad = await call(routes, '/smart-compact/force', { method: 'POST', body: '{"allowForce":"yes"}' })
  assert.equal(bad.status, 400)

  const read = await call(routes, '/smart-compact/force')
  assert.equal(read.status, 405)
  assert.equal(read.headers.allow, 'POST')
})

test('the disposer removes every route', () => {
  const { ctx, routes } = createComposition()
  const dispose = mountRoutes(ctx, createApi())
  assert.equal(routes.size, 4)
  dispose()
  assert.equal(routes.size, 0)
})

test('wire parsers reject malformed values', () => {
  assert.equal(parseSessionId('a'.repeat(129)), null)
  assert.equal(parseSessionId('-lead'), null)
  assert.equal(parseSessionId('session-1'), 'session-1')
  assert.equal(parseThreshold({ kind: 'percent', percent: 30.5 }), null)
  assert.equal(parseThreshold({ kind: 'percent', percent: 0 }), null)
  assert.deepEqual(parseThreshold({ kind: 'default' }), { kind: 'default' })
  assert.equal(parseWindow(null), undefined)
  assert.equal(parseWindow('0'), undefined)
  assert.equal(parseWindow('abc'), undefined)
  assert.equal(parseWindow('1048576'), 1_048_576)
})

test('a window hint lets the panel describe a session with no live request', async () => {
  const { ctx, routes } = createComposition()
  const api = {
    ...createApi(),
    describeSession(id, hint) { return { id, window: hint ?? null } },
  }
  mountRoutes(ctx, api)
  const plain = await call(routes, '/smart-compact/state', { url: '/smart-compact/state?sessionId=s1' })
  assert.equal(plain.json.session.window, null)
  const hinted = await call(routes, '/smart-compact/state', {
    url: '/smart-compact/state?sessionId=s1&window=1048576',
  })
  assert.equal(hinted.json.session.window, 1_048_576)
})
