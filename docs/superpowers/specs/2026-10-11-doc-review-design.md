# doc-review 设计文档

- 日期：2026-10-11
- 状态：待评审

## 1. 背景与目标

Claude 经常生成 md 或 HTML 文档给用户 review。现在的流程是：用户看完文档，再回到聊天框把意见逐条打出来，体验很差。

桌面版自带的划词「回复」只在聊天记录里有，文件面板和浏览器面板里都没有（2026-10-11 实测）。

**目标**：用户在 Claude 桌面版右侧的浏览器面板里阅读文档，选中文字就地评论，攒多条后一键发送，评论自动进入当前会话；Claude 修改文档后页面自动刷新，评论显示处理结果。md 和 HTML 都支持，全程只在本机运行，不上传任何内容。

**第一版不做**：评论回复和讨论串、多人协作、导出评论。

## 2. 用户流程

1. 用户让 Claude 生成方案或页面。Claude 写完文件后调用 `review_open`，在浏览器面板打开评审页。只是改代码时顺带生成的 md/HTML 不打开。
2. 用户在评审页里选中文字，弹出浮条〔评论〕，写下意见，保存为草稿。
3. 用户点底部的〔发送给 Claude〕，草稿变为「处理中」。
4. mod 把这一批评论作为一条消息发进当前会话。
5. Claude 修改文件，并对每条评论调用 `review_resolve` 写处理说明。
6. 页面自动刷新，评论变为「已解决」并显示说明。用户继续下一轮。

用户也可以用 `/doc-review <文件>` 手动打开任意 md/HTML 文件。

## 3. 评审页交互

### 3.1 布局

右侧面板较窄，不做左右分栏。

- **文档切换**：放在底部固定栏左侧，是一个下拉框，列出本会话里的待评审文档，每项显示未解决的评论数。不做顶部栏，避免挡住 HTML 页面自己的导航。
- **正文**：占满宽度。md 在浏览器端渲染，支持 GFM 表格、代码高亮、mermaid；HTML 按原样显示。
- **底部固定栏**：「待发送 N 条 ·〔发送给 Claude〕」，点开展开评论列表抽屉。抽屉按状态分组：草稿、处理中、已解决（默认折叠）、原文已变动。

### 3.2 写评论

1. 选中文字后，在选区旁弹出深色小浮条〔评论〕。
2. 点击后出现输入框：回车保存，Shift+回车换行，Esc 取消。
3. 保存后，原文显示黄色高亮，段尾挂 💬 标记；点高亮或标记可以查看、修改、删除这条评论（草稿状态下才能改和删）。
4. 选区跨多个块级元素时，以选中的纯文本为准。

### 3.3 评论状态

| 状态 | 值 | 时机 | 页面表现 |
|---|---|---|---|
| 草稿 | `draft` | 已保存、未发送 | 黄色高亮，可改可删 |
| 处理中 | `sent` | 已发送 | 蓝色高亮，锁定 |
| 已解决 | `resolved` | Claude 调用了 `review_resolve` | 去掉高亮，在抽屉里显示原评论和处理说明 |

### 3.4 文档更新

- 文件变化后页面自动刷新，并保持滚动位置。
- 刷新后用 `quote` + `prefix` + `suffix` 重新定位每条未解决的评论。找不到原文的评论放进抽屉的「原文已变动」分组，评论不会丢。

### 3.5 HTML

服务返回 HTML 时注入评审脚本。评审界面挂在 Shadow DOM 里，与原页面样式互不干扰。高亮使用浏览器的 CSS Custom Highlight API，不修改页面 DOM 结构；对原页面唯一的改动是插入一个定义高亮颜色的 `<style>`。原页面自己的脚本照常运行。

HTML 里的相对路径资源（图片、样式）通过注入 `<base href="/asset/<文档 ID>/">` 由服务从文档所在目录提供，用 `os.OpenRoot` 限制不能越出该目录。

## 4. 数据与流转

### 4.1 存储

所有数据放在 `~/.claude/doc-review/` 下，项目仓库里不会产生任何文件。

```
~/.claude/doc-review/
├── server.json                    # 正在运行的服务：端口、令牌、pid
├── docs/<路径 sha1 前 16 位>.json   # 每个文档一份
└── outbox/<会话 ID>/<批次 ID>.json # 待送进会话的批次，送达后删除
```

文档文件：

```json
{
  "id": "路径 sha1 前 16 位",
  "path": "/abs/path/to/file.md",
  "kind": "md",
  "session": "会话 ID",
  "comments": [
    {
      "id": "c_8f2a1b",
      "quote": "选中的原文",
      "prefix": "原文前 30 个字",
      "suffix": "原文后 30 个字",
      "body": "评论内容",
      "status": "draft",
      "createdAt": "2026-10-11T10:00:00+08:00",
      "sentAt": null,
      "batch": null,
      "resolution": null
    }
  ]
}
```

`resolution` 解决后为 `{ "note": "处理说明", "at": "时间" }`。

批次文件：

```json
{
  "batch": "b_20261011_100500_x1",
  "doc": "文档 ID",
  "path": "/abs/path/to/file.md",
  "comments": [{ "id": "c_8f2a1b", "quote": "……", "body": "……" }]
}
```

### 4.2 写入规则

本地服务是 `docs/` 和 `outbox/` 的唯一写入者。mod 只通过 HTTP 接口（`$.http.fetch`）与服务交互：登记、标记已解决、取批次（`GET /api/outbox`）、确认送达（`POST /api/outbox/ack`，服务随即删除批次文件）。

### 4.3 会话路由

- `review_open` 把文档登记到调用它的会话名下。
- 同一个文件被不同会话先后登记时，以最后一次为准。
- 发送时，服务把批次写到文档当前所属会话的 outbox 目录。每个会话的 mod 只读自己的目录。

### 4.4 送进会话的消息格式

```
[文档评审] docs/xxx.md 有 3 条新评论：

1. [c_8f2a1b] 原文：「……」
   意见：……
2. ……

处理完后，请对每条评论调用 review_resolve 说明处理结果。
```

路径显示为相对会话工作目录的路径；不在工作目录下时显示绝对路径。

## 5. 组成与技术选型

### 5.1 仓库结构

仓库根目录本身就是 mod，通过 `CLAUDE_CODE_PLUGIN_DIRS` 加载。

```
doc-review/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json
│   └── register.ts
├── types/index.d.ts              # mod 的 $.state 契约（用到时才加）
├── server/
│   ├── main.go
│   ├── store/                    # 文档与评论读写
│   ├── api/                      # HTTP 接口
│   └── web/                      # 评审页资源，go:embed 打包
│       ├── review.js / review.css
│       ├── anchor.js             # 原文定位，独立模块，可单测
│       └── vendor/               # marked、highlight.js、mermaid，内置不联网
├── Makefile                      # make build → bin/doc-review-server
└── docs/superpowers/specs/
```

### 5.2 本地服务（Go）

- 选 Go 的原因：作者熟悉；单个二进制，不依赖 nvm 下的 node；页面资源用 `go:embed` 打包，运行时不需要联网，也不用 `npm install`。
- 只监听 `127.0.0.1`。默认端口 4823，被其他程序占用时依次尝试到 4830。实际端口、令牌、pid 写入 `server.json`。
- 不引入第三方 Go 依赖。

接口（全部要求带令牌：评审页从链接参数 `t` 取，页面内的接口调用和 mod 的调用放在请求头 `X-Review-Token`；`/api/health` 例外，只返回服务名和版本）：

| 方法与路径 | 调用方 | 作用 |
|---|---|---|
| `GET /review?doc=<id>&t=<令牌>` | 浏览器 | 评审页 |
| `GET /raw?doc=<id>` | 评审页 | 文档原文（md）或注入脚本后的 HTML |
| `GET /events?doc=<id>` | 评审页 | SSE，文件变化或评论状态变化时推送 |
| `GET /api/docs?session=<id>` | 评审页 | 本会话的文档列表与未解决数 |
| `GET/POST/PATCH/DELETE /api/comments` | 评审页 | 评论增删改查（只有草稿能改和删） |
| `POST /api/send` | 评审页 | 把草稿变为处理中，并写入 outbox |
| `POST /api/open` | mod | 登记文档，返回文档 ID 和评审链接 |
| `POST /api/resolve` | mod | 标记已解决并写入说明；部分 ID 找不到时返回 `{resolved, missing}`，全部找不到时 404 |
| `GET /api/outbox?session=<id>` | mod | 取本会话待送达的批次 |
| `POST /api/outbox/ack` | mod | 确认某批次已送达，服务删除批次文件 |
| `GET /api/health` | mod | 返回服务名和版本，用于判断端口上是不是自己 |
| `GET /api/doc?doc=<id>` | 评审页 | 文档详情与全部评论 |
| `GET /asset/<id>/<相对路径>` | 浏览器 | HTML 同目录资源，不校验令牌；只服务 HTML 文档，不提供点开头的路径 |

- 文件变化检测：每 500ms 检查一次已登记且有页面订阅的文件的修改时间，不使用 fsnotify。
- 只允许访问登记过的文件；`/api/open` 只接受 `.md`、`.markdown`、`.html`、`.htm`。
- 所有请求（含不校验令牌的接口）只接受 Host 为 `127.0.0.1:<端口>` 或 `localhost:<端口>`，防 DNS 重绑定。

### 5.3 mod（TypeScript）

- **会话开始**：读取 `server.json` 并用 `$.http.fetch` 调 `/api/health`；服务不在就用 `$.process.run` 执行 `/bin/sh -c 'nohup <二进制> >><日志> 2>&1 &'` 在后台启动。不用 `$.process.spawn`，因为它启动的进程会随会话（mod 卸载）被杀掉；后台启动的服务由所有会话共用，不随任何会话退出。
- **工具**：
  - `review_open(path)`：登记文档，返回评审链接。工具说明里写明，返回后要在浏览器面板打开这个链接。
  - `review_resolve(ids, note)`：可以一次处理多条，`note` 也可以按条分别给出。
- **命令**：`/doc-review <文件>`，登记文档后发一条消息，让 Claude 在浏览器面板打开评审页。
- **系统提示规则**（`prompt.compose` 追加一节）：生成需要用户评审的 md/HTML（方案、设计、文案、报告、页面）后，调用 `review_open` 并在浏览器面板打开；随代码改动顺带修改的 README 等不需要。
- **投递**：用 `$.clock.every` 每秒调一次 `GET /api/outbox?session=<会话 ID>`，有批次就 `$.prompt.submit({ text, asUser: true })` 发进会话，再调 `/api/outbox/ack` 确认。会话正在处理时排队，等这一轮结束再送。`submit` 失败时退回 `$.prompt.fill` 填进输入框，并用 toast 提示用户按回车。
- **守护**：工具调用时服务不可达，就重启一次再重试；仍失败则返回明确的错误。

### 5.4 安全

- 只监听本机。
- 服务每次启动生成随机令牌，带在评审链接里，并写入页面供接口调用使用。没有令牌的请求一律拒绝，防止其他网页通过 localhost 调用接口。
- 只能读取登记过的文件。
- md 的渲染结果经 DOMPurify 净化后再插入页面；评审界面全部用 DOM API 构建，不用 `innerHTML` 拼接内容。

## 6. 出错处理

| 情况 | 处理 |
|---|---|
| 二进制还没编译 | mod 用 toast 提示「请先在 doc-review 目录运行 make build」，工具返回同样的错误 |
| 服务不可达 | 重启一次服务后重试；仍失败则返回错误，并给出日志路径 |
| 4823～4830 端口都被占用 | 启动失败，报错说明 |
| 文件被删除或移走 | 页面提示「文件不存在」，评论保留 |
| 不支持的文件类型 | `review_open` 返回错误 |
| 原文被改，找不到评论位置 | 评论放进「原文已变动」分组 |
| 消息发不进会话 | 填进输入框，toast 提示按回车 |

## 7. 测试

- **Go 单元测试**：评论存储与状态流转、发送写 outbox、令牌校验、只允许访问登记过的文件、端口回退。
- **前端单元测试**：`anchor.js` 的原文定位，包括重复出现的原文、原文被改、跨段落选区，用 `node --test` 运行。
- **mod 测试**：`claude plugin test`，覆盖工具注册、系统提示规则、outbox 投递和失败时退回填充输入框。
- **端到端**：在浏览器面板里用一份 md 和一份 HTML 实际走一遍：划词、评论、发送、消息进入会话、修改文件、页面刷新、评论标记已解决。「mod 主动发消息进会话」在这一步首先验证。

## 8. 安装

1. 在仓库根目录运行 `make build`
2. 在 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS` 里追加本目录，用 `:` 和已有路径分隔。
3. 重启桌面版会话。
