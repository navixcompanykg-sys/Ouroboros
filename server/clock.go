package main

import (
	"sync"
	"time"
)

// ════════════════════════════════════════════════════════════════════════════
// ЕДИНЫЕ ЧАСЫ СИМУЛЯЦИИ
//
// Сервер — единственный источник игрового времени. Клиент никогда не считает
// время сам: он спрашивает у сервера «сколько сейчас месяцев» и между
// синхронизациями лишь экстраполирует по известной скорости.
//
// Ускорение для тестов меняет ТОЛЬКО множитель speed — сколько игровых месяцев
// проходит за одну реальную секунду. Способ счёта при этом не меняется: за
// секунду просто происходит больше, чем обычно. Поэтому «ускоренный» и
// «обычный» прогон дают одинаковую картину на одном и том же игровом времени.
//
// months монотонно растёт и никогда не сбрасывается — даже при смене скорости
// и при паузе (speed = 0). Накопление идёт по фактически прошедшему реальному
// времени, а не по номиналу тика, поэтому дрожание таймера ОС не копится в
// ошибку: months += speed × (now − last).
// ════════════════════════════════════════════════════════════════════════════

// tickHz — частота внутреннего таймера сервера. На точность не влияет (шаг
// считается по реальному времени), задаёт лишь зернистость, с которой сервер
// знает своё время между запросами.
const tickHz = 20

type Clock struct {
	mu     sync.RWMutex
	months float64   // накопленное игровое время, месяцы — монотонно
	speed  float64   // игровых месяцев за реальную секунду (0 = пауза)
	last   time.Time // момент последнего накопления
	epoch  time.Time // старт сервера — для диагностики
	ticks  uint64    // сколько раз сработал внутренний таймер
}

type Snapshot struct {
	Months  float64 `json:"months"`  // игровое время сейчас
	Speed   float64 `json:"speed"`   // месяцев за реальную секунду
	Ticks   uint64  `json:"ticks"`   // тиков внутреннего таймера с запуска
	Uptime  float64 `json:"uptime"`  // реальных секунд с запуска
	StampMs int64   `json:"stampMs"` // серверное время отправки, мс — для замера задержки
}

func NewClock(speed float64) *Clock {
	now := time.Now()
	return &Clock{speed: speed, last: now, epoch: now}
}

// advance накапливает игровое время по фактически прошедшему реальному.
// Вызывается под замком.
func (c *Clock) advance(now time.Time) {
	dt := now.Sub(c.last).Seconds()
	if dt < 0 {
		dt = 0 // защита от скачка системных часов назад
	}
	c.months += c.speed * dt
	c.last = now
}

// Run — внутренний таймер сервера. Идёт всегда, независимо от того, подключён
// ли хоть один клиент: игровое время течёт само по себе, а не «пока кто-то смотрит».
func (c *Clock) Run(stop <-chan struct{}) {
	t := time.NewTicker(time.Second / tickHz)
	defer t.Stop()
	for {
		select {
		case now := <-t.C:
			c.mu.Lock()
			c.advance(now)
			c.ticks++
			c.mu.Unlock()
		case <-stop:
			return
		}
	}
}

func (c *Clock) Snapshot() Snapshot {
	now := time.Now()
	c.mu.Lock()
	c.advance(now) // досчитываем до текущего момента, чтобы ответ не отставал на полтика
	s := Snapshot{
		Months:  c.months,
		Speed:   c.speed,
		Ticks:   c.ticks,
		Uptime:  now.Sub(c.epoch).Seconds(),
		StampMs: now.UnixMilli(),
	}
	c.mu.Unlock()
	return s
}

// SetSpeed меняет множитель ускорения. Накопленное время сначала фиксируется по
// старой скорости, поэтому переключение не создаёт ни скачка, ни потери времени.
func (c *Clock) SetSpeed(speed float64) Snapshot {
	if speed < 0 {
		speed = 0
	}
	if speed > maxSpeed {
		speed = maxSpeed
	}
	now := time.Now()
	c.mu.Lock()
	c.advance(now)
	c.speed = speed
	s := Snapshot{Months: c.months, Speed: c.speed, Ticks: c.ticks,
		Uptime: now.Sub(c.epoch).Seconds(), StampMs: now.UnixMilli()}
	c.mu.Unlock()
	return s
}

// maxSpeed — предохранитель: за один реальный час на этой скорости пройдёт
// ~1000 игровых лет. Выше — заведомо опечатка в запросе.
const maxSpeed = 240
