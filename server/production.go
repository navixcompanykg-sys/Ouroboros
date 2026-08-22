package main

import (
	"math"
	"sort"
	"time"
)

// ════════════════════════════════════════════════════════════════════════════
// ПОСУТОЧНЫЙ/ПОЧАСОВОЙ ЦИКЛ КОЛОНИИ (фаза 2, ТЗ_Экономика.md §§2–15): добыча →
// содержание → производство → население. server/buildings.go (фаза 1)
// размещает здания и проверяет связность — здесь эти данные оживают: реальный
// склад (Planet.Stock), реальное списание содержания, реальное производство
// компонентов заводами, реальный рост/убыль населения по еде.
//
// Добыча/содержание/население — раз в игровые сутки, как и раньше. Производство
// (шаг 3) — по прямому указанию пользователя ограничено раз в игровой ЧАС:
// один завод производит РОВНО ОДНУ партию за час (не «пока хватает сырья», как
// было раньше), и не больше maxProductionBatchesPerDay партий суммарно за
// сутки на завод (12 партий × 10 шт = 120 компонентов/сутки на завод) —
// счётчик Building.BatchesToday сбрасывается на границе суток.
//
// «Час»/«сутки» — дискретные единицы, которых в игре раньше не было вовсе
// (Clock, clock.go, знает только непрерывный Clock.months). Калибровка та же,
// что у gameSpeedRealtime (clock.go): 365.2425/12 суток = 1 игровой месяц,
// 24 часа = 1 сутки — advanceProduction переводит текущий Clock.months в
// номер часа и досчитывает пропущенные часы по одному (граница суток —
// каждый 24-й час), задним числом при паузе/ускорении не теряя ни одного и
// не блокируя сервер одним огромным проходом (maxProductionHoursPerAdvance).
//
// Изолированные (не connectedHexes) здания не добывают/не потребляют/не
// производят — то же самое уже обещано в client/planet.html («⚠ изолирован —
// не поставляет ресурсы на склад»), здесь это просто становится правдой.
// ════════════════════════════════════════════════════════════════════════════

const daysPerMonth = 365.2425 / 12
const hoursPerDay = 24

// maxProductionBatchesPerDay — потолок партий на один завод в сутки (решение
// пользователя): 12 партий × 10 шт = 120 компонентов/сутки на завод.
// Building.BatchesToday считает партии этого завода за текущие сутки,
// сбрасывается в 0 на границе суток (resetDailyBatches).
const maxProductionBatchesPerDay = 12

// maxProductionHoursPerAdvance — предохранитель против «догоняющего» шторма
// после долгой паузы или на максимальном ускорении администратора: один вызов
// advanceProduction не прогоняет больше этого числа часов подряд — остаток
// доедается следующими вызовами тикера (раз в реальную секунду), без потери
// часов и без блокировки sim.mu на неограниченное время. ~2000 суток — тот же
// порядок, что был у прежнего суточного предохранителя.
const maxProductionHoursPerAdvance = 2000 * hoursPerDay

// lastProdHour — номер последнего просимулированного часа. Пишет и читает
// только сама горутина driveProduction (однопоточный доступ, отдельный мьютекс
// не нужен — тот же приём, что и остальные package-level переменные сервера).
var lastProdHour int64

// driveProduction — фоновый тикер по образцу driveSim (main.go): границы часа
// на порядки грубее тактовой частоты симуляции (tickHz=20 в sim.go), раз в
// реальную секунду более чем достаточно.
func driveProduction(stop <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			advanceProduction(clk.Snapshot().Months)
		case <-stop:
			return
		}
	}
}

// advanceProduction — единый почасовой догоняющий цикл: на каждый час —
// производство (runProductionHour), а на каждый 24-й час (граница суток) —
// ЕЩЁ И добыча/содержание/сброс партий/население (runProductionDay), строго
// ПЕРЕД производством этого часа (новые сутки начинаются с чистого счётчика
// партий и свежедобытого сырья). День и час здесь не два независимых
// счётчика с риском рассинхронизации, а один — час, где день выводится как
// hour % hoursPerDay == 0.
func advanceProduction(months float64) {
	hour := int64(math.Floor(months * daysPerMonth * hoursPerDay))
	for lastProdHour < hour {
		steps := hour - lastProdHour
		if steps > maxProductionHoursPerAdvance {
			steps = maxProductionHoursPerAdvance
		}
		for i := int64(0); i < steps; i++ {
			lastProdHour++
			if lastProdHour%hoursPerDay == 0 {
				runProductionDay()
			}
			runProductionHour()
		}
	}
}

// ── рабочие места: свободное население vs занятое работой на зданиях ────────
//
// По требованию пользователя: раньше Planet.Population был чистой витриной
// (растёт/падает по еде, но ничего не гейтил) — здания добывали/производили
// независимо от того, сколько народу на планете вообще. Теперь у здания,
// которому нужен работник, но работника не хватило, добыча/производство
// (шаги 1/3) в этот день не идут — здание физически стоит, хотя и не
// сломано и не отключено. Содержание (шаг 2, upkeepDay) сознательно НЕ
// завязано на укомплектованность — здание требует обслуживания просто
// потому что существует, вне зависимости от того, работает ли на нём кто-то
// сегодня (та же логика, что и у Жилого модуля — он вообще не требует
// работника, но исправно потребляет воду).

// buildingWorkerRequirement — ТЗ_Экономика.md §12, столбец «Требует
// жителей»: 1 работник на любое продуктивное здание, единственное
// исключение в исходной таблице — Жилой модуль (0, само не производит,
// только даёт места). Транспортный узел в исходную таблицу не входил
// (добавлен позже, §15) — тот же принцип: «сам ничего не добывает и не
// производит, только присутствует», значит тоже 0.
func buildingWorkerRequirement(t BuildingType) int {
	switch t {
	case BuildingHousing, BuildingTransportNode:
		return 0
	default:
		return 1
	}
}

// workerPriority — если населения не хватает на все здания сразу, кого
// укомплектовать первым. САМОСТОЯТЕЛЬНОЕ архитектурное допущение (в ТЗ
// приоритет между зданиями не описан, только «1 житель на здание» без
// порядка): добыча — первый приоритет (без сырья не работает вообще ничего
// дальше по цепочке), заводы — второй, всё остальное (энергетика/оборона/
// наука/верфь и т.д.) — по остаточному принципу. Внутри одной группы
// приоритета — порядок в Planet.Buildings (порядок расстановки при
// bootstrapColony), см. assignedWorkers.
func workerPriority(t BuildingType) int {
	switch t {
	case BuildingMine, BuildingAtmoCollector, BuildingBioExtractor, BuildingHydroFarm:
		return 0
	case BuildingFactoryMetal, BuildingFactoryChem, BuildingFactoryElec, BuildingLab:
		return 1
	default:
		return 2
	}
}

// assignedWorkers — какие здания СЕГОДНЯ укомплектованы работником, в
// пределах текущего Planet.Population. Изолированные (не connected) здания
// вообще не участвуют в конкурсе за работников — они и так не добывают/не
// производят, укомплектовывать их бессмысленно. sort.SliceStable по
// workerPriority сохраняет исходный порядок Planet.Buildings внутри одной
// группы приоритета — детерминировано, не зависит от порядка map.
//
// Ключ занятости — ИНДЕКС здания в Planet.Buildings, НЕ координата гекса:
// на одном гексе может стоять до hexSlotsCap=7 разных зданий (buildings.go),
// у координаты (Q,R) нет однозначного соответствия одному зданию — ключевание
// по (Q,R) молча слило бы занятость всех зданий гекса в один общий флаг.
func assignedWorkers(p *Planet, connected map[[2]int]bool) map[int]bool {
	type candidate struct {
		index    int
		priority int
	}
	var candidates []candidate
	for i, b := range p.Buildings {
		if buildingWorkerRequirement(b.Type) == 0 || !connected[[2]int{b.Q, b.R}] {
			continue
		}
		candidates = append(candidates, candidate{i, workerPriority(b.Type)})
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].priority < candidates[j].priority })

	assigned := make(map[int]bool, len(candidates))
	remaining := p.Population
	for _, c := range candidates {
		if remaining <= 0 {
			break
		}
		assigned[c.index] = true
		remaining--
	}
	return assigned
}

// ── шаг 1: добыча ────────────────────────────────────────────────────────────

// mineKeysFor — тип здания → ключи ресурсов, которые оно добывает на своём
// гексе. Переиспользует starterMineGroups (buildings.go) — та же таблица уже
// используется для стартовой расстановки шахт по богатейшим гексам, здесь —
// для реальной ежедневной добычи.
func mineKeysFor(t BuildingType) []string {
	for _, g := range starterMineGroups {
		if g.building == t {
			return g.keys
		}
	}
	return nil
}

// mineDay — ТЗ_Экономика.md §2: «Одна шахта занимает один гекс и выдаёт
// добычу, равную концентрации этого гекса за сутки» — гекс никогда не
// истощается (то же самое поведение, что у Planet.Res сегодня). Дополнительно
// (по требованию пользователя) — не укомплектованная работником шахта в этот
// день не добывает вовсе, см. assignedWorkers выше.
func mineDay(p *Planet, connected map[[2]int]bool) {
	if len(p.Surface) == 0 {
		return
	}
	assigned := assignedWorkers(p, connected)
	hexByCoord := make(map[[2]int]*SurfaceHex, len(p.Surface))
	for i := range p.Surface {
		h := &p.Surface[i]
		hexByCoord[[2]int{h.Q, h.R}] = h
	}
	for i, b := range p.Buildings {
		keys := mineKeysFor(b.Type)
		if keys == nil || !connected[[2]int{b.Q, b.R}] || !assigned[i] {
			continue
		}
		h := hexByCoord[[2]int{b.Q, b.R}]
		if h == nil {
			continue
		}
		for _, key := range keys {
			if v := h.res[key]; v > 0 {
				addStock(p, key, float64(v))
				p.MinedToday = accumulate(p.MinedToday, key, float64(v))
			}
		}
	}
}

// ── шаг 2: содержание зданий ─────────────────────────────────────────────────

// buildingUpkeep — ТЗ_Экономика.md §14.2 (полная таблица) + §15.3
// (транспортный узел): 3 статьи расхода на здание за сутки. «Луч смерти» из
// §14.2 сюда не входит — уникальная постройка Станции-корабля, не здание
// колонии, у него нет BuildingType.
var buildingUpkeep = map[BuildingType][]recipeInput{
	BuildingMine:          {ri("bitumens", 4), ci("polymers", 2), ci("metal_structs", 1)},
	BuildingAtmoCollector: {ci("polymers", 3), ci("chem_reagents", 2), ci("metal_structs", 1)},
	BuildingBioExtractor:  {ci("polymers", 3), ci("chem_reagents", 2), ri("bitumens", 1)},
	BuildingHydroFarm:     {ci("polymers", 4), ri("bitumens", 2), ci("chem_reagents", 1)},
	BuildingFactoryMetal:  {ci("chem_reagents", 5), ci("polymers", 3), ri("waterIce", 2)},
	BuildingFactoryChem:   {ri("waterIce", 8), ci("chem_reagents", 4), ci("polymers", 2)},
	BuildingFactoryElec:   {ci("chem_reagents", 4), ci("polymers", 3), ri("waterIce", 1)},
	BuildingLab:           {ci("chem_reagents", 4), ci("sci_equipment", 2), ri("waterIce", 1)},
	BuildingHousing:       {ri("waterIce", 10), ci("polymers", 3), ci("chem_reagents", 1)},
	BuildingH2Generator:   {ri("waterIce", 5), ci("metal_structs", 2), ci("polymers", 1)},
	BuildingSolarPanel:    {ci("polymers", 3), ri("lightRare", 1)},
	BuildingBattery:       {ci("weapons", 4), ci("chem_reagents", 2), ci("metal_structs", 1)},
	BuildingFort:          {ci("weapons", 3), ci("polymers", 2), ci("chem_reagents", 1)},
	BuildingShipyard:      {ci("metal_structs", 4), ci("polymers", 2), ci("chem_reagents", 1)},
	BuildingAdvComponents: {ci("chem_reagents", 4), ci("polymers", 3), ci("microelectronics", 1)},
	BuildingRadio:         {ci("polymers", 3), ci("chem_reagents", 2), ci("electronics", 1)},
	BuildingScienceCenter: {ci("sci_equipment", 4), ci("chem_reagents", 3), ri("waterIce", 2)},
	BuildingCryptoFarm:    {ci("chem_reagents", 3), ci("polymers", 3), ri("waterIce", 1)},
	BuildingTransportNode: {ci("polymers", 2), ci("metal_structs", 1), ci("chem_reagents", 1)},
	BuildingNuclearPlant:  {ci("nuclear_components", 2), ri("waterIce", 6), ci("high_alloys", 1)},
	BuildingRecycler:      {ci("chem_reagents", 4), ci("polymers", 2), ri("waterIce", 2)},
}

// demolitionGraceDays — по требованию пользователя: здание, которому не
// хватает НА КОТОРУЮ-ЛИБО из 3 статей содержания (не хватает частично —
// демонтаж, а не недоплата, см. upkeepDay ниже), демонтируется. Порог в 3
// СУТОК ПОДРЯД — САМОСТОЯТЕЛЬНОЕ решение сверх явного запроса: демонтаж на
// первую же неудачу снёс бы стартовую колонию целиком в первые же игровые
// сутки. Причина не гипотетическая, а структурная: Химреагенты/Полимеры/
// Металлоконструкции — САМИ продукты заводов, а не сырьё, и на день 0 их на
// складе физически 0 (mineDay добывает только сырьё, а advanceProduction
// вызывает runProductionDay — значит и upkeepDay — СТРОГО ПЕРЕД первым же
// runProductionHour той же границы суток, см. комментарий там); первая
// проверка застаёт склад пустым по всем компонентам сразу — без
// грейс-периода это демонтировало бы почти всё захватом одной сутки, что
// явно не было целью запроса (пользователь просил экономическое давление за
// хронический дефицит, а не мгновенный снос стартовой колонии).
const demolitionGraceDays = 3

// demolitionRefundFrac — доля стоимости постройки (buildingCosts,
// economy.go), которую игрок получает обратно компонентами на склад при
// демонтаже; остаток утилизируется безвозвратно. Число (60%) и округление
// «к целым числам» — по прямому требованию пользователя.
const demolitionRefundFrac = 0.6

// upkeepDay — списывает содержание каждого подключённого здания. По
// требованию пользователя: недоплата больше не проходит бесследно — если на
// складе не хватает хотя бы ОДНОЙ из 3 статей расхода (canAffordCycle),
// здание НЕ платит частично, счётчик MissedUpkeepDays растёт; после
// demolitionGraceDays суток подряд без полной оплаты — здание демонтируется
// (refundBuilding: 60% стоимости постройки возвращается на склад, 40%
// утилизируется). Успешная оплата в любой день сбрасывает счётчик в 0 —
// порог именно про ХРОНИЧЕСКИЙ дефицит, единичный плохой день не наказывает.
// Изолированные (не connected) здания по-прежнему вне цикла целиком: не
// платят, не копят MissedUpkeepDays, не демонтируются — как и раньше, они
// просто не участвуют ни в одном шаге.
func upkeepDay(p *Planet, connected map[[2]int]bool) {
	kept := p.Buildings[:0:0]
	for _, b := range p.Buildings {
		if !connected[[2]int{b.Q, b.R}] {
			kept = append(kept, b)
			continue
		}
		inputs := buildingUpkeep[b.Type]
		if canAffordCycle(p.Stock, inputs) {
			payCycle(p.Stock, inputs)
			for _, in := range inputs {
				p.ConsumedToday = accumulate(p.ConsumedToday, in.Key, in.Qty)
			}
			b.MissedUpkeepDays = 0
			kept = append(kept, b)
			continue
		}
		b.MissedUpkeepDays++
		if b.MissedUpkeepDays < demolitionGraceDays {
			kept = append(kept, b)
			continue
		}
		refundBuilding(p, b.Type)
		p.DemolishedToday = append(p.DemolishedToday, string(b.Type))
	}
	p.Buildings = kept
}

// refundBuilding — 60% стоимости постройки (округление ПО КАЖДОМУ
// компоненту рецепта отдельно, math.Round, не от общей суммы) — обратно на
// склад; остальные 40% утилизируются безвозвратно (просто не добавляются
// никуда). Здание без записи в buildingCosts (сейчас таких нет — все 20
// BuildingType заведены 1:1) молча демонтируется без возврата.
func refundBuilding(p *Planet, t BuildingType) {
	cost, ok := buildingCostByType[t]
	if !ok {
		return
	}
	for _, in := range cost.Inputs {
		refund := math.Round(in.Qty * demolitionRefundFrac)
		if refund > 0 {
			addStock(p, in.Key, refund)
		}
	}
}

// ── энергия: учёт дефицита (без последствий, чистая метрика) ────────────────

// buildingEnergyOutput — энергия/сутки, которую даёт здание этого типа
// (ТЗ_Экономика.md §12.2 + §720 для атомной станции — «40 энергии/сутки, то
// же значение, что у Атомного реактора корабля»). Здания без записи здесь
// ничего не производят (0), только потребляют — как и раньше.
func buildingEnergyOutput(t BuildingType) float64 {
	switch t {
	case BuildingH2Generator:
		return 10
	case BuildingSolarPanel:
		return 5
	case BuildingNuclearPlant:
		return 40
	default:
		return 0
	}
}

// isActivityBilledEnergy — здания, чьё потребление считается НЕ плоской
// ставкой 1/сутки, а по фактической активности (ActivityEnergySpent,
// накапливается в produceHour/recycleHour): заводы (по тарифу ТУ рецепта)
// и завод переработки (recyclingEnergyPerBatch за партию любого рецепта).
// По требованию пользователя: «Производство — ТУ1 1 энергии, ТУ2 — 2, ТУ3 —
// 3. Остальные здания 1 энергии, если не описано иное» — простой недвижимый
// «1/сутки» для этих типов был бы ДВОЙНЫМ учётом поверх активности, поэтому
// они полностью исключены из плоской ставки ниже, а не дополняют её.
func isActivityBilledEnergy(t BuildingType) bool {
	if _, ok := factoryBuildingName[t]; ok {
		return true
	}
	return t == BuildingRecycler
}

// energyDay — пересчитывает EnergyProduction/EnergyConsumption заново
// каждые сутки, по подключённым зданиям (та же connected-гейт, что у
// остальных шагов — изолированное здание не потребляет и не производит
// энергию, симметрично тому, что оно не добывает/не производит компоненты).
// Вызывается ПОСЛЕ upkeepDay намеренно — если сутки демонтировали здание,
// баланс должен отражать ИТОГОВЫЙ состав колонии на конец дня, а не тот,
// что был до демонтажа.
//
// Потребление — по требованию пользователя ДИФФЕРЕНЦИРОВАННОЕ (раньше было
// плоские 1/здание без исключений): добыча и «всё остальное» — 1/сутки за
// штуку, как и раньше (ТЗ_Экономика.md §12.1, isActivityBilledEnergy==false
// для них). Заводы/переработка — НЕ входят в эту плоскую сумму вовсе, их
// расход накоплен весь день в p.ActivityEnergySpent (produceHour добавляет
// тариф по ТУ рецепта за каждую успешную партию, recycleHour — фиксированные
// recyclingEnergyPerBatch) — здесь он просто ДОБАВЛЯЕТСЯ к потреблению и
// СБРАСЫВАЕТСЯ для следующих суток (тот же принцип, что Building.BatchesToday
// /resetDailyBatches, только на уровне планеты).
func energyDay(p *Planet, connected map[[2]int]bool) {
	var production, consumption float64
	for _, b := range p.Buildings {
		if !connected[[2]int{b.Q, b.R}] {
			continue
		}
		if !isActivityBilledEnergy(b.Type) {
			consumption++
		}
		production += buildingEnergyOutput(b.Type)
	}
	consumption += p.ActivityEnergySpent
	p.ActivityEnergySpent = 0
	p.EnergyProduction = production
	p.EnergyConsumption = consumption
}

// ── шаг 3: производство компонентов (почасовое, до 12 партий/сутки/завод) ────

// factoryBuildingName — BuildingType → componentRecipe.Factory (economy.go),
// чтобы отобрать рецепты, которые умеет производить конкретное здание.
var factoryBuildingName = map[BuildingType]string{
	BuildingFactoryMetal: "Металлургический завод",
	BuildingFactoryChem:  "Химический завод",
	BuildingFactoryElec:  "Электроинженерный завод",
	BuildingLab:          "Лаборатория передовых систем",
}

// recipesForFactory — все рецепты (ЛЮБОГО из 3 уровней ТУ) этого завода.
// Допущение v1: здание-завод не хранит «текущий уровень технологии» (такого
// поля нет ни у Building, ни у BuildingType, апгрейдить пока нечего) — значит
// способно на все уровни своего типа сразу. Пересмотреть, когда появится
// механика уровней заводов (ТЗ_Экономика.md §6.2).
func recipesForFactory(name string) []componentRecipe {
	var out []componentRecipe
	for _, r := range componentRecipes {
		if r.Factory == name {
			out = append(out, r)
		}
	}
	return out
}

func canAffordCycle(stock map[string]float64, inputs []recipeInput) bool {
	for _, in := range inputs {
		if stock[in.Key] < in.Qty {
			return false
		}
	}
	return true
}

func payCycle(stock map[string]float64, inputs []recipeInput) {
	for _, in := range inputs {
		stock[in.Key] -= in.Qty
	}
}

// componentStockFloor — по требованию пользователя: производство сперва
// стремится обеспечить БАЗОВЫЙ МИНИМУМ по 10 каждого компонента, который
// умеет производить завод (любого ТУ, не только ТУ1 — раньше эту роль
// играл tier1StockFloor/tier1NeedsBuildup, но только для ТУ1; проблема была
// в том, что «стремление к разнообразию» само по себе не учитывалось —
// завод мог качать один и тот же дешёвый доступный рецепт, пока другие
// типы стояли на нуле). Соответствует клиентскому полю «мин. запас» на
// складе (client/planet.html, whState) — там оно пока чисто
// косметическое/сессионное, здесь то же число (10) зашито как единый порог
// для всех компонентов на сервере.
const componentStockFloor = 10

// dailyUpkeepDemand — суммарная потребность в содержании на предстоящие
// сутки по всем ПОДКЛЮЧЁННЫМ зданиям (buildingUpkeep, ТЗ_Экономика.md
// §14.2) — первый шаг алгоритма формирования очереди производства (решение
// пользователя: «сначала считаем что нужно для содержания»).
func dailyUpkeepDemand(p *Planet, connected map[[2]int]bool) map[string]float64 {
	demand := map[string]float64{}
	for _, b := range p.Buildings {
		if !connected[[2]int{b.Q, b.R}] {
			continue
		}
		for _, in := range buildingUpkeep[b.Type] {
			demand[in.Key] += in.Qty
		}
	}
	return demand
}

// buildQueueForRecipes — приоритетный порядок рецептов ОДНОГО типа завода
// на весь день (решение пользователя, три группы приоритета, без пересечения
// — рецепт попадает РОВНО в одну):
//  1. «Нужно для содержания» — выход рецепта входит в upkeepDemand, и на
//     складе меньше этой суточной потребности; сортировка внутри группы —
//     по размеру нехватки (самый острый дефицит первым).
//  2. «Ниже общего минимума» — то же самое, что раньше делала pickBelowFloor
//     (componentStockFloor=10), но теперь явный порядок, а не почасовая
//     ротация; сортировка — по размеру нехватки до порога.
//  3. «Всё остальное» — по НАСТОЯЩЕЙ цене (priceOf, economy.go — решение
//     пользователя: не по уровню ТУ, как было раньше), от дорогого к
//     дешёвому — «строим то, что как можно выше по цене».
func buildQueueForRecipes(recipes []componentRecipe, stock map[string]float64, upkeepDemand map[string]float64, priceCache map[string]componentResolved) []string {
	type scored struct {
		key   string
		score float64
	}
	var need, floor, rest []scored
	for _, r := range recipes {
		have := stock[r.Key]
		switch {
		case upkeepDemand[r.Key] > 0 && have < upkeepDemand[r.Key]:
			need = append(need, scored{r.Key, upkeepDemand[r.Key] - have})
		case have < componentStockFloor:
			floor = append(floor, scored{r.Key, componentStockFloor - have})
		default:
			rest = append(rest, scored{r.Key, priceOf(r.Key, priceCache)})
		}
	}
	byScoreDesc := func(s []scored) { sort.Slice(s, func(i, j int) bool { return s[i].score > s[j].score }) }
	byScoreDesc(need)
	byScoreDesc(floor)
	byScoreDesc(rest)
	out := make([]string, 0, len(need)+len(floor)+len(rest))
	for _, group := range [][]scored{need, floor, rest} {
		for _, s := range group {
			out = append(out, s.key)
		}
	}
	return out
}

// buildDailyQueues — пересчитывает Building.Queue заново на начинающиеся
// сутки: ОДНА очередь на ТИП завода (решение пользователя — «общая на тип
// завода»), записывается одинаково во все здания этого типа. Вызывается
// ПОСЛЕ upkeepDay/energyDay намеренно — демонтированные за сегодня здания
// уже не в p.Buildings, и очередь считается по СВЕЖЕМУ складу (после того,
// что упkeep уже списал). Building.Queue (buildings.go) был задел на
// будущее — «структура данных, production.go её пока не читает»; теперь
// читает: produceHour/recycleHour ниже просто идут по этому списку. Завод
// переработки получает свою очередь тем же вызовом, но БЕЗ фаз «нужно для
// содержания»/«ниже минимума» — recyclingRecipes производят СЫРЬЁ, не
// входящее в buildingUpkeep готовых компонентов, поэтому её очередь всегда
// recyclingRecipes в порядке объявления (дешёвый рецепт 1 → низкорентабельные
// 2/3, решение пользователя — переработка «последним шагом», после того как
// более приоритетное сырьё уже израсходовано на настоящее производство).
func buildDailyQueues(p *Planet, connected map[[2]int]bool) {
	if p.Stock == nil {
		p.Stock = make(map[string]float64)
	}
	demand := dailyUpkeepDemand(p, connected)
	priceCache := map[string]componentResolved{}
	queues := map[BuildingType][]string{}
	for bt, name := range factoryBuildingName {
		queues[bt] = buildQueueForRecipes(recipesForFactory(name), p.Stock, demand, priceCache)
	}
	recyclerQueue := make([]string, len(recyclingRecipes))
	for i, r := range recyclingRecipes {
		recyclerQueue[i] = r.Key
	}
	queues[BuildingRecycler] = recyclerQueue

	for i := range p.Buildings {
		if q, ok := queues[p.Buildings[i].Type]; ok {
			p.Buildings[i].Queue = q
		}
	}
}

// recyclingRecipeByKey — recyclingRecipes (economy.go) по ключу выхода;
// НЕ то же самое, что recipeByKey (componentRecipes) — переработка выдаёт
// СЫРЬЁ (bitumens/lightRare/platinoids), не компоненты, отдельный список.
func recyclingRecipeByKey(key string) (componentRecipe, bool) {
	for _, r := range recyclingRecipes {
		if r.Key == key {
			return r, true
		}
	}
	return componentRecipe{}, false
}

// produceHour — по требованию пользователя: завод производит РОВНО ОДНУ
// партию (10 шт., §8.1) за игровой час, если хватает сырья и не исчерпан
// суточный потолок (maxProductionBatchesPerDay, Building.BatchesToday), И
// сегодня укомплектован работником (assignedWorkers) — незанятый завод в
// этот час/сутки простаивает, как и незанятая шахта (mineDay выше). Какой
// рецепт производить — больше НЕ решается заново каждый час (было —
// pickRecipeToProduce с почасовой ротацией): завод идёт по своей
// Building.Queue (buildDailyQueues, пересчитывается раз в сутки) СТРОГО ПО
// ПОРЯДКУ, первый рецепт по карману побеждает. hourSeed сохранён в сигнатуре
// ради обратной совместимости вызова (production_test.go), внутри уже не
// используется. Каждая успешная партия добавляет к p.ActivityEnergySpent
// тариф по ТУ рецепта (1/2/3 — решение пользователя, energyDay выше
// сворачивает это в EnergyConsumption на границе суток) — ЗАМЕНА плоской
// ставке «1/сутки», не дополнение к ней.
//
// cycleLog — необязательный счётчик «сколько партий какой рецепт отработал»,
// по типу здания-завода: cycleLog[тип здания][ключ рецепта]++ на каждую
// успешную партию. nil в обычной работе (без накладных расходов —
// production_test.go передаёт свою карту для диагностики).
func produceHour(p *Planet, connected map[[2]int]bool, hourSeed int64, cycleLog map[BuildingType]map[string]int) {
	_ = hourSeed
	assigned := assignedWorkers(p, connected)
	for i := range p.Buildings {
		b := &p.Buildings[i]
		if _, ok := factoryBuildingName[b.Type]; !ok || !connected[[2]int{b.Q, b.R}] || !assigned[i] || b.BatchesToday >= maxProductionBatchesPerDay {
			continue
		}
		if p.Stock == nil {
			p.Stock = make(map[string]float64)
		}
		for _, key := range b.Queue {
			rec, ok := recipeByKey(key)
			if !ok || !canAffordCycle(p.Stock, rec.Inputs) {
				continue
			}
			payCycle(p.Stock, rec.Inputs)
			p.Stock[rec.Key] += 10
			b.BatchesToday++
			p.ActivityEnergySpent += float64(rec.Tier)
			p.ProducedToday = accumulate(p.ProducedToday, rec.Key, 10)
			for _, in := range rec.Inputs {
				p.ConsumedToday = accumulate(p.ConsumedToday, in.Key, in.Qty)
			}
			if cycleLog != nil {
				if cycleLog[b.Type] == nil {
					cycleLog[b.Type] = map[string]int{}
				}
				cycleLog[b.Type][rec.Key]++
			}
			break
		}
	}
}

// recyclingEnergyPerBatch — по требованию пользователя: 5 энергии за партию
// переработки, ОДИНАКОВО для всех 3 рецептов (recyclingRecipes, economy.go)
// вне зависимости от их собственного Tier — тариф за партию произведённых
// компонентов (produceHour выше) в переработке не применяется, у неё свой
// плоский тариф.
const recyclingEnergyPerBatch = 5

// recycleHour — завод переработки (BuildingRecycler), тем же механизмом
// очереди, что produceHour: идёт по своей Building.Queue (buildDailyQueues
// — для переработки это всегда recyclingRecipes в порядке объявления)
// СТРОГО ПО ПОРЯДКУ, первый по карману побеждает — рецепт 1 (дешёвый)
// почти всегда доступен, поэтому 2/3 (низкорентабельные) включаются только
// когда у рецепта 1 закончилось СВОЁ сырьё. Раньше был отдельный темп «раз
// в 2 часа» — по решению пользователя переработка встроена ПОСЛЕДНИМ шагом
// в общий приоритет производства, поэтому теперь работает в ТОМ ЖЕ
// почасовом цикле, что и обычные заводы (никакой особой чётности часа);
// естественный потолок не изменился — maxProductionBatchesPerDay=12/сутки.
func recycleHour(p *Planet, connected map[[2]int]bool, hourSeed int64) {
	_ = hourSeed
	assigned := assignedWorkers(p, connected)
	for i := range p.Buildings {
		b := &p.Buildings[i]
		if b.Type != BuildingRecycler || !connected[[2]int{b.Q, b.R}] || !assigned[i] || b.BatchesToday >= maxProductionBatchesPerDay {
			continue
		}
		if p.Stock == nil {
			p.Stock = make(map[string]float64)
		}
		for _, key := range b.Queue {
			rec, ok := recyclingRecipeByKey(key)
			if !ok || !canAffordCycle(p.Stock, rec.Inputs) {
				continue
			}
			payCycle(p.Stock, rec.Inputs)
			out := recyclingBatchOutput(rec.Tier)
			p.Stock[rec.Key] += out
			b.BatchesToday++
			p.ActivityEnergySpent += recyclingEnergyPerBatch
			p.ProducedToday = accumulate(p.ProducedToday, rec.Key, out)
			for _, in := range rec.Inputs {
				p.ConsumedToday = accumulate(p.ConsumedToday, in.Key, in.Qty)
			}
			break
		}
	}
}

// resetDailyBatches — обнуляет суточный счётчик партий каждого здания на
// границе суток (maxProductionBatchesPerDay считается заново каждые сутки).
func resetDailyBatches(p *Planet) {
	for i := range p.Buildings {
		p.Buildings[i].BatchesToday = 0
	}
}

// ── шаг 4: население ─────────────────────────────────────────────────────────

// foodKeys — три типа пищи (ТЗ_Экономика.md §12.5), та же тройка ключей, что
// planetFoodTypes (buildings.go) уже использует для определения ЧИСЛА
// доступных типов — здесь переиспользуется для суммарного запаса еды и для
// порядка списания (едим сначала самое дешёвое).
var foodKeys = []string{"biomass", "biosynthetics", "bioengineered"}

func foodStockTotal(stock map[string]float64) float64 {
	total := 0.0
	for _, k := range foodKeys {
		total += stock[k]
	}
	return total
}

func deductFood(stock map[string]float64, qty float64) {
	for _, k := range foodKeys {
		if qty <= 0 {
			return
		}
		take := math.Min(stock[k], qty)
		stock[k] -= take
		qty -= take
	}
}

// populationDay — ТЗ_Экономика.md §11.2 буквально: растёт/падает ±1 житель на
// поселение (Жилой модуль) за сутки, по еде. bootstrapColony/computePopulation
// (buildings.go) не меняются — они остаются посевным значением на день 0,
// эта функция эволюционирует population дальше теми же helper'ами
// (settlementWorkerCap/planetFoodTypes), так что бутстрап и симуляция никогда
// не разойдутся в определении лимита.
func populationDay(p *Planet) {
	settlements := 0
	for _, b := range p.Buildings {
		if b.Type == BuildingHousing {
			settlements++
		}
	}
	if settlements == 0 {
		return
	}
	foodCap := settlements * settlementWorkerCap(planetFoodTypes(p.Buildings))
	hardCap := settlements * 10
	food := foodStockTotal(p.Stock)

	switch {
	case food < float64(p.Population): // голод — не хватает еды даже на нынешнее население
		p.Population -= settlements
	case p.Population < foodCap && food >= float64(p.Population+settlements): // рост — лимит по еде не достигнут и хватает и на прирост
		p.Population += settlements
		if p.Population > foodCap {
			p.Population = foodCap
		}
	case p.Population > foodCap: // переполнение по еде — лимит только что снизился (постройки/еда пропали)
		p.Population -= settlements
		if p.Population < foodCap {
			p.Population = foodCap
		}
	}
	if p.Population < 0 {
		p.Population = 0
	}
	if p.Population > hardCap { // §11.2 «Случай В»: физический потолок жилья, 10/поселение
		p.Population = hardCap
	}

	deductFood(p.Stock, math.Min(food, float64(p.Population)))
}

// ── склад: инициализация при первом обращении ────────────────────────────────

func addStock(p *Planet, key string, qty float64) {
	if qty == 0 {
		return
	}
	if p.Stock == nil {
		p.Stock = make(map[string]float64)
	}
	p.Stock[key] += qty
}

func cloneStock(src map[string]float64) map[string]float64 {
	if src == nil {
		return nil
	}
	out := make(map[string]float64, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

// accumulate — прибавляет qty к m[key], инициализируя m при первом
// обращении (тот же приём, что addStock, но возвращает карту — нужна для
// полей вроде Planet.ProducedToday, которые сами могут быть nil). Используют
// накопители суточного журнала (EventLog, Planet.*Today) — mineDay/
// upkeepDay/produceHour/recycleHour.
func accumulate(m map[string]float64, key string, qty float64) map[string]float64 {
	if qty == 0 {
		return m
	}
	if m == nil {
		m = map[string]float64{}
	}
	m[key] += qty
	return m
}

// ── дирижёр: клонирование вместо мутации на месте ─────────────────────────────

// forEachColonizedPlanet — общий обход всех заселённых планет сектора: для
// каждой звезды с хотя бы одной колонизированной планетой клонирует срез её
// планет (и Stock каждой затронутой планеты отдельно — Planet.Stock это map,
// ссылочный тип, поверхностное копирование среза Planet расшарило бы старую
// map с новой версией), применяет step к каждой такой планете, атомарно
// подменяет sim.objects[id]. sim.go документирует объекты (*Object, внутри —
// []Planet) как неизменные после создания: Sim.Snapshot()/Sim.Object() отдают
// «сырые» указатели под RLock, которые маршалятся в JSON уже после отпускания
// блокировки — мутировать Planet на месте внутри живого *Object означало бы
// гонку данных, ломающую этот инвариант. Общая часть runProductionDay/
// runProductionHour (сама мутация внутри step — разная, обход и клонирование
// — одинаковые), по образцу того, как Sim.Advance целиком заменяет объекты
// при обороте, а не мутирует поля.
func forEachColonizedPlanet(step func(p *Planet, connected map[[2]int]bool)) {
	sim.mu.Lock()
	defer sim.mu.Unlock()
	for id, obj := range sim.objects {
		if obj.Type != "star" {
			continue
		}
		var cloned []Planet
		for i := range obj.Planets {
			if len(obj.Planets[i].Buildings) == 0 {
				continue // неколонизировано — нечего симулировать
			}
			if cloned == nil {
				cloned = append([]Planet(nil), obj.Planets...)
			}
			p := &cloned[i]
			p.Stock = cloneStock(p.Stock)
			connected := connectedHexes(p)
			step(p, connected)
		}
		if cloned != nil {
			next := *obj
			next.Planets = cloned
			sim.objects[id] = &next
		}
	}
}

// runProductionDay — суточные шаги: добыча, содержание, сброс суточных
// партий, население. Вызывается advanceProduction на каждой границе суток,
// ПЕРЕД производством этого же часа.
func runProductionDay() {
	day := lastProdHour / hoursPerDay
	forEachColonizedPlanet(func(p *Planet, connected map[[2]int]bool) {
		mineDay(p, connected)
		upkeepDay(p, connected)
		energyDay(p, connected)
		buildDailyQueues(p, connected)
		resetDailyBatches(p)
		populationDay(p)
		logDayEntry(p, day)
	})
}

// maxEventLogDays — кольцевой буфер журнала (EventLog, Planet.go): держим
// только последние N суток, старые записи вытесняются. По требованию
// пользователя журнал нужен для НАГЛЯДНОСТИ за небольшое число суток («у нас
// всего 10 циклов, всё наглядно будет») — 60 суток с запасом, не раздувает
// память (объекты небольшие, десятки ключей).
const maxEventLogDays = 60

// DayLogEntry — одна строка журнала событий колонии (по требованию
// пользователя): что намыли, что произвели/переработали, что потратили
// (содержание + входы производства/переработки), что снесли, и остаток
// склада на конец суток — снимок «было → стало» за один игровой день.
type DayLogEntry struct {
	Day        int64              `json:"day"`
	Mined      map[string]float64 `json:"mined,omitempty"`
	Produced   map[string]float64 `json:"produced,omitempty"`
	Consumed   map[string]float64 `json:"consumed,omitempty"`
	Demolished []string           `json:"demolished,omitempty"`
	Stock      map[string]float64 `json:"stock"`
	Population int                `json:"population"`
	Buildings  int                `json:"buildings"`
}

// logDayEntry — сворачивает суточные накопители (Mined/Produced/
// ConsumedToday, DemolishedToday — растут весь день в mineDay/upkeepDay/
// produceHour/recycleHour) в новую запись EventLog и обнуляет их для
// следующих суток. Вызывается ПОСЛЕДНИМ шагом runProductionDay — Stock/
// Population/Buildings в записи должны быть ИТОГОВЫМИ за день (после
// возможного демонтажа и эволюции населения), а не промежуточными.
func logDayEntry(p *Planet, day int64) {
	entry := DayLogEntry{
		Day:        day,
		Mined:      p.MinedToday,
		Produced:   p.ProducedToday,
		Consumed:   p.ConsumedToday,
		Demolished: p.DemolishedToday,
		Stock:      cloneStock(p.Stock),
		Population: p.Population,
		Buildings:  len(p.Buildings),
	}
	p.EventLog = append(p.EventLog, entry)
	if len(p.EventLog) > maxEventLogDays {
		p.EventLog = p.EventLog[len(p.EventLog)-maxEventLogDays:]
	}
	p.MinedToday = nil
	p.ProducedToday = nil
	p.ConsumedToday = nil
	p.DemolishedToday = nil
}

// runProductionHour — почасовой шаг: производство (см. produceHour).
// Вызывается advanceProduction каждый игровой час.
func runProductionHour() {
	hourSeed := lastProdHour
	forEachColonizedPlanet(func(p *Planet, connected map[[2]int]bool) {
		produceHour(p, connected, hourSeed, nil) // без учёта пачек — для этого server/production_test.go
		recycleHour(p, connected, hourSeed)
	})
}
