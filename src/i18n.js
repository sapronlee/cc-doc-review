// 界面文字的中英两套，以及按 Claude Code 的 language 设置选用哪套。全是纯函数。
// 文档页用的子集在 server/web/static/i18n.js，两边同键同值（tests/web/i18n.test.mjs 检查）。

/** @typedef {'zh' | 'en'} Lang */

export const STRINGS = {
  zh: {
    replyHint: '回复 Claude',
    pendingOnPage: '{n} 条回复待发送',
    noReplies: '还没有回复',
    clear: '清空',
    deleteFailed: '没删掉：{reason}',
    markSentFailed: '已发出，但没能标为已发送（{reason}），这些回复还会留在列表里，别再发一遍',
    serverGone: '文档服务没在运行',
    bandTitle: '{n} 条回复',
    moreReplies: '还有 {n} 条',
    expandRest: '展开其余 {n} 条',
    collapse: '收起',
    confirmClear: '确认清空',
    send: '发送',
    sending: '发送中…',
    sent: '已发给 Claude',
    sendFailed: '没发出去：{reason}',
    blockHead: '[文档回复] 请按编号逐条答复。',
    noDocs: '本会话还没有文档',
    docsListHead: '本会话的文档（{n} 份）：',
    changes: '改了 {n} 处',
    justNow: '刚刚',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    daysAgo: '{n} 天前',
    rootDir: '项目根目录',
    deleteReply: '删除',
    commandFailed: '{command} 命令注册失败（{reason}），其余功能不受影响',
    yourReply: '你的回复',
    switchDoc: '切换文档',
    addReply: '加入回复',
    pageLoadFailed: '加载回复失败：{reason}',
    pageSaveFailed: '没加上：{reason}',
    pageDisconnected: '文档服务已断开，请重新打开文档页',
    pageMissing: '文件不存在或无法读取（{status}）。',
    prevChange: '上一处改动',
    nextChange: '下一处改动',
    clearChanges: '清掉改动标注',
    openLink: '打开 {name}',
    autoFailed: '自动登记文档失败：{reason}',
    cmdOpened: '已登记 {file}，已在系统浏览器打开：{url}',
    cmdRegistered: '已登记 {file}：{url}',
    cmdFailed: '打开失败：{reason}',
    commandHint: '列出本会话的文档；带文件参数时登记该文件并在浏览器打开',
    commandArg: '[md 或 html 文件]',
  },
  en: {
    replyHint: 'Reply to Claude',
    pendingOnPage: '{n} replies to send',
    noReplies: 'No replies yet',
    clear: 'Clear',
    deleteFailed: 'Not deleted: {reason}',
    markSentFailed: "Sent, but couldn't mark the replies as sent ({reason}); they stay in the list, so don't send them again",
    serverGone: 'the document service is not running',
    bandTitle: '{n} replies',
    moreReplies: '{n} more',
    expandRest: 'Show {n} more',
    collapse: 'Collapse',
    confirmClear: 'Confirm clear',
    send: 'Send',
    sending: 'Sending…',
    sent: 'Sent to Claude',
    sendFailed: 'Not sent: {reason}',
    blockHead: '[Doc reply] Please answer each by number.',
    noDocs: 'No docs in this session yet',
    docsListHead: 'Docs in this session ({n}):',
    changes: '{n} changes',
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',
    daysAgo: '{n} d ago',
    rootDir: 'project root',
    deleteReply: 'Delete',
    commandFailed: '{command} could not be registered ({reason}); everything else still works',
    yourReply: 'Your reply',
    switchDoc: 'Switch doc',
    addReply: 'Add reply',
    pageLoadFailed: 'Could not load replies: {reason}',
    pageSaveFailed: 'Not added: {reason}',
    pageDisconnected: 'Lost the doc service. Reopen this page',
    pageMissing: 'File not found or unreadable ({status}).',
    prevChange: 'Previous change',
    nextChange: 'Next change',
    clearChanges: 'Clear change marks',
    openLink: 'Open {name}',
    autoFailed: 'Could not register the doc automatically: {reason}',
    cmdOpened: 'Registered {file} and opened it in your browser: {url}',
    cmdRegistered: 'Registered {file}: {url}',
    cmdFailed: 'Could not open: {reason}',
    commandHint: 'List this session\'s docs; with a file, register it and open it in your browser',
    commandArg: '[md or html file]',
  },
}

/**
 * 从 `$.config.list()` 的结果里读 language 设置：含「中文」「Chinese」「zh」（不分大小写）为中文，其余或读不到为英文。
 * @param {readonly { key: string, value: unknown }[] | undefined} rows
 * @returns {Lang}
 */
export function langOf(rows) {
  const row = rows?.find(r => r.key === 'language')
  const value = typeof row?.value === 'string' ? row.value : ''
  return /中文|chinese|zh/i.test(value) ? 'zh' : 'en'
}

/**
 * 取一条文字并替换 {变量}；这套里没有时用英文，再没有时返回键名。
 * @param {Lang} lang @param {string} key @param {Record<string, string | number>} [vars]
 */
export function t(lang, key, vars = {}) {
  const table = /** @type {Record<string, string>} */ (STRINGS[lang] ?? STRINGS.en)
  const text = table[key] ?? /** @type {Record<string, string>} */ (STRINGS.en)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}
