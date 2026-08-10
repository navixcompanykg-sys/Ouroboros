package main

import (
	"math"
	"math/rand"
	"sort"
)

// ════════════════════════════════════════════════════════════════════════════
// ГЕНЕРАТОР ГАЛАКТИКИ — перенесён из client/galaxy.html без изменения правил.
// Все числа и формулы соответствуют ТЗ.md §2.1–2.3 и §2.11.
//
// Сервер — единственный владелец состояния сектора: он засевает объекты,
// считает их орбиты и решает, кто покинул окно и кто вошёл взамен. Клиент
// ничего не разыгрывает сам, иначе два телефона показали бы разные галактики.
// ════════════════════════════════════════════════════════════════════════════

const (
	maxR     = 120.0 // радиальная ось окна (клети)
	halfW    = 60.0  // половина ширины окна по дуговой оси
	trueR0   = 280.0 // от истинного центра галактики до ближнего края окна
	pxpu     = 300.0 / maxR
	apexX    = 150.0
	minSepPx = 15.0 // минимальный экранный зазор между точечными объектами

	// Уход и вход разнесены за границы окна: объект доезжает до края и только
	// потом исчезает, а новый выезжает из-за края, а не возникает в кадре.
	exitX  = 128.0
	entryX = -8.0
)

var apexY = 300.0 + trueR0*pxpu

func toXY(r, x float64) (float64, float64) {
	tr := trueR0 + r
	theta := (x - halfW) / tr
	trpx := tr * pxpu
	return apexX + trpx*math.Sin(theta), apexY - trpx*math.Cos(theta)
}

// ── 12 зон (ТЗ.md §2.1/§2.2) ────────────────────────────────────────────────
// months — «время выхода из радиуса»: опорная точка кривой, отнесённая к
// СЕРЕДИНЕ зоны. Реальная скорость каждой орбиты берётся из arcSpeedAt.
type Zone struct {
	ID      int
	Months  float64
	Stars   int
	Density float64
	BhW     float64
	StarW   map[string]float64
	R0, R1  float64
}

var zones = func() []*Zone {
	z := []*Zone{
		{ID: 1, Months: 1, Stars: 7, Density: 3.0, BhW: 3, StarW: map[string]float64{"red": 5, "yellow": 5, "blue": 30, "white": 0, "neutron": 60}},
		{ID: 2, Months: 2, Stars: 8, Density: 2.9, BhW: 2.5, StarW: map[string]float64{"red": 5, "yellow": 5, "blue": 30, "white": 0, "neutron": 60}},
		{ID: 3, Months: 3, Stars: 9, Density: 2.6, BhW: 1.2, StarW: map[string]float64{"red": 30, "yellow": 30, "blue": 20, "white": 0, "neutron": 20}},
		{ID: 4, Months: 4, Stars: 9, Density: 2.5, BhW: 1, StarW: map[string]float64{"red": 30, "yellow": 30, "blue": 20, "white": 0, "neutron": 20}},
		{ID: 5, Months: 5, Stars: 7, Density: 2.7, BhW: 0.8, StarW: map[string]float64{"red": 15, "yellow": 15, "blue": 25, "white": 10, "neutron": 35}},
		{ID: 6, Months: 0, Stars: 9, Density: 2.3, BhW: 0, StarW: map[string]float64{"red": 35, "yellow": 50, "blue": 0, "white": 15, "neutron": 0}},
		{ID: 7, Months: 0, Stars: 10, Density: 2.0, BhW: 0, StarW: map[string]float64{"red": 35, "yellow": 50, "blue": 0, "white": 15, "neutron": 0}},
		{ID: 8, Months: 0, Stars: 10, Density: 1.8, BhW: 0, StarW: map[string]float64{"red": 35, "yellow": 50, "blue": 0, "white": 15, "neutron": 0}},
		{ID: 9, Months: 9, Stars: 9, Density: 1.5, BhW: 0, StarW: map[string]float64{"red": 40, "yellow": 10, "blue": 0, "white": 50, "neutron": 0}},
		{ID: 10, Months: 10, Stars: 8, Density: 1.3, BhW: 0, StarW: map[string]float64{"red": 40, "yellow": 10, "blue": 0, "white": 50, "neutron": 0}},
		{ID: 11, Months: 11, Stars: 8, Density: 1.1, BhW: 0, StarW: map[string]float64{"red": 40, "yellow": 10, "blue": 0, "white": 50, "neutron": 0}},
		{ID: 12, Months: 12, Stars: 7, Density: 0.9, BhW: 0, StarW: map[string]float64{"red": 40, "yellow": 10, "blue": 0, "white": 50, "neutron": 0}},
	}
	for i, zz := range z {
		zz.R0 = float64(i) * 10
		zz.R1 = float64(i+1) * 10
	}
	return z
}()

// ── скорость принадлежит ОРБИТЕ, а не зоне: между серединами зон линейная
// интерполяция, поэтому переход через границу зоны незаметен ──────────────
type orbitPt struct{ r, arc float64 }

// Неподвижная полоса Империи — зоны 6–8, то есть r = 50…80 (ТЗ.md §2.1).
const (
	stableBandR0 = 50.0
	stableBandR1 = 80.0
)

var orbitPts = func() []orbitPt {
	var p []orbitPt
	for _, z := range zones {
		if z.Months <= 0 {
			continue // стабильная полоса задаётся не серединами зон, а границами — ниже
		}
		p = append(p, orbitPt{r: (z.R0 + z.R1) / 2, arc: 120 / z.Months})
	}
	// Нули ставим на КРАЯХ полосы, а не в серединах зон 6–8. Иначе интерполяция
	// идёт от середины зоны 5 (r=45, скорость 24) к середине зоны 6 (r=55, ноль),
	// и на участке r=50…55 скорость остаётся ненулевой — то есть часть орбит
	// ВНУТРИ полосы стабильности продолжает ехать. Симметрично на r=80…85.
	// Теперь разгон и торможение целиком укладываются в соседние зоны 5 и 9.
	p = append(p, orbitPt{r: stableBandR0, arc: 0}, orbitPt{r: stableBandR1, arc: 0})
	sort.Slice(p, func(i, j int) bool { return p[i].r < p[j].r })
	return p
}()

// arcSpeedAt — клетей по дуге за игровой месяц на орбите r.
func arcSpeedAt(r float64) float64 {
	if r <= orbitPts[0].r {
		return orbitPts[0].arc
	}
	last := orbitPts[len(orbitPts)-1]
	if r >= last.r {
		return last.arc
	}
	for i := 0; i < len(orbitPts)-1; i++ {
		a, b := orbitPts[i], orbitPts[i+1]
		if r <= b.r {
			return a.arc + (b.arc-a.arc)*(r-a.r)/(b.r-a.r)
		}
	}
	return 0
}

// ── массы (условные солнечные): переносятся от ушедшего объекта к вошедшему ──
var starMass = map[string][2]float64{
	"red":     {0.10, 0.60},
	"yellow":  {0.80, 1.20},
	"white":   {0.50, 1.00},
	"blue":    {10.0, 30.0},
	"neutron": {1.40, 2.20},
}

var bhMass = [2]float64{50, 300}

const (
	nebTotal = 150
	astTotal = 250
	bhTotal  = 8
)

// Типы планет — пять эффективных типов из v1 (archive/docs/RESOURCES_design.md):
// core (голое ядро), lava, rocky, ice, gas. Прежний прототип v2 держал ещё
// ocean/toxic/desert — это была ошибка: в v1 они не типы планет, а доли биомов
// на поверхности (surf.deserts и т.п.), считаются уже внутри планетарного UI.
var factionKeys = []string{"technocracy", "tradefed", "monarchy", "miners", "pirates", "smugglers", "rebels", "none"}

type stableWorld struct {
	zone    int
	r, x    float64
	faction string
	role    string
}

// ── 4 стабильных мира: по одному в каждой четверти по меридиану ─────────────
//
// Четверти — вертикальные полосы по дуговой оси шириной 30 клетей: 0–30, 30–60,
// 60–90, 90–120. Требование: при ЛЮБОМ сиде четыре мира лежат в четырёх разных
// четвертях, две звезды не могут оказаться рядом.
//
// Столица стоит строго в середине карты (x=60, r=60) — это вынужденно: от неё
// центрируется круг перелётов (§2.3), а он должен быть вписан в окно, иначе
// часть сектора недостижима. Формально x=60 — левый край третьей четверти,
// поэтому столица занимает её, а три вассала расходятся по 1-й, 2-й и 4-й.
//
// Полосы для вассалов взяты уже самих четвертей: так между соседними мирами
// остаётся зазор не меньше 10 клетей (ближайшая пара — вассал 2-й четверти и
// столица), и они не слипаются визуально.
type quarterBand struct{ x0, x1 float64 }

var vassalBands = []quarterBand{{10, 20}, {35, 50}, {100, 112}} // четверти 1, 2 и 4

const (
	capitalR = 60.0 // центр радиальной оси окна — центр круга перелётов
	capitalX = 60.0 // строго середина карты по дуге
)

// placeStableWorlds раскладывает миры детерминированно от сида: фракции
// перемешиваются между четвертями, положение внутри четверти и орбита в полосе
// стабильности разыгрываются — но четверть у каждого своя всегда.
func (s *Sim) placeStableWorlds() []stableWorld {
	vassals := []string{"tradefed", "monarchy", "miners"}
	s.rng.Shuffle(len(vassals), func(i, j int) { vassals[i], vassals[j] = vassals[j], vassals[i] })

	out := make([]stableWorld, 0, 4)
	for i, b := range vassalBands {
		x := b.x0 + s.rng.Float64()*(b.x1-b.x0)
		// орбита внутри полосы стабильности, с отступом от её краёв.
		// Округляем: орбиты дискретны (ТЗ.md §2.1), стабильные миры не исключение.
		r := math.Round(stableBandR0 + 2 + s.rng.Float64()*(stableBandR1-stableBandR0-4))
		out = append(out, stableWorld{
			zone: int(r/10) + 1, r: r, x: x, faction: vassals[i], role: "vassal",
		})
	}
	out = append(out, stableWorld{
		zone: int(capitalR/10) + 1, r: capitalR, x: capitalX,
		faction: "technocracy", role: "capital",
	})
	return out
}

type arm struct{ x0, slope float64 }

var arms = []arm{{15, 0.55}, {55, -0.35}, {95, 0.40}}

// ════════════════════════════════════════════════════════════════════════════
// Объект сектора.
//
// Позиция задана АНАЛИТИЧЕСКИ: x(t) = X0 + Arc·(t − T0), радиус постоянен.
// Поэтому сервер не двигает объекты покадрово — он лишь знает момент выхода
// TExit и обрабатывает его, когда игровое время до него дойдёт. Клиент по этим
// же трём числам рисует положение на любой момент времени, так что картинка на
// всех устройствах совпадает независимо от частоты кадров.
// ════════════════════════════════════════════════════════════════════════════
type Puff struct {
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
	R  float64 `json:"r"`
}

type Object struct {
	ID       int      `json:"id"`
	Type     string   `json:"type"` // star | bh | neb | ast
	StarType string   `json:"starType,omitempty"`
	Faction  string   `json:"faction,omitempty"`
	Role     string   `json:"role,omitempty"`
	Zone     int      `json:"zone"`
	R        float64  `json:"r"`
	X0       float64  `json:"x0"`
	T0       float64  `json:"t0"`  // игровое время, в которое объект был в X0
	Arc      float64  `json:"arc"` // клетей по дуге за игровой месяц
	Mass     float64  `json:"mass"`
	Size     float64  `json:"size,omitempty"`
	Puffs    []Puff   `json:"puffs,omitempty"`
	Planets  []Planet `json:"planets,omitempty"`
	Stable   bool     `json:"stable,omitempty"`
	Chaotic  bool     `json:"chaotic,omitempty"`

	// Только для type=="star" — см. planets.go rollMeteorActivity/rollRings.
	Rings          int     `json:"rings,omitempty"`
	MeteorActivity int     `json:"meteorActivity,omitempty"` // 1–100
	SystemRadius   float64 `json:"sysR,omitempty"`           // радиус звёздной области, клети — размер поля масштаба «Звёздная система»

	Rad float64 `json:"-"` // радиус тела, клети — только для расстановки на сервере

	TExit float64 `json:"-"` // игровое время выхода за край окна; +Inf = не движется
	heapI int     // позиция в очереди выходов
}

func (o *Object) xAt(t float64) float64 { return o.X0 + o.Arc*(t-o.T0) }

func computeExit(o *Object) {
	if o.Arc <= 0 || o.Stable {
		o.TExit = math.Inf(1)
		return
	}
	o.TExit = o.T0 + (exitX-o.X0)/o.Arc
}

// ── вспомогательные розыгрыши (порт из client/galaxy.html) ──────────────────

func gaussianJitter(rng *rand.Rand, spread float64) float64 {
	return (rng.Float64() + rng.Float64() - 1) * spread
}

// ── орбиты дискретны ────────────────────────────────────────────────────────
// ТЗ.md §2.1: «Орбиты: 120 всего = 12 зон × 10 орбит на зону». Шаг между
// соседними орбитами — 1 клеть. Раньше r был непрерывным, из-за чего объекты
// стояли на произвольных дробных радиусах и «орбит» как таковых не было.
//
// Побочный выигрыш: объекты на ОДНОЙ орбите имеют в точности одну скорость
// (arcSpeedAt зависит только от r), поэтому, разведённые при засеве, они уже
// никогда не съедутся. Расходятся только соседние орбиты — это естественно.
func zoneOrbit(rng *rand.Rand, z *Zone) float64 {
	mid := (z.R0 + z.R1) / 2
	r := math.Round(mid + gaussianJitter(rng, 8))
	return math.Max(0, math.Min(120, r))
}

// ── габариты объектов для расстановки ───────────────────────────────────────
// Радиус «тела» в клетях: на столько объект занимает место на карте.
//
// Берём размер, в котором объект рисуется на ОБЩЕМ плане, а не истинный.
// Истинная звезда — 1 клеть в поперечнике (радиус 0,5), на общем плане её
// не разглядеть и пальцем не попасть, поэтому клиент рисует её крупнее и
// сжимает к истинному размеру по мере приближения. Разводить при засеве надо
// именно по видимому размеру — иначе на общем плане объекты сольются.
const (
	radStar   = 1.1 // звезда на общем плане, клети
	radStable = 1.5 // стабильные миры рисуются крупнее и с ореолом
	radBH     = 1.0 // точка с диском аккреции
	// minGapCl — обязательный просвет между телами двух объектов. Без него
	// касающиеся объекты на телефоне читаются как один.
	minGapCl = 1.0
	// Сколько раз пробуем поставить объект, прежде чем взять лучшее из найденного.
	// Занятость сетки ~21% (ТЗ.md §2.11), поэтому свободное место обычно
	// находится за единицы попыток; запас нужен для плотных зон 1–2.
	//
	// Засев идёт один раз при старте сервера — там можно не экономить. Вход
	// новых объектов, наоборот, происходит непрерывно (на ускорении — тысячи
	// раз в секунду), поэтому попыток меньше; там и соседей сравнивается всего
	// несколько десятков, у входного края.
	seedAttempts  = 200
	entryAttempts = 40
)

// cloudRadius — радиус туманности/астероидного поля из её ПЛОЩАДИ (ТЗ.md §2.11:
// размер задан площадью в клетях², а не стороной). Берём радиус равновеликого
// круга: клочки кластера расходятся шире, но краями диффузного газа можно
// перекрываться — это выглядит естественно, в отличие от наложения центров.
func cloudRadius(area float64) float64 { return math.Sqrt(area / math.Pi) }

func cellX(rng *rand.Rand, col int) float64 { return float64(col)*10 + rng.Float64()*10 }

func armWeight(z *Zone, col int) float64 {
	r := (z.R0 + z.R1) / 2
	cellMid := float64(col)*10 + 5
	minDist := 999.0
	for _, a := range arms {
		ax := math.Mod(a.x0+a.slope*r, 120)
		if ax < 0 {
			ax += 120
		}
		d := math.Abs(cellMid - ax)
		d = math.Min(d, 120-d)
		minDist = math.Min(minDist, d)
	}
	return math.Exp(-minDist/25) + 0.22
}

// assignDistinctColumns — редкие объекты (звёзды/ЧД) расходятся по РАЗНЫМ
// столбцам, с весом к рукавам, но без дублей.
func assignDistinctColumns(rng *rand.Rand, n int, z *Zone) []int {
	type cw struct {
		c int
		w float64
	}
	list := make([]cw, 12)
	for c := 0; c < 12; c++ {
		list[c] = cw{c, armWeight(z, c) * (0.6 + rng.Float64()*0.8)}
	}
	for i := 1; i < len(list); i++ { // сортировка вставками по убыванию веса
		for j := i; j > 0 && list[j].w > list[j-1].w; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	if n > 12 {
		n = 12
	}
	out := make([]int, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, list[i].c)
	}
	return out
}

// weightedColumnCounts — многочисленные объекты раздаются по ВСЕМ 12 столбцам
// пропорционально весу, остаток — по наибольшим дробным частям: пустых клеток нет.
func weightedColumnCounts(n int, z *Zone) []int {
	w := make([]float64, 12)
	total := 0.0
	for c := 0; c < 12; c++ {
		w[c] = armWeight(z, c)
		total += w[c]
	}
	raw := make([]float64, 12)
	counts := make([]int, 12)
	assigned := 0
	for c := 0; c < 12; c++ {
		raw[c] = float64(n) * w[c] / total
		counts[c] = int(math.Floor(raw[c]))
		assigned += counts[c]
	}
	order := make([]int, 12)
	for i := range order {
		order[i] = i
	}
	frac := func(i int) float64 { return raw[i] - math.Floor(raw[i]) }
	for i := 1; i < len(order); i++ {
		for j := i; j > 0 && frac(order[j]) > frac(order[j-1]); j-- {
			order[j], order[j-1] = order[j-1], order[j]
		}
	}
	for k := 0; k < n-assigned; k++ {
		counts[order[k%12]]++
	}
	return counts
}

func makeCluster(rng *rand.Rand, area float64, n int, puffFrac float64) []Puff {
	parts := make([]Puff, 0, n)
	for i := 0; i < n; i++ {
		partArea := (area / float64(n)) * (0.7 + rng.Float64()*0.6)
		r := math.Sqrt(partArea/math.Pi) * puffFrac
		angle := rng.Float64() * math.Pi * 2
		dist := math.Sqrt(area/math.Pi) * rng.Float64() * 0.85
		parts = append(parts, Puff{DX: math.Cos(angle) * dist, DY: math.Sin(angle) * dist, R: r})
	}
	return parts
}

func pickWeighted(rng *rand.Rand, weights map[string]float64) string {
	// порядок обхода map в Go случаен — идём по фиксированному списку ключей,
	// иначе один и тот же сид давал бы разные галактики
	keys := []string{"red", "yellow", "blue", "white", "neutron"}
	total := 0.0
	for _, k := range keys {
		if weights[k] > 0 {
			total += weights[k]
		}
	}
	if total <= 0 {
		return "red"
	}
	x := rng.Float64() * total
	for _, k := range keys {
		w := weights[k]
		if w <= 0 {
			continue
		}
		if x < w {
			return k
		}
		x -= w
	}
	return "red"
}

func massInRange(rng *rand.Rand, rg [2]float64) float64 {
	return rg[0] + rng.Float64()*(rg[1]-rg[0])
}

// starTypeForMass — масса первична, тип вторичен: выбираем среди типов, чей
// диапазон масс накрывает пришедшую массу, с весами зоны.
func starTypeForMass(rng *rand.Rand, starW map[string]float64, mass float64) string {
	keys := []string{"red", "yellow", "blue", "white", "neutron"}
	fit := map[string]float64{}
	any := false
	for _, k := range keys {
		if starW[k] <= 0 {
			continue
		}
		rg := starMass[k]
		if mass >= rg[0] && mass <= rg[1] {
			fit[k] = starW[k]
			any = true
		}
	}
	if any {
		return pickWeighted(rng, fit)
	}
	best, bestD := "", math.Inf(1)
	for _, k := range keys {
		if starW[k] <= 0 {
			continue
		}
		rg := starMass[k]
		d := 0.0
		if mass < rg[0] {
			d = rg[0] - mass
		} else if mass > rg[1] {
			d = mass - rg[1]
		}
		if d < bestD {
			bestD, best = d, k
		}
	}
	if best == "" {
		return "red"
	}
	return best
}
