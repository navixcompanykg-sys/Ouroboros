# ТЗ: Реестр звёздных систем OUROBOROS
### Модуль: `star_registry.json` + `registry.html`

---

## 1. НАЗНАЧЕНИЕ

Реестр — постоянный файл `star_registry.json`, который ведётся параллельно с симуляцией в `galaxy.html`. Каждая звезда при рождении получает уникальную запись с кодом генерации её планетной системы (GEN-код). При смерти запись дополняется. Просмотр — через отдельную страницу `registry.html`.

---

## 2. ФАЙЛЫ И ИНТЕГРАЦИЯ

```
server/
├── galaxy.html          # Симуляция — пишет события в реестр через POST /registry
├── registry.html        # Таблица реестра — читает через GET /registry, обновляется в онлайн
├── star_registry.json   # Постоянный файл реестра (создаётся при первой звезде)
├── main.go              # Добавить два новых эндпоинта: GET /registry, POST /registry
```

### Новые эндпоинты в `main.go`

| Метод | Путь | Описание |
|---|---|---|
| `GET /registry` | — | Возвращает `star_registry.json` целиком |
| `GET /registry/stream` | — | SSE-поток событий: `init / birth / death / reset` |
| `GET /registry/stats` | — | Статистика реестра (O(n), один проход) |
| `POST /registry/birth` | тело: JSON записи рождения | Добавляет новую запись в реестр |
| `POST /registry/death` | тело: `{id, death_tick, ...}` | Дополняет существующую запись |
| `POST /registry/reset` | — | Очищает реестр (при перегенерации галактики) |

**Формат файла:** массив JSON-объектов, каждый = одна звезда.  
**Запись:** при `POST /registry/birth` — append нового объекта. При `POST /registry/death` — patch по `star_id`.

---

## 3. СТРУКТУРА ЗАПИСИ В РЕЕСТРЕ

### 3.1 Блок рождения (фиксируется один раз, неизменен)

| Поле | Тип | Описание |
|---|---|---|
| `star_id` | int | ID объекта из движка (`o.id`) |
| `birth_tick` | int | Тик рождения (`tick` в момент `checkFormationBirth`) |
| `birth_radius` | float | `o.r` — расстояние от центра галактики (у.е.) |
| `birth_star_type` | string | `red_dwarf` / `yellow_dwarf` / `blue_giant` / `neutron_star` *(белые карлики не регистрируются — они образуются трансформацией существующей звезды, минуя формацию)* |
| `birth_mass` | int | Масса звезды в момент рождения |
| `birth_event` | int (0–4) | Тип события рождения (см. раздел 4.7) |
| `neighbor_gravity_mass` | int | Сумма масс ЧД + НЗ в радиусе 10 у.е. при рождении |
| `neighbor_neb_mass` | int | Сумма масс туманностей в радиусе 5 у.е. при рождении |
| `asteroid_absorbed` | int | Масса астероидов, поглощённых формацией до рождения |
| `birth_temp_env` | float | Средняя температура соседних звёзд в радиусе 5 у.е. + стартовая T самой звезды / 2 |
| `gen_code` | string(9) | GEN-код: `S1S2S3S4S5S6S7S8S9` |
| `n_planets` | int (0–12) | Расчётное число планет |
| `n_rings` | int (0–2) | Расчётное число астероидных колец |

### 3.2 Блок смерти (заполняется при гибели звезды, null до смерти)

| Поле | Тип | Описание |
|---|---|---|
| `death_tick` | int\|null | Тик смерти. null = звезда жива |
| `lifespan` | int\|null | `death_tick - birth_tick` |
| `death_cause` | string\|null | `overheat` / `overcool` / `collision` / `mass_limit` |
| `collision_partner` | string\|null | Тип объекта при столкновении: тип звезды, `black_hole`, `asteroid_field`, `nebula`, `formation` |
| `death_radius` | float\|null | Радиус от центра галактики в момент смерти |
| `mass_at_death` | int\|null | Масса звезды в момент смерти |
| `temp_at_death` | float\|null | Температура в момент смерти |

### Пример записи (живая звезда)

```json
{
  "star_id": 1847,
  "birth_tick": 312,
  "birth_radius": 54.3,
  "birth_star_type": "yellow_dwarf",
  "birth_mass": 420,
  "birth_event": 0,
  "neighbor_gravity_mass": 310,
  "neighbor_neb_mass": 8,
  "asteroid_absorbed": 72,
  "birth_temp_env": 285.0,
  "gen_code": "134131073",
  "n_planets": 8,
  "n_rings": 0,
  "death_tick": null,
  "lifespan": null,
  "death_cause": null,
  "collision_partner": null,
  "death_radius": null,
  "mass_at_death": null,
  "temp_at_death": null
}
```

---

## 4. GEN-КОД: 9 цифр S1–S9

GEN-код — строка из 9 цифр (0–9). Вычисляется один раз при рождении. Используется при загрузке планетной системы игроком.

### 4.1 S1 — Гравитационное давление соседей

**Что:** сумма масс всех ЧД + НЗ в радиусе 10 у.е. в момент рождения  
**Диапазон входа:** 0–3500  
**Формула:** `S1 = min(floor(neighbor_gravity_mass / 350), 9)`

| S1 | Масса соседей | Влияние на систему |
|---|---|---|
| 0 | 0 | Норма, нет возмущений |
| 1–3 | 1–1050 | −1 планета (дальние орбиты нестабильны) |
| 4–6 | 1051–2100 | −2 планеты |
| 7–9 | 2101–3500 | −3 планеты |

### 4.2 S2 — Радиус орбиты

**Что:** `o.r` в момент рождения  
**Диапазон входа:** 0–120 у.е.  
**Формула:** `S2 = min(floor(birth_radius / 12), 9)`

| S2 | Радиус | Влияние |
|---|---|---|
| 0 | 0–12 у.е. | −1 планета (жёсткое гравитационное давление центра) |
| 1 | 12–24 у.е. | Нейтрально |
| 2–5 | 24–72 у.е. | +1 планета (оптимальная зона формирования) |
| 6–9 | 72–120 у.е. | −1 планета, +1 к вероятности кольца |

### 4.3 S3 — Масса звезды при рождении

**Что:** `birth_mass`, предел 1000  
**Диапазон входа:** 51–1000  
**Формула:** `S3 = min(floor((birth_mass - 1) / 100), 9)`

| S3 | Масса | Тип | Влияние |
|---|---|---|---|
| 0–2 | 1–300 | Красный карлик | Нейтрально (красные карлики — стабильные хозяева планет) |
| 3–5 | 301–600 | Жёлтый карлик | +1 планета, оптимальная зона |
| 6–8 | 601–900 | Синий гигант | −2 планеты, мощный звёздный ветер |
| 9 | 901–1000 | Предельная масса | −4 планеты, 0–3 максимум |

> **Правило предела:** если формация набирает > 1000 — звезда не рождается. Формация мгновенно взрывается (supernova) без записи в реестр.

### 4.4 S4 — Астероидная насыщенность

**Что:** масса астероидных полей, поглощённых формацией за 6 тиков до рождения  
**Диапазон входа:** 0–300  
**Формула:** `S4 = min(floor(asteroid_absorbed / 30), 9)`

| S4 | Масса | Влияние |
|---|---|---|
| 0–3 | 0–120 | Нейтрально |
| 4–6 | 121–210 | +1 планета каменистого типа |
| 7–9 | 211–300 | +2 планеты, +1 к кольцам |

### 4.5 S5 — Газовая насыщенность среды

**Что:** сумма масс туманностей в радиусе 5 у.е. в момент рождения  
**Диапазон входа:** 0–40 (туманности 1–5 единиц каждая)  
**Формула:** `S5 = min(floor(neighbor_neb_mass / 4), 9)`

| S5 | Масса | Влияние |
|---|---|---|
| 0–2 | 0–8 | −1 планета, редкие газовые гиганты |
| 3–5 | 9–20 | Норма |
| 6–9 | 21–40 | +1 газовая планета |

### 4.6 S6 — Тепловой фон среды

**Что:** средняя T соседних звёзд в радиусе 5 у.е. + стартовая T самой звезды, делённая на 2  
**Стартовые T по типу:**

| Тип | Стартовая T |
|---|---|
| Красный карлик | 100 |
| Жёлтый карлик | 300 |
| Синий гигант | 700 |
| Нейтронная звезда | 900 |

**Если соседей нет:** `T_среда = 0`, `T_итог = birth_star_T / 2`

**Формула:** `S6 = min(floor(birth_temp_env / 100), 9)`

| S6 | T_итог | Влияние |
|---|---|---|
| 0–2 | 0–200 | Холодная среда: −1 планета в дальней зоне, ледяные тела |
| 3–5 | 201–500 | Норма |
| 6–9 | 501–900 | Горячая среда: −1 планета из внешней зоны |

### 4.7 S7 — Тип события рождения

Определяется в момент `checkFormationBirth` по истории формации:

| S7 | Событие | Как определить | Влияние |
|---|---|---|---|
| 0 | Формация влетела с края галактики | `birth_event_type = 'inflow'` — формация создана через `returnMass` | +1 планета, высокий угловой момент |
| 1 | Формация из столкновения звёзд | `birth_event_type = 'star_collision'` — формация создана в `handleCollision` между двумя звёздами | −1 планета, богато тяжёлыми элементами |
| 2 | Формация из столкновения астероидных масс | `birth_event_type = 'asteroid_collision'` — источник оба объекта asteroid_field | +1 планета каменистого класса, +1 кольцо |
| 3 | Формация из столкновения звезда + астероид/туманность | `birth_event_type = 'star_cloud'` | Норма |
| 4 | Слияние двух формаций | `birth_event_type = 'formation_merge'` — оба объекта TYPE.FORMATION | +1 планета, увеличен разброс орбит |
| 5 | Формация из взрыва белого карлика | `birth_event_type = 'wd_nova'` — белый карлик превысил `WD_NOVA_MASS` (600 у.е.) | Нейтрально |
| 6–9 | Резерв | — | — |

**Реализация:** при создании формации в `galaxy.html` добавить поле `o.birth_event_type` на объект формации. При рождении звезды это поле копируется в запись реестра и кодируется в S7.

### 4.8 S8 — Фазовый сдвиг орбит

**Что:** последняя цифра тика рождения  
**Формула:** `S8 = birth_tick % 10`

Используется при расчёте начального положения планет:  
`θ_планеты(t) = θ₀ + S8 × 36° + ω × (t - birth_tick × 5)`  
*(где 5 сек = длительность тика планетной системы)*

### 4.9 S9 — Контрольная сумма

**Формула:** `S9 = (S1 + S2 + S3 + S4 + S5 + S6 + S7 + S8) % 10`

---

## 5. РАСЧЁТ ЧИСЛА ПЛАНЕТ И КОЛЕЦ

### Формула

```
N_planets = clamp(7 + ΔS1 + ΔS2 + ΔS3 + ΔS4 + ΔS5 + ΔS6 + ΔS7, 0, 12)
```

Среднее при нейтральных параметрах = **7**.

### Таблица корректировок ΔN

| Параметр | Условие | Δ планет |
|---|---|---|
| S1 | 0 | 0 |
| S1 | 1–3 | −1 |
| S1 | 4–6 | −2 |
| S1 | 7–9 | −3 |
| S2 | 0 | −1 |
| S2 | 1 | 0 |
| S2 | 2–5 | +1 |
| S2 | 6–9 | −1 |
| S3 | 0–2 | 0 |
| S3 | 3–5 | +1 |
| S3 | 6–8 | −2 |
| S3 | 9 | −4 |
| S4 | 0–3 | 0 |
| S4 | 4–6 | +1 |
| S4 | 7–9 | +2 |
| S5 | 0–2 | −1 |
| S5 | 3–5 | 0 |
| S5 | 6–9 | +1 |
| S6 | 0–2 | −1 |
| S6 | 3–5 | 0 |
| S6 | 6–9 | −1 |
| S7 | 0 | +1 |
| S7 | 1 | −1 |
| S7 | 2 | +1 |
| S7 | 3 | 0 |
| S7 | 4 | +1 |
| S7 | 5 | 0 |

### Формула числа колец

```
N_rings = clamp(ring_score, 0, 2)

ring_score = 0
  + (S2 >= 6 ? 1 : 0)     // периферия: рассеянный диск → кольца
  + (S4 >= 6 ? 1 : 0)     // много астероидов → кольца
  + (S7 == 2 ? 1 : 0)     // рождение из астероидного столкновения
```

---

## 6. ПРЕДЕЛЬНЫЕ ПРИМЕРЫ

### 🟢 Минимум — «Выжженная зона»
*Синий гигант, центр галактики, рядом ЧД+НЗ, горячая среда*

| Параметр | Значение | Цифра |
|---|---|---|
| neighbor_gravity_mass = 2800 | | S1 = 8 |
| birth_radius = 6 у.е. | | S2 = 0 |
| birth_mass = 870 (BG) | | S3 = 8 |
| asteroid_absorbed = 20 | | S4 = 0 |
| neighbor_neb_mass = 3 | | S5 = 0 |
| birth_temp_env = 680 | | S6 = 6 |
| birth_event = collision BG+BG | | S7 = 1 |
| birth_tick = 431 | | S8 = 1 |
| контрольная сумма | (8+0+8+0+0+6+1+1)=24 | S9 = 4 |

**GEN-код: `808000614`**  
**ΔN:** −3 −1 −2  0 −1 −1 −1 = **−9** → N = clamp(7−9, 0, 12) = **0 планет**  
**Кольца:** S4=0, S7=1 → **0 колец**

---

### 🟡 Норма — «Жёлтый карлик средней зоны»
*Жёлтый карлик, средняя зона, влетел с края*

| Параметр | Значение | Цифра |
|---|---|---|
| neighbor_gravity_mass = 0 | | S1 = 0 |
| birth_radius = 52 у.е. | | S2 = 4 |
| birth_mass = 420 (YD) | | S3 = 4 |
| asteroid_absorbed = 72 | | S4 = 2 |
| neighbor_neb_mass = 8 | | S5 = 2 |
| birth_temp_env = 195 | | S6 = 1 |
| birth_event = inflow | | S7 = 0 |
| birth_tick = 312 | | S8 = 2 |
| контрольная сумма | (0+4+4+2+2+1+0+2)=15 | S9 = 5 |

**GEN-код: `044221025`**  
**ΔN:** 0 +1 +1  0 −1 −1 +1 = **+1** → N = **8 планет**  
**Кольца:** 0

---

### 🔴 Максимум — «Богатая система»
*Жёлтый карлик, средняя зона, слияние формаций, богатый диск*

| Параметр | Значение | Цифра |
|---|---|---|
| neighbor_gravity_mass = 0 | | S1 = 0 |
| birth_radius = 45 у.е. | | S2 = 3 |
| birth_mass = 500 (YD) | | S3 = 4 |
| asteroid_absorbed = 240 | | S4 = 8 |
| neighbor_neb_mass = 32 | | S5 = 8 |
| birth_temp_env = 310 | | S6 = 3 |
| birth_event = formation merge | | S7 = 4 |
| birth_tick = 180 | | S8 = 0 |
| контрольная сумма | (0+3+4+8+8+3+4+0)=30 | S9 = 0 |

**GEN-код: `034883400`**  
**ΔN:** 0 +1 +1 +2 +1 +0 +1 = **+6** → N = clamp(13, 0, 12) = **12 планет**  
**Кольца:** S4=8 ≥ 6 → +1 → **1 кольцо**

---

## 7. ИНТЕГРАЦИЯ В `galaxy.html`

### 7.1 Что добавить на объект формации

При создании формации (функции `returnMass`, `handleCollision`) добавить поле:

```javascript
form.birth_event_type = 'inflow';          // влёт с края
form.birth_event_type = 'star_collision';  // столкновение двух звёзд
form.birth_event_type = 'asteroid_collision'; // столкновение астероидов
form.birth_event_type = 'star_cloud';      // звезда + облако/астероид
form.birth_event_type = 'formation_merge'; // слияние двух формаций

// Счётчик поглощённой массы астероидов (обновляется при каждом поглощении)
form.asteroid_absorbed = 0;
```

### 7.2 Сканирование соседей при рождении

В `checkFormationBirth`, прямо перед записью в реестр — **один проход по массиву objects**:

```javascript
function scanNeighbors(o, radius_gravity=10, radius_neb=5) {
  let grav_mass = 0, neb_mass = 0, temp_sum = 0, temp_count = 0;
  for (const nb of objects) {
    if (nb.id === o.id) continue;
    const d = dist2(o.x, o.y, nb.x, nb.y);
    if (d <= radius_gravity) {
      if (nb.type === TYPE.BLACK_HOLE) grav_mass += nb.mass;
      if (nb.star_type === STAR.NEUTRON) grav_mass += nb.mass;
    }
    if (d <= radius_neb) {
      if (nb.type === TYPE.NEBULA) neb_mass += nb.mass;
      if (nb.type === TYPE.STAR) { temp_sum += nb.temp; temp_count++; }
    }
  }
  const star_base_temp = startTempForStarType(o.star_type);
  const env_temp = temp_count > 0 ? temp_sum / temp_count : 0;
  return {
    neighbor_gravity_mass: grav_mass,
    neighbor_neb_mass: neb_mass,
    birth_temp_env: (star_base_temp + env_temp) / 2
  };
}
```

Сканирование делается **один раз при рождении**. Результат сохраняется в реестр. Повторных вычислений нет.

### 7.3 Функция вычисления GEN-кода

```javascript
function computeGenCode(r) {
  // r = объект с полями рождения
  const S1 = Math.min(Math.floor(r.neighbor_gravity_mass / 350), 9);
  const S2 = Math.min(Math.floor(r.birth_radius / 12), 9);
  const S3 = Math.min(Math.floor((r.birth_mass - 1) / 100), 9);
  const S4 = Math.min(Math.floor(r.asteroid_absorbed / 30), 9);
  const S5 = Math.min(Math.floor(r.neighbor_neb_mass / 4), 9);
  const S6 = Math.min(Math.floor(r.birth_temp_env / 100), 9);
  const S7 = { inflow:0, star_collision:1, asteroid_collision:2,
               star_cloud:3, formation_merge:4, wd_nova:5 }[r.birth_event_type] ?? 9;
  const S8 = r.birth_tick % 10;
  const S9 = (S1+S2+S3+S4+S5+S6+S7+S8) % 10;
  return `${S1}${S2}${S3}${S4}${S5}${S6}${S7}${S8}${S9}`;
}
```

### 7.4 Расчёт числа планет

```javascript
function computePlanets(S1, S2, S3, S4, S5, S6, S7) {
  let n = 7;
  // S1: гравитационное давление соседей — без изменений
  if      (S1 >= 7) n -= 3;
  else if (S1 >= 4) n -= 2;
  else if (S1 >= 1) n -= 1;

  // S2: средняя зона оптимальна (+1), крайние зоны штраф (−1); S2=1 нейтрален
  if      (S2 >= 2 && S2 <= 5) n += 1;
  else if (S2 === 0 || S2 >= 6) n -= 1;

  // S3: маломассивные звёзды больше не штрафуются (красные карлики — стабильные хозяева)
  if      (S3 === 9)           n -= 4;
  else if (S3 >= 6)            n -= 2;
  else if (S3 >= 3 && S3 <= 5) n += 1;

  // S4: только бонус за астероидное богатство; нулевые астероиды не штрафуются; бонусы накапливаются
  if (S4 >= 4) n += 1;
  if (S4 >= 7) n += 1;

  // S5: газовая насыщенность — без изменений
  if      (S5 <= 2) n -= 1;
  else if (S5 >= 6) n += 1;

  // S6: тепловой фон — без изменений
  if      (S6 <= 2) n -= 1;
  else if (S6 >= 6) n -= 1;

  // S7: тип события
  if      (S7 === 0) n += 1;
  else if (S7 === 1) n -= 1;
  else if (S7 === 2) n += 1;
  else if (S7 === 4) n += 1;
  // S7 === 5 (wd_nova): нейтрально, без изменений

  return Math.max(0, Math.min(12, n));
}

function computeRings(S2, S4, S7) {
  let r = 0;
  if (S2 >= 6) r++;
  if (S4 >= 6) r++;
  if (S7 === 2) r++;
  return Math.min(2, r);
}
```

### 7.5 Жизненный цикл белых карликов

Белые карлики **не проходят через формацию** — они образуются трансформацией существующей звезды и не получают записи в реестре при «рождении».

**Образование:** когда красный или жёлтый карлик остывает ниже `DEATH_LIMIT` (10), `checkStarDeath` меняет тип на месте:
```javascript
o.star_type = STAR.WHITE;
o.temp = CFG.T_WHITE;  // 50
o.age = 0;
```

**Без рекласификации:** белый карлик, поглощающий астероиды или туманности, **не превращается обратно** в красный/жёлтый — `starTypeFromMass` для `STAR.WHITE` пропускается.

**Взрыв (новая):** если масса белого карлика достигает `WD_NOVA_MASS` (600 у.е., параметр `config.json → temperature.wd_nova_mass`), вызывается `doWhiteDwarfNova`:
- 12 туманностей разлетаются в радиусе 5 у.е. (откусывают массу первыми)
- 60% остатка → 24 осколка (астероиды, туманности, малые формации)
- 40% остатка → формация с `birth_event_type = 'wd_nova'` и орбитальной скоростью `V_FLAT`

Из этой формации по обычным правилам `checkFormationBirth` может родиться новая звезда (чаще всего красный карлик), которая уже **попадёт в реестр**.

**Счётчики:** смерти белых карликов учитываются в `CNT.deathWD`, `CNT.lifeWD`. В реестре смерть белого карлика не фиксируется (нет записи рождения).

### 7.6 Запись в реестр (вызов из `checkFormationBirth`)

```javascript
async function registerBirth(star, genCode, nPlanets, nRings, neighbors) {
  const record = {
    star_id:               star.id,
    birth_tick:            tick,
    birth_radius:          +star.r.toFixed(2),
    birth_star_type:       star.star_type,
    birth_mass:            star.mass,
    birth_event:           { inflow:0, star_collision:1, asteroid_collision:2,
                             star_cloud:3, formation_merge:4 }[star.birth_event_type] ?? 5,
    neighbor_gravity_mass: neighbors.neighbor_gravity_mass,
    neighbor_neb_mass:     neighbors.neighbor_neb_mass,
    asteroid_absorbed:     star.asteroid_absorbed ?? 0,
    birth_temp_env:        +neighbors.birth_temp_env.toFixed(1),
    gen_code:              genCode,
    n_planets:             nPlanets,
    n_rings:               nRings,
    death_tick:            null,
    lifespan:              null,
    death_cause:           null,
    collision_partner:     null,
    death_radius:          null,
    mass_at_death:         null,
    temp_at_death:         null
  };
  await fetch('/registry/birth', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(record)
  });
}
```

### 7.7 Запись смерти

Вызывать из `doSupernova`, `coolDeath`, `heatDeath` и при столкновении:

```javascript
async function registerDeath(star, cause, partnerType) {
  await fetch('/registry/death', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      star_id:           star.id,
      death_tick:        tick,
      lifespan:          tick - star.birth_tick_registered,  // нужно хранить на объекте
      death_cause:       cause,       // 'overheat' | 'overcool' | 'collision' | 'mass_limit'
      collision_partner: partnerType, // null или тип объекта
      death_radius:      +star.r.toFixed(2),
      mass_at_death:     star.mass,
      temp_at_death:     +star.temp.toFixed(1)
    })
  });
}
```

---

## 8. `registry.html` — СТРАНИЦА РЕЕСТРА

### Концепция

- Открывается как отдельная страница (кнопка в `galaxy.html`)
- При открытии загружает `GET /registry` и `GET /registry/stats`
- Обновляется синхронно с тиком галактики (см. механизм ниже)
- Таблица с фильтрами, сортировкой и поиском по ID

### Колонки таблицы

| Колонка | Поле | Примечание |
|---|---|---|
| ID | `star_id` | |
| Тип | `birth_star_type` | С цветной точкой |
| GEN | `gen_code` | Моноширинный шрифт |
| Планеты | `n_planets` | |
| Кольца | `n_rings` | |
| Масса (рожд.) | `birth_mass` | |
| Радиус (рожд.) | `birth_radius` | |
| Событие | `birth_event` | Текстовый лейбл |
| Тик рожд. | `birth_tick` | |
| Статус | — | 🟢 Живая / 💀 Мёртвая |
| Тик смерти | `death_tick` | — если живая |
| Продолжительность | `lifespan` | — если живая |
| Причина смерти | `death_cause` | — если живая |

### Фильтры

- По типу звезды (чекбоксы)
- Только живые / только мёртвые / все
- Тик рождения: от / до
- Минимальное число планет

### Синхронизация через SSE (Server-Sent Events)

Синхронизация **событийная, без таймеров и опроса**. `registry.html` устанавливает постоянное SSE-соединение с сервером.

**Механизм:** `EventSource('/registry/stream')` — браузер держит открытое HTTP-соединение, сервер отправляет именованные события по мере их возникновения.

| Событие | Когда | Содержимое |
|---|---|---|
| `init` | При подключении | Полный массив `star_registry.json` |
| `birth` | При каждом рождении звезды | JSON-запись рождения |
| `death` | При каждой смерти звезды | JSON-патч (`star_id` + поля смерти) |
| `reset` | При перегенерации галактики | `{}` |

```javascript
// registry.html
const evtSource = new EventSource('/registry/stream');

evtSource.addEventListener('init', e => {
  allRecords = JSON.parse(e.data);
  renderTable();
  updateStatsFromRecords();
});

evtSource.addEventListener('birth', e => {
  const rec = JSON.parse(e.data);
  allRecords.push(rec);
  if (passesFilter(rec))
    document.getElementById('registry-tbody').appendChild(buildRow(rec, ...));
  scheduleStatsUpdate(); // дебаунс 1500ms
});

evtSource.addEventListener('death', e => {
  const patch = JSON.parse(e.data);
  const rec = allRecords.find(r => r.star_id === patch.star_id);
  if (rec) Object.assign(rec, patch);
  // точечное обновление DOM через data-field атрибуты
  const tr = document.querySelector(`#registry-tbody tr[data-id="${patch.star_id}"]`);
  if (tr) { /* обновление конкретных ячеек */ }
  scheduleStatsUpdate();
});

evtSource.addEventListener('reset', () => {
  allRecords = [];
  document.getElementById('registry-tbody').innerHTML = '';
  updateStatsFromRecords();
});
```

**Дельта-рендеринг:** ползунок прокрутки всегда стабилен. Рождения добавляются через `appendChild` в конец tbody. Смерти обновляются точечно через `tr.querySelector('[data-field="..."]')` — без пересборки таблицы.

**Статистика:** пересчитывается на клиенте из `allRecords` с дебаунсом 1500ms. Запрос `GET /registry/stats` не используется из `registry.html`.

Новые строки подсвечиваются зелёным (border-left). Смерти — анимацией `dead-flash`.

---

## 9. СВОДНАЯ СТАТИСТИКА В `registry.html`

Панель статистики отображается над таблицей и пересчитывается при каждом обновлении. Все цифры по **всем записям** реестра, если не указано иное.

### 9.1 Эндпоинт статистики

Статистика вычисляется на сервере — один проход по файлу, O(n). Браузер получает готовый JSON.

```
GET /registry/stats
```

Возвращает:

```json
{
  "tick": 500,
  "total_registered":    2847,
  "total_alive":         1203,
  "total_dead":          1644,

  "avg_planets":         6.8,
  "stars_no_planets":    87,
  "stars_10_12_planets": 34,
  "stars_1_ring":        210,
  "stars_2_rings":       58,

  "by_type": {
    "red_dwarf":    { "alive": 710, "dead": 980 },
    "yellow_dwarf": { "alive": 380, "dead": 490 },
    "blue_giant":   { "alive": 98,  "dead": 162 },
    "neutron_star": { "alive": 15,  "dead": 12  }
  },

  "by_birth_event": {
    "0": 420, "1": 310, "2": 180, "3": 260, "4": 90
  },

  "deaths_by_cause": {
    "overheat":   820,
    "overcool":   310,
    "collision":  490,
    "mass_limit": 24
  }
}
```

### 9.2 Поля статистики

| Поле | Считается по | Описание |
|---|---|---|
| `total_registered` | все записи | Всего записей в реестре (живые + мёртвые) |
| `total_alive` | `death_tick == null` | Звёзд без `death_tick` |
| `total_dead` | `death_tick != null` | Звёзд с `death_tick` |
| `avg_planets` | все записи | Среднее `n_planets`, 1 знак после запятой |
| `stars_no_planets` | все записи | `n_planets == 0` |
| `stars_10_12_planets` | все записи | `n_planets >= 10` |
| `stars_1_ring` | все записи | `n_rings == 1` |
| `stars_2_rings` | все записи | `n_rings == 2` |
| `by_type` | все записи | Живые/мёртвые по каждому типу звезды |
| `by_birth_event` | все записи | Число рождений по типу события 0–4 |
| `deaths_by_cause` | мёртвые | Число смертей по причине |

### 9.3 Макет панели статистики

```
┌─────────────────────────────────────────────────────────────────────┐
│  REGISTRY  ·  Тик 500              ⟳ sync: per tick  [●]  [STOP]   │
├──────────────┬──────────────┬──────────────┬────────────────────────┤
│ ВСЕГО        │ ЖИВЫХ        │ МЁРТВЫХ       │ СРЕДНЕЕ ПЛАНЕТ         │
│ 2847         │ 1203  ●      │ 1644          │ 6.8                    │
├──────────────┴──────────────┴──────────────┴────────────────────────┤
│  Без планет  87  │  10–12 планет  34  │  1 кольцо  210  │  2 кольца  58  │
├────────────────────────────────────────────────────────────────────-┤
│  Смерти: перегрев 820 · переохлаждение 310 · столкновение 490 · предел массы 24  │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.4 Реализация на сервере (Go)

В `main.go` добавить обработчик `GET /registry/stats`:

```go
func registryStatsHandler(w http.ResponseWriter, r *http.Request) {
    data, _ := os.ReadFile("star_registry.json")
    var records []map[string]interface{}
    json.Unmarshal(data, &records)

    alive, dead := 0, 0
    planetsSum, planetsCount := 0, 0
    noP, highP, ring1, ring2 := 0, 0, 0, 0
    byType := map[string]map[string]int{}
    byEvent := map[string]int{}
    byCause := map[string]int{}

    for _, rec := range records {
        isAlive := rec["death_tick"] == nil
        if isAlive { alive++ } else { dead++ }

        np := int(rec["n_planets"].(float64))
        nr := int(rec["n_rings"].(float64))
        planetsSum += np; planetsCount++
        if np == 0 { noP++ }
        if np >= 10 { highP++ }
        if nr == 1 { ring1++ }
        if nr == 2 { ring2++ }

        st := rec["birth_star_type"].(string)
        if byType[st] == nil { byType[st] = map[string]int{} }
        if isAlive { byType[st]["alive"]++ } else { byType[st]["dead"]++ }

        ev := fmt.Sprintf("%v", rec["birth_event"])
        byEvent[ev]++

        if !isAlive {
            cause := fmt.Sprintf("%v", rec["death_cause"])
            byCause[cause]++
        }
    }

    avg := 0.0
    if planetsCount > 0 { avg = math.Round(float64(planetsSum)/float64(planetsCount)*10) / 10 }

    stats := map[string]interface{}{
        "total_registered":    len(records),
        "total_alive":         alive,
        "total_dead":          dead,
        "avg_planets":         avg,
        "stars_no_planets":    noP,
        "stars_10_12_planets": highP,
        "stars_1_ring":        ring1,
        "stars_2_rings":       ring2,
        "by_type":             byType,
        "by_birth_event":      byEvent,
        "deaths_by_cause":     byCause,
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(stats)
}
```

---

## 10. ОБРАБОТКА ПЕРЕГЕНЕРАЦИИ ГАЛАКТИКИ

При нажатии кнопки `⟳ GEN` в `galaxy.html`:
1. `POST /registry/reset` — очищает `star_registry.json` (пишет пустой массив `[]`)
2. Генерация идёт как обычно
3. При начальной генерации все звёзды `galaxy.json` регистрируются через `registerBirth` за один проход (тик = 0, `birth_event = 0` для всех начальных звёзд)

---

## 11. ПРАВИЛО ПРЕДЕЛА МАССЫ > 1000

Если формация при очередном поглощении превышает массу 1000:
- Формация **немедленно взрывается** (supernova) без рождения звезды
- Запись в реестр **не создаётся**
- В счётчик `CNT` добавить `massLimitExplosions++` для статистики

---

## 12. ПРОИЗВОДИТЕЛЬНОСТЬ

- Запросы к `/registry/birth` и `/registry/death` — асинхронные (`await fetch`), не блокируют тик
- При быстром прокручивании (Jump to Tick) — запросы батчируются: отправка раз в 50 тиков или в конце прыжка
- `star_registry.json` хранится на сервере; `registry.html` никогда не пишет напрямую
- `GET /registry/stats` — лёгкий запрос, один O(n) проход. При реестре 10 000+ записей рассмотреть кеш, инвалидируемый при каждом `POST /registry/*`

---

## 13. КОНТРОЛЬНЫЙ СПИСОК РЕАЛИЗАЦИИ

### main.go
- [x] Эндпоинт `GET /registry` — читает и отдаёт `star_registry.json`
- [x] Эндпоинт `GET /registry/stats` — считает и отдаёт статистику
- [x] Эндпоинт `GET /registry/stream` — SSE-поток событий (`init/birth/death/reset`)
- [x] Эндпоинт `POST /registry/birth` — append записи
- [x] Эндпоинт `POST /registry/death` — patch записи по `star_id`
- [x] Эндпоинт `POST /registry/reset` — перезаписывает файл как `[]`

### galaxy.html
- [x] Добавить `birth_event_type` на объект формации при создании
- [x] Добавить `asteroid_absorbed` на объект формации (инкрементировать при поглощении)
- [x] Функция `scanNeighbors(o)` — один проход при рождении
- [x] Функция `computeGenCode(r)` — вычисление кода
- [x] Функции `computePlanets(...)` и `computeRings(...)` (формула обновлена, см. v1.3)
- [x] Вызов `registerBirth(...)` в `checkFormationBirth`
- [x] Вызов `registerBirth(...)` для начальных звёзд при `applyGalaxy`
- [x] Вызов `registerDeath(...)` в `doSupernova`, `coolDeath`, `heatDeath`, `handleCollision`
- [x] Кнопка «REGISTRY» в UI → открывает `registry.html`
- [x] `POST /registry/reset` при `⟳ GEN`
- ~~`localStorage.setItem('ouroboros_tick', tick)`~~ — не используется, заменён SSE

### registry.html
- [x] Панель статистики (клиентский расчёт из `allRecords`, дебаунс 1500ms)
- [x] Таблица с колонками из раздела 8
- [x] Синхронизация через SSE `EventSource('/registry/stream')` — дельта-рендеринг
- [x] Фильтры по типу, статусу, числу планет, поиск по ID
- [x] Подсветка новых записей (зелёный border-left) и смертей (`dead-flash`)
- ~~Переключатель «per tick / every N sec»~~ — не нужен при SSE

---

