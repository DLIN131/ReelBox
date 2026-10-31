// rv 站：把 HTML 解析成程式用的資料（影片列表、影片資訊、分類 / 作者列表）
const KEY = 'rv'
const parser = new DOMParser()
const doc = (html) => parser.parseFromString(html, 'text/html')
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const get = (url) => window.hub.get(KEY, url)

export const key = KEY

export const filters = {
  // 內容類型（網站的 flag1 參數）
  types: [
    { id: '', name: '全部' },
    { id: '2109', name: '異性' },
    { id: '192', name: '男同' },
    { id: '15', name: '扶她' },
    { id: '4747', name: '音樂' },
    { id: '1821', name: 'Iwara' },
  ],
  sorts: [
    { id: '', name: '最新' },
    { id: 'video_viewed', name: '最多觀看' },
    { id: 'rating', name: '最高評分' },
    { id: 'duration', name: '最長' },
    { id: 'pseudo_rand', name: '隨機' },
  ],
  searchSorts: [
    { id: '', name: '最相關' },
    { id: 'post_date', name: '最新' },
    { id: 'video_viewed', name: '最多觀看' },
    { id: 'rating', name: '最高評分' },
    { id: 'duration', name: '最長' },
  ],
}

export const groupTabs = [
  { kind: 'categories', name: '分類' },
  { kind: 'models', name: '作者' },
]

export function groupSorts(kind) {
  return kind === 'models'
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
}

/** 貼上的網址是不是這個站的影片頁 */
export function matchUrl(u) {
  const m = u.match(/\/video\/(\d+)\/[^\s?#]*/)
  return m ? { id: m[1], url: m[0] } : null
}

/** 列表頁的網址。kind: latest / search / tags / categories / models */
function listUrl({ kind = 'latest', slug = '', q = '', page = 1, sort = '', type = '' }) {
  let p
  if (kind === 'search') p = `/search/${encodeURIComponent(q.trim().toLowerCase().replace(/\s+/g, '-'))}/`
  else if (kind === 'latest') p = '/latest-updates/'
  else p = `/${kind}/${slug}/`
  if (page > 1) p += `${page}/`
  const qs = new URLSearchParams()
  if (sort) qs.set('sort_by', sort)
  if (type) qs.set('flag1', type)
  const s = qs.toString()
  return s ? `${p}?${s}` : p
}

function lastPage(d) {
  let max = 1
  for (const a of d.querySelectorAll('.pagination a')) {
    const m = (a.getAttribute('data-parameters') || '').match(/from[^:]*:(\d+)/) || (a.getAttribute('href') || '').match(/\/(\d+)\/?(?:\?|$)/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

function parseCards(root, skipId = '') {
  const out = []
  const seen = new Set()
  for (const el of root.querySelectorAll('[data-video-card-id]')) {
    const id = el.getAttribute('data-video-card-id')
    if (!id || id === skipId || seen.has(id)) continue
    const a = el.querySelector('a.th[href*="/video/"]')
    if (!a) continue
    seen.add(id)
    const img = el.querySelector('img.thumb')
    out.push({
      site: KEY,
      id,
      url: a.getAttribute('href'),
      title: a.getAttribute('title') || txt(el.querySelector('.thumb_title')),
      thumb: img ? img.getAttribute('data-rd-jpg') || img.getAttribute('src') || '' : '',
      preview: el.querySelector('[data-preview]')?.getAttribute('data-preview') || '',
      duration: txt(el.querySelector('.time')),
      hd: !!el.querySelector('.quality'),
      added: txt(el.querySelector('.added')),
      rating: txt(el.querySelector('.rating')),
      views: txt(el.querySelector('.video-views-count')),
    })
  }
  return out
}

export async function list(opts) {
  const d = doc(await get(listUrl(opts)))
  const items = parseCards(d)
  const page = opts.page || 1
  return { items, page, hasMore: items.length > 0 && page < lastPage(d) }
}

/** 影片頁：資訊、標籤、作者、相關影片（播放網址另外由主程序抓，見 hub.sources） */
export async function video(url) {
  const d = doc(await get(url))
  const id = (url.match(/\/video\/(\d+)/) || [])[1] || ''
  const meta = [...d.querySelectorAll('.vp-meta .item_info span')].map(txt)
  const links = (sel) => {
    const seen = new Set()
    return [...d.querySelectorAll(sel)]
      .map((a) => {
        const m = (a.getAttribute('href') || '').match(/\/(tags|categories|models)\/([^/?#]+)/)
        return m && { kind: m[1], slug: m[2], name: txt(a.querySelector('.name')) || txt(a) }
      })
      .filter((x) => x && x.name && !seen.has(x.kind + x.slug) && seen.add(x.kind + x.slug))
  }
  const uploader = d.querySelector('.vp-credits a[href*="/members/"]')
  const ld = (() => {
    try {
      return JSON.parse(d.querySelector('script[type="application/ld+json"]')?.textContent || '{}')
    } catch {
      return {}
    }
  })()
  return {
    id,
    url,
    title: txt(d.querySelector('h1.title_video')) || ld.name || '',
    desc: (d.querySelector('.vp-desc')?.innerText ?? txt(d.querySelector('.vp-desc'))).trim(),
    added: meta[0] || '',
    views: meta[1] || '',
    duration: meta[2] || '',
    rating: txt(d.querySelector('.vp-voters')),
    thumb: ld.thumbnailUrl || d.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
    uploader: uploader ? { name: txt(uploader), avatar: uploader.querySelector('img')?.getAttribute('src') || '' } : null,
    rows: [
      { label: '作者', items: links('.vp-tags a[href*="/models/"]') },
      { label: '分類', items: links('.vp-tags a[href*="/categories/"]') },
      { label: '標籤', items: links('.vp-tags a[href*="/tags/"]') },
    ],
    playlist: [],
    related: parseCards(d, id),
  }
}

/** 分類 / 作者列表 */
export async function groups(kind, page = 1, sort = '') {
  let p = `/${kind}/` + (page > 1 ? `${page}/` : '')
  if (sort) p += `?sort_by=${sort}`
  const d = doc(await get(p))
  const out = []
  const seen = new Set()
  for (const a of d.querySelectorAll(`a[href*="/${kind}/"]`)) {
    if (a.closest('.aside_wrap, header, footer, nav, .pagination')) continue
    const m = (a.getAttribute('href') || '').match(new RegExp(`/${kind}/([^/?#]+)/?$`))
    if (!m || /^\d+$/.test(m[1]) || seen.has(m[1])) continue
    const img = a.querySelector('img')
    const name = txt(a.querySelector('.thumb_title, .name')) || img?.getAttribute('alt') || ''
    if (!name) continue
    seen.add(m[1])
    out.push({ slug: m[1], name, img: img?.getAttribute('src') || '', count: txt(a.querySelector('.count')) })
  }
  return { items: out, page, hasMore: out.length > 0 && page < lastPage(d) }
}
