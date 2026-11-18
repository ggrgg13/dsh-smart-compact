import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PERCENT,
  MIN_PERCENT,
  computeBudget,
  describeBudget,
  formatTokens,
  migrateState,
  normalizeThreshold,
  requestedPercent,
} from '../policy.js'

const FLASH = { window: 1_048_576, reserved: 256_000 }

test('deepseek-flash rail and cap match compaction-basic defaults', () => {
  const budget = computeBudget({ ...FLASH, threshold: { kind: 'default' } })
  assert.equal(budget.status, 'ok')
  assert.equal(budget.rail, 727_040)
  assert.equal(Math.round(budget.railPercent * 10) / 10, 69.3)
  assert.equal(budget.maxPercent, 67)
  assert.equal(budget.percent, DEFAULT_PERCENT)
  assert.equal(budget.thresholdTokens, 629_145)
  assert.equal(budget.clamped, false)
})

test('a percent above the rail is clamped, one below the floor is raised', () => {
  const high = computeBudget({ ...FLASH, threshold: { kind: 'percent', percent: 90 } })
  assert.equal(high.percent, 67)
  assert.equal(high.requestedPercent, 90)
  assert.equal(high.clamped, true)
  assert.equal(high.thresholdTokens, Math.floor((1_048_576 * 67) / 100))

  const low = computeBudget({ ...FLASH, threshold: { kind: 'percent', percent: 10 } })
  assert.equal(low.percent, MIN_PERCENT)
  assert.equal(low.clamped, true)
})

test('off and an unknown window report why no threshold exists', () => {
  const off = computeBudget({ ...FLASH, threshold: { kind: 'off' } })
  assert.equal(off.status, 'off')
  assert.equal(off.thresholdTokens, null)
  assert.equal(off.rail, null)

  const unknown = computeBudget({ window: undefined, threshold: { kind: 'default' } })
  assert.equal(unknown.status, 'unknown-window')
  assert.equal(unknown.thresholdTokens, null)
})

test('a window whose rail leaves no room is reported, never guessed', () => {
  const budget = computeBudget({
    window: 131_072,
    reserved: 32_768,
    headroom: 65_536,
    threshold: { kind: 'default' },
  })
  assert.equal(budget.rail, 32_768)
  assert.equal(budget.maxPercent, 23)
  assert.equal(budget.status, 'window-too-small')
  assert.equal(budget.thresholdTokens, null)
})

test('the global default only applies to records following it', () => {
  assert.equal(requestedPercent({ kind: 'default' }, 45), 45)
  assert.equal(requestedPercent({ kind: 'percent', percent: 72 }, 45), 72)
  assert.equal(requestedPercent({ kind: 'off' }, 45), null)
  const budget = computeBudget({ ...FLASH, threshold: { kind: 'default' }, defaultPercent: 45 })
  assert.equal(budget.percent, 45)
})

test('threshold normalization rejects junk', () => {
  assert.deepEqual(normalizeThreshold(undefined), { kind: 'default' })
  assert.deepEqual(normalizeThreshold({ kind: 'off' }), { kind: 'off' })
  assert.deepEqual(normalizeThreshold({ kind: 'percent', percent: 61.4 }), { kind: 'percent', percent: 61 })
  assert.deepEqual(normalizeThreshold({ kind: 'percent', percent: 'x' }), { kind: 'default' })
})

test('version 1 modes migrate to percent thresholds', () => {
  const state = migrateState({
    version: 1,
    sessions: {
      a: { mode: 'off', crossed: true },
      b: { mode: 'late', pending: { requestedAt: 1 } },
      c: { mode: 'eager' },
      d: { mode: 'balanced' },
    },
  })
  assert.equal(state.version, 2)
  assert.equal(state.defaultPercent, DEFAULT_PERCENT)
  assert.equal(state.allowForce, false)
  assert.deepEqual(state.sessions.a.threshold, { kind: 'off' })
  assert.deepEqual(state.sessions.b.threshold, { kind: 'percent', percent: 99 })
  assert.deepEqual(state.sessions.c.threshold, { kind: 'percent', percent: 40 })
  assert.deepEqual(state.sessions.d.threshold, { kind: 'default' })
  assert.equal(state.sessions.a.crossed, true)
  assert.deepEqual(state.sessions.b.pending, { requestedAt: 1 })
})

test('a version 2 state round-trips and clamps the global default', () => {
  const state = migrateState({
    version: 2,
    defaultPercent: 250,
    sessions: { a: { threshold: { kind: 'percent', percent: 55 } } },
  })
  assert.equal(state.defaultPercent, 99)
  assert.deepEqual(state.sessions.a.threshold, { kind: 'percent', percent: 55 })
})

test('the bypass is off unless the state says otherwise', () => {
  assert.equal(migrateState(undefined).allowForce, false)
  assert.equal(migrateState({ allowForce: 'yes' }).allowForce, false)
  assert.equal(migrateState({ allowForce: true }).allowForce, true)
})

test('token formatting is compact and stable', () => {
  assert.equal(formatTokens(437_000), '437k')
  assert.equal(formatTokens(1_048_576), '1.05M')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(undefined), '?')
})

test('budget reading carries usage, suggested line and rail', () => {
  const budget = computeBudget({ ...FLASH, threshold: { kind: 'default' } })
  const text = describeBudget({ pressure: 437_000, budget, reclaimable: 430_000 })
  assert.match(text, /context 437k\/1\.05M \(42%\)/)
  assert.match(text, /suggested 60% \(629k\)/)
  assert.match(text, /built-in rail 69% \(727k\)/)
  assert.match(text, /would free ~430k/)
})

test('the reading explains off, too-small windows and clamping', () => {
  const off = describeBudget({
    pressure: 10_000,
    budget: computeBudget({ ...FLASH, threshold: { kind: 'off' } }),
  })
  assert.match(off, /compaction off for this session/)
  assert.doesNotMatch(off, /suggested/)

  const clamped = describeBudget({
    pressure: 10_000,
    budget: computeBudget({ ...FLASH, threshold: { kind: 'percent', percent: 90 } }),
  })
  assert.match(clamped, /requested 90%, capped at 67%/)

  const small = describeBudget({
    pressure: 10_000,
    budget: computeBudget({ window: 131_072, reserved: 32_768, threshold: { kind: 'default' } }),
  })
  assert.match(small, /no room below the built-in rail/)
})
