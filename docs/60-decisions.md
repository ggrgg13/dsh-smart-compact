# 60 · 决策记录

格式：Context / Decision / Consequences。改动时追加，不覆盖。

---

## ADR-1 · 压缩在回合结束后执行，不在回合内

**Context**：工具调用发生在回合内，而 `compactNow` 要求没有 open turn；
回合内可用的 `compactRegion` 需要自己选范围并保证 tool 配对平衡。

**Decision**：工具只登记请求；压缩在 `agent/status === 'idle'` 时用
`ctx.compaction.compactNow` 执行。回合内永远不压缩。

**Consequences**：
- 实现最简单，复用 DSH 的命令路径，Chat 里显示为 manual compaction。
- 代价：`compactNow` 只保留最后一个节点，比内置自动压缩激进。若实测损失过大，
  改走 ADR-1b（下一回合 pre-step 的 `compactRegion` + 保留尾部）。

**Revisit**：M2 结束时按实际使用体验决定是否切 B。

---

## ADR-2 · 不要求用户设置 token 阈值，默认从 DSH 配置推导

**Context**：用户不想手工算参数；内置阈值随模型窗口、输出预留和 headroom 变化，
手填数字很容易与真实触发点错位。

**Decision**：默认四档模式，水位线由插件从 `compaction` 实例的 config（或内置默认公式）
与当前窗口推导；数字只作为高级覆盖。

**Consequences**：
- 升级 DSH 或换模型时自动跟随，不需要用户重设。
- 依赖一个抽象接口未声明的字段，需要降级路径与日志。
- 用户失去"精确控制"的直观入口，用"高级…"补偿。

---

## ADR-3 · 动态信息事件驱动，不每步注入

**Context**：runtime-context 是**追加**语义（每次变化多一条 user 消息）；
在非 in-history 路由上，system prompt 变化还会重写头部、整段前缀缓存失效。

**Decision**：
- 策略文本做成静态 section，整个会话只渲染一次；
- 数字走工具 `check`，只在 agent 主动询问时出现；
- 跨水位提醒与压缩结果通知各注入一次。

**Consequences**：
- 长回合不会堆出大量小消息，缓存损失局限在压缩本身。
- agent 需要主动 `check` 才能看到精确读数（一次工具往返）。
- 代价是"agent 不一定会查"，用跨水位通知兜住关键节点。

---

## ADR-4 · 用户一键应用走 action cards

**Context**：需要 agent 提议、用户确认、并且能在对话里留痕的一键操作。

**Decision**：注册 `ctx.actionCards` kind，用内置 `propose_action` 发卡；
`act()` 写入会话策略并 `record()`；agent 只能提议，不能执行。

**Consequences**：
- 复用官方卡片渲染、状态回报与去重（每回合一张）机制。
- 依赖 action-cards 包与其客户端半边；M0 验证，不可用则自绘 toolview。
- agent 必须先加载 kind 的 skill 才能发卡，这是有意的渐进披露。

---

## ADR-5 · 会话状态存在插件自己的存储，不写 Session 日志

**Context**：插件不能 append 新 event type（会破坏会话重开），
而 mode/pending 是插件私有数据。

**Decision**：按 sessionId 存在 `ctx.storage` 里；fork 复制记录（pending 除外）；
subagent 继承 mode 但不共享 pending。

**Consequences**：
- Session 格式零改动。
- fork/同步/跨设备不自动带上策略；需要时可迁移到会话内记录，作为后续增强。

---

## ADR-6 · 不关闭内置自动压缩

**Context**：插件可能失效、被卸载，或被低水位策略误配。

**Decision**：`auto` 保持开启。插件只把压缩提前到边界，内置线永远是兜底。

**Consequences**：
- 最坏情况退回 DSH 原生行为，不会出现"上下文爆掉"。
- 可能出现两次压缩（插件先压、内置线再评估），但内置线在压力已降时会 no-op。

---

## ADR-7 · 工具用 `action` 参数区分 check / request，而不是两个工具

**Context**：DSH 的工具设计倾向"相关操作共用一个工具 + action 参数"，
且每个工具名都会进入首轮 prompt 成本。

**Decision**：一个 `compact_context` 工具，`action: "check" | "request"`。

**Consequences**：
- 少一个工具声明，schema 更短。
- 工具描述必须同时说清两个动作的差别，避免 agent 误用 `request` 当查询。
