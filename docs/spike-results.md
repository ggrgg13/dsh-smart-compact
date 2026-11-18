# 55 · M0 可行性 spike 结果

日期：2026-11-18。核对对象：Desktop 安装的 DSH `0.2.2-rc.3`，profile `desktop`。

本机的 DSH 源码全在 `resources\app.asar` 归档里，没有可用的检出目录；
下面的结论来自对归档内 `node_modules/@deepseek-ai/*` 源码的逐条阅读
（用仓库外的只读脚本 `asar.mjs` 浏览，未改动 DSH 安装）。

结论先行：M0 的**设计前提全部成立**，没有需要改方案的地方；
三项只有在真实会话里才能验的行为，被推迟到"第一次以插件形态装载时"，
清单见本文最后一节。

---

## 1. idle 时机与 `compactNow` 竞争（M0-1）

### 状态机（`dsh-agent-loop/src/agent.ts`）

```ts
get status(): AgentStatus {
  return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
}

private setPhase(next: Phase): void {
  const previousStatus = this.status
  this.phase = next
  const status = this.status
  if (status !== previousStatus) this.dispatch.emit('agent/status', { status })
}
```

三条事实：

1. `maintenance` 阶段对外**仍报 `idle`**。所以我们的监听器在维护开始/结束时
   **不会被再次触发**——不存在 `idle → compactNow → idle` 的递归自激。
2. `agent/status('idle')` 只在 `running → idle` 时发出一次，位置在 `kick()` 的
   `finally` 里（`setPhase({ kind: 'idle', lastTurn })` 之后才 `wakeDriver()`）。
   即：**回合确实已经收尾、turn 已关闭**，满足 manual bracket 的前提。
3. `runMaintenance` 的前提是 `phase.kind === 'idle'`；不满足时同步抛
   `agent "..." already has active work`。`compactNow` 把这个异常统一包成
   `ManualCompactionError('busy', ...)`（`dsh-compaction-basic/src/index.ts` 的
   `compactNow`，catch 覆盖了 job 的全部异常）。

### 与用户下一条消息的竞争

- 维护进行中用户发消息：`wakeDriver()` 看到 `phase.kind === 'maintenance'`，
  只把 `wakeRequested` **挂起**；`runMaintenance` 的 `finally` 在结束时
  `if (wakeRequested && inbox.hasPending) wakeDriver()`，消息不丢。
- 代价：用户会看到"发出后等一会儿才开始回应"，等多久取决于摘要那一次模型调用。
  这是可接受的，且只在恰好压线时发生。
- 我们的执行器不能"先 await 再调用"。若在 `agent/status` 回调里先 `await`
  了度量/网络，期间用户可能已经开出新回合，`runMaintenance` 会抛
  `already has active work`。处理：**捕获后放弃本次压缩**（用户已继续，
  压缩本来就该让位），并清掉 pending 记录。

### 两个不会失败的方向

- 已 idle 但 `selectCompactableRange(...) === null`：`compactNow` 返回 `null`，
  正常跳过，不报错。
- 自动压缩（`agent/pre-step`）那时已经压过：`measure().totalTokens` 低于阈值，
  我们自己的判定先一步拦下，不会白花一次摘要调用。

---

## 2. `compaction.config` 可读性（M0-2）

`@deepseek-ai/dsh-compaction` 的 `CompactionEngine extends Service`，构造里
`super(ctx, 'compaction')`（`src/index.ts:121`）；`BasicCompactionEngine` 继承它，
并有一个 public readonly 字段：

```ts
/** Resolved and validated compaction configuration. */
readonly config: ResolvedConfig
```

即运行时 `ctx.compaction.config` **就在实例上**（类型上只声明在子类，所以要
`Reflect.get` 读，和 `dsh-host-open-in-app` 读 `connection` 的写法一致）。

`ResolvedConfig`（`dsh-compaction-basic/src/config.ts` 的 `resolveConfig`）字段：
`thresholdRatio`（默认 0.8）、`headroomTokens`（默认 65_536）、`maxTokens`
（缺省时等于 headroom）、`retainRatio` / `retainTokens`、`modelPolicies[]`、
`auto`、`compactionRetries`、`maxOverflowRetries`、摘要模型对。

系统线的算法可以直接照抄 `resolveCompactSpec` + `reservedCompletionTokens`：

```
messageBudget   = W − reservedOutput
pressureBudget  = messageBudget − headroomTokens
thresholdTokens = floor(min(W × thresholdRatio, pressureBudget))
```

其中 `W` 与 `defaultMaxTokens` 从 `ctx.llm.resolveModelInfo(provider, model)`
取（`dsh-llm/src/index.ts:775`，异步、结果已脱敏冻结），
`reservedOutput = header.config.maxTokens ?? defaultMaxTokens ?? 0`。

降级策略不变：读不到 `config`（升级改名/实例换成别的后端）时用
`0.8 / 65_536` 这组默认值，并在日志里打一次 "using built-in defaults"。

---

## 3. 自定义路由与信任栅栏（M0-3）

`WebRoute`（`dsh-host-webserver/src/index.ts`）：

```ts
export interface WebRoute {
  kind: 'exact' | 'prefix'   // exact 逐字匹配；prefix 匹配 p 与 p/<anything>
  path: string               // 绝对路径，不能有尾斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

- `register(route)` 返回 disposer；**重复的 (kind, path) 直接抛错**。
- 请求未被任何具名路由匹配时走 fallback（Web 组合里是 SPA dist server）。
- handler 自己拥有整个响应生命周期。

栅栏：`connection.requestRejection(req)` 返回 `401 | 403 | undefined`。
DSH 自己的 `dsh-host-open-in-app` 是完整范例（三个路由，每个第一行就调它）：

```ts
const rejected = (req, res): boolean => {
  const rejection = connectionOf(ctx).requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}
```

同文件还给出了这些可照抄的细节：

- `ctx.effect(() => ctx.webServer.register({...}), 'label')` 完成注册与卸载；
- `content-type` 必须是 `application/json`（否则 415），body 上限 64 KiB，
  超限 413，读不完 400；
- JSON 响应统一 `content-type: application/json; charset=utf-8` +
  `cache-control: no-store`；
- 方法不对回 405 并带 `allow`。

它注释里写明了栅栏覆盖的内容：**Host/Origin 检查（防 DNS rebinding 与跨站调用）
加浏览器登录 cookie 的鉴权**，且我们的路由和页面同源（同一个 `webServer`），
`fetch('/smart-compact/state')` 会照常带上 cookie。

服务名来自 `inject = ['webServer', 'connection']`（yaml 里声明依赖）。

---

## 4. 两个槽（M0-4）

### `plugins.bundle.config`

```ts
'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
```

文档注释：

> A bundle's own configuration, **keyed by the bundle's package name** and rendered
> on the bundle's page between its description and its rows (`view: 'page'` only).

- 只支持 `view: 'page'`，正好是计划里"插件页默认阈值"的座位。
- key = 包名。我们的包名 = bundle 名 = `@local/dsh-smart-compact`，所以
  `ctx.slots.register({ name: 'plugins.bundle.config', key: '@local/dsh-smart-compact', ... })`。

### `conversation.input.model.options`

```ts
'conversation.input.model.options': {
  kind: 'list'
  scope: 'session'
  owner: { locked: boolean; dismiss: () => void; reportFailure: (message: string) => void }
}
```

- 注册参数：`{ name, id, order?, label? }`，`id` 必填且要自己取
  （复用已内置的 id 会**替换**那一格；现有占用者是 `agent-team` 的 `agent-team`）。
- 除 owner props 外还有一套标准 kit props，其中包含我们要的
  `useProjection`、`sessionId`、`useSessionStatus`、`useAccess`。
  `useProjection('contextPressure')` 正是 DSH 内置 `ContextMeter.tsx` 的读法。

---

## 5. "压缩释放了多少"的读法（M0-5）

`tokenMeter` 提供两个读数：

- `ctx.tokenMeter.contextPressure(session)` → `{ pressureTokens?, contextWindow? }`，
  `pressureTokens` 是**最近一次已记录的 provider 请求**的 prompt 大小（滞后一步）；
- `ctx.tokenMeter.measure(session, header?)` → `{ totalTokens, surfaceTokens, nodes[] }`，
  同步、确定性、按启发式计价，不需要模型调用。

所以"释放量"要在**宿主侧**用 `measure()` 前后相减：

```
released = measure(session).totalTokens   // 压缩前（在 compactNow 之前取）
         − measure(session).totalTokens   // 压缩后
```

不能用 `contextPressure` 的差值：它要等下一次真实请求才更新，而且压缩本身
会替换节点，滞后读数会把两件事混在一起。

UI 上"当前占用"继续用 `contextPressure`（免费、随投影推送）；它滞后一步，
但面板又不是精确计费器，可以接受。**只有通知文案里的"释放了多少"用 measure 差值。**

---

## 6. 客户端半身的装载方式（顺带核实）

我们的插件要带 UI，必须声明浏览器半身。DSH 的清单字段（`dsh-context` 的
`package.json` 是可用样例，但字段本身属于 DSH 的插件清单契约）：

```json
"exports": { "./client": "./lib/client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation", ...] }
}
```

`inject` 列出客户端要用的 DSH 客户端包（槽声明所在的包），`platform: 'web'`。
客户端文件用 `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 包裹，
`factory` 返回 `{ inject, apply(ctx) }` 形式的 Cordis 客户端插件。
我们不需要构建工具链：手写这一个文件即可（现有 `test/` 也不依赖打包）。

---

## 7. 还没验的三件事（必须真实装载后才能验）

这几项无法靠读源码回答，等第一次以插件形态加载时按顺序做：

| # | 要验的 | 怎么验 | 失败的退路 |
|---|---|---|---|
| R1 | 回合结束 → `agent/status('idle')` → `compactNow` 真的成功 | 长会话里让 agent 主动请求压缩，看日志出现 `compaction (manual)`、Chat 出现 manual-compaction 节点 | 改走路径 B（下一回合 `agent/pre-step` 的 `compactRegion`） |
| R2 | 浏览器 `fetch` 带 cookie 通过栅栏；伪造 Host / 跨站被 401/403 | `curl` 与页面内 fetch 各一次；伪造 `Host: evil` 一次 | 退回会话命令通道（`ctx.remote.commands.execute`） |
| R3 | `plugins.bundle.config` 在插件页真的渲染，`view:'page'` 生效 | 打开插件详情页看配置区 | 退到 `plugins.item`（官方保留座位）不适用时，改为插件页自定义路由渲染 |
| R4 | `dsh.client` 半身被加载、槽注册生效 | 打开模型菜单看我们那一行 | 检查 `exports["./client"]` 与 `inject` 列表 |
| R5 | `measure()` 前后差值可用、量级合理 | 压缩前后各打一条日志 | 通知里不报具体数字，只说"已压缩" |

R2/R3/R4 属于"装载即验"，R1/R5 需要一次真实的长会话。
按当前约定，这些都在功能做完、准备安装时一次性执行——**安装本身放到最后**。

---

## 8. 对设计文档的影响

- `docs/20-design.md` 的路径 A / 阈值公式 / 降级策略：**无需修改**。
- `docs/40-gui.md` 的三个接口与两种槽：**无需修改**；只补一条实现注记
  （row 注册要带自己的 `id`，插件页 key 是包名）。
- `docs/10-facts.md` 的第 8 节（待验证）按本文更新。
