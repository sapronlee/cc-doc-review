import { expect, test } from 'claude-code/testing'

import { docItems } from '../src/docsview.js'

const NOW = Date.parse('2026-10-18T10:00:00Z')
const at = (min: number) => new Date(NOW - min * 60_000).toISOString()

test('docItems：顺序沿用服务端，名称、目录、更新时间、待发送数', async () => {
  const items = docItems(
    [
      { id: 'b', path: '/w/proj/docs/2026-10-18-新归类方案.md', openedAt: at(30), modifiedAt: at(20), seenAt: at(5), pending: 0 },
      { id: 'a', path: '/w/proj/改名清单.md', openedAt: at(60), pending: 2 },
    ],
    '/w/proj',
    NOW,
  )
  expect(items.map(i => i.id)).toEqual(['b', 'a'])
  expect(items[0]).toEqual({ id: 'b', path: '/w/proj/docs/2026-10-18-新归类方案.md', name: '新归类方案', dir: 'docs', when: '20 分钟前', pending: 0, isNew: false })
  expect(items[1].dir).toBe('项目根目录')
  expect(items[1].pending).toBe(2)
  expect(items[1].when).toBe('1 小时前')
  expect(docItems([{ id: 'a', path: '/w/proj/a.md', openedAt: at(0) }], '/w/proj', NOW, 'en')[0]).toEqual({
    id: 'a',
    path: '/w/proj/a.md',
    name: 'a',
    dir: 'project root',
    when: 'just now',
    pending: 0,
    isNew: true,
  })
})

test('docItems：isNew 三种情况', async () => {
  const one = (d: object) => docItems([{ id: 'x', path: '/w/x.md', ...d }], '/w', NOW)[0].isNew
  expect(one({ openedAt: at(10) })).toBe(true)
  expect(one({ openedAt: at(10), modifiedAt: at(8), seenAt: at(5) })).toBe(false)
  expect(one({ openedAt: at(10), modifiedAt: at(2), seenAt: at(5) })).toBe(true)
  expect(one({ openedAt: at(1), seenAt: at(5) })).toBe(true)
  expect(docItems(undefined, '/w', NOW)).toEqual([])
})
