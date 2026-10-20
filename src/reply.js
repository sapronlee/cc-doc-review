// 回复块：把待发送的回复排成写进消息正文的文字，以及从消息正文里认出它。全是纯函数。
// 格式见 docs/superpowers/specs/2026-10-18-reply-cards-design.md 7.2。

import { baseName } from './bandview.js'
import { STRINGS, t } from './i18n.js'

/** @typedef {import('./i18n.js').Lang} Lang */
/** @typedef {{ id?: string, no?: number, quote: string, body: string, createdAt?: string }} ReplyItem */
/** @typedef {{ doc?: string, path: string, kind?: string, replies: ReplyItem[] }} ReplyGroup */
/** @typedef {{ no: number, quote: string, body: string }} ParsedReply */
/** @typedef {{ name: string, path: string, replies: ParsedReply[] }} ParsedGroup */

/** 用户自己发的消息：输入框回车、Remote Control、SDK 宿主（桌面版）。插件发的（含本插件）、通知、别的会话都不算。*/
const USER_KINDS = new Set(['composer', 'bridge', 'sdk'])

/** @param {{ kind: string } | undefined} origin prompt.submit 的 e.origin */
export function isUserOrigin(origin) {
  return USER_KINDS.has(origin?.kind ?? '')
}

/** 路径在 cwd 下时写相对路径。@param {string} path @param {string} cwd */
export function shownPath(path, cwd) {
  if (!cwd) return path
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** 组标题行：中文「名（路径）」，英文「name (path)」。@param {Lang} lang @param {string} name @param {string} path */
const groupLine = (lang, name, path) => (lang === 'zh' ? `${name}（${path}）` : `${name} (${path})`)

const MARKER = /^<!-- reply (\d+) -->$/
const GROUP_LINE = { zh: /^(.+?)（(.+)）$/, en: /^(.+?) \((.+)\)$/ }

/**
 * 交给 Claude 的回复块：首行说明，每份文档一行「文件名（路径）」，每条回复带全局连续的编号。
 * @param {ReplyGroup[]} groups @param {Lang} lang @param {string} cwd
 */
export function formatBlock(groups, lang, cwd) {
  const lines = [t(lang, 'blockHead')]
  let no = 0
  for (const g of groups) {
    if (g.replies.length === 0) continue
    lines.push(groupLine(lang, baseName(g.path), shownPath(g.path, cwd)))
    g.replies.forEach((r, i) => {
      no++
      if (i > 0) lines.push('')
      lines.push(`<!-- reply ${no} -->`)
      for (const q of r.quote.trim().split('\n')) lines.push(q.trim() ? `> ${q.trimEnd()}` : '>')
      lines.push('', r.body.trim())
    })
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 用户的话在前，空一行接回复块；用户没写话时只有回复块。
 * @param {string} userText @param {ReplyGroup[]} groups @param {Lang} lang @param {string} cwd
 */
export function withReplies(userText, groups, lang, cwd) {
  const block = formatBlock(groups, lang, cwd)
  const own = userText.trim()
  return own ? `${own}\n\n${block}` : block
}

/**
 * 认出 withReplies 生成的文字，还原用户的话和各组回复；认不出（没有开头那行、格式被改过）时返回 null。
 * @param {unknown} text
 * @returns {{ own: string, lang: Lang, groups: ParsedGroup[] } | null}
 */
export function parseMessage(text) {
  if (typeof text !== 'string') return null
  for (const lang of /** @type {Lang[]} */ (['zh', 'en'])) {
    const head = STRINGS[lang].blockHead
    let at = text.startsWith(`${head}\n`) ? 0 : -1
    const mid = text.lastIndexOf(`\n\n${head}\n`)
    if (mid >= 0) at = mid + 2
    if (at < 0) continue
    const groups = parseGroups(text.slice(at + head.length + 1).split('\n'), lang)
    return groups ? { own: text.slice(0, at).trim(), lang, groups } : null
  }
  return null
}

/** @param {string[]} lines @param {Lang} lang @returns {ParsedGroup[] | null} */
function parseGroups(lines, lang) {
  /** @type {ParsedGroup[]} */
  const groups = []
  let expected = 1
  let i = 0
  const isHeader = (/** @type {number} */ k) => (lines[k] ?? '').trim() !== '' && MARKER.test(lines[k + 1] ?? '')
  while (i < lines.length) {
    if (!isHeader(i)) return null
    const m = lines[i].match(GROUP_LINE[lang])
    if (!m) return null
    /** @type {ParsedGroup} */
    const group = { name: m[1], path: m[2], replies: [] }
    groups.push(group)
    i++
    while (i < lines.length && MARKER.test(lines[i])) {
      const no = Number(lines[i].match(MARKER)?.[1])
      if (no !== expected) return null
      expected++
      i++
      const quote = []
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^> ?/, ''))
      if (quote.length === 0 || lines[i] !== '') return null
      i++
      const body = []
      while (i < lines.length && !MARKER.test(lines[i]) && !isHeader(i)) body.push(lines[i++])
      const text = body.join('\n').trim()
      if (!text) return null
      group.replies.push({ no, quote: quote.join('\n'), body: text })
    }
  }
  return groups.length > 0 ? groups : null
}
