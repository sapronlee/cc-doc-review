// 把 root 下全部文本节点拼成一个字符串，在「字符偏移」和 DOM Range 之间互转。
// 偏移用 Range.toString() 计算，与拼接结果一致。

export function buildTextMap(root) {
  const nodes = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length })
    text += n.data
  }
  return { root, text, nodes }
}

export function offsetOf(map, node, offset) {
  const r = document.createRange()
  r.setStart(map.root, 0)
  r.setEnd(node, offset)
  return r.toString().length
}

// 找到位置 pos 所在的文本节点；结束点正好落在节点边界时取前一个节点的末尾。
function pointAt(map, pos, isEnd) {
  let lo = 0
  let hi = map.nodes.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = map.nodes[mid].start
    if (s < pos || (!isEnd && s === pos)) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const { node, start } = map.nodes[idx]
  return [node, Math.min(pos - start, node.data.length)]
}

export function rangeOf(map, start, end) {
  const r = document.createRange()
  if (map.nodes.length === 0) return r
  r.setStart(...pointAt(map, start, false))
  r.setEnd(...pointAt(map, end, true))
  return r
}
