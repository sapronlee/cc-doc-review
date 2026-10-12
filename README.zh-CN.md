# CC-Doc-Review

[English](README.md) | 简体中文

一个 Claude Code 插件，用来评审 Claude 写的文档。在浏览器面板里打开 Markdown 或 HTML 文件，选中文字写评论，再把评论送回 Claude Code 会话。Claude 改完文档后页面自动刷新，每条评论标记为已解决并附上处理说明。全部在本机运行。

## 安装

```
/plugin marketplace add sapronlee/claude-plugins
/plugin install cc-doc-review@sapronlee
```

第一条命令添加的是 [SummErOK 的插件市场](https://github.com/sapronlee/claude-plugins)，名字叫 `sapronlee`，市场里的所有插件共用，只需添加一次。`cc-doc-review@sapronlee` 的格式是「插件名@插件市场名」。

然后新开一个会话。不需要装 Go：第一次使用时，插件会从本仓库的 GitHub Releases 下载预编译好的评审服务（见[系统要求](#系统要求)）。

## 使用

说明：评审页和插件自身的提示（弹出提示、状态带、评审卡片）目前都是中文。

- **打开文档。** Claude 写出命中自动登记模式的文档后，插件会登记评审并给你弹出提示，不会通知 Claude。对话里的评审卡片（文件名、相对路径、待发送 / 处理中 / 已解决条数，带〔在浏览器打开〕〔在面板打开〕按钮；画不了卡片时是一个链接）只在 Claude 调用 `review_open` 时才出现，所以请让 Claude 把文档打开评审。也可以用 `/cc-doc-review <文件>` 手动打开任意文件。
- **查看进度。** 说「评审进度」「看评论」（英文说 "review progress" 也可以），Claude 会调用 `review_status` 工具列出本会话各文档的进度和待处理评论，能画卡片时画汇总卡片。
- **写评论。** 选中文字，点〔评论〕，回车保存。攒好后点底部〔发送给 Claude〕。右侧评论栏里可以修改、删除草稿，也能查看已解决评论的处理说明。
- **Claude 处理。** Claude 修改文档，并给每条评论写处理说明、标记已解决。页面自动重新加载，评论会重新定位到改动后的文字上。
- **评论送达。** 评论进入会话时弹出提示，告知已收到 N 条评论、Claude 正在处理。发不进去时，插件隔 5、15、45 秒重试；仍不行就把评论附在你的下一条消息上一起交给 Claude（不会填进输入框）。
- **漏回复提醒。** 一轮结束时，已送达的评论仍没有处理结果，插件会提醒 Claude 一次（每批评论最多一次）并弹出提示。子代理、被中断或出错的轮次，以及还没送达的评论，都不检查。

### 桌面版与命令行版

| | Claude 桌面版 | Claude Code 命令行版 |
|---|---|---|
| 打开评审页 | 对话里的评审卡片，或状态带 | 评审卡片，或状态带 |
| 输入框上方的状态带 | 本会话有未解决评论时显示 | 本会话有未解决评论时显示 |
| 弹出提示（已送达、已提醒） | 显示 | 显示 |

桌面版的状态带只有一行，靠左排：先是「评审」，后面的文档和下面的用量一样平铺不加框：状态图标加文件名，文件名是链接，点了直接在系统浏览器打开评审页（桌面版里插件界面上的链接都走外部浏览器，不经过 Claude）。想在浏览器面板里看，用对话里评审卡片上的〔在面板打开〕。每篇文档处在一个评审状态：**待评审**（Claude 写完或改完，等你给结论）、**未发送**（你写了评论还没发）、**待确认**（Claude 处理完，等你核对）、**Claude 处理中**。文件名左边的图标用形状和颜色一起表示状态：待评审是粉色放大镜，未发送是黄色铅笔，待确认是绿色勾，Claude 处理中是灰色沙漏。轮到你的排在前面；放几个由宽度决定，其余收成「+N」。鼠标停在「评审」上是各状态的图例和篇数，停在文件上是全名和「状态 · 目录 · 更新时间」。在评审页顶栏点〔通过〕表示这篇定稿，文档从状态带消失，Claude 会收到「已通过」的通知；24 小时没有变化的文档也会退出状态带。同一位置还有其他插件的内容（比如用量带）时，两块之间画一条细分隔线；只有一块时不画。

输入框上方这块位置由多个插件共用，按加载顺序一层套一层。本插件画完自己那一行后，会把内层插件（比如用量插件 [CC-Gauge](https://github.com/sapronlee/CC-Gauge)）的内容接在下面；但如果外层插件画完不让位，状态带就显示不出来，这时把本插件排到它前面即可。

### 休眠模式

插件全局安装，但在会话里真正用到评审之前一直休眠：不往系统提示里加评审规则（工具说明仍在），也不轮询。休眠时仍保留评审工具、斜杠命令和写文件时的路径匹配。出现以下任一情况就唤醒，并保持到会话结束：Claude 调用任一评审工具、你使用 `/cc-doc-review`、自动登记命中，或本会话登记过文档（会话开始时查一次；服务不在时读本机数据，本会话有文档就直接启动服务）。`/clear` 后回到休眠。

## 配置

有两种设置方式，修改后新开的会话生效：

- 在命令行版 Claude Code 里运行 `/plugin`，进入已安装的插件，选中 `cc-doc-review`，选「Configure options」。
- 直接编辑 `~/.claude/settings.json`，选项在 `pluginConfigs` 下，键是「插件名@插件市场名」。没写的项用默认值：

```json
{
  "pluginConfigs": {
    "cc-doc-review@sapronlee": {
      "options": {
        "includePatterns": "design/**/*.md,**/specs/**/*.md",
        "excludePatterns": "**/drafts/**",
        "autoRegister": true
      }
    }
  }
}
```

| 选项 | 默认值 | 含义 |
|---|---|---|
| `autoRegister` | `true` | Claude 写完命中模式的文档后自动登记评审。关闭后只能用 `/cc-doc-review`，或让 Claude 调用 `review_open`。 |
| `includePatterns` | `**/specs/**/*.{md,html},**/plans/**/*.{md,html},**/docs/**/*.{md,markdown,html,htm}` | 要登记的文档的 glob 模式，逗号分隔。 |
| `excludePatterns` | `**/.superpowers/**,**/node_modules/**,**/vendor/**,**/dist/**,**/.git/**,**/.claude/**,**/README*,**/CHANGELOG*,**/CLAUDE.md` | 绝不登记的 glob 模式，逗号分隔。 |

模式语法：

- 模式匹配**相对会话工作目录**的路径，不区分大小写。
- `**` 匹配任意层目录，`*` 匹配名称中的任意字符，`?` 匹配单个字符，`{a,b}` 匹配其中之一。大括号里的逗号不会拆分模式。
- 单个模式最多 8 个 `*` / `**` 通配符（展开 `{a,b}` 后逐项计算），超过的模式会被忽略。
- 同时命中包含和排除的路径按**排除**处理（排除优先）。
- 包含模式留空什么都匹配不到，所以自动登记什么也不做。
- 以 `/` 开头的模式，以及以 `/` 结尾的目录式模式（如 `docs/`），什么都匹配不到；请改写成 `docs/**`。
- 只考虑主对话里用 Write 或 Edit 写的文件。工作目录之外的文件、子代理写的文件始终不自动登记。
- 例：只想评审 `design/` 下的 Markdown，把 `includePatterns` 改成 `design/**/*.md`。

自动登记失败只提示一次，之后一分钟内不再尝试。

## 工作方式

```
Claude 写文档 ──> 插件钩子 ──> 本地评审服务（127.0.0.1）──> 浏览器面板里的评审页
      ^                                                          │ 你选中文字写评论
      │                                                          v
Claude 改文档，调用 review_resolve <── 评论作为一条消息发进会话
```

- `server/`：Go 写的小型服务（只用标准库），监听 `127.0.0.1` 的 4823～4830 端口，提供评审页，评论保存在 `~/.claude/cc-doc-review/`。评审页打包进二进制；Markdown 用 marked 渲染、DOMPurify 净化，代码和图表用 highlight.js 和 mermaid（见 `THIRD_PARTY_NOTICES.md`）。
- `hooks/` 和 `src/`：Claude Code 插件（hooks 模块），负责启动服务、登记文档、轮询评论、把评论送进会话、检查漏回复。
- 提供给 Claude 的工具：`mcp__cc-doc-review__review_open`、`mcp__cc-doc-review__review_resolve`、`mcp__cc-doc-review__review_status`。

## 安全说明

- 服务只监听 `127.0.0.1`，并只接受 Host 为 `127.0.0.1:<端口>` 或 `localhost:<端口>` 的请求。
- 评审页链接里带着访问令牌（参数 `t`），每次服务启动时重新生成。
- 评审 **HTML** 文档时，评审脚本注入在该页面里，页面自己的脚本也能读到这个令牌，进而调用评审接口；只评审你信任的 HTML。
- `/static/`（内置前端文件）和 `/api/health`（只返回名称和版本）不校验令牌。
- `/asset` 同样不校验令牌，提供 HTML 文档所在目录及其子目录下的资源，不提供以点开头的文件或目录（`.env`、`.git` 等）。文档 ID 由文件路径推算（绝对路径 SHA-1 的前 16 位十六进制），本机上的其他进程可以对已登记的 HTML 文档请求 `/asset`。
- 评审内容不会上传到任何地方。被评审页面里引用的远程图片、脚本仍会由你的浏览器去请求；每个新版本首次使用时会从 GitHub Releases 下载一次服务程序。

## 系统要求

- macOS 或 Linux（x86_64 或 arm64），不支持 Windows。
- 支持插件的 Claude Code。
- 第一次使用时，插件用 `curl` 从本仓库的 GitHub Releases 下载对应平台的预编译服务程序，按该版本的 `SHA256SUMS` 校验 SHA-256，保存为 `~/.claude/cc-doc-review/bin/cc-doc-review-server-<版本>`。下载失败而本机装有 Go 1.24 及以上时，退回本地编译 `server/`；两者都不行会给出带平台和原因的错误。
- `/plugin update` 之后，需要的新版本程序会按需下载，运行中的旧版服务会重启为新版。

## 开发

```
make build     # 编译 bin/cc-doc-review-server，版本号取自 .claude-plugin/plugin.json
make test      # Go 测试与 vet、前端测试、插件测试
make run       # 编译并运行服务
```

- `./bin/cc-doc-review-server -port <端口>` 只监听指定的单一端口，不在 4823～4830 中扫描。
- **开发模式：** 插件目录下有 `bin/cc-doc-review-server` 时，插件优先用它而不是下载的版本，版本变化也不自动重启。改了服务代码后，先结束旧进程（`kill $(jq .pid ~/.claude/cc-doc-review/server.json)`），再 `make build`，下次调用时就会启动新版本。想从工作副本运行插件，用 `claude --plugin-dir <路径>` 启动 Claude Code；桌面版等没法传参数的场景，改为设置环境变量 `CLAUDE_CODE_PLUGIN_DIRS` 指向该目录。
- 服务日志：`~/.claude/cc-doc-review/server.log`。
- **发版：** 修改 `.claude-plugin/plugin.json` 的 `version`，再推送同名标签 `v<版本>`。GitHub Actions 会检查标签是合法版本号且与 `plugin.json` 一致，运行 `go test` 和 `go vet`，编译四个平台的程序，连同 `SHA256SUMS` 上传到该标签的 Release；标签与 `plugin.json` 版本不一致会失败。[插件市场](https://github.com/sapronlee/claude-plugins)里本插件的条目不带版本号，所以只需改 `plugin.json`。`make release-local` 在本地演练产物，输出到 `dist/`。打标签前请先在本地运行 `make test`：CI 只跑 Go 测试，不跑前端和插件测试。

### 从旧版 `doc-review` 迁移

旧版插件名为 `doc-review`，数据在 `~/.claude/doc-review/`。新版服务首次启动时，会结束仍在运行的旧服务；新目录里没有 `docs/` 时，把旧目录的 `docs/`、`outbox/` 复制过来。旧目录保留不删。

## 许可证

[MIT](LICENSE)。评审页打包的第三方库见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
