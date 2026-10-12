// 评论的原文定位：保存选中文字及其前后文，文档改动后据此重新找到位置。

export const CONTEXT = 30

export function captureQuote(text, start, end, ctx = CONTEXT) {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ctx), start),
    suffix: text.slice(end, end + ctx),
  }
}

function commonSuffixLength(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefixLength(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

export function locate(text, { quote, prefix = '', suffix = '' }) {
  if (!quote) return null
  let best = null
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    const end = i + quote.length
    const score =
      commonSuffixLength(text.slice(Math.max(0, i - prefix.length), i), prefix) +
      commonPrefixLength(text.slice(end, end + suffix.length), suffix)
    if (!best || score > best.score) best = { start: i, end, score }
  }
  return best && { start: best.start, end: best.end }
}
