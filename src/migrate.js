// 旧版（插件名 doc-review）数据迁移里不碰 $ 的部分。
// 文件和进程操作写在 hooks/register.js 里（引擎不允许把 $ 传进 import 来的函数）。
import { parseInfo } from './client.js'

/** 旧版数据目录。@param {string} home */
export function legacyDataDirOf(home) {
  return `${home}/.claude/doc-review`
}

/**
 * 是否需要把旧数据复制过来：旧目录存在，且新目录里还没有 docs（有了就不覆盖）。
 * @param {{ hasLegacyDir: boolean, hasNewDocs: boolean }} s
 */
export function shouldCopyLegacy({ hasLegacyDir, hasNewDocs }) {
  return hasLegacyDir && !hasNewDocs
}

/**
 * 把旧目录的 docs、outbox 复制到新目录的命令。路径作为参数传入（$1 旧目录、$2 新目录），不拼进脚本。
 * 用 `/.` 把内容合并进目标目录，目标已有同名目录时也不会多套一层。
 * @param {string} oldDir @param {string} newDir
 */
export function copyLegacyArgv(oldDir, newDir) {
  const script =
    'mkdir -p "$2" || exit 1; for d in docs outbox; do if [ -d "$1/$d" ]; then mkdir -p "$2/$d" && cp -R "$1/$d/." "$2/$d/" || exit 1; fi; done'
  return ['/bin/sh', '-c', script, 'sh', oldDir, newDir]
}

/** 旧服务的健康检查应答：名字必须是 doc-review。@param {{ ok: boolean, text: string }} r */
export function isLegacyHealthy(r) {
  try {
    return r.ok && JSON.parse(r.text).name === 'doc-review'
  } catch {
    return false
  }
}

/** 从旧 server.json 取进程号：必须是大于 1 的整数，否则当没有。@param {string} text @returns {number | undefined} */
export function legacyServerPid(text) {
  const pid = /** @type {any} */ (parseInfo(text))?.pid
  return Number.isInteger(pid) && pid > 1 ? pid : undefined
}

/** 取进程命令行的命令。@param {number} pid */
export function psArgv(pid) {
  return ['ps', '-p', String(pid), '-o', 'command=']
}

/** 结束进程的命令（SIGTERM）。@param {number} pid */
export function killArgv(pid) {
  return ['kill', String(pid)]
}

/**
 * 进程命令行是不是旧版评审服务（程序名 doc-review-server）。
 * 新版叫 cc-doc-review-server，不能误杀。
 * @param {string} command
 */
export function isLegacyCommand(command) {
  return /(^|[\s/])doc-review-server(\s|$)/.test(command.trim())
}
