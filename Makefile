.PHONY: build test run release-local

# 版本号取自 plugin.json，构建时注入到服务里（health 接口返回它）。
VERSION := $(shell sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' .claude-plugin/plugin.json | head -1)

build:
	cd server && go build -ldflags "-X main.version=$(VERSION)" -o ../bin/cc-doc-review-server .

test:
	cd server && go test ./... && go vet ./...
	node --test tests/web/
	claude plugin test .

run: build
	./bin/cc-doc-review-server

# 本地演练发布产物：四个平台的程序加 SHA256SUMS，输出到 dist/（与 GitHub Actions 的编译参数一致）。
release-local:
	rm -rf dist && mkdir -p dist
	cd server && for t in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do \
		CGO_ENABLED=0 GOOS=$${t%/*} GOARCH=$${t#*/} go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o ../dist/cc-doc-review-server-$${t%/*}-$${t#*/} . || exit 1; \
	done
	cd dist && shasum -a 256 cc-doc-review-server-* > SHA256SUMS
