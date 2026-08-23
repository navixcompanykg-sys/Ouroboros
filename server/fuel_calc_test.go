package main

import (
	"math"
	"testing"
	"time"
)

// TestTwoInterstellarFlightsOnOneTank — ФАКТИЧЕСКАЯ проверка топливного
// бюджета, а не расчёт по формуле (ТЗ.md §0, главный принцип — никаких
// подгонок): каждый из 4 стартовых кораблей реально летает по маршруту «к
// соседней звезде → к САМОЙ ДАЛЬНЕЙ планете её системы» ДВАЖДЫ, через
// настоящие Navigate/resolveTransit, с настоящим списанием топлива. Дальняя
// планета — намеренно худший случай подлёта внутри системы (ближняя дала бы
// вдвое мягче результат).
//
// ДИАГНОСТИЧЕСКИЙ, не строгий тест (t.Logf, без t.Fatalf на нехватку
// топлива): по прямому требованию пользователя период сжигания сделан
// ЖЁСТЧЕ (90с → 60с на единицу для эталонного двигателя) специально для
// того, чтобы слабым/мелким кораблям было труднее и они были вынуждены
// возить больше запаса — то есть НЕХВАТКА топлива в предельном случае (самый
// прожорливый корабль, самая дальняя планета, дважды подряд) это ОЖИДАЕМЫЙ,
// а не аварийный исход; тест это фиксирует фактом, не скрывает и не
// подгоняет константу под гарантированный успех.
func TestTwoInterstellarFlightsOnOneTank(t *testing.T) {
	clk = NewClock(gameSpeedRealtime)
	sim = NewSim(11)
	forceHabitableCapitals(sim)
	loadEconomy()
	loadShipDefaults()
	initFleets(sim)

	objects, _ := sim.Snapshot()
	starByID := map[int]*Object{}
	for _, o := range objects {
		if o.Type == "star" {
			starByID[o.ID] = o
		}
	}
	nearestStar := func(fromID int) (int, float64) {
		me := starByID[fromID]
		bestID, best := 0, math.MaxFloat64
		for id, o := range starByID {
			if id == fromID {
				continue
			}
			if d := math.Hypot(me.R-o.R, me.X0-o.X0); d < best {
				bestID, best = id, d
			}
		}
		return bestID, best
	}

	for _, f := range fleets {
		sh := f.Ship
		if sh == nil {
			continue
		}
		startFuel := sh.FuelHydrogen
		fuel := startFuel
		log := ""
		for leg := 1; leg <= 2; leg++ {
			target, dist := nearestStar(sh.SystemStarID)
			if err := sh.Navigate(sim, time.Now(), "star", target, -1); err != nil {
				log += "\n    перелёт " + itoa(leg) + ": межзвёздный " + f1(dist) +
					" клети — НЕ СОСТОЯЛСЯ (" + err.Error() + ")"
				break
			}
			arrive(sh)
			spentInter := fuel - sh.FuelHydrogen
			fuel = sh.FuelHydrogen

			star := starByID[sh.SystemStarID]
			idx, pd := farthestPlanet(sh, star)
			spentLocal := 0.0
			failed := ""
			if idx >= 0 {
				if err := sh.Navigate(sim, time.Now(), "planet", star.ID, idx); err != nil {
					failed = " — НЕ СОСТОЯЛСЯ (" + err.Error() + ")"
				} else {
					arrive(sh)
					spentLocal = fuel - sh.FuelHydrogen
					fuel = sh.FuelHydrogen
				}
			}
			log += formatLeg(leg, dist, spentInter, pd, spentLocal, failed)
			if failed != "" {
				break
			}
		}
		t.Logf("%-22s бак %5.0f → осталось %5.0f (%.0f%%)%s",
			sh.Design, startFuel, fuel, fuel/startFuel*100, log)
	}
}

// TestEngineEfficiencyComparison — ФАКТИЧЕСКОЕ сравнение обычного и ионного
// двигателя, а не заявление «ионный эффективнее/хуже» (прямое требование
// пользователя: «ионные двигатели не дают больше тяги, у них больше лимит
// сжигания топлива за раз и выше выдача ускорения за счёт этого — так и
// было, давай сравним эффективность на деле»).
//
// ⚠ Квантованная модель (settleEnergyCycle, shipphysics.go) не знает
// понятия «мгновенный расход, ед./с» — жжётся ЦЕЛЫМИ единицами раз в цикл
// (energyCyclePeriodSec), и то, сколько именно, зависит от заряда батареи
// на этот момент, не только от спроса. «Расход» ниже — фактически сожжённое
// количество ЗА ЭТАЛОННЫЙ МАНЁВР (fuelBurnedForThrust, симуляция циклов на
// копиях запаса — тот же приём, что EstimateTravel/deductFlightFuel, ship.go),
// не производная формула.
//
// Берёт РЕАЛЬНЫЕ 4 стартовых дизайна (не синтетику): 2 ионных (Корвет
// Патрульный, Шатл 2 Скоростной) и 2 обычных (Шатл Грузовой, Корвет 2
// Боевой) — уже готовая пара сравнения из живой библиотеки кораблей.
// Печатает по каждому: тягу/массу (accelUE, steadyFuelRatio — «в среднем»,
// см. shipphysics.go) и расход на одинаковый эталонный манёвр (20 клетей,
// тот же ориентир, что и внутрисистемный подлёт в
// TestTwoInterstellarFlightsOnOneTank), чтобы видеть КОНКРЕТНЫЙ размен
// «быстрее, но дороже» на реальной дистанции, а не только абстрактный
// коэффициент.
func TestEngineEfficiencyComparison(t *testing.T) {
	clk = NewClock(gameSpeedRealtime)
	sim = NewSim(11)
	forceHabitableCapitals(sim)
	loadEconomy()
	loadShipDefaults()
	initFleets(sim)

	const refCells = 20.0 // тот же ориентир, что и «внутрисистемный подлёт» выше

	for _, f := range fleets {
		sh := f.Ship
		if sh == nil {
			continue
		}
		ratio := sh.Physics.steadyFuelRatio(sh.FuelHydrogen, sh.BatteryCharge, fuelUnitYieldHydrogen)
		accel := sh.Physics.accelAtRatio(ratio)
		prof := newFlightProfile(refCells, accel, accel, 0, math.Inf(1))
		fuelForRef := fuelBurnedForThrust(sh, prof.thrustSec())
		rateEd := 0.0
		if prof.thrustSec() > 0 {
			rateEd = fuelForRef / prof.thrustSec()
		}
		effic := safeDiv(accel, rateEd)

		t.Logf("%-22s accelUE %7.1f | расход %.4f ед./с (=%.0f с/ед.) | ускорение/расход %8.0f | эталон %.0f клетей: %.0f с, %.1f ед.",
			sh.Design, accel, rateEd, safeDiv(1, rateEd), effic, refCells, prof.thrustSec(), fuelForRef)
	}
}

// fuelBurnedForThrust — сколько единиц водорода реально сгорит за thrustSec
// секунд ПОД ТЯГОЙ, симуляцией дискретных циклов НА КОПИЯХ запаса/батареи
// (реальный Ship не трогает) — тот же приём, что ship.go EstimateTravel/
// deductFlightFuel.
func fuelBurnedForThrust(sh *Ship, thrustSec float64) float64 {
	stock, battery := sh.FuelHydrogen, sh.BatteryCharge
	cycles := int(thrustSec / energyCyclePeriodSec)
	for i := 0; i < cycles; i++ {
		sh.Physics.settleEnergyCycle(&stock, fuelUnitYieldHydrogen, &battery)
	}
	return sh.FuelHydrogen - stock
}

func safeDiv(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

// arrive — досрочно финализировать перелёт (в тесте не ждём реального
// времени полёта, но проходим ровно через тот же resolveTransit).
func arrive(sh *Ship) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if sh.Transit != nil {
		sh.resolveTransit(sh.Transit.ArriveAt)
	}
}

// farthestPlanet — САМАЯ ДАЛЬНЯЯ планета системы, а не ближняя: честный
// худший случай «перемещения внутри системы» после прилёта на границу (у
// ближней проверка была бы вдвое мягче реальной).
func farthestPlanet(sh *Ship, star *Object) (int, float64) {
	if star == nil {
		return -1, 0
	}
	months := clk.Snapshot().Months
	best, bestD := -1, 0.0
	for i := range star.Planets {
		p := &star.Planets[i]
		a := p.Angle + p.AngVel*months
		x, y := p.Orbit*math.Cos(a), p.Orbit*math.Sin(a)
		if d := math.Hypot(x-sh.SX, y-sh.SY); d > bestD {
			best, bestD = i, d
		}
	}
	return best, bestD
}

// interDist приходит в СЕКТОРНЫХ клетях (Object.R/X0) — конвертируем в
// экраны той же функцией, что и продакшен-код (server/ship.go Navigate),
// чтобы в логе была видна реальная дистанция полёта, а не сектор-клети,
// которые ничего не говорят о времени/топливе (см. sectorCletsToScreens,
// shipphysics.go).
func formatLeg(leg int, interDist, interFuel, planetDist, planetFuel float64, failed string) string {
	return "\n    перелёт " + itoa(leg) +
		": межзвёздный " + f1(interDist) + " клети (≈" + f1(sectorCletsToScreens(interDist)) + " экр.) → " + f1(interFuel) + " ед.; " +
		"подлёт к планете " + f1(planetDist) + " экр. → " + f1(planetFuel) + " ед." + failed
}

func itoa(v int) string { return string(rune('0' + v)) }
func f1(v float64) string {
	s := ""
	if v < 0 {
		s, v = "-", -v
	}
	whole := int(v)
	frac := int((v - float64(whole)) * 10)
	return s + itoaN(whole) + "." + string(rune('0'+frac))
}
func itoaN(v int) string {
	if v == 0 {
		return "0"
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	return string(b)
}

// TestFourShipsFlightComparison — по прямому запросу пользователя: взять
// одну цель и прогнать через неё все 4 стартовых корабля, вживую (Navigate/
// resolveTransit, настоящее списание топлива, настоящий критический резерв
// на манёвр и настоящий вклад реактора — ship.go/shipphysics.go), и
// напечатать 4 показателя по каждому: время полёта, максимально достигнутая
// скорость, расход топлива, ускорение двигателя (у.е./с²).
//
// Цель — межзвёздный перелёт к ближайшей соседней звезде (7,2 секторных
// клети ≈ 98 экранов на этом сиде, sectorCletsToScreens): самый частый и
// самый нагруженный по расчёту случай (гравиторможения нет, топливо
// тратится на ОБЕ фазы тяги полностью).
func TestFourShipsFlightComparison(t *testing.T) {
	clk = NewClock(gameSpeedRealtime)
	sim = NewSim(11)
	forceHabitableCapitals(sim)
	loadEconomy()
	loadShipDefaults()
	initFleets(sim)

	objects, _ := sim.Snapshot()
	starByID := map[int]*Object{}
	for _, o := range objects {
		if o.Type == "star" {
			starByID[o.ID] = o
		}
	}

	t.Logf("%-22s | %-10s | %-14s | %-27s | %-12s | %s",
		"корабль", "время", "макс.скорость", "% пути разгон/торможение", "топливо", "ускорение")
	for _, f := range fleets {
		sh := f.Ship
		if sh == nil {
			continue
		}
		me := starByID[sh.SystemStarID]
		target, targetID := (*Object)(nil), 0
		best := math.MaxFloat64
		for id, o := range starByID {
			if id == sh.SystemStarID {
				continue
			}
			if d := math.Hypot(me.R-o.R, me.X0-o.X0); d < best {
				best, target, targetID = d, o, id
			}
		}
		_ = target

		fuelBefore := sh.FuelHydrogen
		navRatio := sh.Physics.steadyFuelRatio(sh.FuelHydrogen, sh.BatteryCharge, fuelUnitYieldHydrogen)
		accelUE := sh.Physics.accelAtRatio(navRatio)
		if err := sh.Navigate(sim, time.Now(), "star", targetID, -1); err != nil {
			t.Logf("%-22s — перелёт не состоялся: %v", sh.Design, err)
			continue
		}

		sh.mu.Lock()
		tr := sh.Transit
		sh.mu.Unlock()
		if tr == nil {
			t.Errorf("%s: Navigate не создал Transit", sh.Design)
			continue
		}
		totalSec := tr.Profile.totalSec()

		// Максимально ДОСТИГНУТАЯ скорость — не просто PeakSpeed из профиля
		// (он мог быть урезан критическим резервом топлива), а честный замер
		// по самой кинематике: сэмплируем stateAt по всему перелёту.
		maxSpeed := 0.0
		const samples = 400
		for i := 0; i <= samples; i++ {
			_, v := tr.Profile.stateAt(totalSec * float64(i) / samples)
			if v > maxSpeed {
				maxSpeed = v
			}
		}

		// % ПУТИ (дистанции, не времени) на разгон/торможение — по прямому
		// запросу пользователя. Через stateAt (та же кинематика, что и вся
		// остальная навигация), не через AccelSec/DecelSec напрямую: доля
		// ВРЕМЕНИ и доля ПУТИ — разные числа (на разгоне корабль медленнее,
		// значит доля пути под разгоном МЕНЬШЕ доли времени под разгоном).
		p := tr.Profile
		distAcc, _ := p.stateAt(p.AccelSec)
		distToDecel, _ := p.stateAt(p.AccelSec + p.CruiseSec)
		distDecel := p.DistanceUE - distToDecel
		pctAccel, pctDecel := 0.0, 0.0
		if p.DistanceUE > 0 {
			pctAccel = distAcc / p.DistanceUE * 100
			pctDecel = distDecel / p.DistanceUE * 100
		}

		arrive(sh)
		fuelSpent := fuelBefore - sh.FuelHydrogen

		t.Logf("%-22s | %8.1f с | %11.0f у.е. | %5.1f%% разгон / %5.1f%% торможение | %9.1f ед. | %8.1f у.е./с²",
			sh.Design, totalSec, maxSpeed, pctAccel, pctDecel, fuelSpent, accelUE)
	}
}
