// 服务程序的预编译分发里不碰 $ 的部分：平台判定、下载地址、校验值解析、各条命令的参数、版本比较。
// 下载、校验、重启的流程写在 hooks/register.js 里（引擎不允许把 $ 传进 import 来的函数）。
import { dataDirOf } from './client.js'

/** 发布程序的 GitHub 仓库。*/
const REPO = 'sapronlee/cc-doc-review'
/** 版本号的合法格式：进下载地址、文件名和命令参数前先过一遍。*/
const VERSION_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/
const SHA_RE = /\b[0-9a-fA-F]{64}\b/

/** @typedef {{ os: 'darwin' | 'linux', arch: 'amd64' | 'arm64' }} Platform */

/**
 * 由 `uname -sm` 的输出判定平台；不是 macOS / Linux 的 amd64、arm64 就返回 undefined。
 * @param {string} uname @returns {Platform | undefined}
 */
export function platformOf(uname) {
  const [sys, machine] = uname.trim().split(/\s+/)
  const os = sys === 'Darwin' ? 'darwin' : sys === 'Linux' ? 'linux' : undefined
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'amd64' : machine === 'arm64' || machine === 'aarch64' ? 'arm64' : undefined
  return os && arch ? { os, arch } : undefined
}

/** Release 里该平台的程序文件名。@param {Platform} p */
export function assetName(p) {
  return `cc-doc-review-server-${p.os}-${p.arch}`
}

/** 某个版本的 Release 里一个文件的下载地址（标签为 v<版本>）。@param {string} version @param {string} file */
export function releaseUrl(version, file) {
  return `https://github.com/${REPO}/releases/download/v${version}/${file}`
}

/** 本地保存的程序路径，按版本区分：~/.claude/cc-doc-review/bin/cc-doc-review-server-<版本>。@param {string} home @param {string} version */
export function binPathOf(home, version) {
  return `${dataDirOf(home)}/bin/cc-doc-review-server-${version}`
}

/** 取 plugin.json 里的版本号；缺失或格式不对（会进路径和命令）当没有。@param {string} text @returns {string | undefined} */
export function versionOf(text) {
  try {
    const v = JSON.parse(text)?.version
    return typeof v === 'string' && VERSION_RE.test(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** 从 SHA256SUMS 里取某个文件的校验值（小写）；找不到或格式不对返回 undefined。@param {string} sums @param {string} name */
export function expectedSha(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (m && m[2] === name) return m[1].toLowerCase()
  }
  return undefined
}

/** 取 shasum / sha256sum 输出里的校验值（小写）。@param {string} out */
export function parseSha256(out) {
  return SHA_RE.exec(out)?.[0].toLowerCase()
}

/** 下载一个文件的命令；--create-dirs 让目标目录不存在时自动建。@param {string} url @param {string} dest */
export function curlArgv(url, dest) {
  return ['curl', '-fsSL', '--create-dirs', '--connect-timeout', '15', '--max-time', '120', '-o', dest, url]
}

/** 计算 SHA-256 的命令：macOS 用 shasum，没有就用 sha256sum（Linux）。@param {string} file */
export function sha256Argv(file) {
  const script = 'if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi'
  return ['/bin/sh', '-c', script, 'sh', file]
}

/** 校验通过后：加可执行权限并改名为正式路径。@param {string} part @param {string} dest */
export function finalizeArgv(part, dest) {
  return ['/bin/sh', '-c', 'chmod +x "$1" && mv -f "$1" "$2"', 'sh', part, dest]
}

/** @param {string[]} files */
export function removeArgv(...files) {
  return ['rm', '-f', ...files]
}

/** 在登录 shell 里找 Go（登录 shell 才有用户配置的 PATH）。@param {string} shell */
export function goProbeArgv(shell) {
  return [shell, '-lc', 'command -v go']
}

/**
 * 在登录 shell 里编译插件目录下的 server/ 到临时文件，再改名为目标路径，版本号用 -ldflags 注入。
 * 临时文件名由调用方保证唯一（多个会话同时编译互不干扰），编译中断不会留下半个程序。
 * 路径和版本都作为参数（$0 插件目录、$1 版本、$2 临时文件、$3 目标）。
 * @param {string} shell @param {string} root @param {string} version @param {string} tmp @param {string} dest
 */
export function goBuildArgv(shell, root, version, tmp, dest) {
  const script =
    'mkdir -p "$(dirname "$3")" && cd "$0/server" && go build -trimpath -ldflags "-s -w -X main.version=$1" -o "$2" . && chmod +x "$2" && mv -f "$2" "$3"'
  return [shell, '-lc', script, root, version, tmp, dest]
}

/** health 应答里的服务版本号。@param {{ text: string }} r @returns {string | undefined} */
export function healthVersion(r) {
  try {
    const v = JSON.parse(r.text).version
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** 比较两个预发布段（按 semver：纯数字按数值比，数字低于字母，短的低于长的）。@param {string[]} a @param {string[]} b */
function comparePre(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i])
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (an !== bn) return an ? -1 : 1
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * 比较两个 major.minor.patch 版本号：预发布版低于同号的正式版，构建元数据忽略。
 * 任何一个解析不了（如 "dev"）返回 undefined。
 * @param {string} a @param {string} b @returns {number | undefined} 负数 a 低、0 相同、正数 a 高
 */
export function compareSemver(a, b) {
  const ma = SEMVER_RE.exec(a)
  const mb = SEMVER_RE.exec(b)
  if (!ma || !mb) return undefined
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d !== 0) return d
  }
  if (ma[4] === undefined && mb[4] === undefined) return 0
  if (ma[4] === undefined) return 1
  if (mb[4] === undefined) return -1
  return comparePre(ma[4].split('.'), mb[4].split('.'))
}

/**
 * 运行中的服务要不要换成插件对应的版本：开发模式（用插件目录下自己编译的程序）不自动重启；
 * 读不到插件版本时也不动它。只升级、不降级：服务没报版本号，或版本号能解析且严格低于插件版本才重启；
 * 服务比插件新（旧会话还加载着旧插件）、版本相同、任一方解析不了（如 "dev"）都不动，
 * 免得新旧两个版本互相替换、每次换都轮换令牌让打开的评审页失效。
 * @param {{ isDev: boolean, pluginVersion: string | undefined, serverVersion: string | undefined }} s
 */
export function needsRestart({ isDev, pluginVersion, serverVersion }) {
  if (isDev || pluginVersion === undefined) return false
  if (serverVersion === undefined) return true
  const cmp = compareSemver(serverVersion, pluginVersion)
  return cmp !== undefined && cmp < 0
}

/** server.json 里的进程号：必须是大于 1 的整数，否则当没有。@param {{ pid?: unknown }} info @returns {number | undefined} */
export function serverPid(info) {
  const pid = info.pid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : undefined
}

/** 进程命令行是不是新版文档服务（程序名 cc-doc-review-server，带不带版本后缀都算）；旧版 doc-review-server 不算。@param {string} command */
export function isServerCommand(command) {
  return /(^|[\s/])cc-doc-review-server(-[0-9A-Za-z.+-]+)?(\s|$)/.test(command.trim())
}
