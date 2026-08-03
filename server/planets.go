package main

import (
	"math"
	"math/rand"
)

// ════════════════════════════════════════════════════════════════════════════
// ПЛАНЕТЫ И РАСПРОСТРАНЕНИЕ РЕСУРСОВ
//
// Правила и числа взяты из archive/docs/RESOURCES_design.md (ТЗ.md §2.5 —
// «типы планет и ресурсы пока без изменений относительно v1»). Изменены только
// две вещи, и обе — по требованию нового ТЗ:
//
//  1. Расстановка орбит. В v1 было 36 фиксированных слотов на систему и тип
//     планеты назначался по номеру слота (лава 0–8, камень 9–17, лёд 18–26,
//     газ 27–35). ТЗ.md §2.8 задаёт новую схему: шаг 4 экрана ± 1 при радиусе
//     системы 25–35, то есть 5–8 орбит, а не 36. Прямой перенос невозможен.
//
//  2. Тип планеты определяется не номером орбиты, а тем, в какую
//     РАДИАЦИОННУЮ ЗОНУ звезды эта орбита попала (таблица зон — ТЗ.md §2.8).
//     Порядок тот же, что в v1 (жар → холод: ядро, лава, камень, лёд, газ),
//     но теперь он согласован с типом звезды: у синего гиганта зоны шире, и
//     каменные планеты уезжают дальше от светила, у красного карлика — ближе.
//     Побочный выигрыш: не нужно отдельное правило для Bare Core, оно само
//     получается там, где звезда сожгла кору — внутри зоны сильной радиации.
// ════════════════════════════════════════════════════════════════════════════

// Категории множителей (archive/docs/RESOURCES_design.md, «Множитель типа звезды»).
const (
	catBase    = "BASE"
	catMetals  = "METALS"
	catNuclear = "NUCLEAR"
	catFuel    = "FUEL"
	catGas     = "GAS"
)

// Ресурс: табличная база по типу планеты + категория множителей.
type resourceDef struct {
	Key  string
	Cat  string
	Name string
	// база по типу планеты, у.е. (шкала 0–10 000)
	Base map[string]float64
}

// Табличные базы — ровно из archive/docs/RESOURCES_design.md.
// У «голого ядра» летучих нет вовсе: кора и атмосфера уничтожены звездой.
var resourceDefs = []resourceDef{
	{"silicates", catBase, "Силикатная масса", map[string]float64{
		"lava": 9500, "rocky": 8500, "ice": 1500, "gas": 0, "core": 600}},
	{"iron", catBase, "Металлическое железо", map[string]float64{
		"lava": 7000, "rocky": 4500, "ice": 800, "gas": 0, "core": 8800}},
	{"refractory", catMetals, "Тугоплавкие металлы", map[string]float64{
		"lava": 4500, "rocky": 3000, "ice": 400, "gas": 0, "core": 7200}},
	{"lightRare", catMetals, "Лёгкие редкие металлы", map[string]float64{
		"lava": 2000, "rocky": 3500, "ice": 600, "gas": 0, "core": 5500}},
	{"platinoids", catMetals, "Платиноиды", map[string]float64{
		"lava": 2500, "rocky": 1800, "ice": 200, "gas": 0, "core": 6800}},
	{"inertGases", catGas, "Инертные тяжёлые газы", map[string]float64{
		"lava": 1200, "rocky": 800, "ice": 200, "gas": 5000, "core": 0}},
	{"helium3", catGas, "Гелий-3", map[string]float64{
		"lava": 800, "rocky": 500, "ice": 100, "gas": 0, "core": 0}},
	{"hydrogen", catFuel, "Водород", map[string]float64{
		"lava": 500, "rocky": 3000, "ice": 7000, "gas": 10000, "core": 0}},
	{"volcanicGases", catFuel, "Вулканические газы", map[string]float64{
		"lava": 6000, "rocky": 1500, "ice": 200, "gas": 0, "core": 0}},
	{"radioactives", catNuclear, "Радиоактивные материалы", map[string]float64{
		"lava": 3000, "rocky": 2000, "ice": 500, "gas": 0, "core": 4800}},
}

// ── множитель типа звезды при рождении ──────────────────────────────────────
// yellow / red / blue — из архива без изменений.
//
// white и neutron в архиве не заданы: белый карлик там наследовал множители
// прогенитора (`star.progenitor`), а нейтронных звёзд в таблице не было вовсе.
// В v2 прогениторы не отслеживаются, поэтому значения ПРЕДЛОЖЕНЫ (требуют
// подтверждения, см. ТЗ.md §2.5):
//   • white   — как жёлтый карлик: типичный прогенитор белого карлика —
//               солнцеподобная звезда, система сформировалась в её условиях;
//   • neutron — как синий гигант, но металлы и ядерное сырьё ещё выше:
//               прогенитор массивный, а вспышка сверхновой дополнительно
//               обогатила остаток тяжёлыми элементами.
var starMod = map[string]map[string]float64{
	"yellow":  {catMetals: 1.00, catNuclear: 1.00, catFuel: 1.00, catGas: 1.00, catBase: 1.00},
	"red":     {catMetals: 0.72, catNuclear: 0.65, catFuel: 1.20, catGas: 1.15, catBase: 0.90},
	"blue":    {catMetals: 1.55, catNuclear: 1.50, catFuel: 0.50, catGas: 0.70, catBase: 1.05},
	"white":   {catMetals: 1.00, catNuclear: 1.00, catFuel: 1.00, catGas: 1.00, catBase: 1.00},
	"neutron": {catMetals: 1.70, catNuclear: 1.80, catFuel: 0.45, catGas: 0.65, catBase: 1.05},
	// стабильные миры Империи считаем по жёлтому карлику
	"stable": {catMetals: 1.00, catNuclear: 1.00, catFuel: 1.00, catGas: 1.00, catBase: 1.00},
}

// ── множитель галактической позиции ─────────────────────────────────────────
// Градиент металличности: ближе к центру галактики — больше тяжёлых элементов
// (много поколений сверхновых), на периферии — больше лёгких летучих.
//
// В архиве вход — birth_radius 0–10. В v2 радиальная ось окна r = 0…120, где
// r=0 — край, ближний к центру галактики (ТЗ.md §2.1). Пересчёт линейный:
// galPos = r / 12, то есть r=0 → 0 (центр), r=120 → 10 (периферия).
func galPos(r float64) float64 { return r / 12 }

func galMod(cat string, r float64) float64 {
	galDelta := (5 - galPos(r)) / 5 // +1 у центра, −1 у края
	switch cat {
	case catMetals, catNuclear:
		return 1 + galDelta*0.35
	case catFuel:
		return 1 - galDelta*0.20
	case catGas:
		return 1 - galDelta*0.15
	default: // catBase
		return 1 + galDelta*0.12
	}
}

// ── радиационные зоны звезды (ТЗ.md §2.8) ───────────────────────────────────
// Границы в клетях от центра звезды: сильная / повышенная / умеренная / слабая.
var radiationZones = map[string][4]float64{
	"red":     {3, 5, 8, 13},  // сдвиг ряда Фибоначчи влево
	"white":   {3, 5, 8, 13},
	"yellow":  {4, 7, 12, 20}, // база
	"stable":  {4, 7, 12, 20},
	"blue":    {5, 10, 18, 31}, // сдвиг вправо
	"neutron": {5, 10, 18, 31},
}

// Базовые полосы типов — доли радиуса системы. Пропорции взяты из v1, где тип
// назначался по номеру слота из 36 (лава 0–8, камень 9–17, лёд 18–26, газ
// 27–35), то есть газовые гиганты занимали внешнюю четверть орбит.
const (
	bandLava  = 8.0 / 36  // ≈0.22
	bandRocky = 17.0 / 36 // ≈0.47
	bandIce   = 26.0 / 36 // ≈0.72
)

// planetTypeAt — тип планеты по орбите.
//
// Два слоя. Основной — те же пропорции, что в v1: доля орбиты от радиуса
// системы задаёт полосу лава → камень → лёд → газ. Поверх него радиационное
// вето (ТЗ.md §2.8): всё, что попало в зону сильной радиации звезды, теряет
// кору и атмосферу и становится голым ядром, а в зоне повышенной — лавовой
// планетой, какой бы ни была доля.
//
// Так горячие звёзды выжигают свои внутренние планеты (у синего гиганта зона
// сильной радиации до r=5, у красного карлика — до r=3), но общий состав
// системы остаётся v1-совместимым. Привязка ВСЕХ границ к радиационным зонам,
// как было в первой версии этого кода, давала перекос: у красных карликов
// зона «слабая» кончается на r=13, и 59% их планет уезжали в газовые гиганты.
func planetTypeAt(starType string, orbit, sysR float64) string {
	z, ok := radiationZones[starType]
	if !ok {
		z = radiationZones["yellow"]
	}
	if orbit <= z[0] {
		return "core" // кора и атмосфера сожжены близостью звезды
	}
	if orbit <= z[1] {
		return "lava"
	}
	switch f := orbit / sysR; {
	case f <= bandLava:
		return "lava"
	case f <= bandRocky:
		return "rocky"
	case f <= bandIce:
		return "ice"
	default:
		return "gas"
	}
}

// Диаметр планеты, клети (ТЗ.md §2.5: 1,5–3, зависит от типа).
var planetDiameter = map[string][2]float64{
	"core":  {1.5, 1.9},
	"lava":  {1.7, 2.3},
	"rocky": {1.8, 2.5},
	"ice":   {1.9, 2.6},
	"gas":   {2.6, 3.0},
}

// Вода — параметр 0–100, а не запас в у.е. (archive: «Вода ★/♻»).
var waterRange = map[string][2]float64{
	"core":  {0, 0},
	"lava":  {0, 2},
	"rocky": {30, 60},
	"ice":   {50, 90},
	"gas":   {45, 55},
}

type Planet struct {
	Index    int            `json:"i"`
	Type     string         `json:"type"`
	Orbit    float64        `json:"orbit"` // клетей от центра звезды
	Diameter float64        `json:"d"`
	Owner    string         `json:"owner"`
	Water    int            `json:"water"`
	Res      map[string]int `json:"res"` // ключ ресурса → концентрация, у.е. 0–10 000
}

// resourceVariance — детерминированный разброс вокруг табличной базы.
// В архиве это ±var через resRand(gen_code, orbit, idx); здесь роль gen_code
// играет сид сервера, от которого раскручен весь rng.
const resourceVariance = 0.08

// systemRadiusRange — радиус звёздной области, клети (ТЗ.md §2.7.4: 25–35).
const (
	systemRadiusMin = 25.0
	systemRadiusMax = 35.0
	orbitStep       = 4.0 // шаг орбит, экраны (ТЗ.md §2.8: 4 ± 1)
	orbitJitter     = 1.0
	orbitOccupancy  = 0.82 // доля занятых слотов: часть орбит пустует
)

// generatePlanets заселяет звезду планетами.
//
// starR — радиус звезды в окне галактики (нужен для галактического градиента:
// планеты у центра галактики богаче металлами, у края — летучими).
func generatePlanets(rng *rand.Rand, starType string, starR float64) []Planet {
	sysR := systemRadiusMin + rng.Float64()*(systemRadiusMax-systemRadiusMin)

	// орбиты: первая на шаге от звезды, дальше с шагом 4 ± 1
	var orbits []float64
	for o := orbitStep + (rng.Float64()*2-1)*orbitJitter; o <= sysR; {
		orbits = append(orbits, o)
		o += orbitStep + (rng.Float64()*2-1)*orbitJitter
	}

	planets := make([]Planet, 0, len(orbits))
	for _, o := range orbits {
		if rng.Float64() > orbitOccupancy {
			continue // орбита пустует
		}
		planets = append(planets, makePlanet(rng, starType, starR, o, sysR, len(planets)))
	}
	// система без единой планеты выглядит как ошибка генерации — гарантируем одну
	if len(planets) == 0 && len(orbits) > 0 {
		planets = append(planets, makePlanet(rng, starType, starR, orbits[0], sysR, 0))
	}
	return planets
}

func makePlanet(rng *rand.Rand, starType string, starR, orbit, sysR float64, idx int) Planet {
	pt := planetTypeAt(starType, orbit, sysR)
	dr := planetDiameter[pt]
	wr := waterRange[pt]

	sm, ok := starMod[starType]
	if !ok {
		sm = starMod["yellow"]
	}

	// нормированное положение орбиты внутри системы — для бонуса гелия-3
	orbitNorm := math.Min(1, orbit/systemRadiusMax)

	res := make(map[string]int, len(resourceDefs))
	for _, rd := range resourceDefs {
		base := rd.Base[pt]
		if base <= 0 {
			res[rd.Key] = 0
			continue
		}
		v := base * sm[rd.Cat] * galMod(rd.Cat, starR)
		// разброс ±resourceVariance
		v *= 1 + (rng.Float64()*2-1)*resourceVariance
		// Гелий-3 имплантирован солнечным ветром в реголит безвоздушных тел:
		// на каменистых/лавовых/голом ядре ближе к звезде его заметно больше
		// (archive: bonus при pressure < 20 и внутренних орбитах).
		if rd.Key == "helium3" && (pt == "rocky" || pt == "lava" || pt == "core") {
			v += (1 - orbitNorm) * 1500
		}
		res[rd.Key] = clampRes(v)
	}

	owner := "none"
	if rng.Float64() >= 0.55 {
		owner = factionKeys[rng.Intn(len(factionKeys))]
	}

	return Planet{
		Index:    idx,
		Type:     pt,
		Orbit:    math.Round(orbit*10) / 10,
		Diameter: math.Round((dr[0]+rng.Float64()*(dr[1]-dr[0]))*100) / 100,
		Owner:    owner,
		Water:    int(math.Round(wr[0] + rng.Float64()*(wr[1]-wr[0]))),
		Res:      res,
	}
}

// ── потолок шкалы: мягкое поджатие вместо обрубания ─────────────────────────
//
// В v1 стояло жёсткое `clamp(value, 0, 10000)`. На наших множителях это
// схлопывает как раз самые ценные планеты: у голого ядра синего гиганта
// платиноиды считаются как 6800 × 1.55 (звезда) × 1.30 (позиция) = 13 733,
// у нейтронной звезды — 15 062, и всё это одинаково становится 10 000. Замер
// на сиде 12345: у 21 голого ядра из 30 по два-три металла стояли на потолке
// и были неотличимы друг от друга — то есть «лучший источник платиноидов»
// переставал читаться, хотя ради этого система и задумана.
//
// Поджимаем экспоненциально начиная с resKnee: порядок величин сохраняется
// (платиноиды остаются богаче лёгких редких, те — богаче железа), значение
// асимптотически подходит к 10 000, но никогда его не достигает. Шкала 0–10 000
// из архива соблюдена, «сглаживание крайностей» — тоже, оно там прямо заявлено.
//
// ОТСТУПЛЕНИЕ ОТ v1 — требует подтверждения (см. ТЗ.md §2.5).
const resKnee = 8000.0

func clampRes(v float64) int {
	if v < 0 {
		return 0
	}
	if v > resKnee {
		head := 10000.0 - resKnee
		v = resKnee + head*(1-math.Exp(-(v-resKnee)/head))
	}
	return int(math.Round(v))
}
