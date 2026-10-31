// 各來源的解析器；每個都提供 filters / groupTabs / list / video / groups / matchUrl
import * as rv from './rv.js'
import * as h1 from './h1.js'

export const SITES = { rv, h1 }
export const SITE_KEYS = Object.keys(SITES)
export const siteOf = (k) => SITES[k] || rv
