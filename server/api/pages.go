package api

import (
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// 大小写不敏感的定位用正则：返回的偏移量直接对应原始字节，不会因 ToLower 改变长度而错位。
var (
	headOpen  = regexp.MustCompile(`(?i)<head\b[^>]*>`)
	bodyClose = regexp.MustCompile(`(?i)</body>`)
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
	_ = a.cfg.Store.MarkSeen(d.ID)
	status := http.StatusOK
	var page []byte
	if d.Kind == "md" {
		if page, err = fs.ReadFile(a.cfg.Static, "review.html"); err != nil {
			fail(w, err)
			return
		}
	} else if page, err = os.ReadFile(d.Path); err == nil {
		page = inject(page, d.ID)
	} else {
		// HTML 文件不在了：仍然注入脚本，文件恢复后 SSE 会触发刷新。
		status = http.StatusNotFound
		page = inject(missingPage(d.Path, r.URL.Query().Get("lang")), d.ID)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(page)
}

// missingPage 是 HTML 文件不在时的占位页，lang 为 zh 时用中文，其余用英文。
func missingPage(path, lang string) []byte {
	p := html.EscapeString(path)
	if lang == "zh" {
		return []byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>文件不存在</title></head>` +
			`<body><p>文件不存在或无法读取：` + p + `。文件恢复后页面会自动刷新。</p></body></html>`)
	}
	return []byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>File not found</title></head>` +
		`<body><p>File not found or unreadable: ` + p + `. The page refreshes when the file is back.</p></body></html>`)
}

// inject 给 HTML 加上 base（让相对路径资源走 /asset）和文档页脚本。
func inject(page []byte, docID string) []byte {
	base := []byte(`<base href="/asset/` + docID + `/">`)
	script := []byte(`<script type="module" src="/static/review.js" data-doc-review="html"></script>`)
	var out []byte
	if loc := headOpen.FindIndex(page); loc != nil {
		at := loc[1]
		out = append(append(append(out, page[:at]...), base...), page[at:]...)
	} else {
		out = append(append(out, base...), page...)
	}
	if locs := bodyClose.FindAllIndex(out, -1); len(locs) > 0 {
		at := locs[len(locs)-1][0]
		return append(append(append([]byte{}, out[:at]...), script...), out[at:]...)
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
	// md 文档页每次刷新内容都走这里：你正看着的文档，Claude 改了也不算「新」
	_ = a.cfg.Store.MarkSeen(d.ID)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// asset 提供 HTML 文档同目录下的资源，os.OpenRoot 保证不越出该目录。
// 只服务 HTML 文档，且不提供点开头的文件或目录（.env、.git 等）。
func (a *app) asset(w http.ResponseWriter, r *http.Request) {
	d, err := a.cfg.Store.Get(r.PathValue("doc"))
	if err != nil {
		fail(w, err)
		return
	}
	if d.Kind != "html" || hasDotSegment(r.PathValue("path")) {
		http.NotFound(w, r)
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

func hasDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// events 每 Poll 检查一次文件修改时间和回复版本，变化时推送 change 事件。
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
