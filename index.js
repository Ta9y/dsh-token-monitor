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
  let events = []
  try {
    events = session.ownEvents()
  } catch {
    events = []
  }
  return sumUsageEvents(events)
}

// 纯事件版本：从持久化日志里读回来的"冷会话"没有 Session 对象，也走这里累加。
function sumUsageEvents(events) {
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
    // 每个会话的用量快照：id -> { key, withContext, value }
    stats: new Map(),
    // 已销毁会话的最后一次成绩，会话消失后仍能计入汇总
    finalStats: new Map(),
    // 父会话 -> 子会话（子智能体会话被销毁后关系仍然保留）
    childrenOf: new Map(),
    // 持久化谱系（sessionQuery.traceSession）算出来的父子关系，重启后依然有效
    corpusChildren: new Map(),
    corpusFor: '',
    corpusAt: 0,
    corpusBusy: null,
    corpusSource: 'none',
    // 已经从持久化日志里补过用量的冷会话 id
    coldLoaded: new Set(),
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

  // 统计单个会话。withContext 只在主会话上用：上下文占用要跑 tokenMeter，
  // 子会话没必要每个轮询都算一遍。
  function measureSession(session, withContext, knownId) {
    const id = textOf(session.id) || textOf(knownId)
    if (!id) return null
    const key = id + ':' + textOf(session.seq) + (withContext ? ':ctx' : '')
    const cached = cache.stats.get(id)
    if (cached && cached.key === key) return cached.value

    let usage = null
    try {
      usage = sumUsage(session)
    } catch (error) {
      log('sumUsage failed: ' + textOf((error && error.message) || error))
    }

    let contextTokens = null
    if (withContext) {
      const meter = ctx.get('tokenMeter')
      if (meter) {
        try {
          contextTokens = meter.measure(session).totalTokens
        } catch {
          contextTokens = null
        }
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
      parentId: header.parentSession ? textOf(header.parentSession) : null,
      subagent: header.origin === 'subagent',
      input: usage ? usage.input : 0,
      output: usage ? usage.output : 0,
      total: usage ? usage.total : 0,
      calls: usage ? usage.calls : 0,
      cacheRead: usage ? usage.cacheRead : 0,
      cacheWrite: usage ? usage.cacheWrite : 0,
      // 按发生时刻分桶的用量：页面用各自时段的单价折算，比"全按当前时段"准
      peak: usage ? usage.peak : emptyBucket(),
      offpeak: usage ? usage.offpeak : emptyBucket(),
      searches: usage ? usage.searches : 0,
      fetches: usage ? usage.fetches : 0,
      context: contextTokens,
      model,
      provider,
      title: titleOf(session),
      measured: true,
    }
    cache.stats.set(id, { key, value })
    return value
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
    return measureSession(session, false, id)
  }

  function mainStats(sessionId) {
    const id = textOf(sessionId)
    if (!id) return null
    const sessions = ctx.get('sessions')
    if (!sessions) return null
    let session
    try {
      session = sessions.get(id)
    } catch {
      session = undefined
    }
    if (!session) return null
    return measureSession(session, true, id)
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

  // ---- 任务级汇总（主会话 + 子智能体 + 智能体团队） --------------------------

  function emptyTotals() {
    return {
      input: 0,
      output: 0,
      total: 0,
      calls: 0,
      cacheRead: 0,
      cacheWrite: 0,
      searches: 0,
      fetches: 0,
      peak: emptyBucket(),
      offpeak: emptyBucket(),
    }
  }

  function addInto(target, value) {
    if (!value) return target
    target.input += Number(value.input) || 0
    target.output += Number(value.output) || 0
    target.total += Number(value.total) || 0
    target.calls += Number(value.calls) || 0
    target.cacheRead += Number(value.cacheRead) || 0
    target.cacheWrite += Number(value.cacheWrite) || 0
    target.searches += Number(value.searches) || 0
    target.fetches += Number(value.fetches) || 0
    for (const bucketName of ['peak', 'offpeak']) {
      const source = value[bucketName]
      if (!source) continue
      const bucket = target[bucketName]
      bucket.input += Number(source.input) || 0
      bucket.output += Number(source.output) || 0
      bucket.cacheRead += Number(source.cacheRead) || 0
      bucket.cacheWrite += Number(source.cacheWrite) || 0
    }
    return target
  }

  // 已销毁子会话的成绩靠这里保住：会话从 store 消失后，用量仍然算在父任务上
  function rememberParent(session) {
    try {
      const header = session && session.header
      if (!header || !header.parentSession) return
      const parent = textOf(header.parentSession)
      const child = textOf(session.id)
      if (!parent || !child || parent === child) return
      let set = cache.childrenOf.get(parent)
      if (!set) {
        set = new Set()
        cache.childrenOf.set(parent, set)
      }
      set.add(child)
    } catch {
      // ignore
    }
  }

  function childrenIndex() {
    const index = new Map()
    const add = (parent, child) => {
      if (!parent || !child || parent === child) return
      let set = index.get(parent)
      if (!set) {
        set = new Set()
        index.set(parent, set)
      }
      set.add(child)
    }
    const sessions = ctx.get('sessions')
    if (sessions) {
      try {
        for (const session of sessions.list()) {
          const header = session.header || {}
          if (header.parentSession) add(textOf(header.parentSession), textOf(session.id))
        }
      } catch {
        // ignore
      }
    }
    for (const [parent, children] of cache.childrenOf) {
      for (const child of children) add(parent, child)
    }
    // 持久化谱系兜底：进程重启后，早就结束的子会话不在 store 里，只能靠这条
    for (const [parent, children] of cache.corpusChildren) {
      for (const child of children) add(parent, child)
    }
    return index
  }

  function collectDescendants(rootId) {
    if (!rootId) return []
    const index = childrenIndex()
    const seen = new Set([rootId])
    const out = []
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift()
      const kids = index.get(current)
      if (!kids) continue
      for (const kid of kids) {
        if (seen.has(kid)) continue
        seen.add(kid)
        out.push(kid)
        queue.push(kid)
      }
    }
    return out
  }

  // ---- 持久化谱系 + 冷会话用量 ----------------------------------------------
  //
  // 子智能体的会话在结束（或被进程重启清掉）之后就不在 ctx.sessions 里了，
  // 只靠活会话内存关系的话，"子任务"这一栏会在重启后整个消失。
  // ctx.sessionQuery 读的是磁盘上的会话日志，所以：
  //   1. traceSession(rootId)   拿到整棵谱系 -> 子会话 id
  //   2. readSession(id)        把冷会话的日志读回来 -> 用它的事件累加用量
  // 两件事都有缓存，重启后第一次打开页面补齐，之后每次轮询都是零成本。

  const CORPUS_TTL_MS = 30 * 1000

  function lineageNodeId(node) {
    const header = node && node.session && node.session.header
    return textOf(header && header.id)
  }

  async function refreshCorpus(rootId) {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.traceSession !== 'function' || !rootId) {
      cache.corpusSource = 'none'
      return
    }
    if (cache.corpusBusy) return cache.corpusBusy
    const run = async () => {
      try {
        const trace = await query.traceSession(rootId)
        const index = new Map()
        const walk = (node, parentId) => {
          const kids = node && Array.isArray(node.descendants) ? node.descendants : []
          for (const kid of kids) {
            const id = lineageNodeId(kid)
            if (id && parentId) {
              let set = index.get(parentId)
              if (!set) {
                set = new Set()
                index.set(parentId, set)
              }
              set.add(id)
            }
            walk(kid, id || parentId)
          }
        }
        walk(trace, rootId)
        // store 里还活着的关系以实时数据为准，这里只补它没有的
        for (const [parent, kids] of cache.childrenOf) {
          let set = index.get(parent)
          if (!set) {
            set = new Set()
            index.set(parent, set)
          }
          for (const kid of kids) set.add(kid)
        }
        cache.corpusChildren = index
        cache.corpusSource = 'trace'
        cache.corpusFor = rootId
        cache.corpusAt = Date.now()
        log('corpus trace ok: children=' + [...index.values()].reduce((n, set) => n + set.size, 0))
      } catch (error) {
        cache.corpusSource = 'none'
        // 记下时间，失败也在 TTL 内不重试，免得每次轮询都刷一遍日志
        cache.corpusFor = rootId
        cache.corpusAt = Date.now()
        log('corpus 谱系读取失败: ' + textOf((error && error.message) || error))
      }
    }
    cache.corpusBusy = run().finally(() => {
      cache.corpusBusy = null
    })
    return cache.corpusBusy
  }

  async function ensureCorpus(rootId) {
    if (!rootId) return
    const fresh = cache.corpusFor === rootId && Date.now() - cache.corpusAt < CORPUS_TTL_MS
    if (fresh) return
    await refreshCorpus(rootId)
  }

  // 冷会话（已结束/上次进程里的子任务）的用量从日志里补一次，之后走 finalStats。
  async function hydrateCold(rootId) {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.readSession !== 'function' || !rootId) return
    const sessions = ctx.get('sessions')
    for (const id of collectDescendants(rootId)) {
      if (cache.coldLoaded.has(id)) continue
      let live = false
      try {
        live = Boolean(sessions && sessions.get(id))
      } catch {
        live = false
      }
      if (live) continue
      if (cache.finalStats.has(id)) {
        cache.coldLoaded.add(id)
        continue
      }
      try {
        const snapshot = await query.readSession(id)
        const all = Array.isArray(snapshot && snapshot.events) ? snapshot.events : []
        const from = Number(snapshot && snapshot.inheritedEventCount) || 0
        const usage = sumUsageEvents(all.slice(from))
        const header = (snapshot && snapshot.session) || {}
        let model = ''
        for (const event of all) {
          if (event && event.type === 'request/context' && event.data) {
            const name = textOf(event.data.model)
            if (name) model = name
          }
        }
        cache.finalStats.set(id, {
          id,
          live: false,
          cold: true,
          measured: true,
          createdAt: Number(header.createdAt) || null,
          parentId: header.parentSession ? textOf(header.parentSession) : null,
          subagent: header.origin === 'subagent',
          model,
          provider: '',
          title: '',
          context: null,
          ...usage,
          at: Date.now(),
        })
        cache.coldLoaded.add(id)
        log('cold hydrate ' + id + ' total=' + usage.total + ' calls=' + usage.calls)
      } catch (error) {
        // 读不出来就别每次轮询都重试
        cache.coldLoaded.add(id)
        log('冷会话读取失败 ' + id + ': ' + textOf((error && error.message) || error))
      }
    }
  }

  function statsOf(sessionId) {
    const id = textOf(sessionId)
    if (!id) return null
    const live = sessionUsage(id)
    if (live && live.live) return live
    return cache.finalStats.get(id) || null
  }

  // 智能体团队：只有"当前会话正是一个 Team Lead"时才把队友算进来
  function teammatesOf(rootId) {
    const teams = ctx.get('agentTeams')
    const agents = ctx.get('agents')
    if (!teams || !agents || !rootId) return []
    let self = null
    try {
      for (const agent of agents.list()) {
        if (textOf(agent.id) === rootId) {
          self = agent
          break
        }
      }
    } catch {
      return []
    }
    if (!self) return []
    try {
      const membership = typeof teams.tryMembership === 'function' ? teams.tryMembership(self) : undefined
      if (!membership || membership.role !== 'lead') return []
      const members = teams.listMembers(self) || []
      const out = []
      for (const member of members) {
        if (!member || member.role !== 'teammate') continue
        const id = textOf(member.id)
        if (!id) continue
        out.push({ id, name: textOf(member.name), status: textOf(member.status) })
      }
      return out
    } catch {
      return []
    }
  }

  function partOf(stats) {
    if (!stats) return null
    return {
      id: stats.id,
      live: stats.live === true,
      model: stats.model || '',
      measured: true,
      input: stats.input || 0,
      output: stats.output || 0,
      total: stats.total || 0,
      calls: stats.calls || 0,
      cacheRead: stats.cacheRead || 0,
      cacheWrite: stats.cacheWrite || 0,
      peak: stats.peak || emptyBucket(),
      offpeak: stats.offpeak || emptyBucket(),
      searches: stats.searches || 0,
      fetches: stats.fetches || 0,
    }
  }

  function partFromTotals(totals, model) {
    return {
      id: null,
      live: false,
      model: model || '',
      measured: true,
      ...totals,
    }
  }

  // mainValue 由调用方传进来（它带 :ctx 变体），避免这里再算一遍导致缓存反复失效
  //
  // 口径：子任务 = 这棵树下**所有**子会话（含队友）；队友只是其中被单独拆出来看的一块，
  // 不从子任务里扣除，也不再单独参与合计 —— 否则同一份用量会被算两次。
  function taskRollup(rootId, mainValue) {
    const parts = { main: null, subagents: null, teammates: null }
    const counts = { subagents: 0, teammates: 0 }
    if (!rootId) return { parts, counts }

    parts.main = partOf(mainValue)

    // 队友是 Lead 的子会话（origin=subagent、parentSession=Lead），
    // 它自己的子智能体又是它的子会话，所以"队友整棵子树"就是拆解出来的那一块。
    const mates = teammatesOf(rootId)
    const mateTree = new Set()
    for (const mate of mates) {
      mateTree.add(mate.id)
      for (const id of collectDescendants(mate.id)) mateTree.add(id)
    }

    const subTotals = emptyTotals()
    let subModel = ''
    for (const id of collectDescendants(rootId)) {
      const stats = statsOf(id)
      if (!stats) continue
      counts.subagents += 1
      addInto(subTotals, stats)
      if (!subModel && stats.model) subModel = stats.model
    }
    if (counts.subagents > 0) parts.subagents = partFromTotals(subTotals, subModel)

    const teamTotals = emptyTotals()
    let teamModel = ''
    if (mates.length > 0) {
      counts.teammates = mates.length
      for (const id of mateTree) {
        const stats = statsOf(id)
        if (!stats) continue
        addInto(teamTotals, stats)
        if (!teamModel && stats.model) teamModel = stats.model
      }
      parts.teammates = partFromTotals(teamTotals, teamModel)
    }

    return { parts, counts }
  }

  function balanceMs() {
    return clampNumber(readSettings().balanceSeconds, intervalMs / 1000, 5, 3600) * 1000
  }

  function snapshot() {
    const now = Date.now()
    const settings = readSettings()
    const activeId = resolveActiveId()
    const main = mainStats(activeId)
    // 任务级汇总：主会话 + 这棵树下所有子会话（队友已经在 subagents 里，不再重复加）
    const rollup = taskRollup(main ? activeId : null, main)

    const totals = emptyTotals()
    addInto(totals, rollup.parts.main)
    addInto(totals, rollup.parts.subagents)
    const measured = Boolean(rollup.parts.main || rollup.parts.subagents || rollup.parts.teammates)

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
        id: main ? main.id : activeId,
        live: Boolean(main),
        // 优先用宿主从 sessionTitle 折出来的真标题，页面报上来的文字只作兜底
        title: (main && main.title) || cache.activeTitle || '',
        model: (main && main.model) || '',
        provider: (main && main.provider) || '',
        createdAt: main ? main.createdAt : null,
        context: main ? main.context : null,
        measured,
        // tracked 表示这个 id 确实解析到了一个活着的 Session；
        // 页面猜错 id 时为 false，UI 退回 '—' 而不是显示假数据。
        tracked: Boolean(main),
        // 合计（主 + 子 + 队友）
        ...totals,
        // 分项：页面据此展示"主会话 / 子任务 / 队友"的金额与 token
        parts: rollup.parts,
        counts: rollup.counts,
        diag: {
          corpus: cache.corpusSource,
          corpusAt: cache.corpusAt,
          childrenOfRoot: (childrenIndex().get(activeId) || { size: 0 }).size,
          cold: cache.coldLoaded.size,
        },
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
        // 子任务/队友的谱系和冷会话用量：磁盘上的会话日志是重启后唯一可靠的来源，
        // 靠它把已经结束（或上个进程里的）子任务补回来。
        const activeId = resolveActiveId()
        if (activeId) {
          try {
            await ensureCorpus(activeId)
            await hydrateCold(activeId)
          } catch (error) {
            log('corpus/hydrate 失败: ' + textOf((error && error.message) || error))
          }
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

  // ---- 会话关系与生命周期 ------------------------------------------------------

  ctx.effect(() =>
    ctx.on('session/event', (session) => {
      try {
        // 任何会话（含子智能体）都要记录父子关系，子会话销毁后关系仍然有效
        rememberParent(session)
        const header = session && session.header
        if (!header || header.origin === 'subagent') return
        cache.lastActivityId = textOf(session.id)
      } catch {
        // ignore
      }
    }),
  )

  // 子智能体一被创建就记下父子关系：不依赖 session/event 是否送到本级上下文。
  ctx.effect(() =>
    ctx.on('subagent/start', (info) => {
      try {
        const childId = textOf(info && info.id)
        if (!childId) return
        const sessions = ctx.get('sessions')
        const child = sessions ? sessions.get(childId) : undefined
        const parent = textOf(child && child.header && child.header.parentSession)
        if (!parent) return
        let set = cache.childrenOf.get(parent)
        if (!set) {
          set = new Set()
          cache.childrenOf.set(parent, set)
        }
        set.add(childId)
        log('subagent/start ' + childId + ' <- ' + parent)
      } catch {
        // ignore
      }
    }),
  )

  // 会话离开 store 之前把成绩固化下来，否则子任务/队友销毁后这块用量就丢了
  ctx.effect(() =>
    ctx.on('session/disposed', (session) => {
      try {
        const id = textOf(session && session.id)
        if (!id) return
        // 子会话销毁时也记一次父子关系：插件可能在它创建之后才加载，没赶上 session/event
        rememberParent(session)
        const final = measureSession(session, false, id)
        if (final) cache.finalStats.set(id, final)
      } catch {
        // ignore
      }
    }),
  )

  // 启动即取一次余额，避免第一次打开页面时空窗。
  void refreshBalance()
  log('applied; interval=' + intervalMs + 'ms')
}
