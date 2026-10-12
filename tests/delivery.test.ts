import { expect, test } from 'claude-code/testing'

import {
  contextText,
  deliveredToast,
  isUserOrigin,
  queuedToast,
  remindedToast,
  reminderTargets,
  retryDelay,
} from '../src/delivery.js'

test('重试间隔：第 1、2、3 次失败后分别等 5、15、45 秒，之后不再重试', async () => {
  expect(retryDelay(1)).toBe(5_000)
  expect(retryDelay(2)).toBe(15_000)
  expect(retryDelay(3)).toBe(45_000)
  expect(retryDelay(4)).toBeUndefined()
  expect(retryDelay(0)).toBeUndefined()
})

test('只有用户自己发的消息算用户消息，插件（含本插件）、通知、其他会话的都不算', async () => {
  expect(isUserOrigin({ kind: 'composer' })).toBe(true)
  expect(isUserOrigin({ kind: 'bridge' })).toBe(true)
  expect(isUserOrigin({ kind: 'sdk' })).toBe(true)
  expect(isUserOrigin({ kind: 'plugin', name: 'cc-doc-review', asUser: true })).toBe(false)
  expect(isUserOrigin({ kind: 'plugin', name: 'other' })).toBe(false)
  expect(isUserOrigin({ kind: 'task-notification' })).toBe(false)
  expect(isUserOrigin({ kind: 'peer' })).toBe(false)
  expect(isUserOrigin(undefined)).toBe(false)
})

test('附在用户消息上的文字：说明来由，后面接各批评论', async () => {
  const text = contextText(['[文档评审] a.md 有 1 条新评论：\n\n1. [c_1] …', '[文档评审] b.md 有 2 条新评论：…'])
  expect(text).toContain('没能及时送达')
  expect(text).toContain('[c_1]')
  expect(text).toContain('b.md')
  expect(text.indexOf('a.md')).toBeLessThan(text.indexOf('b.md'))
})

test('提示文案', async () => {
  expect(deliveredToast(3)).toBe('已收到 3 条评论，Claude 正在处理')
  expect(remindedToast(2)).toBe('还有 2 条评论没回复处理结果，已提醒 Claude')
  expect(queuedToast(1)).toContain('下一条消息')
})

test('自动提醒：有没提醒过的批次就提醒全部没回复的评论，并记下这些批次', async () => {
  const batchOf = new Map([
    ['c_1', 'b1'],
    ['c_2', 'b1'],
    ['c_3', 'b2'],
  ])
  expect(reminderTargets(['c_1', 'c_3'], batchOf, new Set())).toEqual({ ids: ['c_1', 'c_3'], batches: ['b1', 'b2'] })
  // b1 提醒过，b2 没有：仍然提醒，名单里带上 b1 没回复的
  expect(reminderTargets(['c_1', 'c_3'], batchOf, new Set(['b1']))).toEqual({ ids: ['c_1', 'c_3'], batches: ['b2'] })
  // 都提醒过：不再提醒
  expect(reminderTargets(['c_1', 'c_3'], batchOf, new Set(['b1', 'b2']))).toEqual({ ids: [], batches: [] })
  expect(reminderTargets([], batchOf, new Set())).toEqual({ ids: [], batches: [] })
})
