package main

// ══════════════════════════════════════════════════════════════════════════
// ФЛОТЫ ИГРОКА
//
// Раскладка «где чьи флоты стоят» — по одному на каждый из 4 стабильных миров
// (столица + 3 вассала, см. galaxy.go placeStableWorlds). Раньше реально летал
// только ОДИН, статичный, «текущий» флот — тот же самый глобальный `ship`
// (ship.go), остальные три были декоративными карточками без своего корабля.
// По прямому требованию пользователя это исправлено: у каждого из 4 флотов
// теперь СВОЙ *Ship (позиция/курс/HP палуб/топливо — всё своё), и
// activeFleetID определяет, чей корабль сейчас показывают /api/ship и
// принимают команды /api/ship/*. Аккаунтов всё ещё нет (см. шапку ship.go) —
// «активный» флот один общий на весь сервер, как и раньше со скоростью
// времени: переключение видно сразу на всех подключённых устройствах.
//
// 4 первых (самых малых) готовых дизайна библиотеки кораблей
// (client/ship-deck-sectors.html → ship_defaults.json) розданы по одному на
// флот — простой детерминированный выбор по имени, без привязки к конкретной
// фракции (вассалы и так перемешаны по сиду в placeStableWorlds, привязывать
// дизайн к конкретной фракции было бы произвольным решением без разницы).
// ══════════════════════════════════════════════════════════════════════════

type Fleet struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	ShipClass  string `json:"shipClass"`
	HomeStarID int    `json:"homeStarId"`
	Current    bool   `json:"current"` // = (ID == activeFleetID), см. handleFleets

	Ship *Ship `json:"-"`
}

var (
	fleets        []Fleet
	activeFleetID int
)

// starterFleetDesigns — 4 самых малых готовых дизайна библиотеки (класс
// Корвет/Шаттл, 1 палуба) — по прямому требованию пользователя «возьмём 4
// первых типа, самых малых». Порядок соответствует индексу флота (fleets[i]).
var starterFleetDesigns = []string{
	"Корвет Патрульный", "Шатл Грузовой", "Корвет 2 Боевой", "Шатл 2 Скоростной",
}

// initFleets раскладывает флоты по стабильным мирам детерминированно от сида
// (порядок вассалов уже перемешан в placeStableWorlds). Столица всегда несёт
// флот с индексом 0 — так совпадает со стартовой позицией ship.go/activeFleetID.
func initFleets(sim *Sim) {
	objects, _ := sim.Snapshot()
	vassalIDs := make([]int, 0, 3)
	for _, o := range objects {
		if o.Role == "vassal" {
			vassalIDs = append(vassalIDs, o.ID)
		}
	}

	names := []string{`1-й флот «Скиталец»`, `2-й флот «Тень»`, `3-й флот «Кузня»`, `4-й флот «Застава»`}
	homeStars := append([]int{findCapitalID(sim)}, vassalIDs...)

	fleets = make([]Fleet, 0, 4)
	for i := 0; i < 4 && i < len(homeStars); i++ {
		fleets = append(fleets, Fleet{
			ID: i, Name: names[i], HomeStarID: homeStars[i],
		})
	}
	activeFleetID = 0
	assignFleetShips()
}

// assignFleetShips — назначает каждому флоту его *Ship по стартовому дизайну
// (starterFleetDesigns): позиция — у родного мира флота, HP палуб и тяга —
// из дизайна библиотеки (shipphysics.go). Вызывается один раз при старте,
// после loadShipDefaults()/loadEconomy() (нужны для расчёта тяги/массы).
func assignFleetShips() {
	shipDefaultsMu.RLock()
	byName := make(map[string]shipDefaultShip, len(shipDefaultsData))
	for _, s := range shipDefaultsData {
		byName[s.Name] = s
	}
	shipDefaultsMu.RUnlock()

	for i := range fleets {
		f := &fleets[i]
		sysR := 20.0
		if star, ok := sim.Object(f.HomeStarID); ok && star.SystemRadius > 0 {
			sysR = star.SystemRadius
		}
		sh := NewShip(f.HomeStarID, sysR)

		designName := starterFleetDesigns[i%len(starterFleetDesigns)]
		if design, ok := byName[designName]; ok && len(design.Decks) > 0 {
			sh.Design = design.Name
			sh.Decks = buildDeckHP(design)
			sh.Physics = computeShipPhysics(design)
			loadStartingFuel(sh)
		}
		f.Ship = sh
		f.ShipClass = designName
	}
}

// loadStartingFuel — заправляет корабль при назначении флоту: водород
// (основной бак, 95%) и гелий-3 (форсажный резерв, 5%) ПО МАССЕ (по прямому
// требованию пользователя, доли исправлены — см. комментарий у
// startFuelHydrogenShare), от условной ёмкости gasStorageFuelCapacity на
// каждое установленное газохранилище (shipphysics.go). Масса водорода/гелия
// разная (economy.go resourceMass) — поэтому доля по массе даёт РАЗНОЕ число
// единиц каждого топлива, не просто 95%/5% от одного и того же счётчика.
// Металлический водород не грузится (0) — см. комментарий у
// gasStorageFuelCapacity.
func loadStartingFuel(sh *Ship) {
	if sh.Physics.GasStorageCount <= 0 {
		return
	}
	totalMass := float64(sh.Physics.GasStorageCount) * gasStorageFuelCapacity
	if hMass := resourceMass("hydrogen"); hMass > 0 {
		sh.FuelHydrogen = totalMass * startFuelHydrogenShare / hMass
	}
	if he3Mass := resourceMass("helium3"); he3Mass > 0 {
		sh.FuelHelium3 = totalMass * startFuelHelium3Share / he3Mass
	}
}

// activeShip — корабль текущего активного флота. Заменяет прежний глобальный
// `ship` во всех обработчиках /api/ship* (main.go).
func activeShip() *Ship {
	for i := range fleets {
		if fleets[i].ID == activeFleetID {
			return fleets[i].Ship
		}
	}
	if len(fleets) > 0 {
		return fleets[0].Ship
	}
	return nil
}

// activateFleet — переключает активный флот. Не запрещаем переключаться в
// полёте/на посадке — у КАЖДОГО флота своё независимое состояние (Transit/
// Landed и т.п.), значит переключение ничему постороннему не мешает.
func activateFleet(id int) bool {
	for i := range fleets {
		if fleets[i].ID == id {
			activeFleetID = id
			return true
		}
	}
	return false
}

// fleetsView — снимок для GET /api/fleets: Current выставляется динамически
// от activeFleetID на каждый запрос (не хранится в fleets[i].Current сам по
// себе — та копия годится только для чтения снаружи пакета через JSON).
func fleetsView() []Fleet {
	out := make([]Fleet, len(fleets))
	for i, f := range fleets {
		f.Current = f.ID == activeFleetID
		out[i] = f
	}
	return out
}
