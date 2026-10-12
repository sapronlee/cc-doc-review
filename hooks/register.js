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
import {
  activeDocs,
  baseName,
  classifyDelivered,
  copyFailReason,
  nextReminder,
  reminderPrompt,
  reminderTitle,
} from '../src/band.js'
import { dataDirOf, isHealthy, messageOf, parseInfo, parseReply, reviewUrl, startArgv } from '../src/client.js'
import {
  contextText,
  approvedToast,
  approveQueuedToast,
  deliveredToast,
  isUserOrigin,
  queuedToast,
  remindedToast,
  remindFailedToast,
  reminderTargets,
  retryDelay,
} from '../src/delivery.js'
import { commentIdsIn, formatBatch } from '../src/format.js'
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
import { OPEN_SPEC, OPEN_TOOL, RESOLVE_SPEC, RESOLVE_TOOL, STATUS_SPEC, STATUS_TOOL } from '../src/rules.js'
import { countsOf, openResult, statusResult } from '../src/status.js'
import {
  BAND_STATES,
  bandDocs,
  commentIcon,
  dirOf,
  displayName,
  dividerLine,
  fitDocs,
  hasDrawnContent,
  markdownLink,
  MAX_ROWS,
  stateDescription,
  stateIcon,
  stateOf,
  visibleDocs,
} from '../src/bandview.js'

/** 斜杠命令名：不能叫 review，会和内置的 /code-review 冲突。*/
const COMMAND = 'cc-doc-review'
/** 写完这些工具的文件后按文件夹判断是否自动登记评审。*/
const WRITE_TOOLS = ['Write', 'Edit']
/** 自动登记失败（多半是服务起不来）后，这么久内不再尝试，免得每次写文档都等启动超时。*/
const AUTO_BACKOFF_MS = 60_000
/** 单次状态刷新卡住超过这么久，就当它已经结束。*/
const REFRESH_STUCK_MS = 10_000
/** 同一文档的〔打开评审页〕在这段时间内重复点击只算一次。*/
const OPEN_AGAIN_MS = 10_000
let isDelivering = false
let hasWarned = false
/** 投递定时器；会话重新开始时先取消旧的，避免叠加。@type {import('claude-code').Timer | undefined} */
let deliverTimer
/** 已送达（发进会话或附在用户消息上）但还没确认的批次 ID：确认失败时下一轮只重试确认，不重复发送。*/
const submittedBatches = new Set()
/** 发进会话失败的批次 → 已失败次数、下次重试的时间（$.clock.now() 的毫秒数）。@type {Map<string, { failures: number, nextAt: number }>} */
const retries = new Map()
/**
 * 重试用完、等着附在用户下一条消息上的批次：批次 ID → 排好的消息文字和其中的评论 ID。
 * @type {Map<string, { batch: string, text: string, ids: string[] }>}
 */
const awaitingUser = new Map()
/** 正附在用户消息上、那条消息还没进入的批次：投递定时器跳过它们，不另发；进入后转入 submittedBatches，被拒则回到 awaitingUser。*/
const attaching = new Set()
/** 已自动提醒过的批次：每批最多提醒一次，防止循环。*/
const remindedBatches = new Set()

// 状态带的数据。用模块变量加 $.ui.invalidate 重绘：热重载丢了也无妨，两秒内就重新取到。
/** 状态带刷新定时器。@type {import('claude-code').Timer | undefined} */
let statusTimer
let isRefreshing = false
let refreshStartedAt = 0
/** 本会话的文档概况（GET /api/docs）；服务不在时为空。@type {import('../src/band.js').DocSummary[]} */
let docs = []
/** 会话的工作目录：卡片里按它显示文档的相对目录；取到之前显示绝对目录。*/
let sessionCwd = ''
/** 内层内容绘制失败的提示每个进程只弹一次。*/
let hasWarnedInner = false
/** 最近一次刷新状态的时刻（$.clock.now() 的毫秒数）：文档项里「N 分钟前更新」按它算。*/
let bandNow = 0
/** 服务地址和令牌（server.json）：状态带的文件链接按它拼评审页地址；服务不在时为空。@type {import('../src/client.js').ServerInfo | undefined} */
let bandInfo
let docsKey = '[]'
let isExpanded = false
/**
 * 要送达的评论 ID → 所在文档、批次、是否已进入模型。
 * 带着它的「[文档评审]」消息真正开始一轮（turn.start），或随用户消息作为 context 进入，才算进入模型；一轮结束时只核对这些。
 * @type {Map<string, { doc: string, batch: string, isInModel: boolean }>}
 */
const delivered = new Map()
/** 提醒中的评论 ID（已送达、还没 review_resolve）。@type {string[]} */
let reminder = []
/** 点了〔×〕：下一批评论送达前不再提醒。*/
let isReminderDismissed = false
/** 每有新一批评论进入模型加一；核对期间变了，那次核对的结果作废。*/
let reminderEpoch = 0
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
/** 各文档最近一次〔打开评审页〕的时刻（$.clock.now() 的毫秒数），按文档路径记。@type {Map<string, number>} */
const openedAt = new Map()
/** 自重启失败后多久内不再重试。*/
const RESTART_BACKOFF_MS = 60_000
/** 已就哪个插件版本提示过「继续使用旧版服务」，每个版本只提示一次。@type {string | undefined} */
let staleWarnedFor

// 休眠模式：会话开始时只注册工具、命令和写文件钩子，不联网。
// 定时器只在 session.start 启动（引擎只保证从那里启动的定时器持续运行），休眠时每次 tick 只看标志就返回，不调用任何 $ 能力。
// 用到评审（调用评审工具、用斜杠命令、自动登记命中、开始时本会话已有文档）才唤醒，保持到会话结束。
let isAwake = false
/** 刚唤醒：下一次投递 tick 顺带取一次状态，状态带不用等 2 秒。*/
let isRefreshDue = false
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
const toolNames = { open: OPEN_TOOL, resolve: RESOLVE_TOOL, status: STATUS_TOOL }

/** 注册结果里的工具全名；拿不到像样的全名时用默认名。@param {any} registered @param {string} fallback */
const fullToolName = (registered, fallback) => {
  const tool = registered?.tool
  return typeof tool === 'string' && tool.startsWith('mcp__') ? tool : fallback
}

/** review_open：登记文档并返回评审链接和卡片数据。@param {any} $ @param {any} e */
async function reviewOpen($, e) {
  try {
    const file = String(e.path ?? '')
    const opened = await openDoc($, file)
    const path = String(opened.doc?.path ?? (await absPath($, file)))
    return { result: openResult({ url: String(opened.url), path, comments: opened.doc?.comments }, await $.session.cwd()) }
  } catch (err) {
    return { deny: `review_open 失败：${messageOf(err)}` }
  } finally {
    wake()
  }
}

/** review_resolve：把评论标为已解决。@param {any} $ @param {any} e */
async function reviewResolve($, e) {
  try {
    const items = Array.isArray(e.items) ? e.items : []
    const { resolved, missing = [] } = await call($, 'POST', '/api/resolve', { items })
    const done = `已标记 ${resolved} 条评论为已解决，评审页会自动更新。`
    return { result: missing.length ? `${done}找不到这些评论 ID：${missing.join('、')}，请核对后重试。` : done }
  } catch (err) {
    return { deny: `review_resolve 失败：${messageOf(err)}` }
  } finally {
    wake()
  }
}

/** review_status：本会话各文档的进度和待处理评论。@param {any} $ */
async function reviewStatusTool($) {
  try {
    return { result: await reviewStatus($) }
  } catch (err) {
    return { deny: `review_status 失败：${messageOf(err)}` }
  } finally {
    wake()
  }
}

/**
 * 输入框上方状态带里本插件画的「文档评审」；没什么可显示时返回 undefined。
 * 列哪些文档：未发送、待确认、待评审、Claude 处理中四种状态，且 24 小时内有变化的（bandDocs），先排轮到你的。
 * 桌面版：一行靠左，「评审」后面是文件药丸。药丸左边的 lucide 图标形状表示状态、颜色表示轮到谁；
 * 文件名是链接，和下面的用量一样平铺不加框，点了在系统浏览器打开评审页（桌面版的链接一律走外部浏览器）；
 * 服务地址还没取到时退回原生按钮。放几个按宽度估算，其余收成「+N」。
 * 命令行版：标题行下每个文档一行文字，状态写成文字，带〔复制链接〕〔打开〕，超过 3 个可展开。
 * @param {any} $ @param {any} e
 */
function bandTree($, e) {
  const { Box, Button, Markdown, Svg, Text } = $.ui.resolve(e)
  const btn = (/** @type {string} */ key, /** @type {string} */ label, /** @type {(p: any) => unknown} */ onPress, extra = {}) =>
    Button({
      key,
      label,
      onPress: p => {
        Promise.resolve()
          .then(() => onPress(p))
          .catch(err => $.ui.toast(`文档评审：${messageOf(err)}`))
      },
      ...extra,
    })
  const line = (/** @type {string} */ key, /** @type {any[]} */ children, extra = {}) =>
    Box({ key, flexDirection: 'row', alignItems: 'center', columnGap: 1, children, ...extra })
  const meta = (/** @type {any} */ doc) => BAND_STATES[/** @type {keyof typeof BAND_STATES} */ (stateOf(doc) ?? 'review')]

  const listed = bandDocs(docs, bandNow)
  const isReminding = reminder.length > 0 && !isReminderDismissed
  if (listed.length === 0 && !isReminding) return undefined
  const reminderLine = () =>
    line('head', [
      Box({ key: 'head-text', flexShrink: 1, children: [Text({ color: 'warning', bold: true, wrap: 'truncate-end', children: [reminderTitle(reminder.length)] })] }),
      btn('dismiss', '×', () => dismissReminder($), { role: 'dismiss' }),
    ])

  if (e.surface === 'desktop') {
    const pic = (/** @type {string} */ key, /** @type {{ svg: string, width: number }} */ p, /** @type {string} */ alt) =>
      Svg({ key, source: p.svg, alt, width: p.width, height: 18 })
    // 带 key 的盒子是悬停锚点；其中 absolute + display:none + hover 时 display:flex 的 Box 会被桌面版提成自带样式的悬浮卡片
    const anchor = (/** @type {string} */ key, /** @type {any[]} */ body, /** @type {any[]} */ card) =>
      Box({
        key,
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        children: [...body, Box({ position: 'absolute', display: 'none', hover: { display: 'flex' }, flexDirection: 'column', rowGap: 1, children: card })],
      })
    // 文件：状态图标在文件名链接左边，隔一格，免得和链接的颜色连成一片
    const pill = (/** @type {string} */ key, /** @type {any} */ doc) =>
      Box({
        key: `pill-${key}`,
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: 1,
        flexShrink: 0,
        children: [
          pic(`${key}:icon`, stateIcon(stateOf(doc) ?? 'review'), meta(doc).label),
          bandInfo
            ? Markdown({ key: `link:${doc.id}`, text: markdownLink(displayName(doc.path), reviewUrl(bandInfo, doc.id)) })
            : btn(key, displayName(doc.path), () => openReview($, doc), meta(doc).turn === 'wait' ? { dimColor: true } : {}),
        ],
      })
    // 「评审」卡片：标题、文档数，下面是图例（每种状态一行：图标、名称、篇数，只列不为 0 的）
    const legend = Object.keys(BAND_STATES).flatMap(state => {
      const n = listed.filter(d => stateOf(d) === state).length
      if (n === 0) return []
      const m = BAND_STATES[/** @type {keyof typeof BAND_STATES} */ (state)]
      return [
        line(`legend:${state}`, [
          pic(`legend-icon:${state}`, stateIcon(state), m.label),
          Text({ key: `legend-label:${state}`, children: [m.label] }),
          Box({ key: `legend-gap:${state}`, flexGrow: 1, minWidth: 2 }),
          Text({ key: `legend-n:${state}`, dimColor: true, children: [`${n} 篇`] }),
        ]),
      ]
    })
    const head = isReminding
      ? reminderLine()
      : anchor(
          'seg:head',
          [pic('head-icon', commentIcon(), '文档评审'), Text({ key: 'head-label', color: 'claude', children: [' 评审'] })],
          [
            Box({
              key: 'head-card-top',
              flexDirection: 'column',
              children: [
                Text({ key: 'head-title', bold: true, children: ['文档评审'] }),
                Text({ key: 'head-sum', dimColor: true, children: [`${listed.length} 个文档`] }),
              ],
            }),
            Box({ key: 'legend', flexDirection: 'column', children: legend }),
          ],
        )
    const { shown, hidden } = fitDocs(listed, e.props?.bodyColumns)
    const pills = shown.map(doc =>
      anchor(
        `seg:${doc.id}`,
        [pill(`open:${doc.id}`, doc)],
        [
          // 文件卡片只留：全名，和「状态 · 目录 · N 分钟前更新」
          Text({ key: `name:${doc.id}`, bold: true, children: [baseName(doc.path)] }),
          Text({ key: `desc:${doc.id}`, dimColor: true, children: [stateDescription(doc, sessionCwd, bandNow)] }),
        ],
      ),
    )
    const more =
      hidden > 0
        ? [
            anchor(
              'seg:more',
              [Text({ key: 'more-label', dimColor: true, children: [`+${hidden}`] })],
              listed.slice(shown.length).map(doc => pill(`open:${doc.id}`, doc)),
            ),
          ]
        : []
    // 不加左右内边距：桌面版外层容器本身有内边距，再加一层会把内容往中间挤
    return Box({ key: 'band', width: '100%', flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center', columnGap: 2, children: [head, ...pills, ...more] })
  }

  const { shown, hidden } = visibleDocs(listed, isExpanded)
  const head = isReminding
    ? reminderLine()
    : line('head', [
        Text({ key: 'head-title', bold: true, children: ['文档评审'] }),
        Text({ key: 'head-sum', dimColor: true, wrap: 'truncate-end', children: [`${listed.length} 个文档`] }),
      ])
  const items = shown.map(doc =>
    line(`doc:${doc.id}`, [
      Text({ key: `icon:${doc.id}`, dimColor: true, children: ['•'] }),
      Text({ key: `name:${doc.id}`, bold: true, wrap: 'truncate-end', children: [baseName(doc.path)] }),
      Box({ key: `dir:${doc.id}`, flexGrow: 1, flexShrink: 1, children: [Text({ dimColor: true, wrap: 'truncate-middle', children: [dirOf(doc.path, sessionCwd)] })] }),
      Text({ key: `state:${doc.id}`, color: meta(doc).turn === 'you' ? 'claude' : undefined, dimColor: meta(doc).turn !== 'you', children: [meta(doc).label] }),
      btn(`copy:${doc.id}`, '复制链接', p => copyLink($, doc, p.surface)),
      btn(`open:${doc.id}`, '打开', () => openReview($, doc)),
    ]),
  )
  const more =
    listed.length > MAX_ROWS
      ? [
          line('more', [
            Text({ key: 'more-text', dimColor: true, children: [isExpanded ? `共 ${listed.length} 个文档` : `还有 ${hidden} 个文档`] }),
            btn('toggle', isExpanded ? '收起' : '展开', () => toggleList($)),
          ]),
        ]
      : []
  return Box({ key: 'band', width: '100%', flexDirection: 'column', children: [head, ...items, ...more] })
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  const auto = autoRegisterConfig(options)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    goDormant($)
    needsWakeCheck = false
    isWakeCheckDue = false
    toolNames.open = fullToolName(await $.tool.register(OPEN_SPEC), OPEN_TOOL)
    toolNames.resolve = fullToolName(await $.tool.register(RESOLVE_SPEC), RESOLVE_TOOL)
    toolNames.status = fullToolName(await $.tool.register(STATUS_SPEC), STATUS_TOOL)
    // 定时器一律在这里启动；休眠时空转（只看标志），唤醒后才投递、刷新状态
    deliverTimer?.cancel()
    deliverTimer = $.clock.every(1000, () => {
      if (isWakeCheckDue) {
        isWakeCheckDue = false
        void checkWake($).catch(() => {})
      }
      if (!isAwake) return
      if (isRefreshDue) {
        isRefreshDue = false
        void refreshStatus($)
      }
      void deliver($)
    })
    statusTimer?.cancel()
    statusTimer = $.clock.every(2000, () => {
      if (isAwake) void refreshStatus($)
    })
    // 命令放在最后，且失败不抛：名字被引擎拒绝时也不能让工具和投递跟着失效。
    try {
      await $.command.register({
        name: COMMAND,
        description: '在右侧浏览器面板打开文档评审页',
        argumentHint: '<md 或 html 文件>',
      })
    } catch (err) {
      $.ui.toast(`文档评审：/${COMMAND} 命令注册失败（${messageOf(err)}），评审工具不受影响`)
    }
    // 在后台查：服务卡住也不拖住会话开始
    void checkWake($).catch(() => {})
    return started
  })

  // 会话结束：一律复位为休眠。/clear、/resume 后进程以新会话继续，且不会再触发 session.start，
  // 所以定时器留着空转（等再次唤醒）；真正退出时定时器随进程一起消失，不用专门取消。
  // /clear 后是全新的会话，不用查；/resume 换来的会话可能登记过文档，下一轮开始时查一次。
  on('session.end', async ($, e, next) => {
    goDormant($)
    needsWakeCheck = e.reason === 'resume'
    return next(e)
  })

  // 按注册时拿到的真实工具名分派；不是本插件的工具原样放行
  on('tool.call', async ($, e, next) => {
    if (e.tool === toolNames.open) return reviewOpen($, e)
    if (e.tool === toolNames.resolve) return reviewResolve($, e)
    if (e.tool === toolNames.status) return reviewStatusTool($)
    return next(e)
  })

  // 重试用完的评论附在用户的下一条消息上（context），只挂在用户自己发的消息上；休眠时直接放行。
  on('prompt.submit', async ($, e, next) => {
    if (!isAwake || awaitingUser.size === 0 || !isUserOrigin(e.origin)) return next(e)
    const waiting = [...awaitingUser.values()]
    // 移出队列的同时标为送达中（中间没有 await）：next 挂起期间投递定时器不会把这批再发一遍
    awaitingUser.clear()
    for (const w of waiting) attaching.add(w.batch)
    const epoch = sessionEpoch
    const putBack = () => {
      if (epoch !== sessionEpoch) return
      for (const w of waiting) {
        attaching.delete(w.batch)
        if (!awaitingUser.has(w.batch)) awaitingUser.set(w.batch, w)
      }
    }
    /** @type {import('claude-code').PromptSubmitResult} */
    let r
    try {
      r = await next({ ...e, context: [...(e.context ?? []), contextText(waiting.map(w => w.text))] })
    } catch (err) {
      putBack()
      throw err
    }
    if (r.drop !== undefined) {
      putBack()
      return r
    }
    if (epoch !== sessionEpoch) return r
    // 已随用户的消息进入模型（空闲时这一轮已开始；打字时有一轮在跑，就并进那一轮）。
    // 确认送达交给投递定时器（下一次 tick），确认只在那一处做，不会和它并发。
    const ids = waiting.flatMap(w => w.ids)
    for (const w of waiting) {
      attaching.delete(w.batch)
      submittedBatches.add(w.batch)
    }
    markInModel($, ids)
    // 只附了「通过」通知（没有评论）时不报「已收到 0 条评论」
    if (ids.length > 0) $.ui.toast(deliveredToast(ids.length))
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      const file = e.args.trim()
      if (!file) return { text: `用法：/${COMMAND} <md 或 html 文件>` }
      const { url } = await openDoc($, file)
      // 直接打开；打不开再请 Claude 在浏览器面板打开
      const how = await openUrl($, url)
      if (!how) $.prompt.submit({ text: `请在浏览器面板打开文档评审页：${url}` }).catch(() => {})
      const where = how === 'panel' ? '，已在浏览器面板打开' : how === 'browser' ? '，已在系统浏览器打开' : ''
      return { text: `已登记 ${file}${where}，评审页：${url}` }
    } catch (err) {
      return { text: `打开失败：${messageOf(err)}` }
    } finally {
      wake()
    }
  })

  // 带评论的「[文档评审]」消息开始一轮：这批评论才算进入模型。
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (/** @type {any} */ (e).agentId) return started
    if (needsWakeCheck) {
      needsWakeCheck = false
      isWakeCheckDue = true
    }
    if (e.text.startsWith('[文档评审]')) markInModel($, commentIdsIn(e.text))
    return started
  })

  // 一轮正常答完时核对进入模型的评论是否都回复了处理结果；子代理、被中断或出错的轮次不算。
  // 在后台核对，不拖住这一轮的收尾。休眠时直接放行。
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isAwake && !e.agentId && !e.isAborted && e.reason === 'answer') {
      void checkUnreplied($).catch(() => {})
    }
    return done
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

  // 同一位置可能还有别的插件（如用量带）：自己画完也把下层的内容接在下面，不独占这一块
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isAwake || e.props.hasSurvey) return next(e)
    const mine = bandTree($, e)
    if (mine === undefined) return next(e)
    // 内层（别的插件或引擎）出错不能连累本插件：只画自己这一行，并提示一次原因
    let rest
    try {
      rest = await next(e)
    } catch (err) {
      if (!hasWarnedInner) {
        hasWarnedInner = true
        $.ui.toast(`文档评审：同一位置的其他插件绘制失败，已跳过（${messageOf(err)}）`)
      }
      return mine
    }
    if (rest === null || rest === undefined) return mine
    const { Box, Svg } = $.ui.resolve(e)
    // 下层内容里可能有引擎自己的节点，而引擎节点不能放在设了 width 的 Box 下面（整块会被拒绝）。
    // 所以包着下层内容的 stack、rest 都不设宽度，靠纵向排列的拉伸铺满；只有自己画的部分设 width。
    const stretch = { flexDirection: 'column', alignItems: 'stretch' }
    const own = Box({ key: 'mine', width: '100%', children: [mine] })
    const below = Box({ key: 'rest', ...stretch, children: [rest] })
    if (e.surface !== 'desktop') return Box({ key: 'stack', ...stretch, children: [own, below] })
    // 分隔线只在上下两块都有可见内容时画：下层只有引擎节点（看起来是空的）时不画
    if (!hasDrawnContent(rest)) return Box({ key: 'stack', ...stretch, children: [own, below] })
    const line = dividerLine()
    const divider = Box({ key: 'divider', width: '100%', overflow: 'hidden', children: [Svg({ source: line.svg, alt: '分隔线', width: line.width, height: line.height })] })
    return Box({ key: 'stack', ...stretch, children: [own, divider, below] })
  })
}

/**
 * 发进会话，不再填进输入框兜底。在那一轮开始时才返回。
 * @param {any} $
 * @param {string} text
 * @param {boolean} [asUser] 以用户的话发出（评论是用户写的）；否则以插件的名义
 * @returns {Promise<boolean>} 是否发进了会话（被拒或出错为 false）
 */
async function submitPrompt($, text, asUser = false) {
  try {
    const r = await $.prompt.submit(asUser ? { text, asUser: true } : { text })
    return r.drop === undefined
  } catch {
    return false
  }
}

/**
 * 每 2 秒：取本会话的文档概况，变了就重绘状态带；提醒中时顺带看那些评论回复了没有。
 * 服务不在就当没有数据，不去启动它。
 * @param {any} $
 */
async function refreshStatus($) {
  const now = await $.clock.now()
  // 上一次刷新卡住（服务半死不活）超过 10 秒就不再等它
  if (isRefreshing && now - refreshStartedAt < REFRESH_STUCK_MS) return
  isRefreshing = true
  refreshStartedAt = now
  // 「N 分钟前」每过一分钟重画一次；其余时候数据不变就不重画（桌面版每次重画都会闪一下）
  const isNewMinute = Math.floor(now / 60_000) !== Math.floor(bandNow / 60_000)
  bandNow = now
  if (isNewMinute) $.ui.invalidate('ui.render')
  const epoch = sessionEpoch
  try {
    const session = await $.session.id()
    if (!sessionCwd) sessionCwd = String((await $.session.cwd()) ?? '')
    const info = await readInfo($)
    if (info?.port !== bandInfo?.port || info?.token !== bandInfo?.token) {
      bandInfo = info
      $.ui.invalidate('ui.render')
    }
    const list = await call($, 'GET', `/api/docs?session=${encodeURIComponent(session)}`, undefined, false)
    // 取的过程中会话结束了：这是上一个会话的数据，丢掉
    if (epoch !== sessionEpoch) return
    setDocs($, Array.isArray(list) ? list : [])
    if (reminder.length > 0) {
      // 去掉已解决或已不存在的；一时查不到的（服务重启中）继续提醒
      const before = reminder
      const epoch = reminderEpoch
      const { pending, settled, unknown } = await lookupDelivered($, before)
      for (const id of settled) delivered.delete(id)
      if (epoch === reminderEpoch) setReminder($, nextReminder(pending, unknown, reminder))
    }
  } catch {
    if (epoch === sessionEpoch) setDocs($, [])
  } finally {
    isRefreshing = false
  }
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
  // 命中即唤醒（登记完再唤醒，状态带第一次取数据就能带上这个文档）
  try {
    const now = await $.clock.now()
    // 检查和占位之间不能有 await：同一文件并发写两次时只登记一次
    if (now < autoRetryAt || autoRegistered.has(path)) return
    autoRegistered.add(path)
    try {
      await openDoc($, path)
      $.ui.toast(`已登记评审：${baseName(path)}`)
    } catch (err) {
      autoRegistered.delete(path)
      autoRetryAt = now + AUTO_BACKOFF_MS
      if (!hasAutoWarned) {
        hasAutoWarned = true
        $.ui.toast(`自动登记评审失败：${messageOf(err)}`)
      }
    }
  } finally {
    wake()
  }
}

/**
 * 唤醒：会话开始时启动的定时器从下一次 tick 起投递（每秒）、刷新状态（每 2 秒），并在下一次投递 tick 顺带取一次状态。
 * 只改标志，不建定时器。已唤醒时什么都不做。
 */
function wake() {
  if (isAwake) return
  isAwake = true
  isRefreshDue = true
}

/**
 * 复位为休眠：定时器空转，上一个会话的状态全部作废，状态带让位。
 * @param {any} $
 */
function goDormant($) {
  isAwake = false
  isRefreshDue = false
  sessionEpoch++
  resetSessionState()
  $.ui.invalidate('ui.render')
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

/** 换了会话（新开、/clear）时，上一个会话的状态带数据和提醒都作废。*/
function resetSessionState() {
  docs = []
  docsKey = ''
  isExpanded = false
  delivered.clear()
  reminder = []
  isReminderDismissed = false
  reminderEpoch++
  autoRegistered.clear()
  hasAutoWarned = false
  autoRetryAt = 0
  submittedBatches.clear()
  retries.clear()
  awaitingUser.clear()
  attaching.clear()
  remindedBatches.clear()
  hasWarned = false
  openedAt.clear()
}

/** @param {any} $ @param {import('../src/band.js').DocSummary[]} list */
function setDocs($, list) {
  const key = JSON.stringify(list)
  if (key === docsKey) return
  docs = list
  docsKey = key
  $.ui.invalidate('ui.render')
}

/** @param {any} $ @param {string[]} ids */
function setReminder($, ids) {
  if (ids.join() === reminder.join()) return
  reminder = ids
  $.ui.invalidate('ui.render')
}

/** @param {any} $ */
function dismissReminder($) {
  isReminderDismissed = true
  $.ui.invalidate('ui.render')
}

/** @param {any} $ */
function toggleList($) {
  isExpanded = !isExpanded
  $.ui.invalidate('ui.render')
}

/**
 * 查已送达评论的现状：取它们所在文档的详情，分出没回复的、已了结的（已解决或 404）和这次没查到的。
 * @param {any} $
 * @param {string[]} ids
 */
async function lookupDelivered($, ids) {
  /** @type {Map<string, string>} */
  const docOf = new Map()
  for (const id of ids) {
    const doc = delivered.get(id)?.doc
    if (doc) docOf.set(id, doc)
  }
  /** @type {Map<string, any>} */
  const fetched = new Map()
  for (const docId of new Set(docOf.values())) {
    const d = await fetchDoc($, docId)
    if (d !== undefined) fetched.set(docId, d)
  }
  return classifyDelivered(ids, docOf, fetched)
}

/**
 * 取文档详情：取到返回文档，404 返回 null，服务不可达或其他错误返回 undefined。不去启动服务。
 * @param {any} $ @param {string} docId
 */
async function fetchDoc($, docId) {
  try {
    const info = await readInfo($)
    if (!info || !(await isAlive($, info))) return undefined
    const r = await request($, info, 'GET', `/api/doc?doc=${encodeURIComponent(docId)}`)
    if (r.status === 404) return null
    return parseReply(r)
  } catch {
    return undefined
  }
}

/**
 * 一轮结束时：进入模型的评论里还有处于「处理中」的，状态带进入提醒状态，并自动提醒 Claude 一次
 * （每批评论最多一次，防止循环），同时弹提示告诉用户。服务一时不可达时保留原提醒，不清空。
 * @param {any} $
 */
async function checkUnreplied($) {
  const ids = [...delivered].filter(([, v]) => v.isInModel).map(([id]) => id)
  if (ids.length === 0) return
  const epoch = reminderEpoch
  const { pending, settled, unknown } = await lookupDelivered($, ids)
  for (const id of settled) delivered.delete(id)
  // 核对期间有新一批评论进入模型（提醒被重置）或换了会话时，这次的结果作废
  if (epoch !== reminderEpoch) return
  setReminder($, nextReminder(pending, unknown, reminder))
  const batchOf = new Map(pending.map(id => [id, delivered.get(id)?.batch ?? id]))
  const target = reminderTargets(pending, batchOf, remindedBatches)
  if (target.ids.length === 0) return
  // 先记下再发：提醒那一轮结束时再核对，不会再提醒同一批
  for (const b of target.batches) remindedBatches.add(b)
  const n = target.ids.length
  const isSent = await submitPrompt($, reminderPrompt(target.ids))
  $.ui.toast(isSent ? remindedToast(n) : remindFailedToast(n))
}

/**
 * 取文档当前有效的评审链接：用服务的端口、口令和文档 ID 直接拼（服务不在会拉起）。
 * 不走 /api/open：那是「登记」，会刷新登记时间，把待确认、已通过的文档误判回待评审。
 * @param {any} $ @param {{ id: string }} doc
 */
async function linkOf($, doc) {
  return reviewUrl(await ensureServer($), doc.id)
}

/** @param {any} $ @param {{ path: string }} doc */
async function openReview($, doc) {
  let url
  try {
    url = await linkOf($, doc)
  } catch (err) {
    $.ui.toast(`打开评审页失败：${messageOf(err)}`)
    return
  }
  // 先直接打开（浏览器面板或系统浏览器），不用等 Claude 回复，也不在对话里留消息
  if (await openUrl($, url)) return
  // 都打不开：退回请 Claude 在浏览器面板打开
  const now = await $.clock.now()
  // 检查和记下之间不能有 await：连点时只有第一下发请求
  const last = openedAt.get(doc.path)
  if (last !== undefined && now - last < OPEN_AGAIN_MS) {
    $.ui.toast('已经请求过打开这个评审页，Claude 手上这轮结束后就会打开')
    return
  }
  openedAt.set(doc.path, now)
  $.ui.toast('已请求 Claude 在浏览器面板打开评审页')
  try {
    if (!(await submitPrompt($, `请在浏览器面板打开文档评审页：${url}`, true))) {
      openedAt.delete(doc.path)
      $.ui.toast(`打开评审页的请求没能发进会话，链接：${url}`)
    }
  } catch (err) {
    openedAt.delete(doc.path)
    $.ui.toast(`打开评审页失败：${messageOf(err)}`)
  }
}

/** 桌面版浏览器面板的工具：插件可以像 Claude 一样直接调用，打开网页、查看面板状态。*/
const BROWSER_TOOL = 'mcp__Claude_Browser__preview_start'
const BROWSER_STATE_TOOL = 'mcp__Claude_Browser__tabs_context'

/** 工具结果里的文字，用来判断和提示。@param {any} r */
const toolText = r => String(r?.text ?? (typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? '')))

/**
 * 浏览器面板现在是否打开并显示着：问一次面板状态；问不了时当作已显示（不再多做一步）。
 * @param {any} $ @param {boolean} canAsk
 */
async function isPanelShown($, canAsk) {
  if (!canAsk) return true
  try {
    // 结果里的引号可能被转义（\"browserOpen\": true），按词匹配；认不出来时当作已显示，不误判
    const text = toolText(await $.tool.call({ tool: BROWSER_STATE_TOOL }))
    if (/browserOpen\W*false/.test(text) || /currently hidden|is hidden/i.test(text)) return false
    return true
  } catch {
    return true
  }
}

/**
 * 直接打开评审页，不经过 Claude，点了马上能看到：
 * 1. 有浏览器面板（桌面版）时先在面板里打开（'panel'），并确认面板确实显示了；
 * 2. 面板打不开（比如自动模式下插件发起的调用被拦下）或面板收着看不见，就立刻用系统浏览器打开（'browser'），
 *    并提示原因；命令行版没有面板，直接用系统浏览器；
 * 3. 系统浏览器也打不开时返回 undefined，由调用方退回请 Claude 打开。
 * @param {any} $ @param {string} url
 * @returns {Promise<'panel' | 'browser' | undefined>}
 */
async function openUrl($, url) {
  let names = []
  try {
    names = (await $.tool.list()).map((/** @type {any} */ t) => t.name)
  } catch {
    // 取不到工具列表：当作没有面板
  }
  let reason = ''
  if (names.includes(BROWSER_TOOL)) {
    try {
      const r = await $.tool.call({ tool: BROWSER_TOOL, url })
      if (r?.deny !== undefined) reason = '内置浏览器被权限拦下'
      else if (r?.isError) reason = `内置浏览器打不开：${toolText(r).slice(0, 80)}`
      else if (await isPanelShown($, names.includes(BROWSER_STATE_TOOL))) return 'panel'
      else reason = '内置浏览器面板是收起的'
    } catch (err) {
      reason = `内置浏览器打不开：${messageOf(err)}`
    }
  }
  for (const argv of [['open', url], ['xdg-open', url]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5000 })
      if (r.exitCode === 0) {
        $.ui.toast(reason ? `${reason}，已在系统浏览器打开评审页` : '已在系统浏览器打开评审页')
        return 'browser'
      }
    } catch {
      // 这个命令不存在：试下一个
    }
  }
  if (reason) $.ui.toast(`${reason}，系统浏览器也打不开，已请 Claude 打开`)
  return undefined
}

/**
 * 复制评审链接；界面不支持剪贴板（桌面版是远程界面）时改为把链接填进输入框。
 * @param {any} $ @param {{ path: string }} doc @param {string | undefined} surface
 */
async function copyLink($, doc, surface) {
  let url
  try {
    url = await linkOf($, doc)
  } catch (err) {
    $.ui.toast(`取评审链接失败：${messageOf(err)}`)
    return
  }
  /** @type {{ isCopied: boolean, reason?: string }} */
  let copied
  try {
    copied = await $.ui.copy({ text: url, surface })
  } catch (err) {
    copied = { isCopied: false, reason: messageOf(err) }
  }
  if (copied.isCopied) {
    $.ui.toast('评审链接已复制')
    return
  }
  await $.prompt.fill({ text: url, mode: 'append' })
  $.ui.toast(`复制失败（${copyFailReason(String(copied.reason))}），链接已填进输入框`)
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

/**
 * review_status：本会话各文档的路径、链接、各状态条数和待处理评论。服务不在会拉起（数据在磁盘上）。
 * 某个文档取不到详情时用概况里的条数，不列评论。
 * @param {any} $
 */
async function reviewStatus($) {
  const session = await $.session.id()
  const list = await call($, 'GET', `/api/docs?session=${encodeURIComponent(session)}`)
  const info = await readInfo($)
  const cwd = await $.session.cwd()
  /** @type {import('../src/status.js').StatusEntry[]} */
  const entries = []
  for (const d of Array.isArray(list) ? list : []) {
    const url = info ? reviewUrl(info, d.id) : ''
    const detail = await fetchDoc($, d.id)
    const comments = Array.isArray(detail?.comments) ? detail.comments : undefined
    if (!comments) {
      entries.push({ path: d.path, url, drafts: d.drafts ?? 0, sent: d.sent ?? 0, pending: [] })
      continue
    }
    const pending = comments
      .filter((/** @type {any} */ c) => c.status === 'sent')
      .map((/** @type {any} */ c) => ({ id: String(c.id), quote: String(c.quote ?? ''), body: String(c.body ?? '') }))
    entries.push({ path: d.path, url, ...countsOf(comments), pending })
  }
  return statusResult(entries, cwd)
}

/**
 * 每秒一次：把本会话 outbox 里的批次发进会话。服务不在就跳过，不去启动它。
 * 发不进去（被拒或出错）时按 5、15、45 秒重试；仍不行就等用户的下一条消息，附在上面送达（见 prompt.submit 钩子）。
 * @param {any} $
 */
async function deliver($) {
  if (isDelivering) return
  isDelivering = true
  const epoch = sessionEpoch
  try {
    const session = await $.session.id()
    const batches = await call($, 'GET', `/api/outbox?session=${encodeURIComponent(session)}`, undefined, false)
    if (!batches) return
    const cwd = await $.session.cwd()
    for (const batch of batches) {
      // 取的过程中会话结束了：别把上一个会话的评论发进新会话
      if (epoch !== sessionEpoch) return
      const id = batch.batch
      // 等着附在、或正附在用户消息上的：不另发
      if (awaitingUser.has(id) || attaching.has(id)) continue
      if (!submittedBatches.has(id)) {
        const retry = retries.get(id)
        if (retry && (await $.clock.now()) < retry.nextAt) continue
        // 先记下再发：prompt.submit 在那一轮开始时才返回，turn.start 要能认出这批评论
        recordBatch(batch)
        const text = formatBatch(batch, cwd)
        const isSent = await submitPrompt($, text, true)
        if (epoch !== sessionEpoch) return
        if (!isSent) {
          await scheduleRetry($, batch, text)
          continue
        }
        retries.delete(id)
        submittedBatches.add(id)
        $.ui.toast(batch.kind === 'approve' ? approvedToast(baseName(batch.path)) : deliveredToast(batch.comments.length))
      }
      await call($, 'POST', '/api/outbox/ack', { session, batch: id })
      submittedBatches.delete(id)
    }
    hasWarned = false
  } catch (err) {
    if (!hasWarned) {
      hasWarned = true
      $.ui.toast(`文档评审：${messageOf(err)}`)
    }
  } finally {
    isDelivering = false
  }
}

/**
 * 一批没发进会话：记下失败次数和下次重试的时间；重试用完就改为等用户的下一条消息，并提示用户。
 * @param {any} $ @param {{ batch: string, kind?: string, path: string, comments: { id: string }[] }} batch @param {string} text 排好的消息
 */
async function scheduleRetry($, batch, text) {
  const failures = (retries.get(batch.batch)?.failures ?? 0) + 1
  const delay = retryDelay(failures)
  if (delay !== undefined) {
    retries.set(batch.batch, { failures, nextAt: (await $.clock.now()) + delay })
    return
  }
  retries.delete(batch.batch)
  awaitingUser.set(batch.batch, { batch: batch.batch, text, ids: batch.comments.map(c => c.id) })
  $.ui.toast(batch.kind === 'approve' ? approveQueuedToast(baseName(batch.path)) : queuedToast(batch.comments.length))
}

/**
 * 记下一批评论。是否进入模型由 turn.start（发进会话的那批）或 prompt.submit 钩子（附在用户消息上的那批）认定。
 * @param {{ batch: string, doc: string, comments: { id: string }[] }} batch
 */
function recordBatch(batch) {
  for (const c of batch.comments) {
    if (!delivered.has(c.id)) delivered.set(c.id, { doc: batch.doc, batch: batch.batch, isInModel: false })
  }
}

/**
 * 「[文档评审]」消息开始了一轮：其中的评论进入模型。新一批进来时，之前的提醒和〔×〕都作废，到这一轮结束再判断。
 * @param {any} $ @param {string[]} ids
 */
function markInModel($, ids) {
  let isNew = false
  for (const id of ids) {
    const entry = delivered.get(id)
    if (entry && !entry.isInModel) {
      entry.isInModel = true
      isNew = true
    }
  }
  if (!isNew) return
  reminderEpoch++
  isReminderDismissed = false
  setReminder($, [])
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
 * 服务的 health 应答：在跑且是评审服务就返回应答，否则 undefined。
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
        $.ui.toast(`文档评审：评审服务要更新到 ${version}，但${why}，继续使用旧版`)
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
  throw new Error(`评审服务启动失败，日志：${log}`)
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
    $.ui.toast(isUpdate ? '文档评审：插件已更新，正在准备新版评审服务' : '文档评审：首次使用，正在下载评审服务')
    try {
      await downloadBinary($, version, platform, dest, unique)
      return
    } catch (err) {
      reason = `下载失败：${messageOf(err)}`
    }
  }
  const shell = await findGoShell($)
  if (!shell) {
    throw new Error(`评审服务获取失败（${label}）：${reason}。本机登录 shell 里也没有 Go，无法本地编译；请检查网络后重试，或安装 Go`)
  }
  $.ui.toast(`文档评审：${reason}，改为本地编译，可能要一分钟`)
  const tmp = `${dest}.build-${unique}`
  const built = await run($, goBuildArgv(shell, $.plugin.root, version, tmp, dest), 300_000)
  if (built.exitCode !== 0) {
    await run($, removeArgv(tmp))
    throw new Error(`评审服务获取失败（${label}）：${reason}；本地编译失败：${failureOf(built)}`)
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
 * 结束运行中的服务：进程号来自 server.json，命令行确认是评审服务才结束，并等端口释放。
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
    $.ui.toast('文档评审：已把旧版评论数据迁移到 ~/.claude/cc-doc-review')
  } catch (err) {
    $.ui.toast(`文档评审：迁移旧数据失败（${messageOf(err)}），旧数据仍在 ~/.claude/doc-review`)
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
 * 向评审服务发一个请求，返回原始应答。
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
