// 抓網站頁面、解析影片的播放 / 下載網址（主程序）
const { app, session } = require('electron')
const fs = require('original-fs')
const path = require('path')

// 網址只用 Base64 存，可在設定頁改成鏡像站
const DEFAULT_BASE = Buffer.from('aHR0cHM6Ly9ydWxlMzR2aWRlby5jb20=', 'base64').toString()
const cfgFile = () => path.join(app.getPath('userData'), 'site.json')
let base = DEFAULT_BASE
let ua = ''

function init(userAgent) {
  ua = userAgent
  try {
    const b = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).base
    if (/^https?:\/\/[^/]+$/.test(b)) base = b
  } catch {}
}

function config() {
  return { base, defaultBase: DEFAULT_BASE }
}

function setBase(b) {
  b = String(b || '').trim().replace(/\/+$/, '') || DEFAULT_BASE
  if (!/^https?:\/\/[^/]+$/.test(b)) throw new Error('網址格式不正確，例如 https://example.com')
  base = b
  try {
    fs.writeFileSync(cfgFile(), JSON.stringify({ base }))
  } catch {}
  return config()
}

/** 是不是網站（或它的 CDN 轉址）的網址：圖片 / 影片要補 Referer */
function isSiteUrl(u) {
  try {
    const h = new URL(u).hostname
    const b = new URL(base).hostname
    return h === b || h.endsWith('.' + b)
  } catch {
    return false
  }
}

function abs(u) {
  if (!u) return ''
  if (/^https?:/.test(u)) return u
  return base + (u.startsWith('/') ? '' : '/') + u
}

async function get(url) {
  const res = await session.defaultSession.fetch(abs(url), {
    headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9', Referer: base + '/' },
  })
  if (res.status === 404) throw new Error('找不到這個頁面（影片可能已被刪除）')
  if (!res.ok) throw new Error(`網站回應 HTTP ${res.status}`)
  return res.text()
}

const unesc = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

/**
 * 影片頁裡播放器的 flashvars 有各畫質的網址（video_url、video_alt_url、video_alt_url2…），
 * 下載選單另外列了檔案大小。網址帶時效 token，所以每次播放 / 下載前都重新抓一次。
 */
function parseSources(html) {
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
  list.sort((a, b) => a.height - b.height)
  if (!list.length) throw new Error('這部影片沒有可播放的檔案')
  return { id: fv.video_id || '', title: fv.video_title || '', poster: fv.preview_url || '', sources: list }
}

async function sources(pageUrl) {
  return parseSources(await get(pageUrl))
}

module.exports = { init, config, setBase, isSiteUrl, abs, get, sources, parseSources, base: () => base }
