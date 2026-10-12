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
	srv := serve(t, Config{Store: st, Token: "tok", Static: static, Version: "test", Poll: 20 * time.Millisecond})
	return env{srv, st, md}
}

// serve 先拿到监听地址，再以它为 BaseURL 构建处理器，这样 Host 校验和真实运行时一致。
func serve(t *testing.T, cfg Config) *httptest.Server {
	t.Helper()
	var h http.Handler
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.ServeHTTP(w, r) }))
	cfg.BaseURL = "http://" + srv.Listener.Addr().String()
	h = New(cfg)
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
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
	if code != 200 || decode[map[string]string](t, body)["name"] != "cc-doc-review" {
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
	if opened.URL != e.srv.URL+"/review?doc="+opened.Doc.ID+"&t=tok" {
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

	_, body = call(t, e, "GET", "/api/docs?session=s1", "tok", nil)
	for _, want := range []string{`"drafts":0,"sent":1,"resolved":0,"state":"processing"`, `"changedAt":`, `"activeAt":`, `"openedAt":`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("文档列表应带各类条数、状态和时间（缺 %s）：%s", want, body)
		}
	}

	code, body = call(t, e, "POST", "/api/resolve", "tok", map[string]any{"items": []map[string]string{{"id": c.ID, "note": "已展开"}}})
	if code != 200 || string(body) != `{"resolved":1}`+"\n" {
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

func TestQueryTokenAccepted(t *testing.T) {
	e := setup(t)
	if code, body := call(t, e, "GET", "/api/doc?doc=nope&t=tok", "", nil); code != 404 {
		t.Fatalf("查询参数令牌应通过校验并返回 404，得到 %d %s", code, body)
	}
}

func TestEmptyConfiguredTokenRejectsAll(t *testing.T) {
	st, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := env{srv: serve(t, Config{Store: st, Token: "", Poll: 20 * time.Millisecond}), st: st}
	code, body := call(t, e, "POST", "/api/open", "", map[string]string{"path": "/x.md", "session": "s1"})
	if code != 401 {
		t.Fatalf("令牌未配置时无令牌请求应返回 401，得到 %d %s", code, body)
	}
	if code, _ := call(t, e, "GET", "/api/doc?doc=nope&t=", "", nil); code != 401 {
		t.Fatalf("令牌未配置时空查询令牌应返回 401，得到 %d", code)
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

func TestResolvePartialAndAllMissing(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	c, _ := e.st.AddComment(d.ID, store.NewComment{Quote: "正文", Body: "x"})
	e.st.Send(d.ID)
	items := []map[string]string{{"id": c.ID, "note": "ok"}, {"id": "c_nope", "note": "x"}}
	code, body := call(t, e, "POST", "/api/resolve", "tok", map[string]any{"items": items})
	got := decode[struct {
		Resolved int      `json:"resolved"`
		Missing  []string `json:"missing"`
	}](t, body)
	if code != 200 || got.Resolved != 1 || len(got.Missing) != 1 || got.Missing[0] != "c_nope" {
		t.Fatalf("部分找不到应返回 200 和 missing：%d %s", code, body)
	}
	code, body = call(t, e, "POST", "/api/resolve", "tok", map[string]any{"items": []map[string]string{{"id": "c_nope", "note": "x"}}})
	if code != 404 || !strings.Contains(string(body), "c_nope") {
		t.Fatalf("全部找不到应返回 404：%d %s", code, body)
	}
}

func TestRejectsForeignHost(t *testing.T) {
	e := setup(t)
	port := e.srv.URL[strings.LastIndex(e.srv.URL, ":")+1:]
	for host, want := range map[string]int{
		"127.0.0.1:" + port:    200,
		"localhost:" + port:    200,
		"LOCALHOST:" + port:    200,
		"evil.example:" + port: 403,
		"127.0.0.1:1":          403,
	} {
		req, _ := http.NewRequest("GET", e.srv.URL+"/api/health", nil)
		req.Host = host
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("Host %q: got %d, want %d", host, res.StatusCode, want)
		}
	}
}

func TestApproveOnlyWhenReadyAndWritesOutbox(t *testing.T) {
	e := setup(t)
	_, body := call(t, e, "POST", "/api/open", "tok", map[string]string{"path": e.md, "session": "s1"})
	doc := decode[struct {
		Doc store.Doc `json:"doc"`
	}](t, body).Doc

	_, body = call(t, e, "GET", "/api/doc?doc="+doc.ID, "tok", nil)
	if !strings.Contains(string(body), `"state":"review"`) {
		t.Fatalf("刚登记应为待评审：%s", body)
	}
	call(t, e, "POST", "/api/comments", "tok", map[string]string{"doc": doc.ID, "quote": "正文", "body": "改一下"})
	if code, body := call(t, e, "POST", "/api/approve", "tok", map[string]string{"doc": doc.ID}); code != 409 || !strings.Contains(string(body), "没发送") {
		t.Fatalf("有未发送评论时不能通过：%d %s", code, body)
	}
	_, body = call(t, e, "POST", "/api/send", "tok", map[string]string{"doc": doc.ID})
	batch := decode[store.Batch](t, body)
	call(t, e, "POST", "/api/outbox/ack", "tok", map[string]string{"session": "s1", "batch": batch.Batch})
	call(t, e, "POST", "/api/resolve", "tok", map[string]any{"items": []map[string]string{{"id": batch.Comments[0].ID, "note": "改好了"}}})
	_, body = call(t, e, "GET", "/api/doc?doc="+doc.ID, "tok", nil)
	if !strings.Contains(string(body), `"state":"confirm"`) {
		t.Fatalf("处理完应为待确认：%s", body)
	}
	code, body := call(t, e, "POST", "/api/approve", "tok", map[string]string{"doc": doc.ID})
	if code != 200 || !strings.Contains(string(body), `"kind":"approve"`) {
		t.Fatalf("approve: %d %s", code, body)
	}
	_, body = call(t, e, "GET", "/api/outbox?session=s1", "tok", nil)
	if got := decode[[]store.Batch](t, body); len(got) != 1 || got[0].Kind != store.KindApprove || got[0].Doc != doc.ID {
		t.Fatalf("outbox 应有一条通过消息：%s", body)
	}
	if code, _ := call(t, e, "POST", "/api/approve", "tok", map[string]string{"doc": doc.ID}); code != 409 {
		t.Fatalf("重复通过应被拒绝：%d", code)
	}
}
