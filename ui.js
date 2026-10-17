// dsh-token-monitor —— 悬浮窗本体（纯 DOM，无依赖）
//
// 两条加载路径共用这一份实现：
//   桌面端：client.js（DSH client module）挂 <script src="/dsh-token-monitor/ui.js">
//   浏览器端：index.js 的 webServer.tapIndex 挂 <script src="...ui.js?t=<token>&debug=1">
//
// 路由和令牌都从脚本自己的 src 解析；桌面端没有令牌参数时退回固定路由，
// 由 host 侧按 Origin 放行（dsh-app://app 或同源）。
(function () {
  'use strict'

  var DEFAULT_PREFIX = '/dsh-token-monitor/'

  function resolveBoot() {
    var configured = window.__DSH_TOKEN_MONITOR__
    if (configured && configured.route) return configured
    var el = document.currentScript || document.querySelector('script[data-dsh-token-monitor]')
    var url = null
    if (el) {
      try {
        url = new URL(el.getAttribute('src') || '', location.href)
      } catch (e) {
        url = null
      }
    }
    var prefix = url ? url.pathname.replace(/ui\.js$/, '') : DEFAULT_PREFIX
    return {
      token: (url && url.searchParams.get('t')) || '',
      route: prefix + 'state',
      probe: prefix + 'probe',
      // 应用语言由 client.js 通过 lang 参数传进来
      lang: (url && url.searchParams.get('lang')) || '',
      // 默认开诊断（探针只打一次 DOM 特征，用来校准会话识别）；
      // 想关就在脚本 URL 上加 ?debug=0
      debug: !url || url.searchParams.get('debug') !== '0',
    }
  }

  var boot = resolveBoot()
  var snapshot = window.__DSH_TOKEN_MONITOR_SNAPSHOT__ || null
  if (!boot.route) return
  if (document.getElementById('dsh-token-monitor-host')) return

  var KEY_POS = 'dsh-token-monitor:pos'
  var POLL_MS = 10000
  // 显隐不持久化：每次打开应用都从「收起」状态开始，只记住竖条的位置
  var hiddenState = true
  var EDGE = 16
  var CARD_W = 236
  var SESSION_ATTRS = ['data-session-id', 'data-sessionid', 'data-session', 'data-session-key']

  // ---- 多语言（跟随应用语言） -------------------------------------------------
  //
  // 语言由 client.js 读应用的 locale 服务后经 URL 的 lang 参数传进来；
  // 应用里切语言时 client.js 会派发事件，这里就地换文案，不重新挂载。

  var STRINGS = {
    'zh-Hans': {
      balance: '余额',
      session: '本对话',
      bonus: '赠送余额',
      tokens: '消耗 token',
      calls: '调用次数',
      context: '上下文',
      tools: '搜索 / 抓取',
      model: '计价模型',
      updated: '余额更新',
      sessionId: '会话',
      expand: '展开 Token Monitor',
      expandWithCost: '展开 Token Monitor（本对话 {cost}）',
      closeTip: '收起成贴右侧的竖条',
      notSignedIn: '未登录',
      unavailable: '取不到',
      waiting: '待激活',
      loading: '…',
      offline: '离线',
      offlineSnapshot: '离线快照（{err}）',
      searched: '搜索 {n} 次 / 抓取 {m} 次',
      freeUntil: '（11-01 前免费）',
      modelLine: '{model} · 按调用时段计价（现在{tier}）',
      peak: '高峰',
      idle: '空闲',
      unknownSession: '未识别',
      times: '{n} 次',
    },
    en: {
      balance: 'Balance',
      session: 'This chat',
      bonus: 'Bonus balance',
      tokens: 'Tokens used',
      calls: 'API calls',
      context: 'Context',
      tools: 'Search / Fetch',
      model: 'Priced model',
      updated: 'Balance updated',
      sessionId: 'Session',
      expand: 'Open Token Monitor',
      expandWithCost: 'Open Token Monitor (this chat {cost})',
      closeTip: 'Collapse into the tab on the right',
      notSignedIn: 'Signed out',
      unavailable: 'Unavailable',
      waiting: 'Not started',
      loading: '…',
      offline: 'Offline',
      offlineSnapshot: 'Offline snapshot ({err})',
      searched: '{n} searches / {m} fetches',
      freeUntil: ' (free before Nov 1)',
      modelLine: '{model} · priced by call time (now {tier})',
      peak: 'peak',
      idle: 'off-peak',
      unknownSession: 'not detected',
      times: '{n}',
    },
  }

  function normalizeLang(value) {
    var text = String(value || '').toLowerCase()
    if (text.indexOf('zh') === 0) return 'zh-Hans'
    if (text.indexOf('en') === 0) return 'en'
    return ''
  }

  function detectLang() {
    var candidates = [
      boot.lang,
      window.__DSH_TOKEN_MONITOR_LOCALE__,
      document.documentElement && document.documentElement.lang,
      navigator.language,
    ]
    for (var i = 0; i < candidates.length; i++) {
      var normalized = normalizeLang(candidates[i])
      if (normalized) return normalized
    }
    return 'zh-Hans'
  }

  var lang = detectLang()

  function t(key, vars) {
    var table = STRINGS[lang] || STRINGS['zh-Hans']
    var text = table[key] != null ? table[key] : STRINGS['zh-Hans'][key] || key
    if (vars) {
      for (var name in vars) {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) continue
        text = text.split('{' + name + '}').join(String(vars[name]))
      }
    }
    return text
  }

  // ---- 小工具 ---------------------------------------------------------------

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key)
      if (!raw) return fallback
      return JSON.parse(raw)
    } catch (e) {
      return fallback
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (e) {
      // 隐私模式下忽略
    }
  }

  function clamp(value, min, max) {
    if (max < min) return min
    return Math.min(max, Math.max(min, value))
  }

  // 文本被省略号截断时，用原生 tooltip 把完整内容补回来（悬停即可看全）
  function syncTooltip(el) {
    if (!el) return
    var full = el.textContent || ''
    el.title = el.scrollWidth > el.clientWidth + 1 ? full : ''
  }

  function formatTokens(n) {
    var value = Number(n)
    if (!isFinite(value) || value <= 0) return '0'
    if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M'
    if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
    return String(Math.round(value))
  }

  function pickWallet(wallets) {
    if (!wallets || !wallets.length) return null
    for (var i = 0; i < wallets.length; i++) {
      if (wallets[i] && wallets[i].currency === 'CNY') return wallets[i]
    }
    return wallets[0] || null
  }

  function formatMoney(wallet) {
    if (!wallet) return null
    var amount = Number(wallet.balance)
    var symbol = wallet.currency === 'USD' ? '$' : '¥'
    if (!isFinite(amount)) return symbol + String(wallet.balance)
    return symbol + amount.toFixed(2)
  }

  // 官方价格（元 / 百万 token），按模型 + 时段。数据来自 DeepSeek 官方价目页（2026-10）。
  // 高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；其余时段（含周末）是半价。
  // 注意：法定节假日未处理；历史 token 统一按"当前时段"折算，是估算不是结算值。
  // 实际值由宿主从 config.json 下发（snapshot.ui.prices）。
  var priceTable = {
    'deepseek-flash': {
      offpeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    'deepseek-v4-pro': {
      offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
  }
  var FALLBACK_MODEL = 'deepseek-flash'

  // Search / Fetch 是独立按次计费的（元 / 千次）。官方说明 2026-11-01 00:00 前不计费，
  // 所以次数一直统计，钱按日期决定收不收。
  var toolRates = { searchPer1000: 5, fetchPer1000: 5, from: '2026-11-01' }

  function numberOr(value, fallback) {
    var n = Number(value)
    return isFinite(n) ? n : fallback
  }

  function applyUiSettings(ui) {
    if (!ui || typeof ui !== 'object') return
    if (ui.searchPer1000 != null) toolRates.searchPer1000 = numberOr(ui.searchPer1000, toolRates.searchPer1000)
    if (ui.fetchPer1000 != null) toolRates.fetchPer1000 = numberOr(ui.fetchPer1000, toolRates.fetchPer1000)
    if (ui.searchBillingFrom) toolRates.from = String(ui.searchBillingFrom)

    var incoming = ui.prices
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return
    // 只接受 { model: { peak, offpeak } } 这种新格式；旧的扁平单价忽略掉
    if (incoming.cacheMiss !== undefined || incoming.input !== undefined) return
    priceTable = incoming
  }

  function toolBillingStarted() {
    var from = Date.parse(toolRates.from + 'T00:00:00+08:00')
    if (!isFinite(from)) return true
    return Date.now() >= from
  }

  function beijingNow() {
    var now = new Date()
    var utc = now.getTime() + now.getTimezoneOffset() * 60000
    return new Date(utc + 8 * 3600000)
  }

  function isPeakNow() {
    var bj = beijingNow()
    var day = bj.getDay()
    if (day === 0 || day === 6) return false
    var hour = bj.getHours() + bj.getMinutes() / 60
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  }

  function ratesFor(model) {
    var name = model && priceTable[model] ? model : FALLBACK_MODEL
    var entry = priceTable[name] || priceTable[FALLBACK_MODEL]
    if (!entry) return null
    var tier = isPeakNow() ? 'peak' : 'offpeak'
    return entry[tier] || entry.offpeak || entry.peak || null
  }

  function bucketCost(tokens, rates) {
    if (!tokens || !rates) return null
    var miss = (Number(tokens.input) || 0) + (Number(tokens.cacheWrite) || 0)
    var hit = Number(tokens.cacheRead) || 0
    var out = Number(tokens.output) || 0
    if (miss + hit + out === 0) return 0
    var cny = (miss * rates.cacheMiss + hit * rates.cacheHit + out * rates.output) / 1e6
    return isFinite(cny) ? cny : null
  }

  function toolCost(session) {
    if (!session || !toolBillingStarted()) return 0
    var searches = Number(session.searches) || 0
    var fetches = Number(session.fetches) || 0
    if (searches === 0 && fetches === 0) return 0
    return (searches * toolRates.searchPer1000 + fetches * toolRates.fetchPer1000) / 1000
  }

  function costOf(session) {
    if (!session || !session.measured) return null
    var extras = toolCost(session)
    var entry = priceTable[session.model] || priceTable[FALLBACK_MODEL]

    // 优先用宿主按「调用发生时刻」分好桶的用量：高峰和空闲各按自己的单价算，
    // 比把全部 token 按当前时段一刀切准得多。
    if (entry && (session.peak || session.offpeak)) {
      var peakCost = bucketCost(session.peak, entry.peak)
      var idleCost = bucketCost(session.offpeak, entry.offpeak)
      if (peakCost != null || idleCost != null) {
        return (peakCost || 0) + (idleCost || 0) + extras
      }
    }

    // 兼容：宿主没给分桶数据时退回「总量 × 当前时段」
    var rates = entry ? ratesFor(session.model) : null
    if (!rates) return extras > 0 ? extras : null
    var tokenCost = bucketCost(
      { input: session.input, cacheWrite: session.cacheWrite, cacheRead: session.cacheRead, output: session.output },
      rates,
    )
    if (tokenCost == null) return extras > 0 ? extras : null
    return tokenCost + extras
  }

  function formatCost(cny) {
    if (cny == null) return null
    if (cny >= 100) return '¥' + cny.toFixed(0)
    if (cny >= 1) return '¥' + cny.toFixed(2)
    return '¥' + cny.toFixed(2)
  }

  function formatClock(ms) {
    if (!ms) return '—'
    var d = new Date(ms)
    var pad = function (n) { return (n < 10 ? '0' : '') + n }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  // ---- 当前会话识别 -----------------------------------------------------------

  function rowText(el) {
    var text = (el && el.textContent) || ''
    return text.replace(/\s+/g, ' ').trim().slice(0, 60)
  }

  var SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  var lastDeepScanAt = 0
  var lastFound = null

  // 在某个子树里找第一个“值像 session id”的属性
  function scanSubtree(root, limit) {
    if (!root) return null
    var nodes = root.querySelectorAll('*')
    var count = Math.min(nodes.length, limit)
    for (var i = 0; i < count; i++) {
      var el = nodes[i]
      var attrs = el.attributes
      for (var j = 0; j < attrs.length; j++) {
        var value = attrs[j].value
        if (!value || value.length < 20) continue
        var hit = value.match(SESSION_RE)
        if (hit) {
          return { id: hit[0], title: rowText(el), via: 'dom:' + attrs[j].name }
        }
      }
    }
    return null
  }

  // 当前选中的会话行：不同版本可能用 aria-selected / data-selected / aria-current
  function selectedRow() {
    return (
      document.querySelector('[aria-selected="true"]') ||
      document.querySelector('[data-selected="true"]') ||
      document.querySelector('[aria-current="page"]')
    )
  }

  // 从探针拿到的真实结构（2026-10-17）：会话区容器带 data-conversation-session，
  // 侧边栏行带 data-row-key，两者都可能直接就是 session id。先认这两个，再退回其它线索。
  var CONVERSATION_ATTR = 'data-conversation-session'
  var ROW_KEY_ATTR = 'data-row-key'

  // 只接受形如 session-<uuid> 的值，避免把"行序号"之类的 key 当成 id 报上去
  function asSessionId(value) {
    var text = String(value || '')
    var hit = text.match(SESSION_RE)
    return hit ? hit[0] : ''
  }

  function idFromElement(el) {
    if (!el) return ''
    for (var i = 0; i < SESSION_ATTRS.length; i++) {
      var value = el.getAttribute ? el.getAttribute(SESSION_ATTRS[i]) : ''
      if (value) return value
    }
    var rowKey = el.getAttribute ? asSessionId(el.getAttribute(ROW_KEY_ATTR)) : ''
    if (rowKey) return rowKey
    var hit = scanSubtree(el, 90)
    return hit ? hit.id : ''
  }

  // 侧边栏行文字会带相对时间尾巴（"…plugin2分钟"），匹配标题前先削掉
  function normalizeTitle(text) {
    return String(text || '')
      .replace(/\s*(刚刚|刚才)$/u, '')
      .replace(/\s*\d+\s*(秒|分钟|分|小时|天|周|个月|年)前?$/u, '')
      .replace(/\s*\d{1,2}[-/]\d{1,2}(\s+\d{1,2}:\d{2})?$/u, '')
      .trim()
  }

  // 切换对话的关键：每次都重新找"当前会话"。
  // 优先读会话区容器上的 data-conversation-session（最准），其次选中行，最后才靠标题。
  function detectSession() {
    var row = selectedRow()
    var title = row ? normalizeTitle(rowText(row)) : ''

    var conversation = document.querySelector('[' + CONVERSATION_ATTR + ']')
    var id = conversation ? asSessionId(conversation.getAttribute(CONVERSATION_ATTR)) : ''

    if (!id) id = idFromElement(row)

    if (!id) {
      var fromUrl = String(location.href || '').match(SESSION_RE)
      if (fromUrl) id = fromUrl[0]
    }

    if (!row && !id) {
      var now = Date.now()
      if (now - lastDeepScanAt > 10000) {
        lastDeepScanAt = now
        var found = scanSubtree(document.body, 2000)
        if (found) {
          lastFound = found
          return { id: found.id, title: title || found.title, via: 'deep' }
        }
      }
      if (lastFound) return { id: lastFound.id, title: title || lastFound.title, via: 'memo' }
    }

    return { id: id, title: title, via: id ? 'id' : row ? 'row' : 'none' }
  }

  function sampleAttributeNames() {
    var names = {}
    var list = []
    try {
      var all = document.querySelectorAll('*')
      for (var i = 0; i < all.length && list.length < 120; i++) {
        var attrs = all[i].attributes
        for (var j = 0; j < attrs.length; j++) {
          var name = attrs[j].name
          if (name.indexOf('data-') !== 0) continue
          if (names[name]) continue
          names[name] = true
          list.push(name)
        }
      }
    } catch (e) {
      // ignore
    }
    return list
  }

  // ---- 样式 -------------------------------------------------------------------

  var CSS = [
    ':host { all: initial; }',
    '.card {',
    '  box-sizing: border-box; width: ' + CARD_W + 'px; padding: 11px 13px 12px;',
    '  border-radius: 12px; cursor: grab; user-select: none;',
    '  font: 12.5px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;',
    '  background: rgba(255,255,255,0.95); color: #1f2328;',
    '  border: 1px solid rgba(0,0,0,0.10);',
    '  box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06);',
    '  backdrop-filter: blur(10px); pointer-events: auto;',
    // top 设的是「竖条中心」，再靠 translateY(-50%) 自居中：
    // 明细展开动画期间高度一直在变，但纵向中心始终咬住竖条，不需要 JS 每帧追。
    '  transform: translateY(-50%) scale(var(--tm-scale, 1)); transform-origin: left center;',
    '  transition: opacity 150ms ease, transform 150ms ease, box-shadow 120ms ease, border-color 120ms ease;',
    '}',
    // 展开/收起动画：不用 display:none（那样没有过渡），改成透明 + 轻微右移缩放
    '.card.closed {',
    '  opacity: 0; pointer-events: none;',
    '  transform: translateY(-50%) translateX(14px) scale(calc(var(--tm-scale, 1) * 0.96));',
    '}',
    '.card.dragging { box-shadow: 0 12px 32px rgba(0,0,0,0.20); cursor: grabbing; }',
    // 拖动期间保持明细展开，不要"掉回未展开状态"
    '.card.dragging .extra { display: block !important; }',
    '.row { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }',
    '.row + .row { margin-top: 4px; }',
    '.label { color: #6a737d; font-size: 11.5px; flex: none; }',
    '.value { font-weight: 600; font-size: 13.5px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }',
    '.value.dim { color: #9aa2ac; font-weight: 500; }',
    '.sub { margin-left: auto; color: #8b949e; font-size: 11px; font-variant-numeric: tabular-nums; }',
    '.head { display: flex; align-items: center; gap: 6px; }',
    '.dot { width: 7px; height: 7px; border-radius: 50%; background: #b8bfc7; flex: none; }',
    '.dot.ok { background: #2da44e; }',
    '.dot.warn { background: #d29922; }',
    '.dot.bad { background: #cf222e; }',
    '.title { flex: 1; color: #6a737d; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.close {',
    '  flex: none; width: 18px; height: 18px; line-height: 17px; text-align: center;',
    '  border-radius: 6px; color: #d1242f; cursor: pointer; font-size: 15px; font-weight: 700;',
    '  transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;',
    '}',
    '.close:hover { background: #d1242f; color: #fff; box-shadow: 0 0 10px rgba(209,36,47,0.45); }',
    // 明细展开/收起动画：用 max-height + opacity 过渡，而不是 display 切换
    '.extra {',
    '  max-height: 0; opacity: 0; overflow: hidden;',
    '  margin-top: 0; padding-top: 0;',
    '  border-top: 1px dashed transparent;',
    '  color: #57606a; font-size: 11.5px;',
    '  transition: max-height 200ms ease, opacity 160ms ease, margin-top 200ms ease, padding-top 200ms ease;',
    '}',
    '.card.expanded .extra, .card.dragging .extra {',
    '  max-height: 240px; opacity: 1; margin-top: 7px; padding-top: 7px;',
    '  border-top-color: rgba(0,0,0,0.10);',
    '}',
    '.kv { display: flex; align-items: baseline; gap: 10px; line-height: 1.62; }',
    '.kv .k { flex: none; width: 62px; color: #8b949e; }',
    '.kv .v { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }',
    '.tab {',
    '  position: fixed; right: 0; top: 50%; transform: translateY(-50%);',
    '  box-sizing: border-box; width: 32px; min-height: 112px; padding: 12px 0;',
    '  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;',
    '  border-radius: 12px 0 0 12px; cursor: pointer; pointer-events: auto; user-select: none;',
    '  background: linear-gradient(180deg, #2f7cf6 0%, #1a5fd0 55%, #1549a6 100%);',
    '  color: #fff; box-shadow: -6px 8px 22px rgba(12,58,140,0.38);',
    '  font: 600 11px/1.1 "Microsoft YaHei", system-ui, sans-serif; letter-spacing: 0.5px;',
    '  transform: translateY(-50%) scale(var(--tm-scale, 1)); transform-origin: right center;',
    '  transition: box-shadow 150ms ease, filter 150ms ease;',
    '}',
    '.tab:hover {',
    '  filter: brightness(1.08);',
    '  box-shadow: 0 0 0 2px rgba(255,255,255,0.30), 0 0 22px 4px rgba(88,166,255,0.55), -8px 8px 26px rgba(12,58,140,0.42);',
    '}',
    '.tab.dragging { filter: brightness(0.96); cursor: grabbing; }',
    '.tab.muted { opacity: 0.42; filter: saturate(0.25); }',
    '.tab.muted:hover { opacity: 0.9; filter: saturate(0.85); }',
    '.tab:active { filter: brightness(0.96); }',
    '.tab .dot { background: #fff; width: 7px; height: 7px; box-shadow: 0 0 0 3px rgba(255,255,255,0.22); }',
    '.tab .tabValue { writing-mode: vertical-rl; text-orientation: mixed; font-variant-numeric: tabular-nums; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: rgba(32,34,38,0.95); color: #e6edf3; border-color: rgba(255,255,255,0.10); }',
    '  .label, .title, .extra { color: #9198a1; }',
    '  .value.dim, .sub { color: #6e7681; }',
    '  .close:hover { background: #d1242f; color: #fff; }',
    '  .card.expanded .extra, .card.dragging .extra { border-top-color: rgba(255,255,255,0.12); }',
    '}',
  ].join('\n')

  // ---- 结构 -------------------------------------------------------------------

  var host = document.createElement('div')
  host.id = 'dsh-token-monitor-host'
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;'
  var shadow = host.attachShadow({ mode: 'open' })
  var style = document.createElement('style')
  style.textContent = CSS
  shadow.appendChild(style)

  var card = document.createElement('div')
  card.className = 'card'
  card.style.position = 'fixed'
  card.style.pointerEvents = 'auto'

  var head = document.createElement('div')
  head.className = 'head'
  var dot = document.createElement('span')
  dot.className = 'dot'
  var title = document.createElement('span')
  title.className = 'title'
  title.textContent = 'Token Monitor'
  var close = document.createElement('span')
  close.className = 'close'
  close.textContent = '×'
  close.title = t('closeTip')
  head.appendChild(dot)
  head.appendChild(title)
  head.appendChild(close)

  var rowBalance = document.createElement('div')
  rowBalance.className = 'row'
  var lblBalance = document.createElement('span')
  lblBalance.className = 'label'
  lblBalance.textContent = t('balance')
  var valBalance = document.createElement('span')
  valBalance.className = 'value dim'
  valBalance.textContent = '—'
  rowBalance.appendChild(lblBalance)
  rowBalance.appendChild(valBalance)

  var rowSession = document.createElement('div')
  rowSession.className = 'row'
  var lblSession = document.createElement('span')
  lblSession.className = 'label'
  lblSession.textContent = t('session')
  var valSession = document.createElement('span')
  valSession.className = 'value dim'
  valSession.textContent = '—'
  var subSession = document.createElement('span')
  subSession.className = 'sub'
  subSession.textContent = ''
  rowSession.appendChild(lblSession)
  rowSession.appendChild(valSession)
  rowSession.appendChild(subSession)

  var extra = document.createElement('div')
  extra.className = 'extra'
  var kvRows = {}

  function addKv(key, labelKey) {
    var row = document.createElement('div')
    row.className = 'kv'
    var k = document.createElement('span')
    k.className = 'k'
    k.textContent = t(labelKey)
    var v = document.createElement('span')
    v.className = 'v'
    row.appendChild(k)
    row.appendChild(v)
    extra.appendChild(row)
    kvRows[key] = { row: row, label: k, value: v, labelKey: labelKey }
  }

  function setKv(key, text) {
    var cell = kvRows[key]
    if (!cell) return
    if (text == null || text === '') {
      cell.row.style.display = 'none'
      return
    }
    cell.row.style.display = 'flex'
    cell.value.textContent = text
  }

  addKv('bonus', 'bonus')
  addKv('tokens', 'tokens')
  addKv('calls', 'calls')
  addKv('context', 'context')
  addKv('tools', 'tools')
  addKv('model', 'model')
  addKv('updated', 'updated')
  addKv('session', 'sessionId')

  card.appendChild(head)
  card.appendChild(rowBalance)
  card.appendChild(rowSession)
  card.appendChild(extra)

  // 收起态：吸附在右侧的竖向矩形按钮（贴着窗口右边缘、垂直居中）
  var tab = document.createElement('div')
  tab.className = 'tab'
  tab.title = t('expand')
  tab.style.display = 'none'
  var tabDot = document.createElement('span')
  tabDot.className = 'dot'
  var tabValue = document.createElement('span')
  tabValue.className = 'tabValue'
  tabValue.textContent = '¥ --'
  tab.appendChild(tabDot)
  tab.appendChild(tabValue)

  shadow.appendChild(card)
  shadow.appendChild(tab)

  function mount() {
    if (!document.body) {
      window.setTimeout(mount, 50)
      return
    }
    // 先摆好位置/显隐再挂进 DOM，避免首帧从"可见"闪一下再淡出
    layout()
    document.body.appendChild(host)
    applyPosition()
  }

  // ---- 位置与缩放 -------------------------------------------------------------
  //
  // 只有一个可拖的东西：右侧竖条。竖条位置存「比例」（0~1，占可用高度的比例），
  // 所以窗口最大化 / 全屏 / 改大小时会按同一相对位置映射过去。
  //
  // 浮窗不记位置：它的位置永远由竖条推导出来 —— 在竖条左侧、垂直中心对齐。
  // 缩放 scale 随视口大小变化，且不带过渡动画（切全屏时是直接跳变，不飘）。

  var KEY_TAB = 'dsh-token-monitor:tab'
  var TAB_GAP = 10

  function currentScale() {
    var s = Math.min(window.innerWidth / 1440, window.innerHeight / 900)
    return clamp(s, 0.88, 1.15)
  }

  var scale = currentScale()

  function cardSize() {
    return { w: (CARD_W || 236) * scale, h: (card.offsetHeight || 96) * scale }
  }

  function tabSize() {
    return { w: 32 * scale, h: (tab.offsetHeight || 112) * scale }
  }

  var savedTab = readJson(KEY_TAB, null)
  var tabRatio = { ry: savedTab && typeof savedTab.ry === 'number' ? clamp(savedTab.ry, 0, 1) : 0.5 }

  function applyPosition() {
    scale = currentScale()
    card.style.setProperty('--tm-scale', String(scale))
    tab.style.setProperty('--tm-scale', String(scale))

    var vw = window.innerWidth
    var vh = window.innerHeight

    var t = tabSize()
    var c = cardSize()
    var tabSpan = Math.max(0, vh - t.h)

    // 锚点（竖条中心）取"竖条可见"与"浮窗可见"两个约束的交集，
    // 这样两者永远不会有谁先撞边导致的错位（拖动时就不会出现浮窗越拖越偏）。
    var minCenter = Math.max(t.h / 2, c.h / 2 + 4)
    var maxCenter = Math.min(vh - t.h / 2, vh - c.h / 2 - 4)
    if (maxCenter < minCenter) maxCenter = minCenter

    var tabCenter = clamp(tabRatio.ry * tabSpan + t.h / 2, minCenter, maxCenter)

    tab.style.top = tabCenter + 'px'

    var x = Math.max(4, vw - t.w - TAB_GAP - c.w)
    card.style.left = x + 'px'
    // 只给中心点，纵向居中交给 CSS 的 translateY(-50%)：
    // 明细展开/收缩时高度在变，但卡片始终以这个点为中心
    card.style.top = tabCenter + 'px'
  }

  // 拖完等布局稳定后重算一次（尺寸/高度可能刚变过）
  function scheduleReposition() {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(applyPosition)
    })
  }

  function layout() {
    var hidden = hiddenState === true
    // 用 class 控制显隐（opacity/transform 过渡），而不是 display:none
    card.style.display = ''
    card.classList.toggle('closed', hidden)
    // 竖条常驻：展开时它仍然贴在右侧，浮窗挂在它左边，拖动竖条浮窗跟着走
    tab.style.display = 'flex'
    // 浮窗打开时把竖条压暗，别抢阅读注意力；收起后恢复原样
    tab.classList.toggle('muted', !hidden)
    applyPosition()
  }

  function setHidden(value) {
    hiddenState = value === true
    layout()
  }

  close.addEventListener('click', function (event) {
    event.stopPropagation()
    card.classList.remove('expanded')
    window.clearTimeout(expandTimer)
    setHidden(true)
  })

  // ---- 拖动 -------------------------------------------------------------------
  //
  // 竖条和浮窗都能上下拖，但它们共用同一个锚点（tabRatio.ry）：
  // 拖哪个都是整组上下移动，这样两者永远保持垂直对齐。

  function startVerticalDrag(event, onTap) {
    if (event.button !== 0) return
    var startX = event.clientX
    var startY = event.clientY
    var originRy = tabRatio.ry
    var moved = false
    var target = event.currentTarget
    var captureId = null
    // 从浮窗上开始拖时锁住它的高度：拖动过程中鼠标可能离开/回到卡片，
    // 明细一旦收起展开，卡片高度就变，位置会跟着跳。锁住高度并强制展开明细。
    var lockedHeight = null
    if (target === card) {
      // 开始拖就立刻展开明细并锁高，拖动过程中不会因为悬停计时/移出而收起来
      card.classList.add('expanded')
      lockedHeight = card.offsetHeight
      card.style.height = lockedHeight + 'px'
    }

    function onMove(moveEvent) {
      var dx = moveEvent.clientX - startX
      var dy = moveEvent.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
      moved = true
      var t = tabSize()
      var span = Math.max(1, window.innerHeight - t.h)
      tabRatio.ry = clamp((originRy * span + dy) / span, 0, 1)
      applyPosition()
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      try {
        target.releasePointerCapture(captureId)
      } catch (e) {
        // ignore
      }
      target.classList.remove('dragging')
      if (lockedHeight != null) card.style.height = ''
      if (moved) {
        writeJson(KEY_TAB, { ry: tabRatio.ry })
        // 松手后按真实高度重新对齐一次
        scheduleReposition()
      } else if (onTap) {
        onTap()
      }
    }

    try {
      captureId = event.pointerId
      target.setPointerCapture(captureId)
    } catch (e) {
      captureId = null
    }
    target.classList.add('dragging')
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    event.preventDefault()
  }

  // 竖条：上下拖动改位置；单击（没拖动）切换浮窗开/关
  tab.addEventListener('pointerdown', function (event) {
    startVerticalDrag(event, function () {
      setHidden(!hiddenState)
    })
  })

  // 浮窗：同样上下拖动（整组一起动），点关闭按钮不触发拖动
  card.addEventListener('pointerdown', function (event) {
    if (event.target === close) return
    startVerticalDrag(event, null)
  })

  // 悬停要停留一小会儿才展开明细：鼠标只是快速划过时不会误触发。
  // 收起是立即的，不拖泥带水。
  var EXPAND_DELAY_MS = 320
  var expandTimer = null
  var inCloseZone = false

  function startExpandTimer() {
    window.clearTimeout(expandTimer)
    expandTimer = window.setTimeout(function () {
      card.classList.add('expanded')
    }, EXPAND_DELAY_MS)
  }

  // 关闭按钮所在的标题行（含一点余量）：鼠标停在这一横排上时不「新展开」明细，
  // 免得明细弹出来把 × 推开、反而点不准。
  // 注意：只拦"展开"，不碰已经展开的状态——用户已经展开后再去点 ×，
  // 浮窗必须保持原样，不能在要关的时候缩回去。
  function isInCloseZone(x, y) {
    var rect = head.getBoundingClientRect()
    var pad = 8
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad
  }

  card.addEventListener('mouseenter', function (event) {
    // 直接停在关闭区上方进入时就不启动计时
    if (isInCloseZone(event.clientX, event.clientY)) {
      inCloseZone = true
      window.clearTimeout(expandTimer)
      return
    }
    inCloseZone = false
    startExpandTimer()
  })

  card.addEventListener('mouseleave', function () {
    window.clearTimeout(expandTimer)
    expandTimer = null
    inCloseZone = false
    card.classList.remove('expanded')
  })

  card.addEventListener('mousemove', function (event) {
    var inside = isInCloseZone(event.clientX, event.clientY)
    if (inside === inCloseZone) return
    inCloseZone = inside
    if (inside) {
      // 进入关闭区：只取消"待展开"，已展开的保持不动
      window.clearTimeout(expandTimer)
    } else {
      // 离开关闭区但人还在浮窗上：重新开始计时
      startExpandTimer()
    }
  })

  // 明细展开/收起不需要额外对齐：卡片用 translateY(-50%) 以中心点定位，
  // 高度在动画中怎么变，纵向中心都咬住竖条。

  // ---- 轮询 -------------------------------------------------------------------

  var mounting = true
  var lastError = ''
  var lastDetected = null
  var renderedOnce = false
  var lastPayload = null

  function setDot(kind) {
    dot.className = 'dot' + (kind ? ' ' + kind : '')
  }

  function render(data) {
    if (!data || !data.ok) return
    lastPayload = data
    var balance = data.balance || {}
    var session = data.session || {}

    // 宿主下发的可调项（config.json）：单价 + 轮询间隔
    applyUiSettings(data.ui)
    if (data.ui && typeof data.ui.pollSeconds === 'number') {
      var wanted = clamp(data.ui.pollSeconds, 3, 3600) * 1000
      if (wanted !== pollMs) {
        pollMs = wanted
        schedulePoll()
      }
    }

    var wallet = pickWallet(balance.wallets)
    var mainValue = formatMoney(wallet)
    if (mainValue) {
      valBalance.textContent = mainValue
      valBalance.className = 'value'
    } else if (balance.status === 'signed-out') {
      valBalance.textContent = t('notSignedIn')
      valBalance.className = 'value dim'
    } else if (balance.status === 'failed' || balance.status === 'error') {
      valBalance.textContent = t('unavailable')
      valBalance.className = 'value dim'
    } else {
      valBalance.textContent = t('loading')
      valBalance.className = 'value dim'
    }

    var cost = costOf(session)
    if (session.measured) {
      valSession.textContent = cost == null ? '—' : '≈' + formatCost(cost)
      valSession.className = cost == null ? 'value dim' : 'value'
      subSession.textContent = formatTokens(session.total) + ' tok'
    } else if (session.tracked === false) {
      valSession.textContent = '—'
      valSession.className = 'value dim'
      subSession.textContent = ''
    } else {
      valSession.textContent = t('waiting')
      valSession.className = 'value dim'
      subSession.textContent = ''
    }

    if (balance.status === 'ready') setDot(balance.stale ? 'warn' : 'ok')
    else if (balance.status === 'signed-out' || balance.status === 'unavailable') setDot('warn')
    else if (balance.status === 'failed' || balance.status === 'error') setDot('bad')

    // 收起态竖条上同步显示余额，并给同样的状态色
    tabValue.textContent = mainValue || (balance.status === 'signed-out' ? t('notSignedIn') : '¥ --')
    tabDot.className = dot.className
    tab.title = cost == null ? t('expand') : t('expandWithCost', { cost: formatCost(cost) })

    setKv('bonus', formatMoney(pickWallet(balance.bonusWallets)))
    setKv('tokens', session.measured ? formatTokens(session.total) + ' tok' : null)
    setKv('calls', session.measured && session.calls ? t('times', { n: session.calls }) : null)
    setKv('context', session.measured && session.context ? formatTokens(session.context) + ' tok' : null)
    var searchCount = Number(session.searches) || 0
    var fetchCount = Number(session.fetches) || 0
    setKv(
      'tools',
      session.measured && (searchCount > 0 || fetchCount > 0)
        ? t('searched', { n: searchCount, m: fetchCount }) + (toolBillingStarted() ? '' : t('freeUntil'))
        : null,
    )
    setKv(
      'model',
      session.model
        ? t('modelLine', { model: session.model, tier: isPeakNow() ? t('peak') : t('idle') })
        : null,
    )
    setKv('updated', formatClock(balance.updatedAt))
    setKv(
      'session',
      boot.debug
        ? (lastDetected && lastDetected.id ? String(lastDetected.id).slice(0, 14) : t('unknownSession'))
        : null,
    )

    // 标题常被省略号截断，悬停用原生 tooltip 显示全称 + session id
    var fullTitle = session.title || ''
    title.textContent = fullTitle || 'Token Monitor'
    title.title = fullTitle
      ? fullTitle + (session.id ? '\n' + session.id : '')
      : (session.id || 'Token Monitor')

    // 其余被省略号截断的文本，同样用 tooltip 兜底显示全量
    syncTooltip(valBalance)
    syncTooltip(valSession)
    syncTooltip(subSession)
    for (var key in kvRows) {
      if (!Object.prototype.hasOwnProperty.call(kvRows, key)) continue
      var cell = kvRows[key]
      if (cell.row.style.display === 'none') continue
      syncTooltip(cell.value)
    }
  }

  function authHeaders(extra) {
    var headers = extra || {}
    if (boot.token) headers['x-dsh-token-monitor'] = boot.token
    return headers
  }

  function tick() {
    // 每轮顺带对齐一次语言（不变时是空操作）：MutationObserver 漏了也能收敛
    if (document.documentElement && document.documentElement.lang) {
      applyLanguage(document.documentElement.lang)
    }
    var detected = detectSession()
    lastDetected = detected
    var query = []
    if (detected && detected.id) query.push('s=' + encodeURIComponent(detected.id))
    // 即使抓不到 id 也要把选中行的文字发上去，宿主用它反查会话
    if (detected && detected.title) query.push('t=' + encodeURIComponent(detected.title))
    var url = boot.route + (query.length ? '?' + query.join('&') : '')
    fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: authHeaders(),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('http ' + response.status)
        return response.json()
      })
      .then(function (data) {
        lastError = ''
        renderedOnce = true
        render(data)
      })
      .catch(function (error) {
        lastError = String((error && error.message) || error)
        if (!renderedOnce && snapshot) {
          // 路由不可达时退回注入时的快照，至少不是空白窗
          renderedOnce = true
          render(snapshot)
          extra.textContent = t('offlineSnapshot', { err: lastError })
          setDot('warn')
          return
        }
        setDot('bad')
        valBalance.textContent = t('offline')
        valBalance.className = 'value dim'
      })
  }

  function probe() {
    if (!boot.debug || !boot.probe) return
    var payload = {
      href: String(location.href),
      title: String(document.title || ''),
      detected: detectSession(),
      dataAttrs: sampleAttributeNames(),
      lastError: lastError,
    }
    try {
      fetch(boot.probe, {
        method: 'POST',
        cache: 'no-store',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      }).catch(function () {})
    } catch (e) {
      // ignore
    }
  }

  // ---- 启动 -------------------------------------------------------------------

  // 用 setTimeout 自循环而不是 setInterval：宿主下发的 pollSeconds 变了，
  // 下一次排期直接按新间隔走，不用清定时器再重建。
  var pollMs = clamp(POLL_MS, 3000, 3600000)
  var pollTimer = null

  function schedulePoll() {
    if (pollTimer) window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(function () {
      tick()
      schedulePoll()
    }, pollMs)
  }

  window.addEventListener('resize', applyPosition)
  window.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick()
  })

  // 切换会话要立刻刷新：盯住侧边栏选中态的变化，一变就拉一次，不用等 10s 轮询。
  // 用变化签名做对比（选中行文字 + 属性里的 session id），避免 class 抖动造成误触发。
  var lastSelection = ''
  var lastSelectionCheck = 0

  function selectedSignature() {
    var row = selectedRow()
    if (!row) return ''
    var id = ''
    for (var i = 0; i < SESSION_ATTRS.length; i++) {
      var value = row.getAttribute ? row.getAttribute(SESSION_ATTRS[i]) : ''
      if (value) {
        id = value
        break
      }
    }
    return rowText(row) + '|' + id
  }

  function watchSelection() {
    lastSelection = selectedSignature()
    if (!window.MutationObserver) return
    var observer = new MutationObserver(function () {
      var now = Date.now()
      if (now - lastSelectionCheck < 150) return
      lastSelectionCheck = now
      var signature = selectedSignature()
      if (signature === lastSelection) return
      lastSelection = signature
      window.requestAnimationFrame(tick)
    })
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'data-selected', 'aria-current', 'class'],
    })
  }

  // ---- 语言切换 ---------------------------------------------------------------

  // 只在文案上换语言，不重新挂载：位置、显隐、拖动状态全部保留
  function applyLanguage(next) {
    var normalized = normalizeLang(next)
    if (!normalized || normalized === lang) return
    lang = normalized
    lblBalance.textContent = t('balance')
    lblSession.textContent = t('session')
    close.title = t('closeTip')
    tab.title = t('expand')
    for (var key in kvRows) {
      if (!Object.prototype.hasOwnProperty.call(kvRows, key)) continue
      kvRows[key].label.textContent = t(kvRows[key].labelKey)
    }
    // 就地用上一份数据重渲染，不再发请求（也避免 tick → applyLanguage 的递归）
    if (lastPayload) render(lastPayload)
  }

  window.addEventListener('dsh-token-monitor:locale', function (event) {
    applyLanguage(event && event.detail)
  })

  // 最可靠的语言信号：应用切语言时 <html lang> 会变。盯它，
  // 即使 locale 服务的快照字段和我猜的不一样也能跟上。
  function watchDocumentLang() {
    if (!window.MutationObserver || !document.documentElement) return
    var observer = new MutationObserver(function () {
      applyLanguage(document.documentElement.lang)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'dir'] })
  }

  mount()
  watchSelection()
  watchDocumentLang()
  tick()
  window.setTimeout(probe, 1500)
  schedulePoll()
})()
