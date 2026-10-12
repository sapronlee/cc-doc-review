// cc-doc-review-server 是本地文档评审服务：只监听本机，所有会话共用一个实例。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"docreview/api"
	"docreview/store"
	"docreview/web"
)

// version 默认为 dev，发布构建时用 -ldflags "-X main.version=<版本>" 注入。
var version = "dev"

const (
	defaultFrom = 4823
	defaultTo   = 4830
)

var errAlreadyRunning = errors.New("already running")

func main() {
	home, _ := os.UserHomeDir()
	dir := flag.String("dir", filepath.Join(home, ".claude", "cc-doc-review"), "数据目录")
	portFlag := flag.Int("port", 0, "监听端口；0 表示在 4823～4830 中自动选择")
	flag.Parse()

	st, err := store.New(*dir)
	if err != nil {
		log.Fatalf("初始化数据目录失败：%v", err)
	}
	from, to := portRange(*portFlag)
	ln, port, err := listen(from, to, isOurs)
	if errors.Is(err, errAlreadyRunning) {
		log.Printf("端口 %d 上已有 cc-doc-review 实例，退出", port)
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	token := randomToken()
	info, _ := json.Marshal(map[string]any{"port": port, "token": token, "pid": os.Getpid()})
	if err := os.WriteFile(filepath.Join(*dir, "server.json"), info, 0o600); err != nil {
		log.Fatalf("写入 server.json 失败：%v", err)
	}
	log.Printf("cc-doc-review %s 监听 127.0.0.1:%d", version, port)
	log.Fatal(http.Serve(ln, api.New(api.Config{
		Store: st, Token: token, Version: version, Static: web.FS,
		BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
	})))
}

// portRange 返回要尝试的端口范围：port 为 0 时用默认的 4823～4830，否则只用指定的那一个。
func portRange(port int) (from, to int) {
	if port == 0 {
		return defaultFrom, defaultTo
	}
	return port, port
}

// listen 依次尝试端口；端口被占用且占用者是 cc-doc-review 时返回 errAlreadyRunning。
func listen(from, to int, isOurs func(int) bool) (net.Listener, int, error) {
	for p := from; p <= to; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return ln, ln.Addr().(*net.TCPAddr).Port, nil
		}
		if isOurs(p) {
			return nil, p, errAlreadyRunning
		}
	}
	return nil, 0, fmt.Errorf("端口 %d～%d 都被占用", from, to)
}

func isOurs(port int) bool {
	c := http.Client{Timeout: 500 * time.Millisecond}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var v struct{ Name string }
	return json.NewDecoder(res.Body).Decode(&v) == nil && v.Name == "cc-doc-review"
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
