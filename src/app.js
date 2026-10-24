import { store } from './store.js'
import * as site from './site.js'

const $ = (s, r = document) => r.querySelector(s)
const view = $('#view')
const player = $('#player')

/** 建立元素：h('div', { class: 'x', onclick }, ...children) */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el[k] = v
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const loading = (text = '載入中…') => h('div', { class: 'status' }, h('span', { class: 'spinner' }), text)
const status = (text, retry) => h('div', { class: 'status' }, text, retry ? h('button', { class: 'btn', onclick: retry }, '重試') : null)

let toastTimer
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600)
}

function fmtBytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

// 網站上的英文日期 / 數字轉成中文顯示
const zhAgo = (s) =>
  String(s || '')
    .replace(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i, (_m, n, u) => `${n} ${{ second: '秒', minute: '分鐘', hour: '小時', day: '天', week: '週', month: '個月', year: '年' }[u.toLowerCase()]}前`)
    .replace(/^Submitted:\s*/i, '')

// ---------- 收藏 / 紀錄 ----------

const brief = (v) => ({ id: String(v.id), url: v.url, title: v.title, thumb: v.thumb, duration: v.duration || '', hd: !!v.hd, preview: v.preview || '' })
const isFav = (id) => store.get('favorites', []).some((x) => x.id === String(id))

function toggleFav(v) {
  const list = store.get('favorites', [])
  const i = list.findIndex((x) => x.id === String(v.id))
  if (i >= 0) list.splice(i, 1)
  else list.unshift({ ...brief(v), time: Date.now() })
  store.set('favorites', list)
  toast(i >= 0 ? '已取消收藏' : '已加入收藏')
  return i < 0
}

function saveHistory(v, pos, len) {
  if (!store.get('keepHistory', true)) return
  const list = store.get('history', []).filter((x) => x.id !== String(v.id))
  list.unshift({ ...brief(v), time: Date.now(), pos: pos || 0, len: len || 0 })
  store.set('history', list.slice(0, 500))
}
const historyOf = (id) => store.get('history', []).find((x) => x.id === String(id))

// ---------- 下載狀態 ----------

const jobs = new Map()
const dlListeners = new Set()

function updateDlCount() {
  const n = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length
  const el = $('#dlCount')
  el.textContent = n
  el.classList.toggle('hidden', !n)
}

window.hub.dl.onUpdate((j) => {
  const old = jobs.get(j.id)
  jobs.set(j.id, j)
  if (old && old.status !== j.status) {
    if (j.status === 'done') toast(`下載完成：${j.title}`)
    else if (j.status === 'error') toast(`下載失敗：${j.title}`)
  }
  updateDlCount()
  for (const f of dlListeners) f(j)
})
window.hub.dl.onRemoved((id) => {
  jobs.delete(id)
  updateDlCount()
  for (const f of dlListeners) f({ id, removed: true })
})
window.hub.dl.list().then((list) => {
  for (const j of list) jobs.set(j.id, j)
  updateDlCount()
})

async function startDownload(v, src) {
  try {
    const j = await window.hub.dl.add({ videoId: v.id, pageUrl: v.url, title: v.title, thumb: v.thumb, duration: v.duration, height: src.height, label: src.label })
    jobs.set(j.id, j)
    updateDlCount()
    toast(j.status === 'done' ? '這個畫質已經下載過了' : `已加入下載：${src.label}`)
  } catch (e) {
    toast(`無法下載：${errText(e)}`)
  }
}

// ---------- 影片卡片 ----------

let previewTimer = null
function videoCard(v, extra) {
  const thumb = h('div', { class: 'thumb' }, h('img', { src: v.thumb, loading: 'lazy', alt: '' }), v.duration ? h('span', { class: 'dur' }, v.duration) : null, v.hd ? h('span', { class: 'hd' }, 'HD') : null)
  const hist = historyOf(v.id)
  if (hist && hist.len) thumb.append(h('div', { class: 'progress' }, h('i', { style: `width:${Math.min(100, (hist.pos / hist.len) * 100)}%` })))
  if (v.preview && store.get('hoverPreview', true)) {
    // 滑鼠停一下才載入預覽片段，掃過去不會一直下載
    thumb.onmouseenter = () => {
      clearTimeout(previewTimer)
      previewTimer = setTimeout(() => {
        if (thumb.querySelector('video')) return
        const vid = h('video', { src: v.preview, muted: true, autoplay: true, loop: true, playsinline: true })
        vid.muted = true
        thumb.append(vid)
      }, 350)
    }
    thumb.onmouseleave = () => {
      clearTimeout(previewTimer)
      thumb.querySelector('video')?.remove()
    }
  }
  const meta = [zhAgo(v.added), v.views ? `${v.views} 次觀看` : '', v.rating ? `👍 ${v.rating}` : ''].filter(Boolean).join(' · ')
  return h('div', { class: 'card', onclick: () => openVideo(v) }, thumb, h('div', { class: 'title', title: v.title }, v.title), meta ? h('div', { class: 'meta' }, meta) : null, extra || null)
}

/** 會一直往下載入的影片列表；loader(page) → { items, hasMore } */
function infiniteGrid(container, loader, makeCard) {
  const grid = h('div', { class: 'grid' })
  const foot = h('div', { class: 'foot' })
  container.append(grid, foot)
  let page = 0
  let busy = false
  let done = false
  const seen = new Set()
  const token = navToken
  async function more() {
    if (busy || done || token !== navToken) return
    busy = true
    foot.replaceChildren(loading())
    try {
      const r = await loader(page + 1)
      if (token !== navToken) return
      page++
      for (const it of r.items) {
        const key = it.id || it.slug
        if (seen.has(key)) continue
        seen.add(key)
        grid.append(makeCard(it))
      }
      done = !r.hasMore
      foot.replaceChildren(done ? h('div', { class: 'status dim' }, seen.size ? '已經到底了' : '沒有結果') : '')
    } catch (e) {
      foot.replaceChildren(status(`載入失敗：${errText(e)}`, () => more()))
    } finally {
      busy = false
    }
    // 第一頁不夠填滿畫面就再載一頁
    if (!done && token === navToken && view.scrollHeight <= view.clientHeight + 200) more()
  }
  scrollHook = () => {
    if (view.scrollTop + view.clientHeight > view.scrollHeight - 800) more()
  }
  more()
}

// ---------- 頁面切換 ----------

let navToken = 0
let scrollHook = null
let current = { name: 'home', params: {} }
const backStack = []

view.addEventListener('scroll', () => scrollHook && scrollHook())

function nav(name, params = {}, { push = true } = {}) {
  if (push && current) backStack.push({ ...current, scroll: view.scrollTop })
  if (backStack.length > 50) backStack.shift()
  current = { name, params }
  navToken++
  scrollHook = null
  view.replaceChildren()
  view.scrollTop = 0
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.nav === name)
  ;(pages[name] || pages.home)(params)
}

function goBack() {
  if (!player.classList.contains('hidden')) {
    // 影片頁裡點了相關影片：返回上一部影片
    if (!videoStack.length) return closeVideo()
    savePos()
    currentVideo = null
    return openVideo(videoStack.pop(), { fromStack: true })
  }
  const prev = backStack.pop()
  if (prev) nav(prev.name, prev.params, { push: false })
}

/** 篩選列：內容類型 + 排序 */
function filterBar(params, { sorts = site.SORTS, defSort = 'post_date', types = true } = {}) {
  const type = params.type ?? store.get('type', '')
  const sort = params.sort ?? defSort
  const bar = h('div', { class: 'filters' })
  if (types) {
    const chips = h('div', { class: 'chips' })
    for (const t of site.TYPES) {
      chips.append(
        h(
          'button',
          {
            class: `chip${t.id === type ? ' on' : ''}`,
            onclick: () => {
              store.set('type', t.id)
              nav(current.name, { ...params, type: t.id }, { push: false })
            },
          },
          t.name,
        ),
      )
    }
    bar.append(chips)
  }
  const sel = h('select', { class: 'sort', onchange: () => nav(current.name, { ...params, sort: sel.value }, { push: false }) }, sorts.map((s) => h('option', { value: s.id, selected: s.id === sort }, s.name)))
  bar.append(h('label', { class: 'sort-wrap' }, '排序', sel))
  return { bar, type, sort }
}

const pages = {
  home(params) {
    const { bar, type, sort } = filterBar(params)
    view.append(h('div', { class: 'page-head' }, h('h1', {}, '最新影片'), bar))
    infiniteGrid(view, (page) => site.videoList({ kind: 'latest', page, sort: sort === 'post_date' ? '' : sort, type }), (v) => videoCard(v))
  },

  list(params) {
    const { kind, slug, q, name } = params
    const { bar, type, sort } = filterBar(params, { defSort: kind === 'search' ? '' : 'post_date', sorts: kind === 'search' ? [{ id: '', name: '最相關' }, ...site.SORTS] : site.SORTS })
    const label = { search: '搜尋', tags: '標籤', categories: '分類', models: '作者' }[kind]
    const title = h('h1', {}, h('span', { class: 'dim' }, `${label}：`), kind === 'search' ? q : name || slug)
    const head = h('div', { class: 'page-head' }, title, bar)
    if (kind !== 'search') {
      const key = `${kind}/${slug}`
      const follows = () => store.get('follows', [])
      const on = () => follows().some((f) => f.key === key)
      const btn = h('button', { class: 'btn small' })
      const paint = () => (btn.textContent = on() ? '★ 已追蹤' : '☆ 追蹤')
      btn.onclick = () => {
        const list = follows().filter((f) => f.key !== key)
        if (!on()) list.unshift({ key, kind, slug, name: name || slug })
        store.set('follows', list)
        paint()
      }
      paint()
      title.append(btn)
    }
    view.append(head)
    infiniteGrid(view, (page) => site.videoList({ kind, slug, q, page, sort: sort === 'post_date' && kind !== 'search' ? '' : sort, type }), (v) => videoCard(v))
  },

  groups(params) {
    const kind = params.kind
    const sorts =
      kind === 'models'
        ? [
            { id: '', name: '熱門' },
            { id: 'title', name: '名稱' },
            { id: 'total_videos', name: '影片數' },
            { id: 'avg_videos_rating', name: '評分' },
          ]
        : [
            { id: 'total_videos', name: '影片數' },
            { id: '', name: '熱門' },
            { id: 'title', name: '名稱' },
            { id: 'avg_videos_rating', name: '評分' },
          ]
    const { bar, sort } = filterBar(params, { sorts, defSort: sorts[0].id, types: false })
    const follows = store.get('follows', []).filter((f) => f.kind === kind)
    view.append(h('div', { class: 'page-head' }, h('h1', {}, kind === 'models' ? '作者' : '分類'), bar))
    if (follows.length) {
      view.append(
        h(
          'div',
          { class: 'follow-row' },
          h('span', { class: 'dim' }, '追蹤中：'),
          follows.map((f) => h('button', { class: 'chip on', onclick: () => nav('list', { kind: f.kind, slug: f.slug, name: f.name }) }, f.name)),
        ),
      )
    }
    infiniteGrid(
      view,
      (page) => site.groups(kind, page, sort),
      (g) =>
        h(
          'div',
          { class: `gcard ${kind}`, onclick: () => nav('list', { kind, slug: g.slug, name: g.name }) },
          h('div', { class: 'gimg' }, g.img ? h('img', { src: g.img, loading: 'lazy', alt: '' }) : h('span', {}, g.name.slice(0, 1).toUpperCase())),
          h('div', { class: 'gname' }, g.name),
          g.count ? h('div', { class: 'meta' }, g.count) : null,
        ),
    )
  },

  favorites() {
    const list = store.get('favorites', [])
    view.append(h('div', { class: 'page-head' }, h('h1', {}, `收藏（${list.length}）`)))
    if (!list.length) return view.append(status('還沒有收藏。在影片頁按「☆ 收藏」加入。'))
    const grid = h('div', { class: 'grid' })
    for (const v of list) {
      const rm = h('button', {
        class: 'card-x',
        title: '取消收藏',
        onclick: (e) => {
          e.stopPropagation()
          toggleFav(v)
          card.remove()
        },
      }, '×')
      const card = videoCard(v, rm)
      grid.append(card)
    }
    view.append(grid)
  },

  history() {
    const list = store.get('history', [])
    const clear = h('button', {
      class: 'btn small',
      onclick: () => {
        if (!confirm('清除全部觀看紀錄？')) return
        store.set('history', [])
        nav('history', {}, { push: false })
      },
    }, '清除紀錄')
    view.append(h('div', { class: 'page-head' }, h('h1', {}, '觀看紀錄'), list.length ? clear : null))
    if (!list.length) return view.append(status('還沒有觀看紀錄'))
    const grid = h('div', { class: 'grid' })
    for (const v of list) grid.append(videoCard({ ...v, added: '' }, h('div', { class: 'meta' }, `${new Date(v.time).toLocaleString()}${v.len ? ` · 看到 ${fmtTime(v.pos)} / ${fmtTime(v.len)}` : ''}`)))
    view.append(grid)
  },

  async downloads() {
    const dirEl = h('span', { class: 'dim path' })
    window.hub.dl.dir().then((d) => (dirEl.textContent = d))
    view.append(
      h(
        'div',
        { class: 'page-head' },
        h('h1', {}, '下載'),
        h(
          'div',
          { class: 'row' },
          dirEl,
          h('button', { class: 'btn small', onclick: () => window.hub.dl.openDir() }, '開啟資料夾'),
          h('button', { class: 'btn small', onclick: async () => (dirEl.textContent = await window.hub.dl.chooseDir()) }, '變更位置'),
        ),
      ),
    )
    const box = h('div', { class: 'dl-list' })
    view.append(box)
    const rows = new Map()
    const render = () => {
      const list = [...jobs.values()].sort((a, b) => b.added - a.added)
      if (!list.length) return box.replaceChildren(status('還沒有下載。在影片頁按「下載」選畫質。'))
      if (!rows.size) box.replaceChildren()
      for (const j of list) if (!rows.has(j.id)) {
        const r = dlRow(j)
        rows.set(j.id, r)
        box.append(r.el)
      }
    }
    render()
    const token = navToken
    const listener = (j) => {
      if (token !== navToken) return dlListeners.delete(listener)
      if (j.removed) {
        rows.get(j.id)?.el.remove()
        rows.delete(j.id)
        if (!rows.size) render()
        return
      }
      const r = rows.get(j.id)
      if (r) r.update(j)
      else {
        const nr = dlRow(j)
        rows.set(j.id, nr)
        if (rows.size === 1) box.replaceChildren()
        box.prepend(nr.el)
      }
    }
    dlListeners.add(listener)
  },

  settings() {
    const box = h('div', { class: 'settings' })
    view.append(h('div', { class: 'page-head' }, h('h1', {}, '設定')), box)
    const section = (title, ...kids) => h('section', {}, h('h2', {}, title), ...kids)
    const checkbox = (key, def, label) => {
      const c = h('input', { type: 'checkbox', checked: store.get(key, def) })
      c.onchange = () => store.set(key, c.checked)
      return h('label', { class: 'check' }, c, label)
    }

    // 版本與更新
    const st = h('span', { class: 'dim' })
    const checkBtn = h('button', {
      class: 'btn',
      onclick: async () => {
        st.textContent = '檢查中…'
        const r = await checkUpdate(true)
        st.textContent = { dev: '開發版不檢查更新', latest: '已經是最新版', shown: '有新版本，請看右下角', error: '檢查失敗（網路問題？）' }[r]
      },
    }, '檢查更新')
    box.append(section('版本', h('div', { class: 'row' }, h('b', {}, versionText()), checkBtn, h('button', { class: 'btn', onclick: () => showChangelog() }, '更新紀錄'), st)))

    // 播放
    const q = h('select', { onchange: () => store.set('quality', Number(q.value)) }, [2160, 1080, 720, 480, 360].map((v) => h('option', { value: v, selected: v === store.get('quality', 1080) }, v === 2160 ? '4K' : `${v}p`)))
    box.append(
      section(
        '播放',
        h('label', { class: 'row' }, '預設畫質（沒有的話用最接近的較低畫質）', q),
        checkbox('autoplay', true, '開啟影片時自動播放'),
        checkbox('resume', true, '從上次看到的地方繼續'),
        checkbox('hoverPreview', true, '滑鼠停在縮圖上播放預覽'),
        checkbox('keepHistory', true, '記錄觀看紀錄'),
      ),
    )

    // 下載
    const dirEl = h('span', { class: 'path' })
    window.hub.dl.dir().then((d) => (dirEl.textContent = d))
    box.append(section('下載', h('div', { class: 'row' }, '下載位置：', dirEl, h('button', { class: 'btn small', onclick: async () => (dirEl.textContent = await window.hub.dl.chooseDir()) }, '變更'))))

    // 網址
    const inp = h('input', { type: 'text', class: 'input', spellcheck: false })
    window.hub.config().then((c) => (inp.value = c.base))
    box.append(
      section(
        '連線',
        h('div', { class: 'dim' }, '網站換網域時可以在這裡改（留空恢復預設）'),
        h(
          'div',
          { class: 'row' },
          inp,
          h('button', {
            class: 'btn',
            onclick: async () => {
              try {
                inp.value = (await window.hub.setBase(inp.value)).base
                toast('已儲存')
              } catch (e) {
                toast(errText(e))
              }
            },
          }, '儲存'),
        ),
      ),
    )
  },
}

function dlRow(j) {
  const bar = h('i')
  const info = h('div', { class: 'dl-info' })
  const btns = h('div', { class: 'dl-btns' })
  const el = h('div', { class: 'dl-row' }, h('img', { src: j.thumb, alt: '' }), h('div', { class: 'dl-main' }, h('div', { class: 'title' }, j.title), h('div', { class: 'bar' }, bar), info), btns)
  const btn = (text, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: fn }, text)
  function update(x) {
    j = x
    const pct = j.total ? Math.floor((j.got / j.total) * 100) : 0
    bar.style.width = `${j.status === 'done' ? 100 : pct}%`
    el.dataset.status = j.status
    const size = j.total ? `${fmtBytes(j.got)} / ${fmtBytes(j.total)}` : j.got ? fmtBytes(j.got) : ''
    info.textContent =
      {
        queued: '等待中',
        running: `下載中 ${pct}% · ${size}${j.speed ? ` · ${fmtBytes(j.speed)}/s` : ''}`,
        paused: `已暫停 ${size ? `· ${size}` : ''}`,
        done: `完成 · ${fmtBytes(j.total)}`,
        error: `失敗：${j.error}`,
      }[j.status] + ` · ${j.label || ''}`
    const del = btn('移除', async () => {
      const file = j.status === 'done' && confirm('要一併把影片檔丟到資源回收筒嗎？\n（按「取消」只從列表移除，檔案保留）')
      await window.hub.dl.remove(j.id, file)
    })
    if (j.status === 'done') btns.replaceChildren(btn('播放', () => playLocal(j), 'primary'), btn('開啟位置', () => window.hub.dl.show(j.id)), btn('影片頁', () => openVideo({ id: j.videoId, url: j.pageUrl, title: j.title, thumb: j.thumb })), del)
    else if (j.status === 'running' || j.status === 'queued') btns.replaceChildren(btn('暫停', () => window.hub.dl.pause(j.id)), del)
    else btns.replaceChildren(btn(j.status === 'error' ? '重試' : '繼續', () => window.hub.dl.resume(j.id), 'primary'), del)
  }
  update(j)
  return { el, update }
}

async function playLocal(j) {
  if (!(await window.hub.dl.exists(j.id))) return toast('找不到影片檔（可能被移動或刪除了）')
  openVideo({ id: j.videoId, url: j.pageUrl, title: j.title, thumb: j.thumb, duration: j.duration }, { local: j })
}

// ---------- 影片頁 / 播放器 ----------

let videoToken = 0
const videoStack = []
let currentVideo = null
let saveTimer = null

function closeVideo() {
  savePos()
  clearInterval(saveTimer)
  videoToken++
  const vid = $('video', player)
  if (vid) {
    vid.pause()
    vid.removeAttribute('src')
    vid.load()
  }
  player.classList.add('hidden')
  player.replaceChildren()
  videoStack.length = 0
  currentVideo = null
}

function savePos() {
  const vid = $('video.main', player)
  if (!currentVideo || !vid || !vid.duration) return
  saveHistory(currentVideo, vid.currentTime, vid.duration)
}

function pickSource(list) {
  const want = store.get('quality', 1080)
  return list.filter((s) => s.height <= want).pop() || list[0]
}

async function openVideo(v, { local = null, fromStack = false } = {}) {
  if (currentVideo && !fromStack) {
    savePos()
    videoStack.push(currentVideo)
  }
  clearInterval(saveTimer)
  const token = ++videoToken
  currentVideo = brief(v)
  player.classList.remove('hidden')
  player.scrollTop = 0

  const vid = h('video', { class: 'main', controls: true, preload: 'auto', poster: v.thumb || '' })
  const qBox = h('div', { class: 'quality' })
  const stage = h('div', { class: 'stage' }, vid)
  const back = h('button', { class: 'back', onclick: goBack, title: '返回 (Esc)' }, '← 返回')
  const infoBox = h('div', { class: 'vinfo' }, h('h1', {}, v.title || ''), loading())
  const relBox = h('div', { class: 'related' })
  player.replaceChildren(h('div', { class: 'vp' }, h('div', { class: 'vp-top' }, back, qBox), stage, infoBox, relBox))

  let sources = []
  let info = null
  const setSource = (src) => {
    const t = vid.currentTime
    const playing = !vid.paused
    vid.src = src.url
    for (const b of qBox.querySelectorAll('button')) b.classList.toggle('on', b.dataset.url === src.url)
    if (t) vid.currentTime = t
    if (playing || store.get('autoplay', true)) vid.play().catch(() => {})
  }
  const renderQuality = (cur) => {
    qBox.replaceChildren(
      ...sources.map((s) =>
        h('button', {
          class: `chip${s === cur ? ' on' : ''}`,
          'data-url': s.url,
          onclick: () => {
            if (!local) store.set('quality', s.height)
            setSource(s)
          },
        }, s.label),
      ),
    )
  }
  // 從上次看到的地方繼續（快看完的就從頭）
  const hist = historyOf(v.id)
  vid.addEventListener(
    'loadedmetadata',
    () => {
      if (store.get('resume', true) && hist && hist.pos > 5 && hist.pos < vid.duration - 15) {
        vid.currentTime = hist.pos
        toast(`從 ${fmtTime(hist.pos)} 繼續播放`)
      }
      saveHistory(currentVideo, vid.currentTime, vid.duration)
    },
    { once: true },
  )
  vid.addEventListener('pause', savePos)
  vid.addEventListener('error', () => {
    if (token !== videoToken || !vid.getAttribute('src')) return
    stage.querySelector('.verr')?.remove()
    stage.append(h('div', { class: 'verr' }, '播放失敗（網址可能過期）', h('button', { class: 'btn', onclick: () => openVideo(v, { local, fromStack: true }) }, '重新載入')))
  })
  saveTimer = setInterval(savePos, 10000)

  if (local) {
    sources = [{ label: `${local.label} · 本機`, height: local.height, url: local.fileUrl }]
    renderQuality(sources[0])
    setSource(sources[0])
  }

  // 影片資訊和播放網址同時抓
  const pInfo = site.video(v.url).catch((e) => e)
  const pSrc = local ? Promise.resolve(null) : window.hub.sources(v.url).catch((e) => e)
  const [ri, rs] = await Promise.all([pInfo, pSrc])
  if (token !== videoToken) return

  if (!local) {
    if (rs instanceof Error) {
      stage.append(h('div', { class: 'verr' }, `無法播放：${errText(rs)}`, h('button', { class: 'btn', onclick: () => openVideo(v, { fromStack: true }) }, '重試')))
    } else {
      sources = rs.sources
      const cur = pickSource(sources)
      renderQuality(cur)
      setSource(cur)
    }
  }

  if (ri instanceof Error) {
    infoBox.replaceChildren(h('h1', {}, v.title || ''), status(`讀不到影片資訊：${errText(ri)}`, () => openVideo(v, { local, fromStack: true })))
    return
  }
  info = ri
  currentVideo = brief({ ...v, ...info, title: info.title || v.title, thumb: v.thumb || info.thumb, duration: v.duration || info.duration })
  if (!vid.poster && info.thumb) vid.poster = info.thumb

  // 動作按鈕
  const favBtn = h('button', { class: 'btn' })
  const paintFav = () => (favBtn.textContent = isFav(v.id) ? '★ 已收藏' : '☆ 收藏')
  favBtn.onclick = () => {
    toggleFav(currentVideo)
    paintFav()
  }
  paintFav()
  const dlMenu = h('div', { class: 'menu hidden' })
  const dlBtn = h('button', { class: 'btn primary', onclick: (e) => {
    e.stopPropagation()
    dlMenu.classList.toggle('hidden')
  } }, '⬇ 下載')
  const fillDlMenu = (list) =>
    dlMenu.replaceChildren(
      ...list
        .slice()
        .reverse()
        .map((s) => h('button', { onclick: () => {
          dlMenu.classList.add('hidden')
          startDownload(currentVideo, s)
        } }, h('b', {}, s.label), h('span', { class: 'dim' }, s.size || ''))),
    )
  if (local) {
    // 本機播放時另外抓一次網址，才知道有哪些畫質能下載
    dlMenu.replaceChildren(loading())
    window.hub.sources(v.url).then((r) => token === videoToken && fillDlMenu(r.sources), () => token === videoToken && dlMenu.replaceChildren(status('讀不到下載網址')))
  } else if (sources.length) fillDlMenu(sources)
  else dlBtn.disabled = true

  const chipRow = (label, list) =>
    list.length
      ? h('div', { class: 'tagrow' }, h('span', { class: 'label' }, label), list.map((t) => h('button', { class: `tag ${t.kind}`, onclick: () => {
          closeVideo()
          nav('list', { kind: t.kind, slug: t.slug, name: t.name })
        } }, t.name)))
      : null

  infoBox.replaceChildren(
    h('h1', {}, currentVideo.title),
    h('div', { class: 'vmeta' }, [zhAgo(info.added), info.views && `${info.views} 次觀看`, info.duration, info.rating && `👍 ${info.rating}`].filter(Boolean).join(' · ')),
    h('div', { class: 'actions' }, h('div', { class: 'dl-wrap' }, dlBtn, dlMenu), favBtn, h('button', { class: 'btn', onclick: () => window.hub.config().then((c) => window.hub.external(new URL(v.url, c.base).href)) }, '在瀏覽器開啟')),
    info.uploader ? h('div', { class: 'uploader' }, info.uploader.avatar ? h('img', { src: info.uploader.avatar, alt: '' }) : null, h('span', {}, `上傳者：${info.uploader.name}`)) : null,
    info.desc ? h('div', { class: 'desc' }, info.desc) : null,
    chipRow('作者', info.models),
    chipRow('分類', info.categories),
    chipRow('標籤', info.tags),
  )
  if (info.related.length) relBox.replaceChildren(h('h2', {}, '相關影片'), h('div', { class: 'grid' }, info.related.map((r) => videoCard(r))))
}

document.addEventListener('click', () => $('.menu:not(.hidden)', player)?.classList.add('hidden'))

// ---------- 鍵盤 / 滑鼠 ----------

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
  if (e.key === 'Escape') {
    if (document.fullscreenElement) return
    if (!$('#overlay').classList.contains('hidden')) return closeOverlay()
    if (!player.classList.contains('hidden')) return goBack()
  }
  if (e.altKey && e.key === 'ArrowLeft') return goBack()
  if (typing || player.classList.contains('hidden')) return
  const vid = $('video.main', player)
  if (!vid) return
  // 影片本身有焦點時原生控制列會處理方向鍵和空白鍵，避免重複
  const native = e.target === vid
  if (e.key === ' ' || e.key === 'k') {
    if (native && e.key === ' ') return
    e.preventDefault()
    vid.paused ? vid.play() : vid.pause()
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !native) {
    e.preventDefault()
    vid.currentTime += e.key === 'ArrowLeft' ? -5 : 5
  } else if (e.key === 'j' || e.key === 'l') vid.currentTime += e.key === 'j' ? -10 : 10
  else if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : vid.requestFullscreen()
  else if (e.key === 'm') vid.muted = !vid.muted
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !native) {
    e.preventDefault()
    vid.volume = Math.min(1, Math.max(0, vid.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)))
  }
})
// 滑鼠側鍵「上一頁」
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) {
    e.preventDefault()
    goBack()
  }
})

// ---------- 程式內更新 / 更新紀錄 ----------

const REPO = 'DLIN131/ReelBox'
const ZIP_NAME = 'ReelBox-Windows.zip'

/** 目前版本的文字；version.js 由 CI 寫入（APP_VERSION = run_number），本機開發是 0 */
const versionText = () => (Number(window.APP_VERSION) ? `v1.0.${Number(window.APP_VERSION)}` : '開發版')

function openOverlay(...kids) {
  const box = h('div', { class: 'ov-box' }, h('button', { class: 'close', onclick: closeOverlay, title: '關閉 (Esc)' }, '×'), ...kids)
  $('#overlay').replaceChildren(box)
  $('#overlay').classList.remove('hidden')
  return box
}
function closeOverlay() {
  $('#overlay').classList.add('hidden')
  $('#overlay').replaceChildren()
}
$('#overlay').addEventListener('click', (e) => e.target.id === 'overlay' && closeOverlay())

/** 從 GitHub 的發布說明拿每一版的內容；抓不到（離線）就用上次存的 */
async function fetchChangelog() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = (await res.json())
      .map((r) => {
        const code = Number(String(r.tag_name || '').split('.').pop()) || 0
        // 發布說明：第一行是標題，下面是條列；--- 以下是固定的下載網址，Co-Authored-By 也不用給使用者看
        const lines = String(r.body || '')
          .split('\n---')[0]
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('Co-Authored-By'))
        return { code, date: (r.published_at || '').slice(0, 10), title: lines[0] || '', items: lines.slice(1).map((l) => l.replace(/^[-*•]\s*/, '')) }
      })
      .filter((r) => r.code)
      .sort((a, b) => b.code - a.code)
    store.set('changelog', list)
    return list
  } catch {
    return store.get('changelog', [])
  }
}

/** 更新紀錄視窗；since 有值時只顯示比它新的版本（剛更新完用） */
async function showChangelog({ since = 0, title = '更新紀錄' } = {}) {
  const box = openOverlay(h('h2', {}, title), loading())
  const list = (await fetchChangelog()).filter((r) => r.code > since)
  const cur = Number(window.APP_VERSION) || 0
  box.lastChild.replaceWith(
    list.length
      ? h(
          'div',
          { class: 'cl-list' },
          list.map((r) =>
            h(
              'div',
              { class: `cl-item${r.code === cur ? ' current' : ''}` },
              h('div', { class: 'cl-head' }, h('b', {}, `v1.0.${r.code}`), r.code === cur ? h('span', { class: 'cl-now' }, '目前版本') : null, h('span', { class: 'cl-date' }, r.date)),
              h('div', { class: 'cl-title' }, r.title),
              r.items.length ? h('ul', {}, r.items.map((i) => h('li', {}, i))) : null,
            ),
          ),
        )
      : status('讀不到更新紀錄（第一次查看需要網路）'),
  )
}

/** 更新後第一次開：自動顯示這次更新了什麼 */
function showWhatsNew() {
  const cur = Number(window.APP_VERSION) || 0
  if (!cur) return
  const seen = store.get('lastSeenVersion', 0)
  store.set('lastSeenVersion', cur)
  if (!seen || seen < cur) showChangelog({ since: seen || cur - 1, title: `已更新到 v1.0.${cur}` })
}

/** 檢查新版；有的話右下角跳更新提示。回傳 'dev' | 'latest' | 'shown' | 'error' */
async function checkUpdate(manual = false) {
  const cur = Number(window.APP_VERSION) || 0
  if (!cur) return 'dev'
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return 'error'
    const r = await res.json()
    const code = Number(String(r.tag_name || '').split('.').pop()) || 0
    const asset = (r.assets || []).find((a) => a.name === ZIP_NAME)
    if (code <= cur || !asset) return 'latest'
    if (!manual && store.get('skippedVersion', 0) === code) return 'latest'
    document.querySelector('.update-bar')?.remove()
    const notes = String(r.body || '')
      .split('\n---')[0]
      .split('\n')
      .filter((l) => !l.startsWith('Co-Authored-By'))
      .join('\n')
      .trim()
    const st = h('div', { class: 'status-line' })
    const primary = h('button', { class: 'btn primary' }, '立即更新')
    const skip = h('button', { class: 'btn' }, '略過這個版本')
    const later = h('button', { class: 'btn' }, '稍後')
    const bar = h('div', { class: 'update-bar' }, h('div', {}, h('b', {}, `發現新版本 v1.0.${code}`), `（目前 v1.0.${cur}）`, h('div', { class: 'notes' }, notes), st), h('div', { class: 'row' }, primary, skip, later))
    const inApp = window.updater && (await window.updater.supported().catch(() => false))
    let busy = false
    primary.onclick = async () => {
      if (!inApp) {
        window.hub.external(asset.browser_download_url)
        return bar.remove()
      }
      if (busy) return
      const active = [...jobs.values()].some((j) => j.status === 'running')
      if (active && !confirm('還有影片在下載，更新後會自動從中斷的地方繼續。要現在更新嗎？')) return
      busy = true
      primary.textContent = '下載中…'
      skip.disabled = later.disabled = true
      try {
        await window.updater.download(asset.browser_download_url, (p) => {
          st.textContent = p >= 0 ? `下載中 ${p}%` : '下載中…'
          if (p >= 100) st.textContent = '解壓縮中…'
        })
        st.textContent = '下載完成，程式會關閉並自動重新開啟'
        primary.textContent = '安裝中…'
        await window.updater.install()
      } catch (err) {
        busy = false
        primary.textContent = '重試'
        skip.disabled = later.disabled = false
        st.textContent = `更新失敗：${errText(err)}`
      }
    }
    skip.onclick = () => {
      store.set('skippedVersion', code)
      bar.remove()
    }
    later.onclick = () => bar.remove()
    document.body.append(bar)
    return 'shown'
  } catch {
    return 'error'
  }
}

// ---------- 啟動 ----------

for (const b of document.querySelectorAll('[data-nav]')) {
  b.addEventListener('click', () => {
    if (!player.classList.contains('hidden')) closeVideo()
    const n = b.dataset.nav
    if (n === 'categories' || n === 'models') nav('groups', { kind: n })
    else nav(n)
    if (n === 'categories' || n === 'models') for (const t of document.querySelectorAll('.tabs button')) t.classList.toggle('active', t.dataset.nav === n)
  })
}

const verEl = $('#version')
verEl.textContent = versionText()
verEl.onclick = (e) => {
  e.stopPropagation()
  showChangelog()
}

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const q = $('#searchInput').value.trim()
  if (!q) return
  // 貼上影片網址就直接開
  const m = q.match(/\/video\/(\d+)\/[^\s]*/)
  if (m) return openVideo({ id: m[1], url: new URL(q.startsWith('http') ? q : `https://x${q.startsWith('/') ? '' : '/'}${q}`).pathname, title: '' })
  if (!player.classList.contains('hidden')) closeVideo()
  nav('list', { kind: 'search', q })
})

window.addEventListener('beforeunload', savePos)

nav('home', {}, { push: false })
setTimeout(() => checkUpdate(), 2500)
showWhatsNew()

// 測試用
window.__app = { nav, openVideo, closeVideo, showChangelog, checkUpdate, jobs, site }
