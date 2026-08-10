package main

import (
	"container/heap"
	"math"
	"math/rand"
	"sync"
)

// ════════════════════════════════════════════════════════════════════════════
// СИМУЛЯЦИЯ СЕКТОРА — авторитетное состояние на сервере.
//
// Позиции аналитические (см. Object.xAt), поэтому сервер НЕ пересчитывает
// объекты каждый кадр. Он держит очередь по времени выхода и обрабатывает
// только тех, чьё время подошло. Стоимость не зависит от ускорения времени:
// на скорости 0.25 мес/с и на 240 мес/с работа одна и та же на игровой месяц.
//
// Оборот объектов (ТЗ.md §2.3): ушедший уничтожается вместе с ID, взамен у
// противоположного края входит НОВЫЙ объект того же класса и той же массы.
// ════════════════════════════════════════════════════════════════════════════

// exitQueue — очередь ближайших выходов за край окна.
type exitQueue []*Object

func (q exitQueue) Len() int           { return len(q) }
func (q exitQueue) Less(i, j int) bool { return q[i].TExit < q[j].TExit }
func (q exitQueue) Swap(i, j int)      { q[i], q[j] = q[j], q[i]; q[i].heapI = i; q[j].heapI = j }
func (q *exitQueue) Push(x any)        { o := x.(*Object); o.heapI = len(*q); *q = append(*q, o) }
func (q *exitQueue) Pop() any {
	old := *q
	n := len(old)
	o := old[n-1]
	old[n-1] = nil
	*q = old[:n-1]
	return o
}

// Event — изменение состава сектора. Клиент применяет их поштучно вместо того,
// чтобы перекачивать весь список объектов.
type Event struct {
	Seq  uint64  `json:"seq"`
	Kind string  `json:"kind"` // spawn | despawn
	At   float64 `json:"at"`   // игровое время события
	ID   int     `json:"id"`
	Obj  *Object `json:"obj,omitempty"`
}

const eventBufSize = 4096

type Sim struct {
	mu      sync.RWMutex
	rng     *rand.Rand
	objects map[int]*Object
	queue   exitQueue
	nextID  int

	events  []Event // кольцевой буфер
	seq     uint64  // номер последнего события
	dropped uint64  // сколько событий вытеснено из буфера

	placed []placedObj   // занятые места для проверки зазора при засеве
	stable []stableWorld // 4 стабильных мира, разложенные по четвертям от сида
}

// placedObj — занятое место в координатах сетки (клети) вместе с радиусом тела
type placedObj struct{ r, x, rad float64 }

func NewSim(seed int64) *Sim {
	s := &Sim{
		rng:     rand.New(rand.NewSource(seed)),
		objects: map[int]*Object{},
		nextID:  1,
		events:  make([]Event, 0, eventBufSize),
	}
	s.seed()
	return s
}

// ── засев (порт client/galaxy.html, правила ТЗ.md §2.1 «144 клетки») ─────────

// clearance — просвет между телом объекта радиуса rad в точке (r, x) и
// ближайшим уже расставленным. Отрицательный результат означает наложение.
// Считаем в клетях по (r, x): окно почти изометрично (истинный радиус 280 при
// размахе 120), поэтому евклидова метрика в клетях здесь корректна.
func (s *Sim) clearance(r, x, rad float64) float64 {
	worst := math.Inf(1)
	for _, p := range s.placed {
		gap := math.Hypot(r-p.r, x-p.x) - (rad + p.rad + minGapCl)
		if gap < worst {
			worst = gap
		}
	}
	return worst
}

// findSpot подбирает орбиту и место на дуге внутри своей клетки так, чтобы
// объект не налез на соседей. Если за seedAttempts попыток свободного места не
// нашлось (плотные зоны 1–2), берём вариант с наибольшим просветом — объект всё
// равно должен быть засеян, правило «ни одна клетка не пустует» (ТЗ.md §2.1)
// важнее идеального зазора.
func (s *Sim) findSpot(z *Zone, col int, rad float64) (float64, float64) {
	var bestR, bestX float64
	bestD := math.Inf(-1)
	for attempt := 0; attempt < seedAttempts; attempt++ {
		r, x := zoneOrbit(s.rng, z), cellX(s.rng, col)
		d := s.clearance(r, x, rad)
		if d >= 0 {
			s.placed = append(s.placed, placedObj{r, x, rad})
			return r, x
		}
		if d > bestD {
			bestD, bestR, bestX = d, r, x
		}
	}
	s.placed = append(s.placed, placedObj{bestR, bestX, rad})
	return bestR, bestX
}

func (s *Sim) add(o *Object) {
	computeExit(o)
	s.objects[o.ID] = o
	if !math.IsInf(o.TExit, 1) {
		heap.Push(&s.queue, o)
	}
}

func (s *Sim) seed() {
	// положение стабильных миров разыгрывается от сида, но по одному на четверть
	s.stable = s.placeStableWorlds()

	// стабильные миры занимают места первыми — остальные не лягут поверх
	for _, w := range s.stable {
		s.placed = append(s.placed, placedObj{w.r, w.x, radStable})
	}

	nebSum, astSum, bhSum := 0.0, 0.0, 0.0
	for _, z := range zones {
		nebSum += z.Density
		astSum += z.Density
		bhSum += z.BhW
	}

	for _, z := range zones {
		nStable := 0
		for _, w := range s.stable {
			if w.zone == z.ID {
				nStable++
			}
		}

		// звёзды — каждая в своём столбце
		for _, col := range assignDistinctColumns(s.rng, z.Stars-nStable, z) {
			r, x := s.findSpot(z, col, radStar)
			st := pickWeighted(s.rng, z.StarW)
			// масса — до планет: от неё зависит период их обращения (Кеплер)
			mass := massInRange(s.rng, starMass[st])
			planets, rings, meteor, sysR := makeStarEnvironment(s.rng, st, r, mass)
			s.add(&Object{
				ID: s.takeID(), Type: "star", StarType: st, Zone: z.ID,
				R: r, X0: x, T0: 0, Arc: arcSpeedAt(r), Rad: radStar,
				Mass: mass, Planets: planets,
				Rings: rings, MeteorActivity: meteor, SystemRadius: sysR,
			})
		}

		// чёрные дыры — сразу за звёздами.
		// Порядок важен: точечные объекты (звёзды, ЧД) немногочисленны, но их
		// нужно уметь ткнуть пальцем по отдельности, поэтому место они выбирают
		// первыми. Когда ЧД сеялись последними, в плотной зоне 1 им уже не
		// хватало свободного места и одна ложилась на туманность.
		nBh := 0
		if bhSum > 0 {
			nBh = int(math.Round(bhTotal * z.BhW / bhSum))
		}
		for _, col := range assignDistinctColumns(s.rng, nBh, z) {
			r, x := s.findSpot(z, col, radBH)
			s.add(&Object{
				ID: s.takeID(), Type: "bh", Zone: z.ID,
				R: r, X0: x, T0: 0, Arc: arcSpeedAt(r), Rad: radBH,
				Mass: massInRange(s.rng, bhMass), Chaotic: z.ID <= 2,
			})
		}

		// туманности — по всем 12 столбцам
		nNeb := int(math.Round(nebTotal * z.Density / nebSum))
		for col, count := range weightedColumnCounts(nNeb, z) {
			for i := 0; i < count; i++ {
				area := 7 + s.rng.Float64()*3
				rad := cloudRadius(area)
				r, x := s.findSpot(z, col, rad)
				s.add(&Object{
					ID: s.takeID(), Type: "neb", Zone: z.ID,
					R: r, X0: x, T0: 0, Arc: arcSpeedAt(r), Rad: rad,
					Mass: area, Size: area,
					Puffs: makeCluster(s.rng, area, 3+s.rng.Intn(2), 1.3),
				})
			}
		}

		// астероидные поля — аналогично
		nAst := int(math.Round(astTotal * z.Density / astSum))
		for col, count := range weightedColumnCounts(nAst, z) {
			for i := 0; i < count; i++ {
				area := 1 + s.rng.Float64()*2
				rad := cloudRadius(area)
				r, x := s.findSpot(z, col, rad)
				s.add(&Object{
					ID: s.takeID(), Type: "ast", Zone: z.ID,
					R: r, X0: x, T0: 0, Arc: arcSpeedAt(r), Rad: rad,
					Mass: area, Size: area,
					Puffs: makeCluster(s.rng, area, 4+s.rng.Intn(3), 0.55),
				})
			}
		}

	}

	// 4 стабильных мира — неподвижная реф. точка, навсегда вне цикла оборота
	for _, w := range s.stable {
		mass := massInRange(s.rng, starMass["yellow"])
		planets, rings, meteor, sysR := makeStarEnvironment(s.rng, "stable", w.r, mass)
		s.add(&Object{
			ID: s.takeID(), Type: "star", StarType: "stable", Faction: w.faction, Role: w.role,
			Zone: w.zone, R: w.r, X0: w.x, T0: 0, Arc: 0,
			Mass: mass, Stable: true, Rad: radStable,
			Planets: planets, Rings: rings, MeteorActivity: meteor, SystemRadius: sysR,
		})
	}
}

func (s *Sim) takeID() int {
	id := s.nextID
	s.nextID++
	return id
}

// entryOrbit — орбита для входящего объекта: та же зона, но своя, и не впритык
// к тем, кто уже стоит у входного края. Правило зазора то же, что при засеве
// (findSpot), только сравниваемся с живыми соседями на текущий момент времени,
// а не с таблицей занятых мест — состав сектора успел смениться.
func (s *Sim) entryOrbit(z *Zone, rad, entry, now float64) float64 {
	best := zoneOrbit(s.rng, z)
	bestD := math.Inf(-1)
	for attempt := 0; attempt < entryAttempts; attempt++ {
		r := zoneOrbit(s.rng, z)
		worst := math.Inf(1)
		for _, o := range s.objects {
			ox := o.xAt(now)
			if ox > 25 {
				continue // сравниваемся только с соседями у входного края
			}
			gap := math.Hypot(r-o.R, entry-ox) - (rad + o.Rad + minGapCl)
			if gap < worst {
				worst = gap
			}
		}
		if worst >= 0 {
			return r
		}
		if worst > bestD {
			bestD, best = worst, r
		}
	}
	return best
}

// spawnReplacing — новый объект взамен ушедшего: тот же класс и ТА ЖЕ масса,
// но новый ID, своя орбита и заново собранный состав.
func (s *Sim) spawnReplacing(gone *Object, at float64) *Object {
	z := zones[gone.Zone-1]
	// габарит известен заранее: класс и масса переносятся от ушедшего, а у
	// туманностей и астероидных полей масса — это и есть площадь (ТЗ.md §2.11)
	rad := radStar
	switch gone.Type {
	case "bh":
		rad = radBH
	case "neb", "ast":
		rad = cloudRadius(gone.Mass)
	}
	entry := entryX - s.rng.Float64()*4
	r := s.entryOrbit(z, rad, entry, at)
	o := &Object{
		ID: s.takeID(), Type: gone.Type, Zone: z.ID,
		R: r, X0: entry, T0: at, Arc: arcSpeedAt(r), Rad: rad,
		Mass: gone.Mass,
	}
	switch gone.Type {
	case "star":
		o.StarType = starTypeForMass(s.rng, z.StarW, gone.Mass)
		// планеты, кольца и метеоритная активность у вошедшей звезды свои:
		// другой тип светила и другая орбита в галактике дают другой состав
		// недр (ТЗ.md §2.5) и другую историю системы
		// масса переносится от ушедшей звезды (возврат массы, ТЗ.md §2.3) —
		// она же задаёт период обращения планет новой системы
		o.Planets, o.Rings, o.MeteorActivity, o.SystemRadius = makeStarEnvironment(s.rng, o.StarType, r, gone.Mass)
	case "bh":
		o.Chaotic = z.ID <= 2
	case "neb":
		o.Size = gone.Mass
		o.Puffs = makeCluster(s.rng, gone.Mass, 3+s.rng.Intn(2), 1.3)
	case "ast":
		o.Size = gone.Mass
		o.Puffs = makeCluster(s.rng, gone.Mass, 4+s.rng.Intn(3), 0.55)
	}
	return o
}

func (s *Sim) pushEvent(e Event) {
	s.seq++
	e.Seq = s.seq
	if len(s.events) >= eventBufSize {
		copy(s.events, s.events[1:])
		s.events = s.events[:len(s.events)-1]
		s.dropped++
	}
	s.events = append(s.events, e)
}

// maxTurnoverPerAdvance — предохранитель от зависания при абсурдном ускорении:
// за один шаг обрабатываем не больше стольких смен объектов.
const maxTurnoverPerAdvance = 20000

// Advance доводит состав сектора до игрового времени now: всех, чьё время
// выхода уже наступило, уничтожает и заменяет новыми. Обрабатывает строго в
// хронологическом порядке, поэтому результат не зависит от того, за сколько
// шагов сервер дошёл до now — прогон на паузе с рывком даёт то же, что ровный.
func (s *Sim) Advance(now float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for n := 0; n < maxTurnoverPerAdvance; n++ {
		if len(s.queue) == 0 || s.queue[0].TExit > now {
			return
		}
		gone := heap.Pop(&s.queue).(*Object)
		at := gone.TExit
		delete(s.objects, gone.ID)
		s.pushEvent(Event{Kind: "despawn", At: at, ID: gone.ID})

		fresh := s.spawnReplacing(gone, at)
		s.add(fresh)
		s.pushEvent(Event{Kind: "spawn", At: at, ID: fresh.ID, Obj: fresh})
	}
}

// Object возвращает объект по ID — используется кораблём (ship.go) для
// разрешения цели навигации (звезда/её планеты). Объекты неизменны после
// создания (Advance заменяет их целиком, а не мутирует поля), поэтому
// возвращённый указатель безопасно читать и после отпускания блокировки.
func (s *Sim) Object(id int) (*Object, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	o, ok := s.objects[id]
	return o, ok
}

// Snapshot — полный состав сектора. Клиент берёт его при подключении и дальше
// живёт на событиях.
func (s *Sim) Snapshot() ([]*Object, uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Object, 0, len(s.objects))
	for _, o := range s.objects {
		out = append(out, o)
	}
	// стабильный порядок по ID — иначе клиент каждый раз перестраивает слой заново
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, s.seq
}

// EventsSince возвращает события после since. Второе значение — признак того,
// что клиент отстал сильнее, чем хранит буфер, и ему нужен полный снимок.
func (s *Sim) EventsSince(since uint64) ([]Event, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.events) == 0 {
		return nil, false
	}
	oldest := s.events[0].Seq
	if since+1 < oldest {
		return nil, true // часть событий уже вытеснена — нужен resync
	}
	out := make([]Event, 0, 32)
	for _, e := range s.events {
		if e.Seq > since {
			out = append(out, e)
		}
	}
	return out, false
}

// Stats — сводка для диагностики и тестов.
type Stats struct {
	Count     int            `json:"count"`
	ByType    map[string]int `json:"byType"`
	TotalMass float64        `json:"totalMass"`
	NextID    int            `json:"nextId"`
	Seq       uint64         `json:"seq"`
	Dropped   uint64         `json:"dropped"`
}

func (s *Sim) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := Stats{ByType: map[string]int{}, NextID: s.nextID, Seq: s.seq, Dropped: s.dropped}
	for _, o := range s.objects {
		st.Count++
		st.ByType[o.Type]++
		st.TotalMass += o.Mass
	}
	return st
}
