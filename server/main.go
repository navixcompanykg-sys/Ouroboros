package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const port = ":8080"
const registryFile = "star_registry.json"
const maxDeadRecords = 5000

// trimDeadRecords keeps all alive stars + the newest maxDeadRecords dead ones.
func trimDeadRecords(records []map[string]interface{}) []map[string]interface{} {
	var alive, dead []map[string]interface{}
	for _, rec := range records {
		if rec["death_tick"] == nil {
			alive = append(alive, rec)
		} else {
			dead = append(dead, rec)
		}
	}
	if len(dead) <= maxDeadRecords {
		return records
	}
	sort.Slice(dead, func(i, j int) bool {
		ti, _ := dead[i]["death_tick"].(float64)
		tj, _ := dead[j]["death_tick"].(float64)
		return ti > tj
	})
	return append(alive, dead[:maxDeadRecords]...)
}

var registryMu sync.Mutex

// In-memory registry — все операции с реестром работают с этими структурами.
// Файл используется только для персистентности (загрузка при старте, запись при изменениях).
var regRecords []map[string]interface{}
var regByID = map[int]map[string]interface{}{}

func recID(rec map[string]interface{}) int {
	if v, ok := rec["star_id"].(float64); ok {
		return int(v)
	}
	return -1
}

func rebuildIndex() {
	regByID = make(map[int]map[string]interface{}, len(regRecords))
	for _, rec := range regRecords {
		if id := recID(rec); id >= 0 {
			regByID[id] = rec
		}
	}
}

var regDirty bool // true = файл устарел относительно памяти

func saveRegistryLocked() {
	out, _ := json.Marshal(regRecords)
	os.WriteFile(registryFile, out, 0644)
	regDirty = false
}

// startRegistrySaver запускает фоновый горутин, пишущий файл раз в 2с если есть несохранённые изменения.
// Вызывать один раз из main(). Благодаря этому birth-запросы не блокируются файловым I/O.
func startRegistrySaver() {
	go func() {
		for range time.Tick(2 * time.Second) {
			registryMu.Lock()
			if regDirty {
				saveRegistryLocked()
			}
			registryMu.Unlock()
		}
	}()
}

func loadRegistryIntoMemory() {
	registryMu.Lock()
	defer registryMu.Unlock()
	data, err := os.ReadFile(registryFile)
	if err != nil || len(data) == 0 {
		regRecords = nil
		regByID = map[int]map[string]interface{}{}
		return
	}
	json.Unmarshal(data, &regRecords)
	rebuildIndex()
}

// ============================================================
// SSE HUB
// ============================================================

type sseHub struct {
	mu      sync.RWMutex
	clients map[chan string]struct{}
}

var hub = &sseHub{clients: make(map[chan string]struct{})}

func (h *sseHub) subscribe() chan string {
	ch := make(chan string, 64)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *sseHub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
	close(ch)
}

func (h *sseHub) broadcast(msg string) {
	h.mu.RLock()
	for ch := range h.clients {
		select {
		case ch <- msg:
		default:
		}
	}
	h.mu.RUnlock()
}

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
		"/galaxy.html":   "text/html; charset=utf-8",
		"/config.html":   "text/html; charset=utf-8",
		"/registry.html": "text/html; charset=utf-8",
		"/prices.html":   "text/html; charset=utf-8",
		"/galaxy.json":   "application/json",
		"/config.json":   "application/json",
		"/prices.json":   "application/json",
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
// REGISTRY HANDLERS
// ============================================================

func handleRegistryGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	registryMu.Lock()
	out, _ := json.Marshal(regRecords)
	registryMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Write(out)
}

func handleRegistryBirth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	var rec map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	registryMu.Lock()
	regRecords = append(regRecords, rec)
	if id := recID(rec); id >= 0 {
		regByID[id] = rec
	}
	regDirty = true // файл запишет фоновый тикер
	registryMu.Unlock()
	if b, err := json.Marshal(rec); err == nil {
		hub.broadcast("event: birth\ndata: " + string(b) + "\n\n")
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"ok":true}`)
}

func handleRegistryBirthBatch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	var newRecs []map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&newRecs); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	registryMu.Lock()
	regRecords = append(regRecords, newRecs...)
	for _, rec := range newRecs {
		if id := recID(rec); id >= 0 {
			regByID[id] = rec
		}
	}
	regDirty = true
	registryMu.Unlock()
	for _, rec := range newRecs {
		if b, err := json.Marshal(rec); err == nil {
			hub.broadcast("event: birth\ndata: " + string(b) + "\n\n")
		}
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"ok":true,"count":%d}`, len(newRecs))
}

func handleRegistryDeath(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	var patch map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	sid := -1
	if v, ok := patch["star_id"].(float64); ok {
		sid = int(v)
	}
	registryMu.Lock()
	if sid >= 0 {
		if rec, ok := regByID[sid]; ok {
			for k, v := range patch {
				rec[k] = v
			}
		}
	}
	regRecords = trimDeadRecords(regRecords)
	rebuildIndex()
	saveRegistryLocked() // смерть — пишем сразу (важно для персистентности)
	registryMu.Unlock()
	if b, err := json.Marshal(patch); err == nil {
		hub.broadcast("event: death\ndata: " + string(b) + "\n\n")
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"ok":true}`)
}

func handleRegistryReset(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	registryMu.Lock()
	regRecords = nil
	regByID = map[int]map[string]interface{}{}
	os.WriteFile(registryFile, []byte("[]"), 0644)
	registryMu.Unlock()
	hub.broadcast("event: reset\ndata: {}\n\n")
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"ok":true}`)
}

func handleRegistryStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	registryMu.Lock()
	records := make([]map[string]interface{}, len(regRecords))
	copy(records, regRecords)
	registryMu.Unlock()

	alive, dead := 0, 0
	planetsSum, planetsCount := 0, 0
	noP, highP, ring1, ring2 := 0, 0, 0, 0
	byType := map[string]map[string]int{}
	byEvent := map[string]int{}
	byCause := map[string]int{}

	for _, rec := range records {
		isAlive := rec["death_tick"] == nil
		if isAlive {
			alive++
		} else {
			dead++
		}
		if np, ok := rec["n_planets"].(float64); ok {
			n := int(np)
			planetsSum += n
			planetsCount++
			if n == 0 {
				noP++
			}
			if n >= 10 {
				highP++
			}
		}
		if nr, ok := rec["n_rings"].(float64); ok {
			n := int(nr)
			if n == 1 {
				ring1++
			}
			if n == 2 {
				ring2++
			}
		}
		if st, ok := rec["birth_star_type"].(string); ok {
			if byType[st] == nil {
				byType[st] = map[string]int{"alive": 0, "dead": 0}
			}
			if isAlive {
				byType[st]["alive"]++
			} else {
				byType[st]["dead"]++
			}
		}
		ev := fmt.Sprintf("%v", rec["birth_event"])
		byEvent[ev]++
		if !isAlive {
			if cause, ok := rec["death_cause"].(string); ok {
				byCause[cause]++
			}
		}
	}

	avg := 0.0
	if planetsCount > 0 {
		avg = math.Round(float64(planetsSum)/float64(planetsCount)*10) / 10
	}

	stats := map[string]interface{}{
		"total_registered":    len(records),
		"total_alive":         alive,
		"total_dead":          dead,
		"avg_planets":         avg,
		"stars_no_planets":    noP,
		"stars_10_12_planets": highP,
		"stars_1_ring":        ring1,
		"stars_2_rings":       ring2,
		"by_type":             byType,
		"by_birth_event":      byEvent,
		"deaths_by_cause":     byCause,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

func handleRegistryStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	registryMu.Lock()
	initData, _ := json.Marshal(regRecords)
	registryMu.Unlock()
	fmt.Fprintf(w, "event: init\ndata: %s\n\n", initData)
	flusher.Flush()

	ch := hub.subscribe()
	defer hub.unsubscribe(ch)

	for {
		select {
		case msg := <-ch:
			fmt.Fprint(w, msg)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

// ============================================================
// SCAN HANDLER
// ============================================================

func handleScan(w http.ResponseWriter, r *http.Request) {
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

	if err := os.MkdirAll("scans", 0755); err != nil {
		http.Error(w, "cannot create scans dir", http.StatusInternalServerError)
		return
	}

	var meta struct {
		Tick int `json:"tick"`
	}
	json.Unmarshal(raw, &meta)

	ts := time.Now().Format("20060102_150405")
	fname := fmt.Sprintf("scan_%s_tick%04d.json", ts, meta.Tick)
	fpath := filepath.Join("scans", fname)

	pretty, _ := json.MarshalIndent(raw, "", "  ")
	if err := os.WriteFile(fpath, pretty, 0644); err != nil {
		http.Error(w, "cannot write scan file", http.StatusInternalServerError)
		return
	}

	log.Printf("Galaxy scan saved: %s", fpath)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "file": fname})
}

// ============================================================
// SYSTEM VIEW
// ============================================================

var orbitPeriods = []int{
	7200, 9000, 11200, 14000, 17400, 21700, 27000, 33600, 41800, 52000, 64700, 80600,
	100400, 125000, 155600, 193700, 241200, 300300, 373900, 465700, 579800, 721900, 898700, 1118900,
	1393000, 1734300, 2159200, 2688200, 3346800, 4166800, 5187700, 6458700, 8041100, 10011200, 12464000, 15517700,
}

type PlanetInfo struct {
	Slot       int    `json:"slot"`
	OrbitIndex int    `json:"orbit_index"`
	Type       string `json:"type"`
	VisualType string `json:"visual_type"`
	PeriodSec  int    `json:"period_sec"`
}

type RingInfo struct {
	RingIndex int `json:"ring_index"`
	OrbitGrid int `json:"orbit_grid"`
}

func genCodeToSeed(code string) int64 {
	n := int64(0)
	for _, c := range code {
		if c >= '0' && c <= '9' {
			n = n*10 + int64(c-'0')
		}
	}
	return n
}

func planetTypeFromSlot(slot int) string {
	switch {
	case slot <= 8:
		return "lava"
	case slot <= 17:
		return "rocky"
	case slot <= 26:
		return "ice"
	default:
		return "gas_giant"
	}
}

func assignPlanetOrbits(nPlanets int, seed int64) []int {
	if nPlanets <= 0 {
		return nil
	}
	slots := make([]int, 36)
	for i := range slots {
		slots[i] = i
	}
	// Fisher-Yates shuffle via LCG
	for i := 35; i > 0; i-- {
		seed = (seed*1664525 + 1013904223) & 0x7fffffff
		j := int(seed % int64(i+1))
		slots[i], slots[j] = slots[j], slots[i]
	}
	// Greedy pick: minimum 2 free orbits between any two planets (gap >= 3 slots)
	// With 36 slots this allows up to 12 planets (0,3,6,...,33) — maximum preserved.
	taken := make(map[int]bool)
	result := make([]int, 0, nPlanets)
	for _, s := range slots {
		if len(result) >= nPlanets {
			break
		}
		if !taken[s-2] && !taken[s-1] && !taken[s+1] && !taken[s+2] {
			taken[s] = true
			result = append(result, s)
		}
	}
	sort.Ints(result)
	return result
}

func handleSystemGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	idStr := strings.TrimPrefix(r.URL.Path, "/system/")
	starID, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid star id", http.StatusBadRequest)
		return
	}

	registryMu.Lock()
	found, inIndex := regByID[starID]
	var rec map[string]interface{}
	if inIndex {
		// Копируем нужные поля под локом — без гонок при последующем чтении
		rec = map[string]interface{}{
			"gen_code":        found["gen_code"],
			"n_planets":       found["n_planets"],
			"n_rings":         found["n_rings"],
			"birth_star_type": found["birth_star_type"],
			"birth_mass":      found["birth_mass"],
		}
	}
	registryMu.Unlock()

	if rec == nil {
		// Запись не найдена (возможно, удалена прунингом после старой трансформации WD).
		// Генерируем синтетическую запись детерминированно из ID и query-параметров.
		qMass, _ := strconv.Atoi(r.URL.Query().Get("mass"))
		if qMass <= 0 {
			qMass = 50
		}
		qType := r.URL.Query().Get("type")
		if qType == "" {
			qType = "white_dwarf"
		}
		lcg := func(s int64) int64 { return (s*1664525 + 1013904223) & 0x7fffffff }
		s := lcg(int64(starID))
		gc := fmt.Sprintf("%09d", s%1000000000)
		s = lcg(s)
		nP := int(s%7) + 1
		s = lcg(s)
		nR := int(s % 3)
		rec = map[string]interface{}{
			"star_id":         float64(starID),
			"gen_code":        gc,
			"n_planets":       float64(nP),
			"n_rings":         float64(nR),
			"birth_star_type": qType,
			"birth_mass":      float64(qMass),
		}
	}

	genCode, _ := rec["gen_code"].(string)
	nPlanets := int(rec["n_planets"].(float64))
	nRings := int(rec["n_rings"].(float64))
	starType, _ := rec["birth_star_type"].(string)
	mass := int(rec["birth_mass"].(float64))

	seed := int64(starID)*1000003 + genCodeToSeed(genCode)
	slots := assignPlanetOrbits(nPlanets, seed)

	planets := make([]PlanetInfo, len(slots))
	for i, slot := range slots {
		pt := planetTypeFromSlot(slot)
		planets[i] = PlanetInfo{
			Slot:       slot + 1,
			OrbitIndex: slot,
			Type:       pt,
			VisualType: pt,
			PeriodSec:  orbitPeriods[slot],
		}
	}

	// Build candidate ring positions in the largest gaps between planets
	type gapInfo struct{ mid, size int }
	var gaps []gapInfo
	if len(slots) == 0 {
		gaps = []gapInfo{{10, 36}, {22, 36}, {30, 36}}
	} else {
		if slots[0] >= 4 {
			gaps = append(gaps, gapInfo{slots[0] / 2, slots[0]})
		}
		for i := 1; i < len(slots); i++ {
			g := slots[i] - slots[i-1]
			if g >= 4 {
				gaps = append(gaps, gapInfo{(slots[i-1] + slots[i]) / 2, g})
			}
		}
		last := slots[len(slots)-1]
		gaps = append(gaps, gapInfo{last + 3, 4}) // внешние позиции — приоритет как у мелких внутренних зазоров
		gaps = append(gaps, gapInfo{last + 6, 3})
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].size > gaps[j].size })

	usedOrbits := make(map[int]bool)
	for _, s := range slots {
		usedOrbits[s] = true
	}
	ringSeed := seed*31337 + 1
	rings := make([]RingInfo, 0, nRings)
	for i := 0; i < nRings && len(gaps) > 0; i++ {
		ringSeed = (ringSeed*1664525 + 1013904223) & 0x7fffffff
		topN := int64(3)
		if topN > int64(len(gaps)) {
			topN = int64(len(gaps))
		}
		idx := int(ringSeed % topN)
		pos := gaps[idx].mid
		for usedOrbits[pos] {
			pos++
		}
		usedOrbits[pos] = true
		gaps = append(gaps[:idx], gaps[idx+1:]...)
		rings = append(rings, RingInfo{RingIndex: i + 1, OrbitGrid: pos})
	}
	for len(rings) < nRings {
		pos := 38 + len(rings)
		rings = append(rings, RingInfo{RingIndex: len(rings) + 1, OrbitGrid: pos})
	}

	result := map[string]interface{}{
		"star_id":   starID,
		"star_type": starType,
		"mass":      mass,
		"gen_code":  genCode,
		"n_planets": nPlanets,
		"n_rings":   nRings,
		"planets":   planets,
		"rings":     rings,
	}
	json.NewEncoder(w).Encode(result)
}

// ============================================================
// MAIN
// ============================================================

func main() {
	loadRegistryIntoMemory()
	log.Printf("Registry loaded: %d records (%d unique IDs)", len(regRecords), len(regByID))
	startRegistrySaver()

	// Registry API
	http.HandleFunc("/registry/birth/batch", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodOptions:
			handleRegistryBirthBatch(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/registry/birth", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodOptions:
			handleRegistryBirth(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/registry/death", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodOptions:
			handleRegistryDeath(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/registry/reset", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodOptions:
			handleRegistryReset(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/registry/stats", func(w http.ResponseWriter, r *http.Request) {
		handleRegistryStats(w, r)
	})
	http.HandleFunc("/registry/stream", handleRegistryStream)
	http.HandleFunc("/registry", func(w http.ResponseWriter, r *http.Request) {
		handleRegistryGet(w, r)
	})

	// Galaxy scan
	http.HandleFunc("/scan", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodOptions:
			handleScan(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// System view
	http.HandleFunc("/system/", handleSystemGet)

	// Prices editor
	http.HandleFunc("/prices", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var raw json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		var check interface{}
		if err := json.Unmarshal(raw, &check); err != nil {
			http.Error(w, "invalid JSON structure", http.StatusBadRequest)
			return
		}
		pretty, _ := json.MarshalIndent(check, "", "  ")
		if err := os.WriteFile("prices.json", pretty, 0644); err != nil {
			http.Error(w, "cannot save prices.json", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	})

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
	fmt.Println("  registry.html → star registry")
	log.Fatal(http.ListenAndServe(port, nil))
}
