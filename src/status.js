// review_open、review_status 返回给 Claude 的文字：链接、各状态条数、卡片数据和画卡片的说明。纯函数。

import { baseName } from './band.js'
import { displayPath, oneLine } from './format.js'

/** @typedef {{ drafts: number, sent: number, resolved?: number }} Counts */

/**
 * 按状态数评论。
 * @param {{ status: string }[] | undefined} comments
 * @returns {{ drafts: number, sent: number, resolved: number }}
 */
export function countsOf(comments) {
  const n = { drafts: 0, sent: 0, resolved: 0 }
  for (const c of comments ?? []) {
    if (c.status === 'draft') n.drafts++
    else if (c.status === 'sent') n.sent++
    else if (c.status === 'resolved') n.resolved++
  }
  return n
}

/** 「待发送 N 条 · 处理中 M 条 · 已解决 K 条」；不知道已解决条数时省略那一项。@param {Counts} c */
function countsLine(c) {
  const parts = [`待发送 ${c.drafts} 条`, `处理中 ${c.sent} 条`]
  if (c.resolved !== undefined) parts.push(`已解决 ${c.resolved} 条`)
  return parts.join(' · ')
}

/** 卡片要的数据；没有链接时不带 url。@param {string} url @param {string} path @param {string} cwd @param {Counts} c */
function cardOf(url, path, cwd, c) {
  const card = { name: baseName(path), path: displayPath(path, cwd), drafts: c.drafts, sent: c.sent, resolved: c.resolved }
  return url ? { url, ...card } : card
}

/** 评论意见的长度上限，超出截断加省略号。*/
const BODY_MAX = 500

/** @param {string} s @param {number} max */
function clip(s, max) {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 〔在面板打开〕替用户发的话。*/
const PANEL_PROMPT = '请在浏览器面板打开文档评审页：'

const BUTTONS = `〔在浏览器打开〕调用 openLink(url)；〔在面板打开〕调用 sendPrompt('${PANEL_PROMPT}' + url)`

/**
 * review_open 的返回文字。
 * @param {{ url: string, path: string, comments?: { status: string }[] }} opened
 * @param {string} cwd
 */
export function openResult(opened, cwd) {
  const c = countsOf(opened.comments)
  const card = cardOf(opened.url, opened.path, cwd, c)
  return [
    `评审页已就绪：${opened.url}`,
    `文件：${card.name}（${card.path}），${countsLine(c)}`,
    `卡片数据：${JSON.stringify(card)}`,
    '',
    `展示方式：如果你有能在对话中渲染 HTML 卡片的工具（例如 show_widget），用它画一张评审卡片：文件名、相对路径、待发送 / 处理中 / 已解决条数，以及两个按钮——${BUTTONS}。没有这类工具时，直接把链接发给用户（有浏览器面板时也可以在面板里打开：preview_start 传 url；面板已打开时用 navigate）。`,
    '用户发送评论后会自动以「[文档评审]」开头的消息送达。',
  ].join('\n')
}

/**
 * @typedef {{ path: string, url: string, drafts: number, sent: number, resolved?: number,
 *   pending: { id: string, quote: string, body: string }[] }} StatusEntry
 */

/**
 * review_status 的返回文字。
 * @param {StatusEntry[]} entries 本会话的文档；resolved 缺省表示没取到详情
 * @param {string} cwd
 */
export function statusResult(entries, cwd) {
  if (entries.length === 0) return '本会话还没有登记评审的文档。'
  const lines = [`本会话有 ${entries.length} 个文档在评审：`]
  entries.forEach((e, i) => {
    lines.push('', `${i + 1}. ${baseName(e.path)}（${displayPath(e.path, cwd)}）`)
    lines.push(e.url ? `   链接：${e.url}` : '   链接暂不可用（评审服务没在运行），稍后再查')
    lines.push(`   ${countsLine(e)}`)
    if (e.pending.length > 0) {
      lines.push('   待处理的评论：')
      for (const c of e.pending) {
        lines.push(`   - [${c.id}] 原文：「${oneLine(c.quote)}」`)
        lines.push(`     意见：${clip(c.body.trim(), BODY_MAX).replace(/\n/g, '\n     ')}`)
      }
    }
  })
  const cards = entries.map(e => cardOf(e.url, e.path, cwd, e))
  lines.push(
    '',
    `卡片数据：${JSON.stringify(cards)}`,
    '',
    `展示方式：如果你有能在对话中渲染 HTML 卡片的工具（例如 show_widget），用它画一张汇总卡片：每个文档一行，显示文件名、相对路径、各状态条数，以及两个按钮（没有 url 的文档不放按钮）——${BUTTONS}。没有这类工具时，用文字列出。`,
    '待处理的评论处理完后，对每条调用 review_resolve 说明处理结果（改了什么，或为什么没改）。',
  )
  return lines.join('\n')
}
