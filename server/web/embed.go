// Package web 打包评审页的前端资源。
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// FS 是 static 目录本身，路径不带 static/ 前缀。
var FS, _ = fs.Sub(files, "static")
