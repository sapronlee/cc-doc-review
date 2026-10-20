// 文档服务客户端里不碰 $ 的部分。引擎不允许把 $ 传进 import 来的函数，
// 所以真正调 $ 的 ensureServer / call 写在 hooks/register.js 里。

/** @typedef {{ port: number, token: string, pid: number }} ServerInfo */

/** 数据目录，server.json 和 server.log 都在这里。@param {string} home */
export function dataDirOf(home) {
  return `${home}/.claude/cc-doc-review`
}

/**
 * 文档页链接，拼法与服务端 /api/open 返回的一致，再带上界面文字用哪套（lang）。
 * @param {{ port: number, token: string }} info @param {string} docId @param {string} [lang]
 */
export function reviewUrl(info, docId, lang) {
  const base = `http://127.0.0.1:${info.port}/review?doc=${encodeURIComponent(docId)}&t=${encodeURIComponent(info.token)}`
  return lang ? `${base}&lang=${encodeURIComponent(lang)}` : base
}

/** 给服务端返回的文档页链接加上 lang。@param {string} url @param {string} lang */
export function withLang(url, lang) {
  return /[?&]lang=/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}lang=${encodeURIComponent(lang)}`
}

/** 解析 server.json；内容不对就当没有。@param {string} text @returns {ServerInfo | undefined} */
export function parseInfo(text) {
  try {
    const info = JSON.parse(text)
    return info && typeof info.port === 'number' && typeof info.token === 'string' ? info : undefined
  } catch {
    return undefined
  }
}

/** 健康检查的应答是不是本插件的服务。@param {{ ok: boolean, text: string }} r */
export function isHealthy(r) {
  try {
    return r.ok && JSON.parse(r.text).name === 'cc-doc-review'
  } catch {
    return false
  }
}

/**
 * 后台启动服务的命令：nohup 加 & 让它脱离会话。
 * 只把 nohup 那一条放进后台，且标准输入输出全部改向，sh 才能立刻退出、不占住调用方的管道。
 * @param {string} bin @param {string} log
 */
export function startArgv(bin, log) {
  return ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")"; nohup "$0" >>"$1" 2>&1 </dev/null &', bin, log]
}

/** 取接口应答里的数据；非 2xx 时抛出服务端给的原因，应答不是 JSON 时报 HTTP 状态码。@param {{ ok: boolean, status: number, text: string }} r */
export function parseReply(r) {
  let data
  try {
    data = r.text ? JSON.parse(r.text) : {}
  } catch {
    throw new Error(r.ok ? `应答不是合法的 JSON（HTTP ${r.status}）` : `HTTP ${r.status}`)
  }
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
  return data
}

/** @param {unknown} err */
export function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
