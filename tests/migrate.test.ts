import { expect, test } from 'claude-code/testing'

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

test('旧数据目录是 ~/.claude/doc-review', async () => {
  expect(legacyDataDirOf('/home/x')).toBe('/home/x/.claude/doc-review')
})

test('只有旧目录存在且新目录没有 docs 时才复制', async () => {
  expect(shouldCopyLegacy({ hasLegacyDir: true, hasNewDocs: false })).toBe(true)
  expect(shouldCopyLegacy({ hasLegacyDir: true, hasNewDocs: true })).toBe(false)
  expect(shouldCopyLegacy({ hasLegacyDir: false, hasNewDocs: false })).toBe(false)
  expect(shouldCopyLegacy({ hasLegacyDir: false, hasNewDocs: true })).toBe(false)
})

test('复制命令只带 docs 和 outbox，路径作为参数传入而不拼进脚本', async () => {
  const argv = copyLegacyArgv('/home/a b/.claude/doc-review', '/home/a b/.claude/cc-doc-review')
  expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(argv.slice(3)).toEqual(['sh', '/home/a b/.claude/doc-review', '/home/a b/.claude/cc-doc-review'])
  expect(argv[2]).toContain('docs outbox')
  expect(argv[2]).not.toContain('a b')
  expect(argv[2]).not.toContain('server.json')
})

test('旧服务 health 的名字必须是 doc-review，新名字和失败应答都不算', async () => {
  expect(isLegacyHealthy({ ok: true, text: '{"name":"doc-review","version":"0.1.0"}' })).toBe(true)
  expect(isLegacyHealthy({ ok: true, text: '{"name":"cc-doc-review"}' })).toBe(false)
  expect(isLegacyHealthy({ ok: false, text: '{"name":"doc-review"}' })).toBe(false)
  expect(isLegacyHealthy({ ok: true, text: 'not json' })).toBe(false)
})

test('从旧 server.json 取进程号：必须是大于 1 的整数', async () => {
  expect(legacyServerPid('{"port":4823,"token":"t","pid":4242}')).toBe(4242)
  expect(legacyServerPid('{"port":4823,"token":"t","pid":1}')).toBeUndefined()
  expect(legacyServerPid('{"port":4823,"token":"t","pid":"4242"}')).toBeUndefined()
  expect(legacyServerPid('{"port":4823,"token":"t"}')).toBeUndefined()
  expect(legacyServerPid('坏的')).toBeUndefined()
})

test('结束进程前核对命令行，确认它是旧版评审服务', async () => {
  expect(psArgv(4242)).toEqual(['ps', '-p', '4242', '-o', 'command='])
  expect(killArgv(4242)).toEqual(['kill', '4242'])
  expect(isLegacyCommand('/x/doc-review/bin/doc-review-server -dir /y\n')).toBe(true)
  // 新版的程序名也含 doc-review-server，不能误杀
  expect(isLegacyCommand('/x/bin/cc-doc-review-server\n')).toBe(false)
  expect(isLegacyCommand('/usr/bin/node app.js')).toBe(false)
  expect(isLegacyCommand('')).toBe(false)
})
