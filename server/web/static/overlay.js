// 评审界面：放在 Shadow DOM 里，不受页面样式影响，也不影响页面。
// 顶栏固定在页面顶部（标题、文件、状态、〔发送给 Claude〕〔通过〕），评论栏固定在右侧；
// 通过在 <head> 注入样式给 <html> 加上边距和右边距，正文不被遮挡。
// 顶栏、评论栏和正文共用一种底色，只用细线分区；明暗由页面通过 setTheme 指定（跟着文档走，见 theme.js）。

const SIDE_WIDTH = 300
/** 顶栏高度：评论栏、窄条从它下方开始，正文顶部留出同样的空白。*/
const BAR_HEIGHT = 48
const RAIL_WIDTH = 28
const STORE_KEY = 'doc-review:sidebar'
const NARROW_WIDTH = 720 // 视口比这窄时自动收起评论栏，临时展开时浮在正文上

const STYLE = `
:host {
  all: initial;
  color-scheme: light;
  --page: #FAF9F5; --side: #F5F4EE; --card: #FFFFFF; --bar: var(--page);
  --line: rgba(31,30,29,0.12); --line-strong: rgba(31,30,29,0.22);
  --fg: #141413; --fg2: #5E5D59; --fg3: #87867F; --hover: rgba(31,30,29,0.05);
  --brand: #D97757; --brand-hover: #C6613F; --on-brand: #FFFFFF;
  --warn-bg: #FAEEDA; --warn-fg: #854F0B;
  --info-bg: #E6F1FB; --info-fg: #185FA5;
  --danger-bg: #FCEBEB; --danger-fg: #A32D2D; --danger-line: #F09595;
  --ok-bg: #EAF3DE; --ok-fg: #3B6D11;
  --focus: #85B7EB; --ring: #378ADD;
  --toast-bg: #30302E; --toast-fg: #FAF9F5;
  --solid-bg: #141413; --solid-fg: #FAF9F5; --solid-hover: #3D3D3A;
  /* 评审状态的颜色，和输入框上方状态带一致：待评审粉、未发送黄、待确认绿、处理中和已通过灰 */
  --st-review: #db2777; --st-draft: #ca8a04; --st-confirm: #16a34a;
  --approve: #16a34a; --approve-hover: #15803d;
  --shadow: 0 8px 24px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.08);
  --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
  --serif: ui-serif, "Songti SC", Georgia, serif;
  font: 400 13px/1.5 var(--sans);
  color: var(--fg);
}
:host([data-theme="dark"]) {
  color-scheme: dark;
  --page: #262624; --side: #1F1E1D; --card: #30302E;
  --line: rgba(222,220,209,0.12); --line-strong: rgba(222,220,209,0.22);
  --fg: #FAF9F5; --fg2: #C2C0B6; --fg3: #9C9A92; --hover: rgba(222,220,209,0.06);
  --warn-bg: rgba(239,159,39,0.16); --warn-fg: #FAC775;
  --info-bg: rgba(55,138,221,0.18); --info-fg: #85B7EB;
  --danger-bg: rgba(226,75,74,0.18); --danger-fg: #F09595; --danger-line: rgba(240,149,149,0.4);
  --ok-bg: rgba(99,153,34,0.2); --ok-fg: #97C459;
  --focus: #378ADD;
  --toast-bg: #FAF9F5; --toast-fg: #141413;
  --solid-bg: #FAF9F5; --solid-fg: #141413; --solid-hover: #DEDCD1;
  --st-review: #f472b6; --st-draft: #facc15; --st-confirm: #4ade80;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, select, textarea { margin: 0; font: inherit; color: inherit; }
button { padding: 0; cursor: pointer; background: none; border: 0; border-radius: 8px; }
button:focus-visible, summary:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--ring); }
.icon { display: block; flex: none; }
.spin { animation: spin 1.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

.badge { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px;
  padding: 0 6px; font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums; color: var(--fg2);
  background: var(--card); border: 0.5px solid var(--line); border-radius: 999px; }

.float { position: fixed; z-index: 7; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
  font-size: 13px; color: var(--fg); background: var(--card); border: 0.5px solid var(--line);
  box-shadow: var(--shadow); }
.float:hover { background-image: linear-gradient(var(--hover), var(--hover)); }
.float .icon { color: var(--fg2); }
.editor { position: fixed; z-index: 7; width: 320px; padding: 10px; background: var(--card);
  border: 0.5px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.editor textarea { display: block; width: 100%; min-height: 72px; resize: vertical; padding: 8px 10px;
  font-size: 13px; line-height: 1.5; color: var(--fg); background: var(--page);
  border: 0.5px solid var(--line-strong); border-radius: 8px; }
.editor textarea::placeholder { color: var(--fg3); }
.editor textarea:focus { outline: none; box-shadow: 0 0 0 1px var(--ring); }
.editor .hint { margin-top: 6px; font-size: 11px; color: var(--fg3); }
.editor .ehead { display: flex; align-items: center; justify-content: space-between; margin: -2px -4px 8px 2px; }
.editor .etitle { font-size: 12px; font-weight: 500; color: var(--fg2); }
.editor .close { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border-radius: 6px; color: var(--fg2); }
.editor .close:hover { color: var(--fg); background: var(--hover); }

.side { position: fixed; z-index: 5; top: ${BAR_HEIGHT}px; right: 0; bottom: 0; width: ${SIDE_WIDTH}px; display: flex;
  flex-direction: column; color: var(--fg); background: var(--bar); border-left: 0.5px solid var(--line); }
.side.peek { box-shadow: var(--shadow); }
.head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 0.5px solid var(--line); }
.head .title { font-size: 14px; font-weight: 500; }
.head .counts { flex: 1; min-width: 0; font-size: 12px; color: var(--fg3); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.fold { display: grid; place-items: center; width: 28px; height: 28px; margin: -4px -6px -4px auto; color: var(--fg2); }
.fold:hover { color: var(--fg); background: var(--hover); }
.picker { position: relative; display: flex; align-items: center; gap: 4px; min-width: 0; height: 30px;
  padding: 0 6px; margin: 0 -2px; color: var(--fg); border-radius: 8px; }
.picker.many:hover { background: var(--hover); }
.picker:has(select:focus-visible) { box-shadow: 0 0 0 1px var(--ring); }
.picker .icon { color: var(--fg3); }
.picker:not(.many) .icon, .picker:not(.many) select { display: none; }
.picker .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.picker select { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; cursor: pointer;
  opacity: 0; border: 0; appearance: none; }

.list { position: relative; flex: 1; display: flex; flex-direction: column; gap: 12px; padding: 14px 16px;
  overflow: auto; overscroll-behavior: contain; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 10px; margin: auto 0; padding: 24px 8px;
  text-align: center; color: var(--fg3); }
.empty .icon { opacity: .6; }
.card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--card);
  border: 0.5px solid var(--line); border-radius: 12px; }
.card.go { cursor: pointer; }
.card.go:hover { border-color: var(--line-strong); }
.card.moved { border-color: var(--danger-line); }
.card.resolved { background: transparent; }
.card.focus, .card.focus:hover { border-color: var(--focus); box-shadow: 0 0 0 0.5px var(--focus); }
.card.pulse { animation: pulse .9s ease-out; }
@keyframes pulse { from { background: var(--info-bg); } }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.time { margin-left: auto; font-size: 11px; color: var(--fg3); white-space: nowrap; }
.status { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; font-size: 11px;
  line-height: 1; white-space: nowrap; color: var(--fg2); background: var(--hover); border-radius: 999px; }
.status .dot { width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
.status.draft { color: var(--warn-fg); background: var(--warn-bg); }
.status.sent { color: var(--info-fg); background: var(--info-bg); }
.status.moved { color: var(--danger-fg); background: var(--danger-bg); }
.status.resolved { color: var(--ok-fg); background: var(--ok-bg); }
.quote { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  padding-left: 10px; font-size: 12px; line-height: 1.55; color: var(--fg2); word-break: break-word;
  border-left: 2px solid var(--line-strong); border-radius: 0; }
.card.moved .quote { text-decoration: line-through; }
.body { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.card.resolved .body { color: var(--fg2); }
.ops { display: flex; justify-content: flex-end; gap: 2px; margin: -4px -6px -4px 0; }
.ghost { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; font-size: 12px;
  color: var(--fg2); }
.ghost:hover { color: var(--fg); background: var(--hover); }
.ghost.danger:hover { color: var(--danger-fg); }
.reply { display: flex; gap: 8px; padding-top: 10px; border-top: 0.5px solid var(--line); }
.reply .icon { flex: none; margin-top: calc((13px * 1.55 - 14px) / 2); color: var(--fg2); }
.reply .note { flex: 1; min-width: 0; font: 400 13px/1.55 var(--serif); color: var(--fg); white-space: pre-wrap;
  word-break: break-word; }
details.done summary { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px;
  color: var(--fg2); cursor: pointer; list-style: none; user-select: none; border-radius: 8px; }
details.done summary::-webkit-details-marker { display: none; }
details.done summary .icon { transition: transform .15s; }
details.done[open] summary .icon { transform: rotate(90deg); }
details.done .card { margin-top: 12px; }

.bar { position: fixed; z-index: 5; top: 0; left: 0; right: 0; height: ${BAR_HEIGHT}px; display: flex;
  align-items: center; gap: 8px; padding: 0 12px 0 16px; color: var(--fg); background: var(--bar);
  border-bottom: 0.5px solid var(--line); }
.bar .brand { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; white-space: nowrap; }
.bar .brand .icon { color: var(--brand); }
.bar .slash { color: var(--line-strong); }
.bar .state { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; font-size: 12px; font-weight: 500;
  white-space: nowrap; color: var(--fg2); }
.bar .state.review { color: var(--st-review); }
.bar .state.draft { color: var(--st-draft); }
.bar .state.confirm { color: var(--st-confirm); }
.bar .gap { flex: 1; }
.bar .reason { min-width: 0; font-size: 12px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 720px) { .bar .reason, .bar .state .label { display: none; } }
/* 同一时间最多一个实心按钮：未发送时是〔发送给 Claude〕，待评审、待确认时是绿色的〔通过〕；其余是描边按钮 */
.btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; font-size: 13px; font-weight: 500;
  white-space: nowrap; color: var(--fg); border: 0.5px solid var(--line-strong); }
.btn:hover:not(:disabled) { background: var(--hover); }
.btn:disabled { color: var(--fg3); border-color: var(--line); cursor: default; }
.btn.solid { border-color: transparent; }
.send.solid { color: var(--solid-fg); background: var(--solid-bg); }
.send.solid:hover:not(:disabled) { background: var(--solid-hover); }
.approve.solid { color: #fff; background: var(--approve); }
.approve.solid:hover:not(:disabled) { background: var(--approve-hover); }
.rail { position: fixed; z-index: 5; top: ${BAR_HEIGHT}px; right: 0; bottom: 0; width: ${RAIL_WIDTH}px; display: flex;
  flex-direction: column; align-items: center; gap: 8px; padding: 14px 0; color: var(--fg2);
  background: var(--bar); border-left: 0.5px solid var(--line); border-radius: 0; }
.rail:hover { color: var(--fg); background-image: linear-gradient(var(--hover), var(--hover)); }
.rail:focus-visible { box-shadow: inset 0 0 0 1px var(--ring); }
.rail .label { writing-mode: vertical-rl; letter-spacing: 2px; color: var(--fg); }
.rail .badge { min-width: 18px; padding: 0 4px; }
.toast { position: fixed; z-index: 6; bottom: 16px; left: 0; width: max-content; max-width: 80%; margin: 0 auto;
  padding: 8px 14px; font-size: 13px; color: var(--toast-fg); background: var(--toast-bg); border-radius: 8px;
  box-shadow: var(--shadow); }
`

// 图标取自 lucide（https://lucide.dev，ISC 许可），矩形改写成等价路径。
const ICONS = {
  'message-square': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  'panel-right-close': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18', 'm8 9 3 3-3 3'],
  'panel-right-open': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18', 'm10 15-3-3 3-3'],
  'chevrons-up-down': ['m7 15 5 5 5-5', 'm7 9 5-5 5 5'],
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
  'trash-2': ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  'loader-circle': ['M21 12a9 9 0 1 1-6.219-8.56'],
  'triangle-alert': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  check: ['M20 6 9 17l-5-5'],
  sparkles: [
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
    'M20 3v4',
    'M22 5h-4',
    'M4 17v2',
    'M5 18H3',
  ],
  send: [
    'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z',
    'm21.854 2.147-10.94 10.939',
  ],
  'chevron-right': ['m9 18 6-6-6-6'],
  // 评审状态：待评审、未发送、待确认、处理中、已通过
  'file-search': ['M14 2v4a2 2 0 0 0 2 2h4', 'M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3', 'm9 18-1.5-1.5', 'M2 14a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  'file-pen': [
    'M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z',
  ],
  'file-check': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'm9 15 2 2 4-4'],
  hourglass: [
    'M5 22h14',
    'M5 2h14',
    'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22',
    'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2',
  ],
  'circle-check': ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'm9 12 2 2 4-4'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// icon('check', 12)：线性图标，颜色跟随文字。
function icon(name, size = 16, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs = {
    class: `icon ${extraClass}`.trim(),
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': size <= 12 ? 2 : 1.75,
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

// el('div', { class: 'x', onclick: fn }, '文本', child)：字符串子节点一律作为文本插入。
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue
    if (k === 'class') node.className = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'style') node.style.cssText = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false))
  return node
}

const basename = p => p.split('/').pop()
const pad = n => String(n).padStart(2, '0')

// 状态徽章：文字和前导标记
const STATUS = {
  draft: { text: '草稿', mark: () => el('span', { class: 'dot' }) },
  sent: { text: '处理中', mark: () => icon('loader-circle', 11, 'spin') },
  moved: { text: '原文已变动', mark: () => icon('triangle-alert', 11) },
  resolved: { text: '已解决', mark: () => icon('check', 11) },
}

// 评论时间的相对显示：一分钟内「刚刚」，一小时内「N 分钟前」，今天「HH:mm」，昨天「昨天」，更早「M月D日」。
export function relativeTime(at, now = new Date()) {
  const t = new Date(at)
  if (!at || Number.isNaN(t.getTime())) return ''
  const diff = now.getTime() - t.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(t)) / 86_400_000)
  if (days <= 0) return `${pad(t.getHours())}:${pad(t.getMinutes())}`
  if (days === 1) return '昨天'
  return `${t.getMonth() + 1}月${t.getDate()}日`
}

// 把评论分成三组：能定位的未解决评论（按原文位置排序）、找不到原文的未解决评论、已解决评论。
// anchors：评论 id → { start, end }。
export function orderComments(comments, anchors) {
  const open = comments.filter(c => c.status !== 'resolved')
  const located = open
    .filter(c => anchors.has(c.id))
    .sort((a, b) => anchors.get(a.id).start - anchors.get(b.id).start || anchors.get(a.id).end - anchors.get(b.id).end)
  return {
    located,
    moved: open.filter(c => !anchors.has(c.id)),
    resolved: comments.filter(c => c.status === 'resolved'),
  }
}

// 用户在宽视口下的选择；窄视口下的自动收起由 NARROW_WIDTH 实时决定，不存这里。
function loadCollapsed() {
  try {
    return localStorage.getItem(STORE_KEY) === 'collapsed'
  } catch {
    return false // 读不到存储就默认展开
  }
}

// 视口宽度，不含经典滚动条；怪异模式下 <html> 的 clientWidth 不是视口宽度，改用 <body>。
function viewportWidth() {
  const box = document.compatMode === 'CSS1Compat' ? document.documentElement : document.body
  return box?.clientWidth || innerWidth
}

/** 评审状态的名称、图标和轮到谁（you：轮到你；wait：在等 Claude；done：已结束）。*/
export const STATES = {
  review: { label: '待评审', icon: 'file-search', turn: 'you' },
  draft: { label: '未发送', icon: 'file-pen', turn: 'you' },
  confirm: { label: '待确认', icon: 'file-check', turn: 'you' },
  processing: { label: 'Claude 处理中', icon: 'hourglass', turn: 'wait' },
  approved: { label: '已通过', icon: 'circle-check', turn: 'done' },
}

/**
 * 顶栏和评论栏标题要显示的内容：当前状态、各类评论条数（只列不为 0 的），
 * 〔通过〕〔发送给 Claude〕能不能点、为什么不能点，以及哪个是实心按钮（primary，最多一个）。
 * 旧版服务端没有 state 时按评论推算（有草稿是未发送，有处理中的是处理中，否则待评审）。
 * @param {{ state?: string, comments: { status: string }[] }} doc
 */
export function barState(doc) {
  const n = { draft: 0, sent: 0, resolved: 0 }
  for (const c of doc.comments) if (c.status in n) n[c.status]++
  const state = doc.state in STATES ? doc.state : n.draft > 0 ? 'draft' : n.sent > 0 ? 'processing' : 'review'
  const counts = [
    [n.draft, '未发送'],
    [n.sent, '处理中'],
    [n.resolved, '已解决'],
  ]
    .filter(([k]) => k > 0)
    .map(([k, name]) => `${k} ${name}`)
    .join(' · ')
  const send = n.draft > 0 ? { enabled: true, label: `发送给 Claude（${n.draft}）` } : { enabled: false, label: '发送给 Claude' }
  const approve =
    state === 'review' || state === 'confirm'
      ? { enabled: true, label: '通过', reason: '' }
      : state === 'approved'
        ? { enabled: false, label: '已通过', reason: '这篇已经通过；有新意见可以继续评论' }
        : state === 'draft'
          ? { enabled: false, label: '通过', reason: `还有 ${n.draft} 条评论没发送` }
          : { enabled: false, label: '通过', reason: 'Claude 还在处理评论' }
  const primary = send.enabled ? 'send' : approve.enabled ? 'approve' : ''
  return { state, ...STATES[state], counts, send, approve, primary }
}

export function createOverlay(h) {
  const host = document.createElement('doc-review-overlay')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  // 给正文让位的样式放在 <head> 里：正文的 MutationObserver 只看 <body>，改它不会触发重建映射
  const layout = document.createElement('style')
  layout.dataset.docReview = 'layout'
  document.head.appendChild(layout)

  const textarea = el('textarea', { placeholder: '写下你的意见' })
  const float = el('button', { class: 'float', hidden: true }, icon('message-square', 14), '评论')
  const editorTitle = el('span', { class: 'etitle' }, '评论')
  const closeBtn = el('button', { class: 'close', title: '关闭（不保存）', 'aria-label': '关闭评论框' }, icon('x', 14))
  const editor = el(
    'div',
    { class: 'editor', hidden: true },
    el('div', { class: 'ehead' }, editorTitle, closeBtn),
    textarea,
    el('div', { class: 'hint' }, '回车保存，Shift+回车换行，Esc 取消'),
  )
  const toastEl = el('div', { class: 'toast', hidden: true })
  // 文件名：本会话有多个文档时点它切换（透明的 select 盖在上面）
  const docs = el('select', { class: 'docs', title: '切换文档', 'aria-label': '切换文档' })
  const docName = el('span', { class: 'name' })
  const picker = el('div', { class: 'picker' }, docName, icon('chevrons-up-down', 14), docs)
  const fold = el('button', { class: 'fold', title: '收起评论栏', 'aria-label': '收起评论栏' }, icon('panel-right-close', 16))
  const countsEl = el('span', { class: 'counts' })
  const list = el('div', { class: 'list' })
  const stateEl = el('span', { class: 'state' })
  const reasonEl = el('span', { class: 'reason' })
  const approveBtn = el('button', { class: 'btn approve', disabled: true }, icon('check', 14), el('span', {}, '通过'))
  const sendLabel = el('span', {}, '发送给 Claude')
  const sendBtn = el('button', { class: 'btn send', disabled: true }, icon('send', 14), sendLabel)
  const bar = el(
    'div',
    { class: 'bar' },
    el('span', { class: 'brand' }, icon('message-square', 16), '评审'),
    el('span', { class: 'slash' }, '/'),
    picker,
    stateEl,
    el('span', { class: 'gap' }),
    reasonEl,
    sendBtn,
    approveBtn,
  )
  const side = el(
    'div',
    { class: 'side' },
    el('div', { class: 'head' }, el('span', { class: 'title' }, '评论'), countsEl, fold),
    list,
  )
  const railCount = el('span', { class: 'badge' }, '0')
  const rail = el(
    'button',
    { class: 'rail', title: '展开评论栏', 'aria-label': '展开评论栏' },
    el('span', { class: 'label' }, '评论'),
    railCount,
    icon('panel-right-open', 14),
  )
  shadow.append(el('style', {}, STYLE), bar, side, rail, float, editor, toastEl)

  let onSave = null
  let toastTimer = 0
  // 宽视口下按用户的选择收起或展开（会被记住）；窄视口下自动收起，
  // 用户临时展开时评论栏浮在正文上，不挤压正文，也不改写记住的选择。
  let isUserCollapsed = loadCollapsed()
  let isNarrow = viewportWidth() < NARROW_WIDTH
  let isPeeking = false
  let isCollapsed = isNarrow || isUserCollapsed
  let focusedId = ''
  let isResolvedOpen = false
  let docsKey = ''
  let listKey = ''
  let listScrollTop = 0 // 收起时 display:none 会清零列表滚动位置，先记下
  let editorRect = null

  float.addEventListener('mousedown', e => e.preventDefault()) // 保住页面上的选区
  float.addEventListener('click', () => h.onComment())
  sendBtn.addEventListener('click', () => h.onSend())
  approveBtn.addEventListener('click', () => h.onApprove())
  docs.addEventListener('change', () => h.onSwitchDoc(docs.value))
  fold.addEventListener('click', () => setCollapsed(true))
  rail.addEventListener('click', () => setCollapsed(false))
  // 拖窄预览窗口时自动收起评论栏，拖宽后恢复用户原来的选择
  addEventListener('resize', () => {
    const narrow = viewportWidth() < NARROW_WIDTH
    if (narrow === isNarrow) return
    isNarrow = narrow
    setCollapsed(narrow || isUserCollapsed)
    isPeeking = false
    applyLayout()
  })
  closeBtn.addEventListener('click', () => closeEditor(''))
  textarea.addEventListener('keydown', e => {
    if (e.isComposing) return // 输入法组字时的回车不算保存
    if (e.key === 'Escape') closeEditor('')
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      closeEditor(textarea.value.trim())
    }
  })
  // 列表只在内容变化时重建，相对时间靠定时刷新
  setInterval(() => {
    for (const t of list.querySelectorAll('.time')) t.textContent = relativeTime(t.dataset.at)
  }, 60_000)
  applyLayout()

  function sideWidth() {
    return isCollapsed ? RAIL_WIDTH : SIDE_WIDTH
  }

  function applyLayout() {
    side.hidden = isCollapsed
    rail.hidden = !isCollapsed
    side.classList.toggle('peek', isPeeking)
    // 窄视口下临时展开的评论栏浮在正文上，正文只给窄条让位
    const margin = isCollapsed || isPeeking ? RAIL_WIDTH : SIDE_WIDTH
    layout.textContent =
      `html{margin-right:${margin}px !important;padding-top:${BAR_HEIGHT}px !important;` +
      `scroll-padding-top:${BAR_HEIGHT + 8}px !important}`
    // 固定定位的左右边界就是不含滚动条的视口，right 让出评论栏后 margin:auto 即在正文区域居中
    toastEl.style.right = `${sideWidth()}px`
  }

  function setCollapsed(value) {
    if (value === isCollapsed) return
    if (value) listScrollTop = list.scrollTop
    isCollapsed = value
    isPeeking = isNarrow && !value
    applyLayout()
    if (!value) list.scrollTop = listScrollTop
    // 正文宽度变了，选区位置随之变化：收起浮条；编辑框按新布局重新摆放
    float.hidden = true
    if (!editor.hidden && editorRect) place(editor, editorRect)
    if (isNarrow) return // 窄视口下的临时展开、收起不改写记住的选择
    isUserCollapsed = value
    try {
      localStorage.setItem(STORE_KEY, value ? 'collapsed' : 'open')
    } catch {
      // 存不下就只在本页生效
    }
  }

  // 把浮条/编辑框放在 rect 附近，并限制在不被顶栏、评论栏遮挡的可视区域内。
  function place(node, rect) {
    node.hidden = false
    const right = viewportWidth() - sideWidth() - 8
    const topLimit = BAR_HEIGHT + 8
    const bottom = innerHeight - 8
    const left = Math.max(8, Math.min(rect.left, right - node.offsetWidth))
    const below = rect.bottom + 8
    const top = below + node.offsetHeight > bottom ? rect.top - node.offsetHeight - 8 : below
    node.style.left = `${left}px`
    node.style.top = `${Math.max(topLimit, Math.min(top, bottom - node.offsetHeight))}px`
  }

  // 关闭编辑框；text 非空时保存。先调 save 再通知关闭，好让页面知道保存还在进行中。
  function closeEditor(text) {
    const save = onSave
    editor.hidden = true
    onSave = null
    if (text && save) save(text)
    h.onEditorClosed?.()
  }

  function statusBadge(status) {
    const s = STATUS[status]
    if (!s) return el('span', { class: 'status' }, status)
    return el('span', { class: `status ${status}` }, s.mark(), s.text)
  }

  // kind：located 能定位到原文；moved 原文已变动；resolved 已解决
  function card(c, kind) {
    const canGo = kind === 'located'
    const classes = ['card', kind === 'moved' ? 'moved' : c.status]
    if (canGo) classes.push('go')
    if (c.id === focusedId) classes.push('focus')
    const at = c.createdAt ?? ''
    const created = new Date(at)
    return el(
      'div',
      {
        class: classes.join(' '),
        dataset: { id: c.id },
        onclick: canGo
          ? e => {
              if (e.target instanceof Element && e.target.closest('button')) return
              mark(c.id)
              h.onReveal(c.id)
            }
          : null,
      },
      el(
        'div',
        { class: 'top' },
        statusBadge(c.status),
        kind === 'moved' && statusBadge('moved'),
        el(
          'span',
          {
            class: 'time',
            dataset: { at },
            title: at && !Number.isNaN(created.getTime()) ? created.toLocaleString('zh-CN', { hour12: false }) : null,
          },
          relativeTime(at),
        ),
      ),
      el('div', { class: 'quote' }, c.quote),
      el('div', { class: 'body' }, c.body),
      c.status === 'draft' &&
        el(
          'div',
          { class: 'ops' },
          el('button', { class: 'ghost', onclick: () => h.onEdit(c.id) }, icon('pencil', 12), '修改'),
          el('button', { class: 'ghost danger', onclick: () => h.onDelete(c.id) }, icon('trash-2', 12), '删除'),
        ),
      c.resolution && el('div', { class: 'reply' }, icon('sparkles', 14), el('div', { class: 'note' }, c.resolution.note)),
    )
  }

  function renderList(groups) {
    const { located, moved, resolved } = groups
    const nodes = [...located.map(c => card(c, 'located')), ...moved.map(c => card(c, 'moved'))]
    if (resolved.length) {
      const done = el(
        'details',
        { class: 'done', open: isResolvedOpen },
        el('summary', {}, icon('chevron-right', 14), '已解决', el('span', { class: 'badge' }, String(resolved.length))),
        ...resolved.map(c => card(c, 'resolved')),
      )
      done.addEventListener('toggle', () => (isResolvedOpen = done.open))
      nodes.push(done)
    }
    const empty = el('div', { class: 'empty' }, icon('message-square', 24), '选中正文中的文字即可添加评论。')
    const scrollTop = list.scrollTop
    list.replaceChildren(...(nodes.length ? nodes : [empty]))
    list.scrollTop = scrollTop
  }

  function cardOf(id) {
    return list.querySelector(`.card[data-id="${CSS.escape(id)}"]`)
  }

  function mark(id) {
    focusedId = id
    for (const node of list.querySelectorAll('.card')) node.classList.toggle('focus', node.dataset.id === id)
  }

  // 只滚动评论列表，不牵动页面
  function scrollToCard(node) {
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top - 8
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8
  }

  const self = {
    host,
    // 外框的明暗和底色：theme 是 light / dark；bar 是顶栏、评论栏的底色（HTML 文档用页面实际的背景色），不给就用默认底色
    setTheme(theme, barColor) {
      host.dataset.theme = theme
      if (barColor) host.style.setProperty('--bar', barColor)
      else host.style.removeProperty('--bar')
    },
    showFloat(rect) {
      place(float, rect)
    },
    hideFloat() {
      float.hidden = true
    },
    isEditing() {
      return !editor.hidden
    },
    openEditor(rect, text, save) {
      float.hidden = true
      textarea.value = text
      editorTitle.textContent = text ? '修改评论' : '评论'
      onSave = save
      editorRect = rect
      place(editor, rect)
      textarea.focus()
    },
    // anchors：评论 id → { start, end }，只含能定位到原文的未解决评论
    render({ docs: docList, doc, anchors }) {
      const nextDocsKey = JSON.stringify([doc.id, docList.map(d => [d.id, d.path, d.open])])
      if (nextDocsKey !== docsKey) {
        docsKey = nextDocsKey
        docs.replaceChildren(
          ...docList.map(d => el('option', { value: d.id, selected: d.id === doc.id }, `${basename(d.path)}（${d.open}）`)),
        )
        const current = docList.find(d => d.id === doc.id)
        docName.textContent = basename(current?.path ?? doc.path)
        picker.title = current?.path ?? doc.path
        picker.classList.toggle('many', docList.length > 1)
      }
      const f = barState(doc)
      stateEl.className = `state ${f.state}`
      stateEl.replaceChildren(icon(f.icon, 14), el('span', { class: 'label' }, f.label))
      stateEl.title = f.label
      countsEl.textContent = f.counts
      reasonEl.textContent = f.approve.reason
      approveBtn.disabled = !f.approve.enabled
      approveBtn.title = f.approve.reason || '没有意见了，通过这篇文档并通知 Claude'
      approveBtn.lastChild.textContent = f.approve.label
      approveBtn.classList.toggle('solid', f.primary === 'approve')
      sendBtn.disabled = !f.send.enabled
      sendBtn.classList.toggle('solid', f.primary === 'send')
      sendLabel.textContent = f.send.label
      const groups = orderComments(doc.comments, anchors)
      railCount.textContent = String(groups.located.length + groups.moved.length)
      const sig = c => [c.id, c.status, c.quote, c.body, c.createdAt ?? '', c.resolution?.note ?? '']
      const nextListKey = JSON.stringify([groups.located.map(sig), groups.moved.map(sig), groups.resolved.map(sig)])
      if (nextListKey !== listKey) {
        listKey = nextListKey
        renderList(groups)
      }
    },
    // 点正文高亮：展开评论栏，把对应卡片滚进列表并突出显示
    focus(id) {
      if (isCollapsed) setCollapsed(false)
      mark(id)
      const node = cardOf(id)
      if (!node) return
      const done = node.closest('details')
      if (done && !done.open) done.open = true
      scrollToCard(node)
      node.classList.remove('pulse')
      void node.offsetWidth // 重新触发动画
      node.classList.add('pulse')
    },
    toast(text) {
      toastEl.textContent = text
      toastEl.hidden = false
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (toastEl.hidden = true), 3000)
    },
  }
  return self
}
