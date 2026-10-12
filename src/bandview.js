// 状态带「文档评审」卡片的显示规则和桌面版用的小图（图标、状态标签），都是纯函数。

import { baseName } from './band.js'

/** 卡片里最多直接列出几个文档，多出来的折叠成「还有 N 个文档」。*/
export const MAX_ROWS = 3

/** @typedef {import('./band.js').DocSummary} DocSummary */

/**
 * 文档所在目录：在工作目录下时显示相对目录（末尾带 /，就在根目录时为 ./），否则显示绝对目录。
 * @param {string} path @param {string} cwd
 */
export function dirOf(path, cwd) {
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  if (cwd) {
    const root = cwd.endsWith('/') ? cwd : `${cwd}/`
    if (dir === root) return './'
    if (dir.startsWith(root)) return dir.slice(root.length)
  }
  return dir
}

/**
 * 「N 分钟前」这类相对时间；时间无效时返回空串。
 * @param {string | undefined} at ISO 时间 @param {number} now 毫秒
 */
export function ago(at, now) {
  const t = at ? Date.parse(at) : NaN
  if (Number.isNaN(t)) return ''
  const min = Math.floor(Math.max(0, now - t) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 文档所在目录，用于显示：不带末尾的 /，就在工作目录根下时写「项目根目录」。@param {DocSummary} doc @param {string} cwd */
export function docDir(doc, cwd) {
  const dir = dirOf(doc.path, cwd)
  return dir === './' ? '项目根目录' : dir.length > 1 ? dir.slice(0, -1) : dir
}

/** 直接列出的文档和折叠掉的个数。@param {DocSummary[]} active @param {boolean} isExpanded */
export function visibleDocs(active, isExpanded) {
  if (isExpanded || active.length <= MAX_ROWS) return { shown: active, hidden: 0 }
  return { shown: active.slice(0, MAX_ROWS), hidden: active.length - MAX_ROWS }
}

// ── 桌面版单行样式：和用量带同一套视觉语言（13px 等宽数字、彩色数字、整行两端对齐）──

const LINE_H = 18
const LINE_STYLE =
  '<style>' +
  ':root{color-scheme:light dark;background:transparent}' +
  'text{font-family:Inter,"SF Pro Text","PingFang SC",system-ui,-apple-system,sans-serif;font-weight:500;font-size:13px;font-feature-settings:"tnum","cv05"}' +
  '.ink{fill:#3d3d3a}.mute{fill:#8b8f97;font-weight:400}.clay{fill:#c96442}.amb{fill:#b7791f}.gdot{fill:#a8abb2}' +
  '.rule{stroke:#000;stroke-opacity:.12;stroke-width:1}.cic{fill:none;stroke:#c96442;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
  // 评审状态的颜色：待评审粉、未发送黄、待确认绿、处理中灰（「评审」二字已用陶土色，文件名链接是桌面版固定的蓝色，都避开）
  '.st{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
  '.st-review{stroke:#db2777}.st-draft{stroke:#ca8a04}.st-confirm{stroke:#16a34a}.st-processing{stroke:#8b8f97}' +
  '.fic{fill:none;stroke:#8b8f97;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
  '@media (prefers-color-scheme:dark){.ink{fill:#e6e4dd}.mute{fill:#9aa0a8}.clay{fill:#e8916f}.amb{fill:#e8b45f}' +
  '.gdot{fill:#6f737a}.rule{stroke:#fff;stroke-opacity:.16}.cic{stroke:#e8916f}.fic{stroke:#9aa0a8}' +
  '.st-review{stroke:#f472b6}.st-draft{stroke:#facc15}.st-confirm{stroke:#4ade80}.st-processing{stroke:#9aa0a8}}' +
  '</style>'

/** @param {number} width @param {string} body */
const lineDoc = (width, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LINE_H}" viewBox="0 0 ${width} ${LINE_H}">${LINE_STYLE}${body}</svg>`

/** 标题段的评论图标（陶土色）。*/
export function commentIcon() {
  const body = '<g class="cic" transform="translate(1 2) scale(0.583)"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></g>'
  return { svg: lineDoc(16, body), width: 16 }
}

/**
 * 一条横向分隔线。桌面版会把过宽的图缩放到行宽，所以图本身随意拉伸（preserveAspectRatio="none"），
 * 线用 non-scaling-stroke 保持 1 像素，缩放后仍清晰可见。
 */
export function dividerLine() {
  const width = 2000
  // 线上下各约 10pt，加上药丸和用量带自身的上下内边距，正好和外层容器的内边距（约 17pt）一致
  const height = 20
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `${LINE_STYLE}<line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" class="rule" vector-effect="non-scaling-stroke"/></svg>`
  return { svg, width, height }
}

/** 文件名去掉扩展名，单行里更紧凑；悬停卡片里再给全名。@param {string} path */
export function shortName(path) {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 单行里显示的文件名：去掉扩展名和开头的日期（如 2026-10-11-），过长时截断加「…」。
 * 长度按显示宽度算：中日韩字符算 2，其他算 1。
 * @param {string} path @param {number} [max]
 */
export function displayName(path, max = 18) {
  const name = shortName(path).replace(/^\d{4}-\d{2}-\d{2}[-_ ]+/, '') || shortName(path)
  let width = 0
  let out = ''
  for (const ch of name) {
    const w = /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1
    if (width + w > max - 1) return `${out}…`
    width += w
    out += ch
  }
  return out
}

/** 渲染树里元素的类型（插件能画的那些）；不在其中的是引擎自己的节点。*/
const DRAWN_TYPES = new Set(['Text', 'Button', 'Svg', 'Markdown', 'Code', 'Link', 'Image', 'Raster', 'Input', 'Select', 'Client'])

/**
 * 渲染树里有没有插件画的可见内容（文字、按钮、图等）。只有引擎节点或空盒子时为 false：
 * 那时下层看起来是空的，不该为它画分隔线。
 * @param {any} node
 * @returns {boolean}
 */
export function hasDrawnContent(node) {
  if (node === null || node === undefined || typeof node !== 'object') return typeof node === 'string' && node.trim() !== ''
  if (Array.isArray(node)) return node.some(hasDrawnContent)
  if (DRAWN_TYPES.has(node.type)) return true
  if (node.type !== 'Box') return false
  return hasDrawnContent(node.children)
}

/**
 * 药丸里文字大约占几格：桌面版按比例字体排，英文字符比一格窄、中文比两格窄（按截图校准）。
 * @param {string} text
 */
function fitWidth(text) {
  let w = 0
  for (const ch of text) w += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 1.7 : /\p{Extended_Pictographic}/u.test(ch) ? 2 : 0.85
  return w
}

/**
 * 按状态带的宽度（格）算出这一行放得下几个文件药丸，其余收成「+N」；至少放 1 个。
 * 每个文件占「状态图标 + 文件名」的宽度再加间距；宽度未知时按 MAX_ROWS 个放。
 * @param {DocSummary[]} active @param {number | undefined} columns
 */
export function fitDocs(active, columns) {
  if (!columns || columns <= 0) return visibleDocs(active, false)
  const HEAD = 7 // 图标 + 「评审」 + 间距
  const MORE = 4 // 「+N」 + 间距
  const PILL_EXTRA = 5 // 状态图标 + 图标和文件名的间距 + 间距
  let used = HEAD
  let count = 0
  for (let i = 0; i < active.length; i++) {
    const w = fitWidth(displayName(active[i].path)) + PILL_EXTRA
    const needMore = i < active.length - 1 ? MORE : 0
    if (count > 0 && used + w + needMore > columns) break
    used += w
    count++
  }
  return { shown: active.slice(0, count), hidden: active.length - count }
}

// ── 评审状态（见 docs/superpowers/specs/2026-10-12-review-states-design.md）──

/** 状态带里显示的状态，按这个顺序排（先排轮到你的）；turn：you 轮到你，wait 在等 Claude。*/
export const BAND_STATES = {
  draft: { label: '未发送', turn: 'you', icon: 'file-pen' },
  confirm: { label: '待确认', turn: 'you', icon: 'file-check' },
  review: { label: '待评审', turn: 'you', icon: 'file-search' },
  processing: { label: 'Claude 处理中', turn: 'wait', icon: 'hourglass' },
}
const ORDER = Object.keys(BAND_STATES)

/** 有变化后多久还留在状态带里。*/
export const RECENT_MS = 24 * 3_600_000

/**
 * 文档的评审状态：新版服务端直接给 state；旧版没有时按评论推算，只认得未发送和处理中。
 * @param {DocSummary & { state?: string }} doc
 */
export function stateOf(doc) {
  if (doc.state) return doc.state
  if ((doc.drafts ?? 0) > 0) return 'draft'
  if ((doc.sent ?? 0) > 0 || doc.open > 0) return 'processing'
  return undefined
}

/**
 * 状态带要列的文档：状态是未发送、待确认、待评审、处理中之一，且 24 小时内有变化；按状态顺序排。
 * 旧版服务端（没有 state）只列有未解决评论的。
 * @param {(DocSummary & { state?: string, changedAt?: string })[] | undefined} docs @param {number} now
 */
export function bandDocs(docs, now) {
  const list = (docs ?? []).filter(d => {
    const state = stateOf(d)
    if (!state || !(state in BAND_STATES)) return false
    if (!d.state) return true
    const at = Date.parse(d.changedAt ?? '')
    return !Number.isNaN(at) && now - at < RECENT_MS
  })
  return list.sort((a, b) => ORDER.indexOf(stateOf(a) ?? '') - ORDER.indexOf(stateOf(b) ?? ''))
}

// 状态图标取自 lucide（https://lucide.dev，ISC 许可），圆改写成等价路径
const STATE_ICONS = {
  'file-search': ['M14 2v4a2 2 0 0 0 2 2h4', 'M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3', 'm9 18-1.5-1.5', 'M2 14a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  'file-pen': [
    'M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z',
  ],
  'file-check': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'm9 15 2 2 4-4'],
  hourglass: [
    'M5 22h14',
    'M5 2h14',
    'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22',
    'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2',
  ],
}

/**
 * 状态图标：形状和颜色都表示状态（待评审粉、未发送黄、待确认绿、处理中灰），明暗两套颜色。
 * @param {string} state
 */
export function stateIcon(state) {
  const key = state in BAND_STATES ? state : 'review'
  const meta = BAND_STATES[/** @type {keyof typeof BAND_STATES} */ (key)]
  const body = `<g class="st st-${key}" transform="translate(1 2) scale(0.583)">${STATE_ICONS[meta.icon].map(d => `<path d="${d}"/>`).join('')}</g>`
  return { svg: lineDoc(16, body), width: 16 }
}

/**
 * 文件卡片的说明：「状态 · 目录 · N 分钟前更新」。
 * @param {DocSummary & { state?: string, changedAt?: string }} doc @param {string} cwd @param {number} now
 */
export function stateDescription(doc, cwd, now) {
  const state = stateOf(doc)
  const label = state && state in BAND_STATES ? BAND_STATES[/** @type {keyof typeof BAND_STATES} */ (state)].label : ''
  const when = ago(doc.changedAt ?? doc.activeAt, now)
  return [label, docDir(doc, cwd), when ? `${when}更新` : ''].filter(Boolean).join(' · ')
}

/**
 * Markdown 链接：文字里的方括号、圆括号和反斜杠转义，免得文件名把链接截断。
 * @param {string} text @param {string} url
 */
export function markdownLink(text, url) {
  return `[${text.replace(/[\\[\]()]/g, ch => `\\${ch}`)}](${url})`
}
