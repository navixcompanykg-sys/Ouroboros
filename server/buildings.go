package main

import "sort"

// ════════════════════════════════════════════════════════════════════════════
// ЗДАНИЯ И ТРАНСПОРТНАЯ СЕТЬ КОЛОНИИ (фаза 1 — размещение и связность).
//
// Полноценная работающая экономика (посуточная добыча, рост населения, голод,
// потребление зданий) — ТЗ_Экономика.md, отдельная фаза 2, здесь НЕ
// реализована: здание просто «существует и подключено» или «существует, но
// изолировано» (соответствующий гекс не поставляет ресурсы на склад).
// Реальных чисел добычи/производства в сутки эта фаза не считает.
// ════════════════════════════════════════════════════════════════════════════

// BuildingType — каталог типов зданий, ТЗ_Экономика.md §12 (стандартная
// колония) + §15 (транспортный узел — новое, не из исходного документа).
type BuildingType string

const (
	BuildingMine          BuildingType = "mine"           // горнодобывающая шахта
	BuildingAtmoCollector BuildingType = "atmo_collector" // атмосферный собиратель
	BuildingBioExtractor  BuildingType = "bio_extractor"  // биоэкстрактор
	BuildingHydroFarm     BuildingType = "hydro_farm"     // гидроминеральная ферма
	BuildingFactoryMetal  BuildingType = "factory_metal"  // металлургический завод
	BuildingFactoryChem   BuildingType = "factory_chem"   // химический завод
	BuildingFactoryElec   BuildingType = "factory_elec"   // электроинженерный завод
	BuildingLab           BuildingType = "lab"            // лаборатория передовых систем
	BuildingHousing       BuildingType = "housing"        // жилой модуль
	BuildingH2Generator   BuildingType = "h2_generator"   // водородный генератор
	BuildingSolarPanel    BuildingType = "solar_panel"    // солнечная панель
	BuildingBattery       BuildingType = "battery"        // планетарная батарея
	BuildingFort          BuildingType = "fort"           // форт-казарма
	BuildingShipyard      BuildingType = "shipyard"       // верфь
	BuildingAdvComponents BuildingType = "adv_components" // завод улучшенных компонентов
	BuildingRadio         BuildingType = "radio"          // радиостанция
	BuildingScienceCenter BuildingType = "science_center" // научный центр
	BuildingCryptoFarm    BuildingType = "crypto_farm"    // криптоферма
	BuildingTransportNode BuildingType = "transport_node" // транспортный узел (новое)
	BuildingNuclearPlant  BuildingType = "nuclear_plant"  // атомная станция (ТЗ_Экономика.md §12.2/§13/§14.2 — раньше без BuildingType, только теория)
	BuildingRecycler      BuildingType = "recycler"       // завод переработки (новое — по требованию пользователя, вне ТЗ_Экономика.md)
)

// Building — одно здание на гексе. 7 точек застройки на гекс (client/planet.html)
// — до 7 зданий, слоты явно не различаются (какое здание в какой из 7 точек
// стоит — вопрос отрисовки на клиенте, не модели).
type Building struct {
	Type BuildingType `json:"type"`
	Q    int          `json:"q"`
	R    int          `json:"r"`

	// Queue — очередь производства завода (задел на будущее — по прямому
	// указанию пользователя: только структура данных, server/production.go
	// её пока НЕ читает, produceHour выбирает рецепт сама, «сбалансированным
	// набором»). Ключи — componentRecipe.Key (economy.go), в порядке
	// приоритета. Имеет смысл только для BuildingType из factoryBuildingName
	// (production.go), для остальных зданий всегда пусто.
	Queue []string `json:"queue,omitempty"`

	// BatchesToday — сколько партий уже произвёл этот завод за текущие
	// игровые сутки (потолок maxProductionBatchesPerDay=12, production.go),
	// сбрасывается в 0 на границе суток (resetDailyBatches). Имеет смысл
	// только для заводов — у остальных зданий всегда 0.
	BatchesToday int `json:"batchesToday,omitempty"`

	// MissedUpkeepDays — подряд идущих суток, когда на складе не хватило
	// хотя бы одной из 3 статей расхода на содержание (upkeepDay,
	// production.go). Сбрасывается в 0 при первой же успешной оплате.
	// По достижении demolitionGraceDays здание демонтируется (по требованию
	// пользователя — «если зданию не хватает компонентов на содержание, оно
	// демонтируется»). Грейс-период — САМОСТОЯТЕЛЬНОЕ решение, не из явного
	// запроса: без него стартовая колония была бы демонтирована целиком в
	// первые же сутки — химзавод/склад ещё пусты (Металлоконструкции/
	// Химреагенты/Полимеры — сами продукты заводов, а не сырьё, их взять
	// неоткуда раньше первого часа производства), см. комментарий у
	// demolitionGraceDays.
	MissedUpkeepDays int `json:"missedUpkeepDays,omitempty"`
}

const hexSlotsCap = 7 // ТЗ_UI.md §5: 7 точек застройки на гекс

// ── соседство и связность гексов ────────────────────────────────────────────
//
// axial pointy-top (см. generateSurface) — 6 соседей гекса (q,r).
func hexNeighbors(q, r int) [6][2]int {
	return [6][2]int{
		{q + 1, r}, {q + 1, r - 1}, {q, r - 1},
		{q - 1, r}, {q - 1, r + 1}, {q, r + 1},
	}
}

// hexDistance — расстояние между гексами в «шагах» (axial/cube distance).
func hexDistance(a, b [2]int) int {
	dq := a[0] - b[0]
	dr := a[1] - b[1]
	return (abs(dq) + abs(dq+dr) + abs(dr)) / 2
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// connectedHexes — какие гексы подключены к транспортной сети колонии.
//
// Гекс ПРИСУТСТВУЕТ в сети, если это домашний гекс (0,0) (всегда — база и
// склад колонии, единственный вход через посадку) ИЛИ на нём стоит хотя бы
// одно здание (в т.ч. «пустой» транспортный узел). Гекс ПОДКЛЮЧЁН, если до
// него есть путь по СОСЕДНИМ присутствующим гексам от домашнего — обычный
// BFS. Транспортный узел нужен только чтобы замостить разрыв (гекс без
// единого здания) между двумя занятыми областями: если застройка образует
// сплошное пятно от домашнего гекса, узлы не нужны вовсе — «если все гексы
// заселены и нет анклавов» из исходной формулировки задачи выполняется этой
// же логикой без специальных случаев.
func connectedHexes(p *Planet) map[[2]int]bool {
	present := map[[2]int]bool{{0, 0}: true}
	for _, b := range p.Buildings {
		present[[2]int{b.Q, b.R}] = true
	}
	connected := map[[2]int]bool{{0, 0}: true}
	queue := [][2]int{{0, 0}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, n := range hexNeighbors(cur[0], cur[1]) {
			if present[n] && !connected[n] {
				connected[n] = true
				queue = append(queue, n)
			}
		}
	}
	return connected
}

// ── стартовая колонизация ───────────────────────────────────────────────────

// mineGroup — тип шахты, ключи ресурсов, которые она добывает (см.
// ТЗ_Экономика.md §3), и сколько таких шахт ставит стартовая колонизация.
type mineGroup struct {
	building BuildingType
	keys     []string
	count    int
}

var starterMineGroups = []mineGroup{
	{BuildingMine, []string{"silicates", "iron", "refractory", "lightRare", "platinoids", "radioactives"}, 10},
	{BuildingAtmoCollector, []string{"hydrogen", "helium3", "inertGases", "volcanicGases"}, 10},
	{BuildingBioExtractor, []string{"waterIce", "phosphates", "carbonates"}, 10},
	{BuildingHydroFarm, []string{"bitumens", "biomass"}, 10},
}

// starterInfra — инфраструктура «стандартной колонии» (ТЗ_Экономика.md §12),
// не зависит от богатства гекса — расставляется от домашнего гекса наружу.
// Число заводов — НЕ «по одному каждого типа», как в §12 — пересмотрено
// пользователем под потолок производства maxProductionBatchesPerDay=12
// (production.go) и расчёт Расчёт_производственных_мощностей.md (сколько
// заводов нужно, чтобы переработать в ТУ1-компоненты всё, что добывают 40
// шахт ниже): 5 Металлургических + 5 Химических (округлено вверх от
// расчётных 4 — то же число, что у Металлургического, для красоты) + 1
// Электроинженерный (расчётной нагрузки хватает на 1) + 1 Лаборатория
// передовых систем (у неё нет ни одного рецепта ТУ1 — ТЗ_Экономика.md §6.3
// прямым текстом: «завод строится сразу под ТУ2» — не выводится из добычи
// 40 шахт, добавлена как безусловный минимум, иначе Высококачественные
// сплавы/Ядерные компоненты/весь ТУ3 недоступны в принципе).
var starterInfra = []struct {
	building BuildingType
	count    int
}{
	{BuildingFactoryMetal, 5},
	{BuildingFactoryChem, 5},
	{BuildingFactoryElec, 1},
	{BuildingLab, 1},
	{BuildingHousing, 10},
	{BuildingH2Generator, 8},
	{BuildingSolarPanel, 1},
	{BuildingNuclearPlant, 1}, // по требованию пользователя: 1 атомная станция на колонию — +40 энергии/сутки (учёт дефицита энергии, production.go energyDay), сверх «стандартной колонии» ТЗ_Экономика.md §12 (там 0 штук)
	{BuildingBattery, 5},
	{BuildingFort, 1},
	{BuildingShipyard, 1},
	{BuildingAdvComponents, 1},
	{BuildingRadio, 1},
	{BuildingScienceCenter, 1},
	{BuildingCryptoFarm, 10},
	{BuildingRecycler, 1}, // по требованию пользователя: завод переработки излишков (production.go recycleHour) — 1 на колонию, тот же принцип добавления, что у атомной станции выше
}

// bootstrapColony — размещает «стандартную колонию» (85 зданий: 40 шахт +
// 45 инфраструктуры, ТЗ_Экономика.md §12 + 1 атомная станция и 1 завод
// переработки сверх эталона) на уже сгенерированной планете.
// Детерминировано по данным планеты (Surface/Res) — своего RNG не требует,
// порядок обхода везде фиксирован (сортировка/расстояние от домашнего гекса).
func bootstrapColony(p *Planet) {
	if len(p.Surface) == 0 {
		return
	}
	slotsUsed := map[[2]int]int{}
	place := func(t BuildingType, coord [2]int) {
		p.Buildings = append(p.Buildings, Building{Type: t, Q: coord[0], R: coord[1]})
		slotsUsed[coord]++
	}

	// 1. Шахты — топ-N гексов по сумме релевантной группы ресурсов гекса.
	// «Богатый» и «близкий к базе» — разные вещи: если лучшие гексы для
	// добычи оказались не рядом с домашним, ниже это вскроет связность (3).
	for _, g := range starterMineGroups {
		type scoredHex struct {
			coord [2]int
			value int
		}
		scored := make([]scoredHex, 0, len(p.Surface))
		for _, h := range p.Surface {
			v := 0
			for _, key := range g.keys {
				v += h.res[key]
			}
			if v > 0 {
				scored = append(scored, scoredHex{[2]int{h.Q, h.R}, v})
			}
		}
		sort.Slice(scored, func(i, j int) bool { return scored[i].value > scored[j].value })
		placed := 0
		for _, s := range scored {
			if placed >= g.count {
				break
			}
			if slotsUsed[s.coord] >= hexSlotsCap {
				continue
			}
			place(g.building, s.coord)
			placed++
		}
	}

	// 2. Инфраструктура — от домашнего гекса наружу по кольцам, заполняя
	// свободные слоты по порядку (позиция не влияет на её работу).
	byDistance := make([][2]int, len(p.Surface))
	for i, h := range p.Surface {
		byDistance[i] = [2]int{h.Q, h.R}
	}
	sort.Slice(byDistance, func(i, j int) bool {
		return hexDistance(byDistance[i], [2]int{0, 0}) < hexDistance(byDistance[j], [2]int{0, 0})
	})
	cursor := 0
	for _, item := range starterInfra {
		for n := 0; n < item.count; n++ {
			for cursor < len(byDistance) && slotsUsed[byDistance[cursor]] >= hexSlotsCap {
				cursor++
			}
			if cursor >= len(byDistance) {
				break // некуда ставить — не ожидается на реальных размерах сетки (19+ гексов × 7 слотов)
			}
			place(item.building, byDistance[cursor])
		}
	}

	// 3. Связность — шахты на богатых гексах могли оказаться island'ами
	// (см. пункт 1). Пока есть отключённое здание — кратчайший путь до уже
	// подключённой области, транспортный узел на каждый пустой гекс пути.
	connectDisconnectedBuildings(p)

	// 4. Стартовый запас компонентов — по требованию пользователя: без этого
	// склад в день 0 пуст по всем 21 компонентам сразу (сами компоненты —
	// продукт заводов, не сырьё, взять их взять неоткуда раньше первого часа
	// производства), из-за чего первая же проверка содержания (upkeepDay,
	// production.go — Химреагенты/Полимеры/Металлоконструкции нужны
	// почти всем зданиям) massово проваливается ещё до того, как заводы
	// успели произвести хоть партию. По 10 каждого — то же число, что
	// componentStockFloor (минимум, к которому и так стремится производство).
	if p.Stock == nil {
		p.Stock = make(map[string]float64)
	}
	for _, r := range componentRecipes {
		p.Stock[r.Key] = 10
	}

	// 5. Население — заселяем стартовую колонию сразу по лимиту разнообразия
	// пищи (ТЗ_Экономика.md §11.2), см. computePopulation ниже.
	p.Population = computePopulation(p.Buildings)
}

// connectDisconnectedBuildings — пока есть здание вне connectedHexes,
// прокладывает транспортные узлы по кратчайшему пути до сети. Итеративно:
// после каждого моста связность могла измениться для нескольких зданий
// разом, пересчитываем заново, а не полагаемся на один проход.
func connectDisconnectedBuildings(p *Planet) {
	valid := make(map[[2]int]bool, len(p.Surface))
	for _, h := range p.Surface {
		valid[[2]int{h.Q, h.R}] = true
	}
	occupied := func() map[[2]int]bool {
		m := make(map[[2]int]bool, len(p.Buildings))
		for _, b := range p.Buildings {
			m[[2]int{b.Q, b.R}] = true
		}
		return m
	}

	for iter := 0; iter < 64; iter++ { // защитный предел — на 19–61 гексе не должен исчерпаться
		connected := connectedHexes(p)
		var target [2]int
		found := false
		for _, b := range p.Buildings { // порядок p.Buildings детерминирован — итог воспроизводим
			coord := [2]int{b.Q, b.R}
			if !connected[coord] {
				target = coord
				found = true
				break
			}
		}
		if !found {
			return
		}
		path := shortestHexPath(target, connected, valid)
		if path == nil || len(path) < 2 {
			return // не нашли путь — не должно происходить на связной гекс-сетке
		}
		occ := occupied()
		for _, step := range path[1 : len(path)-1] {
			if !occ[step] {
				p.Buildings = append(p.Buildings, Building{Type: BuildingTransportNode, Q: step[0], R: step[1]})
			}
		}
	}
}

// shortestHexPath — BFS от start до ближайшего гекса из connected, путь
// целиком внутри valid (гексов планеты). Возвращает [start, ..., конец] или
// nil, если пути нет.
func shortestHexPath(start [2]int, connected, valid map[[2]int]bool) [][2]int {
	prev := map[[2]int][2]int{}
	visited := map[[2]int]bool{start: true}
	queue := [][2]int{start}
	var end [2]int
	found := false
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if connected[cur] {
			end = cur
			found = true
			break
		}
		for _, n := range hexNeighbors(cur[0], cur[1]) {
			if valid[n] && !visited[n] {
				visited[n] = true
				prev[n] = cur
				queue = append(queue, n)
			}
		}
	}
	if !found {
		return nil
	}
	path := [][2]int{end}
	cur := end
	for cur != start {
		cur = prev[cur]
		path = append(path, cur)
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

// ── население: лимит по разнообразию пищи (ТЗ_Экономика.md §11.2) ──────────
//
// Полной посуточной симуляции населения нет (склада с запасом ресурсов не
// существует вовсе, см. шапку файла — фаза 2), поэтому здесь не «текущий
// счётчик», а одноразовое заселение при бутстрапе: сколько работоспособных
// жителей помещается по факту НАЛИЧИЯ построек, способных произвести каждый
// тип пищи — а не смоделированного запаса на складе. Стандартная колония
// (§12) имеет все нужные для этого здания, поэтому берём максимально
// достижимое разнообразие, а не 0 (честный «нет склада — нет пищи» сделал бы
// заселение бессмысленным для абсолютно любой колонии).
//
// Три типа пищи и их рецепты (§12.5): натуральная — сама биомасса без
// переработки; синтетическая — биосинтетика из биомассы (Химзавод);
// биоинженерная — биосинтетика + микроэлектроника (Химзавод + Электрозавод).
func planetFoodTypes(buildings []Building) int {
	hasBiomass, hasChem, hasElec := false, false, false
	for _, b := range buildings {
		switch b.Type {
		case BuildingHydroFarm:
			hasBiomass = true
		case BuildingFactoryChem:
			hasChem = true
		case BuildingFactoryElec:
			hasElec = true
		}
	}
	types := 0
	if hasBiomass {
		types++ // натуральная
	}
	if hasBiomass && hasChem {
		types++ // синтетическая
	}
	if hasBiomass && hasChem && hasElec {
		types++ // биоинженерная
	}
	return types
}

// settlementWorkerCap — ТЗ_Экономика.md §11.2: сколько из физических 10 мест
// поселения (Жилого модуля) работоспособны, по числу доступных типов пищи.
func settlementWorkerCap(foodTypes int) int {
	switch foodTypes {
	case 1:
		return 5
	case 2:
		return 7
	case 3:
		return 9
	default:
		return 0
	}
}

// computePopulation — работоспособное население колонии: число поселений
// (Жилых модулей) × лимит по разнообразию пищи (не физическая вместимость
// 10/поселение — та достижима только переселенцами сверх лимита, §11.2).
func computePopulation(buildings []Building) int {
	settlements := 0
	for _, b := range buildings {
		if b.Type == BuildingHousing {
			settlements++
		}
	}
	return settlements * settlementWorkerCap(planetFoodTypes(buildings))
}
