# dsh-smart-compact

Let the agent decide *when* the conversation gets compacted — at a semantic
boundary it recognises, such as a finished phase or a written handoff — instead
of waiting for the harness' own compaction rail to fire in the middle of a step.

With a per-session suggested threshold kept safely below that rail, a live
reading in the model menu, and one command that asks for compaction right now.

> 让 agent 在**语义合适的边界**自主请求上下文压缩，而不是等 DSH 内置的自动压缩线
> 在某个步骤中途被动触发。阈值按会话设置，永远低于系统自动线；模型菜单里实时显示
> 占用与建议线，一条命令可以立刻压。

## 为什么需要它

DSH 内置的压缩在 deepseek-flash 上要到约 **69%（727k tokens）** 才触发，而这个触发点
和对话走到哪里毫无关系：它可能正好切在“刚读完代码、还没开始改”的中间。真正值钱的不是
阈值，而是**压缩时机**——以及压缩之前把关键状态落到磁盘上。

这个插件把“什么时候压”交还给 agent 自己（它知道当前阶段结没结束），同时让用户能用
一条命令强制在当下压缩。内置自动线仍然兜底，插件不替换它。

背景与事实核对：`docs/00-overview.md`、`docs/10-facts.md`。

## 它做什么

- **工具 `smart_compact`**：`check` 读取当前占用、建议阈值、内置自动线、可释放量；
  `request` 登记一次压缩请求，**回合结束后**执行（若已在阈值之上）。
- **system prompt 段**：一小段判断准则——何时该压、何时不该压、压缩前先写手记。
- **跨线提醒**：压力首次越过建议线时提醒 agent 一次，回落到 90% 以下才复位。
- **回执**：压缩成功/跳过/失败后，在下一个回合告诉 agent 结果与释放的 token 数。
- **GUI**：模型菜单里一行「上下文压缩 · 已用 42% / 建议线 60%」，展开是刻度条与三态
  （跟随默认 / 自定义 / 关闭），拖动松手即保存；插件页设置新会话的默认百分比。
- **命令 `/smart-compact`**：查看、改阈值、关闭、或强制压缩（见下）。

## 安装

要求 DSH **≥ 0.2.2-rc.1**；在 Desktop 0.2.2-rc.3、profile `desktop`、模型
`deepseek-flash` 上实测通过（含工具触发与人用命令触发两条压缩路径）。

**桌面版**：打开 Plugins 页 → 添加插件 → 填入

```
github:ggrgg13/dsh-smart-compact
```

**命令行**：

```sh
dsh plugin --profile <profile> add github:ggrgg13/dsh-smart-compact
```

**本地开发**：把本目录以 `link:` 装进 profile。改 `index.js` 后需要重载插件
（插件页开关一次）或重启宿主；改 `client.js` 后刷新页面。

## 用法

### 图形界面（主要入口）

- **模型菜单**里那行「上下文压缩」：点开可以看到已用、建议线、系统自动线三个标记，
  选「跟随默认 / 自定义 / 关闭」，拖滑杆松手就保存。
- **插件页**里设置所有新会话的默认百分比，以及「允许绕过阈值（测试用）」开关。

### 斜杠命令

```
/smart-compact            # 查看本会话阈值与读数（等同 status）
/smart-compact 55         # 本会话设为 55%
/smart-compact default    # 回到插件默认值
/smart-compact off        # 本会话关闭（内置自动压缩仍然生效）
/smart-compact force 原因  # 立刻排队一次压缩，无视建议线（需先打开绕过开关）
```

### 给 agent 的工具

```jsonc
{ "action": "check" }                          // 读读数，不做任何修改
{ "action": "request", "reason": "阶段 2 完成，手记已写" }
```

`request` 只在压力达到建议线时才真正压缩；低于阈值、已关闭、已有排队请求都会被明确拒绝
并说明原因。

## 阈值怎么算

用户选的是窗口百分比，不是 token 数。建议线从内置自动线往下夹紧，永远留 2 个点余量：

```
rail            = min(W × thresholdRatio, W − reservedOutput − headroomTokens)
maxPercent      = floor(rail / W × 100) − 2
percent         = clamp(用户选择, 30, maxPercent)
```

`deepseek-flash`（1,048,576 窗口）下：内置线 69%（727k），上限 67%，默认 60%（629k）。
窗口未知时不猜——面板会说明“第一次请求之后才知道窗口大小”。完整推导见
`docs/DETAIL.md`。

## 它不做什么

- 不替换、不关闭内置自动压缩，内置线仍会兜底。
- 不在回合内压缩：DSH 的 `compactNow` 要求当前没有进行中的 turn。
- 不新增 Chat 节点，压缩记录沿用 DSH 自己的 manual compaction 节点。
- 不让模型建议阈值（模型估不准窗口与成本，容易把用户引向错误设置）。

已知限制（激进压缩只留最后一条消息、fork 不继承设置、部分读数滞后一次请求等）列在
`docs/DETAIL.md` 末尾。

## 测试

```sh
node test/policy.test.mjs && node test/host.test.mjs && node test/routes.test.mjs \
  && node test/client.test.mjs && node test/market.test.mjs
```

49 个测试：策略 12 / 宿主 23 / 路由 9 / 客户端 2 / 市场索引 3。
`npm test` 会跑全部；索引那 3 个用来防止发版时忘了重新生成 `market/index.json`。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/DETAIL.md` | 插件详情页正文：功能、阈值推导、命令、已知限制 |
| `docs/00-overview.md` | 背景、目标、非目标 |
| `docs/10-facts.md` | 已核实的 DSH 行为与数字（含来源） |
| `docs/20-design.md` | 架构、触发时序、失败处理、存储 |
| `docs/70-implementation.md` | 实现、验证清单与实测证据 |
| `docs/75-status.md` | 当前状态与最近的修复（给接手的人） |
| `docs/80-distribution.md` | 分发：GitHub / npm / 社区目录 / 自建索引 |

## 许可证

MIT
