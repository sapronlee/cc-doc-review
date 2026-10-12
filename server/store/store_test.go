package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
		"不支持的类型":  {strings.TrimSuffix(p, ".md") + ".txt", "s", ErrUnsupported},
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
	n, missing, err := s.Resolve([]ResolveItem{{ID: c1.ID, Note: "已改成表格"}, {ID: c2.ID, Note: "没改：原因……"}})
	if err != nil || n != 2 || len(missing) != 0 {
		t.Fatalf("resolve: %d %v %v", n, missing, err)
	}
	g1, _ := s.Get(d1.ID)
	if g1.Comments[0].Status != Resolved || g1.Comments[0].Resolution.Note != "已改成表格" {
		t.Fatalf("bad: %+v", g1.Comments[0])
	}
	if _, _, err := s.Resolve([]ResolveItem{{ID: "c_nope", Note: "x"}}); !errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), "未找到") {
		t.Fatalf("got %v", err)
	}
}

func TestResolvePartialReportsMissing(t *testing.T) {
	s, p := newStore(t)
	d, _ := s.Open(p, "s1")
	c, _ := s.AddComment(d.ID, NewComment{Quote: "正文", Body: "a"})
	s.Send(d.ID)
	n, missing, err := s.Resolve([]ResolveItem{{ID: "c_zz", Note: "x"}, {ID: c.ID, Note: "ok"}, {ID: "c_aa", Note: "y"}})
	if err != nil || n != 1 || strings.Join(missing, ",") != "c_aa,c_zz" {
		t.Fatalf("got %d %v %v", n, missing, err)
	}
	if g, _ := s.Get(d.ID); g.Comments[0].Status != Resolved {
		t.Fatalf("找得到的评论应照常标记：%+v", g.Comments[0])
	}
}

func TestSentinelErrorsAreChinese(t *testing.T) {
	if ErrNotFound.Error() != "未找到" || ErrInvalid.Error() != "参数不合法" {
		t.Fatalf("got %q %q", ErrNotFound, ErrInvalid)
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

func TestListBySessionSplitsDraftsAndSent(t *testing.T) {
	s, p := newStore(t)
	p2 := filepath.Join(filepath.Dir(p), "b.md")
	os.WriteFile(p2, []byte("b"), 0o644)
	clock := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	d1, _ := s.Open(p, "s1")
	d2, _ := s.Open(p2, "s1")
	s.AddComment(d1.ID, NewComment{Quote: "正文", Body: "a"})
	s.AddComment(d1.ID, NewComment{Quote: "标题", Body: "b"})
	clock = clock.Add(time.Minute)
	s.Send(d1.ID)
	clock = clock.Add(time.Minute)
	s.AddComment(d1.ID, NewComment{Quote: "正文", Body: "c"})

	list, err := s.ListBySession("s1")
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %+v %v", list, err)
	}
	byID := map[string]DocSummary{list[0].ID: list[0], list[1].ID: list[1]}
	a := byID[d1.ID]
	if a.Drafts != 1 || a.Sent != 2 || a.Open != 3 {
		t.Fatalf("草稿 1、处理中 2、未解决 3，得到 %+v", a)
	}
	if a.ActiveAt == nil || !a.ActiveAt.Equal(clock) {
		t.Fatalf("activeAt 应为最近一次评论变化 %v，得到 %v", clock, a.ActiveAt)
	}
	b := byID[d2.ID]
	if b.Drafts != 0 || b.Sent != 0 || b.Open != 0 || b.ActiveAt != nil {
		t.Fatalf("没有评论的文档：%+v", b)
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

func TestListBySessionReportsResolvedAndOpenedAt(t *testing.T) {
	s, p := newStore(t)
	p2 := filepath.Join(filepath.Dir(p), "b.md")
	os.WriteFile(p2, []byte("b"), 0o644)
	clock := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	d1, _ := s.Open(p, "s1")
	clock = clock.Add(time.Hour)
	d2, _ := s.Open(p2, "s1")
	c, _ := s.AddComment(d1.ID, NewComment{Quote: "正文", Body: "a"})
	s.Send(d1.ID)
	s.Resolve([]ResolveItem{{ID: c.ID, Note: "ok"}})

	list, err := s.ListBySession("s1")
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %+v %v", list, err)
	}
	byID := map[string]DocSummary{list[0].ID: list[0], list[1].ID: list[1]}
	if a := byID[d1.ID]; a.Resolved != 1 || a.Open != 0 || a.OpenedAt == nil || !a.OpenedAt.Equal(time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("已解决 1、登记于 9 点，得到 %+v", a)
	}
	if b := byID[d2.ID]; b.Resolved != 0 || b.Open != 0 || b.OpenedAt == nil || !b.OpenedAt.Equal(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("没有评论、登记于 10 点，得到 %+v", b)
	}
	// 再次登记会刷新登记时间
	clock = clock.Add(time.Hour)
	s.Open(p, "s1")
	list, _ = s.ListBySession("s1")
	for _, d := range list {
		if d.ID == d1.ID && !d.OpenedAt.Equal(clock) {
			t.Fatalf("再次登记后应为 11 点，得到 %v", d.OpenedAt)
		}
	}
}

func TestStateOfFollowsReviewLoop(t *testing.T) {
	s, p := newStore(t)
	clock := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	tick := func() { clock = clock.Add(time.Minute) }
	state := func() string {
		d, err := s.View(DocID(p))
		if err != nil {
			t.Fatal(err)
		}
		return d.State
	}
	d, _ := s.Open(p, "s1")
	if got := state(); got != StateReview {
		t.Fatalf("刚登记：%s", got)
	}
	tick()
	c, _ := s.AddComment(d.ID, NewComment{Quote: "正文", Body: "a"})
	if got := state(); got != StateDraft {
		t.Fatalf("写了评论：%s", got)
	}
	tick()
	s.Send(d.ID)
	if got := state(); got != StateProcessing {
		t.Fatalf("发送后：%s", got)
	}
	tick()
	s.Resolve([]ResolveItem{{ID: c.ID, Note: "ok"}})
	if got := state(); got != StateConfirm {
		t.Fatalf("处理完：%s", got)
	}
	tick()
	if _, err := s.Approve(d.ID); err != nil {
		t.Fatal(err)
	}
	if got := state(); got != StateApproved {
		t.Fatalf("通过后：%s", got)
	}
	// 通过后 Claude 又改了这篇并重新登记：回到待评审
	tick()
	s.Open(p, "s1")
	if got := state(); got != StateReview {
		t.Fatalf("通过后重新登记：%s", got)
	}
	// 待评审时也可以直接通过（没有意见）
	tick()
	if _, err := s.Approve(d.ID); err != nil || state() != StateApproved {
		t.Fatalf("待评审直接通过：%v %s", err, state())
	}
	// 通过后再评论、处理完：又变成待确认
	tick()
	c2, _ := s.AddComment(d.ID, NewComment{Quote: "正文", Body: "b"})
	s.Send(d.ID)
	tick()
	s.Resolve([]ResolveItem{{ID: c2.ID, Note: "ok"}})
	if got := state(); got != StateConfirm {
		t.Fatalf("通过后又一轮处理完：%s", got)
	}
}

func TestApproveRefusesWhenNotReady(t *testing.T) {
	s, p := newStore(t)
	d, _ := s.Open(p, "s1")
	s.AddComment(d.ID, NewComment{Quote: "正文", Body: "a"})
	if _, err := s.Approve(d.ID); !errors.Is(err, ErrNotReady) {
		t.Fatalf("有草稿时应拒绝：%v", err)
	}
	s.Send(d.ID)
	if _, err := s.Approve(d.ID); !errors.Is(err, ErrNotReady) {
		t.Fatalf("处理中时应拒绝：%v", err)
	}
}
