package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
)

const port = ":8080"

// ============================================================
// CONFIG HANDLERS
// ============================================================

func handleGetConfig(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile("config.json")
	if err != nil {
		http.Error(w, "config.json not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(data)
}

func handlePostConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}

	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate it's valid JSON before saving
	var check interface{}
	if err := json.Unmarshal(raw, &check); err != nil {
		http.Error(w, "invalid JSON structure", http.StatusBadRequest)
		return
	}

	pretty, _ := json.MarshalIndent(check, "", "  ")
	if err := os.WriteFile("config.json", pretty, 0644); err != nil {
		http.Error(w, "cannot save config.json", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"ok":true}`)
}

// ============================================================
// GENERATE HANDLER
// ============================================================

func handleGenerate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}

	seedStr := r.URL.Query().Get("seed")
	seed := int64(-1)
	if seedStr != "" {
		if s, err := strconv.ParseInt(seedStr, 10, 64); err == nil {
			seed = s
		}
	}

	args := []string{"run", "galaxy_gen.go", "-config", "config.json", "-out", "galaxy.json"}
	if seed >= 0 {
		args = append(args, "-seed", strconv.FormatInt(seed, 10))
	}

	cmd := exec.Command("go", args...)
	cmd.Dir = "."
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("generate error: %v\n%s", err, out)
		http.Error(w, fmt.Sprintf("generation failed: %s", out), http.StatusInternalServerError)
		return
	}

	log.Printf("Generated galaxy: %s", out)

	data, err := os.ReadFile("galaxy.json")
	if err != nil {
		http.Error(w, "galaxy.json not found after generation", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

// ============================================================
// STATIC FILES
// ============================================================

func handleStatic(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path == "/" {
		path = "/galaxy.html"
	}

	// Only serve known files for security
	allowed := map[string]string{
		"/galaxy.html": "text/html; charset=utf-8",
		"/config.html": "text/html; charset=utf-8",
		"/galaxy.json": "application/json",
		"/config.json": "application/json",
	}

	ct, ok := allowed[path]
	if !ok {
		http.NotFound(w, r)
		return
	}

	data, err := os.ReadFile("." + path)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

// ============================================================
// MAIN
// ============================================================

func main() {
	// Static files
	http.HandleFunc("/", handleStatic)

	// API
	http.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleGetConfig(w, r)
		case http.MethodPost, http.MethodOptions:
			handlePostConfig(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/generate", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodOptions:
			handleGenerate(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	fmt.Printf("OUROBOROS server running on http://localhost%s\n", port)
	fmt.Println("  galaxy.html → main simulation")
	fmt.Println("  config.html → settings editor")
	log.Fatal(http.ListenAndServe(port, nil))
}
