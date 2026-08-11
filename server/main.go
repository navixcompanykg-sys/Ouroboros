package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
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
	ship     *Ship
	seed     int64
	clientFS string
)

func main() {
	port := flag.Int("port", 8080, "порт HTTP-сервера")
	// По умолчанию — РЕАЛЬНОЕ время: 1 игровой месяц идёт ровно 1 календарный
	// месяц, никакого сжатия (gameSpeedRealtime в clock.go). Всё, что быстрее, —
	// ускорение для отладки из админ-панели, а не то, что видит игрок.
	speed := flag.Float64("speed", gameSpeedRealtime, "скорость игрового времени: игровых месяцев за реальную секунду (по умолчанию — реальное время)")
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
	forceHabitableCapitals(sim)
	ship = NewShip(findCapitalID(sim), findCapitalRadius(sim))
	initFleets(sim)
	stop := make(chan struct{})
	go clk.Run(stop)
	go driveSim(stop)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/time", handleTime)
	mux.HandleFunc("/api/speed", handleSpeed)
	mux.HandleFunc("/api/galaxy", handleGalaxy)
	mux.HandleFunc("/api/planet/surface", handlePlanetSurface)
	mux.HandleFunc("/api/stats", handleStats)
	mux.HandleFunc("/api/events", handleEvents)
	mux.HandleFunc("/api/ship", handleShip)
	mux.HandleFunc("/api/ship/navigate", handleShipNavigate)
	mux.HandleFunc("/api/ship/land", handleShipLand)
	mux.HandleFunc("/api/ship/launch", handleShipLaunch)
	mux.HandleFunc("/api/fleets", handleFleets)
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

// findCapitalID/findCapitalRadius — где стоит корабль при старте сервера:
// в системе столицы Империи (Role=="capital", тот же объект, вокруг которого
// centred круг перелётов на карте сектора, см. galaxy.html). Если по какой-то
// причине столица не нашлась (не должно происходить), берём первую звезду.
func findCapitalID(sim *Sim) int {
	objects, _ := sim.Snapshot()
	for _, o := range objects {
		if o.Type == "star" && o.Role == "capital" {
			return o.ID
		}
	}
	for _, o := range objects {
		if o.Type == "star" {
			return o.ID
		}
	}
	return 0
}

func findCapitalRadius(sim *Sim) float64 {
	if star, ok := sim.Object(findCapitalID(sim)); ok {
		return star.SystemRadius
	}
	return 30
}

// forceHabitableCapitals — в каждой из 4 стабильных систем (столица +
// 3 вассала, ТЗ.md §2.1) одна планета в зоне обитания принудительно
// становится живой и получает стартовую колонию. Вызывается один раз при
// старте сервера сразу после генерации сектора — правит уже готовые
// объекты sim постфактум, не встраивается в сам генератор (planets.go),
// чтобы не усложнять его отдельным случаем «эта планета обязана быть живой».
//
// «Зона обитания» в этой кодовой базе не отдельное понятие — ей
// соответствует тип планеты `rocky` (жизнь физически возможна только на
// rocky/ice, см. lifeChanceCap в planets.go), rocky предпочтительнее ice как
// более многообещающий/типичный вариант.
func forceHabitableCapitals(sim *Sim) {
	objects, _ := sim.Snapshot()
	for _, star := range objects {
		if star.Type != "star" || star.StarType != "stable" {
			continue
		}
		idx := -1
		for i, p := range star.Planets {
			if p.Type == "rocky" {
				idx = i
				break
			}
		}
		if idx < 0 {
			for i, p := range star.Planets {
				if p.Type == "ice" {
					idx = i
					break
				}
			}
		}
		if idx < 0 {
			// Защитный случай — не ожидается на реальной генерации (стабильные
			// системы получают несколько планет через обычный generatePlanets,
			// пересекающий все орбитальные полосы), но без rocky/ice
			// принудительная жизнь физически невозможна (lifeChanceCap) —
			// берём первую планету с твёрдой поверхностью и меняем её тип.
			for i, p := range star.Planets {
				if p.Type != "gas" {
					idx = i
					star.Planets[i].Type = "rocky"
					break
				}
			}
		}
		if idx < 0 {
			log.Printf("forceHabitableCapitals: у звезды #%d (%s) нет ни одной планеты с твёрдой поверхностью — пропущено", star.ID, star.Faction)
			continue
		}
		// Отдельный детерминированный поток, не общий поток генерации сектора
		// (sim.rng) — иначе порядок этого вызова сдвинул бы все последующие
		// броски, и сектор перестал бы быть воспроизводимым по сиду.
		rng := rand.New(rand.NewSource(int64(star.ID)*1000 + int64(idx)))
		recomputeAsHabitable(rng, &star.Planets[idx], star.StarType, star.R, star.SystemRadius)
		bootstrapColony(&star.Planets[idx])
		log.Printf("столица %s: планета #%d (%s) сделана обитаемой, стартовая колония — %d зданий",
			star.Faction, idx, star.Planets[idx].Type, len(star.Planets[idx].Buildings))
	}
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

// GET /api/planet/surface?starId=N&planetIndex=N — гекс-карта ОДНОЙ планеты
// С РЕСУРСАМИ по гексам (SurfaceHexDetail). Отдельный от /api/galaxy
// эндпоинт намеренно: тот опрашивается раз в секунду для всего сектора
// сразу, а ресурсы по гексам (до 15 ключей на гекс, до 61 гекса на планету)
// раздули бы его на мегабайты за тик ради данных, нужных только для ОДНОЙ
// планеты — той, на которую сейчас смотрит игрок (client/planet.html), и то
// не каждый кадр, а один раз при посадке. См. SurfaceHex.res в planets.go.
func handlePlanetSurface(w http.ResponseWriter, r *http.Request) {
	starID := int(parseUint(r.URL.Query().Get("starId")))
	planetIndex := int(parseUint(r.URL.Query().Get("planetIndex")))
	star, found := sim.Object(starID)
	if !found || star.Type != "star" || planetIndex < 0 || planetIndex >= len(star.Planets) {
		http.Error(w, "планета не найдена", http.StatusNotFound)
		return
	}
	p := star.Planets[planetIndex]
	connected := connectedHexes(&p)
	hexes := make([]SurfaceHexDetail, len(p.Surface))
	for i, h := range p.Surface {
		hexes[i] = SurfaceHexDetail{
			Q: h.Q, R: h.R, Type: h.Type, Crater: h.Crater, Res: h.res,
			Connected: connected[[2]int{h.Q, h.R}],
		}
	}
	writeJSON(w, struct {
		Surface   []SurfaceHexDetail `json:"surface"`
		Buildings []Building         `json:"buildings"`
	}{Surface: hexes, Buildings: p.Buildings})
}

// GET /api/stats — сводка по сектору для диагностики и тестов. Читает её и
// общая админ-панель (client/admin-panel.js): опрашивает этот эндпоинт раз в
// секунду с любого экрана — панель не привязана к тому, какой именно HTML
// сейчас открыт (ship.html/galaxy.html), в отличие от карты сектора.
func handleStats(w http.ResponseWriter, r *http.Request) {
	snap := clk.Snapshot()
	sim.Advance(snap.Months)
	writeJSON(w, struct {
		Stats
		Months float64 `json:"months"`
		Speed  float64 `json:"speed"`
		Seed   int64   `json:"seed"`
	}{Stats: sim.Stats(), Months: snap.Months, Speed: snap.Speed, Seed: seed})
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
	// formatSpeed, а не %.4f: игровая (реальная) скорость — это ~3.8e-7 мес/сек,
	// в логе она печаталась как «0.0000 мес/сек» и была неотличима от паузы.
	log.Printf("скорость → %s (игровое время %.2f мес)", formatSpeed(s.Speed), s.Months)
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

// GET /api/ship — текущее положение корабля (ship.go: один глобальный
// корабль на сервере, реальное время полёта, не игровые месяцы).
func handleShip(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, ship.Snapshot(time.Now()))
}

// POST /api/ship/navigate {"kind":"star"|"planet","starId":N,"planetIndex":N}
// — проложить курс. kind="star" всегда допустим (в своей системе или
// межзвёздно); kind="planet" — только в ТЕКУЩЕЙ системе корабля (см. ship.go:
// до чужой планеты летим в два шага — сначала до её звезды).
func handleShipNavigate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Kind        string `json:"kind"`
		StarID      int    `json:"starId"`
		PlanetIndex int    `json:"planetIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || (body.Kind != "star" && body.Kind != "planet") {
		http.Error(w, `ожидается {"kind":"star"|"planet","starId":N,"planetIndex":N}`, http.StatusBadRequest)
		return
	}
	if err := ship.Navigate(sim, time.Now(), body.Kind, body.StarID, body.PlanetIndex); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, ship.Snapshot(time.Now()))
}

// POST /api/ship/land — посадка на планету, у которой корабль сейчас
// находится (кроме газовых гигантов — см. ship.go Land).
func handleShipLand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	if err := ship.Land(sim, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, ship.Snapshot(time.Now()))
}

// POST /api/ship/launch — взлёт с поверхности.
func handleShipLaunch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	if err := ship.Launch(time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, ship.Snapshot(time.Now()))
}

// GET /api/fleets — раскладка флотов игрока по стабильным мирам (fleets.go).
// Только текущий флот (Current==true) реально симулируется через ship.go;
// остальные — статичные данные о гарнизоне на орбите родного мира.
func handleFleets(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, fleets)
}

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

// formatSpeed — человекочитаемая скорость времени: на игровой (реальное
// время) множитель ~3.8e-7 мес/сек, и «0.0000 мес/сек» в баннере не говорит
// ничего. Главное — КРАТНОСТЬ к игровой скорости, абсолютный темп идёт
// уточнением. Тот же формат, что и в админ-панели (client/admin-panel.js).
func formatSpeed(speed float64) string {
	if speed <= 0 {
		return "пауза (время стоит)"
	}
	mult := speed / gameSpeedRealtime
	secPerMonth := 1 / speed
	var per string
	if secPerMonth >= 86400 {
		per = fmt.Sprintf("%.1f реальных суток", secPerMonth/86400)
	} else {
		per = fmt.Sprintf("%.1f реальных часов", secPerMonth/3600)
	}
	if math.Abs(mult-1) < 0.01 {
		return fmt.Sprintf("× 1 игровая, реальное время (1 игр. месяц / %s)", per)
	}
	return fmt.Sprintf("× %.0f от игровой (1 игр. месяц / %s)", mult, per)
}

func printBanner(port int, speed float64) {
	line := strings.Repeat("─", 58)
	fmt.Println(line)
	fmt.Println("  УРОБОРОС — сервер")
	fmt.Printf("  клиент:   %s\n", clientFS)
	fmt.Printf("  сид:      %d\n", seed)
	fmt.Printf("  скорость: %s\n", formatSpeed(speed))
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
