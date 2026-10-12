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
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound    = errors.New("未找到")
	ErrNotDraft    = errors.New("只有草稿可以修改或删除")
	ErrNoDrafts    = errors.New("没有待发送的评论")
	ErrUnsupported = errors.New("只支持 .md、.markdown、.html、.htm 文件")
	ErrInvalid     = errors.New("参数不合法")
	ErrNotReady    = errors.New("现在不能通过")
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
	// OpenedAt 是最近一次登记（Open）的时间；旧数据没有这个字段。
	OpenedAt *time.Time `json:"openedAt,omitempty"`
	// ApprovedAt 是最近一次「通过」的时间，没通过过时省略。
	ApprovedAt *time.Time `json:"approvedAt,omitempty"`
}

// 文档的评审状态（见 docs/superpowers/specs/2026-10-12-review-states-design.md）。
const (
	StateReview     = "review"     // 待评审：写完或改完，还没给结论
	StateDraft      = "draft"      // 未发送：有还没发给 Claude 的评论
	StateProcessing = "processing" // 处理中：评论已发给 Claude，还没处理完
	StateConfirm    = "confirm"    // 待确认：上次通过后有评论被解决，等核对
	StateApproved   = "approved"   // 已通过
)

// StateOf 按「未发送 → 处理中 → 已通过 → 待确认 → 待评审」的顺序判断文档状态，
// 同时给出最近一次变化（登记、评论新建 / 发送 / 解决、通过）的时间；什么都没有时为零值。
func StateOf(d Doc) (string, time.Time) {
	var changed time.Time
	later := func(t *time.Time) {
		if t != nil && t.After(changed) {
			changed = *t
		}
	}
	later(d.OpenedAt)
	later(d.ApprovedAt)
	drafts, sent := 0, 0
	var lastResolved *time.Time
	for _, c := range d.Comments {
		created := c.CreatedAt
		later(&created)
		later(c.SentAt)
		switch c.Status {
		case Draft:
			drafts++
		case Sent:
			sent++
		case Resolved:
			if at := resolvedAt(c); at != nil && (lastResolved == nil || at.After(*lastResolved)) {
				lastResolved = at
			}
		}
		later(resolvedAt(c))
	}
	after := func(a, b *time.Time) bool { return a != nil && (b == nil || a.After(*b)) }
	switch {
	case drafts > 0:
		return StateDraft, changed
	case sent > 0:
		return StateProcessing, changed
	case d.ApprovedAt != nil && !after(d.OpenedAt, d.ApprovedAt) && !after(lastResolved, d.ApprovedAt):
		return StateApproved, changed
	case after(lastResolved, d.ApprovedAt) && !after(d.OpenedAt, lastResolved):
		return StateConfirm, changed
	default:
		return StateReview, changed
	}
}

// DocView 是评审页读取的文档：文档本身加当前评审状态。
type DocView struct {
	Doc
	State string `json:"state"`
}

// View 读取文档并算出当前状态。
func (s *Store) View(id string) (DocView, error) {
	d, err := s.Get(id)
	if err != nil {
		return DocView{}, err
	}
	state, _ := StateOf(d)
	return DocView{Doc: d, State: state}, nil
}

// Approve 通过文档：只有待评审、待确认时可以；记录通过时间，并往文档所属会话的 outbox 写一条通过消息。
func (s *Store) Approve(docID string) (Batch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load(docID)
	if err != nil {
		return Batch{}, err
	}
	switch state, _ := StateOf(d); state {
	case StateDraft:
		return Batch{}, fmt.Errorf("%w：还有没发送的评论，先发给 Claude 或删掉", ErrNotReady)
	case StateProcessing:
		return Batch{}, fmt.Errorf("%w：Claude 还在处理评论", ErrNotReady)
	case StateApproved:
		return Batch{}, fmt.Errorf("%w：已经通过了", ErrNotReady)
	}
	now := s.now()
	d.ApprovedAt = &now
	b := Batch{
		Batch:    fmt.Sprintf("b_%s_%s", now.Format("20060102_150405"), randomID("")[:4]),
		Kind:     KindApprove,
		Doc:      d.ID,
		Path:     d.Path,
		Comments: []BatchComment{},
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

type BatchComment struct {
	ID    string `json:"id"`
	Quote string `json:"quote"`
	Body  string `json:"body"`
}

// KindApprove 是「通过」消息的批次类型；评论批次不带 kind。
const KindApprove = "approve"

type Batch struct {
	Batch    string         `json:"batch"`
	Kind     string         `json:"kind,omitempty"`
	Doc      string         `json:"doc"`
	Path     string         `json:"path"`
	Comments []BatchComment `json:"comments"`
}

type ResolveItem struct {
	ID   string `json:"id"`
	Note string `json:"note"`
}

// DocSummary 是文档的评论概况：Open 为未解决总数（= Drafts + Sent）。
// ActiveAt 是最近一次评论变化（新建、发送、解决）的时间，没有评论时省略。
type DocSummary struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Open     int    `json:"open"`
	Drafts   int    `json:"drafts"`
	Sent     int    `json:"sent"`
	Resolved int    `json:"resolved"`
	// State 是评审状态（review / draft / processing / confirm / approved），ChangedAt 是最近一次变化的时间。
	State     string     `json:"state"`
	ChangedAt *time.Time `json:"changedAt,omitempty"`
	ActiveAt  *time.Time `json:"activeAt,omitempty"`
	// OpenedAt 是最近一次登记的时间，旧数据没有时省略。
	OpenedAt *time.Time `json:"openedAt,omitempty"`
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

// Resolve 按评论 ID 跨文档标记已解决，返回标记的条数和找不到的 ID（已排序）。
// 只有一个都找不到时才返回 ErrNotFound；部分找不到时其余照常处理。
func (s *Store) Resolve(items []ResolveItem) (int, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := map[string]string{}
	for _, it := range items {
		want[it.ID] = it.Note
	}
	total := len(want)
	docs, err := s.allDocs()
	if err != nil {
		return 0, nil, err
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
				return done, nil, err
			}
		}
	}
	missing := make([]string, 0, len(want))
	for id := range want {
		missing = append(missing, id)
	}
	sort.Strings(missing)
	if total > 0 && len(missing) == total {
		return 0, missing, fmt.Errorf("%w：评论 %s", ErrNotFound, strings.Join(missing, "、"))
	}
	return done, missing, nil
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
		sum := DocSummary{ID: d.ID, Path: d.Path, OpenedAt: d.OpenedAt}
		for _, c := range d.Comments {
			switch c.Status {
			case Draft:
				sum.Drafts++
			case Sent:
				sum.Sent++
			case Resolved:
				sum.Resolved++
			}
			for _, at := range []*time.Time{&c.CreatedAt, c.SentAt, resolvedAt(c)} {
				if at != nil && (sum.ActiveAt == nil || at.After(*sum.ActiveAt)) {
					t := *at
					sum.ActiveAt = &t
				}
			}
		}
		sum.Open = sum.Drafts + sum.Sent
		state, changed := StateOf(d)
		sum.State = state
		if !changed.IsZero() {
			sum.ChangedAt = &changed
		}
		out = append(out, sum)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func resolvedAt(c Comment) *time.Time {
	if c.Resolution == nil {
		return nil
	}
	return &c.Resolution.At
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
