import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pageTheme, parseColor } from '../../server/web/static/theme.js'

test('parseColor 认得 rgb()、rgba() 和空格写法，认不得的返回 null', () => {
  assert.deepEqual(parseColor('rgb(255, 255, 255)'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 })
  assert.deepEqual(parseColor('rgb(18 18 18 / 50%)'), { r: 18, g: 18, b: 18, a: 0.5 })
  assert.equal(parseColor('transparent'), null)
  assert.equal(parseColor(''), null)
})

test('pageTheme：按 body、html 的不透明背景色判断明暗，外框用同一个底色', () => {
  const clear = 'rgba(0, 0, 0, 0)'
  assert.deepEqual(pageTheme({ body: 'rgb(255, 255, 255)', html: clear, prefersDark: true }), {
    theme: 'light',
    bar: 'rgb(255, 255, 255)',
  })
  assert.deepEqual(pageTheme({ body: clear, html: 'rgb(13, 17, 23)', prefersDark: false }), {
    theme: 'dark',
    bar: 'rgb(13, 17, 23)',
  })
  // 中等偏暗的彩色底也算深色
  assert.equal(pageTheme({ body: 'rgb(30, 64, 120)', prefersDark: false }).theme, 'dark')
})

test('pageTheme：没设背景时看浏览器画布，只有页面声明了深色 color-scheme 才是深色', () => {
  const clear = 'rgba(0, 0, 0, 0)'
  // 没写样式的 HTML：系统是深色，页面仍是白底
  assert.deepEqual(pageTheme({ body: clear, html: clear, scheme: 'normal', prefersDark: true }), { theme: 'light', bar: '#ffffff' })
  assert.equal(pageTheme({ body: clear, html: clear, scheme: 'light dark', prefersDark: true }).theme, 'dark')
  assert.equal(pageTheme({ body: clear, html: clear, scheme: 'light dark', prefersDark: false }).theme, 'light')
  assert.deepEqual(pageTheme({ body: clear, html: clear, scheme: 'dark', prefersDark: false }), { theme: 'dark', bar: '#121212' })
})
