// 回复列表的显示数据：输入框上方的回复区和聊天记录里的回复消息用同一套样子
// （标题「N 条回复 · 文档名」，每条：编号、│ 原文（一行）、你的回复）。全是纯函数；画树在 hooks/register.js 里。

import { displayName } from './bandview.js'
import { t } from './i18n.js'

/** @typedef {import('./i18n.js').Lang} Lang */
/** @typedef {{ id?: string, no: number, quote: string, body: string, createdAt?: string }} ListReply */
/** @typedef {{ doc?: string, path: string, replies: ListReply[] }} ListGroup */
/**
 * @typedef {{ kind: 'doc', key: string, name: string }
 *   | { kind: 'reply', key: string, id: string, doc: string, no: number, quote: string, body: string, fullQuote: string }} ListRow
 */

/** 原文行最多占多宽（再长的由界面按行宽截断）：按字宽算，一个汉字算 1，英文字母算 0.6。*/
export const QUOTE_WIDTH = 60
/** 回复区超过这么多条时折叠，只列最新加入的这么多条。*/
export const COLLAPSED_ROWS = 3

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u

/** 一个字算多宽：中日韩、全角字符和表情算 1，其余算 0.6。@param {string} ch */
const charWidth = ch => (WIDE.test(ch) ? 1 : 0.6)

/** 压成一行，超过 max 宽时截断加「…」。@param {string} s @param {number} max */
export function fit(s, max) {
  const line = s.replace(/\s+/g, ' ').trim()
  let w = 0
  for (const ch of line) w += charWidth(ch)
  if (w <= max) return line
  const room = max - charWidth('…')
  let out = ''
  w = 0
  for (const ch of line) {
    w += charWidth(ch)
    if (w > room) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

/**
 * 列表的行：只有一份文档时不单列文档行（文档名放在标题里），多份时每组前面一行文档名。
 * @param {ListGroup[]} groups @param {Set<string>} [keep] 只列这些回复（折叠时）；不给就全列
 * @returns {ListRow[]}
 */
function rowsOf(groups, keep) {
  /** @type {ListRow[]} */
  const rows = []
  const isMulti = groups.length > 1
  groups.forEach((g, gi) => {
    const shown = keep ? g.replies.filter(r => keep.has(r.id ?? '')) : g.replies
    if (shown.length === 0) return
    if (isMulti) rows.push({ kind: 'doc', key: `doc:${g.doc ?? gi}`, name: displayName(g.path, 40) })
    for (const r of shown) {
      const id = r.id ?? `n${r.no}`
      rows.push({ kind: 'reply', key: `r:${id}`, id, doc: g.doc ?? '', no: r.no, quote: fit(r.quote, QUOTE_WIDTH), body: r.body.trim(), fullQuote: r.quote.trim() })
    }
  })
  return rows
}

/** 标题「N 条回复」，和只有一份文档时标题后面接的文档名（多份时为空，文档名各自成行）。@param {ListGroup[]} groups @param {Lang} lang */
function titleOf(groups, lang) {
  const total = groups.reduce((n, g) => n + g.replies.length, 0)
  return { title: t(lang, 'bandTitle', { n: total }), docName: groups.length === 1 ? displayName(groups[0].path, 40) : '' }
}

/**
 * 输入框上方回复区的显示数据。最多列 room 条（剩余高度放得下的条数）；没展开时再限到 3 条。
 * 列的是最新加入的那几条；列不全时标题行右边有〔展开其余 N 条〕，展开后是〔收起〕。
 * @param {ListGroup[]} groups 服务端按文档分好组、编号连续的待发送回复
 * @param {{ isExpanded: boolean, isArmed: boolean, isSending: boolean, lang: Lang, room?: number }} state
 */
export function bandModel(groups, { isExpanded, isArmed, isSending, lang, room = Infinity }) {
  const live = groups.filter(g => g.replies.length > 0)
  const all = live.flatMap(g => g.replies)
  const total = all.length
  const cap = Math.max(1, Math.floor(room))
  const folded = Math.min(COLLAPSED_ROWS, cap)
  // 展开后能多列几条才给〔展开〕：放得下的条数不比折叠时多，展开也没用
  const canFold = total > folded && cap > folded
  const limit = isExpanded && canFold ? cap : folded
  /** @type {Set<string> | undefined} */
  let keep
  if (total > limit) {
    const newest = [...all].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || b.no - a.no)
    keep = new Set(newest.slice(0, limit).map(r => r.id ?? ''))
  }
  const hidden = keep ? total - keep.size : 0
  return {
    total,
    ...titleOf(live, lang),
    rows: rowsOf(live, keep),
    hidden,
    more: hidden > 0 ? t(lang, 'moreReplies', { n: hidden }) : '',
    toggle: !canFold ? '' : isExpanded ? t(lang, 'collapse') : t(lang, 'expandRest', { n: hidden }),
    clear: t(lang, isArmed ? 'confirmClear' : 'clear'),
    send: t(lang, isSending ? 'sending' : 'send'),
    isSending,
  }
}

/**
 * 聊天记录里一条回复消息的显示数据：同样的标题和行，不折叠；你写的话另放。
 * @param {{ own: string, groups: { name: string, path: string, replies: { no: number, quote: string, body: string }[] }[] }} parsed
 * @param {Lang} lang
 */
export function messageModel(parsed, lang) {
  const groups = parsed.groups.map(g => ({ path: g.path || g.name, replies: g.replies }))
  return { ...titleOf(groups, lang), rows: rowsOf(groups), own: parsed.own }
}
