package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"sync"
)

// ════════════════════════════════════════════════════════════════════════════
// ЭКОНОМИКА — админ-панель `client/economy.html`.
//
// Цены и масса 15 реализованных ресурсов (сырьё из planets.go) редактируются
// администратором и хранятся на диске (economy_data.json рядом с сервером —
// сервер полагается на файл как на истину, правки переживают перезапуск).
//
// Рецепты 21 компонента (I/II/III цикл) и стоимость постройки 19 зданий —
// ВРЕМЕННЫЕ справочные данные, взятые как есть из ТЗ_Экономика.md (§8-10, §13,
// §15) — этих чисел нет больше нигде в коде, и админ их не редактирует. Итоговая
// стоимость/масса компонентов и зданий пересчитывается на лету от текущих цен и
// массы базовых ресурсов (см. resolveComponent/resolveBuilding).
//
// Металлический водород и антиматерия (ресурсы №16-17 ТЗ_Ресурсы.md) в
// симуляции не реализованы (нет в resourceDefs, planets.go) — не входят в
// список редактируемых ресурсов вовсе. Три рецепта ТУ3 (антигравитация,
// квантовые вычислители, аннигиляционные заряды), которые их используют,
// показаны как есть — их вход отмечен Unimplemented: физическая масса берётся
// из фиксированной константы ТЗ, а денежная стоимость не считается (флаг
// Incomplete на компоненте/здании — клиент должен это отметить).
// ════════════════════════════════════════════════════════════════════════════

// ── справочник ресурсов ─────────────────────────────────────────────────────

// econResourceOrder — 16 реализованных ресурсов, порядок как в client
// RESOURCES (planets.html/economy.html), не как в resourceDefs. Металлический
// водород добавлен сюда (был в unimplemented) — теперь генерируется в
// planets.go (газовые гиганты зон 1–4, resourceDefs), реализован по-настоящему.
var econResourceOrder = []string{
	"silicates", "iron", "refractory", "lightRare", "platinoids",
	"hydrogen", "helium3", "inertGases", "volcanicGases", "radioactives",
	"waterIce", "biomass", "phosphates", "carbonates", "bitumens", "metal_hydrogen",
}

// econDefaultMass — масса единицы ресурса (у.м.), ТЗ_Ресурсы.md §1.
var econDefaultMass = map[string]float64{
	"silicates": 8, "iron": 12, "refractory": 10, "lightRare": 14, "platinoids": 16,
	"hydrogen": 2, "helium3": 1, "inertGases": 3, "volcanicGases": 4, "radioactives": 18,
	"waterIce": 5, "biomass": 5, "phosphates": 8, "carbonates": 6, "bitumens": 7,
	"metal_hydrogen": 28,
}

// unimplementedMass/unimplementedName — осталась только антиматерия (ресурс
// №17, ТЗ_Ресурсы.md §3.2): собирается у аномалий, не у планет, добыча —
// отдельная механика, которой пока нет в planets.go. Металлический водород
// (№16) отсюда убран — реализован (см. econResourceOrder).
var unimplementedMass = map[string]float64{
	"antimatter": 30,
}
var unimplementedName = map[string]string{
	"antimatter": "Антиматерия",
}

func isEconResource(key string) bool {
	for _, k := range econResourceOrder {
		if k == key {
			return true
		}
	}
	return false
}

func resourceDefByKey(key string) (resourceDef, bool) {
	for _, rd := range resourceDefs {
		if rd.Key == key {
			return rd, true
		}
	}
	return resourceDef{}, false
}

// sectorResourceTotals — суммарный реальный запас каждого ресурса по всем
// планетам сгенерированного сектора (та же величина, что клиент считает сам
// из /api/galaxy для колонки «запас в секторе», economy.html табл. 1 — здесь
// нужна той же формуле на сервере для расчёта цены). Требует уже созданный
// sim (main.go вызывает loadEconomy() после sim = NewSim(...)).
func sectorResourceTotals() map[string]float64 {
	totals := map[string]float64{}
	if sim == nil {
		return totals
	}
	objects, _ := sim.Snapshot()
	for _, o := range objects {
		if o.Type != "star" {
			continue
		}
		for _, p := range o.Planets {
			for k, v := range p.Res {
				totals[k] += float64(v)
			}
		}
	}
	return totals
}

func maxOf(totals map[string]float64) float64 {
	max := 0.0
	for _, v := range totals {
		if v > max {
			max = v
		}
	}
	return max
}

// round5 — округление до кратного 5, минимум 5.
func round5(v float64) float64 {
	r := math.Round(v/5) * 5
	if r < 5 {
		r = 5
	}
	return r
}

// recommendedPriceFromTotals — ОДНА формула для всех 15 ресурсов без
// исключений и без отдельных игродизайнерских коэффициентов: цена
// пропорциональна обратному реальному запасу ресурса в текущем сгенерированном
// секторе относительно самого распространённого ресурса этого же сектора.
// цена = 5 × (запас_самого_частого / запас_этого_ресурса). У кого меньше
// реальных единиц в секторе прямо сейчас — тот дороже, и наоборот; никакого
// хардкода «водород всегда 5» — это просто следствие того, что водород
// почти всегда самый распространённый ресурс сектора по факту генерации.
func recommendedPriceFromTotals(key string, totals map[string]float64, maxStock float64) float64 {
	stock := totals[key]
	if stock <= 0 {
		stock = 1 // ресурса нет в сгенерированном секторе — не делим на 0
	}
	if maxStock <= 0 {
		return 5
	}
	return round5(5.0 * maxStock / stock)
}

func recommendedPrice(key string) float64 {
	totals := sectorResourceTotals()
	return recommendedPriceFromTotals(key, totals, maxOf(totals))
}

// ── энергетика модулей корабля (client/ship-deck-sectors.html) ─────────────
//
// Зеркало SHIP_MODULES оттуда, редактируемое администратором
// (client/economy.html, вкладка «ЭНЕРГИЯ») — раньше числа были хардкодом
// прямо в JS конструктора кораблей. Первая версия (Gen/Use) была условной
// оценкой «в ТЗ формул нет» — это оказалось неверно: в ТЗ_Корабль.md §4.20
// уже есть настоящая сводная таблица потребления по модулям (числа
// зафиксированы пользователем в отдельной сессии над тем документом), эта
// правка сверяет код с ней. Заодно пользователь уточнил деление, которого
// в плоском Use не было: у модуля есть ПАССИВНЫЙ расход (постоянно, пока
// корабль жив/работает — СЖО/радар/computer/щит-дежурство) и АКТИВНЫЙ пик
// (только в момент действия — двигатель при разгоне, оружие при выстреле,
// РЭБ в бою, щит при поглощении удара). Грузовой отсек/Ангар/Стыковочный
// док/Солнечный парус — по ТЗ 0 в обоих режимах. Источники энергии
// (реактор/газохранилище/панель/аккумулятор) сами не потребляют (в ТЗ прямо
// «источник, не потребитель» — 4.7).
//
// ВАЖНО (пока не смоделировано числами, только пометка для будущего шага):
// по ТЗ §4.5 оба типа двигателя топятся ВОДОРОДОМ/ГЕЛИЕМ-3 из Газохранилища,
// а не «общей электрикой» реактора — то есть у корабля фактически ДВЕ
// независимые сети (топливная — только двигатели, от Газохранилища;
// электрическая — всё остальное, от реактора/панели/аккумулятора). Учёт
// реального расхода топлива (курс сжигания, §4.7: 1 водород→10 энергии,
// 1 гелий-3→100, металл. водород не оцифрован в ТЗ вовсе) — отдельный шаг
// (расчёт тяги/ускорения), здесь фиксируются только сами числа расхода.
var shipModuleEnergyOrder = []string{
	"ship_life_support", "ship_colonist", "ship_weapon_mount", "ship_solar_sail",
	"ship_engine", "ship_engine_ion", "ship_reactor", "ship_gas_storage",
	"ship_battery", "ship_repair", "ship_solar_panel", "ship_teleport",
	"ship_miner", "ship_radar", "ship_ecm", "ship_computer", "ship_shield",
	"ship_dock", "ship_hangar", "ship_cargo",
}

type shipModulePower struct{ Gen, Active, Passive float64 }

// shipModuleEnergyDefaults — «заводские» значения. Источник — ТЗ_Корабль.md
// §4.20, кроме мест, отмеченных ниже как собственная оценка (в ТЗ явно
// написано «не задано»/«качественно», числа не даны):
//   - ship_colonist — оценка (в ТЗ только «качественно потребляет энергию»);
//   - ship_repair/ship_miner — оценка (в ТЗ «не задано, только при действии»);
//   - ship_computer — оценка, поднята с прежней (в ТЗ «не задано, качественно
//     постоянно МНОГО» — заметно больше рядовых 1-2 у СЖО/радара);
//   - ship_engine_ion — не из ТЗ (модуль введён в v2), по прямому требованию
//     пользователя поднят с ×4 (5→20) до ×20 (5→100) от обычного двигателя —
//     атомный реактор (powerGen=40) теперь физически не может в одиночку
//     тянуть даже один такой двигатель на полную мощность (что и было целью
//     правки — см. shipphysics.go settleEnergyCycle);
//     недостача энергии не блокирует полёт целиком, а линейно снижает тягу
//     через уже существующий FuelRatio (shipphysics.go computeShipPhysics);

//   - ship_solar_panel — ТЗ даёт 3 уровня по орбитам (10/2/1), здесь взят
//     оптимистичный «ближние орбиты» как единственное статическое число —
//     инструмент вне контекста конкретной звезды;
//   - ship_teleport — ТЗ считает «40 за КАЖДЫЙ сектор прыжка», здесь — плоское
//     разовое значение без учёта дальности (дальность прыжка тут не задана).
var shipModuleEnergyDefaults = map[string]shipModulePower{
	"ship_life_support": {0, 2, 2}, "ship_colonist": {0, 2, 2}, "ship_weapon_mount": {0, 1, 0},
	"ship_solar_sail": {0, 0, 0}, "ship_engine": {0, 5, 0}, "ship_engine_ion": {0, 100, 0},
	"ship_reactor": {40, 0, 0}, "ship_gas_storage": {10, 0, 0}, "ship_battery": {0, 0, 0},
	"ship_repair": {0, 2, 0}, "ship_solar_panel": {10, 0, 0}, "ship_teleport": {0, 40, 0},
	"ship_miner": {0, 3, 0}, "ship_radar": {0, 1, 1}, "ship_ecm": {0, 3, 0},
	"ship_computer": {0, 5, 5}, "ship_shield": {0, 15, 1}, "ship_dock": {0, 0, 0},
	"ship_hangar": {0, 0, 0}, "ship_cargo": {0, 0, 0},
}

func isShipModuleKey(key string) bool {
	_, ok := shipModuleEnergyDefaults[key]
	return ok
}

// ── персистентные оверрайды администратора ──────────────────────────────────

type resourceOverride struct {
	Price *float64 `json:"price,omitempty"`
	Mass  *float64 `json:"mass,omitempty"`
}

type shipModuleOverride struct {
	PowerGen     *float64 `json:"powerGen,omitempty"`
	PowerActive  *float64 `json:"powerActive,omitempty"`
	PowerPassive *float64 `json:"powerPassive,omitempty"`
}

type economyData struct {
	Resources   map[string]resourceOverride   `json:"resources"`
	ShipModules map[string]shipModuleOverride `json:"shipModules,omitempty"`
}

var (
	econMu   sync.RWMutex
	econData economyData
)

// economyDataFile — рядом с сервером; проект запускается как `cd server &&
// go run .`, поэтому относительный путь достаточен (тот же расчёт, что и у
// остальных server/*.go — никакого отдельного каталога данных в проекте нет).
const economyDataFile = "economy_data.json"

// loadEconomy — читает economy_data.json при старте. Если файла нет или он
// повреждён, создаёт его заново со всеми 15 ресурсами на рекомендованных
// цене/массе — сервер полагается на файл как на истину с первого запуска.
func loadEconomy() {
	econMu.Lock()
	defer econMu.Unlock()
	if b, err := os.ReadFile(economyDataFile); err == nil {
		var d economyData
		if jerr := json.Unmarshal(b, &d); jerr == nil {
			if d.Resources == nil {
				d.Resources = map[string]resourceOverride{}
			}
			if d.ShipModules == nil {
				d.ShipModules = map[string]shipModuleOverride{}
			}
			econData = d
			seedShipModuleDefaultsLocked() // старый файл мог не знать о вкладке «Энергия» — дозаполняем недостающие ключи
			return
		} else {
			log.Printf("economy_data.json повреждён (%v) — пересоздаю с рекомендованными значениями", jerr)
		}
	}
	econData = economyData{Resources: map[string]resourceOverride{}, ShipModules: map[string]shipModuleOverride{}}
	totals := sectorResourceTotals()
	maxStock := maxOf(totals)
	for _, key := range econResourceOrder {
		p := recommendedPriceFromTotals(key, totals, maxStock)
		m := econDefaultMass[key]
		econData.Resources[key] = resourceOverride{Price: &p, Mass: &m}
	}
	seedShipModuleDefaultsLocked()
	saveEconomyLocked()
}

// seedShipModuleDefaultsLocked — заполняет econData.ShipModules заводскими
// значениями для любых ключей из shipModuleEnergyDefaults, которых там ещё
// нет (новый файл целиком, либо старый файл без вкладки «Энергия»). Не
// трогает уже сохранённые оверрайды администратора. Вызывающий держит econMu.
func seedShipModuleDefaultsLocked() {
	dirty := false
	for key, def := range shipModuleEnergyDefaults {
		if _, ok := econData.ShipModules[key]; ok {
			continue
		}
		gen, active, passive := def.Gen, def.Active, def.Passive
		econData.ShipModules[key] = shipModuleOverride{PowerGen: &gen, PowerActive: &active, PowerPassive: &passive}
		dirty = true
	}
	if dirty {
		saveEconomyLocked()
	}
}

func saveEconomyLocked() {
	b, err := json.MarshalIndent(econData, "", "  ")
	if err != nil {
		log.Printf("не удалось сериализовать economy_data.json: %v", err)
		return
	}
	if err := os.WriteFile(economyDataFile, b, 0644); err != nil {
		log.Printf("не удалось сохранить economy_data.json: %v", err)
	}
}

func resourcePrice(key string) float64 {
	econMu.RLock()
	defer econMu.RUnlock()
	if ov, ok := econData.Resources[key]; ok && ov.Price != nil {
		return *ov.Price
	}
	return recommendedPrice(key)
}

func resourceMass(key string) float64 {
	econMu.RLock()
	defer econMu.RUnlock()
	if ov, ok := econData.Resources[key]; ok && ov.Mass != nil {
		return *ov.Mass
	}
	return econDefaultMass[key]
}

// setResourceOverride — правка администратора: nil-поле оставляет прежнее
// значение (частичное обновление, {"key":"iron","price":50} не трогает массу).
func setResourceOverride(key string, price, mass *float64) error {
	if !isEconResource(key) {
		return fmt.Errorf("неизвестный ресурс: %s (нет в симуляции)", key)
	}
	econMu.Lock()
	defer econMu.Unlock()
	ov := econData.Resources[key]
	if price != nil {
		ov.Price = price
	}
	if mass != nil {
		ov.Mass = mass
	}
	econData.Resources[key] = ov
	saveEconomyLocked()
	return nil
}

func shipModulePowerGen(key string) float64 {
	econMu.RLock()
	defer econMu.RUnlock()
	if ov, ok := econData.ShipModules[key]; ok && ov.PowerGen != nil {
		return *ov.PowerGen
	}
	return shipModuleEnergyDefaults[key].Gen
}

func shipModulePowerActive(key string) float64 {
	econMu.RLock()
	defer econMu.RUnlock()
	if ov, ok := econData.ShipModules[key]; ok && ov.PowerActive != nil {
		return *ov.PowerActive
	}
	return shipModuleEnergyDefaults[key].Active
}

func shipModulePowerPassive(key string) float64 {
	econMu.RLock()
	defer econMu.RUnlock()
	if ov, ok := econData.ShipModules[key]; ok && ov.PowerPassive != nil {
		return *ov.PowerPassive
	}
	return shipModuleEnergyDefaults[key].Passive
}

// setShipModuleOverride — правка администратора: nil-поле оставляет прежнее
// значение, тем же принципом, что setResourceOverride.
func setShipModuleOverride(key string, powerGen, powerActive, powerPassive *float64) error {
	if !isShipModuleKey(key) {
		return fmt.Errorf("неизвестный модуль корабля: %s", key)
	}
	econMu.Lock()
	defer econMu.Unlock()
	ov := econData.ShipModules[key]
	if powerGen != nil {
		ov.PowerGen = powerGen
	}
	if powerActive != nil {
		ov.PowerActive = powerActive
	}
	if powerPassive != nil {
		ov.PowerPassive = powerPassive
	}
	econData.ShipModules[key] = ov
	saveEconomyLocked()
	return nil
}

// ── рецепты компонентов (ТЗ_Экономика.md §8.2/9.2/10.3, ВРЕМЕННО как есть) ──

type recipeInput struct {
	Key           string // ключ ресурса ИЛИ ключ другого компонента
	IsResource    bool
	Unimplemented bool    // metal_hydrogen/antimatter — нет в симуляции
	Qty           float64 // на цикл = партия 10 шт готового компонента
}

func ri(key string, qty float64) recipeInput {
	return recipeInput{Key: key, IsResource: true, Qty: qty}
}
func ci(key string, qty float64) recipeInput { return recipeInput{Key: key, Qty: qty} }
func ui(key string, qty float64) recipeInput {
	return recipeInput{Key: key, IsResource: true, Unimplemented: true, Qty: qty}
}

type componentRecipe struct {
	Key, Name, Factory string
	Tier               int
	Inputs             []recipeInput
}

var componentRecipes = []componentRecipe{
	// ── ТУ1 (I цикл), §8.2 — выход 10 шт за цикл ──────────────────────────
	{Key: "chem_reagents", Name: "Химические реагенты", Factory: "Химический завод", Tier: 1, Inputs: []recipeInput{
		ri("volcanicGases", 10), ri("inertGases", 4), ri("waterIce", 2),
	}},
	{Key: "metal_structs", Name: "Металлоконструкции", Factory: "Металлургический завод", Tier: 1, Inputs: []recipeInput{
		ri("iron", 8), ri("silicates", 6),
	}},
	{Key: "polymers", Name: "Полимеры", Factory: "Химический завод", Tier: 1, Inputs: []recipeInput{
		ri("bitumens", 9), ri("volcanicGases", 5), ri("waterIce", 3),
	}},
	// inertGases добавлен сверх ТЗ_Экономика.md §8.2 — защитная инертная атмосфера
	// вокруг контактов питания (от окисления/дугообразования). Правка по прямой
	// просьбе пользователя: инертные газы — редкий ресурс почти без применения,
	// power_cells используется почти везде (здания+корабль), даёт спросу разойтись.
	{Key: "power_cells", Name: "Элементы электропитания", Factory: "Электроинженерный завод", Tier: 1, Inputs: []recipeInput{
		ri("lightRare", 9), ri("platinoids", 6), ri("radioactives", 3), ri("inertGases", 3),
	}},
	{Key: "electronics", Name: "Электроника", Factory: "Электроинженерный завод", Tier: 1, Inputs: []recipeInput{
		ri("lightRare", 10), ri("platinoids", 5), ri("inertGases", 4),
	}},
	{Key: "solar_panels", Name: "Высокоэффективные солнечные панели", Factory: "Электроинженерный завод", Tier: 1, Inputs: []recipeInput{
		ri("lightRare", 8), ri("silicates", 7), ri("platinoids", 2),
	}},
	// Завод — Лаборатория передовых систем, не Электроинженерный, как в
	// ТЗ_Экономика.md §8.2 — перенесено по прямому указанию пользователя:
	// у Лаборатории по ТЗ §6.3 вообще нет ни одного рецепта ТУ1 («строится
	// сразу под ТУ2»), из-за чего она почти всегда простаивала — все её
	// ТУ2/ТУ3-рецепты делят платиноиды/радиоактивные с Электрозаводом, и
	// Роботы (ТУ3) висят на полимерах Химзавода. Научное оборудование даёт
	// Лаборатории гарантированную работу (не зависит от чужих заводов) и
	// разгружает Электрозавод — то же дефицитное сырьё (редкие/радиоакт./
	// инертные газы) больше не делится на 4 рецепта, только на 3.
	{Key: "sci_equipment", Name: "Научное оборудование", Factory: "Лаборатория передовых систем", Tier: 1, Inputs: []recipeInput{
		ri("lightRare", 9), ri("inertGases", 6), ri("radioactives", 2),
	}},

	// ── ТУ2 (II цикл), §9.2 ────────────────────────────────────────────────
	{Key: "servomechanisms", Name: "Сервомеханизмы", Factory: "Металлургический завод", Tier: 2, Inputs: []recipeInput{
		ci("metal_structs", 9), ci("polymers", 5), ci("electronics", 2),
	}},
	// inertGases добавлен сверх ТЗ_Экономика.md §9.2 — газовая диэлектрическая
	// изоляция высоковольтной проводки (по аналогии с SF6 в реальных
	// газонаполненных кабелях/выключателях). Та же правка, что у power_cells выше.
	{Key: "cabling", Name: "Кабельная продукция", Factory: "Металлургический завод", Tier: 2, Inputs: []recipeInput{
		ri("lightRare", 10), ci("polymers", 6), ri("iron", 5), ri("inertGases", 4),
	}},
	{Key: "industrial_equipment", Name: "Промышленное оборудование", Factory: "Металлургический завод", Tier: 2, Inputs: []recipeInput{
		ci("metal_structs", 10), ri("iron", 9), ri("refractory", 6),
	}},
	// carbonates добавлен сверх ТЗ_Экономика.md §9.2 — металлургический флюс
	// (известняк/карбонаты выводят примеси при плавке сплава, реальная химия
	// металлургии). Правка по прямой просьбе пользователя: неорганические
	// карбонаты почти не задействованы в производстве, только в питании.
	{Key: "high_alloys", Name: "Высококачественные сплавы", Factory: "Лаборатория передовых систем", Tier: 2, Inputs: []recipeInput{
		ri("refractory", 9), ri("lightRare", 5), ci("metal_structs", 5), ri("platinoids", 2), ri("carbonates", 6),
	}},
	{Key: "nuclear_components", Name: "Ядерные компоненты", Factory: "Лаборатория передовых систем", Tier: 2, Inputs: []recipeInput{
		ri("radioactives", 10), ri("refractory", 9), ci("electronics", 6), ri("helium3", 5),
	}},
	{Key: "weapons", Name: "Оружие и боеприпасы", Factory: "Электроинженерный завод", Tier: 2, Inputs: []recipeInput{
		ci("metal_structs", 10), ci("chem_reagents", 6), ri("radioactives", 2),
	}},
	{Key: "microelectronics", Name: "Микроэлектроника", Factory: "Электроинженерный завод", Tier: 2, Inputs: []recipeInput{
		ci("electronics", 10), ri("lightRare", 9), ri("inertGases", 5),
	}},
	{Key: "biosynthetics", Name: "Биосинтетика", Factory: "Химический завод", Tier: 2, Inputs: []recipeInput{
		ri("biomass", 10), ri("waterIce", 6), ri("phosphates", 5), ri("carbonates", 2),
	}},

	// ── ТУ3 (III цикл), §10.3 ──────────────────────────────────────────────
	// Завод — Электроинженерный, не Лаборатория передовых систем, как в
	// ТЗ_Экономика.md §10.3 — перенесено по прямому указанию пользователя
	// (та же правка, что у Научного оборудования выше, в обратную сторону):
	// разгружает Лабораторию, у которой теперь и так есть гарантированная
	// работа (Научное оборудование), и логично садится рядом с Электроникой
	// — тем же заводом, что производит 6 из 10 требуемых Электроники на цикл.
	{Key: "robots", Name: "Роботы", Factory: "Электроинженерный завод", Tier: 3, Inputs: []recipeInput{
		ci("industrial_equipment", 10), ci("electronics", 6), ci("polymers", 5),
	}},
	{Key: "nanocomposites", Name: "Наноструктурные композиты", Factory: "Металлургический завод", Tier: 3, Inputs: []recipeInput{
		ci("metal_structs", 10), ci("polymers", 10), ci("high_alloys", 6),
	}},
	{Key: "bioengineered", Name: "Биоинженерная продукция", Factory: "Химический завод", Tier: 3, Inputs: []recipeInput{
		ci("biosynthetics", 10), ri("phosphates", 6), ci("microelectronics", 5),
	}},
	{Key: "antigrav_units", Name: "Антигравитационные установки", Factory: "Лаборатория передовых систем", Tier: 3, Inputs: []recipeInput{
		ci("high_alloys", 10), ci("power_cells", 10), ri("metal_hydrogen", 2),
	}},
	{Key: "quantum_computers", Name: "Квантовые вычислители", Factory: "Электроинженерный завод", Tier: 3, Inputs: []recipeInput{
		ci("microelectronics", 10), ri("platinoids", 10), ri("metal_hydrogen", 2),
	}},
	{Key: "annihilation_charges", Name: "Аннигиляционные заряды", Factory: "Лаборатория передовых систем", Tier: 3, Inputs: []recipeInput{
		ci("weapons", 10), ci("nanocomposites", 6), ui("antimatter", 2),
	}},
}

func recipeByKey(key string) (componentRecipe, bool) {
	for _, r := range componentRecipes {
		if r.Key == key {
			return r, true
		}
	}
	return componentRecipe{}, false
}

// ── переработка излишков (НОВОЕ, вне ТЗ_Экономика.md — по прямому требованию
// пользователя): вместо СЫРЬЁ→КОМПОНЕНТ (componentRecipes выше) — СЫРЬЁ→ДРУГОЕ
// СЫРЬЁ, специально чтобы девать избыток (Силикаты/Карбонаты — на реальных
// колониях этой сессии скапливаются тысячами) в дефицит (Битумы — хронически
// пуст, душит Полимеры, см. CLAUDE.md/production.go). Тот же struct
// componentRecipe переиспользован как есть (Key/Inputs работают идентично —
// Stock не различает сырьё и компоненты) — Factory = "Завод переработки"
// (buildingCostByType[BuildingRecycler] ниже), Tier здесь — СВОЯ нумерация
// приоритета переработки (дешёвая/дорогая), НЕ уровень ТУ componentRecipes,
// хотя пользователь и назвал её теми же словами «ТУ1/ТУ2/ТУ3». Обработка —
// production.go recycleHour, отдельно от produceHour/pickRecipeToProduce
// (иной темп — раз в 2 часа, а не в 1, и фиксированный приоритет 1→2→3, а не
// «минимум по разнообразию» обычного производства — рецепт 1 почти всегда
// по карману, поэтому 2/3 включаются, только когда у рецепта 1 кончилось
// сырьё). Все количества согласованы с пользователем построчно.
var recyclingRecipes = []componentRecipe{
	// Рецепт 1 — дешёвый, основной: закрывает дефицит Битумов повседневным
	// излишком. Пропорция НЕ равная (20/20/20, как было в первом черновике) —
	// по требованию пользователя приближена к реальной химии: Битумы —
	// тяжёлые углеводороды, почти целиком углерод (Карбонаты — буквальный
	// источник углерода) с добавкой уже готовых C-H связей (Дикая биомасса —
	// органика); Силикаты (SiO2) к самим углеводородам не имеют отношения —
	// оставлены в мизерном количестве как «катализатор/подложка» (силикагель
	// реально используют носителем катализатора в синтезе Фишера-Тропша, той
	// же природы процесс). Пропорция 5:25:125 — геометрическая прогрессия
	// ×5, продиктована пользователем построчно. Энергия (5/партия, все 3
	// рецепта одинаково) — НЕ recipeInput (склад её не хранит), считается
	// отдельно в recycleHour.
	{Key: "bitumens", Name: "Переработка: Битумы", Factory: "Завод переработки", Tier: 1, Inputs: []recipeInput{
		ri("silicates", 5), ri("carbonates", 25), ri("biomass", 125),
	}},
	// Рецепт 2 — низкорентабельный: 1000 силикатов + 50 химреагентов (ровно
	// 10:5 к выходу, по требованию пользователя) почти ни во что не
	// превращаются (5 шт. вместо обычной партии в 10) — по требованию
	// пользователя должен быть ХУЖЕ гипотетического импорта извне, чтобы не
	// стать основной стратегией.
	{Key: "lightRare", Name: "Переработка: Лёгкие редкие металлы", Factory: "Завод переработки", Tier: 2, Inputs: []recipeInput{
		ri("silicates", 1000), ci("chem_reagents", 50),
	}},
	// Рецепт 3 — ещё дороже (2000 силикатов, по требованию пользователя, было
	// 1500), ещё скромнее выход: самый ценный металл в игре (platinoids —
	// самая низкая Rarity среди catMetals, planets.go).
	{Key: "platinoids", Name: "Переработка: Платиноиды", Factory: "Завод переработки", Tier: 3, Inputs: []recipeInput{
		ri("silicates", 2000), ri("carbonates", 500), ci("chem_reagents", 100),
	}},
}

// recyclingBatchOutput — сколько единиц даёт одна партия переработки; ниже
// обычных 10 у ТУ2/ТУ3 намеренно («по немножку», решение пользователя) —
// весь смысл рецепта в том, что 1000+ сырья превращаются в жалкую горстку.
func recyclingBatchOutput(tier int) float64 {
	switch tier {
	case 1:
		return 10
	case 2:
		return 5
	default:
		return 2
	}
}

// ── стоимость построек (ТЗ_Экономика.md §13/§15, ВРЕМЕННО как есть) ────────
// Ровно 21 запись — все BuildingType из buildings.go, 1:1 (включая
// «Атомную станцию» и «Завод переработки» — раньше не входили, у них не
// было BuildingType, теперь есть, см. buildings.go/production.go). «Луч
// смерти» сюда не входит — это
// уникальная постройка Станции-корабля (ТЗ_Корабль.md §7), не здание
// колонии, у него нет BuildingType.

type buildingCostDef struct {
	BType        BuildingType
	Name         string
	Level        int
	BuildDays    float64
	LimitingName string
	Inputs       []recipeInput
}

var buildingCosts = []buildingCostDef{
	{BType: BuildingMine, Name: "Горнодобывающая шахта", Level: 1, BuildDays: 1, LimitingName: "Электроника", Inputs: []recipeInput{
		ci("metal_structs", 200), ri("iron", 100), ri("silicates", 100), ci("polymers", 40), ci("electronics", 20),
	}},
	{BType: BuildingAtmoCollector, Name: "Атмосферный собиратель", Level: 1, BuildDays: 1, LimitingName: "Электроника", Inputs: []recipeInput{
		ci("metal_structs", 180), ci("polymers", 60), ci("chem_reagents", 60), ri("lightRare", 20), ci("electronics", 20),
	}},
	{BType: BuildingBioExtractor, Name: "Биоэкстрактор", Level: 1, BuildDays: 1, LimitingName: "Электроника", Inputs: []recipeInput{
		ci("metal_structs", 150), ci("polymers", 50), ci("chem_reagents", 50), ri("waterIce", 100), ci("electronics", 20),
	}},
	{BType: BuildingHydroFarm, Name: "Гидроминеральная ферма", Level: 1, BuildDays: 1, LimitingName: "Элементы электропитания", Inputs: []recipeInput{
		ci("polymers", 120), ci("metal_structs", 80), ci("chem_reagents", 40), ri("bitumens", 50), ri("waterIce", 100), ci("power_cells", 10),
	}},
	// carbonates добавлен сверх ТЗ_Экономика.md §13 — строительный минерал
	// (известняк/бетон в основе стройматериалов, наравне с уже используемыми
	// здесь силикатами). Та же правка, что у high_alloys выше.
	{BType: BuildingHousing, Name: "Жилой модуль", Level: 1, BuildDays: 1, LimitingName: "Электроника", Inputs: []recipeInput{
		ri("silicates", 300), ri("carbonates", 80), ci("metal_structs", 100), ci("polymers", 60), ci("electronics", 20), ci("cabling", 10),
	}},
	{BType: BuildingSolarPanel, Name: "Солнечная панель", Level: 1, BuildDays: 1, LimitingName: "Солнечные панели (компонент)", Inputs: []recipeInput{
		ri("silicates", 200), ci("solar_panels", 50), ci("polymers", 40), ci("metal_structs", 50), ci("electronics", 10),
	}},
	{BType: BuildingBattery, Name: "Планетарная батарея", Level: 1, BuildDays: 1, LimitingName: "Оружие и боеприпасы", Inputs: []recipeInput{
		ci("metal_structs", 150), ri("refractory", 60), ci("weapons", 20), ci("electronics", 10), ci("cabling", 10),
	}},
	{BType: BuildingFort, Name: "Форт-казарма", Level: 1, BuildDays: 1, LimitingName: "Оружие и боеприпасы", Inputs: []recipeInput{
		ci("metal_structs", 120), ci("polymers", 50), ci("weapons", 20), ci("electronics", 10), ci("power_cells", 5),
	}},
	{BType: BuildingFactoryMetal, Name: "Металлургический завод", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("metal_structs", 50), ci("high_alloys", 10), ci("cabling", 10), ci("microelectronics", 4),
	}},
	{BType: BuildingFactoryChem, Name: "Химический завод", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("chem_reagents", 80), ci("polymers", 30), ci("cabling", 10), ci("microelectronics", 4),
	}},
	{BType: BuildingFactoryElec, Name: "Электроинженерный завод", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("electronics", 40), ci("cabling", 20), ci("power_cells", 10), ci("microelectronics", 4),
	}},
	{BType: BuildingLab, Name: "Лаборатория передовых систем", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("high_alloys", 15), ci("microelectronics", 4), ci("sci_equipment", 5), ci("power_cells", 5),
	}},
	{BType: BuildingShipyard, Name: "Верфь", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("metal_structs", 60), ci("high_alloys", 10), ci("cabling", 15), ci("electronics", 10), ci("microelectronics", 4),
	}},
	{BType: BuildingAdvComponents, Name: "Завод улучшенных компонентов", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("high_alloys", 15), ci("microelectronics", 4), ci("electronics", 20), ci("cabling", 10),
	}},
	{BType: BuildingH2Generator, Name: "Водородный генератор", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 15), ci("metal_structs", 50), ci("cabling", 15), ci("electronics", 10), ci("microelectronics", 4),
	}},
	{BType: BuildingRadio, Name: "Радиостанция", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 15), ci("electronics", 30), ci("cabling", 15), ci("sci_equipment", 5), ci("microelectronics", 4),
	}},
	{BType: BuildingScienceCenter, Name: "Научный центр", Level: 3, BuildDays: 3.5, LimitingName: "Научное оборудование", Inputs: []recipeInput{
		ci("nanocomposites", 10), ci("sci_equipment", 70), ci("microelectronics", 5), ci("power_cells", 10), ci("high_alloys", 10),
	}},
	{BType: BuildingCryptoFarm, Name: "Криптоферма", Level: 3, BuildDays: 3.5, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("nanocomposites", 10), ci("microelectronics", 7), ci("cabling", 10), ci("power_cells", 5), ci("high_alloys", 5),
	}},
	{BType: BuildingTransportNode, Name: "Транспортный узел", Level: 1, BuildDays: 1, LimitingName: "Электроника", Inputs: []recipeInput{
		ci("metal_structs", 100), ri("silicates", 80), ci("polymers", 30), ci("electronics", 20),
	}},
	{BType: BuildingNuclearPlant, Name: "Атомная станция", Level: 3, BuildDays: 3.5, LimitingName: "Ядерные компоненты", Inputs: []recipeInput{
		ci("nanocomposites", 10), ci("nuclear_components", 14), ci("high_alloys", 10), ci("microelectronics", 4), ci("power_cells", 10),
	}},
	// Завод переработки — стоимость постройки САМОСТОЯТЕЛЬНО придумана (вне
	// ТЗ_Экономика.md, здание новое), по образцу других ТУ2-заводов ниже.
	{BType: BuildingRecycler, Name: "Завод переработки", Level: 2, BuildDays: 2, LimitingName: "Микроэлектроника", Inputs: []recipeInput{
		ci("industrial_equipment", 20), ci("metal_structs", 60), ci("high_alloys", 5), ci("cabling", 10), ci("microelectronics", 4),
	}},
}

// buildingCostByType — тот же список buildingCosts, только по ключу
// BuildingType, для быстрого поиска. Нужен refundBuilding (production.go —
// демонтаж здания при нехватке содержания возвращает 60% этого рецепта).
var buildingCostByType = func() map[BuildingType]buildingCostDef {
	m := make(map[BuildingType]buildingCostDef, len(buildingCosts))
	for _, b := range buildingCosts {
		m[b.BType] = b
	}
	return m
}()

// ── корабль: каркас, броня, модули, оружие (ТЗ_Корабль.md — ТЕОРИЯ, в игровую
// механику постройки/боя не заведена; перенесено в экономику по прямой просьбе
// пользователя — «увидеть какие ресурсы каким спросом пользуются» наравне со
// зданиями и компонентами). В отличие от componentRecipes/buildingCosts — здесь
// принципиально нет сырья (только готовые компоненты, ТЗ_Корабль.md §4) и нет
// деления на партии по 10: один рецепт = один экземпляр (палуба/модуль/орудие).
type shipItemCategory string

const (
	shipCatFrame   shipItemCategory = "frame"
	shipCatArmor   shipItemCategory = "armor"
	shipCatModule  shipItemCategory = "module"
	shipCatWeapon  shipItemCategory = "weapon"
	shipCatStation shipItemCategory = "station" // уникальные постройки Станции (ТЗ_Корабль.md §8)
)

type shipItemCost struct {
	Key      string
	Name     string
	Category shipItemCategory
	Inputs   []recipeInput
	// Multiplier — явный ценовой коэффициент поверх физического рецепта (1
	// если не задан). Формула, не подгонка: recipe остаётся «сколько сырья
	// реально ушло» (масса/спрос считаются от него как обычно), а Multiplier —
	// отдельная объявленная надбавка (редкость технологии, премия за спрос и
	// т.п.), применяется только к стоимости в кредитах, не к массе/спросу.
	Multiplier float64
}

func (s shipItemCost) mult() float64 {
	if s.Multiplier == 0 {
		return 1
	}
	return s.Multiplier
}

var shipItemCosts = []shipItemCost{
	{Key: "ship_frame", Name: "Каркас (палуба)", Category: shipCatFrame, Inputs: []recipeInput{
		ci("metal_structs", 100), ci("high_alloys", 13), ci("industrial_equipment", 10),
		ci("servomechanisms", 5), ci("cabling", 7), ci("electronics", 3),
	}},
	{Key: "ship_armor", Name: "Бронирование палубы", Category: shipCatArmor, Multiplier: 2, Inputs: []recipeInput{
		ci("high_alloys", 15), ci("metal_structs", 10), ci("industrial_equipment", 3),
	}},

	{Key: "ship_life_support", Name: "Система жизнеобеспечения", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 5), ci("industrial_equipment", 2), ci("biosynthetics", 4), ci("bioengineered", 2), ci("power_cells", 2),
	}},
	{Key: "ship_colonist", Name: "Колониальный модуль", Category: shipCatModule, Multiplier: 2, Inputs: []recipeInput{
		ci("metal_structs", 8), ci("industrial_equipment", 3), ci("biosynthetics", 3), ci("power_cells", 2),
	}},
	{Key: "ship_weapon_mount", Name: "Оружейный модуль (хардпоинт)", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 6), ci("high_alloys", 3), ci("industrial_equipment", 2), ci("weapons", 2),
	}},
	{Key: "ship_solar_sail", Name: "Солнечный парус", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 5), ci("high_alloys", 3), ci("industrial_equipment", 2), ci("servomechanisms", 3),
	}},
	{Key: "ship_engine", Name: "Двигатель", Category: shipCatModule, Inputs: []recipeInput{
		ci("high_alloys", 6), ci("industrial_equipment", 4), ci("metal_structs", 5), ci("power_cells", 3), ci("cabling", 2),
	}},
	// Ионный двигатель — второй тип двигателя, альтернатива ship_engine (та же
	// роль, ТЗ_Корабль.md §4.5), но технологичнее и дороже. Антигравитационные
	// установки (ТУ3) — НЕ фиксированное количество, как и Квантовые
	// вычислители у Телепорт-модуля: считается формулой ionEnginePriceMultiple
	// (см. buildIonEngineItem), чтобы итог держался ровно ×5 от цены обычного
	// ship_engine при любых живых ценах, а не разъезжался при правке цен ТУ3.
	{Key: "ship_engine_ion", Name: "Ионный двигатель", Category: shipCatModule, Inputs: []recipeInput{
		ci("high_alloys", 8), ci("industrial_equipment", 5), ci("metal_structs", 4), ci("power_cells", 4), ci("cabling", 3),
	}},
	{Key: "ship_reactor", Name: "Атомный реактор", Category: shipCatModule, Inputs: []recipeInput{
		ci("nuclear_components", 5), ci("high_alloys", 4), ci("industrial_equipment", 3), ci("metal_structs", 4), ci("cabling", 3),
	}},
	{Key: "ship_gas_storage", Name: "Газохранилище", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 10), ci("high_alloys", 4), ci("industrial_equipment", 3),
	}},
	{Key: "ship_battery", Name: "Аккумуляторы", Category: shipCatModule, Inputs: []recipeInput{
		ci("power_cells", 8), ci("metal_structs", 4), ci("industrial_equipment", 2), ci("cabling", 3),
	}},
	{Key: "ship_repair", Name: "Ремонтный модуль", Category: shipCatModule, Inputs: []recipeInput{
		ci("robots", 2), ci("industrial_equipment", 4), ci("metal_structs", 5), ci("microelectronics", 2),
	}},
	{Key: "ship_solar_panel", Name: "Солнечная панель", Category: shipCatModule, Inputs: []recipeInput{
		ci("solar_panels", 4), ci("metal_structs", 3), ci("industrial_equipment", 2),
	}},
	// Квантовые вычислители — НЕ здесь: количество вычисляется формулой
	// (teleportPriceMultiple × средняя цена остальных модулей), не константой,
	// см. economySnapshot(). Это единственный рецепт, где ci() недостаточно.
	{Key: "ship_teleport", Name: "Телепорт-модуль", Category: shipCatModule, Inputs: []recipeInput{
		ci("nanocomposites", 6), ci("nuclear_components", 2), ci("high_alloys", 2), ci("cabling", 4), ci("industrial_equipment", 2),
	}},
	{Key: "ship_miner", Name: "Шахтёр", Category: shipCatModule, Inputs: []recipeInput{
		ci("industrial_equipment", 5), ci("robots", 1), ci("metal_structs", 5), ci("high_alloys", 2),
	}},
	{Key: "ship_radar", Name: "Радар", Category: shipCatModule, Inputs: []recipeInput{
		ci("electronics", 4), ci("microelectronics", 2), ci("sci_equipment", 2), ci("metal_structs", 2), ci("industrial_equipment", 2),
	}},
	{Key: "ship_ecm", Name: "Модуль РЭБ", Category: shipCatModule, Multiplier: 2, Inputs: []recipeInput{
		ci("microelectronics", 5), ci("electronics", 3), ci("quantum_computers", 1), ci("metal_structs", 2), ci("industrial_equipment", 2), ci("cabling", 3),
	}},
	{Key: "ship_computer", Name: "Вычислительный модуль", Category: shipCatModule, Inputs: []recipeInput{
		ci("quantum_computers", 3), ci("microelectronics", 4), ci("metal_structs", 2), ci("industrial_equipment", 2), ci("cabling", 3),
	}},
	{Key: "ship_shield", Name: "Защитное поле", Category: shipCatModule, Multiplier: 2, Inputs: []recipeInput{
		ci("electronics", 3), ci("power_cells", 4), ci("high_alloys", 3), ci("industrial_equipment", 2), ci("cabling", 3),
	}},
	{Key: "ship_dock", Name: "Стыковочный док", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 10), ci("high_alloys", 2), ci("industrial_equipment", 3), ci("servomechanisms", 2),
	}},
	{Key: "ship_hangar", Name: "Ангар", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 12), ci("high_alloys", 2), ci("industrial_equipment", 4), ci("servomechanisms", 3),
	}},
	{Key: "ship_cargo", Name: "Грузовой отсек", Category: shipCatModule, Inputs: []recipeInput{
		ci("metal_structs", 10), ci("industrial_equipment", 2), ci("servomechanisms", 1),
	}},

	// ── оружие — устанавливается в ship_weapon_mount, цена сверх хардпоинта ──
	{Key: "weapon_autocannon", Name: "Автопушка", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("weapons", 1),
	}},
	{Key: "weapon_railgun", Name: "Рельсотрон", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("weapons", 3),
	}},
	{Key: "weapon_laser", Name: "Лазер", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("weapons", 1), ci("electronics", 2), ci("power_cells", 2),
	}},
	{Key: "weapon_plasma", Name: "Плазмапушка", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("weapons", 1), ci("power_cells", 2), ci("cabling", 1),
	}},
	{Key: "weapon_missile", Name: "Ракеты", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("weapons", 4), ci("electronics", 1),
	}},
	{Key: "weapon_torpedo", Name: "Торпеды", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("weapons", 6), ci("electronics", 2),
	}},
	{Key: "weapon_emp", Name: "ЭМИ-пушка", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("microelectronics", 2), ci("power_cells", 2),
	}},
	{Key: "weapon_tractor", Name: "Луч захвата", Category: shipCatWeapon, Inputs: []recipeInput{
		ci("microelectronics", 1), ci("cabling", 2), ci("power_cells", 1),
	}},

	// ── уникальные постройки Станции (ТЗ_Корабль.md §8, 10 палуб каждая) ──────
	// Разовая постройка. Расход КАЖДОГО применения (топливо, не стройка) в код
	// не заведён — Портал жжёт антиматерию (ресурс не реализован в симуляции,
	// см. unimplementedMass), Ускоритель — «дорогие компоненты 3 ТУ» без точной
	// цифры (ТЗ_Корабль.md §9, открытый вопрос) — это расход по факту действия,
	// не разовая постройка, отдельная механика, которой сейчас в demand нет
	// (аналогично содержанию зданий, ТЗ_Экономика.md §14 — тоже не в demand).
	{Key: "ship_accelerator", Name: "Ускоритель (постройка Станции)", Category: shipCatStation, Inputs: []recipeInput{
		ci("industrial_equipment", 60), ci("metal_structs", 80), ci("high_alloys", 40),
		ci("robots", 5), ci("nanocomposites", 10), ci("power_cells", 20),
	}},
	{Key: "ship_portal", Name: "Портал (постройка Станции)", Category: shipCatStation, Inputs: []recipeInput{
		ci("industrial_equipment", 60), ci("metal_structs", 70), ci("high_alloys", 30),
		ci("quantum_computers", 15), ci("nanocomposites", 15), ci("nuclear_components", 10), ci("cabling", 30),
	}},
	// Ставится дополнительно к обычному рецепту КАЖДОГО планетарного здания,
	// построенного на Станции (§8.1) — компенсация невесомости. Antigrav_units
	// содержит нереализованный metal_hydrogen (Incomplete=true) — соответственно
	// и вся надстройка над зданием станции физически недостроима до появления
	// добычи металлического водорода, тем же образом, что и Портал с антиматерией.
	{Key: "ship_station_antigrav", Name: "Антигравитатор здания станции", Category: shipCatStation, Inputs: []recipeInput{
		ci("antigrav_units", 2), ci("high_alloys", 3), ci("industrial_equipment", 2),
	}},
	// Луч смерти — единственная из уникальных построек §8, доступная НЕ только
	// Станции: у Дредноута тоже хватает 21 палубы на эти 10 (ТЗ_Корабль.md §8.3).
	// Аннигиляционные заряды тянут за собой Incomplete (антиматерия) — планета
	// физически не превратится в голое ядро, пока антиматерия не добывается.
	{Key: "ship_death_ray", Name: "Луч смерти (постройка Станции/Дредноута)", Category: shipCatStation, Inputs: []recipeInput{
		ci("metal_structs", 60), ci("nanocomposites", 40), ci("annihilation_charges", 15),
		ci("nuclear_components", 20), ci("microelectronics", 15), ci("high_alloys", 25), ci("industrial_equipment", 50),
	}},
}

func shipItemByKey(key string) (shipItemCost, bool) {
	for _, s := range shipItemCosts {
		if s.Key == key {
			return s, true
		}
	}
	return shipItemCost{}, false
}

// ── резолвер: рекурсивно разворачивает компонент/здание до базовых ресурсов ─

type componentResolved struct {
	ValuePerUnit float64
	MassPerUnit  float64
	BaseTotals   map[string]float64 // ключ базового ресурса → кол-во на 1 шт компонента
	Incomplete   bool
}

// resolveComponent — масса 1 шт = (Σ qty×mass входов) × 0.8 / 10 (потери 20%
// при переделе, партия 10 шт, ТЗ_Экономика.md §8.3). Стоимость — без потерь
// (испорченное сырьё всё равно оплачено): (Σ qty×price входов) / 10.
// cache — память на вызов economySnapshot(), т.к. компоненты старших циклов
// повторно используют младшие (например, Аннигиляционные заряды тянут
// Наноструктурные композиты, которые сами уже ТУ3).
func resolveComponent(key string, cache map[string]componentResolved) componentResolved {
	if v, ok := cache[key]; ok {
		return v
	}
	rec, ok := recipeByKey(key)
	if !ok {
		return componentResolved{BaseTotals: map[string]float64{}}
	}
	totalValue, totalMassRaw := 0.0, 0.0
	base := map[string]float64{}
	incomplete := false
	for _, in := range rec.Inputs {
		switch {
		case in.Unimplemented:
			totalMassRaw += in.Qty * unimplementedMass[in.Key]
			base[in.Key] += in.Qty // спрос учитывается (табл. 5), стоимость — нет: цены у ресурса нет
			incomplete = true
		case in.IsResource:
			totalValue += in.Qty * resourcePrice(in.Key)
			totalMassRaw += in.Qty * resourceMass(in.Key)
			base[in.Key] += in.Qty
		default:
			sub := resolveComponent(in.Key, cache)
			totalValue += in.Qty * sub.ValuePerUnit
			totalMassRaw += in.Qty * sub.MassPerUnit
			for k, v := range sub.BaseTotals {
				base[k] += in.Qty * v
			}
			incomplete = incomplete || sub.Incomplete
		}
	}
	for k := range base {
		base[k] /= 10
	}
	res := componentResolved{
		ValuePerUnit: totalValue / 10,
		MassPerUnit:  totalMassRaw * 0.8 / 10,
		BaseTotals:   base,
		Incomplete:   incomplete,
	}
	cache[key] = res
	return res
}

// priceOf — цена ЛЮБОГО ключа склада (сырьё ИЛИ компонент, Stock их не
// различает) — по требованию пользователя очередь производства теперь
// сортируется «что как можно выше по цене» по НАСТОЯЩЕЙ рассчитанной цене
// (этот резолвер), а не по номеру ТУ рецепта, как раньше (production.go,
// buildQueueForRecipes). cache — тот же кеш, что resolveComponent, чтобы
// повторные вызовы в пределах одного пересчёта очереди не разворачивали
// вложенные компоненты заново.
func priceOf(key string, cache map[string]componentResolved) float64 {
	if _, ok := recipeByKey(key); ok {
		return resolveComponent(key, cache).ValuePerUnit
	}
	return resourcePrice(key)
}

type buildingResolved struct {
	TotalValue float64
	TotalMass  float64
	BaseTotals map[string]float64 // на 1 здание целиком (не партия)
	Incomplete bool
}

// resolveBuilding — сумма входов здания, без дополнительного коэффициента
// потерь (в ТЗ для сборки самого здания такого коэффициента нет, только для
// цикла завода — resolveComponent).
func resolveBuilding(b buildingCostDef, cache map[string]componentResolved) buildingResolved {
	totalValue, totalMass := 0.0, 0.0
	base := map[string]float64{}
	incomplete := false
	for _, in := range b.Inputs {
		switch {
		case in.Unimplemented:
			totalMass += in.Qty * unimplementedMass[in.Key]
			base[in.Key] += in.Qty
			incomplete = true
		case in.IsResource:
			totalValue += in.Qty * resourcePrice(in.Key)
			totalMass += in.Qty * resourceMass(in.Key)
			base[in.Key] += in.Qty
		default:
			sub := resolveComponent(in.Key, cache)
			totalValue += in.Qty * sub.ValuePerUnit
			totalMass += in.Qty * sub.MassPerUnit
			for k, v := range sub.BaseTotals {
				base[k] += in.Qty * v
			}
			incomplete = incomplete || sub.Incomplete
		}
	}
	return buildingResolved{TotalValue: totalValue, TotalMass: totalMass, BaseTotals: base, Incomplete: incomplete}
}

// resolveShipItem — палуба/броня/модуль/оружие (ТЗ_Корабль.md): тот же принцип,
// что и resolveBuilding (без коэффициента потерь, без деления на партию — один
// рецепт = один экземпляр). Ветка IsResource оставлена на случай будущей правки
// рецептуры кораблей сырьём — сейчас ни один shipItemCosts.Inputs её не задействует.
func resolveShipItem(s shipItemCost, cache map[string]componentResolved) buildingResolved {
	totalValue, totalMass := 0.0, 0.0
	base := map[string]float64{}
	incomplete := false
	for _, in := range s.Inputs {
		switch {
		case in.Unimplemented:
			totalMass += in.Qty * unimplementedMass[in.Key]
			base[in.Key] += in.Qty
			incomplete = true
		case in.IsResource:
			totalValue += in.Qty * resourcePrice(in.Key)
			totalMass += in.Qty * resourceMass(in.Key)
			base[in.Key] += in.Qty
		default:
			sub := resolveComponent(in.Key, cache)
			totalValue += in.Qty * sub.ValuePerUnit
			totalMass += in.Qty * sub.MassPerUnit
			for k, v := range sub.BaseTotals {
				base[k] += in.Qty * v
			}
			incomplete = incomplete || sub.Incomplete
		}
	}
	return buildingResolved{TotalValue: totalValue * s.mult(), TotalMass: totalMass, BaseTotals: base, Incomplete: incomplete}
}

// teleportPriceMultiple — правило пользователя буквально: «итоговая цена
// [телепорт-модуля] должна быть в пять раз дороже средней цены модулей».
// Единственное объявленное число во всей формуле — меняется здесь и нигде
// больше.
const teleportPriceMultiple = 5.0

// buildTeleportItem — количество Квантовых вычислителей в телепорт-модуле не
// константа (как раньше — руками подобранная под сегодняшние цены и обречённая
// разъехаться при следующей правке цены ресурса), а обратная формула: сколько
// вычислителей нужно докупить сверх остальных компонентов (teleportBase), чтобы
// итог сравнялся с teleportPriceMultiple × средняя цена ВСЕХ ОСТАЛЬНЫХ модулей
// (otherModuleValues). Пересчитывается на каждый запрос — 5× держится всегда,
// а не только в момент, когда это было проверено вручную.
func buildTeleportItem(def shipItemCost, base buildingResolved, otherModuleValues []float64, cache map[string]componentResolved, demand map[string]float64) economyShipItemView {
	avg := 0.0
	if len(otherModuleValues) > 0 {
		sum := 0.0
		for _, v := range otherModuleValues {
			sum += v
		}
		avg = sum / float64(len(otherModuleValues))
	}
	qc := resolveComponent("quantum_computers", cache)
	qcQty := 0.0
	if qc.ValuePerUnit > 0 {
		qcQty = (avg*teleportPriceMultiple - base.TotalValue) / qc.ValuePerUnit
		if qcQty < 0 {
			qcQty = 0
		}
	}

	totalValue := base.TotalValue + qcQty*qc.ValuePerUnit
	totalMass := base.TotalMass + qcQty*qc.MassPerUnit
	baseTotals := make(map[string]float64, len(base.BaseTotals)+len(qc.BaseTotals))
	for k, v := range base.BaseTotals {
		baseTotals[k] = v
	}
	for k, v := range qc.BaseTotals {
		baseTotals[k] += qcQty * v
	}
	for k, v := range baseTotals {
		demand[k] += v
	}

	inputs := append([]recipeInput{}, def.Inputs...)
	inputs = append(inputs, recipeInput{Key: "quantum_computers", Qty: qcQty})

	return economyShipItemView{
		Key: def.Key, Name: def.Name, Category: string(def.Category),
		Inputs: inputViews(inputs), TotalValue: totalValue, TotalMass: totalMass,
		BaseTotals: baseTotals, Incomplete: base.Incomplete || qc.Incomplete,
	}
}

// ionEnginePriceMultiple — правило пользователя буквально: «по итоговой цене
// должен быть в 5 раз примерно дороже обычного [двигателя]». Тот же приём,
// что teleportPriceMultiple: единственное объявленное число, меняется здесь
// и нигде больше.
const ionEnginePriceMultiple = 5.0

// buildIonEngineItem — количество Антигравитационных установок в Ионном
// двигателе не константа, а обратная формула (см. buildTeleportItem —
// идентичный приём): сколько установок нужно докупить сверх остальных
// фиксированных компонентов (base), чтобы итог сравнялся с
// ionEnginePriceMultiple × цена ОБЫЧНОГО ship_engine (enginePrice).
// Пересчитывается на каждый запрос — 5× держится всегда, а не только в
// момент, когда это было проверено вручную.
func buildIonEngineItem(def shipItemCost, base buildingResolved, enginePrice float64, cache map[string]componentResolved, demand map[string]float64) economyShipItemView {
	au := resolveComponent("antigrav_units", cache)
	auQty := 0.0
	if au.ValuePerUnit > 0 {
		auQty = (enginePrice*ionEnginePriceMultiple - base.TotalValue) / au.ValuePerUnit
		if auQty < 0 {
			auQty = 0
		}
	}

	totalValue := base.TotalValue + auQty*au.ValuePerUnit
	totalMass := base.TotalMass + auQty*au.MassPerUnit
	baseTotals := make(map[string]float64, len(base.BaseTotals)+len(au.BaseTotals))
	for k, v := range base.BaseTotals {
		baseTotals[k] = v
	}
	for k, v := range au.BaseTotals {
		baseTotals[k] += auQty * v
	}
	for k, v := range baseTotals {
		demand[k] += v
	}

	inputs := append([]recipeInput{}, def.Inputs...)
	inputs = append(inputs, recipeInput{Key: "antigrav_units", Qty: auQty})

	return economyShipItemView{
		Key: def.Key, Name: def.Name, Category: string(def.Category),
		Inputs: inputViews(inputs), TotalValue: totalValue, TotalMass: totalMass,
		BaseTotals: baseTotals, Incomplete: base.Incomplete || au.Incomplete,
	}
}

func inputDisplayName(in recipeInput) string {
	if in.Unimplemented {
		if n, ok := unimplementedName[in.Key]; ok {
			return n
		}
		return in.Key
	}
	if in.IsResource {
		if rd, ok := resourceDefByKey(in.Key); ok {
			return rd.Name
		}
		return in.Key
	}
	if rec, ok := recipeByKey(in.Key); ok {
		return rec.Name
	}
	return in.Key
}

// ── API-снимок ───────────────────────────────────────────────────────────

type economyResourceView struct {
	Key              string  `json:"key"`
	Name             string  `json:"name"`
	Rarity           float64 `json:"rarity"`
	DefaultMass      float64 `json:"defaultMass"`
	Mass             float64 `json:"mass"`
	RecommendedPrice float64 `json:"recommendedPrice"`
	Price            float64 `json:"price"`
}

type economyInputView struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	IsResource    bool    `json:"isResource"`
	Unimplemented bool    `json:"unimplemented"`
	Qty           float64 `json:"qty"`
}

type economyRecipeView struct {
	Key          string             `json:"key"`
	Name         string             `json:"name"`
	Tier         int                `json:"tier"`
	Factory      string             `json:"factory"`
	Inputs       []economyInputView `json:"inputs"`
	ValuePerUnit float64            `json:"valuePerUnit"`
	MassPerUnit  float64            `json:"massPerUnit"`
	BaseTotals   map[string]float64 `json:"baseTotals"`
	Incomplete   bool               `json:"incomplete"`
}

type economyBuildingView struct {
	Type         BuildingType       `json:"type"`
	Name         string             `json:"name"`
	Level        int                `json:"level"`
	BuildDays    float64            `json:"buildDays"`
	LimitingName string             `json:"limitingName"`
	Inputs       []economyInputView `json:"inputs"`
	TotalValue   float64            `json:"totalValue"`
	TotalMass    float64            `json:"totalMass"`
	BaseTotals   map[string]float64 `json:"baseTotals"`
	Incomplete   bool               `json:"incomplete"`
}

type economyShipItemView struct {
	Key        string             `json:"key"`
	Name       string             `json:"name"`
	Category   string             `json:"category"` // frame | armor | module | weapon
	Inputs     []economyInputView `json:"inputs"`
	TotalValue float64            `json:"totalValue"`
	TotalMass  float64            `json:"totalMass"`
	BaseTotals map[string]float64 `json:"baseTotals"`
	Incomplete bool               `json:"incomplete"`
}

type economyShipView struct {
	Status string                `json:"status"`
	Note   string                `json:"note"`
	Items  []economyShipItemView `json:"items"`
}

type economySnapshotResponse struct {
	Resources        []economyResourceView         `json:"resources"`
	Recipes          []economyRecipeView           `json:"recipes"`
	Buildings        []economyBuildingView         `json:"buildings"`
	Demand           map[string]float64            `json:"demand"`          // базовые ресурсы, по всей цепочке (см. ниже)
	ComponentDemand  map[string]float64            `json:"componentDemand"` // компоненты (все 21, все ТУ), см. componentDemandTotals
	ShipComponents   economyShipView               `json:"shipComponents"`
	ShipModuleEnergy []economyShipModuleEnergyView `json:"shipModuleEnergy"`
}

// economyShipModuleEnergyView — вкладка «ЭНЕРГИЯ» client/economy.html:
// редактируемые выработка/активное(пик)/пассивное(постоянное) потребление 20
// модулей корабля (client/ship-deck-sectors.html читает эти значения вместо
// своего прежнего хардкода). Default* — заводские значения (ТЗ_Корабль.md
// §4.20), чтобы UI мог показать кнопку «сбросить», как у цены ресурса.
type economyShipModuleEnergyView struct {
	Key                 string  `json:"key"`
	Name                string  `json:"name"`
	PowerGen            float64 `json:"powerGen"`
	PowerActive         float64 `json:"powerActive"`
	PowerPassive        float64 `json:"powerPassive"`
	DefaultPowerGen     float64 `json:"defaultPowerGen"`
	DefaultPowerActive  float64 `json:"defaultPowerActive"`
	DefaultPowerPassive float64 `json:"defaultPowerPassive"`
}

// componentDemandTotals — спрос НА КОМПОНЕНТЫ (не на базовые ресурсы): сколько
// единиц каждого из 21 компонента нужно как прямой ингредиент — суммарно по
// ВСЕМ 21 рецептам (в т.ч. когда компонент старшего ТУ входит в ещё более
// старший — например, Наноструктурные композиты внутри Аннигиляционных
// зарядов) и по ВСЕМ 19 зданиям, независимо от технологического уровня самого
// здания/потребителя (шахта ТУ1 и лаборатория ТУ3 считаются наравне). Это
// прямое использование (in-degree по рецептному графу), а не рекурсивно
// развёрнутое до сырья — тот более глубокий разрез уже есть в Demand.
func componentDemandTotals() map[string]float64 {
	out := map[string]float64{}
	for _, rec := range componentRecipes {
		for _, in := range rec.Inputs {
			if !in.IsResource && !in.Unimplemented {
				out[in.Key] += in.Qty
			}
		}
	}
	for _, b := range buildingCosts {
		for _, in := range b.Inputs {
			if !in.IsResource && !in.Unimplemented {
				out[in.Key] += in.Qty
			}
		}
	}
	for _, s := range shipItemCosts {
		for _, in := range s.Inputs {
			if !in.IsResource && !in.Unimplemented {
				out[in.Key] += in.Qty
			}
		}
	}
	return out
}

func inputViews(inputs []recipeInput) []economyInputView {
	out := make([]economyInputView, 0, len(inputs))
	for _, in := range inputs {
		out = append(out, economyInputView{
			Key: in.Key, Name: inputDisplayName(in), IsResource: in.IsResource,
			Unimplemented: in.Unimplemented, Qty: in.Qty,
		})
	}
	return out
}

// economySnapshot — считает всё заново на каждый вызов: данных мало (15
// ресурсов, 21 рецепт, 19 зданий), кешировать между запросами незачем, а
// пересчёт от актуальных цен/массы гарантированно свежий без инвалидации.
func economySnapshot() economySnapshotResponse {
	totals := sectorResourceTotals()
	maxStock := maxOf(totals)
	resources := make([]economyResourceView, 0, len(econResourceOrder))
	for _, key := range econResourceOrder {
		rd, _ := resourceDefByKey(key)
		abundance := 0.0
		if maxStock > 0 {
			abundance = totals[key] / maxStock
		}
		resources = append(resources, economyResourceView{
			Key: key, Name: rd.Name, Rarity: abundance,
			DefaultMass: econDefaultMass[key], Mass: resourceMass(key),
			RecommendedPrice: recommendedPriceFromTotals(key, totals, maxStock), Price: resourcePrice(key),
		})
	}

	cache := map[string]componentResolved{}
	recipes := make([]economyRecipeView, 0, len(componentRecipes))
	demand := map[string]float64{}
	for _, key := range econResourceOrder {
		demand[key] = 0
	}
	for _, rec := range componentRecipes {
		resolved := resolveComponent(rec.Key, cache)
		recipes = append(recipes, economyRecipeView{
			Key: rec.Key, Name: rec.Name, Tier: rec.Tier, Factory: rec.Factory,
			Inputs: inputViews(rec.Inputs), ValuePerUnit: resolved.ValuePerUnit,
			MassPerUnit: resolved.MassPerUnit, BaseTotals: resolved.BaseTotals, Incomplete: resolved.Incomplete,
		})
		for k, v := range resolved.BaseTotals {
			demand[k] += v
		}
	}

	buildings := make([]economyBuildingView, 0, len(buildingCosts))
	for _, b := range buildingCosts {
		resolved := resolveBuilding(b, cache)
		buildings = append(buildings, economyBuildingView{
			Type: b.BType, Name: b.Name, Level: b.Level, BuildDays: b.BuildDays,
			LimitingName: b.LimitingName, Inputs: inputViews(b.Inputs),
			TotalValue: resolved.TotalValue, TotalMass: resolved.TotalMass,
			BaseTotals: resolved.BaseTotals, Incomplete: resolved.Incomplete,
		})
		for k, v := range resolved.BaseTotals {
			demand[k] += v
		}
	}

	shipItems := make([]economyShipItemView, 0, len(shipItemCosts))
	var teleportBase buildingResolved
	var teleportDef shipItemCost
	var ionEngineBase buildingResolved
	var ionEngineDef shipItemCost
	var enginePrice float64
	otherModuleValues := make([]float64, 0, len(shipItemCosts))
	for _, s := range shipItemCosts {
		if s.Key == "ship_teleport" {
			teleportBase, teleportDef = resolveShipItem(s, cache), s
			continue // достраивается ниже формулой teleportPriceMultiple, после среднего
		}
		if s.Key == "ship_engine_ion" {
			ionEngineBase, ionEngineDef = resolveShipItem(s, cache), s
			continue // достраивается ниже формулой ionEnginePriceMultiple, после цены ship_engine
		}
		resolved := resolveShipItem(s, cache)
		if s.Key == "ship_engine" {
			enginePrice = resolved.TotalValue
		}
		shipItems = append(shipItems, economyShipItemView{
			Key: s.Key, Name: s.Name, Category: string(s.Category),
			Inputs: inputViews(s.Inputs), TotalValue: resolved.TotalValue, TotalMass: resolved.TotalMass,
			BaseTotals: resolved.BaseTotals, Incomplete: resolved.Incomplete,
		})
		for k, v := range resolved.BaseTotals {
			demand[k] += v
		}
		if s.Category == shipCatModule {
			otherModuleValues = append(otherModuleValues, resolved.TotalValue)
		}
	}
	shipItems = append(shipItems, buildTeleportItem(teleportDef, teleportBase, otherModuleValues, cache, demand))
	shipItems = append(shipItems, buildIonEngineItem(ionEngineDef, ionEngineBase, enginePrice, cache, demand))

	shipModuleEnergy := make([]economyShipModuleEnergyView, 0, len(shipModuleEnergyOrder))
	for _, key := range shipModuleEnergyOrder {
		name := key
		for _, s := range shipItemCosts {
			if s.Key == key {
				name = s.Name
				break
			}
		}
		def := shipModuleEnergyDefaults[key]
		shipModuleEnergy = append(shipModuleEnergy, economyShipModuleEnergyView{
			Key: key, Name: name,
			PowerGen: shipModulePowerGen(key), PowerActive: shipModulePowerActive(key), PowerPassive: shipModulePowerPassive(key),
			DefaultPowerGen: def.Gen, DefaultPowerActive: def.Active, DefaultPowerPassive: def.Passive,
		})
	}

	return economySnapshotResponse{
		Resources: resources, Recipes: recipes, Buildings: buildings, Demand: demand,
		ComponentDemand: componentDemandTotals(),
		ShipComponents: economyShipView{
			Status: "theory",
			Note:   "Рецепты — теория из ТЗ_Корабль.md (классы/палубы/модули/оружие), в игровую механику постройки и боя не заведены. Показаны здесь для расчёта спроса на ресурсы наравне со зданиями и компонентами.",
			Items:  shipItems,
		},
		ShipModuleEnergy: shipModuleEnergy,
	}
}
