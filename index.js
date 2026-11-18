/**
 * dsh-smart-compact — Host half.
 *
 * Gives the agent one tool to read its context budget and to *request* compaction,
 * then performs that compaction after the turn ends (never mid-turn). The policy
 * follows the Harness' own compaction configuration; the user picks a suggested
 * watermark as a percentage of the window, kept below the built-in rail.
 *
 * @module dsh-smart-compact
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mountRoutes } from './routes.js'
import {
  MIN_PERCENT,
  computeBudget,
  describeBudget,
  describeBudgetZh,
  formatTokens,
  migrateState,
  normalizeThreshold,
} from './policy.js'

export const name = 'smart-compact'
export const inject = ['tools', 'commands', 'systemPrompt']

const SECTION = `You can compact your own history with the \`smart_compact\` tool.
Compaction replaces older history with a structured summary and keeps only the most recent message; anything not on disk is at risk.

Compact at a boundary you chose: a phase is finished, notes are written, or you are switching to an unrelated subtask. Do not compact mid-edit, mid-diagnosis, or while the plan exists only in the conversation. Never cut a turn short to compact.

If the window is filling and real work remains, compact before the system does it for you; if the task is nearly done, finish first. Persist decisions, paths and the next step before you request it.`

const TOOL_DESCRIPTION = 'Read the context budget, or request compaction of older history. A request runs after this turn ends, never mid-turn; it keeps only the most recent message and costs one summarization call.'

/**
 * Bypass policy sentence. Registered only while the plugin setting enables the
 * bypass, so an ordinary session never pays for it in the prompt.
 */
const FORCE_SECTION = `The compaction bypass is enabled in this plugin's settings: \`smart_compact_force\` queues a compaction that ignores the suggested threshold, and the user can type \`/smart-compact force\`. Both run at the end of the turn like a normal request. Use the bypass only when the user explicitly asks to test compaction or when the budget reading is clearly wrong; a session that is turned off still refuses.`

const FORCE_TOOL_DESCRIPTION = 'Queue a compaction that skips the suggested threshold. Use only when the user explicitly asks to test compaction or the budget reading is clearly wrong: it runs regardless of pressure, and only while the plugin setting allows it. A session that is turned off still refuses.'

/** Same bound the Harness applies to a `notice` source summary (`boundContextSummary`). */
const NOTICE_SUMMARY_MAX_CHARS = 120

const STATE_FILE = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh'),
  'smart-compact',
  'state.json',
)

/** Load persisted policy. Corrupt, missing, or older state migrates to the current shape. */
function loadState() {
  try {
    return migrateState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    // Missing or unreadable state is not an error: thresholds fall back to the default.
  }
  return migrateState(undefined)
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
  /** Prompt section plus tool of the bypass; empty while the setting is off. */
  let forceDisposers = []

  function record(id) {
    return state.sessions[id]
  }

  function ensure(id) {
    return state.sessions[id] ??= {
      threshold: { kind: 'default' },
      pending: null,
      last: null,
      crossed: false,
      attempts: 0,
    }
  }

  /** The threshold a record actually uses, defaulting to the global suggestion. */
  function thresholdOf(rec) {
    return normalizeThreshold(rec?.threshold)
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

  /**
   * Resolve the compaction backend for one agent.
   *
   * The Host plane deliberately has no compaction service: `dsh-web-app` disables
   * `compaction-basic` there and each agent preset mounts its own backend, so the
   * service is only reachable from the agent's scope (`agent.ctx`). The built-in
   * `/compact` command works for the same reason — it is mounted by the preset.
   *
   * @param agent owning agent, when one is known
   * @returns the compaction service, or undefined without a backend
   */
  function compactionFor(agent) {
    return ctx.get('compaction') ?? agent?.ctx?.get?.('compaction')
  }

  /** Measure one session against its threshold. */
  function evaluate(session, threshold, agent, windowHint) {
    const meter = ctx.get('tokenMeter')
    const context = session?.requestContext?.()
    const header = session?.requestHeader?.()
    const config = compactionFor(agent)?.config ?? {}
    const budget = computeBudget({
      window: context?.contextWindow ?? (Number.isFinite(windowHint) && windowHint > 0 ? windowHint : undefined),
      reserved: header?.config?.maxTokens ?? 0,
      ratio: config.thresholdRatio,
      headroom: config.headroomTokens,
      threshold,
      defaultPercent: state.defaultPercent,
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
    return { budget, pressure, reclaimable }
  }

  function reading({ budget, pressure, reclaimable }) {
    return describeBudget({ pressure, budget, reclaimable })
  }

  /**
   * Build one model-facing notice as a *complete* user message.
   *
   * `agent.inject()` takes a whole `UserMessage`, not a bag of `content` and
   * `source`: the loop appends the object it is given as both the durable
   * `user/message` event and the provider request entry. A message without
   * `role: 'user'` is therefore rejected by the provider (`missing field role`)
   * and makes the stored session fail validation on the next load
   * (`message must have role "user"`); `id` is required for the same reason.
   */
  function noticeMessage(text, summary) {
    const bound = summary.length <= NOTICE_SUMMARY_MAX_CHARS
      ? summary
      : `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'smart-compact', form: 'notice', summary: bound },
    }
  }

  /** Tell the agent something once, without waking an idle conversation. */
  async function notify(agent, text, summary = text) {
    try {
      await agent.inject(noticeMessage(text, summary))
    } catch {
      // A notification is advisory; never let it fail the surrounding work.
    }
  }

  /**
   * Run one manual compaction for an idle agent.
   *
   * The Host plane may have no compaction service at all: `dsh-web-app` disables
   * `compaction-basic` there and each agent preset mounts its own backend inside
   * an isolated `cordis:group`. Isolation keeps that service invisible to the
   * Agent object too (`agent.ctx` is the process-wide loop runtime, not the
   * preset group), so the only reachable seam is the `/compact` command the same
   * preset registers: `commands.find(agent, 'compact')` resolves it through the
   * agent's scope chain, and its handler closes over the isolated service.
   *
   * Dispatching through `commands.execute` is deliberate: the `command/run`
   * record lands before the summarization call and `command/done` after it, so
   * the conversation shows the compaction happening instead of appearing idle.
   *
   * @param agent idle agent whose next-turn admission the compaction reserves
   * @param signal cancellation for this attempt
   * @returns `{ status: 'unavailable' | 'empty' | 'done' | 'failed', text? }`
   */
  async function compactNow(agent, signal) {
    const direct = compactionFor(agent)
    const commands = ctx.get('commands')
    const command = commands?.find?.(agent, 'compact')

    // Preferred path: dispatch the preset's own `/compact` through the registry.
    // It mints a command id, logs `command/run` before the summarization starts
    // and `command/done` after, so the conversation shows the compaction running
    // instead of leaving the reader waiting on silence.
    if (command !== undefined && typeof commands.execute === 'function') {
      const execution = await commands.execute(agent, '/compact', [], signal)
      if (execution !== undefined) {
        const result = execution.result
        if (result?.kind === 'error') return { status: 'failed', text: result.text }
        const text = typeof result?.text === 'string' ? result.text : ''
        return text.includes('No compactable history') ? { status: 'empty' } : { status: 'done' }
      }
    }

    // Fallback without a dispatcher: call the same handler directly. It keeps the
    // compaction out of the command log, which is only acceptable because the
    // backend's own `compaction/*` markers still record the run.
    if (command !== undefined) {
      const result = await command.handler({
        commandId: undefined,
        agent,
        rawInput: '',
        attachments: [],
        signal,
      })
      if (result?.kind === 'error') return { status: 'failed', text: result.text }
      const text = typeof result?.text === 'string' ? result.text : ''
      return text.includes('No compactable history') ? { status: 'empty' } : { status: 'done' }
    }

    if (direct !== undefined) {
      const result = await direct.compactNow(agent, signal)
      return result == null ? { status: 'empty' } : { status: 'done' }
    }
    return { status: 'unavailable' }
  }

  async function runPending(agent) {
    if (running.has(agent.id)) return
    const rec = record(agent.id)
    if (!rec?.pending) return
    const forced = rec.pending.force === true
    const current = evaluate(agent.session, thresholdOf(rec), agent)
    if (current.budget.status === 'off') {
      rec.pending = null
      save()
      return
    }
    // The bypass waives the cost gate — no threshold, no window, no pressure —
    // but it is the only thing waived: `off` above still wins, and the running
    // guard still keeps one run per request.
    if (!forced) {
      if (current.budget.thresholdTokens === null) {
        rec.pending = null
        save()
        await notify(agent, `Compaction skipped: ${reading(current)}. Nothing was changed.`)
        return
      }
      if (current.pressure < current.budget.thresholdTokens) {
        rec.pending = null
        save()
        await notify(agent, `Compaction skipped: ${reading(current)}. Nothing was changed.`)
        return
      }
    }
    running.add(agent.id)
    const controller = new AbortController()
    controllers.add(controller)
    const measure = () => {
      try {
        return ctx.get('tokenMeter')?.measure(agent.session).totalTokens
      } catch {
        // Measurement is optional; the notice then omits the released amount.
      }
      return undefined
    }
    const before = measure()
    try {
      const outcome = await compactNow(agent, controller.signal)
      rec.pending = null
      rec.attempts = 0
      if (outcome.status === 'unavailable') {
        rec.last = { at: Date.now(), status: 'failed', freedTokens: 0 }
        await notify(agent, 'Compaction request dropped: no compaction backend is mounted.')
      } else if (outcome.status === 'empty') {
        rec.last = { at: Date.now(), status: 'empty', freedTokens: 0 }
        await notify(agent, 'Compaction found no useful range to condense; history is unchanged.')
      } else {
        const after = measure()
        const freed = Number.isFinite(before) && Number.isFinite(after) ? Math.max(0, before - after) : null
        rec.last = { at: Date.now(), status: 'ok', freedTokens: freed ?? 0 }
        const verb = forced ? 'Compacted older history (forced bypass)' : 'Compacted older history'
        await notify(agent, freed === null
          ? `${verb}. Recent history and files on disk are unchanged.`
          : `${verb}; ~${formatTokens(freed)} tokens freed. Recent history and files on disk are unchanged.`)
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
      // `compactNow` reports every failure as `busy`, so the code says nothing
      // useful to the model; keep the notice honest and non-specific.
      await notify(agent, 'Compaction did not run this time (busy or failed); history is unchanged.')
    } finally {
      running.delete(agent.id)
      controllers.delete(controller)
    }
  }

  function toolDefinition() {
    return {
      name: 'smart_compact',
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
        if (!agent) throw new Error('smart_compact requires an owning agent session')
        const rec = ensure(agent.id)
        const current = evaluate(agent.session, thresholdOf(rec), agent)
        const line = reading(current)
        if (args.action === 'check') return { text: line }
        if (current.budget.status === 'off') {
          return { text: `Not queued: compaction is turned off for this session. ${line}` }
        }        if (rec.pending) {
          return { text: `Already queued for the end of this turn. ${line}` }
        }
        if (current.budget.thresholdTokens === null) {
          return { text: `Not queued: ${line}.` }
        }
        if (current.pressure < current.budget.thresholdTokens) {
          return {
            text: `Not queued: ${line} is below the suggested line; no compaction needed yet.`,
          }
        }
        rec.pending = { requestedAt: Date.now(), reason: typeof args.reason === 'string' ? args.reason : '' }
        rec.attempts = 0
        save()
        return {
          text: `Queued for the end of this turn. It runs only if pressure is still above the suggested line.\n${line}\nBefore you finish: write decisions, file paths and the next step to disk.`,
        }
      },
    }
  }

  /**
   * The bypass tool. It exists only while the plugin setting allows it, so an
   * ordinary session never sees it in the tool list.
   */
  function forceToolDefinition() {
    return {
      name: 'smart_compact_force',
      description: FORCE_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: {
            type: 'string',
            description: 'One short line for the user, such as "testing the bypass".',
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
        if (!agent) throw new Error('smart_compact_force requires an owning agent session')
        // The registry above should make this unreachable; keep it honest anyway.
        if (state.allowForce !== true) {
          return { text: 'Not queued: the compaction bypass is turned off in the plugin settings.' }
        }
        const rec = ensure(agent.id)
        const current = evaluate(agent.session, thresholdOf(rec), agent)
        const line = reading(current)
        if (current.budget.status === 'off') {
          return { text: `Not queued: compaction is turned off for this session; the bypass never overrides off. ${line}` }
        }
        if (rec.pending) {
          return { text: `Already queued for the end of this turn. ${line}` }
        }
        rec.pending = { requestedAt: Date.now(), reason: typeof args.reason === 'string' ? args.reason : '', force: true }
        rec.attempts = 0
        save()
        return {
          text: `Queued (forced) for the end of this turn: it runs regardless of pressure.\n${line}\nBefore you finish: write decisions, file paths and the next step to disk.`,
        }
      },
    }
  }

  /**
   * Mirror `state.allowForce` onto the prompt and the tool registry, so turning
   * the setting on or off changes what the model can see on its next request.
   */
  function syncForce() {
    const on = state.allowForce === true
    if (on === (forceDisposers.length > 0)) return
    if (on) {
      forceDisposers.push(ctx.systemPrompt.section({
        name: 'smart-compact-force',
        order: 321,
        text: FORCE_SECTION,
      }))
      forceDisposers.push(ctx.tools.register(forceToolDefinition()))
      return
    }
    for (const dispose of forceDisposers) {
      try {
        dispose()
      } catch {
        // Unloading must continue past a failing disposer.
      }
    }
    forceDisposers = []
  }

  disposers.push(ctx.systemPrompt.section({
    name: 'smart-compact',
    order: 320,
    text: SECTION,
  }))

  disposers.push(ctx.tools.register(toolDefinition()))

  syncForce()

  disposers.push(ctx.commands.register({
    definitionId: 'smart-compact',
    name: 'smart-compact',
    description: '查看或修改本会话的上下文压缩阈值',
    handler(invocation) {
      const agent = invocation.agent
      const rec = ensure(agent.id)
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const [first, second] = parts
      const percentArg = (value) => {
        const parsed = Number.parseInt(String(value ?? '').replace(/%$/, ''), 10)
        return Number.isFinite(parsed) ? Math.max(MIN_PERCENT, Math.min(99, parsed)) : undefined
      }
      const shapeOf = (threshold) => (threshold.kind === 'off'
        ? '关闭'
        : threshold.kind === 'percent' ? `自定义 ${threshold.percent}%` : `跟随默认 ${state.defaultPercent}%`)

      if (first === undefined || first === 'status') {
        const current = evaluate(agent.session, thresholdOf(rec), agent)
        return {
          kind: 'success',
          text: `阈值 ${shapeOf(rec.threshold)} · ${describeBudgetZh(current)} · 压缩请求：${rec.pending ? `已排队${rec.pending.force === true ? '（强制）' : ''}` : '无'} · 绕过开关：${state.allowForce === true ? '开' : '关'}`,
        }
      }
      if (first === 'force') {
        if (state.allowForce !== true) {
          return {
            kind: 'error',
            text: '强制压缩未启用：请先在插件设置页打开「允许绕过阈值」。',
          }
        }
        const current = evaluate(agent.session, thresholdOf(rec), agent)
        if (current.budget.status === 'off') {
          return {
            kind: 'error',
            text: `本会话已关闭压缩，强制模式不会覆盖关闭状态。${describeBudgetZh(current)}`,
          }
        }
        if (rec.pending) {
          return { kind: 'success', text: `已有压缩请求在排队。${describeBudgetZh(current)}` }
        }
        rec.pending = {
          requestedAt: Date.now(),
          reason: typeof second === 'string' ? second : 'manual force',
          force: true,
        }
        rec.attempts = 0
        save()
        return {
          kind: 'success',
          text: `已强制排队：本回合结束后执行压缩，无视阈值与窗口。${describeBudgetZh(current)}`,
        }
      }
      if (first === 'off') {
        rec.threshold = { kind: 'off' }
      } else if (first === 'default' || first === 'reset') {
        rec.threshold = { kind: 'default' }
      } else if (first === 'on') {
        rec.threshold = { kind: 'percent', percent: state.defaultPercent }
      } else {
        const percent = percentArg(first === 'set' ? second : first)
        if (percent === undefined) {
          return {
            kind: 'error',
            text: '用法：/smart-compact [status|off|default|force [原因]|<百分比 30-99>]',
          }
        }
        rec.threshold = { kind: 'percent', percent }
      }
      rec.crossed = false
      save()
      const current = evaluate(agent.session, thresholdOf(rec), agent)
      return { kind: 'success', text: `阈值 ${shapeOf(rec.threshold)} · ${describeBudgetZh(current)}` }
    },
  }))

  /**
   * Wire shape of one session, shared by the settings routes.
   * @param {string} id session id
   * @param {number} [windowHint] window the browser already read from the projection
   */
  function describeSession(id, windowHint) {
    const rec = record(id)
    const threshold = thresholdOf(rec)
    const agent = ctx.get('agents')?.get?.(id)
    const { budget } = evaluate(agent?.session, threshold, agent, windowHint)
    return {
      id,
      threshold,
      pending: Boolean(rec?.pending),
      status: budget.status,
      percent: budget.percent,
      requestedPercent: budget.requestedPercent,
      thresholdTokens: budget.thresholdTokens,
      rail: budget.rail,
      railPercent: budget.railPercent,
      maxPercent: budget.maxPercent,
      clamped: budget.clamped,
      last: rec?.last ?? null,
    }
  }

  const settings = {
    defaultPercent: () => state.defaultPercent,
    minPercent: () => MIN_PERCENT,
    setDefaultPercent(percent) {
      state.defaultPercent = percent
      flush()
      return true
    },
    allowForce: () => state.allowForce === true,
    setAllowForce(value) {
      state.allowForce = value === true
      flush()
      // The tool and its prompt section follow the switch immediately.
      syncForce()
      return true
    },
    describeSession,
    setSessionThreshold(id, threshold) {
      const rec = ensure(id)
      rec.threshold = normalizeThreshold(threshold)
      rec.crossed = false
      flush()
      return describeSession(id)
    },
  }

  // The settings panel needs both the HTTP carrier and the trust fence. When
  // either service is absent (headless compositions) the callback never runs
  // and the plugin keeps working without routes.
  if (typeof ctx.inject === 'function') {
    const routes = ctx.inject(['webServer', 'connection'], (scoped) => {
      scoped.effect(() => mountRoutes(scoped, settings), 'smart-compact: settings routes')
    })
    disposers.push(() => routes?.dispose?.())
  }

  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    return runPending(agent)
  }))
  disposers.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const rec = record(agent.id)
      const threshold = thresholdOf(rec)
      if (threshold.kind !== 'off' && !rec?.pending) {
        const current = evaluate(agent.session, threshold, agent)
        const line = current.budget.thresholdTokens
        if (line !== null && current.pressure >= line) {
          if (!rec?.crossed) {
            const target = rec ?? ensure(agent.id)
            target.crossed = true
            save()
            await notify(agent, `Context passed its suggested compaction line (${reading(current)}). If you are finishing a phase, write handoff notes and call smart_compact(action: "request").`)
          }
        } else if (rec?.crossed && (line === null || current.pressure < line * 0.9)) {
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
    for (const dispose of forceDisposers) {
      try {
        dispose()
      } catch {
        // Same as above; the bypass seats are optional.
      }
    }
    forceDisposers = []
    flush()
  }
}
