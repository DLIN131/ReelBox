// 影片下載佇列（主程序）：可暫停 / 續傳，關掉程式再開會從上次的位置繼續。
// 檔案切成小段，從所有找得到的 CDN 主機同時下載（見 mirrors.js），寫進 .part 的對應位置。
const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron')
const fs = require('original-fs')
const path = require('path')
const { pathToFileURL } = require('url')
const fetcher = require('./fetcher')
const mirrors = require('./mirrors')
const { nodeGet, chromiumGet } = require('./httpget')

const MAX_RUNNING = 2
const jobsFile = () => path.join(app.getPath('userData'), 'downloads.json')
let jobs = []
let dir = ''
let byAuthor = true // 依作者分資料夾
const running = new Map() // job.id → AbortController
let saveTimer = null
const sendTimers = new Map()

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'))
    jobs = Array.isArray(d.jobs) ? d.jobs : []
    dir = d.dir || ''
    if (typeof d.byAuthor === 'boolean') byAuthor = d.byAuthor
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
    fs.writeFileSync(f + '.tmp', JSON.stringify({ dir, byAuthor, jobs }))
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

/** 放哪個資料夾：開了「依作者分資料夾」就是 下載位置\作者名 */
const folderOf = (j) => (byAuthor ? path.join(dir, clean(j.author || '未知作者')) : dir)

/** 檔名：標題 [編號] 畫質.mp4；同名檔案已存在（又不是這個工作的）就加 (2)、(3)… */
function pickFile(j, folder = folderOf(j)) {
  fs.mkdirSync(folder, { recursive: true })
  const stem = `${clean(j.title)} [${j.videoId}] ${j.label}`
  for (let n = 1; ; n++) {
    const f = path.join(folder, `${stem}${n > 1 ? ` (${n})` : ''}.mp4`)
    if (f === j.file) return f
    if (!fs.existsSync(f) && !fs.existsSync(f + '.part') && !jobs.some((o) => o !== j && o.file === f)) return f
  }
}

/** 搬檔案；不同磁碟不能直接改名，就複製再刪 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.copyFileSync(from, to)
    fs.rmSync(from)
  }
}

/** 把下載過的影片搬到對應的作者資料夾；list = [{ id, author }]（author 空的就用工作上記的） */
function organize(list) {
  let moved = 0
  let failed = 0
  for (const { id, author } of list) {
    const j = jobs.find((x) => x.id === id)
    if (!j) continue
    if (author) j.author = author
    // 還沒開始的不用搬，開始下載時就會放對地方；下載中的等下次
    if (!j.file || running.has(j.id)) continue
    const target = folderOf(j)
    if (path.dirname(j.file) === target) continue
    const src = j.status === 'done' ? j.file : j.file + '.part'
    if (!fs.existsSync(src)) continue
    try {
      const old = j.file
      const f = pickFile(j, target)
      moveFile(src, j.status === 'done' ? f : f + '.part')
      j.file = f
      moved++
      // 舊資料夾搬空了就順手刪掉（只刪下載位置裡面的空資料夾）
      const od = path.dirname(old)
      if (od !== dir && od.startsWith(dir + path.sep)) {
        try {
          fs.rmdirSync(od)
        } catch {}
      }
    } catch {
      failed++
    }
    emit(j, true)
  }
  save()
  return { moved, failed }
}

function pump() {
  for (const j of jobs) {
    if (running.size >= MAX_RUNNING) break
    if (j.status === 'queued' && !running.has(j.id)) run(j)
  }
}

// 分段大小和連線數；為什麼要用多條連線見 httpget.js
const CHUNK = 2 * 1048576 // 分段大小；最後幾段也不會拖太久
const TOTAL_CONN = 16 // 每個下載總共開幾條連線，平均分給各台主機

async function run(j) {
  const ctl = new AbortController()
  running.set(j.id, ctl)
  j.status = 'running'
  j.error = ''
  j.speed = 0
  j.hosts = 0
  emit(j, true)
  let fd = null
  try {
    // 網址有時效，每次開始都重抓影片頁拿新的
    const info = await fetcher.sources(j.site, j.pageUrl)
    const src = info.sources.find((s) => s.height === j.height) || info.sources.filter((s) => s.height <= j.height).pop() || info.sources[info.sources.length - 1]
    if (!j.file) {
      j.label = src.label
      j.height = src.height
      j.file = pickFile(j)
    }
    const referer = fetcher.base(j.site) + '/'
    const { urls, total } = await mirrors.find(src.url, referer)
    if (ctl.signal.aborted) throw new Error('aborted')
    if (!total) throw new Error('伺服器沒有回應檔案大小，請稍後再試')
    j.hosts = urls.length
    const part = j.file + '.part'
    const n = Math.ceil(total / CHUNK)
    let partSize = -1
    try {
      partSize = fs.statSync(part).size
    } catch {}
    // 續傳：同一個檔案（大小一樣）就沿用已完成的分段；舊版是從頭依序下載，前面完整的部分也算完成
    if (j.total !== total || typeof j.chunks !== 'string' || j.chunks.length !== n || partSize < 0) {
      const keep = partSize > 0 && j.total === total ? Math.floor(partSize / CHUNK) : 0
      j.chunks = '1'.repeat(Math.min(keep, n)) + '0'.repeat(n - Math.min(keep, n))
    }
    j.total = total
    fd = fs.openSync(part, partSize < 0 ? 'w+' : 'r+')
    fs.ftruncateSync(fd, total)
    const done = j.chunks.split('').map((c) => c === '1')
    const chunkLen = (i) => Math.min(CHUNK, total - i * CHUNK)
    j.got = done.reduce((a, d, i) => a + (d ? chunkLen(i) : 0), 0)
    const busy = new Set()
    let winStart = Date.now()
    let winBytes = 0
    const nextChunk = () => {
      for (let i = 0; i < n; i++) if (!done[i] && !busy.has(i)) return i
      return -1
    }

    async function getChunk(url, i, viaChromium) {
      const start = i * CHUNK
      const end = start + chunkLen(i) - 1
      const res = await (viaChromium ? chromiumGet : nodeGet)(url, { Range: `bytes=${start}-${end}`, Referer: referer }, ctl.signal)
      if (res.status !== 206) {
        res.stream.destroy()
        throw new Error(`HTTP ${res.status}`)
      }
      let pos = start
      try {
        for await (const value of res.stream) {
          if (pos + value.length > end + 1) throw new Error('伺服器回傳的資料超出範圍')
          fs.writeSync(fd, value, 0, value.length, pos)
          pos += value.length
          j.got += value.length
          winBytes += value.length
          const now = Date.now()
          if (now - winStart >= 1000) {
            j.speed = Math.round((winBytes * 1000) / (now - winStart))
            winStart = now
            winBytes = 0
          }
          emit(j)
        }
      } catch (e) {
        j.got -= pos - start
        throw e
      }
      if (pos !== end + 1) {
        j.got -= pos - start
        throw new Error('分段沒下載完')
      }
    }

    // 每台主機開幾條連線，各自搶還沒下載的分段；快的主機自然會搶到比較多段
    async function worker(url) {
      let fails = 0
      let viaChromium = false
      for (;;) {
        if (ctl.signal.aborted) return
        const i = nextChunk()
        if (i < 0) return
        busy.add(i)
        try {
          await getChunk(url, i, viaChromium)
          done[i] = true
          fails = 0
          j.chunks = done.map((d) => (d ? '1' : '0')).join('')
          save()
        } catch (e) {
          if (ctl.signal.aborted) return
          // 失敗一次就改用 Chromium 試；同一條連續失敗 3 次就不用了，其他連線繼續
          viaChromium = true
          if (++fails >= 3) return
          await new Promise((r) => setTimeout(r, 1000 * fails))
        } finally {
          busy.delete(i)
        }
      }
    }
    const per = Math.max(2, Math.ceil(TOTAL_CONN / urls.length))
    await Promise.all(urls.flatMap((u) => Array.from({ length: per }, () => worker(u))))
    if (ctl.signal.aborted) throw new Error('aborted')
    if (done.some((d) => !d)) throw new Error('連線中斷，檔案沒下載完（可按「繼續」續傳）')
    fs.closeSync(fd)
    fd = null
    fs.renameSync(part, j.file)
    try {
      j.total = j.got = fs.statSync(j.file).size
    } catch {}
    delete j.chunks
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
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
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
  ipcMain.handle('dl:options', () => ({ byAuthor }))
  ipcMain.handle('dl:setOptions', (_e, o) => {
    if (typeof o.byAuthor === 'boolean') byAuthor = o.byAuthor
    save()
    return { byAuthor }
  })
  ipcMain.handle('dl:organize', (_e, list) => organize(list))
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
      author: v.author || '',
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
