// 抓網站頁面、解析影片的播放 / 下載網址（主程序）
// 一般請求走 session.fetch；遇到 Cloudflare 驗證頁就改用隱藏視窗載入真的網頁，過關後 cookie 留著，之後 fetch 就能直接用。
const { app, BrowserWindow, session } = require('electron')
const fs = require('original-fs')
const path = require('path')

// 站名、網址、影片 CDN 只用 Base64 存，原始碼裡不出現明文；網址可在設定頁改成鏡像站
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8')
const SITES = {
  rv: { label: b64('UjM0VmlkZW8='), base: b64('aHR0cHM6Ly9ydWxlMzR2aWRlby5jb20='), cdn: [] },
  h1: { label: b64('SGFuaW1lMQ=='), base: b64('aHR0cHM6Ly9oYW5pbWUxLm1l'), cdn: [b64('aGVtYmVkLmNvbQ==')] },
}
const KEYS = Object.keys(SITES)
const cfgFile = () => path.join(app.getPath('userData'), 'site.json')
let bases = {}
let ua = ''

function init(userAgent) {
  ua = userAgent
  try {
    const c = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'))
    // 舊版只有一個站：{ base }
    if (c.base) c.rv = c.base
    for (const k of KEYS) if (/^https?:\/\/[^/]+$/.test(c[k] || '')) bases[k] = c[k]
  } catch {}
}

const check = (site) => {
  if (!SITES[site]) throw new Error(`未知的來源：${site}`)
  return site
}
const base = (site) => bases[check(site)] || SITES[site].base

function config() {
  const out = {}
  for (const k of KEYS) out[k] = { label: SITES[k].label, base: base(k), defaultBase: SITES[k].base }
  return out
}

function setBase(site, b) {
  check(site)
  b = String(b || '').trim().replace(/\/+$/, '')
  if (!b || b === SITES[site].base) delete bases[site]
  else if (!/^https?:\/\/[^/]+$/.test(b)) throw new Error('網址格式不正確，例如 https://example.com')
  else bases[site] = b
  try {
    fs.writeFileSync(cfgFile(), JSON.stringify(bases))
  } catch {}
  return config()
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}
const sameOrSub = (h, d) => h === d || h.endsWith('.' + d)

/** 網址屬於哪個站（含它的圖片 / 影片 CDN），縮圖和影片要補對應的 Referer */
function siteForUrl(u) {
  const h = hostOf(u)
  if (!h) return null
  for (const k of KEYS) {
    if (sameOrSub(h, hostOf(base(k))) || SITES[k].cdn.some((d) => sameOrSub(h, d))) return k
  }
  return null
}

const abs = (site, u) => (!u ? '' : /^https?:/.test(u) ? u : base(site) + (u.startsWith('/') ? '' : '/') + u)

// ---------- 過 Cloudflare 用的隱藏視窗 ----------

const isChallenge = (status, text) => (status === 403 || status === 503) && /challenge-platform|Just a moment|cf-chl|Attention Required/i.test(text)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let worker = null
let queue = Promise.resolve()

function getWorker() {
  if (!worker || worker.isDestroyed()) {
    worker = new BrowserWindow({ show: false, width: 1000, height: 760, title: '請完成網站驗證', autoHideMenuBar: true, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
    worker.removeMenu()
    worker.webContents.setAudioMuted(true)
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 使用者關掉驗證視窗只是藏起來，等待中的請求會收到錯誤
    worker.on('close', (e) => {
      if (app.isQuitting) return
      e.preventDefault()
      worker.hide()
      worker.giveUp = true
    })
  }
  return worker
}
app.on('before-quit', () => {
  app.isQuitting = true
})

/** 用隱藏視窗載入網頁拿 HTML；15 秒還在驗證頁就把視窗顯示出來讓使用者手動驗證 */
function loadViaWindow(url) {
  const run = async () => {
    const w = getWorker()
    w.giveUp = false
    w.loadURL(url).catch(() => {})
    const start = Date.now()
    while (Date.now() - start < 120000) {
      await sleep(600)
      if (w.isDestroyed()) break
      if (w.giveUp) throw new Error('驗證視窗被關閉了')
      let info
      try {
        info = await w.webContents.executeJavaScript('({ title: document.title, ready: document.readyState, html: document.documentElement.outerHTML })')
      } catch {
        continue
      }
      const challenged = /Just a moment|請稍候|Attention Required|cf-chl|challenge-platform/i.test(info.title + info.html.slice(0, 4000))
      if (!challenged && info.ready !== 'loading') {
        if (w.isVisible()) w.hide()
        // 網頁會一直跑廣告腳本，拿到內容就換成空白頁
        w.loadURL('about:blank').catch(() => {})
        return info.html
      }
      if (challenged && Date.now() - start > 15000 && !w.isVisible()) w.show()
    }
    if (!w.isDestroyed()) w.hide()
    throw new Error('網站驗證逾時，請稍後再試')
  }
  const p = queue.catch(() => {}).then(run)
  queue = p
  return p
}

async function get(site, url) {
  const full = abs(site, url)
  let res
  try {
    res = await session.defaultSession.fetch(full, { headers: { 'User-Agent': ua, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8', Referer: base(site) + '/' } })
  } catch (e) {
    const msg = e.message || String(e)
    throw new Error(/net::ERR_/.test(msg) ? `連不上網站（網路中斷或網站被擋，${msg.replace(/^.*net::/, '')}）` : msg)
  }
  const text = await res.text()
  if (isChallenge(res.status, text)) return loadViaWindow(full)
  if (res.status === 404) throw new Error('找不到這個頁面（影片可能已被刪除）')
  if (!res.ok) throw new Error(`網站回應 HTTP ${res.status}`)
  return text
}

// ---------- 播放 / 下載網址 ----------

const unesc = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/**
 * rv：影片頁裡播放器的 flashvars 有各畫質的網址（video_url、video_alt_url、video_alt_url2…），
 * 下載選單另外列了檔案大小。
 */
function parseRv(html) {
  const m = html.match(/var flashvars = \{([\s\S]*?)\};/)
  if (!m) throw new Error('這部影片沒有可播放的檔案（可能需要登入或已被移除）')
  const fv = {}
  for (const x of m[1].matchAll(/([a-z0-9_]+):\s*'((?:[^'\\]|\\.)*)'/g)) fv[x[1]] = unesc(x[2])
  const sizes = {}
  for (const x of html.matchAll(/href="([^"]*_(\d+p?|preview)\.mp4\/[^"]*download=true[^"]*)"[^>]*>[\s\S]*?<\/svg>\s*MP4 ([^<]+)<span class="vp-sheet__meta">([^<]*)</g)) {
    sizes[x[3].trim().toLowerCase()] = x[4].trim()
  }
  const list = []
  for (const k of ['video_url', 'video_alt_url', 'video_alt_url2', 'video_alt_url3', 'video_alt_url4', 'video_alt_url5', 'video_alt_url6']) {
    if (!fv[k] || !/^https?:/.test(fv[k])) continue
    const label = fv[k + '_text'] || ''
    const height = label === '4k' ? 2160 : parseInt(label, 10) || 0
    const key = height === 2160 ? '2160p' : label.toLowerCase()
    list.push({ label: label === '4k' ? '4K' : label, height, url: fv[k], size: sizes[key] || sizes[label.toLowerCase()] || '' })
  }
  return { id: fv.video_id || '', title: fv.video_title || '', poster: fv.preview_url || '', sources: list }
}

/** h1：影片頁的 <video> 直接列出 <source src size="720">，網址帶幾小時後過期的簽章 */
function parseH1(html) {
  const list = []
  for (const x of html.matchAll(/<source\b[^>]*>/g)) {
    const src = (x[0].match(/src="([^"]+)"/) || [])[1]
    if (!src || !/\.mp4/i.test(src)) continue
    const height = Number((x[0].match(/size="(\d+)"/) || [])[1]) || Number((src.match(/(\d{3,4})p/) || [])[1]) || 0
    if (list.some((s) => s.height === height)) continue
    list.push({ label: height ? `${height}p` : 'MP4', height, url: decodeEntities(src), size: '' })
  }
  const poster = (html.match(/<video[^>]*poster="([^"]+)"/) || [])[1] || ''
  return { id: '', title: '', poster: decodeEntities(poster), sources: list }
}

async function sources(site, pageUrl) {
  const html = await get(site, pageUrl)
  const r = site === 'h1' ? parseH1(html) : parseRv(html)
  r.sources.sort((a, b) => a.height - b.height)
  if (!r.sources.length) throw new Error('這部影片沒有可播放的檔案（可能需要登入或已被移除）')
  return r
}

/** 下載選單沒附檔案大小的，用 Range 0-0 問一下總長度 */
async function sizes(site, urls) {
  return Promise.all(
    urls.map(async (u) => {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 5000)
        const r = await session.defaultSession.fetch(u, { headers: { Range: 'bytes=0-0', Referer: base(site) + '/' }, signal: ctl.signal })
        clearTimeout(t)
        const total = Number((r.headers.get('content-range') || '').split('/')[1]) || Number(r.headers.get('content-length')) || 0
        r.body?.cancel().catch(() => {})
        return total
      } catch {
        return 0
      }
    }),
  )
}

module.exports = { init, config, setBase, siteForUrl, abs, get, sources, sizes, base, label: (s) => SITES[check(s)].label, KEYS }
