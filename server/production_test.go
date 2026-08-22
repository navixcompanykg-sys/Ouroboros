package main

import (
	"sort"
	"testing"
)

// economyDisplayName — русское название ключа склада для читаемого вывода:
// сначала сырьё (resourceDefs, planets.go), потом компонент (componentRecipes,
// economy.go), иначе — сам ключ как есть.
func economyDisplayName(key string) string {
	for _, rd := range resourceDefs {
		if rd.Key == key {
			return rd.Name
		}
	}
	for _, rec := range componentRecipes {
		if rec.Key == key {
			return rec.Name
		}
	}
	return key
}

// TestProductionDiagnostic — не проверка (без assert'ов), а диагностический
// прогон по прямому запросу пользователя: сколько каких компонентов
// произвела каждая из 4 столичных колоний за 10 суток, сколько пачек по 10
// отработал каждый тип завода (включая ТУ3 — Лабораторию передовых систем),
// и что в итоге на складе. Отдельный Sim (не общий сервер) — можно свободно
// мутировать Planet на месте, никакой конкурентности здесь нет. Запуск:
// go test ./... -run TestProductionDiagnostic -v (вывод — через t.Log,
// виден только с -v).
func TestProductionDiagnostic(t *testing.T) {
	s := NewSim(1)
	forceHabitableCapitals(s)

	objects, _ := s.Snapshot()
	const days = 10
	for _, obj := range objects {
		if obj.Type != "star" {
			continue
		}
		for i := range obj.Planets {
			if len(obj.Planets[i].Buildings) == 0 {
				continue
			}
			runDiagnostic(t, &obj.Planets[i], obj.ID, obj.Faction, days)
		}
	}
}

func runDiagnostic(t *testing.T, planet *Planet, starID int, faction string, days int) {
	t.Logf("════════ %s (звезда #%d, планета #%d, %d зданий) ════════", faction, starID, planet.Index, len(planet.Buildings))

	buildingCounts := map[BuildingType]int{}
	for _, b := range planet.Buildings {
		buildingCounts[b.Type]++
	}
	var btKeys []BuildingType
	for bt := range buildingCounts {
		btKeys = append(btKeys, bt)
	}
	sort.Slice(btKeys, func(i, j int) bool { return btKeys[i] < btKeys[j] })
	t.Log("── состав колонии ──")
	for _, bt := range btKeys {
		t.Logf("    %-18s × %d", bt, buildingCounts[bt])
	}

	before := map[string]float64{}
	for k, v := range planet.Stock {
		before[k] = v
	}
	startPop := planet.Population

	cycleLog := map[BuildingType]map[string]int{}
	for hour := int64(1); hour <= int64(days)*hoursPerDay; hour++ {
		connected := connectedHexes(planet)
		if hour%hoursPerDay == 0 {
			mineDay(planet, connected)
			upkeepDay(planet, connected)
			resetDailyBatches(planet)
			populationDay(planet)
		}
		produceHour(planet, connected, hour, cycleLog)
	}

	t.Logf("население: %d → %d за %d суток", startPop, planet.Population, days)

	t.Log("── пачки по 10, по типу завода и рецепту (включая ТУ3) ──")
	var factoryTypes []BuildingType
	for bt := range cycleLog {
		factoryTypes = append(factoryTypes, bt)
	}
	sort.Slice(factoryTypes, func(i, j int) bool { return factoryTypes[i] < factoryTypes[j] })
	// Показываем ВСЕ 4 типа завода явно, даже если 0 пачек — иначе не видно,
	// какой завод молчал (и почему, см. остаток по его сырью ниже).
	allFactoryTypes := []BuildingType{BuildingFactoryMetal, BuildingFactoryChem, BuildingFactoryElec, BuildingLab}
	for _, bt := range allFactoryTypes {
		if buildingCounts[bt] == 0 {
			continue // такого завода на колонии вообще нет
		}
		recipes := cycleLog[bt]
		var keys []string
		total := 0
		for k, n := range recipes {
			keys = append(keys, k)
			total += n
		}
		sort.Strings(keys)
		t.Logf("%s (%s) — всего %d пачек = %d шт.:", bt, factoryBuildingName[bt], total, total*10)
		for _, k := range keys {
			t.Logf("    %-28s %4d пачек = %5d шт.", economyDisplayName(k), recipes[k], recipes[k]*10)
		}
	}

	t.Logf("── склад: было → стало (%d суток) ──", days)
	all := map[string]bool{}
	for k := range before {
		all[k] = true
	}
	for k := range planet.Stock {
		all[k] = true
	}
	var keys []string
	for k := range all {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		t.Logf("    %-28s %10.1f → %10.1f (Δ %+.1f)", economyDisplayName(k), before[k], planet.Stock[k], planet.Stock[k]-before[k])
	}
}
