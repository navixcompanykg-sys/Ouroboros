package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"
)

// TestFlightProfile — постоянная проверка (не диагностика) кинематики
// автопилота (flightProfile, ship.go): именно она задаёт, как выглядит полёт
// у игрока — плавный разгон и торможение вместо «телепорта» в цель. Формулы
// продублированы на клиенте (client/world.js transitState), поэтому ошибка
// здесь разъедет сервер и клиент, а не просто испортит число.
func TestFlightProfile(t *testing.T) {
	cases := []struct {
		name                        string
		distanceCells, accel, decel float64
		entrySpeed                  float64
	}{
		{"треугольный профиль с места", 20, 358, 358, 0},
		{"треугольный профиль с хода", 20, 358, 358, 40000},
		{"трапеция с крейсерским участком", 4000, 358, 358, 0},
		{"дальний межзвёздный", 7.4, 25, 25, 0},
		{"цель ближе тормозного пути", 0.01, 25, 25, 200000},
		// подлёт к планете: торможение в гравитационном колодце (navDecelFor)
		{"с гравиторможением у планеты", 20, 358, 3586, 0},
		{"гравиторможение и вход на ходу", 20, 358, 3586, 40000},
		{"гравиторможение на пределе скорости", 4000, 358, 3586, 0},
	}
	for _, c := range cases {
		p := newFlightProfile(c.distanceCells, c.accel, c.decel, c.entrySpeed, math.Inf(1))
		total := p.totalSec()
		if total <= 0 {
			t.Fatalf("%s: нулевая длительность перелёта", c.name)
		}

		// 1. Профиль довозит РОВНО до цели и не дальше.
		gotDist, gotSpeed := p.stateAt(total)
		wantDist := c.distanceCells * screenUE
		if math.Abs(gotDist-wantDist) > wantDist*1e-9 {
			t.Errorf("%s: пройдено %.3f у.е., ожидалось %.3f", c.name, gotDist, wantDist)
		}
		if math.Abs(gotSpeed-p.ExitSpeed) > 1e-6 {
			t.Errorf("%s: скорость на финише %.3f, в профиле %.3f", c.name, gotSpeed, p.ExitSpeed)
		}

		// 2. Старт — ровно с той скорости, что была у корабля в момент
		// команды: разрыв здесь и есть «рывок» при нажатии ЛЕТЕТЬ.
		if _, v0 := p.stateAt(0); math.Abs(v0-c.entrySpeed) > 1e-9 {
			t.Errorf("%s: старт со скорости %.3f, ожидалась %.3f", c.name, v0, c.entrySpeed)
		}

		// 3. Путь монотонно растёт, скорость нигде не отрицательна и не
		// превышает предел (ТЗ.md §2.7.4), интеграл скорости сходится с
		// путём — то есть stateAt действительно одна и та же физика, а не
		// две независимые формулы.
		const steps = 400
		prevDist, numeric := 0.0, 0.0
		dt := total / steps
		for i := 1; i <= steps; i++ {
			at := dt * float64(i)
			d, v := p.stateAt(at)
			if d < prevDist-1e-6 {
				t.Fatalf("%s: путь пошёл назад на t=%.3f", c.name, at)
			}
			if v < -1e-9 || v > speedLimitUE+1e-6 {
				t.Fatalf("%s: скорость %.3f вне [0, %.0f] на t=%.3f", c.name, v, speedLimitUE, at)
			}
			_, vPrev := p.stateAt(at - dt)
			numeric += (v + vPrev) / 2 * dt // трапеции
			prevDist = d
		}
		if math.Abs(numeric-wantDist) > wantDist*1e-3 {
			t.Errorf("%s: интеграл скорости %.3f не сходится с путём %.3f", c.name, numeric, wantDist)
		}

		// 4. Топливо тратится только под тягой — крейсер идёт по инерции
		// (ТЗ_Корабль.md §4.5).
		if p.thrustSec() > total+1e-9 {
			t.Errorf("%s: время под тягой %.3f больше всего перелёта %.3f", c.name, p.thrustSec(), total)
		}
	}
}

// TestTransitHeadingTurn — разворот на курс идёт ОДНОВРЕМЕННО с разгоном и
// заканчивается ровно на курсе маршрута: иначе обзор (камера смотрит по
// курсу, ТЗ_UI.md §2.1.2) скакнёт в момент прилёта.
func TestTransitHeadingTurn(t *testing.T) {
	// Прямой маршрут (без обхода светила) курсом −170°: From→To выбраны так,
	// чтобы направление отрезка и было −170°, — headingAt берёт курс из
	// геометрии маршрута, а не из поля HeadingToDeg.
	dx, dy := math.Cos(-170*math.Pi/180), math.Sin(-170*math.Pi/180)
	tr := &Transit{
		FromX: -dx * 10, FromY: -dy * 10, ToX: 0, ToY: 0,
		Profile: newFlightProfile(10, 300, 300, 0, math.Inf(1)), TimeFactor: 1,
		HeadingFromDeg: 170, HeadingToDeg: -170, TurnSec: 4,
	}
	// Кратчайшая дуга 170° → −170° это +20°, а не −340°.
	if d := shortestAngleDeg(170, -170); math.Abs(d-20) > 1e-9 {
		t.Fatalf("кратчайший поворот %.3f°, ожидалось 20°", d)
	}
	if h := tr.headingAt(2, 0); math.Abs(h-180) > 1e-9 {
		t.Errorf("на середине разворота курс %.3f°, ожидалось 180°", h)
	}
	if h := tr.headingAt(4, 0); math.Abs(h-(-170)) > 1e-9 {
		t.Errorf("по завершении разворота курс %.3f°, ожидалось −170°", h)
	}
	if h := tr.headingAt(tr.Profile.totalSec(), 1); math.Abs(h-(-170)) > 1e-9 {
		t.Errorf("к прилёту курс %.3f°, ожидалось −170°", h)
	}
	// Разворот длиннее самого перелёта сжимается под него (turnSecFor).
	if sec := turnSecFor(0, 180, 25, 3); sec != 3 {
		t.Errorf("разворот не сжат под короткий перелёт: %.3f с", sec)
	}
}

// TestEntrySpeedOnCourse — команда «лететь» на ходу: профиль начинается с
// ПРОЕКЦИИ текущей скорости на курс маршрута (server/ship.go). Идём ровно по
// курсу — скорость сохраняется целиком (никакого рывка «стоп-старт»); летим
// от цели — начинаем с нуля, а не уносимся к ней задним ходом.
func TestEntrySpeedOnCourse(t *testing.T) {
	const v = 50000
	cases := []struct {
		name                  string
		headingRad, courseRad float64
		want                  float64
	}{
		{"ровно по курсу", 0, 0, v},
		{"поперёк курса", 0, math.Pi / 2, 0},
		{"от цели", 0, math.Pi, 0},
		{"под 60°", 0, math.Pi / 3, v / 2},
	}
	for _, c := range cases {
		got := entrySpeedOnCourse(v, c.headingRad, c.courseRad)
		if math.Abs(got-c.want) > 1e-6 {
			t.Errorf("%s: %.3f, ожидалось %.3f", c.name, got, c.want)
		}
	}
	if got := entrySpeedOnCourse(0, 1, 2); got != 0 {
		t.Errorf("со стоянки должен быть ноль, получено %.3f", got)
	}
}

// TestNavigateSnapshotIsFiniteJSON — сквозная проверка того, ЧТО РЕАЛЬНО
// УЕЗЖАЕТ КЛИЕНТУ после команды «лететь»: снимок корабля обязан кодироваться
// в JSON целиком и без NaN/Inf. Появилась после жалобы пользователя «корабль
// исчез, вышла ошибка, связь с сервером оборвалась»: воспроизвести не
// удалось, но именно так этот класс отказа и выглядит снаружи — `encoding/
// json` отказывается кодировать NaN/±Inf, ответ обрывается на полуслове, и
// клиент уходит в оффлайн (см. writeJSON в main.go — теперь такая ошибка ещё
// и логируется, а не глотается молча).
//
// Прогоняет настоящий сектор: перелёт к каждой планете и к звезде своей
// системы, плюс межзвёздный, и на каждом — снимок в нескольких точках
// перелёта (старт/середина/прилёт).
func TestNavigateSnapshotIsFiniteJSON(t *testing.T) {
	clk = NewClock(gameSpeedRealtime)
	sim = NewSim(7)
	forceHabitableCapitals(sim)
	loadEconomy()
	loadShipDefaults()
	initFleets(sim)

	sh := activeShip()
	if sh == nil {
		t.Fatal("флоту не назначен корабль")
	}
	star, ok := sim.Object(sh.SystemStarID)
	if !ok {
		t.Fatalf("звезда #%d не найдена", sh.SystemStarID)
	}

	check := func(t *testing.T, label string) {
		t.Helper()
		now := time.Now()
		view := sh.Snapshot(now)
		b, err := json.Marshal(view)
		if err != nil {
			t.Fatalf("%s: снимок не кодируется в JSON: %v", label, err)
		}
		if bytes.Contains(b, []byte("NaN")) || bytes.Contains(b, []byte("Inf")) {
			t.Fatalf("%s: в снимке NaN/Inf: %s", label, b)
		}
		if view.Transit != nil {
			for _, frac := range []float64{0, 0.5, 1} {
				at := view.Transit.DepartedAt.Add(time.Duration(
					float64(view.Transit.ArriveAt.Sub(view.Transit.DepartedAt)) * frac))
				f, speed, heading := view.Transit.stateAt(at)
				if math.IsNaN(f) || math.IsNaN(speed) || math.IsNaN(heading) ||
					math.IsInf(f, 0) || math.IsInf(speed, 0) || math.IsInf(heading, 0) {
					t.Fatalf("%s: профиль даёт NaN/Inf на доле %.1f", label, frac)
				}
				if f < 0 || f > 1 {
					t.Fatalf("%s: доля пути %.3f вне [0,1] на доле времени %.1f", label, f, frac)
				}
			}
		}
	}

	// Перелёты внутри системы: к звезде и к каждой планете. Между ними
	// перелёт принудительно завершается (иначе второй вернёт ErrShipBusy —
	// это нормальная логика игры, но проверить надо каждую цель).
	// Звезду своей системы целью брать нельзя (ErrStarNotTarget) — проверяем
	// это отдельно, а перелёты гоняем по планетам.
	if err := sh.Navigate(sim, time.Now(), "star", sh.SystemStarID, -1); err != ErrStarNotTarget {
		t.Fatalf("перелёт к своей звезде должен отклоняться, получено: %v", err)
	}
	var targets []struct {
		kind string
		idx  int
	}
	for i := range star.Planets {
		targets = append(targets, struct {
			kind string
			idx  int
		}{"planet", i})
	}
	for _, tg := range targets {
		refuel(sh) // бак рассчитан на пару перелётов (ТЗ.md §2.7.7) — тут проверяется не баланс, а кодирование снимка
		if err := sh.Navigate(sim, time.Now(), tg.kind, sh.SystemStarID, tg.idx); err != nil {
			t.Fatalf("навигация %s#%d: %v", tg.kind, tg.idx, err)
		}
		check(t, fmt.Sprintf("%s#%d", tg.kind, tg.idx))
		sh.mu.Lock()
		sh.resolveTransit(sh.Transit.ArriveAt) // «долетели» — досрочно финализируем
		sh.mu.Unlock()
		check(t, fmt.Sprintf("%s#%d после прилёта", tg.kind, tg.idx))
	}

	// Межзвёздный перелёт — ближайшая другая звезда.
	objects, _ := sim.Snapshot()
	other := 0
	for _, o := range objects {
		if o.Type == "star" && o.ID != sh.SystemStarID {
			other = o.ID
			break
		}
	}
	if other != 0 {
		refuel(sh)
		if err := sh.Navigate(sim, time.Now(), "star", other, -1); err != nil {
			t.Fatalf("межзвёздная навигация: %v", err)
		}
		check(t, "межзвёздный перелёт")
	}
}

// refuel — залить полный бак прямо в состояние корабля (в игре пополнения
// топлива пока нет вовсе, ТЗ.md §2.7.7 — это чисто тестовая заправка).
func refuel(sh *Ship) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.FuelHydrogen = gasStorageFuelCapacity * float64(sh.Physics.GasStorageCount)
	sh.FuelHelium3 = gasStorageFuelCapacity * float64(sh.Physics.GasStorageCount)
}

// TestAvoidStarWaypoint — обход светила: маршрут, проходящий ближе
// starAvoidCells к звезде, ломается на два участка (прямое требование
// пользователя «корабли не приближаются к звёздам, если маршрут пересекает
// звезду, они огибают её»).
func TestAvoidStarWaypoint(t *testing.T) {
	// 1. Маршрут мимо звезды — обходить нечего.
	if _, _, ok := avoidStarWaypoint(10, 10, 10, -10); ok {
		t.Error("маршрут в 10 клетях от звезды не должен ломаться")
	}
	// 2. Маршрут насквозь через звезду — путевая точка ровно на запретном
	// радиусе и перпендикулярно курсу.
	mx, my, ok := avoidStarWaypoint(-10, 0, 10, 0)
	if !ok {
		t.Fatal("маршрут через центр звезды обязан ломаться")
	}
	// Главное требование: ВЕСЬ ломаный маршрут вне запретного радиуса, а не
	// только сама путевая точка на нём (прямые участки от точки снаружи до
	// точки НА окружности всё равно срезали бы угол внутрь — так и было до
	// правки: обход радиусом 2.5 давал реальный подход 2.04 клети).
	if d := math.Min(segmentDistToStar(-10, 0, mx, my), segmentDistToStar(mx, my, 10, 0)); d < starAvoidCells-1e-6 {
		t.Errorf("маршрут подходит к звезде на %.3f клети, запрет %.3f", d, starAvoidCells)
	}
	// 3. Маршрут «задевает» звезду сбоку — точка выталкивается в ту же
	// сторону, куда маршрут отклонялся (обход минимальный, не крюк).
	mx, my, ok = avoidStarWaypoint(-10, 1, 10, 1)
	if !ok {
		t.Fatal("маршрут в 1 клети от звезды обязан ломаться")
	}
	if my <= 0 {
		t.Errorf("обход ушёл не в ту сторону: my=%.3f", my)
	}
	if d := math.Min(segmentDistToStar(-10, 1, mx, my), segmentDistToStar(mx, my, 10, 1)); d < starAvoidCells-1e-6 {
		t.Errorf("маршрут подходит к звезде на %.3f клети, запрет %.3f", d, starAvoidCells)
	}
	// 4. Ломаный маршрут длиннее прямого — обход не бесплатный.
	if l := routeLength(-10, 0, 10, 0); l <= 20 {
		t.Errorf("длина обхода %.3f не больше прямой 20", l)
	}

	// 5. Позиция и курс идут ПО ЛОМАНОМУ пути: середина пути должна быть у
	// путевой точки, а не на прямой между концами (та прошла бы через звезду).
	tr := &Transit{
		FromX: -10, FromY: 1, ToX: 10, ToY: 1,
		HasMid: true, MidX: mx, MidY: my,
		Profile: newFlightProfile(routeLength(-10, 1, 10, 1), 300, 300, 0, math.Inf(1)), TimeFactor: 1,
	}
	minDist := math.MaxFloat64
	for f := 0.0; f <= 1.0001; f += 0.002 {
		x, y := tr.pointAtFrac(f)
		if d := math.Hypot(x, y); d < minDist {
			minDist = d
		}
	}
	if minDist < starAvoidCells-1e-6 {
		t.Errorf("корабль подошёл к звезде на %.3f клети, запрет %.3f", minDist, starAvoidCells)
	}
	// Курс на ломаном маршруте меняется и нигде не прыгает больше, чем на
	// разумный шаг: обзор камеры идёт по этому же курсу.
	prev := tr.courseHeadingAt(0)
	for f := 0.02; f <= 1.0001; f += 0.02 {
		h := tr.courseHeadingAt(f)
		if d := math.Abs(shortestAngleDeg(prev, h)); d > 25 {
			t.Errorf("курс скакнул на %.1f° на доле %.2f", d, f)
		}
		prev = h
	}
}

// TestSystemEdgeRadius — межзвёздный перелёт заканчивается на границе целевой
// системы, а не у светила (прямое требование пользователя). Граница —
// простой минимум из радиуса системы и расстояния до звезды (starDistance
// приходит УЖЕ в экранах, sectorCletsToScreens — вызывающий сторону
// конвертирует до вызова, shipphysics.go): при честной конверсии типичное
// расстояние (≈100 экранов) на порядок больше радиуса системы (35), так что
// минимум сам по себе никогда не оказывается позади старта — раньше здесь
// была доля (systemEdgeShare=0.45) как костыль от смешения единиц (секторные
// клети напрямую как экраны), теперь не нужна.
func TestSystemEdgeRadius(t *testing.T) {
	// Обычный случай: звезда далеко — работает радиус системы целиком.
	if got := systemEdgeRadius(30, sectorCletsToScreens(7.35)); math.Abs(got-30) > 1e-9 {
		t.Errorf("граница %.3f, ожидался радиус системы 30", got)
	}
	// Гипотетически близкая звезда (меньше радиуса системы) — работает
	// расстояние до неё, не радиус.
	if got := systemEdgeRadius(30, 12); math.Abs(got-12) > 1e-9 {
		t.Errorf("граница %.3f, ожидалось расстояние до звезды 12", got)
	}
	// Точка выхода никогда не ближе запретного радиуса звезды.
	if got := systemEdgeRadius(1, 1); got < starAvoidCells {
		t.Errorf("граница %.3f ближе запретного радиуса %.3f", got, starAvoidCells)
	}
	// Граница всегда впереди по курсу: перелёт не может стать отрицательным.
	// Раньше (при смешении единиц) СЫРЫЕ секторные клети типа 7,35 передавали
	// напрямую — на них граница ощутимо приближалась к самой цели; теперь
	// вызывающая сторона обязана сконвертировать в экраны до вызова
	// (sectorCletsToScreens), и на реалистичных расстояниях запас всегда
	// большой (радиус системы 30–35 против типичных ~100 экранов).
	for _, clets := range []float64{7.35, 13.9} {
		d := sectorCletsToScreens(clets)
		if edge := systemEdgeRadius(30, d); edge >= d {
			t.Errorf("при расстоянии %.2f клети (%.2f экр.) граница %.2f оказалась дальше самой цели", clets, d, edge)
		}
	}
}

// TestFuelReserveCoasts — «критический остаток на манёвр»: если топливного
// бюджета (maxThrustSec) не хватает на весь разгон+торможение по кинематике,
// корабль ПРЕКРАЩАЕТ РАЗГОН РАНЬШЕ (ниже пик) и остаток пути идёт по инерции
// (CruiseSec растёт), но ВСЁ РАВНО полностью тормозит (ExitSpeed=0) — прямое
// требование пользователя. Отдельно проверяется совсем крайний случай —
// бюджета не хватает даже на одно только торможение.
func TestFuelReserveCoasts(t *testing.T) {
	const dist, accel, decel = 20.0, 300.0, 300.0
	unlimited := newFlightProfile(dist, accel, decel, 0, math.Inf(1))
	fullThrust := unlimited.thrustSec()

	t.Run("бюджета впритык хватает — профиль не меняется", func(t *testing.T) {
		p := newFlightProfile(dist, accel, decel, 0, fullThrust)
		if math.Abs(p.PeakSpeed-unlimited.PeakSpeed) > 1e-6 {
			t.Errorf("пик %.3f разошёлся с безлимитным %.3f", p.PeakSpeed, unlimited.PeakSpeed)
		}
		if p.CruiseSec > 1e-6 {
			t.Errorf("крейсер %.3f не ожидался — бюджета хватает впритык на полный разгон", p.CruiseSec)
		}
	})

	t.Run("бюджета хватает на стыковку, но не на полный разгон — корабль коастит", func(t *testing.T) {
		budget := fullThrust * 0.5
		p := newFlightProfile(dist, accel, decel, 0, budget)
		if p.PeakSpeed >= unlimited.PeakSpeed {
			t.Errorf("пик %.3f должен быть НИЖЕ безлимитного %.3f — бюджет урезан", p.PeakSpeed, unlimited.PeakSpeed)
		}
		if p.ExitSpeed > 1e-6 {
			t.Errorf("бюджета хватает на полное торможение — ExitSpeed должен быть 0, получено %.3f", p.ExitSpeed)
		}
		if p.CruiseSec <= 0 {
			t.Error("ожидался крейсерский участок («летит по инерции») — его нет")
		}
		if got := p.AccelSec + p.DecelSec; got > budget+1e-6 {
			t.Errorf("потрачено под тягой %.3f с больше бюджета %.3f", got, budget)
		}
		// Профиль обязан всё равно довезти РОВНО до цели.
		gotDist, gotSpeed := p.stateAt(p.totalSec())
		if math.Abs(gotDist-dist*screenUE) > dist*screenUE*1e-6 {
			t.Errorf("пройдено %.3f, ожидалось %.3f", gotDist, dist*screenUE)
		}
		if math.Abs(gotSpeed) > 1e-6 {
			t.Errorf("скорость на финише %.3f, ожидался точный ноль (пришвартовались)", gotSpeed)
		}
	})

	t.Run("бюджета не хватает даже на одно торможение — прилетает с остатком скорости", func(t *testing.T) {
		// Входим на большой скорости с крошечным бюджетом: даже не разгоняясь,
		// затормозить полностью не успеваем.
		entrySpeed := 50000.0
		minDecel := entrySpeed / decel
		budget := minDecel * 0.3
		p := newFlightProfile(dist, accel, decel, entrySpeed, budget)
		if p.AccelSec > 1e-6 {
			t.Errorf("разгон %.3f не ожидался — бюджета не хватает даже на торможение", p.AccelSec)
		}
		if math.Abs(p.DecelSec-budget) > 1e-6 {
			t.Errorf("торможение %.3f должно съесть весь бюджет %.3f", p.DecelSec, budget)
		}
		if p.ExitSpeed <= 0 {
			t.Error("ожидался ненулевой остаток скорости на финише — бюджета на полную остановку не хватило")
		}
		if p.ExitSpeed >= entrySpeed {
			t.Errorf("скорость на финише %.3f не должна превышать стартовую %.3f", p.ExitSpeed, entrySpeed)
		}
	})

	t.Run("нулевой бюджет — либо покой, либо коастинг с самой стартовой скорости", func(t *testing.T) {
		p := newFlightProfile(dist, accel, decel, 1000, 0)
		if p.AccelSec != 0 || p.DecelSec != 0 {
			t.Errorf("при нулевом бюджете не должно быть тяги вовсе: accel=%.3f decel=%.3f", p.AccelSec, p.DecelSec)
		}
		if math.Abs(p.ExitSpeed-1000) > 1e-6 {
			t.Errorf("без тяги скорость не должна меняться: %.3f, ожидалось 1000", p.ExitSpeed)
		}
	})
}

// TestSettleEnergyCycle — квантованная модель энергии/топлива (эта правка,
// заменяет прежнюю continuous burnRateFor целиком): ПРЯМАЯ цитата
// пользователя, дважды поправившего первую версию: «ты исходишь из того что
// жжёт топливо двигатель, но логика такова, что газовое хранилище сжигает
// топливо чтоб произвести энергию которую потребляет обычный двигатель...
// сжигание раз в 60 секунд, единый цикл. В первую очередь двигатель берёт
// энергию из генерации или запаса аккумуляторов, и если не хватает — идёт
// сжигание, но нельзя сжечь 0,3 водорода. Если есть аккумулятор — жжём на
// полную, так как есть куда деть излишек, если нет — жжём меньше и двигатели
// недополучат». Каждый сценарий — отдельная проверяемая часть этой цитаты.
func TestSettleEnergyCycle(t *testing.T) {
	t.Run("реактор один полностью покрывает спрос — бак не расходуется вовсе", func(t *testing.T) {
		p := ShipPhysics{FuelDemand: 40, ReactorPowerGen: 40}
		stock, battery := 100.0, 0.0
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		if ratio < 0.999 {
			t.Errorf("реактор один должен полностью покрыть спрос: ratio=%.4f, ожидался ~1", ratio)
		}
		if stock != 100 {
			t.Errorf("бак вообще не должен тратиться, было 100, стало %.4f", stock)
		}
	})

	t.Run("делёж между несколькими двигателями — дробно, не по целым единицам", func(t *testing.T) {
		// Пример пользователя буквально: «два двигателя максимум могут
		// потребить 10 единиц энергии, значит хватит одного газохранилища...
		// а вот если двигателя три, а газохранилище одно, все три двигателя
		// всё равно выработка будет 10 энергии, и эти 10 разделятся на три
		// двигателя по 3,33». FuelDemand — это УЖЕ суммарный спрос (3×5=15
		// для трёх обычных двигателей мощностью 5); проверяем именно ДОЛЮ.
		p := ShipPhysics{FuelDemand: 15}
		stock, battery := 1.0, 0.0 // ровно 1 единица водорода = 10 энергии
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		wantRatio := 10.0 / 15.0
		if math.Abs(ratio-wantRatio) > 1e-9 {
			t.Errorf("10 энергии на 15 спроса = %.4f доли, получено %.4f", wantRatio, ratio)
		}
		if stock != 0 {
			t.Errorf("без батареи округление вниз всё равно жжёт единственную ЦЕЛУЮ единицу, раз она нужна целиком (10<15): осталось %.4f, ожидался 0", stock)
		}
	})

	t.Run("нехватка не делится ровно, есть аккумулятор — жжём с запасом, излишек банкуется", func(t *testing.T) {
		p := ShipPhysics{FuelDemand: 12, BatteryCapacity: 1000}
		stock, battery := 5.0, 0.0
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		if ratio < 0.999 {
			t.Errorf("с местом в батарее спрос должен покрываться полностью: ratio=%.4f", ratio)
		}
		if stock != 3 {
			t.Errorf("shortfall=12, yield=10 → ceil(12/10)=2 сожжённые единицы, было 5, ожидалось 3, получено %.4f", stock)
		}
		if battery != 8 {
			t.Errorf("излишек 20-12=8 должен уйти в батарею, получено %.4f", battery)
		}
	})

	t.Run("нехватка не делится ровно, аккумулятора нет — жжём по минимуму, недополучают", func(t *testing.T) {
		p := ShipPhysics{FuelDemand: 12, BatteryCapacity: 0}
		stock, battery := 5.0, 0.0
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		if stock != 4 {
			t.Errorf("без батареи округление ВНИЗ — floor(12/10)=1 единица, было 5, ожидалось 4, получено %.4f", stock)
		}
		wantRatio := 10.0 / 12.0
		if math.Abs(ratio-wantRatio) > 1e-9 {
			t.Errorf("покрыто 10 из 12 = %.4f, получено %.4f (двигатели недополучили — это ОЖИДАЕМО)", wantRatio, ratio)
		}
		if battery != 0 {
			t.Errorf("топливо жжётся не в отходы — раз округлили вниз, лишку банковать нечего: battery=%.4f", battery)
		}
	})

	t.Run("гелий-3 закрывает один ионный двигатель ровно, без остатка", func(t *testing.T) {
		// «Гелий сжигание даёт 100 энергии и потребление двигателя 100
		// энергии, так что двигатель сжигает целое» — прямая цитата.
		p := ShipPhysics{FuelDemand: 100}
		stock, battery := 1.0, 0.0
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHelium3, &battery)
		if ratio < 0.999 {
			t.Errorf("1 ед. гелия-3 должна закрыть спрос 100 полностью: ratio=%.4f", ratio)
		}
		if stock != 0 {
			t.Errorf("ровно 1 единица должна сгореть (100/100=1, без остатка ни при округлении вверх, ни вниз): осталось %.4f", stock)
		}
		if battery != 0 {
			t.Errorf("совпадение 1:1 — излишка нет вовсе: battery=%.4f", battery)
		}
	})

	t.Run("бака не хватает на вычисленные единицы — жжём сколько физически есть", func(t *testing.T) {
		p := ShipPhysics{FuelDemand: 100, BatteryCapacity: 1000} // хочет ceil(100/10)=10 единиц
		stock, battery := 3.0, 0.0                               // а в баке только 3
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		if stock != 0 {
			t.Errorf("должны сжечь ВСЕ 3 имеющиеся единицы (нельзя сжечь больше, чем есть): осталось %.4f", stock)
		}
		wantRatio := 30.0 / 100.0
		if math.Abs(ratio-wantRatio) > 1e-9 {
			t.Errorf("3 сожжённые единицы = 30 энергии из 100 спроса = %.4f, получено %.4f", wantRatio, ratio)
		}
	})

	t.Run("батарея уже покрывает часть — реактор+батарея проверяются ПЕРВЫМИ", func(t *testing.T) {
		// «В первую очередь двигатель берёт энергию из генерации или запаса
		// аккумуляторов, и если не хватает — идёт сжигание».
		p := ShipPhysics{FuelDemand: 50, ReactorPowerGen: 20, BatteryCapacity: 1000}
		stock, battery := 10.0, 15.0 // реактор 20 + батарея 15 = 35, не хватает 15 до 50
		ratio := p.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		if ratio < 0.999 {
			t.Errorf("с местом в батарее (после её же разряда) остаток должен покрыться сжиганием: ratio=%.4f", ratio)
		}
		if battery <= 0 {
			t.Errorf("батарея должна была сначала ОТДАТЬ заряд на нехватку, потом принять излишек от сжигания — не может остаться 0 или меньше: battery=%.4f", battery)
		}
	})
}

// TestRetargetMidFlight — смена цели В ПОЛЁТЕ (прямое требование пользователя:
// «нельзя сменить цель в процессе полёта, нужно это разрешить»). Три
// сценария: редирект внутри системы (планета → другая планета), редирект
// внутри системы в межзвёздный (планета → другая звезда), редирект СРЕДИ
// межзвёздного перелёта (звезда → другая звезда) — последний самый
// нетривиальный: корабль в этот момент физически ни в одной системе, точка
// старта нового курса берётся из PendingInterstellarR/Arc, не от звезды
// отправления.
func TestRetargetMidFlight(t *testing.T) {
	clk = NewClock(gameSpeedRealtime)
	sim = NewSim(11)
	forceHabitableCapitals(sim)
	loadEconomy()
	loadShipDefaults()
	initFleets(sim)

	sh := activeShip()
	if sh == nil {
		t.Fatal("флоту не назначен корабль")
	}
	refuel(sh)
	star, ok := sim.Object(sh.SystemStarID)
	if !ok || len(star.Planets) < 2 {
		t.Fatal("нужна звезда минимум с 2 планетами")
	}

	t.Run("планета → другая планета", func(t *testing.T) {
		if err := sh.Navigate(sim, time.Now(), "planet", sh.SystemStarID, 0); err != nil {
			t.Fatalf("первый курс не проложен: %v", err)
		}
		if sh.Transit == nil {
			t.Fatal("Transit не создан")
		}
		mid := sh.Transit.DepartedAt.Add(sh.Transit.ArriveAt.Sub(sh.Transit.DepartedAt) / 3)
		if err := sh.Navigate(sim, mid, "planet", sh.SystemStarID, 1); err != nil {
			t.Fatalf("смена цели в полёте отклонена: %v", err)
		}
		if sh.Transit == nil || sh.Transit.TargetPlanetIndex != 1 {
			t.Fatal("новый Transit не ведёт к планете 1")
		}
		// Новый маршрут должен стартовать НЕ от точки первоначального
		// отправления (fromX/fromY первого Transit), а от места, докуда
		// корабль реально долетел за треть пути.
		if sh.Transit.FromX == 0 && sh.Transit.FromY == 0 {
			t.Error("похоже, маршрут начался от нуля, а не от текущей позиции корабля")
		}
	})

	t.Run("планета → другая звезда (редирект в интерстеллар)", func(t *testing.T) {
		refuel(sh)
		if err := sh.Navigate(sim, time.Now(), "planet", sh.SystemStarID, 0); err != nil {
			t.Fatalf("первый курс не проложен: %v", err)
		}
		objects, _ := sim.Snapshot()
		var target *Object
		for _, o := range objects {
			if o.Type == "star" && o.ID != sh.SystemStarID {
				target = o
				break
			}
		}
		if target == nil {
			t.Fatal("не нашлось другой звезды")
		}
		mid := sh.Transit.DepartedAt.Add(sh.Transit.ArriveAt.Sub(sh.Transit.DepartedAt) / 3)
		if err := sh.Navigate(sim, mid, "star", target.ID, -1); err != nil {
			t.Fatalf("редирект в интерстеллар отклонён: %v", err)
		}
		if sh.Transit == nil || sh.Transit.Mode != "interstellar" {
			t.Fatal("новый Transit не интерстелларный")
		}
	})

	t.Run("звезда → другая звезда среди интерстеллара", func(t *testing.T) {
		refuel(sh)
		objects, _ := sim.Snapshot()
		var target1, target2 *Object
		for _, o := range objects {
			if o.Type == "star" && o.ID != sh.SystemStarID {
				if target1 == nil {
					target1 = o
				} else if target2 == nil && o.ID != target1.ID {
					target2 = o
					break
				}
			}
		}
		if target1 == nil || target2 == nil {
			t.Fatal("нужно минимум 2 других звезды")
		}
		if err := sh.Navigate(sim, time.Now(), "star", target1.ID, -1); err != nil {
			t.Fatalf("первый интерстеллар не проложен: %v", err)
		}
		if sh.Transit.Mode != "interstellar" {
			t.Fatal("ожидался интерстелларный Transit")
		}
		mid := sh.Transit.DepartedAt.Add(sh.Transit.ArriveAt.Sub(sh.Transit.DepartedAt) / 3)
		firstFromR, firstFromArc := sh.Transit.FromR, sh.Transit.FromArc
		if err := sh.Navigate(sim, mid, "star", target2.ID, -1); err != nil {
			t.Fatalf("редирект среди интерстеллара отклонён: %v", err)
		}
		if sh.Transit == nil || sh.Transit.Mode != "interstellar" || sh.Transit.ToStarID != target2.ID {
			t.Fatal("новый Transit не ведёт к target2")
		}
		// Точка старта ВТОРОГО перелёта обязана отличаться от точки старта
		// ПЕРВОГО — иначе редирект тихо проигнорировал пройденный путь и
		// начал маршрут заново от звезды отправления.
		if sh.Transit.FromR == firstFromR && sh.Transit.FromArc == firstFromArc {
			t.Error("новый маршрут стартовал от той же точки, что первый — прогресс полёта не учтён")
		}
		// Попытка выбрать ПЛАНЕТУ среди интерстеллара должна быть отклонена —
		// корабль физически ни в одной системе.
		if err := sh.Navigate(sim, mid, "planet", target1.ID, 0); err != ErrNoSystemContext {
			t.Errorf("ожидался ErrNoSystemContext при выборе планеты среди интерстеллара, получено: %v", err)
		}
	})
}

// TestCurvedTurnPosition — реальный разворот В ДВИЖЕНИИ, не «нос крутится на
// месте, пока позиция едет по прямой» (прямая жалоба пользователя: «линия
// траектории сразу показывает куда, а не реальную траекторию — корабль с
// округлой траекторией»).
func TestCurvedTurnPosition(t *testing.T) {
	// Маршрут строго вдоль +X (курс 0°), корабль стартует, смотря строго
	// поперёк (90°) — большой разворот на 90°, будет заметен на дуге.
	tr := &Transit{
		FromX: 0, FromY: 0, ToX: 100, ToY: 0,
		Profile:        newFlightProfile(0.0001, 300, 300, 0, math.Inf(1)),
		TimeFactor:     1,
		HeadingFromDeg: 90, HeadingToDeg: 0,
		TurnSec: 3,
	}
	// Кинематическая дистанция ОБЯЗАНА совпадать с геометрической (Hypot
	// FromX/Y→ToX/Y = 100) — как и в реальном Navigate, где оба берутся из
	// одного и того же расстояния (routeLength/distScreens). Несовпадение
	// здесь означало бы Transit, который в игре никогда не возникает.
	tr.Profile = newFlightProfile(100, 300, 300, 0, math.Inf(1))
	if tr.Profile.totalSec() <= tr.TurnSec {
		t.Fatal("тестовый перелёт должен быть длиннее фазы разворота")
	}

	t.Run("в начале движения корабль идёт НЕ по прямой к цели", func(t *testing.T) {
		// На старте курс 90° (вверх), а не 0° (к цели) — если бы позиция ехала
		// по прямой к цели с первого мгновения (старое поведение), через
		// маленький dt точка легла бы точно на ось X (y≈0). При настоящем
		// развороте в движении на раннем шаге корабль ещё держит курс,
		// близкий к 90°, — заметное смещение по Y.
		x, y := tr.positionAt(0.3)
		if math.Abs(y) < 1e-6 {
			t.Fatalf("y=%.6f — движение сразу пошло по прямой к цели (x=%.6f), разворот не учтён", y, x)
		}
		if x < 0 {
			t.Errorf("x=%.6f — корабль не должен двигаться НАЗАД от старта", x)
		}
	})

	t.Run("хорда короче дуги — разворот не бесплатен по пути", func(t *testing.T) {
		turnX, turnY := tr.positionAt(tr.TurnSec)
		chord := math.Hypot(turnX-tr.FromX, turnY-tr.FromY)
		arcLen, _ := tr.Profile.stateAt(tr.TurnSec)
		if chord >= arcLen-1e-9 {
			t.Errorf("хорда %.3f не короче дуги %.3f — разворот получился «бесплатным»", chord, arcLen)
		}
	})

	t.Run("после разворота корабль всё равно приезжает ровно в цель", func(t *testing.T) {
		x, y := tr.positionAt(tr.Profile.totalSec())
		if math.Abs(x-tr.ToX) > 1e-6 || math.Abs(y-tr.ToY) > 1e-6 {
			t.Errorf("финиш (%.6f, %.6f), ожидалась цель (%.1f, %.1f)", x, y, tr.ToX, tr.ToY)
		}
	})

	t.Run("позиция непрерывна на стыке фаз разворот→прямая", func(t *testing.T) {
		eps := 1e-4
		xBefore, yBefore := tr.positionAt(tr.TurnSec - eps)
		xAfter, yAfter := tr.positionAt(tr.TurnSec + eps)
		if math.Hypot(xAfter-xBefore, yAfter-yBefore) > 0.05 {
			t.Errorf("разрыв на стыке TurnSec: до (%.4f,%.4f), после (%.4f,%.4f)", xBefore, yBefore, xAfter, yAfter)
		}
	})

	t.Run("на маршруте без разворота (TurnSec=0) поведение как раньше", func(t *testing.T) {
		straight := &Transit{
			FromX: 0, FromY: 0, ToX: 100, ToY: 0,
			Profile: newFlightProfile(100, 300, 300, 0, math.Inf(1)), TimeFactor: 1,
			HeadingFromDeg: 0, HeadingToDeg: 0, TurnSec: 0,
		}
		half := straight.Profile.totalSec() / 2
		xCurved, yCurved := straight.positionAt(half)
		xStraight, yStraight := straight.pointAtFrac(0.5)
		if math.Hypot(xCurved-xStraight, yCurved-yStraight) > 1.0 {
			t.Errorf("без разворота positionAt (%.3f,%.3f) разошёлся с pointAtFrac (%.3f,%.3f)", xCurved, yCurved, xStraight, yStraight)
		}
	})
}
