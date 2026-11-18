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

> **已被 ADR-9 取代。** 用户最终要求每会话可设阈值、插件里设默认值；
> 保留此条仅作历史记录。

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

> **已被 ADR-10 取代。** 用户决定取消"agent 建议阈值"这一功能，保留此条仅作历史记录。

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

**Decision**：一个 `smart_compact` 工具，`action: "check" | "request"`。

**Consequences**：
- 少一个工具声明，schema 更短。
- 工具描述必须同时说清两个动作的差别，避免 agent 误用 `request` 当查询。

---

## ADR-8 · 判断标准进 system prompt，数字进运行期，阈值不下放给 agent

**Context**：agent 无法可靠感知 token 压力、窗口与内置线位置，也没有缓存经济学；
把"阈值"交给它，会同时产生"从不压"和"随手压"两种失败。但"当前是不是一个好的语义边界"
只有它知道。

**Decision**：
- 时机判断：agent。system prompt 给正向/反向信号与行为准则（约 100 词），
  并明确"不要为了压缩提前结束回合"。
- 阈值：用户 + 插件策略。agent 不参与阈值的决定，也不能自己改（ADR-10）。
- 数字：`check` 工具与一次性通知提供，绝不每步刷新。

**Consequences**：
- agent 有了可执行的判断表，而不是一句"必要时压缩"。
- 需要额外实现跨阈值提醒，否则 agent 可能忘记 `check`。
- 阈值不会被 agent 悄悄改掉；代价是它只能按用户/插件设定的线行动。

---

## ADR-9 · 阈值 = 全局默认百分比 + 每会话覆盖

**Context**：四档模式（late / balanced / eager）要求用户理解系统线、成本与细节损失的权衡；
而"早一点/晚一点"本质是一个百分比。用户明确要求：每会话可设、插件里有默认值、
不懂的人用默认就好。

**Decision**：
- 全局 `defaultPercent`（默认 60），在插件设置页改；
- 每会话 `threshold` 三态：`default` / `percent`（30–90 整数）/ `off`；
- 生效值 `clamp(percent, 30, railPercent − 2)`，按当前模型窗口换算成 token；
- `off` 只对 `/smart-compact` 命令开放，UI 不暴露；
- 窗口未知时不判定，UI 禁用。

**Consequences**：
- 面板只需要一个滑杆，"跟随默认"一个勾选，用户认知负担最小。
- 换模型或 DSH 调整压缩配置时阈值自动重算，不需要用户重设。
- 现有代码里的 mode 实现需要迁移；迁移期间旧的 `late/balanced/eager` 命令值映射为
  `default` 下的百分比（late → rail−10%，balanced → 60%，eager → 40%）。

---

## ADR-10 · 取消"agent 建议阈值"

**Context**：曾计划让 agent 在发现用户设置与任务不匹配时发一张卡（ADR-4），用户一键接受。

**Decision**：取消。agent 只决定时机（`check` / `request`），不参与阈值的建议、修改或默认值。

**Consequences**：
- 少一个 action kind、一个 skill、一份客户端卡片渲染与冷却逻辑。
- 用户不会被模型引导到它自己无法验证的设置上；不懂的用户保持默认值。
- 产品故事更简单：阈值是人的偏好，时机是模型的判断。

---

## ADR-11 · 客户端读写设置走插件自己的 HTTP 路由

**Context**：客户端需要读写"全局默认 + 每会话阈值"，而 DSH 没有给第三方插件现成的
per-session 设置通道。可选项：typert Remote、会话命令、自定义 HTTP 路由。

**Decision**：用 `ctx.webServer.register` 注册三条精确路由
（`GET /smart-compact/state`、`POST /smart-compact/session`、`POST /smart-compact/default`），
并实现浏览器信任栅栏：回环/受信 Host、`Sec-Fetch-Site`、同源 Origin 校验，
委托 `connection.requestRejection`，异常即拒绝（fail closed）。

**Consequences**：
- 设置变更不污染对话（会话命令方案会在聊天里留 command 行）。
- 需要维护一小段安全相关代码，并在 M0 用真实浏览器请求验证。
- 远程（非回环）访问需要显式降级：只读或隐藏面板，而不是让插件报错。
- 不引入任何第三方插件依赖；`dsh-whale-widget` 只作为写法参考。
