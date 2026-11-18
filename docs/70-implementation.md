# 70 · 实现状态（Host 半）

> 更新时间：2026-11-18。本文件记录**已经写完的代码**与**尚未验证的部分**，不是设计愿景。

## 结论

Host 半已实现并通过 14 个单元/集成测试。**尚未安装到 profile**：
`plugin_manager install_bundle` 的 danger-full-access 升级被拒绝，因此真实运行时行为
（`compactNow` 在 idle 的时序、`inject` 落点、GUI 呈现）还没有在 DSH 里验证过。

## 文件

| 文件 | 作用 |
|---|---|
| `policy.js` | 纯函数：rail/watermark 计算、模式归一化、读数格式化。无 Harness 依赖，可单测。 |
| `index.js` | Host 插件：工具、prompt 段、命令、idle 执行器、跨水位提醒、按会话状态持久化。 |
| `cordis.patch.yml` | 插入一行 `smart-compact`。 |
| `package.json` | bundle 清单（`dsh.bundle.patch`）。 |
| `test/policy.test.mjs` | 8 个策略测试（含 flash 的 727,040 / 629,145 数字）。 |
| `test/host.test.mjs` | 6 个集成测试（假 Cordis context，跑真实注册与执行路径）。 |

## 运行行为

1. system prompt 增加静态段（order 320）：判断准则与"压缩前先落盘"。
2. 注册 `compact_context` 工具：
   - `check` 返回 `context 700k/1.05M (67%) · watermark 629k · built-in rail 727k · ...`；
   - `request` 在低于水位、off 模式、已有 pending 时明确拒绝，否则登记 pending。
3. 注册 `/smart-compact` 命令：`status|off|late|balanced|eager|reset`。
4. `agent/status === 'idle'` 时消费 pending：
   - 仍低于水位 → 丢弃并通知；
   - 否则 `ctx.compaction.compactNow(agent, signal)`；
   - `busy` 时保留请求，下个 idle 重试一次；
   - 成功/失败/无可用范围都写一条回执（`agent.inject`，不唤醒会话）。
5. `agent/pre-step` 时若压力首次越水位，注入一次提醒；压力回落到 90% 以下后复位。
6. 每会话状态写入 `<DSH_PROFILE_DIR>/smart-compact/state.json`（150ms 防抖）。

## 实现期的设计决定

- **不 import 任何 `@deepseek-ai/*` 包**。本地 bundle 以链接目录安装，裸导入无法从
  workspace 解析；因此工具定义直接用 JSON Schema 注册（不走 `defineTool`），
  持久化直接用 `node:fs`，不依赖 `ctx.storage` 的 form/domain。
- **工具参数用标准 JSON Schema**（`type/properties/required/additionalProperties`），
  不是 DSH 的 DSL；注册表只要求 `ToolSchema.parameters` 是 JSON。
- **状态文件放在 profile 目录**，不放 workspace：它是插件私有偏好，不应污染用户仓库；
  写入失败要静默降级，不能因为 profile 只读就让压缩失败。
- **先做命令、后做 GUI**：命令是当前唯一无需 client↔host RPC 的人类入口，
  先用它验证策略与执行链路；GUI 的读路径（模式 + 实时读数）尚未选定，放在 M3。
- **回执用 `agent.inject`**，不用 followup：不应因为压缩而唤醒空闲会话。
- **freed tokens 用压缩前后的 `pressureTokens` 差**：`compactNow` 的返回值带
  `shadowedTokenCount`，但那是被替换内容的估价；压力差更接近用户感知的"省了多少窗口"。

## 已偏离计划的点

- 没有 `Config` schema（模式走命令）；计划里的"四档模式 + 高级覆盖"只实现了四档。
- 没有 action cards：原 M4（agent 建议阈值）已按 ADR-10 取消，不是待办。
- 没有 GUI：M3 已按 `40-gui.md` 重新定义，等待迁移与实现。
- 状态没有清理策略：每个 session 一条记录，长期使用会缓慢增长（后续加 TTL 或上限）。

## 验证清单

已做：

- `node --check index.js` / `policy.js` 通过。
- `node test/policy.test.mjs` 8/8。
- `node test/host.test.mjs` 6/6（注册、读数、拒绝、idle 执行、去重、off、跨水位提醒去重）。

未做（需要在 DSH 里安装后验证）：

- [ ] 本地链接安装后，Loader 能解析 `@local/dsh-smart-compact` 这一行。
- [ ] 工具用标准 JSON Schema 注册（代替 `defineTool`）能通过输出值校验。
- [ ] 安装后工具真的出现在 agent 的工具列表里。
- [ ] 回合结束进入 idle 时 `compactNow` 成功，Chat 出现 manual-compaction 节点。
- [ ] 用户紧接着发消息时 `busy` 是否按预期重试一次。
- [ ] `agent.inject` 的回执在下一个回合真的被模型看到。
- [ ] 结束回执与提醒不会造成重复注入。

## 迁移到 ADR-9 的阈值模型（未开始）

当前代码用 `mode: off/late/balanced/eager`，与新决定的"全局默认百分比 + 每会话覆盖"不一致。
迁移清单：

1. `policy.js`：`computePolicy` 接受 `percent` 而不是 `mode`；输出 `effectivePercent`、`thresholdTokens`；
   保留 `railPercent` 供 UI 夹紧与显示。
2. `index.js`：会话记录改为 `{ threshold: { kind: 'default' | 'percent' | 'off' } }`；
   全局 `{ defaultPercent }` 与 `sessions` 放在同一状态文件；`ensure()` 不再写 mode。
3. 命令：`/smart-compact set <percent>`、`/smart-compact reset`、`/smart-compact off`，
   旧的 `late|balanced|eager` 接受但映射为百分比并提示已弃用。
4. 新增三条路由（见 `40-gui.md`）与浏览器信任栅栏。
5. 测试：迁移 `test/policy.test.mjs` 的期望值；`test/host.test.mjs` 改用 `threshold`；
   新增路由校验的用例（伪造 Host、跨站、非法 percent、未知 session）。
6. `docs/DETAIL.md` 同步命令用法与"模式→百分比"的变化。

迁移完成前，`DETAIL.md` 里描述的 `late/balanced/eager` 仍是当前代码的真实行为。

## 安装

在 **Plugins → Add plugin** 选择本目录；或对具备 Full access 的会话执行
`plugin_manager install_bundle`，target 指向本目录。安装后新开会话验证，不要让当前会话承担首次压缩。
