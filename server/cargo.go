package main

import (
	"errors"
	"math"
	"sync"
	"time"
)

// ════════════════════════════════════════════════════════════════════════════
// ГРУЗОВОЙ ТРЮМ И КОРОБКИ В КОСМОСЕ — окно осмотра корабля (client/ship.html),
// по прямому требованию пользователя: «можно выкинуть из трюма груз в
// космос (появится коробка в открытом космосе, которую можно подобрать),
// привязана всегда к центру клети, если будут другие коробки — будут падать
// в этот бокс и объединяться».
//
// «Клеть» здесь — та же система координат, что Ship.SX/SY (клети текущей
// звёздной системы, ТЗ.md §2.7.4, тот же смысл, что и у screenUE в ship.go),
// округлённая до целого числа — «центр клети». Коробки общие на систему
// (StarID), не привязаны к конкретному флоту — любой корабль в той же
// системе на той же клети может подобрать чужой сброшенный груз, тем же
// принципом «одна галактика на всех», что и остальное состояние проекта.
//
// В игре пока нет ни намайненного сырья, ни торговли — трюм начинает
// ПУСТЫМ и никак не пополняется, кроме подбора чужих коробок (Jettison
// работает только с тем, что уже есть в Cargo). Это честное отражение
// текущего состояния экономики корабля, а не недоделка этого файла.
// ════════════════════════════════════════════════════════════════════════════

// CargoBox — сброшенный в космос груз.
type CargoBox struct {
	ID       int                `json:"id"`
	StarID   int                `json:"starId"`
	CellX    int                `json:"cellX"`
	CellY    int                `json:"cellY"`
	Contents map[string]float64 `json:"contents"`
}

var (
	cargoMu     sync.Mutex
	cargoBoxes  []CargoBox
	nextCargoID = 1
)

func cargoUsed(cargo map[string]float64) float64 {
	sum := 0.0
	for _, v := range cargo {
		sum += v
	}
	return sum
}

// Jettison — списывает amount груза key из трюма, создаёт (или пополняет уже
// существующую на той же клети) коробку рядом с кораблём.
func (sh *Ship) Jettison(key string, amount float64) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if amount <= 0 {
		return errors.New("количество должно быть положительным")
	}
	if sh.Cargo[key] < amount {
		return errors.New("в трюме недостаточно этого груза")
	}
	if sh.Landed {
		return errors.New("нельзя выбросить груз, пока корабль на поверхности")
	}
	sx, sy := sh.effectivePos()
	starID := sh.SystemStarID
	sh.Cargo[key] -= amount
	if sh.Cargo[key] <= 0 {
		delete(sh.Cargo, key)
	}

	cargoMu.Lock()
	defer cargoMu.Unlock()
	cellX, cellY := int(math.Round(sx)), int(math.Round(sy))
	for i := range cargoBoxes {
		b := &cargoBoxes[i]
		if b.StarID == starID && b.CellX == cellX && b.CellY == cellY {
			b.Contents[key] += amount
			return nil
		}
	}
	cargoBoxes = append(cargoBoxes, CargoBox{
		ID: nextCargoID, StarID: starID, CellX: cellX, CellY: cellY,
		Contents: map[string]float64{key: amount},
	})
	nextCargoID++
	return nil
}

// Pickup — подбирает груз с клети, где сейчас находится корабль (целиком, по
// каждому ключу — до заполнения трюма; излишек остаётся в коробке, если
// свободного места не хватило на всё).
func (sh *Ship) Pickup(now time.Time) (map[string]float64, error) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.resolveTransit(now)
	if sh.Transit != nil {
		return nil, ErrShipBusy
	}
	sx, sy := sh.effectivePos()
	starID := sh.SystemStarID
	cellX, cellY := int(math.Round(sx)), int(math.Round(sy))

	cargoMu.Lock()
	defer cargoMu.Unlock()
	idx := -1
	for i := range cargoBoxes {
		if cargoBoxes[i].StarID == starID && cargoBoxes[i].CellX == cellX && cargoBoxes[i].CellY == cellY {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, errors.New("рядом нет груза для подбора")
	}
	box := &cargoBoxes[idx]
	if sh.Cargo == nil {
		sh.Cargo = map[string]float64{}
	}
	free := sh.Physics.CargoCapacity - cargoUsed(sh.Cargo)
	picked := map[string]float64{}
	for k, v := range box.Contents {
		if free <= 0 {
			break
		}
		take := v
		if take > free {
			take = free
		}
		sh.Cargo[k] += take
		box.Contents[k] -= take
		if box.Contents[k] <= 0 {
			delete(box.Contents, k)
		}
		picked[k] = take
		free -= take
	}
	if len(picked) == 0 {
		return nil, errors.New("трюм полон")
	}
	if len(box.Contents) == 0 {
		cargoBoxes = append(cargoBoxes[:idx], cargoBoxes[idx+1:]...)
	}
	return picked, nil
}

// cargoBoxesInStar — снимок коробок в звёздной системе (GET /api/cargo-boxes).
func cargoBoxesInStar(starID int) []CargoBox {
	cargoMu.Lock()
	defer cargoMu.Unlock()
	out := make([]CargoBox, 0)
	for _, b := range cargoBoxes {
		if b.StarID == starID {
			cp := CargoBox{ID: b.ID, StarID: b.StarID, CellX: b.CellX, CellY: b.CellY, Contents: map[string]float64{}}
			for k, v := range b.Contents {
				cp.Contents[k] = v
			}
			out = append(out, cp)
		}
	}
	return out
}
