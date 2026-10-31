import { store } from './store.js'
import { SITES, SITE_KEYS, siteOf } from './sites/index.js'

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

// ---------- 來源 ----------

// 站名、網址都由主程序提供（原始碼裡只有 Base64）
const siteCfg = await window.hub.config()
const siteLabel = (k) => siteCfg[k]?.label || k
let curSite = SITE_KEYS.includes(store.get('site')) ? store.get('site') : SITE_KEYS[0]
const siteBadge = (k) => h('span', { class: `site-badge ${k}` }, siteLabel(k))

function setSite(k, { go = true } = {}) {
  if (!SITES[k]) return
  curSite = k
  store.set('site', k)
  renderSiteSwitch()
  renderTabs()
  if (go) {
    if (!player.classList.contains('hidden')) closeVideo()
    backStack.length = 0
    nav('home', {}, { push: false })
  }
}

function renderSiteSwitch() {
  $('#siteSwitch').replaceChildren(...SITE_KEYS.map((k) => h('button', { class: k === curSite ? 'on' : '', title: `切換到 ${siteLabel(k)}`, onclick: () => k !== curSite && setSite(k) }, siteLabel(k))))
}

/** 上方分頁：首頁、該來源的分類類分頁、收藏、紀錄、下載、設定 */
function renderTabs() {
  const tabs = [['home', '首頁'], ...siteOf(curSite).groupTabs.map((g) => [`group:${g.kind}`, g.name]), ['favorites', '收藏'], ['history', '紀錄'], ['downloads', '下載'], ['settings', '設定']]
  $('#tabs').replaceChildren(
    ...tabs.map(([id, name]) =>
      h(
        'button',
        {
          'data-nav': id,
          onclick: () => {
            if (!player.classList.contains('hidden')) closeVideo()
            if (id.startsWith('group:')) nav('groups', { kind: id.slice(6) })
            else nav(id)
          },
        },
        name,
        id === 'downloads' ? h('span', { id: 'dlCount', class: 'dl-count hidden' }) : null,
      ),
    ),
  )
  markTab()
  updateDlCount()
}

function markTab() {
  const id = current.name === 'groups' ? `group:${current.params.kind}` : current.name
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.nav === id)
}

// ---------- 收藏 / 紀錄 ----------

// 舊資料沒有 site（只有第一個來源）
const vsite = (v) => v.site || 'rv'
const vkey = (v) => `${vsite(v)}:${v.id}`
const brief = (v) => ({ site: vsite(v), id: String(v.id), url: v.url, title: v.title, thumb: v.thumb, duration: v.duration || '', hd: !!v.hd, vertical: !!v.vertical, preview: v.preview || '' })
const isFav = (v) => store.get('favorites', []).some((x) => vkey(x) === vkey(v))

function toggleFav(v) {
  const list = store.get('favorites', [])
  const i = list.findIndex((x) => vkey(x) === vkey(v))
  if (i >= 0) list.splice(i, 1)
  else list.unshift({ ...brief(v), time: Date.now() })
  store.set('favorites', list)
  toast(i >= 0 ? '已取消收藏' : '已加入收藏')
  return i < 0
}

function saveHistory(v, pos, len) {
  if (!store.get('keepHistory', true)) return
  const list = store.get('history', []).filter((x) => vkey(x) !== vkey(v))
  list.unshift({ ...brief(v), time: Date.now(), pos: pos || 0, len: len || 0 })
  store.set('history', list.slice(0, 500))
}
const historyOf = (v) => store.get('history', []).find((x) => vkey(x) === vkey(v))

// ---------- 下載狀態 ----------

const jobs = new Map()
const dlListeners = new Set()

function updateDlCount() {
  const el = $('#dlCount')
  if (!el) return
  const n = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length
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
    const j = await window.hub.dl.add({ site: vsite(v), videoId: v.id, pageUrl: v.url, title: v.title, thumb: v.thumb, duration: v.duration, height: src.height, label: src.label })
    jobs.set(j.id, j)
    updateDlCount()
    toast(j.status === 'done' ? '這個畫質已經下載過了' : `已加入下載：${src.label}`)
  } catch (e) {
    toast(`無法下載：${errText(e)}`)
  }
}

// ---------- 影片卡片 ----------

let previewTimer = null
function videoCard(v, { extra = null, badge = false } = {}) {
  const thumb = h('div', { class: 'thumb' }, h('img', { src: v.thumb, loading: 'lazy', alt: '' }), v.duration ? h('span', { class: 'dur' }, v.duration) : null, v.hd ? h('span', { class: 'hd' }, 'HD') : null)
  const hist = historyOf(v)
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
  const meta = [v.author, zhAgo(v.added), v.views ? (/次/.test(v.views) ? v.views : `${v.views} 次觀看`) : '', v.rating ? `👍 ${v.rating}` : ''].filter(Boolean).join(' · ')
  return h(
    'div',
    { class: `card${v.vertical ? ' vertical' : ''}`, onclick: () => openVideo(v) },
    thumb,
    h('div', { class: 'title', title: v.title }, badge ? siteBadge(vsite(v)) : null, v.title),
    meta ? h('div', { class: 'meta' }, meta) : null,
    extra,
  )
}

/** 卡片放進格子；直式海報比較窄，整頁都是海報時格子也縮小 */
function gridOf(cards, items) {
  const grid = h('div', { class: 'grid' }, cards)
  if (items && items.length && items.every((v) => v.vertical)) grid.classList.add('posters')
  return grid
}

/** 會一直往下載入的列表；loader(page) → { items, hasMore } */
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
      if (page === 1 && r.items.length && r.items.every((v) => v.vertical)) grid.classList.add('posters')
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
  if (push && current) backStack.push({ ...current, site: curSite, scroll: view.scrollTop })
  if (backStack.length > 50) backStack.shift()
  current = { name, params }
  navToken++
  scrollHook = null
  view.replaceChildren()
  view.scrollTop = 0
  markTab()
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
  if (!prev) return
  if (prev.site && prev.site !== curSite) setSite(prev.site, { go: false })
  nav(prev.name, prev.params, { push: false })
}

/** 篩選列：內容類型 + 排序 */
function filterBar(params, { sorts, types = null, remember = true }) {
  // 首頁 / 分類列表記住上次選的類型；搜尋每次從「全部」開始
  const typeKey = `type_${curSite}`
  const type = types ? params.type ?? (remember ? store.get(typeKey, '') : '') : ''
  const sort = params.sort ?? sorts[0]?.id ?? ''
  const bar = h('div', { class: 'filters' })
  if (types) {
    bar.append(
      h(
        'div',
        { class: 'chips' },
        types.map((t) =>
          h(
            'button',
            {
              class: `chip${t.id === type ? ' on' : ''}`,
              onclick: () => {
                if (remember) store.set(typeKey, t.id)
                nav(current.name, { ...params, type: t.id }, { push: false })
              },
            },
            t.name,
          ),
        ),
      ),
    )
  }
  if (sorts.length) {
    const sel = h('select', { class: 'sort', onchange: () => nav(current.name, { ...params, sort: sel.value }, { push: false }) }, sorts.map((s) => h('option', { value: s.id, selected: s.id === sort }, s.name)))
    bar.append(h('label', { class: 'sort-wrap' }, '排序', sel))
  }
  return { bar, type, sort }
}

/** 收藏 / 紀錄的來源篩選 */
function siteFilter(key, onChange) {
  const cur = store.get(key, '')
  return h(
    'div',
    { class: 'chips' },
    [['', '全部'], ...SITE_KEYS.map((k) => [k, siteLabel(k)])].map(([k, name]) =>
      h(
        'button',
        {
          class: `chip${k === cur ? ' on' : ''}`,
          onclick: () => {
            store.set(key, k)
            onChange()
          },
        },
        name,
      ),
    ),
  )
}

const pages = {
  home(params) {
    const s = siteOf(curSite)
    const { bar, type, sort } = filterBar(params, { sorts: s.filters.sorts, types: s.filters.types })
    view.append(h('div', { class: 'page-head' }, h('h1', {}, siteLabel(curSite)), bar))
    infiniteGrid(view, (page) => s.list({ kind: 'latest', page, sort, type }), (v) => videoCard(v))
  },

  list(params) {
    const { kind, slug, q, name } = params
    const s = siteOf(curSite)
    const { bar, type, sort } = filterBar(params, { sorts: kind === 'search' ? s.filters.searchSorts : s.filters.sorts, types: curSite === 'h1' ? s.filters.types : kind === 'search' ? null : s.filters.types, remember: kind !== 'search' })
    const label = { search: '搜尋', tags: '標籤', categories: '分類', models: '作者' }[kind]
    const title = h('h1', {}, h('span', { class: 'dim' }, `${label}：`), kind === 'search' ? q : name || slug)
    const key = `${curSite}/${kind}/${kind === 'search' ? q : slug}`
    const follows = () => store.get('follows', [])
    const on = () => follows().some((f) => f.key === key)
    const btn = h('button', { class: 'btn small' })
    const paint = () => (btn.textContent = on() ? '★ 已追蹤' : '☆ 追蹤')
    btn.onclick = () => {
      const list = follows().filter((f) => f.key !== key)
      if (!on()) list.unshift({ key, site: curSite, kind, slug: kind === 'search' ? q : slug, name: kind === 'search' ? q : name || slug })
      store.set('follows', list)
      paint()
    }
    paint()
    title.append(btn)
    view.append(h('div', { class: 'page-head' }, title, bar))
    infiniteGrid(view, (page) => s.list({ kind, slug, q, page, sort, type }), (v) => videoCard(v))
  },

  async groups(params) {
    const kind = params.kind
    const s = siteOf(curSite)
    const tab = s.groupTabs.find((g) => g.kind === kind) || s.groupTabs[0]
    if (!tab) return nav('home', {}, { push: false })
    const { bar, sort } = filterBar(params, { sorts: s.groupSorts(kind) })
    view.append(h('div', { class: 'page-head' }, h('h1', {}, tab.name), bar))
    const follows = store.get('follows', []).filter((f) => (f.site || 'rv') === curSite)
    if (follows.length) {
      view.append(
        h(
          'div',
          { class: 'follow-row' },
          h('span', { class: 'dim' }, '追蹤中：'),
          follows.map((f) => h('button', { class: 'chip on', onclick: () => nav('list', f.kind === 'search' ? { kind: 'search', q: f.slug } : { kind: f.kind, slug: f.slug, name: f.name }) }, f.name)),
        ),
      )
    }
    const openGroup = (g) => nav('list', { kind, slug: g.slug, name: g.name })
    // 標籤這種沒有圖的，整組列成按鈕
    if (!s.groupSorts(kind).length && kind === 'tags') {
      const box = h('div', {}, loading())
      view.append(box)
      const token = navToken
      try {
        const r = await s.groups(kind)
        if (token !== navToken) return
        box.replaceChildren(...r.sections.map((sec) => h('section', { class: 'tag-section' }, h('h2', {}, sec.title), h('div', { class: 'chips' }, sec.items.map((g) => h('button', { class: 'chip', onclick: () => openGroup(g) }, g.name))))))
      } catch (e) {
        box.replaceChildren(status(`載入失敗：${errText(e)}`, () => nav('groups', params, { push: false })))
      }
      return
    }
    infiniteGrid(
      view,
      (page) => s.groups(kind, page, sort),
      (g) =>
        h(
          'div',
          { class: `gcard ${kind}`, onclick: () => openGroup(g) },
          h('div', { class: 'gimg' }, g.img ? h('img', { src: g.img, loading: 'lazy', alt: '' }) : h('span', {}, g.name.slice(0, 1).toUpperCase())),
          h('div', { class: 'gname' }, g.name),
          g.count ? h('div', { class: 'meta' }, g.count) : null,
        ),
    )
  },

  favorites() {
    const filterKey = 'favSite'
    const all = store.get('favorites', [])
    const f = store.get(filterKey, '')
    const list = all.filter((v) => !f || vsite(v) === f)
    view.append(h('div', { class: 'page-head' }, h('h1', {}, `收藏（${list.length}）`), h('div', { class: 'filters' }, siteFilter(filterKey, () => nav('favorites', {}, { push: false })))))
    if (!list.length) return view.append(status('還沒有收藏。在影片頁按「☆ 收藏」加入。'))
    const cards = list.map((v) => {
      const rm = h(
        'button',
        {
          class: 'card-x',
          title: '取消收藏',
          onclick: (e) => {
            e.stopPropagation()
            toggleFav(v)
            card.remove()
          },
        },
        '×',
      )
      const card = videoCard(v, { extra: rm, badge: true })
      return card
    })
    view.append(gridOf(cards, list))
  },

  history() {
    const filterKey = 'histSite'
    const f = store.get(filterKey, '')
    const list = store.get('history', []).filter((v) => !f || vsite(v) === f)
    const clear = h(
      'button',
      {
        class: 'btn small',
        onclick: () => {
          if (!confirm('清除全部觀看紀錄？')) return
          store.set('history', [])
          nav('history', {}, { push: false })
        },
      },
      '清除紀錄',
    )
    view.append(h('div', { class: 'page-head' }, h('h1', {}, '觀看紀錄'), h('div', { class: 'filters' }, siteFilter(filterKey, () => nav('history', {}, { push: false })), clear)))
    if (!list.length) return view.append(status('還沒有觀看紀錄'))
    view.append(gridOf(list.map((v) => videoCard({ ...v, added: '' }, { badge: true, extra: h('div', { class: 'meta' }, `${new Date(v.time).toLocaleString()}${v.len ? ` · 看到 ${fmtTime(v.pos)} / ${fmtTime(v.len)}` : ''}`) })), list))
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
      for (const j of list)
        if (!rows.has(j.id)) {
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
    const checkBtn = h(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          st.textContent = '檢查中…'
          const r = await checkUpdate(true)
          st.textContent = { dev: '開發版不檢查更新', latest: '已經是最新版', shown: '有新版本，請看右下角', error: '檢查失敗（網路問題？）' }[r]
        },
      },
      '檢查更新',
    )
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

    // 各來源網址
    const rows = SITE_KEYS.map((k) => {
      const inp = h('input', { type: 'text', class: 'input', spellcheck: false, value: siteCfg[k].base })
      return h(
        'div',
        { class: 'row' },
        h('b', { class: 'site-name' }, siteLabel(k)),
        inp,
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                const c = await window.hub.setBase(k, inp.value)
                Object.assign(siteCfg, c)
                inp.value = c[k].base
                toast('已儲存')
              } catch (e) {
                toast(errText(e))
              }
            },
          },
          '儲存',
        ),
      )
    })
    box.append(section('連線', h('div', { class: 'dim' }, '網站換網域時可以在這裡改（清空後儲存恢復預設）'), ...rows))
  },
}

function dlRow(j) {
  const bar = h('i')
  const info = h('div', { class: 'dl-info' })
  const btns = h('div', { class: 'dl-btns' })
  const el = h('div', { class: 'dl-row' }, h('img', { src: j.thumb, alt: '' }), h('div', { class: 'dl-main' }, h('div', { class: 'title' }, siteBadge(vsite(j)), j.title), h('div', { class: 'bar' }, bar), info), btns)
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
    const page = () => openVideo({ site: vsite(j), id: j.videoId, url: j.pageUrl, title: j.title, thumb: j.thumb })
    if (j.status === 'done') btns.replaceChildren(btn('播放', () => playLocal(j), 'primary'), btn('開啟位置', () => window.hub.dl.show(j.id)), btn('影片頁', page), del)
    else if (j.status === 'running' || j.status === 'queued') btns.replaceChildren(btn('暫停', () => window.hub.dl.pause(j.id)), del)
    else btns.replaceChildren(btn(j.status === 'error' ? '重試' : '繼續', () => window.hub.dl.resume(j.id), 'primary'), del)
  }
  update(j)
  return { el, update }
}

async function playLocal(j) {
  if (!(await window.hub.dl.exists(j.id))) return toast('找不到影片檔（可能被移動或刪除了）')
  openVideo({ site: vsite(j), id: j.videoId, url: j.pageUrl, title: j.title, thumb: j.thumb, duration: j.duration }, { local: j })
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

/** 影片頁裡的標籤 / 作者按鈕：開該來源的列表 */
function openTag(siteKey, t) {
  closeVideo()
  if (siteKey !== curSite) setSite(siteKey, { go: false })
  if (t.kind === 'search') nav('list', { kind: 'search', q: t.slug })
  else nav('list', { kind: t.kind, slug: t.slug, name: t.name })
}

async function openVideo(v, { local = null, fromStack = false } = {}) {
  if (currentVideo && !fromStack) {
    savePos()
    videoStack.push(currentVideo)
  }
  clearInterval(saveTimer)
  const token = ++videoToken
  const sk = vsite(v)
  const s = siteOf(sk)
  currentVideo = brief(v)
  player.classList.remove('hidden')
  player.scrollTop = 0

  const vid = h('video', { class: 'main', controls: true, preload: 'auto', poster: v.vertical ? '' : v.thumb || '' })
  const qBox = h('div', { class: 'quality' })
  const stage = h('div', { class: 'stage' }, vid)
  const back = h('button', { class: 'back', onclick: goBack, title: '返回 (Esc)' }, '← 返回')
  const infoBox = h('div', { class: 'vinfo' }, h('h1', {}, v.title || ''), loading())
  const listBox = h('div', { class: 'related' })
  const relBox = h('div', { class: 'related' })
  player.replaceChildren(h('div', { class: 'vp' }, h('div', { class: 'vp-top' }, back, siteBadge(sk), qBox), stage, infoBox, listBox, relBox))

  let sources = []
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
      ...sources.map((x) =>
        h(
          'button',
          {
            class: `chip${x === cur ? ' on' : ''}`,
            'data-url': x.url,
            onclick: () => {
              if (!local) store.set('quality', x.height)
              setSource(x)
            },
          },
          x.label,
        ),
      ),
    )
  }
  // 從上次看到的地方繼續（快看完的就從頭）
  const hist = historyOf(v)
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
  const pInfo = s.video(v.url).catch((e) => e)
  const pSrc = local ? Promise.resolve(null) : window.hub.sources(sk, v.url).catch((e) => e)
  const [info, rs] = await Promise.all([pInfo, pSrc])
  if (token !== videoToken) return

  if (!local) {
    if (rs instanceof Error) {
      stage.append(h('div', { class: 'verr' }, `無法播放：${errText(rs)}`, h('button', { class: 'btn', onclick: () => openVideo(v, { fromStack: true }) }, '重試')))
    } else {
      sources = rs.sources
      const cur = pickSource(sources)
      renderQuality(cur)
      setSource(cur)
      if (!vid.poster && rs.poster) vid.poster = rs.poster
    }
  }

  if (info instanceof Error) {
    infoBox.replaceChildren(h('h1', {}, v.title || ''), status(`讀不到影片資訊：${errText(info)}`, () => openVideo(v, { local, fromStack: true })))
    return
  }
  currentVideo = brief({ ...v, title: info.title || v.title, thumb: v.thumb || info.thumb, duration: v.duration || info.duration })
  if (!vid.poster && info.thumb) vid.poster = info.thumb

  // 動作按鈕
  const favBtn = h('button', { class: 'btn' })
  const paintFav = () => (favBtn.textContent = isFav(currentVideo) ? '★ 已收藏' : '☆ 收藏')
  favBtn.onclick = () => {
    toggleFav(currentVideo)
    paintFav()
  }
  paintFav()
  const dlMenu = h('div', { class: 'menu hidden' })
  const dlBtn = h(
    'button',
    {
      class: 'btn primary',
      onclick: (e) => {
        e.stopPropagation()
        dlMenu.classList.toggle('hidden')
      },
    },
    '⬇ 下載',
  )
  const fillDlMenu = (list) => {
    const rows = list
      .slice()
      .reverse()
      .map((x) => {
        const size = h('span', { class: 'dim' }, x.size || '')
        const b = h(
          'button',
          {
            onclick: () => {
              dlMenu.classList.add('hidden')
              startDownload(currentVideo, x)
            },
          },
          h('b', {}, x.label),
          size,
        )
        return { b, size, x }
      })
    dlMenu.replaceChildren(...rows.map((r) => r.b))
    // 網站沒附檔案大小的，另外問 CDN
    const missing = rows.filter((r) => !r.x.size)
    if (missing.length)
      window.hub.sizes(sk, missing.map((r) => r.x.url)).then((ns) => ns.forEach((n, i) => n && (missing[i].size.textContent = fmtBytes(n))), () => {})
  }
  if (local) {
    // 本機播放時另外抓一次網址，才知道有哪些畫質能下載
    dlMenu.replaceChildren(loading())
    window.hub.sources(sk, v.url).then(
      (r) => token === videoToken && fillDlMenu(r.sources),
      () => token === videoToken && dlMenu.replaceChildren(status('讀不到下載網址')),
    )
  } else if (sources.length) fillDlMenu(sources)
  else dlBtn.disabled = true

  const chipRow = (row) =>
    row.items.length ? h('div', { class: 'tagrow' }, h('span', { class: 'label' }, row.label), row.items.map((t) => h('button', { class: `tag ${t.kind}`, onclick: () => openTag(sk, t) }, t.name))) : null

  infoBox.replaceChildren(
    h('h1', {}, currentVideo.title),
    h('div', { class: 'vmeta' }, [zhAgo(info.added), info.views && (/次/.test(info.views) ? `觀看 ${info.views}` : `${info.views} 次觀看`), info.duration, info.rating && `👍 ${info.rating}`].filter(Boolean).join(' · ')),
    h(
      'div',
      { class: 'actions' },
      h('div', { class: 'dl-wrap' }, dlBtn, dlMenu),
      favBtn,
      h('button', { class: 'btn', onclick: () => window.hub.external(new URL(v.url, siteCfg[sk].base).href) }, '在瀏覽器開啟'),
    ),
    info.uploader ? h('div', { class: 'uploader' }, info.uploader.avatar ? h('img', { src: info.uploader.avatar, alt: '' }) : null, h('span', {}, `上傳者：${info.uploader.name}`)) : null,
    info.desc ? h('div', { class: 'desc' }, info.desc) : null,
    ...info.rows.map(chipRow).filter(Boolean),
  )
  if (info.playlist.length > 1) listBox.replaceChildren(h('h2', {}, '同系列 / 播放清單'), gridOf(info.playlist.map((r) => videoCard(r)), info.playlist))
  if (info.related.length) relBox.replaceChildren(h('h2', {}, '相關影片'), gridOf(info.related.map((r) => videoCard(r)), info.related))
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

$('.brand').onclick = () => {
  if (!player.classList.contains('hidden')) closeVideo()
  nav('home')
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
  // 貼上影片網址就直接開（看網址是哪個來源的）
  if (/^https?:\/\//.test(q) || /watch\?v=|\/video\/\d+/.test(q)) {
    let host = ''
    try {
      host = new URL(q).hostname
    } catch {}
    const order = [...SITE_KEYS].sort((a, b) => (host && new URL(siteCfg[b].base).hostname === host) - (host && new URL(siteCfg[a].base).hostname === host))
    for (const k of order) {
      const m = SITES[k].matchUrl(q)
      if (m) return openVideo({ site: k, id: m.id, url: m.url, title: '' })
    }
  }
  if (!player.classList.contains('hidden')) closeVideo()
  nav('list', { kind: 'search', q })
})

window.addEventListener('beforeunload', savePos)

renderSiteSwitch()
renderTabs()
nav('home', {}, { push: false })
setTimeout(() => checkUpdate(), 2500)
showWhatsNew()

// 測試用
window.__app = { nav, openVideo, closeVideo, setSite, showChangelog, checkUpdate, jobs, SITES }
