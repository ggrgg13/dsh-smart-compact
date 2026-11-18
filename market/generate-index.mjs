#!/usr/bin/env node
/**
 * Regenerate the plugin market index (format 1) for this repository.
 *
 * The Discover page installs a git source by exact commit, so the index has to
 * be regenerated after every release: run it once the release commit exists.
 *
 *   node market/generate-index.mjs [commit] [timestampSeconds]
 *
 * The commit defaults to GIT_COMMIT, then to the repository's HEAD read from
 * .git (no child process, so it also works under a command sandbox).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Read HEAD without spawning git: .git/HEAD names a ref file or a packed ref. */
function readHead() {
  const gitDir = join(root, '.git')
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  const direct = /^[0-9a-f]{40}$/.exec(head)
  if (direct) return direct[0]
  const ref = /^ref: (.+)$/.exec(head)?.[1]
  if (ref === undefined) throw new Error(`cannot parse .git/HEAD: ${head}`)
  try {
    return readFileSync(join(gitDir, ref), 'utf8').trim()
  } catch {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    const line = packed.split('\n').find(entry => entry.endsWith(` ${ref}`))
    if (line === undefined) throw new Error(`cannot resolve ${ref}; pass the commit as an argument`)
    return line.split(' ')[0]
  }
}

const commit = process.argv[2] ?? process.env.GIT_COMMIT ?? readHead()
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`commit must be a full 40-character SHA, got: ${commit}`)
}
const publishTimestamp = Number(process.argv[3] ?? process.env.PUBLISH_TIMESTAMP ?? Math.floor(Date.now() / 1000))

const index = {
  format: 1,
  title: { en: 'dsh-smart-compact', zh: '智能压缩' },
  description: {
    en: 'Agent-requested context compaction at semantic turn boundaries, with a per-session suggested threshold kept below the harness rail.',
    zh: '让 agent 在语义合适的边界自主请求上下文压缩，阈值按会话设置并始终低于系统自动压缩线。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Smart compact', zh: '智能压缩' },
      description: {
        en: 'Lets the agent choose when to compact: a live budget reading, a per-session threshold below the built-in rail, and a visible compaction run at the end of the turn.',
        zh: '让 agent 自己挑压缩时机：实时读数、低于系统线的会话阈值，压缩在回合结束后可见地执行。',
      },
      homepage: pkg.homepage,
      repository: { url: 'https://github.com/ggrgg13/dsh-smart-compact' },
      metadata: { keywords: pkg.keywords ?? [], labels: [], sortKeys: {} },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: {
            type: 'git',
            url: 'https://github.com/ggrgg13/dsh-smart-compact.git',
            commit,
          },
          engines: pkg.engines?.dsh === undefined ? {} : { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
}

const target = join(here, 'index.json')
writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${target} · ${pkg.name}@${pkg.version} · ${commit.slice(0, 7)}`)
