// 冒烟测试：用假的 ctx / req / res 跑一遍 host 半的注册与响应，
// 不依赖 cordis 运行时。运行：node test/smoke.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..')

const usageEvents = [
  { type: 'user/message', data: { text: 'hi' } },
  { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } },
  { type: 'assistant/message', data: { usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 250 } } },
  { type: 'assistant/message', data: {} },
]

const session = {
  seq: 4,
  header: { createdAt: 1700000000000 },
  ownEvents: () => usageEvents,
}

const services = {
  deepseekAccount: {
    async getBalance() {
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '12.34' }],
        bonusWallets: [{ currency: 'CNY', balance: '1.50' }],
      }
    },
  },
  sessions: {
    get(id) {
      return id === 'sess-1' ? session : undefined
    },
  },
  tokenMeter: {
    measure() {
      return { totalTokens: 3210 }
    },
  },
}

const routes = new Map()
const taps = []
const listeners = new Map()
const effects = []

const ctx = {
  webServer: {
    register(route) {
      assert.ok(!routes.has(route.path), 'duplicate route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  on(name, listener) {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  },
  effect(callback) {
    // 模拟 cordis 的 effect：立刻执行，返回值就是 disposer
    const disposer = callback()
    effects.push(disposer)
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  get(name) {
    return services[name]
  },
}

const plugin = await import(pathToFileURL(path.join(PKG, 'index.js')).href)
assert.equal(plugin.name, 'dsh-token-monitor')
assert.deepEqual(plugin.inject, ['webServer'])
assert.equal(typeof plugin.apply, 'function')

plugin.apply(ctx, { intervalSeconds: 60, debug: false })

await new Promise((resolve) => setTimeout(resolve, 30))

assert.ok(routes.has('/dsh-token-monitor/state'), 'state route registered')
assert.ok(routes.has('/dsh-token-monitor/probe'), 'probe route registered')
assert.ok(routes.has('/dsh-token-monitor/ui.js'), 'ui route registered')

function fakeReq(url, headers = {}) {
  const req = new EventEmitter()
  req.url = url
  req.headers = { host: '127.0.0.1:19387', ...headers }
  req.method = 'GET'
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
      return res
    },
    end(chunk) {
      if (chunk) res.body += chunk
    },
  }
  return res
}

const stateRoute = routes.get('/dsh-token-monitor/state')

// 1) 跨站 Origin → 403（挡住网页对 localhost 的 CSRF 读取）
{
  const res = fakeRes()
  stateRoute.handler(fakeReq('/dsh-token-monitor/state', { origin: 'https://evil.example' }), res)
  assert.equal(res.status, 403)
}

// 1b) 桌面端渲染进程（Origin: dsh-app://app，没有令牌）→ 放行
{
  const res = fakeRes()
  stateRoute.handler(fakeReq('/dsh-token-monitor/state', { origin: 'dsh-app://app' }), res)
  assert.equal(res.status, 200)
}

// 1c) 同源/本地请求（无 Origin）→ 放行
{
  const res = fakeRes()
  stateRoute.handler(fakeReq('/dsh-token-monitor/state'), res)
  assert.equal(res.status, 200)
}

// 令牌只存在于注入的页面里，从 taps 输出的 script src 里取回来
const html = taps[0]('<html><head></head><body><div id="app"></div></body></html>')
assert.ok(html.includes('data-dsh-token-monitor="ui"'), 'injects script tag')
assert.ok(html.includes('src="/dsh-token-monitor/ui.js?t='), 'uses a same-origin external script (CSP-safe)')
assert.ok(html.indexOf('</script>') < html.indexOf('</body>'), 'script lands before </body>')
assert.equal((html.match(/<\/script>/g) || []).length, 1, 'exactly one script tag injected')
assert.ok(!html.includes('__DSH_TOKEN_MONITOR__ ='), 'no inline boot object anymore')

const tokenMatch = html.match(/\?t=([0-9a-f]+)/)
assert.ok(tokenMatch, 'token embedded in the script src')
const token = tokenMatch[1]

// 2) 有令牌 → 200 且带余额与 token 消耗
{
  const res = fakeRes()
  stateRoute.handler(
    fakeReq('/dsh-token-monitor/state?s=sess-1&t=%E4%BB%BB%E5%8A%A1A', { 'x-dsh-token-monitor': token }),
    res,
  )
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.balance.status, 'ready')
  assert.equal(data.balance.wallets[0].balance, '12.34')
  assert.equal(data.session.id, 'sess-1')
  assert.equal(data.session.live, true)
  assert.equal(data.session.calls, 2, 'only events carrying usage count')
  assert.equal(data.session.total, 120 + 340, 'total falls back to input+output')
  assert.equal(data.session.context, 3210)
  assert.equal(data.session.title, '任务A')
}

// 3) 页面报了宿主不认识的 session → 仍 200，但 tracked=false
{
  const res = fakeRes()
  stateRoute.handler(fakeReq('/dsh-token-monitor/state?s=ghost', { 'x-dsh-token-monitor': token }), res)
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.session.live, false)
  assert.equal(data.session.tracked, false)
}

// 4) 令牌正确时，即使带跨站 Origin 也放行（令牌本身就是凭证）
{
  const res = fakeRes()
  stateRoute.handler(
    fakeReq('/dsh-token-monitor/state', { 'x-dsh-token-monitor': token, origin: 'https://evil.example' }),
    res,
  )
  assert.equal(res.status, 200)
}

// 4b) 令牌错误 + 跨站 Origin → 403
{
  const res = fakeRes()
  stateRoute.handler(
    fakeReq('/dsh-token-monitor/state', { 'x-dsh-token-monitor': 'deadbeef', origin: 'https://evil.example' }),
    res,
  )
  assert.equal(res.status, 403)
}

// 5) ui.js 路由可用
{
  const res = fakeRes()
  routes.get('/dsh-token-monitor/ui.js').handler(fakeReq('/dsh-token-monitor/ui.js'), res)
  assert.equal(res.status, 200)
  assert.ok(res.body.length > 1000)
  assert.ok(res.headers['content-type'].includes('javascript'))
}

// 6) session/event 监听把活动 session 记为兜底
{
  const listener = listeners.get('session/event')
  assert.equal(typeof listener, 'function')
  listener({ id: 'sess-1', header: {} }, { type: 'turn/start' })
  const res = fakeRes()
  stateRoute.handler(fakeReq('/dsh-token-monitor/state', { 'x-dsh-token-monitor': token }), res)
  const data = JSON.parse(res.body)
  assert.equal(data.session.id, 'sess-1', 'falls back to last active session')
}

const uiSource = fs.readFileSync(path.join(PKG, 'ui.js'), 'utf8')
assert.ok(!uiSource.includes('</script'), 'ui.js must not contain a closing script tag literal')

console.log('smoke: all assertions passed')
