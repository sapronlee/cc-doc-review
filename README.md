# CC-Doc-Review

English | [简体中文](README.zh-CN.md)

A Claude Code plugin for reviewing documents Claude writes. Open a Markdown or HTML file in a browser panel, select text, leave a comment, and send the comments back to the Claude Code session. Claude edits the document, the page refreshes, and each comment is marked resolved with a note on what changed. Everything runs on your machine.

## Install

```
/plugin marketplace add sapronlee/claude-plugins
/plugin install cc-doc-review@sapronlee
```

The first command adds [SummErOK's plugin marketplace](https://github.com/sapronlee/claude-plugins), named `sapronlee`; you only need it once for all plugins listed there. `cc-doc-review@sapronlee` reads as `plugin@marketplace`.

Then start a new session. You do not need Go: on first use the plugin downloads a prebuilt review server from this repository's GitHub Releases (see [Requirements](#requirements)).

## Usage

Note: the review page and the plugin's own messages (toasts, status band, review card) are currently in Chinese; the English names below describe the controls.

- **Open a document.** After Claude writes a document that matches the auto-register patterns, the plugin registers it for review and shows you a toast; it does not notify Claude. The review card in the chat (file name, relative path, counts of drafts / in progress / resolved, with "Open in browser" and "Open in panel" buttons, or a plain link where cards cannot be drawn) appears only when Claude calls `review_open`, so ask Claude to open the document for review. You can also open any file yourself with `/cc-doc-review <file>`.
- **Check progress.** Say "review progress" (or 「评审进度」, 「看评论」) and Claude calls the `review_status` tool to list this session's documents and their pending comments, as a summary card where possible.
- **Comment.** Select text, click Comment, and press Enter to save. Collect as many comments as you like, then click Send to Claude at the bottom. In the sidebar you can edit or delete drafts and read the resolution notes on resolved comments.
- **Claude responds.** Claude edits the document and resolves each comment with a note. The page reloads and comments are re-anchored to the changed text.
- **Delivery.** When the comments reach the session you see a toast saying N comments were received and Claude is working on them. If sending fails, the plugin retries after 5, 15 and 45 seconds; if that still fails, the comments are attached to your next message instead (they are never pasted into your input box).
- **Missed replies.** When a turn ends while delivered comments still have no resolution, the plugin reminds Claude once per batch of comments and shows a toast. Subagent turns, interrupted turns, errored turns and comments that were never delivered are not checked.

### Desktop app and CLI

| | Claude desktop app | Claude Code CLI |
|---|---|---|
| Open the review page | review card in the chat, or the status band | review card, or the status band |
| Status band above the prompt | shown while this session has unresolved comments | shown while this session has unresolved comments |
| Toasts (delivered, reminded) | shown | shown |

In the desktop app the status band is a single left-aligned line: Review, then each document laid out flat like the usage line below it: a state icon and the file name as a link. Clicking the name opens its review page in your default browser (the desktop app opens links from plugin UI in the external browser; Claude is not involved). To read it in the browser panel instead, use "Open in panel" on the review card in the chat. Each document is in one review state: **to review** (Claude wrote or changed it and waits for your verdict), **not sent** (you wrote comments but have not sent them), **to confirm** (Claude handled your comments; check the changes), or **with Claude**. The icon before each name shows the state by shape and color: a pink magnifier to review, a yellow pencil for unsent comments, a green check to confirm, and a gray hourglass while Claude works. Your turn comes first; as many documents as fit are shown, the rest fold into "+N". Hovering Review shows a legend with counts; hovering a document shows the full name and "state · folder · last change". Clicking Approve in the top bar of the review page settles the document: it leaves the band and Claude is told it was approved. Documents with no change for 24 hours also leave the band. When another plugin also draws in this space (a usage gauge, say), a thin rule separates the two; with only one of them, there is no rule.

Plugins share the space above the prompt, nested in load order. After drawing its own line, this plugin passes the space on, so a plugin loaded inside it (such as [CC-Gauge](https://github.com/sapronlee/CC-Gauge), a usage gauge) still shows below. A plugin loaded outside it that does not pass the space on hides the status band; load this plugin before that one.

### Dormant mode

The plugin is installed globally but stays dormant in a session until review is actually used, so it adds no review rules to the system prompt (the tool descriptions remain) and does no polling. It keeps the review tools, the slash command and the path check on file writes. It wakes up, and stays awake until the session ends, when Claude calls a review tool, you use `/cc-doc-review`, an auto-register match happens, or this session registered documents earlier (checked when the session starts; if the server is not running, the plugin looks at its local data and starts the server when this session has documents). `/clear` returns it to dormant.

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
| `autoRegister` | `true` | Register matching documents for review automatically after Claude writes them. When off, use `/cc-doc-review` or ask Claude to call `review_open`. |
| `includePatterns` | `**/specs/**/*.{md,html},**/plans/**/*.{md,html},**/docs/**/*.{md,markdown,html,htm}` | Comma-separated globs for documents to register. |
| `excludePatterns` | `**/.superpowers/**,**/node_modules/**,**/vendor/**,**/dist/**,**/.git/**,**/.claude/**,**/README*,**/CHANGELOG*,**/CLAUDE.md` | Comma-separated globs that are never registered. |

Pattern syntax:

- Patterns are matched against the path **relative to the session working directory**, case-insensitively.
- `**` matches any number of directories, `*` any characters within a name, `?` a single character, `{a,b}` either alternative. Commas inside braces do not split patterns.
- A pattern may contain at most 8 `*` / `**` wildcards (counted for each alternative after `{a,b}` is expanded); patterns over the limit are ignored.
- A path that matches both lists is **excluded** (exclude wins).
- An empty include list matches nothing, so auto-registration does nothing.
- A pattern with a leading `/` and a directory-style pattern with a trailing `/` (for example `docs/`) match nothing. Use `docs/**` instead.
- Only files written by Write or Edit in the main conversation are considered. Files outside the working directory and files written by subagents are never auto-registered.
- Example: to review only the Markdown files under `design/`, set `includePatterns` to `design/**/*.md`.

Auto-registration failures are reported once, and not retried for a minute.

## How it works

```
Claude writes doc ──> plugin hook ──> local review server (127.0.0.1) ──> review page in browser panel
        ^                                                                     │ you select text and comment
        │                                                                     v
   Claude edits, calls review_resolve <── comments sent into the session as a message
```

- `server/`: a small Go server (standard library only) that listens on `127.0.0.1`, ports 4823 to 4830, serves the review page and stores comments in `~/.claude/cc-doc-review/`. The review page is embedded in the binary; Markdown is rendered with marked, sanitized with DOMPurify, and code and diagrams use highlight.js and mermaid (see `THIRD_PARTY_NOTICES.md`).
- `hooks/` and `src/`: the Claude Code plugin (a hooks module) that starts the server, registers documents, polls for comments, delivers them to the session and checks for missed replies.
- Tools exposed to Claude: `mcp__cc-doc-review__review_open`, `mcp__cc-doc-review__review_resolve`, `mcp__cc-doc-review__review_status`.

## Security

- The server listens on `127.0.0.1` only and accepts only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`.
- Review page links carry an access token (query parameter `t`), generated each time the server starts.
- When you review an **HTML** document, the review script is injected into that page, so the page's own scripts can read the token and call the review API. Only review HTML you trust.
- `/static/` (the built-in front-end files) and `/api/health` (name and version only) do not check the token.
- `/asset` does not check the token either. It serves resources from the HTML document's directory and its subdirectories, and never files or directories whose names start with a dot (`.env`, `.git`, and so on). A document ID is derived from the file path (the first 16 hex characters of the SHA-1 of the absolute path), so another process on the same machine can request `/asset` for a registered HTML document.
- Your review content is not uploaded anywhere. Remote images or scripts referenced by a reviewed page are still fetched by your browser, and the first use of each new version downloads the server binary once from GitHub Releases.

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

[MIT](LICENSE). Third-party libraries bundled with the review page are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
