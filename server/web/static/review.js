// 评审页入口：md 外壳页和注入后的 HTML 页面共用。

import { captureQuote, locate } from './anchor.js'
import { buildTextMap, offsetOf, rangeOf } from './textmap.js'
import { createApi } from './api.js'
import { createOverlay } from './overlay.js'
import { isUnstyled, pageTheme, PLAIN_STYLE } from './theme.js'

const params = new URLSearchParams(location.search)
const docId = params.get('doc')
const token = params.get('t')
const mode = document.querySelector('script[data-doc-review]')?.dataset.docReview ?? 'md'
const root = mode === 'md' ? document.getElementById('content') : document.body
const api = createApi(token)

let doc = null
let docList = []
let map = null
let pending = null // 当前选区 { start, end, quote, prefix, suffix }，原文在选中时就取好
const anchors = new Map() // 评论 id → { start, end }
let saving = 0 // 进行中的保存数
let isReloadDeferred = false // HTML 文件变了，但编辑框开着或还在保存，等它们结束再刷新
let observer = null
let rebuildTimer = 0
let flashTimer = 0

installHighlightStyle()
if (mode === 'html' && isUnstyled(document)) installPlainStyle()
const ui = createOverlay({ onComment, onSend, onApprove, onSwitchDoc, onEdit, onDelete, onEditorClosed, onReveal })
syncTheme()
watchTheme()

watchDom()
await renderContent()
await refreshComments()
restoreScroll()
listen()

document.addEventListener('mouseup', e => {
  if (e.composedPath().includes(ui.host)) return
  setTimeout(onSelection, 0)
})
document.addEventListener('click', onClickText)
if (mode === 'html') document.addEventListener('click', onHashLink)

function installHighlightStyle() {
  const style = document.createElement('style')
  style.dataset.docReview = ''
  style.textContent =
    '::highlight(dr-draft){background:rgba(239,159,39,.30)}::highlight(dr-sent){background:rgba(55,138,221,.22)}' +
    '::highlight(dr-flash){background:rgba(217,119,87,.35)}'
  document.head.appendChild(style)
}

// 页面自己没写样式时补上默认的边距和行高，免得文字贴着窗口边
function installPlainStyle() {
  const style = document.createElement('style')
  style.dataset.docReview = 'plain'
  style.textContent = PLAIN_STYLE
  document.head.appendChild(style)
}

// 外框跟着文档的明暗走：Markdown 是我们渲染的，跟随系统；HTML 按页面实际的背景色
function syncTheme() {
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches
  if (mode === 'md') return ui.setTheme(prefersDark ? 'dark' : 'light')
  const html = getComputedStyle(document.documentElement)
  const t = pageTheme({
    body: document.body ? getComputedStyle(document.body).backgroundColor : '',
    html: html.backgroundColor,
    scheme: html.colorScheme,
    prefersDark,
  })
  ui.setTheme(t.theme, t.bar)
}

// 系统明暗切换、页面加载完、页面脚本改了 <html> / <body> 的 class 或 style（切换主题）时重新判断
function watchTheme() {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme)
  if (mode !== 'html') return
  addEventListener('load', syncTheme)
  const watch = new MutationObserver(syncTheme)
  const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode'] }
  watch.observe(document.documentElement, opts)
  if (document.body) watch.observe(document.body, opts)
}

async function renderContent() {
  if (mode === 'md') {
    const res = await fetch(`/raw?doc=${docId}&t=${token}`)
    if (!res.ok) {
      const p = document.createElement('p')
      p.className = 'missing'
      p.textContent = `文件不存在或无法读取（${res.status}）。评论仍然保留。`
      root.replaceChildren(p)
    } else {
      const html = window.marked.parse(await res.text())
      root.replaceChildren(window.DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }))
      for (const code of root.querySelectorAll('pre code')) {
        if (code.classList.contains('language-mermaid')) {
          const div = document.createElement('div')
          div.className = 'mermaid'
          div.textContent = code.textContent
          code.parentElement.replaceWith(div)
        } else {
          window.hljs.highlightElement(code)
        }
      }
      await window.mermaid.run({ querySelector: '.mermaid' }).catch(() => {})
    }
  }
  map = buildTextMap(root)
  // 旧选区的偏移对新文本无效
  pending = null
  ui.hideFloat()
}

async function refreshComments() {
  try {
    doc = await api.get(`/api/doc?doc=${docId}`)
    if (mode === 'md') document.title = `评审：${doc.path.split('/').pop()}`
    docList = await api.get(`/api/docs?session=${encodeURIComponent(doc.session)}`)
    reanchor()
  } catch (err) {
    ui.toast(`加载评论失败：${err.message}`)
  }
}

// 按当前文本重新定位全部评论，并刷新高亮和评论栏（评论栏自己判断内容变了才重建列表）。
function reanchor() {
  if (!doc) return
  anchors.clear()
  for (const c of doc.comments) {
    if (c.status === 'resolved') continue
    const pos = locate(map.text, c)
    if (pos) anchors.set(c.id, pos)
  }
  ui.render({ docs: docList, doc, anchors })
  paint()
}

// HTML 页面自己的脚本（如加载后才渲染的 mermaid）会改 DOM，文本映射随之过期。
// 监听正文变化，最多 150ms 后重建映射；取偏移前也会先同步一次。
function watchDom() {
  if (mode !== 'html') return
  observer = new MutationObserver(records => {
    if (!records.some(isPageMutation)) return
    if (!rebuildTimer) rebuildTimer = setTimeout(syncMap, 150)
  })
  observer.observe(root, { subtree: true, childList: true, characterData: true })
}

function isPageMutation(r) {
  if (r.target === ui.host || ui.host.contains(r.target)) return false
  const nodes = [...r.addedNodes, ...r.removedNodes]
  return nodes.length === 0 || nodes.some(n => n !== ui.host)
}

// 有未处理的正文变化就重建映射、重新定位评论，并按新映射重新取当前选区。
function syncMap() {
  clearTimeout(rebuildTimer)
  const hasQueued = rebuildTimer !== 0
  rebuildTimer = 0
  if (!observer) return
  const isDirty = observer.takeRecords().some(isPageMutation) || hasQueued
  if (!isDirty) return
  map = buildTextMap(root)
  reanchor()
  if (pending) updatePending()
}

function paint() {
  const draft = new Highlight()
  const sent = new Highlight()
  for (const c of doc.comments) {
    const pos = anchors.get(c.id)
    if (pos) (c.status === 'draft' ? draft : sent).add(rangeOf(map, pos.start, pos.end))
  }
  CSS.highlights.set('dr-draft', draft)
  CSS.highlights.set('dr-sent', sent)
}

function onSelection() {
  syncMap()
  updatePending()
}

function updatePending() {
  pending = null
  const sel = getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ui.hideFloat()
  const r = sel.getRangeAt(0)
  if (!root.contains(r.commonAncestorContainer)) return ui.hideFloat()
  const start = offsetOf(map, r.startContainer, r.startOffset)
  const end = offsetOf(map, r.endContainer, r.endOffset)
  if (end <= start || !map.text.slice(start, end).trim()) return ui.hideFloat()
  pending = { start, end, ...captureQuote(map.text, start, end) }
  ui.showFloat(r.getBoundingClientRect())
}

function onComment() {
  syncMap()
  if (!pending) return
  const at = pending
  ui.openEditor(rangeOf(map, at.start, at.end).getBoundingClientRect(), '', async body => {
    saving++
    try {
      await api.send('POST', '/api/comments', { doc: docId, quote: at.quote, prefix: at.prefix, suffix: at.suffix, body })
      getSelection().removeAllRanges()
      pending = null
      await refreshComments()
    } catch (err) {
      ui.toast(`保存失败：${err.message}`)
    } finally {
      saving--
      reloadIfDeferred()
    }
  })
}

function onEditorClosed() {
  reloadIfDeferred()
}

async function onSend() {
  pending = null
  ui.hideFloat()
  try {
    const batch = await api.send('POST', '/api/send', { doc: docId })
    ui.toast(`已发送 ${batch.comments.length} 条，Claude 处理完会自动更新`)
    await refreshComments()
  } catch (err) {
    ui.toast(`发送失败：${err.message}`)
  }
}

async function onApprove() {
  pending = null
  ui.hideFloat()
  try {
    await api.send('POST', '/api/approve', { doc: docId })
    ui.toast('已通过，已通知 Claude')
    await refreshComments()
  } catch (err) {
    ui.toast(`没能通过：${err.message}`)
  }
}

function onSwitchDoc(id) {
  location.href = `/review?doc=${encodeURIComponent(id)}&t=${token}`
}

function onEdit(id) {
  const c = doc.comments.find(one => one.id === id)
  const pos = anchors.get(id)
  let rect = null
  if (pos) {
    const range = rangeOf(map, pos.start, pos.end)
    const start = range.startContainer
    // 先把评论所在位置滚进视口，否则编辑框会落到屏幕外
    ;(start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement)?.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = range.getBoundingClientRect()
    if (r.bottom > 0 && r.top < innerHeight) rect = r
  }
  if (!rect) rect = new DOMRect(16, innerHeight / 2, 0, 0)
  ui.openEditor(rect, c.body, async body => {
    saving++
    try {
      await api.send('PATCH', '/api/comments', { doc: docId, id, body })
      await refreshComments()
    } catch (err) {
      ui.toast(`修改失败：${err.message}`)
    } finally {
      saving--
      reloadIfDeferred()
    }
  })
}

async function onDelete(id) {
  try {
    await api.send('DELETE', `/api/comments?doc=${docId}&id=${encodeURIComponent(id)}`)
    await refreshComments()
  } catch (err) {
    ui.toast(`删除失败：${err.message}`)
  }
}

// 点评论卡片：把对应原文滚到视口中间，并让高亮闪一下
function onReveal(id) {
  syncMap()
  const pos = anchors.get(id)
  if (!pos) return
  const range = rangeOf(map, pos.start, pos.end)
  const start = range.startContainer
  // 先让所在元素进入视口（含页面内部的滚动容器），再按原文本身精确居中
  ;(start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement)?.scrollIntoView({ block: 'center', behavior: 'instant' })
  const r = range.getBoundingClientRect()
  if (r.width || r.height) {
    // 原文比半屏还高时让开头落在上方四分之一处，免得开头被滚出视口
    const y = r.height > innerHeight / 2 ? r.top - innerHeight / 4 : r.top + r.height / 2 - innerHeight / 2
    scrollBy({ top: y, behavior: 'instant' })
  }
  const flash = new Highlight(range)
  flash.priority = 1
  CSS.highlights.set('dr-flash', flash)
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => CSS.highlights.delete('dr-flash'), 1000)
}

// 点到高亮文字时，在评论栏里定位到那条评论
function onClickText(e) {
  if (e.composedPath().includes(ui.host) || !getSelection().isCollapsed) return
  let node
  let offset
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY)
  if (pos) {
    node = pos.offsetNode
    offset = pos.offset
  } else {
    const r = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    node = r?.startContainer
    offset = r?.startOffset
  }
  if (!node || !root.contains(node)) return
  syncMap()
  const at = offsetOf(map, node, offset)
  for (const [id, a] of anchors) {
    if (at >= a.start && at <= a.end) return ui.focus(id)
  }
}

// 注入的 <base> 会让页内锚点 href="#x" 跳到 /asset/… 离开评审页：改为在本页内滚动。
function onHashLink(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  if (e.composedPath().includes(ui.host)) return
  const a = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null
  if (!a || !root.contains(a)) return
  e.preventDefault()
  const hash = a.getAttribute('href')
  let id = hash.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    // 不是合法的百分号编码就按原样找
  }
  const target = id && (document.getElementById(id) ?? document.getElementsByName(id)[0])
  if (target) target.scrollIntoView()
  else if (!id || id.toLowerCase() === 'top') scrollTo(0, 0)
  // 用绝对地址：相对地址会按 <base> 解析成 /asset/…
  const url = new URL(location.href)
  url.hash = hash
  history.replaceState(history.state, '', url.href)
}

function listen() {
  const es = new EventSource(`/events?doc=${docId}&t=${token}`)
  let hasWarned = false
  es.addEventListener('open', () => {
    hasWarned = false
  })
  es.addEventListener('error', () => {
    if (hasWarned) return
    hasWarned = true
    ui.toast('评审服务已断开，请重新打开评审页')
  })
  addEventListener('pagehide', () => es.close())
  es.addEventListener('change', async ev => {
    const { file } = JSON.parse(ev.data)
    if (file) {
      if (mode === 'html') {
        isReloadDeferred = true
        reloadIfDeferred()
        return
      }
      const y = scrollY
      await renderContent()
      scrollTo(0, y)
    }
    await refreshComments()
  })
}

// HTML 文件变化后整页刷新；编辑框开着或保存未完成时推迟，免得丢掉正在写的评论。
function reloadIfDeferred() {
  if (!isReloadDeferred || ui.isEditing() || saving > 0) return
  isReloadDeferred = false
  sessionStorage.setItem('dr-scroll', String(scrollY))
  location.reload()
}

function restoreScroll() {
  const saved = sessionStorage.getItem('dr-scroll')
  if (saved === null) return
  sessionStorage.removeItem('dr-scroll')
  scrollTo(0, Number(saved))
}
