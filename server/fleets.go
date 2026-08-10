package main

// ══════════════════════════════════════════════════════════════════════════
// ФЛОТЫ ИГРОКА
//
// Механика нескольких кораблей под игроком не описана в ТЗ.md — здесь только
// раскладка «где чьи флоты стоят»: по одному на каждый из 4 стабильных миров
// (столица + 3 вассала, см. galaxy.go placeStableWorlds). Реально летает
// только ТЕКУЩИЙ флот (Current==true) — это тот же самый глобальный `ship`
// (ship.go), с которым сервер всегда стартует в столице. Три остальных —
// гарнизоны на орбите родного мира: они не двигаются, поэтому и не нужно
// разыгрывать вокруг них целый мир (Transit, орбиты планет и т.п.) — только
// эти несколько статичных полей. Кнопки ◀▶ на карте сектора (galaxy.html)
// листают список для обзора; управление чужими флотами — вопрос будущих ТЗ.
// ══════════════════════════════════════════════════════════════════════════

type Fleet struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	ShipClass  string `json:"shipClass"`
	HomeStarID int    `json:"homeStarId"`
	Current    bool   `json:"current"` // управляемый игроком флот — тот же объект, что ship.go
}

var fleets []Fleet

// initFleets раскладывает флоты по стабильным мирам детерминированно от сида
// (порядок вассалов уже перемешан в placeStableWorlds). Столица всегда несёт
// текущий/управляемый флот — так совпадает со стартовой позицией ship.go.
func initFleets(sim *Sim) {
	objects, _ := sim.Snapshot()
	var capitalID int
	vassalIDs := make([]int, 0, 3)
	for _, o := range objects {
		switch o.Role {
		case "capital":
			capitalID = o.ID
		case "vassal":
			vassalIDs = append(vassalIDs, o.ID)
		}
	}

	fleets = make([]Fleet, 0, 4)
	fleets = append(fleets, Fleet{
		ID: 0, Name: `1-й флот «Скиталец»`, ShipClass: `Крейсер «Аврора»`,
		HomeStarID: capitalID, Current: true,
	})
	names := []string{`2-й флот «Тень»`, `3-й флот «Кузня»`, `4-й флот «Застава»`}
	classes := []string{`Разведчик «Игла»`, `Транспорт «Ковчег»`, `Корвет «Секира»`}
	for i, starID := range vassalIDs {
		if i >= len(names) {
			break
		}
		fleets = append(fleets, Fleet{
			ID: i + 1, Name: names[i], ShipClass: classes[i],
			HomeStarID: starID, Current: false,
		})
	}
}
