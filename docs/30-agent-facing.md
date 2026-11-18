# 30 · Agent 侧：判断标准、工具与动态信息

## 两个决策要分开

| 决策 | 谁拥有 | 理由 |
|---|---|---|
| **什么时候压**（时机） | agent | 只有它知道当前处在编辑、诊断还是阶段边界 |
| **多早算该压**（阈值/水位） | 用户 + 插件策略 | 本质是"省钱 vs 保细节"的偏好；agent 估不准 token，也会把它当成本地玩具 |

agent 可以在明显不匹配时**提议改模式**（见 `40-gui.md` 的建议卡），但不能在会话里偷偷改水位。

## agent 该考虑什么

正向信号（满足越多越该压）：

1. **处在边界上**：一个阶段完成、文档/笔记已落盘、要切换到不相关的子任务。
2. **下一阶段能靠磁盘 + 摘要跑起来**，不需要原始工具输出、报错串、长 diff。
3. **会话后面还有大量工作**；快收尾了压了也是白压。
4. **内置线快到了**：与其让系统在某个步骤中途被动压，不如自己挑一个时刻先压。
5. **这一回合的最后一条回答能自包含**——`compactNow` 只保留最后一个节点，
   最后这条消息是唯一逐字保留的东西；如果它承载了下一步需要的信息，就能压。

反向信号（有一条就别压）：

- 编辑到一半、诊断到一半、工具链中间（未配对的 call/result）；
- 计划、决定、路径只存在于对话里，还没落盘；
- 用户正在等一个回答，压完还得重新读文件才能答；
- 最近刚压过、压力还没回来——反复"摘要的摘要"是纯损失；
- 子 agent 马上要交结果：它的上下文会随结果消失，压它是浪费一次摘要调用。

两个成本项：一次摘要调用（输入大多命中缓存，输出 2–4k tokens）；
压缩本身从替换点起让 KV 缓存失效。

## 它判断不了的事

当前 token 数、窗口大小、内置线在哪、缓存命中价差。
这些只能由插件给，因此所有数字都走运行期，不写进指令。

## 三层分工：每层只说一次

| 层 | 内容 | 成本 |
|---|---|---|
| System prompt（静态） | 判断标准与行为准则 | 约 100 词，只渲染一次，进前缀缓存 |
| 工具描述 | 机制与硬约束（回合后运行、只留最后一条、要一次摘要调用） | 每次请求随 schema 发送，反正已存在 |
| 运行期 | `check` 读数、跨水位一次提醒、压缩结果通知 | 每事件一次 |

### System prompt 段落

```
You can compact your own history with `compact_context`. Compaction replaces older
history with a structured summary and keeps only the most recent message; anything
not on disk is at risk.

Compact at a boundary you chose: a phase is finished, notes are written, or you are
switching to an unrelated subtask. Do not compact mid-edit, mid-diagnosis, or while
the plan exists only in the conversation. Never cut a turn short to compact.

If the window is filling and real work remains, compact before the system does it
for you; if the task is nearly done, finish first. Persist decisions, paths and the
next step before you request it.
```

规则：

- 只说一次。工具定义不重复"什么时候用"，prompt 不重复参数含义。
- 不和 `compaction` 包自己的摘要提示重复（那是给摘要器的）。
- 不写数字，数字走工具与通知。

### 工具描述

```
Read the context budget, or request compaction of older history. A request runs
after this turn ends, never mid-turn; it keeps only the most recent message and
costs one summarization call.
```

### 工具 schema

```jsonc
{
  "name": "compact_context",
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

### 返回

`check`：

```
context 437k/1049k (42%) · watermark 629k · built-in rail 727k · compaction would free ~430k
```

`request`：

```
queued for the end of this turn (turn 12). It runs only if pressure is still above the watermark.
Before you finish: write decisions, file paths and the next step to disk.
```

低于水位：

```
not queued: context 118k/1049k (11%) is below the watermark 629k; no compaction needed yet
```

不提供"立刻压"：回合内没有这个语义（`compactNow` 需要没有 open turn），工具不应假装有。

## 为什么不把这段放进 skill

- 静态 prompt 段约 130 tokens，只渲染一次并进前缀缓存，几乎免费；
- skill 省下的正是这 130 tokens，代价是 agent 可能永远不加载它；
- 判断标准需要在 agent 还没想到"压缩"之前就生效，加载式披露不适合。

## 为什么不每步刷新数字

两个机制决定了"每步变一次"的代价：

1. **runtime context 是追加语义**：内容变化时新造一条 `<system-reminder>` user 消息去
   supersede 旧快照，不是原位改写。每步变化的数字 = 每步一条消息，长回合会堆出大量小消息。
2. **system prompt 的更新策略取决于路由**：`deepseek-flash` 声明 `in-history`，变化追加在尾部、
   前缀缓存保住；其他路由不支持，prompt 一变就重写头部，**整段前缀缓存失效**。

因此：静态策略进 `section()`；数字走 `check`；跨水位与结果各通知一次。

## 已知失败模式

- 每个回合结束都"顺手压一下"，上下文一直在低水位重置；
- 为了让压缩发生而提前结束回合；
- 压缩后把刚丢的东西全部重读一遍，净负收益；
- 在用户等待确认时压缩，把待确认的细节压掉。
