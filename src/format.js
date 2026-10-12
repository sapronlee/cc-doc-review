// 把一批评论排成发进会话的消息。

/** @param {string} path @param {string} cwd */
export function displayPath(path, cwd) {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

/** 压成一行，过长截断。@param {string} s @param {number} [max] */
export function oneLine(s, max = 200) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 送进会话的消息。评论批次列出每条评论；「通过」消息（kind 为 approve）告诉 Claude 这篇已经定稿。
 * @param {{ kind?: string, path: string, comments: { id: string, quote: string, body: string }[] }} batch
 * @param {string} cwd
 */
export function formatBatch(batch, cwd) {
  if (batch.kind === 'approve') {
    return `[文档评审] ${displayPath(batch.path, cwd)} 已通过评审：用户确认没有修改意见，这篇可以定稿，可以继续下一步。不需要调用 review_resolve。`
  }
  const lines = [`[文档评审] ${displayPath(batch.path, cwd)} 有 ${batch.comments.length} 条新评论：`, '']
  batch.comments.forEach((c, i) => {
    lines.push(`${i + 1}. [${c.id}] 原文：「${oneLine(c.quote)}」`)
    lines.push(`   意见：${c.body.trim().replace(/\n/g, '\n   ')}`)
  })
  lines.push('', '处理完后，请对每条评论调用 review_resolve 说明处理结果（改了什么，或为什么没改）。')
  return lines.join('\n')
}

/** 从 formatBatch 排出的消息里取评论 ID（`[c_xxx]`）。@param {string} text */
export function commentIdsIn(text) {
  return [...text.matchAll(/\[(c_[0-9A-Za-z]+)\]/g)].map(m => m[1])
}
