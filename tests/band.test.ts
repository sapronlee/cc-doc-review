import { expect, test } from 'claude-code/testing'

import {
  activeDocs,
  classifyDelivered,
  copyFailReason,
  nextReminder,
  reminderPrompt,
  reminderTitle,
} from '../src/band.js'
import {
  ago,
  dirOf,
  displayName,
  docDir,
  fitDocs,
  markdownLink,
  bandDocs,
  stateDescription,
  stateIcon,
  stateOf,
  MAX_ROWS,
  shortName,
  dividerLine,
  hasDrawnContent,
  visibleDocs,
} from '../src/bandview.js'

const doc = (id: string, o: any = {}) => {
  const drafts = o.drafts ?? 0
  const sent = o.sent ?? 0
  return { id, path: `/proj/docs/${id}.md`, open: drafts + sent, drafts, sent, activeAt: o.activeAt }
}

test('只算有未解决评论的文档', () => {
  expect(activeDocs([doc('a'), doc('b', { drafts: 1 })]).map(d => d.id)).toEqual(['b'])
  expect(activeDocs(undefined)).toEqual([])
})

test('提醒文案列出评论 ID 并要求逐条 review_resolve', () => {
  expect(reminderTitle(2)).toBe('⚠ 还有 2 条评论没回复处理结果')
  const text = reminderPrompt(['c_1', 'c_2'])
  expect(text).toContain('c_1、c_2')
  expect(text).toContain('review_resolve')
})

test('复制失败原因翻成中文，不认识的原样给出', () => {
  expect(copyFailReason('no-clipboard')).toContain('剪贴板')
  expect(copyFailReason('奇怪')).toBe('奇怪')
})

test('已送达评论：sent 算没回复；已解决、文档 404、评论不存在都算了结；文档没取到的算没查到', () => {
  const docOf = new Map([
    ['c_1', 'd1'],
    ['c_2', 'd1'],
    ['c_3', 'd1'],
    ['c_4', 'd2'],
    ['c_5', 'd3'],
  ])
  const fetched = new Map<string, any>([
    ['d1', { comments: [{ id: 'c_1', status: 'sent' }, { id: 'c_2', status: 'resolved' }] }],
    ['d2', null],
  ])
  expect(classifyDelivered(['c_1', 'c_2', 'c_3', 'c_4', 'c_5', 'c_6'], docOf, fetched)).toEqual({
    pending: ['c_1'],
    settled: ['c_2', 'c_3', 'c_4'],
    unknown: ['c_5', 'c_6'],
  })
})

test('提醒名单：没查到的保留原提醒，不清空', () => {
  expect(nextReminder(['c_1'], ['c_2', 'c_9'], ['c_2', 'c_3'])).toEqual(['c_1', 'c_2'])
  expect(nextReminder([], [], ['c_2'])).toEqual([])
})

test('目录：工作目录下显示相对目录，根目录显示 ./，其他显示绝对目录', () => {
  expect(dirOf('/proj/docs/superpowers/plan.md', '/proj')).toBe('docs/superpowers/')
  expect(dirOf('/proj/plan.md', '/proj/')).toBe('./')
  expect(dirOf('/tmp/demo/a.html', '/proj')).toBe('/tmp/demo/')
  expect(dirOf('/projx/a.md', '/proj')).toBe('/projx/')
  expect(dirOf('/tmp/a.md', '')).toBe('/tmp/')
})

test('超过上限的文档折叠，展开后全部列出', () => {
  const many = Array.from({ length: MAX_ROWS + 2 }, (_, i) => doc(`d${i}`, { sent: 1 }))
  expect(visibleDocs(many, false)).toEqual({ shown: many.slice(0, MAX_ROWS), hidden: 2 })
  expect(visibleDocs(many, true)).toEqual({ shown: many, hidden: 0 })
  expect(visibleDocs(many.slice(0, 2), false)).toEqual({ shown: many.slice(0, 2), hidden: 0 })
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

test('分隔线：1 像素线条不随缩放变粗变细，自带明暗两套颜色', () => {
  const d = dividerLine()
  expect(d.svg).toContain('class="rule"')
  expect(d.svg).toContain('vector-effect="non-scaling-stroke"')
  expect(d.svg).toContain('preserveAspectRatio="none"')
})
test('单行文件名：去掉扩展名和日期前缀，过长截断，中日韩字符按两格算', () => {
  expect(displayName('/a/2026-10-11-plugin-release-design.md')).toBe('plugin-release-de…')
  expect(displayName('/a/2026-10-11-api-design.md')).toBe('api-design')
  expect(displayName('/a/2026-10-11-a-very-long-document-name-here.md')).toBe('a-very-long-docum…')
  expect(displayName('/a/上线评估报告.html')).toBe('上线评估报告')
  expect(displayName('/a/一二三四五六七八九十十一十二.md')).toBe('一二三四五六七八…')
  expect(displayName('/a/2026-10-11.md')).toBe('2026-10-11')
})

test('下层有没有可见内容：只有引擎节点或空盒子时没有，有文字、按钮、图时有', () => {
  expect(hasDrawnContent(null)).toBe(false)
  expect(hasDrawnContent({ type: 'Engine', props: {} })).toBe(false)
  expect(hasDrawnContent({ type: 'Box', props: {}, children: [{ type: 'Box', props: {}, children: [] }, { type: 'Engine' }] })).toBe(false)
  expect(hasDrawnContent({ type: 'Box', props: {}, children: [{ type: 'Svg', props: {} }] })).toBe(true)
  expect(hasDrawnContent({ type: 'Text', props: {}, children: ['x'] })).toBe(true)
})

test('按宽度放文件：放得下几个就放几个，至少 1 个；宽度未知时按上限放', () => {
  const docs = ['a', 'b', 'c', 'd'].map(id => doc(`${id}-long-file-name`, { sent: 1 }))
  expect(fitDocs(docs, 200)).toEqual({ shown: docs, hidden: 0 })
  expect(fitDocs(docs, 40).shown.length).toBe(1)
  expect(fitDocs(docs, 5)).toEqual({ shown: docs.slice(0, 1), hidden: 3 })
  expect(fitDocs(docs, undefined)).toEqual(visibleDocs(docs, false))
})

test('文档目录：根目录写「项目根目录」，其余不带末尾的 /', () => {
  expect(docDir({ id: 'r', path: '/proj/readme.md', open: 1 } as any, '/proj')).toBe('项目根目录')
  expect(docDir({ id: 'p', path: '/proj/docs/a/p.md', open: 1 } as any, '/proj')).toBe('docs/a')
})

test('评审状态：新版服务端直接给 state，旧版按评论推算', () => {
  expect(stateOf({ id: 'a', path: '/a.md', open: 0, state: 'confirm' } as any)).toBe('confirm')
  expect(stateOf(doc('a', { drafts: 1 }))).toBe('draft')
  expect(stateOf(doc('a', { sent: 1 }))).toBe('processing')
  expect(stateOf(doc('a'))).toBeUndefined()
})

test('状态带的文档：四种状态、24 小时内有变化的，先排轮到你的；旧版只列有未解决评论的', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  const d = (id: string, state: string, changedAt = '2026-10-12T11:00:00Z') => ({ id, path: `/p/${id}.md`, open: 0, state, changedAt }) as any
  const list = bandDocs([d('p', 'processing'), d('r', 'review'), d('c', 'confirm'), d('x', 'draft'), d('ok', 'approved'), d('old', 'review', '2026-10-11T11:00:00Z')], now)
  expect(list.map(x => x.id)).toEqual(['x', 'c', 'r', 'p'])
  expect(bandDocs([doc('a', { sent: 1 }), doc('b')], now).map(x => x.id)).toEqual(['a'])
})

test('状态图标：形状和颜色都随状态（待评审粉、未发送黄、待确认绿、处理中灰）；卡片说明写状态、目录和时间', () => {
  for (const state of ['review', 'draft', 'confirm', 'processing']) expect(stateIcon(state).svg).toContain(`class="st st-${state}"`)
  expect(stateIcon('review').svg).toContain('.st-review{stroke:#f472b6}')
  expect(stateIcon('confirm').svg).not.toBe(stateIcon('review').svg)
  const now = Date.parse('2026-10-12T12:00:00Z')
  expect(stateDescription({ id: 'a', path: '/proj/docs/a.md', open: 0, state: 'confirm', changedAt: '2026-10-12T11:58:00Z' } as any, '/proj', now)).toBe('待确认 · docs · 2 分钟前更新')
})

test('markdownLink：文件名里的括号和反斜杠转义，不截断链接', () => {
  expect(markdownLink('plan', 'http://x/?a=1')).toBe('[plan](http://x/?a=1)')
  expect(markdownLink('a[1](2)\\b', 'u')).toBe('[a\\[1\\]\\(2\\)\\\\b](u)')
})
