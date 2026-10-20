// 文档页的中英文字。与插件的 src/i18n.js 同键同值（tests/web/i18n.test.mjs 检查），只取页面用到的。

export const STRINGS = {
  zh: {
    replyHint: '回复 Claude',
    pendingOnPage: '{n} 条回复待发送',
    noReplies: '还没有回复',
    deleteReply: '删除',
    deleteFailed: '没删掉：{reason}',
    yourReply: '你的回复',
    switchDoc: '切换文档',
    addReply: '加入回复',
    pageLoadFailed: '加载回复失败：{reason}',
    pageSaveFailed: '没加上：{reason}',
    pageDisconnected: '文档服务已断开，请重新打开文档页',
    pageMissing: '文件不存在或无法读取（{status}）。',
    changes: '改了 {n} 处',
    prevChange: '上一处改动',
    nextChange: '下一处改动',
    clearChanges: '清掉改动标注',
  },
  en: {
    replyHint: 'Reply to Claude',
    pendingOnPage: '{n} replies to send',
    noReplies: 'No replies yet',
    deleteReply: 'Delete',
    deleteFailed: 'Not deleted: {reason}',
    yourReply: 'Your reply',
    switchDoc: 'Switch doc',
    addReply: 'Add reply',
    pageLoadFailed: 'Could not load replies: {reason}',
    pageSaveFailed: 'Not added: {reason}',
    pageDisconnected: 'Lost the doc service. Reopen this page',
    pageMissing: 'File not found or unreadable ({status}).',
    changes: '{n} changes',
    prevChange: 'Previous change',
    nextChange: 'Next change',
    clearChanges: 'Clear change marks',
  },
}

/**
 * 页面用哪套文字：链接里的 lang（插件按 Claude Code 的 language 设置给）优先，没有时看浏览器语言。
 * @param {string | null} param @param {string} [browser]
 */
export function pageLang(param, browser = '') {
  if (param === 'zh' || param === 'en') return param
  return /^zh/i.test(browser) ? 'zh' : 'en'
}

/** 取一条文字并替换 {变量}。@param {'zh' | 'en'} lang @param {string} key @param {Record<string, string | number>} [vars] */
export function t(lang, key, vars = {}) {
  const text = (STRINGS[lang] ?? STRINGS.en)[key] ?? STRINGS.en[key] ?? key
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}
