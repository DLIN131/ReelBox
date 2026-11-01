const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const path = require('path')
const fetcher = require('./fetcher')
const downloads = require('./downloads')
const stream = require('./stream')
const updater = require('./updater')
const state = require('./state')

// 用一般 Chrome 的 UA，網站對 Electron 字樣的 UA 可能會擋
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
app.userAgentFallback = UA

// 看過的縮圖 / 影片不存磁碟快取，userData 才不會越看越大（同一次執行裡還是有記憶體快取）
app.commandLine.appendSwitch('disable-http-cache')
// 沒點過頁面也能自動播放（滑過縮圖的預覽片段）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** 刪掉以前留下的快取資料夾。一定要在 app ready 之前做，ready 之後 Chromium 已經開著這些檔案 */
function removeOldCaches() {
  const ofs = require('original-fs')
  const ud = app.getPath('userData')
  for (const n of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
    try {
      ofs.rmSync(path.join(ud, n), { recursive: true, force: true })
    } catch {}
  }
}

let mainWin = null

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f13',
    title: 'ReelBox',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWin.removeMenu()
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'))
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      mainWin.webContents.toggleDevTools()
      e.preventDefault()
    }
  })
}

/** 縮圖、預覽、影片都補上所屬網站的 Referer（部分 CDN 沒有 Referer 會擋） */
function setupHeaders() {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*', 'http://*/*'] }, (details, cb) => {
    const site = fetcher.siteForUrl(details.url)
    if (site) details.requestHeaders.Referer = fetcher.base(site) + '/'
    cb({ requestHeaders: details.requestHeaders })
  })
}

function setupIpc() {
  ipcMain.handle('net:get', (_e, site, url) => fetcher.get(site, url))
  ipcMain.handle('net:sources', (_e, site, url) => fetcher.sources(site, url))
  ipcMain.handle('net:sizes', (_e, site, urls) => fetcher.sizes(site, urls))
  ipcMain.handle('site:config', () => fetcher.config())
  ipcMain.handle('site:setBase', (_e, site, b) => fetcher.setBase(site, b))
  ipcMain.handle('shell:external', (_e, url) => shell.openExternal(url))
}

// 同時只開一份：再開一次就把原本的視窗叫到前面（兩份同時跑下載會打架）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  removeOldCaches()
  app.on('second-instance', () => {
    if (!mainWin || mainWin.isDestroyed()) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
  })
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return
  state.setup()
  fetcher.init(UA)
  setupHeaders()
  setupIpc()
  downloads.setup()
  stream.setup()
  updater.setup()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
