import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diffBlocks, shouldAutoScroll } from '../../server/web/static/diff.js'

const base = ['标题', '第一段', '第二段', '第三段']

test('diffBlocks：整体不变时没有改动', () => {
  assert.deepEqual(diffBlocks(base, [...base]), [])
})

test('diffBlocks：中间插一段，只标新的那段', () => {
  assert.deepEqual(diffBlocks(base, ['标题', '第一段', '新插的', '第二段', '第三段']), [2])
})

test('diffBlocks：改一段，标改过的那段', () => {
  assert.deepEqual(diffBlocks(base, ['标题', '第一段', '第二段改了', '第三段']), [2])
})

test('diffBlocks：删一段不标；同时改一段时只标改的', () => {
  assert.deepEqual(diffBlocks(base, ['标题', '第二段', '第三段']), [])
  assert.deepEqual(diffBlocks(base, ['标题', '第二段', '第三段改了']), [2])
})

test('diffBlocks：只有空白不同不算改动；新的空段落不标', () => {
  assert.deepEqual(diffBlocks(['a  b', ' c '], ['a b', 'c\n']), [])
  assert.deepEqual(diffBlocks(['a'], ['a', '  ']), [])
})

test('diffBlocks：开头和结尾加段落、全新内容', () => {
  assert.deepEqual(diffBlocks(base, ['前言', ...base, '附录']), [0, 5])
  assert.deepEqual(diffBlocks([], ['x', 'y']), [0, 1])
})

test('shouldAutoScroll：回复框开着、3 秒内滚动过都不滚', () => {
  assert.equal(shouldAutoScroll({ isEditorOpen: false, lastScrollAt: 0, now: 10_000 }), true)
  assert.equal(shouldAutoScroll({ isEditorOpen: true, lastScrollAt: 0, now: 10_000 }), false)
  assert.equal(shouldAutoScroll({ isEditorOpen: false, lastScrollAt: 8_000, now: 10_000 }), false)
  assert.equal(shouldAutoScroll({ isEditorOpen: false, lastScrollAt: 7_000, now: 10_000 }), true)
})
