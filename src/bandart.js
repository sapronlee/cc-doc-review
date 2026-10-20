// 回复列表的图（SVG）：输入框上方的回复区和聊天记录里的回复消息共用，表格样式，一条一行。
// 13 号字，用桌面版的系统字体；暗字 #8b8f97 / #9aa0a8 同用量带（CC-Gauge）。每行 28 像素高；行与行之间的通栏横线单独一条（lineSvg），栏与栏之间不画线。
// 外框也画在图里（左边框画在每行图里，右边框、圆角是小图），内边距、对齐都按像素定。
// 画得很宽（2000），用 slice 只裁不缩：桌面版把过宽的图限制在行宽内时，文字不会被缩小，右边多出的部分被裁掉。
// 预览页和插件用的是同一组函数，画出来的就是实际看到的。全是纯函数。

/** 表格一行的高度、画布宽度（像素）。*/
export const ROW_H = 28
export const CANVAS_W = 2000
/** 外框：圆角半径、内容离左边框的距离（和桌面版按钮的内边距差不多，左右看起来对称）。*/
export const RADIUS = 6
export const PAD = 8
/** 标题行最右边，〔发送〕和右边框之间再空出的像素（按钮自带的内边距比左边的留白小这么多）。*/
export const HEAD_RIGHT = 4
/**
 * 各栏的位置（像素，从左边框算起）：编号圆点（第一栏）、原文（第二栏，竖线加文字）、回复（第三栏）。
 */
export const COL = { dot: PAD + 1, bar: PAD + 27, quote: PAD + 35, quoteW: 206, body: PAD + 255, bodyW: 430 }

// 和桌面版界面文字同一种字体（标题行和按钮是桌面版自己画的字），表格里上下看起来是一家
const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",system-ui,sans-serif'
const STYLE =
  `text{font-family:${FONT};font-size:13px;font-feature-settings:"tnum","cv05"}` +
  '.ink{fill:#29261b;font-weight:500}.mute{fill:#8b8f97}.dot{fill:#c96442}.num{fill:#fff;font-size:10px;font-weight:600}.bar{fill:#000;fill-opacity:.2}.acc{fill:#c96442}.line{fill:#000;fill-opacity:.09}.edge{fill:#000;fill-opacity:.14}.arc{fill:none;stroke:#000;stroke-opacity:.14}' +
  '@media (prefers-color-scheme:dark){.ink{fill:#ecebe8}.mute{fill:#9aa0a8}.dot{fill:#d97757}.bar{fill:#fff;fill-opacity:.28}.acc{fill:#d97757}.line{fill:#fff;fill-opacity:.1}.edge{fill:#fff;fill-opacity:.14}.arc{stroke:#fff;stroke-opacity:.14}}'

/** @param {string} s */
const esc = s => s.replace(/[&<>"']/g, ch => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u
/** 13 号字时一个字大约多宽（像素）：中日韩、全角字符 13，其余 7.4。@param {string} ch */
const charW = ch => (WIDE.test(ch) ? 13 : 7.4)

/** 压成一行，超过 maxPx 宽时截断加「…」。@param {string} s @param {number} maxPx */
export function clip(s, maxPx) {
  const line = s.replace(/\s+/g, ' ').trim()
  let w = 0
  for (const ch of line) w += charW(ch)
  if (w <= maxPx) return line
  const room = maxPx - charW('…')
  let out = ''
  w = 0
  for (const ch of line) {
    w += charW(ch)
    if (w > room) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

/** 通栏横线：画布很宽，被裁到行宽，所以总是通栏。*/
const TOP_LINE = `<rect x="0" y="0" width="${CANVAS_W}" height="1" class="line"/>`

/**
 * 一张很宽的图（左对齐，右边多出的被裁掉）。@param {string} body @param {number} [h] @param {number} [w]
 */
const doc = (body, h = ROW_H, w = CANVAS_W, align = 'xMinYMid') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="${align} slice" style="color-scheme:light dark;background:transparent"><style>${STYLE}</style>${body}</svg>`

/** 左边框（一行高的竖线，贴着图的左边）。@param {number} h */
const leftEdge = h => `<rect x="0" y="0" width="1" height="${h}" class="edge"/>`

/** 最后一行的左边框：竖线往下接左下圆角，再接贴着行底的外框下沿（很宽，右边被裁）。@param {number} h */
const bottomLeft = h => {
  const r = RADIUS
  const k = r - 0.5
  return `<path d="M0.5 0 V${h - r} A${k} ${k} 0 0 0 ${r} ${h - 0.5} H${CANVAS_W}" class="arc"/>`
}

/**
 * 表格的一行（一条回复，横线另画，见 lineSvg）：左边框，第一栏橙色编号圆点，第二栏灰色竖线加暗色原文，第三栏亮色回复。右边框另画（edgeSvg）。
 * 最后一行（isLast）连外框的下沿、左下圆角一起画：每行都是「横线 + 一行」，桌面版给每张图多留的空白一样多，各行就一样高。
 * @param {{ no: number, quote: string, body: string }} r @param {number} [h] @param {boolean} [isLast]
 */
export function rowSvg(r, h = ROW_H, isLast = false) {
  const cy = h / 2
  const base = cy + 4.5
  return doc(
    (isLast ? bottomLeft(h) : leftEdge(h)) +
      `<circle cx="${COL.dot + 7}" cy="${cy}" r="7" class="dot"/>` +
      `<text x="${COL.dot + 7}" y="${cy + 3.5}" text-anchor="middle" class="num">${r.no}</text>` +
      `<rect x="${COL.bar}" y="${cy - 6}" width="2" height="12" rx="1" class="bar"/>` +
      `<text x="${COL.quote}" y="${base}" class="mute">${esc(clip(r.quote, COL.quoteW))}</text>` +
      `<text x="${COL.body}" y="${base}" class="ink">${esc(clip(r.body, COL.bodyW))}</text>`,
    h,
  )
}

/** 文档名行（多份文档时每组前一行）。@param {string} name @param {number} [h] @param {boolean} [isLast] */
export function docRowSvg(name, h = ROW_H, isLast = false) {
  return doc(`${isLast ? bottomLeft(h) : leftEdge(h)}<text x="${PAD + 1}" y="${h / 2 + 4.5}" class="mute" font-weight="500">${esc(clip(name, 600))}</text>`, h)
}

/** 行与行之间的通栏横线（高 1 像素）：单独一条，从左边框贯穿到右边框，不被行尾的 × 挡住。*/
export function lineSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="1" viewBox="0 0 ${CANVAS_W} 1" preserveAspectRatio="xMinYMid slice" style="color-scheme:light dark;background:transparent"><style>${STYLE}</style>${TOP_LINE}</svg>`
}

/** 标题行右边〔展开〕和〔清空〕之间的细竖线（1×12）。*/
export function sepSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="12" viewBox="0 0 1 12" style="color-scheme:light dark;background:transparent"><style>${STYLE}</style><rect width="1" height="12" class="line"/></svg>`
}

/**
 * 竖着的一段边框：side 为 right 时竖线贴着图的右边（右边框，宽 w 时左边是空白）；为 left 时贴着左边（标题行的左边框加内边距）。
 * @param {number} h @param {number} [w] @param {'left' | 'right'} [side]
 */
export function edgeSvg(h, w = 1, side = 'right') {
  const x = side === 'right' ? w - 1 : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="color-scheme:light dark;background:transparent"><style>${STYLE}</style><rect x="${x}" y="0" width="1" height="${h}" class="edge"/></svg>`
}

/**
 * 和外框上沿一样高的一段空白（只有左右边框，左右两张图同 frameSvg）：垫在标题行下面，
 * 让标题行上下空白一样（桌面版给每段图留的高度和上沿完全相同），内容在外框和横线之间居中。
 */
export function gapSvg() {
  return { left: doc(leftEdge(RADIUS), RADIUS), right: edgeSvg(RADIUS, RADIUS) }
}

/** × 那一格的宽（像素）：比桌面版的 × 按钮宽一点，× 居中，和右边框之间留出空白。*/
export const CLOSE_W = 28

/** 行尾和右边框之间的空白（宽 PAD、一行高），长回复不会贴着边框被截断；最后一行画外框下沿。@param {boolean} [isLast] */
export function padSvg(isLast = false) {
  return doc(isLast ? `<rect x="0" y="${ROW_H - 1}" width="${PAD}" height="1" class="edge"/>` : '', ROW_H, PAD)
}

/** 一格最底下的一像素（宽 w）：最后一行是外框下沿（× 那一格、回复那一格底下的下沿不断），其余行空着。@param {boolean} [isLast] @param {number} [w] */
export function closeBaseSvg(isLast = false, w = CLOSE_W) {
  return doc(isLast ? `<rect x="0" y="0" width="${w}" height="1" class="edge"/>` : '', 1, w)
}

/** 最后一行的右边框（宽 RADIUS）：竖线往下接右下圆角，左边接外框下沿。@param {number} [h] */
export function cornerEdgeSvg(h = ROW_H) {
  const r = RADIUS
  const k = r - 0.5
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${h}" viewBox="0 0 ${r} ${h}" style="color-scheme:light dark;background:transparent"><style>${STYLE}</style><path d="M0 ${h - 0.5} A${k} ${k} 0 0 0 ${k} ${h - r} V0" class="arc"/></svg>`
}

/**
 * 外框的上沿或下沿（高 RADIUS）：左圆角接一条很宽的横线（左对齐、右边被裁），右圆角另一张小图（宽 RADIUS）。
 * @param {'top' | 'bottom'} side
 */
export function frameSvg(side) {
  const r = RADIUS
  const k = r - 0.5
  const left =
    side === 'top'
      ? `<path d="M0.5 ${r} A${k} ${k} 0 0 1 ${r} 0.5 H${CANVAS_W}" class="arc"/>`
      : `<path d="M0.5 0 A${k} ${k} 0 0 0 ${r} ${k} H${CANVAS_W}" class="arc"/>`
  const right =
    side === 'top' ? `<path d="M0 0.5 A${k} ${k} 0 0 1 ${k} ${r}" class="arc"/>` : `<path d="M0 ${k} A${k} ${k} 0 0 0 ${k} 0" class="arc"/>`
  return {
    left: doc(left, r),
    right: `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${r}" viewBox="0 0 ${r} ${r}" style="color-scheme:light dark;background:transparent"><style>${STYLE}</style>${right}</svg>`,
  }
}
