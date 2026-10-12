import { test } from 'node:test'
import assert from 'node:assert/strict'

import { barState, orderComments, relativeTime } from '../../server/web/static/overlay.js'

const c = (id, status) => ({ id, status, quote: id, body: id })

test('orderComments 按原文位置排序，找不到原文的排在后面，已解决单独一组', () => {
  const comments = [c('a', 'draft'), c('b', 'sent'), c('c', 'resolved'), c('d', 'draft'), c('e', 'sent')]
  const anchors = new Map([
    ['a', { start: 50, end: 60 }],
    ['b', { start: 10, end: 20 }],
    ['e', { start: 10, end: 15 }],
  ])
  const { located, moved, resolved } = orderComments(comments, anchors)
  assert.deepEqual(located.map(x => x.id), ['e', 'b', 'a'])
  assert.deepEqual(moved.map(x => x.id), ['d'])
  assert.deepEqual(resolved.map(x => x.id), ['c'])
})

test('orderComments 没有评论时三组都为空', () => {
  assert.deepEqual(orderComments([], new Map()), { located: [], moved: [], resolved: [] })
})

test('relativeTime 按距今远近显示', () => {
  const now = new Date(2026, 9, 11, 15, 30, 0)
  const at = (...a) => new Date(...a).toISOString()
  assert.equal(relativeTime(at(2026, 9, 11, 15, 29, 30), now), '刚刚')
  assert.equal(relativeTime(at(2026, 9, 11, 15, 31, 0), now), '刚刚')
  assert.equal(relativeTime(at(2026, 9, 11, 15, 5, 0), now), '25 分钟前')
  assert.equal(relativeTime(at(2026, 9, 11, 9, 5, 0), now), '09:05')
  assert.equal(relativeTime(at(2026, 9, 10, 23, 59, 0), now), '昨天')
  assert.equal(relativeTime(at(2026, 9, 9, 12, 0, 0), now), '10月9日')
  assert.equal(relativeTime(at(2025, 11, 31, 12, 0, 0), now), '12月31日')
})

test('relativeTime 时间缺失或无效时返回空串', () => {
  assert.equal(relativeTime(''), '')
  assert.equal(relativeTime(undefined), '')
  assert.equal(relativeTime('不是时间'), '')
})

test('barState：五种状态下〔通过〕〔发送给 Claude〕能不能点、显示什么、哪个是实心按钮', () => {
  const docOf = (state, ...statuses) => ({ state, comments: statuses.map((s, i) => c(`c${i}`, s)) })

  let f = barState(docOf('review'))
  assert.equal(f.label, '待评审')
  assert.equal(f.turn, 'you')
  assert.deepEqual(f.approve, { enabled: true, label: '通过', reason: '' })
  assert.equal(f.send.enabled, false)
  assert.equal(f.primary, 'approve')
  assert.equal(f.counts, '')

  f = barState(docOf('draft', 'draft', 'draft', 'resolved'))
  assert.equal(f.label, '未发送')
  assert.equal(f.counts, '2 未发送 · 1 已解决')
  assert.equal(f.primary, 'send')
  assert.deepEqual(f.send, { enabled: true, label: '发送给 Claude（2）' })
  assert.equal(f.approve.enabled, false)
  assert.equal(f.approve.reason, '还有 2 条评论没发送')

  f = barState(docOf('processing', 'sent'))
  assert.equal(f.turn, 'wait')
  assert.equal(f.approve.enabled, false)
  assert.equal(f.approve.reason, 'Claude 还在处理评论')
  assert.equal(f.send.enabled, false)
  assert.equal(f.primary, '')

  f = barState(docOf('confirm', 'resolved'))
  assert.equal(f.label, '待确认')
  assert.equal(f.approve.enabled, true)

  f = barState(docOf('approved', 'resolved'))
  assert.equal(f.turn, 'done')
  assert.deepEqual([f.approve.enabled, f.approve.label], [false, '已通过'])
  assert.equal(f.primary, '')
})

test('barState：旧版服务端没有 state 时按评论推算', () => {
  assert.equal(barState({ comments: [c('a', 'draft')] }).state, 'draft')
  assert.equal(barState({ comments: [c('a', 'sent')] }).state, 'processing')
  assert.equal(barState({ comments: [] }).state, 'review')
})
