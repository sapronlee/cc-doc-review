# doc-review 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Claude 桌面版右侧浏览器面板里对 md/HTML 划词评论，一键把评论送进当前会话，Claude 修改后页面自动刷新、评论标记已解决。

**Architecture:** 三部分。Go 本地服务（`server/`）是数据的唯一写入者，提供评审页、评论接口、SSE 和 outbox；评审页是无构建步骤的原生 ES 模块，打包进 Go 二进制；仓库根目录本身是 Claude Code mod，负责在后台拉起服务、给模型注册 `review_open`/`review_resolve` 工具、往系统提示加评审规则，并每秒把 outbox 里的评论批次送进会话。

**Tech Stack:** Go 1.24+（只用标准库，`os.OpenRoot`、`http.ServeMux` 路由模式）；浏览器端原生 JS、CSS Custom Highlight API、Shadow DOM、marked、DOMPurify、highlight.js、mermaid（内置不联网）；mod 用 Claude Code function hooks（JS + JSDoc），测试用 `claude plugin test`；前端纯函数用 `node --test`。

**Spec:** `docs/superpowers/specs/2026-10-11-doc-review-design.md`

## Global Constraints

- 服务只监听 `127.0.0.1`，端口 4823～4830；数据目录 `~/.claude/doc-review/`。
- 除 `/api/health`、`/static/*`、`/asset/*` 外，所有接口都校验令牌：页面链接参数 `t`，或请求头 `X-Review-Token`。
- 只接受 `.md`、`.markdown`、`.html`、`.htm`；只允许访问登记过的文件。
- Go 不引入第三方依赖；前端不引入构建步骤。
- 前端不用 `innerHTML` 插入内容：界面用 DOM API 构建；md 渲染结果经 DOMPurify 净化后以 DOM 片段插入。
- 源码字符串里的中文标点用全角（项目约定）。
- mod 插件名 `doc-review`，工具全名 `mcp__doc-review__review_open`、`mcp__doc-review__review_resolve`。
- 评论状态值固定为 `draft`、`sent`、`resolved`。
- 第一版不做：评论回复和讨论串、多人协作、导出。

## 相对设计文档的落地细节

1. 文档切换下拉框放在**底部栏**左侧，而不是顶部细条：HTML 页面顶部常有自己的导航，固定顶栏会挡住内容。
2. HTML 页面注入 `<base href="/asset/<文档 ID>/">`，并由 `/asset/<文档 ID>/<相对路径>` 提供同目录下的图片、样式等资源（用 `os.OpenRoot` 限制在文档所在目录内），否则页面里的相对路径资源会全部失效。
3. md 渲染结果用 DOMPurify 净化：评审页持有令牌，md 里夹带的 `<img onerror=…>` 之类不能执行。

Task 1 第一步会把这几点同步进设计文档。

## 文件结构

```
doc-review/
├── .claude-plugin/plugin.json      # mod 清单                         Task 8
├── hooks/hooks.json                # 指向 register.js                 Task 8
├── hooks/register.js               # mod 入口：工具、命令、规则、投递   Task 9
├── src/format.js                   # 批次 → 消息文本（纯函数）          Task 8
├── src/rules.js                    # 系统提示规则与工具说明             Task 8
├── src/client.js                   # 找到/拉起服务、调接口              Task 9
├── tests/format.test.ts            # mod 纯函数测试                    Task 8
├── tests/register.test.ts          # mod 行为测试                      Task 9
├── tests/web/anchor.test.mjs       # 前端定位逻辑测试                  Task 6
├── tsconfig.json / .gitignore / Makefile / README.md
└── server/
    ├── go.mod                      # module docreview                 Task 1
    ├── main.go / main_test.go      # 端口选择、server.json、启动        Task 5
    ├── store/store.go / store_test.go   # 文档与评论、outbox、resolve   Task 1、2
    ├── api/api.go / api_test.go    # JSON 接口与令牌                   Task 3
    ├── api/pages.go / pages_test.go     # /review /raw /asset /events  Task 4
    └── web/
        ├── embed.go                # go:embed static                  Task 4
        └── static/
            ├── anchor.js           # 原文定位（纯函数）                 Task 6
            ├── textmap.js          # 文本偏移 ↔ DOM Range              Task 7
            ├── api.js              # 带令牌的 fetch                    Task 7
            ├── overlay.js          # Shadow DOM 里的评审界面           Task 7
            ├── review.js           # 入口：渲染、选区、高亮、SSE        Task 7
            ├── review.html / review.css   # md 外壳页与排版            Task 7
            └── vendor/             # 第三方库                          Task 7
```

---

### Task 1：Go 模块骨架与评论存储（登记、增改删）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-doc-review-design.md`
- Create: `server/go.mod`、`server/store/store.go`、`server/store/store_test.go`、`.gitignore`

**Interfaces:**
- Produces（`package store`）：
  - `var ErrNotFound, ErrNotDraft, ErrNoDrafts, ErrUnsupported, ErrInvalid error`
  - `type Status string`，常量 `Draft`、`Sent`、`Resolved`
  - `type Comment struct{ ID, Quote, Prefix, Suffix, Body string; Status Status; CreatedAt time.Time; SentAt *time.Time; Batch string; Resolution *Resolution }`
  - `type Resolution struct{ Note string; At time.Time }`
  - `type Doc struct{ ID, Path, Kind, Session string; Revision int; Comments []Comment }`
  - `type NewComment struct{ Quote, Prefix, Suffix, Body string }`
  - `func New(root string) (*Store, error)`、`func DocID(path string) string`、`func KindOf(path string) (string, error)`
  - `func (s *Store) Open(path, session string) (Doc, error)`、`Get(id string) (Doc, error)`
  - `func (s *Store) AddComment(docID string, in NewComment) (Comment, error)`
  - `func (s *Store) UpdateComment(docID, id, body string) (Comment, error)`、`DeleteComment(docID, id string) error`

- [ ] **Step 1：同步设计文档**

3.1 节把「顶部细条」一条替换为：

```markdown
- **文档切换**：放在底部固定栏左侧，是一个下拉框，列出本会话里的待评审文档，每项显示未解决的评论数。不做顶部栏，避免挡住 HTML 页面自己的导航。
```

3.5 节末尾追加：

```markdown
HTML 里的相对路径资源（图片、样式）通过注入 `<base href="/asset/<文档 ID>/">` 由服务从文档所在目录提供，用 `os.OpenRoot` 限制不能越出该目录。
```

5.4 节（安全）追加：

```markdown
- md 的渲染结果经 DOMPurify 净化后再插入页面；评审界面全部用 DOM API 构建，不用 `innerHTML` 拼接内容。
```

5.2 节接口表追加：

```markdown
| `GET /api/doc?doc=<id>` | 评审页 | 文档详情与全部评论 |
| `GET /asset/<id>/<相对路径>` | 浏览器 | HTML 同目录资源，不校验令牌 |
```

- [ ] **Step 2：建 Go 模块和 .gitignore**

`server/go.mod`：

```
module docreview

go 1.24
```

`.gitignore`：

```
bin/
node_modules/
.DS_Store
.claude-plugin/types/
```

- [ ] **Step 3：写失败的测试** `server/store/store_test.go`

```go
package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "a.md")
	if err := os.WriteFile(p, []byte("# 标题\n\n正文"), 0o644); err != nil {
		t.Fatal(err)
	}
	return s, p
}

func TestOpenRegistersDocUnderSession(t *testing.T) {
	s, p := newStore(t)
	d, err := s.Open(p, "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != DocID(p) || d.Kind != "md" || d.Session != "sess-1" {
		t.Fatalf("unexpected doc: %+v", d)
	}
	d2, err := s.Open(p, "sess-2")
	if err != nil {
		t.Fatal(err)
	}
	if d2.Session != "sess-2" {
		t.Fatalf("最后一次登记应生效，得到 %q", d2.Session)
	}
}

func TestOpenRejectsBadInput(t *testing.T) {
	s, p := newStore(t)
	cases := map[string]struct {
		path, session string
		want          error
	}{
		"相对路径":    {"a.md", "s", ErrInvalid},
		"不支持的类型": {strings.TrimSuffix(p, ".md") + ".txt", "s", ErrUnsupported},
		"非法会话 ID": {p, "../x", ErrInvalid},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := s.Open(c.path, c.session); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
	if _, err := s.Open(filepath.Join(filepath.Dir(p), "missing.md"), "s"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("文件不存在应返回 ErrNotExist，得到 %v", err)
	}
}

func TestCommentEditableOnlyAsDraft(t *testing.T) {
	s, p := newStore(t)
	d, _ := s.Open(p, "s1")
	c, err := s.AddComment(d.ID, NewComment{Quote: "正文", Prefix: "# 标题\n\n", Body: "太短"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != Draft || !strings.HasPrefix(c.ID, "c_") {
		t.Fatalf("bad comment: %+v", c)
	}
	up, err := s.UpdateComment(d.ID, c.ID, "再展开一点")
	if err != nil || up.Body != "再展开一点" {
		t.Fatalf("update: %+v %v", up, err)
	}
	if err := s.DeleteComment(d.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(d.ID)
	if len(got.Comments) != 0 {
		t.Fatalf("删除后应为空：%+v", got.Comments)
	}
	if _, err := s.AddComment(d.ID, NewComment{Quote: " ", Body: "x"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("空引用应拒绝，得到 %v", err)
	}
	if _, err := s.UpdateComment(d.ID, "c_nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestGetUnknownDoc(t *testing.T) {
	s, _ := newStore(t)
	if _, err := s.Get("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}
```

- [ ] **Step 4：运行确认失败**

Run: `cd server && go test ./store/`
Expected: FAIL，编译错误 `undefined: New` 等

- [ ] **Step 5：实现** `server/store/store.go`

```go
// Package store 保存登记的文档和评论，是数据目录的唯一写入者。
package store

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrNotDraft    = errors.New("只有草稿可以修改或删除")
	ErrNoDrafts    = errors.New("没有待发送的评论")
	ErrUnsupported = errors.New("只支持 .md、.markdown、.html、.htm 文件")
	ErrInvalid     = errors.New("invalid input")
)

type Status string

const (
	Draft    Status = "draft"
	Sent     Status = "sent"
	Resolved Status = "resolved"
)

type Resolution struct {
	Note string    `json:"note"`
	At   time.Time `json:"at"`
}

type Comment struct {
	ID         string      `json:"id"`
	Quote      string      `json:"quote"`
	Prefix     string      `json:"prefix"`
	Suffix     string      `json:"suffix"`
	Body       string      `json:"body"`
	Status     Status      `json:"status"`
	CreatedAt  time.Time   `json:"createdAt"`
	SentAt     *time.Time  `json:"sentAt"`
	Batch      string      `json:"batch,omitempty"`
	Resolution *Resolution `json:"resolution"`
}

type Doc struct {
	ID       string    `json:"id"`
	Path     string    `json:"path"`
	Kind     string    `json:"kind"`
	Session  string    `json:"session"`
	Revision int       `json:"revision"`
	Comments []Comment `json:"comments"`
}

type NewComment struct {
	Quote  string `json:"quote"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
	Body   string `json:"body"`
}

var validSession = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Store struct {
	root string
	mu   sync.Mutex
	now  func() time.Time
}

func New(root string) (*Store, error) {
	for _, d := range []string{"docs", "outbox"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, err
		}
	}
	return &Store{root: root, now: time.Now}, nil
}

// DocID 是文档绝对路径 sha1 的前 16 位。
func DocID(path string) string {
	sum := sha1.Sum([]byte(path))
	return hex.EncodeToString(sum[:])[:16]
}

func KindOf(path string) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown":
		return "md", nil
	case ".html", ".htm":
		return "html", nil
	}
	return "", ErrUnsupported
}

// Open 登记文档到会话名下；同一文件再次登记时以最后一次为准。
func (s *Store) Open(path, session string) (Doc, error) {
	if !filepath.IsAbs(path) {
		return Doc{}, fmt.Errorf("%w：路径必须是绝对路径：%s", ErrInvalid, path)
	}
	if !validSession.MatchString(session) {
		return Doc{}, fmt.Errorf("%w：会话 ID 不合法：%q", ErrInvalid, session)
	}
	path = filepath.Clean(path)
	kind, err := KindOf(path)
	if err != nil {
		return Doc{}, err
	}
	if _, err := os.Stat(path); err != nil {
		return Doc{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := DocID(path)
	d, err := s.load(id)
	if errors.Is(err, ErrNotFound) {
		d = Doc{ID: id, Path: path, Kind: kind, Comments: []Comment{}}
	} else if err != nil {
		return Doc{}, err
	}
	d.Session = session
	return d, s.save(&d)
}

func (s *Store) Get(id string) (Doc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load(id)
}

func (s *Store) AddComment(docID string, in NewComment) (Comment, error) {
	if strings.TrimSpace(in.Quote) == "" || strings.TrimSpace(in.Body) == "" {
		return Comment{}, fmt.Errorf("%w：引用的原文和评论内容都不能为空", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load(docID)
	if err != nil {
		return Comment{}, err
	}
	c := Comment{
		ID: randomID("c_"), Quote: in.Quote, Prefix: in.Prefix, Suffix: in.Suffix,
		Body: in.Body, Status: Draft, CreatedAt: s.now(),
	}
	d.Comments = append(d.Comments, c)
	return c, s.save(&d)
}

func (s *Store) UpdateComment(docID, id, body string) (Comment, error) {
	if strings.TrimSpace(body) == "" {
		return Comment{}, fmt.Errorf("%w：评论内容不能为空", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load(docID)
	if err != nil {
		return Comment{}, err
	}
	c, err := findComment(&d, id)
	if err != nil {
		return Comment{}, err
	}
	if c.Status != Draft {
		return Comment{}, ErrNotDraft
	}
	c.Body = body
	return *c, s.save(&d)
}

func (s *Store) DeleteComment(docID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load(docID)
	if err != nil {
		return err
	}
	c, err := findComment(&d, id)
	if err != nil {
		return err
	}
	if c.Status != Draft {
		return ErrNotDraft
	}
	kept := d.Comments[:0]
	for _, one := range d.Comments {
		if one.ID != id {
			kept = append(kept, one)
		}
	}
	d.Comments = kept
	return s.save(&d)
}

func findComment(d *Doc, id string) (*Comment, error) {
	for i := range d.Comments {
		if d.Comments[i].ID == id {
			return &d.Comments[i], nil
		}
	}
	return nil, fmt.Errorf("%w：评论 %s", ErrNotFound, id)
}

func (s *Store) docPath(id string) string {
	return filepath.Join(s.root, "docs", filepath.Base(id)+".json")
}

func (s *Store) load(id string) (Doc, error) {
	b, err := os.ReadFile(s.docPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return Doc{}, fmt.Errorf("%w：文档 %s", ErrNotFound, id)
	}
	if err != nil {
		return Doc{}, err
	}
	var d Doc
	if err := json.Unmarshal(b, &d); err != nil {
		return Doc{}, err
	}
	return d, nil
}

// save 每次写入都递增 Revision，SSE 靠它发现评论变化。
func (s *Store) save(d *Doc) error {
	d.Revision++
	return writeJSON(s.docPath(d.ID), d)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func randomID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}
```

- [ ] **Step 6：运行确认通过**

Run: `cd server && go test ./store/ && go vet ./...`
Expected: `ok  docreview/store`

- [ ] **Step 7：提交**

```bash
git add .gitignore server/go.mod server/store docs/superpowers/specs
git commit -m "feat(store): 文档登记与评论增改删"
```

---

### Task 2：发送、outbox、标记已解决、文档列表

**Files:**
- Modify: `server/store/store.go`、`server/store/store_test.go`（都是追加）

**Interfaces:**
- Consumes：Task 1 的 `Store`、`Doc`、`Comment`、`writeJSON`、`randomID`、`validSession`、错误变量。
- Produces：
  - `type BatchComment struct{ ID, Quote, Body string }`
  - `type Batch struct{ Batch, Doc, Path string; Comments []BatchComment }`
  - `type ResolveItem struct{ ID, Note string }`、`type DocSummary struct{ ID, Path string; Open int }`
  - `func (s *Store) Send(docID string) (Batch, error)`
  - `func (s *Store) Outbox(session string) ([]Batch, error)`、`Ack(session, batch string) error`
  - `func (s *Store) Resolve(items []ResolveItem) (int, error)`
  - `func (s *Store) ListBySession(session string) ([]DocSummary, error)`、`Revision(id string) (int, error)`

- [ ] **Step 1：追加失败的测试**

```go
func TestSendLocksDraftsAndWritesOutbox(t *testing.T) {
	s, p := newStore(t)
	d, _ := s.Open(p, "s1")
	c, _ := s.AddComment(d.ID, NewComment{Quote: "正文", Body: "改"})
	b, err := s.Send(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(b.Batch, "b_") || b.Path != p || len(b.Comments) != 1 || b.Comments[0].Body != "改" {
		t.Fatalf("bad batch: %+v", b)
	}
	if _, err := s.UpdateComment(d.ID, c.ID, "x"); !errors.Is(err, ErrNotDraft) {
		t.Fatalf("已发送的评论应锁定，得到 %v", err)
	}
	if err := s.DeleteComment(d.ID, c.ID); !errors.Is(err, ErrNotDraft) {
		t.Fatalf("got %v", err)
	}
	if _, err := s.Send(d.ID); !errors.Is(err, ErrNoDrafts) {
		t.Fatalf("没有草稿时应返回 ErrNoDrafts，得到 %v", err)
	}
	got, _ := s.Get(d.ID)
	if got.Comments[0].Status != Sent || got.Comments[0].Batch != b.Batch || got.Comments[0].SentAt == nil {
		t.Fatalf("bad comment after send: %+v", got.Comments[0])
	}
}

func TestOutboxIsPerSessionAndAckRemoves(t *testing.T) {
	s, p := newStore(t)
	d, _ := s.Open(p, "s1")
	s.AddComment(d.ID, NewComment{Quote: "正文", Body: "改"})
	b, _ := s.Send(d.ID)
	got, err := s.Outbox("s1")
	if err != nil || len(got) != 1 || got[0].Batch != b.Batch {
		t.Fatalf("outbox: %+v %v", got, err)
	}
	if other, _ := s.Outbox("s2"); len(other) != 0 {
		t.Fatalf("别的会话不应看到：%+v", other)
	}
	if err := s.Ack("s1", b.Batch); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Outbox("s1"); len(got) != 0 {
		t.Fatalf("ack 后应为空：%+v", got)
	}
	if err := s.Ack("s1", "../../etc"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("非法批次名应拒绝，得到 %v", err)
	}
	if err := s.Ack("s1", b.Batch); err != nil {
		t.Fatalf("重复 ack 应幂等，得到 %v", err)
	}
}

func TestResolveAcrossDocs(t *testing.T) {
	s, p := newStore(t)
	p2 := filepath.Join(filepath.Dir(p), "b.html")
	os.WriteFile(p2, []byte("<p>x</p>"), 0o644)
	d1, _ := s.Open(p, "s1")
	d2, _ := s.Open(p2, "s1")
	c1, _ := s.AddComment(d1.ID, NewComment{Quote: "正文", Body: "a"})
	c2, _ := s.AddComment(d2.ID, NewComment{Quote: "x", Body: "b"})
	s.Send(d1.ID)
	s.Send(d2.ID)
	n, err := s.Resolve([]ResolveItem{{ID: c1.ID, Note: "已改成表格"}, {ID: c2.ID, Note: "没改：原因……"}})
	if err != nil || n != 2 {
		t.Fatalf("resolve: %d %v", n, err)
	}
	g1, _ := s.Get(d1.ID)
	if g1.Comments[0].Status != Resolved || g1.Comments[0].Resolution.Note != "已改成表格" {
		t.Fatalf("bad: %+v", g1.Comments[0])
	}
	if _, err := s.Resolve([]ResolveItem{{ID: "c_nope", Note: "x"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestListBySessionCountsOpenComments(t *testing.T) {
	s, p := newStore(t)
	p2 := filepath.Join(filepath.Dir(p), "b.md")
	os.WriteFile(p2, []byte("b"), 0o644)
	d1, _ := s.Open(p, "s1")
	s.Open(p2, "s2")
	c, _ := s.AddComment(d1.ID, NewComment{Quote: "正文", Body: "a"})
	s.AddComment(d1.ID, NewComment{Quote: "标题", Body: "b"})
	s.Send(d1.ID)
	s.Resolve([]ResolveItem{{ID: c.ID, Note: "ok"}})
	list, err := s.ListBySession("s1")
	if err != nil || len(list) != 1 || list[0].ID != d1.ID || list[0].Open != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
}

func TestRevisionBumpsOnEveryWrite(t *testing.T) {
	s, p := newStore(t)
	d, _ := s.Open(p, "s1")
	r1, _ := s.Revision(d.ID)
	s.AddComment(d.ID, NewComment{Quote: "正文", Body: "a"})
	r2, _ := s.Revision(d.ID)
	if r2 <= r1 {
		t.Fatalf("revision 应递增：%d → %d", r1, r2)
	}
}
```

- [ ] **Step 2：运行确认失败**

Run: `cd server && go test ./store/`
Expected: FAIL，`s.Send undefined` 等

- [ ] **Step 3：追加实现**（`store.go` 末尾；import 增加 `"sort"`）

```go
type BatchComment struct {
	ID    string `json:"id"`
	Quote string `json:"quote"`
	Body  string `json:"body"`
}

type Batch struct {
	Batch    string         `json:"batch"`
	Doc      string         `json:"doc"`
	Path     string         `json:"path"`
	Comments []BatchComment `json:"comments"`
}

type ResolveItem struct {
	ID   string `json:"id"`
	Note string `json:"note"`
}

type DocSummary struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Open int    `json:"open"`
}

var validBatch = regexp.MustCompile(`^b_[0-9]{8}_[0-9]{6}_[0-9a-f]{4}$`)

// Send 把文档的全部草稿变为处理中，并写一个批次到文档所属会话的 outbox。
func (s *Store) Send(docID string) (Batch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load(docID)
	if err != nil {
		return Batch{}, err
	}
	now := s.now()
	b := Batch{
		Batch: fmt.Sprintf("b_%s_%s", now.Format("20060102_150405"), randomID("")[:4]),
		Doc:   d.ID,
		Path:  d.Path,
	}
	for i := range d.Comments {
		c := &d.Comments[i]
		if c.Status != Draft {
			continue
		}
		at := now
		c.Status, c.SentAt, c.Batch = Sent, &at, b.Batch
		b.Comments = append(b.Comments, BatchComment{ID: c.ID, Quote: c.Quote, Body: c.Body})
	}
	if len(b.Comments) == 0 {
		return Batch{}, ErrNoDrafts
	}
	dir := filepath.Join(s.root, "outbox", d.Session)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Batch{}, err
	}
	if err := writeJSON(filepath.Join(dir, b.Batch+".json"), b); err != nil {
		return Batch{}, err
	}
	return b, s.save(&d)
}

func (s *Store) Outbox(session string) ([]Batch, error) {
	if !validSession.MatchString(session) {
		return nil, fmt.Errorf("%w：会话 ID 不合法", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.root, "outbox", session)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Batch{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Batch{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		var b Batch
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Batch < out[j].Batch })
	return out, nil
}

// Ack 确认批次已送达并删除；重复确认不报错。
func (s *Store) Ack(session, batch string) error {
	if !validSession.MatchString(session) || !validBatch.MatchString(batch) {
		return fmt.Errorf("%w：会话或批次名不合法", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	err := os.Remove(filepath.Join(s.root, "outbox", session, batch+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Resolve 按评论 ID 跨文档标记已解决；有找不到的 ID 时返回 ErrNotFound，其余照常处理。
func (s *Store) Resolve(items []ResolveItem) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := map[string]string{}
	for _, it := range items {
		want[it.ID] = it.Note
	}
	docs, err := s.allDocs()
	if err != nil {
		return 0, err
	}
	done := 0
	for _, d := range docs {
		changed := false
		for i := range d.Comments {
			c := &d.Comments[i]
			note, ok := want[c.ID]
			if !ok {
				continue
			}
			delete(want, c.ID)
			if c.Status == Resolved {
				continue
			}
			c.Status = Resolved
			c.Resolution = &Resolution{Note: note, At: s.now()}
			changed = true
			done++
		}
		if changed {
			if err := s.save(&d); err != nil {
				return done, err
			}
		}
	}
	if len(want) > 0 {
		missing := make([]string, 0, len(want))
		for id := range want {
			missing = append(missing, id)
		}
		sort.Strings(missing)
		return done, fmt.Errorf("%w：评论 %s", ErrNotFound, strings.Join(missing, "、"))
	}
	return done, nil
}

func (s *Store) ListBySession(session string) ([]DocSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	docs, err := s.allDocs()
	if err != nil {
		return nil, err
	}
	out := []DocSummary{}
	for _, d := range docs {
		if d.Session != session {
			continue
		}
		open := 0
		for _, c := range d.Comments {
			if c.Status != Resolved {
				open++
			}
		}
		out = append(out, DocSummary{ID: d.ID, Path: d.Path, Open: open})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func (s *Store) Revision(id string) (int, error) {
	d, err := s.Get(id)
	return d.Revision, err
}

func (s *Store) allDocs() ([]Doc, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "docs"))
	if err != nil {
		return nil, err
	}
	var out []Doc
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		d, err := s.load(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}
```

- [ ] **Step 4：运行确认通过**

Run: `cd server && go test ./store/ && go vet ./...`
Expected: `ok  docreview/store`

- [ ] **Step 5：提交**

```bash
git add server/store
git commit -m "feat(store): 发送批次、outbox、标记已解决与文档列表"
```

---

### Task 3：JSON 接口与令牌校验

**Files:**
- Create: `server/api/api.go`、`server/api/api_test.go`、`server/api/pages.go`（空实现，Task 4 替换）

**Interfaces:**
- Consumes：Task 1、2 的 `store` 全部导出。
- Produces（`package api`）：
  - `type Config struct{ Store *store.Store; Token, BaseURL, Version string; Static fs.FS; Poll time.Duration }`
  - `func New(cfg Config) http.Handler`
  - 接口：`GET /api/health` → `{"name":"doc-review","version":…}`；`POST /api/open {path,session}` → `{doc, url}`；`GET /api/doc?doc=`；`GET /api/docs?session=`；`POST|PATCH|DELETE /api/comments`；`POST /api/send {doc}` → Batch；`GET /api/outbox?session=` → `[]Batch`；`POST /api/outbox/ack {session,batch}`；`POST /api/resolve {items:[{id,note}]}` → `{resolved}`。错误统一为 `{"error":"…"}`。
  - 供 Task 4 使用：`(*app).auth`、`fail`、`writeErr`、`(*app).registerPages`。

- [ ] **Step 1：写失败的测试** `server/api/api_test.go`

```go
package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"docreview/store"
)

type env struct {
	srv *httptest.Server
	st  *store.Store
	md  string
}

func setup(t *testing.T) env {
	t.Helper()
	st, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	md := filepath.Join(t.TempDir(), "a.md")
	os.WriteFile(md, []byte("# 标题\n\n正文"), 0o644)
	static := fstest.MapFS{
		"review.html": {Data: []byte("<html>shell</html>")},
		"review.js":   {Data: []byte("// js")},
	}
	srv := httptest.NewServer(New(Config{
		Store: st, Token: "tok", BaseURL: "http://127.0.0.1:4823",
		Static: static, Version: "test", Poll: 20 * time.Millisecond,
	}))
	t.Cleanup(srv.Close)
	return env{srv, st, md}
}

// call 发请求并返回状态码和响应体；token 为空时不带令牌。body 为 string 时原样发送。
func call(t *testing.T, e env, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	if token != "" {
		req.Header.Set("X-Review-Token", token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, out
}

func decode[T any](t *testing.T, b []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("decode %s: %v", b, err)
	}
	return v
}

func TestHealthNeedsNoToken(t *testing.T) {
	e := setup(t)
	code, body := call(t, e, "GET", "/api/health", "", nil)
	if code != 200 || decode[map[string]string](t, body)["name"] != "doc-review" {
		t.Fatalf("%d %s", code, body)
	}
}

func TestRejectsMissingOrWrongToken(t *testing.T) {
	e := setup(t)
	for _, tok := range []string{"", "wrong"} {
		if code, _ := call(t, e, "POST", "/api/open", tok, map[string]string{"path": e.md, "session": "s1"}); code != 401 {
			t.Fatalf("token %q: got %d", tok, code)
		}
	}
}

func TestFullCommentRoundTrip(t *testing.T) {
	e := setup(t)
	code, body := call(t, e, "POST", "/api/open", "tok", map[string]string{"path": e.md, "session": "s1"})
	if code != 200 {
		t.Fatalf("open: %d %s", code, body)
	}
	opened := decode[struct {
		Doc store.Doc `json:"doc"`
		URL string    `json:"url"`
	}](t, body)
	if opened.URL != "http://127.0.0.1:4823/review?doc="+opened.Doc.ID+"&t=tok" {
		t.Fatalf("url: %s", opened.URL)
	}
	id := opened.Doc.ID

	code, body = call(t, e, "POST", "/api/comments", "tok", map[string]string{"doc": id, "quote": "正文", "body": "太短"})
	if code != 200 {
		t.Fatalf("add: %d %s", code, body)
	}
	c := decode[store.Comment](t, body)

	code, body = call(t, e, "PATCH", "/api/comments", "tok", map[string]string{"doc": id, "id": c.ID, "body": "展开写"})
	if code != 200 || decode[store.Comment](t, body).Body != "展开写" {
		t.Fatalf("patch: %d %s", code, body)
	}

	code, body = call(t, e, "POST", "/api/send", "tok", map[string]string{"doc": id})
	if code != 200 {
		t.Fatalf("send: %d %s", code, body)
	}
	batch := decode[store.Batch](t, body)

	if code, _ := call(t, e, "DELETE", "/api/comments?doc="+id+"&id="+c.ID, "tok", nil); code != 409 {
		t.Fatalf("已发送的评论删除应返回 409，得到 %d", code)
	}

	_, body = call(t, e, "GET", "/api/outbox?session=s1", "tok", nil)
	if got := decode[[]store.Batch](t, body); len(got) != 1 || got[0].Batch != batch.Batch {
		t.Fatalf("outbox: %s", body)
	}
	if code, body := call(t, e, "POST", "/api/outbox/ack", "tok", map[string]string{"session": "s1", "batch": batch.Batch}); code != 200 {
		t.Fatalf("ack: %d %s", code, body)
	}

	code, body = call(t, e, "POST", "/api/resolve", "tok", map[string]any{"items": []map[string]string{{"id": c.ID, "note": "已展开"}}})
	if code != 200 || decode[map[string]int](t, body)["resolved"] != 1 {
		t.Fatalf("resolve: %d %s", code, body)
	}

	_, body = call(t, e, "GET", "/api/doc?doc="+id, "tok", nil)
	if d := decode[store.Doc](t, body); d.Comments[0].Status != store.Resolved {
		t.Fatalf("doc: %s", body)
	}
	_, body = call(t, e, "GET", "/api/docs?session=s1", "tok", nil)
	if list := decode[[]store.DocSummary](t, body); len(list) != 1 || list[0].Open != 0 {
		t.Fatalf("docs: %s", body)
	}
}

func TestErrorsMapToStatus(t *testing.T) {
	e := setup(t)
	cases := []struct {
		method, path string
		body         any
		want         int
	}{
		{"POST", "/api/open", map[string]string{"path": "rel.md", "session": "s1"}, 400},
		{"POST", "/api/open", map[string]string{"path": strings.TrimSuffix(e.md, ".md") + ".txt", "session": "s1"}, 400},
		{"POST", "/api/open", map[string]string{"path": filepath.Join(filepath.Dir(e.md), "none.md"), "session": "s1"}, 404},
		{"GET", "/api/doc?doc=nope", nil, 404},
		{"POST", "/api/comments", "not json", 400},
	}
	for _, c := range cases {
		if code, body := call(t, e, c.method, c.path, "tok", c.body); code != c.want {
			t.Errorf("%s %s: got %d %s, want %d", c.method, c.path, code, body, c.want)
		}
	}
}
```

- [ ] **Step 2：运行确认失败**

Run: `cd server && go test ./api/`
Expected: FAIL，`undefined: New`、`undefined: Config`

- [ ] **Step 3：实现** `server/api/api.go`

```go
// Package api 提供评审页和 mod 使用的 HTTP 接口。
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"time"

	"docreview/store"
)

type Config struct {
	Store   *store.Store
	Token   string
	BaseURL string
	Static  fs.FS
	Version string
	Poll    time.Duration
}

type app struct{ cfg Config }

func New(cfg Config) http.Handler {
	if cfg.Poll == 0 {
		cfg.Poll = 500 * time.Millisecond
	}
	a := &app{cfg}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("POST /api/open", a.auth(a.open))
	mux.HandleFunc("GET /api/doc", a.auth(a.doc))
	mux.HandleFunc("GET /api/docs", a.auth(a.docs))
	mux.HandleFunc("POST /api/comments", a.auth(a.addComment))
	mux.HandleFunc("PATCH /api/comments", a.auth(a.updateComment))
	mux.HandleFunc("DELETE /api/comments", a.auth(a.deleteComment))
	mux.HandleFunc("POST /api/send", a.auth(a.send))
	mux.HandleFunc("GET /api/outbox", a.auth(a.outbox))
	mux.HandleFunc("POST /api/outbox/ack", a.auth(a.ack))
	mux.HandleFunc("POST /api/resolve", a.auth(a.resolve))
	a.registerPages(mux)
	return mux
}

// auth 校验请求头 X-Review-Token 或链接参数 t。
func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get("X-Review-Token")
		if tok == "" {
			tok = r.URL.Query().Get("t")
		}
		if subtle.ConstantTimeCompare([]byte(tok), []byte(a.cfg.Token)) != 1 {
			writeErr(w, http.StatusUnauthorized, errors.New("令牌无效"))
			return
		}
		next(w, r)
	}
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"name": "doc-review", "version": a.cfg.Version})
}

func (a *app) open(w http.ResponseWriter, r *http.Request) {
	var in struct{ Path, Session string }
	if !readJSON(w, r, &in) {
		return
	}
	d, err := a.cfg.Store.Open(in.Path, in.Session)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"doc": d, "url": a.cfg.BaseURL + "/review?doc=" + d.ID + "&t=" + a.cfg.Token})
}

func (a *app) doc(w http.ResponseWriter, r *http.Request) {
	d, err := a.cfg.Store.Get(r.URL.Query().Get("doc"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, d)
}

func (a *app) docs(w http.ResponseWriter, r *http.Request) {
	list, err := a.cfg.Store.ListBySession(r.URL.Query().Get("session"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, list)
}

func (a *app) addComment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Doc string `json:"doc"`
		store.NewComment
	}
	if !readJSON(w, r, &in) {
		return
	}
	c, err := a.cfg.Store.AddComment(in.Doc, in.NewComment)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, c)
}

func (a *app) updateComment(w http.ResponseWriter, r *http.Request) {
	var in struct{ Doc, ID, Body string }
	if !readJSON(w, r, &in) {
		return
	}
	c, err := a.cfg.Store.UpdateComment(in.Doc, in.ID, in.Body)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, c)
}

func (a *app) deleteComment(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if err := a.cfg.Store.DeleteComment(q.Get("doc"), q.Get("id")); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *app) send(w http.ResponseWriter, r *http.Request) {
	var in struct{ Doc string }
	if !readJSON(w, r, &in) {
		return
	}
	b, err := a.cfg.Store.Send(in.Doc)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, b)
}

func (a *app) outbox(w http.ResponseWriter, r *http.Request) {
	list, err := a.cfg.Store.Outbox(r.URL.Query().Get("session"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, list)
}

func (a *app) ack(w http.ResponseWriter, r *http.Request) {
	var in struct{ Session, Batch string }
	if !readJSON(w, r, &in) {
		return
	}
	if err := a.cfg.Store.Ack(in.Session, in.Batch); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *app) resolve(w http.ResponseWriter, r *http.Request) {
	var in struct{ Items []store.ResolveItem }
	if !readJSON(w, r, &in) {
		return
	}
	n, err := a.cfg.Store.Resolve(in.Items)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]int{"resolved": n})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, errors.New("请求体不是合法的 JSON"))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

// fail 把存储层错误映射为 HTTP 状态码。
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, os.ErrNotExist):
		writeErr(w, http.StatusNotFound, err)
	case errors.Is(err, store.ErrNotDraft), errors.Is(err, store.ErrNoDrafts):
		writeErr(w, http.StatusConflict, err)
	case errors.Is(err, store.ErrInvalid), errors.Is(err, store.ErrUnsupported):
		writeErr(w, http.StatusBadRequest, err)
	default:
		writeErr(w, http.StatusInternalServerError, err)
	}
}
```

`server/api/pages.go`（空实现，让本任务单独编译通过）：

```go
package api

import "net/http"

// registerPages 注册评审页相关路由，Task 4 实现。
func (a *app) registerPages(mux *http.ServeMux) {}
```

- [ ] **Step 4：运行确认通过**

Run: `cd server && go test ./... && go vet ./...`
Expected: `ok  docreview/api`、`ok  docreview/store`

- [ ] **Step 5：提交**

```bash
git add server/api
git commit -m "feat(api): 评论接口、outbox 与令牌校验"
```

---

### Task 4：评审页、原文、同目录资源与 SSE

**Files:**
- Modify: `server/api/pages.go`（替换空实现）
- Create: `server/api/pages_test.go`、`server/web/embed.go`、`server/web/static/review.html`（占位，Task 7 替换）

**Interfaces:**
- Consumes：Task 3 的 `app`、`auth`、`fail`、`writeErr`；`store.Store.Get`、`Revision`。
- Produces：
  - `GET /review?doc=&t=`：md 返回 `Static` 里的 `review.html`；html 返回注入后的页面。
  - `GET /raw?doc=&t=`：md 原文，`text/markdown`。
  - `GET /asset/{doc}/{path...}`：HTML 同目录资源，不校验令牌。
  - `GET /static/`：`Static` 里的文件。
  - `GET /events?doc=&t=`：SSE，事件名 `change`，数据 `{"file":bool,"comments":bool}`。
  - `func inject(page []byte, docID string) []byte`：`<base href="/asset/<id>/">` 放在 `<head>` 之后（没有 `<head>` 就放在最前），`<script type="module" src="/static/review.js" data-doc-review="html"></script>` 放在最后一个 `</body>` 之前（没有就追加到末尾）。
  - `package web`：`var FS fs.FS`（`static/` 子树）。

- [ ] **Step 1：写失败的测试** `server/api/pages_test.go`

```go
package api

import (
	"bufio"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"docreview/store"
)

func TestReviewServesShellForMarkdown(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	code, body := call(t, e, "GET", "/review?doc="+d.ID+"&t=tok", "", nil)
	if code != 200 || string(body) != "<html>shell</html>" {
		t.Fatalf("%d %s", code, body)
	}
}

func TestReviewInjectsIntoHTML(t *testing.T) {
	e := setup(t)
	p := filepath.Join(filepath.Dir(e.md), "page.html")
	os.WriteFile(p, []byte("<html><head><title>x</title></head><body><p>hi</p></body></html>"), 0o644)
	d, _ := e.st.Open(p, "s1")
	_, body := call(t, e, "GET", "/review?doc="+d.ID+"&t=tok", "", nil)
	s := string(body)
	if !strings.Contains(s, `<head><base href="/asset/`+d.ID+`/">`) {
		t.Fatalf("缺少 base：%s", s)
	}
	if !strings.Contains(s, `data-doc-review="html"></script></body>`) {
		t.Fatalf("脚本应在 </body> 前：%s", s)
	}
}

func TestInjectWithoutHeadOrBody(t *testing.T) {
	got := string(inject([]byte("<p>bare</p>"), "abc"))
	if !strings.HasPrefix(got, `<base href="/asset/abc/">`) || !strings.HasSuffix(got, `data-doc-review="html"></script>`) {
		t.Fatalf("got %s", got)
	}
}

func TestRawReturnsMarkdownAnd404WhenGone(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	code, body := call(t, e, "GET", "/raw?doc="+d.ID+"&t=tok", "", nil)
	if code != 200 || string(body) != "# 标题\n\n正文" {
		t.Fatalf("%d %s", code, body)
	}
	os.Remove(e.md)
	if code, _ := call(t, e, "GET", "/raw?doc="+d.ID+"&t=tok", "", nil); code != 404 {
		t.Fatalf("文件删除后应 404，得到 %d", code)
	}
}

func TestAssetStaysInsideDocDir(t *testing.T) {
	e := setup(t)
	dir := filepath.Dir(e.md)
	p := filepath.Join(dir, "page.html")
	os.WriteFile(p, []byte("<p>x</p>"), 0o644)
	os.WriteFile(filepath.Join(dir, "img.txt"), []byte("pixel"), 0o644)
	d, _ := e.st.Open(p, "s1")
	if code, body := call(t, e, "GET", "/asset/"+d.ID+"/img.txt", "", nil); code != 200 || string(body) != "pixel" {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := call(t, e, "GET", "/asset/"+d.ID+"/..%2Fsecret.txt", "", nil); code == 200 {
		t.Fatal("不应读到文档目录之外的文件")
	}
}

// waitEvent 打开 SSE，执行 trigger，等到包含 want 的 data 行。
func waitEvent(t *testing.T, e env, docID, want string, trigger func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", e.srv.URL+"/events?doc="+docID+"&t=tok", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	trigger()
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		if line := sc.Text(); strings.HasPrefix(line, "data: ") && strings.Contains(line, want) {
			return
		}
	}
	t.Fatalf("没有收到包含 %s 的事件", want)
}

func TestEventsReportFileChange(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	waitEvent(t, e, d.ID, `"file":true`, func() {
		future := time.Now().Add(time.Hour)
		os.Chtimes(e.md, future, future)
	})
}

func TestEventsReportCommentChange(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	waitEvent(t, e, d.ID, `"comments":true`, func() {
		e.st.AddComment(d.ID, store.NewComment{Quote: "正文", Body: "x"})
	})
}
```

- [ ] **Step 2：运行确认失败**

Run: `cd server && go test ./api/`
Expected: FAIL，`undefined: inject`

- [ ] **Step 3：实现** `server/api/pages.go`

```go
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func (a *app) registerPages(mux *http.ServeMux) {
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(a.cfg.Static)))
	mux.HandleFunc("GET /asset/{doc}/{path...}", a.asset)
	mux.HandleFunc("GET /review", a.auth(a.review))
	mux.HandleFunc("GET /raw", a.auth(a.raw))
	mux.HandleFunc("GET /events", a.auth(a.events))
}

func (a *app) review(w http.ResponseWriter, r *http.Request) {
	d, err := a.cfg.Store.Get(r.URL.Query().Get("doc"))
	if err != nil {
		fail(w, err)
		return
	}
	var page []byte
	if d.Kind == "md" {
		page, err = fs.ReadFile(a.cfg.Static, "review.html")
	} else if page, err = os.ReadFile(d.Path); err == nil {
		page = inject(page, d.ID)
	}
	if err != nil {
		fail(w, fmt.Errorf("文件不存在或无法读取：%w", err))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(page)
}

// inject 给 HTML 加上 base（让相对路径资源走 /asset）和评审脚本。
func inject(page []byte, docID string) []byte {
	base := []byte(`<base href="/asset/` + docID + `/">`)
	script := []byte(`<script type="module" src="/static/review.js" data-doc-review="html"></script>`)
	var out []byte
	if i := bytes.Index(bytes.ToLower(page), []byte("<head>")); i >= 0 {
		at := i + len("<head>")
		out = append(append(append(out, page[:at]...), base...), page[at:]...)
	} else {
		out = append(append(out, base...), page...)
	}
	if i := bytes.LastIndex(bytes.ToLower(out), []byte("</body>")); i >= 0 {
		return append(append(append([]byte{}, out[:i]...), script...), out[i:]...)
	}
	return append(out, script...)
}

func (a *app) raw(w http.ResponseWriter, r *http.Request) {
	d, err := a.cfg.Store.Get(r.URL.Query().Get("doc"))
	if err != nil {
		fail(w, err)
		return
	}
	b, err := os.ReadFile(d.Path)
	if err != nil {
		fail(w, fmt.Errorf("文件不存在或无法读取：%w", err))
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// asset 提供 HTML 文档同目录下的资源，os.OpenRoot 保证不越出该目录。
func (a *app) asset(w http.ResponseWriter, r *http.Request) {
	d, err := a.cfg.Store.Get(r.PathValue("doc"))
	if err != nil {
		fail(w, err)
		return
	}
	root, err := os.OpenRoot(filepath.Dir(d.Path))
	if err != nil {
		fail(w, err)
		return
	}
	defer root.Close()
	f, err := root.Open(r.PathValue("path"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

// events 每 Poll 检查一次文件修改时间和评论版本，变化时推送 change 事件。
func (a *app) events(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("doc")
	d, err := a.cfg.Store.Get(id)
	if err != nil {
		fail(w, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("不支持流式响应"))
		return
	}
	mtime := func() int64 {
		if st, err := os.Stat(d.Path); err == nil {
			return st.ModTime().UnixNano()
		}
		return 0
	}
	lastFile, lastRev := mtime(), d.Revision
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, ": ok\n\n")
	flusher.Flush()
	tick := time.NewTicker(a.cfg.Poll)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			file := mtime()
			rev, _ := a.cfg.Store.Revision(id)
			change := map[string]bool{"file": file != lastFile, "comments": rev != lastRev}
			if !change["file"] && !change["comments"] {
				continue
			}
			lastFile, lastRev = file, rev
			data, _ := json.Marshal(change)
			fmt.Fprintf(w, "event: change\ndata: %s\n\n", data)
			flusher.Flush()
		}
	}
}
```

`server/web/embed.go`：

```go
// Package web 打包评审页的前端资源。
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// FS 是 static 目录本身，路径不带 static/ 前缀。
var FS, _ = fs.Sub(files, "static")
```

`server/web/static/review.html` 先放占位内容 `<!doctype html><title>doc-review</title>`，Task 7 替换。

- [ ] **Step 4：运行确认通过**

Run: `cd server && go test ./... && go vet ./...`
Expected: 全部 `ok`

- [ ] **Step 5：提交**

```bash
git add server/api server/web
git commit -m "feat(api): 评审页、原文、同目录资源与 SSE"
```

---

### Task 5：服务入口、端口选择与构建

**Files:**
- Create: `server/main.go`、`server/main_test.go`、`Makefile`

**Interfaces:**
- Consumes：`store.New`、`api.New`、`api.Config`、`web.FS`。
- Produces：
  - 二进制 `bin/doc-review-server`，参数 `-dir`（默认 `~/.claude/doc-review`）。
  - `<dir>/server.json`：`{"port":4823,"token":"…","pid":123}`，权限 0600。
  - 端口上已有 doc-review 实例时打印提示并以 0 退出，不改 `server.json`。
  - `func listen(from, to int, isOurs func(int) bool) (net.Listener, int, error)`、`var errAlreadyRunning`。

- [ ] **Step 1：写失败的测试** `server/main_test.go`

```go
package main

import (
	"errors"
	"net"
	"testing"
)

func occupy(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func TestListenDetectsRunningInstance(t *testing.T) {
	p := occupy(t)
	if _, got, err := listen(p, p, func(int) bool { return true }); !errors.Is(err, errAlreadyRunning) || got != p {
		t.Fatalf("got %d %v", got, err)
	}
}

func TestListenFailsWhenAllTakenByOthers(t *testing.T) {
	p := occupy(t)
	if _, _, err := listen(p, p, func(int) bool { return false }); err == nil || errors.Is(err, errAlreadyRunning) {
		t.Fatalf("got %v", err)
	}
}

func TestListenReturnsActualPort(t *testing.T) {
	ln, port, err := listen(0, 0, func(int) bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if port == 0 || port != ln.Addr().(*net.TCPAddr).Port {
		t.Fatalf("port %d", port)
	}
}
```

- [ ] **Step 2：运行确认失败**

Run: `cd server && go test .`
Expected: FAIL，`undefined: listen`

- [ ] **Step 3：实现** `server/main.go`

```go
// doc-review-server 是本地文档评审服务：只监听本机，所有会话共用一个实例。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"docreview/api"
	"docreview/store"
	"docreview/web"
)

const version = "0.1.0"

var errAlreadyRunning = errors.New("already running")

func main() {
	home, _ := os.UserHomeDir()
	dir := flag.String("dir", filepath.Join(home, ".claude", "doc-review"), "数据目录")
	flag.Parse()

	st, err := store.New(*dir)
	if err != nil {
		log.Fatalf("初始化数据目录失败：%v", err)
	}
	ln, port, err := listen(4823, 4830, isOurs)
	if errors.Is(err, errAlreadyRunning) {
		log.Printf("端口 %d 上已有 doc-review 实例，退出", port)
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	token := randomToken()
	info, _ := json.Marshal(map[string]any{"port": port, "token": token, "pid": os.Getpid()})
	if err := os.WriteFile(filepath.Join(*dir, "server.json"), info, 0o600); err != nil {
		log.Fatalf("写入 server.json 失败：%v", err)
	}
	log.Printf("doc-review %s 监听 127.0.0.1:%d", version, port)
	log.Fatal(http.Serve(ln, api.New(api.Config{
		Store: st, Token: token, Version: version, Static: web.FS,
		BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
	})))
}

// listen 依次尝试端口；端口被占用且占用者是 doc-review 时返回 errAlreadyRunning。
func listen(from, to int, isOurs func(int) bool) (net.Listener, int, error) {
	for p := from; p <= to; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return ln, ln.Addr().(*net.TCPAddr).Port, nil
		}
		if isOurs(p) {
			return nil, p, errAlreadyRunning
		}
	}
	return nil, 0, fmt.Errorf("端口 %d～%d 都被占用", from, to)
}

func isOurs(port int) bool {
	c := http.Client{Timeout: 500 * time.Millisecond}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var v struct{ Name string }
	return json.NewDecoder(res.Body).Decode(&v) == nil && v.Name == "doc-review"
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

`Makefile`：

```make
.PHONY: build test run

build:
	cd server && go build -o ../bin/doc-review-server .

test:
	cd server && go test ./... && go vet ./...
	node --test tests/web/
	claude plugin test .

run: build
	./bin/doc-review-server
```

- [ ] **Step 4：运行确认通过并试跑**

Run: `cd server && go test ./... && cd .. && make build && ls -l bin/doc-review-server`
Expected: 测试全部 `ok`，二进制存在。

试跑（用临时数据目录，不碰真实目录）：

```bash
DIR=$(mktemp -d)
./bin/doc-review-server -dir "$DIR" & sleep 0.5
curl -s 127.0.0.1:4823/api/health
./bin/doc-review-server -dir "$DIR"
kill %1; rm -rf "$DIR"
```

Expected: health 返回 `{"name":"doc-review","version":"0.1.0"}`；第二个实例打印「已有 doc-review 实例，退出」后立即退出。

- [ ] **Step 5：提交**

```bash
git add server/main.go server/main_test.go Makefile
git commit -m "feat(server): 服务入口、端口选择与 server.json"
```

---

### Task 6：前端原文定位（anchor.js）

**Files:**
- Create: `server/web/static/anchor.js`、`tests/web/anchor.test.mjs`

**Interfaces:**
- Produces（ES 模块，浏览器和 node 通用）：
  - `export const CONTEXT = 30`
  - `export function captureQuote(text, start, end, ctx = CONTEXT) → { quote, prefix, suffix }`
  - `export function locate(text, { quote, prefix, suffix }) → { start, end } | null`：在 `text` 中找 `quote` 的所有出现位置，按「前文与 prefix 的公共后缀长度 + 后文与 suffix 的公共前缀长度」打分取最高；找不到返回 `null`。

- [ ] **Step 1：写失败的测试** `tests/web/anchor.test.mjs`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { captureQuote, locate } from '../../server/web/static/anchor.js'

test('captureQuote 取选区和前后各 30 个字', () => {
  const text = 'a'.repeat(40) + '目标' + 'b'.repeat(40)
  assert.deepEqual(captureQuote(text, 40, 42), {
    quote: '目标',
    prefix: 'a'.repeat(30),
    suffix: 'b'.repeat(30),
  })
})

test('captureQuote 在文本两端不越界', () => {
  assert.deepEqual(captureQuote('开头结尾', 0, 2), { quote: '开头', prefix: '', suffix: '结尾' })
})

test('locate 找到唯一出现的原文', () => {
  const text = '背景。方案是按环境分组。风险。'
  assert.deepEqual(locate(text, captureQuote(text, 3, 11)), { start: 3, end: 11 })
})

test('原文重复出现时按上下文选对位置', () => {
  const text = '第一段：需要改。第二段：需要改。'
  const at = text.lastIndexOf('需要改')
  assert.deepEqual(locate(text, captureQuote(text, at, at + 3)), { start: at, end: at + 3 })
})

test('前面插入内容后仍能定位', () => {
  const before = '第一节。目标句子在这里。尾巴。'
  const q = captureQuote(before, 4, 11)
  const after = '新增的开头段落。' + before
  const start = after.indexOf('目标句子在这里')
  assert.deepEqual(locate(after, q), { start, end: start + 7 })
})

test('原文被改掉时返回 null', () => {
  const q = captureQuote('方案是按环境分组。', 0, 8)
  assert.equal(locate('方案是按区域分组。', q), null)
})

test('空引用返回 null', () => {
  assert.equal(locate('任何文本', { quote: '', prefix: '', suffix: '' }), null)
})
```

- [ ] **Step 2：运行确认失败**

Run: `node --test tests/web/`
Expected: FAIL，找不到 `anchor.js`

- [ ] **Step 3：实现** `server/web/static/anchor.js`

```js
// 评论的原文定位：保存选中文字及其前后文，文档改动后据此重新找到位置。

export const CONTEXT = 30

export function captureQuote(text, start, end, ctx = CONTEXT) {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ctx), start),
    suffix: text.slice(end, end + ctx),
  }
}

function commonSuffixLength(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefixLength(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

export function locate(text, { quote, prefix = '', suffix = '' }) {
  if (!quote) return null
  let best = null
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    const end = i + quote.length
    const score =
      commonSuffixLength(text.slice(Math.max(0, i - prefix.length), i), prefix) +
      commonPrefixLength(text.slice(end, end + suffix.length), suffix)
    if (!best || score > best.score) best = { start: i, end, score }
  }
  return best && { start: best.start, end: best.end }
}
```

- [ ] **Step 4：运行确认通过**

Run: `node --test tests/web/`
Expected: 7 个测试全部 pass

- [ ] **Step 5：提交**

```bash
git add server/web/static/anchor.js tests/web
git commit -m "feat(web): 评论原文定位"
```

---

### Task 7：评审页界面

**Files:**
- Create: `server/web/static/textmap.js`、`api.js`、`overlay.js`、`review.js`、`review.css`、`vendor/*`
- Modify: `server/web/static/review.html`（替换占位）

**Interfaces:**
- Consumes：`anchor.js` 的 `captureQuote`、`locate`；Task 3、4 的全部接口。
- Produces：
  - `textmap.js`：`buildTextMap(root) → { root, text, nodes }`、`offsetOf(map, node, offset) → number`、`rangeOf(map, start, end) → Range`。
  - `api.js`：`createApi(token) → { get(url), send(method, url, body) }`，失败时抛出带服务端 `error` 文本的 `Error`。
  - `overlay.js`：`createOverlay(handlers) → { host, showFloat(rect), hideFloat(), openEditor(rect, text, onSave), render({ docs, doc, anchored }), placeMarkers(markers), focus(id), toast(text) }`；`handlers` 为 `{ onComment, onSend, onSwitchDoc(id), onEdit(id), onDelete(id) }`。
  - 高亮名：`dr-draft`（草稿）、`dr-sent`（处理中）。

- [ ] **Step 1：下载第三方库（先向用户确认）**

下载前把下表告诉用户，得到同意后再执行：

| 文件 | 来源 | 约 |
|---|---|---|
| `vendor/marked.min.js` | `https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js` | 40 KB |
| `vendor/purify.min.js` | `https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js` | 22 KB |
| `vendor/highlight.min.js` | `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js` | 120 KB |
| `vendor/github.min.css` | `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github.min.css` | 1 KB |
| `vendor/github-dark.min.css` | `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github-dark.min.css` | 1 KB |
| `vendor/mermaid.min.js` | `https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js` | 2.6 MB |

```bash
mkdir -p server/web/static/vendor && cd server/web/static/vendor
curl -fsSLO https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js
curl -fsSLO https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js
curl -fsSLO https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js
curl -fsSLO https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github.min.css
curl -fsSLO https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github-dark.min.css
curl -fsSLO https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js
ls -l
```

Expected：6 个文件，体积与上表同一量级。任一 `curl` 因版本不存在而失败，就换成该库同一主版本的最新版再试，并把实际版本记进 README。

- [ ] **Step 2：写 `textmap.js`**

```js
// 把 root 下全部文本节点拼成一个字符串，在「字符偏移」和 DOM Range 之间互转。
// 偏移用 Range.toString() 计算，与拼接结果一致。

export function buildTextMap(root) {
  const nodes = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length })
    text += n.data
  }
  return { root, text, nodes }
}

export function offsetOf(map, node, offset) {
  const r = document.createRange()
  r.setStart(map.root, 0)
  r.setEnd(node, offset)
  return r.toString().length
}

// 找到位置 pos 所在的文本节点；结束点正好落在节点边界时取前一个节点的末尾。
function pointAt(map, pos, isEnd) {
  let lo = 0
  let hi = map.nodes.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = map.nodes[mid].start
    if (s < pos || (!isEnd && s === pos)) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const { node, start } = map.nodes[idx]
  return [node, Math.min(pos - start, node.data.length)]
}

export function rangeOf(map, start, end) {
  const r = document.createRange()
  if (map.nodes.length === 0) return r
  r.setStart(...pointAt(map, start, false))
  r.setEnd(...pointAt(map, end, true))
  return r
}
```

- [ ] **Step 3：写 `api.js`**

```js
// 带令牌的接口调用；失败时抛出服务端返回的错误文本。

export function createApi(token) {
  async function send(method, url, body) {
    const headers = { 'X-Review-Token': token }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }
  return { get: url => send('GET', url), send }
}
```

- [ ] **Step 4：写 `overlay.js`**

全部用 DOM API 构建，用户内容只以文本节点插入。

```js
// 评审界面：放在 Shadow DOM 里，不受页面样式影响，也不影响页面。

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
button { cursor: pointer; border: 0; border-radius: 6px; }
.float { position: fixed; z-index: 3; padding: 6px 12px; background: #2b2b2b; color: #f5f5f5;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); border: 1px solid #444; }
.float:hover { background: #3a3a3a; }
.editor { position: fixed; z-index: 4; width: 320px; padding: 8px; background: #2b2b2b;
  border: 1px solid #444; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.editor textarea { width: 100%; min-height: 72px; resize: vertical; padding: 6px; color: #f5f5f5;
  background: #1e1e1e; border: 1px solid #555; border-radius: 6px; }
.editor .hint { color: #999; font-size: 12px; margin-top: 4px; }
.marker { position: fixed; z-index: 2; width: 20px; height: 20px; padding: 0; font-size: 12px;
  background: #fde68a; border-radius: 10px; }
.marker.sent { background: #bfdbfe; }
.bar { position: fixed; z-index: 5; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center;
  padding: 8px 12px; background: #1f1f1f; color: #ddd; border-top: 1px solid #333; }
.bar select { max-width: 40%; background: #2b2b2b; color: #ddd; border: 1px solid #444; border-radius: 6px; padding: 3px 6px; }
.bar .count { flex: 1; color: #aaa; }
.bar .send { padding: 5px 12px; background: #d97757; color: #fff; }
.bar .send:disabled { background: #555; color: #999; cursor: default; }
.bar .toggle { padding: 5px 10px; background: #2b2b2b; color: #ddd; }
.drawer { position: fixed; z-index: 5; left: 0; right: 0; bottom: 45px; max-height: 50vh; overflow: auto;
  padding: 8px 12px 12px; background: #1b1b1b; color: #ddd; border-top: 1px solid #333; }
.drawer h4 { margin: 10px 0 4px; color: #aaa; font-weight: 600; }
.item { padding: 8px; margin: 4px 0; background: #242424; border-radius: 6px; border-left: 3px solid #fde68a; }
.item.sent { border-color: #93c5fd; }
.item.resolved { border-color: #4ade80; opacity: .8; }
.item.moved { border-color: #f87171; }
.item.focus { outline: 1px solid #d97757; }
.item .quote { color: #999; }
.item .note { margin-top: 4px; color: #86efac; }
.item .ops button { margin: 4px 6px 0 0; padding: 2px 8px; background: #333; color: #ddd; }
.toast { position: fixed; z-index: 6; left: 50%; bottom: 56px; transform: translateX(-50%); padding: 6px 12px;
  background: #333; color: #fff; border-radius: 6px; }
`

// el('div', { class: 'x', onclick: fn }, '文本', child)：字符串子节点一律作为文本插入。
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue
    if (k === 'class') node.className = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'style') node.style.cssText = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false))
  return node
}

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s)
const basename = p => p.split('/').pop()

export function createOverlay(h) {
  const host = document.createElement('doc-review-overlay')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })

  const textarea = el('textarea', { placeholder: '写下你的意见' })
  const float = el('button', { class: 'float', hidden: true }, '评论')
  const editor = el('div', { class: 'editor', hidden: true }, textarea, el('div', { class: 'hint' }, '回车保存，Shift+回车换行，Esc 取消'))
  const markers = el('div', { class: 'markers' })
  const drawer = el('div', { class: 'drawer', hidden: true })
  const toastEl = el('div', { class: 'toast', hidden: true })
  const docs = el('select', { class: 'docs' })
  const count = el('span', { class: 'count' })
  const sendBtn = el('button', { class: 'send', disabled: true }, '发送给 Claude')
  const toggle = el('button', { class: 'toggle' }, '评论 ▴')
  shadow.append(
    el('style', {}, STYLE),
    float,
    editor,
    markers,
    drawer,
    toastEl,
    el('div', { class: 'bar' }, docs, count, sendBtn, toggle),
  )

  let onSave = null
  let toastTimer = 0

  float.addEventListener('mousedown', e => e.preventDefault()) // 保住页面上的选区
  float.addEventListener('click', () => h.onComment())
  sendBtn.addEventListener('click', () => h.onSend())
  docs.addEventListener('change', () => h.onSwitchDoc(docs.value))
  toggle.addEventListener('click', () => setDrawer(drawer.hidden))
  textarea.addEventListener('keydown', e => {
    if (e.isComposing) return // 输入法组字时的回车不算保存
    if (e.key === 'Escape') closeEditor()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = textarea.value.trim()
      const save = onSave
      closeEditor()
      if (text && save) save(text)
    }
  })

  function setDrawer(open) {
    drawer.hidden = !open
    toggle.textContent = open ? '评论 ▾' : '评论 ▴'
  }

  function place(node, rect) {
    node.hidden = false
    const left = Math.max(8, Math.min(rect.left, innerWidth - node.offsetWidth - 8))
    const below = rect.bottom + 8
    const top = below + node.offsetHeight > innerHeight - 50 ? rect.top - node.offsetHeight - 8 : below
    node.style.left = `${left}px`
    node.style.top = `${Math.max(8, top)}px`
  }

  function closeEditor() {
    editor.hidden = true
    onSave = null
  }

  function item(c, isMoved) {
    return el(
      'div',
      { class: `item ${isMoved ? 'moved' : c.status}`, dataset: { id: c.id } },
      el('div', { class: 'quote' }, `「${short(c.quote)}」`),
      el('div', {}, c.body),
      c.resolution && el('div', { class: 'note' }, `处理：${c.resolution.note}`),
      c.status === 'draft' &&
        el(
          'div',
          { class: 'ops' },
          el('button', { onclick: () => h.onEdit(c.id) }, '修改'),
          el('button', { onclick: () => h.onDelete(c.id) }, '删除'),
        ),
    )
  }

  const self = {
    host,
    showFloat(rect) {
      place(float, rect)
    },
    hideFloat() {
      float.hidden = true
    },
    openEditor(rect, text, save) {
      float.hidden = true
      textarea.value = text
      onSave = save
      place(editor, rect)
      textarea.focus()
    },
    render({ docs: list, doc, anchored }) {
      docs.replaceChildren(
        ...list.map(d => el('option', { value: d.id, selected: d.id === doc.id }, `${basename(d.path)}（${d.open}）`)),
      )
      const drafts = doc.comments.filter(c => c.status === 'draft')
      count.textContent = drafts.length ? `待发送 ${drafts.length} 条` : '没有待发送的评论'
      sendBtn.disabled = drafts.length === 0
      const open = doc.comments.filter(c => c.status !== 'resolved')
      const groups = [
        ['草稿', open.filter(c => c.status === 'draft' && anchored.has(c.id)), false],
        ['处理中', open.filter(c => c.status === 'sent' && anchored.has(c.id)), false],
        ['原文已变动', open.filter(c => !anchored.has(c.id)), true],
      ]
      const resolved = doc.comments.filter(c => c.status === 'resolved')
      const sections = groups
        .filter(([, list]) => list.length)
        .flatMap(([title, list, isMoved]) => [el('h4', {}, `${title}（${list.length}）`), ...list.map(c => item(c, isMoved))])
      if (resolved.length) {
        sections.push(el('details', {}, el('summary', {}, `已解决（${resolved.length}）`), ...resolved.map(c => item(c, false))))
      }
      drawer.replaceChildren(...(sections.length ? sections : [el('p', {}, '还没有评论。选中正文里的文字即可评论。')]))
    },
    // markers: [{ id, status, rect }]，rect 为视口坐标
    placeMarkers(list) {
      markers.replaceChildren(
        ...list.map(m =>
          el(
            'button',
            { class: `marker ${m.status}`, style: `left:${m.rect.right + 2}px;top:${m.rect.top - 4}px`, onclick: () => self.focus(m.id) },
            '💬',
          ),
        ),
      )
    },
    focus(id) {
      setDrawer(true)
      for (const node of shadow.querySelectorAll('.item')) node.classList.toggle('focus', node.dataset.id === id)
      shadow.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
    },
    toast(text) {
      toastEl.textContent = text
      toastEl.hidden = false
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (toastEl.hidden = true), 3000)
    },
  }
  return self
}
```

- [ ] **Step 5：写 `review.js`**

```js
// 评审页入口：md 外壳页和注入后的 HTML 页面共用。

import { captureQuote, locate } from './anchor.js'
import { buildTextMap, offsetOf, rangeOf } from './textmap.js'
import { createApi } from './api.js'
import { createOverlay } from './overlay.js'

const params = new URLSearchParams(location.search)
const docId = params.get('doc')
const token = params.get('t')
const mode = document.querySelector('script[data-doc-review]')?.dataset.docReview ?? 'md'
const root = mode === 'md' ? document.getElementById('content') : document.body
const api = createApi(token)

let doc = null
let map = null
let pending = null // 当前选区 { start, end }
const anchors = new Map() // 评论 id → { start, end }

installHighlightStyle()
const ui = createOverlay({ onComment, onSend, onSwitchDoc, onEdit, onDelete })

await renderContent()
await refreshComments()
restoreScroll()
listen()

document.addEventListener('mouseup', e => {
  if (e.composedPath().includes(ui.host)) return
  setTimeout(onSelection, 0)
})
document.addEventListener('click', onClickText)
addEventListener('scroll', placeMarkers, { passive: true })
addEventListener('resize', placeMarkers)

function installHighlightStyle() {
  const style = document.createElement('style')
  style.dataset.docReview = ''
  style.textContent =
    '::highlight(dr-draft){background:rgba(250,204,21,.45)}::highlight(dr-sent){background:rgba(96,165,250,.40)}'
  document.head.appendChild(style)
}

async function renderContent() {
  if (mode === 'md') {
    const res = await fetch(`/raw?doc=${docId}&t=${token}`)
    if (!res.ok) {
      const p = document.createElement('p')
      p.className = 'missing'
      p.textContent = `文件不存在或无法读取（${res.status}）。评论仍然保留。`
      root.replaceChildren(p)
    } else {
      const html = window.marked.parse(await res.text())
      root.replaceChildren(window.DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }))
      for (const code of root.querySelectorAll('pre code')) {
        if (code.classList.contains('language-mermaid')) {
          const div = document.createElement('div')
          div.className = 'mermaid'
          div.textContent = code.textContent
          code.parentElement.replaceWith(div)
        } else {
          window.hljs.highlightElement(code)
        }
      }
      await window.mermaid.run({ querySelector: '.mermaid' }).catch(() => {})
    }
  }
  map = buildTextMap(root)
}

async function refreshComments() {
  try {
    doc = await api.get(`/api/doc?doc=${docId}`)
    if (mode === 'md') document.title = `评审：${doc.path.split('/').pop()}`
    anchors.clear()
    for (const c of doc.comments) {
      if (c.status === 'resolved') continue
      const pos = locate(map.text, c)
      if (pos) anchors.set(c.id, pos)
    }
    const docs = await api.get(`/api/docs?session=${encodeURIComponent(doc.session)}`)
    ui.render({ docs, doc, anchored: new Set(anchors.keys()) })
    paint()
  } catch (err) {
    ui.toast(`加载评论失败：${err.message}`)
  }
}

function paint() {
  const draft = new Highlight()
  const sent = new Highlight()
  for (const c of doc.comments) {
    const pos = anchors.get(c.id)
    if (pos) (c.status === 'draft' ? draft : sent).add(rangeOf(map, pos.start, pos.end))
  }
  CSS.highlights.set('dr-draft', draft)
  CSS.highlights.set('dr-sent', sent)
  placeMarkers()
}

function placeMarkers() {
  if (!doc) return
  const list = []
  for (const c of doc.comments) {
    const pos = anchors.get(c.id)
    if (!pos) continue
    const rects = rangeOf(map, pos.start, pos.end).getClientRects()
    const rect = rects[rects.length - 1]
    if (rect && rect.bottom > 0 && rect.top < innerHeight) list.push({ id: c.id, status: c.status, rect })
  }
  ui.placeMarkers(list)
}

function onSelection() {
  const sel = getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ui.hideFloat()
  const r = sel.getRangeAt(0)
  if (!root.contains(r.commonAncestorContainer)) return ui.hideFloat()
  const start = offsetOf(map, r.startContainer, r.startOffset)
  const end = offsetOf(map, r.endContainer, r.endOffset)
  if (end <= start || !map.text.slice(start, end).trim()) return ui.hideFloat()
  pending = { start, end }
  ui.showFloat(r.getBoundingClientRect())
}

function onComment() {
  if (!pending) return
  const at = { ...pending }
  ui.openEditor(rangeOf(map, at.start, at.end).getBoundingClientRect(), '', async body => {
    try {
      await api.send('POST', '/api/comments', { doc: docId, ...captureQuote(map.text, at.start, at.end), body })
      getSelection().removeAllRanges()
      pending = null
      await refreshComments()
    } catch (err) {
      ui.toast(`保存失败：${err.message}`)
    }
  })
}

async function onSend() {
  try {
    const batch = await api.send('POST', '/api/send', { doc: docId })
    ui.toast(`已发送 ${batch.comments.length} 条，Claude 处理完会自动更新`)
    await refreshComments()
  } catch (err) {
    ui.toast(`发送失败：${err.message}`)
  }
}

function onSwitchDoc(id) {
  location.href = `/review?doc=${encodeURIComponent(id)}&t=${token}`
}

function onEdit(id) {
  const c = doc.comments.find(one => one.id === id)
  const pos = anchors.get(id)
  const rect = pos ? rangeOf(map, pos.start, pos.end).getBoundingClientRect() : new DOMRect(16, innerHeight / 2, 0, 0)
  ui.openEditor(rect, c.body, async body => {
    try {
      await api.send('PATCH', '/api/comments', { doc: docId, id, body })
      await refreshComments()
    } catch (err) {
      ui.toast(`修改失败：${err.message}`)
    }
  })
}

async function onDelete(id) {
  try {
    await api.send('DELETE', `/api/comments?doc=${docId}&id=${encodeURIComponent(id)}`)
    await refreshComments()
  } catch (err) {
    ui.toast(`删除失败：${err.message}`)
  }
}

// 点到高亮文字时，在抽屉里定位到那条评论
function onClickText(e) {
  if (e.composedPath().includes(ui.host) || !getSelection().isCollapsed) return
  let node
  let offset
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY)
  if (pos) {
    node = pos.offsetNode
    offset = pos.offset
  } else {
    const r = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    node = r?.startContainer
    offset = r?.startOffset
  }
  if (!node || !root.contains(node)) return
  const at = offsetOf(map, node, offset)
  for (const [id, a] of anchors) {
    if (at >= a.start && at <= a.end) return ui.focus(id)
  }
}

function listen() {
  const es = new EventSource(`/events?doc=${docId}&t=${token}`)
  es.addEventListener('change', async ev => {
    const { file } = JSON.parse(ev.data)
    if (file) {
      if (mode === 'html') {
        sessionStorage.setItem('dr-scroll', String(scrollY))
        location.reload()
        return
      }
      const y = scrollY
      await renderContent()
      scrollTo(0, y)
    }
    await refreshComments()
  })
}

function restoreScroll() {
  const saved = sessionStorage.getItem('dr-scroll')
  if (saved === null) return
  sessionStorage.removeItem('dr-scroll')
  scrollTo(0, Number(saved))
}
```

- [ ] **Step 6：写 `review.html` 和 `review.css`**

`review.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>文档评审</title>
  <link rel="stylesheet" href="/static/review.css">
  <link rel="stylesheet" href="/static/vendor/github.min.css" media="(prefers-color-scheme: light)">
  <link rel="stylesheet" href="/static/vendor/github-dark.min.css" media="(prefers-color-scheme: dark)">
  <script src="/static/vendor/marked.min.js"></script>
  <script src="/static/vendor/purify.min.js"></script>
  <script src="/static/vendor/highlight.min.js"></script>
  <script src="/static/vendor/mermaid.min.js"></script>
  <script>
    mermaid.initialize({ startOnLoad: false, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' })
  </script>
</head>
<body>
  <main id="content" class="markdown-body"></main>
  <script type="module" src="/static/review.js" data-doc-review="md"></script>
</body>
</html>
```

`review.css`：

```css
:root { color-scheme: light dark; --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e6e6; --bg: #1a1a1a; --muted: #9a9a9a; --line: #3a3a3a; --code: #242424; }
}
body { margin: 0; background: var(--bg); color: var(--fg); }
.markdown-body { max-width: 860px; margin: 0 auto; padding: 24px 20px 96px;
  font: 15px/1.75 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.markdown-body h1, .markdown-body h2 { padding-bottom: .3em; border-bottom: 1px solid var(--line); }
.markdown-body table { border-collapse: collapse; display: block; overflow: auto; }
.markdown-body th, .markdown-body td { border: 1px solid var(--line); padding: 6px 12px; }
.markdown-body code { font: 13px/1.6 "SF Mono", Menlo, monospace; background: var(--code); padding: .1em .35em; border-radius: 4px; }
.markdown-body pre { background: var(--code); padding: 12px 16px; border-radius: 8px; overflow: auto; }
.markdown-body pre code { padding: 0; background: none; }
.markdown-body blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--line); }
.markdown-body img { max-width: 100%; }
.markdown-body .mermaid { text-align: center; }
.missing { color: #d1242f; }
```

- [ ] **Step 7：构建并在浏览器面板里手动验证**

```bash
make build
DIR=$(mktemp -d)
./bin/doc-review-server -dir "$DIR" &
sleep 0.5
TOKEN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['token'])" "$DIR/server.json")
curl -s -X POST 127.0.0.1:4823/api/open -H "X-Review-Token: $TOKEN" \
  -d "{\"path\":\"$PWD/docs/superpowers/specs/2026-10-11-doc-review-design.md\",\"session\":\"try\"}"
```

用返回的 `url` 在浏览器面板（`preview_start` 传 url）打开，逐项确认：

1. md 正常渲染：标题、表格、代码块都有样式。
2. 选中一段文字 → 出现〔评论〕→ 输入后回车 → 文字变黄、旁边出现 💬，底部显示「待发送 1 条」。
3. 中文输入法组字时按回车不会误保存。
4. 抽屉里能修改、删除草稿；点高亮文字会在抽屉里定位到对应评论。
5. 点〔发送给 Claude〕→ 高亮变蓝；`curl -H "X-Review-Token: $TOKEN" '127.0.0.1:4823/api/outbox?session=try'` 能看到批次。
6. 在终端里编辑这个 md 文件，页面自动刷新且滚动位置不变。
7. 准备 `$DIR/page.html`（带一张同目录图片 `<img src="pic.png">`）并登记，确认页面原样显示、图片能加载、划词评论可用。

验证完成后 `kill %1; rm -rf "$DIR"`。

- [ ] **Step 8：提交**

```bash
git add server/web
git commit -m "feat(web): 评审页界面：划词评论、高亮、抽屉与自动刷新"
```

---

### Task 8：mod 清单、消息格式与评审规则

**Files:**
- Create: `.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.js`（骨架）、`src/format.js`、`src/rules.js`、`tests/format.test.ts`、`tsconfig.json`

**Interfaces:**
- Produces：
  - `src/format.js`：`displayPath(path, cwd) → string`、`formatBatch(batch, cwd) → string`，`batch` 形如 `{ batch, doc, path, comments: [{ id, quote, body }] }`。
  - `src/rules.js`：`RULES`、`OPEN_TOOL`、`RESOLVE_TOOL`、`OPEN_SPEC`、`RESOLVE_SPEC`（后两者直接传给 `$.tool.register`）。

- [ ] **Step 1：写清单和骨架**

`.claude-plugin/plugin.json`：

```json
{
  "name": "doc-review",
  "version": "0.1.0",
  "description": "在右侧浏览器面板里对 md/HTML 划词评论，评论自动送进当前会话",
  "author": { "name": "SummErOK" }
}
```

`hooks/hooks.json`：

```json
{ "modules": ["./register.js"] }
```

`hooks/register.js`（Task 9 替换）：

```js
/** @type {import('claude-code').Register} */
export const register = () => {}
```

`tsconfig.json`：

```json
{ "extends": "./.claude-plugin/types/tsconfig.json" }
```

- [ ] **Step 2：写失败的测试** `tests/format.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import { displayPath, formatBatch } from '../src/format.js'

const BATCH = {
  batch: 'b_20261011_100500_ab12',
  doc: 'd1',
  path: '/proj/docs/plan.md',
  comments: [
    { id: 'c_1', quote: '方案是按环境\n分组', body: '改成表格' },
    { id: 'c_2', quote: '风险', body: '补充回滚方案\n以及负责人' },
  ],
}

test('工作目录下的文件显示相对路径，否则显示绝对路径', async () => {
  expect(displayPath('/proj/docs/plan.md', '/proj')).toBe('docs/plan.md')
  expect(displayPath('/proj/docs/plan.md', '/proj/')).toBe('docs/plan.md')
  expect(displayPath('/other/a.md', '/proj')).toBe('/other/a.md')
  expect(displayPath('/project2/a.md', '/proj')).toBe('/project2/a.md')
})

test('消息带文件、条数、每条的 ID、原文和意见', async () => {
  const text = formatBatch(BATCH, '/proj')
  expect(text).toContain('[文档评审] docs/plan.md 有 2 条新评论：')
  expect(text).toContain('1. [c_1] 原文：「方案是按环境 分组」')
  expect(text).toContain('   意见：改成表格')
  expect(text).toContain('2. [c_2] 原文：「风险」')
  expect(text).toContain('   意见：补充回滚方案\n   以及负责人')
  expect(text).toContain('review_resolve')
})

test('过长的原文截断', async () => {
  const text = formatBatch({ ...BATCH, comments: [{ id: 'c_9', quote: '字'.repeat(300), body: 'x' }] }, '/proj')
  expect(text).toContain('字'.repeat(200) + '…')
  expect(text).not.toContain('字'.repeat(201))
})
```

- [ ] **Step 3：运行确认失败**

Run: `claude plugin test .`
Expected: FAIL，找不到 `../src/format.js`

- [ ] **Step 4：实现** `src/format.js` 和 `src/rules.js`

`src/format.js`：

```js
// 把一批评论排成发进会话的消息。

/** @param {string} path @param {string} cwd */
export function displayPath(path, cwd) {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

/** @param {string} s @param {number} [max] */
function oneLine(s, max = 200) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * @param {{ path: string, comments: { id: string, quote: string, body: string }[] }} batch
 * @param {string} cwd
 */
export function formatBatch(batch, cwd) {
  const lines = [`[文档评审] ${displayPath(batch.path, cwd)} 有 ${batch.comments.length} 条新评论：`, '']
  batch.comments.forEach((c, i) => {
    lines.push(`${i + 1}. [${c.id}] 原文：「${oneLine(c.quote)}」`)
    lines.push(`   意见：${c.body.trim().replace(/\n/g, '\n   ')}`)
  })
  lines.push('', '处理完后，请对每条评论调用 review_resolve 说明处理结果（改了什么，或为什么没改）。')
  return lines.join('\n')
}
```

`src/rules.js`：

```js
// 系统提示规则和工具说明：模型据此决定何时打开评审页、如何回报处理结果。

export const OPEN_TOOL = 'mcp__doc-review__review_open'
export const RESOLVE_TOOL = 'mcp__doc-review__review_resolve'

export const RULES = `# 文档评审（doc-review）
当你为用户生成或大幅修改了需要用户阅读评审的 md 或 HTML 文件（方案、设计、文案、报告、页面等），写完后：
1. 调用 ${OPEN_TOOL}，传入文件路径；
2. 用浏览器面板打开它返回的评审链接（preview_start 传 url；面板已打开时用 navigate）。
随代码改动顺带修改的 README、CHANGELOG、CLAUDE.md 等不需要打开。
用户在评审页里发送的评论会以「[文档评审]」开头的消息送达。逐条处理：按意见修改文件；每条处理完调用 ${RESOLVE_TOOL}，写清改了什么，没改的说明原因。`

export const OPEN_SPEC = {
  name: 'review_open',
  description: '登记一个 md 或 HTML 文件供用户划词评论，返回评审页链接。拿到链接后要在浏览器面板里打开它。',
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
```

- [ ] **Step 5：运行确认通过并校验**

Run: `claude plugin test . && claude plugin validate .`
Expected: 3 个测试 pass；validate 无错误

- [ ] **Step 6：提交**

```bash
git add .claude-plugin hooks src tests/format.test.ts tsconfig.json
git commit -m "feat(mod): 清单、消息格式与评审规则"
```

---

### Task 9：mod 行为：拉起服务、工具、命令、规则、投递

**Files:**
- Create: `src/client.js`、`tests/register.test.ts`
- Modify: `hooks/register.js`（替换骨架）

**Interfaces:**
- Consumes：Task 8 的 `formatBatch`、`RULES`、`OPEN_TOOL`、`RESOLVE_TOOL`、`OPEN_SPEC`、`RESOLVE_SPEC`；服务的全部 JSON 接口。
- Produces：
  - `src/client.js`：`ensureServer($) → Promise<{port, token, pid}>`、`call($, method, path, body?, { start = true }?) → Promise<any>`、`messageOf(err) → string`。
  - 会话里可用：工具 `mcp__doc-review__review_open`、`mcp__doc-review__review_resolve`；命令 `/review <文件>`；系统提示节 `doc-review:rules`；每秒投递一次 outbox。

- [ ] **Step 1：写失败的测试** `tests/register.test.ts`

桩的写法：`$` 的操作类事件（`env.get`、`fs.*`、`http.fetch`、`process.run`、`session.*`）返回 `{ value }`；`prompt.submit`、`prompt.fill`、`session.start`、`prompt.compose` 直接返回结果。

```ts
import { expect, mock, test } from 'claude-code/testing'

const INFO = { port: 4823, token: 'tok', pid: 1 }
const PROC = { isStdoutTruncated: false, isStderrTruncated: false }

/** 把 mod 用到的引擎能力都答上；o 控制服务状态和 outbox 内容。*/
function stub(on: any, o: any = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-11T00:00:00Z') })
  const fetched: { method: string; path: string; body?: any }[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const spawned: string[][] = []
  let outbox = o.outbox ?? []

  on('env.get', () => ({ value: '/home/x' }))
  on('fs.exists', ($: any, e: any) => ({
    value: e.path.endsWith('server.json') ? o.hasInfo !== false : o.hasBinary !== false,
  }))
  on('fs.read', () => ({ value: JSON.stringify(INFO) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', () => ({ cwd: '/proj' }))
  on('process.run', ($: any, e: any) => {
    spawned.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', ...PROC } }
  })
  on('http.fetch', ($: any, e: any) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    fetched.push({ method, path: url.pathname + url.search, body })
    const reply = (status: number, data: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) },
    })
    if (url.pathname === '/api/health') return o.alive === false ? reply(503, {}) : reply(200, { name: 'doc-review' })
    if (url.pathname === '/api/open') {
      return body.path.endsWith('.txt')
        ? reply(400, { error: '只支持 .md、.markdown、.html、.htm 文件' })
        : reply(200, { doc: { id: 'd1' }, url: 'http://127.0.0.1:4823/review?doc=d1&t=tok' })
    }
    if (url.pathname === '/api/outbox') return reply(200, outbox)
    if (url.pathname === '/api/outbox/ack') {
      outbox = outbox.filter((b: any) => b.batch !== body.batch)
      return reply(200, { ok: true })
    }
    if (url.pathname === '/api/resolve') return reply(200, { resolved: body.items.length })
    return reply(404, { error: 'not stubbed' })
  })
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return o.dropSubmit ? { drop: '会话不接受' } : { text: e.text }
  })
  on('prompt.fill', ($: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  return { clock, fetched, submitted, filled, spawned }
}

async function boot($: any) {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/proj' })
}

async function tick(clock: any) {
  await clock.advance(1000)
  await clock.settle()
}

const BATCH = {
  batch: 'b_20261011_100500_ab12',
  doc: 'd1',
  path: '/proj/docs/plan.md',
  comments: [{ id: 'c_1', quote: '方案', body: '改成表格' }],
}

test('review_open 把相对路径补成绝对路径并登记到当前会话', async ($, on) => {
  const s = stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__doc-review__review_open', path: 'docs/plan.md' })
  expect(String(ran.result)).toContain('http://127.0.0.1:4823/review?doc=d1&t=tok')
  expect(s.fetched.find(f => f.path === '/api/open')?.body).toEqual({ path: '/proj/docs/plan.md', session: 'sess-1' })
})

test('review_open 失败时把服务端原因告诉模型', async ($, on) => {
  stub(on)
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__doc-review__review_open', path: 'a.txt' })
  expect(String(ran.deny)).toContain('只支持')
})

test('review_resolve 透传条目并报告数量', async ($, on) => {
  const s = stub(on)
  await boot($)
  const items = [{ id: 'c_1', note: '已改' }, { id: 'c_2', note: '没改：超出范围' }]
  const ran: any = await $.tool.call({ tool: 'mcp__doc-review__review_resolve', items })
  expect(String(ran.result)).toContain('2 条')
  expect(s.fetched.find(f => f.path === '/api/resolve')?.body).toEqual({ items })
})

test('服务没在跑就在后台启动它', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  const pending = $.tool.call({ tool: 'mcp__doc-review__review_open', path: 'docs/plan.md' })
  await s.clock.advance(4000)
  await pending
  const run = s.spawned.find(a => a[0] === '/bin/sh')
  expect(run?.[3].endsWith('/bin/doc-review-server')).toBe(true)
  expect(run?.[4]).toBe('/home/x/.claude/doc-review/server.log')
})

test('二进制没编译时提示先 make build', async ($, on) => {
  stub(on, { alive: false, hasBinary: false })
  await boot($)
  const ran: any = await $.tool.call({ tool: 'mcp__doc-review__review_open', path: 'docs/plan.md' })
  expect(String(ran.deny)).toContain('make build')
})

test('outbox 里的批次发进会话并确认送达，只发一次', async ($, on) => {
  const s = stub(on, { outbox: [BATCH] })
  await boot($)
  await tick(s.clock)
  await tick(s.clock)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toContain('[文档评审] docs/plan.md 有 1 条新评论')
  expect(s.fetched.filter(f => f.path === '/api/outbox/ack').length).toBe(1)
})

test('发不进会话时填进输入框', async ($, on) => {
  const s = stub(on, { outbox: [BATCH], dropSubmit: true })
  await boot($)
  await tick(s.clock)
  expect(s.filled.length).toBe(1)
  expect(s.filled[0]).toContain('[文档评审]')
})

test('服务没在跑时投递静默跳过，不去启动服务', async ($, on) => {
  const s = stub(on, { alive: false })
  await boot($)
  await tick(s.clock)
  expect(s.spawned.length).toBe(0)
  expect(s.submitted.length).toBe(0)
})

test('系统提示追加评审规则', async ($, on) => {
  stub(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  await boot($)
  const composed: any = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const rules = composed.sections.find((s: any) => s.id === 'doc-review:rules')
  expect(rules?.scope).toBe('session')
  expect(rules?.text).toContain('mcp__doc-review__review_open')
})
```

`$.prompt.compose` 的入参以 `.claude-plugin/types/claude-code/index.d.ts` 里的 `PromptComposeInput` 为准；类型检查报缺字段时按类型补齐，断言不变。

- [ ] **Step 2：运行确认失败**

Run: `claude plugin test .`
Expected: `register.test.ts` 失败（骨架没注册任何东西）

- [ ] **Step 3：实现** `src/client.js`

```js
// 找到或拉起本地评审服务，并带令牌调用它的接口。

/** @typedef {{ port: number, token: string, pid: number }} ServerInfo */

/** @param {any} $ */
async function dataDir($) {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('读不到 HOME 环境变量')
  return `${home}/.claude/doc-review`
}

/** @param {any} $ @returns {Promise<ServerInfo | undefined>} */
async function readInfo($) {
  const file = `${await dataDir($)}/server.json`
  if (!(await $.fs.exists(file))) return undefined
  try {
    return JSON.parse(/** @type {string} */ (await $.fs.read(file)))
  } catch {
    return undefined
  }
}

/** @param {any} $ @param {ServerInfo} info */
async function isAlive($, info) {
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${info.port}/api/health`)
    return r.ok && JSON.parse(r.text).name === 'doc-review'
  } catch {
    return false
  }
}

/**
 * 服务在跑就返回它的信息；不在跑就在后台启动（不随会话退出），最多等 3 秒。
 * 不用 $.process.spawn：它启动的进程会随 mod 卸载被杀掉。
 * @param {any} $
 * @returns {Promise<ServerInfo>}
 */
export async function ensureServer($) {
  let info = await readInfo($)
  if (info && (await isAlive($, info))) return info
  const bin = `${$.plugin.root}/bin/doc-review-server`
  if (!(await $.fs.exists(bin))) {
    throw new Error(`评审服务还没编译，请先在 ${$.plugin.root} 运行 make build`)
  }
  const log = `${await dataDir($)}/server.log`
  await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && nohup "$0" >>"$1" 2>&1 &', bin, log])
  for (let i = 0; i < 15; i++) {
    await $.clock.sleep(200)
    info = await readInfo($)
    if (info && (await isAlive($, info))) return info
  }
  throw new Error(`评审服务启动失败，日志：${log}`)
}

/**
 * @param {any} $
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ start?: boolean }} [opts] start 为 false 时服务不在就返回 undefined，不去启动
 */
export async function call($, method, path, body, { start = true } = {}) {
  let info
  if (start) {
    info = await ensureServer($)
  } else {
    info = await readInfo($)
    if (!info || !(await isAlive($, info))) return undefined
  }
  const r = await $.http.fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { 'X-Review-Token': info.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = r.text ? JSON.parse(r.text) : {}
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
  return data
}

/** @param {unknown} err */
export function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
```

- [ ] **Step 4：实现** `hooks/register.js`

```js
import { call, messageOf } from '../src/client.js'
import { formatBatch } from '../src/format.js'
import { OPEN_SPEC, OPEN_TOOL, RESOLVE_SPEC, RESOLVE_TOOL, RULES } from '../src/rules.js'

/** @type {import('claude-code').Register} */
export const register = on => {
  let isDelivering = false
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register(OPEN_SPEC)
    await $.tool.register(RESOLVE_SPEC)
    await $.command.register({
      name: 'review',
      description: '在右侧浏览器面板打开文档评审页',
      argumentHint: '<md 或 html 文件>',
    })
    $.clock.every(1000, () => void deliver($))
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'doc-review:rules', text: RULES, scope: 'session' }] }
  })

  on('tool.call', { tool: OPEN_TOOL }, async ($, e) => {
    try {
      const { url } = await openDoc($, String(e.path ?? ''))
      return {
        result: `评审页已就绪：${url}\n请用浏览器面板打开这个链接（preview_start 传 url；面板已打开时用 navigate）。用户发送评论后会自动以「[文档评审]」消息送达。`,
      }
    } catch (err) {
      return { deny: `review_open 失败：${messageOf(err)}` }
    }
  })

  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e) => {
    try {
      const items = Array.isArray(e.items) ? e.items : []
      const { resolved } = await call($, 'POST', '/api/resolve', { items })
      return { result: `已标记 ${resolved} 条评论为已解决，评审页会自动更新。` }
    } catch (err) {
      return { deny: `review_resolve 失败：${messageOf(err)}` }
    }
  })

  on('command.run', { command: 'review' }, async ($, e) => {
    const file = e.args.trim()
    if (!file) return { text: '用法：/review <md 或 html 文件>' }
    try {
      const { url } = await openDoc($, file)
      void $.prompt.submit({ text: `请在浏览器面板打开文档评审页：${url}` })
      return { text: `已登记 ${file}，正在打开评审页。` }
    } catch (err) {
      return { text: `打开失败：${messageOf(err)}` }
    }
  })

  /** 每秒一次：把本会话 outbox 里的批次发进会话。服务不在就跳过，不去启动它。*/
  async function deliver($) {
    if (isDelivering) return
    isDelivering = true
    try {
      const session = await $.session.id()
      const batches = await call($, 'GET', `/api/outbox?session=${encodeURIComponent(session)}`, undefined, { start: false })
      if (!batches) return
      const cwd = await $.session.cwd()
      for (const batch of batches) {
        await submitOrFill($, formatBatch(batch, cwd))
        await call($, 'POST', '/api/outbox/ack', { session, batch: batch.batch })
      }
      hasWarned = false
    } catch (err) {
      if (!hasWarned) {
        hasWarned = true
        $.ui.toast(`文档评审：${messageOf(err)}`)
      }
    } finally {
      isDelivering = false
    }
  }
}

/** 以用户身份发进会话；被拒或出错时退回填进输入框。*/
async function submitOrFill($, text) {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (r.drop === undefined) return
  } catch {
    // 落到下面的输入框兜底
  }
  await $.prompt.fill({ text, mode: 'append' })
  $.ui.toast('评审意见已填入输入框，按回车发送')
}

async function openDoc($, file) {
  if (!file) throw new Error('缺少文件路径')
  const path = file.startsWith('/') ? file : `${await $.session.cwd()}/${file}`
  return call($, 'POST', '/api/open', { path, session: await $.session.id() })
}
```

- [ ] **Step 5：运行确认通过**

Run: `claude plugin test . && claude plugin validate .`
Expected: 全部测试 pass；validate 列出 `session.start`、`prompt.compose`、`tool.call`×2、`command.run`，无错误。

某个桩的返回形状与本版本引擎不符时（测试报返回值形状不对），以 `.claude-plugin/types/claude-code/index.d.ts` 中对应事件的结果类型为准修正**桩**，不改断言。

- [ ] **Step 6：类型检查**

Run: `npx -y -p typescript@5 tsc -p .`
Expected: 无错误。`.claude-plugin/types/` 由引擎在首次加载 mod 后生成；还没生成时跳过，在 Task 10 安装后补跑。

- [ ] **Step 7：提交**

```bash
git add hooks/register.js src/client.js tests/register.test.ts
git commit -m "feat(mod): 拉起服务、评审工具、/review 命令与评论投递"
```

---

### Task 10：安装、端到端验证与 README

**Files:**
- Create: `README.md`
- Modify: `~/.claude/settings.json`（`env.CLAUDE_CODE_PLUGIN_DIRS`，**先向用户确认**）

- [ ] **Step 1：全量测试并构建**

Run: `make test && make build`
Expected: Go、node、mod 测试全部通过；`bin/doc-review-server` 存在。

- [ ] **Step 2：安装 mod（先向用户确认）**

把本目录追加到 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS`，与已有路径用 `:` 分隔：

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/other-plugin:/path/to/doc-review"
```

请用户新开一个桌面版会话使其生效。之后补跑 Task 9 Step 6 的类型检查。

- [ ] **Step 3：端到端验证（在新会话里）**

1. 让 Claude 写一份简短的 md 方案，确认它**自动**调用 `review_open` 并在浏览器面板打开评审页。
2. 在页面上划词写两条评论，点〔发送给 Claude〕。
3. 确认会话里**自动出现**「[文档评审] … 有 2 条新评论」的消息，Claude 开始修改。这是设计里风险最大的一环；如果消息进的是输入框而不是直接发出，记录下来，这属于预期内的兜底。
4. Claude 改完后，页面自动刷新，两条评论进入「已解决」并显示处理说明。
5. 用 HTML 文件重复 1～4。
6. `/review <某个已有 md>` 能手动打开评审页。

- [ ] **Step 4：写 README.md**

```markdown
# doc-review

在 Claude 桌面版右侧的浏览器面板里，对 Claude 生成的 md / HTML 划词评论；评论一键送进当前会话，Claude 改完后页面自动刷新，评论标记已解决并附处理说明。全部在本机运行。

## 安装

1. `make build`
2. 在 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS` 里加入本目录（多个目录用 `:` 分隔）
3. 新开一个会话

## 使用

- Claude 生成需要评审的 md / HTML 后会自动打开评审页；也可以用 `/review <文件>` 手动打开。
- 选中文字 →〔评论〕→ 回车保存；攒好后点底部〔发送给 Claude〕。
- 抽屉里能修改、删除草稿，查看已解决评论的处理说明。

## 组成

- `server/`：Go 本地服务（127.0.0.1:4823～4830），数据在 `~/.claude/doc-review/`
- `server/web/static/`：评审页前端，打包进二进制；第三方库在 `vendor/`
- `hooks/`、`src/`：Claude Code mod

## 开发

- `make test`：Go、前端、mod 全部测试
- 服务日志：`~/.claude/doc-review/server.log`
- 改了服务代码后先结束旧进程：`kill $(jq .pid ~/.claude/doc-review/server.json)`，再 `make build`，下次调用时 mod 会自动拉起新版本
```

- [ ] **Step 5：提交**

```bash
git add README.md
git commit -m "docs: README"
```
