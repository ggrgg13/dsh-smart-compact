import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-smart-compact-test-'))
const { apply } = await import('../index.js')

const WINDOW = 1_048_576
const RESERVED = 256_000
/** 60% of the flash window, the default suggested line. */
const DEFAULT_LINE = 629_145
let sessionCounter = 0

/**
 * Minimal Cordis-shaped context. Only the surfaces index.js touches are present,
 * so the test exercises the real registration and execution paths without the
 * Harness runtime. Each context gets a fresh session id because policy state is
 * persisted per session and would otherwise leak between cases.
 */
function createContext({ pressure: initialPressure = 700_000, withRoutes = false } = {}) {
  const sessionId = `session-${++sessionCounter}`
  const registered = { section: null, tool: null, command: null, listeners: {}, routes: new Map() }
  const notices = []
  const messages = []
  const compactionCalls = []
  let pressure = initialPressure
  let agent
  const ctx = {
    get(name) {
      if (name === 'tokenMeter') {
        return {
          contextPressure: () => ({ pressureTokens: pressure }),
          measure: () => ({ totalTokens: pressure, nodes: [{ seq: 1, tokens: 1_000 }] }),
        }
      }
      if (name === 'compaction') {
        return {
          config: { thresholdRatio: 0.8, headroomTokens: 65_536 },
          async compactNow(agent, signal) {
            compactionCalls.push({ agent, signal })
            pressure = Math.max(0, pressure - 600_000)
            return { compactionId: 'c1' }
          },
        }
      }
      if (name === 'agents') {
        return { get: (id) => (id === sessionId ? agent : undefined) }
      }
      return undefined
    },
    systemPrompt: { section: (section) => { registered.section = section; return () => {} } },
    tools: { register: (definition) => { registered.tool = definition; return () => {} } },
    commands: { register: (command) => { registered.command = command; return () => {} } },
    on: (event, listener) => { registered.listeners[event] = listener; return () => {} },
  }
  if (withRoutes) {
    ctx.webServer = {
      register(route) {
        registered.routes.set(route.path, route)
        return () => { registered.routes.delete(route.path) }
      },
    }
    ctx.connection = { requestRejection: () => undefined }
    ctx.effect = (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    }
    ctx.inject = (deps, callback) => {
      callback(ctx)
      return { dispose() {} }
    }
  }
  agent = {
    id: sessionId,
    session: {
      requestContext: () => ({ contextWindow: WINDOW }),
      requestHeader: () => ({ config: { maxTokens: RESERVED } }),
    },
    /**
     * The loop appends exactly this object as the durable `user/message` event
     * and as the provider request entry, so the mock records it verbatim; a
     * shape assertion lives in its own test rather than failing every case.
     */
    inject: async (input) => {
      messages.push(input)
      notices.push(input.content.map(block => block.text).join(''))
    },
  }
  const dispose = apply(ctx)
  return { ctx, agent, sessionId, registered, notices, messages, compactionCalls, dispose }
}

/** Drive one registered route the way the browser would. */
async function callRoute(routes, path, { method = 'GET', body, url } = {}) {
  const route = routes.get(path)
  assert.ok(route, `no route for ${path}`)
  const req = {
    method,
    url: url ?? path,
    headers: { host: '127.0.0.1:59593', 'content-type': 'application/json' },
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
    json: res.body === undefined || res.body === '' ? undefined : JSON.parse(res.body),
  }
}

test('registers the policy section, the tool and the command', () => {
  const { registered, dispose } = createContext()
  assert.match(registered.section.text, /smart_compact/)
  assert.equal(registered.tool.name, 'smart_compact')
  assert.equal(registered.command.name, 'smart-compact')
  dispose()
})

test('check reports usage, the suggested line and the rail', async () => {
  const { registered, agent, dispose } = createContext()
  const result = await registered.tool.execute({ action: 'check' }, { agent })
  assert.match(result.text, /context 700k\/1\.05M \(67%\)/)
  assert.match(result.text, /suggested 60% \(629k\)/)
  assert.match(result.text, /built-in rail 69% \(727k\)/)
  dispose()
})

test('request below the suggested line is refused', async () => {
  const { registered, agent, dispose } = createContext({ pressure: 100_000 })
  const result = await registered.tool.execute({ action: 'request' }, { agent })
  assert.match(result.text, /Not queued/)
  assert.match(result.text, /below the suggested line/)
  dispose()
})

test('request above the line runs at idle, not during the call', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext()
  const result = await registered.tool.execute({ action: 'request', reason: 'phase done' }, { agent })
  assert.match(result.text, /Queued for the end of this turn/)
  assert.equal(compactionCalls.length, 0)

  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /Compacted older history/)
  assert.match(notices[0], /600k tokens freed/)

  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1, 'a consumed request must not run twice')
  dispose()
})

test('off refuses requests but keeps reporting the budget', async () => {
  const { registered, agent, compactionCalls, dispose } = createContext()
  const status = registered.command.handler({ agent, rawInput: 'off' })
  assert.match(status.text, /^阈值 关闭/)
  const result = await registered.tool.execute({ action: 'request' }, { agent })
  assert.match(result.text, /turned off for this session/)
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 0)
  dispose()
})

test('a session percent is clamped below the rail and applies to the tool', async () => {
  const { registered, agent, dispose } = createContext({ pressure: 700_000 })
  const status = registered.command.handler({ agent, rawInput: '90' })
  assert.match(status.text, /请求 90%，按上限取 67%/)
  const check = await registered.tool.execute({ action: 'check' }, { agent })
  assert.match(check.text, /suggested 67% \(703k\)/)
  dispose()
})

test('default and reset return the session to the plugin default', async () => {
  const { registered, agent, dispose } = createContext()
  registered.command.handler({ agent, rawInput: '55' })
  const back = registered.command.handler({ agent, rawInput: 'default' })
  assert.match(back.text, /^阈值 跟随默认 60%/)
  assert.match(back.text, /建议线 60%/)
  dispose()
})

test('crossing the suggested line notifies the agent once per crossing', async () => {
  const { registered, agent, notices, dispose } = createContext()
  const next = () => 'next'
  await registered.listeners['agent/pre-step']({ agent }, next)
  await registered.listeners['agent/pre-step']({ agent }, next)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /suggested compaction line/)
  assert.match(notices[0], /smart_compact\(action: "request"\)/)
  dispose()
})

test('an injected notice is a complete user message the loop can persist', async () => {
  const { registered, agent, messages, dispose } = createContext()
  await registered.listeners['agent/pre-step']({ agent }, () => 'next')
  assert.equal(messages.length, 1)
  const [message] = messages
  // The loop copies this object into both the durable event and the request;
  // a missing role broke the provider (`missing field role`) and the stored
  // session (`message must have role "user"`).
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.source.kind, 'smart-compact')
  assert.equal(message.source.form, 'notice')
  assert.ok(message.source.summary.length > 0)
  assert.ok(message.source.summary.length <= 120, 'a notice summary stays within the Harness bound')
  dispose()
})

test('below the line no notice is sent', async () => {
  const { registered, agent, notices, dispose } = createContext({ pressure: 100_000 })
  const next = () => 'next'
  await registered.listeners['agent/pre-step']({ agent }, next)
  assert.equal(notices.length, 0)
  assert.ok(DEFAULT_LINE > 100_000)
  dispose()
})

test('the settings routes describe and persist a session threshold', async () => {
  const { registered, sessionId, dispose } = createContext({ withRoutes: true })
  assert.equal(registered.routes.size, 3)

  const initial = await callRoute(registered.routes, '/smart-compact/state', {
    url: `/smart-compact/state?sessionId=${sessionId}`,
  })
  assert.equal(initial.status, 200)
  assert.equal(initial.json.defaultPercent, 60)
  assert.equal(initial.json.session.threshold.kind, 'default')
  assert.equal(initial.json.session.percent, 60)
  assert.equal(initial.json.session.thresholdTokens, DEFAULT_LINE)
  assert.equal(initial.json.session.maxPercent, 67)

  const written = await callRoute(registered.routes, '/smart-compact/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId, threshold: { kind: 'percent', percent: 45 } }),
  })
  assert.equal(written.status, 200)
  assert.equal(written.json.percent, 45)
  assert.equal(written.json.thresholdTokens, Math.floor((WINDOW * 45) / 100))

  const reread = await callRoute(registered.routes, '/smart-compact/state', {
    url: `/smart-compact/state?sessionId=${sessionId}`,
  })
  assert.equal(reread.json.session.percent, 45)

  const raised = await callRoute(registered.routes, '/smart-compact/default', {
    method: 'POST',
    body: JSON.stringify({ defaultPercent: 50 }),
  })
  assert.equal(raised.status, 200)
  const afterDefault = await callRoute(registered.routes, '/smart-compact/state')
  assert.equal(afterDefault.json.defaultPercent, 50)
  dispose()
})

test('a window hint fills in a session the host cannot size itself', async () => {
  const { registered, dispose } = createContext({ withRoutes: true })
  // The state file is shared by every context in this process, so read the
  // default the earlier test left behind instead of assuming 60.
  const current = await callRoute(registered.routes, '/smart-compact/state')
  const defaultPercent = current.json.defaultPercent
  const hinted = await callRoute(registered.routes, '/smart-compact/state', {
    url: '/smart-compact/state?sessionId=not-live&window=1048576',
  })
  assert.equal(hinted.status, 200)
  assert.equal(hinted.json.session.status, 'ok')
  assert.equal(hinted.json.session.percent, defaultPercent)
  assert.equal(hinted.json.session.thresholdTokens, Math.floor((WINDOW * defaultPercent) / 100))

  const unhinted = await callRoute(registered.routes, '/smart-compact/state', {
    url: '/smart-compact/state?sessionId=not-live',
  })
  assert.equal(unhinted.json.session.status, 'unknown-window')
  dispose()
})
