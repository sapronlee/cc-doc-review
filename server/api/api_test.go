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

func TestReplyRoundTrip(t *testing.T) {
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

	var ids []string
	for _, b := range []string{"太短", "再展开"} {
		code, body = call(t, e, "POST", "/api/comments", "tok", map[string]string{"doc": id, "quote": "正文", "body": b})
		if code != 200 {
			t.Fatalf("add: %d %s", code, body)
		}
		ids = append(ids, decode[store.Comment](t, body).ID)
	}

	_, body = call(t, e, "GET", "/api/replies?session=s1", "tok", nil)
	got := decode[struct {
		Groups []store.ReplyGroup `json:"groups"`
		Total  int                `json:"total"`
	}](t, body)
	if got.Total != 2 || len(got.Groups) != 1 || got.Groups[0].Path != e.md || got.Groups[0].Replies[1].No != 2 {
		t.Fatalf("replies: %s", body)
	}
	if _, body := call(t, e, "GET", "/api/replies?session=other", "tok", nil); string(body) != `{"groups":[],"total":0}`+"\n" {
		t.Fatalf("别的会话应为空：%s", body)
	}

	_, body = call(t, e, "GET", "/api/docs?session=s1", "tok", nil)
	for _, want := range []string{`"pending":2`, `"modifiedAt":`, `"openedAt":`, `"kind":"md"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("文档列表缺 %s：%s", want, body)
		}
	}

	code, body = call(t, e, "POST", "/api/replies/sent", "tok", map[string]any{"ids": []string{ids[0], "c_nope"}})
	if code != 200 || string(body) != `{"missing":["c_nope"],"sent":1}`+"\n" {
		t.Fatalf("sent: %d %s", code, body)
	}
	if code, _ := call(t, e, "POST", "/api/replies/sent", "tok", map[string]any{"ids": []string{ids[0]}}); code != 404 {
		t.Fatalf("全部找不到应返回 404，得到 %d", code)
	}
	if code, _ := call(t, e, "POST", "/api/replies/sent", "tok", map[string]any{"ids": []string{}}); code != 400 {
		t.Fatalf("空 ids 应返回 400，得到 %d", code)
	}
	if code, _ := call(t, e, "DELETE", "/api/comments?doc="+id+"&id="+ids[0], "tok", nil); code != 409 {
		t.Fatalf("已发送的回复删除应返回 409，得到 %d", code)
	}

	_, body = call(t, e, "GET", "/api/doc?doc="+id, "tok", nil)
	if d := decode[store.Doc](t, body); len(d.Comments) != 1 || d.Comments[0].ID != ids[1] {
		t.Fatalf("文档只带待发送的回复：%s", body)
	}

	code, body = call(t, e, "DELETE", "/api/replies?session=s1", "tok", nil)
	if code != 200 || string(body) != `{"deleted":1}`+"\n" {
		t.Fatalf("clear: %d %s", code, body)
	}
	if code, _ := call(t, e, "DELETE", "/api/replies?session=../x", "tok", nil); code != 400 {
		t.Fatalf("非法会话应返回 400，得到 %d", code)
	}
	_, body = call(t, e, "GET", "/api/docs?session=s1", "tok", nil)
	if list := decode[[]store.DocSummary](t, body); len(list) != 1 || list[0].Pending != 0 {
		t.Fatalf("docs: %s", body)
	}
}

func TestRemovedRoutesAre404(t *testing.T) {
	e := setup(t)
	for _, r := range []struct{ method, path string }{
		{"POST", "/api/send"}, {"POST", "/api/approve"}, {"GET", "/api/outbox?session=s1"},
		{"POST", "/api/outbox/ack"}, {"POST", "/api/resolve"},
	} {
		if code, _ := call(t, e, r.method, r.path, "tok", map[string]string{}); code != 404 {
			t.Errorf("%s %s 应返回 404，得到 %d", r.method, r.path, code)
		}
	}
}

func TestReplyRoutesNeedToken(t *testing.T) {
	e := setup(t)
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/replies?session=s1"}, {"DELETE", "/api/replies?session=s1"}, {"POST", "/api/replies/sent"},
	} {
		if code, _ := call(t, e, r.method, r.path, "", map[string]any{"ids": []string{"x"}}); code != 401 {
			t.Errorf("%s %s 无令牌应返回 401，得到 %d", r.method, r.path, code)
		}
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
