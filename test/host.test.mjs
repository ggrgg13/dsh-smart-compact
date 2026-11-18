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
function createContext({ pressure: initialPressure = 700_000 } = {}) {
  const sessionId = `session-${++sessionCounter}`
  const registered = { section: null, tool: null, command: null, listeners: {} }
  const notices = []
  const compactionCalls = []
  let pressure = initialPressure
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
      return undefined
    },
    systemPrompt: { section: (section) => { registered.section = section; return () => {} } },
    tools: { register: (definition) => { registered.tool = definition; return () => {} } },
    commands: { register: (command) => { registered.command = command; return () => {} } },
    on: (event, listener) => { registered.listeners[event] = listener; return () => {} },
  }
  const agent = {
    id: sessionId,
    session: {
      requestContext: () => ({ contextWindow: WINDOW }),
      requestHeader: () => ({ config: { maxTokens: RESERVED } }),
    },
    inject: async (input) => { notices.push(input.content.map(block => block.text).join('')) },
  }
  const dispose = apply(ctx)
  return { ctx, agent, registered, notices, compactionCalls, dispose }
}

test('registers the policy section, the tool and the command', () => {
  const { registered, dispose } = createContext()
  assert.match(registered.section.text, /compact_context/)
  assert.equal(registered.tool.name, 'compact_context')
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
  assert.match(result.text, /below the suggested watermark/)
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
  assert.match(status.text, /^off/)
  const result = await registered.tool.execute({ action: 'request' }, { agent })
  assert.match(result.text, /turned off for this session/)
  await registered.listeners['agent/status']({ agent, status: 'idle' })
  assert.equal(compactionCalls.length, 0)
  dispose()
})

test('a session percent is clamped below the rail and applies to the tool', async () => {
  const { registered, agent, dispose } = createContext({ pressure: 700_000 })
  const status = registered.command.handler({ agent, rawInput: '90' })
  assert.match(status.text, /requested 90%, capped at 67%/)
  const check = await registered.tool.execute({ action: 'check' }, { agent })
  assert.match(check.text, /suggested 67% \(703k\)/)
  dispose()
})

test('default and reset return the session to the plugin default', async () => {
  const { registered, agent, dispose } = createContext()
  registered.command.handler({ agent, rawInput: '55' })
  const back = registered.command.handler({ agent, rawInput: 'default' })
  assert.match(back.text, /^default · /)
  assert.match(back.text, /suggested 60%/)
  dispose()
})

test('crossing the suggested line notifies the agent once per crossing', async () => {
  const { registered, agent, notices, dispose } = createContext()
  const next = () => 'next'
  await registered.listeners['agent/pre-step']({ agent }, next)
  await registered.listeners['agent/pre-step']({ agent }, next)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /suggested compaction watermark/)
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
