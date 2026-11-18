# 45 · GUI 样式与交互规格（已确认 A1 / B1 / C1）

> 状态：**已确认**（2026-11-18）。A1 内联展开、B1 松手即保存、C1 只有 Esc 与点菜单外关闭。
> 数据与阈值算法见 `20-design.md`、`40-gui.md`；本文只冻结"长什么样、怎么动"。
> 数值不是估的：行高/字号/内边距取自 DSH 菜单自己的 `ModelSelect.module.css`，
> 颜色全部走 `--dsw-alias-*` 主题 token。

## 1. 结构与座位

- 槽位 `conversation.input.model.options`（`scope: session`，list），注册 `id: 'smart-compact'`、`order: 40`。
- 结构固定为：

```
div.dsc-wrap                     ← 唯一的事件边界
├── button.dsc-cell              ← 与「模型」「推理等级」同规格的一行
│   ├── span.dsc-cellLabel       ← 上下文压缩
│   ├── span.dsc-cellValue       ← 41% / 60%
│   └── svg.dsc-chevron          ← 12px，展开时旋转 90°
└── div.dsc-panel                ← 展开后出现，同卡片内
```

- 面板**内联展开在菜单卡片里**，不做浮层、不 portal。理由：不新增层叠上下文、不抢焦点，
  菜单的定位（CSS anchor）自动把卡片向上撑开。

## 2. 样式规格

### 2.1 行（必须与相邻菜单行完全一致）

| 属性 | 值 |
|---|---|
| height | `34px` |
| padding | `0 8px` |
| gap | `6px` |
| border-radius | `var(--dsw-radius-md, 8px)` |
| 背景 | 透明；`:hover`/`:focus-visible` 用 `var(--dsw-alias-interactive-bg-hover)` |
| 文字 | **13px / 20px**，`color: var(--dsw-alias-label-primary)` |
| 数值 | 13px，右对齐，`var(--dsw-alias-label-tertiary)`，`font-variant-numeric: tabular-nums` |
| 箭头 | 12×12，`var(--dsw-alias-menu-icon)` |
| disabled | `var(--dsw-alias-label-dimmed)`，`cursor: default` |

**当前字体过大的根因（已定位）**：`.dsc-cell` 里在 `font-size: 13px; line-height: 20px`
之后又写了 `font: inherit`，简写把字号重置成了继承值（菜单根节点更大）。
修正规则写死：**`font` 简写不得出现在 `font-size` 之后**；行内只用
`font-family: inherit; font-size: 13px; line-height: 20px`。

### 2.2 面板

| 属性 | 值 |
|---|---|
| padding | `4px 8px 10px` |
| 行间距 | `gap: 8px` |
| 背景/圆角 | 无（跟随菜单卡片材质） |

### 2.3 刻度条（就是滑轨本身）

| 元素 | 规格 |
|---|---|
| 轨道 | 高 `6px`，`border-radius: 3px`，底色 `var(--dsw-alias-interactive-bg-hover)` |
| 已用填充 | 从 0 到"已用%"，`var(--dsw-alias-state-business-primary)`，透明度 `.55`，两端 3px 圆角 |
| 系统线刻度 | 宽 `1px`，`var(--dsw-alias-state-warn-label)`，上下各溢出 4px，不可拖 |
| 拖动点（knob） | 12px 实心圆，`var(--dsw-alias-label-primary)`，外圈 2px 卡片底色描边；聚焦时外圈换成 focus ring |
| 命中区 | 整条 `24px` 高，透明 `input[type=range]` 覆盖，`cursor: pointer` |

### 2.4 三段单选

| 属性 | 值 |
|---|---|
| 行高 | `20px`，字号 `12px` |
| 未选中 | `var(--dsw-alias-label-secondary)`；圆点 12px，1px 边框 tertiary |
| 选中 | 文字 `var(--dsw-alias-label-primary)`；圆点 business-primary 填充 + 2px 卡片底色内环 |
| 排布 | 三行纵向列表，`gap: 4px` |

### 2.5 插件页

与 2.3 同一条轨道（无"已用"填充、无系统刻度），标题 13px，大数值 20px tabular，
下方一行 11px 说明。宽度上限 `460px`。

## 3. 交互规格

### 3.1 打开与关闭

- 点整行切换展开/收起，`aria-expanded` 同步。
- **面板内任何操作都不关闭菜单**：不调用 `dismiss()`，不因失焦关闭。
  - 实现约束：`div.dsc-wrap` 对 `mousedown` 调 `preventDefault()`（`input` 除外）；
    不再使用会转移焦点的 `label + input` 结构。
- 关闭菜单只有两种方式：`Esc`、点击菜单外（DSH 菜单自身行为）。

### 3.2 单选

1. 点击 → 圆点**立即**移动、行摘要立即变化（乐观更新）。
2. 同时发一次 `POST /smart-compact/session`。
3. 成功：保持；失败：回滚到点击前的值，面板底部出现红字，菜单保持打开。
4. 「自定义」可拖轨道；「关闭」时轨道禁用并灰显（仍显示上次的百分比位置）。

### 3.3 滑轨

- 按下/拖动：**只改本地 draft**，knob 与右侧百分比实时跟随，不发请求。
- 松手（`pointerup` / `pointercancel` / `keyup`）：值有变化才提交**一次**。
- 点击轨道任意位置 = 跳到该值并提交一次（与拖动等价）。
- 键盘：聚焦后 `←/→` ±1，`Home/End` 到边界，`keyup` 提交。

### 3.4 反馈

| 场景 | 表现 |
|---|---|
| 保存中 | 行摘要右侧显示 11px "保存中…"，控件禁用，**不关闭菜单** |
| 保存成功 | 控件恢复，无额外提示（数值本身即反馈） |
| 保存失败 | 面板底部 11px 红字"保存失败：<状态码>" + "重试" |
| 读取失败 | 面板内红字"暂时读不到设置，刷新页面重试"+ "重试" |
| 窗口未知 | 轨道禁用，一行提示"第一次请求之后才知道窗口大小" |
| 窗口过小 | 隐藏轨道，一行"这个模型在系统线下方没有空间" |

### 3.5 并发

- 展开时拉一次 `GET /state`；若窗口未知且投影已给出窗口，再拉一次（现有逻辑保留）。
- 面板打开期间：已用百分比随投影实时变化；knob 只随用户操作移动。

## 4. 状态矩阵

| 会话阈值 | 行摘要 | 轨道 | 提示 |
|---|---|---|---|
| 跟随默认 | `41% / 60%` | 可拖，knob 在 60% | — |
| 自定义 | `41% / 55%` | 可拖 | 若被夹紧，显示"受系统线限制，最高 67%" |
| 关闭 | `已关闭` | 禁用、灰显 | "系统自动压缩线仍然有效。" |
| 窗口未知 | `—` | 禁用 | "第一次请求之后才知道窗口大小。" |
| 窗口过小 | `—` | 隐藏 | "……没有空间" |
| 锁定（回合运行中） | 行可展开但控件禁用 | 禁用 | — |

## 5. 退路（如果你仍看到菜单被关掉）

内联方案依赖"焦点不离开菜单卡片"。若实测仍关闭：

- 改为 **body portal 浮层**：点行时先 `dismiss()` 关菜单，再在行下方弹出独立面板，
  自管 outside-pointer 关闭（与 agent-team 的确认框同一套路）。
- 代价：多一次点击感、需要定位与关闭逻辑，但彻底脱离菜单的焦点生命周期。

## 6. 验收清单

在本机（DSH 窗口）上逐条验证：

1. **字号**：截图对比「模型」「推理等级」「上下文压缩」三行，字高与基线一致。
2. **不关菜单**：点面板空白、点文字、点单选、拖轨道，菜单始终打开。
3. **单选有效**：点「自定义」→ 圆点立刻移动、菜单不关；收起再展开仍是自定义。
4. **滑轨有效**：拖动时右侧数字实时变；松手后收起再展开仍是该值；
   `~/.dsh/smart-compact/state.json` 里该会话的 `threshold.percent` 同步更新。
5. **关闭语义**：选「关闭」后轨道灰显、行摘要"已关闭"；`smart_compact(check)` 显示 off。
6. **失败可见**：临时改路由制造 500，红字出现且菜单不关。
7. **插件页**：拖滑杆 → 松手保存 → 刷新页面仍在。

## 6.5 已定位的实现缺陷（本稿要修）

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| D1 | 行文字比相邻行大 | `client.js:102` 里 `font-size: 13px; line-height: 20px;` 之后又写了 `font: inherit`，简写把前两者覆盖成继承值 | 删掉 `font: inherit`，改为 `font-family: inherit` |
| D2 | 选了「自定义」后单选看起来没选中 | `client.js:408` 用 `radio('custom', …)`，但服务端 `threshold.kind` 是 `'percent'`，`kind === 'custom'` 永远为假 | 控件值域与存储值域统一：`default / percent / off`，文案只做显示映射 |
| D3 | 面板内点非输入区域可能让菜单失焦关闭 | 菜单在 `onBlur` 里判断焦点是否还在卡片内（`ModelSelect.tsx:341`） | `dsc-wrap` 对非 `input` 的 `mousedown` 调 `preventDefault`；本稿进一步要求所有控件都是 `button`，彻底不转移焦点 |

D2 也解释了"选项看起来无效"：即使 POST 成功，选中态也不会显示出来。

## 7. 已确认的选择

- **A1 内联展开**：面板留在菜单卡片内，不 portal、不浮层。
- **B1 松手即保存**：滑轨松手提交一次，单选点击即提交，没有"保存"按钮。
- **C1 关闭方式**：只有 `Esc` 与点菜单外关闭；面板内不提供"完成"按钮。

确认后我按本文实现，并用 `dsh-computer-use-win` 截图复核样式；
注意该插件**禁止向 DSH 宿主窗口注入输入**（`HOST_INPUT_DENIED`），
所以"点按"这一步仍需要你操作，我只做截图与状态文件校验。
