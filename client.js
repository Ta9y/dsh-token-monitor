// dsh-token-monitor —— 客户端插件（DSH 的 client module 格式）
//
// 桌面版的窗口跑在 dsh-app://app/ 上，index.html 是主进程直接从磁盘读的，
// 不走 host 的 webServer.tapIndex，所以注入那条路在桌面端无效。
// 真正的接法是这个 client module：host 的 client-modules 服务扫描 loader 条目里
// 声明了 dsh.client 的包，把 ./client 这个 bundle 以 /plugins/<id>/client.js 供给页面。
//
// 职责只有两件事：
//   1. 把真正干活的 ui.js 以同源脚本挂进页面；
//   2. 把应用当前语言告诉 ui.js，并在应用里切换语言时通知它。
// dsh-app://app/dsh-token-monitor/ui.js 会被主进程的协议处理器转发给 host 的 webserver。
window.__ModuleLoader__.load({
  id: 'dsh-token-monitor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var SCRIPT_FLAG = 'data-dsh-token-monitor'
    var UI_URL = '/dsh-token-monitor/ui.js'
    var LOCALE_EVENT = 'dsh-token-monitor:locale'

    // 从 locale 服务快照里尽量稳地抠出语言标识
    function readLocaleId(snapshot) {
      if (snapshot == null) return ''
      if (typeof snapshot === 'string') return snapshot
      var candidates = [snapshot.id, snapshot.locale, snapshot.current, snapshot.language, snapshot.value]
      for (var i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] === 'string' && candidates[i]) return candidates[i]
      }
      if (snapshot.preference && typeof snapshot.preference.id === 'string') return snapshot.preference.id
      return ''
    }

    function apply(ctx) {
      var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      var localeId = ''
      try {
        var snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
        if (snapshot == null && locale && typeof locale.getLocale === 'function') snapshot = locale.getLocale()
        localeId = readLocaleId(snapshot)
      } catch (e) {
        localeId = ''
      }

      // 先把语言订阅装好（即使脚本已存在也要能收到切换事件），再决定是否注入脚本
      if (locale && typeof locale.subscribe === 'function') {
        ctx.effect(() =>
          locale.subscribe(function () {
            var next = ''
            try {
              var snap = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
              next = readLocaleId(snap)
            } catch (e) {
              next = ''
            }
            if (!next) return
            window.__DSH_TOKEN_MONITOR_LOCALE__ = next
            window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: next }))
          }),
        )
      }

      if (document.querySelector('script[' + SCRIPT_FLAG + ']')) return
      var script = document.createElement('script')
      script.src = UI_URL + (localeId ? '?lang=' + encodeURIComponent(localeId) : '')
      script.setAttribute(SCRIPT_FLAG, 'ui')
      script.async = false
      ;(document.body || document.head || document.documentElement).appendChild(script)
    }

    var inject = []

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
