# 50 · 路线图、风险与验收

## M0 · 可行性 spike（1 个临时 bundle，约半天）

只验证，不追求完整：

1. 在 `agent/status === 'idle'` 回调里调用 `ctx.compaction.compactNow(agent, signal)`，
   确认：能在回合刚结束时成功压缩；用户立刻发消息时确实 `busy`，且可重试。
2. 确认 `ctx.get('compaction')` 上能否读到 `config`；读不到时的行为如何降级。
3. 注册一个 action kind，验证 `propose_action` 全链路（skill 加载 → 卡片 → 点击 → record → notice）。
4. 找到 `ctx.storage` 里按 sessionId 存小 JSON 的正确 form。
5. 记录 `compactNow` 前后 `contextPressure` 的变化，确认能算出 released tokens。

**产出**：`docs/spike-results.md`（结论 + 反例 + 代码位置），并更新 `docs/10-facts.md` 的待验证清单。

**失败预案**：

- `compactNow` 在 idle 回调里不稳定 → 改走路径 B（下一回合 pre-step 的 `compactRegion`）。
- action cards 的客户端渲染不可用 → 退回自绘 toolview + `@Remote` 方法（用户操作仍是唯一写入方）。
- `compaction.config` 读不到 → 水位线退回"内置默认公式 + 插件 Config"，不阻塞发布。

## M1 · 最小可用（Host only）

- `compact_context` 工具（`check` / `request`）。
- pending 记录 + `agent/status` 执行器 + 失败/竞争处理。
- 静态 system prompt 段落。
- 单测：水位判定、pending 生命周期、busy 重试、低于水位拒绝。

**验收**：在新会话里让 agent 主动在阶段结束时请求压缩；日志显示压缩发生在 `turn/end` 之后，
Chat 里出现 DSH 自己的 manual-compaction 节点；用户下一条消息从压缩后的上下文开始。

## M2 · 策略与提醒

- 从 DSH 配置推导水位线（含降级路径）。
- 跨水位一次的 `agent.inject` 提醒。
- 压缩结果通知（成功/跳过/失败）。
- fork / subagent 的继承规则。

**验收**：长会话里 agent 在到达内置线之前收到过一次提醒并完成一轮"落盘 + 请求压缩"；
内置线仍能在插件缺席时正常兜底。

## M3 · GUI

- 模型菜单里的会话选项（模式、三条参考线、恢复默认）。
- 高级覆盖（ratio / tokens），切模型时重算。
- 文案中英文。

**验收**：能在一个会话里切换模式，另一个会话不受影响；重启 DSH 后设置仍在；
样式与模型菜单其他行一致，遵守主题 token 与 locale。

## M4 · agent 建议卡

- `skill` + action kind + `act()` 写入 + status notice。
- 触发条件（连续压缩、短任务却 eager、窗口变化导致 token 覆盖失效）。
- 冷却：用户 `keep` 后一段时间不再提。

**验收**：构造一个明显不匹配的会话，agent 提出一次建议，用户点击后模式立即生效，
agent 在下一个请求里收到决定，且不会重复发卡。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `compactNow` 只保留最后一个节点，过于激进 | 回合间连续性下降 | v1 观察；必要时切路径 B（保留尾部） |
| idle 竞争窗口 | 偶尔跳过压缩 | 下一回合重试一次；内置线兜底 |
| 读 DSH 私有 `config` | 升级后可能失效 | best-effort + 默认公式降级 + 启动日志 |
| 依赖 action cards | 某 profile 没装客户端半边 | M0 验证；不可用则自绘 toolview |
| 提醒变噪音 | agent 反复建议压缩 | 每水位一次 + 冷却 + 只在跨水位时注入 |
| 子会话 | 每个子会话都在压缩，成本上升 | M2 决定子会话默认 `off` 或继承 |

## 不做什么（防止范围膨胀）

- 不做 token 使用图表、历史曲线、跨会话统计。
- 不做"自定义摘要提示词"。
- 不改 `compaction-basic` 的配置，不关闭 `auto`。
- 不做 Chat 新节点类型（沿用 `manual-compaction`）。
