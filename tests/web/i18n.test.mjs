import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pageLang, STRINGS as PAGE, t } from '../../server/web/static/i18n.js'
import { STRINGS as PLUGIN } from '../../src/i18n.js'

test('页面文字表的每个键在插件文字表里都有，中英值相同', () => {
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(PAGE[lang])) assert.equal(PLUGIN[lang][key], value, `${lang}.${key}`)
  }
  assert.deepEqual(Object.keys(PAGE.zh).sort(), Object.keys(PAGE.en).sort())
})

test('pageLang：链接参数优先，没有时看浏览器语言', () => {
  assert.equal(pageLang('zh', 'en-US'), 'zh')
  assert.equal(pageLang('en', 'zh-CN'), 'en')
  assert.equal(pageLang(null, 'zh-CN'), 'zh')
  assert.equal(pageLang(null, 'fr'), 'en')
  assert.equal(pageLang('xx', ''), 'en')
})

test('t：替换变量', () => {
  assert.equal(t('zh', 'pendingOnPage', { n: 2 }), '2 条回复待发送')
  assert.equal(t('en', 'changes', { n: 3 }), '3 changes')
})
