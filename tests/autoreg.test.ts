import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  autoRegisterConfig,
  isMainLoopSuccess,
  isReviewDoc,
  matchGlob,
  splitPatterns,
} from '../src/autoreg.js'

const cfg = autoRegisterConfig({})

test('glob：** 能匹配零层和多层目录', () => {
  expect(matchGlob('**/docs/*.md', 'docs/a.md')).toBe(true)
  expect(matchGlob('**/docs/*.md', 'x/docs/a.md')).toBe(true)
  expect(matchGlob('**/docs/*.md', 'x/y/z/docs/a.md')).toBe(true)
  expect(matchGlob('**/docs/*.md', 'docs/x/a.md')).toBe(false)
  expect(matchGlob('docs/**/*.md', 'docs/a.md')).toBe(true)
  expect(matchGlob('docs/**/*.md', 'docs/x/y/a.md')).toBe(true)
  expect(matchGlob('docs/**', 'docs/x/y/a.md')).toBe(true)
  expect(matchGlob('docs/**', 'other/a.md')).toBe(false)
  // ** 不在目录边界上时不当作零层目录
  expect(matchGlob('**/docs/*.md', 'mydocs/a.md')).toBe(false)
  expect(matchGlob('**/docs/*.md', 'a/mydocs/a.md')).toBe(false)
})

test('glob：* 和 ? 不跨目录', () => {
  expect(matchGlob('docs/*.md', 'docs/a.md')).toBe(true)
  expect(matchGlob('docs/*.md', 'docs/x/a.md')).toBe(false)
  expect(matchGlob('docs/*.md', 'docs/.md')).toBe(true)
  expect(matchGlob('docs/?.md', 'docs/a.md')).toBe(true)
  expect(matchGlob('docs/?.md', 'docs/ab.md')).toBe(false)
  expect(matchGlob('docs/?.md', 'docs//.md')).toBe(false)
  expect(matchGlob('**/README*', 'docs/README.zh.md')).toBe(true)
  expect(matchGlob('**/README*', 'README')).toBe(true)
})

test('glob：{a,b} 选一，可含 ** 和嵌套，点号等正则字符按字面', () => {
  expect(matchGlob('docs/*.{md,html}', 'docs/a.md')).toBe(true)
  expect(matchGlob('docs/*.{md,html}', 'docs/a.html')).toBe(true)
  expect(matchGlob('docs/*.{md,html}', 'docs/a.htm')).toBe(false)
  expect(matchGlob('{docs,specs}/**/*.md', 'specs/a/b.md')).toBe(true)
  expect(matchGlob('{docs,specs}/**/*.md', 'plans/a.md')).toBe(false)
  expect(matchGlob('docs/*.{md,{html,htm}}', 'docs/a.htm')).toBe(true)
  expect(matchGlob('docs/a.md', 'docs/aXmd')).toBe(false)
  expect(matchGlob('docs/(a)+.md', 'docs/(a)+.md')).toBe(true)
  // 括号没配对时按字面
  expect(matchGlob('docs/{a.md', 'docs/{a.md')).toBe(true)
})

test('glob：不区分大小写，路径和模式开头的 ./ 忽略', () => {
  expect(matchGlob('**/docs/*.md', 'Docs/a.md')).toBe(true)
  expect(matchGlob('**/docs/*.md', 'docs/a.MD')).toBe(true)
  expect(matchGlob('**/DOCS/*.MD', 'docs/a.md')).toBe(true)
  expect(matchGlob('**/docs/*.md', 'docs/a.txt')).toBe(false)
  expect(matchGlob('**/docs/*.md', './docs/a.md')).toBe(true)
  expect(matchGlob('./docs/*.md', 'docs/a.md')).toBe(true)
  expect(matchGlob('./docs/*.md', './docs/a.md')).toBe(true)
})

test('逗号分隔的模式串：大括号里的逗号不拆，去掉空白和空项', () => {
  expect(splitPatterns('**/a/*.{md,html}, **/b/*.md ,,')).toEqual(['**/a/*.{md,html}', '**/b/*.md'])
  expect(splitPatterns('')).toEqual([])
  expect(splitPatterns('   ')).toEqual([])
  expect(splitPatterns(undefined)).toEqual([])
  expect(splitPatterns(DEFAULT_INCLUDE).length).toBe(1)
  expect(splitPatterns(DEFAULT_EXCLUDE).length).toBe(17)
})

test('配置：缺省用默认值，字符串和开关按给定的来', () => {
  expect(autoRegisterConfig({})).toEqual({
    enabled: true,
    include: splitPatterns(DEFAULT_INCLUDE),
    exclude: splitPatterns(DEFAULT_EXCLUDE),
  })
  expect(autoRegisterConfig(undefined).enabled).toBe(true)
  const custom = autoRegisterConfig({ includePatterns: '**/notes/*.md, a.md', excludePatterns: '', autoRegister: false })
  expect(custom).toEqual({ enabled: false, include: ['**/notes/*.md', 'a.md'], exclude: [] })
  // 类型不对的值回到默认
  expect(autoRegisterConfig({ includePatterns: 3, excludePatterns: true, autoRegister: 'no' } as any)).toEqual(
    autoRegisterConfig({}),
  )
})

test('自动登记：默认收工作目录里所有 md、markdown、html、htm 文档', () => {
  expect(isReviewDoc('/proj/docs/superpowers/specs/2026-10-11-design.md', '/proj', cfg)).toBe(true)
  expect(isReviewDoc('/proj/specs/page.html', '/proj', cfg)).toBe(true)
  expect(isReviewDoc('/proj/plans/rollout.markdown', '/proj', cfg)).toBe(true)
  expect(isReviewDoc('/proj/src/notes.md', '/proj', cfg)).toBe(true)
  expect(isReviewDoc('/proj/report.htm', '/proj', cfg)).toBe(true)
  expect(isReviewDoc('/proj/docs.md', '/proj', cfg)).toBe(true)
  // 不是文档的不收
  expect(isReviewDoc('/proj/docs/notes.txt', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/src/a.ts', '/proj', cfg)).toBe(false)
  // 不区分大小写
  expect(isReviewDoc('/proj/Docs/page.HTML', '/proj', cfg)).toBe(true)
  expect(isReviewDoc('', '/proj', cfg)).toBe(false)
})

test('自动登记：默认排除优先于包含', () => {
  expect(isReviewDoc('/proj/docs/.superpowers/x.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/.superpowers/docs/x.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/node_modules/pkg/docs/x.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/README.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/README', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/readme.zh.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/claude.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/Node_Modules/x/docs/a.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/CHANGELOG.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/CLAUDE.md', '/proj', cfg)).toBe(false)
  for (const name of ['AGENTS.md', 'LICENSE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
    expect(isReviewDoc(`/proj/${name}`, '/proj', cfg)).toBe(false)
  }
  for (const dir of ['vendor', 'dist', '.git', '.claude', '.github', 'build', 'coverage']) {
    expect(isReviewDoc(`/proj/${dir}/docs/x.md`, '/proj', cfg)).toBe(false)
  }
  // 自定义时同样排除优先
  const own = autoRegisterConfig({ includePatterns: '**/*.md', excludePatterns: '**/draft/**' })
  expect(isReviewDoc('/proj/a/b.md', '/proj', own)).toBe(true)
  expect(isReviewDoc('/proj/a/draft/b.md', '/proj', own)).toBe(false)
})

test('自动登记只看工作目录内的相对路径', () => {
  // 工作目录外的不登记，哪怕路径里有 docs
  expect(isReviewDoc('/other/docs/x.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/projx/docs/x.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/../other/docs/x.md', '/proj', cfg)).toBe(false)
  // 只看工作目录内的相对路径：工作目录本身在 node_modules 下也照收
  expect(isReviewDoc('/home/node_modules/proj/notes.md', '/home/node_modules/proj', cfg)).toBe(true)
  expect(isReviewDoc('/home/docs/proj/specs/a.md', '/home/docs/proj/', cfg)).toBe(true)
  // 路径里的 ./ 段不影响匹配
  expect(isReviewDoc('/proj/./docs/x.md', '/proj', cfg)).toBe(true)
})

test('自动登记：自定义包含模式覆盖默认值，关掉开关一律不登记', () => {
  const own = autoRegisterConfig({ includePatterns: '**/notes/**/*.md, design.md' })
  expect(isReviewDoc('/proj/notes/a.md', '/proj', own)).toBe(true)
  expect(isReviewDoc('/proj/x/notes/y/a.md', '/proj', own)).toBe(true)
  expect(isReviewDoc('/proj/design.md', '/proj', own)).toBe(true)
  expect(isReviewDoc('/proj/docs/a.md', '/proj', own)).toBe(false)
  const off = autoRegisterConfig({ autoRegister: false })
  expect(isReviewDoc('/proj/docs/a.md', '/proj', off)).toBe(false)
  // 包含为空则什么都不登记
  expect(isReviewDoc('/proj/docs/a.md', '/proj', autoRegisterConfig({ includePatterns: '' }))).toBe(false)
})

test('glob：连续的 * 和 **/ 折叠，语义不变', () => {
  expect(matchGlob('docs/***/a.md', 'docs/x/y/a.md')).toBe(true)
  expect(matchGlob('docs/**/**/**/a.md', 'docs/a.md')).toBe(true)
  expect(matchGlob('docs/**/**/**/a.md', 'docs/x/y/a.md')).toBe(true)
  expect(matchGlob('a**b', 'a/x/b')).toBe(true)
  expect(matchGlob('a*b', 'a/x/b')).toBe(false)
})

test('glob：通配符超过 8 个的模式无效并被忽略', () => {
  const nine = '*a*a*a*a*a*a*a*a*b'
  const ok = '*a*a*a*a*a*a*a*b'
  expect(matchGlob(ok, 'aaaaaaaab')).toBe(true)
  expect(matchGlob(nine, 'aaaaaaaaab')).toBe(false)
  const own = autoRegisterConfig({ includePatterns: `${nine},**/*.md`, excludePatterns: nine })
  expect(isReviewDoc('/proj/aaaaaaaaab', '/proj', own)).toBe(false)
  // 无效的排除模式被忽略，不影响其他模式
  expect(isReviewDoc('/proj/x/a.md', '/proj', own)).toBe(true)
  // 大括号展开过多的模式同样无效
  const many = Array.from({ length: 7 }, () => '{a,b}').join('')
  expect(matchGlob(many, 'aaaaaaa')).toBe(false)
  expect(matchGlob('{a,b}{a,b}', 'ab')).toBe(true)
})

test('glob：病态模式不会回溯爆炸，各自 50ms 内返回', () => {
  const timed = (pattern: string, path: string) => {
    const t0 = performance.now()
    const r = matchGlob(pattern, path)
    return { r, ms: performance.now() - t0 }
  }
  const a = timed('**/a/**/a/**/a/**/a/**/a/**/a/**/b', 'a/'.repeat(60) + 'c')
  expect(a.r).toBe(false)
  expect(a.ms).toBeLessThan(50)
  const b = timed('*a*a*a*a*a*a*a*b', 'a'.repeat(60))
  expect(b.r).toBe(false)
  expect(b.ms).toBeLessThan(50)
  const c = timed('**/a/**/a/**/a/**/a/**/a/**/a/**/b', 'a/'.repeat(60) + 'b')
  expect(c.r).toBe(true)
  expect(c.ms).toBeLessThan(50)
})

test('文件名含换行也能被排除模式命中', () => {
  expect(matchGlob('**/README*', 'docs/README\nx.md')).toBe(true)
  expect(isReviewDoc('/proj/docs/README\nx.md', '/proj', cfg)).toBe(false)
  expect(isReviewDoc('/proj/docs/a\nb.md', '/proj', cfg)).toBe(true)
})

test('配置：autoRegister 的字符串 true / false（不区分大小写）按布尔处理', () => {
  for (const v of ['false', 'False', ' FALSE ']) expect(autoRegisterConfig({ autoRegister: v }).enabled).toBe(false)
  for (const v of ['true', 'TRUE']) expect(autoRegisterConfig({ autoRegister: v }).enabled).toBe(true)
  expect(autoRegisterConfig({ autoRegister: 'nope' }).enabled).toBe(true)
})

test('只认主对话里成功的写入：子代理、被拒、工具报错都不算', () => {
  expect(isMainLoopSuccess({}, { result: 'ok' } as any)).toBe(true)
  expect(isMainLoopSuccess({ agentId: 'agent-1' }, { result: 'ok' } as any)).toBe(false)
  expect(isMainLoopSuccess({}, { deny: '不许写' })).toBe(false)
  expect(isMainLoopSuccess({}, { isError: true })).toBe(false)
})
