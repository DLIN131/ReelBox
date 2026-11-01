// 線上播放用的本機轉送伺服器（主程序）。
// <video> 直接連 CDN 的話，Chromium 只會開一條連線，在限速的主機上只有約 0.24 MB/s，1080p 會一直卡。
// 這裡在 127.0.0.1 開一個小伺服器：播放器照常用 Range 要資料，我們把要的範圍切成小段，
// 從所有鏡像主機開多條連線同時抓（見 httpget.js、mirrors.js），再依序回給播放器。
const { ipcMain } = require('electron')
const http = require('http')
const crypto = require('crypto')
const fetcher = require('./fetcher')
const mirrors = require('./mirrors')
const { nodeGet, chromiumGet } = require('./httpget')

const CHUNK = 512 * 1024 // 小段一點，開始播放和拖曳後比較快有畫面
const WINDOW = 12 // 每個播放請求最多同時抓幾段（也是預先緩衝的上限）
const KEEP_MS = 6 * 60 * 60 * 1000

const entries = new Map() // id → { site, url, referer, urls, total, ready, time }
const byUrl = new Map() // 原始網址 → id
let server = null
let listening = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找出 CDN 網址和檔案大小；鏡像在背景找，找到再加進來 */
function ensure(e) {
  if (!e.ready) {
    e.ready = (async () => {
      const first = await mirrors.resolveRedirect(e.url, e.referer)
      const total = await mirrors.probe(first, e.referer, 15000)
      if (!total) throw new Error('伺服器沒有回應檔案大小')
      e.urls = [first]
      e.total = total
      mirrors
        .find(e.url, e.referer)
        .then((r) => {
          if (r.total === e.total && r.urls.length > e.urls.length) e.urls = r.urls
        })
        .catch(() => {})
    })()
    e.ready.catch(() => (e.ready = null))
  }
  return e.ready
}

/** CDN 網址過期（403 之類）就重新轉址一次 */
function refresh(e) {
  if (!e.refreshing) {
    e.refreshing = mirrors
      .resolveRedirect(e.url, e.referer)
      .then(async (u) => {
        if ((await mirrors.probe(u, e.referer)) === e.total) e.urls = [u]
      })
      .finally(() => setTimeout(() => (e.refreshing = null), 5000))
  }
  return e.refreshing
}

/** 把 [start, end] 這段依序寫給播放器；後面的小段同時在抓 */
async function pipeRange(e, start, end, res, signal) {
  const n = Math.ceil((end - start + 1) / CHUNK)
  const chunks = []
  let next = 0
  let cur = 0
  let rr = 0
  const poke = (c) => {
    const w = c.wake
    c.wake = null
    w?.()
  }

  function fetchChunk(i) {
    const c = { start: start + i * CHUNK, end: Math.min(end, start + (i + 1) * CHUNK - 1), bufs: [], got: 0, done: false, err: null, wake: null }
    const len = c.end - c.start + 1
    ;(async () => {
      let tries = 0
      while (!signal.aborted) {
        // 輪流用各台主機；失敗重試時自然換到下一台
        const url = e.urls[rr++ % e.urls.length]
        try {
          const r = await (tries >= 2 ? chromiumGet : nodeGet)(url, { Range: `bytes=${c.start + c.got}-${c.end}`, Referer: e.referer }, signal)
          if (r.status !== 206) {
            r.stream.destroy()
            throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
          }
          for await (const b of r.stream) {
            const piece = b.length > len - c.got ? b.subarray(0, len - c.got) : b
            c.bufs.push(piece)
            c.got += piece.length
            poke(c)
            if (c.got >= len) break
          }
          if (c.got >= len) {
            c.done = true
            break
          }
          throw new Error('分段沒抓完')
        } catch (err) {
          if (signal.aborted) break
          if (++tries >= 5) {
            c.err = err
            break
          }
          if (err.status >= 400) await refresh(e).catch(() => {})
          await sleep(300 * tries)
        }
      }
      if (!c.done && !c.err) c.err = new Error('aborted')
      poke(c)
    })()
    return c
  }

  const launch = () => {
    while (next < n && next < cur + WINDOW && !signal.aborted) chunks[next] = fetchChunk(next++)
  }
  const drained = () =>
    new Promise((r) => {
      res.once('drain', r)
      res.once('close', r)
    })

  for (; cur < n; cur++) {
    launch()
    const c = chunks[cur]
    for (;;) {
      while (c.bufs.length) {
        if (signal.aborted) throw new Error('aborted')
        if (!res.write(c.bufs.shift())) await drained()
      }
      if (c.err) throw c.err
      if (c.done) break
      await new Promise((r) => {
        c.wake = r
        if (c.bufs.length || c.done || c.err) poke(c)
      })
    }
    chunks[cur] = null
  }
}

async function handle(req, res) {
  const m = /^\/v\/([\w-]+)/.exec(req.url)
  const e = m && entries.get(m[1])
  if (!e) {
    res.writeHead(404)
    return res.end()
  }
  e.time = Date.now()
  try {
    await ensure(e)
  } catch {
    res.writeHead(502)
    return res.end()
  }
  const total = e.total
  let start = 0
  let end = total - 1
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (r) {
    if (r[1] === '') start = Math.max(0, total - Number(r[2] || 0))
    else {
      start = Number(r[1])
      if (r[2]) end = Math.min(Number(r[2]), total - 1)
    }
  }
  if (start >= total || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` })
    return res.end()
  }
  res.writeHead(r ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(r ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
  })
  if (req.method === 'HEAD') return res.end()
  // 播放器拖曳或關掉時會斷開這個請求，跟著停止還在抓的分段
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())
  try {
    await pipeRange(e, start, end, res, ctl.signal)
    res.end()
  } catch {
    res.destroy()
  }
}

function start() {
  if (!listening) {
    server = http.createServer((req, res) => handle(req, res).catch(() => res.destroy()))
    listening = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    listening.catch(() => (listening = null))
  }
  return listening
}

/** 給播放器用的本機網址；同一個原始網址重複要會拿到同一個 */
async function urlFor(site, url) {
  const port = await start()
  for (const [id, x] of entries) if (Date.now() - x.time > KEEP_MS) entries.delete(id), byUrl.delete(x.url)
  let id = byUrl.get(url)
  if (!id || !entries.has(id)) {
    id = crypto.randomBytes(12).toString('hex')
    entries.set(id, { site, url, referer: fetcher.base(site) + '/', urls: null, total: 0, ready: null, time: Date.now() })
    byUrl.set(url, id)
  }
  const e = entries.get(id)
  e.time = Date.now()
  ensure(e).catch(() => {})
  return `http://127.0.0.1:${port}/v/${id}`
}

function setup() {
  ipcMain.handle('net:stream', (_e, site, url) => urlFor(site, url))
}

module.exports = { setup, urlFor }
