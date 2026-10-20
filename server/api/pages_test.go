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

func TestReviewShowsMissingPageForDeletedHTML(t *testing.T) {
	e := setup(t)
	p := filepath.Join(filepath.Dir(e.md), "gone<x>.html")
	os.WriteFile(p, []byte("<p>x</p>"), 0o644)
	d, _ := e.st.Open(p, "s1")
	os.Remove(p)
	code, body := call(t, e, "GET", "/review?doc="+d.ID+"&t=tok&lang=zh", "", nil)
	s := string(body)
	if code != 404 || !strings.Contains(s, "文件不存在或无法读取") || !strings.Contains(s, `data-doc-review="html"`) {
		t.Fatalf("应返回带脚本的提示页：%d %s", code, s)
	}
	if _, en := call(t, e, "GET", "/review?doc="+d.ID+"&t=tok", "", nil); !strings.Contains(string(en), "File not found") {
		t.Fatalf("不带 lang 时用英文：%s", en)
	}
	if strings.Contains(s, "gone<x>") || !strings.Contains(s, "gone&lt;x&gt;") {
		t.Fatalf("路径应转义：%s", s)
	}
}

func TestInjectHandlesHeadWithAttributes(t *testing.T) {
	got := string(inject([]byte(`<html><head lang="en"><title>t</title></head><body><header>h</header></body></html>`), "abc"))
	if !strings.Contains(got, `<head lang="en"><base href="/asset/abc/">`) {
		t.Fatalf("got %s", got)
	}
	got = string(inject([]byte(`<body><header>h</header></body>`), "abc"))
	if !strings.HasPrefix(got, `<base href="/asset/abc/">`) {
		t.Fatalf("<header> 不能当作 <head>：%s", got)
	}
}

func TestAssetOnlyForHTMLAndNoDotfiles(t *testing.T) {
	e := setup(t)
	dir := filepath.Dir(e.md)
	p := filepath.Join(dir, "page.html")
	os.WriteFile(p, []byte("<p>x</p>"), 0o644)
	os.WriteFile(filepath.Join(dir, "img.txt"), []byte("pixel"), 0o644)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=1"), 0o644)
	os.MkdirAll(filepath.Join(dir, ".git"), 0o755)
	os.WriteFile(filepath.Join(dir, ".git", "config"), []byte("x"), 0o644)
	md, _ := e.st.Open(e.md, "s1")
	if code, _ := call(t, e, "GET", "/asset/"+md.ID+"/img.txt", "", nil); code != 404 {
		t.Fatalf("md 文档不应提供 /asset，得到 %d", code)
	}
	d, _ := e.st.Open(p, "s1")
	for _, path := range []string{".env", ".git/config", "sub/.hidden"} {
		if code, _ := call(t, e, "GET", "/asset/"+d.ID+"/"+path, "", nil); code != 404 {
			t.Errorf("%s：点开头的路径段应 404，得到 %d", path, code)
		}
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

func TestInjectKeepsOffsetsWithNonASCIIBeforeTags(t *testing.T) {
	// U+0130 的小写字节长度与原字符不同，定位不能基于 ToLower 后的副本。
	got := string(inject([]byte("İ<HEAD><p>x</p></BODY>"), "abc"))
	want := "İ<HEAD><base href=\"/asset/abc/\"><p>x</p><script type=\"module\" src=\"/static/review.js\" data-doc-review=\"html\"></script></BODY>"
	if got != want {
		t.Fatalf("got %s", got)
	}
}

func TestReviewMarksSeen(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	if d.SeenAt != nil {
		t.Fatalf("刚登记不应有 seenAt")
	}
	call(t, e, "GET", "/review?doc="+d.ID+"&t=tok", "", nil)
	if got, _ := e.st.Get(d.ID); got.SeenAt == nil {
		t.Fatalf("打开文档页后应记下 seenAt")
	}
}

func TestRawMarksSeen(t *testing.T) {
	e := setup(t)
	d, _ := e.st.Open(e.md, "s1")
	call(t, e, "GET", "/raw?doc="+d.ID+"&t=tok", "", nil)
	if got, _ := e.st.Get(d.ID); got.SeenAt == nil {
		t.Fatalf("md 页面取内容时应记下 seenAt")
	}
}
