// 自动登记评审文档：按可配置的 glob 模式匹配相对项目根的路径。纯函数，不碰引擎。

/** 默认的包含模式（逗号分隔），与 plugin.json userConfig.includePatterns 的默认值保持一致。*/
export const DEFAULT_INCLUDE =
  '**/*.{md,markdown,html,htm}'
/** 默认的排除模式（逗号分隔），与 plugin.json userConfig.excludePatterns 的默认值保持一致。*/
export const DEFAULT_EXCLUDE =
  '**/.superpowers/**,**/node_modules/**,**/vendor/**,**/dist/**,**/.git/**,**/.claude/**,**/README*,**/CHANGELOG*,**/CLAUDE.md,**/AGENTS.md,**/LICENSE*,**/CONTRIBUTING*,**/SECURITY*,**/CODE_OF_CONDUCT*,**/.github/**,**/build/**,**/coverage/**'

/** @typedef {{ enabled: boolean, include: string[], exclude: string[] }} AutoConfig */

/**
 * 这次写文件是否算数：主对话里（子代理的不算）、没被拒、工具没报错。
 * @param {{ agentId?: string }} call tool.call 的输入
 * @param {{ deny?: string, isError?: boolean }} result next(e) 的结果
 */
export function isMainLoopSuccess(call, result) {
  return !call.agentId && result.deny === undefined && !result.isError
}

/**
 * 把逗号分隔的模式串拆成数组：大括号里的逗号不拆，去掉首尾空白和空项。
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitPatterns(text) {
  if (typeof text !== 'string') return []
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(p => p.trim()).filter(Boolean)
}

/**
 * 布尔配置：真正的布尔直接用，字符串 "true" / "false"（不区分大小写）也认，其余回到默认值。
 * @param {unknown} v @param {boolean} dflt
 */
function toBool(v, dflt) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (t === 'true') return true
    if (t === 'false') return false
  }
  return dflt
}

/**
 * 读取插件配置（register 的 options），缺省或类型不对的字段回到默认值。
 * @param {Record<string, unknown> | undefined} options
 * @returns {AutoConfig}
 */
export function autoRegisterConfig(options) {
  const o = options ?? {}
  return {
    enabled: toBool(o.autoRegister, true),
    include: splitPatterns(typeof o.includePatterns === 'string' ? o.includePatterns : DEFAULT_INCLUDE),
    exclude: splitPatterns(typeof o.excludePatterns === 'string' ? o.excludePatterns : DEFAULT_EXCLUDE),
  }
}

/** 去掉开头的 ./（可重复）。*/
const stripDot = (/** @type {string} */ s) => s.replace(/^(?:\.\/)+/, '')

/** 单个模式里 * / ** 通配符的上限，超过的模式视为无效并忽略。*/
const MAX_WILDCARDS = 8
/** 一个模式展开 {a,b} 后的选项数上限，超过的模式视为无效。*/
const MAX_EXPANSIONS = 64

/**
 * 从 open（指向 '{'）起找配对的 '}'，同时按顶层逗号切分各选项。没有配对返回 undefined。
 * @param {string} p @param {number} open
 */
function parseBraces(p, open) {
  let depth = 0
  let start = open + 1
  /** @type {string[]} */
  const alts = []
  for (let i = open; i < p.length; i++) {
    const ch = p[i]
    if (ch === '\\') i++
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        alts.push(p.slice(start, i))
        return { alts, end: i }
      }
    } else if (ch === ',' && depth === 1) {
      alts.push(p.slice(start, i))
      start = i + 1
    }
  }
  return undefined
}

/**
 * 展开 {a,b}（可嵌套）。括号没配对的按字面，展开数超限返回 undefined。
 * @param {string} p
 * @returns {string[] | undefined}
 */
function expandBraces(p) {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') i++
    else if (p[i] === '{') {
      const group = parseBraces(p, i)
      if (!group) continue
      /** @type {string[]} */
      const out = []
      for (const alt of group.alts) {
        const sub = expandBraces(p.slice(0, i) + alt + p.slice(group.end + 1))
        if (!sub) return undefined
        out.push(...sub)
        if (out.length > MAX_EXPANSIONS) return undefined
      }
      return out
    }
  }
  return [p]
}

/**
 * 词元：字面字符 { c }、? 、* 、** 、**\/（可匹配零层或多层目录）。
 * @typedef {{ t: 'lit', c: string } | { t: 'one' | 'star' | 'any' | 'dirs' }} Token
 */

/**
 * 一个不含大括号的模式转词元。连续的 * 折叠成一个，连续的 **\/ 折叠成一个；
 * 字面字符转小写（匹配不区分大小写）。
 * @param {string} p @returns {Token[]}
 */
function tokenize(p) {
  /** @type {Token[]} */
  const out = []
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      let j = i
      while (p[j + 1] === '*') j++
      if (j === i) {
        out.push({ t: 'star' })
      } else if (p[j + 1] === '/' && (i === 0 || p[i - 1] === '/')) {
        // ** 后面紧跟 / 且在目录边界上：可匹配零层目录
        if (out[out.length - 1]?.t !== 'dirs') out.push({ t: 'dirs' })
        j++
      } else {
        out.push({ t: 'any' })
      }
      i = j
    } else if (ch === '?') {
      out.push({ t: 'one' })
    } else if (ch === '\\' && i + 1 < p.length) {
      out.push({ t: 'lit', c: p[++i].toLowerCase() })
    } else {
      out.push({ t: 'lit', c: ch.toLowerCase() })
    }
  }
  return out
}

/**
 * 模式编译成各展开选项的词元表；无效模式（通配符过多、展开过多）返回 null。
 * @param {string} pattern @returns {Token[][] | null}
 */
function compile(pattern) {
  const alts = expandBraces(stripDot(pattern))
  if (!alts) return null
  const compiled = alts.map(a => tokenize(a))
  if (compiled.some(t => t.filter(x => x.t !== 'lit' && x.t !== 'one').length > MAX_WILDCARDS)) return null
  return compiled
}

/**
 * 词元表是否匹配整条文本。按 (词元位置, 文本位置) 记忆化，耗时只与二者之积成正比，不会指数回溯。
 * @param {Token[]} tokens @param {string} text 已转小写
 */
function matchTokens(tokens, text) {
  const n = text.length
  const memo = new Int8Array((tokens.length + 1) * (n + 1)) // 0 未算，1 真，2 假
  /** @param {number} ti @param {number} si @returns {boolean} */
  const go = (ti, si) => {
    const key = ti * (n + 1) + si
    if (memo[key]) return memo[key] === 1
    const tok = tokens[ti]
    let ok = false
    if (!tok) ok = si === n
    else if (tok.t === 'lit') ok = si < n && text[si] === tok.c && go(ti + 1, si + 1)
    else if (tok.t === 'one') ok = si < n && text[si] !== '/' && go(ti + 1, si + 1)
    else if (tok.t === 'star') ok = go(ti + 1, si) || (si < n && text[si] !== '/' && go(ti, si + 1))
    else if (tok.t === 'any') ok = go(ti + 1, si) || (si < n && go(ti, si + 1))
    else {
      // dirs：零层，或吃掉一层目录（到下一个 / 为止）再继续
      const slash = text.indexOf('/', si)
      ok = go(ti + 1, si) || (slash >= 0 && go(ti, slash + 1))
    }
    memo[key] = ok ? 1 : 2
    return ok
  }
  return go(0, 0)
}

/** @type {Map<string, Token[][] | null>} */
const compiled = new Map()

/**
 * 相对路径是否匹配 glob 模式：不区分大小写，整条路径匹配，路径和模式开头的 ./ 忽略。
 * 支持 ** 、* 、? 、{a,b}；* 不跨 /，** 跨目录，**\/ 可匹配零层目录。
 * 通配符超过 8 个的模式视为无效，不匹配任何路径。
 * @param {string} pattern @param {string} relPath
 */
export function matchGlob(pattern, relPath) {
  let alts = compiled.get(pattern)
  if (alts === undefined) {
    alts = compile(pattern)
    compiled.set(pattern, alts)
  }
  if (!alts) return false
  const text = stripDot(relPath).toLowerCase()
  return alts.some(tokens => matchTokens(tokens, text))
}

/**
 * Write / Edit 写的文件是否该自动登记评审：开关打开、在工作目录内，
 * 相对工作目录的路径命中任一包含模式且不命中任何排除模式（排除优先）。
 * @param {string} path 绝对路径
 * @param {string} cwd 会话工作目录
 * @param {AutoConfig} config autoRegisterConfig 的结果
 */
export function isReviewDoc(path, cwd, config) {
  if (!config.enabled || !path || !cwd) return false
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (!path.startsWith(base)) return false
  const parts = path.slice(base.length).split('/').filter(p => p && p !== '.')
  if (parts.length === 0 || parts.includes('..')) return false
  const rel = parts.join('/')
  if (config.exclude.some(p => matchGlob(p, rel))) return false
  return config.include.some(p => matchGlob(p, rel))
}
