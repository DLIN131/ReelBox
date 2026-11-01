// 找同一個影片檔還放在哪些 CDN 主機上（主程序）。
// 同一個檔案通常同時放在好幾台（例如 eu-cdn03 / eu-cdn04 / us-cdn04），轉址只會給其中一台，
// 而有些主機本身就比較快（eu-cdn03 單條連線就有好幾 MB/s）。
// 這裡把同名規則的主機都問一遍，拿到同樣大小的就當作鏡像，下載時連線分散到各台一起分段抓。
const { net, session } = require('electron')

const CACHE_MS = 30 * 60 * 1000
const cache = new Map() // 原始主機 → { hosts, time }

/** get_file 會 302 轉到 CDN；不跟隨轉址，只拿轉到哪 */
function resolveRedirect(url, referer) {
  return new Promise((resolve) => {
    let done = false
    const finish = (u) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(u)
    }
    const rq = net.request({ url, redirect: 'manual', session: session.defaultSession })
    if (referer) rq.setHeader('Referer', referer)
    const timer = setTimeout(() => {
      rq.abort()
      finish(url)
    }, 15000)
    rq.on('redirect', (_s, _m, to) => {
      finish(to)
      rq.abort()
    })
    // 沒有轉址（例如直接就是檔案）：拿到回應就斷掉，不要把整個檔案抓下來
    rq.on('response', () => {
      finish(url)
      rq.abort()
    })
    rq.on('error', () => finish(url))
    rq.end()
  })
}

/** 問一台主機有沒有這個檔案：Range 0-0 回 206 且總長度一樣才算 */
async function probe(url, referer, timeout = 5000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await session.defaultSession.fetch(url, { headers: { Range: 'bytes=0-0', Referer: referer }, signal: ctl.signal })
    const total = r.status === 206 ? Number((r.headers.get('content-range') || '').split('/')[1]) || 0 : 0
    r.body?.cancel().catch(() => {})
    return total
  } catch {
    return 0
  } finally {
    clearTimeout(t)
  }
}

/** 主機名稱像 eu-cdn10-prem.xxx 才猜得出其他主機；猜 eu/us × cdn01~cdn12 */
function candidates(host) {
  const m = host.match(/^(eu|us)-cdn(\d+)(-prem)?(\..+)$/)
  if (!m) return []
  const out = []
  for (const region of ['eu', 'us']) for (let n = 1; n <= 12; n++) out.push(`${region}-cdn${String(n).padStart(2, '0')}${m[3] || ''}${m[4]}`)
  return out.filter((h) => h !== host)
}

/**
 * 回傳 { urls, total }：urls 第一個是網站給的那台，後面是找到的鏡像。
 * 找鏡像失敗也沒關係，至少有原本那台。
 */
async function find(url, referer) {
  const first = await resolveRedirect(url, referer)
  let u
  try {
    u = new URL(first)
  } catch {
    return { urls: [url], total: await probe(url, referer) }
  }
  const total = await probe(first, referer)
  const host = u.host
  const swap = (h) => {
    const x = new URL(first)
    x.host = h
    return x.href
  }
  const hit = cache.get(host)
  let hosts
  if (hit && Date.now() - hit.time < CACHE_MS) {
    // 同一組主機之前問過；還是確認一下這個檔案在不在（不同檔案可能放在不同組）
    const ok = await Promise.all(hit.hosts.map((h) => probe(swap(h), referer)))
    hosts = hit.hosts.filter((_, i) => ok[i] && ok[i] === total)
  } else {
    const list = candidates(host)
    const sizes = await Promise.all(list.map((h) => probe(swap(h), referer)))
    hosts = list.filter((_, i) => total && sizes[i] === total)
    cache.set(host, { hosts, time: Date.now() })
  }
  return { urls: [first, ...hosts.map(swap)], total }
}

module.exports = { find, resolveRedirect, probe }
