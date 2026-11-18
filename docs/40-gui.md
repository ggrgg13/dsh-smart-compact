# 40 · GUI、默认策略与"agent 建议、一键应用"

## 位置

`conversation.input.model.options`（`scope: session`，模型菜单里、模型与推理强度之后）。
理由：这是唯一"会话级 + 与模型窗口强相关"的现成座位，已有占用者（agent-team），
且用户对"上下文预算"的心智本来就是和模型选择放在一起的。

菜单是弹层，所以**不要把滑杆塞进去**。形态：

```
模型        deepseek-flash
推理强度    high
────────────────────────
上下文压缩  平衡 · 约 60% 时在回合结束触发   ›
```

点这一行展开一个二级面板（或小弹层）：

```
上次压缩    释放约 312k（3 回合前）
当前占用    42%  (437k / 1049k)
会触发于    压力 ≥ 629k 且回合结束时
内置自动线  727k（DSH 自身配置）
[ 关闭 ] [ 晚一点 ] [ 平衡 ] [ 更积极 ] [ 高级… ]
```

- 默认只暴露**四档模式**与"关闭"；数字只藏在"高级…"里。
- "当前占用 / 会触发于 / 内置自动线"三条线一起显示，用户才看得懂发生了什么。
- 新会话取插件 Config 的默认模式；面板里有"恢复默认"。

## 模式（默认不要求用户设数字）

| 模式 | 行为 | 适用 |
|---|---|---|
| `off` | agent 的请求直接拒绝，只靠内置自动压缩 | 短会话、调试插件 |
| `late` | 水位 = 内置线 − 1×margin，接近自动线才在回合结束时压 | 不想损失细节 |
| `balanced`（默认） | 水位 = 0.6×W，且不超过内置线 − margin | 大多数情况 |
| `eager` | 水位 = 0.4×W | 长任务、按 token 付费敏感 |

- `margin` 默认 `0.05×W`，插件 Config 可调。
- 水位只决定"回合结束时值不值得花钱"，agent 的语义判断仍然是第一道闸门。
- 高级覆盖：允许 `{ ratio: 0.5 }` 或 `{ tokens: 400000 }`，写进同一个会话记录；
  百分比按当前路由窗口换算，切模型后自动重算，绝对 token 超出窗口时提示。

## 用户设定与任务不匹配时：agent 建议卡

### 机制选择

用 DSH 内置的 action cards，而不是自己拼一个按钮：

- `ctx.actionCards.register(kind)` 注册 kind，内置工具 `propose_action` 负责发卡；
- agent 先加载 kind 的 `skill`，然后调用 `propose_action`，卡在**回合结束后**出现；
- 用户点击 → 客户端调 `actionCards.act(agent, callId, verb, payload)`（`@Remote`）；
- kind 的 `act()` 调用我们自己的 host 方法写入会话策略，再用 `ctx.actionCards.record()` 记录决定；
- 下一个模型请求会收到一条 status notice，agent 知道用户选了什么；
- **agent 不能自己执行 `act`**，一键应用永远是用户动作，符合"确认类权限只属于用户"。

不用 `ask_user_question` 的原因：它只能问，不能把答案变成一次配置写入，
也留不下可回看的卡；action cards 天然记录决定并回报给 agent。

### kind 草案

```jsonc
{
  "action": "smart-compact.set-mode",
  "skill": "smart-compact-policy",       // 加载后才可见 propose_action
  "invitation": "你可以在下面的卡片里一键切换这个会话的压缩策略。",
  "details": {
    "current": "balanced",
    "suggested": "eager",
    "why": "这个任务预计会持续很久，60% 水位下每个回合结束都可能压缩，摘要开销偏高。",
    "options": ["eager", "balanced", "off"]
  },
  "verbs": { "apply": {}, "keep": {} },
  "act": "写入 mode → record({ phase: 'applied' | 'kept' })"
}
```

- `apply` 写入建议值；`keep` 保持不变（也记录，避免反复建议同一件事）。
- `dismiss` 由框架处理。
- 卡片可附带可选数字（`details.ratio`），但默认只给模式；用户想调数字走"高级…"。

### 什么时候才建议

只在**检测到明确不匹配**时提议，避免变成噪音：

- 会话规模与模式冲突：例如 `balanced` 下已经连续 3 个回合触发压缩 → 建议 `late`；
- 任务显然很短却设了 `eager`（例如前 10 个回合压力 < 15%）→ 建议 `balanced` 或 `off`；
- 用户设了绝对 token 但换了小窗口模型 → 建议按百分比重算。

每个 kind 每回合最多一张卡，天然限流；同一会话对同一建议的 `keep` 会让插件一段时间内不再提。

## 否决的放置方案

- **Settings 页**：全局粒度，会把"每个会话单独设"做成"一次设全部"，语义不对。
- **header utilities**：与模型无关的位置，用户找不到，且和模型窗口割裂。
- **Composer 常驻压力条**：可以作为以后的补充（`conversation.input.dock`），
  但常驻 UI 需要额外的 client 投影与 wire view，第一版不做。
- **自定义 HTML/iframe**：违反 DSH 主题与 locale 机制，且卡片渲染已经现成。
