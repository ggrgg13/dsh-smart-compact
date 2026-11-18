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
function createContext({ pressure: initialPressure = 700_000, window: initialWindow = WINDOW, withRoutes = false, compactionIn = 'host', compactCommand = false, compactExecute = false } = {}) {
  const sessionId = `session-${++sessionCounter}`
  const registered = { section: null, sections: [], tools: [], tool: null, command: null, listeners: {}, routes: new Map() }
  const notices = []
  const messages = []
  const compactionCalls = []
  let pressure = initialPressure
  let agent
  const compactionBackend = {
    config: { thresholdRatio: 0.8, headroomTokens: 65_536 },
    async compactNow(agent, signal) {
      compactionCalls.push({ agent, signal })
      pressure = Math.max(0, pressure - 600_000)
      return { compactionId: 'c1' }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'tokenMeter') {
        return {
          contextPressure: () => ({ pressureTokens: pressure }),
          measure: () => ({ totalTokens: pressure, nodes: [{ seq: 1, tokens: 1_000 }] }),
        }
      }
      if (name === 'compaction') {
        return compactionIn === 'host' ? compactionBackend : undefined
      }
      if (name === 'agents') {
        return { get: (id) => (id === sessionId ? agent : undefined) }
      }
      if (name === 'commands') return this.commands
      return undefined
    },
    systemPrompt: {
      section: (section) => {
        registered.sections.push(section)
        if (section.name === 'smart-compact') registered.section = section
        return () => {
          const at = registered.sections.indexOf(section)
          if (at >= 0) registered.sections.splice(at, 1)
        }
      },
    },
    tools: {
      register: (definition) => {
        registered.tools.push(definition)
        if (definition.name === 'smart_compact') registered.tool = definition
        return () => {
          const at = registered.tools.indexOf(definition)
          if (at >= 0) registered.tools.splice(at, 1)
        }
      },
    },
    commands: {
      register: (command) => { registered.command = command; return () => {} },
      find: (agent, name) => {
        if ((!compactCommand && !compactExecute) || name !== 'compact') return undefined
        return {
          name: 'compact',
          handler: async (invocation) => {
            compactionCalls.push({ agent: invocation.agent, signal: invocation.signal, via: 'command' })
            pressure = Math.max(0, pressure - 600_000)
            return { kind: 'success', text: 'Compacted 2 history items (~600000 tokens).' }
          },
        }
      },
      execute: compactExecute
        ? async (agent, line, attachments, signal) => {
          compactionCalls.push({ agent, signal, via: 'execute', line })
          pressure = Math.max(0, pressure - 600_000)
          return { commandId: 'cmd-1', result: { kind: 'success', text: 'Compacted 3 history items (~600000 tokens).' } }
        }
        : undefined,
    },
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
      requestContext: () => ({ contextWindow: initialWindow }),
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
    // The Host plane has no compaction service; dsh-web-app mounts the backend
    // per agent preset, so the agent scope is the one that resolves it.
    ctx: compactionIn === 'agent' ? { get: (name) => (name === 'compaction' ? compactionBackend : undefined) } : undefined,
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

test('the backend is resolved from the agent scope when the host plane has none', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({ compactionIn: 'agent' })
  const result = await registered.tool.execute({ action: 'request' }, { agent })
  assert.match(result.text, /Queued for the end of this turn/)
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1, 'the preset-owned backend must run')
  assert.match(notices[0], /Compacted older history/)
  dispose()
})

test('without any backend the request is dropped and reported', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({ compactionIn: 'none' })
  await registered.tool.execute({ action: 'request' }, { agent })
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 0)
  assert.match(notices[0], /no compaction backend is mounted/)
  dispose()
})

test('the preset-scoped /compact command is the reachable backend', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({
    compactionIn: 'none', compactCommand: true,
  })
  await registered.tool.execute({ action: 'request' }, { agent })
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1)
  assert.equal(compactionCalls[0].via, 'command')
  assert.match(notices[0], /Compacted older history/)
  dispose()
})

test('compaction is dispatched through the registry so the run is visible', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({
    compactionIn: 'none', compactCommand: true, compactExecute: true,
  })
  await registered.tool.execute({ action: 'request' }, { agent })
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1)
  assert.equal(compactionCalls[0].via, 'execute')
  assert.equal(compactionCalls[0].line, '/compact')
  assert.match(notices[0], /Compacted older history/)
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

test('the bypass tool and prompt appear only while the plugin switch is on', async () => {
  const { registered, dispose } = createContext({ withRoutes: true })
  const names = () => registered.tools.map(tool => tool.name).sort()
  const sections = () => registered.sections.map(section => section.name).sort()
  assert.deepEqual(names(), ['smart_compact'])
  assert.deepEqual(sections(), ['smart-compact'])

  const on = await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: true }),
  })
  assert.equal(on.status, 200)
  assert.deepEqual(on.json, { allowForce: true })
  assert.deepEqual(names(), ['smart_compact', 'smart_compact_force'])
  assert.deepEqual(sections(), ['smart-compact', 'smart-compact-force'])

  const off = await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: false }),
  })
  assert.equal(off.status, 200)
  assert.deepEqual(names(), ['smart_compact'])
  assert.deepEqual(sections(), ['smart-compact'])
  dispose()
})

test('a forced request runs at idle below the suggested line', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({ withRoutes: true, pressure: 100_000 })
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: true }),
  })
  const forceTool = registered.tools.find(tool => tool.name === 'smart_compact_force')
  const result = await forceTool.execute({ reason: 'testing bypass' }, { agent })
  assert.match(result.text, /Queued \(forced\)/)
  assert.match(result.text, /regardless of pressure/)
  assert.match(result.text, /context 100k\/1\.05M \(10%\)/)

  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1)
  assert.match(notices[0], /forced bypass/)
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: false }),
  })
  dispose()
})

test('the bypass never overrides a session that is off', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({ withRoutes: true, pressure: 100_000 })
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: true }),
  })
  registered.command.handler({ agent, rawInput: 'off' })
  const forceTool = registered.tools.find(tool => tool.name === 'smart_compact_force')
  const result = await forceTool.execute({}, { agent })
  assert.match(result.text, /never overrides off/)
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 0)
  assert.equal(notices.length, 0)
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: false }),
  })
  dispose()
})

test('a forced request compacts even when the window is unknown', async () => {
  const { registered, agent, notices, compactionCalls, dispose } = createContext({
    withRoutes: true, pressure: 100_000, window: null,
  })
  const check = await registered.tool.execute({ action: 'check' }, { agent })
  assert.match(check.text, /^context 100k/)
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: true }),
  })
  const forceTool = registered.tools.find(tool => tool.name === 'smart_compact_force')
  const result = await forceTool.execute({}, { agent })
  assert.match(result.text, /Queued \(forced\)/)
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1)
  assert.match(notices[0], /forced bypass/)
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: false }),
  })
  dispose()
})

test('the human command refuses the bypass until the switch is on, then queues it', async () => {
  const { registered, agent, compactionCalls, dispose } = createContext({ withRoutes: true, pressure: 100_000 })
  const refused = registered.command.handler({ agent, rawInput: 'force' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /强制压缩未启用/)

  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: true }),
  })
  const queued = registered.command.handler({ agent, rawInput: 'force 测试' })
  assert.equal(queued.kind, 'success')
  assert.match(queued.text, /已强制排队/)
  const status = registered.command.handler({ agent, rawInput: 'status' })
  assert.match(status.text, /已排队（强制）/)
  assert.match(status.text, /绕过开关：开/)

  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 1)
  await callRoute(registered.routes, '/smart-compact/force', {
    method: 'POST',
    body: JSON.stringify({ allowForce: false }),
  })
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

test('crossing the suggested line notifies the agent once per crossing', async () => {  const { registered, agent, notices, dispose } = createContext()
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
  assert.equal(registered.routes.size, 4)

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
