// 输入框上方评审状态带的文案和取舍规则，全是纯函数；画树在 hooks/register.js 里。

/** @typedef {{ id: string, path: string, open: number, drafts?: number, sent?: number, resolved?: number, activeAt?: string, openedAt?: string }} DocSummary */

/** @param {string} path */
export function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 状态带要显示的文档：还有未解决评论（处理中或待发送）的。@param {DocSummary[] | undefined} docs */
export function activeDocs(docs) {
  return (docs ?? []).filter(d => d.open > 0)
}

/** $.ui.copy 失败原因的中文说明。@param {string} reason */
export function copyFailReason(reason) {
  return (
    { 'no-surface': '没有能复制的界面', 'no-clipboard': '当前界面没有接通剪贴板', refused: '复制被拦下' }[reason] ?? reason
  )
}

/** @param {number} n */
export function reminderTitle(n) {
  return `⚠ 还有 ${n} 条评论没回复处理结果`
}

/** 一轮结束仍有评论没回复时，自动提醒 Claude 的消息。@param {string[]} ids */
export function reminderPrompt(ids) {
  return [
    `[文档评审] 还有 ${ids.length} 条评论没有回复处理结果：${ids.join('、')}。`,
    '请对每条调用 review_resolve，写清改了什么，或为什么没改。',
  ].join('\n')
}

/**
 * 在文档详情里查已送达的评论。
 * - pending：评论还处于 sent，没回复；
 * - settled：已解决，或文档 / 评论已经不存在（404），不再跟踪；
 * - unknown：所在文档这次没取到（服务不可达），下次再查。
 * @param {string[]} ids
 * @param {Map<string, string>} docOf 评论 ID → 文档 ID
 * @param {Map<string, { comments?: { id: string, status: string }[] } | null>} fetched 取到的文档详情；null 表示 404
 */
export function classifyDelivered(ids, docOf, fetched) {
  /** @type {string[]} */ const pending = []
  /** @type {string[]} */ const settled = []
  /** @type {string[]} */ const unknown = []
  for (const id of ids) {
    const docId = docOf.get(id)
    if (docId === undefined || !fetched.has(docId)) {
      unknown.push(id)
      continue
    }
    const doc = fetched.get(docId)
    const status = doc?.comments?.find(c => c.id === id)?.status
    if (status === 'sent') pending.push(id)
    else settled.push(id)
  }
  return { pending, settled, unknown }
}

/**
 * 新的提醒名单：确认没回复的，加上原先提醒中、这次没查到的（服务一时不可达时不清空提醒）。
 * @param {string[]} pending @param {string[]} unknown @param {string[]} previous
 */
export function nextReminder(pending, unknown, previous) {
  return [...new Set([...pending, ...previous.filter(id => unknown.includes(id))])]
}
