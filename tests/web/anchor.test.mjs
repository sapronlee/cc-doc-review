import { test } from 'node:test'
import assert from 'node:assert/strict'

import { captureQuote, locate } from '../../server/web/static/anchor.js'

test('captureQuote 取选区和前后各 30 个字', () => {
  const text = 'a'.repeat(40) + '目标' + 'b'.repeat(40)
  assert.deepEqual(captureQuote(text, 40, 42), {
    quote: '目标',
    prefix: 'a'.repeat(30),
    suffix: 'b'.repeat(30),
  })
})

test('captureQuote 在文本两端不越界', () => {
  assert.deepEqual(captureQuote('开头结尾', 0, 2), { quote: '开头', prefix: '', suffix: '结尾' })
})

test('locate 找到唯一出现的原文', () => {
  const text = '背景。方案是按环境分组。风险。'
  assert.deepEqual(locate(text, captureQuote(text, 3, 11)), { start: 3, end: 11 })
})

test('原文重复出现时按上下文选对位置', () => {
  const text = '第一段：需要改。第二段：需要改。'
  const at = text.lastIndexOf('需要改')
  assert.deepEqual(locate(text, captureQuote(text, at, at + 3)), { start: at, end: at + 3 })
})

test('前面插入内容后仍能定位', () => {
  const before = '第一节。目标句子在这里。尾巴。'
  const q = captureQuote(before, 4, 11)
  const after = '新增的开头段落。' + before
  const start = after.indexOf('目标句子在这里')
  assert.deepEqual(locate(after, q), { start, end: start + 7 })
})

test('原文被改掉时返回 null', () => {
  const q = captureQuote('方案是按环境分组。', 0, 8)
  assert.equal(locate('方案是按区域分组。', q), null)
})

test('空引用返回 null', () => {
  assert.equal(locate('任何文本', { quote: '', prefix: '', suffix: '' }), null)
})
