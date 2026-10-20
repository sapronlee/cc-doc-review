// 文档页入口：md 外壳页和注入后的 HTML 页面共用。

import { captureQuote, locate } from './anchor.js'
import { buildTextMap, offsetOf, rangeOf } from './textmap.js'
import { createApi } from './api.js'
import { blocksOf, diffBlocks, shouldAutoScroll } from './diff.js'
import { pageLang, t } from './i18n.js'
import { createOverlay, numberOf } from './overlay.js'
import { isUnstyled, pageTheme, PLAIN_STYLE } from './theme.js'

const params = new URLSearchParams(location.search)
const docId = params.get('doc')
const token = params.get('t')
const lang = pageLang(params.get('lang'), navigator.language)
const mode = document.querySelector('script[data-doc-review]')?.dataset.docReview ?? 'md'
const root = mode === 'md' ? document.getElementById('content') : document.body
const api = createApi(token)

let doc = null
let docList = []
let replyGroups = [] // 本会话待发送的回复（/api/replies 的 groups），编号以它为准
let map = null
let pending = null // 当前选区 { start, end, quote, prefix, suffix }，原文在选中时就取好
const anchors = new Map() // 回复 id → { start, end }
let saving = 0 // 进行中的保存数
let isReloadDeferred = false // HTML 文件变了，但回复框开着或还在保存，等它们结束再刷新
let observer = null
let rebuildTimer = 0
let frame = 0
/** 正文里编号小圆点的属性名，值是回复 id。*/
const DOT_ATTR = 'data-dr-dot'
/** 标为改动的段落带这个属性。*/
const CHANGED_ATTR = 'data-dr-changed'
/** HTML 文档整页刷新前把各段文字存在这里，刷新后比较。*/
const BLOCKS_KEY = `dr-blocks:${docId}`
/** 上一版内容的各段文字：下一次内容变化时和它比较。*/
let snapshot = []
/** 当前标出的改动段落，和 ⌃ ⌄ 跳到了第几处。*/
let changed = []
let changeAt = -1
/** 你最近一次滚动页面的时刻：3 秒内刷新不自动滚走。*/
let lastScrollAt = 0

const highlightStyle = installHighlightStyle()
if (mode === 'html' && isUnstyled(document)) installPlainStyle()
const ui = createOverlay({ onAdd, onDelete, onSwitchDoc, onEditorClosed, onChanges }, { lang })
syncTheme()
watchTheme()

watchDom()
await renderContent()
await refreshComments()
restoreScroll()
startDiff()
listen()

document.addEventListener('mouseup', e => {
  if (e.composedPath().includes(ui.host)) return
  // 点编号圆点时按下被拦住、选区没折叠：不拿旧选区重开回复框
  if (e.target instanceof Element && e.target.closest(`[${DOT_ATTR}]`)) return
  setTimeout(onSelection, 0)
})
// 回复框是固定定位的：页面（或页面里的滚动容器）滚动、窗口大小变了就跟着选区重新摆放
addEventListener('scroll', schedulePlace, { capture: true, passive: true })
addEventListener('resize', schedulePlace)
// 只记你自己的滚动（滚轮、触控、翻页键），页面恢复位置、自动滚到改动不算
for (const type of ['wheel', 'touchmove']) addEventListener(type, () => (lastScrollAt = Date.now()), { passive: true })
addEventListener('keydown', e => {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) lastScrollAt = Date.now()
})
if (mode === 'html') document.addEventListener('click', onHashLink)
// 别的文档加减回复会让编号变化：隔几秒取一次编号
setInterval(() => {
  if (document.visibilityState === 'visible' && doc) refreshNumbers()
}, 3000)

// 回复标记：淡强调色底加下划线；正在回复的选区用浅蓝底，焦点移到回复框后仍看得出选了什么
function installHighlightStyle() {
  const style = document.createElement('style')
  style.dataset.docReview = ''
  document.head.appendChild(style)
  return style
}

// 编号小圆点：强调色底、白字、直径 16，数字用 ::before 画，不进正文文字（不影响定位和复制）
function setHighlightTheme(theme) {
  const [fill, line, accent, onAccent] =
    theme === 'dark'
      ? ['rgba(232,145,111,.18)', 'rgba(232,145,111,.7)', '#e8916f', '#1b1b1a']
      : ['rgba(201,100,66,.14)', 'rgba(201,100,66,.6)', '#c96442', '#ffffff']
  highlightStyle.textContent =
    `::highlight(dr-reply){background:${fill};text-decoration:underline;text-decoration-color:${line};` +
    'text-decoration-thickness:1.5px;text-underline-offset:3px}' +
    '::highlight(dr-pending){background:rgba(80,140,255,.28)}' +
    `[${DOT_ATTR}]{display:inline-block;box-sizing:border-box;width:16px;height:16px;margin:0 1px 0 2px;padding:0;` +
    `border-radius:50%;background:${accent};color:${onAccent};vertical-align:1px;text-align:center;text-indent:0;` +
    'font:600 11px/16px Inter,"SF Pro Text","PingFang SC",system-ui,sans-serif;font-feature-settings:"tnum";' +
    'letter-spacing:0;text-decoration:none;user-select:none;cursor:pointer}' +
    `[${DOT_ATTR}]::before{content:attr(data-n)}` +
    // 改过的段落：左侧 3 像素强调色竖线、淡强调色底；表格行画在单元格上
    `[${CHANGED_ATTR}]:not(tr){border-left:3px solid ${accent};padding-left:10px;margin-left:-13px;` +
    `background:${theme === 'dark' ? 'rgba(232,145,111,.10)' : 'rgba(201,100,66,.08)'};border-radius:0 4px 4px 0}` +
    `tr[${CHANGED_ATTR}]>*{background:${theme === 'dark' ? 'rgba(232,145,111,.10)' : 'rgba(201,100,66,.08)'}}` +
    `tr[${CHANGED_ATTR}]>:first-child{box-shadow:inset 3px 0 0 ${accent}}`
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
  if (mode === 'md') {
    ui.setTheme(prefersDark ? 'dark' : 'light')
    return setHighlightTheme(prefersDark ? 'dark' : 'light')
  }
  const html = getComputedStyle(document.documentElement)
  const theme = pageTheme({
    body: document.body ? getComputedStyle(document.body).backgroundColor : '',
    html: html.backgroundColor,
    scheme: html.colorScheme,
    prefersDark,
  })
  ui.setTheme(theme.theme, theme.bar)
  setHighlightTheme(theme.theme)
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
      p.textContent = t(lang, 'pageMissing', { status: res.status })
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
  ui.closeEditor()
}

async function refreshComments() {
  try {
    doc = await api.get(`/api/doc?doc=${docId}`)
    if (mode === 'md') document.title = doc.path.split('/').pop()
    const session = encodeURIComponent(doc.session)
    ;[docList, { groups: replyGroups }] = await Promise.all([api.get(`/api/docs?session=${session}`), api.get(`/api/replies?session=${session}`)])
    reanchor()
  } catch (err) {
    ui.toast(t(lang, 'pageLoadFailed', { reason: err.message }))
  }
}

async function refreshNumbers() {
  try {
    const { groups } = await api.get(`/api/replies?session=${encodeURIComponent(doc.session)}`)
    if (JSON.stringify(groups.map(g => g.replies.map(r => [r.id, r.no]))) === JSON.stringify(replyGroups.map(g => g.replies.map(r => [r.id, r.no])))) return
    replyGroups = groups
    numberDots()
  } catch {
    // 一时取不到：编号不变
  }
}

// 按当前文本重新定位全部回复，刷新顶栏、标记和编号。找不到原文的不画标记（回复区的卡片照旧保留）。
function reanchor() {
  if (!doc) return
  anchors.clear()
  for (const c of doc.comments) {
    if (c.status !== 'draft') continue
    const pos = locate(map.text, c)
    if (pos) anchors.set(c.id, pos)
  }
  ui.render({ docs: docList, doc, pending: doc.comments.filter(c => c.status === 'draft').length })
  ui.setMarks(doc.comments.map(c => ({ id: c.id, no: numberOf(replyGroups, c.id), body: c.body })))
  insertDots()
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

// 有未处理的正文变化就重建映射、重新定位回复；回复框没开时按新映射重新取当前选区（开着时选区已移进回复框）。
function syncMap() {
  clearTimeout(rebuildTimer)
  const hasQueued = rebuildTimer !== 0
  rebuildTimer = 0
  if (!observer) return
  const isDirty = observer.takeRecords().some(isPageMutation) || hasQueued
  if (!isDirty) return
  map = buildTextMap(root)
  reanchor()
  if (pending && !ui.isEditing()) updatePending()
}

function paint() {
  const marks = new Highlight()
  for (const pos of anchors.values()) marks.add(rangeOf(map, pos.start, pos.end))
  CSS.highlights.set('dr-reply', marks)
  paintPending()
}

function paintPending() {
  if (pending && ui.isEditing()) CSS.highlights.set('dr-pending', new Highlight(rangeOf(map, pending.start, pending.end)))
  else CSS.highlights.delete('dr-pending')
}

// 编号小圆点插在每条回复原文的末尾。从后往前插：插入会拆开文本节点，后面的先插不影响前面的位置。
// 插完重建映射（文字没变，偏移照旧有效），并丢掉这次插入引起的正文变化记录，免得触发重建循环。
function insertDots() {
  ownMutation(() => {
    for (const old of root.querySelectorAll(`[${DOT_ATTR}]`)) old.remove()
    const list = [...anchors].sort((a, b) => b[1].end - a[1].end)
    for (const [id, pos] of list) {
      const r = rangeOf(map, pos.start, pos.end)
      r.collapse(false)
      const dot = document.createElement('span')
      dot.setAttribute(DOT_ATTR, id)
      dot.setAttribute('aria-hidden', 'true')
      // 点编号才弹出回复卡片，再点一次收起；按下就处理，不让它变成选中文字，也不让外面的「点别处收起」先把卡片关掉
      dot.addEventListener('mousedown', e => {
        e.preventDefault()
        e.stopPropagation()
        ui.toggleMark(id, dot.getBoundingClientRect())
      })
      // 圆点可能插在链接、折叠标题等可点的元素里：点圆点不触发页面自己的点击
      dot.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
      })
      r.insertNode(dot)
    }
    numberDots()
    map = buildTextMap(root)
  })
}

function numberDots() {
  ownMutation(() => {
    for (const dot of root.querySelectorAll(`[${DOT_ATTR}]`)) {
      const no = numberOf(replyGroups, dot.getAttribute(DOT_ATTR))
      dot.dataset.n = no === undefined ? '' : String(no)
    }
  })
  if (doc) ui.setMarks(doc.comments.map(c => ({ id: c.id, no: numberOf(replyGroups, c.id), body: c.body })))
}

// 改正文（插圆点、标改动）时不让自己的改动触发重建；但之前已经排着的页面自己的改动要留着，稍后照常重建映射
function ownMutation(fn) {
  const hadPage = observer ? observer.takeRecords().some(isPageMutation) : false
  fn()
  observer?.takeRecords()
  if (hadPage && !rebuildTimer) rebuildTimer = setTimeout(syncMap, 0)
}

function schedulePlace() {
  if (frame || !((pending && ui.isEditing()) || ui.cardMark())) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (pending && ui.isEditing()) ui.moveEditor(rangeOf(map, pending.start, pending.end).getBoundingClientRect())
    // 编号卡片跟着它的圆点走
    const id = ui.cardMark()
    if (id) ui.moveCard(root.querySelector(`[${DOT_ATTR}="${CSS.escape(id)}"]`)?.getBoundingClientRect())
  })
}

function onSelection() {
  syncMap()
  updatePending()
  if (!pending) return
  ui.openEditor(rangeOf(map, pending.start, pending.end).getBoundingClientRect(), pending.quote)
  paintPending()
}

// 取当前选区的位置和原文；不在正文里、是空白、或落在流程图、图片、画布、嵌入内容里时没有选区。
function updatePending() {
  pending = null
  const sel = getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
  const r = sel.getRangeAt(0)
  if (!root.contains(r.commonAncestorContainer)) return
  if ([r.startContainer, r.endContainer, r.commonAncestorContainer].some(isUnreplyable)) return
  const start = offsetOf(map, r.startContainer, r.startOffset)
  const end = offsetOf(map, r.endContainer, r.endOffset)
  if (end <= start || !map.text.slice(start, end).trim()) return
  pending = { start, end, ...captureQuote(map.text, start, end) }
}

/** 本次不支持回复的内容：Mermaid 图、图片、画布、嵌入内容和 SVG。*/
function isUnreplyable(node) {
  const elem = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  return Boolean(elem?.closest('.mermaid, svg, img, picture, canvas, iframe, video, object, embed'))
}

// 加入回复：原文、前后文在选中时就取好了，这里直接用（焦点已在回复框里，页面上的选区不可靠）
async function onAdd(body) {
  const at = pending
  if (!at) return
  saving++
  try {
    await api.send('POST', '/api/comments', { doc: docId, quote: at.quote, prefix: at.prefix, suffix: at.suffix, body })
    getSelection().removeAllRanges()
    pending = null
    await refreshComments()
  } catch (err) {
    ui.toast(t(lang, 'pageSaveFailed', { reason: err.message }))
    // 没加上：把回复框连同刚写的字重新打开，不让输入白费
    if (pending === at) ui.openEditor(rangeOf(map, at.start, at.end).getBoundingClientRect(), at.quote, body)
  } finally {
    saving--
    paintPending()
    reloadIfDeferred()
  }
}

function onEditorClosed() {
  paintPending()
  reloadIfDeferred()
}

function onSwitchDoc(id) {
  location.href = `/review?doc=${encodeURIComponent(id)}&t=${token}&lang=${lang}`
}

async function onDelete(id) {
  try {
    await api.send('DELETE', `/api/comments?doc=${docId}&id=${encodeURIComponent(id)}`)
    await refreshComments()
  } catch (err) {
    ui.toast(t(lang, 'deleteFailed', { reason: err.message }))
  }
}

// 注入的 <base> 会让页内锚点 href="#x" 跳到 /asset/… 离开文档页：改为在本页内滚动。
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
    ui.toast(t(lang, 'pageDisconnected'))
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
      await refreshComments()
      markChanges(snapshot)
      return
    }
    await refreshComments()
  })
}

// HTML 文件变化后整页刷新；回复框开着或保存未完成时推迟，免得丢掉正在写的回复。
function reloadIfDeferred() {
  if (!isReloadDeferred || ui.isEditing() || saving > 0) return
  isReloadDeferred = false
  sessionStorage.setItem('dr-scroll', String(scrollY))
  try {
    sessionStorage.setItem(BLOCKS_KEY, JSON.stringify(blocksOf(root).map(b => b.text)))
  } catch {
    // 存不下就不比较：刷新后不标改动
  }
  location.reload()
}

function restoreScroll() {
  const saved = sessionStorage.getItem('dr-scroll')
  if (saved === null) return
  sessionStorage.removeItem('dr-scroll')
  scrollTo(0, Number(saved))
}

// 记下打开时的内容；HTML 文档整页刷新回来时，和刷新前存的那版比较（比较完删掉，只比较本页打开期间的变化）
function startDiff() {
  if (mode !== 'html') {
    snapshot = blocksOf(root).map(b => b.text)
    return
  }
  const saved = sessionStorage.getItem(BLOCKS_KEY)
  sessionStorage.removeItem(BLOCKS_KEY)
  const run = () => {
    let prev = null
    try {
      prev = saved === null ? null : JSON.parse(saved)
    } catch {
      prev = null
    }
    if (Array.isArray(prev)) markChanges(prev)
    else snapshot = blocksOf(root).map(b => b.text)
  }
  // 等页面自己的脚本跑完（加载完再等一帧），免得把脚本生成的内容当成改动
  if (document.readyState === 'complete') requestAnimationFrame(run)
  else addEventListener('load', () => requestAnimationFrame(run), { once: true })
}

// 和上一版比较，标出新增或改过的段落；标注保留到下一次内容变化或点 ✕
function markChanges(prevTexts) {
  ownMutation(() => {
    for (const el of document.querySelectorAll(`[${CHANGED_ATTR}]`)) el.removeAttribute(CHANGED_ATTR)
  })
  const blocks = blocksOf(root)
  const next = blocks.map(b => b.text)
  changed = diffBlocks(prevTexts, next).map(i => blocks[i].el)
  snapshot = next
  changeAt = -1
  ownMutation(() => {
    for (const el of changed) el.setAttribute(CHANGED_ATTR, '')
  })
  ui.setChanges(changed.length)
  if (changed.length > 0 && shouldAutoScroll({ isEditorOpen: ui.isEditing(), lastScrollAt, now: Date.now() })) jumpTo(0)
}

function jumpTo(i) {
  changeAt = i
  changed[i]?.scrollIntoView({ block: 'center' })
}

function onChanges(action) {
  if (action === 'clear') {
    ownMutation(() => {
      for (const el of changed) el.removeAttribute(CHANGED_ATTR)
    })
    changed = []
    ui.setChanges(0)
    return
  }
  if (changed.length === 0) return
  const n = changed.length
  jumpTo(action === 'next' ? (changeAt + 1) % n : (changeAt - 1 + n) % n)
}
