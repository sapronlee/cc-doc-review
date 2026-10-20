import { expect, test } from 'claude-code/testing'

import { langOf, STRINGS, t } from '../src/i18n.js'

const row = (value: unknown) => [{ key: 'theme', value: 'dark' }, { key: 'language', value }]

test('langOf：含中文、Chinese、zh 为中文，其余或读不到为英文', async () => {
  expect(langOf(row('简体中文'))).toBe('zh')
  expect(langOf(row('Chinese'))).toBe('zh')
  expect(langOf(row('zh-CN'))).toBe('zh')
  expect(langOf(row('ZH'))).toBe('zh')
  expect(langOf(row('English'))).toBe('en')
  expect(langOf(row(''))).toBe('en')
  expect(langOf(row(undefined))).toBe('en')
  expect(langOf([{ key: 'theme', value: 'dark' }])).toBe('en')
  expect(langOf(undefined)).toBe('en')
})

test('t：替换变量；缺的变量原样保留；没有的键回落到英文再回落到键名', async () => {
  expect(t('zh', 'changes', { n: 3 })).toBe('改了 3 处')
  expect(t('en', 'changes', { n: 3 })).toBe('3 changes')
  expect(t('zh', 'docsListHead', { n: 2 })).toBe('本会话的文档（2 份）：')
  expect(t('en', 'docsListHead', { n: 2 })).toBe('Docs in this session (2):')
  expect(t('zh', 'deleteFailed')).toBe('没删掉：{reason}')
  expect(t('zh', 'no-such-key')).toBe('no-such-key')
})

test('设计文档第 3 节的叫法照抄', async () => {
  expect(t('zh', 'replyHint')).toBe('回复 Claude')
  expect(t('en', 'replyHint')).toBe('Reply to Claude')
  expect(t('zh', 'pendingOnPage', { n: 2 })).toBe('2 条回复待发送')
  expect(t('en', 'pendingOnPage', { n: 2 })).toBe('2 replies to send')
  expect(t('zh', 'blockHead').startsWith('[文档回复]')).toBe(true)
  expect(t('en', 'blockHead').startsWith('[Doc reply]')).toBe(true)
})

test('中英两套同键；中文全用全角标点，不出现评论、评审、通过、待确认', async () => {
  expect(Object.keys(STRINGS.zh).sort()).toEqual(Object.keys(STRINGS.en).sort())
  for (const [key, value] of Object.entries(STRINGS.zh)) {
    const text = value.replace(/\{\w+\}/g, '')
    if (/[:(),]/.test(text)) throw new Error(`${key} 有半角标点：${value}`)
    if (/评论|评审|通过|待确认/.test(text)) throw new Error(`${key} 用了旧叫法：${value}`)
  }
})
