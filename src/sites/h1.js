// h1 站：沒有 API，全部從 HTML 解析（列表都是 /search 加參數）
const KEY = 'h1'
const parser = new DOMParser()
const doc = (html) => parser.parseFromString(html, 'text/html')
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const get = (url) => window.hub.get(KEY, url)
const b64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export const key = KEY

// 類型名稱要跟網站的查詢參數完全一致
const GENRES = b64('6KOP55WqLOazoem6teeVqixNb3Rpb24gQW5pbWUsM0RDRywyLjVELDJE5YuV55WrLEFJ55Sf5oiQLE1NRCxDb3NwbGF5').split(',')
const SORTS = ['最新上市', '最新上傳', '本日排行', '本週排行', '本月排行', '觀看次數', '讚好比例', '時長最長', '他們在看']

export const filters = {
  types: [{ id: '', name: '全部' }, ...GENRES.map((g) => ({ id: g, name: g }))],
  sorts: [{ id: '', name: '預設' }, ...SORTS.map((s) => ({ id: s, name: s }))],
  searchSorts: [{ id: '', name: '最相關' }, ...SORTS.map((s) => ({ id: s, name: s }))],
}

export const groupTabs = [{ kind: 'tags', name: '標籤' }]
export const groupSorts = () => []

export function matchUrl(u) {
  const m = u.match(/watch\?v=(\d+)/)
  return m ? { id: m[1], url: `/watch?v=${m[1]}` } : null
}

/** kind: latest（類型 + 排序）/ search（關鍵字）/ tags（標籤） */
function listUrl({ kind = 'latest', slug = '', q = '', page = 1, sort = '', type = '' }) {
  const qs = new URLSearchParams()
  if (kind === 'search' && q.trim()) qs.set('query', q.trim())
  if (type) qs.set('genre', type)
  if (kind === 'tags' && slug) qs.append('tags[]', slug)
  if (sort) qs.set('sort', sort)
  if (page > 1) qs.set('page', page)
  const s = qs.toString()
  return s ? `/search?${s}` : '/search'
}

/** 把一堆指向 watch?v= 的連結整理成影片卡片（同一部的縮圖連結和標題連結會合併） */
function parseCards(links, skipId = '') {
  const out = new Map()
  for (const a of links) {
    const id = ((a.getAttribute('href') || '').match(/watch\?v=(\d+)/) || [])[1]
    if (!id || id === skipId) continue
    const prev = out.get(id) || {}
    // 往上找包住這張卡片的容器（裡面有標題），最多 4 層
    let card = a
    for (let p = a.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
      if (p.classList.contains('video-item-container') || p.querySelector('.video-title, .title, .home-rows-videos-title')) {
        card = p
        break
      }
    }
    const img = a.querySelector('img') || card.querySelector('img')
    const thumb = img?.getAttribute('src') || ''
    const title = txt(a.querySelector('.title, .home-rows-videos-title, .video-title')) || txt(card.querySelector('.video-title, .title, .home-rows-videos-title')) || card.getAttribute('title') || a.getAttribute('title') || ''
    const stats = [...new Set([...a.querySelectorAll('.stat-item'), ...card.querySelectorAll('.stat-item')].map((s) => txt(s)))]
    out.set(id, {
      site: KEY,
      id,
      url: `/watch?v=${id}`,
      title: title || prev.title || '',
      thumb: thumb || prev.thumb || '',
      vertical: thumb.includes('/cover/') || !!prev.vertical,
      duration: txt(a.querySelector('.duration') || card.querySelector('.duration')) || prev.duration || '',
      rating: (stats.find((s) => s.includes('%')) || '').replace('thumb_up', '').trim() || prev.rating || '',
      views: stats.find((s) => s.includes('次')) || prev.views || '',
      added: txt(card.querySelector('.subtitle-time')).replace(/^•\s*/, '') || prev.added || '',
      author: txt(card.querySelector('.subtitle a')) || prev.author || '',
    })
  }
  // 廣告或沒有封面的雜訊連結就不要了
  return [...out.values()].filter((v) => v.thumb || v.title)
}

export async function list(opts) {
  const page = opts.page || 1
  const d = doc(await get(listUrl(opts)))
  const items = parseCards(d.querySelectorAll('a[href*="watch?v="]'))
  return { items, page, hasMore: items.length > 0 && !!d.querySelector(`a[href*="page=${page + 1}"]`) }
}

/** 標籤連結：/search?tags[]=X 是標籤，/search?query=X 是關鍵字（作品名、角色） */
function tagFrom(a) {
  const href = a.getAttribute('href') || ''
  let u
  try {
    u = new URL(href, 'https://x')
  } catch {
    return null
  }
  const name = txt(a).replace(/^#\s*/, '').replace(/\s*\(\d+\)$/, '').trim()
  if (!name || name === 'add' || name === 'remove') return null
  const tag = u.searchParams.get('tags[]')
  if (tag) return { kind: 'tags', slug: tag, name }
  const q = u.searchParams.get('query')
  if (q) return { kind: 'search', slug: q, name }
  return null
}

export async function video(url) {
  const d = doc(await get(url))
  const id = (url.match(/watch\?v=(\d+)/) || [])[1] || ''
  const infoLine = [...d.querySelectorAll('.video-details-wrapper, .video-description-panel div')].map(txt).find((t) => t.startsWith('觀看次數')) || ''
  const views = (infoLine.match(/觀看次數[:：]\s*(\S+次)/) || [])[1] || ''
  const added = (infoLine.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || ''
  const artistEl = d.querySelector('#video-artist-name')
  const artist = txt(artistEl)
  const avatar = artistEl?.closest('.video-details-wrapper')?.querySelector('img[src*="avatar"]:not(#video-user-avatar)')?.getAttribute('src') || ''
  const seen = new Set()
  const tags = [...d.querySelectorAll('.single-video-tag a[href]')].map(tagFrom).filter((t) => t && !seen.has(t.kind + t.slug) && seen.add(t.kind + t.slug))
  const capEl = d.querySelector('.video-caption-text')
  return {
    id,
    url,
    title: txt(d.querySelector('#shareBtn-title')) || d.title.split(' - ')[0].trim(),
    desc: (capEl?.innerText ?? txt(capEl) ?? '').trim(),
    added,
    views,
    duration: '',
    rating: '',
    thumb: d.querySelector('meta[property="og:image"]')?.getAttribute('content') || d.querySelector('video[poster]')?.getAttribute('poster') || '',
    uploader: artist ? { name: artist, avatar } : null,
    rows: [
      { label: '作者', items: artist ? [{ kind: 'search', slug: artist, name: artist }] : [] },
      { label: '作品', items: tags.filter((t) => t.kind === 'search') },
      { label: '標籤', items: tags.filter((t) => t.kind === 'tags') },
    ],
    playlist: parseCards(d.querySelectorAll('#playlist-scroll a[href*="watch?v="]')),
    related: parseCards(d.querySelectorAll('#related-tabcontent a[href*="watch?v="]'), id),
  }
}

let tagCache = null

/** 標籤列表：搜尋頁的「內容標籤」視窗裡，每個 <h5> 是一組，下面是該組的勾選框 */
export async function groups() {
  if (!tagCache) {
    const d = doc(await get('/search'))
    const sections = []
    for (const inp of d.querySelectorAll('input[name="tags[]"]')) {
      // 往前找最近的 <h5> 當組名
      let el = inp.closest('label') || inp
      let head = null
      while (el && !head) {
        let p = el.previousElementSibling
        while (p && p.tagName !== 'H5') p = p.previousElementSibling
        head = p
        el = el.parentElement
      }
      const title = head ? head.childNodes[0]?.textContent.trim() || txt(head) : '其他'
      let sec = sections.find((s) => s.title === title)
      if (!sec) sections.push((sec = { title, items: [] }))
      const v = inp.getAttribute('value')
      if (v && !sec.items.some((x) => x.slug === v)) sec.items.push({ slug: v, name: v })
    }
    tagCache = sections.filter((s) => s.items.length)
  }
  return { sections: tagCache, hasMore: false }
}
