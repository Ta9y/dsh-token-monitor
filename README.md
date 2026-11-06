# dsh-token-monitor

**整个插件，除了这一行字以外，由DeepSeek Harness生成**

给 DeepSeek Harness 用的悬浮小窗：显示**账户余额**、**当前对话已消耗的 token**，以及按官方价目估算的**本次对话花费**。

贴在窗口右边缘的一个窄竖条 + 展开卡片，可拖动、可收起，不占阅读空间。

> English README: [README.en.md](./README.en.md) · 仓库：[GitHub](https://github.com/Ta9y/dsh-token-monitor)

```
┌──────────────────────┐ ┌──┐
│ ● 你的对话标题     × │ │¥ │
│ 余额        ¥25.87   │ │25│
│ 本对话     ≈¥0.42 25.4M│ │.8│
└──────────────────────┘ └──┘
        悬停后展开明细 ↑
```

## 功能

- **余额**：读 DeepSeek 账号服务，显示充值钱包（悬停可看赠送余额）
- **本对话消耗**：累加该会话里每次模型调用的 usage
- **本次对话花费**：按 DeepSeek 官方价目估算，分模型、分**高峰/空闲**时段
- **Search / Fetch 计费**：统计 `web_search` / `web_fetch` 调用次数，按官方 5 元/千次计价
  （官方说明 2026-11-01 00:00 前不计费，插件会按日期自动决定是否计入）
- **价格每月自动更新**：从官方价目页抓取，缓存 30 天，抓失败就继续用旧值
- **跟随当前对话**：切换会话立即刷新（识别 DOM 选中态，宿主按标题/id 反查）
- **跟随应用语言**：简体中文 / English，应用里切语言即时同步
- **可拖动**：竖条上下拖，浮窗与竖条始终垂直对齐；位置按视口比例记忆
- **不打扰**：悬停 320ms 才展开明细；鼠标停在 × 那一排时不展开，避免点不中

## ⚠️ 高危权限使用声明（务必阅读）

1. **本项目不申请任何提权、审批或代操作权限**：不注册工具、不自动同意、不绕过、不降低任何审批策略，
   你不需要为它点「允许一次」。
2. **它读什么**：只读当前对话及其子会话的用量数据（余额、usage、标题、上下文、团队名单）；
   子会话结束后会读一次它在磁盘上的会话日志，只为累加 token。
3. **它在本机提供 3 个只读路由**：`/dsh-token-monitor/state`、`/dsh-token-monitor/probe`、`/dsh-token-monitor/ui.js`，
   只经 DSH 自己的回环地址提供，带随机令牌 + 同源 / 桌面 Origin 守卫，跨站请求一律 `403`。
4. **它写什么**：只写插件目录下的 `debug.log`（诊断）、`token.txt`（页面令牌）、`prices.auto.json`（价格缓存）；
   不写工作区、不写会话。
5. **它出网吗**：只有每月一次抓官方价目页（`api-docs.deepseek.com`）；余额查询走 DSH 账号服务，插件不直接连平台。
6. **它不上传任何东西**：无遥测、无统计、无第三方 API；数据只在本机内存里累加。

逐项的接口 / 频率清单见下文「[权限与接口](#权限与接口)」。

## 环境要求

- DSH 0.2.x（`@deepseek-ai/dsh-base` + `dsh-web-app` 组合）
- 桌面端走 `dsh.client` 客户端模块注入；纯浏览器模式（`dsh web`）走 index 注入
- 只在 Windows 的 `desktop` profile 上实测过；macOS / Linux 未验证

## 安装

插件是标准的 DSH bundle，同时带 host 半（`index.js`）和 client 半（`client.js`）。

> 命令里的 `<profile>` 换成你要装的 profile 名；桌面版就是 `desktop`。
> `dsh plugin` 会把参数原样转给 pnpm，所以任何 pnpm 能装的 spec 都行。

### 方式 A：从 GitHub 直装（推荐，当前唯一可直接用的一键方式）

```bash
dsh plugin --profile <profile> add github:Ta9y/dsh-token-monitor
```

### 方式 B：图形界面

**设置 → 插件 → 安装**，粘贴 `github:Ta9y/dsh-token-monitor`。

### 方式 C：手动（适合本地开发调试）

```powershell
cd $HOME\.dsh\profiles\desktop
pnpm add file:C:/path/to/dsh-token-monitor
```

然后把 `dsh-token-monitor` 加进该目录 `package.json` 的 `dsh.profile.bundles` 数组。

### 方式 D：从 npm

> ⚠️ **尚未发布到 npm**，这条命令现在会 404。等发布后可用：
>
> ```bash
> dsh plugin --profile <profile> add dsh-token-monitor
> ```

> 安装后**需要重启一次 DSH 进程**：host 半的代码走 ESM 缓存，重载插件不会重新执行。
> 之后改 `ui.js` / `config.json` 只要刷新页面即可。

## 使用

1. 页面右边缘出现一条窄竖条，显示余额；鼠标移上去展开卡片。
2. 卡片顶部是「余额 / 本对话消耗 / 估算花费」，下面按「消耗构成 / 用量 / 余额」分组列明细。
3. 竖条上下拖动改变位置（按视口比例记住）；点 × 收起，收起后点竖条还能展开。
4. 应用里切换语言（简中 / English），浮窗文字即时跟着变。

> 悬停 320ms 才展开；鼠标停在 × 那一排时不会展开，免得点不中。

## 配置

`config.json`（插件目录下，改完刷新页面生效，不用重启）：

```json
{
  "pollSeconds": 10,        // 页面轮询间隔（秒）
  "balanceSeconds": 60,     // 余额查询间隔（秒）
  "autoPrices": true,       // true = 每月从官网抓价；false = 只用手写的 prices
  "searchPer1000": 5,       // Search 单价（元/千次）
  "fetchPer1000": 5,        // Fetch 单价（元/千次）
  "searchBillingFrom": "2026-11-01",
  "prices": {               // 元 / 百万 token，按模型 + 时段
    "deepseek-flash": {
      "offpeak": { "cacheHit": 0.02, "cacheMiss": 1, "output": 4 },
      "peak":    { "cacheHit": 0.04, "cacheMiss": 2, "output": 8 }
    },
    "deepseek-v4-pro": {
      "offpeak": { "cacheHit": 0.15, "cacheMiss": 4.5, "output": 13.5 },
      "peak":    { "cacheHit": 0.3,  "cacheMiss": 9,   "output": 27 }
    }
  }
}
```

## 花费是怎么算的

单位：元 / 百万 token。高峰 = 北京时间**工作日** 9:00–12:00、14:00–18:00，其余时段（含周末）为半价。

- 模型从会话的 `requestContext()` 读出；未知模型回落到 `deepseek-flash`
- **按调用发生的时段计价**：每次 usage 按事件时间分进「高峰桶 / 空闲桶」，各用自己的单价
- Search / Fetch 按次计费，和 token 是两笔账
- 法定节假日未处理，所以结果是**估算**，不是账单金额

价格来源：[DeepSeek 官方价目页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，
由插件每月自动抓取并缓存在 `prices.auto.json`（含 `fetchedAt`）；解析失败时保留旧值。

## 外观与配色

- 竖条：品牌蓝渐变 `#2f7cf6 → #1a5fd0 → #1549a6` + 白字；hover 加白色内描边与蓝色光晕
- 卡片：跟随 DSH 主题 token（`--dsw-alias-bg-layer-2` / `label-primary` / `label-secondary` / `border-l1`），
  深浅色自动切换；token 缺失时退回内置的浅/深两套色值
- 状态点：正常 = `--dsw-alias-state-success-primary`，待确认 = `state-warn`，出错 = `state-error`，未激活 = `state-idle`
- 数字统一等宽（`tabular-nums`）：金额写成 `≈¥0.42`，token 写成 `25.4M tok`

## 权限与接口

它只读、只显示：不改会话、不发消息、不执行任何 Agent。下面是用到的**全部** DSH 能力。

| 接口（都只读） | 用途 | 频率 |
|---|---|---|
| `ctx.deepseekAccount.getBalance()` | 余额 + 赠送余额 | 60s（`balanceSeconds`） |
| `ctx.sessions.get()` / `list()` | 当前会话对象、还活着的子会话 | 10s |
| `ctx.sessionTitle.get()` | 会话标题（用来跟随当前对话） | 10s |
| `ctx.tokenMeter.measure()` | 上下文占用 | 10s |
| `ctx.sessionQuery.traceSession()` | 会话谱系：这个对话下面有哪些子会话（读磁盘上的会话头） | 30s / 切会话 |
| `ctx.sessionQuery.readSession()` | 读**已结束子会话**的事件日志，只为累加 token | 每个子会话一次 |
| `ctx.agentTeams.tryMembership()` / `listMembers()` | 判断哪些子会话是队友 | 10s |
| `ctx.agents.list()` | 找到当前会话对应的 Agent | 10s |

注册的东西：

| 注册 | 内容 |
|---|---|
| `webServer.register` | `GET /dsh-token-monitor/state`（余额 + 用量 JSON）、`GET /dsh-token-monitor/probe`（诊断日志）、`GET /dsh-token-monitor/ui.js`（界面脚本） |
| `webServer.tapIndex()`（浏览器模式）/ `dsh.client`（桌面端） | 往页面挂一个同源 `<script>`，不注入内联代码 |
| 事件监听 | `session/event`、`session/disposed`、`subagent/start`，只读通知，不拦截、不修改 |

三个路由都要先过鉴权，满足其一才放行：带 `token.txt` 里的随机令牌、同源 / 桌面端 `dsh-app://app` 的 Origin、
或者根本没有 Origin（本机进程与同源 `fetch`）。带跨站 Origin 的请求一律 `403`（防止网页对 localhost 的 CSRF 读取）。

**明确不申请、也不使用的高危能力**

- 不注册任何工具 —— 模型看不到它，也调不到它
- 不写会话、不改事件、不发消息、不 spawn / 中断任何 Agent
- 不读凭据、登录令牌、API Key；不碰 `ctx.credentials`、`ctx.authorization`
- 不执行 shell、不起子进程、不写包目录以外的任何路径
- 不调用 `ctx.llm.stream()` —— 它自己不会产生任何模型费用

**会不会看到我别的对话？** `sessionQuery` 是整个会话库的接口，但插件只做两件事：

1. 用 `traceSession(当前会话)` 取**它自己的**子树（主会话 → 子智能体 → 队友）；
2. 对子树里**已经结束**的子会话各读一次日志。

不自己遍历会话库、不搜索、不读其它对话的正文（谱系由 DSH 的 `traceSession` 解析，插件只拿到这棵子树）。
读进来的日志只在内存里累加 token 数字，既不出网、也不落盘。

## 隐私

- **不读取**登录令牌、不碰 API Key
- 余额只通过 DSH 自己的账号服务（`ctx.deepseekAccount.getBalance()`）读取，插件不直接连平台
- **不向任何第三方发请求**；唯一的出站请求是每月一次抓官方价目页
- 数据只在本机内存 + 浏览器 `localStorage`（竖条位置）里
- 本地写入的文件：`debug.log`（诊断，可删）、`token.txt`（页面随机令牌）、`prices.auto.json`（价格缓存）

## 已知限制

- 只统计**当前对话这一棵树**：主会话 + 它的子智能体 + 队友（及其子智能体），别的对话不计入
- 子任务/队友的会话结束、甚至 DSH 重启之后，用量会从磁盘上的会话日志补算回来；只有那份日志被删掉才会丢
- 法定节假日的高峰/空闲判断不准（会影响估算）

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-token-monitor
```

图形界面：**设置 → 插件 → `dsh-token-monitor` → 卸载**。卸载后重启一次 DSH，页面上的竖条会消失。

## 仓库结构

```
index.js            host 半：读余额、累加 usage、HTTP 路由、价格抓取
client.js           client module：把 ui.js 挂进页面，并桥接应用语言
ui.js               悬浮窗本体：纯 DOM + Shadow DOM，无构建、无依赖
cordis.patch.yml    bundle 层：插入插件行
config.json         默认配置
test/smoke.mjs      假 ctx 的回归测试（npm test）
test/rollup.mjs     任务级汇总（主会话 + 子任务 + 队友）的回归测试
test/prices.mjs     拿真实官方页面验证价格解析（npm run test:prices）
CHANGELOG.md        版本变更
LICENSE             MIT
```

## 开发

```bash
node test/smoke.mjs     # host 半的回归（假 ctx，不需要跑 DSH）
node test/rollup.mjs    # 任务级汇总口径（主会话 / 子任务 / 队友）
npm run test:prices     # 抓真实官方页面验证价格解析
```

### 两个容易踩的坑

1. **bundle patch 插入新行必须用 `insert:`**。`- id: xxx` 是「覆盖已存在条目」的语义，
   条目不存在时只打印 `patch: entry "xxx" not found` 然后**静默跳过** —— 插件看起来装好了但根本没加载。

   ```yaml
   - insert:
       - id: dsh-token-monitor
         name: 'dsh-token-monitor'
   ```

2. **路由/注入注册必须包在 `ctx.effect()` 里**。否则插件热重载时旧路由不会释放，
   新实例注册同名路径直接抛 duplicate route，`apply` 半路夭折（表现为"改了代码没反应"）。

## 发布到 GitHub

仓库用 REST API 推送（不需要装 git）：把 `release/<版本>/<包名>/` 当作一个提交推到 `main`，
历史版本留在 `release/<旧版本>/`，不跟着上传。

```powershell
# 1) 把 GitHub PAT（Contents: Read and write）写进仓库根的 .github-token
# 2) 先离线自检：不联网、不需要令牌，只列出将要上传的文件并检查是否有运行时产物 / 凭据
$env:GH_DRY = "1"; node tools/push-github.mjs
# 3) 正式推送（提交信息默认 feat: dsh-token-monitor <版本>，版本取自 package.json）
node tools/push-github.mjs
```

仓库建好后记得加 **Topics**（右侧 About 旁的齿轮）：

```
dsh-plugin  dsh  deepseek-harness  deepseek  plugin  token  cost  balance
```

`dsh-plugin` 是检索 DSH 插件时最主要的标签。

## 许可

[MIT](LICENSE)
