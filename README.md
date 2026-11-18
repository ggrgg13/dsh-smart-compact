# dsh-smart-compact

让 agent 在**语义合适的边界**（回合结束、阶段完成、关键文档写完之后）自主请求上下文压缩，
而不是等 DSH 内置的自动压缩线在某个步骤中途被动触发。

## 状态

Host 半已实现，14 个单元/集成测试通过；**尚未安装到 profile**，GUI 未做。
M0 可行性 spike 的静态部分已完成，结论见 `docs/spike-results.md`。
实现细节与未验证项见 `docs/70-implementation.md`。设计基于实际安装的 DSH 0.2.2-rc.3
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
| `docs/40-gui.md` | GUI 规格：模型菜单一行、面板、插件页默认值、设置通道 |
| `docs/50-roadmap.md` | 里程碑、风险、验收标准 |
| `docs/spike-results.md` | M0 可行性结论（路由、槽、idle 时机、配置可读性）与待验项 |
| `docs/60-decisions.md` | 决策记录（含被否决的方案） |
| `docs/70-implementation.md` | 已实现的 Host 半、实现期决定、验证与未验证项 |

## 预期形态

一个可安装的本地 DSH bundle：Host 半（工具 + 策略 + prompt + 压缩执行器）+
Client 半（模型菜单里的会话选项 + 插件页默认阈值）。最终以 `Plugins > Add plugin` 安装本目录。
