import { expect, test } from 'claude-code/testing'

import { ago, dirOf, displayName, markdownLink, shortName } from '../src/bandview.js'

test('目录：工作目录下显示相对目录，根目录显示 ./，其他显示绝对目录', () => {
  expect(dirOf('/proj/docs/superpowers/plan.md', '/proj')).toBe('docs/superpowers/')
  expect(dirOf('/proj/plan.md', '/proj/')).toBe('./')
  expect(dirOf('/tmp/demo/a.html', '/proj')).toBe('/tmp/demo/')
  expect(dirOf('/projx/a.md', '/proj')).toBe('/projx/')
  expect(dirOf('/tmp/a.md', '')).toBe('/tmp/')
})

test('相对时间：刚刚、分钟、小时、天；时间无效时为空', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  expect(ago('2026-10-11T11:59:30Z', now)).toBe('刚刚')
  expect(ago('2026-10-11T11:58:00Z', now)).toBe('2 分钟前')
  expect(ago('2026-10-11T09:00:00Z', now)).toBe('3 小时前')
  expect(ago('2026-10-09T12:00:00Z', now)).toBe('2 天前')
  expect(ago(undefined, now)).toBe('')
  expect(ago('不是时间', now)).toBe('')
})

test('文件名去掉扩展名，以点开头的名字保持原样', () => {
  expect(shortName('/a/上线评估报告.html')).toBe('上线评估报告')
  expect(shortName('/a/.env')).toBe('.env')
})

test('单行文件名：去掉扩展名和日期前缀，过长截断，中日韩字符按两格算', () => {
  expect(displayName('/a/2026-10-11-plugin-release-design.md')).toBe('plugin-release-de…')
  expect(displayName('/a/2026-10-11-api-design.md')).toBe('api-design')
  expect(displayName('/a/2026-10-11-a-very-long-document-name-here.md')).toBe('a-very-long-docum…')
  expect(displayName('/a/上线评估报告.html')).toBe('上线评估报告')
  expect(displayName('/a/一二三四五六七八九十十一十二.md')).toBe('一二三四五六七八…')
  expect(displayName('/a/2026-10-11.md')).toBe('2026-10-11')
})

test('markdownLink：文件名里的括号和反斜杠转义，不截断链接', () => {
  expect(markdownLink('plan', 'http://x/?a=1')).toBe('[plan](http://x/?a=1)')
  expect(markdownLink('a[1](2)\\b', 'u')).toBe('[a\\[1\\]\\(2\\)\\\\b](u)')
})
