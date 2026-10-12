import { expect, test } from 'claude-code/testing'

import { reviewUrl } from '../src/client.js'
import { countsOf, openResult, statusResult } from '../src/status.js'

const URL = 'http://127.0.0.1:4823/review?doc=d1&t=tok'

/** 取返回文字里「卡片数据：」那一行的 JSON。*/
function cardData(text: string) {
  return JSON.parse(text.match(/卡片数据：(.*)/)?.[1] ?? 'null')
}

test('按状态数评论', async () => {
  expect(countsOf([{ status: 'draft' }, { status: 'sent' }, { status: 'sent' }, { status: 'resolved' }])).toEqual({
    drafts: 1,
    sent: 2,
    resolved: 1,
  })
  expect(countsOf(undefined)).toEqual({ drafts: 0, sent: 0, resolved: 0 })
})

test('评审链接与服务端拼法一致', async () => {
  expect(reviewUrl({ port: 4823, token: 'tok' }, 'd1')).toBe(URL)
  expect(reviewUrl({ port: 4823, token: 'a&b' }, 'd 1')).toBe('http://127.0.0.1:4823/review?doc=d%201&t=a%26b')
})

test('review_open 的返回：链接、卡片数据（文件名、相对路径、各状态条数）和画卡片的说明', async () => {
  const text = openResult(
    {
      url: URL,
      path: '/proj/docs/plan.md',
      comments: [{ status: 'draft' }, { status: 'sent' }, { status: 'resolved' }, { status: 'resolved' }],
    },
    '/proj',
  )
  expect(text).toContain(`评审页已就绪：${URL}`)
  expect(cardData(text)).toEqual({ url: URL, name: 'plan.md', path: 'docs/plan.md', drafts: 1, sent: 1, resolved: 2 })
  expect(text).toContain('待发送 1 条 · 处理中 1 条 · 已解决 2 条')
  // 通用说明：有渲染卡片的工具就画卡片，否则给链接
  expect(text).toContain('show_widget')
  expect(text).toContain('openLink')
  expect(text).toContain('sendPrompt')
  expect(text).toContain('在浏览器打开')
  expect(text).toContain('在面板打开')
  expect(text).toContain('直接把链接')
  expect(text).toContain('[文档评审]')
})

test('review_status：没有文档时直说', async () => {
  expect(statusResult([], '/proj')).toContain('还没有登记')
})

test('review_status：各文档的路径、链接、条数和待处理评论，附汇总卡片数据', async () => {
  const text = statusResult(
    [
      {
        path: '/proj/docs/plan.md',
        url: URL,
        drafts: 1,
        sent: 2,
        resolved: 3,
        pending: [
          { id: 'c_1', quote: '方案\n分组', body: '改成表格' },
          { id: 'c_2', quote: '风险', body: '补充回滚\n以及负责人' },
        ],
      },
      { path: '/elsewhere/b.html', url: 'http://127.0.0.1:4823/review?doc=d2&t=tok', drafts: 0, sent: 0, resolved: 4, pending: [] },
    ],
    '/proj',
  )
  expect(text).toContain('2 个文档')
  expect(text).toContain('plan.md（docs/plan.md）')
  expect(text).toContain(URL)
  expect(text).toContain('待发送 1 条 · 处理中 2 条 · 已解决 3 条')
  expect(text).toContain('[c_1] 原文：「方案 分组」')
  expect(text).toContain('意见：改成表格')
  expect(text).toContain('[c_2]')
  expect(text).toContain('b.html（/elsewhere/b.html）')
  expect(text).toContain('review_resolve')
  expect(cardData(text)).toEqual([
    { url: URL, name: 'plan.md', path: 'docs/plan.md', drafts: 1, sent: 2, resolved: 3 },
    { url: 'http://127.0.0.1:4823/review?doc=d2&t=tok', name: 'b.html', path: '/elsewhere/b.html', drafts: 0, sent: 0, resolved: 4 },
  ])
  expect(text).toContain('show_widget')
})

test('review_status：取不到详情的文档不报已解决条数', async () => {
  const text = statusResult([{ path: '/proj/a.md', url: URL, drafts: 1, sent: 0, pending: [] }], '/proj')
  expect(text).toContain('待发送 1 条 · 处理中 0 条')
  expect(text).not.toContain('已解决')
  expect(cardData(text)[0].resolved).toBeUndefined()
})

test('review_status：取不到链接时说明暂不可用，卡片数据不带空 url', async () => {
  const text = statusResult([{ path: '/proj/a.md', url: '', drafts: 0, sent: 1, resolved: 0, pending: [] }], '/proj')
  expect(text).not.toMatch(/链接：\s*$/m)
  expect(text).toContain('链接暂不可用')
  expect(cardData(text)[0].url).toBeUndefined()
})

test('review_status：评论意见过长时截断', async () => {
  const body = '长'.repeat(600)
  const text = statusResult(
    [{ path: '/proj/a.md', url: URL, drafts: 0, sent: 1, resolved: 0, pending: [{ id: 'c_1', quote: 'q', body }] }],
    '/proj',
  )
  expect(text).toContain(`意见：${'长'.repeat(500)}…`)
  expect(text).not.toContain('长'.repeat(501))
})
