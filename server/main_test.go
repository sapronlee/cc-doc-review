package main

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
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

func TestPortRange(t *testing.T) {
	if from, to := portRange(0); from != 4823 || to != 4830 {
		t.Fatalf("默认应为 4823～4830，得到 %d～%d", from, to)
	}
	if from, to := portRange(4831); from != 4831 || to != 4831 {
		t.Fatalf("指定端口时只用该端口，得到 %d～%d", from, to)
	}
}

func TestSpecifiedPortOnlyTriesThatPort(t *testing.T) {
	p := occupy(t)
	from, to := portRange(p)
	if _, _, err := listen(from, to, func(int) bool { return false }); err == nil || errors.Is(err, errAlreadyRunning) {
		t.Fatalf("指定端口被占用时应报错且不换端口，得到 %v", err)
	}
}

func healthServer(t *testing.T, name string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"name": name})
	}))
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

func TestIsOursRecognizesName(t *testing.T) {
	if !isOurs(healthServer(t, "cc-doc-review")) {
		t.Fatal("应认出 cc-doc-review")
	}
	if isOurs(healthServer(t, "doc-review")) {
		t.Fatal("旧名 doc-review 不应被认作本服务")
	}
}
