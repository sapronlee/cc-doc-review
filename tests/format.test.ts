import { expect, test } from 'claude-code/testing'

import { commentIdsIn, displayPath, formatBatch } from '../src/format.js'

const BATCH = {
  batch: 'b_20261011_100500_ab12',
  doc: 'd1',
  path: '/proj/docs/plan.md',
  comments: [
    { id: 'c_1', quote: '方案是按环境\n分组', body: '改成表格' },
    { id: 'c_2', quote: '风险', body: '补充回滚方案\n以及负责人' },
  ],
}

test('工作目录下的文件显示相对路径，否则显示绝对路径', async () => {
  expect(displayPath('/proj/docs/plan.md', '/proj')).toBe('docs/plan.md')
  expect(displayPath('/proj/docs/plan.md', '/proj/')).toBe('docs/plan.md')
  expect(displayPath('/other/a.md', '/proj')).toBe('/other/a.md')
  expect(displayPath('/project2/a.md', '/proj')).toBe('/project2/a.md')
})

test('消息带文件、条数、每条的 ID、原文和意见', async () => {
  const text = formatBatch(BATCH, '/proj')
  expect(text).toContain('[文档评审] docs/plan.md 有 2 条新评论：')
  expect(text).toContain('1. [c_1] 原文：「方案是按环境 分组」')
  expect(text).toContain('   意见：改成表格')
  expect(text).toContain('2. [c_2] 原文：「风险」')
  expect(text).toContain('   意见：补充回滚方案\n   以及负责人')
  expect(text).toContain('review_resolve')
})

test('过长的原文截断', async () => {
  const text = formatBatch({ ...BATCH, comments: [{ id: 'c_9', quote: '字'.repeat(300), body: 'x' }] }, '/proj')
  expect(text).toContain('字'.repeat(200) + '…')
  expect(text).not.toContain('字'.repeat(201))
})

test('从评审消息里取评论 ID', () => {
  const text = formatBatch(
    { path: '/p/a.md', comments: [{ id: 'c_1a', quote: 'x', body: 'y' }, { id: 'c_2b', quote: 'x', body: '见 c_9' }] },
    '/p',
  )
  expect(commentIdsIn(text)).toEqual(['c_1a', 'c_2b'])
})
