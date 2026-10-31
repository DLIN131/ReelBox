// 影片下載佇列（主程序）：可暫停 / 續傳，關掉程式再開會從上次的位置繼續
const { app, ipcMain, dialog, shell, session, BrowserWindow } = require('electron')
const fs = require('original-fs')
const path = require('path')
const { pathToFileURL } = require('url')
const fetcher = require('./fetcher')

const MAX_RUNNING = 2
const jobsFile = () => path.join(app.getPath('userData'), 'downloads.json')
let jobs = []
let dir = ''
const running = new Map() // job.id → AbortController
let saveTimer = null
const sendTimers = new Map()

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'))
    jobs = Array.isArray(d.jobs) ? d.jobs : []
    dir = d.dir || ''
  } catch {}
  if (!dir) dir = path.join(app.getPath('downloads'), 'ReelBox')
  for (const j of jobs) {
    // 上次關程式時還在下載的，這次接著下
    if (j.status === 'running') j.status = 'queued'
    j.speed = 0
    // 舊版只有一個來源
    if (!j.site) j.site = 'rv'
  }
}

function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 500)
}

function flush() {
  clearTimeout(saveTimer)
  try {
    const f = jobsFile()
    fs.writeFileSync(f + '.tmp', JSON.stringify({ dir, jobs }))
    fs.renameSync(f + '.tmp', f)
  } catch {}
}

function publicJob(j) {
  return { ...j, fileUrl: j.status === 'done' && j.file ? pathToFileURL(j.file).href : '' }
}

/** 通知頁面；下載中每 300ms 最多送一次 */
function emit(j, now = false) {
  const send = () => {
    sendTimers.delete(j.id)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('dl:update', publicJob(j))
  }
  if (now) {
    clearTimeout(sendTimers.get(j.id))
    send()
  } else if (!sendTimers.has(j.id)) sendTimers.set(j.id, setTimeout(send, 300))
}

const clean = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120) || 'video'

/** 檔名：標題 [編號] 畫質.mp4；同名檔案已存在（又不是這個工作的）就加 (2)、(3)… */
function pickFile(j) {
  fs.mkdirSync(dir, { recursive: true })
  const stem = `${clean(j.title)} [${j.videoId}] ${j.label}`
  for (let n = 1; ; n++) {
    const f = path.join(dir, `${stem}${n > 1 ? ` (${n})` : ''}.mp4`)
    if (!fs.existsSync(f) && !fs.existsSync(f + '.part') && !jobs.some((o) => o !== j && o.file === f)) return f
  }
}

function pump() {
  for (const j of jobs) {
    if (running.size >= MAX_RUNNING) break
    if (j.status === 'queued' && !running.has(j.id)) run(j)
  }
}

async function run(j) {
  const ctl = new AbortController()
  running.set(j.id, ctl)
  j.status = 'running'
  j.error = ''
  j.speed = 0
  emit(j, true)
  try {
    // 網址有時效，每次開始都重抓影片頁拿新的
    const info = await fetcher.sources(j.site, j.pageUrl)
    const src = info.sources.find((s) => s.height === j.height) || info.sources.filter((s) => s.height <= j.height).pop() || info.sources[info.sources.length - 1]
    if (!j.file) {
      j.label = src.label
      j.height = src.height
      j.file = pickFile(j)
    }
    const part = j.file + '.part'
    let got = 0
    try {
      got = fs.statSync(part).size
    } catch {}
    const headers = { Referer: fetcher.base(j.site) + '/' }
    if (got > 0) headers.Range = `bytes=${got}-`
    const res = await session.defaultSession.fetch(src.url, { headers, signal: ctl.signal })
    if (res.status === 416 && got > 0) {
      // 已經下載完了，只是上次沒改名
    } else {
      if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status}`)
      if (res.status !== 206) got = 0 // 伺服器不支援續傳就從頭來
      const range = res.headers.get('content-range')
      const len = Number(res.headers.get('content-length')) || 0
      j.total = range ? Number(range.split('/')[1]) || got + len : len
      j.got = got
      const out = fs.createWriteStream(part, { flags: got > 0 ? 'a' : 'w' })
      const done = new Promise((resolve, reject) => {
        out.on('error', reject)
        out.on('finish', resolve)
      })
      const reader = res.body.getReader()
      let winStart = Date.now()
      let winBytes = 0
      try {
        for (;;) {
          const { done: end, value } = await reader.read()
          if (end) break
          j.got += value.length
          winBytes += value.length
          const now = Date.now()
          if (now - winStart >= 1000) {
            j.speed = Math.round((winBytes * 1000) / (now - winStart))
            winStart = now
            winBytes = 0
          }
          if (!out.write(value)) await new Promise((r) => out.once('drain', r))
          emit(j)
        }
      } finally {
        out.end()
        await done.catch(() => {})
      }
      if (j.total && j.got < j.total) throw new Error('連線中斷，檔案沒下載完（可按「繼續」續傳）')
    }
    fs.renameSync(part, j.file)
    try {
      j.total = j.got = fs.statSync(j.file).size
    } catch {}
    j.status = 'done'
    j.finished = Date.now()
  } catch (e) {
    if (ctl.signal.aborted) {
      if (j.status === 'running') j.status = 'paused'
    } else {
      j.status = 'error'
      j.error = e.message || String(e)
    }
  } finally {
    j.speed = 0
    running.delete(j.id)
    save()
    emit(j, true)
    pump()
  }
}

function find(id) {
  const j = jobs.find((x) => x.id === id)
  if (!j) throw new Error('找不到這個下載')
  return j
}

function setup() {
  load()
  ipcMain.handle('dl:list', () => jobs.map(publicJob))
  ipcMain.handle('dl:dir', () => dir)
  ipcMain.handle('dl:chooseDir', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: dir, properties: ['openDirectory', 'createDirectory'] })
    if (!r.canceled && r.filePaths[0]) {
      dir = r.filePaths[0]
      save()
    }
    return dir
  })
  ipcMain.handle('dl:openDir', () => {
    fs.mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  })
  ipcMain.handle('dl:add', (_e, v) => {
    // 同一部影片同一畫質已經在佇列或下載完，就不重複加
    const site = v.site || 'rv'
    const same = jobs.find((j) => j.site === site && j.videoId === String(v.videoId) && j.height === v.height && j.status !== 'error')
    if (same) return publicJob(same)
    const j = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      site,
      videoId: String(v.videoId),
      pageUrl: v.pageUrl,
      title: v.title || '',
      thumb: v.thumb || '',
      duration: v.duration || '',
      height: v.height || 0,
      label: v.label || '',
      file: '',
      total: 0,
      got: 0,
      speed: 0,
      status: 'queued',
      error: '',
      added: Date.now(),
    }
    jobs.unshift(j)
    save()
    emit(j, true)
    pump()
    return publicJob(j)
  })
  ipcMain.handle('dl:pause', (_e, id) => {
    const j = find(id)
    if (j.status === 'queued') j.status = 'paused'
    else if (j.status === 'running') {
      j.status = 'paused'
      running.get(id)?.abort()
    }
    save()
    emit(j, true)
  })
  ipcMain.handle('dl:resume', (_e, id) => {
    const j = find(id)
    if (j.status === 'paused' || j.status === 'error') {
      j.status = 'queued'
      j.error = ''
      save()
      emit(j, true)
      pump()
    }
  })
  ipcMain.handle('dl:remove', async (_e, id, deleteFile) => {
    const j = find(id)
    if (running.has(id)) {
      j.status = 'removed'
      running.get(id).abort()
      await new Promise((r) => setTimeout(r, 300))
    }
    if (j.file) {
      try {
        fs.rmSync(j.file + '.part', { force: true })
      } catch {}
      if (deleteFile && fs.existsSync(j.file)) await shell.trashItem(j.file).catch(() => {})
    }
    jobs = jobs.filter((x) => x !== j)
    save()
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('dl:removed', id)
  })
  ipcMain.handle('dl:show', (_e, id) => {
    const j = find(id)
    if (j.file && fs.existsSync(j.file)) shell.showItemInFolder(j.file)
    else shell.openPath(dir)
  })
  ipcMain.handle('dl:exists', (_e, id) => {
    const j = find(id)
    return !!j.file && fs.existsSync(j.file)
  })
  app.on('before-quit', flush)
  pump()
}

module.exports = { setup, flush }
