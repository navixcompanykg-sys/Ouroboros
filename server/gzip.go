package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
)

// Сжатие ответов. Полный состав сектора — около 220 КБ JSON, и клиент
// перезабирает его при рассинхроне (сильное ускорение времени вытесняет
// события из буфера быстрее, чем клиент успевает их применить). По Wi-Fi
// на телефон это заметно, а JSON жмётся в разы.

type gzipWriter struct {
	http.ResponseWriter
	w io.Writer
}

func (g gzipWriter) Write(b []byte) (int, error) { return g.w.Write(b) }

func withGzip(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.ServeHTTP(w, r)
			return
		}
		// поток событий не сжимаем: gzip буферизует, а SSE должен уходить сразу
		if strings.HasPrefix(r.URL.Path, "/api/events") {
			h.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		h.ServeHTTP(gzipWriter{ResponseWriter: w, w: gz}, r)
	})
}
