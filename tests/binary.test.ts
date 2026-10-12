import { expect, test } from 'claude-code/testing'

import {
  assetName,
  binPathOf,
  compareSemver,
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

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

test('platformOf：识别 macOS 和 Linux 的两种芯片，其余不支持', async () => {
  expect(platformOf('Darwin arm64\n')).toEqual({ os: 'darwin', arch: 'arm64' })
  expect(platformOf('Darwin x86_64')).toEqual({ os: 'darwin', arch: 'amd64' })
  expect(platformOf('Linux x86_64')).toEqual({ os: 'linux', arch: 'amd64' })
  expect(platformOf('Linux aarch64')).toEqual({ os: 'linux', arch: 'arm64' })
  expect(platformOf('Linux arm64')).toEqual({ os: 'linux', arch: 'arm64' })
  expect(platformOf('Linux riscv64')).toBeUndefined()
  expect(platformOf('FreeBSD amd64')).toBeUndefined()
  expect(platformOf('MINGW64_NT-10.0 x86_64')).toBeUndefined()
  expect(platformOf('')).toBeUndefined()
})

test('assetName 与 releaseUrl 拼出 Release 里的文件名和下载地址', async () => {
  expect(assetName({ os: 'darwin', arch: 'arm64' })).toBe('cc-doc-review-server-darwin-arm64')
  expect(releaseUrl('0.2.0', 'SHA256SUMS')).toBe(
    'https://github.com/sapronlee/CC-Doc-Review/releases/download/v0.2.0/SHA256SUMS',
  )
})

test('binPathOf：按插件版本放在数据目录的 bin 下', async () => {
  expect(binPathOf('/home/x', '0.2.0')).toBe('/home/x/.claude/cc-doc-review/bin/cc-doc-review-server-0.2.0')
})

test('versionOf：取 plugin.json 的版本号，格式不对当没有', async () => {
  expect(versionOf('{"name":"x","version":"0.2.0"}')).toBe('0.2.0')
  expect(versionOf('{"version":"1.0.0-rc.1"}')).toBe('1.0.0-rc.1')
  expect(versionOf('{"name":"x"}')).toBeUndefined()
  expect(versionOf('{"version":"../../etc"}')).toBeUndefined()
  expect(versionOf('{"version":"1.0 --evil"}')).toBeUndefined()
  expect(versionOf('{"version":2}')).toBeUndefined()
  expect(versionOf('not json')).toBeUndefined()
})

test('expectedSha：从 SHA256SUMS 里按文件名取校验值（兼容二进制模式的星号）', async () => {
  const sums = [
    `${HASH}  cc-doc-review-server-darwin-arm64`,
    `${OTHER.toUpperCase()} *cc-doc-review-server-linux-amd64`,
    `${HASH}  cc-doc-review-server-darwin-arm64.sig`,
    '',
  ].join('\n')
  expect(expectedSha(sums, 'cc-doc-review-server-darwin-arm64')).toBe(HASH)
  expect(expectedSha(sums, 'cc-doc-review-server-linux-amd64')).toBe(OTHER)
  expect(expectedSha(sums, 'cc-doc-review-server-linux-arm64')).toBeUndefined()
  expect(expectedSha('zzz  cc-doc-review-server-darwin-arm64', 'cc-doc-review-server-darwin-arm64')).toBeUndefined()
  expect(expectedSha(sums.replace(/\n/g, '\r\n'), 'cc-doc-review-server-darwin-arm64')).toBe(HASH)
})

test('parseSha256：取 shasum / sha256sum 输出的第一列', async () => {
  expect(parseSha256(`${HASH}  /tmp/x\n`)).toBe(HASH)
  expect(parseSha256(`${OTHER.toUpperCase()} *x`)).toBe(OTHER)
  expect(parseSha256('shasum: command not found')).toBeUndefined()
  expect(parseSha256('')).toBeUndefined()
})

test('下载、校验、收尾、清理的命令都以参数传入路径', async () => {
  expect(curlArgv('https://h/x', '/d/x.part')).toEqual([
    'curl', '-fsSL', '--create-dirs', '--connect-timeout', '15', '--max-time', '120', '-o', '/d/x.part', 'https://h/x',
  ])
  const sha = sha256Argv('/d/x.part')
  expect(sha[0]).toBe('/bin/sh')
  expect(sha[2]).toContain('shasum -a 256')
  expect(sha[2]).toContain('sha256sum')
  expect(sha.slice(3)).toEqual(['sh', '/d/x.part'])
  const fin = finalizeArgv('/d/x.part', '/d/x')
  expect(fin.slice(3)).toEqual(['sh', '/d/x.part', '/d/x'])
  expect(fin[2]).toContain('chmod +x "$1"')
  expect(fin[2]).toContain('mv -f "$1" "$2"')
  expect(removeArgv('/d/a', '/d/b')).toEqual(['rm', '-f', '/d/a', '/d/b'])
})

test('goProbeArgv 与 goBuildArgv：在登录 shell 里找 Go 和本地编译，路径和版本作为参数', async () => {
  expect(goProbeArgv('/bin/zsh')).toEqual(['/bin/zsh', '-lc', 'command -v go'])
  const dest = '/home/x/.claude/cc-doc-review/bin/cc-doc-review-server-0.2.0'
  const build = goBuildArgv('/bin/bash', '/plug', '0.2.0', `${dest}.build-1`, dest)
  expect(build.slice(0, 2)).toEqual(['/bin/bash', '-lc'])
  expect(build.slice(3)).toEqual(['/plug', '0.2.0', `${dest}.build-1`, dest])
  expect(build[2]).toContain('go build -trimpath')
  expect(build[2]).toContain('-X main.version=$1')
  expect(build[2]).toContain('cd "$0/server"')
  // 先编译到临时文件再改名，编译中断不会留下半个程序
  expect(build[2]).toContain('-o "$2"')
  expect(build[2]).toContain('mv -f "$2" "$3"')
})

test('healthVersion：取 health 应答里的版本号', async () => {
  expect(healthVersion({ ok: true, text: '{"name":"cc-doc-review","version":"0.2.0"}' })).toBe('0.2.0')
  expect(healthVersion({ ok: true, text: '{"name":"cc-doc-review"}' })).toBeUndefined()
  expect(healthVersion({ ok: true, text: 'x' })).toBeUndefined()
})

test('compareSemver：按 major.minor.patch 比较，预发布版低于正式版，忽略构建元数据', async () => {
  expect(compareSemver('0.2.0', '0.1.9')).toBeGreaterThan(0)
  expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0)
  expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0)
  expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0)
  expect(compareSemver('0.2.0', '0.2.0')).toBe(0)
  expect(compareSemver('0.2.0-rc.1', '0.2.0')).toBeLessThan(0)
  expect(compareSemver('0.2.0', '0.2.0-rc.1')).toBeGreaterThan(0)
  expect(compareSemver('0.2.0-rc.1', '0.2.0-rc.2')).toBeLessThan(0)
  expect(compareSemver('0.2.0-rc.2', '0.2.0-rc.10')).toBeLessThan(0)
  expect(compareSemver('0.2.0-alpha', '0.2.0-alpha.1')).toBeLessThan(0)
  expect(compareSemver('0.2.0+build.5', '0.2.0+build.9')).toBe(0)
  expect(compareSemver('dev', '0.2.0')).toBeUndefined()
  expect(compareSemver('0.2.0', 'dev')).toBeUndefined()
  expect(compareSemver('0.2', '0.2.0')).toBeUndefined()
})

test('needsRestart：只有非开发模式且服务版本没有或严格低于插件版本才重启，绝不降级', async () => {
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: '0.1.0' })).toBe(true)
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: '0.1.9+abc' })).toBe(true)
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: '0.2.0-rc.1' })).toBe(true)
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: undefined })).toBe(true)
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: '0.2.0' })).toBe(false)
  // 服务比插件新（旧会话还在用旧插件）：不降级
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: '0.3.0' })).toBe(false)
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: '0.2.1' })).toBe(false)
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0-rc.1', serverVersion: '0.2.0' })).toBe(false)
  // 版本号解析不了：不动它
  expect(needsRestart({ isDev: false, pluginVersion: '0.2.0', serverVersion: 'dev' })).toBe(false)
  expect(needsRestart({ isDev: false, pluginVersion: 'dev', serverVersion: '0.1.0' })).toBe(false)
  expect(needsRestart({ isDev: true, pluginVersion: '0.2.0', serverVersion: '0.1.0' })).toBe(false)
  expect(needsRestart({ isDev: false, pluginVersion: undefined, serverVersion: '0.1.0' })).toBe(false)
})

test('serverPid 与 isServerCommand：只认大于 1 的进程号和新版服务的命令行', async () => {
  expect(serverPid({ port: 1, token: 't', pid: 4242 })).toBe(4242)
  expect(serverPid({ port: 1, token: 't', pid: 1 })).toBeUndefined()
  expect(serverPid({ port: 1, token: 't' })).toBeUndefined()
  expect(isServerCommand('/home/x/.claude/cc-doc-review/bin/cc-doc-review-server-0.2.0\n')).toBe(true)
  expect(isServerCommand('/plug/bin/cc-doc-review-server -dir /tmp/x')).toBe(true)
  expect(isServerCommand('/old/bin/doc-review-server')).toBe(false)
  expect(isServerCommand('/usr/bin/node app.js')).toBe(false)
  expect(isServerCommand('vim cc-doc-review-server.go')).toBe(false)
})
