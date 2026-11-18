# 70 · 实现状态

> 更新时间：2026-11-18。本文件记录**已经写完的代码**与**尚未验证的部分**，不是设计愿景。

## 结论

Host 半与 Client 半都已实现，32 个测试通过。**尚未安装到 profile**，所以真实运行时行为
（`compactNow` 在 idle 的时序、浏览器栅栏与 cookie、客户端 bundle 的加载与渲染）
还没有在 DSH 里验证过——按约定，安装放在功能满意之后一次性做。

## 文件

| 文件 | 作用 |
|---|---|
| `policy.js` | 纯函数：rail / 百分比夹紧 / 迁移 v1 模式 / 读数格式化。无 Harness 依赖。 |
| `index.js` | Host 插件：工具、prompt 段、命令、idle 执行器、跨阈值提醒、状态持久化、设置门面。 |
| `routes.js` | 三条 HTTP 路由 + 信任栅栏 + 线上校验；同样无 Harness 依赖，可单测。 |
| `client.js` | Client 半：模型菜单一行（含面板）、插件页默认阈值、中英文案。 |
| `cordis.patch.yml` | 插入一行 `smart-compact`（Host 半）；Client 半由 `dsh.client` 声明加载。 |
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（`platform: 'web'`）+ `exports['./client']`。 |
| `locale/{en,zh}.json` | 插件卡片元数据（`meta.title/description/detail`），供插件管理器读取。 |
| `test/policy.test.mjs` | 11 个策略测试（rail、夹紧、窗口过小、迁移、读数文案）。 |
| `test/host.test.mjs` | 11 个集成测试（假 Cordis context，跑真实注册与执行路径）。 |
| `test/routes.test.mjs` | 8 个路由测试（栅栏、方法、媒体类型、体积上限、字段校验、卸载）。 |
| `test/client.test.mjs` | 2 个客户端测试（bundle 注册、两个槽的注册参数）。 |

## 运行行为

1. system prompt 增加静态段（order 320）：判断准则与"压缩前先落盘"。
2. 注册 `compact_context` 工具：
   - `check` 返回 `context 700k/1.05M (67%) · suggested 60% (629k) · built-in rail 69% (727k) · ...`；
   - `request` 在低于阈值、关闭、已有 pending 时明确拒绝，否则登记 pending。
3. 注册 `/smart-compact` 命令：`status|off|on|default|<percent>`。
4. `agent/status === 'idle'` 时消费 pending：
   - 仍低于阈值 → 丢弃并通知；
   - 否则 `ctx.compaction.compactNow(agent, signal)`；
   - `busy` 时保留请求，下个 idle 重试一次；
   - 成功/失败/无可用范围都写一条回执（`agent.inject`，不唤醒会话）。
5. `agent/pre-step` 时若压力首次越阈值，注入一次提醒；回落到 90% 以下后复位。
6. 每会话状态写入 `<DSH_PROFILE_DIR>/smart-compact/state.json`（150ms 防抖，v2 结构）。
7. 注册 `webServer` 路由（仅当组合里存在 `webServer` 与 `connection` 两个服务）：
   - `GET /smart-compact/state?sessionId=…`
   - `POST /smart-compact/session`
   - `POST /smart-compact/default`
8. Client 半在 `conversation.input.model.options` 注册一行、在 `plugins.bundle.config` 注册插件页控制。

## 实现期的设计决定

- **不 import 任何 `@deepseek-ai/*` 包**。本地 bundle 以链接目录安装，裸导入无法从
  workspace 解析；因此工具定义直接用 JSON Schema 注册（不走 `defineTool`），
  持久化直接用 `node:fs`，不依赖 `ctx.storage` 的 form/domain。
- **工具参数用标准 JSON Schema**（`type/properties/required/additionalProperties`），
  不是 DSH 的 DSL；注册表只要求 `ToolSchema.parameters` 是 JSON。
- **状态文件放在 profile 目录**，不放 workspace：它是插件私有偏好，不应污染用户仓库；
  写入失败要静默降级，不能因为 profile 只读就让压缩失败。
- **回执用 `agent.inject`**，不用 followup：不应因为压缩而唤醒空闲会话。
- **freed tokens 用 `tokenMeter.measure()` 前后差值**（决定见 `spike-results.md` §5），
  不用 `contextPressure` 的差值，也不用 `shadowedTokenCount`。
- **路由挂载用 `ctx.inject(['webServer','connection'], …)`**：headless 组合里这两个服务不存在，
  回调不执行，插件在没有 Web 端时照常工作（`spike-results.md` §3 的栅栏写法）。
- **栅栏拒绝一律 fail closed**：`requestRejection` 抛错时按 403 处理，不放行。
- **Client 半手写、不引入构建链**：`window.__ModuleLoader__.load({id, factory})` +
  `exports.apply/inject`，与 DSH 自己的客户端 bundle 同构；React 从模块表 `require('react')` 取。
- **面板做成菜单内联展开**，不是浮层：模型菜单自己管理浮层与焦点，内联展开不会与它打架。
  滑杆只在松开时提交（`pointerup/cancel/keyup/blur`），一次拖动只写一次。
- **UI 文案写在 `client.js` 里**，`locale/*.json` 只保留插件卡片元数据——客户端 bundle
  无法读取包的 JSON 文件，两处维护反而更容易失配。

## 已偏离计划的点

- 没有 `Config` schema：阈值走命令与 GUI，插件设置项由我们自己的路由承载（见 ADR-11）。
- 没有 action cards：原 M4（agent 建议阈值）已按 ADR-10 取消，不是待办。
- 插件页默认值滑杆范围是 30–90：真正的上限取决于模型，由每会话的夹紧负责。
- 状态没有清理策略：每个 session 一条记录，长期使用会缓慢增长（后续加 TTL 或上限）。

## 验证清单

已做：

- `node --check index.js` / `client.js` 通过。
- `node test/policy.test.mjs` 11/11、`test/host.test.mjs` 11/11、
  `test/routes.test.mjs` 8/8、`test/client.test.mjs` 2/2。

未做（需要在 DSH 里安装后验证）：

- [ ] 本地链接安装后，Loader 能解析 `@local/dsh-smart-compact` 这一行。
- [ ] 工具用标准 JSON Schema 注册（代替 `defineTool`）能通过输出值校验。
- [ ] 回合结束进入 idle 时 `compactNow` 成功，Chat 出现 manual-compaction 节点。
- [ ] 用户紧接着发消息时 `busy` 在下一个 idle 重试一次。
- [ ] `agent.inject` 的回执与提醒在下一个回合真的被模型看到，且不重复。
- [ ] `dsh.client` 半身被加载，模型菜单出现「上下文压缩」行。
- [ ] 浏览器端 `fetch` 带 cookie 通过栅栏；伪造 Host / 跨站被 401/403。
- [ ] 插件页出现默认阈值滑杆，保存后刷新仍在。
- [ ] `measure()` 前后差值的量级合理。

## 阈值迁移（已完成）

原实现的 `mode: off/late/balanced/eager` 已按 ADR-9 迁移为：

- 全局 `state.defaultPercent`（默认 60，插件页可改）；
- 每会话 `{ kind: 'default' | 'percent' | 'off' }`；
- 生效值 `clamp(percent, 30, floor(railPercent) − 2)`；
- v1 状态文件自动迁移：`off → off`、`late → 99%(夹紧到上限)`、`eager → 40%`、
  `balanced → default`（`policy.js` 的 `migrateState`）。

## 安装

在 **Plugins → Add plugin** 选择本目录；或对具备 Full access 的会话执行
`plugin_manager install_bundle`，target 指向本目录。安装后新开会话验证，
不要让当前会话承担首次压缩。
