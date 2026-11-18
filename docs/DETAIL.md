# 智能压缩（Smart compact）

让 agent 在回合结束时、在自己选定的语义边界上压缩上下文，而不是等内置自动压缩线在某个步骤中途触发。

## 它做什么

- 给 agent 一个工具 `compact_context`：
  - `action: "check"` 读取当前占用、建议阈值（百分比 + token）、内置自动线、压缩可释放量；
  - `action: "request"` 登记一次压缩请求，**回合结束后**才执行。
- 在 system prompt 里加一段静态判断准则（约 100 词）：何时该压、何时不该压、压缩前先落盘。
- 压力首次越过阈值时，给 agent 注入一次提醒（同一段水位只提醒一次）。
- 压缩成功/跳过/失败后，在下一个回合给 agent 一条回执，成功时带"释放了多少 token"。
- GUI：
  - **模型菜单**（模型/推理等级下面）一行「上下文压缩 42% / 60% ›」，展开有三标记刻度条
    （已用 / agent 压缩点 / Harness 自动线）与滑杆，松开即保存；
  - **插件页**里设置所有新会话的默认百分比。

## 它不做什么

- 不替换、不关闭内置自动压缩（`compaction-basic` 仍然兜底）。
- 不在回合内压缩：`compactNow` 需要没有进行中的 turn。
- 不新增 Chat 节点类型，压缩记录沿用 DSH 自己的 manual compaction。
- 不让模型自己建议阈值（见 ADR-10：模型估不准，容易把用户引向错误的设置）。

## 阈值怎么算

用户选的是**窗口百分比**，不是 token 数：

```
rail            = min(W × thresholdRatio, W − reservedOutput − headroomTokens)   # 内置自动线
railPercent     = rail / W
maxPercent      = floor(railPercent) − 2                                         # 永远留 2 个点
percent         = clamp(用户选择, 30, maxPercent)
thresholdTokens = floor(W × percent / 100)
```

`thresholdRatio`（默认 0.8）、`headroomTokens`（默认 65536）从 `compaction-basic` 实例上读，
`W` 与 `reservedOutput` 来自当前路由的模型信息。以 `deepseek-flash` 为例：
内置线 727,040（69.3%），上限 67%，默认 60% = 629,145。

窗口未知时不猜：面板显示"第一次请求之后才知道窗口大小"，滑杆禁用。
窗口太小、内置线下方放不下 30% 时，明确说"不给建议"，也不猜。

## 用法（命令行仍然保留）

```
/smart-compact            # 查看当前会话的阈值与读数
/smart-compact 55         # 本会话 55%
/smart-compact on         # 本会话回到插件默认值
/smart-compact default    # 同上
/smart-compact off        # 本会话关闭（内置自动压缩仍生效）
```

GUI 是主要入口；命令用于脚本化或没有 Web 端的场合。

## 已知限制

- `compactNow` 只保留最后一个 surface 节点，属于激进压缩；回合间连续性依赖最后一条回答是否自包含。
- 状态按 sessionId 存在 profile 目录（`smart-compact/state.json`），fork 不继承（后续增强）。
- 命令与工具文案目前只有英文；GUI 文案中英双语。
- 与 DSH 升级的耦合点：`compaction` 实例上的 `config` 是 best-effort 读取，读不到时回退到
  `thresholdRatio 0.8` / `headroomTokens 65536`。
- 面板的"已用"读数来自 `contextPressure` 投影，滞后一次请求（与 DSH 自己的 ContextMeter 一致）。
