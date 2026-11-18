/**
 * Host routes for the Smart Compact settings surface.
 *
 * The page is same-origin with the Web app, so the browser's session cookie is
 * present; the trust fence is delegated to the composition's `connection`
 * service exactly as `@deepseek-ai/dsh-host-open-in-app` does — its Host/Origin
 * check defeats DNS rebinding and cross-site calls, and its cookie check gates
 * every request before any value is read or written.
 *
 * Kept free of Harness imports so the wire contract stays testable with plain
 * Node.
 *
 * @module @local/dsh-smart-compact/routes
 */

/** Largest body any route accepts; the payloads are three small numbers. */
export const MAX_BODY_BYTES = 8 * 1024

/** Session ids are opaque, but never long or exotic enough to escape a map key. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/**
 * Read one bounded request body as text.
 * @param {import('node:http').IncomingMessage} req request
 * @returns {Promise<string | null>} body text, or null past the ceiling
 */
export async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one session id from a query string or a body.
 * @param {unknown} value candidate
 * @returns {string | null} the id, or null when it is not acceptable
 */
export function parseSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null
}

/**
 * Normalize a threshold from the wire.
 * @param {unknown} value candidate
 * @returns {{ kind: 'default' } | { kind: 'percent', percent: number } | { kind: 'off' } | null}
 */
export function parseThreshold(value) {
  if (!value || typeof value !== 'object') return null
  if (value.kind === 'default') return { kind: 'default' }
  if (value.kind === 'off') return { kind: 'off' }
  if (value.kind === 'percent' && Number.isInteger(value.percent) && value.percent >= 1 && value.percent <= 100) {
    return { kind: 'percent', percent: value.percent }
  }
  return null
}

/**
 * Normalize the global default percent from the wire.
 * @param {unknown} value candidate
 * @param {number} min lowest allowed percent
 * @returns {number | null} the percent, or null when unacceptable
 */
export function parsePercent(value, min) {
  return Number.isInteger(value) && value >= min && value <= 100 ? value : null
}

/**
 * Normalize a context-window hint from a query string.
 * @param {string | null} value raw query value
 * @returns {number | undefined} a positive integer, or undefined
 */
export function parseWindow(value) {
  if (value === null) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000_000 ? parsed : undefined
}

/**
 * Mount the three routes behind the trust fence.
 *
 * @param {import('@deepseek-ai/cordis').Context} composition context exposing webServer and connection
 * @param {object} api host policy facade
 * @param {() => number} api.defaultPercent current global default
 * @param {(percent: number) => boolean} api.setDefaultPercent persist a new global default
 * @param {() => number} api.minPercent lowest allowed percent
 * @param {(sessionId: string) => object} api.describeSession thresholds for one session
 * @param {(sessionId: string, threshold: object) => object} api.setSessionThreshold stage a session threshold
 * @param {string} [api.prefix] route prefix
 * @returns {() => void} disposer removing every route
 */
export function mountRoutes(ctx, api) {
  const prefix = api.prefix ?? '/smart-compact'
  const disposers = []

  const rejected = (req, res) => {
    let rejection
    try {
      rejection = ctx.connection.requestRejection(req)
    } catch {
      // A fence that cannot answer must not become an open door.
      rejection = 403
    }
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const sendJson = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  const allow = (res, method) => {
    res.statusCode = 405
    res.setHeader('allow', method)
    res.end()
  }

  /** Shared body handling: JSON content type, bounded size, parsed object. */
  const readJson = async (req, res) => {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (essence !== 'application/json') {
      sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return undefined
    }
    let text
    try {
      text = await readBoundedBody(req)
    } catch {
      sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
      return undefined
    }
    if (text === null) {
      sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
      return undefined
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Falls through to the single bad-request answer below.
    }
    sendJson(res, 400, { code: 'bad-request', message: 'request body must be a JSON object' })
    return undefined
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/state`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        allow(res, 'GET')
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const raw = url.searchParams.get('sessionId')
      const sessionId = raw === null ? null : parseSessionId(raw)
      if (raw !== null && sessionId === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'sessionId is not a valid id' })
        return
      }
      // The browser reads the context window from its own projection; the Host
      // uses it only when its own session cannot report one. Display only: the
      // agent's own measurement still decides when compaction fires.
      const windowHint = parseWindow(url.searchParams.get('window'))
      sendJson(res, 200, {
        defaultPercent: api.defaultPercent(),
        minPercent: api.minPercent(),
        session: sessionId === null ? null : api.describeSession(sessionId, windowHint),
      })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/session`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        allow(res, 'POST')
        return
      }
      const body = await readJson(req, res)
      if (body === undefined) return
      const sessionId = parseSessionId(body.sessionId)
      if (sessionId === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'sessionId is required' })
        return
      }
      const threshold = parseThreshold(body.threshold)
      if (threshold === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'threshold must be default, off, or percent 1-100' })
        return
      }
      sendJson(res, 200, api.setSessionThreshold(sessionId, threshold))
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/default`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        allow(res, 'POST')
        return
      }
      const body = await readJson(req, res)
      if (body === undefined) return
      const percent = parsePercent(body.defaultPercent, api.minPercent())
      if (percent === null) {
        sendJson(res, 400, { code: 'bad-request', message: `defaultPercent must be an integer from ${api.minPercent()} to 100` })
        return
      }
      if (!api.setDefaultPercent(percent)) {
        sendJson(res, 500, { code: 'persist-failed', message: 'the default could not be saved' })
        return
      }
      sendJson(res, 200, { defaultPercent: percent })
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Unloading must continue past a failing route disposer.
      }
    }
  }
}
