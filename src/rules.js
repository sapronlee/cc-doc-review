// open_doc 的工具说明和返回给 Claude 的文字。说明写在工具里，不加进系统提示：没用到文档回复的会话里插件不占系统提示（休眠模式）。

import { displayName } from './bandview.js'
import { t } from './i18n.js'
import { shownPath } from './reply.js'

export const OPEN_TOOL = 'mcp__cc-doc-review__open_doc'

export const OPEN_SPEC = {
  name: 'open_doc',
  description: `Register a Markdown or HTML file so the user can select text in it and reply to you, the way they quote a message in chat. Registering is not a review: the user does not need to confirm or approve anything.
When to call: after you write or substantially revise a document meant for the user to read (a plan, design, report, copy, page), pass its path. Also call it whenever the user asks to comment on, reply to, review or mark up a file: pass that file's path, even one you did not write. Call it for files that were registered automatically too, to get the link. Skip README, CHANGELOG, CLAUDE.md and similar files edited alongside code. Only call it from the main conversation, never from a subagent.
Then put the returned link in your reply, so the user can open the document.
The user's replies arrive in a message that starts with "[文档回复]" or "[Doc reply]": each reply is numbered (<!-- reply N -->) and quotes the text it is about. Answer every reply by its number in your response: what you changed, or why you did not.`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path of the .md or .html file, absolute or relative to the working directory' } },
    required: ['path'],
  },
  isDeferred: false,
}

/**
 * open_doc 返回给 Claude 的文字：只有路径和链接（附一个可以直接放进回话的 Markdown 链接）。
 * @param {string} path @param {string} url @param {string} cwd @param {import('./i18n.js').Lang} lang
 */
/** 让 Claude 有内置浏览器（桌面版旁边的浏览器面板）时直接在里面打开文档页：插件自己调不动那个浏览器。*/
export const BROWSER_HINT =
  "If you have a tool that opens a page in a browser pane inside this app (such as the desktop app's built-in browser), open the Link there now so the user can reply beside this conversation; never use the user's own browser for it. Still put the reply link in your answer."

export function openText(path, url, cwd, lang) {
  const label = t(lang, 'openLink', { name: displayName(path, 40) }).replace(/[\\[\]]/g, ch => `\\${ch}`)
  return [
    `Registered: ${shownPath(path, cwd)}`,
    `Link: ${url}`,
    `For your reply: [${label}](${url})`,
    BROWSER_HINT,
  ].join('\n')
}
