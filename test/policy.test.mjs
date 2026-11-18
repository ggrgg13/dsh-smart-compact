import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MODE,
  computePolicy,
  describeBudget,
  formatTokens,
  normalizeMode,
} from '../policy.js'

const FLASH = { window: 1_048_576, reserved: 256_000 }

test('deepseek-flash rail matches compaction-basic defaults', () => {
  const { rail, watermark, mode } = computePolicy({ ...FLASH, mode: 'balanced' })
  assert.equal(mode, 'balanced')
  assert.equal(rail, 727_040)
  assert.equal(watermark, 629_145)
})

test('modes only move the watermark, never above the rail', () => {
  const eager = computePolicy({ ...FLASH, mode: 'eager' })
  const late = computePolicy({ ...FLASH, mode: 'late' })
  const off = computePolicy({ ...FLASH, mode: 'off' })
  assert.equal(eager.watermark, 419_430)
  assert.equal(late.watermark, 727_040 - 52_428)
  assert.equal(off.watermark, null)
  assert.equal(off.rail, 727_040)
})

test('small windows clamp every mode below the rail', () => {
  const policy = computePolicy({ window: 131_072, reserved: 8_192, mode: 'eager' })
  assert.equal(policy.rail, 57_344)
  assert.equal(policy.watermark, 57_344 - 6_553)
  assert.ok(policy.watermark < policy.rail)
})

test('unknown window yields no watermark', () => {
  assert.deepEqual(
    computePolicy({ window: undefined, mode: 'balanced' }),
    { mode: 'balanced', window: null, rail: null, watermark: null },
  )
})

test('invalid modes fall back to the default', () => {
  assert.equal(normalizeMode('turbo'), DEFAULT_MODE)
  assert.equal(normalizeMode('eager'), 'eager')
  assert.equal(normalizeMode(undefined), DEFAULT_MODE)
})

test('token formatting is compact and stable', () => {
  assert.equal(formatTokens(437_000), '437k')
  assert.equal(formatTokens(1_048_576), '1.05M')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(undefined), '?')
})

test('budget reading carries usage, percent, watermark and rail', () => {
  const policy = computePolicy({ ...FLASH, mode: 'balanced' })
  const text = describeBudget({ pressure: 437_000, policy, reclaimable: 430_000 })
  assert.match(text, /context 437k\/1\.05M \(42%\)/)
  assert.match(text, /watermark 629k/)
  assert.match(text, /built-in rail 727k/)
  assert.match(text, /would free ~430k/)
})

test('off mode still reports the budget', () => {
  const policy = computePolicy({ ...FLASH, mode: 'off' })
  const text = describeBudget({ pressure: 10_000, policy })
  assert.match(text, /policy off/)
  assert.doesNotMatch(text, /watermark/)
})
