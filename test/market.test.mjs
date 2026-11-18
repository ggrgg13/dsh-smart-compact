import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The market index is generated, never edited by hand; these checks keep it
 * from drifting: a release that forgets `node market/generate-index.mjs` leaves
 * the old version or commit behind, and the Discover page would keep installing
 * a stale bundle.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const index = JSON.parse(readFileSync(join(root, 'market', 'index.json'), 'utf8'))

test('the market index describes exactly this package and version', () => {
  assert.equal(index.format, 1)
  assert.equal(typeof index.title?.en, 'string')
  const plugin = index.plugins.find(entry => entry.name === pkg.name)
  assert.ok(plugin, `index has no entry for ${pkg.name}`)
  assert.equal(plugin.versions.length, 1)
  assert.equal(plugin.versions[0].version, pkg.version)
})

test('the index installs a git source pinned to a full commit', () => {
  const source = index.plugins[0].versions[0].source
  assert.equal(source.type, 'git')
  assert.equal(source.url, 'https://github.com/ggrgg13/dsh-smart-compact.git')
  assert.match(source.commit, /^[0-9a-f]{40}$/)
  assert.equal(source.path, undefined)
})

test('the index carries the harness requirement and a publish timestamp', () => {
  const version = index.plugins[0].versions[0]
  assert.equal(version.engines?.dsh, pkg.engines.dsh)
  assert.ok(Number.isSafeInteger(version.publishTimestamp))
  assert.ok(version.publishTimestamp > 0)
})
