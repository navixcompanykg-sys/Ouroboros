package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ════════════════════════════════════════════════════════════════════════════
// УРОБОРОС — сервер v2
//
// Задачи на этом этапе:
//  1. Единые часы симуляции (clock.go) — источник игрового времени для всех клиентов.
//  2. Раздача клиента (client/) по локальной сети, чтобы открывать карту с телефона.
//
// Слушает 0.0.0.0, поэтому доступен с любого устройства в той же сети —
// при старте печатает готовый адрес для телефона.
// ════════════════════════════════════════════════════════════════════════════

var (
	clk      *Clock
	sim      *Sim
	seed     int64
	clientFS string
)

func main() {
	port := flag.Int("port", 8080, "порт HTTP-сервера")
	speed := flag.Float64("speed", 0.25, "стартовое ускорение: игровых месяцев за реальную секунду")
	seedFlag := flag.Int64("seed", 0, "сид генерации галактики (0 = случайный при запуске)")
	flag.Parse()

	if *seedFlag != 0 {
		seed = *seedFlag
	} else {
		seed = time.Now().UnixNano() & 0x7fffffffffffffff
	}

	dir, err := resolveClientDir()
	if err != nil {
		log.Fatalf("не найден каталог client/: %v", err)
	}
	clientFS = dir

	clk = NewClock(*speed)
	sim = NewSim(seed)
	stop := make(chan struct{})
	go clk.Run(stop)
	go driveSim(stop)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/time", handleTime)
	mux.HandleFunc("/api/speed", handleSpeed)
	mux.HandleFunc("/api/galaxy", handleGalaxy)
	mux.HandleFunc("/api/stats", handleStats)
	mux.HandleFunc("/api/events", handleEvents)
	mux.Handle("/", noCache(http.FileServer(http.Dir(clientFS))))

	addr := fmt.Sprintf(":%d", *port)
	printBanner(*port, *speed)

	srv := &http.Server{
		Addr:              addr,
		Handler:           withGzip(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		close(stop)
		log.Fatal(err)
	}
}

// resolveClientDir ищет client/ рядом с сервером — чтобы запуск работал и из
// server/, и из корня проекта, и от собранного .exe.
func resolveClientDir() (string, error) {
	candidates := []string{"../client", "client", "./client"}
	if exe, err := os.Executable(); err == nil {
		base := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(base, "..", "client"),
			filepath.Join(base, "client"))
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, "ship.html")); err == nil && !st.IsDir() {
			return filepath.Clean(c), nil
		}
	}
	return "", fmt.Errorf("ship.html не найден ни в одном из %v", candidates)
}

// noCache — на время разработки: иначе телефон закеширует старый HTML и правки
// не будут видны без ручной очистки кеша.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/ship.html", http.StatusFound)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// driveSim доводит состав сектора до текущего игрового времени. Идёт своим
// тиком независимо от клиентов: галактика живёт, даже когда её никто не смотрит.
func driveSim(stop <-chan struct{}) {
	t := time.NewTicker(time.Second / tickHz)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			sim.Advance(clk.Snapshot().Months)
		case <-stop:
			return
		}
	}
}

type timeResponse struct {
	Snapshot
	Seed int64  `json:"seed"`
	Seq  uint64 `json:"seq"`
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// GET /api/time — «сколько сейчас». Клиент синхронизируется этим при загрузке
// и периодически, чтобы не накапливать расхождение с сервером.
func handleTime(w http.ResponseWriter, r *http.Request) {
	_, seq := sim.Snapshot()
	writeJSON(w, timeResponse{Snapshot: clk.Snapshot(), Seed: seed, Seq: seq})
}

// GET /api/galaxy — полный состав сектора на текущий момент. Клиент берёт его
// при подключении, дальше живёт на потоке событий и сам считает позиции по
// формуле x = x0 + arc·(t − t0), не перекачивая список заново.
func handleGalaxy(w http.ResponseWriter, r *http.Request) {
	snap := clk.Snapshot()
	sim.Advance(snap.Months) // отдаём состав, актуальный ровно на это время
	objects, seq := sim.Snapshot()
	writeJSON(w, struct {
		Snapshot
		Seed    int64     `json:"seed"`
		Seq     uint64    `json:"seq"`
		Objects []*Object `json:"objects"`
	}{Snapshot: snap, Seed: seed, Seq: seq, Objects: objects})
}

// GET /api/stats — сводка по сектору для диагностики и тестов.
func handleStats(w http.ResponseWriter, r *http.Request) {
	snap := clk.Snapshot()
	sim.Advance(snap.Months)
	writeJSON(w, struct {
		Stats
		Months float64 `json:"months"`
		Speed  float64 `json:"speed"`
	}{Stats: sim.Stats(), Months: snap.Months, Speed: snap.Speed})
}

// POST /api/speed {"speed": <месяцев в секунду>} — ускорение времени.
// Это серверная настройка: меняется для всех клиентов сразу, а не локально в браузере.
func handleSpeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Speed *float64 `json:"speed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Speed == nil {
		http.Error(w, "ожидается {\"speed\": число}", http.StatusBadRequest)
		return
	}
	sim.Advance(clk.Snapshot().Months) // доводим состав по старой скорости, потом меняем
	s := clk.SetSpeed(*body.Speed)
	_, seq := sim.Snapshot()
	log.Printf("скорость → %.4f мес/сек (игровое время %.2f мес)", s.Speed, s.Months)
	writeJSON(w, timeResponse{Snapshot: s, Seed: seed, Seq: seq})
}

// GET /api/events — SSE-поток серверного времени. Нужен, чтобы смена ускорения
// с одного устройства сразу дошла до остальных (например, меняем с ПК, смотрим
// на телефоне), и чтобы клиент подтягивал время без опроса.
func handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "стриминг не поддерживается", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")

	// курсор клиента живёт в этой горутине: каждое соединение получает ровно
	// те события, которые пропустило
	cursor := parseUint(r.URL.Query().Get("since"))

	t := time.NewTicker(time.Second / sseHz)
	defer t.Stop()
	for {
		snap := clk.Snapshot()
		sim.Advance(snap.Months)
		events, resync := sim.EventsSince(cursor)
		// клиент отстал больше, чем помещается в буфер, или разом накопилось
		// слишком много смен (сильное ускорение) — дешевле перезабрать снимок
		if len(events) > maxEventsPerFrame {
			events, resync = nil, true
		}
		if resync {
			_, seq := sim.Snapshot()
			cursor = seq
		} else if n := len(events); n > 0 {
			cursor = events[n-1].Seq
		}
		payload, _ := json.Marshal(struct {
			Snapshot
			Seed   int64   `json:"seed"`
			Seq    uint64  `json:"seq"`
			Resync bool    `json:"resync,omitempty"`
			Events []Event `json:"events,omitempty"`
		}{Snapshot: snap, Seed: seed, Seq: cursor, Resync: resync, Events: events})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()

		select {
		case <-t.C:
		case <-r.Context().Done():
			return
		}
	}
}

const (
	sseHz             = 4   // частота кадров потока событий
	maxEventsPerFrame = 500 // выше — отправляем resync вместо простыни событий
)

func parseUint(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// lanIPs — адреса, по которым сервер виден с других устройств локальной сети.
func lanIPs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}

func printBanner(port int, speed float64) {
	line := strings.Repeat("─", 58)
	fmt.Println(line)
	fmt.Println("  УРОБОРОС — сервер")
	fmt.Printf("  клиент:   %s\n", clientFS)
	fmt.Printf("  сид:      %d\n", seed)
	fmt.Printf("  скорость: %.4f игр. мес / реальную сек\n", speed)
	fmt.Println(line)
	fmt.Printf("  на этом компьютере:  http://localhost:%d/\n", port)
	ips := lanIPs()
	if len(ips) == 0 {
		fmt.Println("  в локальной сети:    адрес не определён (нет активного сетевого интерфейса)")
	} else {
		for _, ip := range ips {
			fmt.Printf("  с телефона:          http://%s:%d/\n", ip, port)
		}
		fmt.Println("  (телефон должен быть в той же сети; если не открывается —")
		fmt.Println("   разрешите порт в брандмауэре Windows, см. server/README.md)")
	}
	fmt.Println(line)
}
