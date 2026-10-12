// 工具说明：模型据此决定何时打开评审页、如何回报处理结果。
// 规则写在 review_open 的说明里，不加进系统提示：没用到评审的会话里插件不占系统提示（休眠模式）。

export const OPEN_TOOL = 'mcp__cc-doc-review__review_open'
export const RESOLVE_TOOL = 'mcp__cc-doc-review__review_resolve'
export const STATUS_TOOL = 'mcp__cc-doc-review__review_status'

export const OPEN_SPEC = {
  name: 'review_open',
  description: `登记一个 md 或 HTML 文件供用户划词评论，返回评审页链接。
何时调用：你为用户生成或大幅修改了需要用户阅读评审的 md 或 HTML 文件（方案、设计、文案、报告、页面等），写完后调用，传入文件路径。随代码改动顺带修改的 README、CHANGELOG、CLAUDE.md 等不需要调用。
只在主对话里调用；子代理不要调用 review_open，也不要打开评审页。
拿到结果后按返回文字里的「展示方式」给用户看：能在对话中渲染 HTML 卡片时画评审卡片，否则给出链接；用户要在浏览器面板看时用 preview_start 传 url 打开（面板已打开时用 navigate）。
用户在评审页里发送的评论会以「[文档评审]」开头的消息送达，也可能附在用户的消息上。逐条处理：按意见修改文件；每条处理完调用 ${RESOLVE_TOOL}，写清改了什么，没改的说明原因。
用户问评审进度、要看评论时调用 ${STATUS_TOOL}。`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径，绝对路径或相对当前工作目录' } },
    required: ['path'],
  },
  isDeferred: false,
}

export const RESOLVE_SPEC = {
  name: 'review_resolve',
  description: '把用户的评审评论标记为已解决，并写明处理说明。可一次处理多条。',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '评论 ID，形如 c_8f2a1b3c' },
            note: { type: 'string', description: '怎么改的；没改就写原因' },
          },
          required: ['id', 'note'],
        },
      },
    },
    required: ['items'],
  },
  isDeferred: false,
}

export const STATUS_SPEC = {
  name: 'review_status',
  description: `查看本会话的文档评审进度：各文档的路径、评审链接、待发送 / 处理中 / 已解决条数，以及待处理（已发送、还没解决）的评论（ID、原文、意见）。
用户说「评审进度」「看评论」「还有哪些评论没处理」时调用；按返回文字里的「展示方式」给用户看（能渲染 HTML 卡片时画汇总卡片）。`,
  inputSchema: { type: 'object', properties: {} },
  isDeferred: false,
}
