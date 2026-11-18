/**
 * dsh-smart-compact — Host half.
 *
 * Gives the agent one tool to read its context budget and to *request* compaction,
 * then performs that compaction after the turn ends (never mid-turn). The policy
 * follows the Harness' own compaction configuration; users pick a mode, not a
 * token count.
 *
 * @module @local/dsh-smart-compact
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_MODE,
  MODES,
  computePolicy,
  describeBudget,
  formatTokens,
  normalizeMode,
} from './policy.js'

export const name = 'smart-compact'
export const inject = ['tools', 'commands', 'systemPrompt']

const SECTION = `You can compact your own history with the \`compact_context\` tool.
Compaction replaces older history with a structured summary and keeps only the most recent message; anything not on disk is at risk.

Compact at a boundary you chose: a phase is finished, notes are written, or you are switching to an unrelated subtask. Do not compact mid-edit, mid-diagnosis, or while the plan exists only in the conversation. Never cut a turn short to compact.

If the window is filling and real work remains, compact before the system does it for you; if the task is nearly done, finish first. Persist decisions, paths and the next step before you request it.`

const TOOL_DESCRIPTION = 'Read the context budget, or request compaction of older history. A request runs after this turn ends, never mid-turn; it keeps only the most recent message and costs one summarization call.'

const STATE_FILE = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh'),
  'smart-compact',
  'state.json',
)

/** Load persisted per-session policy. Corrupt or missing state reads as empty. */
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed
    }
  } catch {
    // Missing or unreadable state is not an error: modes fall back to the default.
  }
  return { version: 1, sessions: {} }
}

/**
 * Host half entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning context
 */
export function apply(ctx) {
  const state = loadState()
  const disposers = []
  const running = new Set()
  const controllers = new Set()
  let saveTimer

  function record(id) {
    return state.sessions[id]
  }

  function ensure(id) {
    return state.sessions[id] ??= { mode: DEFAULT_MODE, pending: null, last: null, crossed: false, attempts: 0 }
  }

  function save() {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      try {
        mkdirSync(dirname(STATE_FILE), { recursive: true })
        writeFileSync(STATE_FILE, JSON.stringify(state, undefined, 2), 'utf8')
      } catch {
        // Persistence is best-effort; an unwritable profile must not break compaction.
      }
    }, 150)
  }

  function flush() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(state, undefined, 2), 'utf8')
    } catch {
      // Best-effort, as above.
    }
  }

  /** Measure one session against the configured policy. */
  function evaluate(session, mode) {
    const meter = ctx.get('tokenMeter')
    const context = session.requestContext?.()
    const header = session.requestHeader?.()
    const config = ctx.get('compaction')?.config ?? {}
    const policy = computePolicy({
      window: context?.contextWindow,
      reserved: header?.config?.maxTokens ?? 0,
      ratio: config.thresholdRatio,
      headroom: config.headroomTokens,
      mode,
    })
    let pressure = 0
    let reclaimable
    if (meter) {
      try {
        pressure = meter.contextPressure(session).pressureTokens ?? 0
      } catch {
        // No recorded request yet.
      }
      try {
        const measured = meter.measure(session)
        const last = measured.nodes[measured.nodes.length - 1]?.tokens ?? 0
        reclaimable = Math.max(0, measured.totalTokens - last)
      } catch {
        // Measurement is optional; the reading still works without it.
      }
    }
    return { policy, pressure, reclaimable }
  }

  function reading({ policy, pressure, reclaimable }) {
    return describeBudget({ pressure, policy, reclaimable })
  }

  /** Tell the agent something once, without waking an idle conversation. */
  async function notify(agent, text) {
    try {
      await agent.inject({ content: [{ type: 'text', text }], source: { kind: 'smart-compact' } })
    } catch {
      // A notification is advisory; never let it fail the surrounding work.
    }
  }

  async function runPending(agent) {
    if (running.has(agent.id)) return
    const rec = record(agent.id)
    if (!rec?.pending) return
    const compaction = ctx.get('compaction')
    if (!compaction) {
      rec.pending = null
      save()
      await notify(agent, 'Compaction request dropped: no compaction backend is mounted.')
      return
    }
    const current = evaluate(agent.session, rec.mode)
    if (current.policy.mode === 'off') {
      rec.pending = null
      save()
      return
    }
    if (current.policy.watermark === null || current.pressure < current.policy.watermark) {
      rec.pending = null
      save()
      await notify(agent, `Compaction skipped: ${reading(current)}. Nothing was changed.`)
      return
    }
    running.add(agent.id)
    const controller = new AbortController()
    controllers.add(controller)
    const before = current.pressure
    try {
      const result = await compaction.compactNow(agent, controller.signal)
      rec.pending = null
      rec.attempts = 0
      if (result == null) {
        rec.last = { at: Date.now(), status: 'empty', freedTokens: 0 }
        await notify(agent, 'Compaction found no useful range to condense; history is unchanged.')
      } else {
        const after = evaluate(agent.session, rec.mode).pressure
        const freed = Math.max(0, before - after)
        rec.last = { at: Date.now(), status: 'ok', freedTokens: freed }
        await notify(agent, `Compacted older history; ~${formatTokens(freed)} tokens freed. Recent history and files on disk are unchanged.`)
      }
      save()
    } catch (error) {
      const code = error?.code
      if (code === 'busy' && (rec.attempts ?? 0) < 1) {
        // The user (or a parent agent) started new work first; try again at the next idle point.
        rec.attempts = (rec.attempts ?? 0) + 1
        save()
        return
      }
      rec.pending = null
      rec.attempts = 0
      rec.last = { at: Date.now(), status: 'failed', freedTokens: 0 }
      save()
      await notify(agent, `Compaction failed (${code ?? 'error'}); the attempt is recorded in the session log.`)
    } finally {
      running.delete(agent.id)
      controllers.delete(controller)
    }
  }

  function toolDefinition() {
    return {
      name: 'compact_context',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['check', 'request'],
            description: 'check reads the budget; request queues compaction for the end of this turn.',
          },
          reason: {
            type: 'string',
            description: 'For request: one short line for the user, such as "phase 2 done, notes written".',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('compact_context requires an owning agent session')
        const rec = ensure(agent.id)
        const current = evaluate(agent.session, rec.mode)
        const line = reading(current)
        if (args.action === 'check') return { text: line }
        if (rec.mode === 'off') {
          return { text: `Not queued: compaction is disabled for this session. ${line}` }
        }
        if (rec.pending) {
          return { text: `Already queued for the end of this turn. ${line}` }
        }
        if (current.policy.watermark === null) {
          return { text: `Not queued: the context window is not known yet. ${line}` }
        }
        if (current.pressure < current.policy.watermark) {
          return {
            text: `Not queued: ${line} is below the watermark; no compaction needed yet.`,
          }
        }
        rec.pending = { requestedAt: Date.now(), reason: typeof args.reason === 'string' ? args.reason : '' }
        rec.attempts = 0
        save()
        return {
          text: `Queued for the end of this turn. It runs only if pressure is still above the watermark.\n${line}\nBefore you finish: write decisions, file paths and the next step to disk.`,
        }
      },
    }
  }

  disposers.push(ctx.systemPrompt.section({
    name: 'smart-compact',
    order: 320,
    text: SECTION,
  }))

  disposers.push(ctx.tools.register(toolDefinition()))

  disposers.push(ctx.commands.register({
    definitionId: 'smart-compact',
    name: 'smart-compact',
    description: 'Show or change this session\'s context compaction policy',
    handler(invocation) {
      const agent = invocation.agent
      const rec = ensure(agent.id)
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const [first, second] = parts
      const maybeMode = (value) => (MODES.includes(value) ? value : undefined)

      if (first === undefined || first === 'status') {
        const current = evaluate(agent.session, rec.mode)
        const pending = rec.pending ? 'yes' : 'no'
        return {
          kind: 'success',
          text: `mode ${rec.mode} · ${reading(current)} · pending ${pending}`,
        }
      }
      const mode = maybeMode(first === 'mode' ? second : first)
      if (first === 'on') {
        rec.mode = 'balanced'
      } else if (mode !== undefined) {
        rec.mode = mode
      } else if (first === 'reset') {
        rec.mode = DEFAULT_MODE
      } else {
        return { kind: 'error', text: `Usage: /smart-compact [status|off|late|balanced|eager|reset]` }
      }
      save()
      const current = evaluate(agent.session, rec.mode)
      return { kind: 'success', text: `mode ${rec.mode} · ${reading(current)}` }
    },
  }))

  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    return runPending(agent)
  }))

  disposers.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const rec = record(agent.id)
      const mode = rec?.mode ?? DEFAULT_MODE
      if (mode !== 'off' && !rec?.pending) {
        const current = evaluate(agent.session, mode)
        if (current.policy.watermark !== null && current.pressure >= current.policy.watermark) {
          if (!rec?.crossed) {
            const target = rec ?? ensure(agent.id)
            target.crossed = true
            save()
            await notify(agent, `Context is near its suggested compaction watermark (${reading(current)}). If you are finishing a phase, write handoff notes and call compact_context(action: "request").`)
          }
        } else if (rec?.crossed && (current.policy.watermark === null || current.pressure < current.policy.watermark * 0.9)) {
          rec.crossed = false
          save()
        }
      }
    } catch {
      // A failed notice must not fail step preparation.
    }
    return next()
  }))

  return () => {
    for (const controller of controllers) {
      try {
        controller.abort()
      } catch {
        // Already settled.
      }
    }
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Plugin unload must continue past a failing disposer.
      }
    }
    flush()
  }
}
