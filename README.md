# CC-Doc-Review

English | [简体中文](README.zh-CN.md)

A Claude Code plugin for replying on documents Claude writes. Open a Markdown or HTML file, select a passage, and write a reply, just like quoting a message in chat. Your replies go to Claude together with your next message. If you have nothing to say about a document, do nothing: there are no statuses, no approvals and no to-do list. Everything runs on your machine.

## Install

```
/plugin marketplace add sapronlee/claude-plugins
/plugin install cc-doc-review@sapronlee
```

The first command adds [SummErOK's plugin marketplace](https://github.com/sapronlee/claude-plugins), named `sapronlee`; you only need it once for all plugins listed there. `cc-doc-review@sapronlee` reads as `plugin@marketplace`.

Then start a new session. You do not need Go: on first use the plugin downloads a prebuilt document server from this repository's GitHub Releases (see [Requirements](#requirements)).

## Usage

The UI language follows Claude Code's `language` setting: Chinese if it contains 中文, Chinese or zh, English otherwise. The names below are the English ones.

1. **Claude writes a document.** If the file matches the auto-register patterns (see [Configuration](#configuration)), the plugin registers it automatically; Claude can also register any file with the `mcp__cc-doc-review__open_doc` tool. Registering is not a review: nothing waits for your answer. Claude puts a link to the document in its reply.
2. **Open the document.** Click the link in Claude's reply, or type `/cc-doc-review` (no arguments) to list this session's documents in the chat, newest first. Each line has the document name as a link, its folder, the last update time, and "N replies to send" when you have unsent replies on it. Click a link to open the document page in your system browser (the desktop app sends local links there). In the desktop app, when Claude has the built-in browser tool, it also opens the page in the browser pane beside the conversation, so you can reply without switching windows. To register a file yourself, type `/cc-doc-review <file>`: it registers the file and opens it in your browser.
3. **Select text and reply.** On the document page, select some text. A reply box pops up above the selection (below it when there is no room). Type your reply; press Enter or click the ⊕ icon to add it, Shift+Enter for a new line, Esc or a click outside to cancel. Text inside Mermaid charts, images, canvas and iframe content cannot be replied to.
4. **See your replies above the prompt box.** Each reply shows on the page as a highlighted passage with a numbered dot; click the dot to see what you wrote, with a delete icon in its top-right corner. A table-style reply list also appears above Claude's prompt box: a rounded frame whose first row reads "↩ N replies" (followed by the document name when there is only one), with **Clear** and **Send** on the right; below it one reply per row, with rules between rows, each showing an orange number dot (matching the page), a gray bar with the dimmed quoted text, and what you wrote, shortened when long. Hover a row to tint it and show × at the end to delete it. The newest 3 replies are listed first, fewer when the window is too short, so the usage band and other modules below are never pushed out; when not all fit, **Show N more** appears on the right of the title row. **Clear** deletes them all and needs two clicks within 3 seconds (the first turns it into **Confirm clear**). Numbers run across the whole session and match the dots on the page.
5. **Send.** Press Enter in the prompt box (your text goes first, then the replies), or click **Send** in the reply list (this sends just the replies as your message). Slash commands and plugin or notification messages never carry replies. Afterwards the reply list folds away and the marks on the page clear; **Send** also shows a "Sent to Claude" toast.
6. **Claude answers by number.** In the chat, the sent message is drawn as the same kind of list, with anything you wrote below it. In the desktop app, a message sent with Enter turns into the list only once the app syncs the stored message (usually around when Claude replies); one sent with **Send** shows as the list right away. Claude answers each numbered reply and edits the document as needed. There is no status to update and no reminder.
7. **See what changed.** When the document file changes, the page refreshes and marks the changed paragraphs with an accent bar and tint. The top bar shows "N changes" with ⌃ ⌄ arrows to jump between them and ✕ to clear the marks. The page scrolls to the first change unless you are writing a reply or scrolled within the last 3 seconds. Only changes made while the page is open are marked.

### What Claude receives

The replies are written into the message body:

```
[Doc reply] Please answer each by number.
notes.md (docs/notes.md)
<!-- reply 1 -->
> the quoted text from the document

your reply

<!-- reply 2 -->
> another passage

another reply
```

The block starts with `[Doc reply] Please answer each by number.` (`[文档回复] 请按编号逐条答复。` when the interface is in Chinese), then one line per document with its name and path (relative when it is under the working directory), then for each reply `<!-- reply N -->`, the quoted text on `> ` lines, a blank line, and what you wrote. In the chat the plugin redraws the message as a reply list; that only changes how it looks, and Claude still gets the text above. If you edit the block by hand and the plugin cannot read it, it shows as plain text.

### Desktop app and CLI

Both have the reply list above the prompt box and the list in the chat. In both, open documents from the link in Claude's reply or with `/cc-doc-review`.

Several plugins share the space above the prompt box, nested in load order. After drawing its reply list, this plugin puts the inner plugins' content (such as the usage plugin [CC-Gauge](https://github.com/sapronlee/cc-gauge)) below it; with no replies it draws nothing and leaves the space to the others.

### Dormant mode

The plugin is installed globally but stays dormant in a session until documents are actually used, so it adds no rules to the system prompt (the tool description remains) and does no polling. It keeps the `open_doc` tool, the slash command and the path check on file writes. It wakes up, and stays awake until the session ends, when Claude calls `open_doc`, you use `/cc-doc-review`, an auto-register match happens, or this session registered documents earlier (checked when the session starts; if the server is not running, the plugin looks at its local data and starts the server when this session has documents). `/clear` returns it to dormant.

## Configuration

Set them in either of two ways; changes apply to new sessions:

- In the Claude Code CLI, run `/plugin`, open the installed plugins, select `cc-doc-review` and choose "Configure options".
- Edit `~/.claude/settings.json` directly. The options live under `pluginConfigs`, keyed by `plugin@marketplace`; anything you leave out keeps its default:

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

| Option | Default | Meaning |
|---|---|---|
| `autoRegister` | `true` | Register matching documents automatically after Claude writes them, so you can reply on them. When off, use `/cc-doc-review <file>` or ask Claude to call `open_doc`. |
| `includePatterns` | `**/*.{md,markdown,html,htm}` | Comma-separated globs for documents to register. |
| `excludePatterns` | `**/.superpowers/**,**/node_modules/**,**/vendor/**,**/dist/**,**/.git/**,**/.claude/**,**/README*,**/CHANGELOG*,**/CLAUDE.md,**/AGENTS.md,**/LICENSE*,**/CONTRIBUTING*,**/SECURITY*,**/CODE_OF_CONDUCT*,**/.github/**,**/build/**,**/coverage/**` | Comma-separated globs that are never registered. |

Pattern syntax:

- Patterns are matched against the path **relative to the session working directory**, case-insensitively.
- `**` matches any number of directories, `*` any characters within a name, `?` a single character, `{a,b}` either alternative. Commas inside braces do not split patterns.
- A pattern may contain at most 8 `*` / `**` wildcards (counted for each alternative after `{a,b}` is expanded); patterns over the limit are ignored.
- A path that matches both lists is **excluded** (exclude wins).
- An empty include list matches nothing, so auto-registration does nothing.
- A pattern with a leading `/` and a directory-style pattern with a trailing `/` (for example `docs/`) match nothing. Use `docs/**` instead.
- Only files written by Write or Edit in the main conversation are considered. Files outside the working directory and files written by subagents are never auto-registered.
- Example: to register only the Markdown files under `design/`, set `includePatterns` to `design/**/*.md`.

Auto-registration failures are reported once, and not retried for a minute.

## How it works

```
Claude writes doc ──> plugin hook ──> local doc server (127.0.0.1) ──> doc page in your browser
                                                                          │ you select text and reply
                                                                          v
Claude answers by number <── sent with your next message <── reply list above the prompt
```

- `server/`: a small Go server (standard library only) that listens on `127.0.0.1`, ports 4823 to 4830, protected by a token. It serves the document page and stores documents and replies in `~/.claude/cc-doc-review/`. A reply that is not yet sent is a draft, which the UI calls a pending reply. The document page is embedded in the binary and uses server-sent events (SSE) to refresh when the file or the replies change; Markdown is rendered with marked, sanitized with DOMPurify, and code and diagrams use highlight.js and mermaid (see `THIRD_PARTY_NOTICES.md`).
- `hooks/` and `src/`: the Claude Code plugin (a hooks module) that starts the server, and registers documents. While awake it polls `/api/replies` once a second to keep the reply list up to date. When you send, it writes the replies into your message and marks them as sent on the server.
- Tool exposed to Claude: `mcp__cc-doc-review__open_doc`.

## Upgrading from 0.2.0

0.3.0 replaces the review workflow with replies on the document:

- Review states and the Approve button are gone, and so are the Send-to-Claude button on the page, the comment sidebar, delivery retries and the reminders. Nothing waits for your verdict any more.
- Old comments stay in the data directory but are no longer shown.
- Unsent drafts from 0.2.0 appear as pending replies in the reply list above the prompt box. Send them or delete them.
- The tool `review_open` is now `open_doc`. If you have permission rules that mention `review_open`, rename them to `open_doc`. The two other tools were removed, so drop any rules for them.

## Security

- The server listens on `127.0.0.1` only and accepts only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`.
- Document page links carry an access token (query parameter `t`), generated each time the server starts.
- When you open an **HTML** document, the reply script is injected into that page, so the page's own scripts can read the token and call the server API. Only open HTML you trust.
- `/static/` (the built-in front-end files) and `/api/health` (name and version only) do not check the token.
- `/asset` does not check the token either. It serves resources from the HTML document's directory and its subdirectories, and never files or directories whose names start with a dot (`.env`, `.git`, and so on). A document ID is derived from the file path (the first 16 hex characters of the SHA-1 of the absolute path), so another process on the same machine can request `/asset` for a registered HTML document.
- Your documents and replies are not uploaded anywhere. Remote images or scripts referenced by a document page are still fetched by your browser, and the first use of each new version downloads the server binary once from GitHub Releases.

## Requirements

- macOS or Linux (x86_64 or arm64). Windows is not supported.
- Claude Code with plugin support.
- On first use the plugin downloads the prebuilt server for your platform from this repository's GitHub Releases with `curl`, verifies its SHA-256 against the release's `SHA256SUMS`, and saves it as `~/.claude/cc-doc-review/bin/cc-doc-review-server-<version>`. If the download fails and Go 1.24+ is installed, it builds `server/` locally instead; if neither works you get an error naming the platform and the reason.
- After `/plugin update`, a new server version is downloaded on demand and a running older server is restarted.

## Development

```
make build     # builds bin/cc-doc-review-server, version taken from .claude-plugin/plugin.json
make test      # Go tests and vet, front-end tests, plugin tests
make run       # build and run the server
```

- `./bin/cc-doc-review-server -port <port>` listens on a single port instead of scanning 4823 to 4830.
- **Dev mode:** if `bin/cc-doc-review-server` exists in the plugin folder, the plugin uses it in preference to the downloaded one, and does not auto-restart it after version changes. After changing server code, stop the old process (`kill $(jq .pid ~/.claude/cc-doc-review/server.json)`), run `make build`, and the next call starts the new build. To run the plugin from a working copy, start Claude Code with `claude --plugin-dir <path>`; where you cannot pass arguments (for example the desktop app), set the environment variable `CLAUDE_CODE_PLUGIN_DIRS` to the folder instead.
- The server log is `~/.claude/cc-doc-review/server.log`.
- **Release:** set `version` in `.claude-plugin/plugin.json`, then push a matching tag `v<version>`. GitHub Actions checks that the tag is a valid version and matches `plugin.json`, runs `go test` and `go vet`, builds the four platform binaries, and uploads them with `SHA256SUMS` to that tag's Release; it fails if the tag and the `plugin.json` version differ. The plugin's entry in the [marketplace](https://github.com/sapronlee/claude-plugins) carries no version of its own, so `plugin.json` is the only place to change. `make release-local` rehearses the artifacts into `dist/`. Run `make test` locally before tagging: CI only runs the Go tests, not the front-end or plugin tests.

### Migrating from the old `doc-review` plugin

The earlier plugin was named `doc-review` and stored data in `~/.claude/doc-review/`. The first time the new server starts, it stops a still-running old server and, if the new data directory has no `docs/`, copies `docs/` and `outbox/` over. The old directory is kept.

## License

[MIT](LICENSE). Third-party libraries bundled with the document page are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
