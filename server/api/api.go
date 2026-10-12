// Package api 提供评审页和 mod 使用的 HTTP 接口。
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
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
	mux.HandleFunc("POST /api/approve", a.auth(a.approve))
	mux.HandleFunc("GET /api/outbox", a.auth(a.outbox))
	mux.HandleFunc("POST /api/outbox/ack", a.auth(a.ack))
	mux.HandleFunc("POST /api/resolve", a.auth(a.resolve))
	a.registerPages(mux)
	return checkHost(cfg.BaseURL, mux)
}

// checkHost 只放行 Host 为 BaseURL 端口上的 127.0.0.1 或 localhost 的请求，防 DNS 重绑定。
// BaseURL 为空或解析不出端口时一律拒绝。
func checkHost(baseURL string, next http.Handler) http.Handler {
	allowed := map[string]bool{}
	if u, err := url.Parse(baseURL); err == nil && u.Port() != "" {
		allowed["127.0.0.1:"+u.Port()] = true
		allowed["localhost:"+u.Port()] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[strings.ToLower(r.Host)] {
			writeErr(w, http.StatusForbidden, errors.New("不接受的 Host，请通过 127.0.0.1 访问"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// auth 校验请求头 X-Review-Token 或链接参数 t。
func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get("X-Review-Token")
		if tok == "" {
			tok = r.URL.Query().Get("t")
		}
		if a.cfg.Token == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(a.cfg.Token)) != 1 {
			writeErr(w, http.StatusUnauthorized, errors.New("令牌无效"))
			return
		}
		next(w, r)
	}
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"name": "cc-doc-review", "version": a.cfg.Version})
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
	d, err := a.cfg.Store.View(r.URL.Query().Get("doc"))
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

func (a *app) approve(w http.ResponseWriter, r *http.Request) {
	var in struct{ Doc string }
	if !readJSON(w, r, &in) {
		return
	}
	b, err := a.cfg.Store.Approve(in.Doc)
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
	n, missing, err := a.cfg.Store.Resolve(in.Items)
	if err != nil {
		fail(w, err)
		return
	}
	out := map[string]any{"resolved": n}
	if len(missing) > 0 {
		out["missing"] = missing
	}
	writeJSON(w, out)
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
	case errors.Is(err, store.ErrNotDraft), errors.Is(err, store.ErrNoDrafts), errors.Is(err, store.ErrNotReady):
		writeErr(w, http.StatusConflict, err)
	case errors.Is(err, store.ErrInvalid), errors.Is(err, store.ErrUnsupported):
		writeErr(w, http.StatusBadRequest, err)
	default:
		writeErr(w, http.StatusInternalServerError, err)
	}
}
