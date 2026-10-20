import { expect, test } from 'claude-code/testing'

import { formatBlock, isUserOrigin, parseMessage, withReplies } from '../src/reply.js'

const CWD = '/Users/me/photos'
const one = [
  {
    doc: 'd1',
    path: '/Users/me/photos/plans/改名清单.md',
    replies: [
      { id: 'c_1', no: 1, quote: 'IMG_2041 → 2012-05 春游', body: '日期不对，应该是 4 月' },
      { id: 'c_2', no: 2, quote: 'IMG_3310 → 2013-02 春节', body: '这张是元宵，不是春节' },
    ],
  },
]
const two = [
  ...one,
  {
    doc: 'd2',
    path: '/tmp/行程整理清单.html',
    replies: [{ id: 'c_3', no: 3, quote: '2013 年三亚\n和爷爷奶奶', body: '和爷爷奶奶一起去的\n第二行' }],
  },
]

test('formatBlock：一组，路径在 cwd 下写相对路径', async () => {
  expect(formatBlock(one, 'zh', CWD)).toBe(
    [
      '[文档回复] 请按编号逐条答复。',
      '改名清单.md（plans/改名清单.md）',
      '<!-- reply 1 -->',
      '> IMG_2041 → 2012-05 春游',
      '',
      '日期不对，应该是 4 月',
      '',
      '<!-- reply 2 -->',
      '> IMG_3310 → 2013-02 春节',
      '',
      '这张是元宵，不是春节',
    ].join('\n'),
  )
})

test('formatBlock：两组、多行原文、路径不在 cwd 下写绝对路径、编号跨组连续；英文版用半角括号', async () => {
  const tail = [
    '',
    '<!-- reply 3 -->',
    '> 2013 年三亚',
    '> 和爷爷奶奶',
    '',
    '和爷爷奶奶一起去的',
    '第二行',
  ]
  expect(formatBlock(two, 'zh', CWD).split('\n').slice(11)).toEqual(['', '行程整理清单.html（/tmp/行程整理清单.html）', ...tail.slice(1)])
  const en = formatBlock(two, 'en', CWD)
  expect(en.startsWith('[Doc reply] Please answer each by number.\n改名清单.md (plans/改名清单.md)\n')).toBe(true)
  expect(en.includes('\n\n行程整理清单.html (/tmp/行程整理清单.html)\n<!-- reply 3 -->\n')).toBe(true)
})

test('formatBlock：不认 cwd 的前缀相同的兄弟目录', async () => {
  const g = [{ path: '/Users/me/photos2/a.md', replies: [{ quote: 'q', body: 'b' }] }]
  expect(formatBlock(g, 'zh', CWD).split('\n')[1]).toBe('a.md（/Users/me/photos2/a.md）')
})

test('withReplies：用户的话在前，空一行接回复块；没写话时只有回复块', async () => {
  const block = formatBlock(one, 'zh', CWD)
  expect(withReplies('这两处改一下', one, 'zh', CWD)).toBe(`这两处改一下\n\n${block}`)
  expect(withReplies('  \n ', one, 'zh', CWD)).toBe(block)
})

test('parseMessage 还原用户的话、组、编号、原文、内容', async () => {
  const got = parseMessage(withReplies('这两处改一下\n第二行', two, 'zh', CWD))
  expect(got?.own).toBe('这两处改一下\n第二行')
  expect(got?.lang).toBe('zh')
  expect(got?.groups.map(g => [g.name, g.path, g.replies.length])).toEqual([
    ['改名清单.md', 'plans/改名清单.md', 2],
    ['行程整理清单.html', '/tmp/行程整理清单.html', 1],
  ])
  expect(got?.groups[1].replies[0]).toEqual({ no: 3, quote: '2013 年三亚\n和爷爷奶奶', body: '和爷爷奶奶一起去的\n第二行' })
  expect(got?.groups[0].replies[1]).toEqual({ no: 2, quote: 'IMG_3310 → 2013-02 春节', body: '这张是元宵，不是春节' })
})

test('parseMessage：只有回复块时 own 为空串；英文版同样能认', async () => {
  expect(parseMessage(withReplies('', one, 'zh', CWD))?.own).toBe('')
  const en = parseMessage(withReplies('fix these', two, 'en', CWD))
  expect(en?.own).toBe('fix these')
  expect(en?.lang).toBe('en')
  expect(en?.groups[1].path).toBe('/tmp/行程整理清单.html')
})

test('parseMessage：普通消息、改乱的消息返回 null', async () => {
  const good = withReplies('看看', one, 'zh', CWD)
  expect(parseMessage('随便说一句')).toBeNull()
  expect(parseMessage(undefined)).toBeNull()
  expect(parseMessage(good.replace('<!-- reply 2 -->', '<!-- reply 5 -->'))).toBeNull()
  expect(parseMessage(good.replace('> IMG_2041 → 2012-05 春游\n', ''))).toBeNull()
  expect(parseMessage(good.replace('改名清单.md（plans/改名清单.md）', '改名清单.md'))).toBeNull()
  expect(parseMessage(good.replace('这张是元宵，不是春节', ''))).toBeNull()
  expect(parseMessage('前面的话[文档回复] 请按编号逐条答复。\n')).toBeNull()
})

test('只有用户自己发的消息算用户消息，插件（含本插件）、通知、其他会话的都不算', async () => {
  expect(isUserOrigin({ kind: 'composer' })).toBe(true)
  expect(isUserOrigin({ kind: 'bridge' })).toBe(true)
  expect(isUserOrigin({ kind: 'sdk' })).toBe(true)
  expect(isUserOrigin({ kind: 'plugin' })).toBe(false)
  expect(isUserOrigin({ kind: 'task-notification' })).toBe(false)
  expect(isUserOrigin(undefined)).toBe(false)
})
