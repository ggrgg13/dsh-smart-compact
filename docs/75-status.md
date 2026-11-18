# 75 · 阶段状态（2026-11-18 16:58）

给压缩后的自己：这是当前真实状态，不是计划。

## 0.1.8：空闲时敲命令排队的请求会被立刻消费

现象：用户在空闲会话里敲 `/smart-compact force`，命令成功、`pending` 写进了
`state.json`，但压缩一直没发生（`last.at` 停在上一轮）。

根因：执行器只监听 `agent/status === 'idle'` 的**状态迁移**；人敲命令不开回合，
状态一直是 idle，没有迁移，请求就永远等不到。工具调用没这个问题，因为它在回合内，
回合结束必然有一次 busy→idle。

修复：命令排队后调 `kickIfIdle(agent)`——`agent.status === 'idle'` 时用 `setTimeout(0)`
让命令结果先渲染，再直接跑 `runPending`；回合内排队仍走状态迁移。回执文案从
"本回合结束后执行"改成"随后执行"，对两种情形都成立。新增 host 测试覆盖"无状态事件也执行"。

测试：49 个（policy 12 / host 23 / routes 9 / client 2 / market 3）。

**验收（2026-11-18 16:55，测试 session `b3d0…` 实测）**

两条入口都跑通，且都能在对话里看见：

- 工具：15:56 `smart_compact(request)` → 16:35 `command/run compact` →
  `compaction/summary` → `command/done "Compacted 246 history items (~104884 tokens)"`；
  本会话那次释放 443,925 tokens。
- 命令：16:52:25 空闲时 `/smart-compact force` → 同一秒派发 `compact` →
  16:52:34 summary（0.1.8 的 `kickIfIdle` 生效；0.1.8 之前同一动作要等到下一个回合结束）。
- 带参数：`args:" force"` / `" 30"` / `" 40"` 全部进入处理器（0.1.7 的 `input.hint`）。
- busy：16:45 排队的请求在 16:51 回合结束的 idle 迁移时才消费，没有丢。

## 0.1.7：命令声明 `input.hint`，带参数的行才会进命令通道

现象：用户敲 `/smart-compact force`、`/smart-compact status`，两条都以普通消息进会话
（`user/message`，见测试 session 的 seq 689/700/842/860），宿主没有 `command/run`。

根因：`dsh-client-ui-commands/src/client/service.ts` 的 `matchEnter`——没有 `input`
描述符的宿主命令是 bare 命令，`if (!bare) return undefined` 放弃认领，带参数的行就被当
普通提示词提交。`/permission danger-full-access` 正常，是因为它声明了 `input`。

修复：命令加 `input: { hint: 'status | 40 | default | off | force [原因]' }`，测试锁定其存在。
副作用（有意接受）：菜单选中改为插入 `/smart-compact ` 等你补参数；空参回车=status。

测试：45 个（policy 12 / host 22 / routes 9 / client 2）。

## 0.1.6：绕过阈值是插件页开关（默认关），工具/命令/prompt 跟随

动机：要在很小上下文里验证压缩链路，而 30% 下限让廉价会话永远不达标。

- `state.json` 新增全局 `allowForce`（默认 false，`migrateState` 保证缺失即关）；
- 开启时注册 `smart_compact_force` 工具 + 一段 prompt（order 321）+ `/smart-compact force [原因]`；
  关闭时立即 dispose，模型下一次请求就看不到；
- 强制请求写 `pending.force = true`，执行层跳过阈值 / 未知窗口 / 压力三项判断；
- **off 不绕过**（工具与命令都明确报错）；仍只在回合结束后执行一次，
  通知标为 `Compacted older history (forced bypass); ~N tokens freed`；
- 新增路由 `POST /smart-compact/force`（`{allowForce: boolean}`），`GET /state` 回带开关；
- 插件页多一个勾选 + 说明；模型菜单行在开启时显示「绕过已开启」。

测试：44 个全过（policy 12 / host 21 / routes 9 / client 2）。

**注意**：改的是 `index.js` 与 `client.js`，以 `link:` 安装的实例需要重启宿主
（或重载插件）才会出现开关与新工具；浏览器端还要刷新页面以加载新的 client bundle。

## 0.1.5：通过 `/compact` 命令派发，并让用户看得见

0.1.4 直接调用 handler，能压缩但会话里没有痕迹。用户明确要求：**压缩时要能在对话里
看到这条用户指令**，而不是干等。所以 0.1.5 优先走
`ctx.commands.execute(agent, '/compact', [], signal)`：

- `command/run` 在摘要调用**开始前**落盘 → 用户立刻看到"正在压缩"；
- `command/done` 在结束后落盘，带结果（Compacted N items / No compactable history）；
- 拿不到 dispatcher 时退回直接调用 handler（无痕迹但功能相同），
  再退回宿主/agent 作用域的 `compaction`，都没有才报 unavailable。

## 0.1.4：压缩后端的真正入口是 `/compact` 命令

两次实测否定了前两个猜测：

1. 宿主平面没有 `compaction`（`dsh-web-app` 禁用了 `compaction-basic`）；
2. **Agent 作用域也没有**——preset 把后端挂在 `cordis:group` + `isolate` 里，
   而 `Agent.ctx` 是 `this.runtime.ctx`（进程级 loop runtime，见
   `dsh-agent-loop/src/index.ts:470`），不在那个分组内。

可达缝隙：同一个 preset 分组挂了 `command-compact`，命令注册表按 agent 作用域合并
（`dsh-commands` 的 `view(agent)`），所以 `ctx.commands.find(agent, 'compact')`
能拿到定义，其 handler 闭包里握着被隔离的压缩服务。

0.1.4 的 `compactNow()` 顺序：宿主/agent 作用域的 `compaction` → `/compact` handler
→ 都没有才算 unavailable。直接调 handler（不走 `commands.execute`），
避免会话里多出一条"用户执行了 /compact"的记录。

## 0.1.3：错误地以为 agent 作用域可解（已被 0.1.4 取代）

见上。`ctx.get('compaction') ?? agent.ctx?.get?.('compaction')` 两处都是 undefined。

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

- 49 个测试全过（policy 12 / host 23 / routes 9 / client 2 / market 3）。
- 以 `link:` 装在 desktop profile；改 `index.js` 需重载插件（插件页开关）或重启宿主，
  改 `client.js` 需刷新页面。
- 压缩链路已实测：工具触发、命令触发、空闲时命令立即触发三条都跑通（见 0.1.8 验收记录）。
- M0 可行性 spike 的静态部分已完成，结论见 `docs/spike-results.md`。

## 待办

1. **推送**：本地领先 `origin/main`，需要用户 `git push`。
2. **UI 复测**：拖滑杆松手后菜单保持打开（`53cb62d` 之后未复测）。
3. **跨阈值提醒**：只有单测，长会话里还没真实复现到“首次越线时注入一次提醒”。
4. **发布**：从 git URL 重装验证发布产物；社区目录收录见 `docs/80-distribution.md`。
