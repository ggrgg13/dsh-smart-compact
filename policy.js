/**
 * Pure budget policy for dsh-smart-compact.
 *
 * Kept free of Harness imports so it can be unit-tested with plain Node. The
 * numbers mirror `@deepseek-ai/dsh-compaction-basic/src/config.ts`:
 *
 *   thresholdTokens = floor(min(W * thresholdRatio, W - reserved - headroom))
 *
 * A user threshold is a percentage of the context window. It is clamped below
 * the built-in rail so the agent always fires first; when the rail leaves no
 * usable room the policy reports that instead of guessing.
 *
 * @module policy
 */

/** Global default suggestion, percent of the context window. */
export const DEFAULT_PERCENT = 60

/** Lowest suggestion the UI and the clamp allow. */
export const MIN_PERCENT = 30

/** Percentage points kept free below the built-in rail. */
export const RAIL_MARGIN_PERCENT = 2

/** Fallback when the compaction backend does not expose its resolved config. */
export const DEFAULT_RATIO = 0.8

/** Fallback headroom, matching compaction-basic's default. */
export const DEFAULT_HEADROOM = 65_536

/**
 * Normalize an untrusted per-session threshold.
 *
 * @param {unknown} value stored threshold, or undefined
 * @returns {{ kind: 'default' } | { kind: 'percent', percent: number } | { kind: 'off' }}
 */
export function normalizeThreshold(value) {
  if (!value || typeof value !== 'object') return { kind: 'default' }
  if (value.kind === 'off') return { kind: 'off' }
  if (value.kind === 'percent' && Number.isFinite(value.percent)) {
    return { kind: 'percent', percent: Math.round(value.percent) }
  }
  return { kind: 'default' }
}

/**
 * Resolve the percent a session actually uses, before the rail clamp.
 *
 * @param {{ kind: 'default' | 'percent' | 'off', percent?: number }} threshold resolved threshold
 * @param {number} defaultPercent global default
 * @returns {number | null} percent, or null when compaction is off
 */
export function requestedPercent(threshold, defaultPercent = DEFAULT_PERCENT) {
  if (!threshold || threshold.kind === 'off') return null
  if (threshold.kind === 'percent') return threshold.percent
  return Number.isFinite(defaultPercent) ? defaultPercent : DEFAULT_PERCENT
}

/**
 * Compute the built-in rail and this session's suggested threshold.
 *
 * @param {object} input
 * @param {number | undefined} input.window model context window in tokens
 * @param {number} [input.reserved] output tokens reserved by the request
 * @param {number} [input.ratio] compaction-basic thresholdRatio
 * @param {number} [input.headroom] compaction-basic headroomTokens
 * @param {object} [input.threshold] normalized per-session threshold
 * @param {number} [input.defaultPercent] global default percent
 * @returns {{
 *   status: 'ok' | 'off' | 'unknown-window' | 'window-too-small',
 *   window: number | null,
 *   rail: number | null,
 *   railPercent: number | null,
 *   percent: number | null,
 *   thresholdTokens: number | null,
 *   requestedPercent: number | null,
 *   clamped: boolean,
 *   maxPercent: number | null,
 * }}
 */
export function computeBudget({
  window,
  reserved = 0,
  ratio = DEFAULT_RATIO,
  headroom = DEFAULT_HEADROOM,
  threshold,
  defaultPercent = DEFAULT_PERCENT,
}) {
  const empty = {
    status: 'unknown-window',
    window: null,
    rail: null,
    railPercent: null,
    percent: null,
    thresholdTokens: null,
    requestedPercent: requestedPercent(threshold, defaultPercent),
    clamped: false,
    maxPercent: null,
  }
  if (threshold?.kind === 'off') return { ...empty, status: 'off', requestedPercent: null }
  if (!Number.isFinite(window) || window <= 0) return empty

  const rail = Math.floor(Math.min(window * ratio, window - reserved - headroom))
  if (!Number.isFinite(rail) || rail <= 0) return { ...empty, status: 'window-too-small', window }
  if (rail >= window) return { ...empty, status: 'window-too-small', window, rail }

  const railPercent = (rail / window) * 100
  const maxPercent = Math.floor(railPercent) - RAIL_MARGIN_PERCENT
  if (maxPercent < MIN_PERCENT) {
    return { ...empty, status: 'window-too-small', window, rail, railPercent, maxPercent }
  }

  const wanted = requestedPercent(threshold, defaultPercent)
  if (wanted === null) return { ...empty, status: 'off', window, rail, railPercent, maxPercent }
  const percent = Math.max(MIN_PERCENT, Math.min(Math.round(wanted), maxPercent))
  return {
    status: 'ok',
    window,
    rail,
    railPercent,
    percent,
    thresholdTokens: Math.floor((window * percent) / 100),
    requestedPercent: Math.round(wanted),
    clamped: percent !== Math.round(wanted),
    maxPercent,
  }
}

/**
 * Short human/model readable token count.
 * @param {number | null | undefined} tokens token count
 * @returns {string} e.g. `437k`, `1.05M`, or `?`
 */
export function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return '?'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

/**
 * One-line budget reading shared by the tool, the command, and the notice.
 *
 * @param {object} input
 * @param {number} [input.pressure] tokens in the latest recorded request
 * @param {ReturnType<typeof computeBudget>} input.budget
 * @param {number} [input.reclaimable] tokens compaction could free
 * @returns {string} reading text
 */
export function describeBudget({ pressure, budget, reclaimable }) {
  const used = Number.isFinite(pressure) ? pressure : 0
  const parts = []
  if (budget.window === null) {
    parts.push(`context ${formatTokens(used)}`)
  } else {
    parts.push(`context ${formatTokens(used)}/${formatTokens(budget.window)} (${Math.round((used / budget.window) * 100)}%)`)
  }
  if (budget.status === 'off') parts.push('compaction off for this session')
  if (budget.status === 'window-too-small') parts.push('window leaves no room below the built-in rail')
  if (budget.percent !== null) {
    parts.push(`suggested ${budget.percent}% (${formatTokens(budget.thresholdTokens)})`)
  }
  if (budget.rail !== null) {
    parts.push(`built-in rail ${Math.round(budget.railPercent)}% (${formatTokens(budget.rail)})`)
  }
  if (budget.clamped && budget.requestedPercent !== null) {
    parts.push(`requested ${budget.requestedPercent}%, capped at ${budget.percent}%`)
  }
  if (reclaimable !== undefined) parts.push(`compaction would free ~${formatTokens(reclaimable)}`)
  return parts.join(' · ')
}

/** Threshold states a stored record may hold. */
export const THRESHOLD_KINDS = ['default', 'percent', 'off']

/**
 * Rewrite a persisted state file to the current shape.
 *
 * Version 1 stored a mode; version 2 stores a percent threshold plus the global
 * default. Migration keeps the intent: `off` stays off, `late` becomes the
 * highest percent the rail allows, `eager` becomes 40%, everything else follows
 * the default.
 *
 * @param {unknown} raw parsed state file
 * @returns {{ version: 2, defaultPercent: number, sessions: Record<string, object> }}
 */
export function migrateState(raw) {
  const state = { version: 2, defaultPercent: DEFAULT_PERCENT, sessions: {} }
  if (!raw || typeof raw !== 'object') return state
  if (Number.isFinite(raw.defaultPercent)) {
    state.defaultPercent = Math.max(MIN_PERCENT, Math.min(99, Math.round(raw.defaultPercent)))
  }
  const sessions = raw.sessions
  if (!sessions || typeof sessions !== 'object') return state
  for (const [id, value] of Object.entries(sessions)) {
    if (!value || typeof value !== 'object') continue
    const record = {
      threshold: value.threshold && typeof value.threshold === 'object'
        ? normalizeThreshold(value.threshold)
        : legacyThreshold(value.mode),
      pending: value.pending ?? null,
      last: value.last ?? null,
      crossed: value.crossed === true,
      attempts: Number.isFinite(value.attempts) ? value.attempts : 0,
    }
    state.sessions[id] = record
  }
  return state
}

/**
 * Map a version 1 mode onto a version 2 threshold.
 * @param {unknown} mode stored mode string
 * @returns {{ kind: 'default' } | { kind: 'percent', percent: number } | { kind: 'off' }}
 */
function legacyThreshold(mode) {
  if (mode === 'off') return { kind: 'off' }
  if (mode === 'eager') return { kind: 'percent', percent: 40 }
  if (mode === 'late') return { kind: 'percent', percent: 99 }
  return { kind: 'default' }
}
