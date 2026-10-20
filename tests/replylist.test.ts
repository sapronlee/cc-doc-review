import { expect, test } from 'claude-code/testing'

import { bandModel, COLLAPSED_ROWS, fit, messageModel, QUOTE_WIDTH } from '../src/replylist.js'

const at = (i: number) => new Date(Date.parse('2026-10-19T00:00:00Z') + i * 60_000).toISOString()
const reply = (i: number, o: any = {}) => ({ id: `c_${i}`, no: i, quote: `原文${i}`, body: `回复${i}`, createdAt: at(i), ...o })
const STATE = { isExpanded: false, isArmed: false, isSending: false, lang: 'zh' as const }

test('fit：压成一行；汉字算 1、字母算 0.6，超宽截断加「…」', async () => {
  expect(fit('  一行\n两行  ', 10)).toBe('一行 两行')
  expect(fit('一二三四五六', 4)).toBe('一二三…')
  expect(fit('abcdefghij', 3)).toBe('abcd…')
})

test('bandModel：只有一份文档时标题带文档名，不单列文档行；每行编号、截短的原文、回复', async () => {
  const long = '很长很长很长很长很长很长很长很长很长很长很长很长的原文'
  const m = bandModel([{ doc: 'd1', path: '/p/docs/改名清单.md', replies: [reply(1), reply(2, { quote: long })] }], STATE)
  expect(m.total).toBe(2)
  expect(m).toMatchObject({ title: '2 条回复', docName: '改名清单' })
  expect(m.rows.map(r => r.kind)).toEqual(['reply', 'reply'])
  expect(m.rows[0]).toEqual({ kind: 'reply', key: 'r:c_1', id: 'c_1', doc: 'd1', no: 1, quote: '原文1', body: '回复1', fullQuote: '原文1' })
  expect(m.rows[1]).toMatchObject({ quote: fit(long, QUOTE_WIDTH), fullQuote: long })
  expect(m).toMatchObject({ hidden: 0, more: '', toggle: '', clear: '清空', send: '发送', isSending: false })
})

test('bandModel：多份文档时标题只写条数，每组前一行文档名', async () => {
  const m = bandModel(
    [
      { doc: 'da', path: '/p/改名清单.md', replies: [reply(1)] },
      { doc: 'db', path: '/p/行程.html', replies: [reply(2)] },
    ],
    STATE,
  )
  expect(m).toMatchObject({ title: '2 条回复', docName: '' })
  expect(m.rows.map(r => (r.kind === 'doc' ? `doc:${r.name}` : r.id))).toEqual(['doc:改名清单', 'c_1', 'doc:行程', 'c_2'])
})

test('bandModel：超过 3 条时折叠，只列最新 3 条，toggle 是「展开其余 N 条」；展开后全列，toggle 是「收起」', async () => {
  const groups = [{ doc: 'd1', path: '/p/a.md', replies: Array.from({ length: COLLAPSED_ROWS + 1 }, (_, i) => reply(i + 1)) }]
  const folded = bandModel(groups, STATE)
  expect(COLLAPSED_ROWS).toBe(3)
  expect(folded.rows.map(r => (r as any).id)).toEqual(['c_2', 'c_3', 'c_4'])
  expect(folded.hidden).toBe(1)
  expect(folded.more).toBe('还有 1 条')
  expect(folded.toggle).toBe('展开其余 1 条')
  const open = bandModel(groups, { ...STATE, isExpanded: true })
  expect(open.rows.length).toBe(4)
  expect(open.hidden).toBe(0)
  expect(open.more).toBe('')
  expect(open.toggle).toBe('收起')
})

test('bandModel：不超过 3 条时不折叠，没有 toggle（即使标了展开）', async () => {
  const groups = [{ doc: 'd1', path: '/p/a.md', replies: [reply(1), reply(2), reply(3)] }]
  expect(bandModel(groups, STATE)).toMatchObject({ hidden: 0, toggle: '' })
  expect(bandModel(groups, { ...STATE, isExpanded: true })).toMatchObject({ hidden: 0, toggle: '' })
})

test('bandModel：room 限制列出的条数（至少 1 条），折叠和展开都不超过 room；展开也放不下更多时不给〔展开〕', async () => {
  const groups = [{ doc: 'd1', path: '/p/a.md', replies: Array.from({ length: 6 }, (_, i) => reply(i + 1)) }]
  const ids = (m: ReturnType<typeof bandModel>) => m.rows.map(r => (r as any).id)
  // room 大于 3：折叠仍是 3 条，展开列 room 条
  expect(ids(bandModel(groups, { ...STATE, room: 5 }))).toEqual(['c_4', 'c_5', 'c_6'])
  expect(ids(bandModel(groups, { ...STATE, room: 5, isExpanded: true }))).toEqual(['c_2', 'c_3', 'c_4', 'c_5', 'c_6'])
  expect(bandModel(groups, { ...STATE, room: 5, isExpanded: true })).toMatchObject({ hidden: 1, toggle: '收起' })
  // room 够全列：展开后全部 6 条
  expect(ids(bandModel(groups, { ...STATE, room: 10, isExpanded: true })).length).toBe(6)
  // room 小于 3：折叠也只列 room 条；展开后同样只列 room 条
  const small = bandModel(groups, { ...STATE, room: 2 })
  expect(ids(small)).toEqual(['c_5', 'c_6'])
  expect(small).toMatchObject({ hidden: 4, toggle: '' })
  expect(ids(bandModel(groups, { ...STATE, room: 2, isExpanded: true }))).toEqual(['c_5', 'c_6'])
  // room 为 0、负数或带小数：至少 1 条（向下取整）
  expect(ids(bandModel(groups, { ...STATE, room: 0 }))).toEqual(['c_6'])
  expect(ids(bandModel(groups, { ...STATE, room: -4 }))).toEqual(['c_6'])
  expect(ids(bandModel(groups, { ...STATE, room: 2.9 }))).toEqual(['c_5', 'c_6'])
  // 只有 room 条（或更少）回复时不折叠
  expect(bandModel(groups.map(g => ({ ...g, replies: g.replies.slice(0, 2) })), { ...STATE, room: 1 })).toMatchObject({ hidden: 1, toggle: '' })
  expect(bandModel(groups.map(g => ({ ...g, replies: g.replies.slice(0, 1) })), { ...STATE, room: 1 })).toMatchObject({ hidden: 0, toggle: '' })
})

test('bandModel：多份文档折叠时按全部回复的加入时间取最新的，文档名行只留有回复的组', async () => {
  const groups = [
    { doc: 'da', path: '/p/改名清单.md', replies: [reply(1), reply(2), reply(5)] },
    { doc: 'db', path: '/p/行程.html', replies: [reply(3), reply(4)] },
  ]
  const m = bandModel(groups, { ...STATE, room: 2 })
  expect(m.rows.map(r => (r.kind === 'doc' ? `doc:${r.name}` : r.id))).toEqual(['doc:改名清单', 'c_5', 'doc:行程', 'c_4'])
  expect(m.hidden).toBe(3)
  // 最新两条都在同一份文档里时，另一份的文档名行不出现
  const one = bandModel([groups[0], { doc: 'db', path: '/p/行程.html', replies: [reply(0)] }], { ...STATE, room: 2 })
  expect(one.rows.map(r => (r.kind === 'doc' ? `doc:${r.name}` : r.id))).toEqual(['doc:改名清单', 'c_2', 'c_5'])
})

test('bandModel：按钮文字跟着状态变；英文界面用英文；空组不算', async () => {
  const groups = [{ doc: 'd1', path: '/p/a.md', replies: [reply(1)] }, { doc: 'd2', path: '/p/b.md', replies: [] }]
  const m = bandModel(groups, { ...STATE, isArmed: true, isSending: true })
  expect(m).toMatchObject({ title: '1 条回复', docName: 'a', clear: '确认清空', send: '发送中…', isSending: true })
  expect(bandModel(groups, { ...STATE, lang: 'en' })).toMatchObject({ title: '1 replies', docName: 'a', clear: 'Clear', send: 'Send' })
  const many = [{ doc: 'd1', path: '/p/a.md', replies: Array.from({ length: 5 }, (_, i) => reply(i + 1)) }]
  expect(bandModel(many, { ...STATE, lang: 'en' }).toggle).toBe('Show 2 more')
  expect(bandModel(many, { ...STATE, lang: 'en', isExpanded: true }).toggle).toBe('Collapse')
  expect(bandModel([], STATE).total).toBe(0)
})

test('messageModel：和回复区同样的标题和行，不折叠，你写的话另放', async () => {
  const parsed = {
    own: '这几处改一下',
    groups: [{ name: '改名清单.md', path: 'docs/改名清单.md', replies: Array.from({ length: 7 }, (_, i) => ({ no: i + 1, quote: `原文${i + 1}`, body: `回复${i + 1}` })) }],
  }
  const m = messageModel(parsed, 'zh')
  expect(m).toMatchObject({ title: '7 条回复', docName: '改名清单' })
  expect(m.rows.length).toBe(7)
  expect(m.rows[0]).toMatchObject({ kind: 'reply', key: 'r:n1', no: 1, quote: '原文1', body: '回复1' })
  expect(m.own).toBe('这几处改一下')
})
