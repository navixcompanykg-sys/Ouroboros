package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"
)

// ════════════════════════════════════════════════════════════════════════════
// ДЕФОЛТНЫЕ СБОРКИ СТАНЦИЙ — client/ship-deck-sectors.html, отдельная секция
// «СТАНЦИИ» (прямое требование пользователя: «добавь возможность добавлять
// сюда станцию»). Намеренно НЕ в одном списке с shipDefaultShip
// (shipdefaults.go): у станции другая сетка (6×12 вместо 5×7) — сваливать
// это в один массив с обычными кораблями означало бы, что Верфь на планете
// (client/planet.html), которая читает ship_defaults.json КАК ЕСТЬ и рисует
// по Row/Col в предположении сетки 5×7, начала бы получать станционные
// записи, которые ей нечем понять. Отдельный файл/эндпоинт — Верфь станции
// пока не показывает вовсе (не запрошено).
//
// ⚠ ВТОРАЯ ПРАВКА (упрощение поверх первой версии): первая версия вводила
// отдельное «ядро» — специальный супер-отсек 3×5, который бронировался
// целиком или разбивался на 15 обычных клеток, с собственной логикой
// слияния/разбиения. Пользователь отверг это целиком: «всё должно работать
// точно по аналогии с кораблями. Просто можно установить отсек 3 на 5, а ты
// сделал что-то вообще не юзабельное». Теперь станция — БУКВАЛЬНО то же
// самое, что корабль (та же схема {name, decks}, одна клетка — один
// модуль): единственная разница — «отсек 3×5» это ИНСТРУМЕНТ-ШТАМП в
// конструкторе (client/ship-deck-sectors.html), который в один клик строит
// 15 обычных клеток сразу вместо одной — после постройки они ничем не
// отличаются от любой другой клетки, никакого отдельного состояния
// (бронирование/разбиение/привязанный модуль) для них не хранится.
// ════════════════════════════════════════════════════════════════════════════

type stationDefaultShip struct {
	Name  string            `json:"name"`
	Decks []shipDefaultDeck `json:"decks"` // тот же формат, что у обычного корабля — сетка просто больше (6×12)
}

var (
	stationDefaultsMu   sync.RWMutex
	stationDefaultsData []stationDefaultShip
)

const stationDefaultsFile = "station_defaults.json"

// loadStationDefaults — читает station_defaults.json при старте. Если файла
// нет, оставляет пустой список (страница создаст его первым же автосохранением
// — тот же приём, что loadShipDefaults, shipdefaults.go).
func loadStationDefaults() {
	stationDefaultsMu.Lock()
	defer stationDefaultsMu.Unlock()
	b, err := os.ReadFile(stationDefaultsFile)
	if err != nil {
		stationDefaultsData = []stationDefaultShip{}
		return
	}
	var d []stationDefaultShip
	if jerr := json.Unmarshal(b, &d); jerr != nil {
		log.Printf("station_defaults.json повреждён (%v) — начинаю с пустого набора", jerr)
		stationDefaultsData = []stationDefaultShip{}
		return
	}
	stationDefaultsData = d
}

func saveStationDefaultsLocked() {
	b, err := json.MarshalIndent(stationDefaultsData, "", "  ")
	if err != nil {
		log.Printf("не удалось сериализовать station_defaults.json: %v", err)
		return
	}
	if err := os.WriteFile(stationDefaultsFile, b, 0644); err != nil {
		log.Printf("не удалось сохранить station_defaults.json: %v", err)
	}
}

// GET /api/station-defaults — весь список. POST — заменяет целиком (страница
// шлёт весь набор на каждое изменение — тот же приём, что и у обычных
// кораблей, handleShipDefaults).
func handleStationDefaults(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		stationDefaultsMu.RLock()
		defer stationDefaultsMu.RUnlock()
		writeJSON(w, stationDefaultsData)
	case http.MethodPost:
		var body []stationDefaultShip
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "некорректный JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		stationDefaultsMu.Lock()
		stationDefaultsData = body
		saveStationDefaultsLocked()
		stationDefaultsMu.Unlock()
		writeJSON(w, body)
	default:
		http.Error(w, "нужен GET или POST", http.StatusMethodNotAllowed)
	}
}
