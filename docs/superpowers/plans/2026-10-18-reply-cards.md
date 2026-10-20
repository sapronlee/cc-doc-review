# CC-Doc-Review v0.3.0「文档回复」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 0.2.0 的评审审批流程换成「文档上的回复」：划词写回复 → 卡片出现在输入框上方 → 随消息发给 Claude；去掉状态、通过、逐条处理结果和提醒；右侧「文档」面板做入口。

**Architecture:** 服务端（Go）保留文档登记、页面、SSE，把「草稿评论」当作待发送回复，新增按会话取回复（已分组、编号）和标记已发送的接口，删掉发送批次 / 通过 / 处理结果整套。插件（hooks/register.js + src/ 纯函数）每秒取回复画回复区，在 `prompt.submit` 把回复写进消息正文，重画聊天记录里的回复消息，开右侧文档面板。文档页（server/web/static）换成 Claude 自带样式的回复框和编号标记，并在内容刷新时标出改动。

**Tech Stack:** Go 1.24 标准库；Claude Code mod API（`$`，桌面版内置 2.1.299）；浏览器原生 ES module，无构建；测试用 `go test`、`node --test`、`claude plugin test`。

**Spec:** `docs/superpowers/specs/2026-10-18-reply-cards-design.md`（下称「设计文档」）；交互设计稿 `docs/superpowers/specs/2026-10-18-reply-cards-mockup.html`。执行每个任务前先读设计文档里对应的节。

**工作目录：** 仓库根目录，分支 `feat/reply-cards`（已含设计文档提交）。不切分支、不推送、不打 tag、不发布；不改用户的全局设置。

**本计划的写法说明：** 沿用 0.2.0 计划的写法，每个任务给出确切的行为、接口和验收测试，不贴整段实现代码；每个任务先写会失败的测试，再实现，测试全过后单独提交。

## Global Constraints

- 服务端只用 Go 标准库；前端不引入构建工具，不用 `innerHTML` 拼用户内容（沿用 overlay.js 的 `el()`）。
- 源码中文字符串用全角标点（`"已发给 Claude"`、`"N 条回复待发送"`），与 autocorrect 一致。
- 引擎限制：`$` 不能传进 import 来的函数。凡是调 `$` 的代码写在 `hooks/register.js`，`src/` 只放纯函数。
- 样式只用设计文档第 4 节的值：字号 13（主要）/ 12（次要），行高 18，间距 4 的倍数，卡片宽 200、圆角 8，竖线 2、其余线 1；颜色浅 / 深两套：主文字 `#3d3d3a` / `#e6e4dd`，次要 `#8b8f97` / `#9aa0a8`，强调 `#c96442` / `#e8916f`，分隔线黑 12% / 白 16%，边框黑 10% / 白 13%，竖线黑 20% / 白 22%，卡片底黑 3% / 白 4%。
- 能点的只有原生 `Button`；× 在卡片 / 行右上，〔展开 / 收起〕〔清空〕〔发送〕在标题行最右。
- 叫法统一为「回复」，界面不再出现「评论」「评审」「通过」「待确认」；中英两套文字放 `src/i18n.js` 一张表（设计文档 3、3.2 节的表照抄）。
- 工具名 `review_open` 改为 `open_doc`；`review_resolve`、`review_status` 删除。插件名、数据目录、斜杠命令 `/cc-doc-review` 不变。
- 版本号 0.3.0（plugin.json）；服务端 `/api/health` 的版本随之变化，插件靠 `needsRestart` 自动重启旧服务。
- 每个任务结束前全部跑一遍并通过：`cd server && go test ./... && go vet ./...`、`node --test tests/web/`、`claude plugin test .`、`claude plugin validate .`、`make build`；跑完删掉生成的 `tests/*.test.js`。
- 自测服务端用 `-dir <临时目录> -port 4831` 起一个独立实例，不碰 `~/.claude/cc-doc-review` 里的真实数据。
- 桌面版限制以设计文档第 14 节为准：不能画 `ToolResult`；`ToolUse` 只在执行中可画；插件界面的本机链接走系统浏览器；自动模式下插件直接调内置浏览器一律被拒。

---

### Task 1：服务端——回复接口，删掉评审流程

**Files:**
- Modify: `server/store/store.go`、`server/api/api.go`、`server/api/pages.go`（只动 `/review` 读 `lang`、记录打开时间）
- Test: `server/store/store_test.go`、`server/api/api_test.go`、`server/api/pages_test.go`

**Interfaces:**
- Produces（HTTP，均要令牌）：
  - `GET /api/replies?session=<id>` → `{ groups: [ { doc, path, kind, replies: [ { id, no, quote, prefix, suffix, body, createdAt } ] } ], total }`
  - `POST /api/replies/sent {ids: [...]}` → `{ sent: n, missing?: [...] }`
  - `DELETE /api/comments?doc=&id=`（保留）；新增 `DELETE /api/replies?session=` 清空本会话全部待发送回复 → `{ deleted: n }`
  - `GET /api/docs?session=` → `[ { id, path, kind, openedAt, modifiedAt, seenAt, pending } ]`
  - `GET /api/doc?doc=` → Doc，`comments` 只含待发送（draft）的
- Produces（Go）：`func (s *Store) Replies(session string) ([]ReplyGroup, error)`、`func (s *Store) MarkSent(ids []string) (int, []string, error)`、`func (s *Store) ClearReplies(session string) (int, error)`、`func (s *Store) MarkSeen(docID string) error`；类型 `ReplyGroup{Doc, Path, Kind string; Replies []Reply}`、`Reply{ID string; No int; Quote, Prefix, Suffix, Body string; CreatedAt time.Time}`、`DocSummary{ID, Path, Kind string; OpenedAt, ModifiedAt, SeenAt *time.Time; Pending int}`；`Doc` 增加 `SeenAt *time.Time`（json `seenAt,omitempty`）。

**行为**
- 回复 = 状态为 `draft` 的评论，`AddComment` / `DeleteComment` 不变。
- `Replies`：取 `Doc.Session == session` 的文档里所有 draft，按文档分组；组的顺序按组内最早一条的 `CreatedAt`，组内按 `CreatedAt`；`No` 从 1 起全局连续（设计文档 5.5、7.2）。
- `MarkSent`：把这些 ID 的 draft 改成 `sent` 并记 `SentAt`，不写 outbox；已不是 draft 的算 missing，全部 missing 返回 `ErrNotFound`。
- `ClearReplies`：删掉本会话所有 draft。
- `ListBySession`：`ModifiedAt` 取文件 mtime（文件不存在时为 nil），`Pending` 为 draft 数；按 `max(ModifiedAt, OpenedAt)` 倒序（设计文档 10.1「最近更新的在上」）。
- `/review` 页面被打开时调 `MarkSeen`（插件据此判断「新」标记）。
- 删除：`StateOf` 与状态常量、`DocView.State`、`Approve`、`Send`、`Outbox`、`Ack`、`Resolve`、`Batch` / `BatchComment` / `KindApprove` / `ResolveItem`、`ErrNoDrafts`、`ErrNotReady`、`outbox/` 目录的创建；路由 `/api/send`、`/api/approve`、`/api/outbox`、`/api/outbox/ack`、`/api/resolve`。旧文件里的 `approvedAt`、`resolution` 等字段照常读入、原样写回（设计文档 11 节），不报错。
- `/events` 不变（文件 mtime、`Revision` 变化即推送）。

**验收测试**
- store：两份文档交错加 3 条回复 → 分组顺序、组内顺序、`No` 为 1/2/3；别的会话的回复不出现；`MarkSent` 后 `Replies` 不再返回、文件里状态为 sent；部分 ID 不存在时返回 missing；`ClearReplies` 只删本会话；`ListBySession` 的 `Pending`、`ModifiedAt`、排序；`MarkSeen` 写入 `SeenAt` 且 `Revision` 加 1；带旧字段（`approvedAt`、`resolved` 评论、`batch`）的 json 能读、写回后字段仍在。
- api：上面三个新接口的正常与 404 / 400；已删路由返回 404；令牌、Host 检查照旧；`GET /review` 后 `seenAt` 有值。

- [ ] 写失败测试 → 实现 → 全部测试通过 → `git commit -m "feat(server): 回复接口，去掉评审批次、通过与处理结果"`

---

### Task 2：纯函数——文字表、回复块格式与解析

**Files:**
- Create: `src/i18n.js`、`src/reply.js`
- Test: `tests/i18n.test.ts`、`tests/reply.test.ts`

**Interfaces:**
- `src/i18n.js`：`langOf(configRows) → 'zh' | 'en'`（在 `$.config.list()` 的结果里找 `language`，值含「中文」「Chinese」「zh」（不分大小写）为 `zh`，其余或找不到为 `en`）；`t(lang, key, vars?) → string`；`STRINGS = { zh: {...}, en: {...} }`。键至少有：`replyHint`（回复 Claude / Reply to Claude）、`pendingOnPage`（{n} 条回复待发送 / {n} replies to send）、`noReplies`（还没有回复 / No replies yet）、`bandTitle`（{n} 条回复 / {n} replies）、`showingNewest`（显示最新 {n} 条 / showing newest {n}）、`expand` / `collapse` / `clear` / `confirmClear` / `send` / `sending`、`sent`（已发给 Claude / Sent to Claude）、`sendFailed`（没发出去：{reason} / Not sent: {reason}）、`defaultAsk`（请看这几条回复 / Please look at these replies）、`blockHead`（[文档回复] 请按编号逐条答复。 / [Doc reply] Please answer each by number.）、`terminalLine`（{n} 条回复，按回车时一起发给 Claude / {n} replies, sent with your next message）、`docsTitle`（文档 / Docs）、`docsCount`（本会话 · {n} 份 / This session · {n}）、`openInPane`（在面板打开 / Open in pane）、`newTag`（新 / New）、`changes`（改了 {n} 处 / {n} changes）、`askOpenInPane`（请在浏览器面板打开：{name} {url} / Please open in the browser pane: {name} {url}）。
- `src/reply.js`：
  - `formatBlock(groups, lang, cwd) → string`：设计文档 7.2 的回复块（首行 `blockHead`；每组一行「文件名（路径）」，路径在 cwd 下时写相对路径；每条 `<!-- reply N -->`、`> 原文`（多行原文每行加 `> `）、空行、回复内容）。
  - `withReplies(userText, groups, lang, cwd) → string`：用户的话在前，空一行接回复块；用户没写话时只有回复块。
  - `parseMessage(text) → { own: string, groups: [ { name, path, replies: [ { no, quote, body } ] } ] } | null`：认出 `withReplies` 生成的文字；认不出（没有 `blockHead`、格式被改）返回 `null`。
  - `isUserOrigin(origin)`：从 `src/delivery.js` 挪过来（`composer` / `bridge` / `sdk`）。

**验收测试**
- `langOf`：「简体中文」→ zh、「English」→ en、没有 language → en、`zh-CN` → zh。
- `t`：变量替换；中文串全是全角标点（测试里用正则检查 `STRINGS.zh` 不含半角 `:` `(` `)` `,`，URL 占位除外）。
- `formatBlock` / `withReplies` 对一组、两组、原文多行、路径在 / 不在 cwd 下的输出逐字比对。
- `parseMessage(withReplies(...))` 能还原 own、组、编号、原文、内容；只有回复块时 own 为空串；乱改过的文字返回 `null`；英文版同样可解析。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(plugin): 文字表与回复块格式"`

---

### Task 3：纯函数——回复区、消息、面板的版式

**Files:**
- Create: `src/replyview.js`、`src/docsview.js`
- Modify: `src/bandview.js`（只保留仍用到的 `dirOf`、`ago`、`displayName`、`shortName`、`hasDrawnContent`、`dividerLine`、`markdownLink`；删掉状态相关的 `BAND_STATES`、`stateOf`、`bandDocs`、`stateIcon`、`stateDescription`、`visibleDocs`、`fitDocs`、`commentIcon`）
- Test: `tests/replyview.test.ts`、`tests/docsview.test.ts`、改 `tests/band.test.ts`

**Interfaces:**
- `src/replyview.js`：
  - `TOKENS`：设计文档 4.1–4.3 的数值（字号、颜色浅深两套、间距、尺寸），其他模块只从这里取。
  - `layoutOf(groups, { isExpanded }) → { mode: 'cards' | 'list', total, rows: [ { kind: 'group', name, count } | { kind: 'reply', no, quote, body, docName, isFirstOfGroup } ], hidden }`：总数 ≤ 3 为 `cards`，否则 `list`；`list` 折叠时只留最新加入的 3 条（按 `createdAt`），保持分组结构和组标题，`hidden` 为折掉的条数；`cards` 时只有组内第一张带 `docName`。
  - `cardSvg(reply, { docName, theme }) → { svg, width, height }`：卡片外框、竖线、原文（12 号灰、单行截断）、回复（13 号、单行截断）、「编号 · 文档名」行；明暗用 `prefers-color-scheme`（与 bandview 的 `LINE_STYLE` 同法）。
  - `rowSvg(reply, { width })`、`groupHeaderSvg(name, count)`：列表行与组标题。
  - `messageLayout(parsed) → { groups: [...], own }`：给第 9 步的消息重画用，不折叠。
  - `clearState(now, armedAt) → 'idle' | 'armed'`：〔清空〕两次确认，3000 ms 内为 `armed`。
- `src/docsview.js`：
  - `docItems(summaries, cwd, now) → [ { id, name, dir, when, pending, isNew } ]`：`name` 用 `displayName`；`isNew` 为 `max(modifiedAt, openedAt) > seenAt`（`seenAt` 为空也算新）。
  - `shouldAutoOpen({ docCount, hasOpenedBefore, wasClosed }) → boolean`：本会话第一次有文档且没被关过时为 true。

**验收测试**
- `layoutOf`：1、3、4、7 条；两份文档交错；折叠时只留最新 3 条且组标题条数写的是该组总数；展开后全部列出。
- `cardSvg`：输出是合法 SVG（以 `<svg` 开头），包含两套颜色值，原文超长时截断带「…」，中文按 2 格算宽。
- `docItems`：排序沿用服务端顺序；`isNew` 的三种情况；`pending` 为 0 时保留 0（由画法决定不显示）。
- `shouldAutoOpen` 四种组合；`clearState` 边界（2999 / 3000 ms）。
- `band.test.ts` 删掉状态相关用例，保留的函数用例照过。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(plugin): 回复区、消息与文档面板的版式"`

---

### Task 4：插件——回复区与发送

**Files:**
- Modify: `hooks/register.js`
- Delete: `src/delivery.js`（`isUserOrigin` 已挪到 reply.js）、`src/format.js`、`src/status.js`、`src/band.js` 里提醒相关函数（文件若只剩 `baseName` 就并进 bandview.js 后删除）
- Test: `tests/register.test.ts`（重写与送达 / 提醒 / 状态带相关的用例），删 `tests/delivery.test.ts`、`tests/format.test.ts`、`tests/status.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `/api/replies`、`/api/replies/sent`、`DELETE /api/comments`、`DELETE /api/replies`；Task 2 的 `withReplies`、`t`、`langOf`、`isUserOrigin`；Task 3 的 `layoutOf`、`cardSvg`、`rowSvg`、`groupHeaderSvg`、`clearState`。
- Produces：模块状态 `replies`（最近一次 `/api/replies` 的 groups）、`lang`；函数 `refreshReplies($)`、`sendReplies($, userText)`。

**行为**
- `session.start`：读 `lang = langOf(await $.config.list())`；把 1 s 的 `deliverTimer` 改为 1 s 取 `/api/replies?session=`（结果没变不重画），2 s 的 `statusTimer` 保留给文档列表（Task 6 用）。休眠 / 唤醒机制不变。
- `AbovePrompt`（桌面版）：没有回复时 `next(e)`；有回复时按 `layoutOf` 画：标题行（回复图标强调色、`bandTitle`、折叠时 `showingNewest`、右侧〔展开 / 收起〕〔清空 / 确认清空〕〔发送 / 发送中…〕）+ 卡片或列表；下层（用量条）接在下面，中间分隔线，规则同 0.2.0（设计文档 5.6）。
- 悬停卡片或列表行：显示完整原文和完整回复（沿用 0.2.0 状态带的悬停卡片做法：带 key 的 Box 里放 `position: absolute` + `display: none` + `hover: { display: 'flex' }` 的 Box）。
- × → `DELETE /api/comments`；〔清空〕第一次进入 `armed`（3 s 后自动回 `idle`），`armed` 时再点 → `DELETE /api/replies`。
- 〔发送〕：立即标记 `isSending`（按钮变「发送中…」，再点无效）→ `$.prompt.submit({ text: withReplies('', replies, lang, cwd), asUser: true })` → 成功则 `POST /api/replies/sent`、清空本地 `replies`、toast `sent`；失败保留回复、toast `sendFailed`。
- `prompt.submit`：只在 `isUserOrigin(e.origin)` 且有回复时，`next({ ...e, text: withReplies(e.text, replies, lang, cwd) })`；`next` 返回后（消息真正交出去，Claude 忙时排队的消息也在此时）再 `POST /api/replies/sent` 并清空本地 `replies`；不再用 `context`，不弹 toast。
- 命令行版：有回复时只画一行 `terminalLine` 加〔清空〕（设计文档 5.7）。
- 删除：`deliver`、`scheduleRetry`、`recordBatch`、`markInModel`、`checkUnreplied`、提醒相关状态与 `turn.start` / `turn.complete` 里的提醒逻辑、旧的 `bandTree`。

**验收测试**（`tests/register.test.ts`，沿用 `stub` / `boot` / `tick` 等助手；`server` 桩增加 `replies` 字段并按新路由响应）
- 有 2 条回复时 AbovePrompt 树里有标题「2 条回复」、两张卡片、〔清空〕〔发送〕；没有回复时只剩下层内容。
- 4 条时是列表、折叠只列 3 条、〔展开〕后 4 条。
- 点 × 发出 `DELETE /api/comments`；〔清空〕点一次只变「确认清空」，3 s 后复原，3 s 内再点发出 `DELETE /api/replies`。
- 〔发送〕：`submitted[0]` 等于 `withReplies('', …)` 的结果且 `asUser`；随后 `/api/replies/sent` 带全部 ID；toast「已发给 Claude」；`$.prompt.submit` 失败时没有 sent 请求、toast 带原因。
- 用户回车（`origin: { kind: 'composer' }`）：发出的 `text` 是「用户的话 + 回复块」；`origin.kind` 为 `plugin` 时不改写；没有回复时原样放行。
- 终端版只有一行提示。
- 原有的工具、命令、迁移、二进制、休眠、自动登记用例照过（受影响的按新接口改断言）。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(plugin): 输入框上方回复区，回复写进消息正文发送"`

---

### Task 5：插件——聊天记录里的回复消息

**Files:**
- Modify: `hooks/register.js`
- Test: `tests/register.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `parseMessage`；Task 3 的 `messageLayout`、`groupHeaderSvg`、`rowSvg`。

**行为**（设计文档 7.4）
- `on('ui.render', { component: 'UserMessage' })`：`parseMessage(e.props.text)` 为 `null` 时 `next(e)`；否则画「每份文档一组（标题：文档名 · N 条回复）、组内每条：编号、原文、回复」，最后是用户的话（为空不画）。
- `e.props.isExpanded === false` 时画一行「N 条回复 · 用户的话开头」。
- 原始的 `[文档回复]`、`<!-- reply -->`、`>` 行不出现在树里。

**验收测试**
- 用 `$.ui.mount({ component: 'UserMessage', props: { text, isExpanded: true, origin } })`（照现有 `BAND` 的挂法）挂一条 `withReplies` 生成的文字：树里有组标题、三条回复、用户的话；`allText` 里不含 `<!-- reply`。
- 普通消息、被改乱的消息原样交给下层。
- 折叠视图是一行。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(plugin): 聊天记录里按文档分组显示回复"`

---

### Task 6：插件——右侧文档面板与 open_doc

**Files:**
- Modify: `hooks/register.js`、`src/rules.js`、`src/client.js`（`reviewUrl` 加 `lang`）
- Test: `tests/register.test.ts`、`tests/docsview.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `/api/docs` 新字段；Task 3 的 `docItems`、`shouldAutoOpen`；Task 2 的 `t`。
- Produces：`OPEN_SPEC`（`name: 'open_doc'`，英文说明）、`OPEN_TOOL = 'mcp__cc-doc-review__open_doc'`；`reviewUrl(info, docId, lang)` → `…/review?doc=&t=&lang=`。

**行为**（设计文档 10）
- 面板 id `docs`，标题 `docsTitle`；`ui.render` 的 `Pane` 画 `docsCount` 和每份文档的卡片：文档名（Markdown 链接，走系统浏览器）、「目录 · 更新时间」、`pending > 0` 时强调色「N 条回复待发送」、〔在面板打开〕、`isNew` 时「新」标签和强调色描边。
- 〔在面板打开〕：先 `$.mcp.call('Claude_Browser', 'preview_start', { url })`；抛错或 `isError` 时退回 `$.prompt.submit({ text: t(lang, 'askOpenInPane', { name, url }), asUser: true })`，toast 说明原因（照 0.2.0 `openReview` 的写法，10 s 内同一文档不重复发）。
- 自动打开：2 s 的文档列表刷新里，`shouldAutoOpen` 为真时 `$.ui.open({ id: 'docs', title })` 一次；记下 `hasOpenedBefore`；`ui.close` 事件（`origin: person`）记 `wasClosed`，本会话不再自动打开；打开失败（`isPlaced: false`）不重试。
- `/cc-doc-review` 不带参数：打开面板（返回一行说明）；带文件参数：登记并在系统浏览器打开（沿用 `openUrl` 的系统浏览器分支），返回链接。
- `open_doc`：英文说明照设计文档 10.3（登记即可回复、不需确认；写好或改好一份给用户看的文档后调用它（自动登记过的也调用，用来拿链接），并在回话里附上返回的链接；回复以 `[文档回复]` / `[Doc reply]` 开头；收到后按编号逐条答复）；返回文字只有路径和链接（`src/status.js` 已删，返回文字写在 `src/rules.js` 的 `openText(path, url, cwd, lang)`）。
- 自动登记：不再 toast「已登记」。
- 删掉 `review_resolve`、`review_status` 的注册与处理。

**验收测试**
- 第一次刷新到文档时 `$.ui.open` 被调用一次；第二份文档不再调用；收到 `ui.close`（person）后新文档也不调用。
- Pane 树：两份文档、名称链接 URL 带 `lang`、「2 条回复待发送」、「新」标签只在 `isNew` 时出现。
- 〔在面板打开〕：`mcp.call` 成功时不 submit；失败时 submit 的文字等于 `askOpenInPane`，10 s 内再点不重复。
- `/cc-doc-review` 无参数返回打开面板的说明；有参数走登记。
- `$.tool.call({ tool: 'mcp__cc-doc-review__open_doc', path })` 返回文字含链接、不含 `show_widget`；旧工具名调用不再被插件接住。
- 自动登记不产生 toast。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(plugin): 右侧文档面板，review_open 改名 open_doc"`

---

### Task 7：文档页——顶栏、回复框、编号标记

**Files:**
- Modify: `server/web/static/overlay.js`（重写为顶栏 + 回复框 + 标记悬停卡）、`server/web/static/review.js`、`server/web/static/review.css`
- Create: `server/web/static/i18n.js`（页面用的文字子集，与 `src/i18n.js` 同键同值；测试保证两边一致）
- Test: `tests/web/overlay.test.mjs`（重写）、`tests/web/i18n.test.mjs`

**Interfaces:**
- Consumes：Task 1 的 `/api/replies?session=`（取编号）、`POST /api/comments`、`DELETE /api/comments`、`/api/docs`（文件切换）；URL 参数 `lang`。
- Produces（overlay.js 导出，供测试）：`popoverPlace(selRect, viewport, size) → { top, left, side: 'above' | 'below' }`、`canSubmit(text) → boolean`、`numberOf(replyGroups, commentId) → number | undefined`、`createOverlay(h)`（`h` 只剩 `onAdd(text)`、`onDelete(id)`、`onSwitchDoc(id)`、`onEditorClosed()`）。

**行为**（设计文档 6.1–6.3、6.5，设计稿第 2–4、7 步）
- 顶栏：左边文件图标 + 文件名（多文档时 ⌄ 切换）；右边有回复时「回复图标 + `pendingOnPage`」，没有时灰字 `noReplies`。去掉评论栏、状态、发送、通过、窄屏收起。
- 回复框：选中文字后浮在选区上方（放不下放下方），宽 380、圆角 12、浅色白底 / 深色 `#30302e`；原文 14 号灰、竖线、最多两行；输入 15 号、提示字 `replyHint`、自动聚焦；右下 lucide `message-circle-plus`，没字灰、有字亮；回车 / 点图标加入，Shift+回车换行，Esc / 点框外取消，空内容回车无效。
- 选区落在 Mermaid 图、图片、`canvas` / `iframe` / `svg` 内时不弹回复框。
- 标记：每条待发送回复的原文画淡强调色底 + 下划线（CSS Highlight API，沿用 `paint`），后面跟编号小圆点（强调色底、白字、直径 16；用绝对定位的元素贴在 Range 末尾，滚动 / 重排时随 `reanchor` 重算）。编号用 `numberOf`，和输入框上方一致。
- 悬停标记：小卡片显示「编号 · 你的回复」和〔删除〕（调 `onDelete`）。
- SSE 收到 `comments` 变化时（插件删了、发了）重新取回复并重画标记；发出后标记全部消失。
- 删除 `onSend`、`onApprove`、`barState`、`STATES`、评论栏相关代码。

**验收测试**
- `popoverPlace`：上方有空间 → above；选区贴顶 → below；靠右时左移不出界。
- `canSubmit`：空串、只有空白 → false。
- `numberOf`：两组时第二组第一条的编号。
- `i18n.test.mjs`：页面文字表的每个键在 `src/i18n.js` 里存在且中英值相同。
- 手动（`make run` 起服务，浏览器打开一份 md 和一份 html）：划字 → 回复框位置、提示字、回车加入、标记与编号出现；悬停删除；Esc 取消；在 Mermaid 图上划不出框。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(web): 文档页改为 Claude 样式的回复框与编号标记"`

---

### Task 8：文档页——标出 Claude 改了哪里

**Files:**
- Create: `server/web/static/diff.js`
- Modify: `server/web/static/review.js`、`server/web/static/overlay.js`（顶栏「改了 N 处 ⌃ ⌄ ✕」）、`server/web/static/review.css`
- Test: `tests/web/diff.test.mjs`

**Interfaces:**
- `blocksOf(root) → [ { el, text } ]`：按标题、段落、列表项、表格行、代码块、引用块切段（md 渲染后的 DOM；html 文档取 body 下同类元素）。
- `diffBlocks(prevTexts, nextTexts) → number[]`：返回新内容里新增或改过的段的下标（按 LCS 对齐，空白归一后比较）。
- `shouldAutoScroll({ isEditorOpen, lastScrollAt, now }) → boolean`：回复框开着或 3 s 内滚动过时 false。

**行为**（设计文档 6.4）
- 页面打开后记下当前各段文字；文件变化重新渲染后，用 `diffBlocks` 找改动段，加 class（左侧 3 px 强调色竖线、淡强调色底）。
- 顶栏右侧「改了 N 处」+ ⌃ ⌄（在改动间跳，循环）+ ✕（清掉标注）；有待发送回复时两项并排。
- 满足 `shouldAutoScroll` 时滚到第一处改动。
- 标注保留到下一次内容变化（重新比较）或点 ✕；删除的段不显示；只比较本页打开期间的变化。
- html 文档整页 `location.reload()` 的做法改为：重载前把各段文字存 `sessionStorage`（键带文档 ID），重载后比较，比较完删掉。

**验收测试**
- `diffBlocks`：中间插一段、改一段、删一段、整体不变、全空白差异不算改动。
- `shouldAutoScroll` 三种情况。
- 手动：打开一份 md，在终端里改其中两段，页面出现两处标注、「改了 2 处」、⌃ ⌄ 跳转、✕ 清掉；html 文档同样。

- [ ] 写失败测试 → 实现 → 通过 → `git commit -m "feat(web): 内容刷新时标出改动并可跳转"`

---

### Task 9：说明文档、清单与版本

**Files:**
- Modify: `.claude-plugin/plugin.json`（`version` 0.3.0；`description` 改为回复的说法）、`README.md`、`README.zh-CN.md`、`tests/register.test.ts`（版本相关断言）
- Delete: 无

**行为**
- README 两份：「使用」改写为新流程（文档面板、回复框、回复区、发送、消息样式、改动标注），附设计稿里的流程说明；「工作方式」去掉 outbox / 送达 / 处理结果；工具列表改为只有 `mcp__cc-doc-review__open_doc`；新增「从 0.2.0 升级」：评审状态和〔通过〕没有了，旧评论保留在数据目录不显示，未发送的草稿会作为待发送回复出现，权限规则里的 `review_open` 要改成 `open_doc`；说明自动模式下〔在面板打开〕会由 Claude 代为打开（插件直接打开会被安全检查拒绝）。
- 中文说明里的标点全角；英文 README 同步。

**验收测试**
- `claude plugin validate .` 通过；`autoRegister` 默认值与 `src/autoreg.js` 一致的用例照过。
- README 里不再出现 `review_resolve`、`review_status`、`〔通过〕`、`[文档评审]`（用 `grep` 检查）。

- [ ] 改完 → 全部测试通过 → `git commit -m "docs: 0.3.0 文档回复的说明与升级指引"`

---

### Task 10：真实界面验收与收尾

**Files:** 无代码改动（发现问题回到对应任务修）。

**做法**：用本地构建（`make build` 后 `bin/cc-doc-review-server` 存在即为开发模式）在桌面版里加载本仓库插件（`--plugin-dir` 或开发 mod 目录），按设计文档 12 节「真实界面验收」逐项过，每项请用户截图确认：

1. 浅色、深色两种主题。
2. 回复 1、3、4、7 条：卡片 / 列表 / 折叠 / 展开；与用量条拼接的分隔线、左右边距、行高。
3. 窗口拉窄时是否挤乱；展开后最多能画几行（实测后写回设计文档 5.4）。
4. 发送：回车、点〔发送〕各一次，1 条、4 条各一次；聊天记录里的消息样式与折叠视图。
5. 文档面板：首次自动打开、关掉后不再弹、「新」标记、〔在面板打开〕的退回。
6. 文档页：回复框与 Claude 自带回复框并排对比；标记、编号、悬停删除；改动标注与跳转。
7. 终端版：一行提示、回车带上回复、〔清空〕。

全部通过后：
- 删除测试插件 `~/.claude/dev-mods/59795bc7-7458-4067-b266-a187223b0786/quote-probe`。
- 设计文档状态改为「已实现」，补上实测得到的行数上限。
- 停下来问用户：是否推送分支、打 `v0.3.0` tag 发布，以及什么时候升级已安装的插件。

- [ ] 验收全部通过 → `git commit -m "docs: 0.3.0 验收结果"`
