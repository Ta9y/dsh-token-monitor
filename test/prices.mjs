// 用真实的官方价目页验证 parsePrices：抓一次 → 解析 → 打印结果
// 运行：node test/prices.mjs
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..')
const plugin = await import(pathToFileURL(path.join(PKG, 'index.js')).href)

const URL_SRC = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const response = await fetch(URL_SRC, {
  headers: { 'user-agent': 'dsh-token-monitor-test/1.0' },
  signal: AbortSignal.timeout(20000),
})
console.log('http:', response.status)
const html = await response.text()
console.log('html bytes:', html.length)

const prices = plugin.parsePrices(html)
if (!prices) {
  console.log('PARSE FAILED — 需要重新校准解析规则')
  process.exitCode = 1
} else {
  console.log(JSON.stringify(prices, null, 2))
  const flash = prices['deepseek-flash']
  const pro = prices['deepseek-v4-pro']
  if (!flash || !pro) {
    console.log('MISSING MODEL')
    process.exitCode = 1
  } else if (flash.peak.cacheMiss !== flash.offpeak.cacheMiss * 2) {
    console.log('PEAK/OFFPEAK RATIO WRONG')
    process.exitCode = 1
  } else {
    console.log('prices: OK')
  }
}
