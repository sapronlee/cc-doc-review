// 文档内容刷新后标出改了哪里：按段落（标题、段落、列表项、表格行、代码块、引用块）比较新旧文字。纯函数加一个取段落的 DOM 小工具。

/** 参与比较的段落。*/
const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, tr, pre, blockquote'

/**
 * 按顺序取出 root 下的段落和它们的文字。只取最里层的：段落里还套着段落（列表项里的段落、引用块里的段落）时取里面那层。
 * @param {Element} root
 * @returns {{ el: Element, text: string }[]}
 */
export function blocksOf(root) {
  const out = []
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS)) continue
    out.push({ el, text: el.textContent ?? '' })
  }
  return out
}

/** 空白归一：连续空白算一个，首尾空白不算。@param {string} s */
const norm = s => s.replace(/\s+/g, ' ').trim()

/**
 * 新内容里新增或改过的段落下标：按最长公共子序列对齐新旧段落，对不上的新段落就是改动；删掉的段落不算（不显示）。
 * @param {string[]} prevTexts @param {string[]} nextTexts
 * @returns {number[]}
 */
export function diffBlocks(prevTexts, nextTexts) {
  const a = prevTexts.map(norm)
  const b = nextTexts.map(norm)
  const n = a.length
  const m = b.length
  // lcs[i][j]：a[i..]、b[j..] 的最长公共子序列长度
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const changed = []
  let i = 0
  let j = 0
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      i++
      j++
    } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++
    } else {
      // 新段落是空白（比如空的列表项）也不标
      if (b[j]) changed.push(j)
      j++
    }
  }
  return changed
}

/**
 * 刷新后要不要自动滚到第一处改动：回复框开着（正在写回复），或 3 秒内刚滚动过，就不滚，免得打断。
 * @param {{ isEditorOpen: boolean, lastScrollAt: number, now: number }} s
 */
export function shouldAutoScroll({ isEditorOpen, lastScrollAt, now }) {
  return !isEditorOpen && now - lastScrollAt >= 3000
}
