// 頁面不能直接碰網路 session 和檔案，透過這裡呼叫主程序
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updater', {
  supported: () => ipcRenderer.invoke('update:supported'),
  download: (url, onProgress) => {
    const listener = (_e, p) => onProgress(p)
    ipcRenderer.on('update:progress', listener)
    return ipcRenderer.invoke('update:download', url).finally(() => ipcRenderer.removeListener('update:progress', listener))
  },
  install: () => ipcRenderer.invoke('update:install'),
})

contextBridge.exposeInMainWorld('hub', {
  // 程式資料（收藏、紀錄、設定…）存在主程序的 state.json
  state: {
    all: () => ipcRenderer.sendSync('state:all'),
    set: (key, value) => ipcRenderer.send('state:set', key, value),
  },
  get: (site, url) => ipcRenderer.invoke('net:get', site, url),
  sources: (site, url) => ipcRenderer.invoke('net:sources', site, url),
  sizes: (site, urls) => ipcRenderer.invoke('net:sizes', site, urls),
  // 線上播放走本機轉送（多條連線），回傳 http://127.0.0.1 的網址
  stream: (site, url) => ipcRenderer.invoke('net:stream', site, url),
  config: () => ipcRenderer.invoke('site:config'),
  setBase: (site, b) => ipcRenderer.invoke('site:setBase', site, b),
  external: (url) => ipcRenderer.invoke('shell:external', url),
  dl: {
    list: () => ipcRenderer.invoke('dl:list'),
    dir: () => ipcRenderer.invoke('dl:dir'),
    options: () => ipcRenderer.invoke('dl:options'),
    setOptions: (o) => ipcRenderer.invoke('dl:setOptions', o),
    organize: (list) => ipcRenderer.invoke('dl:organize', list),
    chooseDir: () => ipcRenderer.invoke('dl:chooseDir'),
    openDir: () => ipcRenderer.invoke('dl:openDir'),
    add: (v) => ipcRenderer.invoke('dl:add', v),
    pause: (id) => ipcRenderer.invoke('dl:pause', id),
    resume: (id) => ipcRenderer.invoke('dl:resume', id),
    remove: (id, deleteFile) => ipcRenderer.invoke('dl:remove', id, deleteFile),
    show: (id) => ipcRenderer.invoke('dl:show', id),
    exists: (id) => ipcRenderer.invoke('dl:exists', id),
    onUpdate: (fn) => ipcRenderer.on('dl:update', (_e, j) => fn(j)),
    onRemoved: (fn) => ipcRenderer.on('dl:removed', (_e, id) => fn(id)),
  },
})
