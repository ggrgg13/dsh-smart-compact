# 80 · 分发

给接手的人：这里只回答“怎么让别人装上”，功能与设计不在这里。

## 通道总览

| 通道 | 谁装得到 | 需要什么 | 状态 |
|---|---|---|---|
| 直接从 GitHub 装 | 知道仓库地址的人 | 仓库 public、`dsh.bundle.patch` | 可用（仓库已具备） |
| npm 包 | `dsh plugin add <包名>` | npm 账号 + `npm publish` | 未发布 |
| 自建市场索引（官方 Discover） | 加了这条索引源的人 | format-1 `index.json` + 一个可访问 URL | 文件已备：`market/index.json` |
| 社区目录（dshmarket / awesome-dsh-plugin） | 所有人 | 一个 YAML 文件的 PR + 审核 | 未提交 |

## 一、直接从 GitHub 装

已在 `README.md` 里写给用户。要点：

- 桌面版：Plugins → 添加插件 → `github:ggrgg13/dsh-smart-compact`；
- 命令行：`dsh plugin --profile <profile> add github:ggrgg13/dsh-smart-compact`。

前提是 `package.json` 有 `dsh.bundle.patch`（本仓库有）且仓库里有对应
`cordis.patch.yml`。只要这两个在，任何 public 仓库都能这样装。

## 二、发布到 npm（可选，但推荐）

```sh
npm login
npm version patch        # 或改名想好的版本
npm publish --access public
```

之后 `dsh plugin --profile <profile> add dsh-smart-compact` 即可，安装更快
（免构建授权），社区目录也能显示下载量。

注意：

- `repository` 字段必须指回本仓库，否则社区目录不会把 npm 包与仓库关联；
- 官方 `@deepseek-ai/*` 包若要声明，用 `peerDependencies` 且带预发布分支
  （本插件目前只用了 `engines.dsh`，没这问题）；
- `files` 里的 `market`、`docs` 会被一起打包，改分发文件后记得重新发版。

## 三、自建市场索引（官方「发现」页）

DSH 的 Discover 页读的是 **format 1 索引 JSON**，每条 `versions[].source` 可以是
npm 包名，也可以是 git 仓库 + 精确提交。这样不用等任何人审核。

1. **装可选的市场 bundle**（否则插件页没有「发现」标签）：
   插件页里启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，
   或 `dsh plugin --profile <profile> add @deepseek-ai/dsh-experimental-plugin-market-bundle`。
2. **生成索引**：改完版本后

   ```sh
   node market/generate-index.mjs
   ```

   它把指定的提交（默认读 `.git/HEAD`）、`package.json` 的版本与描述写进 `market/index.json`。
   **索引天然落后一个提交**：它只能指向已经存在的提交，所以正常顺序是「发版提交 → 跑生成 →
   再提交索引」。`test/market.test.mjs` 会拦住忘记重新生成的发版。
3. **托管**：`index.json` 放在仓库里，用
   `https://raw.githubusercontent.com/ggrgg13/dsh-smart-compact/main/market/index.json`
   （或经 jsDelivr）。**不要用 GitHub Pages**：DSH 给索引源的时间只有 15 秒。
4. **订阅**：Discover → 索引源 → 添加上面的 URL，之后就能搜到并一键安装。

发版后重新跑第 2 步，索引才会指向新提交。

## 四、社区目录（dshmarket / awesome-dsh-plugin）

社区市场、`awesome-dsh-plugin.com`、`dshmarket.com` 共用一份目录，收录方式是
**往 `awesome-dsh-plugin` 提一个 YAML 文件的 PR**（不是往 `dsh-market/dsh-market` 提）。

条目草稿在 `market/awesome-dsh-plugin-entry.yml`，提交时复制成
`data/plugins/ggrgg13__dsh-smart-compact.yml`。

硬性条件：

- `package.json` 声明 `dsh.bundle` manifest —— ✅ 已有；
- 仓库**创建满 1 天**（CI 自动检查，本仓库建于 2026-11-18 06:14 UTC）；
- 仓库加 `dsh-plugin` topic —— ⬜ 待加；
- 真实可用代码、描述必须与代码一致 —— ✅；
- 选贴合实际功能的分类：`session`（也可 `tools`；选不准维护者会改，不会打回）；
- 可选：`icon:` 用 GitHub 托管的**位图**（svg 不收）；`tarball:` 指向 release 的
  `.tgz`（不发 npm、或仓库无法从源码构建时才需要）。

评审会读源码核对描述，通常一两天内合并；一个 PR 最多 3 条。

## 发版检查清单

- [ ] `package.json` 版本号 +1，`README` 测试数等随之更新
- [ ] `node test/policy.test.mjs && node test/host.test.mjs && node test/routes.test.mjs && node test/client.test.mjs`
- [ ] `docs/75-status.md` 记一条本次改动的状态
- [ ] `git commit && git tag vX.Y.Z && git push --tags`
- [ ] `node market/generate-index.mjs` 再提交（让自建索引指向新提交）
- [ ] 若走 npm：`npm publish`
- [ ] 若改了描述：同步社区目录条目
