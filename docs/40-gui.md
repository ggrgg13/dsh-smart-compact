# 40 · GUI：每会话阈值 + 插件默认值

## 决定

- 用户拥有的是**阈值**（窗口的百分比），不是模式；默认值在插件设置页，每会话可覆盖。
- **不做** agent 建议阈值 / 一键修改（模型判断不可靠，见 ADR-10）。
- 不懂的用户什么都不用做：默认 60%，面板不打扰、不弹窗、不解释术语。
- 所有界面只用 DSH 自身能力：模型菜单的 session options 槽、插件页的 bundle config 槽、
  `contextPressure` 投影、`webServer` + `connection` 服务。第三方插件只作为写法参考，不是依赖。

## 数据模型

```jsonc
// 全局（插件设置页）
{ "defaultPercent": 60 }

// 每会话
{ "threshold": { "kind": "default" }
            | { "kind": "percent", "percent": 65 }
            | { "kind": "off" } }
```

```text
railPercent = rail / window * 100
effective   = clamp(percent, 30, railPercent - 2)
thresholdTokens = round(window * effective / 100)
```

- `rail` 仍从 `compaction-basic` 的配置推导（`min(W×ratio, W−reserved−headroom)`）。
- 窗口未知（没选模型）时不猜：面板整块禁用，提示"选择模型后可设置"。
- `off` 只对命令暴露，UI 不提供——避免多一个需要理解的开关。

## 入口：模型菜单里的一行

槽位 `conversation.input.model.options`（scope: session），排在模型与推理强度之后：

```
模型          deepseek-flash
推理强度      high
────────────────────────────
上下文压缩     42% / 60%        ›
```

- `42%` 来自 `contextPressure` 投影的 `pressureTokens / contextWindow`，是当前占用；
- `60%` 是本会话生效阈值；
- 跟随默认时行尾显示 `跟随默认`，覆盖时显示 `自定义`；`off` 显示 `已关闭`；
- 没有模型或读不到状态时显示 `—`，面板内说明原因。

## 面板

```
┌────────────────────────────────────────────┐
│ 上下文压缩                           仅本会话 │
│                                            │
│  已用 42%      建议线 60%      系统线 69%   │
│  ├──────────●───────────┼──────────┼─────┤ │
│  0                   629k        727k  1.05M│
│                                            │
│  达到建议线后，agent 会在合适的回合结束时压缩 │
│  旧对话。系统线由 DSH 自动触发。            │
│                                            │
│  [──────────●──────────────────]   60%     │
│                                            │
│  ☑ 跟随默认（60%）        恢复默认   完成   │
└────────────────────────────────────────────┘
```

- 三个标记是核心：当前占用、建议线（可拖）、系统线（灰刻度）。只有一个百分比的设置没有参照。
- 双读数：`60% · 629k / 1.05M`；窗口未知时只显示百分比。
- 滑杆范围 `30% – railPercent − 2%`，步进 1；拖动时只更新显示，**松手才提交一次**。
- 勾选"跟随默认"时滑杆禁用并显示默认值；取消勾选才切到自定义。
- 无保存按钮；`完成` 仅关闭。Esc、点击外部关闭，焦点回到那一行。
- 滑杆 `role="slider"`，方向键 ±1，Home/End 到边界，`aria-valuetext` 给百分比加 token。

## 插件设置页

槽位 `plugins.bundle.config`，key 为包名 `@local/dsh-smart-compact`，用 `view: 'page'` 渲染：

```
默认压缩阈值
├──────●────────┤  60%
新会话继承这个值；已有会话的自定义不受影响。
```

- 范围 30–90。插件页没有会话与模型，不显示占用和系统线；夹紧发生在使用时。
- `view: 'summary'` 时只渲染一行文字 `60%`。
- 样式照宿主表单：同一间距、同一输入尺寸、同一主题 token，不引入自定义配色。

## 设置通道：一条小路由

DSH 的 Host 已有 `webServer.register` 与 `connection.requestRejection`（`webserver` / `connection` 是
`dsh-web-app` 的宿主行，属 DSH 自身）。插件注册三个精确路由：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/smart-compact/state?session=<id>` | 返回全局默认、会话覆盖、生效阈值、窗口、系统线 |
| POST | `/smart-compact/session` | `{ session, threshold }` 写会话覆盖 |
| POST | `/smart-compact/default` | `{ percent }` 写全局默认 |

响应统一 `application/json`、`Cache-Control: no-store`。

### 校验

- 只接受精确路径与声明的方法；
- 请求体上限 4 KB，字段白名单；
- `percent` 必须是 30–90 的整数，`threshold.kind` 必须属于闭集；
- `session` 必须是当前存活的会话（`ctx.agents.get`），否则 404；
- 浏览器信任栅栏：只接受回环或 `ctx.webStartup.trustedHosts` 声明的 Host，
  `Sec-Fetch-Site: cross-site` 一律拒绝，带 `Origin` 时必须与 Host 同源，
  并委托 `connection.requestRejection`；该服务缺失或抛异常时**按拒绝处理**（fail closed）。

### 为什么不用其他通道

- **typert Remote（`ctx.remote.<ns>`）**：需要注册 schema，第三方 bundle 里没有成功先例可抄，
  与 DSH 版本耦合，升级风险高。
- **会话命令（`ctx.remote.commands.execute`）**：写和读都要落 `command/run`，
  每次拖动滑杆都会在对话里留一行，污染对话，且读取还得再维护一个投影。

## 实时占用从哪来

`@deepseek-ai/dsh-token-meter` 已经注册了 `contextPressure` 投影，wire view 是
`{ pressureTokens?, projectedTokens?, contextWindow? }`。客户端在槽组件里用
`useProjection('contextPressure')` 读取即可，不需要插件自己的 Host 逻辑，也不需要轮询。
`tokenUsage` 投影同理（如果以后要显示累计花费）。

## 状态与边界

| 状态 | 表现 |
|---|---|
| 未挂载压缩后端 | 行置灰，面板提示"当前不可用" |
| 未选模型 / 窗口未知 | 滑杆禁用，提示"选择模型后可设置" |
| 读取失败 | 行显示 `—`，面板给"重试" |
| 保存失败 | 回滚到上一个值，面板内提示，不弹 toast |
| 会话运行中 | 可改；下一次 `compact_context` 或回合结束复核时生效 |
| 面板打开时占用增长 | 投影实时更新，滑杆位置不动 |

## 文案

- 只用三个词：**已用**、**建议线**、**系统自动压缩线**。
- 不出现：阈值、水位线、watermark、rail、token 预算、buffer。
- 中文同步英文：`Used` / `Suggested` / `System line`。

## 成本

| 部分 | 估计 | 说明 |
|---|---|---|
| 行 + 面板组件 | ~1 天 | 主题 token、locale、键盘与焦点 |
| 路由 + 信任栅栏 + 校验 | ~0.5–1 天 | 复用 DSH 的 `requestRejection` 与回环校验 |
| 插件页默认值 | ~0.5 天 | 同一滑杆组件，`view` 分支 |
| 联调与异常态 | ~0.5 天 | 无模型、无后端、读取/保存失败、并发 |
| 合计 | ~2.5–3 天 | 不含 Host 策略改造（约 0.5 天） |

## 明确不做

- 不做 agent 建议卡、不做"一键按模型建议调整"。
- 不做全局阈值仪表盘、不做历史曲线。
- 不做每步刷新的常驻压力条（面板打开时才订阅）。
- 不依赖任何已安装第三方插件的接口与数据。
