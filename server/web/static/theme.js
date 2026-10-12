// 评审页外框（顶栏、评论栏）跟着文档的明暗走：Markdown 跟随系统；HTML 看页面实际的背景色。

/** 浏览器默认画布色：页面没设背景时露出来的就是它。*/
const CANVAS = { light: '#ffffff', dark: '#121212' }

const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i

/**
 * 解析 getComputedStyle 给出的颜色（rgb() / rgba()，空格或逗号分隔）；解析不了返回 null。
 * @param {string} text
 */
export function parseColor(text) {
  const m = String(text ?? '').trim().match(RGB)
  if (!m) return null
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4])
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha }
}

/** 相对亮度（0 黑 ~ 1 白），按 sRGB 公式。*/
function luminance({ r, g, b }) {
  const lin = v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/**
 * HTML 文档的明暗和外框底色：先看 body、再看 html 的不透明背景色；都没设就是浏览器画布，
 * 画布只有页面声明了 color-scheme 含 dark（且系统是深色或只声明了 dark）时才是深色。
 * @param {{ body?: string, html?: string, scheme?: string, prefersDark: boolean }} page
 * @returns {{ theme: 'light' | 'dark', bar: string }}
 */
export function pageTheme({ body, html, scheme = '', prefersDark }) {
  for (const text of [body, html]) {
    const c = parseColor(text ?? '')
    // 亮度 0.18 约是中灰：比它暗的底色配浅色文字
    if (c && c.a >= 0.5) return { theme: luminance(c) < 0.18 ? 'dark' : 'light', bar: String(text) }
  }
  const words = String(scheme).split(/\s+/)
  const theme = words.includes('dark') && (!words.includes('light') || prefersDark) ? 'dark' : 'light'
  return { theme, bar: CANVAS[theme] }
}

/**
 * 页面自己没写任何样式（没有样式表、body 也没有 style 属性）：评审页给它加默认的边距和行高。
 * 评审页自己注入的样式带 data-doc-review，不算。
 * @param {Document} doc
 */
export function isUnstyled(doc) {
  return !doc.querySelector('style:not([data-doc-review]), link[rel~="stylesheet"]') && !doc.body?.hasAttribute('style')
}

/** 给没写样式的 HTML 文档用的默认排版，和 Markdown 的正文一致。*/
export const PLAIN_STYLE =
  'body{max-width:860px;margin:0 auto;padding:32px 40px 64px;' +
  'font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}'
