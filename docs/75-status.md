# 75 · 阶段状态（2026-11-18 16:00）

给压缩后的自己：这是当前真实状态，不是计划。

## 0.1.3：压缩后端在 agent 作用域，不在 Host 平面（最新修复）

Host 平面**没有** `compaction` 服务：`dsh-web-app/cordis.patch.yml` 在那里把
`compaction-basic` 置为 `disabled: true`，改由每个 agent preset 挂载
（`presets/*.patch.yml`）。内置 `/compact` 命令同理，由 preset 挂载。

所以宿主插件里 `ctx.get('compaction')` 永远是 `undefined`；必须从 agent 作用域取：

```js
ctx.get('compaction') ?? agent.ctx?.get?.('compaction')
```

真实的 `smart_compact(request)` 报 `no compaction backend is mounted` 就是这个原因。
顺带说明：之前 `check` 显示的 `built-in rail 727k` 是**默认公式**（0.8 / 65536）算出来的，
不是真实配置；修复后才会读到 preset 自己的 `thresholdRatio` / `headroomTokens`。

## 0.1.2：通知消息必须是完整的 UserMessage

`agent.inject()` 接收的是完整 `UserMessage`，不是 `{content, source}` 袋子。之前少了
`role` 与 `id`：

- provider 拒收（`messages[N]: missing field role`），每次重试都重发；
- 更糟：它会作为 `user/message` 落盘，导致**下次加载会话校验失败**，会话打不开。

修法：`noticeMessage()` 统一构造
`{id: randomUUID(), role: 'user', content, source: {kind: 'smart-compact', form: 'notice', summary: ≤120字}}`。
回归测试：`test/host.test.mjs` 的 "an injected notice is a complete user message the loop can persist"。

## 已修的其他问题

| 提交 | 内容 |
|---|---|
| `c3d8d00` | `cordis.patch.yml` 里的包名还是 `@local/...`，首次安装无法 import |
| `deb7689` | 菜单内一交互就关；滑块与占用条分成两条；行样式与相邻行不一致 |
| `3be2701` | 行字号被 `font: inherit` 覆盖；单选值域 `custom` vs `percent` 导致选中态不显示 |
| `faa6d26` | 滑条松手不保存：`draft !== value` 恒为假（value 被父组件同步成 draft） |
| `445aafe` | 保存进行中再次点选会被忽略（防并发写） |
| `53cb62d` | 保存时禁用控件导致 range input 失焦 → 菜单关闭；改为不禁用、忽略重复操作 |

## 当前验证状态

- 36 个测试全过（policy 11 / host 14 / routes 8 / client 2）。
- 以 `link:` 装在 desktop profile；**改的是 index.js，需要重启宿主（或重载插件）才生效**。

## 待办

1. **重启 DSH** 让 0.1.3 生效，然后重新 `smart_compact(request)` 验证 R1。
2. **推送**：本地领先 `origin/main` 若干提交（`c3d8d00` 之后全部），需要用户 `git push`。
3. **从 git 重装验证**：当前是链接安装，发布产物还没验过。
4. UI 未复测：拖滑杆松手后菜单是否保持打开（`53cb62d` 之后）。
