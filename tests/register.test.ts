import { expect, mock, test } from 'claude-code/testing'

import { autoRegisterConfig, isReviewDoc } from '../src/autoreg.js'
import { parseReply } from '../src/client.js'

const INFO = { port: 4823, token: 'tok', pid: 5150 }
const LEGACY_INFO = { port: 4901, token: 'old', pid: 4242 }
const PROC = { isStdoutTruncated: false, isStderrTruncated: false }
const HASH = 'a'.repeat(64)
const ASSET = 'cc-doc-review-server-darwin-arm64'
const VERSIONED = '/home/x/.claude/cc-doc-review/bin/cc-doc-review-server-0.2.0'

/** 把 mod 用到的引擎能力都答上；o 控制服务状态和 outbox 内容。*/
function stub(on: any, o: any = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-11T00:00:00Z') })
  // 数外部调用（网络、文件、进程、环境、会话信息）：休眠时定时器空转，一次都不该有
  const ext = { calls: 0 }
  const counted =
    (answer: any) =>
    (...args: any[]) => {
      ext.calls += 1
      return answer(...args)
    }
  const fetched: { method: string; path: string; body?: any }[] = []
  const submitted: string[] = []
  const prompts: { text: string; origin: any; context?: readonly string[] }[] = []
  const filled: string[] = []
  const spawned: string[][] = []
  const timeouts: { argv: string[]; timeoutMs?: number }[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const copied: any[] = []
  const panelOpened: string[] = []
  const tools: Record<string, any> = {}
  let acks = 0
  // 状态带和一轮结束检查用：本会话文档概况、各文档详情，测试中途可以改
  const server: any = {
    docs: o.docs ?? [],
    details: o.details ?? {},
    outbox: o.outbox ?? [],
    session: 'sess-1',
    alive: true,
    version: o.serverVersion,
  }

  on('env.get', counted(() => ({ value: '/home/x' })))
  // o.localDocs：本机 docs 目录里的文档文件（{ name, session }）
  on('fs.list', counted(($: any, e: any) =>
    o.localDocs ? { value: o.localDocs.map((d: any) => ({ name: d.name, kind: 'file', size: 10 })) } : { value: [] },
  ))
  on('fs.exists', counted(($: any, e: any) => {
    // 旧版（doc-review）数据目录默认不存在，迁移相关的测试再打开
    if (e.path === '/home/x/.claude/doc-review') return { value: o.legacyDir === true }
    if (e.path === '/home/x/.claude/cc-doc-review/docs') return { value: o.newHasDocs === true }
    if (e.path.endsWith('server.json')) return { value: o.hasInfo !== false }
    // 默认当作开发模式（插件目录下已有编译好的程序）；预编译分发的测试把 hasBinary 设为 false
    if (e.path.endsWith('/bin/cc-doc-review-server')) return { value: o.hasBinary !== false }
    if (e.path === VERSIONED) return { value: o.hasVersioned === true }
    return { value: true }
  }))
  on('fs.read', counted(($: any, e: any) => {
    const local = o.localDocs?.find((d: any) => e.path.endsWith(`/docs/${d.name}`))
    if (local) return { value: JSON.stringify({ id: local.name, session: local.session }) }
    if (e.path.endsWith('/.claude-plugin/plugin.json'))
      return { value: o.noPluginVersion ? '{"name":"cc-doc-review"}' : JSON.stringify({ name: 'cc-doc-review', version: o.pluginVersion ?? '0.2.0' }) }
    if (e.path.includes('.sums'))
      return { value: o.sums ?? `${HASH}  ${ASSET}\n${'c'.repeat(64)}  cc-doc-review-server-linux-amd64\n` }
    return { value: JSON.stringify(e.path === '/home/x/.claude/doc-review/server.json' ? LEGACY_INFO : INFO) }
  }))
  on('session.id', counted(() => ({ value: server.session })))
  on('session.cwd', counted(() => ({ value: '/proj' })))
  on('session.start', () => ({ cwd: '/proj' }))
  on('tool.register', ($: any, e: any) => {
    tools[e.name] = e
    return { value: { tool: `mcp__${o.pluginName ?? 'cc-doc-review'}__${e.name}` } }
  })
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('command.register', ($: any, e: any) => {
    commands.push(e.name)
    return o.refuseCommand ? { deny: `"/${e.name}" refused: it is the built-in` } : { value: { command: e.name } }
  })
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text ?? e.message ?? JSON.stringify(e))
    return { value: undefined }
  })
  on('process.run', counted(async ($: any, e: any) => {
    spawned.push([...e.argv])
    timeouts.push({ argv: [...e.argv], timeoutMs: e.init?.timeoutMs })
    const [cmd] = e.argv
    const done = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, ...PROC } })
    if (o.copyFails && cmd === '/bin/sh' && e.argv[2].includes('cp -R')) return done(1, '', 'cp: 磁盘已满')
    // 系统浏览器：o.systemOpen 为真时 open 能打开
    if (cmd === 'open' || cmd === 'xdg-open') return o.systemOpen && cmd === 'open' ? done(0) : done(1)
    if (cmd === 'ps') {
      // 旧版服务（pid 4242）和新版服务（pid 5150）各自的命令行
      const isNew = e.argv[2] === String(INFO.pid)
      return done(0, isNew ? (o.serverCommand ?? '/home/x/.claude/cc-doc-review/bin/cc-doc-review-server-0.1.0\n') : (o.legacyCommand ?? ''))
    }
    if (cmd === 'kill' && e.argv[1] === String(INFO.pid)) {
      if (!o.killFails) server.alive = false
      return done(0)
    }
    if (cmd === 'uname') return o.unameFails ? done(127, '', 'uname: 找不到命令') : done(0, o.uname ?? 'Darwin arm64\n')
    if (cmd === 'curl') {
      // 下载很慢：时间在失败之前过去
      if (o.slowCurlMs) await clock.advance(o.slowCurlMs)
      if (o.curlFails) return done(22, '', 'curl: (22) The requested URL returned error: 404')
      return done(0)
    }
    if (cmd === '/bin/sh' && e.argv[2].includes('sha256sum')) return done(0, `${o.fileSha ?? HASH}  ${e.argv[4]}\n`)
    // 找 Go / 本地编译：o.goShell 是装了 Go 的登录 shell
    if (e.argv[1] === '-lc' && e.argv[2] === 'command -v go')
      return o.goShell === cmd ? done(0, '/usr/local/go/bin/go\n') : done(1)
    if (e.argv[1] === '-lc' && e.argv[2].includes('go build')) return o.buildFails ? done(2, '', 'build: 缺少依赖') : done(0)
    if (cmd === '/bin/sh' && e.argv[2].includes('nohup') && o.startsAlive) {
      o.alive = true
      server.alive = true
      server.version = o.startVersion ?? o.pluginVersion ?? '0.2.0'
    }
    return done(0)
  }))
  on('http.fetch', counted(async ($: any, e: any) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    fetched.push({ method, path: url.pathname + url.search, body })
    if (url.port === String(LEGACY_INFO.port)) {
      return o.legacyName === undefined
        ? { value: { status: 503, ok: false, headers: {}, text: '{}' } }
        : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: o.legacyName }) } }
    }
    const reply = (status: number, data: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) },
    })
    if (url.pathname === '/api/health')
      return o.alive !== false && server.alive ? reply(200, { name: 'cc-doc-review', ...(server.version ? { version: server.version } : {}) }) : reply(503, {})
    if (url.pathname === '/api/open') {
      if (o.openFails) return reply(500, { error: '磁盘满了' })
      return body.path.endsWith('.txt')
        ? reply(400, { error: '只支持 .md、.markdown、.html、.htm 文件' })
        : reply(200, {
            doc: { id: 'd1', path: body.path, comments: o.openComments ?? [] },
            url: 'http://127.0.0.1:4823/review?doc=d1&t=tok',
          })
    }
    if (url.pathname === '/api/docs') {
      if (o.docsGate) await o.docsGate
      return reply(200, server.docs)
    }
    if (url.pathname === '/api/doc') {
      const d = server.details[url.searchParams.get('doc') ?? '']
      return d ? reply(200, d) : reply(404, { error: '未找到' })
    }
    if (url.pathname === '/api/outbox') return reply(200, server.outbox)
    if (url.pathname === '/api/outbox/ack') {
      acks += 1
      if (acks <= (o.failAcks ?? 0)) return reply(500, { error: '暂时不可用' })
      server.outbox = server.outbox.filter((b: any) => b.batch !== body.batch)
      return reply(200, { ok: true })
    }
    if (url.pathname === '/api/resolve') {
      if (o.resolveBody !== undefined) return { value: { status: 502, ok: false, headers: {}, text: o.resolveBody } }
      const missing = body.items.map((it: any) => it.id).filter((id: string) => id.startsWith('c_gone'))
      if (missing.length === body.items.length) return reply(404, { error: `未找到：评论 ${missing.join('、')}` })
      return reply(200, missing.length ? { resolved: body.items.length - missing.length, missing } : { resolved: body.items.length })
    }
    return reply(404, { error: 'not stubbed' })
  }))
  // 插件自己发的（$.prompt.submit）记进 submitted；其余来源（用户、通知、别的插件）记进 prompts，连同附上的 context。
  // dropSubmit：true 时本插件发的一律被拒，数字 n 时只拒前 n 次。
  let ownSubmits = 0
  on('prompt.submit', async ($: any, e: any) => {
    if (e.origin?.kind === 'plugin' && e.origin.name === 'cc-doc-review') {
      submitted.push(e.text)
      ownSubmits += 1
      const isDropped = typeof o.dropSubmit === 'number' ? ownSubmits <= o.dropSubmit : o.dropSubmit === true
      return isDropped ? { drop: '会话不接受' } : { text: e.text }
    }
    // 让用户消息停在半路（空闲时 next 要等那一轮开始才返回）
    if (o.userGate) await o.userGate
    if (o.refuseUserPrompts > 0) {
      o.refuseUserPrompts -= 1
      return { drop: '拒绝' }
    }
    prompts.push({ text: e.text, origin: e.origin, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('prompt.fill', ($: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.copy', ($: any, e: any) => {
    copied.push(e)
    return { value: o.copy ?? { isCopied: true } }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  // 会话里的工具：o.browserTool 为真时有桌面版浏览器面板工具
  on('tool.list', () => ({
    value: o.browserTool
      ? [
          { name: 'mcp__Claude_Browser__preview_start', description: '浏览器面板', mcp: true },
          { name: 'mcp__Claude_Browser__tabs_context', description: '面板状态', mcp: true },
        ]
      : [],
  }))
  // 写文件工具和浏览器面板工具：引擎的应答
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'mcp__Claude_Browser__preview_start') {
      panelOpened.push(e.url)
      if (o.panelDenied) return { deny: 'The server-side auto mode classifier gave no verdict' }
      return o.panelFails ? { isError: true, result: undefined, text: '面板打不开' } : { result: 'opened' }
    }
    // 面板状态：o.panelHidden 为真时，打开后面板仍没显示
    if (e.tool === 'mcp__Claude_Browser__tabs_context')
      // 结果里的引号是转义过的，和真实桌面版一致
      return { result: o.panelHidden ? '{\\"browserOpen\\": false, \\"tabs\\": []}' : '{\\"browserOpen\\": true} The Browser pane is currently displayed.' }
    return o.writeErrors ? { isError: true, result: undefined, text: '写入失败' } : { result: `wrote ${e.file_path}` }
  })
  // 状态带让位时画引擎自己的
  on('ui.render', () => {
    if (o.innerThrows) throw new Error('用量带坏了')
    // engineEmpty：下层只有引擎自己的空内容（没有别的插件画东西）
    if (o.engineEmpty) return { type: 'Box', props: {}, children: [] }
    return { type: 'Text', props: {}, children: ['engine'] }
  })
  return { clock, fetched, submitted, prompts, filled, spawned, timeouts, commands, toasts, copied, panelOpened, server, tools, ext }
}

const BAND = {
  plugin: 'cc-doc-review',
  component: 'AbovePrompt',
  surface: 'desktop',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const URL_D1 = 'http://127.0.0.1:4823/review?doc=d1&t=tok'
/** 状态带里点文件得到的链接：直接用文档 ID 拼，不经过 /api/open 重新登记。*/
const urlOf = (id: string) => `http://127.0.0.1:4823/review?doc=${id}&t=tok`

function allText(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(allText).join('')
  return allText(node.children)
}

const summary = (id: string, o: any = {}) => ({
  id,
  path: `/proj/docs/${id}.md`,
  open: (o.drafts ?? 0) + (o.sent ?? 0),
  drafts: o.drafts ?? 0,
  sent: o.sent ?? 0,
  ...(o.activeAt ? { activeAt: o.activeAt } : {}),
  ...(o.resolved !== undefined ? { resolved: o.resolved } : {}),
  ...(o.openedAt ? { openedAt: o.openedAt } : {}),
  ...(o.state ? { state: o.state, changedAt: o.changedAt ?? '2026-10-10T23:50:00Z' } : {}),
})

/** 状态带每 2 秒取一次文档概况。*/
async function refresh(clock: any) {
  await clock.advance(2000)
  await clock.settle()
}

async function band($: any, props: any = {}) {
  return $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } })
}

/** 命令行版状态带：文件有〔打开〕按钮，打开流程（面板、系统浏览器、请 Claude）用它测。*/
async function terminalBand($: any) {
  return $.ui.mount({ ...BAND, surface: 'terminal' })
}

/** 一轮结束；核对在后台跑，settle 一下让它跑完。*/
async function turnDone($: any, clock: any, extra: any = {}) {
  await $.turn.complete({ answer: '好了', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...extra })
  await clock.settle()
}

/** 投递一批评论，并让那条「[文档评审]」消息开始一轮（引擎在真正发出时会这样做）。*/
async function deliverAndStart($: any, s: any) {
  await tick(s.clock)
  await $.turn.start({ text: s.submitted.at(-1), turnId: 't1' })
}

async function boot($: any) {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/proj' })
}

/** 唤醒：调用一次评审工具。投递、状态带、一轮结束检查都只在唤醒后运行。*/
async function wake($: any, s: any) {
  await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  await s.clock.settle()
}

async function bootAwake($: any, s: any) {
  await boot($)
  await wake($, s)
}

/** 会话结束（/clear 时 reason 为 clear，进程以新会话 ID 继续）。*/
async function endSession($: any, s: any, reason = 'clear') {
  await $.session.end({ reason, sessionId: s.server.session, resume: { id: s.server.session } })
  await s.clock.settle()
}

async function tick(clock: any) {
  await clock.advance(1000)
  await clock.settle()
}

const BATCH = {
  batch: 'b_20261011_100500_ab12',
  doc: 'd1',
  path: '/proj/docs/plan.md',
  comments: [{ id: 'c_1', quote: '方案', body: '改成表格' }],
}

test('review_open 把相对路径补成绝对路径并登记到当前会话', async ($, on) => {
  const s = stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  expect(s.fetched.find(f => f.path === '/api/open')?.body).toEqual({ path: '/proj/docs/plan.md', session: 'sess-1' })
})

test('插件以别的名字加载（会话中途改名、热重载后沿用旧名）时，按引擎给的真实工具名响应', async ($, on) => {
  const s = stub(on, { pluginName: 'doc-review' })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__doc-review__review_open', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  const status: any = await $.tool.call({ tool: 'mcp__doc-review__review_status' })
  expect(String(status.result)).not.toContain('失败')
  // 写死的默认名不是这个会话里的工具，原样交给引擎
  const other: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  expect(String(other.result)).toBe('wrote undefined')
  expect(s.fetched.filter(f => f.path === '/api/open').length).toBe(1)
})

test('review_open 的返回带评审卡片的数据和画法说明', async ($, on) => {
  stub(on, { openComments: [{ id: 'c_1', status: 'draft' }, { id: 'c_2', status: 'sent' }, { id: 'c_3', status: 'resolved' }] })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  const text = String(ran.result)
  const data = JSON.parse(text.match(/卡片数据：(.*)/)?.[1] ?? 'null')
  expect(data).toEqual({ url: URL_D1, name: 'plan.md', path: 'docs/plan.md', drafts: 1, sent: 1, resolved: 1 })
  expect(text).toContain('show_widget')
  expect(text).toContain('直接把链接')
})

test('review_status 注册为工具，返回各文档路径、链接、条数和待处理评论，并唤醒', async ($, on) => {
  const s = stub(on, {
    docs: [],
    details: {
      plan: {
        id: 'plan',
        path: '/proj/docs/plan.md',
        comments: [
          { id: 'c_1', status: 'sent', quote: '方案', body: '改成表格' },
          { id: 'c_2', status: 'draft', quote: '草稿', body: '还没发' },
          { id: 'c_3', status: 'resolved', quote: 'x', body: 'y' },
        ],
      },
    },
  })
  await boot($)
  await s.clock.settle()
  expect(await isAwake(s)).toBe(false)
  s.server.docs = [summary('plan', { sent: 1, drafts: 1 }), summary('gone')]
  expect(s.tools.review_status?.description).toContain('评审进度')
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_status' })
  const text = String(ran.result)
  expect(text).toContain('plan.md（docs/plan.md）')
  expect(text).toContain('http://127.0.0.1:4823/review?doc=plan&t=tok')
  expect(text).toContain('待发送 1 条 · 处理中 1 条 · 已解决 1 条')
  expect(text).toContain('[c_1] 原文：「方案」')
  expect(text).toContain('意见：改成表格')
  // 草稿用户还没发，不给 Claude
  expect(text).not.toContain('还没发')
  // 取不到详情的文档照样列出，用概况里的条数
  expect(text).toContain('gone.md（docs/gone.md）')
  expect(await isAwake(s)).toBe(true)
})

test('review_status 本会话没有文档时直说', async ($, on) => {
  stub(on, { docs: [] })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_status' })
  expect(String(ran.result)).toContain('还没有登记')
})

test('review_open 失败时把服务端原因告诉模型', async ($, on) => {
  stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'a.txt' })
  expect(String(ran.deny)).toContain('只支持')
})

test('review_resolve 透传条目并报告数量', async ($, on) => {
  const s = stub(on)
  await boot($)
  const items = [{ id: 'c_1', note: '已改' }, { id: 'c_2', note: '没改：超出范围' }]
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_resolve', items })
  expect(String(ran.result)).toContain('2 条')
  expect(s.fetched.find(f => f.path === '/api/resolve')?.body).toEqual({ items })
})

test('服务没在跑就在后台启动它', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  const pending = $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  await s.clock.advance(4000)
  await pending
  const run = s.spawned.find(a => a[0] === '/bin/sh')
  expect(run?.[3].endsWith('/bin/cc-doc-review-server')).toBe(true)
  expect(run?.[4]).toBe('/home/x/.claude/cc-doc-review/server.log')
  // 只有 nohup 那条进后台，且标准输入输出都改向，sh 才会立刻退出
  expect(run?.[2]).toBe('mkdir -p "$(dirname "$1")"; nohup "$0" >>"$1" 2>&1 </dev/null &')
})

/** 启动服务（服务不在，mod 会先迁移再启动），返回按顺序执行过的命令。*/
async function startServer($: any, s: any) {
  const pending = $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  await s.clock.advance(4000)
  await pending
  return s.spawned as string[][]
}
const isCopy = (a: string[]) => a[0] === '/bin/sh' && a[2].includes('cp -R')
const isStart = (a: string[]) => a[0] === '/bin/sh' && a[2].includes('nohup')

test('旧数据目录存在且新目录没有 docs 时，启动服务前把 docs、outbox 复制过来', async ($, on) => {
  const s = stub(on, { alive: false, legacyDir: true })
  await boot($)
  const ran = await startServer($, s)
  const copy = ran.findIndex(isCopy)
  expect(copy).toBeGreaterThanOrEqual(0)
  expect(ran[copy].slice(3)).toEqual(['sh', '/home/x/.claude/doc-review', '/home/x/.claude/cc-doc-review'])
  expect(copy).toBeLessThan(ran.findIndex(isStart))
})

test('新目录已有 docs 时不覆盖，不复制', async ($, on) => {
  const s = stub(on, { alive: false, legacyDir: true, newHasDocs: true })
  await boot($)
  const ran = await startServer($, s)
  expect(ran.some(isCopy)).toBe(false)
  expect(ran.some(isStart)).toBe(true)
})

test('旧数据目录不存在时什么都不迁移', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  const ran = await startServer($, s)
  expect(ran.some(isCopy)).toBe(false)
  expect(ran.some(a => a[0] === 'kill')).toBe(false)
  expect(s.fetched.some((f: any) => f.path === '/api/health')).toBe(true)
})

test('旧服务还在运行且身份确认无误时，先结束它再复制数据', async ($, on) => {
  const s = stub(on, {
    alive: false,
    legacyDir: true,
    legacyName: 'doc-review',
    legacyCommand: '/old/bin/doc-review-server\n',
  })
  await boot($)
  const ran = await startServer($, s)
  expect(ran.find(a => a[0] === 'ps')).toEqual(['ps', '-p', '4242', '-o', 'command='])
  const kill = ran.findIndex(a => a[0] === 'kill')
  expect(ran[kill]).toEqual(['kill', '4242'])
  expect(kill).toBeLessThan(ran.findIndex(isCopy))
})

test('端口上的 health 名字不是 doc-review 时不结束进程', async ($, on) => {
  const s = stub(on, { alive: false, legacyDir: true, legacyName: 'something-else', legacyCommand: 'x' })
  await boot($)
  const ran = await startServer($, s)
  expect(ran.some(a => a[0] === 'kill')).toBe(false)
})

test('进程命令行不是旧版评审服务时不结束进程', async ($, on) => {
  const s = stub(on, { alive: false, legacyDir: true, legacyName: 'doc-review', legacyCommand: '/usr/bin/node app.js' })
  await boot($)
  const ran = await startServer($, s)
  expect(ran.some(a => a[0] === 'kill')).toBe(false)
  expect(ran.some(isCopy)).toBe(true)
})

test('迁移只执行一次', async ($, on) => {
  const s = stub(on, { alive: false, legacyDir: true })
  await boot($)
  await startServer($, s)
  await startServer($, s)
  expect(s.spawned.filter(isCopy).length).toBe(1)
  expect(s.spawned.filter(isStart).length).toBe(2)
})

test('复制失败时提示并继续启动服务', async ($, on) => {
  const s = stub(on, { alive: false, legacyDir: true, copyFails: true })
  await boot($)
  const ran = await startServer($, s)
  expect(s.toasts.some((t: string) => t.includes('迁移旧数据失败'))).toBe(true)
  expect(ran.some(isStart)).toBe(true)
})

test('review_resolve 部分 ID 找不到时报告成功条数和找不到的 ID', async ($, on) => {
  stub(on)
  await boot($)
  const items = [{ id: 'c_1', note: '已改' }, { id: 'c_gone1', note: 'x' }]
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_resolve', items })
  expect(String(ran.result)).toContain('已标记 1 条')
  expect(String(ran.result)).toContain('c_gone1')
})

test('review_resolve 全部找不到时把原因告诉模型', async ($, on) => {
  stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_resolve', items: [{ id: 'c_gone1', note: 'x' }] })
  expect(String(ran.deny)).toContain('c_gone1')
})

test('服务应答不是 JSON 时报 HTTP 状态码', async ($, on) => {
  stub(on, { resolveBody: '<html>Bad Gateway</html>' })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_resolve', items: [{ id: 'c_1', note: 'x' }] })
  expect(String(ran.deny)).toContain('HTTP 502')
})

test('parseReply：非 JSON 的错误应答给出状态码', async () => {
  expect(() => parseReply({ ok: false, status: 500, text: 'oops' })).toThrow('HTTP 500')
  expect(() => parseReply({ ok: false, status: 400, text: '{"error":"原因"}' })).toThrow('原因')
  expect(parseReply({ ok: true, status: 200, text: '' })).toEqual({})
})

test('会话重复开始时投递定时器不叠加', async ($, on) => {
  const s = stub(on, { docs: [summary('plan')] })
  await boot($)
  await boot($)
  await s.clock.settle()
  await tick(s.clock)
  expect(s.fetched.filter(f => f.path.startsWith('/api/outbox?')).length).toBe(1)
})

// ---- 预编译分发：首次使用下载、校验、本地编译兜底、开发模式、版本自更新 ----

/** 调一次 review_open（服务可能要启动，推进时钟让等待结束），返回工具结果。*/
async function openOnce($: any, s: any) {
  const pending = $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  await s.clock.advance(4000)
  return (await pending) as any
}
const argvOf = (s: any, cmd: string) => s.spawned.filter((a: string[]) => a[0] === cmd)
const isBuild = (a: string[]) => a[1] === '-lc' && a[2].includes('go build')
const isFinalize = (a: string[]) => a[0] === '/bin/sh' && a[2].includes('chmod +x')
const isSha = (a: string[]) => a[0] === '/bin/sh' && a[2].includes('sha256sum')
const isKill = (a: string[]) => a[0] === 'kill'
/** 没有预编译程序、服务不在：走「首次使用」的路径。*/
const FRESH = { alive: false, hasBinary: false }

test('开发模式：插件目录下有程序就直接用它，不下载', async ($, on) => {
  const s = stub(on, { alive: false, startsAlive: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.find(isStart)?.[3].endsWith('/bin/cc-doc-review-server')).toBe(true)
  expect(argvOf(s, 'curl').length).toBe(0)
  expect(argvOf(s, 'uname').length).toBe(0)
})

test('开发模式：运行中的服务版本和插件不同也不自动重启', async ($, on) => {
  const s = stub(on, { serverVersion: '0.1.0' })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.some(isKill)).toBe(false)
  expect(s.spawned.some(isStart)).toBe(false)
})

test('首次使用：下载程序和 SHA256SUMS，校验通过后保存到数据目录并启动', async ($, on) => {
  const s = stub(on, { ...FRESH, startsAlive: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.toasts.some((t: string) => t.includes('首次使用，正在下载评审服务'))).toBe(true)
  const curls = argvOf(s, 'curl')
  expect(curls.length).toBe(2)
  const base = 'https://github.com/sapronlee/CC-Doc-Review/releases/download/v0.2.0'
  // 临时文件名带本次独有的后缀，下载、校验、改名都只针对这两个文件
  const part = curls[0].at(-2) as string
  const sumsFile = curls[1].at(-2) as string
  expect(part).toMatch(new RegExp(`^${VERSIONED}\\.part-[0-9a-z-]+$`))
  expect(sumsFile).toMatch(new RegExp(`^${VERSIONED}\\.sums-[0-9a-z-]+$`))
  expect(curls[0].at(-1)).toBe(`${base}/${ASSET}`)
  expect(curls[1].at(-1)).toBe(`${base}/SHA256SUMS`)
  // 下载和编译给足超时（引擎默认 30 秒）
  expect(s.timeouts.find(t => t.argv[0] === 'curl')?.timeoutMs).toBeGreaterThanOrEqual(120_000)
  const sha = s.spawned.findIndex(isSha)
  const fin = s.spawned.findIndex(isFinalize)
  expect(s.spawned[sha].at(-1)).toBe(part)
  expect(s.spawned[fin].slice(-2)).toEqual([part, VERSIONED])
  const start = s.spawned.findIndex(isStart)
  expect(sha).toBeLessThan(fin)
  expect(fin).toBeLessThan(start)
  expect(s.spawned[start][3]).toBe(VERSIONED)
  // 临时文件清理掉
  expect(argvOf(s, 'rm').at(-1)).toEqual(['rm', '-f', part, sumsFile])
})

test('linux 平台下载对应的程序', async ($, on) => {
  const sums = `${HASH}  cc-doc-review-server-linux-arm64\n`
  const s = stub(on, { ...FRESH, startsAlive: true, uname: 'Linux aarch64\n', sums })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(argvOf(s, 'curl')[0].at(-1)).toBe(
    'https://github.com/sapronlee/CC-Doc-Review/releases/download/v0.2.0/cc-doc-review-server-linux-arm64',
  )
})

test('已经下载过这个版本就不再下载', async ($, on) => {
  const s = stub(on, { ...FRESH, hasVersioned: true, startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(argvOf(s, 'curl').length).toBe(0)
  expect(argvOf(s, 'uname').length).toBe(0)
  expect(s.toasts.some((t: string) => t.includes('首次使用'))).toBe(false)
  expect(s.spawned.find(isStart)?.[3]).toBe(VERSIONED)
})

test('SHA-256 校验失败：不安装、不启动，清理临时文件，错误里说明原因和平台', async ($, on) => {
  const s = stub(on, { ...FRESH, fileSha: 'd'.repeat(64) })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('校验失败')
  expect(String(ran.deny)).toContain('darwin/arm64')
  expect(String(ran.deny)).toContain('没有 Go')
  expect(s.spawned.some(isFinalize)).toBe(false)
  expect(s.spawned.some(isStart)).toBe(false)
  const [, , part, sumsFile] = argvOf(s, 'rm').at(-1) as string[]
  expect(part.startsWith(`${VERSIONED}.part-`)).toBe(true)
  expect(sumsFile.startsWith(`${VERSIONED}.sums-`)).toBe(true)
})

test('SHA256SUMS 里没有这个平台的条目时按校验失败处理', async ($, on) => {
  const s = stub(on, { ...FRESH, sums: `${HASH}  cc-doc-review-server-linux-amd64\n` })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('SHA256SUMS')
  expect(s.spawned.some(isFinalize)).toBe(false)
  expect(s.spawned.some(isStart)).toBe(false)
  // 临时文件清理掉
  const rm = argvOf(s, 'rm').at(-1) as string[]
  expect(rm.slice(0, 2)).toEqual(['rm', '-f'])
  expect(rm[2].startsWith(`${VERSIONED}.part-`)).toBe(true)
  expect(rm[3].startsWith(`${VERSIONED}.sums-`)).toBe(true)
})

test('下载失败且登录 shell 里有 Go：退回本地编译插件目录下的 server/', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true, goShell: '/bin/zsh', startsAlive: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  const build = s.spawned.find(isBuild) as string[]
  expect(build.slice(0, 2)).toEqual(['/bin/zsh', '-lc'])
  expect(build[4]).toBe('0.2.0')
  expect(build[5]).toMatch(new RegExp(`^${VERSIONED}\\.build-[0-9a-z-]+$`))
  expect(build[6]).toBe(VERSIONED)
  expect(build[3].startsWith('/home/x')).toBe(false)
  expect(s.timeouts.find(t => isBuild(t.argv))?.timeoutMs).toBeGreaterThanOrEqual(300_000)
  expect(s.toasts.some((t: string) => t.includes('本地编译'))).toBe(true)
  expect(s.spawned.find(isStart)?.[3]).toBe(VERSIONED)
})

test('zsh 里没有 Go 就再试 bash', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true, goShell: '/bin/bash', startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(s.spawned.filter(a => a[2] === 'command -v go').map(a => a[0])).toEqual(['/bin/zsh', '/bin/bash'])
  expect((s.spawned.find(isBuild) as string[])[0]).toBe('/bin/bash')
})

test('校验失败同样退回本地编译', async ($, on) => {
  const s = stub(on, { ...FRESH, fileSha: 'd'.repeat(64), goShell: '/bin/zsh', startsAlive: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.some(isBuild)).toBe(true)
  expect(s.spawned.some(isFinalize)).toBe(false)
})

test('下载失败且没有 Go：错误里有平台、原因和建议', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true })
  await boot($)
  const ran = await openOnce($, s)
  const msg = String(ran.deny)
  expect(msg).toContain('评审服务')
  expect(msg).toContain('darwin/arm64')
  expect(msg).toContain('404')
  expect(msg).toContain('没有 Go')
  expect(s.spawned.some(isStart)).toBe(false)
})

test('下载失败、本地编译也失败：两个原因都说明', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true, goShell: '/bin/zsh', buildFails: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('404')
  expect(String(ran.deny)).toContain('本地编译失败')
  expect(String(ran.deny)).toContain('缺少依赖')
  expect(s.spawned.some(isStart)).toBe(false)
})

test('不支持的平台：不下载，有 Go 就编译，没有就报错并带上 uname', async ($, on) => {
  const withGo = stub(on, { ...FRESH, uname: 'FreeBSD amd64\n', goShell: '/bin/zsh', startsAlive: true })
  await boot($)
  await openOnce($, withGo)
  expect(argvOf(withGo, 'curl').length).toBe(0)
  expect(withGo.spawned.some(isBuild)).toBe(true)
})

test('不支持的平台且没有 Go：错误里说明平台', async ($, on) => {
  const s = stub(on, { ...FRESH, uname: 'FreeBSD amd64\n' })
  await boot($)
  const ran = await openOnce($, s)
  expect(argvOf(s, 'curl').length).toBe(0)
  expect(String(ran.deny)).toContain('不支持的平台')
  expect(String(ran.deny)).toContain('FreeBSD amd64')
})

test('准备失败后一分钟内不再重试，过后再试', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true })
  await boot($)
  await openOnce($, s)
  const first = argvOf(s, 'uname').length
  const again: any = await openOnce($, s)
  expect(argvOf(s, 'uname').length).toBe(first)
  expect(String(again.deny)).toContain('404')
  await s.clock.advance(61_000)
  await openOnce($, s)
  expect(argvOf(s, 'uname').length).toBe(first + 1)
})

test('同时来了几个调用只下载一次', async ($, on) => {
  const s = stub(on, { ...FRESH, startsAlive: true })
  await boot($)
  const calls = [1, 2, 3].map(() => $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' }))
  await s.clock.advance(4000)
  await Promise.all(calls)
  expect(argvOf(s, 'curl').length).toBe(2)
})

test('读不到插件版本（非开发模式）：明确报错，不下载', async ($, on) => {
  const s = stub(on, { ...FRESH, noPluginVersion: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('插件版本')
  expect(argvOf(s, 'curl').length).toBe(0)
})

test('服务版本和插件不同：先备好新程序，再结束旧进程并启动新版本', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.1.0', startsAlive: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  const ps = s.spawned.findIndex(a => a[0] === 'ps')
  const kill = s.spawned.findIndex(isKill)
  const start = s.spawned.findIndex(isStart)
  expect(s.spawned[ps]).toEqual(['ps', '-p', '5150', '-o', 'command='])
  expect(s.spawned[kill]).toEqual(['kill', '5150'])
  // 新程序（这里要下载）先备好，旧进程才结束
  expect(s.spawned.findIndex(a => a[0] === 'curl')).toBeLessThan(kill)
  expect(ps).toBeLessThan(kill)
  expect(kill).toBeLessThan(start)
  expect(s.spawned[start][3]).toBe(VERSIONED)
})

test('服务版本和插件相同：不动它', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.2.0' })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.length).toBe(0)
})

test('旧版服务的 health 没有版本号：当作版本不同，重启', async ($, on) => {
  const s = stub(on, { hasBinary: false, hasVersioned: true, startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(s.spawned.some(isKill)).toBe(true)
  expect(s.spawned.some(isStart)).toBe(true)
})

test('进程命令行不是评审服务：不结束，继续用旧版并提示', async ($, on) => {
  const s = stub(on, { hasBinary: false, hasVersioned: true, serverVersion: '0.1.0', serverCommand: '/usr/bin/node app.js' })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.some(isKill)).toBe(false)
  expect(s.spawned.some(isStart)).toBe(false)
  expect(s.toasts.some((t: string) => t.includes('继续使用'))).toBe(true)
})

test('旧进程没能结束：不启动新进程，继续用旧版并提示', async ($, on) => {
  const s = stub(on, { hasBinary: false, hasVersioned: true, serverVersion: '0.1.0', killFails: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.some(isKill)).toBe(true)
  expect(s.spawned.some(isStart)).toBe(false)
  expect(s.toasts.some((t: string) => t.includes('继续使用'))).toBe(true)
})

test('新版程序准备失败：旧服务不动，继续用旧版并提示', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.1.0', curlFails: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.some(isKill)).toBe(false)
  expect(s.toasts.some((t: string) => t.includes('继续使用'))).toBe(true)
})

test('服务比插件新（旧会话还加载着旧插件）：不降级，不结束也不提示', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.3.0' })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.result)).toContain('review?doc=d1')
  expect(s.spawned.length).toBe(0)
  expect(s.toasts.some((t: string) => t.includes('评审服务要更新'))).toBe(false)
})

test('服务版本号不是 semver（如 dev）：不重启', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: 'dev' })
  await boot($)
  await openOnce($, s)
  expect(s.spawned.length).toBe(0)
})

test('新版程序暂时准备失败：一分钟内不再试，退避结束后恢复就重启成功', async ($, on) => {
  const o: any = { hasBinary: false, serverVersion: '0.1.0', curlFails: true, startsAlive: true }
  const s = stub(on, o)
  await boot($)
  await openOnce($, s)
  expect(s.spawned.some(isKill)).toBe(false)
  o.curlFails = false
  await openOnce($, s)
  expect(s.spawned.some(isKill)).toBe(false)
  await s.clock.advance(61_000)
  await openOnce($, s)
  expect(s.spawned.filter(isKill).length).toBe(1)
  expect(s.spawned.filter(isStart).length).toBe(1)
})

test('旧进程暂时没能结束：一分钟内不再试，过后可以重试', async ($, on) => {
  const o: any = { hasBinary: false, hasVersioned: true, serverVersion: '0.1.0', killFails: true, startsAlive: true }
  const s = stub(on, o)
  await boot($)
  await openOnce($, s)
  await openOnce($, s)
  expect(s.spawned.filter(isKill).length).toBe(1)
  o.killFails = false
  await s.clock.advance(61_000)
  await openOnce($, s)
  expect(s.spawned.filter(isKill).length).toBe(2)
  expect(s.spawned.filter(isStart).length).toBe(1)
})

test('两个调用同时发现服务过旧：只结束一次旧进程、只启动一次新进程', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.1.0', startsAlive: true, slowCurlMs: 500 })
  await boot($)
  const first = $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  const second = $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  await s.clock.advance(4000)
  await Promise.all([first, second])
  expect(s.spawned.filter(isKill).length).toBe(1)
  expect(s.spawned.filter(isStart).length).toBe(1)
})

test('重启后版本仍对不上时不会反复重启', async ($, on) => {
  const s = stub(on, { hasBinary: false, hasVersioned: true, serverVersion: '0.1.0', startsAlive: true, startVersion: '0.1.0' })
  await boot($)
  await openOnce($, s)
  await openOnce($, s)
  expect(s.spawned.filter(isKill).length).toBe(1)
  expect(s.spawned.filter(isStart).length).toBe(1)
})

test('outbox 里的批次发进会话并确认送达，只发一次', async ($, on) => {
  const s = stub(on, { outbox: [BATCH] })
  await bootAwake($, s)
  await tick(s.clock)
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toContain('[文档评审] docs/plan.md 有 1 条新评论')
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
})

test('送达成功时提示「已收到 N 条评论，Claude 正在处理」', async ($, on) => {
  const two = { ...BATCH, comments: [...BATCH.comments, { id: 'c_2', quote: 'x', body: 'y' }] }
  const s = stub(on, { outbox: [two] })
  await bootAwake($, s)
  await tick(s.clock)
  expect(s.toasts).toContain('已收到 2 条评论，Claude 正在处理')
})

/** 用户在输入框里发一条消息。*/
async function userSays($: any, text: string, kind = 'composer') {
  return $.prompt.submit({ text, wait: false, origin: { kind } })
}

/** 走 n 次每秒的投递 tick。*/
async function ticks(clock: any, n: number) {
  for (let i = 0; i < n; i++) await tick(clock)
}

test('发不进会话时按 5、15、45 秒重试，之后不再发，也不填进输入框', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], dropSubmit: true })
  await bootAwake($, s)
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  await ticks(s.clock, 4)
  expect(s.submitted.length).toBe(1)
  await tick(s.clock) // 失败后第 5 秒
  expect(s.submitted.length).toBe(2)
  await ticks(s.clock, 14)
  expect(s.submitted.length).toBe(2)
  await tick(s.clock) // 再失败后第 15 秒
  expect(s.submitted.length).toBe(3)
  await ticks(s.clock, 44)
  expect(s.submitted.length).toBe(3)
  await tick(s.clock) // 再失败后第 45 秒
  expect(s.submitted.length).toBe(4)
  await s.clock.advance(300_000)
  await s.clock.settle()
  expect(s.submitted.length).toBe(4)
  expect(s.filled).toEqual([])
  // 没送达就不确认
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(0)
  expect(s.toasts.some((t: string) => t.includes('下一条消息'))).toBe(true)
})

test('重试成功后确认送达并提示，只发到成功为止', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], dropSubmit: 1 })
  await bootAwake($, s)
  await tick(s.clock)
  expect(s.toasts).not.toContain('已收到 1 条评论，Claude 正在处理')
  await ticks(s.clock, 5)
  expect(s.submitted.length).toBe(2)
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
  expect(s.toasts).toContain('已收到 1 条评论，Claude 正在处理')
  await ticks(s.clock, 60)
  expect(s.submitted.length).toBe(2)
})

/** 投递一直失败，走完 3 次重试。*/
async function exhaustRetries(s: any) {
  await ticks(s.clock, 1 + 5 + 15 + 45)
  expect(s.submitted.length).toBe(4)
}

test('重试都失败后，把评论作为 context 附在用户的下一条消息上，并确认送达', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], dropSubmit: true, details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await exhaustRetries(s)
  const r: any = await userSays($, '继续')
  await s.clock.settle()
  expect(r.text).toBe('继续')
  const sent = s.prompts.at(-1)
  expect(sent?.text).toBe('继续')
  expect(sent?.context?.length).toBe(1)
  expect(sent?.context?.[0]).toContain('[c_1]')
  expect(sent?.context?.[0]).toContain('改成表格')
  await tick(s.clock)
  const acks = s.fetched.filter(f => f.path === '/api/outbox/ack')
  expect(acks.length).toBe(1)
  expect(acks[0].body).toEqual({ session: 'sess-1', batch: BATCH.batch })
  expect(s.toasts).toContain('已收到 1 条评论，Claude 正在处理')
  // 只附一次；确认后不再发
  await userSays($, '再继续')
  expect(s.prompts.at(-1)?.context).toBeUndefined()
  await ticks(s.clock, 60)
  expect(s.submitted.length).toBe(4)
  // 附上的评论算进入了模型：这一轮结束没回复就提醒
  await turnDone($, s.clock)
  expect(s.submitted.at(-1)).toContain('c_1')
})

test('附带评论的用户消息还没进入时，投递定时器不另发这批，进入后只确认一次', async ($, on) => {
  const o: any = { outbox: [BATCH], dropSubmit: true }
  const s = stub(on, o)
  await bootAwake($, s)
  await exhaustRetries(s)
  let release: () => void = () => {}
  o.userGate = new Promise<void>(r => (release = r))
  o.dropSubmit = false
  const pending = userSays($, '继续')
  await s.clock.settle()
  await ticks(s.clock, 10)
  expect(s.submitted.length).toBe(4)
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(0)
  release()
  await pending
  await s.clock.settle()
  await ticks(s.clock, 10)
  expect(s.submitted.length).toBe(4)
  expect(s.prompts.at(-1)?.context?.[0]).toContain('[c_1]')
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
})

test('附带评论的用户消息被拒后，评论回到队列，投递定时器仍不另发', async ($, on) => {
  const o: any = { outbox: [BATCH], dropSubmit: true }
  const s = stub(on, o)
  await bootAwake($, s)
  await exhaustRetries(s)
  o.dropSubmit = false
  o.refuseUserPrompts = 1
  await userSays($, '第一条')
  await ticks(s.clock, 10)
  expect(s.submitted.length).toBe(4)
  await userSays($, '第二条')
  expect(s.prompts.at(-1)?.context?.[0]).toContain('[c_1]')
})

test('附 context 只挂在用户自己的消息上，不挂在插件、通知等别的来源上', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], dropSubmit: true })
  await bootAwake($, s)
  await exhaustRetries(s)
  await $.prompt.submit({ text: '别的插件', wait: false, origin: { kind: 'plugin', name: 'other' } })
  await $.prompt.submit({ text: '后台任务完成', wait: false, origin: { kind: 'task-notification' } })
  expect(s.prompts.map(p => p.context)).toEqual([undefined, undefined])
  await userSays($, '好', 'sdk')
  expect(s.prompts.at(-1)?.context?.[0]).toContain('[c_1]')
})

test('附 context 的消息被拒时评论留着，等下一条', async ($, on) => {
  const o: any = { outbox: [BATCH], dropSubmit: true }
  const s = stub(on, o)
  await bootAwake($, s)
  await exhaustRetries(s)
  o.refuseUserPrompts = 1
  const r: any = await userSays($, '第一条')
  expect(r.drop).toBe('拒绝')
  await tick(s.clock)
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(0)
  await userSays($, '第二条')
  expect(s.prompts.at(-1)?.context?.[0]).toContain('[c_1]')
})

test('休眠时用户消息原样放行，不碰外部能力', async ($, on) => {
  const s = stub(on, { hasInfo: false })
  await boot($)
  await s.clock.settle()
  const calls = s.ext.calls
  await userSays($, '你好')
  expect(s.prompts.at(-1)).toMatchObject({ text: '你好', context: undefined })
  expect(s.ext.calls).toBe(calls)
})

test('服务没在跑时投递静默跳过，不去启动服务', async ($, on) => {
  const o: any = { docs: [summary('plan')] }
  const s = stub(on, o)
  await boot($)
  await s.clock.settle()
  o.alive = false
  await tick(s.clock)
  expect(s.spawned.length).toBe(0)
  expect(s.submitted.length).toBe(0)
})

test('确认送达失败时不重复发进会话，之后重试确认', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], failAcks: 1 })
  await bootAwake($, s)
  await tick(s.clock)
  await tick(s.clock)
  await tick(s.clock)
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  const acks = s.fetched.filter(f => f.path === '/api/outbox/ack')
  expect(acks.length).toBe(2)
})

test('斜杠命令注册为 cc-doc-review，避开内置的 /code-review', async ($, on) => {
  const s = stub(on)
  await boot($)
  expect(s.commands).toEqual(['cc-doc-review'])
})

test('命令注册被拒时工具和投递照常可用，只弹一条提示', async ($, on) => {
  const s = stub(on, { refuseCommand: true, outbox: [BATCH] })
  await boot($)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('/cc-doc-review')
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
})

// ── 输入框上方的评审状态带 ──

test('没有未解决评论时状态带不显示', async ($, on) => {
  const s = stub(on, { docs: [summary('plan')] })
  await boot($)
  await refresh(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('服务不在时状态带不显示，也不去启动服务', async ($, on) => {
  const o: any = { docs: [summary('plan', { sent: 1 })] }
  const s = stub(on, o)
  await boot($)
  await s.clock.settle()
  o.alive = false
  await refresh(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  expect(s.spawned.length).toBe(0)
  await ui.unmount()
})

test('状态带不独占位置：下层（别的插件或引擎）画的内容接在本插件那行下面', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 2 })] })
  await boot($)
  await refresh(s.clock)
  const ui = await band($)
  const text = allText(await ui.drawn())
  expect(text).toContain('plan.md')
  expect(text.endsWith('engine')).toBe(true)
  // 引擎节点不能放在设了 width 的 Box 下：包着下层内容的 stack、rest 都不设宽度，靠拉伸铺满
  for (const key of ['stack', 'rest']) {
    const box: any = await ui.find({ key })
    expect(box?.props.width).toBeUndefined()
    expect(box?.props.alignItems).toBe('stretch')
  }
  expect(await ui.find({ key: 'rest-card' })).toBeUndefined()
  await ui.unmount()
})

test('内层（别的插件）绘制出错时只画评审这一行，并提示一次原因', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], innerThrows: true })
  await boot($)
  await refresh(s.clock)
  const ui = await band($)
  const text = allText(await ui.drawn())
  expect(text).toContain('plan')
  expect(text).not.toContain('engine')
  expect(s.toasts.filter((t: string) => t.includes('同一位置的其他插件绘制失败')).length).toBe(1)
  await ui.unmount()
})

test('重启后服务不在、本机数据里本会话登记过文档：会话开始就启动服务并唤醒，状态带直接出现', async ($, on) => {
  const s = stub(on, {
    alive: false,
    startsAlive: true,
    newHasDocs: true,
    localDocs: [{ name: 'other.json', session: 'sess-x' }, { name: 'd1.json', session: 'sess-1' }],
    docs: [summary('plan', { sent: 1 })],
  })
  await boot($)
  await s.clock.settle()
  expect(s.spawned.some(a => a.join(' ').includes('nohup'))).toBe(true)
  await refresh(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toContain('plan')
  await ui.unmount()
})

test('重启后服务不在、本机数据里没有本会话的文档：不启动服务，保持休眠', async ($, on) => {
  const s = stub(on, { alive: false, newHasDocs: true, localDocs: [{ name: 'other.json', session: 'sess-x' }], docs: [summary('plan', { sent: 1 })] })
  await boot($)
  await s.clock.settle()
  expect(s.spawned.length).toBe(0)
  await refresh(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('会话开始时服务不在：之后每轮开始再查，服务起来且本会话有文档就唤醒，期间不去启动服务', async ($, on) => {
  const o: any = { alive: false, docs: [summary('plan', { sent: 1 })] }
  const s = stub(on, o)
  await boot($)
  await s.clock.settle()
  await refresh(s.clock)
  let ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  // 服务还没起来：这一轮查过仍然休眠
  await $.turn.start({ text: '你好', turnId: 't1' })
  await tick(s.clock)
  await refresh(s.clock)
  ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  // 服务起来了：下一轮开始时查到本会话的文档，唤醒并显示状态带
  o.alive = true
  await $.turn.start({ text: '继续', turnId: 't2' })
  await tick(s.clock)
  await refresh(s.clock)
  ui = await band($)
  expect(allText(await ui.drawn())).toContain('plan.md')
  expect(s.spawned.length).toBe(0)
  await ui.unmount()
})

test('单文档（desktop）：一行靠左，「评审」是图标加字，文件是平铺的链接（点了在外部浏览器打开），悬停卡片分标题、数据两区且不放按钮，下层有内容时中间画分隔线', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 2, drafts: 1 }), summary('other')] })
  await boot($)
  await refresh(s.clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'band' })).toMatchObject({ type: 'Box', props: { flexDirection: 'row', justifyContent: 'flex-start' } })
  // 不再给「评审」和文件套描边框
  expect(((await ui.find({ key: 'seg:head' })) as any).props.borderStyle).toBeUndefined()
  expect(((await ui.find({ key: 'seg:plan' })) as any).props.borderStyle).toBeUndefined()
  expect(await ui.find({ key: 'link:plan' })).toMatchObject({ type: 'Markdown', props: { text: `[plan](${urlOf('plan')})` } })
  expect(await ui.find({ key: 'open:plan' })).toBeUndefined()
  // 文件名左边是状态图标
  expect((await ui.findAll({ type: 'Svg' })).map((n: any) => n.props.alt)).toContain('未发送')
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find((n: any) => n.text === ' 评审')?.props.color).toBe('claude')
  // 「评审」卡片是图例：状态名和篇数；文件卡片是全名和「状态 · 目录」
  const card = allText(await ui.drawn())
  expect(card).toContain('1 个文档')
  expect(card).toContain('未发送')
  expect(card).toContain('1 篇')
  expect(card).toContain('plan.md')
  expect(card).toContain('未发送 · docs')
  expect(card).not.toContain('条评论未解决')
  // 点药丸就能打开，卡片里不再放按钮
  expect(await ui.find({ key: 'card-open:plan' })).toBeUndefined()
  // 悬停卡片：全名、目录、各状态条数
  const text = allText(await ui.drawn())
  expect(text).toContain('plan.md')
  expect(text).toContain('docs')
  expect(text).toContain('1 个文档')
  expect(await ui.find({ key: 'copy:plan' })).toBeUndefined()
  expect(await ui.find({ key: 'divider' })).toMatchObject({ type: 'Box', props: { overflow: 'hidden' } })
  // 点链接由桌面版直接打开，不经过插件，也不发消息
  expect(s.submitted.some(t => t.startsWith('请在浏览器面板打开'))).toBe(false)
  await ui.unmount()
})

test('下层只有引擎的空内容（只有评审这一块）时不画分隔线', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], engineEmpty: true })
  await boot($)
  await refresh(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toContain('plan')
  expect(await ui.find({ key: 'divider' })).toBeUndefined()
  await ui.unmount()
})

test('单文档（terminal）：一行文字，不画边框，标签是文字，多一个〔复制链接〕', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 2, drafts: 1 })] })
  await boot($)
  await refresh(s.clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = allText(await ui.drawn())
  expect(text).toContain('文档评审')
  expect(text).toContain('未发送')
  expect((await ui.find({ key: 'doc:plan' }))?.props.borderStyle).toBeUndefined()
  expect(await ui.find({ key: 'copy:plan' })).toMatchObject({ type: 'Button', props: { label: '复制链接' } })
  expect(await ui.find({ key: 'open:plan' })).toMatchObject({ type: 'Button', props: { label: '打开' } })
  await ui.unmount()
})

test('按评审状态显示：先排轮到你的（未发送、待确认、待评审）；已通过和 24 小时没动静的不显示', async ($, on) => {
  const s = stub(on, {
    docs: [
      summary('busy', { sent: 1, state: 'processing' }),
      summary('fresh', { state: 'review' }),
      summary('check', { state: 'confirm' }),
      summary('draft', { drafts: 1, state: 'draft' }),
      summary('done', { state: 'approved' }),
      summary('stale', { state: 'review', changedAt: '2026-10-09T20:00:00Z' }),
    ],
  })
  await boot($)
  await refresh(s.clock)
  const ui = await band($, { bodyColumns: 200 })
  const links = (await ui.findAll({ type: 'Markdown' })).map((n: any) => n.props.text)
  expect(links).toEqual(['draft', 'check', 'fresh', 'busy'].map(id => `[${id}](${urlOf(id)})`))
  const alts = (await ui.findAll({ type: 'Svg' })).map((n: any) => n.props.alt)
  for (const label of ['未发送', '待确认', '待评审', 'Claude 处理中']) expect(alts).toContain(label)
  const text = allText(await ui.drawn())
  expect(text).toContain('4 个文档')
  expect(text).not.toContain('done')
  expect(text).not.toContain('stale')
  await ui.unmount()
})

test('只有待评审的文档时状态带也出现；全部通过后自动隐藏', async ($, on) => {
  const s = stub(on, { docs: [summary('fresh', { state: 'review' })] })
  await boot($)
  await refresh(s.clock)
  const ui = await band($)
  expect(await ui.find({ key: 'link:fresh' })).toBeDefined()
  s.server.docs = [summary('fresh', { state: 'approved' })]
  await refresh(s.clock)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('有调查问卷时状态带让位', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })] })
  await boot($)
  await refresh(s.clock)
  const ui = await band($, { hasSurvey: true })
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('数据变化时状态带跟着重画', async ($, on) => {
  const s = stub(on, { docs: [] })
  await bootAwake($, s)
  await refresh(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  s.server.docs = [summary('plan', { drafts: 2 })]
  await refresh(s.clock)
  expect(allText(await ui.drawn())).toContain('plan.md')
  expect(allText(await ui.drawn())).toContain('未发送')
  await ui.unmount()
})

test('〔打开评审页〕取当前链接并请 Claude 在浏览器面板打开', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })] })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  await ui.press({ key: 'open:plan' })
  // 点文件不重新登记（登记会刷新登记时间，把待确认、已通过的文档误判回待评审）
  expect(s.fetched.some(f => f.path === '/api/open')).toBe(false)
  expect(s.submitted.at(-1)).toBe(`请在浏览器面板打开文档评审页：${urlOf('plan')}`)
  await ui.unmount()
})

test('有浏览器面板工具：点〔打开〕直接在面板里打开，不发消息、不用等 Claude', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], browserTool: true })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  const before = s.submitted.length
  await ui.press({ key: 'open:plan' })
  await ui.press({ key: 'open:plan' })
  expect(s.panelOpened).toEqual([urlOf('plan'), urlOf('plan')])
  expect(s.submitted.length).toBe(before)
  // 面板打开成功时不弹提示（面板本身就是反馈）
  expect(s.toasts.some((t: string) => t.includes('系统浏览器') || t.includes('没能直接打开'))).toBe(false)
  await ui.unmount()
})

test('没有浏览器面板工具时用系统浏览器打开并提示', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], systemOpen: true })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  const before = s.submitted.length
  await ui.press({ key: 'open:plan' })
  expect(s.spawned.some(a => a[0] === 'open' && a[1] === urlOf('plan'))).toBe(true)
  expect(s.toasts).toContain('已在系统浏览器打开评审页')
  expect(s.submitted.length).toBe(before)
  await ui.unmount()
})

test('内置浏览器被权限拦下（自动模式）：立刻用系统浏览器打开并说明原因，不发消息给 Claude', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], browserTool: true, panelDenied: true, systemOpen: true })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  const before = s.submitted.length
  await ui.press({ key: 'open:plan' })
  expect(s.panelOpened).toEqual([urlOf('plan')])
  expect(s.spawned.some(a => a[0] === 'open' && a[1] === urlOf('plan'))).toBe(true)
  expect(s.toasts).toContain('内置浏览器被权限拦下，已在系统浏览器打开评审页')
  expect(s.submitted.length).toBe(before)
  await ui.unmount()
})

test('面板收着看不见时也改用系统浏览器', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], browserTool: true, systemOpen: true, panelHidden: true })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  await ui.press({ key: 'open:plan' })
  expect(s.spawned.some(a => a[0] === 'open')).toBe(true)
  expect(s.toasts).toContain('内置浏览器面板是收起的，已在系统浏览器打开评审页')
  await ui.unmount()
})

test('内置浏览器打不开、系统浏览器也打不开：退回请 Claude 打开并说明原因', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], browserTool: true, panelFails: true })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  await ui.press({ key: 'open:plan' })
  expect(s.toasts.some((t: string) => t.includes('系统浏览器也打不开，已请 Claude 打开'))).toBe(true)
  expect(s.submitted.at(-1)).toBe(`请在浏览器面板打开文档评审页：${urlOf('plan')}`)
  await ui.unmount()
})

test('/cc-doc-review 登记后直接在浏览器面板打开，不再发消息请 Claude 打开', async ($, on) => {
  const s = stub(on, { browserTool: true })
  await boot($)
  const before = s.submitted.length
  const r: any = await $.command.run({ command: 'cc-doc-review', args: 'docs/plan.md' } as any)
  expect(String(r.text)).toContain('已在浏览器面板打开')
  expect(s.panelOpened).toEqual([URL_D1])
  expect(s.submitted.length).toBe(before)
})

test('〔打开评审页〕连点只发一次请求，每次点击都有提示；10 秒后可以再发', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })] })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  await ui.press({ key: 'open:plan' })
  await ui.press({ key: 'open:plan' })
  await ui.press({ key: 'open:plan' })
  const asked = () => s.submitted.filter(t => t.startsWith('请在浏览器面板打开文档评审页')).length
  expect(asked()).toBe(1)
  expect(s.toasts.filter(t => t.includes('已请求 Claude 在浏览器面板打开评审页')).length).toBe(1)
  expect(s.toasts.filter(t => t.includes('已经请求过打开这个评审页')).length).toBe(2)
  await s.clock.advance(10_000)
  await ui.press({ key: 'open:plan' })
  expect(asked()).toBe(2)
  await ui.unmount()
})

test('〔复制链接〕复制到按下的那个界面的剪贴板', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })] })
  await boot($)
  await refresh(s.clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'copy:plan' })
  expect(s.copied.at(-1)).toMatchObject({ text: urlOf('plan'), surface: 'terminal' })
  expect(s.toasts).toContain('评审链接已复制')
  expect(s.filled.length).toBe(0)
  await ui.unmount()
})

test('复制失败时提示原因，并把链接填进输入框', async ($, on) => {
  const s = stub(on, { docs: [summary('plan', { sent: 1 })], copy: { isCopied: false, reason: 'no-clipboard' } })
  await boot($)
  await refresh(s.clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'copy:plan' })
  expect(s.filled).toEqual([urlOf('plan')])
  expect(s.toasts.at(-1)).toContain('复制失败')
  expect(s.toasts.at(-1)).toContain('剪贴板')
  await ui.unmount()
})

test('多文档（terminal）：逐个列出有未解决评论的文档，〔打开〕打开对应文档', async ($, on) => {
  const s = stub(on, {
    docs: [summary('a', { sent: 1 }), summary('b', { drafts: 2, sent: 1 }), summary('c')],
  })
  await boot($)
  await refresh(s.clock)
  const ui = await terminalBand($)
  const text = allText(await ui.drawn())
  expect(text).toContain('2 个文档')
  expect(text).toContain('a.md')
  expect(text).toContain('b.md')
  expect(text).not.toContain('c.md')
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  await ui.press({ key: 'open:b' })
  expect(s.submitted.at(-1) ?? '').toContain('doc=b&')
  expect(s.submitted.at(-1)).toContain('请在浏览器面板打开文档评审页：')
  await ui.unmount()
})

test('文件多（desktop）：按状态带宽度放得下几个就放几个，其余收进「+N」，悬停卡片里逐个列出并可打开', async ($, on) => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const s = stub(on, { docs: ids.map(id => summary(id, { sent: 1 })) })
  await boot($)
  await refresh(s.clock)
  // 窄：只放得下前两个
  const narrow = await band($, { bodyColumns: 23 })
  expect(await narrow.find({ key: 'seg:b' })).toBeDefined()
  expect(await narrow.find({ key: 'seg:c' })).toBeUndefined()
  expect((await narrow.findAll({ type: 'Text' })).some((n: any) => n.text === '+4')).toBe(true)
  // 收起的文件在悬停卡片里也是同样的链接
  expect(await narrow.find({ key: 'link:f' })).toMatchObject({ type: 'Markdown', props: { text: `[f](${urlOf('f')})` } })
  expect(await narrow.find({ key: 'toggle' })).toBeUndefined()
  await narrow.unmount()
  // 宽：全部放下，没有「+N」
  const wide = await band($, { bodyColumns: 200 })
  for (const id of ids) expect(await wide.find({ key: `seg:${id}` })).toBeDefined()
  expect(await wide.find({ key: 'seg:more' })).toBeUndefined()
  await wide.unmount()
})

test('文档超过 3 个（terminal）：只列前 3 个和「还有 N 个文档」，〔展开〕列出全部，〔收起〕还原', async ($, on) => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const s = stub(on, { docs: ids.map(id => summary(id, { sent: 1 })) })
  await boot($)
  await refresh(s.clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  let text = allText(await ui.drawn())
  expect(text).toContain('c.md')
  expect(text).not.toContain('d.md')
  expect(text).toContain('还有 3 个文档')
  await ui.press({ key: 'toggle' })
  text = allText(await ui.drawn())
  expect(text).toContain('f.md')
  expect(text).toContain('共 6 个文档')
  await ui.press({ key: 'toggle' })
  expect(allText(await ui.drawn())).not.toContain('f.md')
  await ui.unmount()
})

// ── 一轮结束时检查漏回复的评论 ──

const DETAIL = (status: string) => ({ id: 'd1', comments: [{ id: 'c_1', status }] })
const hasReminder = async (ui: any) => allText(await ui.drawn()).includes('⚠')

test('一轮结束还有评论没回复：自动提醒 Claude 一次并弹提示，状态带变提醒但没有〔提醒 Claude〕按钮', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  const before = s.submitted.length
  await turnDone($, s.clock)
  expect(s.submitted.length).toBe(before + 1)
  expect(s.submitted.at(-1)).toContain('c_1')
  expect(s.submitted.at(-1)).toContain('review_resolve')
  expect(s.toasts).toContain('还有 1 条评论没回复处理结果，已提醒 Claude')
  const ui = await band($)
  expect(allText(await ui.drawn())).toContain('⚠ 还有 1 条评论没回复处理结果')
  expect(await ui.find({ key: 'remind' })).toBeUndefined()
  expect(await ui.find({ key: 'dismiss' })).toMatchObject({ type: 'Button' })
  await ui.unmount()
})

test('自动提醒每批评论最多一次：提醒那一轮结束后仍没回复，不再提醒', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const after = s.submitted.length
  // 提醒的那一轮开始、结束，评论还是没回复
  await $.turn.start({ text: s.submitted.at(-1), turnId: 't2' })
  await turnDone($, s.clock)
  await turnDone($, s.clock)
  expect(s.submitted.length).toBe(after)
  expect(s.toasts.filter((t: string) => t.includes('已提醒 Claude')).length).toBe(1)
})

test('新一批评论进入模型后，没回复时再提醒一次，名单含之前没回复的', async ($, on) => {
  const second = { ...BATCH, batch: 'b_20261011_100600_cd34', comments: [{ id: 'c_2', quote: 'x', body: 'y' }] }
  const s = stub(on, {
    outbox: [BATCH],
    details: { d1: { id: 'd1', comments: [{ id: 'c_1', status: 'sent' }, { id: 'c_2', status: 'sent' }] } },
  })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  s.server.outbox = [second]
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  expect(s.submitted.at(-1)).toContain('c_1')
  expect(s.submitted.at(-1)).toContain('c_2')
  expect(s.toasts).toContain('还有 2 条评论没回复处理结果，已提醒 Claude')
  expect(s.toasts.filter((t: string) => t.includes('已提醒 Claude')).length).toBe(2)
})

test('自动提醒发不出去时只弹提示，不重试、不填输入框', async ($, on) => {
  const o: any = { outbox: [BATCH], details: { d1: DETAIL('sent') } }
  const s = stub(on, o)
  await bootAwake($, s)
  await deliverAndStart($, s)
  // 之后本插件发的都被拒
  o.dropSubmit = true
  const before = s.submitted.length
  await turnDone($, s.clock)
  await turnDone($, s.clock)
  await ticks(s.clock, 120)
  expect(s.submitted.length).toBe(before + 1)
  expect(s.filled).toEqual([])
  expect(s.toasts.at(-1)).toContain('还有 1 条评论没回复处理结果')
  expect(s.toasts.at(-1)).toContain('没能提醒')
})

test('都回复了就不提醒', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('resolved') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(false)
  await ui.unmount()
})

test('评论还没进入模型（排队中，前一轮先结束）时不提醒，进入后那一轮结束才提醒', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await tick(s.clock)
  // 前一轮结束：这批评论的消息还没开始一轮
  await turnDone($, s.clock)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(false)
  await $.turn.start({ text: s.submitted.at(-1), turnId: 't2' })
  await turnDone($, s.clock)
  expect(await hasReminder(ui)).toBe(true)
  await ui.unmount()
})

test('发不进会话（等重试）时不提醒，也不填输入框', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], dropSubmit: true, details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await tick(s.clock)
  await turnDone($, s.clock)
  expect(s.submitted.length).toBe(1)
  expect(s.filled).toEqual([])
  expect(s.toasts.some((t: string) => t.includes('已提醒 Claude'))).toBe(false)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(false)
  await ui.unmount()
})

test('被中断或出错的一轮不提醒', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock, { isAborted: true, reason: 'aborted' })
  await turnDone($, s.clock, { reason: 'error' })
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(false)
  await ui.unmount()
})

test('点〔×〕后不再提醒，直到下一批评论进入模型', async ($, on) => {
  const second = { ...BATCH, batch: 'b_20261011_100600_cd34', comments: [{ id: 'c_2', quote: 'x', body: 'y' }] }
  const s = stub(on, {
    outbox: [BATCH],
    details: { d1: { id: 'd1', comments: [{ id: 'c_1', status: 'sent' }, { id: 'c_2', status: 'sent' }] } },
  })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const ui = await band($)
  await ui.press({ key: 'dismiss' })
  expect(await hasReminder(ui)).toBe(false)
  await turnDone($, s.clock)
  expect(await hasReminder(ui)).toBe(false)
  // 下一批送达并进入模型后，那一轮结束重新提醒
  s.server.outbox = [second]
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  expect(allText(await ui.drawn())).toContain('⚠ 还有 2 条评论没回复处理结果')
  await ui.unmount()
})

test('提醒的评论全部解决后自动退出提醒', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(true)
  s.server.details.d1 = DETAIL('resolved')
  await refresh(s.clock)
  expect(await hasReminder(ui)).toBe(false)
  await ui.unmount()
})

test('文档已不存在（404）的评论不再跟踪，提醒随之消失', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(true)
  delete s.server.details.d1
  await refresh(s.clock)
  expect(await hasReminder(ui)).toBe(false)
  // 已从跟踪里移除：文档回来了也不再提醒、不再去查
  s.server.details.d1 = DETAIL('sent')
  const before = s.fetched.filter(f => f.path.startsWith('/api/doc?')).length
  await turnDone($, s.clock)
  expect(await hasReminder(ui)).toBe(false)
  expect(s.fetched.filter(f => f.path.startsWith('/api/doc?')).length).toBe(before)
  await ui.unmount()
})

test('服务暂时不可达时保留提醒，不清空', async ($, on) => {
  const o: any = { outbox: [BATCH], details: { d1: DETAIL('sent') } }
  const s = stub(on, o)
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(true)
  o.alive = false
  await turnDone($, s.clock)
  await refresh(s.clock)
  expect(await hasReminder(ui)).toBe(true)
  o.alive = true
  s.server.details.d1 = DETAIL('resolved')
  await refresh(s.clock)
  expect(await hasReminder(ui)).toBe(false)
  await ui.unmount()
})

test('子代理的一轮结束不触发检查', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await bootAwake($, s)
  await deliverAndStart($, s)
  await turnDone($, s.clock, { agentId: 'agent-1' })
  expect(s.fetched.some(f => f.path.startsWith('/api/doc?'))).toBe(false)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(false)
  await ui.unmount()
})

// ── 按文件夹自动登记 ──

const opened = (s: any) => s.fetched.filter((f: any) => f.path === '/api/open').map((f: any) => f.body.path)

/** 写文件；登记在后台跑，settle 一下让它跑完。*/
async function write($: any, s: any, file_path: string, tool = 'Write') {
  const input: any =
    tool === 'Write' ? { tool, file_path, content: 'x' } : { tool, file_path, old_string: 'a', new_string: 'b' }
  const r: any = await $.tool.call(input)
  await s.clock.settle()
  return r
}

test('写进 docs / specs / plans 目录的文档自动登记评审，同一文件只登记一次', async ($, on) => {
  const s = stub(on)
  await boot($)
  const r = await write($, s, '/proj/docs/specs/design.md')
  expect(r.result).toBe('wrote /proj/docs/specs/design.md')
  await write($, s, '/proj/docs/specs/design.md', 'Edit')
  await write($, s, '/proj/plans/rollout.html', 'Edit')
  expect(opened(s)).toEqual(['/proj/docs/specs/design.md', '/proj/plans/rollout.html'])
  expect(s.toasts).toEqual(['已登记评审：design.md', '已登记评审：rollout.html'])
})

test('同一文件并发写两次只登记一次', async ($, on) => {
  const s = stub(on)
  await boot($)
  await Promise.all([
    $.tool.call({ tool: 'Write', file_path: '/proj/docs/a.md', content: 'x' }),
    $.tool.call({ tool: 'Edit', file_path: '/proj/docs/a.md', old_string: 'x', new_string: 'y' }),
  ])
  await s.clock.settle()
  expect(opened(s)).toEqual(['/proj/docs/a.md'])
})

test('不在评审目录、被排除、在工作目录外的文件不登记', async ($, on) => {
  const s = stub(on)
  await boot($)
  for (const file_path of [
    '/proj/src/notes.md',
    '/proj/docs/README.md',
    '/proj/docs/CLAUDE.md',
    '/proj/.superpowers/docs/x.md',
    '/proj/node_modules/p/docs/x.md',
    '/proj/vendor/docs/x.md',
    '/proj/docs/x.txt',
    '/elsewhere/docs/x.md',
  ]) {
    await write($, s, file_path)
  }
  expect(opened(s)).toEqual([])
})

test('配置的包含 / 排除模式覆盖默认值', { options: { includePatterns: '**/notes/**/*.md,**/*.rst', excludePatterns: '**/private/**' } }, async ($, on) => {
  const s = stub(on)
  await boot($)
  for (const file_path of [
    '/proj/notes/a.md',
    '/proj/x/notes/b/c.md',
    '/proj/docs/guide.rst',
    '/proj/docs/d.md', // 默认的 docs 规则被覆盖掉了
    '/proj/notes/private/e.md', // 排除优先
    '/proj/README.rst', // 默认排除也被覆盖：README 不再特殊
  ]) {
    await write($, s, file_path)
  }
  expect(opened(s)).toEqual(['/proj/notes/a.md', '/proj/x/notes/b/c.md', '/proj/docs/guide.rst', '/proj/README.rst'])
})

test('autoRegister 关掉后写文档不登记', { options: { autoRegister: false } }, async ($, on) => {
  const s = stub(on)
  await boot($)
  await write($, s, '/proj/docs/a.md')
  await write($, s, '/proj/specs/b.html', 'Edit')
  expect(opened(s)).toEqual([])
  expect(s.toasts).toEqual([])
})

// 引擎在 test 里按 plugin.json 的 userConfig 默认值填 options；测试读不到 plugin.json 本身，
// 所以用行为核对：清单默认值下的登记结果必须和 src/autoreg.js 的默认值一致。
test('plugin.json 的 userConfig 默认值与 src/autoreg.js 的默认值行为一致', async ($, on) => {
  const s = stub(on)
  await boot($)
  const probes = [
    '/proj/specs/a.md',
    '/proj/specs/a.html',
    '/proj/specs/a.markdown',
    '/proj/plans/b.md',
    '/proj/plans/b.htm',
    '/proj/docs/c.markdown',
    '/proj/docs/c.htm',
    '/proj/docs/c.txt',
    '/proj/x/y/docs/z/d.html',
    '/proj/src/e.md',
    '/proj/.superpowers/docs/f.md',
    '/proj/node_modules/docs/f.md',
    '/proj/vendor/docs/f.md',
    '/proj/dist/docs/f.md',
    '/proj/.git/docs/f.md',
    '/proj/.claude/docs/f.md',
    '/proj/docs/README.md',
    '/proj/docs/CHANGELOG.md',
    '/proj/docs/CLAUDE.md',
    '/proj/Docs/UPPER.MD',
  ]
  const expected = probes.filter(p => isReviewDoc(p, '/proj', autoRegisterConfig({})))
  expect(expected.length).toBeGreaterThan(5)
  expect(expected.length).toBeLessThan(probes.length)
  for (const file_path of probes) await write($, s, file_path)
  expect(opened(s)).toEqual(expected)
})

test('写入出错时不登记', async ($, on) => {
  const s = stub(on, { writeErrors: true })
  await boot($)
  await write($, s, '/proj/docs/x.md')
  expect(opened(s)).toEqual([])
})

// 子代理的写入（e.agentId）由 isMainLoopSuccess 排除，见 tests/autoreg.test.ts：
// 测试里的 $.tool.call 按约定会丢掉 agentId，没法从这里造出子代理的调用。

test('自动登记失败只提示一次、不影响工具结果，并退避一分钟', async ($, on) => {
  const o: any = { openFails: true }
  const s = stub(on, o)
  await boot($)
  const r = await write($, s, '/proj/docs/a.md')
  await write($, s, '/proj/docs/b.md')
  expect(r.result).toBe('wrote /proj/docs/a.md')
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('自动登记评审失败')
  // 退避期内不再尝试
  expect(opened(s)).toEqual(['/proj/docs/a.md'])
  o.openFails = false
  await s.clock.advance(61_000)
  await write($, s, '/proj/docs/a.md')
  expect(opened(s)).toEqual(['/proj/docs/a.md', '/proj/docs/a.md'])
  expect(s.toasts.at(-1)).toBe('已登记评审：a.md')
})

// ── 休眠模式：会话开始时休眠，用到评审才唤醒 ──

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: [],
  tools: [],
  outputStyle: null,
  traits: [],
}
const isOutbox = (f: any) => f.path.startsWith('/api/outbox?')
/** 唤醒的标志：投递定时器在跑（每秒查一次 outbox）。*/
async function isAwake(s: any) {
  const before = s.fetched.filter(isOutbox).length
  await tick(s.clock)
  return s.fetched.filter(isOutbox).length > before
}

test('休眠：服务没在跑时零 HTTP、零进程，定时器空转，状态带让位，一轮结束直接放行', async ($, on) => {
  const s = stub(on, { hasInfo: false, outbox: [BATCH], details: { d1: DETAIL('sent') } })
  await boot($)
  await s.clock.settle()
  // 会话开始那次检查之后：定时器 tick、一轮开始与结束、画状态带都不碰任何外部能力
  const calls = s.ext.calls
  await s.clock.advance(60_000)
  await $.turn.start({ text: '你好', turnId: 't1' })
  await turnDone($, s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  expect(s.ext.calls).toBe(calls)
  // 没命中的写入：只做路径匹配，不联网、不提示
  await write($, s, '/proj/src/a.ts')
  expect(s.fetched).toEqual([])
  expect(s.spawned).toEqual([])
  expect(s.submitted).toEqual([])
  expect(s.toasts).toEqual([])
})

test('休眠：服务在跑但本会话没有文档时，只在会话开始查一次', async ($, on) => {
  const s = stub(on, { outbox: [BATCH] })
  await boot($)
  await s.clock.settle()
  expect(s.fetched.map(f => f.path)).toEqual(['/api/health', '/api/docs?session=sess-1'])
  const calls = s.ext.calls
  await s.clock.advance(60_000)
  await turnDone($, s.clock)
  expect(s.fetched.length).toBe(2)
  expect(s.submitted).toEqual([])
  expect(s.ext.calls).toBe(calls)
})

test('系统提示不加评审规则（休眠和唤醒后都不加），规则写在 review_open 的说明里', async ($, on) => {
  const s = stub(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  await boot($)
  const dormant: any = await $.prompt.compose(COMPOSE)
  expect(dormant.sections.map((x: any) => x.id)).toEqual(['intro'])
  await wake($, s)
  const awake: any = await $.prompt.compose(COMPOSE)
  expect(awake.sections.map((x: any) => x.id)).toEqual(['intro'])
  const desc = String(s.tools.review_open?.description)
  expect(desc).toContain('浏览器面板')
  expect(desc).toContain('子代理不要调用')
  expect(desc).toContain('[文档评审]')
  expect(desc).toContain('mcp__cc-doc-review__review_resolve')
  expect(desc).toContain('README')
})

test('唤醒：调用 review_open', async ($, on) => {
  const s = stub(on)
  await boot($)
  expect(await isAwake(s)).toBe(false)
  await $.tool.call({ tool: 'mcp__cc-doc-review__review_open', path: 'docs/plan.md' })
  expect(await isAwake(s)).toBe(true)
})

test('唤醒：调用 review_resolve（即使失败）', async ($, on) => {
  const s = stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__review_resolve', items: [{ id: 'c_gone1', note: 'x' }] })
  expect(String(ran.deny)).toContain('c_gone1')
  expect(await isAwake(s)).toBe(true)
})

test('唤醒：使用 /cc-doc-review 命令', async ($, on) => {
  const s = stub(on)
  await boot($)
  const ran: any = await $.command.run({ command: 'cc-doc-review', args: 'docs/plan.md' } as any)
  expect(String(ran.text)).toContain('已登记')
  expect(await isAwake(s)).toBe(true)
})

test('唤醒：只带空参数的命令也唤醒（用户用了评审）', async ($, on) => {
  const s = stub(on)
  await boot($)
  await $.command.run({ command: 'cc-doc-review', args: '' } as any)
  expect(await isAwake(s)).toBe(true)
})

test('唤醒：自动登记命中；没命中的写入不唤醒', async ($, on) => {
  const s = stub(on)
  await boot($)
  await write($, s, '/proj/src/a.md')
  expect(await isAwake(s)).toBe(false)
  await write($, s, '/proj/docs/a.md')
  expect(await isAwake(s)).toBe(true)
})

test('唤醒：会话开始时服务在跑且本会话已登记过文档', async ($, on) => {
  const s = stub(on, { docs: [summary('plan')] })
  await boot($)
  await s.clock.settle()
  expect(await isAwake(s)).toBe(true)
})

test('会话开始时服务没在跑：不启动服务、不唤醒', async ($, on) => {
  const s = stub(on, { alive: false, docs: [summary('plan')] })
  await boot($)
  await s.clock.settle()
  const calls = s.ext.calls
  await s.clock.advance(10_000)
  expect(s.spawned).toEqual([])
  expect(s.fetched.map(f => f.path)).toEqual(['/api/health'])
  expect(s.ext.calls).toBe(calls)
})

test('唤醒后投递正常：休眠时不投递，唤醒后发进会话并确认送达', async ($, on) => {
  const s = stub(on, { outbox: [BATCH] })
  await boot($)
  await tick(s.clock)
  await tick(s.clock)
  expect(s.submitted).toEqual([])
  await wake($, s)
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toContain('[文档评审]')
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
})

test('唤醒后下一秒就取状态，不等 2 秒的刷新周期', async ($, on) => {
  const s = stub(on, { docs: [] })
  await boot($)
  await s.clock.advance(1500) // 错开刷新周期：下一次 2 秒刷新在 0.5 秒后的再下一秒
  s.server.docs = [summary('plan', { sent: 1 })]
  await wake($, s)
  await tick(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toContain('plan.md')
  await ui.unmount()
})

test('/clear 后复位为休眠：定时器空转、状态带让位、提醒清空，再用到评审时用同一组定时器重新唤醒', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], details: { d1: DETAIL('sent') }, docs: [summary('plan', { sent: 1 })] })
  await boot($)
  await s.clock.settle()
  await deliverAndStart($, s)
  await turnDone($, s.clock)
  const ui = await band($)
  expect(await hasReminder(ui)).toBe(true)
  await endSession($, s)
  s.server.session = 'sess-2'
  const calls = s.ext.calls
  await s.clock.advance(30_000)
  await turnDone($, s.clock)
  expect(s.ext.calls).toBe(calls)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  // 新会话里再用到评审：重新唤醒，按新会话 ID 投递
  await wake($, s)
  await tick(s.clock)
  expect(s.fetched.some(f => f.path === '/api/outbox?session=sess-2')).toBe(true)
})

test('会话结束（退出）：复位为休眠，之后没有任何外部调用，再次唤醒仍可投递', async ($, on) => {
  const s = stub(on)
  await bootAwake($, s)
  await endSession($, s, 'prompt_input_exit')
  expect(await isAwake(s)).toBe(false)
  const calls = s.ext.calls
  await s.clock.advance(30_000)
  expect(s.ext.calls).toBe(calls)
  // 再次唤醒后恢复投递
  s.server.outbox = [BATCH]
  await wake($, s)
  await tick(s.clock)
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
})

test('会话开始的检查在 /clear 之后才返回时不唤醒新会话', async ($, on) => {
  // 让 /api/docs 晚一点应答：检查还没回来，会话就被 /clear 了
  let release: () => void = () => {}
  const docsGate = new Promise<void>(r => (release = r))
  const s = stub(on, { docs: [summary('plan')], docsGate })
  await boot($)
  await s.clock.settle()
  await endSession($, s)
  release()
  await s.clock.settle()
  expect(await isAwake(s)).toBe(false)
})

test('/resume 换到另一个会话后，下一轮开始时查一次那个会话的文档', async ($, on) => {
  const s = stub(on)
  await bootAwake($, s)
  await endSession($, s, 'resume')
  expect(await isAwake(s)).toBe(false)
  s.server.session = 'sess-old'
  s.server.docs = [summary('plan')]
  await $.turn.start({ text: '继续', turnId: 't9' })
  // 检查在会话开始时启动的定时器里做：下一次 tick
  await tick(s.clock)
  expect(s.fetched.at(-1)?.path).toBe('/api/docs?session=sess-old')
  expect(await isAwake(s)).toBe(true)
})

test('并发之外的两次准备使用不同的临时文件名', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true })
  await boot($)
  await openOnce($, s)
  await s.clock.advance(61_000)
  await openOnce($, s)
  const parts = argvOf(s, 'curl')
    .map((a: string[]) => a.at(-2) as string)
    .filter((f: string) => f.includes('.part-'))
  expect(parts.length).toBe(2)
  expect(parts[0]).not.toBe(parts[1])
})

test('本地编译用本次独有的临时文件，失败时清理', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true, goShell: '/bin/zsh', buildFails: true })
  await boot($)
  await openOnce($, s)
  const build = s.spawned.find(isBuild) as string[]
  expect(build[5]).toMatch(/\.build-[0-9a-z-]+$/)
  expect(build[5]).not.toBe(build[6])
  expect(argvOf(s, 'rm').at(-1)).toEqual(['rm', '-f', build[5]])
})

test('失败后的退避从失败那一刻算起，不是从开始下载算起', async ($, on) => {
  const s = stub(on, { ...FRESH, curlFails: true, slowCurlMs: 50_000 })
  await boot($)
  await openOnce($, s)
  const first = argvOf(s, 'uname').length
  // 失败发生在开始后 50 秒；再过 10 秒还在退避期内
  await s.clock.advance(10_000)
  const again: any = await openOnce($, s)
  expect(argvOf(s, 'uname').length).toBe(first)
  expect(String(again.deny)).toContain('404')
})

test('新版程序准备失败：退避结束后会重试，但「继续使用旧版」的提示同一版本只出一次', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.1.0', curlFails: true })
  await boot($)
  await openOnce($, s)
  await s.clock.advance(61_000)
  await openOnce($, s)
  expect(argvOf(s, 'uname').length).toBe(2)
  expect(s.toasts.filter((t: string) => t.includes('继续使用')).length).toBe(1)
})

test('旧进程没能结束后，退避期内不再重试结束', async ($, on) => {
  const s = stub(on, { hasBinary: false, hasVersioned: true, serverVersion: '0.1.0', killFails: true })
  await boot($)
  await openOnce($, s)
  await openOnce($, s)
  expect(s.spawned.filter(isKill).length).toBe(1)
})

test('提示文字：首次使用与插件更新不同，不支持的平台和 uname 失败不提示下载', async ($, on) => {
  const first = stub(on, { ...FRESH, startsAlive: true })
  await boot($)
  await openOnce($, first)
  expect(first.toasts).toContain('文档评审：首次使用，正在下载评审服务')
  expect(first.toasts.some((t: string) => t.includes('插件已更新'))).toBe(false)
})

test('插件更新后换新版：提示正在准备新版，不说首次使用', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.1.0', startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(s.toasts).toContain('文档评审：插件已更新，正在准备新版评审服务')
  expect(s.toasts.some((t: string) => t.includes('首次使用'))).toBe(false)
})

test('不支持的平台不提示下载', async ($, on) => {
  const s = stub(on, { ...FRESH, uname: 'FreeBSD amd64\n', goShell: '/bin/zsh', startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(s.toasts.some((t: string) => t.includes('下载评审服务'))).toBe(false)
  expect(s.toasts.some((t: string) => t.includes('本地编译'))).toBe(true)
})

test('uname 执行失败：报告真实原因而不是「不支持的平台」', async ($, on) => {
  const s = stub(on, { ...FRESH, unameFails: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('uname')
  expect(String(ran.deny)).toContain('找不到命令')
  expect(String(ran.deny)).not.toContain('不支持的平台')
  expect(argvOf(s, 'curl').length).toBe(0)
  expect(s.toasts.some((t: string) => t.includes('下载评审服务'))).toBe(false)
})

test('用版本化程序启动失败：删掉这个程序，下次重新获取', async ($, on) => {
  const s = stub(on, { alive: false, hasBinary: false, hasVersioned: true })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('启动失败')
  expect(argvOf(s, 'rm').at(-1)).toEqual(['rm', '-f', VERSIONED])
})

test('开发模式启动失败：不删程序', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  const ran = await openOnce($, s)
  expect(String(ran.deny)).toContain('启动失败')
  expect(argvOf(s, 'rm').length).toBe(0)
})
