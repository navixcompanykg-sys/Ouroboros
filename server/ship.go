package main

import (
	"errors"
	"math"
	"sync"
	"time"
)

// ════════════════════════════════════════════════════════════════════════════
// КОРАБЛЬ ИГРОКА — один глобальный объект на сервере, а не состояние вкладки.
//
// В игре пока нет аккаунтов/нескольких игроков, поэтому корабль устроен так
// же, как сектор: единственный источник истины на сервере, клиент только
// отображает (CLAUDE.md — «два устройства видят одну и ту же галактику»).
// Появится второй игрок — потребуется таблица кораблей по сессии; пока
// достаточно одного.
//
// Время полёта — РЕАЛЬНЫЕ секунды (time.Now()), а не игровые месяцы Clock.
// У сектора и у HUD полёта в ТЗ.md два никак не увязанных масштаба времени:
// месяцы — для дрейфа звёзд, секунды — для «полёта в реальном времени»
// (ТЗ_UI.md §2). Сшивать их сейчас не на чем (гравитация/топливо — открытые
// вопросы ТЗ.md §2.7), поэтому корабль живёт на своих часах, независимо от
// Clock/Sim.
//
// Упреждение цели различается по масштабам:
//   • ВНУТРИ системы (полёт к планете) оно есть — целимся туда, где планета
//     будет к прилёту. Без него корабль прилетал в покинутую точку, и его
//     скачком выбрасывало на настоящее место стоянки, наружу от планеты
//     (подробности и числа — в Navigate);
//   • МЕЖ-ЗВЁЗДНЫЙ перелёт летит по снимку позиции звезды на момент старта,
//     без упреждения — и этого достаточно: звёзды дрейфуют несопоставимо
//     медленнее корабля (см. следующий блок), промах остаётся ничтожным.
// ════════════════════════════════════════════════════════════════════════════

// Скорости — плейсхолдер-константы, ждут формул скорости/разгона ТЗ.md §2.7.4
// (асимптотика к 300 000 у.е., ускорение по типу двигателя и т.п. не заданы).
const (
	systemSpeed       = 6.0  // клети системы в секунду — полёт внутри звёздной системы
	interstellarSpeed = 12.0 // клети сектора в секунду — полёт между звёздами
)

// ── корабль против дрейфа сектора ──────────────────────────────────────────
//
// Меж-звёздная навигация летит по снимку позиции цели БЕЗ упреждения (см.
// выше) — приближение тем хуже, чем быстрее цель успевает уйти от снимка за
// время полёта. На игровой скорости это не проблема вовсе: время идёт
// реальное (gameSpeedRealtime в clock.go — 1 игровой месяц = 1 календарный),
// поэтому самая быстрая звезда сектора (зона 1, 120 клетей/игровой месяц)
// ползёт со скоростью ~0.000046 клети/сек против 12 клетей/сек у корабля.
// Запас — четверть миллиона раз, за любой мыслимый перелёт цель не сдвинется
// заметно.
//
// Ломается это только на пресетах ускорения из админ-панели
// (client/admin-panel.js): там время сжато в тысячи раз, и снимок цели
// закономерно устаревает. Это инструмент отладки, а не игровой режим, —
// упреждение под него специально не делаем.

// Transit — активный перелёт. Position — чистая функция времени (тот же
// приём, что и у Object.xAt): не тикает сама, а лениво разрешается при
// каждом обращении к кораблю.
type Transit struct {
	Mode string `json:"mode"` // "system" | "interstellar"

	DepartedAt time.Time `json:"departedAt"`
	ArriveAt   time.Time `json:"arriveAt"`

	// Mode == "system": локальные координаты ТЕКУЩЕЙ системы (звезда не меняется).
	// Клиент использует их для анимации — интерполирует From→To по доле
	// (now-DepartedAt)/(ArriveAt-DepartedAt), той же формулой, что уже
	// применяется для звёзд сектора (x = x0 + arc·(t−t0)), только на секундах.
	FromX float64 `json:"fromX"`
	FromY float64 `json:"fromY"`
	ToX   float64 `json:"toX"`
	ToY   float64 `json:"toY"`

	// Mode == "interstellar": секторные (r,x) — снимок на момент отправления
	// и позиция цели В ТОТ ЖЕ момент (без упреждения, см. комментарий выше)
	FromR    float64 `json:"fromR"`
	FromArc  float64 `json:"fromArc"`
	ToR      float64 `json:"toR"`
	ToArc    float64 `json:"toArc"`
	ToStarID int     `json:"toStarId"`

	TargetKind        string `json:"targetKind"` // "star" | "planet"
	TargetPlanetIndex int    `json:"targetPlanetIndex"`
}

// Ship — состояние корабля игрока.
type Ship struct {
	mu sync.RWMutex

	SystemStarID int // звезда текущей системы (0 — только до первой инициализации)
	SX, SY       float64

	AtPlanetIndex int // -1, если корабль не «у» конкретной планеты (у звезды / в точке системы)

	// DockAngleOffset — угол точки причаливания относительно ЦЕНТРА планеты, В
	// ЕЁ СОБСТВЕННОЙ вращающейся системе отсчёта (т.е. отсчитывается от текущего
	// угла самой планеты, а не от звезды). Считается один раз при прокладке
	// курса (Navigate) — по направлению фактического подлёта корабля, а не
	// всегда с одной и той же стороны — и остаётся тем же, пока корабль стоит
	// у планеты: тем самым точка причаливания вращается вместе с планетой
	// (наследует её движение), но с той стороны, откуда корабль реально прилетел.
	DockAngleOffset float64

	Landed            bool
	LandedPlanetIndex int

	Transit *Transit
}

// NewShip размещает корабль в системе заданной звезды, у края области
// (не буквально в центре светила — так безопаснее и живее выглядит).
func NewShip(systemStarID int, sysR float64) *Ship {
	sx := sysR * 0.7
	if sx <= 0 {
		sx = 20
	}
	return &Ship{
		SystemStarID:      systemStarID,
		SX:                sx,
		SY:                0,
		AtPlanetIndex:     -1,
		LandedPlanetIndex: -1,
	}
}

// resolveTransit — если активный перелёт долетел, финализирует его: переносит
// корабль в целевые координаты/систему и снимает Transit. Вызывается в
// начале каждого публичного метода — тот же приём ленивой финализации, что и
// у Sim.Advance для оборота объектов сектора.
func (sh *Ship) resolveTransit(now time.Time) {
	t := sh.Transit
	if t == nil || now.Before(t.ArriveAt) {
		return
	}
	switch t.Mode {
	case "system":
		sh.SX, sh.SY = t.ToX, t.ToY
		if t.TargetKind == "planet" {
			sh.AtPlanetIndex = t.TargetPlanetIndex
			// Планета за время полёта успела сдвинуться по орбите — «прилетели»
			// значит к самой планете, а не к точке, где она была при старте.
			// На игровой скорости сдвиг микроскопический, но на отладочных
			// пресетах (тысячи месяцев в секунду) без этого корабль оказывался
			// в пустоте, а панель уверяла бы, что он «у планеты».
			if x, y, ok := currentPlanetPos(sh.SystemStarID, t.TargetPlanetIndex, sh.DockAngleOffset); ok {
				sh.SX, sh.SY = x, y
			}
		} else {
			sh.AtPlanetIndex = -1
		}
	case "interstellar":
		sh.SystemStarID = t.ToStarID
		sh.SX, sh.SY = 0, 0 // прилёт всегда сначала к звезде — см. комментарий в начале файла
		sh.AtPlanetIndex = -1
	}
	sh.Transit = nil
}

// currentPlanetPos — положение планеты звезды на ТЕКУЩЕЕ игровое время.
// Единая точка правды для сервера: и навигация, и финализация прилёта берут
// координаты отсюда, а не хранят собственную копию (planetPos в planets.go).
func currentPlanetPos(starID, planetIdx int, angleOffset float64) (x, y float64, ok bool) {
	star, found := sim.Object(starID)
	if !found || star.Type != "star" || planetIdx < 0 || planetIdx >= len(star.Planets) {
		return 0, 0, false
	}
	// planetDockPos, не planetPos: «у планеты» значит рядом с ней (на 2/3
	// радиуса запаса за её краем, с той стороны, откуда корабль подлетел), а
	// не в её центре.
	px, py := planetDockPos(star.Planets[planetIdx], clk.Snapshot().Months, angleOffset)
	return px, py, true
}

// ShipView — то, что видит клиент: разрешённое (но не финализированное в
// хранимом состоянии) положение на момент запроса.
type ShipView struct {
	SystemStarID      int      `json:"systemStarId"`
	SX                float64  `json:"sx"`
	SY                float64  `json:"sy"`
	AtPlanetIndex     int      `json:"atPlanetIndex"`
	DockAngleOffset   float64  `json:"dockAngleOffset"` // см. Ship.DockAngleOffset — нужен клиенту, чтобы зеркалить planetDockPos
	Landed            bool     `json:"landed"`
	LandedPlanetIndex int      `json:"landedPlanetIndex"`
	Transit           *Transit `json:"transit,omitempty"`
}

// effectivePos — где корабль НА САМОМ ДЕЛЕ сейчас. Вызывать под замком.
//
// Пока корабль стоит у планеты (или сел на неё), он движется ВМЕСТЕ с ней:
// планета обращается вокруг звезды, и «стоянка у планеты» — это привязка к
// самому телу, а не к точке пространства, где тело когда-то было. Иначе
// планета уезжает по орбите, а корабль остаётся висеть в пустоте — при том
// что панель уверяет, будто он «у планеты».
//
// Хранимые SX/SY используются только когда привязки к планете нет: у звезды,
// в произвольной точке системы или во время перелёта.
func (sh *Ship) effectivePos() (float64, float64) {
	if sh.Transit == nil && sh.AtPlanetIndex >= 0 {
		if x, y, ok := currentPlanetPos(sh.SystemStarID, sh.AtPlanetIndex, sh.DockAngleOffset); ok {
			return x, y
		}
	}
	return sh.SX, sh.SY
}

// Snapshot — текущее состояние для GET /api/ship. Сначала лениво финализирует
// долетевший перелёт (тем же now, что и в ответе), чтобы клиент не увидел
// «повисший» transit с ArriveAt в прошлом.
func (sh *Ship) Snapshot(now time.Time) ShipView {
	sh.mu.Lock()
	sh.resolveTransit(now)
	sx, sy := sh.effectivePos()
	view := ShipView{
		SystemStarID:      sh.SystemStarID,
		SX:                sx,
		SY:                sy,
		AtPlanetIndex:     sh.AtPlanetIndex,
		DockAngleOffset:   sh.DockAngleOffset,
		Landed:            sh.Landed,
		LandedPlanetIndex: sh.LandedPlanetIndex,
		Transit:           sh.Transit,
	}
	sh.mu.Unlock()
	return view
}

var (
	ErrShipBusy       = errors.New("корабль в полёте")
	ErrShipLanded     = errors.New("сначала взлетите")
	ErrNoPlanetHere   = errors.New("рядом нет планеты для посадки")
	ErrAlreadyLanded  = errors.New("уже на поверхности")
	ErrNotLanded      = errors.New("корабль не на поверхности")
	ErrUnknownTarget  = errors.New("неизвестная цель")
	ErrBadPlanetIndex = errors.New("неверный индекс планеты")
)

// Navigate прокладывает курс на звезду (kind="star") или на планету в ТЕКУЩЕЙ
// системе (kind="planet"). Межзвёздный перелёт заканчивается у звезды, не у
// её планеты, — см. комментарий в начале файла: одна команда — одна смена
// системы координат, до планеты у чужой звезды летим вторым шагом.
func (sh *Ship) Navigate(sim *Sim, now time.Time, kind string, starID, planetIdx int) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)

	if sh.Landed {
		return ErrShipLanded
	}
	if sh.Transit != nil {
		return ErrShipBusy
	}

	star, ok := sim.Object(starID)
	if !ok || star.Type != "star" {
		return ErrUnknownTarget
	}

	if starID == sh.SystemStarID {
		// навигация внутри текущей системы. Стартуем оттуда, где корабль
		// реально находится: если он стоял у планеты, та могла уехать по
		// орбите с момента прилёта.
		fx, fy := sh.effectivePos()
		tx, ty := 0.0, 0.0
		flightSec := 0.0
		if kind == "planet" {
			if planetIdx < 0 || planetIdx >= len(star.Planets) {
				return ErrBadPlanetIndex
			}
			// ── упреждение цели ────────────────────────────────────────────
			// Планета не ждёт: целиться в её положение НА МОМЕНТ СТАРТА нельзя,
			// иначе корабль прилетает в точку, которую она давно покинула, — и
			// в момент прилёта его «телепортирует» на настоящее место стоянки.
			// На игровой скорости промах микроскопический, но на отладочных
			// пресетах ускорения (×120) планета уходит на целый корпус, и
			// корабль оказывается снаружи планеты вместо стоянки в её диске.
			//
			// Целимся туда, где планета БУДЕТ к прилёту. Время полёта само
			// зависит от точки прицеливания, поэтому решаем это несколько раз
			// подряд простым приближением: подставили время — получили точку —
			// пересчитали время. Сходится за пару шагов, потому что цель за
			// время полёта смещается много меньше, чем длина самого маршрута.
			p := star.Planets[planetIdx]
			snap := clk.Snapshot()
			dockR := p.Diameter / 2 * dockRadiusFactor
			for i := 0; i < 4; i++ {
				arriveMonths := snap.Months + flightSec*snap.Speed
				pAngle := p.Angle + p.AngVel*arriveMonths
				pcx, pcy := p.Orbit*math.Cos(pAngle), p.Orbit*math.Sin(pAngle)

				// Причаливаем не в центр планеты, а в ближайшую точку
				// пересечения КУРСА корабля (прямая fx,fy → центр планеты) с
				// окружностью причаливания — то есть с той стороны, откуда
				// корабль реально подлетает, а не всегда со стороны звезды.
				dx, dy := pcx-fx, pcy-fy
				dist0 := math.Hypot(dx, dy)
				var ux, uy float64
				if dist0 > 1e-6 {
					ux, uy = dx/dist0, dy/dist0
				} else {
					// вырожденный случай: корабль уже точно в центре планеты —
					// такого не бывает в норме, берём направление от звезды
					ux, uy = math.Cos(pAngle), math.Sin(pAngle)
				}
				tx, ty = pcx-ux*dockR, pcy-uy*dockR
				// угол точки причаливания ОТНОСИТЕЛЬНО планеты (не звезды):
				// пока корабль стоит у неё, он вращается вместе с ней, сохраняя
				// ту же сторону подлёта (currentPlanetPos/effectivePos)
				sh.DockAngleOffset = math.Atan2(ty-pcy, tx-pcx) - pAngle
				flightSec = math.Hypot(tx-fx, ty-fy) / systemSpeed
			}
		} else {
			flightSec = math.Hypot(tx-fx, ty-fy) / systemSpeed
		}
		dur := time.Duration(flightSec * float64(time.Second))
		sh.Transit = &Transit{
			Mode: "system", DepartedAt: now, ArriveAt: now.Add(dur),
			FromX: fx, FromY: fy, ToX: tx, ToY: ty,
			TargetKind: kind, TargetPlanetIndex: planetIdx,
		}
		sh.AtPlanetIndex = -1 // отстыковались: дальше позиция своя, не планеты
		return nil
	}

	// межзвёздный перелёт — снимок позиций на момент старта, без упреждения
	origin, ok := sim.Object(sh.SystemStarID)
	if !ok {
		return ErrUnknownTarget
	}
	gameNow := clk.Snapshot().Months
	fromR, fromX := origin.R, origin.xAt(gameNow)
	toR, toX := star.R, star.xAt(gameNow)
	dist := math.Hypot(toR-fromR, toX-fromX)
	dur := time.Duration(dist / interstellarSpeed * float64(time.Second))
	sh.Transit = &Transit{
		Mode: "interstellar", DepartedAt: now, ArriveAt: now.Add(dur),
		FromR: fromR, FromArc: fromX, ToR: toR, ToArc: toX, ToStarID: starID,
		TargetKind: kind, TargetPlanetIndex: planetIdx,
	}
	return nil
}

// Land высаживает корабль на планету, у которой он сейчас находится
// (AtPlanetIndex ≥ 0). Заглушка — просто переключает флаг, без описания
// поверхности/колонии (ТЗ.md: планетарный интерфейс распишем отдельно).
func (sh *Ship) Land(now time.Time) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)

	if sh.Transit != nil {
		return ErrShipBusy
	}
	if sh.Landed {
		return ErrAlreadyLanded
	}
	if sh.AtPlanetIndex < 0 {
		return ErrNoPlanetHere
	}
	sh.Landed = true
	sh.LandedPlanetIndex = sh.AtPlanetIndex
	return nil
}

// Launch поднимает корабль с поверхности — остаётся в тех же координатах
// (у той же планеты), просто снова доступна навигация.
func (sh *Ship) Launch(now time.Time) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if !sh.Landed {
		return ErrNotLanded
	}
	sh.Landed = false
	return nil
}
