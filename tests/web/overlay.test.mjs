import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canSubmit, numberOf, popoverPlace } from '../../server/web/static/overlay.js'

const VIEW = { width: 1200, height: 800, top: 48 }
const SIZE = { width: 380, height: 110 }
const rect = (top, left, height = 22) => ({ top, bottom: top + height, left })

test('popoverPlace：上方放得下就放上方，不挡选中的字', () => {
  assert.deepEqual(popoverPlace(rect(400, 100), VIEW, SIZE), { top: 400 - 8 - 110, left: 100, side: 'above' })
})

test('popoverPlace：选区贴近顶栏时放下方', () => {
  assert.deepEqual(popoverPlace(rect(60, 100), VIEW, SIZE), { top: 60 + 22 + 8, left: 100, side: 'below' })
  // 刚好放得下：仍在上方
  assert.equal(popoverPlace(rect(48 + 8 + 110, 100), VIEW, SIZE).side, 'above')
})

test('popoverPlace：靠右时左移，不出界；靠左时至少留 8', () => {
  assert.equal(popoverPlace(rect(400, 1000), VIEW, SIZE).left, 1200 - 380 - 8)
  assert.equal(popoverPlace(rect(400, -20), VIEW, SIZE).left, 8)
})

test('canSubmit：空串、只有空白不能加入', () => {
  assert.equal(canSubmit(''), false)
  assert.equal(canSubmit('  \n\t'), false)
  assert.equal(canSubmit(undefined), false)
  assert.equal(canSubmit(' 改一下 '), true)
})

test('numberOf：按回复区的全局编号；第二组第一条接着第一组编', () => {
  const groups = [
    { replies: [{ id: 'a', no: 1 }, { id: 'b', no: 2 }] },
    { replies: [{ id: 'c', no: 3 }] },
  ]
  assert.equal(numberOf(groups, 'c'), 3)
  assert.equal(numberOf(groups, 'b'), 2)
  assert.equal(numberOf(groups, 'x'), undefined)
  assert.equal(numberOf(undefined, 'a'), undefined)
})

test('popoverPlace：选区很高、下方也放不下时贴着窗口底边', () => {
  const at = popoverPlace({ top: 60, bottom: 780, left: 100 }, VIEW, SIZE)
  assert.deepEqual(at, { top: 800 - 110 - 8, left: 100, side: 'below' })
})
