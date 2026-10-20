// 输入框回复、文档列表共用的小工具：路径、相对时间、单行文件名、分隔线，都是纯函数。

import { t } from './i18n.js'

/** @param {string} path */
export function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

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
 * @param {string | undefined} at ISO 时间 @param {number} now 毫秒 @param {import('./i18n.js').Lang} [lang]
 */
export function ago(at, now, lang = 'zh') {
  const at_ = at ? Date.parse(at) : NaN
  if (Number.isNaN(at_)) return ''
  const min = Math.floor(Math.max(0, now - at_) / 60_000)
  if (min < 1) return t(lang, 'justNow')
  if (min < 60) return t(lang, 'minutesAgo', { n: min })
  const hours = Math.floor(min / 60)
  if (hours < 24) return t(lang, 'hoursAgo', { n: hours })
  return t(lang, 'daysAgo', { n: Math.floor(hours / 24) })
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

/**
 * Markdown 链接：文字里的方括号、圆括号和反斜杠转义，免得文件名把链接截断。
 * @param {string} text @param {string} url
 */
export function markdownLink(text, url) {
  return `[${text.replace(/[\\[\]()]/g, ch => `\\${ch}`)}](${url})`
}
