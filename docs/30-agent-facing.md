# 30 · Agent 侧：工具、提示与动态信息

## 一个工具，两个动作

```jsonc
{
  "name": "compact_context",
  "description": "Check the context budget, or ask for compaction of older history. A request runs after this turn ends, never mid-turn.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["check", "request"],
        "description": "check: read pressure and what compaction would free. request: queue compaction for the end of this turn."
      },
      "reason": {
        "type": "string",
        "description": "For request: one short line for the user, such as 'phase 2 done, notes written'."
      }
    },
    "required": ["action"]
  }
}
```

### 返回格式

`check` 只读：

```
context 437k/1049k (42%) · watermark 629k · built-in rail 727k · compaction would free ~430k
```

`request` 在同样读数前加一行：

```
queued for the end of this turn (turn 12). It runs only if pressure is still above the watermark.
Before you finish: write decisions, file paths and the next step to disk.
```

低水位时请求被拒绝而不是排队：

```
not queued: context 118k/1049k (11%) is below the watermark 629k; no compaction needed yet
```

不做第三件事（比如"强制压缩"）：`compactNow` 本来就只能在没有 open turn 时跑，
回合内没有"立刻压"这个语义，工具就不应该假装有。

## System prompt 段落（静态，约 90 词）

```
You can compact your own conversation history with the `compact_context` tool.
Compaction replaces older history with a structured summary and keeps only the
most recent message; anything older is gone unless it is on disk.

Request it at a natural boundary: a phase is finished, notes and decisions are
written, or you are about to start an unrelated subtask. Do not request it in the
middle of an edit or a diagnosis, or while plans exist only in the conversation.
It runs after this turn ends, never mid-turn, and costs one extra model call, so
treat it as a budget tool rather than a habit. Before requesting, persist what
the next session needs: decisions, paths, next step.
```

规则：

- 只说一次。工具定义不重复"什么时候用"，prompt 不重复参数含义。
- 不和 `compaction` 包自己的摘要提示重复（那是给摘要器的，不是给 agent 的）。
- 不写数字，数字走工具与通知。

## 动态信息：默认不每步出现

三条渠道，按成本从低到高：

| 渠道 | 触发 | 成本 |
|---|---|---|
| `compact_context check` | agent 自己想知道时 | 一次工具往返 |
| 跨水位通知（`agent.inject`） | 压力首次越过水位的那个回合 | 一条短消息，每段水位最多一次 |
| 压缩结果通知 | 压缩成功/跳过/失败后的下一个回合 | 一条短消息 |

通知文案示例（一次，不重复）：

```
Context is at 68% of the window; the built-in automatic compaction line is near.
If you are finishing a phase, write handoff notes and call compact_context(action: "request").
```

## 为什么不能每步刷新

两个机制决定了"每步变一次"的代价：

1. **runtime context 是追加语义**：`RuntimeContextProjection.project()` 在内容变化时
   **新造一条 `<system-reminder>` user 消息**去 supersede 旧快照，不是原位改写。
   每步变化的数字 = 每步一条消息，长回合里会堆出几十上百条小消息，直到被压缩掉。
2. **system prompt 的更新策略取决于路由**：
   - `deepseek-flash` 声明 `systemPromptUpdate: 'in-history'`：变化的 prompt 追加在尾部，
     前缀缓存保住，但每变一次就多一条 system 消息；
   - 其他路由不支持 in-history：prompt 变一次就重写头部 node 0，**整段前缀缓存失效**，
     而 DeepSeek 的缓存命中价差很大。

因此：

- 静态策略 → `ctx.systemPrompt.section()`，整个会话渲染一次，永不变。
- 动态数字 → 不做成 prompt/context 的每步内容。
- 压缩本身 → 替换点在历史中部，缓存从替换点失效，这是压缩固有的代价，无法避免；
  能做的是让它在**边界**发生，而不是在一条工具链中间。

## 应该给 agent 的信息

1. **读数**：已用 / 窗口 / 百分比、水位线、内置线、压缩可释放量。（`check` 或通知里给）
2. **规则**：什么时候请求、什么时候不请求、压缩前先落盘。（prompt 里给）
3. **后果**：压缩只保留最近一条消息；更早的内容只剩 8 段摘要，
   精确报错串、长代码片段、中间推理可能丢；**磁盘上的文件不丢**。（prompt 里一句话概括）
4. **结果回执**：成功释放多少、被跳过、还是失败，让 agent 能向用户解释。（通知里给）
5. **不要给**：节点级 token 明细、内置阈值配置细节、每步数字、"你可以强制压缩"这种不存在的能力。
