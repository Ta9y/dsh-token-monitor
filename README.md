# dsh-token-monitor

[English](README.en.md) · **简体中文**

**整个插件，除了这一行字以外，由DeepSeek Harness生成**

给 DeepSeek Harness 用的悬浮小窗：显示**账户余额**、**当前对话已消耗的 token**，以及按官方价目估算的**本次对话花费**。

贴在窗口右边缘的一个窄竖条 + 展开卡片，可拖动、可收起，不占阅读空间。

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

## 隐私

- **不读取**登录令牌、不碰 API Key
- 余额只通过 DSH 自己的账号服务（`ctx.deepseekAccount.getBalance()`）读取
- **不向任何第三方发请求**；唯一的出站请求是每月一次抓官方价目页
- 数据只在本机内存 + 浏览器 `localStorage`（竖条位置）里
- 本地写入的文件：`debug.log`（诊断，可删）、`token.txt`（页面随机令牌）、`prices.auto.json`（价格缓存）

## 兼容性

- 需要 DSH 0.2.x（`@deepseek-ai/dsh-base` + `dsh-web-app` 组合）
- 桌面端通过 `dsh.client` 客户端模块注入；纯浏览器模式（`dsh web`）通过 index 注入
- 只在 Windows 的 desktop profile 上实测过

## 已知限制

- 只统计**主会话**，不含子任务（subagent）的花费
- 会话必须是 Host 内存里的 live session 才能统计；冷会话显示 `—`
- 法定节假日的高峰/空闲判断不准（会影响估算）

## 开发

```
index.js            host 半：读余额、累加 usage、HTTP 路由、价格抓取
client.js           client module：把 ui.js 挂进页面，并桥接应用语言
ui.js               悬浮窗本体：纯 DOM + Shadow DOM，无构建、无依赖
cordis.patch.yml    bundle 层：插入插件行
config.json         默认配置
test/smoke.mjs      假 ctx 的回归测试（npm test）
test/prices.mjs     拿真实官方页面验证价格解析（npm run test:prices）
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

```bash
cd dsh-token-monitor
git init
git add .
git commit -m "feat: dsh-token-monitor 1.0.0"
git branch -M main
git remote add origin https://github.com/Ta9y/dsh-token-monitor.git
git push -u origin main
```

如果想换仓库地址，改 `package.json` 里的 `repository` / `homepage` / `bugs` 三处即可。

仓库建好后记得加 **Topics**（右侧 About 旁的齿轮）：

```
dsh-plugin  dsh  deepseek-harness  deepseek  plugin  token  cost  balance
```

`dsh-plugin` 是检索 DSH 插件时最主要的标签。

## License

[MIT](LICENSE)
