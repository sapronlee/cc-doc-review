import { expect, mock, test } from 'claude-code/testing'

import { autoRegisterConfig, isReviewDoc } from '../src/autoreg.js'
import { parseReply } from '../src/client.js'
import { withReplies } from '../src/reply.js'
import { BROWSER_HINT } from '../src/rules.js'

const INFO = { port: 4823, token: 'tok', pid: 5150 }
const LEGACY_INFO = { port: 4901, token: 'old', pid: 4242 }
const PROC = { isStdoutTruncated: false, isStderrTruncated: false }
const HASH = 'a'.repeat(64)
const ASSET = 'cc-doc-review-server-darwin-arm64'
const VERSIONED = '/home/x/.claude/cc-doc-review/bin/cc-doc-review-server-0.2.0'

/** 把 mod 用到的引擎能力都答上；o 控制服务状态和回复内容。*/
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
  const spawned: string[][] = []
  const timeouts: { argv: string[]; timeoutMs?: number }[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const copied: any[] = []
  const tools: Record<string, any> = {}
  // 唤醒检查和 review_status 用：本会话文档概况、各文档详情，测试中途可以改
  const server: any = {
    docs: o.docs ?? [],
    details: o.details ?? {},
    // 待发送的回复（GET /api/replies 的 groups），测试中途可以改
    replies: o.replies ?? [],
    session: 'sess-1',
    alive: true,
    version: o.serverVersion,
  }

  on('env.get', counted(() => ({ value: '/home/x' })))
  // Claude Code 的设置：language 默认简体中文，o.language 可改
  on('config.list', () => ({ value: [{ key: 'language', label: 'Language', kind: 'text', value: o.language ?? '简体中文', provider: { kind: 'engine' }, isLocked: false }] }))
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
      if (o.openBody !== undefined) return { value: { status: 502, ok: false, headers: {}, text: o.openBody } }
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
    if (url.pathname === '/api/replies' && method === 'GET') {
      if (o.repliesGate) await o.repliesGate
      if (o.repliesFail) return reply(500, { error: '服务忙' })
      return reply(200, { groups: server.replies, total: server.replies.reduce((n: number, g: any) => n + g.replies.length, 0) })
    }
    if (url.pathname === '/api/replies' && method === 'DELETE') {
      const n = server.replies.reduce((n: number, g: any) => n + g.replies.length, 0)
      server.replies = []
      return reply(200, { deleted: n })
    }
    if (url.pathname === '/api/replies/sent') {
      const ids = new Set(body.ids)
      server.replies = server.replies.map((g: any) => ({ ...g, replies: g.replies.filter((r: any) => !ids.has(r.id)) })).filter((g: any) => g.replies.length > 0)
      return reply(200, { sent: ids.size })
    }
    if (url.pathname === '/api/comments' && method === 'DELETE') {
      if (o.deleteFails) return reply(500, { error: '磁盘满了' })
      const id = url.searchParams.get('id')
      server.replies = server.replies.map((g: any) => ({ ...g, replies: g.replies.filter((r: any) => r.id !== id) })).filter((g: any) => g.replies.length > 0)
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
      // pluginGate：让插件自己发的消息停在半路（Claude 忙时排队）
      if (o.pluginGate) await o.pluginGate
      submitted.push(e.text)
      ownSubmits += 1
      const isDropped = typeof o.dropSubmit === 'number' ? ownSubmits <= o.dropSubmit : o.dropSubmit === true
      return isDropped ? { drop: '会话不接受' } : { text: e.text }
    }
    if (o.refuseUserPrompts > 0) {
      o.refuseUserPrompts -= 1
      return { drop: '拒绝' }
    }
    prompts.push({ text: e.text, origin: e.origin, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('ui.copy', ($: any, e: any) => {
    copied.push(e)
    return { value: o.copy ?? { isCopied: true } }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  // 写文件工具的应答
  on('tool.call', ($: any, e: any) => (o.writeErrors ? { isError: true, result: undefined, text: '写入失败' } : { result: `wrote ${e.file_path}` }))
  // 回复区让位时画引擎自己的；o.innerThrows 让下层出错
  on('ui.render', () => {
    if (o.innerThrows) throw new Error('用量带坏了')
    return { type: 'Text', props: {}, children: ['engine'] }
  })
  return { clock, fetched, submitted, prompts, spawned, timeouts, commands, toasts, copied, server, tools, ext }
}

const URL_D1 = 'http://127.0.0.1:4823/review?doc=d1&t=tok'

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
})

/** 一轮结束；settle 一下让后台的事跑完。*/
async function turnDone($: any, clock: any, extra: any = {}) {
  await $.turn.complete({ answer: '好了', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...extra })
  await clock.settle()
}

async function boot($: any) {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/proj' })
}

/** 唤醒：调用一次评审工具。取回复和回复区都只在唤醒后运行。*/
async function wake($: any, s: any) {
  await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
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

test('open_doc 把相对路径补成绝对路径并登记到当前会话', async ($, on) => {
  const s = stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  expect(s.fetched.find(f => f.path === '/api/open')?.body).toEqual({ path: '/proj/docs/plan.md', session: 'sess-1' })
})

test('插件以别的名字加载（会话中途改名、热重载后沿用旧名）时，按引擎给的真实工具名响应', async ($, on) => {
  const s = stub(on, { pluginName: 'doc-review' })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__doc-review__open_doc', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  const status: any = await $.tool.call({ tool: 'mcp__doc-review__review_status' })
  expect(String(status.result)).not.toContain('失败')
  // 写死的默认名不是这个会话里的工具，原样交给引擎
  const other: any = await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
  expect(String(other.result)).toBe('wrote undefined')
  expect(s.fetched.filter(f => f.path === '/api/open').length).toBe(1)
})

test('open_doc 只返回路径和带 lang 的链接，不再要求画卡片', async ($, on) => {
  stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
  const text = String(ran.result)
  expect(text).toBe(
    [`Registered: docs/plan.md`, `Link: ${URL_D1}&lang=zh`, `For your reply: [打开 plan](${URL_D1}&lang=zh)`, BROWSER_HINT].join('\n'),
  )
  expect(text).not.toContain('show_widget')
})

test('旧工具名 review_open、review_resolve、review_status 不再注册，也不被插件接住', async ($, on) => {
  const s = stub(on)
  await boot($)
  expect(Object.keys(s.tools)).toEqual(['open_doc'])
  for (const tool of ['mcp__cc-doc-review__review_open', 'mcp__cc-doc-review__review_resolve', 'mcp__cc-doc-review__review_status']) {
    const ran: any = await $.tool.call({ tool, path: 'docs/plan.md' })
    expect(String(ran.result)).toBe('wrote undefined')
  }
  expect(s.fetched.some(f => f.path === '/api/open')).toBe(false)
})

test('open_doc 失败时把服务端原因告诉模型', async ($, on) => {
  stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'a.txt' })
  expect(String(ran.deny)).toContain('只支持')
})

test('服务没在跑就在后台启动它', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  const pending = $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
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
  const pending = $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
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

test('进程命令行不是旧版文档服务时不结束进程', async ($, on) => {
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

test('服务应答不是 JSON 时报 HTTP 状态码', async ($, on) => {
  stub(on, { openBody: '<html>Bad Gateway</html>' })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
  expect(String(ran.deny)).toContain('HTTP 502')
})

test('parseReply：非 JSON 的错误应答给出状态码', async () => {
  expect(() => parseReply({ ok: false, status: 500, text: 'oops' })).toThrow('HTTP 500')
  expect(() => parseReply({ ok: false, status: 400, text: '{"error":"原因"}' })).toThrow('原因')
  expect(parseReply({ ok: true, status: 200, text: '' })).toEqual({})
})

test('会话重复开始时取回复的定时器不叠加', async ($, on) => {
  const s = stub(on, { docs: [summary('plan')] })
  await boot($)
  await boot($)
  await s.clock.settle()
  await tick(s.clock)
  expect(s.fetched.filter(f => f.path.startsWith('/api/replies?')).length).toBe(1)
})

// ---- 预编译分发：首次使用下载、校验、本地编译兜底、开发模式、版本自更新 ----

/** 调一次 review_open（服务可能要启动，推进时钟让等待结束），返回工具结果。*/
async function openOnce($: any, s: any) {
  const pending = $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
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
  expect(s.toasts.some((t: string) => t.includes('首次使用，正在下载文档服务'))).toBe(true)
  const curls = argvOf(s, 'curl')
  expect(curls.length).toBe(2)
  const base = 'https://github.com/sapronlee/cc-doc-review/releases/download/v0.2.0'
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
    'https://github.com/sapronlee/cc-doc-review/releases/download/v0.2.0/cc-doc-review-server-linux-arm64',
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
  expect(msg).toContain('文档服务')
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
  const calls = [1, 2, 3].map(() => $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' }))
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

test('进程命令行不是文档服务：不结束，继续用旧版并提示', async ($, on) => {
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
  expect(s.toasts.some((t: string) => t.includes('文档服务要更新'))).toBe(false)
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
  const first = $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
  const second = $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
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

/** 用户在输入框里发一条消息。*/
async function userSays($: any, text: string, kind = 'composer') {
  return $.prompt.submit({ text, wait: false, origin: { kind } })
}

/** 走 n 次每秒的定时器 tick。*/
async function ticks(clock: any, n: number) {
  for (let i = 0; i < n; i++) await tick(clock)
}

test('休眠时用户消息原样放行，不碰外部能力', async ($, on) => {
  const s = stub(on, { hasInfo: false })
  await boot($)
  await s.clock.settle()
  const calls = s.ext.calls
  await userSays($, '你好')
  expect(s.prompts.at(-1)).toMatchObject({ text: '你好', context: undefined })
  expect(s.ext.calls).toBe(calls)
})

test('服务没在跑时取回复静默跳过，不去启动服务', async ($, on) => {
  const o: any = { docs: [summary('plan')], replies: replyGroups(2) }
  const s = stub(on, o)
  await boot($)
  await s.clock.settle()
  o.alive = false
  await tick(s.clock)
  expect(s.spawned.length).toBe(0)
  expect(s.submitted.length).toBe(0)
  expect(s.toasts).toEqual([])
})

test('斜杠命令注册为 cc-doc-review，避开内置的 /code-review', async ($, on) => {
  const s = stub(on)
  await boot($)
  expect(s.commands).toEqual(['cc-doc-review'])
})

test('命令注册被拒时工具和取回复照常可用，只弹一条提示', async ($, on) => {
  const s = stub(on, { refuseCommand: true, replies: replyGroups(2) })
  await boot($)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toContain('/cc-doc-review')
  const ran: any = await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  await tick(s.clock)
  expect(s.fetched.some(f => f.path.startsWith('/api/replies?'))).toBe(true)
  const ui = await band($)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await ui.unmount()
})

// ── 回复区的唤醒、休眠与服务状态 ──

test('重启后服务不在、本机数据里本会话登记过文档：会话开始就启动服务并唤醒，回复区直接出现', async ($, on) => {
  const s = stub(on, {
    alive: false,
    startsAlive: true,
    newHasDocs: true,
    localDocs: [{ name: 'other.json', session: 'sess-x' }, { name: 'd1.json', session: 'sess-1' }],
    docs: [summary('plan')],
    replies: replyGroups(2),
  })
  await boot($)
  await s.clock.settle()
  expect(s.spawned.some(a => a.join(' ').includes('nohup'))).toBe(true)
  await tick(s.clock)
  const ui = await band($)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await ui.unmount()
})

test('重启后服务不在、本机数据里没有本会话的文档：不启动服务，保持休眠，不取回复', async ($, on) => {
  const s = stub(on, { alive: false, newHasDocs: true, localDocs: [{ name: 'other.json', session: 'sess-x' }], docs: [summary('plan')], replies: replyGroups(2) })
  await boot($)
  await s.clock.settle()
  expect(s.spawned.length).toBe(0)
  await tick(s.clock)
  expect(s.fetched.some(isReplies)).toBe(false)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('会话开始时服务不在：之后每轮开始再查，服务起来且本会话有文档就唤醒并画回复区，期间不去启动服务', async ($, on) => {
  const o: any = { alive: false, docs: [summary('plan')], replies: replyGroups(2) }
  const s = stub(on, o)
  await boot($)
  await s.clock.settle()
  await tick(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  // 服务还没起来：这一轮查过仍然休眠
  await $.turn.start({ text: '你好', turnId: 't1' })
  await tick(s.clock)
  await tick(s.clock)
  expect(allText(await ui.drawn())).toBe('engine')
  // 服务起来了：下一轮开始时查到本会话的文档，唤醒并取回复（检查一次 tick，取回复再一次 tick）
  o.alive = true
  await $.turn.start({ text: '继续', turnId: 't2' })
  await tick(s.clock)
  await tick(s.clock)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  expect(s.spawned.length).toBe(0)
  await ui.unmount()
})


test('/cc-doc-review 带文件：登记并在系统浏览器打开，返回链接；打不开时只返回链接', async ($, on) => {
  const o: any = { systemOpen: true }
  const s = stub(on, o)
  await boot($)
  let r: any = await $.command.run({ command: 'cc-doc-review', args: 'docs/plan.md' } as any)
  expect(String(r.text)).toBe(`已登记 docs/plan.md，已在系统浏览器打开：${URL_D1}&lang=zh`)
  expect(s.spawned.some(a => a[0] === 'open' && a[1] === `${URL_D1}&lang=zh`)).toBe(true)
  o.systemOpen = false
  r = await $.command.run({ command: 'cc-doc-review', args: 'docs/plan.md' } as any)
  expect(String(r.text)).toBe(`已登记 docs/plan.md：${URL_D1}&lang=zh`)
  expect(s.submitted).toEqual([])
})

const docRow = (id: string, o: any = {}) => ({
  id,
  path: `/proj/docs/${id}.md`,
  kind: 'md',
  openedAt: '2026-10-10T23:50:00Z',
  pending: 0,
  ...o,
})

test('/cc-doc-review 不带参数：在聊天里列出本会话的文档，链接带 lang，目录 · 时间，有待发送回复时带条数', async ($, on) => {
  const s = stub(on, {
    docs: [docRow('a', { pending: 2, modifiedAt: '2026-10-10T23:58:00Z' }), docRow('b[x]', { openedAt: '2026-10-10T23:30:00Z', modifiedAt: '2026-10-10T23:40:00Z' })],
  })
  await boot($)
  const r: any = await $.command.run({ command: 'cc-doc-review', args: '' } as any)
  expect(String(r.text)).toBe(
    [
      '本会话的文档（2 份）：',
      '- [a](http://127.0.0.1:4823/review?doc=a&t=tok&lang=zh) · docs · 2 分钟前 · 2 条回复待发送',
      '- [b\\[x\\]](http://127.0.0.1:4823/review?doc=b%5Bx%5D&t=tok&lang=zh) · docs · 20 分钟前',
    ].join('\n'),
  )
  expect(s.fetched.some(f => f.path === '/api/docs?session=sess-1')).toBe(true)
  expect(s.submitted).toEqual([])
})

test('/cc-doc-review 不带参数：英文界面用英文标题，时间用英文', async ($, on) => {
  const s = stub(on, { language: 'English', docs: [docRow('a', { modifiedAt: '2026-10-10T23:58:00Z' })] })
  await boot($)
  const r: any = await $.command.run({ command: 'cc-doc-review', args: '' } as any)
  expect(String(r.text)).toBe('Docs in this session (1):\n- [a](http://127.0.0.1:4823/review?doc=a&t=tok&lang=en) · docs · 2 min ago')
  void s
})

test('/cc-doc-review 不带参数：本会话没有文档时提示', async ($, on) => {
  const s = stub(on)
  await boot($)
  const r: any = await $.command.run({ command: 'cc-doc-review', args: '' } as any)
  expect(String(r.text)).toBe('本会话还没有文档')
  void s
})

test('/cc-doc-review 不带参数：服务不在就启动它再列', async ($, on) => {
  const s = stub(on, { alive: false, startsAlive: true, docs: [docRow('a')] })
  await boot($)
  const pending: Promise<any> = $.command.run({ command: 'cc-doc-review', args: '' } as any)
  await s.clock.advance(4000)
  const r = await pending
  expect(s.spawned.some(a => a[0] === '/bin/sh' && a[2].includes('nohup'))).toBe(true)
  expect(String(r.text)).toContain('- [a](')
})

test('/cc-doc-review 不带参数：服务起不来时报打开失败', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  const pending: Promise<any> = $.command.run({ command: 'cc-doc-review', args: '' } as any)
  await s.clock.advance(4000)
  const r = await pending
  expect(String(r.text)).toContain('打开失败：文档服务启动失败')
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
  // 不弹「已登记」：Claude 回话里的链接和 /cc-doc-review 列表就是入口
  expect(s.toasts).toEqual([])
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

test('不是文档、被排除、在工作目录外的文件不登记', async ($, on) => {
  const s = stub(on)
  await boot($)
  for (const file_path of [
    '/proj/src/notes.txt',
    '/proj/docs/README.md',
    '/proj/AGENTS.md',
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
  expect(s.toasts[0]).toContain('自动登记文档失败')
  // 退避期内不再尝试
  expect(opened(s)).toEqual(['/proj/docs/a.md'])
  o.openFails = false
  await s.clock.advance(61_000)
  await write($, s, '/proj/docs/a.md')
  expect(opened(s)).toEqual(['/proj/docs/a.md', '/proj/docs/a.md'])
  expect(s.toasts.length).toBe(1)
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
const isReplies = (f: any) => f.path.startsWith('/api/replies?')
/** 唤醒的标志：回复定时器在跑（每秒取一次 /api/replies）。*/
async function isAwake(s: any) {
  const before = s.fetched.filter(isReplies).length
  await tick(s.clock)
  return s.fetched.filter(isReplies).length > before
}

test('休眠：服务没在跑时零 HTTP、零进程，定时器空转，不取回复、不画回复区，一轮结束直接放行', async ($, on) => {
  const s = stub(on, { hasInfo: false, replies: replyGroups(2) })
  await boot($)
  await s.clock.settle()
  // 会话开始那次检查之后：定时器 tick、一轮开始与结束都不碰任何外部能力
  const calls = s.ext.calls
  await s.clock.advance(60_000)
  await $.turn.start({ text: '你好', turnId: 't1' })
  await turnDone($, s.clock)
  expect(s.ext.calls).toBe(calls)
  expect(s.fetched.some(isReplies)).toBe(false)
  // 休眠时回复区整块让给下层，画它也不碰外部能力
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  expect(s.ext.calls).toBe(calls)
  await ui.unmount()
  // 没命中的写入：只做路径匹配，不联网、不提示
  await write($, s, '/proj/src/a.ts')
  expect(s.fetched).toEqual([])
  expect(s.spawned).toEqual([])
  expect(s.submitted).toEqual([])
  expect(s.toasts).toEqual([])
})

test('休眠：服务在跑但本会话没有文档时，只在会话开始查一次', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  await boot($)
  await s.clock.settle()
  expect(s.fetched.map(f => f.path)).toEqual(['/api/health', '/api/docs?session=sess-1'])
  const calls = s.ext.calls
  await s.clock.advance(60_000)
  await turnDone($, s.clock)
  expect(s.fetched.length).toBe(2)
  expect(s.submitted).toEqual([])
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  expect(s.ext.calls).toBe(calls)
})

test('系统提示不加规则（休眠和唤醒后都不加），规则写在 open_doc 的说明里', async ($, on) => {
  const s = stub(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  await boot($)
  const dormant: any = await $.prompt.compose(COMPOSE)
  expect(dormant.sections.map((x: any) => x.id)).toEqual(['intro'])
  await wake($, s)
  const awake: any = await $.prompt.compose(COMPOSE)
  expect(awake.sections.map((x: any) => x.id)).toEqual(['intro'])
  const desc = String(s.tools.open_doc?.description)
  expect(desc).toContain('not a review')
  expect(desc).toContain('never from a subagent')
  expect(desc).toContain('[文档回复]')
  expect(desc).toContain('[Doc reply]')
  expect(desc).toContain('Answer every reply')
  expect(desc).toContain('README')
})

test('唤醒：调用 open_doc', async ($, on) => {
  const s = stub(on)
  await boot($)
  expect(await isAwake(s)).toBe(false)
  await $.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path: 'docs/plan.md' })
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
  await write($, s, '/proj/src/a.ts')
  expect(await isAwake(s)).toBe(false)
  await write($, s, '/proj/src/a.md')
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

test('唤醒后取回复正常：休眠时不取、不画回复区，唤醒后取到就画出回复区', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  await boot($)
  await tick(s.clock)
  await tick(s.clock)
  expect(s.fetched.filter(isReplies).length).toBe(0)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await wake($, s)
  await tick(s.clock)
  expect(s.fetched.filter(isReplies).length).toBe(1)
  expect(await titleOf(ui)).toBe('2 条回复')
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await ui.unmount()
})

test('唤醒后下一秒就取回复并画出回复区', async ($, on) => {
  const s = stub(on)
  await boot($)
  await s.clock.advance(1500) // 错开整秒：唤醒后下一次定时器 tick 就该取回复
  s.server.replies = replyGroups(2)
  await wake($, s)
  await tick(s.clock)
  const ui = await band($)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await ui.unmount()
})

test('/clear 后复位为休眠：定时器空转、不再取回复、回复区收起、回复清空，再用到评审时用同一组定时器重新唤醒，新回复照常画', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2), docs: [summary('plan')] })
  await boot($)
  await s.clock.settle()
  await tick(s.clock)
  const ui = await band($)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await endSession($, s)
  s.server.session = 'sess-2'
  // 新会话里的回复（ID 和旧会话的不同）
  s.server.replies = replyGroups(1).map(g => ({ ...g, replies: g.replies.map((r: any) => ({ ...r, id: 'c_9', quote: '新原文', body: '新回复' })) }))
  const calls = s.ext.calls
  await s.clock.advance(30_000)
  await turnDone($, s.clock)
  expect(s.ext.calls).toBe(calls)
  // 回复区收起，让给下层（这里按新画的来看）
  const fresh = await band($)
  expect(allText(await fresh.drawn())).toBe('engine')
  // 新会话里再用到评审：重新唤醒，按新会话 ID 取回复并画出来，旧会话的回复不会回来
  await wake($, s)
  await tick(s.clock)
  expect(s.fetched.some(f => f.path === '/api/replies?session=sess-2')).toBe(true)
  expect(await rowIds(fresh)).toEqual(['c_9'])
  expect(svgAlts(await fresh.find({ key: 'r:c_9:art' }))).toEqual(['1 新原文 新回复'])
  await fresh.unmount()
  await ui.unmount()
})

test('会话结束（退出）：复位为休眠，之后没有任何外部调用，再次唤醒仍可取回复并画出回复区', async ($, on) => {
  const s = stub(on)
  await bootAwake($, s)
  await endSession($, s, 'prompt_input_exit')
  expect(await isAwake(s)).toBe(false)
  const calls = s.ext.calls
  await s.clock.advance(30_000)
  expect(s.ext.calls).toBe(calls)
  // 再次唤醒后恢复取回复
  s.server.replies = replyGroups(2)
  await wake($, s)
  await tick(s.clock)
  const ui = await band($)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await ui.unmount()
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
  expect(first.toasts).toContain('cc-doc-review：首次使用，正在下载文档服务')
  expect(first.toasts.some((t: string) => t.includes('插件已更新'))).toBe(false)
})

test('插件更新后换新版：提示正在准备新版，不说首次使用', async ($, on) => {
  const s = stub(on, { hasBinary: false, serverVersion: '0.1.0', startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(s.toasts).toContain('cc-doc-review：插件已更新，正在准备新版文档服务')
  expect(s.toasts.some((t: string) => t.includes('首次使用'))).toBe(false)
})

test('不支持的平台不提示下载', async ($, on) => {
  const s = stub(on, { ...FRESH, uname: 'FreeBSD amd64\n', goShell: '/bin/zsh', startsAlive: true })
  await boot($)
  await openOnce($, s)
  expect(s.toasts.some((t: string) => t.includes('下载文档服务'))).toBe(false)
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
  expect(s.toasts.some((t: string) => t.includes('下载文档服务'))).toBe(false)
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

// ---- 输入框上方的回复区 ----

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

async function band($: any, props: any = {}, extra: any = {}) {
  return $.ui.mount({ ...BAND, ...extra, props: { ...BAND.props, ...props } })
}

/** 两份文档的回复，服务端已按组排好、编号连续。n 条：a1、b2、a3……交错加入。*/
function replyGroups(n: number) {
  const at = (i: number) => new Date(Date.parse('2026-10-11T00:00:00Z') + i * 60_000).toISOString()
  const a: any[] = []
  const b: any[] = []
  for (let i = 1; i <= n; i++) (i % 2 === 1 ? a : b).push({ id: `c_${i}`, no: 0, quote: `原文${i}`, prefix: '', suffix: '', body: `回复${i}`, createdAt: at(i) })
  const groups = [
    { doc: 'da', path: '/proj/docs/改名清单.md', kind: 'md', replies: a },
    { doc: 'db', path: '/tmp/行程.md', kind: 'md', replies: b },
  ].filter(g => g.replies.length > 0)
  let no = 0
  for (const g of groups) for (const r of g.replies) r.no = ++no
  return groups
}

/** 去掉指定 ID 的回复（模拟服务端已标为已发送或已删）。*/
const without = (groups: any[], ids: string[]) =>
  groups.map(g => ({ ...g, replies: g.replies.filter((r: any) => !ids.includes(r.id)) })).filter(g => g.replies.length > 0)
const isSent = (f: any) => f.path === '/api/replies/sent'
const isDeleteComment = (f: any) => f.method === 'DELETE' && f.path.startsWith('/api/comments?')
const isClearReplies = (f: any) => f.method === 'DELETE' && f.path.startsWith('/api/replies')

/** 唤醒、取一次回复，再在输入框上方画回复区。*/
async function bandWithReplies($: any, s: any, props: any = {}, extra: any = {}) {
  await bootAwake($, s)
  await tick(s.clock)
  return band($, props, extra)
}

const labels = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((n: any) => n.props.label)
/** 列出来的回复行（按画出来的顺序）的 ID。*/
const rowIds = async (ui: any) =>
  (await ui.findAll({ type: 'Box' })).map((n: any) => String(n.key ?? '')).filter((k: string) => /^r:[^:]+$/.test(k)).map((k: string) => k.slice(2))
/** 标题：桌面版是 Box title 里 Svg 的 alt，终端是里面那行 Text（带「↩ 」前缀）。*/
/** 标题行文字（桌面版、终端都是桌面版的文字：↩、标题、· 文档名），去掉 ↩ 后用空格连起来。*/
const titleOf = async (ui: any) => {
  const box = await ui.find({ key: 'title' })
  return walk(box)
    .filter((n: any) => n?.type === 'Text')
    .map((n: any) => allText(n))
    .filter((t: string) => t !== '↩')
    .join(' ')
}
/** 文档名行（多份文档时每组前一行）：桌面版是 Box doc:<doc> 里 Svg 的 alt，终端是加粗的暗色文字（引擎不保留 Text 的 key，只能按样式认）。*/
const docRows = async (ui: any) => {
  const boxes = (await ui.findAll({ type: 'Box' })).filter((n: any) => /^doc:[^:]+$/.test(String(n.key ?? '')))
  if (boxes.length > 0) return boxes.flatMap((b: any) => svgAlts(b).filter((a: string) => a !== '边框'))
  return (await ui.findAll({ type: 'Text' })).filter((n: any) => n.props.dimColor && n.props.bold).map((n: any) => n.text)
}
/** 按文字找一行 Text。*/
const textOf = async (ui: any, text: string) => ui.find({ type: 'Text', text })
/** 子树里所有节点（含自己），按画出来的先后。*/
const walk = (n: any): any[] => (n ? [n, ...(n.children ?? []).flatMap(walk)] : [])
/** 回复列表里按 key 取一个原始节点：find 直接返回的节点看不到自己的 hover 字段，要从父节点的 children 里取。*/
const inList = async (ui: any, key: string) => walk(await ui.find({ key: 'reply-list' })).find(x => x.props?.key === key)
/** 子树里的 Svg 的 alt 列表。*/
const svgAlts = (n: any) => walk(n).filter(x => x.type === 'Svg').map(x => x.props.alt)
/** 只有一份文档（改名清单）的 n 条回复：c_1、c_3、c_5……*/
const oneDoc = (n: number) => replyGroups(2 * n).filter(g => g.doc === 'da')

test('回复区：2 条回复（单文档）：表格样式的圆角外框、标题行和每条回复各一行（整行一张图）、标题带文档名、× 悬停才出现，下层接在下面；没有回复时整块让给下层', async ($, on) => {
  const s = stub(on, { replies: oneDoc(2) })
  const ui = await bandWithReplies($, s)
  // 圆角外框，边线变暗；第一行是标题行 head，之后每条回复一行
  const list: any = await ui.find({ key: 'reply-list' })
  // 桌面版的外框自己画：上沿、下沿是图，不用桌面版的边框
  expect(list?.props.borderStyle).toBeUndefined()
  expect(list?.children.map((c: any) => c.props.key).filter((k: string) => k.startsWith('rim:'))).toEqual(['rim:top'])
  expect(list.children.map((c: any) => c.props.key)).toEqual(['rim:top', 'head', 'gap:head', 'line:r:c_1', 'r:c_1', 'line:r:c_3', 'r:c_3'])
  // 标题是一张图（alt 带文档名）；只有一份文档，不单列文档名行
  expect(await titleOf(ui)).toBe('2 条回复 · 改名清单')
  // 标题行是桌面版的文字（↩、加粗的标题、暗色的 · 文档名），不是图，和右边的按钮对齐
  expect(svgAlts(await ui.find({ key: 'title' }))).toEqual([])
  expect(await titleOf(ui)).toBe('2 条回复 · 改名清单')
  expect(await docRows(ui)).toEqual([])
  expect(await rowIds(ui)).toEqual(['c_1', 'c_3'])
  // 每一行是 Box r:<id>:art 包一个 Svg，alt 为「编号 完整原文 回复」
  expect(svgAlts(await ui.find({ key: 'r:c_1:art' }))).toEqual(['1 原文1 回复1'])
  expect(svgAlts(await ui.find({ key: 'r:c_3:art' }))).toEqual(['2 原文3 回复3'])
  // 不再有单独的分界线 Box，也不再有底部「还有 N 条」行
  // 行与行之间的横线单独一条（line: 开头），每条回复前一条
  expect((await ui.findAll({ type: 'Box' })).filter((n: any) => String(n.key ?? '').startsWith('line:')).map((n: any) => n.key)).toEqual(['line:r:c_1', 'line:r:c_3'])
  expect(await ui.find({ key: 'line:more' })).toBeUndefined()
  expect(await textOf(ui, '还有')).toBeUndefined()
  // 回复区里每条悬停时底色变浅
  expect(await inList(ui, 'r:c_1')).toMatchObject({ hover: { backgroundColor: 'rgba(127,127,127,0.10)' } })
  expect(await inList(ui, 'r:c_3')).toMatchObject({ hover: { backgroundColor: 'rgba(127,127,127,0.10)' } })
  expect(await ui.find({ key: 'r:c_1:x' })).toMatchObject({ type: 'Button', props: { label: '×', plain: true, dimColor: true } })
  expect(await ui.find({ key: 'r:c_3:x' })).toMatchObject({ type: 'Button', props: { label: '×', plain: true, dimColor: true } })
  // 标题行右边：只有〔清空〕〔发送〕（plain，清空变暗），不折叠就没有〔展开〕和竖线
  expect(await labels(ui)).toEqual(['清空', '发送', '×', '×'])
  expect(await ui.find({ key: 'clear' })).toMatchObject({ props: { plain: true, dimColor: true } })
  expect(await ui.find({ key: 'send' })).toMatchObject({ props: { plain: true } })
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect(await ui.find({ key: 'sep' })).toBeUndefined()
  // 下层的内容接在下面：自己的在上，下层在下
  expect(await ui.find({ key: 'stack' })).toBeDefined()
  expect(await ui.find({ key: 'mine' })).toBeDefined()
  expect(allText(await ui.find({ key: 'rest' }))).toBe('engine')
  expect(allText(await ui.drawn()).endsWith('engine')).toBe(true)
  // 上下两层之间隔一小段
  // 回复区和下层之间不另加空隙：下层（用量带）自己的分隔线上下已经留了空
  expect((await ui.find({ key: 'stack' }))?.props.rowGap).toBeUndefined()
  // 引擎节点不能放在设了 width 的 Box 下：包着下层内容的 stack、rest 都不设宽度，靠拉伸铺满
  for (const key of ['stack', 'rest']) {
    const box: any = await ui.find({ key })
    expect(box?.props.width).toBeUndefined()
    expect(box?.props.alignItems).toBe('stretch')
  }
  // 没有回复时整块让给下层
  s.server.replies = []
  await tick(s.clock)
  expect(allText(await ui.drawn())).toBe('engine')
  expect(await ui.find({ key: 'reply-list' })).toBeUndefined()
  await ui.unmount()
})

test('回复区：两份文档时标题只写条数，每组前一行文档名（一张图，alt 为文档名）', async ($, on) => {
  const s = stub(on, { replies: replyGroups(3) })
  const ui = await bandWithReplies($, s)
  expect(await titleOf(ui)).toBe('3 条回复')
  expect(await docRows(ui)).toEqual(['改名清单', '行程'])
  expect(svgAlts(await ui.find({ key: 'doc:da:art' }))).toEqual(['改名清单'])
  expect(await rowIds(ui)).toEqual(['c_1', 'c_3', 'c_2'])
  expect(svgAlts(await ui.find({ key: 'r:c_2:art' }))).toEqual(['3 原文2 回复2'])
  // 列表里的行顺序：标题行、文档名行、该文档的回复……
  const list: any = await ui.find({ key: 'reply-list' })
  expect(list.children.map((c: any) => c.props.key)).toEqual(['rim:top', 'head', 'gap:head', 'line:doc:da', 'doc:da', 'line:r:c_1', 'r:c_1', 'line:r:c_3', 'r:c_3', 'line:doc:db', 'doc:db', 'line:r:c_2', 'r:c_2'])
  await ui.unmount()
})

test('回复区：没有待发送的回复时整块让给下层，不画框', async ($, on) => {
  const s = stub(on, { docs: [summary('plan')] })
  await boot($)
  await tick(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  expect(await ui.find({ key: 'reply-list' })).toBeUndefined()
  await ui.unmount()
})

test('回复区：下层（别的插件）绘制出错时只画回复区，不连累', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2), innerThrows: true })
  const ui = await bandWithReplies($, s)
  expect(await titleOf(ui)).toBe('2 条回复')
  expect(allText(await ui.drawn())).not.toContain('engine')
  expect(await ui.find({ key: 'stack' })).toBeUndefined()
  await ui.unmount()
})

test('回复区：没有回复时直接交给下层，下层出错时错误照样抛出去（不吞）', async ($, on) => {
  const o: any = { docs: [summary('plan')] }
  const s = stub(on, o)
  await boot($)
  await tick(s.clock)
  const ui = await band($)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  o.innerThrows = true
  await expect(band($)).rejects.toThrow('ui.render')
})

test('回复区：超过 3 条时折叠，只列最新加入的 3 条，标题行有〔展开其余 1 条 ⌄〕和竖线，按它展开 4 条，〔收起 ⌃〕还原', async ($, on) => {
  const s = stub(on, { replies: replyGroups(4) })
  // 行数够（maxRows 40）：下层 1 行，room = 40 - 1 - 3 - 3 = 33
  const ui = await bandWithReplies($, s, { maxRows: 40 })
  expect(await titleOf(ui)).toBe('4 条回复')
  // 最新加入的是 c_2 到 c_4，最早的 c_1 折起来；按文档分组排
  expect([...(await rowIds(ui))].sort()).toEqual(['c_2', 'c_3', 'c_4'])
  // 标题行右边依次是〔展开其余 1 条 ⌄〕、竖线、〔清空〕、〔发送〕；没有底部「还有 N 条」行
  expect(await labels(ui)).toEqual(['展开其余 1 条', '清空', '发送', '×', '×', '×'])
  expect(await ui.find({ key: 'toggle' })).toMatchObject({ type: 'Button', props: { plain: true, dimColor: true } })
  expect(svgAlts(await ui.find({ key: 'sep' }))).toEqual(['|'])
  const head: any = await ui.find({ key: 'head' })
  expect(head.children.map((c: any) => c.props.key)).toEqual(['head:l', 'title', 'toggle', 'sep', 'clear', 'send', 'head:r'])
  expect(await ui.find({ key: 'line:more' })).toBeUndefined()
  expect(await textOf(ui, '还有')).toBeUndefined()
  await ui.press({ key: 'toggle' })
  expect([...(await rowIds(ui))].sort()).toEqual(['c_1', 'c_2', 'c_3', 'c_4'])
  expect((await labels(ui)).slice(0, 3)).toEqual(['收起', '清空', '发送'])
  await ui.press({ key: 'toggle' })
  expect([...(await rowIds(ui))].sort()).toEqual(['c_2', 'c_3', 'c_4'])
  expect((await labels(ui))[0]).toBe('展开其余 1 条')
  // 少到 3 条：不用折叠，〔展开〕和竖线没有了；展开状态也作废，再多起来时仍是折叠的
  await ui.press({ key: 'toggle' })
  s.server.replies = replyGroups(3)
  await tick(s.clock)
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect(await ui.find({ key: 'sep' })).toBeUndefined()
  expect(await rowIds(ui)).toHaveLength(3)
  s.server.replies = replyGroups(4)
  await tick(s.clock)
  expect([...(await rowIds(ui))].sort()).toEqual(['c_2', 'c_3', 'c_4'])
  expect((await labels(ui))[0]).toBe('展开其余 1 条')
  await ui.unmount()
})

test('回复区：终端里折叠时〔展开其余 N 条〕后面没有竖线图', async ($, on) => {
  const s = stub(on, { replies: replyGroups(5) })
  const ui = await bandWithReplies($, s, { maxRows: 40 }, { surface: 'terminal' })
  expect(await labels(ui)).toEqual(['展开其余 2 条', '清空', '发送', '×', '×', '×'])
  expect(await ui.find({ key: 'sep' })).toBeUndefined()
  const head: any = await ui.find({ key: 'head' })
  expect(head.children.map((c: any) => c.props.key)).toEqual(['title', 'toggle', 'clear', 'send'])
  await ui.unmount()
})

test('回复区：行数不够（maxRows 小）时只列 room 条（至少 1 条）；展开也放不下更多时不给〔展开〕', async ($, on) => {
  // maxRows 10、下层 engine 占 1 行：room = 10 - 1 - 3 - 3 = 3，和折叠时一样多，所以没有〔展开〕
  const s = stub(on, { replies: replyGroups(5) })
  let ui = await bandWithReplies($, s, { maxRows: 10 })
  expect([...(await rowIds(ui))].sort()).toEqual(['c_3', 'c_4', 'c_5'])
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect((await labels(ui))[0]).toBe('清空')
  await ui.unmount()
  // maxRows 再小：room 只剩 1（或更少）也至少列 1 条，最新加入的那条
  ui = await band($, { maxRows: 8 })
  expect(await rowIds(ui)).toEqual(['c_5'])
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  await ui.unmount()
  ui = await band($, { maxRows: 2 })
  expect(await rowIds(ui)).toEqual(['c_5'])
  await ui.unmount()
})

test('回复区：下层内容越高，回复区列的条数越少（room 随下层行数减少）', async ($, on) => {
  const s = stub(on, { replies: replyGroups(5) })
  await bootAwake($, s)
  await tick(s.clock)
  // 下层 engine 是 1 行：room = 40 - 1 - 3 - 3，折叠时列 3 条
  let ui = await band($, { maxRows: 40 })
  expect(await rowIds(ui)).toHaveLength(3)
  await ui.unmount()
  // maxRows 9：room = 2
  ui = await band($, { maxRows: 9 })
  expect(await rowIds(ui)).toHaveLength(2)
  await ui.unmount()
})

test('回复区：× 删掉一条：DELETE 对应的评论，这一行马上消失；删失败时保留并提示原因', async ($, on) => {
  const o: any = { replies: replyGroups(2) }
  const s = stub(on, o)
  const ui = await bandWithReplies($, s)
  o.deleteFails = true
  await ui.press({ key: 'r:c_2:x' })
  await s.clock.settle()
  expect(s.toasts.at(-1)).toContain('没删掉：')
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  o.deleteFails = false
  await ui.press({ key: 'r:c_2:x' })
  await s.clock.settle()
  expect(s.fetched.filter(isDeleteComment).at(-1)?.path).toBe('/api/comments?doc=db&id=c_2')
  expect(await rowIds(ui)).toEqual(['c_1'])
  expect(await titleOf(ui)).toBe('1 条回复 · 改名清单')
  // 刚删的不会在下一次取数时又冒出来
  await ticks(s.clock, 2)
  expect(await rowIds(ui)).toEqual(['c_1'])
  // 删到只剩一条再删：回复区让给下层
  await ui.press({ key: 'r:c_1:x' })
  await s.clock.settle()
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('回复区：〔清空〕点一次只变「确认清空」，3 秒后复原；3 秒内再点才清空本会话的回复', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  const ui = await bandWithReplies($, s)
  expect((await labels(ui))[0]).toBe('清空')
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  expect((await labels(ui))[0]).toBe('确认清空')
  expect(s.fetched.some(isClearReplies)).toBe(false)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  // 3 秒内没再点：复原
  await ticks(s.clock, 3)
  expect((await labels(ui))[0]).toBe('清空')
  expect(s.fetched.some(isClearReplies)).toBe(false)
  // 点两次（间隔 1.5 秒）：清空
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  await s.clock.advance(1500)
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  expect(s.fetched.filter(isClearReplies).map(f => f.path)).toEqual(['/api/replies?session=sess-1'])
  expect(s.server.replies).toEqual([])
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('回复区：〔清空〕第二次点得太晚（超过 3 秒）算第一次，不清空', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  const ui = await bandWithReplies($, s)
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  await s.clock.advance(3500)
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  expect(s.fetched.some(isClearReplies)).toBe(false)
  expect((await labels(ui))[0]).toBe('确认清空')
  await ui.unmount()
})

test('回复区：〔发送〕以你的名义发出回复块，标为已发送，提示「已发给 Claude」，回复区让位', async ($, on) => {
  const groups = replyGroups(2)
  const s = stub(on, { replies: groups })
  const ui = await bandWithReplies($, s)
  await ui.press({ key: 'send' })
  await s.clock.settle()
  expect(s.submitted).toEqual([withReplies('', groups, 'zh', '/proj')])
  expect(s.submitted[0].startsWith('[文档回复] 请按编号逐条答复。\n改名清单.md（docs/改名清单.md）\n')).toBe(true)
  expect(s.fetched.filter(isSent).map(f => f.body)).toEqual([{ ids: ['c_1', 'c_2'] }])
  expect(s.toasts).toContain('已发给 Claude')
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('回复区：〔发送〕失败：回复全部保留，不标已发送，提示带原因，按钮恢复', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2), dropSubmit: true })
  const ui = await bandWithReplies($, s)
  await ui.press({ key: 'send' })
  await s.clock.settle()
  expect(s.fetched.some(isSent)).toBe(false)
  expect(s.toasts.at(-1)).toBe('没发出去：会话不接受')
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  expect((await labels(ui))[1]).toBe('发送')
  // 保留的回复可以再发
  await ui.press({ key: 'send' })
  await s.clock.settle()
  expect(s.submitted.length).toBe(2)
  await ui.unmount()
})

test('回复区：〔发送〕发送中显示「发送中…」，再点无效，只发一次', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const s = stub(on, { replies: replyGroups(2), pluginGate: gate })
  const ui = await bandWithReplies($, s)
  const first = ui.press({ key: 'send' })
  await s.clock.settle()
  expect((await labels(ui))[1]).toBe('发送中…')
  await ui.press({ key: 'send' })
  await s.clock.settle()
  release()
  await first
  await s.clock.settle()
  expect(s.submitted.length).toBe(1)
  expect(s.fetched.filter(isSent).length).toBe(1)
  await ui.unmount()
})

test('〔发送〕正在发时用户按回车：这条消息不再带上同一批回复，也不重复标记', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const s = stub(on, { replies: replyGroups(2), pluginGate: gate })
  const ui = await bandWithReplies($, s)
  const sending = ui.press({ key: 'send' })
  await s.clock.settle()
  await userSays($, '顺便问一句')
  expect(s.prompts.at(-1)?.text).toBe('顺便问一句')
  release()
  await sending
  await s.clock.settle()
  expect(s.submitted.length).toBe(1)
  expect(s.fetched.filter(isSent).length).toBe(1)
  await ui.unmount()
})

test('回车发送：你的话在前，回复块在后；交出去后标为已发送，回复区让位，不弹提示', async ($, on) => {
  const groups = replyGroups(2)
  const s = stub(on, { replies: groups })
  const ui = await bandWithReplies($, s)
  await userSays($, '这两处改一下')
  await s.clock.settle()
  expect(s.prompts.at(-1)?.text).toBe(withReplies('这两处改一下', groups, 'zh', '/proj'))
  expect(s.prompts.at(-1)?.text.startsWith('这两处改一下\n\n[文档回复] 请按编号逐条答复。\n')).toBe(true)
  expect(s.fetched.filter(isSent).map(f => f.body)).toEqual([{ ids: ['c_1', 'c_2'] }])
  expect(s.toasts).not.toContain('已发给 Claude')
  expect(allText(await ui.drawn())).toBe('engine')
  // 已发出的不会再带第二遍
  await ticks(s.clock, 2)
  await userSays($, '再说一句')
  expect(s.prompts.at(-1)?.text).toBe('再说一句')
  expect(s.fetched.filter(isSent).length).toBe(1)
  await ui.unmount()
})

test('回车发送：bridge、sdk 来源也算用户自己发的', async ($, on) => {
  const groups = replyGroups(1)
  const s = stub(on, { replies: groups })
  await bootAwake($, s)
  await tick(s.clock)
  await userSays($, '好', 'bridge')
  expect(s.prompts.at(-1)?.text).toBe(withReplies('好', groups, 'zh', '/proj'))
  s.server.replies = groups
  await ticks(s.clock, 2)
  await userSays($, '行', 'sdk')
  expect(s.prompts.at(-1)?.text).toBe(withReplies('行', groups, 'zh', '/proj'))
  expect(s.fetched.filter(isSent).length).toBe(2)
})

test('回车发送：插件、通知发的消息和斜杠命令原样放行，不标记；没有回复时原样放行', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  const ui = await bandWithReplies($, s)
  await $.prompt.submit({ text: '别的插件', wait: false, origin: { kind: 'plugin', name: 'other' } })
  await $.prompt.submit({ text: '后台任务完成', wait: false, origin: { kind: 'task-notification' } })
  await userSays($, '/help')
  await userSays($, '  /clear')
  expect(s.prompts.map(p => p.text)).toEqual(['别的插件', '后台任务完成', '/help', '  /clear'])
  expect(s.fetched.some(isSent)).toBe(false)
  // 这些回复还在，回复区照旧
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  // 用户自己发时才带上
  await userSays($, '好')
  await s.clock.settle()
  expect(s.prompts.at(-1)?.text.startsWith('好\n\n[文档回复]')).toBe(true)
  expect(s.fetched.filter(isSent).map(f => f.body)).toEqual([{ ids: ['c_1', 'c_2'] }])
  // 回复已经发完，没有回复了：原样放行
  await tick(s.clock)
  await userSays($, '第三条')
  expect(s.prompts.at(-1)?.text).toBe('第三条')
  expect(s.fetched.filter(isSent).length).toBe(1)
  await ui.unmount()
})

test('回车发送：消息被拒时不标已发送，回复照旧留着，下一次发送再带', async ($, on) => {
  const o: any = { replies: replyGroups(2) }
  const s = stub(on, o)
  const ui = await bandWithReplies($, s)
  o.refuseUserPrompts = 1
  const r: any = await userSays($, '第一条')
  expect(r.drop).toBe('拒绝')
  await s.clock.settle()
  expect(s.fetched.some(isSent)).toBe(false)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  await userSays($, '第二条')
  await s.clock.settle()
  expect(s.prompts.at(-1)?.text.startsWith('第二条\n\n[文档回复]')).toBe(true)
  expect(s.fetched.filter(isSent).map(f => f.body)).toEqual([{ ids: ['c_1', 'c_2'] }])
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('回车发送：标记失败（服务中途不在）不影响已发出的消息，回复区照样收起，并提示一次别再发', async ($, on) => {
  const o: any = { replies: replyGroups(1) }
  const s = stub(on, o)
  const ui = await bandWithReplies($, s)
  o.alive = false
  await userSays($, '好')
  await s.clock.settle()
  expect(s.prompts.at(-1)?.text.startsWith('好\n\n[文档回复]')).toBe(true)
  expect(allText(await ui.drawn())).toBe('engine')
  expect(s.toasts).toEqual(['已发出，但没能标为已发送（文档服务没在运行），这些回复还会留在列表里，别再发一遍'])
  await ui.unmount()
})

test('回复区：服务不在时 × 和〔确认清空〕不假装成功：回复留着，提示原因', async ($, on) => {
  const o: any = { replies: replyGroups(2) }
  const s = stub(on, o)
  const ui = await bandWithReplies($, s)
  o.alive = false
  const before = await rowIds(ui)
  await ui.press({ key: `r:${before[0]}:x` })
  await s.clock.settle()
  expect(s.toasts.at(-1)).toBe('没删掉：文档服务没在运行')
  expect(await rowIds(ui)).toEqual(before)
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  expect(s.toasts.at(-1)).toBe('没删掉：文档服务没在运行')
  expect(await rowIds(ui)).toEqual(before)
  await ui.unmount()
})

test('回复区：英文界面：标题、按钮和回复块用英文', async ($, on) => {
  const groups = oneDoc(1)
  const s = stub(on, { replies: groups, language: 'English' })
  const ui = await bandWithReplies($, s)
  expect(await titleOf(ui)).toBe('1 replies · 改名清单')
  expect((await labels(ui)).slice(0, 2)).toEqual(['Clear', 'Send'])
  await ui.press({ key: 'clear' })
  await s.clock.settle()
  expect((await labels(ui))[0]).toBe('Confirm clear')
  await userSays($, 'fix')
  expect(s.prompts.at(-1)?.text).toBe(withReplies('fix', groups, 'en', '/proj'))
  expect(s.prompts.at(-1)?.text.startsWith('fix\n\n[Doc reply] Please answer each by number.')).toBe(true)
  await ui.unmount()
})

test('回复区：英文界面：〔展开其余 N 条〕、〔收起〕和〔发送〕成功的提示用英文', async ($, on) => {
  const s = stub(on, { replies: replyGroups(4), language: 'English' })
  const ui = await bandWithReplies($, s, { maxRows: 40 })
  expect(await titleOf(ui)).toBe('4 replies')
  expect((await labels(ui))[0]).toBe('Show 1 more')
  await ui.press({ key: 'toggle' })
  expect((await labels(ui))[0]).toBe('Collapse')
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'send' })
  await s.clock.settle()
  expect(s.toasts).toContain('Sent to Claude')
  await ui.unmount()
})

test('回复区：有调查问卷时让位', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  const ui = await bandWithReplies($, s, { hasSurvey: true })
  expect(allText(await ui.drawn())).toBe('engine')
  expect(await ui.find({ key: 'reply-list' })).toBeUndefined()
  await ui.unmount()
})

test('回复区：服务一时不在时保留现有回复，不去启动服务；服务回来后接着更新', async ($, on) => {
  const o: any = { replies: replyGroups(2) }
  const s = stub(on, o)
  const ui = await bandWithReplies($, s)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  o.alive = false
  await ticks(s.clock, 2)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  expect(s.spawned.length).toBe(0)
  o.alive = true
  s.server.replies = replyGroups(3)
  await tick(s.clock)
  expect(await titleOf(ui)).toBe('3 条回复')
  await ui.unmount()
})

test('回复区：取回复一时失败（服务应答出错）：保留现有回复，不闪一下', async ($, on) => {
  const o: any = { replies: replyGroups(2) }
  const s = stub(on, o)
  const ui = await bandWithReplies($, s)
  o.repliesFail = true
  await ticks(s.clock, 2)
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  expect(s.toasts).toEqual([])
  o.repliesFail = false
  s.server.replies = replyGroups(1)
  await tick(s.clock)
  expect(await rowIds(ui)).toEqual(['c_1'])
  await ui.unmount()
})

test('回复区：× 平时不显示，鼠标停在那一条上才出现；终端画成文字的同样的列表', async ($, on) => {
  const groups = oneDoc(2)
  groups[0].replies[0].quote = '很长的原文'.repeat(20)
  const s = stub(on, { replies: groups })
  const ui = await bandWithReplies($, s)
  // × 排在行尾，那一格和行一样高，最底下一像素是图（最后一行画外框下沿）；平时 display none，悬停时 flex；它自己不带 key（带 key 会挡住上层的悬停）
  for (const id of ['c_1', 'c_3']) {
    const row = await ui.find({ key: `r:${id}` })
    expect(row.props.alignItems).toBe('stretch')
    // 行尾空白（PAD 宽），× 那一格出现在它和右边框之间
    expect(row.children.at(-3).children[0]).toMatchObject({ type: 'Svg', props: { width: 8, height: 28 } })
    const reveal = row.children.at(-2)
    expect(reveal).toMatchObject({ type: 'Box', props: { display: 'none', flexDirection: 'column' }, hover: { display: 'flex' } })
    expect(reveal.children[1]).toMatchObject({ type: 'Svg', props: { width: 28, height: 1 } })
    expect(reveal.children[1].props.source.includes('<rect')).toBe(id === 'c_3')
    expect(reveal.props.key).toBeUndefined()
    expect(reveal.children[0].children[0]).toMatchObject({ type: 'Button', props: { key: `r:${id}:x`, label: '×' } })
  }
  expect(await ui.find({ key: 'r:c_1:x' })).toMatchObject({ props: { plain: true, dimColor: true } })
  // 桌面版：完整原文放在图的 alt 里（图里只画截短的）
  expect(svgAlts(await ui.find({ key: 'r:c_1:art' }))).toEqual([`1 ${'很长的原文'.repeat(20)} 回复1`])
  await ui.unmount()
  const term = await band($, {}, { surface: 'terminal' })
  expect(await titleOf(term)).toBe('2 条回复 · 改名清单')
  expect(await rowIds(term)).toEqual(['c_1', 'c_3'])
  // 终端没有图：编号是橙色文字，原文前有暗色「│ 」，回复是普通文字
  expect(walk(await term.find({ key: 'reply-list' })).filter(x => x.type === 'Svg')).toHaveLength(0)
  expect(walk(await term.find({ key: 'r:c_1:no' })).find(x => x.type === 'Text')).toMatchObject({ children: ['1'], props: { color: 'claude' } })
  expect((await term.find({ key: 'r:c_3:no' }))?.text).toBe('2')
  expect((await term.find({ key: 'r:c_1:q' }))?.text.startsWith('│ ')).toBe(true)
  expect(walk(await term.find({ key: 'r:c_1:q' })).find(x => x.type === 'Text')).toMatchObject({ props: { dimColor: true } })
  expect((await term.find({ key: 'r:c_1:b' }))?.text).toBe('回复1')
  expect(await labels(term)).toEqual(['清空', '发送', '×', '×'])
  // 终端里一样能按〔发送〕
  await term.press({ key: 'send' })
  await s.clock.settle()
  expect(s.submitted.length).toBe(1)
  expect(s.toasts).toContain('已发给 Claude')
  await term.unmount()
})

test('回复区：文档页上新加回复后，已画出的回复区随之更新，不弹提示', async ($, on) => {
  const s = stub(on, { replies: replyGroups(1) })
  const ui = await bandWithReplies($, s)
  expect(await titleOf(ui)).toBe('1 条回复 · 改名清单')
  s.server.replies = replyGroups(2)
  await tick(s.clock)
  expect(await titleOf(ui)).toBe('2 条回复')
  expect(await rowIds(ui)).toEqual(['c_1', 'c_2'])
  expect(s.toasts).toEqual([])
  await ui.unmount()
})

// ---- 聊天记录里的回复消息 ----

const MESSAGE = {
  plugin: 'cc-doc-review',
  component: 'UserMessage',
  surface: 'desktop',
  viewport: { columns: 120, rows: 40 },
} as const

async function message($: any, text: string, extra: any = {}) {
  return $.ui.mount({ ...MESSAGE, ...extra, props: { text, isExpanded: true, origin: { kind: 'composer' }, ...(extra.props ?? {}) } })
}

test('聊天记录：回复消息画成同样的圆角列表（reply-msg 里包 reply-list），你写的话在下面，原始格式文字不出现', async ($, on) => {
  stub(on)
  await boot($)
  const ui = await message($, withReplies('这几处改一下', replyGroups(3), 'zh', '/proj'))
  expect(await ui.find({ key: 'reply-msg' })).toBeDefined()
  expect((await ui.find({ key: 'reply-list' }))?.props.borderStyle).toBeUndefined()
  expect(await ui.find({ key: 'rim:top' })).toBeDefined()
  expect(await ui.find({ key: 'rim:bottom' })).toBeUndefined()
  // 右边框每行都宽 RADIUS（× 那一格各行对齐）：最后一行带右下圆角，中间的行竖线贴右边
  expect((await ui.find({ key: 'r:n3:r' }))?.children[0].props.width).toBe(6)
  expect((await ui.find({ key: 'r:n2:r' }))?.children[0].props.width).toBe(6)
  expect((await ui.find({ key: 'r:n2:r' }))?.children[0].props.source).toContain('<rect x="5" y="0" width="1" height="28" class="edge"/>')
  expect(await titleOf(ui)).toBe('3 条回复')
  expect(await docRows(ui)).toEqual(['改名清单', '行程'])
  expect(await rowIds(ui)).toEqual(['n1', 'n2', 'n3'])
  expect(svgAlts(await ui.find({ key: 'r:n1:art' }))).toEqual(['1 原文1 回复1'])
  // 编号按文档分组后的顺序：改名清单的两条是 1、2，行程的是 3
  expect(svgAlts(await ui.find({ key: 'r:n2:art' }))).toEqual(['2 原文3 回复3'])
  expect(svgAlts(await ui.find({ key: 'r:n3:art' }))).toEqual(['3 原文2 回复2'])
  // 聊天记录里不折叠：reply-msg 里包 reply-list，列表里是标题行、文档名行和每条回复
  const list: any = await ui.find({ key: 'reply-list' })
  expect(list.children.map((c: any) => c.props.key)).toEqual(['rim:top', 'head', 'gap:head', 'line:doc:0', 'doc:0', 'line:r:n1', 'r:n1', 'line:r:n2', 'r:n2', 'line:doc:1', 'doc:1', 'line:r:n3', 'r:n3'])
  // 聊天记录里的列表没有按钮、没有 ×
  expect(await labels(ui)).toEqual([])
  expect((await ui.findAll({ type: 'Box' })).filter((n: any) => n.props.display === 'none')).toHaveLength(0)
  // 也没有悬停变色
  expect((await inList(ui, 'r:n1')).hover).toBeUndefined()
  expect(walk(await ui.find({ key: 'reply-list' })).filter(n => n.hover !== undefined)).toHaveLength(0)
  expect(await textOf(ui, '这几处改一下')).toBeDefined()
  const drawn = allText(await ui.drawn())
  expect(drawn).not.toContain('<!-- reply')
  expect(drawn).not.toContain('[文档回复]')
  await ui.unmount()
})

test('聊天记录：只有一份文档时标题带文档名；只有回复块（点〔发送〕发的）时不画你写的话', async ($, on) => {
  stub(on)
  await boot($)
  const ui = await message($, withReplies('', oneDoc(1), 'zh', '/proj'))
  expect(await titleOf(ui)).toBe('1 条回复 · 改名清单')
  expect(await docRows(ui)).toEqual([])
  expect(allText(await ui.find({ key: 'reply-msg' }))).not.toContain('好')
  await ui.unmount()
})

test('聊天记录：6 条回复不折叠，全部列出', async ($, on) => {
  stub(on)
  await boot($)
  const ui = await message($, withReplies('好', replyGroups(6), 'zh', '/proj'))
  expect(await rowIds(ui)).toHaveLength(6)
  expect(await textOf(ui, '还有')).toBeUndefined()
  await ui.unmount()
})

test('聊天记录：折叠视图（isExpanded 为 false）是一行「N 条回复 · 你写的话的开头」；没写话时只有标题；英文消息用英文', async ($, on) => {
  stub(on)
  await boot($)
  let ui = await message($, withReplies('这几处改一下\n第二行', replyGroups(3), 'zh', '/proj'), { props: { isExpanded: false } })
  expect(allText(await ui.drawn())).toBe('3 条回复 · 这几处改一下')
  expect(await ui.find({ key: 'reply-list' })).toBeUndefined()
  await ui.unmount()
  ui = await message($, withReplies('', replyGroups(2), 'en', '/proj'), { props: { isExpanded: false } })
  expect(allText(await ui.drawn())).toBe('2 replies')
  await ui.unmount()
  ui = await message($, withReplies('fix it', oneDoc(1), 'en', '/proj'))
  expect(await titleOf(ui)).toBe('1 replies · 改名清单')
  await ui.unmount()
})

test('聊天记录：认不出的消息（普通消息、被改乱的回复块）交给下层', async ($, on) => {
  stub(on)
  await boot($)
  let ui = await message($, '随便说一句')
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  const broken = withReplies('看看', replyGroups(2), 'zh', '/proj').replace('<!-- reply 2 -->', '<!-- reply 9 -->')
  ui = await message($, broken)
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
  ui = await message($, '▎ 自己打的\n  不是回复', { props: { isExpanded: false } })
  expect(allText(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('聊天记录：不需要唤醒；终端里画同样的列表', async ($, on) => {
  const s = stub(on)
  await boot($)
  await s.clock.settle()
  const calls = s.ext.calls
  const ui = await message($, withReplies('好', replyGroups(2), 'zh', '/proj'), { surface: 'terminal' })
  expect(await titleOf(ui)).toBe('2 条回复')
  expect(await rowIds(ui)).toEqual(['n1', 'n2'])
  // 终端没有图：编号、「│ 原文」、回复都是文字
  expect(walk(await ui.find({ key: 'reply-list' })).filter(x => x.type === 'Svg')).toHaveLength(0)
  expect((await ui.find({ key: 'r:n1:no' }))?.text).toBe('1')
  expect((await ui.find({ key: 'r:n1:q' }))?.text).toBe('│ 原文1')
  expect((await ui.find({ key: 'r:n1:b' }))?.text).toBe('回复1')
  expect(await textOf(ui, '好')).toBeDefined()
  expect(s.ext.calls).toBe(calls)
  await ui.unmount()
})

test('聊天记录：回车发出的消息（你的话 + 回复块）在聊天记录里认得出', async ($, on) => {
  const s = stub(on, { replies: replyGroups(3) })
  await bootAwake($, s)
  await tick(s.clock)
  await userSays($, '这几处改一下')
  await s.clock.settle()
  const ui = await message($, s.prompts.at(-1)!.text)
  expect(await titleOf(ui)).toBe('3 条回复')
  expect(await rowIds(ui)).toEqual(['n1', 'n2', 'n3'])
  expect(await textOf(ui, '这几处改一下')).toBeDefined()
  await ui.unmount()
})

test('聊天记录：桌面版显示的是你打的原文（不带回复块）时，按发送时记下的完整消息画回复卡片', async ($, on) => {
  const s = stub(on, { replies: replyGroups(3) })
  await bootAwake($, s)
  await tick(s.clock)
  await userSays($, '  这几处改一下 ')
  await s.clock.settle()
  const ui = await message($, '这几处改一下')
  expect(await titleOf(ui)).toBe('3 条回复')
  expect(await rowIds(ui)).toEqual(['n1', 'n2', 'n3'])
  expect(await textOf(ui, '这几处改一下')).toBeDefined()
  await ui.unmount()
  // 没带过回复的普通消息照旧交给下层
  const plain = await message($, '随便说一句')
  expect(await plain.find({ key: 'reply-msg' })).toBeUndefined()
  await plain.unmount()
})

test('回复区：桌面版每行的回复用桌面版文字（按行宽截断加「…」），底下垫一像素的图；最后一行画外框下沿', async ($, on) => {
  const s = stub(on, { replies: [{ doc: 'd1', path: '/proj/docs/改名清单.md', replies: [{ id: 'c_1', no: 1, quote: '原文', body: '第一行\n第二行', createdAt: '2026-10-19T00:00:00Z' }, { id: 'c_2', no: 2, quote: '原文2', body: '好', createdAt: '2026-10-19T00:01:00Z' }] }] })
  const ui = await bandWithReplies($, s)
  const body = await ui.find({ key: 'r:c_1:b' })
  expect(body.props).toMatchObject({ flexGrow: 1, flexDirection: 'column' })
  // 上下居中、靠左（× 出现时文字不动）
  expect(body.children[0].props).toMatchObject({ flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start' })
  expect(body.children[0].children[0]).toMatchObject({ type: 'Text', props: { bold: true, wrap: 'truncate-end' } })
  expect(body.children[0].children[0].children).toEqual(['第一行 第二行'])
  expect(body.children[1].children[0].props.source.includes('<rect')).toBe(false)
  expect((await ui.find({ key: 'r:c_2:b' })).children[1].children[0].props.source.includes('<rect')).toBe(true)
  await ui.unmount()
})

test('聊天记录：桌面版在按回车那一刻就画了这条消息（还没记下完整内容），记下后重画成回复卡片', async ($, on) => {
  const s = stub(on, { replies: replyGroups(2) })
  await bootAwake($, s)
  await tick(s.clock)
  const ui = await message($, '这两处帮我看看')
  expect(await ui.find({ key: 'reply-msg' })).toBeUndefined()
  await userSays($, '这两处帮我看看')
  await s.clock.settle()
  expect(await titleOf(ui)).toBe('2 条回复')
  await ui.unmount()
})
