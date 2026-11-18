# 75 · 阶段状态（2026-11-18 15:45）

给压缩后的自己：这是当前真实状态，不是计划。

## 已修的关键 bug（`dd60b88`，v0.1.2）

`agent.inject()` 接收的是**完整的 `UserMessage`**，不是 `{content, source}` 袋子。
之前通知消息少了 `role` 与 `id`：

- provider 拒收（`messages[N]: missing field role`），每次重试都重发；
- 更糟的是它会作为 `user/message` 落盘，导致**下次加载会话时校验失败**，会话打不开。

修法：`noticeMessage()` 统一构造 `{id: randomUUID(), role:'user', content, source:{kind:'smart-compact', form:'notice', summary:≤120字}}`。
回归测试：`test/host.test.mjs` 的 "an injected notice is a complete user message the loop can persist"。

## 已修的其他问题

| 提交 | 内容 |
|---|---|
| `c3d8d00` | `cordis.patch.yml` 里的包名还是 `@local/...`，导致首次安装无法 import |
| `deb7689` | 菜单内一交互就关；滑块与占用条分成两条；行样式与相邻行不一致 |
| `3be2701` | 行字号被 `font: inherit` 覆盖；单选值域 `custom` vs `percent` 导致选中态不显示 |
| `faa6d26` | 滑条松手不保存：`draft !== value` 恒为假（value 被父组件同步成 draft） |
| `445aafe` | 保存进行中再次点选会被忽略（防并发写） |

## 当前验证状态

- 33 个测试全过（policy 11 / host 12 / routes 8 / client 2）。
- 插件以 `link:` 方式装在 desktop profile，宿主已重启并加载 0.1.2。
- `smart_compact(check)` 可用；阈值越过提醒已真实触发（state.json 里 `crossed: true`，阈值 40%）。

## 待办

1. **推送**：本地领先 `origin/main` 6 个提交（`c3d8d00`…`445aafe`），需要用户执行 `git push`。
2. **从 git 重装验证**：当前是链接安装；发布产物需要用
   `git+https://github.com/ggrgg13/dsh-smart-compact.git` 装一次确认。
3. `docs/70-implementation.md` 的验证清单里 R1（idle 后 `compactNow` 成功）还没打勾——
   本次请求压缩若成功，就是 R1 的首次真实通过。
4. UI 最后一条未验：拖滑杆松手是否还会关菜单（已按"保存期间不禁用控件、避免焦点丢失"改过，
   但还没在界面上复测）。
