// dsh-token-monitor —— DSH 账户余额 + 本对话 token 消耗悬浮窗（Host 半）
//
// 数据来源（全部只读）：
//   1. 账户余额  ctx.deepseekAccount.getBalance()  —— 充值钱包 + 赠送钱包
//   2. 对话消耗  Session 事件里的 assistant/message.usage 累加
//   3. 上下文    ctx.tokenMeter.measure(session).totalTokens
//
// 明确不做：不读取登录令牌、不读 API Key、不发起外部网络请求、不写用户数据。
// 唯一写入：本包目录下的 debug.log（仅在 config.debug 开启时）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

export const name = 'dsh-token-monitor'
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.join(HERE, 'ui.js')
const DEBUG_FILE = path.join(HERE, 'debug.log')
const TOKEN_FILE = path.join(HERE, 'token.txt')
const CONFIG_FILE = path.join(HERE, 'config.json')

const ROUTE_STATE = '/dsh-token-monitor/state'
const ROUTE_PROBE = '/dsh-token-monitor/probe'
const ROUTE_UI = '/dsh-token-monitor/ui.js'

// 可调项都在 config.json 里，按 mtime 缓存，改完不用重启进程：
//   pollSeconds    页面轮询间隔（同时下发给浏览器）
//   balanceSeconds 余额向平台查询的间隔
//   prices         金额估算单价，按模型 + 时段（元 / 百万 token），见 config.json
const DEFAULT_SETTINGS = {
  pollSeconds: 10,
  balanceSeconds: 60,
  autoPrices: true,
  // Search / Fetch 按次计费（元 / 千次）。官方说明：2026-11-01 00:00 前不计费。
  searchPer1000: 5,
  fetchPer1000: 5,
  searchBillingFrom: '2026-11-01',
  prices: {
    'deepseek-flash': {
      offpeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    'deepseek-v4-pro': {
      offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
  },
}

function readSettings() {
  try {
    const stat = fs.statSync(CONFIG_FILE)
    if (readSettings.cache && readSettings.cache.mtimeMs === stat.mtimeMs) {
      return readSettings.cache.value
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const value = {
      pollSeconds: clampNumber(raw.pollSeconds, DEFAULT_SETTINGS.pollSeconds, 3, 3600),
      balanceSeconds: clampNumber(raw.balanceSeconds, DEFAULT_SETTINGS.balanceSeconds, 5, 3600),
      autoPrices: raw.autoPrices !== false,
      searchPer1000: clampNumber(raw.searchPer1000, DEFAULT_SETTINGS.searchPer1000, 0, 1000),
      fetchPer1000: clampNumber(raw.fetchPer1000, DEFAULT_SETTINGS.fetchPer1000, 0, 1000),
      searchBillingFrom: textOf(raw.searchBillingFrom || DEFAULT_SETTINGS.searchBillingFrom),
      prices: raw.prices && typeof raw.prices === 'object' ? raw.prices : DEFAULT_SETTINGS.prices,
    }
    readSettings.cache = { mtimeMs: stat.mtimeMs, value }
    return value
  } catch {
    return readSettings.cache ? readSettings.cache.value : DEFAULT_SETTINGS
  }
}

// ---- 价格自动更新 -----------------------------------------------------------
//
// 每个月从 DeepSeek 官方价目页抓一次，落到 prices.auto.json：
// 抓不到/解析不出来就继续用旧值（config.json 或内置默认），绝不因为网络问题影响浮窗。
// config.json 里 autoPrices=false 可以强制只用 config.json 的单价。

const PRICE_CACHE_FILE = path.join(HERE, 'prices.auto.json')
const PRICE_SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const PRICE_MAX_AGE_MS = 30 * 24 * 3600 * 1000

// 北京时间的高峰时段：工作日 9:00-12:00、14:00-18:00（法定节假日未处理）
function isPeakAt(ms) {
  const shifted = new Date(Number(ms) + 8 * 3600 * 1000)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function readPriceCache() {
  try {
    const stat = fs.statSync(PRICE_CACHE_FILE)
    if (readPriceCache.cache && readPriceCache.cache.mtimeMs === stat.mtimeMs) {
      return readPriceCache.cache.value
    }
    const raw = JSON.parse(fs.readFileSync(PRICE_CACHE_FILE, 'utf8'))
    const value = raw && raw.prices ? raw : null
    readPriceCache.cache = { mtimeMs: stat.mtimeMs, value }
    return value
  } catch {
    return null
  }
}

// 从官方页面里抠出 12 个价格：命中/未命中/输出 × 空闲/高峰 × flash/v4-pro。
// 页面结构是「模型细节」表 + 后面的搜索计费表，所以先切片，避免抓到 Search/Fetch 的 5 元。
export function parsePrices(html) {
  const text = String(html || '')
  const start = text.indexOf('模型细节')
  const end = text.indexOf('网页搜索与抓取价格')
  const slice = start >= 0 && end > start ? text.slice(start, end) : text
  const numbers = []
  const re = /(\d+(?:\.\d+)?)\s*元/g
  let match
  while ((match = re.exec(slice)) !== null) {
    numbers.push(Number(match[1]))
    if (numbers.length > 40) break
  }
  // 官方表固定 12 个数：flash/v4-pro × (命中/未命中/输出) × (空闲/高峰)
  if (numbers.length !== 12) return null
  const [hitOff, proHitOff, hitPeak, proHitPeak, missOff, proMissOff, missPeak, proMissPeak, outOff, proOutOff, outPeak, proOutPeak] =
    numbers
  const ok = (n) => Number.isFinite(n) && n > 0 && n <= 1000
  if (!numbers.every(ok)) return null
  // 合理性：pro 应该不便宜于 flash；高峰应该是空闲的 2 倍
  if (proHitOff < hitOff || proMissOff < missOff || proOutOff < outOff) return null
  if (Math.abs(hitPeak - hitOff * 2) > 1e-6) return null
  return {
    'deepseek-flash': {
      offpeak: { cacheHit: hitOff, cacheMiss: missOff, output: outOff },
      peak: { cacheHit: hitPeak, cacheMiss: missPeak, output: outPeak },
    },
    'deepseek-v4-pro': {
      offpeak: { cacheHit: proHitOff, cacheMiss: proMissOff, output: proOutOff },
      peak: { cacheHit: proHitPeak, cacheMiss: proMissPeak, output: proOutPeak },
    },
  }
}

function refreshPrices(log) {
  if (refreshPrices.running) return refreshPrices.running
  const cached = readPriceCache()
  if (cached && Date.now() - Number(cached.fetchedAt || 0) < PRICE_MAX_AGE_MS) {
    return Promise.resolve(cached)
  }
  refreshPrices.running = (async () => {
    try {
      const response = await fetch(PRICE_SOURCE_URL, {
        headers: { 'user-agent': 'dsh-token-monitor/1.0 (+https://deepseek.com)' },
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) throw new Error('http ' + response.status)
      const html = await response.text()
      const prices = parsePrices(html)
      if (!prices) throw new Error('parse failed')
      const payload = { fetchedAt: Date.now(), source: PRICE_SOURCE_URL, prices }
      fs.writeFileSync(PRICE_CACHE_FILE, JSON.stringify(payload, null, 2) + '\n')
      log('prices updated: flash hit=' + prices['deepseek-flash'].offpeak.cacheHit)
      return payload
    } catch (error) {
      log('prices refresh failed: ' + textOf((error && error.message) || error))
      return cached
    } finally {
      refreshPrices.running = null
    }
  })()
  return refreshPrices.running
}

// 页面里注入的随机令牌：持久化到 token.txt，这样插件热重载后
// 已经打开的页面不会因为令牌变化而拿到 403。
function loadToken() {
  try {
    const stored = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (/^[0-9a-f]{16,}$/.test(stored)) return stored
  } catch {
    // 首次运行：没有文件
  }
  const fresh = randomBytes(16).toString('hex')
  try {
    fs.writeFileSync(TOKEN_FILE, fresh + '\n')
  } catch {
    // 写不了就只在内存里用
  }
  return fresh
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function textOf(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return ''
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendText(res, status, type, text) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(''))
    req.on('aborted', () => done(''))
  })
}

function parseUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    return null
  }
}

// 累加一个 Session 里所有 assistant/message 的 provider usage。
// 同时按"该次调用发生在高峰还是空闲时段"分桶，让金额能按各自单价折算。
function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function sumUsage(session) {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    calls: 0,
    total: 0,
    searches: 0,
    fetches: 0,
    peak: emptyBucket(),
    offpeak: emptyBucket(),
  }
  const events = session.ownEvents()
  for (const event of events) {
    if (!event) continue

    // Search / Fetch 是独立计费的接口调用，次数就藏在工具调用事件里。
    // web_search 的 queries 可能有多条（我的工具支持 1~4 条），按条数算。
    if (event.type === 'tool/call') {
      const name = textOf(event.data && event.data.name)
      if (name === 'web_search') {
        let queries = 1
        try {
          const parsed = JSON.parse(textOf(event.data.arguments) || '{}')
          if (Array.isArray(parsed.queries)) queries = Math.max(1, parsed.queries.length)
        } catch {
          queries = 1
        }
        total.searches += queries
      } else if (name === 'web_fetch') {
        total.fetches += 1
      }
      continue
    }

    if (event.type !== 'assistant/message') continue
    const usage = event.data && event.data.usage
    if (!usage) continue
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    total.calls += 1
    total.input += input
    total.output += output
    total.cacheRead += cacheRead
    total.cacheWrite += cacheWrite
    total.reasoning += Number(usage.reasoningTokens) || 0
    total.total += Number.isFinite(Number(usage.totalTokens)) && usage.totalTokens != null
      ? Number(usage.totalTokens)
      : input + output

    const bucket = isPeakAt(Number(event.time) || Date.now()) ? total.peak : total.offpeak
    bucket.input += input
    bucket.output += output
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
  }
  return total
}

export function apply(ctx, config = {}) {
  const intervalMs = clampNumber(config.intervalSeconds, 60, 15, 3600) * 1000
  // 默认保留诊断日志（每次页面加载一行探针），config.debug === false 可关闭。
  // /api 前缀被连接的鉴权层占用，所以路由挂在独立前缀下，由页面内随机令牌保护。
  const debug = config.debug !== false
  const token = loadToken()

  const cache = {
    balanceStatus: 'unknown',
    wallets: null,
    bonusWallets: null,
    balanceAt: 0,
    balanceError: '',
    refreshing: null,
    activeSessionId: null,
    activeTitle: '',
    lastActivityId: null,
    tokensKey: '',
    tokens: null,
  }

  function clientMetadata() {
    return {
      version: textOf(config.clientVersion || process.env.DSH_VERSION || '0.0.0') || '0.0.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  function log(message) {
    if (!debug) return
    try {
      fs.appendFileSync(DEBUG_FILE, new Date().toISOString() + ' ' + message + '\n')
    } catch {
      // 日志失败不影响主流程
    }
  }

  function autoPrices() {
    const cached = readPriceCache()
    return cached && cached.prices ? cached.prices : null
  }

  // 启动时静默对齐价格（有 30 天缓存就直接返回）
  void refreshPrices(log)

  // ---- 余额 ----------------------------------------------------------------

  function refreshBalance() {
    if (cache.refreshing) return cache.refreshing
    const run = async () => {
      const account = ctx.get('deepseekAccount')
      if (!account) {
        cache.balanceStatus = 'unavailable'
        cache.balanceError = 'deepseekAccount 未启用'
        return
      }
      try {
        const outcome = await account.getBalance(clientMetadata())
        cache.balanceAt = Date.now()
        if (outcome == null) {
          cache.balanceStatus = 'signed-out'
          cache.wallets = null
          cache.bonusWallets = null
          log('balance signed-out（未登录或无平台授权）')
          return
        }
        if (outcome.status === 'failed') {
          cache.balanceStatus = 'failed'
          log('balance failed（平台拒绝了余额查询，可能是 client version 或授权问题）')
          return
        }
        cache.balanceStatus = 'ready'
        cache.wallets = Array.isArray(outcome.value) ? outcome.value : []
        cache.bonusWallets = Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : []
        cache.balanceError = ''
        log(
          'balance ' + cache.balanceStatus +
            ' wallets=' + JSON.stringify(cache.wallets || []) +
            ' bonus=' + JSON.stringify(cache.bonusWallets || []),
        )
      } catch (error) {
        cache.balanceStatus = 'error'
        cache.balanceAt = Date.now()
        cache.balanceError = textOf((error && error.message) || error)
        log('balance error: ' + cache.balanceError)
      }
    }
    cache.refreshing = run().finally(() => {
      cache.refreshing = null
    })
    return cache.refreshing
  }

  // ---- 对话消耗 -------------------------------------------------------------

  function titleOf(session) {
    const titles = ctx.get('sessionTitle')
    if (!titles || !session) return ''
    try {
      const snapshot = titles.get(session)
      return snapshot && snapshot.title ? textOf(snapshot.title) : ''
    } catch {
      return ''
    }
  }

  // 页面只认得 DOM：它把选中行的文字一起报上来，这里用标题反查 live session，
  // 这样即使页面拿不到 session id（或者拿到的是旧的），切换对话也能跟上。
  function resolveByTitle(title) {
    const sessions = ctx.get('sessions')
    const wanted = textOf(title).trim()
    if (!sessions || !wanted) return null
    let list = []
    try {
      list = sessions.list()
    } catch {
      return null
    }
    const exact = []
    const loose = []
    for (const session of list) {
      const header = session.header || {}
      if (header.origin === 'subagent') continue
      const name = titleOf(session)
      if (!name) continue
      if (name === wanted) exact.push(session)
      else if (name.includes(wanted) || wanted.includes(name)) loose.push(session)
    }
    const hit = exact[0] || loose[0]
    return hit ? textOf(hit.id) : null
  }

  function sessionUsage(sessionId) {
    const id = textOf(sessionId)
    if (!id) return null
    const sessions = ctx.get('sessions')
    if (!sessions) return { id, live: false }
    let session
    try {
      session = sessions.get(id)
    } catch {
      session = undefined
    }
    if (!session) return { id, live: false }

    const key = id + ':' + textOf(session.seq)
    if (cache.tokensKey === key && cache.tokens) return cache.tokens

    let usage = null
    try {
      usage = sumUsage(session)
    } catch (error) {
      log('sumUsage failed: ' + textOf((error && error.message) || error))
    }

    let contextTokens = null
    const meter = ctx.get('tokenMeter')
    if (meter) {
      try {
        contextTokens = meter.measure(session).totalTokens
      } catch {
        contextTokens = null
      }
    }

    let model = ''
    let provider = ''
    try {
      const route = session.requestContext ? session.requestContext() : undefined
      if (route) {
        model = textOf(route.model)
        provider = textOf(route.provider)
      }
    } catch {
      // ignore
    }

    const header = session.header || {}
    const value = {
      id,
      live: true,
      createdAt: Number(header.createdAt) || null,
      subagent: header.origin === 'subagent',
      input: usage ? usage.input : 0,
      output: usage ? usage.output : 0,
      total: usage ? usage.total : 0,
      calls: usage ? usage.calls : 0,
      cacheRead: usage ? usage.cacheRead : 0,
      cacheWrite: usage ? usage.cacheWrite : 0,
      // 按发生时刻分桶的用量：页面用各自时段的单价折算，比"全按当前时段"准
      peak: usage ? usage.peak : null,
      offpeak: usage ? usage.offpeak : null,
      searches: usage ? usage.searches : 0,
      fetches: usage ? usage.fetches : 0,
      context: contextTokens,
      model,
      provider,
      title: titleOf(session),
      measured: true,
    }
    cache.tokensKey = key
    cache.tokens = value
    return value
  }

  function resolveActiveId() {
    const sessions = ctx.get('sessions')
    const candidates = []
    if (cache.activeSessionId) candidates.push(cache.activeSessionId)
    if (cache.lastActivityId) candidates.push(cache.lastActivityId)
    for (const candidate of candidates) {
      if (!sessions) return candidate
      try {
        if (sessions.get(candidate)) return candidate
      } catch {
        // ignore
      }
    }
    return candidates.length > 0 ? candidates[0] : null
  }

  function balanceMs() {
    return clampNumber(readSettings().balanceSeconds, intervalMs / 1000, 5, 3600) * 1000
  }

  function snapshot() {
    const now = Date.now()
    const settings = readSettings()
    const activeId = resolveActiveId()
    const session = sessionUsage(activeId) || { id: null, live: false }
    return {
      ok: true,
      now,
      ui: {
        pollSeconds: settings.pollSeconds,
        balanceSeconds: settings.balanceSeconds,
        // 自动抓到的官方价优先（每月一次）；autoPrices=false 时只用 config.json
        prices: (settings.autoPrices === false ? null : autoPrices()) || settings.prices,
        pricesSource: readPriceCache() ? 'auto' : 'config',
        searchPer1000: settings.searchPer1000,
        fetchPer1000: settings.fetchPer1000,
        searchBillingFrom: settings.searchBillingFrom,
      },
      balance: {
        status: cache.balanceStatus,
        wallets: cache.wallets || [],
        bonusWallets: cache.bonusWallets || [],
        updatedAt: cache.balanceAt,
        stale: cache.balanceAt === 0 || now - cache.balanceAt > balanceMs() * 2,
        error: cache.balanceError,
      },
      session: {
        ...session,
        // 优先用宿主从 sessionTitle 折出来的真标题，页面报上来的文字只作兜底
        title: session.title || cache.activeTitle || '',
        // tracked 表示这个 id 确实解析到了一个活着的 Session；
        // 页面猜错 id 时为 false，UI 退回 '—' 而不是显示假数据。
        tracked: session.live === true,
      },
    }
  }

  // ---- 路由 ----------------------------------------------------------------

  // 鉴权策略：
  //   1. 带了正确令牌 → 放行（浏览器模式：脚本由 webServer.tapIndex 注入，令牌走 URL）
  //   2. 没有 Origin → 放行（同源 fetch 与本地进程都不发 Origin）
  //   3. Origin 是 dsh-app://app → 放行（桌面端渲染进程）
  //   4. 其它 Origin 一律拒绝，挡住网页对 localhost 的 CSRF 读取
  function authorized(req) {
    const presented = textOf(req.headers['x-dsh-token-monitor'])
    if (presented !== '' && presented === token) return true
    const origin = textOf(req.headers.origin)
    if (origin === '') return true
    if (origin === 'dsh-app://app') return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  function guard(req, res) {
    if (authorized(req)) return true
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }

  // 所有注册都包在 ctx.effect 里：插件被卸载/热重载时 cordis 会执行 disposer，
  // 否则旧路由会留在 webServer 上，新实例注册同名路径时抛 duplicate route。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_STATE,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const url = parseUrl(req)
        if (url) {
          const sid = textOf(url.searchParams.get('s'))
          const typed = textOf(url.searchParams.get('t'))
          const live = (() => {
            if (!sid) return false
            const sessions = ctx.get('sessions')
            if (!sessions) return false
            try {
              return Boolean(sessions.get(sid))
            } catch {
              return false
            }
          })()
          // 标题优先：切换对话时页面即使抓到的是旧 id，只要选中行标题变了，
          // 这里就能反查到新的 live session。标题匹配不上才退回 id。
          const resolved = resolveByTitle(typed) || (live ? sid : '') || sid
          if (resolved) cache.activeSessionId = resolved
          cache.activeTitle = typed
        }
        if (Date.now() - cache.balanceAt > balanceMs()) {
          // 首次（插件刚加载、账号服务可能还没就绪）等一下再回包，
          // 免得页面第一次轮询就闪一下"取不到"。
          if (cache.balanceAt === 0) await refreshBalance()
          else void refreshBalance()
        }
        // 价格缓存超过 30 天就在后台重抓一次（有缓存时这一步基本是零成本）
        void refreshPrices(log)
        sendJson(res, 200, snapshot())
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PROBE,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        let payload = ''
        try {
          payload = await readBody(req, 64 * 1024)
        } catch {
          payload = ''
        }
        log('probe ' + payload.replace(/\s+/g, ' ').slice(0, 4000))
        sendJson(res, 200, { ok: true })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_UI,
      handler: (req, res) => {
        let source = ''
        try {
          source = fs.readFileSync(UI_FILE, 'utf8')
        } catch (error) {
          sendText(res, 500, 'text/plain; charset=utf-8', 'ui.js 缺失')
          return
        }
        sendText(res, 200, 'text/javascript; charset=utf-8', source)
      },
    }),
  )

  // ---- 注入页面 --------------------------------------------------------------

  ctx.effect(() =>
    ctx.webServer.tapIndex((html) => {
      let source = ''
      try {
        source = fs.readFileSync(UI_FILE, 'utf8')
      } catch (error) {
        log('ui.js 读取失败: ' + textOf((error && error.message) || error))
        return html
      }
      // 用外链同源脚本而不是内联脚本：内联可能被 CSP 的 script-src 拦掉，
      // 而且是静默失败。令牌和路由都通过脚本自己的 URL 传给 ui.js。
      const query = '?t=' + token + (debug ? '&debug=1' : '')
      const injected = '\n<script data-dsh-token-monitor="ui" src="' + ROUTE_UI + query + '"></script>\n'
      log('tap index: html=' + html.length + ' ui=' + source.length + 'B')
      if (html.indexOf('</body>') !== -1) {
        return html.replace('</body>', () => injected + '</body>')
      }
      return html + injected
    }),
  )

  // ---- 活动 session 兜底 ------------------------------------------------------

  ctx.effect(() =>
    ctx.on('session/event', (session) => {
      try {
        const header = session && session.header
        if (!header || header.origin === 'subagent') return
        cache.lastActivityId = textOf(session.id)
      } catch {
        // ignore
      }
    }),
  )

  // 启动即取一次余额，避免第一次打开页面时空窗。
  void refreshBalance()
  log('applied; interval=' + intervalMs + 'ms')
}
