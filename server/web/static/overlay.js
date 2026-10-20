// 文档页的界面：放在 Shadow DOM 里，不受页面样式影响，也不影响页面。
// 顶栏固定在页面顶部（文件名、待发送回复数、改动标注）；选中文字后在选区上方弹出照 Claude 自带样式的回复框；
// 每条待发送回复的原文后面跟一个编号小圆点（由 review.js 插进正文），点圆点时显示「编号 · 你的回复」，右上角是删除图标。
// 通过在 <head> 注入样式给 <html> 加上顶部留白，正文不被顶栏遮挡。数值见设计文档第 4 节和 6.1～6.3。

import { t } from './i18n.js'

/** 顶栏高度：正文顶部留出同样的空白。*/
export const BAR_HEIGHT = 40
/** 回复框宽度。*/
const POP_WIDTH = 380
/** 回复框与选区之间的距离。*/
const POP_GAP = 8

const STYLE = `
:host {
  all: initial;
  color-scheme: light;
  --page: #FAF9F5; --bar: var(--page); --pop: #FFFFFF;
  --ink: #3d3d3a; --mute: #8b8f97; --accent: #c96442; --on-accent: #FFFFFF;
  --divider: rgba(0,0,0,.12); --edge: rgba(0,0,0,.10); --quote: rgba(0,0,0,.20); --hover: rgba(0,0,0,.05);
  --toast-bg: #30302E; --toast-fg: #FAF9F5;
  --shadow: 0 8px 24px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.08);
  --sans: Inter, "SF Pro Text", "PingFang SC", system-ui, -apple-system, sans-serif;
  font: 400 13px/18px var(--sans);
  font-feature-settings: "tnum";
  color: var(--ink);
}
:host([data-theme="dark"]) {
  color-scheme: dark;
  --page: #262624; --pop: #30302e;
  --ink: #e6e4dd; --mute: #9aa0a8; --accent: #e8916f; --on-accent: #1b1b1a;
  --divider: rgba(255,255,255,.16); --edge: rgba(255,255,255,.13); --quote: rgba(255,255,255,.22); --hover: rgba(255,255,255,.06);
  --toast-bg: #FAF9F5; --toast-fg: #141413;
  --shadow: 0 8px 24px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.3);
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, select, textarea { margin: 0; font: inherit; color: inherit; }
button { padding: 0; cursor: pointer; background: none; border: 0; }
button:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--accent); }
.icon { display: block; flex: none; }

.bar { position: fixed; z-index: 5; top: 0; left: 0; right: 0; height: ${BAR_HEIGHT}px; display: flex; align-items: center;
  gap: 8px; padding: 0 16px; background: var(--bar); border-bottom: 1px solid var(--divider); }
.bar .file { color: var(--mute); }
.picker { position: relative; display: flex; align-items: center; gap: 4px; min-width: 0; height: 28px; padding: 0 6px;
  margin: 0 -6px; border-radius: 8px; }
.picker.many:hover { background: var(--hover); }
.picker:has(select:focus-visible) { box-shadow: 0 0 0 1px var(--accent); }
.picker .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.picker .icon { color: var(--mute); }
.picker:not(.many) .icon, .picker:not(.many) select { display: none; }
.picker select { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; cursor: pointer; opacity: 0; border: 0;
  appearance: none; }
.bar .gap { flex: 1; }
.bar .right { display: flex; align-items: center; gap: 16px; white-space: nowrap; font-size: 12px; color: var(--mute); }
.bar .pending { display: inline-flex; align-items: center; gap: 6px; }
.bar .pending .icon { color: var(--accent); }
.changes { display: inline-flex; align-items: center; gap: 2px; }
.changes .label { margin-right: 4px; color: var(--accent); }
.changes button { display: grid; place-items: center; width: 22px; height: 22px; color: var(--mute); border-radius: 6px; }
.changes button:hover { color: var(--ink); background: var(--hover); }

.pop { position: fixed; z-index: 7; width: ${POP_WIDTH}px; padding: 12px 14px 10px; background: var(--pop);
  border: 1px solid var(--edge); border-radius: 12px; box-shadow: var(--shadow); }
.pop .pq { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; padding-left: 10px;
  font-size: 14px; line-height: 22px; color: var(--mute); word-break: break-word; border-left: 2px solid var(--quote); }
.pop .pi { display: flex; align-items: flex-end; gap: 8px; margin-top: 12px; }
.pop textarea { flex: 1; display: block; min-width: 0; max-height: 154px; padding: 0; font-size: 15px; line-height: 22px;
  color: var(--ink); background: transparent; border: 0; outline: none; resize: none; overflow-y: auto; }
.pop textarea::placeholder { color: var(--mute); }
.pop .add { display: grid; place-items: center; width: 24px; height: 24px; color: var(--mute); border-radius: 6px; }
.pop .add.ready { color: var(--ink); }
.pop .add:disabled { cursor: default; }

.card { position: fixed; z-index: 6; width: 260px; padding: 8px 10px; background: var(--pop); border: 1px solid var(--edge);
  border-radius: 10px; box-shadow: var(--shadow); }
.card .head { font-size: 12px; line-height: 20px; color: var(--mute); padding-right: 24px; }
.card .body { margin: 2px 0 2px; font-size: 13px; line-height: 18px; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 8; overflow: hidden; }
.card .del { position: absolute; top: 6px; right: 6px; display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; color: var(--mute); border-radius: 6px; }
.card .del:hover { color: var(--ink); background: var(--hover); }

.toast { position: fixed; z-index: 8; bottom: 16px; left: 0; right: 0; width: max-content; max-width: 80%; margin: 0 auto;
  padding: 8px 14px; font-size: 13px; color: var(--toast-fg); background: var(--toast-bg); border-radius: 8px;
  box-shadow: var(--shadow); }
`

// 图标取自 lucide（https://lucide.dev，ISC 许可），圆和矩形改写成等价路径。
const ICONS = {
  'file-text': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  reply: ['M20 18v-2a4 4 0 0 0-4-4H4', 'm9 17-5-5 5-5'],
  'message-circle-plus': ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z', 'M8 12h8', 'M12 8v8'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'trash-2': ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6'],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** icon('reply', 14)：线性图标，颜色跟随文字。*/
function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs = {
    class: 'icon',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v))
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/** el('div', { class: 'x', onclick: fn }, '文本', child)：字符串子节点一律作为文本插入。*/
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue
    if (k === 'class') node.className = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false))
  return node
}

const basename = p => p.split('/').pop()

/**
 * 回复框放在哪：选区上方放得下（不压到顶栏）就放上方，否则放下方（放不下时贴着窗口底边）；左边对齐选区，靠右时左移，不出界。
 * @param {{ top: number, bottom: number, left: number }} selRect 选区（视口坐标）
 * @param {{ width: number, height: number, top?: number }} viewport top 为可用区域的上沿（顶栏下方）
 * @param {{ width: number, height: number }} size 回复框大小
 * @returns {{ top: number, left: number, side: 'above' | 'below' }}
 */
export function popoverPlace(selRect, viewport, size) {
  const topLimit = viewport.top ?? 0
  const isAbove = selRect.top - POP_GAP - size.height >= topLimit
  const left = Math.max(8, Math.min(selRect.left, viewport.width - size.width - 8))
  if (isAbove) return { top: selRect.top - POP_GAP - size.height, left, side: 'above' }
  // 选区很高、下方也放不下时贴着窗口底边，不跑到屏幕外
  return { top: Math.max(topLimit, Math.min(selRect.bottom + POP_GAP, viewport.height - size.height - 8)), left, side: 'below' }
}

/** 回复框里有字才能加入。@param {string} text */
export function canSubmit(text) {
  return typeof text === 'string' && text.trim() !== ''
}

/**
 * 一条回复的全局编号（和输入框上方的回复区一致）：在 /api/replies 的分组里找。
 * @param {{ replies: { id: string, no: number }[] }[] | undefined} groups @param {string} id
 */
export function numberOf(groups, id) {
  for (const g of groups ?? []) {
    const r = g.replies.find(one => one.id === id)
    if (r) return r.no
  }
  return undefined
}

/**
 * @param {{ onAdd: (text: string) => void, onDelete: (id: string) => void, onSwitchDoc: (id: string) => void, onEditorClosed?: () => void,
 *   onChanges?: (action: 'prev' | 'next' | 'clear') => void }} h
 * @param {{ lang: 'zh' | 'en' }} opts
 */
export function createOverlay(h, { lang }) {
  const host = document.createElement('doc-review-overlay')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  // 给正文让位的样式放在 <head> 里：正文的 MutationObserver 只看 <body>，改它不会触发重建映射
  const layout = document.createElement('style')
  layout.dataset.docReview = 'layout'
  layout.textContent = `html{padding-top:${BAR_HEIGHT}px !important;scroll-padding-top:${BAR_HEIGHT + 8}px !important}`
  document.head.appendChild(layout)

  // 顶栏：文件名（本会话有多个文档时点它切换，透明的 select 盖在上面），右边是改动标注和待发送数
  const docs = el('select', { title: t(lang, 'switchDoc'), 'aria-label': t(lang, 'switchDoc') })
  const docName = el('span', { class: 'name' })
  const picker = el('div', { class: 'picker' }, docName, icon('chevron-down', 14), docs)
  const pendingEl = el('span', { class: 'pending' })
  const changesSlot = el('span', { class: 'changes', hidden: true })
  const bar = el(
    'div',
    { class: 'bar' },
    el('span', { class: 'file' }, icon('file-text', 16)),
    picker,
    el('span', { class: 'gap' }),
    el('span', { class: 'right' }, changesSlot, pendingEl),
  )

  // 回复框：原文（最多两行）、输入框、右下角的加入图标
  const quoteEl = el('div', { class: 'pq' })
  const textarea = el('textarea', { rows: '1', placeholder: t(lang, 'replyHint'), 'aria-label': t(lang, 'replyHint') })
  const addBtn = el('button', { class: 'add', title: t(lang, 'addReply'), 'aria-label': t(lang, 'addReply'), disabled: true }, icon('message-circle-plus', 18))
  const pop = el('div', { class: 'pop', hidden: true }, quoteEl, el('div', { class: 'pi' }, textarea, addBtn))

  // 点编号弹出的卡片：编号 · 你的回复、内容，右上角删除图标
  const cardHead = el('div', { class: 'head' })
  const cardBody = el('div', { class: 'body' })
  const delBtn = el('button', { class: 'del', title: t(lang, 'deleteReply'), 'aria-label': t(lang, 'deleteReply') }, icon('trash-2', 15))
  const card = el('div', { class: 'card', hidden: true }, cardHead, cardBody, delBtn)
  const toastEl = el('div', { class: 'toast', hidden: true })
  shadow.append(el('style', {}, STYLE), bar, card, pop, toastEl)

  let quoteText = ''
  let selRect = null
  let toastTimer = 0
  let docsKey = ''
  /** 当前标记：id → { no, body } */
  let marks = new Map()
  let cardId = ''

  docs.addEventListener('change', () => h.onSwitchDoc(docs.value))

  // 改动标注：「改了 N 处」、⌃ ⌄ 在改动之间跳、✕ 清掉
  const changesLabel = el('span', { class: 'label' })
  const navBtn = (name, key, fn) => el('button', { title: t(lang, key), 'aria-label': t(lang, key), onclick: fn }, icon(name, 14))
  changesSlot.append(
    changesLabel,
    navBtn('chevron-up', 'prevChange', () => h.onChanges?.('prev')),
    navBtn('chevron-down', 'nextChange', () => h.onChanges?.('next')),
    navBtn('x', 'clearChanges', () => h.onChanges?.('clear')),
  )

  // ── 回复框 ──
  const syncAdd = () => {
    const ok = canSubmit(textarea.value)
    addBtn.disabled = !ok
    addBtn.classList.toggle('ready', ok)
  }
  const grow = () => {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 154)}px`
  }
  textarea.addEventListener('input', () => {
    syncAdd()
    grow()
    if (selRect) placePop()
  })
  textarea.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return // 输入法组字时的回车不算加入
    if (e.key === 'Escape') {
      e.preventDefault()
      closeEditor()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'c' && textarea.selectionStart === textarea.selectionEnd) {
      // 焦点在回复框里时，⌘C 仍然复制选中的原文
      e.preventDefault()
      navigator.clipboard?.writeText(quoteText).catch(() => {})
    }
  })
  addBtn.addEventListener('mousedown', e => e.preventDefault())
  addBtn.addEventListener('click', submit)
  // 点框外取消：框里的点击不算
  document.addEventListener(
    'mousedown',
    e => {
      if (pop.hidden || e.composedPath().includes(pop)) return
      closeEditor()
    },
    true,
  )

  // 先交给页面保存、再通知关闭：页面据此知道保存还在进行，不会趁这时整页刷新丢掉这条回复
  function submit() {
    const text = textarea.value.trim()
    if (!canSubmit(text)) return
    closeEditor(() => h.onAdd(text))
  }

  function placePop() {
    const at = popoverPlace(selRect, { width: document.documentElement.clientWidth || innerWidth, height: innerHeight, top: BAR_HEIGHT + 8 }, {
      width: POP_WIDTH,
      height: pop.offsetHeight,
    })
    pop.style.top = `${at.top}px`
    pop.style.left = `${at.left}px`
  }

  function closeEditor(beforeNotify) {
    if (pop.hidden) return
    pop.hidden = true
    selRect = null
    beforeNotify?.()
    h.onEditorClosed?.()
  }

  // ── 点编号弹出的卡片 ──
  function showCard(id, rect) {
    const m = marks.get(id)
    if (!m || !rect) return
    cardId = id
    fillCard(m)
    card.hidden = false
    placeCard(rect)
  }
  /** @param {{ no?: number, body: string }} m */
  function fillCard(m) {
    cardHead.textContent = `${m.no ?? ''}${m.no ? ' · ' : ''}${t(lang, 'yourReply')}`
    cardBody.textContent = m.body
  }
  /** @param {DOMRect} rect */
  function placeCard(rect) {
    const left = Math.max(8, Math.min(rect.right - 20, (document.documentElement.clientWidth || innerWidth) - card.offsetWidth - 8))
    const below = rect.bottom + 6
    const top = below + card.offsetHeight > innerHeight - 8 ? rect.top - card.offsetHeight - 6 : below
    card.style.left = `${left}px`
    card.style.top = `${Math.max(BAR_HEIGHT + 4, top)}px`
  }
  function hideCard() {
    card.hidden = true
    cardId = ''
  }
  // 点卡片以外的地方、按 Esc 收起（点编号自己切换，见 toggleMark）
  document.addEventListener('mousedown', e => {
    if (!card.hidden && !e.composedPath().includes(card)) hideCard()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !card.hidden) hideCard()
  })
  delBtn.addEventListener('click', () => {
    const id = cardId
    hideCard()
    if (id) h.onDelete(id)
  })

  return {
    host,
    /** 外框的明暗和底色：theme 是 light / dark；barColor 是顶栏底色（HTML 文档用页面实际的背景色），不给就用默认底色。*/
    setTheme(theme, barColor) {
      host.dataset.theme = theme
      if (barColor) host.style.setProperty('--bar', barColor)
      else host.style.removeProperty('--bar')
    },
    /** 顶栏：文件名和切换列表、待发送回复数。@param {{ docs: { id: string, path: string }[], doc: { id: string, path: string }, pending: number }} s */
    render({ docs: docList, doc, pending }) {
      const nextDocsKey = JSON.stringify([doc.id, docList.map(d => [d.id, d.path])])
      if (nextDocsKey !== docsKey) {
        docsKey = nextDocsKey
        docs.replaceChildren(...docList.map(d => el('option', { value: d.id, selected: d.id === doc.id }, basename(d.path))))
        const current = docList.find(d => d.id === doc.id)
        docName.textContent = basename(current?.path ?? doc.path)
        picker.title = current?.path ?? doc.path
        picker.classList.toggle('many', docList.length > 1)
      }
      pendingEl.replaceChildren(
        ...(pending > 0 ? [icon('reply', 14), el('span', {}, t(lang, 'pendingOnPage', { n: pending }))] : [el('span', {}, t(lang, 'noReplies'))]),
      )
    },
    /** 在选区（视口坐标）旁打开回复框，原文 quote 显示在框顶；text 是框里预先填好的字（加入失败时恢复刚写的）。*/
    openEditor(rect, quote, text = '') {
      quoteText = quote
      quoteEl.textContent = quote.replace(/\s+/g, ' ').trim()
      textarea.value = text
      syncAdd()
      selRect = rect
      card.hidden = true
      pop.hidden = false
      grow()
      placePop()
      textarea.focus({ preventScroll: true })
    },
    closeEditor,
    isEditing() {
      return !pop.hidden
    },
    /** 页面滚动或重排时，回复框跟着选区走。@param {DOMRect | null} rect */
    moveEditor(rect) {
      if (pop.hidden || !rect) return
      selRect = rect
      placePop()
    },
    /** 当前的回复（编号和内容），卡片据此显示。@param {{ id: string, no?: number, body: string }[]} list */
    setMarks(list) {
      marks = new Map(list.map(m => [m.id, m]))
      if (!cardId) return
      const m = marks.get(cardId)
      if (!m) hideCard()
      else fillCard(m)
    },
    /** 开着的卡片属于哪条回复（没开时为空串）。*/
    cardMark() {
      return card.hidden ? '' : cardId
    },
    /** 页面滚动、重排后把卡片挪到圆点旁；圆点不见了就收起。@param {DOMRect} [rect] */
    moveCard(rect) {
      if (card.hidden) return
      if (!rect || (rect.width === 0 && rect.height === 0)) hideCard()
      else placeCard(rect)
    },
    /** 点了某条回复的编号（id 和编号的视口矩形）：卡片没开或开的是别的就打开，开的就是它就收起。@param {string} id @param {DOMRect} [rect] */
    toggleMark(id, rect) {
      if (!card.hidden && cardId === id) hideCard()
      else showCard(id, rect)
    },
    /** 顶栏右侧的「改了 N 处」；0 时不显示。@param {number} n */
    setChanges(n) {
      changesSlot.hidden = n === 0
      changesLabel.textContent = t(lang, 'changes', { n })
    },
    toast(text) {
      toastEl.textContent = text
      toastEl.hidden = false
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (toastEl.hidden = true), 3000)
    },
  }
}
