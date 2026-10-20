// Package store 保存登记的文档和回复，是数据目录的唯一写入者。
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
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound    = errors.New("未找到")
	ErrNotDraft    = errors.New("只有待发送的回复可以修改或删除")
	ErrUnsupported = errors.New("只支持 .md、.markdown、.html、.htm 文件")
	ErrInvalid     = errors.New("参数不合法")
)

// Status 是回复的状态：draft 为待发送，sent 为已发给 Claude；resolved 只出现在 0.2.0 的旧数据里。
type Status string

const (
	Draft    Status = "draft"
	Sent     Status = "sent"
	Resolved Status = "resolved"
)

// Resolution 是 0.2.0 的处理结果，只为读入旧数据后原样写回。
type Resolution struct {
	Note string    `json:"note"`
	At   time.Time `json:"at"`
}

type Comment struct {
	ID        string     `json:"id"`
	Quote     string     `json:"quote"`
	Prefix    string     `json:"prefix"`
	Suffix    string     `json:"suffix"`
	Body      string     `json:"body"`
	Status    Status     `json:"status"`
	CreatedAt time.Time  `json:"createdAt"`
	SentAt    *time.Time `json:"sentAt"`
	// Batch、Resolution 是 0.2.0 的旧字段，不再使用，只为原样写回。
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
	// OpenedAt 是最近一次登记（Open）的时间；旧数据没有这个字段。
	OpenedAt *time.Time `json:"openedAt,omitempty"`
	// SeenAt 是用户最近一次打开文档页的时间，没打开过时省略。
	SeenAt *time.Time `json:"seenAt,omitempty"`
	// ApprovedAt 是 0.2.0「通过」的时间，不再使用，只为原样写回。
	ApprovedAt *time.Time `json:"approvedAt,omitempty"`
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
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		return nil, err
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
	now := s.now()
	d.OpenedAt = &now
	return d, s.save(&d)
}

func (s *Store) Get(id string) (Doc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load(id)
}

func (s *Store) AddComment(docID string, in NewComment) (Comment, error) {
	if strings.TrimSpace(in.Quote) == "" || strings.TrimSpace(in.Body) == "" {
		return Comment{}, fmt.Errorf("%w：引用的原文和回复内容都不能为空", ErrInvalid)
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
	return nil, fmt.Errorf("%w：回复 %s", ErrNotFound, id)
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

// save 每次写入都递增 Revision，SSE 靠它发现回复变化。
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

// ReplyGroup 是一份文档里待发送的回复。
type ReplyGroup struct {
	Doc     string  `json:"doc"`
	Path    string  `json:"path"`
	Kind    string  `json:"kind"`
	Replies []Reply `json:"replies"`
}

// Reply 是一条待发送的回复；No 是本会话内从 1 起的全局编号。
type Reply struct {
	ID        string    `json:"id"`
	No        int       `json:"no"`
	Quote     string    `json:"quote"`
	Prefix    string    `json:"prefix"`
	Suffix    string    `json:"suffix"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

// Replies 取会话下所有文档里待发送的回复，按文档分组：组按组内最早一条排序，组内按加入时间排序，编号跨组连续。
func (s *Store) Replies(session string) ([]ReplyGroup, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	docs, err := s.allDocs()
	if err != nil {
		return nil, err
	}
	groups := []ReplyGroup{}
	for _, d := range docs {
		if d.Session != session {
			continue
		}
		g := ReplyGroup{Doc: d.ID, Path: d.Path, Kind: d.Kind}
		for _, c := range d.Comments {
			if c.Status == Draft {
				g.Replies = append(g.Replies, Reply{ID: c.ID, Quote: c.Quote, Prefix: c.Prefix, Suffix: c.Suffix, Body: c.Body, CreatedAt: c.CreatedAt})
			}
		}
		if len(g.Replies) == 0 {
			continue
		}
		sort.SliceStable(g.Replies, func(i, j int) bool { return g.Replies[i].CreatedAt.Before(g.Replies[j].CreatedAt) })
		groups = append(groups, g)
	}
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := groups[i].Replies[0].CreatedAt, groups[j].Replies[0].CreatedAt
		if a.Equal(b) {
			return groups[i].Path < groups[j].Path
		}
		return a.Before(b)
	})
	no := 0
	for gi := range groups {
		for ri := range groups[gi].Replies {
			no++
			groups[gi].Replies[ri].No = no
		}
	}
	return groups, nil
}

// MarkSent 把这些回复标为已发送，返回标记的条数和不再是待发送（或找不到）的 ID（已排序）。
// 一个都标不了时返回 ErrNotFound。
func (s *Store) MarkSent(ids []string) (int, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	total := len(want)
	docs, err := s.allDocs()
	if err != nil {
		return 0, nil, err
	}
	done := 0
	now := s.now()
	for _, d := range docs {
		changed := false
		for i := range d.Comments {
			c := &d.Comments[i]
			if !want[c.ID] || c.Status != Draft {
				continue
			}
			delete(want, c.ID)
			at := now
			c.Status, c.SentAt = Sent, &at
			changed = true
			done++
		}
		if changed {
			if err := s.save(&d); err != nil {
				return done, nil, err
			}
		}
	}
	missing := make([]string, 0, len(want))
	for id := range want {
		missing = append(missing, id)
	}
	sort.Strings(missing)
	if total > 0 && done == 0 {
		return 0, missing, fmt.Errorf("%w：回复 %s", ErrNotFound, strings.Join(missing, "、"))
	}
	return done, missing, nil
}

// ClearReplies 删掉会话下所有待发送的回复，返回删掉的条数。
func (s *Store) ClearReplies(session string) (int, error) {
	if !validSession.MatchString(session) {
		return 0, fmt.Errorf("%w：会话 ID 不合法", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	docs, err := s.allDocs()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, d := range docs {
		if d.Session != session {
			continue
		}
		kept := d.Comments[:0]
		for _, c := range d.Comments {
			if c.Status == Draft {
				n++
				continue
			}
			kept = append(kept, c)
		}
		if len(kept) == len(d.Comments) {
			continue
		}
		d.Comments = kept
		if err := s.save(&d); err != nil {
			return n, err
		}
	}
	return n, nil
}

// MarkSeen 记下用户打开文档页的时间，文档面板据此判断「新」。
func (s *Store) MarkSeen(docID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load(docID)
	if err != nil {
		return err
	}
	now := s.now()
	d.SeenAt = &now
	return s.save(&d)
}

// DocSummary 是文档面板里的一份文档。ModifiedAt 是文件修改时间（文件不在时省略），Pending 是待发送的回复数。
type DocSummary struct {
	ID         string     `json:"id"`
	Path       string     `json:"path"`
	Kind       string     `json:"kind"`
	OpenedAt   *time.Time `json:"openedAt,omitempty"`
	ModifiedAt *time.Time `json:"modifiedAt,omitempty"`
	SeenAt     *time.Time `json:"seenAt,omitempty"`
	Pending    int        `json:"pending"`
}

// ListBySession 列出会话登记过的文档，最近更新（文件修改或登记，取较晚的）的在前。
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
		sum := DocSummary{ID: d.ID, Path: d.Path, Kind: d.Kind, OpenedAt: d.OpenedAt, SeenAt: d.SeenAt}
		if st, err := os.Stat(d.Path); err == nil {
			mt := st.ModTime()
			sum.ModifiedAt = &mt
		}
		for _, c := range d.Comments {
			if c.Status == Draft {
				sum.Pending++
			}
		}
		out = append(out, sum)
	}
	latest := func(d DocSummary) time.Time {
		var t time.Time
		for _, at := range []*time.Time{d.ModifiedAt, d.OpenedAt} {
			if at != nil && at.After(t) {
				t = *at
			}
		}
		return t
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := latest(out[i]), latest(out[j])
		if a.Equal(b) {
			return out[i].Path < out[j].Path
		}
		return a.After(b)
	})
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
