package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"
)

// ════════════════════════════════════════════════════════════════════════════
// ДЕФОЛТНЫЕ СБОРКИ КОРАБЛЕЙ — синхронизация client/ship-deck-sectors.html
// (админ-инструмент, библиотека кораблей) с ВЕРФЬЮ на планете (client/planet.html).
//
// Админ редактирует набор в ship-deck-sectors.html — каждое изменение (клик по
// палубе, выбор модуля, название) сразу шлётся сюда и пишется на диск, точно
// как цены в economy.go. Верфь на планете показывает ВЕСЬ этот список как
// самостоятельные, отдельно выбираемые корабли (не сопоставление с одним из
// 12 канонических классов) — форма палуб и модули каждого берутся ровно
// такими, как в библиотеке. Если игрок нажал «Сохранить» в самой Верфи — его
// конфигурация живёт в localStorage браузера, ОТДЕЛЬНО от этого файла, и
// правки админа её не трогают (localStorage грузится только по явному
// «Загрузить»).
// ════════════════════════════════════════════════════════════════════════════

// shipDefaultShip — один корабль библиотеки: имя карточки (Верфь показывает
// её как отдельный самостоятельный вариант в общем списке — не сопоставление
// с одним из 12 канонических классов, весь перечень библиотеки виден в
// Верфи как есть) + список ЗАНЯТЫХ палуб. Row/Col — координаты на сетке 5×7
// ship-deck-sectors.html: Верфь рисует палубы ИМЕННО по ним (та же
// относительная форма, что в библиотеке), а не по своему старому силуэту
// SHIP_DECK_SHAPES (тот остаётся только запасным вариантом, когда для
// класса вообще нет ни одной записи в библиотеке).
type shipDefaultDeck struct {
	Row     int      `json:"row"`
	Col     int      `json:"col"`
	Modules []string `json:"modules"`
}
type shipDefaultShip struct {
	Name  string            `json:"name"`
	Decks []shipDefaultDeck `json:"decks"`
}

var (
	shipDefaultsMu   sync.RWMutex
	shipDefaultsData []shipDefaultShip
)

const shipDefaultsFile = "ship_defaults.json"

// loadShipDefaults — читает ship_defaults.json при старте. Если файла нет,
// оставляет пустой список (ship-deck-sectors.html создаст его первым же
// автосохранением) — в отличие от economy.go здесь нет вычисляемых значений
// по умолчанию, нечего подставлять, пока админ ничего не заполнил.
func loadShipDefaults() {
	shipDefaultsMu.Lock()
	defer shipDefaultsMu.Unlock()
	b, err := os.ReadFile(shipDefaultsFile)
	if err != nil {
		shipDefaultsData = []shipDefaultShip{}
		return
	}
	var d []shipDefaultShip
	if jerr := json.Unmarshal(b, &d); jerr != nil {
		log.Printf("ship_defaults.json повреждён (%v) — начинаю с пустого набора", jerr)
		shipDefaultsData = []shipDefaultShip{}
		return
	}
	shipDefaultsData = d
}

func saveShipDefaultsLocked() {
	b, err := json.MarshalIndent(shipDefaultsData, "", "  ")
	if err != nil {
		log.Printf("не удалось сериализовать ship_defaults.json: %v", err)
		return
	}
	if err := os.WriteFile(shipDefaultsFile, b, 0644); err != nil {
		log.Printf("не удалось сохранить ship_defaults.json: %v", err)
	}
}

// GET /api/ship-defaults — весь список (Верфь на планете читает его целиком
// и показывает как есть, см. комментарий у shipDefaultShip).
// POST /api/ship-defaults — заменяет список целиком (ship-deck-sectors.html
// шлёт весь свой набор на каждое изменение — как и economy.html, отдельного
// разграничения прав администратора в проекте нет, см. economy.go).
func handleShipDefaults(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		shipDefaultsMu.RLock()
		defer shipDefaultsMu.RUnlock()
		writeJSON(w, shipDefaultsData)
	case http.MethodPost:
		var body []shipDefaultShip
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "некорректный JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		shipDefaultsMu.Lock()
		shipDefaultsData = body
		saveShipDefaultsLocked()
		shipDefaultsMu.Unlock()
		writeJSON(w, body)
	default:
		http.Error(w, "нужен GET или POST", http.StatusMethodNotAllowed)
	}
}
