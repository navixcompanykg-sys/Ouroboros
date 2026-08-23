package main

import "math"

// ════════════════════════════════════════════════════════════════════════════
// ФИЗИКА КОРАБЛЯ — тяга/ускорение и HP палуб (ТЗ.md §2.7.4, ТЗ_Корабль.md §2/§4.20).
//
// Порт формул из client/ship-deck-sectors.html (computeReferenceMass/
// engineThrustConstants) и client/planet.html (та же логика, синхронизирована
// 1:1 с конструктором кораблей) — нужен здесь, чтобы у РЕАЛЬНОГО корабля на
// сервере (не только в конструкторе) было настоящее ускорение для разгона/
// торможения/поворота — и ручного полёта (settleFlight), и автопилота
// (Navigate/travelDuration, ship.go — раньше плейсхолдер-константа без связи
// с кораблём, пользователь пожаловался на нереалистично быстрый перелёт).
// Считается один раз при назначении корабля флоту (assignFleetShips,
// fleets.go) — в отличие от клиентских версий (пересчитывают на каждый
// рендер, потому что живут в редакторе, где всё постоянно меняется), тут
// дизайн корабля и цены фиксированы на весь сеанс сервера.
// ════════════════════════════════════════════════════════════════════════════

const (
	speedLimitUE = 300000.0  // ТЗ.md §2.7.4 — предел скорости
	screenUE     = 1000000.0 // у.е.·с на 1 экран/клеть (200000×5, ТЗ.md §2.7.4)

	// ── секторная клеть ≠ экран (эта правка) ────────────────────────────────
	// Прямая жалоба пользователя: «ты пишешь 7 клетей, но 7 клетей это 7
	// секторов, а значит порядка 35×6-7 экранов... ты это учёл???» — НЕТ, не
	// учитывал: `server/galaxy.go` расставляет звёзды в СЕКТОРНОЙ сетке
	// (120×120 на весь сектор, `Object.R/X0`, ТЗ.md §2.1) — это отдельная,
	// более крупная единица, чем экран (корабельная/системная шкала,
	// §2.7.4 — радиус системы 35 экранов). ТЗ.md §2.7.4 прямо говорит: «оба
	// [масштаба корабля и системы] отдельны от масштаба «Доступная
	// галактика» (сетка 120×120)» — но `server/ship.go` (межзвёздная ветка
	// Navigate/EstimateTravel, унаследовано из более раннего этапа проекта)
	// вычитал секторные R/X0 и подставлял результат НАПРЯМУЮ в корабельную
	// кинематику, будто это уже экраны. Отсюда и «мало ест топлива» —
	// перелёты считались в разы короче, чем должны быть.
	//
	// sectorCletToScreen — конверсия, ВЫВЕДЕНА (не подобрана) из уже
	// существующих чисел ТЗ.md §2.7.4: типичный межзвёздный перелёт —
	// пустой участок (30 экранов) + радиус системы с обеих сторон (35+35) =
	// **100 экранов**. Замеренное среднее расстояние до ближайшей звезды в
	// секторных клетях — **7,35** (`server/fuel_calc_test.go`,
	// TestSectorScaleDiagnostic-класс замеров, сид 11, 101 звезда).
	// 100 / 7.35 ≈ 13,6 экрана на 1 секторную клеть.
	//
	// Это же число — «размер сектора в экранах» для БУДУЩЕЙ межсекторной
	// навигации (ТЗ.md §2.1.3, «сектор — самостоятельная область галактики,
	// корабль реально пересекает секторы» — принятое решение пользователя,
	// инфраструктура ещё не реализована): весь сектор — 120 секторных
	// клетей поперёк, то есть ≈1633 экрана.
	sectorCletToScreen = 100.0 / 7.35

	// «Водородный» двигатель — время разгона до 200000 у.е. без гравитации =
	// 36000с (10ч), ТЗ.md §2.7.4 — единственный явный кандидат калибровки для
	// обычного «Двигателя» инструмента (см. подробности в client/ship-deck-
	// sectors.html у HYDROGEN_ACCEL_UE_S2).
	hydrogenAccelUES2 = 200000.0 / 36000.0

	// Ионный двигатель не описан в ТЗ (введён в v2) — калибруется от обычного:
	// потребляет ×20 энергии (economy.go shipModuleEnergyDefaults, 5→100,
	// поднято с ×4 по прямому требованию пользователя — атомный реактор один
	// такой двигатель уже не тянет), но на 20% МЕНЬШЕ ускорения на единицу
	// энергии (уточнение пользователя: было 30%, «многовато» — разница
	// ионного и обычного должна быть ТОЛЬКО в потреблении энергии плюс
	// умеренный штраф к тяге на единицу энергии, не более) — тяга на модуль
	// получается ×20×0.8=×16 от обычного, не независимая цифра.
	ionEfficiencyVsRegular = 0.8

	// ── РАСХОД ТОПЛИВА — дискретный цикл, ГАЗОХРАНИЛИЩЕ жжёт, не двигатель ──
	// ⚠ ВТОРОЕ ИСПРАВЛЕНИЕ поверх первой версии этой калибровки (прямая
	// правка пользователя, полностью меняет модель): первая версия всё ещё
	// считала, что ДВИГАТЕЛЬ жжёт топливо — просто выровняла темп между
	// типами (оба по 60с/ед.). Пользователь поправил саму картину: «ты
	// исходишь из того что жжёт топливо двигатель, но логика такова, что
	// газовое хранилище сжигает топливо чтоб произвести энергию которую
	// потребляет обычный двигатель, а в случае гелия-3 двигатель берёт
	// сжигает сам». То есть:
	//   1. ГАЗОХРАНИЛИЩЕ (не двигатель) — генератор с ФИКСИРОВАННОЙ отдачей
	//      за цикл: 1 ед. водорода → fuelUnitYieldHydrogen энергии, 1 ед.
	//      гелия-3 → fuelUnitYieldHelium3 (число подобрано пользователем так,
	//      что РОВНО закрывает спрос одного ионного двигателя — 100 = 100 —
	//      отсюда и ощущение «двигатель сжигает сам»: без реактора и без
	//      других потребителей 1 сожжённая единица гелия ↔ 1 цикл одного
	//      ионного движка, 1:1, без остатка).
	//   2. Выработанная энергия делится МЕЖДУ ВСЕМИ двигателями НЕПРЕРЫВНО/
	//      ПРОПОРЦИОНАЛЬНО их спросу (пример пользователя: 1 газохранилище
	//      даёт 10 энергии — двум обычным двигателям (спрос 2×5=10) хватает
	//      ровно; если двигателей три (спрос 15), те же 10 делятся НЕ по
	//      целым единицам сжигания на движок, а по 3,33 на каждый) — этот
	//      кусок (ThrustSum·ratio/Mass, «делится дробно между потребителями»)
	//      НЕ МЕНЯЕТСЯ, см. accelAt ниже, тот же смысл, что у старого
	//      accelFor.
	//   3. ЦИКЛ — 60 РЕАЛЬНЫХ СЕКУНД ПОД ТЯГОЙ (не «раз в секунду», тот же
	//      период, что раньше калибровался на двигатель, теперь — на
	//      газохранилище): «сжигание происходит раз в 60 секунд, как и
	//      потребление энергии — единый цикл. В первую очередь двигатель
	//      берёт энергию из генерации [реактора] или запаса аккумуляторов, и
	//      если не хватает — идёт сжигание, но нельзя сжечь 0,3 водорода.
	//      Сожжётся единица и высвободится энергия. Лишнее уйдёт в
	//      аккумуляторы, если нет систем готовых её принять, а если нет
	//      аккумулятора — просто исчезнет». Реализовано в settleEnergyCycle
	//      ниже — реактор+батарея покрывают спрос ПЕРВЫМИ, остаток жжётся
	//      ЦЕЛЫМИ единицами: с округлением ВВЕРХ (излишек в батарею), если у
	//      батареи есть место, иначе ВНИЗ (топливо не тратится впустую, но
	//      двигатели недополучают) — «поэтому нет смысла жечь топливо на
	//      энергию, если нет её потребителя».
	//
	// Порядок КАЖДОГО из этих трёх решений — прямая цитата пользователя, не
	// самостоятельная догадка. Проверено server/shipflight_test.go
	// TestSettleEnergyCycle (несколько сценариев: реактора хватает целиком,
	// делёж между несколькими двигателями, округление вверх с батареей,
	// округление вниз без батареи/без места, гелий закрывает ионный 1:1).
	//
	// Период (60с) — тот же исторический ориентир, что и раньше (было 90,
	// опущено пользователем до 60 — жёстче для мелких кораблей). Среднее
	// межзвёздное расстояние для итоговых прогонов калибровки — 100 экранов
	// (см. sectorCletToScreen выше), актуальные цифры расхода — свежий прогон
	// TestTwoInterstellarFlightsOnOneTank/TestEngineEfficiencyComparison, не
	// исторические числа в этом комментарии (они успели устареть дважды).
	energyCyclePeriodSec = 60.0

	// fuelUnitYieldHydrogen/Helium3 — фиксированная отдача ОДНОЙ единицы
	// топлива за цикл (энергия, та же размерность, что powerActive
	// двигателей). Прямые числа пользователя (не выведены формулой): 10 —
	// водород (2 обычных двигателя на 1 газохранилище влезают ровно, пример
	// пользователя), 100 — гелий-3 (закрывает ровно один ионный двигатель).
	// Совпадают с GAS_RATE_HYDROGEN/GAS_RATE_HELIUM3, которые уже были в
	// client/ship-deck-sectors.html (независимый источник, введённый раньше
	// этой сессии) — не новая, а объединённая с уже существующей цифра;
	// прежние server-константы (300/2600, производные от «burnRate=power/
	// fuelRate» континуальной модели) больше не используются — континуальной
	// модели сжигания за двигателем не осталось вовсе.
	fuelUnitYieldHydrogen = 10.0
	fuelUnitYieldHelium3  = 100.0

	// Металлический водород — топливо не ХОДА (в коде нет отдельного
	// «двигателя на металлическом водороде»), а разового форсированного
	// сжигания для быстрой зарядки аккумуляторов («ЗАРЯДИТЬ» — chargeFuelCost/
	// metalHydrogenChargeYield ниже, отдельная механика, эту правку не
	// затрагивает).

	// ── реальный запас топлива на борту (эта правка — раньше FuelRatio выше
	// был единственным «топливным» понятием: мгновенная пропускная способность
	// газохранилища, БЕЗ расходуемого запаса, будто бак бесконечен). Ёмкость —
	// самостоятельная оценка (в ТЗ нет числа): тот же приём, что уже применён
	// в client/ship-deck-sectors.html для BATTERY_CAPACITY=1000 — абстрактная
	// круглая величина «на 1 модуль», не сорт масса. Стартовая загрузка ПО
	// МАССЕ (переводится в единицы через resourceMass в fleets.go, т.к. масса
	// водорода/гелия разная — economy.go): водород — ОСНОВНОЙ бак (95%,
	// дешёвый/доступный), гелий-3 — малый форсажный резерв (5%, дорогой,
	// расходуется быстро и только на форсаж/импульс) — ИСПРАВЛЕНО по прямому
	// указанию пользователя (первая версия перепутала доли, гелий ошибочно
	// оказался основным баком). При массе водорода 2/ед. и гелия 1/ед. это
	// НЕ даёт зеркальные числа долям (950 водорода / 50 гелия при ёмкости
	// 1000, не 950/50 в лоб — единицы, не масса, у ресурсов разный вес).
	// Металлический водород НЕ грузится при старте (0) — дорогой/дефицитный
	// ресурс (ТЗ_Ресурсы.md §3.1, только газовые гиганты зон 1–4), игрок
	// обязан добыть/купить его сам; сама добыча/покупка топлива для корабля
	// пока нигде не реализована — реальный запас уменьшается только полётом,
	// но никак не пополняется после старта (открытый вопрос на будущее, не
	// эта правка).
	gasStorageFuelCapacity = 1000.0
	startFuelHydrogenShare = 0.95
	startFuelHelium3Share  = 0.05

	// ── форсаж «на гелии» (кнопка УСКОРИТЬ/МЕДЛЕННЕЕ, ship.html) — Ship.Boosted
	// просто переключает, каким из двух топлив settleFlight/settleEnergyCycle
	// урегулирует цикл — искусственного множителя тяги больше нет, разница
	// целиком из настоящей физики топлива (fuelUnitYieldHelium3 на порядок
	// больше fuelUnitYieldHydrogen). Разовый «газ» (тап) остался отдельной
	// механикой — фиксированный импульс скорости (не от accelUE, иначе
	// слабый корабль получал бы микроскопическую прибавку), не трогает
	// Boosted.
	boostKickUE       = speedLimitUE * 0.05
	boostKickFuelCost = 20.0

	// ── быстрая зарядка аккумуляторов сжиганием металлического водорода
	// (кнопка ЗАРЯДИТЬ) — тоже самостоятельная механика по прямому требованию
	// пользователя. Ёмкость батареи — то же число, что BATTERY_CAPACITY в
	// client/ship-deck-sectors.html (согласовано намеренно), «выход заряда»
	// за единицу металл-водорода подобран так, чтобы одно нажатие (по
	// умолчанию расходуя chargeFuelCost) заметно заполняло батарею одного
	// модуля, а не капало по чуть-чуть — соответствует «быстрая зарядка».
	// Поднято 1000→10000 по прямому требованию пользователя: при квантованном
	// сжигании топлива (ship.go, «нельзя сжечь 0,3 водорода») излишек от
	// округлённого вверх сжигания уходит в аккумулятор — на 1000 он забивался
	// почти сразу, и хранить энергию в водороде (просто не жечь лишнее)
	// становилось выгоднее батареи, что обесценивало сам модуль.
	batteryCapacityPerModule = 10000.0
	chargeFuelCost           = 10.0
	metalHydrogenChargeYield = 100.0 // заряда на 1 ед. металл-водорода

	// ── автономность СЖО (система жизнеобеспечения) — по прямому требованию
	// пользователя: «СЖО даёт кораблю без посадки лететь 6 часов, доп.
	// система прибавит ещё столько же за каждое СЖО». Считается в РЕАЛЬНЫХ
	// секундах (та же шкала времени, что у Ship.Speed/Transit — см. шапку
	// файла ship.go, «время полёта — реальные секунды, не игровые месяцы»).
	// Расходуется, только пока корабль НЕ на поверхности («без посадки») —
	// посадка ГДЕ УГОДНО останавливает расход (экипаж не жжёт корабельный
	// запас, пока стоит на грунте), а перезарядка — ТОЛЬКО на обитаемых
	// мирах (Planet.Life) или колониях (Planet.Population>0), по прямому
	// требованию пользователя. Что происходит при обнулении — открытый
	// вопрос (не задано пользователем): по аналогии с дефицитом энергии
	// колонии (server/production.go energyDay) сейчас это чистая метрика для
	// игрока, ни на что не влияющая — см. Ship.settleLifeSupport.
	lifeSupportHoursPerModule = 6.0
	lifeSupportSecPerModule   = lifeSupportHoursPerModule * 3600

	// ── грузовой трюм (окно осмотра корабля, по прямому требованию
	// пользователя: «выкинуть из трюма груз в космос... видно что есть в
	// трюмах») — ёмкость самостоятельная оценка, тот же приём «круглое число
	// на 1 модуль», что у batteryCapacityPerModule/gasStorageFuelCapacity
	// выше. Единица — та же условная «масса», что уже используется для
	// топлива (fleets.go loadStartingFuel), не штуки: разные ресурсы разного
	// веса, значит и разного объёма в реальных единицах.
	cargoCapacityPerModule = 1000.0
)

// moduleDurability — те же значения, что SHIP_MODULES.durability в
// client/ship-deck-sectors.html и client/planet.html (1=хрупкий/2=крепкий,
// ТЗ_Корабль.md §2/§4). На сервере такого справочника раньше не было вовсе —
// корабль был безструктурной точкой (см. шапку ship.go).
var moduleDurability = map[string]int{
	"ship_life_support": 1, "ship_colonist": 1, "ship_weapon_mount": 2,
	"ship_solar_sail": 1, "ship_engine": 2, "ship_engine_ion": 2,
	"ship_reactor": 2, "ship_gas_storage": 2, "ship_battery": 1,
	"ship_repair": 1, "ship_solar_panel": 1, "ship_teleport": 1,
	"ship_miner": 2, "ship_radar": 1, "ship_ecm": 1, "ship_computer": 1,
	"ship_shield": 1, "ship_dock": 2, "ship_hangar": 2, "ship_cargo": 2,
}

// shipClassTable — та же таблица классов, что SHIP_CLASS_TABLE в
// client/ship-deck-sectors.html/planet.html (числа обязаны совпадать во всех
// трёх местах).
var shipClassTable = []struct{ decks, perDeck int }{
	{1, 8}, {2, 6}, {4, 4}, {6, 4}, {12, 3}, {22, 2}, {60, 1},
}

func shipClassBracketGo(builtDecks int) (decks, perDeck int) {
	for _, c := range shipClassTable {
		if c.decks >= builtDecks {
			return c.decks, c.perDeck
		}
	}
	last := shipClassTable[len(shipClassTable)-1]
	return last.decks, last.perDeck
}

// DeckHP — прочность одной палубы: 3 (голая, ТЗ_Корабль.md §2) + сумма
// прочности установленных модулей, без брони (апгрейд бронирования нигде не
// применяется к живым кораблям флотов — тема отдельного будущего шага).
// Row/Col — те же координаты на сетке 5×7, что в библиотеке кораблей
// (ship_defaults.json) — клиент рисует по ним «скелет» корпуса один в один
// с конструктором. Modules — ключи установленных модулей ПО СЛОТАМ (эта
// правка, по прямому требованию пользователя — окно осмотра корабля
// показывает, что установлено в каждый слот, и считает сектора обстрела по
// типу модуля; раньше DeckHP отдавал только агрегированное HP, без состава).
type DeckHP struct {
	Row     int      `json:"row"`
	Col     int      `json:"col"`
	Max     int      `json:"max"`
	Current int      `json:"current"`
	Modules []string `json:"modules"`
}

func buildDeckHP(design shipDefaultShip) []DeckHP {
	out := make([]DeckHP, 0, len(design.Decks))
	for _, d := range design.Decks {
		hp := 3
		for _, m := range d.Modules {
			hp += moduleDurability[m]
		}
		out = append(out, DeckHP{Row: d.Row, Col: d.Col, Max: hp, Current: hp, Modules: d.Modules})
	}
	return out
}

// shipModuleCounts — сколько модулей учитываемых типов установлено и
// суммарная масса всех модулей (нужна и для референсной массы, и для тяги
// конкретного корабля).
type shipModuleCounts struct {
	regularEngines, ionEngines, gasStorage, battery, lifeSupport, cargo, reactor int
	moduleCount                                                                  int
	moduleMassSum                                                                float64
	totalMass                                                                    float64
}

func computeShipModuleCounts(design shipDefaultShip, cache map[string]componentResolved) shipModuleCounts {
	var out shipModuleCounts
	if frame, ok := shipItemByKey("ship_frame"); ok {
		out.totalMass = resolveShipItem(frame, cache).TotalMass * float64(len(design.Decks))
	}
	for _, d := range design.Decks {
		for _, m := range d.Modules {
			if m == "" {
				continue
			}
			out.moduleCount++
			if item, ok := shipItemByKey(m); ok {
				mass := resolveShipItem(item, cache).TotalMass
				out.moduleMassSum += mass
				out.totalMass += mass
			}
			switch m {
			case "ship_engine":
				out.regularEngines++
			case "ship_engine_ion":
				out.ionEngines++
			case "ship_gas_storage":
				out.gasStorage++
			case "ship_battery":
				out.battery++
			case "ship_life_support":
				out.lifeSupport++
			case "ship_cargo":
				out.cargo++
			case "ship_reactor":
				out.reactor++
			}
		}
	}
	return out
}

// computeReferenceMass — масса Крейсера/Баржи (decks-бракет 6) из библиотеки
// ship_defaults.json, КАК ЕСЛИ БЫ все свободные слоты заняли модулями средней
// массы класса — то же самое, что computeReferenceMass в client/ship-deck-
// sectors.html (см. подробный комментарий там), портировано на сервер.
func computeReferenceMass() float64 {
	shipDefaultsMu.RLock()
	defer shipDefaultsMu.RUnlock()
	cache := map[string]componentResolved{}
	var n int
	var massSum, moduleMassSum float64
	var moduleCount, freeSlotsSum int
	for _, s := range shipDefaultsData {
		built := len(s.Decks)
		if built == 0 {
			continue
		}
		decks, perDeck := shipClassBracketGo(built)
		if decks != 6 {
			continue // Крейсер/Баржа
		}
		counts := computeShipModuleCounts(s, cache)
		freeSlots := built*perDeck - counts.moduleCount
		if freeSlots < 0 {
			freeSlots = 0
		}
		n++
		massSum += counts.totalMass
		moduleMassSum += counts.moduleMassSum
		moduleCount += counts.moduleCount
		freeSlotsSum += freeSlots
	}
	if n == 0 {
		return 0
	}
	avgMass := massSum / float64(n)
	avgFreeSlots := float64(freeSlotsSum) / float64(n)
	avgModuleMass := 0.0
	if moduleCount > 0 {
		avgModuleMass = moduleMassSum / float64(moduleCount)
	}
	return avgMass + avgFreeSlots*avgModuleMass
}

// ShipPhysics — статические характеристики КОРПУСА одного корабля флота:
// тяга двигателей и масса, считаются один раз при назначении
// (assignFleetShips) от текущих цен и референсной массы, дальше не меняются
// в течение сеанса сервера. НЕ включает готовое ускорение/расход топлива
// напрямую — раньше эта структура жёстко привязывала топливо к ТИПУ
// установленных двигателей (ионные — всегда на гелии, обычные — всегда на
// водороде); ИСПРАВЛЕНО по прямому уточнению пользователя: «ионный и на
// водороде летать может, просто тяга будет не полной, так как водород даёт
// меньше энергии при сжигании». Теперь ЛЮБОЙ корабль (любой набор
// двигателей) можно топить ЛЮБЫМ из двух топлив — сама тяга (ThrustSum) от
// выбора топлива не зависит вовсе, разница только в том, сколько энергии
// газохранилище способно поставить за цикл (settleEnergyCycle ниже).
type ShipPhysics struct {
	ThrustSum  float64 // суммарная тяга ВСЕХ двигателей на полной мощности — топливонезависимая
	FuelDemand float64 // суммарная активная мощность двигателей на полную тягу (у.е./с энергии) — тоже топливонезависимая
	Mass       float64

	// ── для реального запаса топлива/батареи (fleets.go loadStartingFuel,
	// ship.go Charge/settleEnergyCycle) — сколько соответствующих модулей
	// установлено и какова суммарная ёмкость батареи.
	GasStorageCount int
	BatteryCount    int
	BatteryCapacity float64

	// ── автономность СЖО (ship.go settleLifeSupport) — сколько модулей и
	// суммарный запас хода без посадки, в РЕАЛЬНЫХ секундах.
	LifeSupportCount    int
	LifeSupportCapacity float64

	// ── грузовой трюм (ship.go Jettison/Pickup, окно осмотра корабля).
	CargoCount    int
	CargoCapacity float64

	// ── реактор (эта правка, по прямой жалобе пользователя: «ты как-то не
	// учёл, что у ионного скоростного шаттла атомный реактор»). Раньше
	// ship_reactor участвовал ТОЛЬКО в прочности палубы (moduleDurability) —
	// сама генерируемая энергия нигде не читалась, хотя ровно ЭТУ роль ей
	// прочил уже существовавший комментарий в economy.go (у shipModule
	// EnergyDefaults["ship_engine_ion"]): «атомный реактор (powerGen=40)
	// теперь физически не может в одиночку тянуть даже один такой двигатель
	// на полную мощность... недостача энергии... линейно снижает тягу через
	// уже существующий FuelRatio» — то есть реактор ЗАДУМЫВАЛСЯ источником
	// FuelRatio наравне с газохранилищем, просто это никогда не было
	// дописано в тогдашний расчёт тяги. ReactorPowerGen — суммарная мощность всех
	// реакторов корабля, добавляется к «трубе» ГАЗОНЕЗАВИСИМО (реактор не ест
	// водород/гелий, это отдельный, непополняемый в игре, но и нерасходуемый
	// источник — ТЗ_Корабль.md §4.6 «бесконечный источник энергии»).
	ReactorPowerGen float64
}

// sectorCletsToScreens — расстояние в СЕКТОРНЫХ клетях (Object.R/X0,
// galaxy.go) в экраны (клети корабельной/системной шкалы, ТЗ.md §2.7.4) —
// см. sectorCletToScreen выше. Единственная точка конверсии: любой код,
// сравнивающий расстояние между звёздами с чем-то корабельным (радиус
// системы, кинематика полёта), обязан пройти через неё — server/ship.go
// (Navigate/EstimateTravel, межзвёздная ветка) и тесты (server/fuel_calc_
// test.go) используют именно эту функцию, а не считают коэффициент заново.
func sectorCletsToScreens(clets float64) float64 { return clets * sectorCletToScreen }

// fuelUnitYieldFor — фиксированная отдача одной единицы топлива ЗА ЦИКЛ
// (energyCyclePeriodSec, см. константы выше), 0 для неизвестного ключа.
func fuelUnitYieldFor(fuelKey string) float64 {
	switch fuelKey {
	case "hydrogen":
		return fuelUnitYieldHydrogen
	case "helium3":
		return fuelUnitYieldHelium3
	default:
		return 0
	}
}

// settleEnergyCycle — ОДИН дискретный цикл распределения энергии (60с ПОД
// ТЯГОЙ, см. «РАСХОД ТОПЛИВА» выше) — единственное место, где реально
// списывается запас топлива и меняется заряд батареи. Порядок СТРОГО по
// требованию пользователя:
//  1. Реактор (ГАЗОНЕЗАВИСИМО, бесплатно) + то, что уже есть в батарее,
//     покрывают спрос ПЕРВЫМИ.
//  2. Если этого не хватило — жжём газохранилище ЦЕЛЫМИ единицами (нельзя
//     сжечь дробную часть): с округлением ВВЕРХ, если у батареи есть место
//     принять излишек (surplus банкуется, ничего не пропадает), иначе ВНИЗ
//     (топливо не тратится впустую, но спрос в этом цикле закрывается не
//     полностью — engines «недополучат»).
//
// fuelStock — указатель на РЕАЛЬНЫЙ запас (Ship.FuelHydrogen/FuelHelium3,
// мутируется), fuelUnitYield — fuelUnitYieldFor(fuelKey), batteryCharge —
// указатель на Ship.BatteryCharge (тоже мутируется). Возвращает fuelRatio —
// долю покрытого спроса (0..1), тот же смысл, что раньше, но теперь
// ФИКСИРОВАННУЮ на весь цикл (не пересчитывается continuously по dt) —
// вызывающий (ship.go) держит её константной до следующего цикла.
func (p ShipPhysics) settleEnergyCycle(fuelStock *float64, fuelUnitYield float64, batteryCharge *float64) (ratio float64) {
	demand := p.FuelDemand
	if demand <= 0 {
		return 1
	}
	shortfall := demand - p.ReactorPowerGen
	if shortfall < 0 {
		shortfall = 0
	}
	batteryDraw := math.Min(shortfall, *batteryCharge)
	*batteryCharge -= batteryDraw
	shortfall -= batteryDraw
	covered := demand - shortfall

	if shortfall <= 1e-9 || fuelUnitYield <= 0 || fuelStock == nil {
		ratio = covered / demand
		if ratio > 1 {
			ratio = 1
		}
		return
	}

	hasRoom := *batteryCharge < p.BatteryCapacity
	unitsNeeded := shortfall / fuelUnitYield
	var units float64
	if hasRoom {
		units = math.Ceil(unitsNeeded) // есть куда деть излишек — жжём с запасом
	} else {
		// «Жжём по минимуму» — округление ВНИЗ, но НЕ до нуля: нехватка
		// (shortfall) ВСЕГДА реальна (>0 здесь), а «нет смысла жечь, если
		// нет потребителя» относится к НУЛЕВОМУ спросу (см. верх функции,
		// demand<=0 — там сжигания вообще не происходит), а не к спросу
		// МЕНЬШЕ одной единицы. Без этого пола корабль с одним движком на
		// спросе ниже unitYield (например демонд 5 при выходе 10) НИКОГДА
		// не жёг бы бак (floor(0.5)=0) и стоял бы вечно без хода — раз уж
		// сжигаем, минимум 1 целая единица, даже если часть уйдёт в отходы
		// без батареи (та же цена, что и «просто исчезнет» у излишка).
		units = math.Max(1, math.Floor(unitsNeeded))
	}
	if units > *fuelStock {
		units = math.Floor(*fuelStock) // нельзя сжечь больше целых единиц, чем есть в баке
	}
	if units < 0 {
		units = 0
	}
	*fuelStock -= units

	produced := units * fuelUnitYield
	burnedCovered := math.Min(shortfall, produced)
	surplus := produced - burnedCovered
	if surplus > 0 {
		room := p.BatteryCapacity - *batteryCharge
		bank := math.Min(surplus, room)
		*batteryCharge += bank
		// остаток (surplus-bank, если room не хватило) «просто исчезнет» —
		// прямая цитата пользователя, не баг.
	}

	covered += burnedCovered
	ratio = covered / demand
	if ratio > 1 {
		ratio = 1
	}
	return
}

// accelAtRatio — ускорение при произвольной доле подведённой к двигателям
// мощности (settleEnergyCycle выше возвращает именно такую долю — держится
// константной весь цикл, не continuous).
func (p ShipPhysics) accelAtRatio(ratio float64) float64 {
	if p.Mass <= 0 || p.ThrustSum <= 0 || ratio <= 0 {
		return 0
	}
	return p.ThrustSum * ratio / p.Mass
}

// maxThrustCycleCap — потолок симуляции estimateMaxThrustSec ниже, чтобы не
// зациклиться, если корабль физически никогда не исчерпывает бак (реактор
// покрывает весь спрос, либо спрос настолько мал, что округление вниз без
// места в батарее НИКОГДА не жжёт целую единицу — устойчивое бесконечное
// состояние, см. settleEnergyCycle). Ни один реалистичный перелёт в текущих
// прогонах не приближается к этому потолку (часы, не месяцы).
const maxThrustCycleCap = 20000 // 20000×60с ≈ 333 часа под тягой

// estimateMaxThrustSec — сколько секунд ПОД ТЯГОЙ корабль может продержать,
// пока реальный запас (минус резерв на манёвр/стыковку, reserveSec) не
// закончится. У квантованной модели (settleEnergyCycle) НЕТ замкнутой
// формулы «топливо / скорость расхода» — сколько жжётся за цикл зависит от
// того, сколько УЖЕ накоплено в батарее с прошлых циклов (а туда banked
// излишек от округления вверх) — поэтому симулируем ПОКОЛИЧЕСТВЕННО на
// КОПИЯХ запаса/батареи (реальный Ship не трогаем — это оценка для
// планирования полёта, не факт расхода). Резерв переводится в «худший
// случай одного цикла» (ceil(shortfall/yield) единиц) на каждую
// reserveSec/60 цикла — тот же смысл, что раньше у fuelReserveThrustSec, не
// точная симуляция самого резервного цикла (усложнять сверх этого не
// просил пользователь).
func (p ShipPhysics) estimateMaxThrustSec(fuelStock, batteryCharge, fuelUnitYield, reserveSec float64) float64 {
	if p.FuelDemand <= 0 || p.FuelDemand <= p.ReactorPowerGen || fuelUnitYield <= 0 {
		return math.Inf(1) // бак вообще не расходуется на эту тягу
	}
	shortfall := p.FuelDemand - p.ReactorPowerGen
	reserveCycles := math.Ceil(reserveSec / energyCyclePeriodSec)
	reserveUnits := reserveCycles * math.Ceil(shortfall/fuelUnitYield)
	stock := fuelStock - reserveUnits
	if stock <= 0 {
		return 0
	}
	battery := batteryCharge
	cycles := 0
	for cycles < maxThrustCycleCap {
		before := stock
		p.settleEnergyCycle(&stock, fuelUnitYield, &battery)
		cycles++
		if stock <= 0 {
			return float64(cycles) * energyCyclePeriodSec
		}
		if stock == before {
			// ничего не сожгли этот цикл (устойчивое состояние без сжигания,
			// см. settleEnergyCycle) — так будет всегда, бак не ограничивает.
			return math.Inf(1)
		}
	}
	return math.Inf(1) // потолок симуляции — реалистичного перелёта это не касается
}

// steadyFuelRatio — оценка ДОЛИ покрытого спроса «в среднем» для АВТОПИЛОТА
// (Navigate/EstimateTravel) — у него нет своего урегулированного цикла (в
// отличие от ручного полёта, Ship.FuelRatio), а flightProfile умеет только
// ОДНО постоянное ускорение на весь манёвр (ship.go newFlightProfile) —
// поэтому берём ratio на «устоявшемся» цикле (запас без изменений между
// двумя последовательными циклами — то самое «нет смысла жечь, если некому
// потреблять» из settleEnergyCycle, — либо на исчерпании бака) как лучшее
// ОДНО число для всего манёвра. Честно объявленное упрощение (в модели с
// батареей ratio технически меняется цикл от цикла, пока не устаканится) —
// не подгонка: параметр, который бы подбирался под желаемый результат,
// здесь отсутствует (ТЗ.md §0).
func (p ShipPhysics) steadyFuelRatio(fuelStock, batteryCharge, fuelUnitYield float64) float64 {
	if p.FuelDemand <= 0 {
		return 1
	}
	stock, battery := fuelStock, batteryCharge
	ratio := 1.0
	for i := 0; i < maxThrustCycleCap; i++ {
		before := stock
		ratio = p.settleEnergyCycle(&stock, fuelUnitYield, &battery)
		if stock == before || stock <= 0 {
			break
		}
	}
	return ratio
}

// computeShipPhysics — тяга (топливонезависимая) и масса корпуса. Реальное
// ускорение/расход на конкретном топливе — settleEnergyCycle, вызывается на
// месте (settleFlight/Navigate/EstimateTravel), не здесь: топливо теперь выбирает
// игрок в моменте (кнопка УСКОРИТЬ/МЕДЛЕННЕЕ, ship.html), а не жёстко
// прошито в дизайне корабля.
func computeShipPhysics(design shipDefaultShip) ShipPhysics {
	cache := map[string]componentResolved{}
	counts := computeShipModuleCounts(design, cache)
	referenceMass := computeReferenceMass()
	out := ShipPhysics{
		Mass:                counts.totalMass,
		GasStorageCount:     counts.gasStorage,
		BatteryCount:        counts.battery,
		BatteryCapacity:     float64(counts.battery) * batteryCapacityPerModule,
		LifeSupportCount:    counts.lifeSupport,
		LifeSupportCapacity: float64(counts.lifeSupport) * lifeSupportSecPerModule,
		CargoCount:          counts.cargo,
		CargoCapacity:       float64(counts.cargo) * cargoCapacityPerModule,
		ReactorPowerGen:     float64(counts.reactor) * shipModulePowerGen("ship_reactor"),
	}
	if referenceMass <= 0 || counts.totalMass <= 0 {
		return out
	}
	thrustEngine := hydrogenAccelUES2 * referenceMass
	regActive := shipModulePowerActive("ship_engine")
	ionActive := shipModulePowerActive("ship_engine_ion")
	ionThrustRatio := 0.0
	if regActive > 0 {
		ionThrustRatio = (ionActive / regActive) * ionEfficiencyVsRegular
	}
	thrustIon := thrustEngine * ionThrustRatio

	out.ThrustSum = float64(counts.regularEngines)*thrustEngine + float64(counts.ionEngines)*thrustIon
	out.FuelDemand = float64(counts.regularEngines)*regActive + float64(counts.ionEngines)*ionActive
	return out
}
