package store

import (
	"errors"
	"fmt"
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
	if err := s.DeleteComment(d.ID, "c_nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestGetUnknownDoc(t *testing.T) {
	s, _ := newStore(t)
	if _, err := s.Get("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestSentinelErrorsAreChinese(t *testing.T) {
	if ErrNotFound.Error() != "未找到" || ErrInvalid.Error() != "参数不合法" {
		t.Fatalf("got %q %q", ErrNotFound, ErrInvalid)
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

// replyStore 建两份同会话的文档 a.md、b.md，和一份别的会话的文档 c.md；时钟每次调用前进一分钟。
func replyStore(t *testing.T) (s *Store, a, b, c Doc, clock *time.Time) {
	t.Helper()
	s, p := newStore(t)
	dir := filepath.Dir(p)
	for _, n := range []string{"b.md", "c.md"} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644)
	}
	now := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	clock = &now
	s.now = func() time.Time { *clock = clock.Add(time.Minute); return *clock }
	a, _ = s.Open(p, "s1")
	b, _ = s.Open(filepath.Join(dir, "b.md"), "s1")
	c, _ = s.Open(filepath.Join(dir, "c.md"), "s2")
	return
}

func TestRepliesGroupedAndNumbered(t *testing.T) {
	s, a, b, c, _ := replyStore(t)
	b1, _ := s.AddComment(b.ID, NewComment{Quote: "B", Body: "b1"})
	a1, _ := s.AddComment(a.ID, NewComment{Quote: "A", Body: "a1"})
	b2, _ := s.AddComment(b.ID, NewComment{Quote: "B", Body: "b2"})
	s.AddComment(c.ID, NewComment{Quote: "C", Body: "别的会话"})

	groups, err := s.Replies("s1")
	if err != nil || len(groups) != 2 {
		t.Fatalf("groups: %+v %v", groups, err)
	}
	if groups[0].Doc != b.ID || groups[1].Doc != a.ID || groups[0].Kind != "md" || groups[0].Path != b.Path {
		t.Fatalf("组按组内最早一条排序，b 在前：%+v", groups)
	}
	got := []string{}
	for _, g := range groups {
		for _, r := range g.Replies {
			got = append(got, fmt.Sprintf("%d:%s", r.No, r.ID))
		}
	}
	want := []string{"1:" + b1.ID, "2:" + b2.ID, "3:" + a1.ID}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("编号：got %v want %v", got, want)
	}
	if other, _ := s.Replies("s3"); len(other) != 0 {
		t.Fatalf("没有回复的会话应为空：%+v", other)
	}
}

func TestMarkSentHidesReplies(t *testing.T) {
	s, a, _, _, _ := replyStore(t)
	r1, _ := s.AddComment(a.ID, NewComment{Quote: "A", Body: "1"})
	r2, _ := s.AddComment(a.ID, NewComment{Quote: "A", Body: "2"})
	n, missing, err := s.MarkSent([]string{r1.ID, "c_nope"})
	if err != nil || n != 1 || strings.Join(missing, ",") != "c_nope" {
		t.Fatalf("部分找不到：%d %v %v", n, missing, err)
	}
	groups, _ := s.Replies("s1")
	if len(groups) != 1 || len(groups[0].Replies) != 1 || groups[0].Replies[0].ID != r2.ID || groups[0].Replies[0].No != 1 {
		t.Fatalf("已发送的不再返回，剩下的重新编号：%+v", groups)
	}
	d, _ := s.Get(a.ID)
	if d.Comments[0].Status != Sent || d.Comments[0].SentAt == nil {
		t.Fatalf("文件里应为 sent：%+v", d.Comments[0])
	}
	if _, _, err := s.MarkSent([]string{r1.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("已发送过的再标记应返回 ErrNotFound：%v", err)
	}
	if err := s.DeleteComment(a.ID, r1.ID); !errors.Is(err, ErrNotDraft) {
		t.Fatalf("已发送的不能删：%v", err)
	}
}

func TestClearRepliesOnlyThisSession(t *testing.T) {
	s, a, b, c, _ := replyStore(t)
	s.AddComment(a.ID, NewComment{Quote: "A", Body: "1"})
	s.AddComment(b.ID, NewComment{Quote: "B", Body: "2"})
	sent, _ := s.AddComment(b.ID, NewComment{Quote: "B", Body: "3"})
	s.MarkSent([]string{sent.ID})
	s.AddComment(c.ID, NewComment{Quote: "C", Body: "4"})
	n, err := s.ClearReplies("s1")
	if err != nil || n != 2 {
		t.Fatalf("clear: %d %v", n, err)
	}
	if g, _ := s.Replies("s1"); len(g) != 0 {
		t.Fatalf("应清空：%+v", g)
	}
	if g, _ := s.Replies("s2"); len(g) != 1 {
		t.Fatalf("别的会话不动：%+v", g)
	}
	if d, _ := s.Get(b.ID); len(d.Comments) != 1 || d.Comments[0].Status != Sent {
		t.Fatalf("已发送的保留：%+v", d.Comments)
	}
	if _, err := s.ClearReplies("../x"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("非法会话：%v", err)
	}
}

func TestListBySessionPendingAndOrder(t *testing.T) {
	s, a, b, _, _ := replyStore(t)
	s.AddComment(a.ID, NewComment{Quote: "A", Body: "1"})
	s.AddComment(a.ID, NewComment{Quote: "A", Body: "2"})
	old := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	os.Chtimes(a.Path, old, old)
	os.Chtimes(b.Path, old, old)
	list, err := s.ListBySession("s1")
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %+v %v", list, err)
	}
	// 文件修改时间都很早时按登记时间：b 登记得晚，在前
	if list[0].ID != b.ID || list[1].ID != a.ID || list[1].Pending != 2 || list[0].Pending != 0 {
		t.Fatalf("顺序与待发送数：%+v", list)
	}
	if list[0].ModifiedAt == nil || !list[0].ModifiedAt.Equal(old) || list[0].Kind != "md" {
		t.Fatalf("modifiedAt：%+v", list[0])
	}
	// a 的文件刚被改过：排到前面
	future := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	os.Chtimes(a.Path, future, future)
	list, _ = s.ListBySession("s1")
	if list[0].ID != a.ID {
		t.Fatalf("最近改过的在前：%+v", list)
	}
	os.Remove(a.Path)
	list, _ = s.ListBySession("s1")
	for _, d := range list {
		if d.ID == a.ID && d.ModifiedAt != nil {
			t.Fatalf("文件不在时 modifiedAt 为空：%+v", d)
		}
	}
}

func TestMarkSeenBumpsRevision(t *testing.T) {
	s, a, _, _, clock := replyStore(t)
	r1, _ := s.Revision(a.ID)
	if err := s.MarkSeen(a.ID); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Get(a.ID)
	if d.SeenAt == nil || !d.SeenAt.Equal(*clock) || d.Revision != r1+1 {
		t.Fatalf("seenAt / revision：%+v", d)
	}
	if err := s.MarkSeen("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestLegacyFieldsSurviveRoundTrip(t *testing.T) {
	s, p := newStore(t)
	id := DocID(p)
	legacy := `{"id":"` + id + `","path":"` + p + `","kind":"md","session":"s1","revision":3,
"approvedAt":"2026-10-12T09:00:00Z",
"comments":[
 {"id":"c_old1","quote":"q","body":"b","status":"resolved","createdAt":"2026-10-12T08:00:00Z","sentAt":"2026-10-12T08:30:00Z","batch":"b_20261012_083000_abcd","resolution":{"note":"改好了","at":"2026-10-12T08:40:00Z"}},
 {"id":"c_old2","quote":"q","body":"还没发","status":"draft","createdAt":"2026-10-12T08:50:00Z","sentAt":null,"resolution":null}
]}`
	if err := os.WriteFile(filepath.Join(s.root, "docs", id+".json"), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	groups, err := s.Replies("s1")
	if err != nil || len(groups) != 1 || len(groups[0].Replies) != 1 || groups[0].Replies[0].ID != "c_old2" {
		t.Fatalf("旧草稿应作为待发送回复出现：%+v %v", groups, err)
	}
	if err := s.MarkSeen(id); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(s.root, "docs", id+".json"))
	for _, want := range []string{`"approvedAt": "2026-10-12T09:00:00Z"`, `"batch": "b_20261012_083000_abcd"`, `"note": "改好了"`, `"status": "resolved"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("写回后缺 %s：%s", want, raw)
		}
	}
}
