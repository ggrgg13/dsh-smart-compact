# 10 · 已核实的 DSH 行为

核对对象：Desktop 安装的 DSH `0.2.2-rc.3`，profile `desktop`。
下面是本仓库设计所依赖的事实；每条都标了来源包与文件。

## 1. 内置自动压缩

- 服务：`ctx.compaction`，三个抽象方法 `compactIfNeeded` / `compactNow` / `compactRegion`
  （`@deepseek-ai/dsh-compaction`）。
- 实现：`BasicCompactionEngine`（`@deepseek-ai/dsh-compaction-basic/src/index.ts`）。
  `auto` 默认 `true`。自动触发点有三处：
  - `agent/pre-step`：`compactIfNeeded(agent, 'pressure', signal)`；
  - `agent/request-error`：遇到 `CONTEXT_WINDOW_EXCEEDED_CODE` 后 `'context-overflow'`；
  - `agent/request`：切换模型时按新路由预检，失败会拒绝切换。
- 阈值公式（`src/config.ts`）：

  ```
  messageBudget   = W − reservedOutput
  pressureBudget  = messageBudget − headroomTokens
  thresholdTokens = floor(min(W × thresholdRatio, pressureBudget))
  retainTokens    = floor(messageBudget × retainRatio)        # 或显式 retainTokens
  ```

  默认值：`thresholdRatio = 0.8`、`headroomTokens = 65_536`、`retainRatio = 0.16`。
  `reservedOutput` 取请求 header 的 `config.maxTokens`，否则取适配器默认值
  （DeepSeek 适配器默认单次输出上限 256,000，见 `@deepseek-ai/dsh-llm-deepseek/README.md`）。

- 以 `deepseek-flash`（窗口 1,048,576）为例：

  | 量 | 值 | 占窗口 |
  |---|---|---|
  | 自动压缩线 | 727,040 | 69.3% |
  | 保留尾部（verbatim） | 126,812 | 12.1% |

  注意 `min()` 的第二项：窗口越小，headroom 的占比越大（128k 窗口时自动线约 45%）。
  另外 `reservedOutput` 若被模型自身上限压低（例如 128k），自动线会升到 80%。

- 压缩产物：把被选中的旧对话替换为**一条 user 消息**，内容是一个固定 8 段的结构化摘要
  （Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes /
  Pending Jobs / Current Work / Next Step / Critical Context），外加一段"这是自动生成检查点"的前言
  （`src/summarizer.ts`）。摘要由当前路由模型生成（`purpose: 'compaction'`），要多花一次模型调用。
- 压缩本身**从第一个被替换的 token 起使 KV 缓存失效**（`dsh-compaction/README.md`）。

## 2. 手动压缩的边界

- `compactNow` 走 manual bracket：**不允许有 open turn**（`turn: null`），且 agent 必须空闲，
  否则 `ManualCompactionError('busy')`。它先 `agent.runMaintenance(...)` 再压缩。
- `compactNow` 选择范围时 `retainTokens = 0`，因此**只保留最后一个 surface 节点**（最近一条消息），
  其余全部进摘要（`src/region.ts` 的 `selectCompactableRange`，循环在 `retainTokens = 0` 时立即停在最后一个节点）。
  这就是 `/compact` 今天的行为，比自动压缩激进得多。
- `compactRegion` 反过来**要求有 open turn**，否则抛错（`compactSurfaceRegion`）。
  它由调用方给出 `start`/`end`，必须保证 tool-call/result 配对平衡
  （`toolPairingBalancedBefore/After`，从 `@deepseek-ai/dsh-compaction` 导出）。

> 结论：回合内想压缩只能用 `compactRegion`；回合结束后（无 open turn）只能用 `compactNow`。

## 3. 可用的度量

- `ctx.tokenMeter.contextPressure(session)` → `{ pressureTokens?, contextWindow? }`，
  `pressureTokens` 是**最近一次已记录的 provider 请求**的 prompt 大小（滞后一步）。
- `ctx.tokenMeter.measure(session, header?)` → `{ totalTokens, surfaceTokens, nodes: [{seq, tokens, ...}] }`，
  有节点级价格，可以用来算"压缩能释放多少"。
- `ctx.agents.turnBoundaryOf(session)` 可判断当前是否有 open turn。

## 4. GUI 座位

- `conversation.input.model.options`：`list`、`scope: session`、用途原文
  "Session options appended after model and reasoning controls in the root menu"。
  已有一个占用者（`agent-team`）。CLI 侧同层还有 `conversation.hero.options`。
- 主对话 Chat 节点已有 `compaction` / `manual-compaction` / `context` 等 kind（`conversation.chat.node`）。

## 5. Prompt 与缓存

- `ctx.systemPrompt.section()` 注册静态段落；`ctx.systemPrompt.context()` 注册动态上下文。
- 动态上下文（runtime-context）在内容变化时**追加一条新的 `<system-reminder>` user 消息**
  来 supersede 旧快照，不是原位改写（`@deepseek-ai/dsh-agent-loop/src/runtime-context.ts`）。
  也就是说：**每变化一次就多一条消息**。
- system prompt 的更新策略取决于路由：
  - 声明了 `systemPromptUpdate: 'in-history'` 的路由（`deepseek-flash` 默认声明）：
    prompt 变化被**追加**到历史尾部，不重写头部 → 前缀缓存保住；
  - 其他路由：差异会导致头部 node 0 重写 → **整段前缀缓存失效**。
- `agent.inject()` 的上下文"进入下一个被接纳的 step"，天然追加在尾部。
- 跨回合注入的后台通知（例如 action card 的 status notice）"appended after the request's other new context
  and never rewrites earlier messages"（`dsh-action-cards/README.md`）。

## 6. 一键建议卡（action cards）

- 服务 `ctx.actionCards`：`register({ action, skill, invitation, details, verbs, openPhases?, reconcile?, act })`。
- 内置工具 `propose_action`（`@deepseek-ai/dsh-action-cards`）：
  - 只有 root agent、且它**在本回合自己调用 `skill` 加载了该 kind 的 skill** 时才可见；
  - **每回合只接受一张卡**；卡在**回合结束后**才出现；子 agent 不显示；
  - 用户在客户端点按钮 → `actionCards.act(agent, callId, verb, payload)`（`@Remote`）；
  - kind 的 `act()` 里用 `ctx.actionCards.record()` 记录决定，**下一个模型请求**会收到一条 status notice；
  - 该机制是"agent 提议、用户批准"的官方形态，agent 无法自己执行 `act`。
- 客户端 `conversation.chat.node` 的 toolview 键表里已包含 `propose_action`，说明卡片渲染组件已安装。

## 7. 上游限制

- 没有任何模型可用的压缩工具。`dsh-compaction` 的 Known Limitations 明确写着
  "Human command, not a model tool — no model-facing compaction tool is registered"，
  Dev Note 里"model-facing tool"也仍列为未决项。本插件补的就是这个空位。
- 压缩只能压缩 surface（对话历史），不能压缩 system prompt、工具声明与请求信封。

## 8. M0 spike 结论

静态部分已核实完毕，细节与源码引用见 [`spike-results.md`](spike-results.md)。

1. **`compaction.config` 可读**：`CompactionEngine` 是 `Service`
   （`super(ctx, 'compaction')`），`BasicCompactionEngine` 上有
   `readonly config: ResolvedConfig`。运行时用 `Reflect.get` 读；读不到就降级到
   `0.8 / 65_536` 默认值。
2. **idle 时机安全**：`status` 把 `maintenance` 折叠成 `idle`，而 `setPhase` 只在
   状态字符串变化时发事件 → `agent/status('idle')` 每回合只发一次（在 `kick()` 的
   `finally` 里），我们的监听器不会被自己的维护动作再次触发。
3. **存储**：用 `node:fs` 在 `DSH_PROFILE_DIR` 下写一个 JSON（不走 `ctx.storage`），
   按当前实现即可；`ctx.storage` 留作以后需要多写者时再评估。
4. **action cards**：已从设计中移除（ADR-10），不再需要验证。
5. **释放量**：用 `ctx.tokenMeter.measure(session).totalTokens` 前后相减，
   不用 `contextPressure` 的差值（它滞后一次请求）。

仍待真实装载验证（R1–R5，见 `spike-results.md` 第 7 节）：idle 后 `compactNow`
真的成功、浏览器 cookie/伪造 Host 的栅栏、插件页配置区渲染、客户端半身加载、
`measure()` 差值量级。
