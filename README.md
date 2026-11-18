# dsh-smart-compact

让 agent 在**语义合适的边界**（回合结束、阶段完成、关键文档写完之后）自主请求上下文压缩，
而不是等 DSH 内置的自动压缩线在某个步骤中途被动触发。

## 状态

仅规划，**尚无代码**。本仓库当前只有 `docs/`。设计基于实际安装的 DSH 0.2.2-rc.3
（Desktop / profile `desktop`）核对，事实清单见 `docs/10-facts.md`。

## 一句话结论

阈值不是这个插件的价值，**压缩时机**和**压缩前把关键状态落盘**才是。
内置压缩在 deepseek-flash 上要到约 69%（727k tokens）才触发，而触发点与对话语义无关。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/00-overview.md` | 背景、目标、非目标、是否值得做的判断 |
| `docs/10-facts.md` | 已核实的 DSH 行为与数字（含来源）与待验证项 |
| `docs/20-design.md` | 架构、触发时序、失败处理、存储 |
| `docs/30-agent-facing.md` | 工具、system prompt、动态信息、缓存分析 |
| `docs/40-gui.md` | GUI 位置、默认策略、agent 一键建议卡 |
| `docs/50-roadmap.md` | 里程碑、风险、验收标准 |
| `docs/60-decisions.md` | 决策记录（含被否决的方案） |

## 预期形态

一个可安装的本地 DSH bundle：Host 半（工具 + 策略 + prompt + action card kind）+
Client 半（模型菜单里的会话选项）。最终以 `Plugins > Add plugin` 安装本目录。
