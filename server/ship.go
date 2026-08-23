package main

import (
	"errors"
	"math"
	"math/rand"
	"sync"
	"time"
)

// ════════════════════════════════════════════════════════════════════════════
// КОРАБЛЬ ИГРОКА — тип Ship, состояние ОДНОГО корабля. Раньше был ровно один
// такой объект на весь сервер («один глобальный корабль»); с правкой,
// давшей каждому из 4 флотов свой настоящий *Ship (fleets.go), это уже не
// так буквально — но принцип не изменился: источник истины на сервере,
// клиент только отображает (CLAUDE.md — «два устройства видят одну и ту же
// галактику»), «активный» флот один общий на весь сервер (аккаунтов
// по-прежнему нет — см. fleets.go), а не свой у каждого подключённого
// устройства.
//
// Время полёта — РЕАЛЬНЫЕ секунды (time.Now()), а не игровые месяцы Clock
// напрямую (месяцы — для дрейфа звёзд/орбит, ТЗ_UI.md §2, секунды — для
// «полёта в реальном времени»). НО темп этих секунд теперь завязан на тот же
// множитель ускорения, что и Clock (timeAccelFactor ниже) — ИСПРАВЛЕНО по
// прямой жалобе пользователя: «ускорение времени действует на движение
// планет, но не действует на скорость корабля, это нарушает принцип
// универсальности времени». Раньше корабль буквально жил на своих часах,
// независимо от Clock/Sim (было точно так написано здесь) — теперь при ×120
// в админ-панели физика корабля (settleFlight/settleLifeSupport/Navigate)
// тоже идёт в ×120 раз быстрее, а не только орбиты. Реализовано БЕЗ полного
// повторения Clock-механизма накопленного времени с плавающим множителем
// (это потребовало бы переводить Transit.ArriveAt/FlightControl.ChangedAt из
// абсолютных time.Time в накопленное «время корабля» — большой рефактор):
// вместо этого elapsed real-time МАСШТАБИРУЕТСЯ ТЕКУЩИМ множителем в момент
// вычисления — точно для settleFlight/settleLifeSupport (лениво
// пересчитываются на каждое обращение, поэтому всегда берут АКТУАЛЬНЫЙ
// множитель на момент вызова), приближённо для Navigate/EstimateTravel
// (длительность Transit фиксируется ОДНИМ множителем на момент прокладки
// курса — смена скорости в админ-панели ПОСЛЕ старта перелёта на его
// оставшееся время уже не повлияет, тот же класс упрощения, что и
// «межзвёздный перелёт без упреждения» ниже).
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

// timeAccelFactor — во сколько раз игровое время сейчас идёт быстрее
// «нормального реального» (Clock.speed / gameSpeedRealtime, clock.go) —
// 1.0 на обычной скорости, ×120 на соответствующем пресете админ-панели.
// Обращается к пакетному глобальному `clk` напрямую — тот же приём, что уже
// применён к `sim` в Navigate/EstimateTravel этого файла. Гарантированно >0
// (clk.speed зажат в [0,maxSpeed] в SetSpeed, но 0 — валидная пауза; здесь
// подстрахованы отдельно, см. вызывающих).
func timeAccelFactor() float64 {
	return clk.Snapshot().Speed / gameSpeedRealtime
}

// ── кинематический профиль автопилота ──────────────────────────────────────
//
// flightProfile — разгон → (опционально) крейсер на пределе скорости →
// ТОРМОЖЕНИЕ до нуля: прибытие стыковкой, а не пролётом мимо на инерции.
//
// ИСПРАВЛЕНО по прямой жалобе пользователя («при нажатии кнопки ЛЕТЕТЬ
// корабль как бы телепортируется, и то же при торможении перед планетой»):
// прежняя версия возвращала из этих формул ТОЛЬКО длительность перелёта, а
// сам профиль скорости нигде не жил — ни сервер (Ship.Speed в перелёте
// оставался тем, чем был, обычно 0), ни клиент (интерполировал From→To
// ЛИНЕЙНО по времени) о нём не знали. Наружу это и выглядело телепортацией:
// в момент старта корабль мгновенно приобретал среднюю скорость маршрута, в
// момент прилёта так же мгновенно её терял, а всё, что показывает скорость
// игроку (звёздный фон, показание HUD, пунктир траектории), в перелёте
// честно считало, что корабль стоит на месте.
//
// Теперь профиль — самостоятельная величина: он уезжает в Transit целиком
// (Transit.Profile), сервер отдаёт по нему живые Speed/Heading в снимке, а
// клиент по тем же полям ведёт позицию между опросами (client/world.js
// transitState — зеркало stateAt ниже).
//
// EntrySpeed — скорость В МОМЕНТ ПРОКЛАДКИ курса: команда «лететь», отданная
// на ходу, больше не гасит скорость мгновенно (ещё один источник «рывка»),
// профиль просто начинается с неё. ExitSpeed в норме 0; ненулевым он выходит
// только в вырожденном случае «до цели ближе, чем тормозной путь» — тогда
// корабль честно прилетает с остатком скорости, а не гасит её волшебством.
type flightProfile struct {
	AccelUE    float64 `json:"accelUe"`    // у.е./с² на разгоне
	DecelUE    float64 `json:"decelUe"`    // у.е./с² на торможении (у планеты — с гравитационной помощью, см. newFlightProfile)
	EntrySpeed float64 `json:"entrySpeed"` // у.е. на старте
	PeakSpeed  float64 `json:"peakSpeed"`  // у.е. в конце разгона / на крейсерском участке
	ExitSpeed  float64 `json:"exitSpeed"`  // у.е. в момент прилёта (в норме 0)
	AccelSec   float64 `json:"accelSec"`   // с «времени корабля» под тягой на разгон
	CruiseSec  float64 `json:"cruiseSec"`  // с по инерции на пределе скорости
	DecelSec   float64 `json:"decelSec"`   // с под тягой на торможение
	DistanceUE float64 `json:"distanceUe"` // длина маршрута, у.е.
}

// newFlightProfile — построить профиль. Торможение задаётся ОТДЕЛЬНЫМ
// ускорением: у планеты автопилот тормозит с гравитационной помощью
// (gravityBrakeMultiplier — та же константа, что у ручного торможения,
// ТЗ.md §2.7.6), и подлёт перестаёт занимать столько же времени, сколько
// разгон. Для целей без гравитационного колодца (звезда, точка в пустоте)
// decelUE == accelUE — профиль остаётся симметричным.
// fuelReserveThrustSec — критический резерв автопилота: столько СЕКУНД ПОД
// ТЯГОЙ (в единицах реального расхода бака, не «трубы») автопилот всегда
// оставляет НЕТРОНУТЫМИ на сам перелёт — для стыковки/манёвра после прилёта,
// на непредвиденное. Прямое требование пользователя: «расчёт полёта должен
// учитывать критический остаток топлива на манёврирование и в определённый
// момент прекращать ускорение и просто лететь по инерции». Тот же
// 60-секундный ориентир, что и период сжигания (shipphysics.go
// energyCyclePeriodSec) — не отдельная придуманная константа, единая
// «минута» на весь топливный учёт.
const fuelReserveThrustSec = 60.0

// maxThrustSecFor — сколько секунд под тягой МОЖЕТ потратить автопилот на
// САМ перелёт, оставив fuelReserveThrustSec про запас — обёртка над
// ShipPhysics.estimateMaxThrustSec (квантованная модель, shipphysics.go): у
// автопилота нет своего «текущего» топливного цикла, поэтому оценка всегда
// СИМУЛИРУЕТСЯ заново от РЕАЛЬНОГО запаса/заряда батареи на этот момент
// (не от sh.FuelCycleAccumSec/FuelRatio ручного полёта — те про другой,
// уже урегулированный цикл).
func (sh *Ship) maxThrustSecFor(fuelKey string) float64 {
	var fuelStock float64
	switch fuelKey {
	case "hydrogen":
		fuelStock = sh.FuelHydrogen
	case "helium3":
		fuelStock = sh.FuelHelium3
	default:
		return math.Inf(1)
	}
	return sh.Physics.estimateMaxThrustSec(fuelStock, sh.BatteryCharge, fuelUnitYieldFor(fuelKey), fuelReserveThrustSec)
}

// maxThrustSec — КРИТИЧЕСКИЙ ОСТАТОК ТОПЛИВА НА МАНЁВР (эта правка, по
// прямому требованию пользователя: «расчёт полёта должен учитывать
// критический остаток топлива на маневрирование и в определённый момент
// прекращать ускорение и просто лететь по инерции»). Вызывающий (Navigate/
// EstimateTravel) переводит «сколько топлива МОЖНО потратить на этот
// перелёт» (реальный бак минус резерв, см. fuelReserveThrustSec) в СЕКУНДЫ
// под тягой той же симуляцией циклов, что и реальное списание — если бы
// здесь считали иначе, профиль обещал бы одно, а бак тратил бы другое.
// math.Inf(1) — «топливо не ограничивает» (манёвр в реальном мире мимо
// планеты и т.п., где эта проверка не участвует).
func newFlightProfile(distanceCells, accelUE, decelUE, entrySpeed, maxThrustSec float64) flightProfile {
	if entrySpeed < 0 {
		entrySpeed = 0
	}
	if decelUE <= 0 {
		decelUE = accelUE
	}
	if maxThrustSec < 0 {
		maxThrustSec = 0
	}
	p := flightProfile{
		AccelUE: accelUE, DecelUE: decelUE,
		EntrySpeed: entrySpeed, PeakSpeed: entrySpeed, ExitSpeed: entrySpeed,
		DistanceUE: distanceCells * screenUE,
	}
	if accelUE <= 0 || p.DistanceUE <= 0 {
		return p
	}
	a, d, s, v0 := accelUE, decelUE, p.DistanceUE, entrySpeed

	if v0*v0 > 2*d*s {
		// до цели ближе, чем тормозной путь — тормозим всю дорогу. Топлива
		// на это тоже может не хватить (эта правка): тогда торможение
		// обрывается на maxThrustSec, и корабль долетает с БОЛЬШИМ остатком
		// скорости, чем позволила бы одна только геометрия.
		fullDecelSec := (v0 - math.Sqrt(v0*v0-2*d*s)) / d
		decelSec := math.Min(fullDecelSec, maxThrustSec)
		p.DecelSec = decelSec
		p.ExitSpeed = math.Max(0, v0-d*decelSec)
		return p
	}

	// Пик профиля БЕЗ учёта топлива (только дистанция+предел скорости): разгон
	// и торможение делят путь так, что (v²−v0²)/2a + v²/2d = s
	// ⇒ v² = (2ads + d·v0²)/(a+d).
	peak := math.Sqrt((2*a*d*s + d*v0*v0) / (a + d))
	if peak > speedLimitUE {
		peak = speedLimitUE
	}
	accelSec := (peak - v0) / a
	decelSec := peak / d

	if accelSec+decelSec > maxThrustSec {
		// Топлива физически не хватает на весь разгон+торможение по этой
		// дистанции — «критический остаток на манёвр» (резерв уже вычтен из
		// maxThrustSec снаружи). minDecelSec — сколько СЕКУНД под тягой нужно
		// только чтобы затормозить с ТЕКУЩЕЙ скорости до нуля, вообще не
		// разгоняясь дальше — тот предел, ниже которого «долетаем и
		// стыкуемся» уже невозможно ни при каком манёвре.
		minDecelSec := v0 / d
		if minDecelSec <= maxThrustSec {
			// Бюджета хватает на полную стыковку (ExitSpeed=0), просто пик
			// ниже, чем позволила бы одна геометрия — корабль ПРЕКРАЩАЕТ
			// РАЗГОН РАНЬШЕ (или не разгоняется совсем, если бюджет впритык
			// на одно только торможение) и остаток дистанции идёт по инерции
			// (CruiseSec ниже) — ровно то самое требование пользователя.
			peak = math.Max(v0, (maxThrustSec*a*d+v0*d)/(a+d))
			accelSec = (peak - v0) / a
			decelSec = peak / d
		} else {
			// Даже НЕ разгоняясь, тормозить до конца не хватает топлива —
			// торможение обрывается на maxThrustSec, дальше корабль летит по
			// инерции с ненулевой скоростью (не может состыковаться чисто).
			exitSpeed := math.Max(0, v0-d*maxThrustSec)
			distDuringBrake := (v0*v0 - exitSpeed*exitSpeed) / (2 * d)
			remaining := math.Max(0, s-distDuringBrake)
			p.PeakSpeed = v0
			p.AccelSec = 0
			p.DecelSec = maxThrustSec
			p.ExitSpeed = exitSpeed
			if exitSpeed > 1e-9 {
				p.CruiseSec = remaining / exitSpeed
			}
			return p
		}
	}

	p.PeakSpeed = peak
	p.AccelSec = accelSec
	p.DecelSec = decelSec
	distAcc := (peak*peak - v0*v0) / (2 * a)
	distDec := peak * peak / (2 * d)
	remaining := math.Max(0, s-distAcc-distDec)
	if peak > 0 {
		p.CruiseSec = remaining / peak
	}
	return p
}

// totalSec — вся длительность перелёта во «времени корабля» (не в реальных
// секундах ожидания игрока: те получаются делением на множитель ускорения
// времени, см. Transit.TimeFactor).
func (p flightProfile) totalSec() float64 { return p.AccelSec + p.CruiseSec + p.DecelSec }

// thrustSec — время ПОД ТЯГОЙ (разгон+торможение): тормозить движком так же
// затратно, как разгоняться (тот же движок жжёт то же топливо в обратную
// сторону — settleFlight делает это тождественно через Control.Brake).
// Крейсерский участок идёт по инерции и топлива не ест (ТЗ_Корабль.md §4.5).
func (p flightProfile) thrustSec() float64 { return p.AccelSec + p.DecelSec }

// stateAt — пройденный путь (у.е.) и скорость на момент t секунд «времени
// корабля» от старта. Зеркало на клиенте — client/world.js transitState.
func (p flightProfile) stateAt(t float64) (distUE, speed float64) {
	if t <= 0 {
		return 0, p.EntrySpeed
	}
	if t >= p.totalSec() {
		return p.DistanceUE, p.ExitSpeed
	}
	if t <= p.AccelSec {
		return p.EntrySpeed*t + 0.5*p.AccelUE*t*t, p.EntrySpeed + p.AccelUE*t
	}
	distAcc := p.EntrySpeed*p.AccelSec + 0.5*p.AccelUE*p.AccelSec*p.AccelSec
	t -= p.AccelSec
	if t <= p.CruiseSec {
		return distAcc + p.PeakSpeed*t, p.PeakSpeed
	}
	t -= p.CruiseSec
	return distAcc + p.PeakSpeed*p.CruiseSec + p.PeakSpeed*t - 0.5*p.DecelUE*t*t, p.PeakSpeed - p.DecelUE*t
}

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

	// Путевая точка обхода звезды (эта правка): прямой маршрут, проходящий
	// ближе starAvoidCells к светилу, ломается на два участка — корабль
	// огибает звезду, а не режет её насквозь (прямое требование
	// пользователя). HasMid == false — маршрут обычный, прямой.
	HasMid bool    `json:"hasMid"`
	MidX   float64 `json:"midX"`
	MidY   float64 `json:"midY"`

	// Mode == "interstellar": секторные (r,x) — снимок на момент отправления
	// и позиция цели В ТОТ ЖЕ момент (без упреждения, см. комментарий выше)
	FromR    float64 `json:"fromR"`
	FromArc  float64 `json:"fromArc"`
	ToR      float64 `json:"toR"`
	ToArc    float64 `json:"toArc"`
	ToStarID int     `json:"toStarId"`

	// Куда именно корабль выйдет в целевой системе (её локальные координаты,
	// эта правка): НЕ к звезде, а на границу системы со стороны подлёта —
	// прямое требование пользователя «нужно чтоб летел к краю системы и
	// заканчивал маршрут там, а уж потом игрок выберет планету».
	ArriveLocalX float64 `json:"arriveLocalX"`
	ArriveLocalY float64 `json:"arriveLocalY"`

	TargetKind        string `json:"targetKind"` // "star" | "planet"
	TargetPlanetIndex int    `json:"targetPlanetIndex"`

	// ── кинематика перелёта (эта правка, см. flightProfile выше) ───────────
	// Profile — разгон/крейсер/торможение маршрута; TimeFactor — множитель
	// ускорения игрового времени, зафиксированный на момент прокладки курса
	// (ТЗ.md §2.7.4, приближение — см. шапку файла): «время корабля» =
	// (now−DepartedAt)·TimeFactor. Клиент по этим двум полям ведёт позицию и
	// скорость сам, БЕЗ линейной интерполяции по времени, которой раньше
	// объяснялся «телепорт» на старте и мгновенная остановка у планеты.
	Profile    flightProfile `json:"profile"`
	TimeFactor float64       `json:"timeFactor"`

	// Курс: HeadingFromDeg — куда корабль смотрел в момент команды,
	// HeadingToDeg — направление самого маршрута, TurnSec — за сколько секунд
	// «времени корабля» разворот завершится (по штатной скорости поворота
	// корабля, turnRateDegFor). Разворот идёт ОДНОВРЕМЕННО с разгоном, а не
	// отдельной фазой: длительность перелёта от него не зависит, зато камера
	// (client/ship.html applySpaceRotation) доворачивается плавно вместо
	// мгновенного скачка обзора в момент нажатия «ЛЕТЕТЬ».
	HeadingFromDeg float64 `json:"headingFromDeg"`
	HeadingToDeg   float64 `json:"headingToDeg"`
	TurnSec        float64 `json:"turnSec"`

	// CoastSec — эта правка, «уворот» (Ship.Dodge, по прямому требованию
	// пользователя): первые CoastSec секунд «времени корабля» полёт идёт БЕЗ
	// ТЯГИ, по прямой, на скорости/курсе, с которыми маршрут начался
	// (HeadingFromDeg, Profile.EntrySpeed) — честная цена манёвра уворота,
	// расписание прилёта реально сдвигается позже, а не просто визуальный
	// штраф. 0 у любого обычного перелёта (Navigate) — вся кинематика
	// начинается с тяги немедленно, как и раньше. Разгон/поворот к цели
	// (Profile/TurnSec выше) начинаются ПОСЛЕ этого окна, посчитаны от
	// ОСТАВШЕЙСЯ дистанции (полная минус пройденная накатом) — см.
	// stateAt/headingAt/positionAt ниже, все трое обёрнуты одним и тем же
	// приёмом («время после каста — это тот же расчёт, что и без каста,
	// просто от новой точки старта и меньшего t»), чтобы не заводить
	// отдельную кинематику специально под уворот.
	CoastSec float64 `json:"coastSec,omitempty"`
}

// coastEndpoint — где заканчивается фаза наката (CoastSec) и с какой
// суммарной ДОЛЕЙ ПУТИ (относительно ПОЛНОЙ дистанции — накат + сам профиль)
// это совпадает. Общая точка, которой пользуются stateAt/headingAt/positionAt
// ниже, чтобы не считать накат трижды по-разному.
func (t *Transit) coastEndpoint() (x, y, totalDist, coastDist float64) {
	x, y = t.coastPositionAt(t.CoastSec)
	coastDist = t.Profile.EntrySpeed * t.CoastSec // у.е. — та же шкала, что Profile.DistanceUE
	totalDist = coastDist + t.Profile.DistanceUE
	return
}

// coastPositionAt — позиция НА МОМЕНТ ts секунд наката (0 ≤ ts ≤ CoastSec):
// прямая линия от FromX/FromY курсом HeadingFromDeg на скорости
// Profile.EntrySpeed (тяги нет — курс/скорость не меняются).
func (t *Transit) coastPositionAt(ts float64) (x, y float64) {
	headingRad := t.HeadingFromDeg * math.Pi / 180
	cellsPerSec := t.Profile.EntrySpeed / screenUE
	return t.FromX + cellsPerSec*math.Cos(headingRad)*ts, t.FromY + cellsPerSec*math.Sin(headingRad)*ts
}

// afterCoast — «под-Transit» БЕЗ CoastSec, с той же кинематикой (Profile),
// но точкой старта — ГДЕ НАКАТ ЗАКОНЧИЛСЯ, а не исходным FromX/FromY. Все
// три функции состояния (stateAt/headingAt/positionAt) для ts>CoastSec
// делегируют сюда с ts−CoastSec — тот же расчёт, что и у обычного (без
// уворота) перелёта, просто от сдвинутой точки и меньшего времени.
func (t *Transit) afterCoast() *Transit {
	sub := *t
	sub.CoastSec = 0
	sub.FromX, sub.FromY, _, _ = t.coastEndpoint()
	return &sub
}

// ── звезда как препятствие ────────────────────────────────────────────────
// По прямому требованию пользователя: «корабли не приближаются к звёздам, и
// если маршрут пересекает звезду, они огибают её; звезду нельзя выбрать
// целью полёта буквально». Радиус самой звезды — 2 клети (ТЗ.md §2.8),
// запретный радиус чуть больше; выше поднимать нельзя — ближайшие орбиты
// планет начинаются с 3 клетей (planets.go orbitStep 4±1), и корабль
// перестал бы к ним долетать.
const (
	starAvoidCells   = 2.5  // ближе этого к центру звезды маршрут не проходит
	cornerBlendCells = 0.35 // на скольких клетях пути сглаживается поворот на путевой точке
)

// legLengths — длины двух участков маршрута в клетях (второй — 0, если
// огибать нечего).
func (t *Transit) legLengths() (l1, l2 float64) {
	if !t.HasMid {
		return math.Hypot(t.ToX-t.FromX, t.ToY-t.FromY), 0
	}
	return math.Hypot(t.MidX-t.FromX, t.MidY-t.FromY),
		math.Hypot(t.ToX-t.MidX, t.ToY-t.MidY)
}

// pointAtFrac — точка маршрута по доле ПРОЙДЕННОГО ПУТИ (не времени): с
// путевой точкой маршрут ломаный, и линейная интерполяция From→To срезала бы
// угол ровно там, где корабль обходит звезду. Зеркало на клиенте —
// client/world.js transitPointAt.
func (t *Transit) pointAtFrac(frac float64) (x, y float64) {
	l1, l2 := t.legLengths()
	total := l1 + l2
	if total <= 0 {
		return t.ToX, t.ToY
	}
	d := frac * total
	if d <= l1 || l2 <= 0 {
		k := 0.0
		if l1 > 0 {
			k = d / l1
		}
		if k > 1 {
			k = 1
		}
		return t.FromX + (t.MidOrTo(0)-t.FromX)*k, t.FromY + (t.MidOrTo(1)-t.FromY)*k
	}
	k := (d - l1) / l2
	if k > 1 {
		k = 1
	}
	return t.MidX + (t.ToX-t.MidX)*k, t.MidY + (t.ToY-t.MidY)*k
}

// positionAt — позиция на момент ts секунд «времени корабля», С УЧЁТОМ
// разворота В ДВИЖЕНИИ (эта правка, по прямой жалобе пользователя: «когда
// корабль поворачивает, линия траектории сразу показывает куда, а не
// реальную траекторию — корабль должен идти с округлой траекторией»).
//
// pointAtFrac (выше) считал позицию ЧИСТО по пройденному РАССТОЯНИЮ вдоль
// прямой (или ломаной) линии от старта до цели — независимо от курса,
// который в это же время ОТДЕЛЬНО поворачивался от HeadingFromDeg к
// HeadingToDeg за TurnSec (headingAt). Эти два расчёта были никак не
// связаны: нос разворачивался НА МЕСТЕ, пока позиция уже ехала по прямой к
// цели — выглядело как рывок направления, а не разворот в полёте.
//
// Честной замкнутой формулы для ОДНОВРЕМЕННЫХ разгона и поворота не
// существует (см. комментарий у FlightControl — интеграл Френеля,
// элементарной первообразной нет), поэтому фаза разворота [0, TurnSec]
// считается ЧИСЛЕННО (integrateTurn, тот же приём, что settleFlight,
// physicsStepSec) — суммарная ДЛИНА ДУГИ у неё совпадает с официальным
// пройденным расстоянием (Profile.stateAt остаётся единственным источником
// «сколько пройдено», кинематика/топливо/расписание прилёта не меняются),
// но хорда (прямое расстояние от старта до конца разворота) короче дуги —
// поворот не бывает бесплатным по пути, это физически честно. После
// разворота корабль «прицеливается» точно на актуальную путевую точку (mid,
// если ещё не миновали её, иначе — саму цель) из ТОЙ позиции, где его
// оставило интегрирование, — так что к totalSec корабль ВСЕГДА приезжает
// ровно в цель, каким бы ни получился изгиб на старте. Зеркало на клиенте —
// client/world.js transitPositionAt.
func (t *Transit) positionAt(ts float64) (x, y float64) {
	if t.CoastSec > 0 {
		if ts <= t.CoastSec {
			return t.coastPositionAt(ts)
		}
		return t.afterCoast().positionAt(ts - t.CoastSec)
	}
	total := t.Profile.totalSec()
	if total <= 0 || ts <= 0 {
		return t.FromX, t.FromY
	}
	if ts >= total {
		return t.ToX, t.ToY
	}
	turnEnd := t.TurnSec
	if turnEnd > total {
		turnEnd = total
	}
	if ts <= turnEnd {
		return t.integrateTurn(ts)
	}
	turnX, turnY := t.integrateTurn(turnEnd)
	// Profile.stateAt отдаёт расстояние в у.е. (screenUE-масштаб), а
	// координаты маршрута (FromX/ToX/MidX...) — в клетях: без деления здесь
	// distAtTurnEnd/distNow оказываются на 6 порядков больше segLen (клети),
	// k мгновенно улетает за 1 сразу после turnEnd — ровно тот баг, что ловит
	// тест на непрерывность стыка фаз.
	distAtTurnEnd, _ := t.Profile.stateAt(turnEnd)
	distNow, _ := t.Profile.stateAt(ts)
	distAtTurnEnd /= screenUE
	distNow /= screenUE
	aimX, aimY := t.waypointAfter(distAtTurnEnd)
	dx, dy := aimX-turnX, aimY-turnY
	segLen := math.Hypot(dx, dy)
	if segLen < 1e-9 {
		return turnX, turnY
	}
	k := (distNow - distAtTurnEnd) / segLen
	if k > 1 {
		k = 1
	}
	return turnX + dx*k, turnY + dy*k
}

// integrateTurn — численное интегрирование позиции за время [0, ts]
// (ts ≤ TurnSec), шагами physicsStepSec — тот же приём, что settleFlight.
// Направление на каждом шаге — headingAt (уже поворачивается от
// HeadingFromDeg к HeadingToDeg за TurnSec), длина шага — реальная скорость
// из Profile.stateAt В ТОТ ЖЕ момент: разгон и поворот идут одновременно, а
// не по очереди.
func (t *Transit) integrateTurn(ts float64) (x, y float64) {
	x, y = t.FromX, t.FromY
	if ts <= 0 {
		return
	}
	steps := int(ts / physicsStepSec)
	if steps < 1 {
		steps = 1
	}
	if steps > physicsMaxSteps {
		steps = physicsMaxSteps
	}
	dt := ts / float64(steps)
	for i := 0; i < steps; i++ {
		at := dt * (float64(i) + 0.5) // средняя точка шага — точнее прямоугольника по краю
		headingRad := t.headingAt(at, 0) * math.Pi / 180
		_, speed := t.Profile.stateAt(at)
		cellsPerSec := speed / screenUE
		x += cellsPerSec * math.Cos(headingRad) * dt
		y += cellsPerSec * math.Sin(headingRad) * dt
	}
	return
}

// waypointAfter — актуальная путевая точка ПОСЛЕ того, как официально
// пройдено distSoFar расстояния: mid, если ещё не миновали её по геометрии
// маршрута (обход светила случается в первые секунды полёта, задолго до
// типичного мида — считать изгиб разворота при этом сравнении не нужно),
// иначе сама цель to.
func (t *Transit) waypointAfter(distSoFar float64) (x, y float64) {
	l1, _ := t.legLengths()
	if t.HasMid && distSoFar < l1 {
		return t.MidX, t.MidY
	}
	return t.ToX, t.ToY
}

// MidOrTo — координата конца ПЕРВОГО участка: путевая точка, если она есть,
// иначе сама цель (axis 0 = X, 1 = Y).
func (t *Transit) MidOrTo(axis int) float64 {
	if t.HasMid {
		if axis == 0 {
			return t.MidX
		}
		return t.MidY
	}
	if axis == 0 {
		return t.ToX
	}
	return t.ToY
}

// courseHeadingAt — курс САМОГО МАРШРУТА по доле пройденного пути: на
// ломаном маршруте это направление текущего участка, а вблизи путевой точки —
// плавный переход между участками (cornerBlendCells), иначе обзор скакнул бы
// на повороте.
func (t *Transit) courseHeadingAt(frac float64) float64 {
	l1, l2 := t.legLengths()
	h1 := math.Atan2(t.MidOrTo(1)-t.FromY, t.MidOrTo(0)-t.FromX) * 180 / math.Pi
	if !t.HasMid || l2 <= 0 {
		return h1
	}
	h2 := math.Atan2(t.ToY-t.MidY, t.ToX-t.MidX) * 180 / math.Pi
	d := frac * (l1 + l2)
	blend := math.Min(cornerBlendCells, math.Min(l1, l2))
	if blend <= 0 {
		if d <= l1 {
			return h1
		}
		return h2
	}
	if d <= l1-blend {
		return h1
	}
	if d >= l1+blend {
		return h2
	}
	k := (d - (l1 - blend)) / (2 * blend)
	return h1 + shortestAngleDeg(h1, h2)*k
}

// shipSeconds — «время корабля» с момента старта перелёта (реальные секунды
// ожидания × зафиксированный множитель ускорения времени).
func (t *Transit) shipSeconds(now time.Time) float64 {
	f := t.TimeFactor
	if f <= 0 {
		f = 1
	}
	return now.Sub(t.DepartedAt).Seconds() * f
}

// stateAt — доля пройденного пути (0..1), скорость (у.е.) и курс (градусы) на
// момент now. Зеркало на клиенте — client/world.js transitState.
func (t *Transit) stateAt(now time.Time) (frac, speed, headingDeg float64) {
	return t.stateAtTS(t.shipSeconds(now))
}

// stateAtTS — то же самое, но по «времени корабля» напрямую (ts), не по
// time.Time — нужно и stateAt (now→ts→сюда), и коасту (CoastSec, эта правка,
// см. Transit.CoastSec) ниже: во время наката пройденный путь и скорость
// считаются отдельно от Profile (тяги нет — курс/скорость на накате не
// меняются), а после — делегируются afterCoast() с ts−CoastSec, тем же
// расчётом, что у обычного перелёта, просто от сдвинутой точки.
func (t *Transit) stateAtTS(ts float64) (frac, speed, headingDeg float64) {
	if t.CoastSec > 0 {
		_, _, totalDist, coastDist := t.coastEndpoint()
		if ts <= t.CoastSec {
			frac = 0
			if totalDist > 0 {
				frac = (t.Profile.EntrySpeed * ts) / totalDist
			}
			if frac > 1 {
				frac = 1
			}
			return frac, t.Profile.EntrySpeed, t.HeadingFromDeg
		}
		subFrac, speed, headingDeg := t.afterCoast().stateAtTS(ts - t.CoastSec)
		frac = 1.0
		if totalDist > 0 {
			frac = (coastDist + subFrac*t.Profile.DistanceUE) / totalDist
		}
		if frac > 1 {
			frac = 1
		}
		return frac, speed, headingDeg
	}
	distUE, speed := t.Profile.stateAt(ts)
	frac = 1.0
	if t.Profile.DistanceUE > 0 {
		frac = distUE / t.Profile.DistanceUE
	}
	if frac > 1 {
		frac = 1
	}
	return frac, speed, t.headingAt(ts, frac)
}

// headingAt — курс на момент ts секунд «времени корабля» при доле пути frac:
// сначала разворот со стартового курса на курс маршрута за TurnSec, дальше —
// курс самого маршрута (на ломаном — с плавным поворотом у путевой точки).
// При активном накате (CoastSec) — см. отдельную ветку в stateAtTS/positionAt
// выше, headingAt сюда не вызывается напрямую в фазе наката (курс на накате
// заморожен на HeadingFromDeg, тяги нет — поворачивать нечем).
func (t *Transit) headingAt(ts, frac float64) float64 {
	course := t.courseHeadingAt(frac)
	if t.TurnSec <= 0 || ts >= t.TurnSec {
		return course
	}
	if ts < 0 {
		ts = 0
	}
	return t.HeadingFromDeg + shortestAngleDeg(t.HeadingFromDeg, course)*(ts/t.TurnSec)
}

// shortestAngleDeg — кратчайший поворот из a в b, градусы в (−180, 180].
func shortestAngleDeg(a, b float64) float64 {
	d := math.Mod(b-a, 360)
	if d > 180 {
		d -= 360
	}
	if d <= -180 {
		d += 360
	}
	return d
}

// FlightControl — органы ручного управления, зажаты/отпущены игроком прямо
// сейчас (client/ship.html — боковые «манёвр»/тумблеры «Форсаж»/«Тормож.»).
// Позиция/курс/скорость — чистая функция времени с МОМЕНТА последнего
// изменения набора зажатых кнопок (тот же приём, что Transit): не тикает
// сама, а лениво разрешается при каждом обращении (settleFlight). Замкнутой
// формулы курс+скорость+позиция при одновременных повороте и разгоне не
// существует (спираль — интеграл Френеля, элементарной первообразной нет),
// поэтому settleFlight считает численно короткими шагами — при частоте
// обращений HUD (раз в секунду опрос + кадры между ними на клиенте) это
// более чем точно.
type FlightControl struct {
	Thrust, Brake, TurnLeft, TurnRight bool

	ChangedAt       time.Time
	HeadingAtChange float64 // радианы, математическая конвенция (0 = +X, рост против часовой)
	SpeedAtChange   float64 // у.е. (ТЗ.md §2.7.4)
}

// Ship — состояние корабля игрока (с этой правки — состояние ОДНОГО корабля
// одного флота, см. fleets.go: у каждого из 4 флотов теперь свой *Ship,
// вместо одного глобального на весь сервер).
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

	// ── ручной полёт (эта правка) ──────────────────────────────────────────
	Heading float64 // радианы — курс корабля В МИРЕ (не экранный угол, тот считает клиент)
	Speed   float64 // у.е. — текущая скорость (ТЗ.md §2.7.4)
	Control *FlightControl
	Physics ShipPhysics // тяга/масса — считается один раз при назначении корабля флоту (shipphysics.go)
	Decks   []DeckHP    // HP палуб — из дизайна корабля библиотеки (shipphysics.go buildDeckHP)
	Design  string      // имя дизайна в библиотеке (ship_defaults.json), для скелета на клиенте

	// ── реальный запас топлива и заряд аккумуляторов (эта правка, по прямому
	// требованию пользователя) — раньше FuelRatio в Physics был единственным
	// «топливным» понятием (мгновенная пропускная способность газохранилища,
	// бак предполагался бесконечным). Стартовая загрузка — fleets.go
	// loadStartingFuel, расход — settleFlight (обычная тяга/форсаж), Kick/
	// Charge (разовые действия). Пополнения после старта пока нет нигде —
	// открытый вопрос, не эта правка.
	FuelHydrogen      float64
	FuelHelium3       float64
	FuelMetalHydrogen float64
	BatteryCharge     float64 // заряд аккумуляторов, 0..Physics.BatteryCapacity

	// ── квантованный энергоцикл (эта правка, shipphysics.go settleEnergyCycle)
	// — FuelRatio держится КОНСТАНТНЫМ между циклами (не пересчитывается
	// continuously на каждый тик), FuelCycleAccumSec — накопленное РЕАЛЬНОЕ
	// время под тягой/торможением с последнего урегулированного цикла (не
	// время по часам — см. settleFlight). Дефолт FuelRatio=1 при назначении
	// корабля (fleets.go) — оптимистичное начальное состояние («полная тяга
	// сразу», а не «0 до первого урегулирования через 60с») до первого
	// реального цикла.
	FuelRatio         float64
	FuelCycleAccumSec float64

	// Boosted — форсаж «на гелии» защёлкнут (кнопка УСКОРИТЬ/МЕДЛЕННЕЕ):
	// переключает, каким топливом settleFlight урегулирует энергоцикл
	// (shipphysics.go settleEnergyCycle) — те же самые двигатели. В отличие
	// от Control.Thrust это не «пока держат», а СОСТОЯНИЕ полёта — включается
	// удержанием кнопки, выключается отдельным нажатием «МЕДЛЕННЕЕ» (не
	// логическое НЕ Control).
	Boosted bool

	// ── автономность СЖО (эта правка, по прямому требованию пользователя) —
	// расходуется, пока корабль НЕ на поверхности, перезаряжается на
	// обитаемых мирах/колониях — см. settleLifeSupport и константы в
	// shipphysics.go (lifeSupportHoursPerModule) для полного описания
	// правил. LifeSupportUpdatedAt — момент последнего пересчёта (тот же
	// приём ленивого обновления, что Control.ChangedAt).
	LifeSupportRemaining float64
	LifeSupportUpdatedAt time.Time

	// Cargo — грузовой трюм (ключ ресурса/компонента → количество). Пуст при
	// старте — в игре пока нет ни добычи, ни торговли для корабля; заполняется
	// только подбором чужих сброшенных коробок (см. cargo.go Jettison/Pickup).
	Cargo map[string]float64

	// ── смена цели в полёте (эта правка, по прямому требованию пользователя:
	// «нельзя сменить цель в процессе полёта, нужно это разрешить») ─────────
	// PendingInterstellarR/Arc — секторная позиция, в которой Navigate только
	// что «застал» корабль СРЕДИ межзвёздного перелёта (см. collapseTransit):
	// нужна следующему вызову Navigate как точка СТАРТА нового интерстеллара,
	// вместо позиции звезды отправления (`sim.Object(SystemStarID)`), от
	// которой корабль к этому моменту уже мог заметно отойти. Разовая —
	// collapseTransit выставляет, Navigate считывает и сбрасывает
	// (HasPendingInterstellarOrigin=false) сразу же, будет ли следующий вызов
	// интерстелларом или нет.
	PendingInterstellarR, PendingInterstellarArc float64
	HasPendingInterstellarOrigin                 bool
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
		Cargo:             map[string]float64{},
		FuelRatio:         1, // оптимистичный старт — полная тяга до первого урегулирования цикла
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
		// Выходим НА ГРАНИЦУ системы со стороны подлёта, а не к самой звезде
		// (systemEdgeRadius, прямое требование пользователя). Дальше игрок
		// сам выбирает планету — вторая команда навигации.
		sh.SX, sh.SY = t.ArriveLocalX, t.ArriveLocalY
		sh.AtPlanetIndex = -1
	}
	// Курс и скорость на выходе из перелёта — те же, что профиль довёл до
	// конца маршрута (Transit.stateAt в последний момент): ручное управление
	// продолжается ровно с того состояния, в котором автопилот закончил, без
	// разрыва. Раньше здесь стояло безусловное Speed=0, а Heading не трогался
	// вовсе — и в момент прилёта обзор скачком возвращался на курс, которым
	// корабль шёл ДО команды «лететь» (см. HeadingToDeg в Transit).
	sh.Heading = t.HeadingToDeg * math.Pi / 180
	sh.Speed = t.Profile.ExitSpeed
	sh.Transit = nil
	sh.Control = nil
}

// collapseTransit — по прямому требованию пользователя «нельзя сменить цель
// в процессе полёта, нужно это разрешить»: если корабль СЕЙЧАС в полёте (ещё
// не долетел — resolveTransit выше уже разрешил бы долетевший перелёт сам),
// сворачивает Transit в конкретное состояние ПРЯМО ТАМ, где корабль
// находится в момент вызова — курс/скорость те же, что дал бы профиль на
// этот момент (Transit.stateAt), позиция — точно по пройденному пути
// (Transit.pointAtFrac, с учётом обхода светила). Это НЕ прибытие (звезда не
// меняется автоматически) — просто новая точка старта для СЛЕДУЮЩЕЙ команды
// Navigate, вызывающей эту функцию перед собственными расчётами.
//
// Единственный случай, требующий отдельного состояния (PendingInterstellar*
// на Ship) — застали корабль СРЕДИ межзвёздного перелёта: физически он не «в
// системе» вовсе (летит по сектору между звёздами), поэтому для позиции
// нового интерстеллара нужна не позиция звезды отправления
// (sim.Object(SystemStarID) — от неё корабль к этому моменту мог заметно
// отойти), а его текущая секторная позиция. Navigate считывает её и
// planet-цели в этом состоянии отклоняет (ErrNoSystemContext) — планета
// требует «быть в системе», а корабль между звёзд ни в одной не находится.
func (sh *Ship) collapseTransit(now time.Time) {
	if sh.Transit == nil {
		return
	}
	sx, sy, speed, headingRad, pendingR, pendingArc, hasPending := sh.previewCollapsedState(now)
	if hasPending {
		sh.PendingInterstellarR, sh.PendingInterstellarArc = pendingR, pendingArc
		sh.HasPendingInterstellarOrigin = true
	} else {
		sh.SX, sh.SY = sx, sy
		sh.AtPlanetIndex = -1
	}
	sh.Heading = headingRad
	sh.Speed = speed
	sh.Transit = nil
	sh.Control = nil
}

// previewCollapsedState — то же вычисление, что делает collapseTransit, но
// БЕЗ побочных эффектов: где сейчас реально находится корабль (позиция/
// скорость/курс), не трогая его состояние. Нужен EstimateTravel — предпросмотр
// ETA (ТЗ_UI.md, показывается при выборе цели на радаре) не должен обрывать
// текущий перелёт только потому, что игрок посмотрел на цифры, в отличие от
// Navigate, которому смена цели и нужна по-настоящему.
func (sh *Ship) previewCollapsedState(now time.Time) (sx, sy, speed, headingRad, pendingR, pendingArc float64, hasPending bool) {
	t := sh.Transit
	if t == nil {
		x, y := sh.effectivePos()
		return x, y, sh.Speed, sh.Heading, 0, 0, false
	}
	frac, spd, headingDeg := t.stateAt(now)
	if t.Mode == "system" {
		x, y := t.positionAt(t.shipSeconds(now))
		return x, y, spd, headingDeg * math.Pi / 180, 0, 0, false
	}
	// interstellar — корабль физически ни в одной системе, только секторная
	// позиция имеет смысл (SX/SY не при делах, возвращаем 0).
	r := t.FromR + (t.ToR-t.FromR)*frac
	a := t.FromArc + (t.ToArc-t.FromArc)*frac
	return 0, 0, spd, headingDeg * math.Pi / 180, r, a, true
}

// settleLifeSupport — ленивое обновление автономности СЖО с момента
// последнего пересчёта до `now` (тот же приём, что resolveTransit/
// settleFlight). Расходуется, только пока корабль НЕ на поверхности («без
// посадки» — прямая формулировка пользователя); посадка ГДЕ УГОДНО
// останавливает расход (не требует восполнения — экипаж просто не жжёт
// корабельный запас, пока стоит на грунте), а восполняет запас МГНОВЕННО до
// полного бака ТОЛЬКО посадка на обитаемый мир (Planet.Life) или колонию
// (Planet.Population>0) — «перезаряжается автоматом», в ТЗ формулы нет,
// решение «мгновенно, а не постепенно» — самостоятельное (пользователь не
// уточнил скорость подзарядки, а «автоматом» ближе к «сразу», чем к
// «постепенно тикает»). Что происходит при обнулении запаса — открытый
// вопрос (пользователь не описал последствие): по аналогии с дефицитом
// энергии колонии (server/production.go energyDay) сейчас это чистая
// метрика для игрока, ни на что не влияющая.
func (sh *Ship) settleLifeSupport(now time.Time) {
	if sh.LifeSupportUpdatedAt.IsZero() {
		sh.LifeSupportUpdatedAt = now
		sh.LifeSupportRemaining = sh.Physics.LifeSupportCapacity
		return
	}
	elapsed := now.Sub(sh.LifeSupportUpdatedAt).Seconds()
	sh.LifeSupportUpdatedAt = now
	if elapsed <= 0 {
		return
	}
	if sh.Landed {
		if sh.habitableLanding() {
			sh.LifeSupportRemaining = sh.Physics.LifeSupportCapacity
		}
		return // посадка где угодно останавливает расход, восполняет — только обитаемая/колония выше
	}
	// Ускорение времени (см. шапку файла, timeAccelFactor) — автономность
	// СЖО тоже часть «времени полёта», должна течь в том же темпе.
	sh.LifeSupportRemaining -= elapsed * timeAccelFactor()
	if sh.LifeSupportRemaining < 0 {
		sh.LifeSupportRemaining = 0
	}
}

// ── гравитационное торможение у планеты (эта правка, по прямому требованию
// пользователя: «торможение за счёт гравитации объекта посадки близ орбиты
// планет... корабль может погасить скорость, немного закручивая вокруг
// планеты») — самостоятельная механика, числа не из ТЗ (пользователь сам
// предложил «например ×10» для множителя; радиус «близ орбиты» не задан —
// взят кратным уже существующему радиусу стыковки dockRadiusFactor,
// planets.go, тот же, что определяет «у планеты» для автопилота).
const (
	gravityBrakeMultiplier   = 10.0
	gravityBrakeRadiusFactor = 3.0 // во сколько раз шире радиуса стыковки — «близ орбиты», не только точка причаливания
)

// nearGravityWell — стоит ли корабль СЕЙЧАС достаточно близко к какой-нибудь
// планете текущей системы, чтобы её гравитация помогала тормозить (только
// торможение — не разгон: гравитация гасит скорость витком вокруг тела, а не
// разгоняет корабль в произвольном направлении). Не применяется в полёте
// автопилота (Transit!=nil) и на посадке — только к ручному manoeuvring.
// Обращается к пакетному глобальному `sim`/`clk` напрямую — тот же приём,
// что уже применён в Navigate/EstimateTravel/habitableLanding этого файла.
func (sh *Ship) nearGravityWell() bool {
	if sh.Transit != nil || sh.Landed {
		return false
	}
	star, ok := sim.Object(sh.SystemStarID)
	if !ok {
		return false
	}
	nowMonths := clk.Snapshot().Months
	for i := range star.Planets {
		p := &star.Planets[i]
		pAngle := p.Angle + p.AngVel*nowMonths
		px, py := p.Orbit*math.Cos(pAngle), p.Orbit*math.Sin(pAngle)
		dockR := p.Diameter / 2 * dockRadiusFactor
		if math.Hypot(sh.SX-px, sh.SY-py) <= dockR*gravityBrakeRadiusFactor {
			return true
		}
	}
	return false
}

// habitableLanding — стоит ли корабль СЕЙЧАС на обитаемом мире (Planet.Life)
// или в колонии (Planet.Population>0) — условие автоперезарядки СЖО.
// Обращается к пакетному глобальному `sim` напрямую (тот же приём, что уже
// применён к глобальному `clk` в Navigate/EstimateTravel этого файла) — сама
// Ship не хранит ссылку на Sim.
func (sh *Ship) habitableLanding() bool {
	if !sh.Landed {
		return false
	}
	star, ok := sim.Object(sh.SystemStarID)
	if !ok || sh.LandedPlanetIndex < 0 || sh.LandedPlanetIndex >= len(star.Planets) {
		return false
	}
	p := &star.Planets[sh.LandedPlanetIndex]
	return p.Life || p.Population > 0
}

// ── ручной полёт: разгон/торможение/поворот (эта правка) ────────────────────

const (
	// Скорость поворота — САМОСТОЯТЕЛЬНОЕ решение, в ТЗ формулы нет (только
	// требование пользователя «поворот тоже зависит от ускорения»): база +
	// надбавка от ускорения корабля, чтобы манёвренные ионные корабли ощутимо
	// резче разворачивались, чем медленные водородные. Была ЛИНЕЙНОЙ
	// (3+0.1×accel) — ИСПРАВЛЕНО по прямому требованию пользователя на
	// ЛОГАРИФМИЧЕСКУЮ: разлёт accelUE у 4 стартовых кораблей большой
	// (~25…~480 у.е./с² после недавней перекалибровки топлива, ×19), линейная
	// формула растягивала это в такой же ×19 разлёт итогового поворота —
	// у медленных кораблей поворот был почти незаметен, у быстрых —
	// неоправданно резкий. ln(1+accel) сжимает тот же диапазон до ×1.9
	// (ln(26)≈3.3 против ln(481)≈6.2) — поворот остаётся заметным у любого
	// корабля, не только у самых мощных.
	turnRateBaseDeg        = 3.0
	turnRatePerLogAccelDeg = 4.0

	physicsStepSec  = 0.05 // шаг численного интегрирования
	physicsMaxSteps = 4000 // защита от неограниченного цикла при очень старом ChangedAt
)

// turnRateDegFor — та же формула скорости поворота (град/с) для всех, кому она
// нужна: ручной полёт (settleFlight), снимок для клиента (Snapshot) и разворот
// на курс в начале автопилотного перелёта (Navigate). Раньше была выписана
// дважды подряд.
func turnRateDegFor(accelUE float64) float64 {
	return turnRateBaseDeg + turnRatePerLogAccelDeg*math.Log(1+accelUE)
}

// ensureControl — заводит нейтральное состояние органов управления (все
// кнопки отпущены), если его ещё не было — от ТЕКУЩИХ курса/скорости, чтобы
// не дёрнуть корабль при первом обращении.
func (sh *Ship) ensureControl(now time.Time) {
	if sh.Control == nil {
		sh.Control = &FlightControl{ChangedAt: now, HeadingAtChange: sh.Heading, SpeedAtChange: sh.Speed}
	}
}

// settleFlight — численно доводит курс/скорость/позицию корабля с момента
// последнего изменения органов управления до `now`. Вызывать под замком,
// только когда Transit == nil (в перелёте автопилот сам ведёт позицию —
// вызывающий обязан это проверить, см. Snapshot/SetControl).
func (sh *Ship) settleFlight(now time.Time) {
	sh.ensureControl(now)
	cs := sh.Control
	elapsed := now.Sub(cs.ChangedAt).Seconds()
	if elapsed <= 0 {
		return
	}
	// Ускорение времени (timeAccelFactor) — физика корабля идёт в том же
	// темпе, что и остальной сектор (см. шапку файла). Пересчитывается на
	// КАЖДЫЙ вызов settleFlight от ТЕКУЩЕГО множителя — лениво, как и вся
	// остальная механика ручного полёта, поэтому смена скорости в
	// админ-панели подхватывается корректно, без разрывов.
	elapsed *= timeAccelFactor()
	steps := int(elapsed / physicsStepSec)
	if steps < 1 {
		steps = 1
	}
	if steps > physicsMaxSteps {
		steps = physicsMaxSteps
	}
	dt := elapsed / float64(steps)

	heading, speed := cs.HeadingAtChange, cs.SpeedAtChange

	// ── топливо (квантованная модель, эта правка — settleEnergyCycle,
	// shipphysics.go) — прямая правка пользователя поверх континуальной
	// версии: «газовое хранилище сжигает топливо чтоб произвести энергию,
	// которую потребляет двигатель... сжигание раз в 60 секунд, единый цикл».
	// sh.FuelRatio держится КОНСТАНТНЫМ с последнего урегулированного цикла —
	// именно он задаёт тягу здесь, а не мгновенный пересчёт «трубы» на каждый
	// шаг (континуальной «пропускной способности» в этой модели просто нет).
	// Сами границы циклов сводятся НИЖЕ, ПОСЛЕ движения этого вызова — эффект
	// (новый FuelRatio) применяется СО СЛЕДУЮЩЕГО вызова, не задним числом к
	// уже посчитанному в этом движению (тот же принцип ленивого
	// урегулирования, что и у остальной механики ручного полёта).
	accel := sh.Physics.accelAtRatio(sh.FuelRatio)
	turnRateRad := turnRateDegFor(accel) * math.Pi / 180

	// Гравитоторможение (эта правка) — проверяется ОДИН раз на весь вызов
	// (не по шагам): за длительность одного settleFlight корабль сдвигается
	// не настолько, чтобы влетать/вылетать из зоны действия гравитации
	// планеты внутри одного и того же короткого окна между опросами клиента
	// — тот же принцип приближения, что уже применяют Navigate/EstimateTravel
	// к дрейфу звёзд. Топливо НЕ тратится дополнительно — множитель усиливает
	// уже оплаченную тягу, а не заменяет её (гравитация «бесплатная»).
	brakeBoost := 1.0
	if sh.nearGravityWell() {
		brakeBoost = gravityBrakeMultiplier
	}

	var dx, dy float64
	for i := 0; i < steps; i++ {
		if cs.TurnLeft {
			heading += turnRateRad * dt
		}
		if cs.TurnRight {
			heading -= turnRateRad * dt
		}
		if cs.Thrust {
			speed += accel * dt
		}
		if cs.Brake {
			speed -= accel * brakeBoost * dt
		}
		if speed < 0 {
			speed = 0
		}
		if speed > speedLimitUE {
			speed = speedLimitUE
		}
		cellsPerSec := speed / screenUE // 1 клеть (SX/SY) = 1 экран = 1000000 у.е.·с, ТЗ.md §2.7.4
		dx += cellsPerSec * math.Cos(heading) * dt
		dy += cellsPerSec * math.Sin(heading) * dt
	}
	sh.SX += dx
	sh.SY += dy
	sh.Heading = heading
	sh.Speed = speed
	cs.ChangedAt, cs.HeadingAtChange, cs.SpeedAtChange = now, heading, speed

	// ── урегулирование топливных циклов (эта правка) — копится РЕАЛЬНОЕ
	// время под тягой/торможением, не время по часам («нет смысла жечь
	// топливо на энергию, если нет её потребителя» — цикл просто не идёт,
	// пока корабль не тянет). Граница цикла — РОВНО ОДИН счётчик
	// (FuelCycleAccumSec), catch-up-циклом, не два независимых таймера —
	// тот класс ошибки, от которого предостерегает CLAUDE.md (day/hour в
	// production.go).
	if cs.Thrust || cs.Brake {
		fuelKey := "hydrogen"
		if sh.Boosted {
			fuelKey = "helium3"
		}
		var fuelPool *float64
		switch fuelKey {
		case "hydrogen":
			fuelPool = &sh.FuelHydrogen
		case "helium3":
			fuelPool = &sh.FuelHelium3
		}
		fuelUnitYield := fuelUnitYieldFor(fuelKey)
		sh.FuelCycleAccumSec += elapsed
		for sh.FuelCycleAccumSec >= energyCyclePeriodSec {
			sh.FuelRatio = sh.Physics.settleEnergyCycle(fuelPool, fuelUnitYield, &sh.BatteryCharge)
			sh.FuelCycleAccumSec -= energyCyclePeriodSec
		}
	}

	// Гелий кончился в форсаже — сам сбрасывает режим, а не оставляет корабль
	// «застёгнутым» в Boosted с нулевой добавочной тягой молча.
	if sh.Boosted && sh.FuelHelium3 <= 0 {
		sh.Boosted = false
	}
}

// SetControl — обновляет набор зажатых органов управления (client/ship.html:
// боковые «манёвр»/тумблеры «Форсаж»/«Тормож.»). Разгон снимает привязку к
// планете — тот же смысл, что у Navigate («ушли в манёвр — дальше позиция своя»).
func (sh *Ship) SetControl(now time.Time, thrust, brake, turnLeft, turnRight bool) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)
	if sh.Landed {
		return ErrShipLanded
	}
	if sh.Transit != nil {
		return ErrShipBusy
	}
	sh.settleFlight(now) // довести курс/скорость/позицию до «сейчас» ПЕРЕД сменой команд
	if thrust {
		sh.AtPlanetIndex = -1
	}
	sh.Control.Thrust, sh.Control.Brake = thrust, brake
	sh.Control.TurnLeft, sh.Control.TurnRight = turnLeft, turnRight
	return nil
}

// Kick — разовый импульс «газонуть» (кнопка УСКОРИТЬ, короткий тап,
// client/ship.html): мгновенно добавляет boostKickUE к скорости и списывает
// boostKickFuelCost гелия-3, не трогая режим Boosted (это НЕ то же самое, что
// удержание кнопки — см. Ship.Boosted).
func (sh *Ship) Kick(now time.Time) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)
	if sh.Landed {
		return ErrShipLanded
	}
	if sh.Transit != nil {
		return ErrShipBusy
	}
	if sh.FuelHelium3 < boostKickFuelCost {
		return ErrNotEnoughFuel
	}
	sh.settleFlight(now) // довести до «сейчас» ПЕРЕД разовой прибавкой скорости
	sh.FuelHelium3 -= boostKickFuelCost
	sh.Speed += boostKickUE
	if sh.Speed > speedLimitUE {
		sh.Speed = speedLimitUE
	}
	sh.AtPlanetIndex = -1 // импульс — тот же смысл, что разгон: ушли от стоянки
	sh.ensureControl(now)
	sh.Control.ChangedAt, sh.Control.HeadingAtChange, sh.Control.SpeedAtChange = now, sh.Heading, sh.Speed
	return nil
}

// SetBoost — защёлкивает/снимает режим форсажа на гелии (Ship.Boosted).
// Удержание кнопки УСКОРИТЬ на клиенте включает (engage=true), одно нажатие
// «МЕДЛЕННЕЕ» — выключает (engage=false); в отличие от Control.Thrust это
// состояние полёта, а не «пока держат» (см. комментарий у поля Boosted).
func (sh *Ship) SetBoost(now time.Time, engage bool) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)
	if sh.Landed {
		return ErrShipLanded
	}
	if sh.Transit != nil {
		return ErrShipBusy
	}
	if engage && sh.FuelHelium3 <= 0 {
		return ErrNotEnoughFuel
	}
	sh.settleFlight(now) // довести до «сейчас» на СТАРОМ режиме тяги, потом переключаем
	sh.Boosted = engage
	return nil
}

// Charge — кнопка ЗАРЯДИТЬ: сжигает chargeFuelCost металлического водорода,
// пополняя заряд аккумуляторов на metalHydrogenChargeYield×chargeFuelCost (не
// выше ёмкости всех установленных батарей). На корабле без единой батареи
// (Physics.BatteryCapacity==0) заряжать нечего — явная ошибка, а не тихий
// no-op, чтобы клиент мог показать внятный тост.
func (sh *Ship) Charge(now time.Time) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)
	if sh.Physics.BatteryCapacity <= 0 {
		return ErrNoBattery
	}
	if sh.BatteryCharge >= sh.Physics.BatteryCapacity {
		return ErrBatteryFull
	}
	if sh.FuelMetalHydrogen < chargeFuelCost {
		return ErrNotEnoughFuel
	}
	sh.FuelMetalHydrogen -= chargeFuelCost
	sh.BatteryCharge += chargeFuelCost * metalHydrogenChargeYield
	if sh.BatteryCharge > sh.Physics.BatteryCapacity {
		sh.BatteryCharge = sh.Physics.BatteryCapacity
	}
	return nil
}

// DebugDamage — служебное действие: наносит случайный урон случайной палубе.
// Настоящего боя/столкновений в игре ещё нет (см. ТЗ.md §2.7.5 — только
// текст, без реализации) — это временная демонстрация заполнения HP-чекбоксов
// на HUD (client/ship.html, раздел «Действия»), по прямой просьбе пользователя.
func (sh *Ship) DebugDamage(now time.Time) (DeckHP, error) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if len(sh.Decks) == 0 {
		return DeckHP{}, errors.New("у корабля нет палуб")
	}
	i := rand.Intn(len(sh.Decks))
	dmg := 1 + rand.Intn(5)
	sh.Decks[i].Current -= dmg
	if sh.Decks[i].Current < 0 {
		sh.Decks[i].Current = 0
	}
	return sh.Decks[i], nil
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

// FlightControlView — та же информация, что FlightControl, но только флаги
// (клиенту не нужны служебные ChangedAt/HeadingAtChange/SpeedAtChange —
// текущие курс/скорость уже есть отдельными полями в ShipView).
type FlightControlView struct {
	Thrust    bool `json:"thrust"`
	Brake     bool `json:"brake"`
	TurnLeft  bool `json:"turnLeft"`
	TurnRight bool `json:"turnRight"`
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

	// ── ручной полёт (эта правка) ──────────────────────────────────────────
	HeadingDeg  float64           `json:"headingDeg"`  // градусы, 0=+X, рост против часовой (математическая конвенция)
	Speed       float64           `json:"speed"`       // у.е., ТЗ.md §2.7.4
	MaxSpeed    float64           `json:"maxSpeed"`    // = speedLimitUE (300000), константа — присылаем, чтобы клиент не хардкодил
	AccelUE     float64           `json:"accelUe"`     // у.е./с², с учётом топливного коэффициента
	FuelRatio   float64           `json:"fuelRatio"`   // 1 = топлива хватает на полную тягу
	TurnRateDeg float64           `json:"turnRateDeg"` // град/с при зажатом повороте — клиент этим доворачивает курс между опросами (world.js), не дублирует формулу
	Control     FlightControlView `json:"control"`
	Design      string            `json:"design"` // имя дизайна в библиотеке ship_defaults.json — клиент рисует скелет по нему
	Decks       []DeckHP          `json:"decks"`

	// ── реальный запас топлива/заряда (эта правка) ──────────────────────────
	FuelHydrogen      float64 `json:"fuelHydrogen"`
	FuelHelium3       float64 `json:"fuelHelium3"`
	FuelMetalHydrogen float64 `json:"fuelMetalHydrogen"`
	BatteryCharge     float64 `json:"batteryCharge"`
	BatteryCapacity   float64 `json:"batteryCapacity"` // 0 = на корабле нет батарей вовсе
	Boosted           bool    `json:"boosted"`         // форсаж на гелии защёлкнут (кнопка УСКОРИТЬ/МЕДЛЕННЕЕ)

	// ── автономность СЖО (эта правка) — реальные секунды, 0 = СЖО нет вовсе
	// (LifeSupportCapacity==0) или запас исчерпан.
	LifeSupportRemaining float64 `json:"lifeSupportRemaining"`
	LifeSupportCapacity  float64 `json:"lifeSupportCapacity"`

	// ── грузовой трюм (эта правка) — cargo.go Jettison/Pickup.
	Cargo         map[string]float64 `json:"cargo"`
	CargoCapacity float64            `json:"cargoCapacity"`
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
	sh.settleLifeSupport(now)
	if sh.Transit == nil {
		sh.settleFlight(now) // в перелёте автопилот сам ведёт позицию — ручную физику не трогаем
	}
	sx, sy := sh.effectivePos()
	// В перелёте позиция/скорость/курс — не хранимое состояние, а функция
	// времени от профиля (Transit.stateAt). Без этого снимок в перелёте
	// сообщал скорость 0 и курс «до команды лететь»: звёздный фон стоял,
	// показание скорости в HUD было нулём, а обзор смотрел не туда, куда
	// корабль летит — полёт не ощущался вовсе (прямая жалоба пользователя).
	headingDeg, speed := sh.Heading*180/math.Pi, sh.Speed
	if t := sh.Transit; t != nil {
		_, tSpeed, tHeading := t.stateAt(now)
		speed, headingDeg = tSpeed, tHeading
		if t.Mode == "system" {
			sx, sy = t.positionAt(t.shipSeconds(now))
		}
	}
	decks := make([]DeckHP, len(sh.Decks))
	copy(decks, sh.Decks)
	// Копия, не сама карта — Snapshot маршалится в JSON УЖЕ ПОСЛЕ отпускания
	// sh.mu (тот же приём, что и decks выше), а Cargo мутируют Jettison/Pickup
	// конкурентно — отдавать наружу живую карту было бы гонкой данных.
	cargo := make(map[string]float64, len(sh.Cargo))
	for k, v := range sh.Cargo {
		cargo[k] = v
	}
	// Текущая тяга/расход — sh.FuelRatio, зафиксированный на последнем
	// урегулированном топливном цикле (квантованная модель, settleFlight/
	// shipphysics.go settleEnergyCycle) — HUD показывает ТО ЖЕ число, что
	// реально управляет тягой, не отдельный мгновенный пересчёт.
	fuelRatio := sh.FuelRatio
	accelUE := sh.Physics.accelAtRatio(fuelRatio)
	view := ShipView{
		SystemStarID:         sh.SystemStarID,
		SX:                   sx,
		SY:                   sy,
		AtPlanetIndex:        sh.AtPlanetIndex,
		DockAngleOffset:      sh.DockAngleOffset,
		Landed:               sh.Landed,
		LandedPlanetIndex:    sh.LandedPlanetIndex,
		Transit:              sh.Transit,
		HeadingDeg:           headingDeg,
		Speed:                speed,
		MaxSpeed:             speedLimitUE,
		AccelUE:              accelUE,
		FuelRatio:            fuelRatio,
		TurnRateDeg:          turnRateDegFor(accelUE),
		Design:               sh.Design,
		Decks:                decks,
		FuelHydrogen:         sh.FuelHydrogen,
		FuelHelium3:          sh.FuelHelium3,
		FuelMetalHydrogen:    sh.FuelMetalHydrogen,
		BatteryCharge:        sh.BatteryCharge,
		BatteryCapacity:      sh.Physics.BatteryCapacity,
		Boosted:              sh.Boosted,
		LifeSupportRemaining: sh.LifeSupportRemaining,
		LifeSupportCapacity:  sh.Physics.LifeSupportCapacity,
		Cargo:                cargo,
		CargoCapacity:        sh.Physics.CargoCapacity,
	}
	if sh.Control != nil {
		view.Control = FlightControlView{
			Thrust: sh.Control.Thrust, Brake: sh.Control.Brake,
			TurnLeft: sh.Control.TurnLeft, TurnRight: sh.Control.TurnRight,
		}
	}
	sh.mu.Unlock()
	return view
}

var (
	ErrShipBusy        = errors.New("корабль в полёте")
	ErrShipLanded      = errors.New("сначала взлетите")
	ErrNoPlanetHere    = errors.New("рядом нет планеты для посадки")
	ErrAlreadyLanded   = errors.New("уже на поверхности")
	ErrNotLanded       = errors.New("корабль не на поверхности")
	ErrUnknownTarget   = errors.New("неизвестная цель")
	ErrBadPlanetIndex  = errors.New("неверный индекс планеты")
	ErrNoSolidSurface  = errors.New("у газового гиганта нет твёрдой поверхности")
	ErrNotEnoughFuel   = errors.New("недостаточно топлива")
	ErrStarNotTarget   = errors.New("к звезде не подлетают — выберите планету")
	ErrNoSystemContext = errors.New("корабль в открытом космосе между звёздами — сначала долетите до системы")
	ErrNoBattery       = errors.New("на корабле нет аккумуляторов")
	ErrBatteryFull     = errors.New("аккумуляторы уже заряжены полностью")
)

// deductFlightFuel — списывает топливо за ФАЗЫ ПОД ТЯГОЙ автопилота (accelSec
// — разгон+торможение, travelPhases), симулируя РЕАЛЬНЫЕ дискретные циклы
// (shipphysics.go settleEnergyCycle), а не прежнюю формулу «rate×время» —
// та же квантованная модель, что и у ручного полёта (settleFlight), просто
// прогоняется ЗАРАНЕЕ, одним куском, а не по тику (Navigate/EstimateTravel
// уже знают ВЕСЬ бюджет тяги маршрута наперёд, см. newFlightProfile). Больше
// НЕ отказывает ErrNotEnoughFuel — в квантованной модели «нехватки» в старом
// смысле нет: maxThrustSecFor уже ограничил accelSec тем, что физически
// сгорит, а если бака впритык — корабль просто летит на неполной тяге
// (FuelRatio<1), Navigate это не блокирует. Остаток НЕДОСТАВШЕГО до целого
// цикла времени (accelSec — не всегда кратен 60с) не пропадает — уходит в
// sh.FuelCycleAccumSec, тот же счётчик, что копит ручной полёт, чтобы
// следующая сессия ручного управления доучла его, а не обнулила. Автопилот
// всегда на ШТАТНОМ водороде (не форсаж — Boosted, shipphysics.go, только
// для ручного полёта): дальний перелёт на дорогом гелии-3 игрок не запросил,
// у автопилота нет кнопки «форсаж».
func (sh *Ship) deductFlightFuel(accelSec float64) error {
	if accelSec <= 0 {
		return nil
	}
	if sh.Physics.FuelDemand <= 0 || sh.Physics.FuelDemand <= sh.Physics.ReactorPowerGen {
		return nil // реактор один тянет весь спрос — бак вообще не расходуется
	}
	total := sh.FuelCycleAccumSec + accelSec
	cycles := int(total / energyCyclePeriodSec)
	remainder := total - float64(cycles)*energyCyclePeriodSec

	stock, battery := sh.FuelHydrogen, sh.BatteryCharge
	for i := 0; i < cycles; i++ {
		sh.Physics.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
	}
	sh.FuelHydrogen = stock
	sh.BatteryCharge = battery
	sh.FuelCycleAccumSec = remainder
	return nil
}

// Navigate прокладывает курс на звезду (kind="star") или на планету в ТЕКУЩЕЙ
// системе (kind="planet"). Межзвёздный перелёт заканчивается у звезды, не у
// её планеты, — см. комментарий в начале файла: одна команда — одна смена
// системы координат, до планеты у чужой звезды летим вторым шагом.
func (sh *Ship) Navigate(sim *Sim, now time.Time, kind string, starID, planetIdx int) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)

	if sh.Landed {
		return ErrShipLanded
	}
	// Смена цели В ПОЛЁТЕ разрешена (по прямому требованию пользователя,
	// было ErrShipBusy безусловно) — сворачиваем активный перелёт в точку,
	// докуда корабль реально долетел к этому моменту (collapseTransit), и
	// строим маршрут заново от нeё, как будто команда отдана оттуда. Ручное
	// управление (SetControl/Kick/SetBoost/Charge/Land) по-прежнему отказывает
	// в полёте — им своя логика «долетите сначала» ни к чему не мешает.
	sh.collapseTransit(now)
	// Довести ручную физику до «сейчас» ПЕРЕД прокладкой курса: команда
	// «лететь» на ходу должна стартовать от реальных позиции/курса/скорости
	// корабля, а не от снимка секундной давности (иначе точка старта
	// маршрута — и вместе с ней вся анимация перелёта — заметно отстаёт от
	// того, где корабль на самом деле). Если только что свернули активный
	// интерстеллар, settleFlight ничего не сдвинет: elapsed=0 сразу после
	// collapseTransit (Control только что сброшен в тот же now).
	sh.settleFlight(now)

	star, ok := sim.Object(starID)
	if !ok || star.Type != "star" {
		return ErrUnknownTarget
	}

	// Автопилот всегда на штатном водороде (без форсажа) — см. deductFlightFuel.
	// navRatio — оценка «в среднем» (shipphysics.go steadyFuelRatio), не
	// мгновенный пересчёт: у квантованной модели нет continuous-аналога
	// accelFor, а flightProfile умеет только одно постоянное ускорение на
	// весь манёвр.
	navRatio := sh.Physics.steadyFuelRatio(sh.FuelHydrogen, sh.BatteryCharge, fuelUnitYieldHydrogen)
	navAccelUE := sh.Physics.accelAtRatio(navRatio)
	navDecelUE := navDecelFor(navAccelUE, kind)
	maxThrustSec := sh.maxThrustSecFor("hydrogen")
	// Ускорение времени (см. шапку файла) — фиксируется ОДНИМ снимком на весь
	// перелёт (см. пояснение там же); 0 (пауза) не даёт кораблю вечно лететь —
	// подстрахован до 1× (обычный реальный темп), а не бесконечная длительность.
	navTimeFactor := timeAccelFactor()
	if navTimeFactor <= 0 {
		navTimeFactor = 1
	}

	// Смена цели СРЕДИ межзвёздного перелёта (collapseTransit только что
	// зафиксировал секторную позицию, HasPendingInterstellarOrigin=true) —
	// корабль физически ни в одной системе не находится: планету выбрать
	// нельзя (нет системы, в которой её искать), а «в системе ли мы» для
	// цели-звезды теперь решает НЕ ТОЛЬКО совпадение ID (см. inSystem ниже) —
	// иначе возврат к звезде отправления мid-flight ошибочно считался бы
	// «уже там» вместо честного нового интерстеллара от текущей точки.
	if kind == "planet" && sh.HasPendingInterstellarOrigin {
		return ErrNoSystemContext
	}
	inSystem := starID == sh.SystemStarID && !sh.HasPendingInterstellarOrigin

	// К СВОЕЙ звезде не летают (прямое требование пользователя: «звезду нельзя
	// выбрать в качестве цели полёта буквально») — цель в своей системе только
	// планета. Чужая звезда как цель остаётся: это выбор СИСТЕМЫ, и маршрут
	// всё равно кончается на её границе (systemEdgeRadius), а не у светила.
	if kind == "star" && inSystem {
		return ErrStarNotTarget
	}
	if inSystem {
		// навигация внутри текущей системы. Стартуем оттуда, где корабль
		// реально находится: если он стоял у планеты, та могла уехать по
		// орбите с момента прилёта.
		fx, fy := sh.effectivePos()
		tx, ty := 0.0, 0.0
		flightSec := 0.0
		// Угол причала копится в ЛОКАЛЬНОЙ переменной и попадает в состояние
		// корабля, только когда курс реально проложен: прокладка ещё может
		// сорваться (не хватило топлива — deductFlightFuel ниже), а корабль
		// в этот момент стоит у планеты, и его стоянка отсчитывается как раз
		// от DockAngleOffset — испорченный угол сдвинул бы корабль вокруг
		// планеты на НЕУДАВШЕЙСЯ команде.
		dockAngleOffset := sh.DockAngleOffset
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
				dockAngleOffset = math.Atan2(ty-pcy, tx-pcx) - pAngle
				flightSec = newFlightProfile(routeLength(fx, fy, tx, ty), navAccelUE, navDecelUE,
					entrySpeedOnCourse(sh.Speed, sh.Heading, math.Atan2(ty-fy, tx-fx)), maxThrustSec).totalSec()
			}
		}
		// Обход светила: маршрут, проходящий близко к звезде, ломается на два
		// участка (прямое требование пользователя — «корабли не приближаются
		// к звёздам, если маршрут пересекает звезду, они огибают её»).
		mx, my, hasMid := avoidStarWaypoint(fx, fy, tx, ty)
		firstX, firstY := tx, ty
		if hasMid {
			firstX, firstY = mx, my
		}
		courseRad := math.Atan2(firstY-fy, firstX-fx) // курс на ПЕРВЫЙ участок маршрута
		prof := newFlightProfile(routeLength(fx, fy, tx, ty), navAccelUE, navDecelUE,
			entrySpeedOnCourse(sh.Speed, sh.Heading, courseRad), maxThrustSec)
		if err := sh.deductFlightFuel(prof.thrustSec()); err != nil {
			return err
		}
		sh.DockAngleOffset = dockAngleOffset // курс проложен — только теперь двигаем стоянку
		headingTo := courseRad * 180 / math.Pi
		headingFrom := sh.Heading * 180 / math.Pi
		dur := time.Duration(prof.totalSec() / navTimeFactor * float64(time.Second))
		sh.Transit = &Transit{
			Mode: "system", DepartedAt: now, ArriveAt: now.Add(dur),
			FromX: fx, FromY: fy, ToX: tx, ToY: ty,
			HasMid: hasMid, MidX: mx, MidY: my,
			TargetKind: kind, TargetPlanetIndex: planetIdx,
			Profile: prof, TimeFactor: navTimeFactor,
			HeadingFromDeg: headingFrom, HeadingToDeg: headingTo,
			TurnSec: turnSecFor(headingFrom, headingTo, navAccelUE, prof.totalSec()),
		}
		sh.AtPlanetIndex = -1 // отстыковались: дальше позиция своя, не планеты
		return nil
	}

	// межзвёздный перелёт — снимок позиций на момент старта, без упреждения
	gameNow := clk.Snapshot().Months
	var fromR, fromX float64
	if sh.HasPendingInterstellarOrigin {
		// Смена цели СРЕДИ предыдущего интерстеллара — стартуем от точки,
		// докуда корабль реально долетел (collapseTransit), а не от звезды
		// отправления: та могла остаться далеко позади.
		fromR, fromX = sh.PendingInterstellarR, sh.PendingInterstellarArc
	} else {
		origin, ok := sim.Object(sh.SystemStarID)
		if !ok {
			return ErrUnknownTarget
		}
		fromR, fromX = origin.R, origin.xAt(gameNow)
	}
	toR, toX := star.R, star.xAt(gameNow)
	distClets := math.Hypot(toR-fromR, toX-fromX)  // СЕКТОРНЫЕ клети — карта сектора живёт в них
	distScreens := sectorCletsToScreens(distClets) // ЭКРАНЫ — корабельная кинематика живёт в них (эта правка)
	// Маршрут заканчивается НЕ у звезды, а на границе целевой системы со
	// стороны подлёта: дальше игрок выбирает планету отдельной командой.
	edgeScreens := systemEdgeRadius(star.SystemRadius, distScreens)
	legDist := distScreens - edgeScreens
	if legDist < 0 {
		legDist = 0
	}
	// Направление «от целевой звезды к звезде отправления» — безразмерный
	// орт, общий для обеих шкал (секторные оси трактуются как локальные,
	// X = дуга, Y = r — то же приближение, что и в самом расстоянии выше,
	// полярные координаты как декартовы). Дальше орт домножается РАЗНО:
	// на edgeScreens — для локальной позиции корабля (Ship.SX/SY, экраны),
	// на edgeClets — для точки на карте сектора (Transit.ToR/ToArc,
	// секторные клети) — раньше здесь стояла ОДНА величина (edge) сразу в
	// обеих ролях, что и было той же путаницей единиц, что и с самим dist.
	ux, uy := 1.0, 0.0
	if distClets > 1e-9 {
		ux, uy = (fromX-toX)/distClets, (fromR-toR)/distClets
	}
	edgeClets := edgeScreens / sectorCletToScreen
	arriveLocalX, arriveLocalY := ux*edgeScreens, uy*edgeScreens
	// Конец маршрута в СЕКТОРНЫХ координатах — та же точка выхода, а не сама
	// звезда: иначе метка «вы здесь» на карте сектора (galaxy.html) доезжала
	// бы до светила, тогда как корабль остановился на границе системы.
	toR, toX = toR+uy*edgeClets, toX+ux*edgeClets
	prof := newFlightProfile(legDist, navAccelUE, navAccelUE, sh.Speed, maxThrustSec) // тормозим двигателем: у границы системы гравитации звезды ещё нет
	if err := sh.deductFlightFuel(prof.thrustSec()); err != nil {
		return err
	}
	dur := time.Duration(prof.totalSec() / navTimeFactor * float64(time.Second))
	// Курс межзвёздного перелёта в ЛОКАЛЬНЫХ координатах системы смысла не
	// имеет (система вокруг корабля меняется целиком) — оставляем тот, что
	// был: разворачивать обзор в пустоте не на что.
	heading := sh.Heading * 180 / math.Pi
	sh.Transit = &Transit{
		Mode: "interstellar", DepartedAt: now, ArriveAt: now.Add(dur),
		FromR: fromR, FromArc: fromX, ToR: toR, ToArc: toX, ToStarID: starID,
		ArriveLocalX: arriveLocalX, ArriveLocalY: arriveLocalY,
		TargetKind: kind, TargetPlanetIndex: planetIdx,
		Profile: prof, TimeFactor: navTimeFactor,
		HeadingFromDeg: heading, HeadingToDeg: heading,
	}
	sh.HasPendingInterstellarOrigin = false // курс успешно проложен — точка старта больше не нужна
	return nil
}

// avoidStarWaypoint — путевая точка обхода светила, если прямой маршрут
// from→to подходит к нему (центр локальных координат системы) ближе
// starAvoidCells. Точка берётся на самом запретном радиусе, ровно там, где
// маршрут подходил к звезде ближе всего: обход получается минимальным из
// возможных, а не «крюк вокруг всей системы».
func avoidStarWaypoint(fx, fy, tx, ty float64) (mx, my float64, ok bool) {
	dx, dy := tx-fx, ty-fy
	length2 := dx*dx + dy*dy
	if length2 <= 1e-12 {
		return 0, 0, false
	}
	if segmentDistToStar(fx, fy, tx, ty) >= starAvoidCells {
		return 0, 0, false
	}
	// Направление обхода — туда, куда маршрут и так отклонялся от звезды
	// (обход минимальный, а не крюк вокруг всей системы).
	s := -(fx*dx + fy*dy) / length2
	if s < 0 {
		s = 0
	}
	if s > 1 {
		s = 1
	}
	px, py := fx+dx*s, fy+dy*s
	ux, uy := 0.0, 0.0
	if d := math.Hypot(px, py); d > 1e-9 {
		ux, uy = px/d, py/d
	} else {
		// маршрут идёт ровно через центр звезды — уводим перпендикулярно курсу
		n := math.Sqrt(length2)
		ux, uy = -dy/n, dx/n
	}

	// Путевую точку МАЛО поставить на сам запретный радиус: участки маршрута
	// — прямые, и отрезок от точки снаружи до точки НА окружности всё равно
	// срезает угол внутрь неё (замер до этой правки: обход радиусом 2.5
	// оставлял реальный подход в 2.04 клети). Поэтому точку отодвигают
	// наружу, пока ОБА участка целиком не окажутся вне запретного радиуса.
	// Предел на случай, когда сам корабль или цель уже внутри радиуса (тогда
	// снаружи провести маршрут в принципе нельзя — берём лучшее возможное).
	limit := math.Min(starAvoidCells, math.Min(math.Hypot(fx, fy), math.Hypot(tx, ty))) - 1e-9
	r := starAvoidCells
	for i := 0; i < 24; i++ {
		mx, my = ux*r, uy*r
		if segmentDistToStar(fx, fy, mx, my) >= limit && segmentDistToStar(mx, my, tx, ty) >= limit {
			break
		}
		r *= 1.12
	}
	return mx, my, true
}

// segmentDistToStar — расстояние от центра системы (светила) до ОТРЕЗКА
// a→b, в клетях.
func segmentDistToStar(ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	length2 := dx*dx + dy*dy
	if length2 <= 1e-12 {
		return math.Hypot(ax, ay)
	}
	s := -(ax*dx + ay*dy) / length2
	if s < 0 {
		s = 0
	}
	if s > 1 {
		s = 1
	}
	return math.Hypot(ax+dx*s, ay+dy*s)
}

// routeLength — длина маршрута from→to С УЧЁТОМ обхода светила: прямая, если
// обходить нечего, иначе сумма двух участков. Кинематика (flightProfile)
// считается именно от неё, иначе обход был бы «бесплатным» по времени и
// топливу.
func routeLength(fx, fy, tx, ty float64) float64 {
	if mx, my, ok := avoidStarWaypoint(fx, fy, tx, ty); ok {
		return math.Hypot(mx-fx, my-fy) + math.Hypot(tx-mx, ty-my)
	}
	return math.Hypot(tx-fx, ty-fy)
}

// systemEdgeRadius — на каком расстоянии от целевой звезды заканчивается
// межзвёздный перелёт («край системы», прямое требование пользователя).
// starDistance — уже в ЭКРАНАХ (см. sectorCletsToScreens, shipphysics.go —
// вызывающий обязан сконвертировать секторные клети ДО этого вызова).
//
// ИСПРАВЛЕНО (была здесь до этой правки): раньше starDistance приходил
// НЕконвертированным (секторные клети напрямую), из-за чего типичное
// расстояние (7,35) оказывалось МЕНЬШЕ радиуса системы (35) — «край
// системы» лежал позади точки старта, корабль полетел бы назад. Костыль —
// делить дистанцию на искусственную долю (0.45) — снят: с честной
// конверсией starDistance теперь всегда на порядок больше sysR (типичный
// перелёт ≈100 экранов против радиуса системы 35), и обычный минимум
// работает как задумано с самого начала.
func systemEdgeRadius(sysR, starDistance float64) float64 {
	edge := math.Min(sysR, starDistance)
	if edge < starAvoidCells {
		edge = starAvoidCells
	}
	return edge
}

// navDecelFor — с каким ускорением автопилот ТОРМОЗИТ, подходя к цели.
//
// По прямой жалобе пользователя («посадка на планету очень долгая — видимо
// гравитационного торможения ×10 недостаточно, или это забыли реализовать?»):
// реализовано оно было (ТЗ.md §2.7.6), но ТОЛЬКО для ручного полёта
// (`settleFlight`/`nearGravityWell`), а автопилот тормозил обычной тягой —
// то есть ровно столько же времени, сколько разгонялся. Теперь подлёт К
// ПЛАНЕТЕ тормозится в её гравитационном колодце: тем же множителем
// gravityBrakeMultiplier, что и вручную, — одна константа на обе механики.
//
// Сознательное упрощение: у ручного торможения множитель включается только
// В РАДИУСЕ колодца (`gravityBrakeRadiusFactor`), а здесь применяется ко
// всей фазе торможения. Честный вариант («помогает только у самой планеты»)
// даёт выигрыш в единицы секунд на перелёт в десятки клетей — тормозной
// путь на порядок длиннее радиуса колодца, — то есть на жалобу не отвечает
// вовсе. Замер на реальном корабле: перелёт 20 клетей 475 с → 350 с.
//
// Цели без колодца (звезда, точка в пустоте) тормозятся обычной тягой:
// профиль остаётся симметричным.
func navDecelFor(accelUE float64, kind string) float64 {
	if kind == "planet" {
		return accelUE * gravityBrakeMultiplier
	}
	return accelUE
}

// entrySpeedOnCourse — с какой скоростью профиль перелёта начинается, если
// команда «лететь» отдана НА ХОДУ: проекция текущей скорости на направление
// нового маршрута (составляющая поперёк курса и назад гасится манёвром
// разворота — упрощение, зато без единственного оставшегося рывка: без
// проекции корабль, летящий ОТ цели, мгновенно уносился бы к ней на полной
// скорости задним ходом, а с нулём — так же мгновенно терял бы ход, идя ровно
// по курсу).
func entrySpeedOnCourse(speed, headingRad, courseRad float64) float64 {
	if speed <= 0 {
		return 0
	}
	v := speed * math.Cos(courseRad-headingRad)
	if v < 0 {
		return 0
	}
	return v
}

// turnSecFor — за сколько секунд «времени корабля» корабль довернёт с курса
// from на курс to своей штатной скоростью поворота (turnRateDegFor). Если
// перелёт короче разворота, разворот сжимается под него (totalSec): курс к
// прилёту всё равно обязан совпасть с направлением маршрута, иначе обзор
// скакнёт в момент прилёта — ровно тот скачок, ради устранения которого
// разворот и введён.
func turnSecFor(fromDeg, toDeg, accelUE, totalSec float64) float64 {
	rate := turnRateDegFor(accelUE)
	if rate <= 0 {
		return 0
	}
	sec := math.Abs(shortestAngleDeg(fromDeg, toDeg)) / rate
	if totalSec > 0 && sec > totalSec {
		sec = totalSec
	}
	return sec
}

// rebaseTransit — пере-целивание УЖЕ летящего корабля под НОВЫЙ коэффициент
// ускорения времени (эта правка, прямая жалоба пользователя: «на больших
// ускорениях планета улетает от корабля... их глобальное время не
// синхронно, курс не корректируется по мере движения планет по орбитам»).
//
// Корень бага: упреждение цели в Navigate (см. комментарий там, «планета не
// ждёт») считает, СКОЛЬКО игровых месяцев пройдёт за время полёта, через
// `flightSec*snap.Speed` — снимок ТЕКУЩЕЙ скорости часов НА МОМЕНТ прокладки
// курса. Если админ меняет скорость (`SetSpeed`, main.go) уже В ПОЛЁТЕ, это
// упреждение не пересчитывается — Transit продолжает целиться в точку,
// предсказанную по СТАРОЙ скорости, а реальные месяцы (Clock.months) с этого
// момента идут по НОВОЙ — планета/звезда к прилёту оказывается не там.
//
// Честный фикс — не «доверить» старому прицелу, а честно переприцелиться:
// сворачиваем Transit в РЕАЛЬНУЮ текущую точку (тот же collapseTransit, что
// и у смены цели в полёте) и прокладываем курс ЗАНОВО на ТУ ЖЕ цель — тем же
// путём (Navigate), что и обычная перепрокладка, так что вся уже
// проверенная логика (упреждение, HasPendingInterstellarOrigin, курс/
// разворот) отрабатывает без дублирования. ЕДИНСТВЕННАЯ поправка —
// пере-целивание админом НЕ должно стоить игроку топлива (это не решение
// игрока, это сервер ЧЕСТНО поправляет уже оплаченный курс под новую
// скорость) — поэтому запас топлива/батареи/цикла до и после Navigate
// принудительно возвращается как было.
func (sh *Ship) rebaseTransit(sim *Sim, now time.Time) {
	sh.mu.Lock()
	t := sh.Transit
	if t == nil {
		sh.mu.Unlock()
		return
	}
	kind := t.TargetKind
	planetIdx := t.TargetPlanetIndex
	starID := sh.SystemStarID
	if t.Mode == "interstellar" {
		starID = t.ToStarID
	}
	fuelHydrogen, fuelHelium3 := sh.FuelHydrogen, sh.FuelHelium3
	battery, cycleAccum := sh.BatteryCharge, sh.FuelCycleAccumSec
	sh.mu.Unlock()

	if err := sh.Navigate(sim, now, kind, starID, planetIdx); err != nil {
		return // не смогли перецелиться (например, цель пропала) — оставляем как было, не роняем полёт
	}

	sh.mu.Lock()
	sh.FuelHydrogen, sh.FuelHelium3 = fuelHydrogen, fuelHelium3
	sh.BatteryCharge, sh.FuelCycleAccumSec = battery, cycleAccum
	sh.mu.Unlock()
}

// rebaseAllActiveTransits — пере-целивает ВСЕ летящие корабли всех флотов
// разом (вызывается из handleSpeed, main.go, сразу после смены скорости
// часов) — см. rebaseTransit выше.
func rebaseAllActiveTransits(sim *Sim, now time.Time) {
	for _, f := range fleets {
		if f.Ship == nil {
			continue
		}
		f.Ship.rebaseTransit(sim, now)
	}
}

// TravelEstimate — предпросчёт полёта ДО нажатия «лететь» (ТЗ_UI.md §2, прямой
// запрос пользователя: время и расход топлива видны заранее). Seconds — полное
// время (разгон + крейсерский участок); FuelUnits считает только фазу разгона
// (ТЗ_Корабль.md §4.5 — по инерции двигатель не потребляет), FuelKey — тип
// топлива ("hydrogen"/"helium3") или пусто, если на корабле нет двигателей
// вовсе (тогда FuelUnits==0 без какого-либо смысла «атомный реактор» — реактор
// в этой модели физически не участвует в тяге, см. shipphysics.go, отдельная
// ветка для него не нужна).
type TravelEstimate struct {
	Seconds   float64 `json:"seconds"`
	FuelUnits float64 `json:"fuelUnits"`
	FuelKey   string  `json:"fuelKey"`
}

// EstimateTravel — то же прицеливание, что Navigate, но НИЧЕГО не меняет в
// состоянии корабля (ни Transit, ни DockAngleOffset) — чистое чтение для
// предпросмотра. Геометрия продублирована из Navigate почти дословно
// намеренно: раздвоение здесь чище, чем тащить общий хелпер, который так и
// так пришлось бы параметризовать флагом «мутировать/не мутировать»
// DockAngleOffset — а это ровно то ветвление, которого разделение функций
// избегает.
func (sh *Ship) EstimateTravel(sim *Sim, now time.Time, kind string, starID, planetIdx int) (TravelEstimate, error) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)

	if sh.Landed {
		return TravelEstimate{}, ErrShipLanded
	}

	star, ok := sim.Object(starID)
	if !ok || star.Type != "star" {
		return TravelEstimate{}, ErrUnknownTarget
	}

	navRatio := sh.Physics.steadyFuelRatio(sh.FuelHydrogen, sh.BatteryCharge, fuelUnitYieldHydrogen) // автопилот — см. Navigate
	navAccelUE := sh.Physics.accelAtRatio(navRatio)
	navDecelUE := navDecelFor(navAccelUE, kind)
	maxThrustSec := sh.maxThrustSecFor("hydrogen")
	navTimeFactor := timeAccelFactor()
	if navTimeFactor <= 0 {
		navTimeFactor = 1
	}

	// Смена цели В ПОЛЁТЕ разрешена (см. Navigate) — предпросмотр должен
	// считать ETA от той же (не мутирующей!) точки, докуда корабль реально
	// долетел к этому моменту, не от снимка до старта перелёта.
	fxCur, fyCur, curSpeed, curHeading, pendingR, pendingArc, hasPending := sh.previewCollapsedState(now)
	if kind == "planet" && hasPending {
		return TravelEstimate{}, ErrNoSystemContext // см. Navigate
	}
	inSystem := starID == sh.SystemStarID && !hasPending

	if kind == "star" && inSystem {
		return TravelEstimate{}, ErrStarNotTarget // см. Navigate
	}

	var distanceCells float64
	// Скорость на старте — та же, что подставит Navigate (проекция текущей на
	// курс маршрута), иначе предпросчёт разошёлся бы с фактическим перелётом.
	entrySpeed := curSpeed
	navDecel := navDecelUE
	if inSystem {
		fx, fy := fxCur, fyCur
		tx, ty := 0.0, 0.0
		flightSec := 0.0
		if kind == "planet" {
			if planetIdx < 0 || planetIdx >= len(star.Planets) {
				return TravelEstimate{}, ErrBadPlanetIndex
			}
			p := star.Planets[planetIdx]
			snap := clk.Snapshot()
			dockR := p.Diameter / 2 * dockRadiusFactor
			for i := 0; i < 4; i++ {
				arriveMonths := snap.Months + flightSec*snap.Speed
				pAngle := p.Angle + p.AngVel*arriveMonths
				pcx, pcy := p.Orbit*math.Cos(pAngle), p.Orbit*math.Sin(pAngle)
				dx, dy := pcx-fx, pcy-fy
				dist0 := math.Hypot(dx, dy)
				var ux, uy float64
				if dist0 > 1e-6 {
					ux, uy = dx/dist0, dy/dist0
				} else {
					ux, uy = math.Cos(pAngle), math.Sin(pAngle)
				}
				tx, ty = pcx-ux*dockR, pcy-uy*dockR
				flightSec = newFlightProfile(routeLength(fx, fy, tx, ty), navAccelUE, navDecelUE,
					entrySpeedOnCourse(curSpeed, curHeading, math.Atan2(ty-fy, tx-fx)), maxThrustSec).totalSec()
			}
		}
		// Длина маршрута — с обходом светила, курс — на ПЕРВЫЙ участок: ровно
		// то же, что построит Navigate.
		distanceCells = routeLength(fx, fy, tx, ty)
		firstX, firstY := tx, ty
		if mx, my, ok := avoidStarWaypoint(fx, fy, tx, ty); ok {
			firstX, firstY = mx, my
		}
		entrySpeed = entrySpeedOnCourse(curSpeed, curHeading, math.Atan2(firstY-fy, firstX-fx))
	} else if hasPending {
		fromR, fromX := pendingR, pendingArc
		toR, toX := star.R, star.xAt(clk.Snapshot().Months)
		distClets := math.Hypot(toR-fromR, toX-fromX)
		distScreens := sectorCletsToScreens(distClets)
		distanceCells = math.Max(0, distScreens-systemEdgeRadius(star.SystemRadius, distScreens))
		navDecel = navAccelUE
	} else {
		origin, ok := sim.Object(sh.SystemStarID)
		if !ok {
			return TravelEstimate{}, ErrUnknownTarget
		}
		gameNow := clk.Snapshot().Months
		fromR, fromX := origin.R, origin.xAt(gameNow)
		toR, toX := star.R, star.xAt(gameNow)
		distClets := math.Hypot(toR-fromR, toX-fromX)
		distScreens := sectorCletsToScreens(distClets) // секторные клети → экраны, та же конверсия, что в Navigate
		// Межзвёздный перелёт кончается на границе целевой системы, а не у
		// светила (systemEdgeRadius) — и тормозится двигателем, без
		// гравитационной помощи: те же условия, что в Navigate.
		distanceCells = math.Max(0, distScreens-systemEdgeRadius(star.SystemRadius, distScreens))
		navDecel = navAccelUE
	}

	prof := newFlightProfile(distanceCells, navAccelUE, navDecel, entrySpeed, maxThrustSec)
	totalSec, accelSec := prof.totalSec(), prof.thrustSec()
	// Seconds — РЕАЛЬНОЕ время ожидания игроком (то, что Navigate реально
	// поставит в ArriveAt), поэтому делится на текущий множитель ускорения;
	// accelSec — «время корабля» под тягой, топливо от темпа часов не зависит
	// (см. шапку файла) — расход НЕ делится на navTimeFactor.
	est := TravelEstimate{Seconds: totalSec / navTimeFactor, FuelKey: "hydrogen"}
	// FuelUnits — ЧЕСТНЫЙ прогноз, той же симуляцией по циклам, что и
	// deductFlightFuel реально спишет при коммите (не read/write реального
	// Ship — превью на копиях запаса/батареи).
	{
		stock, battery := sh.FuelHydrogen, sh.BatteryCharge
		total := sh.FuelCycleAccumSec + accelSec
		cycles := int(total / energyCyclePeriodSec)
		for i := 0; i < cycles; i++ {
			sh.Physics.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
		}
		est.FuelUnits = sh.FuelHydrogen - stock
	}
	return est, nil
}

// Land высаживает корабль на планету, у которой он сейчас находится
// (AtPlanetIndex ≥ 0). Газовые гиганты твёрдой поверхности не имеют —
// посадка на них отклоняется (см. Planet.Surface, planets.go).
func (sh *Ship) Land(sim *Sim, now time.Time) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	sh.settleLifeSupport(now)

	if sh.Transit != nil {
		return ErrShipBusy
	}
	if sh.Landed {
		return ErrAlreadyLanded
	}
	if sh.AtPlanetIndex < 0 {
		return ErrNoPlanetHere
	}
	star, found := sim.Object(sh.SystemStarID)
	if !found || sh.AtPlanetIndex >= len(star.Planets) {
		return ErrNoPlanetHere
	}
	if star.Planets[sh.AtPlanetIndex].Type == "gas" {
		return ErrNoSolidSurface
	}
	sh.Landed = true
	sh.LandedPlanetIndex = sh.AtPlanetIndex
	sh.Speed = 0
	sh.Control = nil
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
