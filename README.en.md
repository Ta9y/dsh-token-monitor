# dsh-token-monitor

**English** · [简体中文](README.md)

**The whole plugin except this sentence was genetated by DeepSeek Harness**

A floating monitor for DeepSeek Harness: your **account balance**, the **tokens this conversation has consumed**, and the **estimated cost** of the conversation at DeepSeek's official rates.

A slim tab docked to the right edge of the window, expanding into a small card. Draggable, collapsible, out of the way while you read.

```
┌──────────────────────┐ ┌──┐
│ ● Your chat title  × │ │¥ │
│ Balance     ¥25.87   │ │25│
│ This chat  ≈¥0.42 25.4M│ │.8│
└──────────────────────┘ └──┘
        hover to expand ↑
```

## Features

- **Balance** — read through DeepSeek's account service; hover to see the bonus wallet
- **Conversation usage** — sums `usage` over every model call in the session
- **Conversation cost** — estimated from the official price list, per model and per **peak / off-peak** window
- **Search / Fetch billing** — counts `web_search` / `web_fetch` calls at the official ¥5 per 1,000
  (DeepSeek states these are **free until 2026-11-01 00:00**; the plugin only bills them from that date on)
- **Monthly price refresh** — scraped from the official page, cached for 30 days, old values kept on failure
- **Follows the active conversation** — switching chats refreshes immediately
- **Follows the app language** — Simplified Chinese / English, switched live
- **Draggable** — drag the tab or the card; they stay vertically aligned, position stored as a viewport ratio
- **Unobtrusive** — details appear after a 320 ms hover; hovering the close row never expands them

## Install

The plugin is a standard DSH bundle with both a host half (`index.js`) and a client half (`client.js`).

### A. From npm

```bash
dsh plugin install dsh-token-monitor
```

Or through the UI: **Settings → Plugins → Install**, enter `dsh-token-monitor`.

### B. Straight from GitHub

```bash
dsh plugin install github:Ta9y/dsh-token-monitor
```

### C. Manually (handy while developing)

```powershell
cd $HOME\.dsh\profiles\desktop
pnpm add file:C:/path/to/dsh-token-monitor
```

Then add `dsh-token-monitor` to the `dsh.profile.bundles` array in that directory's `package.json` and restart DSH.

> After installing you must **restart the DSH process once**: the host half is ESM-based and cached, so reloading the plugin will not re-execute it. After that, editing `ui.js` / `config.json` only needs a page refresh.

## Configuration

`config.json` (next to the plugin, takes effect on page refresh — no restart):

```json
{
  "pollSeconds": 10,
  "balanceSeconds": 60,
  "autoPrices": true,
  "searchPer1000": 5,
  "fetchPer1000": 5,
  "searchBillingFrom": "2026-11-01",
  "prices": {
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

Prices are CNY per million tokens. Peak = Beijing time, weekdays 09:00–12:00 and 14:00–18:00; everything else (weekends included) is half price.

## How the cost is estimated

- The model is read from the session's `requestContext()`, falling back to `deepseek-flash`
- **Each call is priced at the window it happened in**: usage is bucketed into peak / off-peak by event time
- Search / Fetch are billed per request, separately from tokens
- Chinese public holidays are not modelled, so the result is an **estimate**, not an invoice

Prices come from the [official DeepSeek pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/),
scraped monthly into `prices.auto.json` (with `fetchedAt`); a failed scrape keeps the previous values.

## Privacy

- **Never reads** your login token or API keys
- Balance comes from DSH's own account service (`ctx.deepseekAccount.getBalance()`)
- **No third-party requests**; the only outbound call is the monthly price-page fetch
- Data lives in process memory plus `localStorage` (tab position only)
- Files written locally: `debug.log` (diagnostics, safe to delete), `token.txt` (page token), `prices.auto.json` (price cache)

## Compatibility

- Requires DSH 0.2.x (`@deepseek-ai/dsh-base` + `dsh-web-app` composition)
- Desktop uses the `dsh.client` module path; plain browser mode (`dsh web`) uses index injection
- Only tested on Windows with the `desktop` profile

## Known limitations

- Counts the **main session only**; subagent spend is not included
- The session must be live in Host memory; cold sessions show `—`
- Holiday-aware peak detection is not implemented

## Development

```
index.js            host half: balance, usage folding, HTTP routes, price scraping
client.js           client module: mounts ui.js, bridges the app locale
ui.js               the widget itself: plain DOM + Shadow DOM, no build, no deps
cordis.patch.yml    bundle layer: inserts the plugin row
config.json         default configuration
test/smoke.mjs      regression test with a fake ctx (npm test)
test/prices.mjs     validates the price parser against the live page
```

Two pitfalls worth knowing:

1. **Inserting a row in a bundle patch requires `insert:`.** `- id: xxx` means "override an existing entry";
   when nothing matches it prints `patch: entry "xxx" not found` and is **silently skipped**.
2. **Route/injection registration must be wrapped in `ctx.effect()`**, otherwise a hot reload leaves the old
   routes registered and the new instance throws `duplicate route`, aborting `apply` halfway.

## Publishing

```bash
cd dsh-token-monitor
git init
git add .
git commit -m "feat: dsh-token-monitor 1.0.0"
git branch -M main
git remote add origin https://github.com/Ta9y/dsh-token-monitor.git
git push -u origin main
```

Change `repository` / `homepage` / `bugs` in `package.json` if you publish under a different repo.

Remember to set **Topics** (the gear next to About on the repo page):

```
dsh-plugin  dsh  deepseek-harness  deepseek  plugin  token  cost  balance
```

`dsh-plugin` is the primary tag people browse DSH plugins by.

## License

[MIT](LICENSE)
