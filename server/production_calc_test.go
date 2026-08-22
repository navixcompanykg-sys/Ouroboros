package main

import (
	"sort"
	"testing"
)

// TestFactoriesNeededFor40Mines — разовый расчёт (не постоянная проверка):
// сколько заводов КАЖДОГО типа объективно нужно, чтобы переработать всё, что
// добывают 40 шахт (10 каждого из 4 типов, ТЗ_Экономика.md §7/§9.1 —
// «самодостаточный мир») при новом потолке maxProductionBatchesPerDay=12
// партий/сутки на завод. Официальные суточные цифры добычи (не хекс-рандом —
// каноническое эталонное значение документа), один общий Stock, ОДИН проход
// «раунд-робин пока хоть один рецепт ещё может себе позволить цикл» (без
// суточного/часового потолка — ищем, сколько циклов вообще способно
// переварить это сырьё совместно, раз ресурсы вроде силикатов/инертных
// газов общие сразу для нескольких заводов). Результат — нижняя граница:
// реального разнообразия рецептов (сколько чего производить) тут нет, это
// максимум ПЕРЕРАБОТКИ сырья при полной загрузке.
func TestFactoriesNeededFor40Mines(t *testing.T) {
	stock := map[string]float64{
		"silicates":     570,
		"iron":          422,
		"lightRare":     81,
		"platinoids":    11,
		"inertGases":    107,
		"volcanicGases": 386,
		"radioactives":  5,
		"waterIce":      820,
		"bitumens":      130,
		"refractory":    88,
		"helium3":       7,
		"biomass":       234,
		"phosphates":    277,
		"carbonates":    653,
	}

	tier1 := make([]componentRecipe, 0, 7)
	for _, r := range componentRecipes {
		if r.Tier == 1 {
			tier1 = append(tier1, r)
		}
	}

	cycles := map[string]int{}
	for {
		ranAny := false
		for _, rec := range tier1 {
			if canAffordCycle(stock, rec.Inputs) {
				payCycle(stock, rec.Inputs)
				cycles[rec.Key]++
				ranAny = true
			}
		}
		if !ranAny {
			break
		}
	}

	byFactory := map[string]int{}
	t.Log("── ТУ1: сколько циклов способны переварить 40 шахт (совместно, с учётом общего сырья) ──")
	var keys []string
	for k := range cycles {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		var name, factory string
		for _, r := range componentRecipes {
			if r.Key == k {
				name, factory = r.Name, r.Factory
			}
		}
		t.Logf("    %-28s %4d циклов = %5d шт. (%s)", name, cycles[k], cycles[k]*10, factory)
		byFactory[factory] += cycles[k]
	}

	t.Log("── остаток сырья после максимальной переработки ──")
	var rkeys []string
	for k := range stock {
		rkeys = append(rkeys, k)
	}
	sort.Strings(rkeys)
	for _, k := range rkeys {
		t.Logf("    %-28s %8.1f осталось", economyDisplayName(k), stock[k])
	}

	t.Log("── нужно заводов (циклов/сутки ÷ 12) ──")
	var fkeys []string
	for k := range byFactory {
		fkeys = append(fkeys, k)
	}
	sort.Strings(fkeys)
	for _, f := range fkeys {
		total := byFactory[f]
		needed := (total + maxProductionBatchesPerDay - 1) / maxProductionBatchesPerDay // округление вверх
		t.Logf("    %-28s %4d циклов/сутки → нужно заводов: %d", f, total, needed)
	}
}
