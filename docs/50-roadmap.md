# 50 · 路线图、风险与验收

> 进度（2026-11-18）：M0 静态部分完成（`docs/spike-results.md`），M1、M2、M3 代码已写完，
> 尚未安装验证。R1–R5 五项运行时验证在安装时一次做完。

## M0 · 可行性 spike（临时 bundle，约半天）

只验证，不追求完整：

1. 在 `agent/status === 'idle'` 回调里调用 `ctx.compaction.compactNow(agent, signal)`，
   确认：能在回合刚结束时成功压缩；用户立刻发消息时确实 `busy`，且可重试。
2. 确认 `ctx.get('compaction')` 实例上能否读到 `config`（thresholdRatio / headroomTokens）；
   读不到时降级到内置默认值。
3. 在 `ctx.webServer.register` 上注册一个精确路由，确认：
   - 路由形状（`kind: 'exact'`、handler 的 req/res 约定）；
   - `connection.requestRejection(req)` 的真实入参与返回；
   - 浏览器端 `fetch('/smart-compact/...')` 能带上会话 cookie；
   - 跨站/伪造 Host 的请求确实被拒。
4. 注册 `plugins.bundle.config`（keyed 槽，key 为包名），确认 `view: 'page' | 'summary'`
   两种渲染与 `ownerProps.form` 的行为。
5. 记录 `compactNow` 前后 `contextPressure` 的变化，确认能算出 released tokens。

**产出**：`docs/spike-results.md`（结论 + 反例 + 代码位置），并更新 `docs/10-facts.md` 的待验证清单。

**失败预案**：

- `compactNow` 在 idle 回调里不稳定 → 改走路径 B（下一回合 pre-step 的 `compactRegion`）。
- 路由不可用或被拒 → 退回会话命令通道（`ctx.remote.commands.execute`），接受对话里多一行 command；
  读取改用自建 session projection 折叠 `command/run`。
- `compaction.config` 读不到 → 阈值退回"内置默认公式"，不阻塞发布。

## M1 · 最小可用（Host only）

- `smart_compact` 工具（`check` / `request`）。
- pending 记录 + `agent/status` 执行器 + 失败/竞争处理。
- 静态 system prompt 段落。
- 单测：阈值判定、pending 生命周期、busy 重试、低于阈值拒绝。

**验收**：在新会话里让 agent 主动在阶段结束时请求压缩；日志显示压缩发生在 `turn/end` 之后，
Chat 里出现 DSH 自己的 manual-compaction 节点；用户下一条消息从压缩后的上下文开始。

**实测（2026-11-18）**：通过。工具请求在 idle 后派发 `command/run compact`，
日志里是 `compaction/summary` + `command/done "Compacted 246 history items (~104884 tokens)"`，
压缩后本会话又回到 ~24k tokens。

## M2 · 阈值模型与提醒

- 全局默认阈值 + 每会话三种状态（default / percent / off），替换当前的 mode 实现。
- 阈值从系统线夹紧：`clamp(percent, 30, railPercent − 2)`。
- 跨阈值一次的 `agent.inject` 提醒。
- 压缩结果通知（成功/跳过/失败）。
- fork / subagent 的继承规则。

**验收**：长会话里 agent 在到达系统线之前收到过一次提醒并完成一轮"落盘 + 请求压缩"；
内置线仍能在插件缺席时正常兜底。

**实测（2026-11-18）**：部分通过。三态阈值（`/smart-compact 30|40`、`default`、`off`）与
收到 `Compacted older history; ~444k tokens freed` 回执都验证了；**跨线提醒只做了单测**，
真实长会话里尚未复现到"首次越过建议线时注入一次提醒"。

## M3 · GUI

- 模型菜单一行 + 面板：当前占用（`contextPressure` 投影）、建议线滑杆、系统线刻度、跟随默认/恢复默认。
- 插件设置页：全局默认阈值（同一个滑杆组件，`view: 'page'`）。
- 设置通道：`GET /smart-compact/state`、`POST /smart-compact/session`、`POST /smart-compact/default`，
  带浏览器信任栅栏与字段校验。
- 文案中英文；主题 token；键盘与焦点。

**验收**：能在一个会话里改阈值，另一个会话不受影响；重启 DSH 后设置仍在；
不选模型时滑杆禁用；伪造 Host / 跨站请求被拒；样式与模型菜单其他行一致。

**实测（2026-11-18）**：通过。会话级阈值写入 `state.json` 的 per-session 记录；
插件页全局默认阈值与绕过开关在插件重载/重启后保留；shell 直接请求路由返回 401，
页面内读写正常；菜单行与面板样式沿用 `ModelSelect` 的 cell 度量。

## M4 · 已取消

原计划是"agent 建议阈值、用户一键接受"。取消原因：

- 模型无法可靠估计 token 与成本，也拿不到压缩效果的反馈；
- 它会把自己的偏好包装成建议，把用户引向错误的设置；
- 不懂的用户本来就用默认值，不需要建议；懂的用户自己会调。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `compactNow` 只保留最后一个节点，过于激进 | 回合间连续性下降 | v1 观察；必要时切路径 B（保留尾部） |
| idle 竞争窗口 | 偶尔跳过压缩 | 下一回合重试一次；内置线兜底 |
| 读 DSH 私有 `config` | 升级后可能失效 | best-effort + 默认公式降级 + 启动日志 |
| 自定义路由的鉴权 | 越权读写别的会话 | 回环/同源校验 + 委托 `requestRejection` + fail closed；M0 实测 |
| 远程访问（非回环） | 面板可能不可用 | 明确降级：只读或隐藏，不让插件报错 |
| 提醒变噪音 | agent 反复被提示 | 每阈值一次 + 90% 滞回 + 只在跨阈值时注入 |
| 子会话 | 每个子会话都在压缩，成本上升 | M2 决定子会话默认 `off` 或继承 |
| 设置读写与工具读状态的时序 | 改了阈值后行为不一致 | 阈值只从一份存储读；路由写入后立即生效 |

## 不做什么（防止范围膨胀）

- 不做 token 使用图表、历史曲线、跨会话统计。
- 不做"自定义摘要提示词"。
- 不做 agent 建议卡、不做"一键按模型建议调整"。
- 不依赖任何已安装第三方插件的接口、事件或数据。
- 不改 `compaction-basic` 的配置，不关闭 `auto`。
- 不做 Chat 新节点类型（沿用 `manual-compaction`）。
