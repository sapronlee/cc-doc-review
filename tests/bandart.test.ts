import { expect, test } from 'claude-code/testing'

import { CANVAS_W, clip, cornerEdgeSvg, docRowSvg, edgeSvg, frameSvg, gapSvg, HEAD_RIGHT, lineSvg, PAD, RADIUS, ROW_H, rowSvg, sepSvg } from '../src/bandart.js'

test('常量：行高 28、画布宽 2000', async () => {
  expect(ROW_H).toBe(28)
  expect(CANVAS_W).toBe(2000)
})

test('clip：压成一行，空白合并并去掉首尾空白', async () => {
  expect(clip('  一行\n\n两行\t三行  ', 600)).toBe('一行 两行 三行')
  expect(clip('abc', 600)).toBe('abc')
  expect(clip('', 100)).toBe('')
})

test('clip：汉字算 13 像素、字母算 7.4 像素，刚好放得下不截断', async () => {
  expect(clip('一二三', 39)).toBe('一二三')
  expect(clip('一二三四', 39)).not.toBe('一二三四')
  // 5 个字母 = 37 像素
  expect(clip('abcde', 37)).toBe('abcde')
  expect(clip('abcdef', 37)).toBe('abcd…')
})

test('clip：超宽截断并加「…」，省略号也占宽（按字母 7.4 像素算）', async () => {
  // 40 像素：留 32.6 给正文，放得下两个汉字
  expect(clip('一二三四五六', 40)).toBe('一二…')
  // 40 像素：留 32.6 给正文，4 个字母 29.6，5 个字母 37 超了
  expect(clip('abcdefgh', 40)).toBe('abcd…')
  // 截断后的宽度不超过上限
  const out = clip('很长很长很长很长很长很长的原文 with some English words', 150)
  expect(out.endsWith('…')).toBe(true)
  let w = 0
  for (const ch of out) w += /[一-鿿…]/.test(ch) ? 13 : 7.4
  expect(w).toBeLessThanOrEqual(150)
})

test('clip：全角标点、表情按 13 像素算，截断时尾部空格被去掉', async () => {
  expect(clip('，，，，', 39)).toBe('，，…')
  expect(clip('ab cdefgh', 30)).toBe('ab…')
})

const NO_ART = { no: 1, quote: '原文', body: '回复' }

test('rowSvg：宽 2000 高 28，slice，跟随主题；不带横线（横线单独一条）、编号圆点（circle）里是编号', async () => {
  const svg = rowSvg({ no: 12, quote: '原文', body: '回复' })
  expect(svg).toContain('width="2000"')
  expect(svg).toContain('height="28"')
  expect(svg).toContain('preserveAspectRatio="xMinYMid slice"')
  expect(svg).toContain('prefers-color-scheme')
  // 横线不画在行里（单独一条，见 lineSvg）
  expect(svg).not.toMatch(/<rect x="0" y="0" width="2000" height="1"[^>]*\/>/)
  // 编号圆点和里面的编号
  expect(svg).toContain('<circle')
  expect(svg).toContain('>12</text>')
  // 引用竖线（宽 2，不是横线）、原文、回复
  expect(svg).toContain('width="2" height="12"')
  expect(svg).toContain('>原文</text>')
  expect(svg).toContain('>回复</text>')
})

test('rowSvg：原文和回复里的 < & " \' 都做了 XML 转义，不会冒出标签', async () => {
  const svg = rowSvg({ no: 1, quote: 'a<b>&c "d" \'e\'', body: '<script>alert(1)</script> & x' })
  expect(svg).toContain('a&lt;b&gt;&amp;c &quot;d&quot; &#39;e&#39;')
  expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; x')
  expect(svg).not.toContain('<script>')
  expect(svg).not.toContain('<b>')
})

test('rowSvg：长原文和长回复被截短并带「…」，换行压成空格', async () => {
  const quote = '很长很长的原文'.repeat(30)
  const body = 'a very long reply '.repeat(40)
  const svg = rowSvg({ no: 1, quote, body })
  expect(svg).not.toContain(quote)
  expect(svg).not.toContain(body.trim())
  expect(svg).toContain('很长很长的原文')
  expect(svg).toMatch(/>[^<>]*…<\/text>/)
  expect(svg.match(/…<\/text>/g)).toHaveLength(2)
  // 多行压成一行
  const multi = rowSvg({ no: 1, quote: '第一行\n第二行', body: '好' })
  expect(multi).toContain('>第一行 第二行</text>')
  expect(multi).not.toContain('第一行\n')
})

test('rowSvg：短原文和短回复原样画，不加「…」', async () => {
  const svg = rowSvg(NO_ART)
  expect(svg).not.toContain('…')
})

test('docRowSvg：宽 2000 高 28，slice，跟随主题；不带横线，文档名转义，过长截短', async () => {
  const svg = docRowSvg('改名清单 <v2> & 备份')
  expect(svg).toContain('width="2000"')
  expect(svg).toContain('height="28"')
  expect(svg).toContain('preserveAspectRatio="xMinYMid slice"')
  expect(svg).toContain('prefers-color-scheme')
  expect(svg).not.toMatch(/<rect x="0" y="0" width="2000" height="1"[^>]*\/>/)
  expect(svg).toContain('改名清单 &lt;v2&gt; &amp; 备份')
  expect(svg).not.toContain('<v2>')
  // 没有编号圆点
  expect(svg).not.toContain('<circle')
  const long = docRowSvg('长'.repeat(100))
  expect(long).not.toContain('长'.repeat(100))
  expect(long).toContain('…</text>')
})

test('sepSvg：宽 1 高 12 的细竖线，跟随主题', async () => {
  const svg = sepSvg()
  expect(svg).toContain('<svg')
  expect(svg).toContain('width="1"')
  expect(svg).toContain('height="12"')
  expect(svg).toContain('viewBox="0 0 1 12"')
  expect(svg).toContain('prefers-color-scheme')
  expect(svg).toContain('<rect width="1" height="12"')
})

test('lineSvg：单独一条通栏横线，宽 2000 高 1，slice，跟随主题', async () => {
  const svg = lineSvg()
  expect(svg).toContain('width="2000"')
  expect(svg).toContain('height="1"')
  expect(svg).toContain('preserveAspectRatio="xMinYMid slice"')
  expect(svg).toContain('prefers-color-scheme')
  expect(svg).toMatch(/<rect x="0" y="0" width="2000" height="1"[^>]*\/>/)
})

test('rowSvg、docRowSvg：最左边画左边框（x=0、宽 1、一行高），内容从边框往里 PAD 像素开始', async () => {
  for (const svg of [rowSvg({ no: 1, quote: 'a', body: 'b' }), docRowSvg('改名清单')]) {
    expect(svg).toContain(`<rect x="0" y="0" width="1" height="${ROW_H}" class="edge"/>`)
  }
  expect(rowSvg({ no: 1, quote: 'a', body: 'b' })).toContain(`<circle cx="${PAD + 1 + 7}"`)
})

test('edgeSvg：右边框的竖线贴着图的右边（宽 w 时左边留空），标题行左边框的竖线贴着左边', async () => {
  expect(edgeSvg(ROW_H)).toContain(`<rect x="0" y="0" width="1" height="${ROW_H}" class="edge"/>`)
  // 标题行右边：〔发送〕和右边框之间再空出 HEAD_RIGHT 像素
  expect(edgeSvg(ROW_H, HEAD_RIGHT + 1)).toContain(`<rect x="${HEAD_RIGHT}" y="0" width="1" height="${ROW_H}" class="edge"/>`)
  const left = edgeSvg(ROW_H, PAD + 1, 'left')
  expect(left).toContain(`width="${PAD + 1}"`)
  expect(left).toContain(`<rect x="0" y="0" width="1" height="${ROW_H}" class="edge"/>`)
})

test('最后一行把外框下沿和左下圆角画在自己的图里，右边框换成带右下圆角的小图，行高不变', async () => {
  const last = rowSvg({ no: 1, quote: 'a', body: 'b' }, ROW_H, true)
  expect(last).toContain(`height="${ROW_H}"`)
  expect(last).toContain(`<path d="M0.5 0 V${ROW_H - RADIUS} A${RADIUS - 0.5} ${RADIUS - 0.5} 0 0 0 ${RADIUS} ${ROW_H - 0.5} H${CANVAS_W}" class="arc"/>`)
  expect(last).not.toContain('class="edge"')
  expect(docRowSvg('改名清单', ROW_H, true)).toContain(`V${ROW_H - RADIUS}`)
  const corner = cornerEdgeSvg()
  expect(corner).toContain(`width="${RADIUS}" height="${ROW_H}"`)
  expect(corner).toContain(`<path d="M0 ${ROW_H - 0.5} A${RADIUS - 0.5} ${RADIUS - 0.5} 0 0 0 ${RADIUS - 0.5} ${ROW_H - RADIUS} V0" class="arc"/>`)
})

test('gapSvg：和上下沿一样高的空白边，左右两张图只有边框竖线', async () => {
  const g = gapSvg()
  expect(g.left).toContain(`height="${RADIUS}"`)
  expect(g.left).toContain(`<rect x="0" y="0" width="1" height="${RADIUS}" class="edge"/>`)
  expect(g.right).toContain(`<rect x="${RADIUS - 1}" y="0" width="1" height="${RADIUS}" class="edge"/>`)
})

test('frameSvg：上沿、下沿各一张很宽的左圆角加横线（slice），右圆角一张 RADIUS 见方的小图', async () => {
  for (const side of ['top', 'bottom'] as const) {
    const f = frameSvg(side)
    expect(f.left).toContain(`width="${CANVAS_W}" height="${RADIUS}"`)
    expect(f.left).toContain('preserveAspectRatio="xMinYMid slice"')
    expect(f.left).toContain(`H${CANVAS_W}`)
    expect(f.right).toContain(`width="${RADIUS}" height="${RADIUS}"`)
    expect(f.left + f.right).toContain('class="arc"')
  }
})
