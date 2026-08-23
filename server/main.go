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
	"os/exec"
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
	// По умолчанию — РЕАЛЬНОЕ время: 1 игровой месяц идёт ровно 1 календарный
	// месяц, никакого сжатия (gameSpeedRealtime в clock.go). Всё, что быстрее, —
	// ускорение для отладки из админ-панели, а не то, что видит игрок.
	speed := flag.Float64("speed", gameSpeedRealtime, "скорость игрового времени: игровых месяцев за реальную секунду (по умолчанию — реальное время)")
	seedFlag := flag.Int64("seed", 0, "сид генерации галактики (0 = случайный при запуске)")
	flag.Parse()

	killStaleServer(*port)

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
	loadEconomy() // после sim — рекомендованная цена считается от реального запаса ресурсов сектора
	loadShipDefaults()
	loadStationDefaults()
	initFleets(sim) // заводит по *Ship на каждый из 4 флотов (fleets.go assignFleetShips) — нужны loadEconomy/loadShipDefaults выше для расчёта тяги
	stop := make(chan struct{})
	go clk.Run(stop)
	go driveSim(stop)
	go driveProduction(stop) // ежедневный цикл колонии: добыча/содержание/производство/население (production.go)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/time", handleTime)
	mux.HandleFunc("/api/speed", handleSpeed)
	mux.HandleFunc("/api/galaxy", handleGalaxy)
	mux.HandleFunc("/api/planet/surface", handlePlanetSurface)
	mux.HandleFunc("/api/planet/log", handlePlanetLog)
	mux.HandleFunc("/api/stats", handleStats)
	mux.HandleFunc("/api/events", handleEvents)
	mux.HandleFunc("/api/ship", handleShip)
	mux.HandleFunc("/api/ship/navigate", handleShipNavigate)
	mux.HandleFunc("/api/ship/land", handleShipLand)
	mux.HandleFunc("/api/ship/launch", handleShipLaunch)
	mux.HandleFunc("/api/ship/control", handleShipControl)
	mux.HandleFunc("/api/ship/debug-damage", handleShipDebugDamage)
	mux.HandleFunc("/api/ship/eta", handleShipETA)
	mux.HandleFunc("/api/ship/boost", handleShipBoost)
	mux.HandleFunc("/api/ship/charge", handleShipCharge)
	mux.HandleFunc("/api/ship/jettison", handleShipJettison)
	mux.HandleFunc("/api/ship/pickup", handleShipPickup)
	mux.HandleFunc("/api/cargo-boxes", handleCargoBoxes)
	mux.HandleFunc("/api/fleets", handleFleets)
	mux.HandleFunc("/api/fleets/activate", handleFleetActivate)
	mux.HandleFunc("/api/economy", handleEconomy)
	mux.HandleFunc("/api/economy/resource", handleEconomyResource)
	mux.HandleFunc("/api/economy/ship-module", handleEconomyShipModule)
	mux.HandleFunc("/api/ship-defaults", handleShipDefaults)
	mux.HandleFunc("/api/station-defaults", handleStationDefaults)
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

// findCapitalID — система столицы Империи (Role=="capital", тот же объект,
// вокруг которого centred круг перелётов на карте сектора, см. galaxy.html) —
// родной мир флота с ID=0 (fleets.go initFleets). Если по какой-то причине
// столица не нашлась (не должно происходить), берём первую звезду.
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
		star.Planets[idx].Capital = true
		bootstrapColony(&star.Planets[idx])
		log.Printf("столица %s: планета #%d (%s) сделана обитаемой, стартовая колония — %d зданий, население %d",
			star.Faction, idx, star.Planets[idx].Type, len(star.Planets[idx].Buildings), star.Planets[idx].Population)
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

// writeJSON — единственный способ ответа API. Ошибку кодирования РАНЬШЕ
// глотали молча (`_ = json.NewEncoder(w).Encode(v)`), и это опасная тишина:
// `encoding/json` отказывается кодировать NaN/±Inf, ответ уходит клиенту
// оборванным на середине, тот не может его разобрать — и снаружи это выглядит
// как «связь с сервером оборвалась» без единой строки в консоли сервера.
// Теперь кодируем в буфер: сломанный ответ становится честной 500-й с
// объяснением в логе (проверка на NaN в снимке корабля — ещё и постоянным
// тестом, server/shipflight_test.go).
func writeJSON(w http.ResponseWriter, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("не удалось закодировать ответ %T: %v", v, err)
		http.Error(w, "внутренняя ошибка сервера: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(b)
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
			Q: h.Q, R: h.R, Type: h.Type, Crater: h.Crater, Fresh: h.Fresh, Res: h.res,
			Connected: connected[[2]int{h.Q, h.R}],
		}
	}
	writeJSON(w, struct {
		Surface   []SurfaceHexDetail `json:"surface"`
		Buildings []Building         `json:"buildings"`
	}{Surface: hexes, Buildings: p.Buildings})
}

// GET /api/planet/log?starId=N&planetIndex=N — журнал событий колонии по
// суткам (Planet.EventLog, production.go logDayEntry) — по требованию
// пользователя: «журнал записей всех компонентов и действий на колониях...
// в табличном виде». Читает новая страница client/colony-log.html. Не
// участвует в /api/galaxy намеренно (см. Planet.EventLog, planets.go) —
// отдельный запрос, не раз в секунду со всеми остальными данными.
func handlePlanetLog(w http.ResponseWriter, r *http.Request) {
	starID := int(parseUint(r.URL.Query().Get("starId")))
	planetIndex := int(parseUint(r.URL.Query().Get("planetIndex")))
	star, found := sim.Object(starID)
	if !found || star.Type != "star" || planetIndex < 0 || planetIndex >= len(star.Planets) {
		http.Error(w, "планета не найдена", http.StatusNotFound)
		return
	}
	p := star.Planets[planetIndex]
	writeJSON(w, struct {
		Log []DayLogEntry `json:"log"`
	}{Log: p.EventLog})
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
	// Пере-целивание летящих кораблей под новую скорость (server/ship.go
	// rebaseTransit) — иначе упреждение цели (планета/звезда к прилёту)
	// остаётся посчитанным по старой скорости, и корабль прилетает не туда.
	rebaseAllActiveTransits(sim, time.Now())
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

// GET /api/ship — текущее положение АКТИВНОГО флота (fleets.go activeShip):
// у каждого из 4 флотов свой *Ship, но клиент всегда работает с тем, что
// сейчас выбран — переключение см. handleFleetActivate. Реальное время
// полёта, не игровые месяцы (ship.go).
func handleShip(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, activeShip().Snapshot(time.Now()))
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
	if err := activeShip().Navigate(sim, time.Now(), body.Kind, body.StarID, body.PlanetIndex); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/land — посадка на планету, у которой корабль сейчас
// находится (кроме газовых гигантов — см. ship.go Land).
func handleShipLand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	if err := activeShip().Land(sim, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/launch — взлёт с поверхности.
func handleShipLaunch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	if err := activeShip().Launch(time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/control {"thrust":bool,"brake":bool,"turnLeft":bool,"turnRight":bool}
// — ручное управление (client/ship.html): какие органы управления зажаты
// ПРЯМО СЕЙЧАС. Курс/скорость/позиция между вызовами доводятся аналитически
// (ship.go settleFlight), а не тикают на сервере фоном.
func handleShipControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Thrust, Brake, TurnLeft, TurnRight bool
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `ожидается {"thrust":bool,"brake":bool,"turnLeft":bool,"turnRight":bool}`, http.StatusBadRequest)
		return
	}
	if err := activeShip().SetControl(time.Now(), body.Thrust, body.Brake, body.TurnLeft, body.TurnRight); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/debug-damage — служебное действие: случайный урон случайной
// палубе активного корабля (см. ship.go DebugDamage — настоящего боя/
// столкновений в игре ещё нет, это временная демонстрация заполнения
// HP-чекбоксов на HUD, по прямой просьбе пользователя).
func handleShipDebugDamage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	deck, err := activeShip().DebugDamage(time.Now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, struct {
		Deck DeckHP   `json:"deck"`
		Ship ShipView `json:"ship"`
	}{deck, activeShip().Snapshot(time.Now())})
}

// POST /api/ship/boost {"action":"kick"|"engage"|"disengage"} — кнопка
// УСКОРИТЬ/МЕДЛЕННЕЕ (client/ship.html): "kick" — разовый импульс (короткий
// тап), "engage"/"disengage" — защёлкнуть/снять устойчивый форсаж на гелии
// (Ship.Boosted, удержание кнопки/явное «МЕДЛЕННЕЕ»).
func handleShipBoost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `ожидается {"action":"kick"|"engage"|"disengage"}`, http.StatusBadRequest)
		return
	}
	var err error
	switch body.Action {
	case "kick":
		err = activeShip().Kick(time.Now())
	case "engage":
		err = activeShip().SetBoost(time.Now(), true)
	case "disengage":
		err = activeShip().SetBoost(time.Now(), false)
	default:
		http.Error(w, `action должен быть "kick", "engage" или "disengage"`, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/charge — кнопка ЗАРЯДИТЬ (client/ship.html): сжигает
// металлический водород, пополняя заряд аккумуляторов (ship.go Charge).
func handleShipCharge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	if err := activeShip().Charge(time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/jettison {"key":"...", "amount":N} — выбросить груз из
// трюма в космос (окно осмотра корабля, cargo.go Jettison).
func handleShipJettison(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Key    string  `json:"key"`
		Amount float64 `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `ожидается {"key":"...","amount":N}`, http.StatusBadRequest)
		return
	}
	if err := activeShip().Jettison(body.Key, body.Amount); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, activeShip().Snapshot(time.Now()))
}

// POST /api/ship/pickup — подобрать груз с клети, где сейчас корабль
// (cargo.go Pickup).
func handleShipPickup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	picked, err := activeShip().Pickup(time.Now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, struct {
		Picked map[string]float64 `json:"picked"`
		Ship   ShipView           `json:"ship"`
	}{picked, activeShip().Snapshot(time.Now())})
}

// GET /api/cargo-boxes?starId=N — коробки с грузом, сброшенные в этой
// звёздной системе (cargo.go).
func handleCargoBoxes(w http.ResponseWriter, r *http.Request) {
	starID, err := strconv.Atoi(r.URL.Query().Get("starId"))
	if err != nil {
		http.Error(w, "ожидается ?starId=N", http.StatusBadRequest)
		return
	}
	writeJSON(w, cargoBoxesInStar(starID))
}

// GET /api/ship/eta?kind=star|planet&starId=N&planetIndex=N — предпросчёт
// полёта ДО нажатия «лететь» (ship.go EstimateTravel): время в секундах и
// расход топлива, ничего не меняя в состоянии корабля. GET, не POST — чтение,
// вызывается на каждый выбор цели на радаре (client/ship.html).
func handleShipETA(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind := q.Get("kind")
	if kind != "star" && kind != "planet" {
		http.Error(w, `ожидается ?kind=star|planet&starId=N&planetIndex=N`, http.StatusBadRequest)
		return
	}
	starID, err1 := strconv.Atoi(q.Get("starId"))
	planetIndex, err2 := strconv.Atoi(q.Get("planetIndex"))
	if err1 != nil || (kind == "planet" && err2 != nil) {
		http.Error(w, `ожидается ?kind=star|planet&starId=N&planetIndex=N`, http.StatusBadRequest)
		return
	}
	est, err := activeShip().EstimateTravel(sim, time.Now(), kind, starID, planetIndex)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, est)
}

// GET /api/fleets — раскладка флотов игрока по стабильным мирам (fleets.go),
// у каждого свой *Ship. Current — какой из них сейчас активен (переключение —
// handleFleetActivate).
func handleFleets(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, fleetsView())
}

// POST /api/fleets/activate {"id":N} — переключить активный флот. Реально
// переключает, чей корабль отдаёт /api/ship и принимает /api/ship/* — раньше
// это меню в client/galaxy.html было чисто локальным (см. историю правки).
func handleFleetActivate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ID int `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `ожидается {"id":N}`, http.StatusBadRequest)
		return
	}
	if !activateFleet(body.ID) {
		http.Error(w, "неизвестный флот", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct {
		Fleets []Fleet  `json:"fleets"`
		Ship   ShipView `json:"ship"`
	}{fleetsView(), activeShip().Snapshot(time.Now())})
}

// GET /api/economy — снимок панели «Экономика» (client/economy.html): цены и
// масса 15 базовых ресурсов (с оверрайдами администратора), рецепты 21
// компонента и стоимость 19 зданий, пересчитанные от текущих цен/массы, и
// сводный спрос по всем базовым ресурсам (economy.go).
func handleEconomy(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, economySnapshot())
}

// POST /api/economy/resource {"key":"...", "price"?:число, "mass"?:число} —
// правка администратора: цена и/или масса одного базового ресурса. Частичная
// (можно прислать только price или только mass), сразу сохраняется на диск
// (economy_data.json) и возвращает пересчитанный снимок экономики целиком —
// табл. 2/3/5 в client/economy.html зависят от цены/массы табл. 1.
func handleEconomyResource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Key   string   `json:"key"`
		Price *float64 `json:"price"`
		Mass  *float64 `json:"mass"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, `ожидается {"key":"...", "price"?:число, "mass"?:число}`, http.StatusBadRequest)
		return
	}
	if err := setResourceOverride(body.Key, body.Price, body.Mass); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, economySnapshot())
}

// POST /api/economy/ship-module {"key":"...", "powerGen"?, "powerActive"?, "powerPassive"?:число} —
// правка администратора: выработка и/или активное(пиковое)/пассивное
// (постоянное) потребление энергии одним модулем корабля (вкладка «ЭНЕРГИЯ»
// client/economy.html). Тот же принцип, что и handleEconomyResource —
// частичная правка, сразу на диск, возвращает пересчитанный снимок целиком
// (client/ship-deck-sectors.html читает его же).
func handleEconomyShipModule(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "нужен POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Key          string   `json:"key"`
		PowerGen     *float64 `json:"powerGen"`
		PowerActive  *float64 `json:"powerActive"`
		PowerPassive *float64 `json:"powerPassive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, `ожидается {"key":"...", "powerGen"?, "powerActive"?, "powerPassive"?:число}`, http.StatusBadRequest)
		return
	}
	if err := setShipModuleOverride(body.Key, body.PowerGen, body.PowerActive, body.PowerPassive); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, economySnapshot())
}

func parseUint(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// killStaleServer — перед стартом закрывает любой процесс, уже слушающий тот
// же порт: почти всегда это забытый процесс сервера с прошлого запуска
// (закрыли окно терминала без Ctrl+C, потерялся фоновый `go run .`) — именно
// такой процесс однажды продолжал отвечать на /api/*, но без свежего кода
// (404 на только что добавленный /api/economy), и было неочевидно, что вообще
// висит лишний процесс. Windows-специфично (netstat -ano / taskkill) — как и
// весь остальной проект, ориентировано на win32 (см. run.bat).
func killStaleServer(port int) {
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return // netstat недоступен — не критично, просто не чистим
	}
	needle := fmt.Sprintf(":%d ", port)
	killed := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "LISTENING") || !strings.Contains(line, needle) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid := fields[len(fields)-1]
		if pid == "" || pid == strconv.Itoa(os.Getpid()) || killed[pid] {
			continue
		}
		if kerr := exec.Command("taskkill", "/F", "/PID", pid).Run(); kerr == nil {
			log.Printf("порт %d был занят процессом PID %s (прошлый запуск сервера) — закрыт", port, pid)
			killed[pid] = true
		}
	}
	if len(killed) > 0 {
		time.Sleep(300 * time.Millisecond) // дать ОС освободить порт перед ListenAndServe
	}
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
