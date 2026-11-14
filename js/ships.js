// Корабли: модули, классы, палубы, библиотека готовых дизайнов и расчёт массы/энергии/тяги/топлива.
// Перенос конструктора v2 (client/ship-deck-sectors.html, server/ship_defaults.json, ТЗ_Корабль.md)
// без цен: экономика v3 другая. Массы — ПО УМОЛЧАНИЮ (допущение, т), потом подставим настоящие.
// Используется конструктором (shipyard.html) и полётом в системе (system.js — разгон и топливо).

// Сетка палуб 5 × 7, нос справа. Сектор обстрела каждой палубы задан вручную (v2 MANUAL_SECTOR_ROWS):
// 0 — нос, 1–2 — правый борт, 3 — корма, 4–5 — левый борт, «Ц» — центральная палуба (цитадель).
const DECK_ROWS = 5, DECK_COLS = 7, CITADEL_SECTOR = 6;
const DECK_SECTOR_ROWS = ['3445550', '3345500', '333Ц000', '3321100', '3221110'];
const deckSector = (r, c) => { const ch = DECK_SECTOR_ROWS[r][c]; return ch === 'Ц' ? CITADEL_SECTOR : +ch; };
const SECTOR_NAMES = ['Нос', 'Правый борт (носовой)', 'Правый борт (кормовой)', 'Корма',
  'Левый борт (кормовой)', 'Левый борт (носовой)', 'Центральная палуба (цитадель)'];
// На цитадели всегда стоят жизнеобеспечение и радар (v2, требование пользователя).
const CITADEL_MANDATORY = ['life_support', 'radar'];

// Класс — по числу палуб; чем больше палуб, тем меньше модулей на каждой (ТЗ_Корабль.md §1).
const SHIP_CLASSES = [
  { decks: 1,  perDeck: 8, name: 'Корвет / Шаттл' },
  { decks: 2,  perDeck: 6, name: 'Фрегат / Челнок' },
  { decks: 4,  perDeck: 4, name: 'Эсминец / Клипер' },
  { decks: 6,  perDeck: 4, name: 'Крейсер / Баржа' },
  { decks: 12, perDeck: 3, name: 'Линкор / Лайнер' },
  { decks: 22, perDeck: 2, name: 'Дредноут / Танкер' },
  { decks: 60, perDeck: 1, name: 'Станция / Ковчег' },
];
const shipClass = n => SHIP_CLASSES.find(c => c.decks >= Math.max(1, n)) || SHIP_CLASSES[SHIP_CLASSES.length - 1];

// Модули (ТЗ_Корабль.md §4): прочность 1 — хрупкий, 2 — крепкий; энергия за 60-секундный цикл
// (gen — выработка, active — при действии, passive — постоянно); mass — т, по умолчанию (допущение).
const SHIP_MODULES = [
  { key: 'life_support', name: 'Жизнеобеспечение',      dur: 1, gen: 0,  active: 2,   passive: 2, mass: 20 },
  { key: 'colonist',     name: 'Колониальный модуль',   dur: 1, gen: 0,  active: 2,   passive: 2, mass: 40 },
  { key: 'weapon_mount', name: 'Оружейный модуль',      dur: 2, gen: 0,  active: 1,   passive: 0, mass: 25 },
  { key: 'engine',       name: 'Двигатель',             dur: 2, gen: 0,  active: 5,   passive: 0, mass: 30 },
  { key: 'engine_ion',   name: 'Ионный двигатель',      dur: 2, gen: 0,  active: 100, passive: 0, mass: 35 },
  { key: 'solar_sail',   name: 'Солнечный парус',       dur: 1, gen: 10, active: 0,   passive: 0, mass: 10 },
  { key: 'reactor',      name: 'Атомный реактор',       dur: 2, gen: 40, active: 0,   passive: 0, mass: 45 },
  { key: 'gas_storage',  name: 'Газохранилище',         dur: 2, gen: 0,  active: 0,   passive: 0, mass: 25 },
  { key: 'battery',      name: 'Аккумуляторы',          dur: 1, gen: 0,  active: 0,   passive: 0, mass: 20 },
  { key: 'repair',       name: 'Ремонтный модуль',      dur: 1, gen: 0,  active: 2,   passive: 0, mass: 20 },
  { key: 'teleport',     name: 'Телепорт-модуль',       dur: 1, gen: 0,  active: 40,  passive: 0, mass: 40 },
  { key: 'miner',        name: 'Шахтёр',                dur: 2, gen: 0,  active: 3,   passive: 0, mass: 35 },
  { key: 'radar',        name: 'Радар',                 dur: 1, gen: 0,  active: 1,   passive: 1, mass: 10 },
  { key: 'ecm',          name: 'Модуль РЭБ',            dur: 1, gen: 0,  active: 3,   passive: 0, mass: 12 },
  { key: 'computer',     name: 'Вычислительный модуль', dur: 1, gen: 0,  active: 5,   passive: 5, mass: 15 },
  { key: 'hangar',       name: 'Ангар',                 dur: 2, gen: 0,  active: 0,   passive: 0, mass: 60 },
  { key: 'cargo',        name: 'Грузовой отсек',        dur: 2, gen: 0,  active: 0,   passive: 0, mass: 30 },
];
const SHIP_MODULE = Object.fromEntries(SHIP_MODULES.map(m => [m.key, m]));
const SHIP_FRAME_MASS = 50; // т на палубу (каркас) — по умолчанию
// Солнечная панель объединена с парусом (решение пользователя): остался один «Солнечный парус» —
// он и движитель (слабая тяга без топлива), и источник энергии (gen 10, как бывшая панель).
const isEngine = k => k === 'engine' || k === 'engine_ion' || k === 'solar_sail';

// ---------- Топливо и тяга ----------
// Три топлива — три класса скорости (пользователь): водород — медленные, тритий — средние,
// антиматерия — быстрые. Отношение тяги 1 : 10 : 100 — по ТЗ v2 §2.7.4 (разгон до 200 000 у.е.:
// водородный 10 ч, ядерный 1 ч, на металлическом водороде 6 мин). rel — тяга двигателя на этом
// топливе в долях «тритиевой»; yield — энергии за единицу топлива (газохранилище жжёт ≤ 1 ед. за
// цикл 60 с, v2); tank — единиц на газохранилище (водород и тритий — v2 водород/гелий-3, у антиматерии
// ×10 плотнее — допущение). Топливо — настройка дизайна (d.fuel); нет — водород, у ионных — тритий.
const FUEL = {
  hydrogen:   { name: 'Водород',     tier: 'медленные', rel: 0.1, yield: 10,   tank: 475 },
  tritium:    { name: 'Тритий',      tier: 'средние',   rel: 1,   yield: 100,  tank: 50 },
  antimatter: { name: 'Антиматерия', tier: 'быстрые',   rel: 10,  yield: 1000, tank: 5 },
};
const FUEL_KEYS = Object.keys(FUEL);
const ENERGY_CYCLE = 60;
// Двигатели: ионный — вдвое больше тяги на модуль при ×20 энергии (v2: ионный тянет сильнее,
// но прожорлив — допущение по величине); парус топлива не жжёт и тянет как 1% тритиевого двигателя.
const ENGINE_REL = { engine: 1, engine_ion: 2, solar_sail: 0.01 };
const designFuel = d => FUEL[d.fuel] ? d.fuel : (d.decks.some(x => x[2].includes('engine_ion')) ? 'tritium' : 'hydrogen');

// Средний корабль библиотеки: средняя масса и среднее число «двигателей» (в единицах ENGINE_REL)
// среди дизайнов с двигателями. Калибровка (thrustK): средний корабль на тритии пересекает систему
// (2 × SYSTEM_RADIUS) за SHIP_CROSS_T с с разгоном и торможением (data.js, требование пользователя).
// ЭТАЛОН КАЛИБРОВКИ — отдельная встроенная сборка, не корабль из библиотеки. Раньше средние
// брались по библиотеке, и стоило снять с кораблей оборудование (а это делает пользователь
// в конструкторе), как двигателей не оставалось и калибровка рушилась делением на ноль.
// Эталон — «средний крейсер» прежней библиотеки: 6 палуб, 3 ионных двигателя, 7 реакторов,
// газохранилище, жизнеобеспечение и радар. Менять его = менять масштаб времени во всей игре.
const CAL_SHIP = { name: 'эталон калибровки', decks: [
  [2, 4, ['weapon_mount', 'weapon_mount', 'battery']],
  [2, 5, []],
  [3, 3, ['weapon_mount', 'weapon_mount', 'reactor', 'reactor']],
  [2, 2, ['engine_ion', 'engine_ion', 'engine_ion', 'reactor']],
  [1, 3, ['weapon_mount', 'weapon_mount', 'reactor', 'reactor']],
  [2, 3, ['life_support', 'radar', 'reactor', 'gas_storage']],
] };
let _avg = null;
function avgShip() {
  if (_avg) return _avg;
  const mods = designModules(CAL_SHIP);
  const eng = mods.reduce((s, k) => s + (k === 'solar_sail' ? 0 : ENGINE_REL[k] || 0), 0);
  const mass = CAL_SHIP.decks.length * SHIP_FRAME_MASS + mods.reduce((s, k) => s + SHIP_MODULE[k].mass, 0);
  _avg = { mass, engines: eng || 1, n: 1 };
  return _avg;
}
// ---------- Ускорение, растущее со скоростью ----------
// a(v) = a₀ · (1 + K · u²), u = v/c (корабль «легчает» на разгоне). Отсюда формулы (m — доля тяги на
// торможении, у автопилота 0,85):
//   время разгона 0 → v:      t = c / (a₀·√K) · atan(√K·u)
//   путь разгона/торможения:  s = c² / (2·m·a₀·K) · ln(1 + K·u²)
//   скорость, с которой ещё успеть остановиться на пути s — обратная к пути.
// K и средний a₀ подбираются вместе (calibrate): средний корабль на тритии пересекает систему за
// SHIP_CROSS_T и разгоняется до c за SHIP_LIGHT_T (data.js).
let _cal = null;
function calibrate() {
  if (_cal) return _cal;
  const c = SHIP_LIGHT, D = 2 * SYSTEM_RADIUS;
  let a = 25, K = 100;
  const cross = (a, K) => { const vp = brakeSpeedK(D / 2, a, K, 1); return 2 * timeToSpeedK(vp, a, K) + (vp >= c ? (D - 2 * stopDistK(c, a, K, 1)) / c : 0); };
  for (let it = 0; it < 30; it++) {
    let lo = 0.01, hi = 1e4;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (cross(m, K) > SHIP_CROSS_T) lo = m; else hi = m; }
    a = (lo + hi) / 2;
    lo = 1e-3; hi = 1e6;
    for (let i = 0; i < 80; i++) { const m = Math.sqrt(lo * hi); if (timeToSpeedK(c, a, m) > SHIP_LIGHT_T) lo = m; else hi = m; }
    K = Math.sqrt(lo * hi);
  }
  return (_cal = { a, K });
}
function timeToSpeedK(v, a0, K) { return SHIP_LIGHT / (a0 * Math.sqrt(K)) * Math.atan(Math.sqrt(K) * v / SHIP_LIGHT); }
function stopDistK(v, a0, K, m) { const u = v / SHIP_LIGHT; return SHIP_LIGHT * SHIP_LIGHT / (2 * m * a0 * K) * Math.log(1 + K * u * u); }
function brakeSpeedK(s, a0, K, m) { const x = Math.exp(Math.max(0, s) * 2 * m * a0 * K / (SHIP_LIGHT * SHIP_LIGHT)) - 1; return SHIP_LIGHT * Math.min(1, Math.sqrt(x / K)); }
// Автопилот (пользователь: «полёты естественнее — инерция, развороты, пересчёт курса»):
//  - тяга только вдоль носа, нос разворачивается не быстрее TURN_RATE рад/с — повороты дугой,
//    перед торможением корабль разворачивается кормой вперёд (~2 с на 180°);
//  - торможение планируется на AP_BRAKE доли тяги: начинается раньше и мягче, запас остаётся
//    на разворот и догон графика.
const AP_BRAKE = 0.5, TURN_RATE = 1.6;
// Рабочие формы — с откалиброванным K.
const accelAt = (a0, v) => { const u = v / SHIP_LIGHT; return a0 * (1 + calibrate().K * u * u); };
const timeToSpeed = (a0, v) => a0 > 0 ? timeToSpeedK(v, a0, calibrate().K) : Infinity;
const stopDistance = (v, a0, m = 0.85) => stopDistK(v, a0, calibrate().K, m);
const brakeSpeed = (s, a0, m = 0.85) => brakeSpeedK(s, a0, calibrate().K, m);

let _thrustK = null;
function thrustK() {
  if (_thrustK) return _thrustK;
  _thrustK = calibrate().a * avgShip().mass / avgShip().engines;   // тяга тритиевого двигателя, т·ед./с²
  return _thrustK;
}

// Дизайн: { name, fuel?, decks: [[row, col, [модули…]], …] }.
function designModules(d) {
  const cls = shipClass(d.decks.length), out = [];
  for (const [, , mods] of d.decks) for (const k of mods.slice(0, cls.perDeck)) if (k && SHIP_MODULE[k]) out.push(k);
  return out;
}

// Всё о корабле по дизайну. Ускорение — мировые ед./с² (как SHIP_LIGHT), dv — запас Δv (мировые ед./с;
// Infinity — двигатели кормит реактор, топливо не тратится).
function shipStats(d, fuelKey = designFuel(d)) {
  const cls = shipClass(d.decks.length), mods = designModules(d), F = FUEL[fuelKey], K = thrustK();
  const count = {};
  for (const k of mods) count[k] = (count[k] || 0) + 1;
  const n = k => count[k] || 0;
  let mass = d.decks.length * SHIP_FRAME_MASS, dur = d.decks.length * 3, gen = 0, passive = 0, demand = 0, combat = 0, thrust = 0;
  for (const k of mods) {
    const m = SHIP_MODULE[k];
    mass += m.mass; dur += m.dur; gen += m.gen; passive += m.passive;
    if (k === 'solar_sail') thrust += ENGINE_REL.solar_sail * K;   // парус тянет без топлива
    else if (isEngine(k)) { demand += m.active; thrust += ENGINE_REL[k] * F.rel * K; }
    if (k === 'weapon_mount' || k === 'ecm') combat += m.active;
  }
  const reactor = n('reactor') * SHIP_MODULE.reactor.gen;
  const supply = reactor + n('gas_storage') * F.yield;          // энергии за цикл при сжигании во всех хранилищах
  const ratio = demand > 0 ? Math.min(1, supply / demand) : 1;  // нехватка энергии кратно снижает тягу
  const accel = mass > 0 ? thrust * ratio / mass : 0;
  // Топливо: реактор покрывает спрос первым, газохранилища — остаток.
  const burnPerCycle = Math.max(0, Math.min(demand, supply) - reactor) / F.yield; // ед. топлива за цикл
  const fuelUnits = n('gas_storage') * F.tank;
  const burnTime = burnPerCycle > 0 ? fuelUnits / burnPerCycle * ENERGY_CYCLE : Infinity; // с полной тяги
  const dv = accel > 0 ? burnTime * accel : 0;
  return {
    cls, decks: d.decks.length, slots: d.decks.length * cls.perDeck, modules: mods.length, count,
    mass, durability: dur, energyGen: gen, energyPassive: passive, energyDemand: demand, energyCombat: combat,
    reactor, supply, ratio, thrust, accel, fuelKey, fuelName: F.name, fuelUnits, burnPerCycle, burnTime, dv,
    weapons: n('weapon_mount'), engines: n('engine') + n('engine_ion') + n('solar_sail'),
    battery: n('battery') * 10000, cargo: n('cargo'),
  };
}

// Перевод ускорения в настоящие м/с²: 1 мировая ед./с² = 11,4 км/с за секунду игры (≈ 1,52 сут).
const MS2_PER_UNIT = KMS_PER_UNIT * 1000 / (365.25 * 86400 / 240);

// Расчётная таблица справочника: средний корабль библиотеки на каждом топливе.
function fuelTable() {
  const A = avgShip();
  return FUEL_KEYS.map(k => {
    const F = FUEL[k], a = thrustK() * F.rel * A.engines / A.mass;
    return { key: k, ...F, thrustPerEngine: thrustK() * F.rel, accel: a, ms2: a * MS2_PER_UNIT,
      toLight: timeToSpeed(a, SHIP_LIGHT), cross: travelTime(a, 2 * SYSTEM_RADIUS), hop: travelTime(a, 9 * AU) };
  });
}

// Межзвёздный перелёт: «быстро» — двигатели на полной мощности, «экономно» — на половине (пользователь
// просил выбор; по физике Δv перелёта одинаков при любой тяге, поэтому экономия — через энергетику
// корабля: двигателям нужно вдвое меньше энергии, бо́льшую долю покрывает реактор — бесплатно).
// fuelK — во сколько раз меньше топлива на единицу Δv, чем на полной мощности (0 — всё кормит реактор).
const WARP_MODES = { fast: { name: 'Быстро', p: 1 }, eco: { name: 'Экономно', p: 0.5 } };
function warpFuelK(st, p) {
  const full = Math.max(0, Math.min(st.energyDemand, st.supply) - st.reactor);
  const part = Math.max(0, Math.min(st.energyDemand * p, st.supply) - st.reactor);
  return full > 0 ? part / p / full : 0;
}
// Прикидка межзвёздного перелёта: время разгона до c, торможения и доля бака. Топливо идёт по ВРЕМЕНИ
// работы двигателя (запас st.dv = время горения × a₀): секунда тяги на мощности p стоит a₀·p·fuelK.
function warpEstimate(st, mode) {
  const p = WARP_MODES[mode].p, a = st.accel * p, fk = warpFuelK(st, p);
  const ta = timeToSpeed(a, SHIP_LIGHT), tb = timeToSpeed(AP_BRAKE * a, SHIP_LIGHT);
  return { accel: ta, brake: tb, fuelK: fk, p,
    fuel: isFinite(st.dv) && st.dv > 0 ? st.accel * p * fk * (ta + AP_BRAKE * tb) / st.dv : 0 };
}

// Время перелёта «с места до места» по прямой (разгон до середины — торможение; на скорости света —
// участок по инерции), с ускорением, растущим со скоростью. accel — базовое a₀ корабля.
function travelTime(accel, dist) {
  if (!(accel > 0)) return Infinity;
  const vp = brakeSpeed(dist / 2, accel, 1);
  return 2 * timeToSpeed(accel, vp) + (vp >= SHIP_LIGHT ? Math.max(0, dist - 2 * stopDistance(SHIP_LIGHT, accel, 1)) / SHIP_LIGHT : 0);
}

// ---------- Библиотека готовых кораблей (v2 server/ship_defaults.json, 26 дизайнов) ----------
// Библиотека — ФОРМЫ и КЛАССЫ кораблей (решение пользователя): палубы на месте, оборудования
// нет, кроме цитадели — там всегда жизнеобеспечение и радар. Всё остальное игрок ставит сам
// в конструкторе.
const SHIP_LIBRARY = [
  { name: "Корвет Патрульный", decks: [[2, 3, ["life_support","radar"]]] },
  { name: "Шатл Грузовой", decks: [[2, 3, ["life_support","radar"]]] },
  { name: "Фрегат", decks: [[2, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Челнок", decks: [[2, 2, []], [2, 3, ["life_support","radar"]]] },
  { name: "Эсминец 1", decks: [[2, 4, []], [3, 3, []], [1, 3, []], [2, 3, ["life_support","radar"]]] },
  { name: "Клипер 1", decks: [[3, 3, []], [2, 2, []], [1, 3, []], [2, 3, ["life_support","radar"]]] },
  { name: "Эсминец 2", decks: [[2, 4, []], [2, 5, []], [2, 2, []], [2, 3, ["life_support","radar"]]] },
  { name: "Клипер 2", decks: [[3, 2, []], [2, 2, []], [1, 2, []], [2, 3, ["life_support","radar"]]] },
  { name: "Крейсер 1", decks: [[2, 4, []], [2, 5, []], [3, 3, []], [2, 2, []], [1, 3, []], [2, 3, ["life_support","radar"]]] },
  { name: "Баржа 1", decks: [[3, 3, []], [3, 4, []], [2, 2, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Крейсер 2", decks: [[2, 4, []], [3, 4, []], [3, 2, []], [1, 2, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Баржа 2", decks: [[1, 5, []], [3, 5, []], [3, 4, []], [2, 2, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Лайнер 1", decks: [[1, 5, []], [3, 5, []], [3, 3, []], [3, 4, []], [4, 4, []], [3, 2, []], [2, 2, []], [1, 2, []], [0, 4, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Лайнер 2", decks: [[2, 4, []], [2, 5, []], [3, 3, []], [3, 2, []], [4, 2, []], [1, 1, []], [2, 2, []], [3, 1, []], [0, 2, []], [1, 2, []], [1, 3, []], [2, 3, ["life_support","radar"]]] },
  { name: "Линкор 1", decks: [[1, 5, []], [2, 4, []], [2, 5, []], [3, 5, []], [3, 3, []], [3, 4, []], [3, 2, []], [2, 2, []], [1, 2, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Линкор 2", decks: [[2, 4, []], [3, 3, []], [4, 3, []], [4, 4, []], [4, 5, []], [3, 2, []], [1, 2, []], [0, 3, []], [0, 4, []], [0, 5, []], [1, 3, []], [2, 3, ["life_support","radar"]]] },
  { name: "Дредноут 1", decks: [[0, 6, []], [2, 4, []], [4, 6, []], [3, 3, []], [3, 4, []], [4, 4, []], [4, 5, []], [3, 2, []], [4, 1, []], [1, 0, []], [1, 1, []], [2, 1, []], [2, 2, []], [3, 0, []], [3, 1, []], [0, 1, []], [1, 2, []], [0, 4, []], [0, 5, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Танкер 1", decks: [[1, 5, []], [2, 4, []], [2, 5, []], [2, 6, []], [3, 5, []], [3, 3, []], [3, 4, []], [4, 4, []], [3, 2, []], [4, 2, []], [1, 0, []], [1, 1, []], [2, 1, []], [2, 2, []], [3, 0, []], [3, 1, []], [0, 2, []], [1, 2, []], [0, 4, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Танкер 2", decks: [[2, 4, []], [2, 5, []], [2, 6, []], [3, 3, []], [3, 4, []], [3, 2, []], [4, 1, []], [4, 2, []], [0, 0, []], [1, 0, []], [1, 1, []], [2, 1, []], [2, 2, []], [3, 0, []], [3, 1, []], [4, 0, []], [0, 1, []], [0, 2, []], [1, 2, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Дредноут 2", decks: [[0, 6, []], [1, 5, []], [1, 6, []], [2, 4, []], [2, 5, []], [2, 6, []], [3, 5, []], [3, 6, []], [4, 6, []], [3, 3, []], [3, 4, []], [4, 3, []], [3, 2, []], [1, 1, []], [2, 1, []], [2, 2, []], [3, 1, []], [1, 2, []], [0, 3, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Корвет 2 Боевой", decks: [[2, 3, ["life_support","radar"]]] },
  // Единственный укомплектованный корабль: с него игрок начинает (START_DESIGN), иначе первый
  // же вылет невозможен — у остальных кораблей оборудование снимается игроком самостоятельно.
  { name: "Шатл 2 Скоростной", decks: [[2, 3, ["life_support","radar","engine_ion","reactor","reactor","gas_storage","weapon_mount","cargo"]]] },
  { name: "Фрегат 2", decks: [[2, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Челнок 2", decks: [[2, 2, []], [2, 3, ["life_support","radar"]]] },
  { name: "Дредноут 3", decks: [[1, 5, []], [1, 6, []], [2, 4, []], [2, 5, []], [2, 6, []], [3, 5, []], [3, 6, []], [3, 3, []], [3, 4, []], [4, 3, []], [4, 4, []], [3, 2, []], [4, 2, []], [1, 1, []], [3, 1, []], [0, 2, []], [1, 2, []], [0, 3, []], [0, 4, []], [1, 3, []], [1, 4, []], [2, 3, ["life_support","radar"]]] },
  { name: "Стартовый", decks: [[2, 4, []], [3, 3, []], [2, 2, []], [1, 3, []], [2, 3, ["life_support","radar"]]] },
];

// Дизайны игрока — своя копия библиотеки в браузере (правки конструктора); нет — исходная библиотека.
const SHIPS_KEY = 'ouro.v3.ships';
function loadDesigns() {
  try {
    const s = JSON.parse(localStorage.getItem(SHIPS_KEY));
    // Сохранённые раньше дизайны могут содержать убранные модули: солнечная панель слилась
    // с парусом, защитного поля и стыковочного дока больше нет — такие слоты просто пустеют.
    if (Array.isArray(s) && s.length) {
      for (const d of s) for (const deck of d.decks || [])
        if (Array.isArray(deck.modules)) deck.modules = deck.modules
          .map(k => k === 'solar_panel' ? 'solar_sail' : k)
          .filter(k => !k || SHIP_MODULE[k]);
      return s;
    }
  } catch (_) { /* нет или испорчено */ }
  return JSON.parse(JSON.stringify(SHIP_LIBRARY));
}
function saveDesigns(list) { try { localStorage.setItem(SHIPS_KEY, JSON.stringify(list)); } catch (_) { /* приватный режим */ } }
// Стартовый корабль игрока — самый быстрый из стартового флота v2 (4 малых дизайна), пока игрок
// не выбрал другой в конструкторе.
const START_DESIGN = 'Шатл 2 Скоростной';
function findDesign(name) { const L = loadDesigns(); return L.find(d => d.name === name) || L.find(d => d.name === START_DESIGN) || L[0]; }
