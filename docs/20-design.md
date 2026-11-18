# 20 · 架构与触发时序

## 组件

```
dsh-smart-compact/
├─ package.json          # dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # insert: host 行；client 自动发现
├─ index.js              # Host：工具、prompt、策略、action kind、存储
├─ client.js             # Client：模型菜单里的会话选项
├─ locale/*.json         # 中英文案
├─ docs/                 # 本目录
└─ icon.svg
```

Host 半边包含四个关注点，互相之间只通过一个策略服务（`SmartCompactPolicy`）通信：

1. **工具** `request_compaction`：只登记请求，不执行压缩。
2. **回合后执行器**：监听 `agent/status`，在 `idle` 时决定是否调用 `ctx.compaction.compactNow`。
3. **prompt 贡献**：一段静态 system prompt 段落（策略说明）。
4. **action kind** `smart-compact.policy`：承载"agent 建议、用户一键接受"。

## 触发流水线（推荐路径 A：回合结束后立即执行）

```
agent 调 request_compaction
   │
   ├─ 校验：没有正在进行的 compaction / 压力 ≥ 地板 / 本会话未禁用
   ├─ 写 per-session pending 记录（存储 + 内存）
   └─ 返回 “queued for the end of this turn; write handoff notes first”
   │
   ▼  （agent 继续、结束回合）
turn/end 落盘
   │
   ▼
agent/status === 'idle'
   │
   ├─ 重新度量 pressure
   ├─ pressure < watermark ?  → 丢弃 pending，返回/记录 skipped
   └─ pressure ≥ watermark    → ctx.compaction.compactNow(agent, signal)
          │
          ├─ 成功：记录 freed tokens，清理 pending
          ├─ busy：保留 pending，下个 idle 再试一次
          └─ 失败：记录失败原因，注入一次简短 notice
   │
   ▼
下一个回合的第一步：注入一次 notice（成功/跳过/失败 + 读数）
```

### 为什么不在回合内

- 回合内工具调用期间 agent 不是 idle，`compactNow` 会 `busy`。
- 只有 `compactRegion` 能在回合内跑，但要自己选范围、保证配对平衡，且会让当前步骤的前缀缓存从替换点失效。
- 回合结束是天然的语义检查点：agent 的回答已完成，摘要里的 "Current Work" / "Next Step" 准确。

### 备选路径 B：下一回合首个 pre-step 执行 `compactRegion`

在下一个用户消息触发的 pre-step 里，用自己选定的范围（保留 DSH 配置的尾部）压缩。
好处是能保留最近上下文（`compactNow` 只保留最后一个节点）；坏处是：

- 要复制 `selectCompactableRange` 的逻辑（约 40 行）并自己读取 retain 预算；
- 压缩延迟落在**用户下一条消息**的首个响应前，用户会多等一次摘要调用；
- 用户如果不发新消息，就永远不会压缩。

| 维度 | A：idle + compactNow | B：next pre-step + compactRegion |
|---|---|---|
| 时机 | 回合结束立刻 | 下一条用户消息之前 |
| 保留尾部 | 仅最后一个节点（激进） | 可保留 DSH 配置的尾部（温和） |
| 额外代码 | 无 | 范围选择 + 预算推导 |
| 失败风险 | busy 竞争，可重试 | 无（turn 已开） |
| 建议 | **v1 默认** | v2 增强，按需切换 |

## 水位线（watermark）

不要求用户输入数字。默认从 DSH 自身配置推导：

```
rail      = min(W × ratio, W − reservedOutput − headroom)   # 尽量读 compaction 实例的 config
watermark = clamp(0.6 × W, 0, rail − margin)                # margin 默认 0.05 × W
```

- 读不到 `config` 时退回内置默认值（ratio 0.8 / headroom 65,536）并记录一次警告。
- 水位线只决定"回合结束时值不值得花钱压缩"，不决定 agent 是否请求。
- agent 的请求是**语义判断**，水位线是**成本闸门**：低于水位时请求会被跳过并告知"还不需要"。
- 自动压缩保持开启；如果内置线先到，pending 失效，下一回合 notice 会说明"已由系统压缩"。

## 会话状态

每个 session 一条记录（`storage`，按 sessionId 键）：

```jsonc
{
  "mode": "balanced",          // off | late | balanced | eager
  "override": null,            // 高级：{ ratio?: number, tokens?: number }
  "pending": {                 // 未完成的请求；有则会在 idle 时消费
    "requestedAt": 1732000000000,
    "turn": 12,
    "reason": "phase done, docs written"
  },
  "lastResult": { "at": 1732000123000, "freedTokens": 312000, "status": "ok" }
}
```

- fork：复制父会话的记录（pending 除外）。
- subagent：默认继承父会话的 mode，但**不共享 pending**；子会话的压缩由子会话自己的请求触发。
  是否让子会话默认 `off` 可在 M2 决定。

## 与内置自动压缩的协作

- `auto` 保持 `true`。插件不写别人的 Config，不重启别人。
- 插件把压缩"提前"到边界，内置线只是兜底；两者的阈值不冲突：
  - `pressure ≥ watermark` 且回合结束 → 插件压缩；
  - 回合中途越线 → 内置压缩，插件在下一回合告知 agent。
- 如果用户在自己的 `cordis.patch.yml` 里调了 `compaction-basic` 的阈值，插件的 watermark 会自动跟随。

## 失败与竞争

| 场景 | 处理 |
|---|---|
| idle 时用户/父 agent 立刻发来消息 | `compactNow` 抛 `busy` → pending 保留，下个 idle 重试一次，再失败则放弃并告知 |
| 同一 session 已有进行中的压缩 | 跳过本次，pending 清除 |
| 摘要调用失败 | 记录失败原因，`compaction/start` 残留由 DSH 的锁语义处理，插件不做清理 |
| 会话被归档/agent 被 dispose | 丢弃 pending |
| 插件被卸载 | pending 留在存储里，下次加载时若 turn 已结束则执行一次或直接丢弃（M1 决定，默认丢弃） |
| 压缩后压力仍高于内置线 | 交给内置自动压缩，插件不再追加 |

## 观测

- 成功：Host 日志 `smart-compact: freed N tokens (turn T)`。
- GUI：模型菜单里的状态行显示 `上次压缩释放 ~Nk`（可选）。
- Chat：沿用 DSH 已有的 `manual-compaction` 节点，不新增 Chat kind（M1 不做）。
