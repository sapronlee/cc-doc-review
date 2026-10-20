import { atom, read, update } from 'claude-code'

import { autoRegisterConfig, isMainLoopSuccess, isReviewDoc } from '../src/autoreg.js'
import {
  assetName,
  binPathOf,
  curlArgv,
  expectedSha,
  finalizeArgv,
  goBuildArgv,
  goProbeArgv,
  healthVersion,
  isServerCommand,
  needsRestart,
  parseSha256,
  platformOf,
  releaseUrl,
  removeArgv,
  serverPid,
  sha256Argv,
  versionOf,
} from '../src/binary.js'
import { dataDirOf, isHealthy, messageOf, parseInfo, parseReply, reviewUrl, startArgv, withLang } from '../src/client.js'
import {
  copyLegacyArgv,
  isLegacyCommand,
  isLegacyHealthy,
  killArgv,
  legacyDataDirOf,
  legacyServerPid,
  psArgv,
  shouldCopyLegacy,
} from '../src/migrate.js'
import { OPEN_SPEC, OPEN_TOOL, openText } from '../src/rules.js'
import { docItems } from '../src/docsview.js'
import { langOf, t } from '../src/i18n.js'
import { isUserOrigin, parseMessage, withReplies } from '../src/reply.js'
import { bandModel, COLLAPSED_ROWS, messageModel } from '../src/replylist.js'
import { CANVAS_W, CLOSE_W, closeBaseSvg, COL, cornerEdgeSvg, docRowSvg, edgeSvg, frameSvg, gapSvg, HEAD_RIGHT, lineSvg, PAD, padSvg, RADIUS, ROW_H, rowSvg, sepSvg } from '../src/bandart.js'
import { markdownLink } from '../src/bandview.js'

/**
 * 重画信号：桌面版只在绘制时读过的插件状态变了才重画输入框上方。回复区绘制时读它，需要重画时加一（见 redraw）。
 * 正式安装的插件在 Claude 空闲时也会因此重画（设计文档 15.3）。
 */
const redraws = atom({ plugin: 'cc-doc-review', key: 'redraws' }, 0)

/** 请回复区重画：写插件状态（桌面版据此重画），同时照旧 invalidate（终端据此重画）。画界面时调用无效，只在事件和定时器里调。@param {any} $ */
function redraw($) {
  $.ui.invalidate('ui.render')
  update($, redraws, n => n + 1).catch(() => {})
}

/** 回车发出的消息记下完整内容时加一：聊天记录里的消息读它，记下后重画一次（按回车那一刻桌面版已经画过这条消息，那时还没记下）。*/
const sentMarks = atom({ plugin: 'cc-doc-review', key: 'sentMarks' }, 0)

/** 斜杠命令名：不能叫 review，会和内置的 /code-review 冲突。*/
const COMMAND = 'cc-doc-review'
/** 写完这些工具的文件后按文件夹判断是否自动登记评审。*/
const WRITE_TOOLS = ['Write', 'Edit']
/** 自动登记失败（多半是服务起不来）后，这么久内不再尝试，免得每次写文档都等启动超时。*/
const AUTO_BACKOFF_MS = 60_000
/** 回复刷新定时器（每秒）。@type {import('claude-code').Timer | undefined} */
let replyTimer
let isFetchingReplies = false
/** 本会话待发送的回复（GET /api/replies 的 groups）；服务不在时为空。@type {import('../src/reply.js').ReplyGroup[]} */
let replies = []
let repliesKey = '[]'
/** 〔发送〕按下到发出（或失败）之间：按钮显示「发送中…」，再点无效；这期间按回车也不再带上同一批回复。*/
let isSending = false
/** 〔清空〕第一次按下的时刻（$.clock.now() 的毫秒数）；3 秒内再按才清空。@type {number | undefined} */
let clearArmedAt
/** 回复区展开着（超过 3 条时）。*/
let isExpanded = false
/** 每次本地改动回复（删、发出）加一：改动前发出的取数结果作废，免得刚删的又冒出来。*/
let repliesEpoch = 0
/** 界面文字用哪套：会话开始时按 Claude Code 的 language 设置定。@type {import('../src/i18n.js').Lang} */
let lang = 'en'

/** 会话的工作目录：回复的来源说明按它显示文档的相对路径；取到之前现取。*/
let sessionCwd = ''
/** 本会话已自动登记过的文件，重复编辑不再登记、不再提示。*/
const autoRegistered = new Set()
let hasAutoWarned = false
/** 自动登记的退避截止时间（$.clock.now() 的毫秒数）。*/
let autoRetryAt = 0
/** 旧版（doc-review）数据迁移是否已处理过；每次加载 mod 只做一次。*/
let isMigrated = false
/** 正在准备服务程序（下载或本地编译）的任务：同时来几个调用只做一次。@type {Promise<void> | undefined} */
let binaryTask
/** 准备服务程序失败的记录：这段时间内（$.clock.now() 的毫秒数）不再重试，直接报同样的原因。@type {{ until: number, message: string } | undefined} */
let binaryFailure
/** 准备失败后多久内不再重试。*/
const BINARY_BACKOFF_MS = 60_000
/** 已为哪个插件版本成功重启过运行中的服务：重启成功后不再重来，免得版本一直对不上时反复重启。@type {string | undefined} */
let restartedFor
/** 自重启失败后，这个时刻（$.clock.now() 的毫秒数）之前不再重试；失败可能只是暂时的（比如没网）。*/
let restartRetryAt = 0
/** 正在自重启：同时来的调用先沿用旧服务，不重复重启。*/
let isRestarting = false
/** 自重启失败后多久内不再重试。*/
const RESTART_BACKOFF_MS = 60_000
/** 已就哪个插件版本提示过「继续使用旧版服务」，每个版本只提示一次。@type {string | undefined} */
let staleWarnedFor

// 休眠模式：会话开始时只注册工具、命令和写文件钩子，不联网。
// 定时器只在 session.start 启动（引擎只保证从那里启动的定时器持续运行），休眠时每次 tick 只看标志就返回，不调用任何 $ 能力。
// 用到评审（调用评审工具、用斜杠命令、自动登记命中、开始时本会话已有文档）才唤醒，保持到会话结束。
let isAwake = false
/** 每次复位为休眠加一；唤醒检查回来时会话已换（/clear），结果作废。*/
let sessionEpoch = 0
/** /resume 换到另一个会话后，下一轮开始时查一次那个会话有没有文档。*/
let needsWakeCheck = false
/** 下一次投递 tick 做那次检查（由 turn.start 置上，检查在会话开始时启动的定时器里做）。*/
let isWakeCheckDue = false
/**
 * 引擎实际给的工具全名（$.tool.register 的返回值）。前缀取自插件加载时的名字，
 * 不一定等于清单里的名字（比如会话进行中插件改了名、热重载后仍沿用旧名），所以不能写死。
 */
const toolNames = { open: OPEN_TOOL }

/** 注册结果里的工具全名；拿不到像样的全名时用默认名。@param {any} registered @param {string} fallback */
const fullToolName = (registered, fallback) => {
  const tool = registered?.tool
  return typeof tool === 'string' && tool.startsWith('mcp__') ? tool : fallback
}

/** open_doc：登记文档，返回路径和文档页链接。@param {any} $ @param {any} e */
async function openDocTool($, e) {
  try {
    const file = String(e.path ?? '')
    const opened = await openDoc($, file)
    const path = String(opened.doc?.path ?? (await absPath($, file)))
    return { result: openText(path, withLang(String(opened.url), lang), String((await $.session.cwd()) ?? ''), lang) }
  } catch (err) {
    return { deny: `open_doc: ${messageOf(err)}` }
  } finally {
    wake()
  }
}

/** 悬停时这一条的底色：浅色、深色主题上都是一层很淡的灰。*/
const ROW_HOVER = 'rgba(127,127,127,0.10)'

/**
 * 画回复列表（输入框上方的回复区和聊天记录里的回复消息共用，设计文档 15.2）：表格样式，圆角外框，
 * 标题行（↩ N 条回复 · 文档名；回复区右边是〔展开其余 N 条〕〔清空〕〔发送〕），下面一条回复一行，行与行之间是通栏横线（单独一条，贯穿外框）。
 * 桌面版：每一行（编号圆点、竖线、原文、回复）和横线是 src/bandart.js 画的图；标题行用桌面版的文字，和按钮对齐；
 * 按钮是桌面版自己的（纯文字样式）；回复区鼠标停在某行上底色变浅、行尾出现 ×。
 * 终端：没有图，画成文字（编号、│ 原文、回复）。
 * @param {any} $ @param {any} e
 * @param {{ title: string, docName?: string, rows: import('../src/replylist.js').ListRow[], toggle?: string }} model
 * @param {{ buttons?: any[], onDelete?: (r: { id: string, doc: string }) => void }} [opts]
 */
function replyList($, e, model, { buttons = [], onDelete } = {}) {
  const { Box, Button, Svg, Text } = $.ui.resolve(e)
  const isBand = onDelete !== undefined
  const hasArt = e.surface === 'desktop' && Svg !== undefined
  const art = (/** @type {string} */ key, /** @type {string} */ source, /** @type {string} */ alt, h = ROW_H) =>
    Box({ key, flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children: [Svg({ source, alt, width: CANVAS_W, height: h })] })
  const xButton = (/** @type {any} */ r) => Button({ key: `${r.key}:x`, label: '×', plain: true, dimColor: true, onPress: () => onDelete({ id: r.id, doc: r.doc }) })
  // 鼠标停在这一行上才出现 ×，排在行尾；包着 × 的盒子不能带 key，否则悬停不传下去。
  // 桌面版：× 那一格宽 CLOSE_W、和行一样高，× 居中；最底下一像素是图，最后一行画着外框下沿，× 出现时下沿不断
  const close = (/** @type {any} */ r, isLast = false) =>
    !isBand
      ? []
      : hasArt
        ? [
            Box({
              display: 'none',
              hover: { display: 'flex' },
              flexDirection: 'column',
              flexShrink: 0,
              children: [
                Box({ flexGrow: 1, alignItems: 'center', justifyContent: 'center', children: [xButton(r)] }),
                Svg({ source: closeBaseSvg(isLast), alt: '边框', width: CLOSE_W, height: 1 }),
              ],
            }),
          ]
        : [Box({ display: 'none', hover: { display: 'flex' }, flexShrink: 0, children: [xButton(r)] })]
  // 行尾的空白（PAD 宽）：长回复不贴着右边框截断；回复区的 × 那一格出现在它和右边框之间，位置不变
  const pad = (isLast = false) => [Box({ flexShrink: 0, children: [Svg({ source: padSvg(isLast), alt: '边框', width: PAD, height: ROW_H })] })]
  // 竖着的边框小图：右边框（宽 1），标题行的左边框加内边距（宽 PAD + 1）
  const edge = (/** @type {string} */ key, /** @type {number} */ h, w = 1, /** @type {'left' | 'right'} */ side = 'right') =>
    hasArt ? [Box({ key, flexShrink: 0, children: [Svg({ source: edgeSvg(h, w, side), alt: '边框', width: w, height: h })] })] : []
  // 标题行全用桌面版的文字和按钮（同一种字体），和右边的按钮同一条基线；左边和下面每行的编号圆点对齐
  const head = Box({
    key: 'head',
    flexDirection: 'row',
    alignItems: 'center',
    children: [
      ...edge('head:l', ROW_H, PAD + 1, 'left'),
      Box({
        key: 'title',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: 1,
        children: [
          Text({ color: 'claude', children: ['↩'] }),
          Text({ bold: true, children: [model.title] }),
          ...(model.docName ? [Text({ dimColor: true, wrap: 'truncate-end', children: [`· ${model.docName}`] })] : []),
        ],
      }),
      ...buttons,
      ...edge('head:r', ROW_H, HEAD_RIGHT + 1),
    ],
  })
  // 外框的上沿、下沿：左圆角加很宽的横线（右边被裁）、右圆角小图
  // 空白边（gap:head）：和上沿一样高，只有左右边框，垫在标题行下面让它上下居中
  const rim = (/** @type {'top' | 'gap:head'} */ side) => {
    const f = side === 'top' ? frameSvg('top') : gapSvg()
    const key = side.startsWith('gap:') ? side : `rim:${side}`
    return Box({
      key,
      flexDirection: 'row',
      children: [
        Box({ key: `${key}:l`, flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children: [Svg({ source: f.left, alt: '边框', width: CANVAS_W, height: RADIUS })] }),
        Box({ key: `${key}:r`, flexShrink: 0, children: [Svg({ source: f.right, alt: '边框', width: RADIUS, height: RADIUS })] }),
      ],
    })
  }
  // 行与行之间的横线：单独一条通栏，贯穿外框（终端不画）
  const line = (/** @type {string} */ key) =>
    hasArt ? [Box({ key, width: '100%', overflow: 'hidden', children: [Svg({ source: lineSvg(), alt: '分隔线', width: CANVAS_W, height: 1 })] })] : []
  /** 行尾的右边框，每行都宽 RADIUS（竖线贴右边），× 那一格各行对齐：最后一行带右下圆角。@param {string} key @param {boolean} isLast */
  const rightEdge = (key, isLast) =>
    hasArt && isLast ? [Box({ key, flexShrink: 0, children: [Svg({ source: cornerEdgeSvg(ROW_H), alt: '边框', width: RADIUS, height: ROW_H })] })] : edge(key, ROW_H, RADIUS)
  // 每行都是「横线 + 一行」两张图：最后一行把外框下沿、两个下圆角画在自己的图里，不另加下沿，各行一样高
  const rows = model.rows.flatMap((r, i) => [...line(`line:${r.key}`), rowOf(r, i === model.rows.length - 1)])
  /** @param {import('../src/replylist.js').ListRow} r @param {boolean} isLast */
  function rowOf(r, isLast) {
    if (r.kind === 'doc') {
      return hasArt
        ? Box({ key: r.key, flexDirection: 'row', children: [art(`${r.key}:art`, docRowSvg(r.name, ROW_H, isLast), r.name), ...rightEdge(`${r.key}:r`, isLast)] })
        : Text({ key: r.key, dimColor: true, bold: true, wrap: 'truncate-end', children: [r.name] })
    }
    // 桌面版：编号、原文画在图里（定宽）；回复用桌面版的文字，按实际行宽截断、末尾加「…」，底下垫一像素的图（最后一行是外框下沿）
    const content = hasArt
      ? [
          Box({
            key: `${r.key}:art`,
            flexShrink: 0,
            overflow: 'hidden',
            children: [Svg({ source: rowSvg({ ...r, body: '' }, ROW_H, isLast), alt: `${r.no} ${r.fullQuote} ${r.body}`, width: COL.body, height: ROW_H })],
          }),
          Box({
            key: `${r.key}:b`,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            flexDirection: 'column',
            children: [
              Box({ flexGrow: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', children: [Text({ bold: true, wrap: 'truncate-end', children: [r.body.replace(/\s+/g, ' ')] })] }),
              Box({ overflow: 'hidden', children: [Svg({ source: closeBaseSvg(isLast, CANVAS_W), alt: '边框', width: CANVAS_W, height: 1 })] }),
            ],
          }),
        ]
      : [
          Box({ key: `${r.key}:no`, width: 3, flexShrink: 0, children: [Text({ color: 'claude', bold: true, children: [String(r.no)] })] }),
          Box({ key: `${r.key}:q`, width: 30, flexShrink: 0, overflow: 'hidden', children: [Text({ dimColor: true, wrap: 'truncate-end', children: [`│ ${r.quote}`] })] }),
          Box({ key: `${r.key}:b`, flexGrow: 1, flexShrink: 1, minWidth: 0, children: [Text({ wrap: isBand ? 'truncate-end' : 'wrap', children: [r.body] })] }),
          ...close(r),
        ]
    return Box({
      key: r.key,
      flexDirection: 'row',
      // 桌面版各格和行一样高（× 那一格的下沿贴着行底）；终端居中
      alignItems: hasArt ? 'stretch' : 'center',
      columnGap: hasArt ? 0 : 1,
      ...(isBand ? { hover: { backgroundColor: ROW_HOVER } } : {}),
      children: [...content, ...(hasArt ? [...pad(isLast), ...close(r, isLast)] : []), ...rightEdge(`${r.key}:r`, isLast)],
    })
  }
  // 桌面版的外框自己画（上沿、下沿、左右边框都是图），内边距、对齐按像素定；终端用自带的圆角边框
  // 行与行之间不留空：桌面版在纵向排列的子元素之间默认会空出一点，会让各行看起来不一样高
  if (hasArt) return Box({ key: 'reply-list', flexDirection: 'column', rowGap: 0, children: [rim('top'), head, rim('gap:head'), ...rows] })
  return Box({ key: 'reply-list', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, children: [head, ...rows] })
}

/** 回复区自己以外要留出的行数：外层插件（如用量带）的内容画在回复区下面，回复区的钩子看不到它有多高，先按 3 行留。*/
const RESERVED_ROWS = 3

/**
 * 一棵树大约占几行（按终端的算法：纵向排的子节点相加，横向排的取最高，带边框的加 2）。
 * 用来算下层内容（本插件之后的插件画的）占了多少，回复区只用剩下的。
 * @param {any} node @returns {number}
 */
function rowsOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((n, c) => n + rowsOf(c), 0)
  const props = node.props ?? {}
  if (props.display === 'none' || props.position === 'absolute') return 0
  if (node.type === 'Text' || node.type === 'Button' || node.type === 'Svg') return 1
  const kids = (node.children ?? []).filter((/** @type {any} */ c) => c && typeof c === 'object')
  const isRow = props.flexDirection === 'row' || props.flexDirection === 'row-reverse'
  const inner = isRow ? Math.max(0, ...kids.map(rowsOf)) : kids.reduce((/** @type {number} */ n, /** @type {any} */ c) => n + rowsOf(c), 0)
  const height = typeof props.height === 'number' ? props.height : inner
  return height + (props.borderStyle ? 2 : 0)
}

/**
 * 输入框上方的回复区：有待发送的回复时画表格，没有时返回 undefined（整块让给下层）。
 * 条数按剩余高度定：这一块最多 maxRows 行，减去下层内容、外层留的行和自己的外框、标题行，剩下几行就最多列几条。
 * @param {any} $ @param {any} e @param {number} now @param {number} [belowRows] 下层内容占的行数
 */
function replyBand($, e, now, belowRows = 0) {
  const maxRows = typeof e.props?.maxRows === 'number' ? e.props.maxRows : 20
  const room = maxRows - belowRows - RESERVED_ROWS - 3
  const model = bandModel(replies, { isExpanded, isArmed: clearState(now, clearArmedAt) === 'armed', isSending, lang, room })
  if (model.total === 0) return undefined
  const { Box, Button, Svg } = $.ui.resolve(e)
  const fail = (/** @type {unknown} */ err) => $.ui.toast(messageOf(err))
  const hasArt = e.surface === 'desktop' && Svg !== undefined
  const buttons = [
    ...(model.toggle
      ? [
          Button({ key: 'toggle', label: model.toggle, plain: true, dimColor: true, onPress: () => toggleList($) }),
          ...(hasArt ? [Box({ key: 'sep', flexShrink: 0, children: [Svg({ source: sepSvg(), alt: '|', width: 1, height: 12 })] })] : []),
        ]
      : []),
    Button({ key: 'clear', label: model.clear, plain: true, dimColor: true, onPress: () => void pressClear($).catch(fail) }),
    Button({ key: 'send', label: model.send, plain: true, ...(model.isSending ? { dimColor: true } : {}), onPress: () => void sendReplies($).catch(fail) }),
  ]
  return replyList($, e, model, { buttons, onDelete: r => void deleteReply($, r).catch(fail) })
}

/** 回车发出的消息：你打的原文（去掉首尾空白）→ 带回复块的完整消息，最多记 50 条（桌面版聊天记录显示的是原文）。*/
const sentTexts = new Map()
/** @param {string} typed @param {string} full */
/** 消息没发出去：撤掉 rememberSent 记下的这一条（只撤自己记的那条）。@param {string} typed @param {string} full */
function forgetSent(typed, full) {
  const key = typed.trim()
  if (sentTexts.get(key) === full) sentTexts.delete(key)
}

function rememberSent(typed, full) {
  const key = typed.trim()
  if (!key) return
  sentTexts.delete(key)
  sentTexts.set(key, full)
  if (sentTexts.size > 50) sentTexts.delete(sentTexts.keys().next().value)
}

/**
 * 聊天记录里带回复块的消息：画成和回复区一样的列表，你写的话放在下面；认不出回复块时返回 undefined（原样显示）。
 * 折叠视图画成一行「N 条回复 · 你写的话的开头」。
 * @param {any} $ @param {any} e
 */
function replyMessage($, e) {
  const text = e.props?.text
  const parsed = parseMessage(text) ?? parseMessage(sentTexts.get(String(text ?? '').trim()))
  if (!parsed) return undefined
  const { Box, Text } = $.ui.resolve(e)
  const model = messageModel(parsed, parsed.lang)
  if (e.props.isExpanded === false) {
    const ownLine = model.own.split('\n')[0]
    return Text({ key: 'reply-msg', dimColor: true, wrap: 'truncate-end', children: [ownLine ? `${model.title} · ${ownLine}` : model.title] })
  }
  const own = model.own ? [Text({ key: 'own', children: [model.own] })] : []
  return Box({ key: 'reply-msg', flexDirection: 'column', rowGap: 1, children: [replyList($, e, model), ...own] })
}

/** 〔清空〕要点两次：第一次之后 3 秒内为 armed（按钮显示「确认清空」），过了就回到 idle。@param {number} now @param {number | undefined} armedAt */
function clearState(now, armedAt) {
  return armedAt !== undefined && now - armedAt < 3000 ? 'armed' : 'idle'
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  const auto = autoRegisterConfig(options)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    goDormant()
    needsWakeCheck = false
    isWakeCheckDue = false
    toolNames.open = fullToolName(await $.tool.register(OPEN_SPEC), OPEN_TOOL)
    try {
      lang = langOf(await $.config.list())
    } catch {
      lang = 'en'
    }
    // 定时器一律在这里启动；休眠时空转（只看标志），唤醒后才取回复
    replyTimer?.cancel()
    replyTimer = $.clock.every(1000, () => {
      if (isWakeCheckDue) {
        isWakeCheckDue = false
        void checkWake($).catch(() => {})
      }
      if (!isAwake) return
      void refreshReplies($)
    })
    // 命令放在最后，且失败不抛：名字被引擎拒绝时也不能让工具和投递跟着失效。
    try {
      await $.command.register({ name: COMMAND, description: t(lang, 'commandHint'), argumentHint: t(lang, 'commandArg') })
    } catch (err) {
      $.ui.toast(t(lang, 'commandFailed', { command: `/${COMMAND}`, reason: messageOf(err) }))
    }
    // 在后台查：服务卡住也不拖住会话开始
    void checkWake($).catch(() => {})
    return started
  })

  // 会话结束：一律复位为休眠。/clear、/resume 后进程以新会话继续，且不会再触发 session.start，
  // 所以定时器留着空转（等再次唤醒）；真正退出时定时器随进程一起消失，不用专门取消。
  // /clear 后是全新的会话，不用查；/resume 换来的会话可能登记过文档，下一轮开始时查一次。
  on('session.end', async ($, e, next) => {
    goDormant()
    // 已经画在屏幕上的回复区马上收起
    redraw($)
    needsWakeCheck = e.reason === 'resume'
    return next(e)
  })

  // 按注册时拿到的真实工具名分派；不是本插件的工具原样放行
  on('tool.call', async ($, e, next) => {
    if (e.tool === toolNames.open) return openDocTool($, e)
    return next(e)
  })

  // 你自己发消息时，把待发送的回复写进这条消息的正文（你的话在前，回复块在后）；消息交出去后标为已发送。
  // 插件、通知等别的来源和斜杠命令不带；休眠、没有回复、或〔发送〕正在发这批回复时原样放行（免得发两遍）。
  on('prompt.submit', async ($, e, next) => {
    if (!isAwake || isSending || replies.length === 0 || !isUserOrigin(e.origin) || e.text.trimStart().startsWith('/')) return next(e)
    const sending = replies
    const cwd = sessionCwd || String((await $.session.cwd()) ?? '')
    const full = withReplies(e.text, sending, lang, cwd)
    // 桌面版聊天记录里这条消息显示的是你打的原文（不带回复块）：记下原文对应的完整消息，聊天记录据此画回复卡片
    rememberSent(e.text, full)
    $.ui.invalidate('ui.render')
    update($, sentMarks, n => n + 1).catch(() => {})
    // 发出去、标为已发送之前，再按回车或点〔发送〕都不再带这批回复
    isSending = true
    try {
      const r = await next({ ...e, text: full })
      if (r.drop === undefined) {
        // 消息交出去后桌面版才画好这一行：再重画一次，卡片马上出来，不用等下一次刷新
        $.ui.invalidate('ui.render')
        update($, sentMarks, n => n + 1).catch(() => {})
        await markSent($, sending)
      }
      else forgetSent(e.text, full)
      return r
    } catch (err) {
      forgetSent(e.text, full)
      throw err
    } finally {
      isSending = false
    }
  })

  // 不带参数：在聊天里列出本会话的文档（名称是文档页链接）。带文件：登记并在系统浏览器打开。
  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      const file = e.args.trim()
      if (!file) return { text: await listDocs($) }
      const opened = await openDoc($, file)
      const url = withLang(String(opened.url), lang)
      return { text: t(lang, (await openInBrowser($, url)) ? 'cmdOpened' : 'cmdRegistered', { file, url }) }
    } catch (err) {
      return { text: t(lang, 'cmdFailed', { reason: messageOf(err) }) }
    } finally {
      wake()
    }
  })

  // /resume 换来的会话：第一轮开始时查一次那个会话有没有文档。
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (/** @type {any} */ (e).agentId) return started
    if (needsWakeCheck) {
      needsWakeCheck = false
      isWakeCheckDue = true
    }
    return started
  })

  // 聊天记录里你发出的带回复块的消息：画成和回复区一样的列表。不需要唤醒：只看消息正文。
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    await read($, sentMarks)
    const mine = replyMessage($, e)
    return mine === undefined ? next(e) : mine
  })

  // 输入框上方的回复区。同一位置可能还有别的插件（如用量带）：自己画完把下层的内容接在下面，不独占这一块
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, redraws)
    if (!isAwake || e.props.hasSurvey) return next(e)
    if (replies.length === 0) return next(e)
    let rest
    /** @type {unknown} */
    let failure
    try {
      rest = await next(e)
    } catch (err) {
      // 下层（别的插件或引擎）出错不能连累回复区：只画回复区
      failure = err
    }
    const mine = replyBand($, e, await $.clock.now(), rowsOf(rest))
    if (mine === undefined) {
      if (failure !== undefined) throw failure
      return rest
    }
    if (rest === null || rest === undefined) return mine
    const { Box } = $.ui.resolve(e)
    // 下层内容里可能有引擎自己的节点，不能放在设了 width 的 Box 下面：包着它们的盒子都不设宽度，靠纵向拉伸铺满
    const stretch = { flexDirection: 'column', alignItems: 'stretch' }
    return Box({ key: 'stack', ...stretch, children: [Box({ key: 'mine', ...stretch, children: [mine] }), Box({ key: 'rest', ...stretch, children: [rest] })] })
  })

  // 主对话写的文档命中配置的 glob 模式（默认 specs / plans / docs 下的 md、html）就自动登记评审；开关关掉则不挂钩。
  if (auto.enabled) {
    for (const tool of WRITE_TOOLS) {
      on('tool.call', { tool }, async ($, e, next) => {
        const r = await next(e)
        if (isMainLoopSuccess(e, r)) {
          // 在后台登记，不拖住工具结果
          void autoRegister($, String(/** @type {any} */ (e).file_path ?? ''), auto).catch(() => {})
        }
        return r
      })
    }
  }
}

/**
 * 本会话的文档，每份一行 Markdown：「- [名称](链接) · 目录 · 时间」，有待发送回复时再接「 · N 条回复待发送」。
 * 需要时启动服务；服务起不来返回「打开失败」。
 * @param {any} $
 * @returns {Promise<string>}
 */
async function listDocs($) {
  let list
  let info
  try {
    const session = await $.session.id()
    list = await call($, 'GET', `/api/docs?session=${encodeURIComponent(session)}`, undefined, true)
    info = await readInfo($)
  } catch (err) {
    return t(lang, 'cmdFailed', { reason: messageOf(err) })
  }
  const cwd = sessionCwd || String((await $.session.cwd()) ?? '')
  const items = docItems(Array.isArray(list) ? list : [], cwd, await $.clock.now(), lang)
  if (items.length === 0) return t(lang, 'noDocs')
  const lines = items.map(d => {
    const name = info ? markdownLink(d.name, reviewUrl(info, d.id, lang)) : d.name
    const parts = [name, d.dir, d.when].filter(Boolean)
    if (d.pending > 0) parts.push(t(lang, 'pendingOnPage', { n: d.pending }))
    return `- ${parts.join(' · ')}`
  })
  return [t(lang, 'docsListHead', { n: items.length }), ...lines].join('\n')
}

/**
 * 每秒：取本会话待发送的回复，变了就重画回复区。服务不在就当没有，不去启动它。
 * @param {any} $
 */
async function refreshReplies($) {
  if (isFetchingReplies) return
  isFetchingReplies = true
  const epoch = sessionEpoch
  const local = repliesEpoch
  try {
    // 〔确认清空〕过了 3 秒没再点：按钮变回〔清空〕
    if (clearArmedAt !== undefined && clearState(await $.clock.now(), clearArmedAt) === 'idle') {
      clearArmedAt = undefined
      redraw($)
    }
    const session = await $.session.id()
    if (!sessionCwd) sessionCwd = String((await $.session.cwd()) ?? '')
    const got = await call($, 'GET', `/api/replies?session=${encodeURIComponent(session)}`, undefined, false)
    // 取的过程中换了会话，或本地刚删 / 清空 / 发出过：这份数据过时了
    // 服务不在（got 为空）或应答不对：保留现有的回复，等它回来
    if (epoch !== sessionEpoch || local !== repliesEpoch || !Array.isArray(got?.groups)) return
    setReplies($, got.groups)
  } catch {
    // 一时取不到（服务忙、重启中）：保留现有的回复，不让回复区闪一下
  } finally {
    isFetchingReplies = false
  }
}

/** @param {any} $ @param {import('../src/reply.js').ReplyGroup[]} groups */
function setReplies($, groups) {
  const key = JSON.stringify(groups)
  if (key === repliesKey) return
  replies = groups
  repliesKey = key
  // 少到不用列表时，展开状态作废
  if (groups.reduce((n, g) => n + g.replies.length, 0) <= COLLAPSED_ROWS) isExpanded = false
  redraw($)
}

/** 从本地列表里去掉这些回复，并让还在路上的取数结果作废。@param {any} $ @param {Set<string>} ids */
function dropLocal($, ids) {
  repliesEpoch++
  setReplies(
    $,
    replies.map(g => ({ ...g, replies: g.replies.filter(r => !ids.has(r.id)) })).filter(g => g.replies.length > 0),
  )
}

/**
 * 回复已随消息交给 Claude：本地马上收起，再告诉服务端标为已发送（文档页的标记随之清掉）。
 * 标记失败不影响已发出的消息，下一次取数时那几条会重新出现，可以删掉。
 * @param {any} $ @param {import('../src/reply.js').ReplyGroup[]} sent
 */
async function markSent($, sent) {
  const ids = sent.flatMap(g => g.replies.map(r => r.id))
  if (ids.length === 0) return
  dropLocal($, new Set(ids))
  clearArmedAt = undefined
  try {
    await callLive($, 'POST', '/api/replies/sent', { ids })
  } catch (err) {
    // 消息已经发出，只是没标上：回复下一次取数会回到列表里，提示一下，免得再发一遍
    $.ui.toast(t(lang, 'markSentFailed', { reason: messageOf(err) }))
  } finally {
    repliesEpoch++
  }
}

/**
 * 〔发送〕：按钮先变「发送中…」，以你的名义把回复块发进会话（插件自己发的消息不经过自己的 prompt.submit 钩子）；
 * 发出后标为已发送并提示；失败时回复全部保留，提示原因。
 * @param {any} $
 */
async function sendReplies($) {
  if (isSending || replies.length === 0) return
  isSending = true
  redraw($)
  const sending = replies
  try {
    const cwd = sessionCwd || String((await $.session.cwd()) ?? '')
    const r = await $.prompt.submit({ text: withReplies('', sending, lang, cwd), asUser: true })
    if (r?.drop !== undefined) {
      $.ui.toast(t(lang, 'sendFailed', { reason: String(r.drop) }))
      return
    }
    await markSent($, sending)
    $.ui.toast(t(lang, 'sent'))
  } catch (err) {
    $.ui.toast(t(lang, 'sendFailed', { reason: messageOf(err) }))
  } finally {
    isSending = false
    redraw($)
  }
}

/** ×：删掉一条回复，文档页的标记随之消失。@param {any} $ @param {{ id: string, doc: string }} r */
async function deleteReply($, r) {
  try {
    await callLive($, 'DELETE', `/api/comments?doc=${encodeURIComponent(r.doc)}&id=${encodeURIComponent(r.id)}`)
    dropLocal($, new Set([r.id]))
  } catch (err) {
    $.ui.toast(t(lang, 'deleteFailed', { reason: messageOf(err) }))
  }
}

/**
 * 〔清空〕要点两次：第一次只把按钮变成「确认清空」，3 秒内再点才清空本会话所有待发送的回复。
 * @param {any} $
 */
async function pressClear($) {
  const now = await $.clock.now()
  if (clearState(now, clearArmedAt) !== 'armed') {
    clearArmedAt = now
    redraw($)
    return
  }
  clearArmedAt = undefined
  try {
    const session = await $.session.id()
    await callLive($, 'DELETE', `/api/replies?session=${encodeURIComponent(session)}`)
    dropLocal($, new Set(replies.flatMap(g => g.replies.map(r => r.id))))
  } catch (err) {
    $.ui.toast(t(lang, 'deleteFailed', { reason: messageOf(err) }))
    redraw($)
  }
}

/** @param {any} $ */
function toggleList($) {
  isExpanded = !isExpanded
  redraw($)
}

/**
 * 文件命中自动登记模式就登记（服务不在会拉起），同一文件本会话只登记一次。
 * 失败只提示一次，并退避一段时间不再尝试。
 * @param {any} $ @param {string} file @param {import('../src/autoreg.js').AutoConfig} config
 */
async function autoRegister($, file, config) {
  if (!file) return
  const cwd = await $.session.cwd()
  const path = file.startsWith('/') ? file : `${cwd}/${file}`
  if (!isReviewDoc(path, cwd, config)) return
  // 命中即唤醒（登记完再唤醒）
  try {
    const now = await $.clock.now()
    // 检查和占位之间不能有 await：同一文件并发写两次时只登记一次
    if (now < autoRetryAt || autoRegistered.has(path)) return
    autoRegistered.add(path)
    try {
      // 不弹「已登记」：Claude 回话里的链接和 /cc-doc-review 列表就是入口
      await openDoc($, path)
    } catch (err) {
      autoRegistered.delete(path)
      autoRetryAt = now + AUTO_BACKOFF_MS
      if (!hasAutoWarned) {
        hasAutoWarned = true
        $.ui.toast(t(lang, 'autoFailed', { reason: messageOf(err) }))
      }
    }
  } finally {
    wake()
  }
}

/**
 * 唤醒：会话开始时启动的定时器从下一次 tick 起每秒取回复、插进输入框。
 * 只改标志，不建定时器。已唤醒时什么都不做。
 */
function wake() {
  if (isAwake) return
  isAwake = true
}

/** 复位为休眠：定时器空转，上一个会话的状态全部作废。*/
function goDormant() {
  isAwake = false
  sessionEpoch++
  resetSessionState()
}

/**
 * 会话开始（或 /resume 后的第一轮）查一次：服务在跑且本会话登记过文档就唤醒。服务不在就跳过，不去启动它。
 * @param {any} $
 */
async function checkWake($) {
  const epoch = sessionEpoch
  const session = await $.session.id()
  let list
  try {
    list = await call($, 'GET', `/api/docs?session=${encodeURIComponent(session)}`, undefined, false)
  } catch {
    list = undefined
  }
  if (epoch !== sessionEpoch || isAwake) return
  if (Array.isArray(list)) {
    if (list.length > 0) wake()
    return
  }
  // 服务不在（比如重启 Claude 时随之退出）：看本机数据里本会话有没有登记过文档。
  // 有就把服务拉起来并唤醒，状态带不用等到有人调用评审工具才出现；没有就之后每一轮开始时再查。
  if (await hasLocalDocs($, session)) {
    if (epoch !== sessionEpoch || isAwake) return
    await ensureServer($)
    wake()
    return
  }
  needsWakeCheck = true
}

/** 本机数据目录里最多读这么多个文档文件来判断本会话有没有文档。*/
const LOCAL_DOCS_LIMIT = 500

/**
 * 本机评审数据（docs/*.json）里有没有本会话登记的文档。只读本地文件，读不了就当没有。
 * @param {any} $ @param {string} session
 */
async function hasLocalDocs($, session) {
  try {
    const dir = `${await dataDir($)}/docs`
    if (!(await $.fs.exists(dir))) return false
    const entries = (await $.fs.list(dir)).filter((/** @type {any} */ f) => f.kind === 'file' && f.name.endsWith('.json')).slice(0, LOCAL_DOCS_LIMIT)
    for (const f of entries) {
      try {
        if (JSON.parse(await $.fs.read(`${dir}/${f.name}`))?.session === session) return true
      } catch {
        // 单个文件坏了不影响其余
      }
    }
  } catch {
    return false
  }
  return false
}

/** 换了会话（新开、/clear）时，上一个会话的回复都作废。*/
function resetSessionState() {
  replies = []
  repliesKey = '[]'
  repliesEpoch++
  isExpanded = false
  isSending = false
  clearArmedAt = undefined
  sessionCwd = ''
  sentTexts.clear()
  autoRegistered.clear()
  hasAutoWarned = false
  autoRetryAt = 0
}

/**
 * 用系统浏览器打开链接（macOS 的 open，其余试 xdg-open）；都打不开时返回 false。
 * @param {any} $ @param {string} url
 */
async function openInBrowser($, url) {
  for (const argv of [['open', url], ['xdg-open', url]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5000 })
      if (r.exitCode === 0) return true
    } catch {
      // 这个命令不存在：试下一个
    }
  }
  return false
}

/**
 * @param {any} $
 * @param {string} file
 */
async function openDoc($, file) {
  if (!file) throw new Error('缺少文件路径')
  return call($, 'POST', '/api/open', { path: await absPath($, file), session: await $.session.id() })
}

/** 相对路径按会话的工作目录补成绝对路径。@param {any} $ @param {string} file */
async function absPath($, file) {
  return file.startsWith('/') ? file : `${await $.session.cwd()}/${file}`
}

/** @param {any} $ */
async function homeDir($) {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('读不到 HOME 环境变量')
  return home
}

/** @param {any} $ */
async function dataDir($) {
  return dataDirOf(await homeDir($))
}

/** @param {any} $ */
async function readInfo($) {
  const file = `${await dataDir($)}/server.json`
  if (!(await $.fs.exists(file))) return undefined
  return parseInfo(await $.fs.read(file))
}

/**
 * 服务的 health 应答：在跑且是文档服务就返回应答，否则 undefined。
 * @param {any} $ @param {{ port: number }} info
 */
async function healthOf($, info) {
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${info.port}/api/health`)
    return isHealthy(r) ? r : undefined
  } catch {
    return undefined
  }
}

/** @param {any} $ @param {{ port: number }} info */
async function isAlive($, info) {
  return (await healthOf($, info)) !== undefined
}

/**
 * 服务在跑就返回它的信息；不在跑就在后台启动（不随会话退出），最多等 3 秒。
 * 不用 $.process.spawn：它启动的进程会随 mod 卸载被杀掉。
 *
 * 用哪个程序：插件目录下有 bin/cc-doc-review-server 就是开发模式，直接用它，也不因版本不同自动重启；
 * 否则用 ~/.claude/cc-doc-review/bin/cc-doc-review-server-<插件版本>（没有就下载，下载不了退回本地编译）。
 * 运行中的服务版本和插件不一致（插件更新了）时，先备好新程序再结束旧进程、启动新版本；
 * 新程序备不好或旧进程结束不了就继续用旧版。
 * @param {any} $
 */
async function ensureServer($) {
  const running = await readInfo($)
  const health = running ? await healthOf($, running) : undefined
  const devBin = `${$.plugin.root}/bin/cc-doc-review-server`
  const isDev = await $.fs.exists(devBin)
  if (running && health) {
    const version = isDev ? undefined : await pluginVersion($).catch(() => undefined)
    if (!needsRestart({ isDev, pluginVersion: version, serverVersion: healthVersion(health) })) return running
    // 重启成功过就不再重来；失败（没网、旧进程结束不了）按退避稍后重试，不会每次调用都重来
    if (restartedFor === version) return running
    if ((await $.clock.now()) < restartRetryAt) return running
    const stay = async (/** @type {string} */ why) => {
      restartRetryAt = (await $.clock.now()) + RESTART_BACKOFF_MS
      if (staleWarnedFor !== version) {
        staleWarnedFor = version
        $.ui.toast(`cc-doc-review：文档服务要更新到 ${version}，但${why}，继续使用旧版`)
      }
      return running
    }
    // 检查和占位之间不能有 await：同时来的调用只有一个去重启，其余沿用旧服务
    if (isRestarting) return running
    isRestarting = true
    try {
      /** @type {string} */
      let bin
      try {
        bin = await prepareBinary($, String(version), true)
      } catch (err) {
        return await stay(`新版程序没准备好（${messageOf(err)}）`)
      }
      if (!(await stopServer($, running))) return await stay('旧版服务没能结束')
      const info = await startAndWait($, bin, isDev)
      restartedFor = version
      return info
    } finally {
      isRestarting = false
    }
  }
  const bin = isDev ? devBin : await prepareBinary($, await pluginVersion($))
  return startAndWait($, bin, isDev)
}

/**
 * 启动服务程序并等它应答（最多 3 秒）。启动不了就抛错；下载或编译来的程序起不来会删掉，下次重新获取。
 * @param {any} $ @param {string} bin @param {boolean} isDev
 */
async function startAndWait($, bin, isDev) {
  const log = `${await dataDir($)}/server.log`
  await migrateLegacy($)
  await $.process.run(startArgv(bin, log))
  for (let i = 0; i < 15; i++) {
    await $.clock.sleep(200)
    const info = await readInfo($)
    if (info && (await isAlive($, info))) return info
  }
  // 下载或编译来的程序起不来：删掉它，下次重新获取（开发模式的程序是开发者自己编的，不动）
  if (!isDev) await run($, removeArgv(bin))
  throw new Error(`文档服务启动失败，日志：${log}`)
}

/** 插件版本：读 plugin.json（$.plugin 里没有版本号）。读不到就报错。@param {any} $ */
async function pluginVersion($) {
  const version = versionOf(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
  if (!version) throw new Error(`读不到插件版本，请检查 ${$.plugin.root}/.claude-plugin/plugin.json 的 version`)
  return version
}

/**
 * 备好这个版本的服务程序，返回路径：已有就直接用；没有就下载（失败退回本地编译）。
 * 同时来几个调用只做一次；失败后一分钟内不再重试。
 * @param {any} $ @param {string} version @param {boolean} [isUpdate] 是插件更新后换新版（不是首次使用），只影响提示文字
 */
async function prepareBinary($, version, isUpdate = false) {
  const dest = binPathOf(await homeDir($), version)
  if (await $.fs.exists(dest)) return dest
  const now = await $.clock.now()
  if (binaryFailure && now < binaryFailure.until) throw new Error(binaryFailure.message)
  binaryTask ??= fetchBinary($, version, dest, isUpdate)
    .then(() => {
      binaryFailure = undefined
    })
    .catch(async err => {
      // 退避从失败的时刻算起（下载和编译可能已经花了很久）
      binaryFailure = { until: (await $.clock.now()) + BINARY_BACKOFF_MS, message: messageOf(err) }
      throw err
    })
    .finally(() => {
      binaryTask = undefined
    })
  await binaryTask
  return dest
}

/**
 * 跑一条命令，起不来也不抛，按退出码 -1 返回，让调用方统一处理。
 * @param {any} $ @param {string[]} argv @param {number} [timeoutMs] 不给就用引擎默认的 30 秒
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function run($, argv, timeoutMs) {
  try {
    return await $.process.run(argv, timeoutMs ? { timeoutMs } : undefined)
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: messageOf(err) }
  }
}

/** @param {{ exitCode: number, stderr: string }} r */
function failureOf(r) {
  return r.stderr.trim().slice(-300) || `退出码 ${r.exitCode}`
}

/**
 * 获取服务程序到 dest：先下载预编译程序；下载或校验失败时，登录 shell 里有 Go 就本地编译；都不行就报错（含平台和原因）。
 * 所有临时文件名都带本次独有的后缀：多个会话同时首次下载时互不踩踏，最终路径只会被「本次校验过的文件」改名占据。
 * @param {any} $ @param {string} version @param {string} dest @param {boolean} isUpdate
 */
async function fetchBinary($, version, dest, isUpdate) {
  const unique = `${await $.clock.now()}-${Math.random().toString(36).slice(2, 10)}`
  const uname = await run($, ['uname', '-sm'])
  const unameText = uname.exitCode === 0 ? uname.stdout.trim() : ''
  const platform = platformOf(unameText)
  const label = platform ? `${platform.os}/${platform.arch}` : unameText || '未知平台'
  let reason
  if (uname.exitCode !== 0) reason = `无法判断系统和芯片（uname 失败：${failureOf(uname)}）`
  else if (!platform) reason = '不支持的平台，没有对应的预编译程序'
  else {
    $.ui.toast(isUpdate ? 'cc-doc-review：插件已更新，正在准备新版文档服务' : 'cc-doc-review：首次使用，正在下载文档服务')
    try {
      await downloadBinary($, version, platform, dest, unique)
      return
    } catch (err) {
      reason = `下载失败：${messageOf(err)}`
    }
  }
  const shell = await findGoShell($)
  if (!shell) {
    throw new Error(`文档服务获取失败（${label}）：${reason}。本机登录 shell 里也没有 Go，无法本地编译；请检查网络后重试，或安装 Go`)
  }
  $.ui.toast(`cc-doc-review：${reason}，改为本地编译，可能要一分钟`)
  const tmp = `${dest}.build-${unique}`
  const built = await run($, goBuildArgv(shell, $.plugin.root, version, tmp, dest), 300_000)
  if (built.exitCode !== 0) {
    await run($, removeArgv(tmp))
    throw new Error(`文档服务获取失败（${label}）：${reason}；本地编译失败：${failureOf(built)}`)
  }
}

/**
 * 下载该平台的程序和 SHA256SUMS，校验通过后装到 dest。失败一律抛错，临时文件都清理掉。
 * @param {any} $ @param {string} version @param {import('../src/binary.js').Platform} platform @param {string} dest
 * @param {string} unique 本次独有的后缀，临时文件名里带上
 */
async function downloadBinary($, version, platform, dest, unique) {
  const name = assetName(platform)
  const part = `${dest}.part-${unique}`
  const sums = `${dest}.sums-${unique}`
  try {
    for (const [file, out] of [[name, part], ['SHA256SUMS', sums]]) {
      const r = await run($, curlArgv(releaseUrl(version, file), out), 150_000)
      if (r.exitCode !== 0) throw new Error(`下载 ${file} 失败：${failureOf(r)}`)
    }
    const want = expectedSha(await $.fs.read(sums), name)
    if (!want) throw new Error(`SHA256SUMS 里没有 ${name} 的校验值`)
    const sha = await run($, sha256Argv(part))
    const got = parseSha256(sha.stdout)
    if (sha.exitCode !== 0 || !got) throw new Error(`无法计算 SHA-256：${failureOf(sha)}`)
    if (got !== want) throw new Error(`SHA-256 校验失败（期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
    const done = await run($, finalizeArgv(part, dest))
    if (done.exitCode !== 0) throw new Error(`安装程序失败：${failureOf(done)}`)
  } finally {
    await run($, removeArgv(part, sums))
  }
}

/** 找一个装了 Go 的登录 shell（zsh 优先，再试 bash）。@param {any} $ @returns {Promise<string | undefined>} */
async function findGoShell($) {
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    const r = await run($, goProbeArgv(shell))
    if (r.exitCode === 0 && r.stdout.trim()) return shell
  }
  return undefined
}

/**
 * 结束运行中的服务：进程号来自 server.json，命令行确认是文档服务才结束，并等端口释放。
 * @param {any} $ @param {{ port: number, pid?: number }} info
 * @returns {Promise<boolean>} 是否已结束
 */
async function stopServer($, info) {
  const pid = serverPid(info)
  if (pid === undefined) return false
  if (!isServerCommand((await run($, psArgv(pid))).stdout)) return false
  await run($, killArgv(pid))
  for (let i = 0; i < 10; i++) {
    await $.clock.sleep(200)
    if (!(await isAlive($, info))) return true
  }
  return false
}

/**
 * 首次启动新版服务前处理旧版（插件名 doc-review）留下的数据：
 * 先结束还在运行的旧服务，再把旧目录的 docs、outbox 复制到新目录（新目录已有 docs 就不动）。
 * 失败只提示，不挡着服务启动；每次加载 mod 只做一次。
 * @param {any} $
 */
async function migrateLegacy($) {
  if (isMigrated) return
  isMigrated = true
  try {
    const home = await $.env.get('HOME')
    if (!home) return
    const oldDir = legacyDataDirOf(home)
    if (!(await $.fs.exists(oldDir))) return
    const newDir = dataDirOf(home)
    if (await stopLegacyServer($, oldDir)) await $.clock.sleep(200)
    const hasNewDocs = await $.fs.exists(`${newDir}/docs`)
    if (!shouldCopyLegacy({ hasLegacyDir: true, hasNewDocs })) return
    const r = await $.process.run(copyLegacyArgv(oldDir, newDir))
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `退出码 ${r.exitCode}`)
    $.ui.toast('cc-doc-review：已把旧版数据迁移到 ~/.claude/cc-doc-review')
  } catch (err) {
    $.ui.toast(`cc-doc-review：迁移旧数据失败（${messageOf(err)}），旧数据仍在 ~/.claude/doc-review`)
  }
}

/**
 * 旧服务还在运行就结束它：server.json 指向的端口 health 名为 doc-review，且进程命令行确认是旧版服务。
 * @param {any} $ @param {string} oldDir
 * @returns {Promise<boolean>} 是否发出了结束命令
 */
async function stopLegacyServer($, oldDir) {
  const file = `${oldDir}/server.json`
  if (!(await $.fs.exists(file))) return false
  const text = await $.fs.read(file)
  const info = parseInfo(text)
  const pid = legacyServerPid(text)
  if (!info || pid === undefined) return false
  let health
  try {
    health = await $.http.fetch(`http://127.0.0.1:${info.port}/api/health`)
  } catch {
    return false
  }
  if (!isLegacyHealthy(health)) return false
  const ps = await $.process.run(psArgv(pid))
  if (!isLegacyCommand(ps.stdout)) return false
  await $.process.run(killArgv(pid))
  return true
}

/**
 * @param {any} $
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {boolean} [shouldStart] 为 false 时服务不在就返回 undefined，不去启动
 */
async function call($, method, path, body, shouldStart = true) {
  let info
  if (shouldStart) {
    info = await ensureServer($)
  } else {
    info = await readInfo($)
    if (!info || !(await isAlive($, info))) return undefined
  }
  return parseReply(await request($, info, method, path, body))
}

/**
 * 向已在运行的文档服务发请求（不去拉起服务）；服务不在时抛错，免得删除、标记假装成功。
 * @param {any} $ @param {string} method @param {string} path @param {unknown} [body]
 */
async function callLive($, method, path, body) {
  const info = await readInfo($)
  if (!info || !(await isAlive($, info))) throw new Error(t(lang, 'serverGone'))
  return parseReply(await request($, info, method, path, body))
}

/**
 * 向文档服务发一个请求，返回原始应答。
 * @param {any} $ @param {{ port: number, token: string }} info
 * @param {string} method @param {string} path @param {unknown} [body]
 */
async function request($, info, method, path, body) {
  return $.http.fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { 'X-Review-Token': info.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
