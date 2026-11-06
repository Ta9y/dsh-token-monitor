// 任务级汇总的回归测试：主会话 + 子智能体 + 队友，以及"子会话销毁后成绩不丢"。
// 用假 ctx / 假 Session，不依赖 cordis 运行时。运行：node test/rollup.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 工作区（test/ 在仓库根）和发布快照（test/ 在包内）两种布局都支持
const PARENT = path.join(HERE, '..')
const PKG = fs.existsSync(path.join(PARENT, 'package.json')) ? PARENT : path.join(PARENT, 'dsh-token-monitor')

function usageEvents(list) {
  return list.map((usage) => ({ type: 'assistant/message', time: Date.UTC(2026, 9, 20, 2, 0, 0), data: { usage } }))
}

function makeSession(id, header, events) {
  return {
    id,
    seq: events.length,
    header: { id, createdAt: Date.UTC(2026, 9, 20), ...header },
    requestContext: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    ownEvents: () => events,
  }
}

const mainSession = makeSession(
  'session-main',
  {},
  usageEvents([{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }]),
)
const childSession = makeSession(
  'session-child',
  { parentSession: 'session-main', origin: 'subagent' },
  usageEvents([
    { inputTokens: 120, outputTokens: 30 },
    { inputTokens: 100, outputTokens: 50 },
  ]),
)

let live = [mainSession, childSession]

const services = {
  deepseekAccount: {
    async getBalance() {
      return { status: 'ready', value: [{ currency: 'CNY', balance: '5.00' }], bonusWallets: [] }
    },
  },
  sessions: {
    get: (id) => live.find((session) => session.id === id),
    list: () => live,
  },
  tokenMeter: { measure: () => ({ totalTokens: 1234 }) },
  sessionTitle: {
    get(session) {
      return session.id === 'session-main' ? { title: '主任务' } : { title: '子任务' }
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
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  on(name, listener) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(listener)
    return () => {}
  },
  effect(callback) {
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
plugin.apply(ctx, { intervalSeconds: 60, debug: false })
await new Promise((resolve) => setTimeout(resolve, 30))

function fakeReq(url) {
  const req = new EventEmitter()
  req.url = url
  req.headers = { host: '127.0.0.1:19387' }
  req.method = 'GET'
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      res.status = status
      return res
    },
    end(chunk) {
      if (chunk) res.body += chunk
    },
  }
  return res
}

const html = taps[0]('<html><body></body></html>')
const token = html.match(/\?t=([0-9a-f]+)/)[1]
const stateRoute = routes.get('/dsh-token-monitor/state')

async function readState(query) {
  const res = fakeRes()
  await stateRoute.handler(fakeReq('/dsh-token-monitor/state' + (query || '')), res)
  return JSON.parse(res.body)
}

// 1) 主会话 + 子智能体一起汇总
{
  const data = await readState('?s=session-main&t=%E4%B8%BB%E4%BB%BB%E5%8A%A1')
  assert.equal(data.session.id, 'session-main')
  assert.equal(data.session.model, 'deepseek-flash')
  assert.equal(data.session.calls, 3, '主 1 次 + 子 2 次')
  assert.equal(data.session.total, 150 + 300, '合计包含子智能体的 token')
  assert.equal(data.session.parts.main.total, 150)
  assert.equal(data.session.parts.subagents.total, 300)
  assert.equal(data.session.counts.subagents, 1)
  assert.equal(data.session.parts.teammates, null, '没有团队时不出现队友分项')
  assert.equal(data.session.title, '主任务', '标题来自 sessionTitle')
  assert.equal(data.session.context, 1234, '上下文仍取主会话')
}

// 2) 子会话被销毁后，成绩仍然计入
{
  for (const listener of listeners.get('session/disposed') || []) listener(childSession)
  live = [mainSession]
  const data = await readState('?s=session-main')
  assert.equal(data.session.parts.subagents.total, 300, '销毁后仍保留子任务用量')
  assert.equal(data.session.total, 450)
}

// 3) 切换到子会话时，只统计它自己（没有自己的子会话）
{
  live = [mainSession, childSession]
  const data = await readState('?s=session-child')
  assert.equal(data.session.id, 'session-child')
  assert.equal(data.session.total, 300)
  assert.equal(data.session.parts.subagents, null)
}

// 4) 队友本质上也是 Lead 的子会话：它计入「子任务」的总数和金额，
//    同时单独拆出一块给页面缩进展示，但合计只算一次。
{
  const teamSession = makeSession(
    'session-team',
    { parentSession: 'session-main', origin: 'subagent' },
    usageEvents([{ inputTokens: 30, outputTokens: 20 }]),
  )
  live = [mainSession, childSession, teamSession]
  services.agents = { list: () => [{ id: 'session-main' }] }
  services.agentTeams = {
    tryMembership: () => ({ role: 'lead', root: { id: 'session-main' }, id: 'team-1', name: 'lead' }),
    listMembers: () => [
      { id: 'session-main', role: 'lead', name: 'lead', status: 'running' },
      { id: 'session-team', role: 'teammate', name: 't1', status: 'inactive' },
    ],
  }

  const data = await readState('?s=session-main')
  assert.equal(data.session.counts.subagents, 2, '子任务 = 所有子会话（子智能体 + 队友）')
  assert.equal(data.session.counts.teammates, 1)
  assert.equal(data.session.parts.subagents.total, 300 + 50, '子任务的金额也含队友')
  assert.equal(data.session.parts.teammates.total, 50, '队友是其中的拆解块')
  assert.equal(data.session.total, 150 + 300 + 50, '合计只算一次，不重复')
}

// 5) 进程重启后：子会话已经不在 store 里（store 里只剩主会话），
//    只能靠 ctx.sessionQuery 的持久化谱系 + 会话日志把"子任务"补回来。
{
  live = [mainSession]
  const coldId = 'session-cold'
  const coldEvents = usageEvents([{ inputTokens: 40, outputTokens: 10, totalTokens: 50 }])

  services.sessionQuery = {
    async traceSession(rootId) {
      assert.equal(rootId, 'session-main', '按当前会话读谱系')
      return {
        target: { header: { id: 'session-main' }, live: true, persisted: true },
        ancestors: [],
        descendants: [
          {
            session: { header: { id: coldId, parentSession: 'session-main', origin: 'subagent' } },
            descendants: [],
          },
        ],
        complete: true,
        root: { header: { id: 'session-main' } },
      }
    },
    async readSession(id) {
      if (id !== coldId) throw new Error('unexpected session ' + id)
      return {
        session: { id: coldId, parentSession: 'session-main', origin: 'subagent' },
        inheritedEventCount: 0,
        events: coldEvents,
      }
    },
  }

  const data = await readState('?s=session-main')
  assert.equal(data.session.diag.corpus, 'trace', '谱系来自 sessionQuery')
  assert.equal(data.session.counts.subagents, 2, '销毁的子会话 + 磁盘上的冷子会话')
  assert.equal(data.session.parts.subagents.total, 300 + 50, '冷会话的用量从日志补回来')
  assert.equal(data.session.total, 150 + 300 + 50)
}

console.log('rollup: all assertions passed')
