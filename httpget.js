// 分段抓取用的連線（主程序），下載和播放共用。
// rv 站的 CDN 每「條連線」限速約 0.24 MB/s，開多條就能疊加（16 條約 3.8 MB/s）。
// Chromium（session.fetch）對同一台主機會把所有請求併進一條 HTTP/2 連線，開再多也只有一條的速度，
// 所以分段改用 Node 的 https（HTTP/1.1，每條連線各自一個 socket）；它連不上（例如要走系統代理）才退回 session.fetch。
const { app, session } = require('electron')
const http = require('http')
const https = require('https')

const agent = new https.Agent({ keepAlive: true, maxSockets: Infinity })
const nodeLib = (u) => (u.startsWith('https:') ? https : http)

/** 用 Node 抓一段，回傳 { status, stream } */
function nodeGet(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = nodeLib(url).get(url, { agent: url.startsWith('https:') ? agent : undefined, headers: { 'User-Agent': app.userAgentFallback, ...headers } }, (res) => resolve({ status: res.statusCode, stream: res }))
    const onAbort = () => req.destroy(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal.removeEventListener('abort', onAbort))
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('連線逾時')))
  })
}

/** 用 Chromium 抓一段（備用），包成跟 nodeGet 一樣的介面 */
async function chromiumGet(url, headers, signal) {
  const res = await session.defaultSession.fetch(url, { headers, signal })
  const reader = res.body.getReader()
  return {
    status: res.status,
    stream: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          yield Buffer.from(value)
        }
      },
      destroy: () => reader.cancel().catch(() => {}),
    },
  }
}

module.exports = { nodeGet, chromiumGet }
