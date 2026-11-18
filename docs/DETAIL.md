# 智能压缩（Smart compact）

让 agent 在回合结束时、在自己选定的语义边界上压缩上下文，而不是等内置自动压缩线在某个步骤中途触发。

## 它做什么

- 给 agent 一个工具 `compact_context`：
  - `action: "check"` 读取当前压力、水位线、内置自动线、压缩可释放量；
  - `action: "request"` 登记一次压缩请求，**回合结束后**才执行。
- 在 system prompt 里加一段静态判断准则（约 100 词）：何时该压、何时不该压、压缩前先落盘。
- 压力首次越过水位线时，给 agent 注入一次提醒（同一段水位只提醒一次）。
- 压缩成功/跳过/失败后，在下一个回合给 agent 一条回执。

## 它不做什么

- 不替换、不关闭内置自动压缩（`compaction-basic` 仍然兜底）。
- 不在回合内压缩：`compactNow` 需要没有进行中的 turn。
- 不新增 Chat 节点类型，压缩记录沿用 DSH 自己的 manual compaction。
- 目前没有 GUI（模型菜单里的会话选项尚未实现），用 `/smart-compact` 命令管理。

## 用法

```
/smart-compact             # 查看当前模式与读数
/smart-compact off         # 只靠内置自动压缩
/smart-compact late        # 接近内置线才在回合结束压
/smart-compact balanced    # 默认：约 60% 窗口时在回合结束压
/smart-compact eager       # 约 40% 窗口
/smart-compact reset       # 回到默认
```

水位线由 `compaction-basic` 的 `thresholdRatio` / `headroomTokens` 与当前模型的窗口推导，
用户不需要填 token 数。每会话独立，记录在 profile 的 `smart-compact/state.json`。

## 已知限制

- `compactNow` 只保留最后一个 surface 节点，属于激进压缩；回合间连续性依赖最后一条回答是否自包含。
- 状态按 sessionId 存在 profile 目录，fork 不继承（后续增强）。
- 命令与工具文案目前只有英文。
- 与 DSH 升级的耦合点：`compaction` 实例上的 `config` 是 best-effort 读取，读不到时回退到
  `thresholdRatio 0.8` / `headroomTokens 65536`。
