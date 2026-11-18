/**
 * Pure budget policy for dsh-smart-compact.
 *
 * Kept free of Harness imports so it can be unit-tested with plain Node.
 * The numbers mirror `@deepseek-ai/dsh-compaction-basic/src/config.ts`:
 *
 *   thresholdTokens = floor(min(W * thresholdRatio, W - reserved - headroom))
 *
 * @module policy
 */

/** Supported per-session policies, from cheapest to most aggressive. */
export const MODES = ['off', 'late', 'balanced', 'eager']

/** Used when a session has no explicit mode. */
export const DEFAULT_MODE = 'balanced'

/** Fallback when the compaction backend does not expose its resolved config. */
export const DEFAULT_RATIO = 0.8

/** Fallback headroom, matching compaction-basic's default. */
export const DEFAULT_HEADROOM = 65_536

/** Default margin kept between the watermark and the built-in rail. */
export const DEFAULT_MARGIN_RATIO = 0.05

/**
 * Normalize an untrusted mode string.
 * @param {unknown} value candidate mode
 * @returns {string} a supported mode, or the default
 */
export function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE
}

/**
 * Compute the built-in rail and this session's watermark.
 *
 * @param {object} input
 * @param {number | undefined} input.window model context window in tokens
 * @param {number} [input.reserved] output tokens reserved by the request
 * @param {number} [input.ratio] compaction-basic thresholdRatio
 * @param {number} [input.headroom] compaction-basic headroomTokens
 * @param {string} [input.mode] session policy
 * @param {number} [input.marginRatio] margin between watermark and rail
 * @returns {{ mode: string, window: number | null, rail: number | null, watermark: number | null }}
 */
export function computePolicy({
  window,
  reserved = 0,
  ratio = DEFAULT_RATIO,
  headroom = DEFAULT_HEADROOM,
  mode = DEFAULT_MODE,
  marginRatio = DEFAULT_MARGIN_RATIO,
}) {
  const normalized = normalizeMode(mode)
  if (!Number.isFinite(window) || window <= 0) {
    return { mode: normalized, window: null, rail: null, watermark: null }
  }
  const rail = Math.floor(Math.min(window * ratio, window - reserved - headroom))
  if (!Number.isFinite(rail) || rail <= 0) {
    return { mode: normalized, window, rail: null, watermark: null }
  }
  const margin = Math.max(1, Math.floor(window * marginRatio))
  const cap = Math.max(1, rail - margin)
  const base = normalized === 'eager'
    ? window * 0.4
    : normalized === 'late'
      ? rail - margin
      : window * 0.6
  const watermark = normalized === 'off'
    ? null
    : Math.max(1, Math.min(Math.floor(base), cap))
  return { mode: normalized, window, rail, watermark }
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
 * @param {{ window: number | null, rail: number | null, watermark: number | null }} input.policy
 * @param {number} [input.reclaimable] tokens compaction could free
 * @returns {string} reading text
 */
export function describeBudget({ pressure, policy, reclaimable }) {
  const used = Number.isFinite(pressure) ? pressure : 0
  const window = policy.window
  const parts = [window === null
    ? `context ${formatTokens(used)}`
    : `context ${formatTokens(used)}/${formatTokens(window)} (${Math.round((used / window) * 100)}%)`]
  if (policy.watermark !== null) parts.push(`watermark ${formatTokens(policy.watermark)}`)
  if (policy.rail !== null) parts.push(`built-in rail ${formatTokens(policy.rail)}`)
  if (policy.mode === 'off') parts.push('policy off')
  if (reclaimable !== undefined) parts.push(`compaction would free ~${formatTokens(reclaimable)}`)
  return parts.join(' · ')
}
