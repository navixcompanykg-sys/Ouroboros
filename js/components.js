// Универсальный конструктор: сырьё → компоненты → оборудование → корабль.
//
// ГЛАВНОЕ (модель пользователя): параметры принадлежат КОМПОНЕНТАМ, а не оборудованию.
// У оборудования задаётся только СОСТАВ — сколько компонентов каждого типа в него входит.
// Свойства оборудования не вводятся, а выводятся: параметр = Σ (кол-во компонентов × влияние
// компонента на этот параметр). Уровень компонентов меняет влияние — значит, и свойства предмета.
// Поэтому новое оборудование добавляется одной строкой состава: все характеристики появятся сами.
//
// Числа влияния и составы вносит ПОЛЬЗОВАТЕЛЬ (components.html, localStorage 'ouro.v3.parts').
// В коде — только структура и расчёт. Исключение — масса: она считается из массы сырья (правило v2).

// ---------- Сырьё: 4 типа × 3 уровня (ровно группы RESOURCES из таблицы пользователя) ----------
const MAT_TYPES = [
  { key: 'struct',  name: 'Конструктивный',  group: 'Структурные',    res: ['silicates', 'rareEarth', 'superdense'] },
  { key: 'compute', name: 'ЭВМ',             group: 'Вычисления',     res: ['silicon', 'niobium', 'isotopes'] },
  { key: 'bio',     name: 'Биохимический',   group: 'Биомасса',       res: ['microbiota', 'flora', 'bitumen'] },
  { key: 'energy',  name: 'Энергетический',  group: 'Энергоносители', res: ['hydrogen', 'tritium', 'antimatter'] },
];
const MAT_TYPE = Object.fromEntries(MAT_TYPES.map(m => [m.key, m]));
const TIERS = [1, 2, 3];

// Сборка компонента из сырья СВОЕГО типа (решение пользователя): need — сколько сырья
// 1-го/2-го/3-го уровня уходит на один компонент этого уровня.
const CRAFT = [
  { tier: 1, need: [3, 0, 0], text: '3 × сырьё 1 ур.' },
  { tier: 2, need: [1, 2, 0], text: '2 × сырьё 2 ур. + 1 × сырьё 1 ур.' },
  { tier: 3, need: [1, 1, 1], text: '1 × сырьё 1 ур. + 1 × 2 ур. + 1 × 3 ур.' },
];

// ---------- Масса: единственный параметр, который не вводят ----------
// v2 (server/economy.go resolveComponent, ТЗ_Экономика.md §8.3): масса 1 шт =
// (Σ масс сырья на цикл × 0,8) / 10 — 20% массы уходит в отходы, выход партии 10 шт.
// В v3 рецепт даёт ОДНУ штуку, поэтому деление на партию не переносим — остаётся потеря.
const CRAFT_LOSS = 0.2;
const rawMass = key => { const r = RESOURCES.find(x => x.key === key); return r ? r.mass : 0; };
// Масса одного компонента типа matKey уровня tier — это и есть его «влияние на массу».
function componentMass(matKey, tier) {
  const m = MAT_TYPE[matKey]; if (!m) return 0;
  return CRAFT[tier - 1].need.reduce((s, q, i) => s + q * rawMass(m.res[i]), 0) * (1 - CRAFT_LOSS);
}
// Сырьё на один предмет: состав × рецепт компонента.
function rawPerItem(comp, tier) {
  const out = {};
  for (const m of MAT_TYPES) out[m.key] = CRAFT[tier - 1].need.map(x => x * (comp[m.key] || 0));
  return out;
}

// ---------- Параметры: общий список для ВСЕГО оборудования ----------
// Универсальный конструктор: параметры одни и те же у всего, разным оборудование делает состав.
// agg — как параметр собирается в итог корабля (sum — сложить, thrust/turn — «на 100 т»).
const PARAMS = [
  { key: 'mass',     name: 'Масса',                            unit: 'т',       dec: 1, derived: true },
  { key: 'dur',      name: 'Прочность',                        unit: '',        dec: 1 },
  { key: 'rad',      name: 'Радиозащита',                      unit: '',        dec: 1 },
  { key: 'heat',     name: 'Тепловая защита',                  unit: '',        dec: 1 },
  { key: 'accel100', name: 'Ускорение/торможение на 100 т',    unit: 'ед./с²',  dec: 3 },
  { key: 'turn100',  name: 'Угол поворота в секунду на 100 т', unit: '°/с',     dec: 2 },
  { key: 'dmg',      name: 'Урон',                             unit: '',        dec: 1 },
  { key: 'range',    name: 'Дальность',                        unit: 'ед.',     dec: 0 },
  { key: 'enGen',    name: 'Выработка энергии',                unit: 'за цикл', dec: 1 },
  { key: 'enActive', name: 'Расход энергии активно',           unit: 'за цикл', dec: 1 },
  { key: 'enPassive',name: 'Расход энергии пассивно',          unit: 'за цикл', dec: 1 },
  { key: 'cap',      name: 'Ёмкость (груз, топливо, энергия)', unit: 'ед.',     dec: 0 },
];
const PARAM = Object.fromEntries(PARAMS.map(p => [p.key, p]));

// ---------- Оборудование: только название и состав ----------
// key совпадает с ключами модулей ships.js — дизайны из конструктора считаются напрямую.
const PART_GROUPS = [
  { key: 'hull',    name: 'Корпус' },
  { key: 'drive',   name: 'Двигатели' },
  { key: 'power',   name: 'Энергетика' },
  { key: 'combat',  name: 'Боевые системы' },
  { key: 'guns',    name: 'Орудия (ставятся в оружейный модуль)' },
  { key: 'service', name: 'Служебные модули' },
];
const PARTS = [
  { key: 'frame',        group: 'hull',    name: 'Каркас палубы', note: 'ставится сам на каждую палубу' },
  { key: 'engine',       group: 'drive',   name: 'Двигатель' },
  { key: 'engine_ion',   group: 'drive',   name: 'Ионный двигатель' },
  { key: 'solar_sail',   group: 'drive',   name: 'Солнечный парус' },
  { key: 'reactor',      group: 'power',   name: 'Атомный реактор' },
  { key: 'solar_panel',  group: 'power',   name: 'Солнечная панель' },
  { key: 'gas_storage',  group: 'power',   name: 'Газохранилище' },
  { key: 'battery',      group: 'power',   name: 'Аккумуляторы' },
  { key: 'weapon_mount', group: 'combat',  name: 'Оружейный модуль', note: 'место под орудие' },
  { key: 'shield',       group: 'combat',  name: 'Защитное поле' },
  { key: 'ecm',          group: 'combat',  name: 'Модуль РЭБ' },
  { key: 'gun_autocannon', group: 'guns',  name: 'Автопушка' },
  { key: 'gun_railgun',    group: 'guns',  name: 'Рельсотрон' },
  { key: 'gun_laser',      group: 'guns',  name: 'Лазер' },
  { key: 'gun_plasma',     group: 'guns',  name: 'Плазмапушка' },
  { key: 'gun_missile',    group: 'guns',  name: 'Ракеты' },
  { key: 'gun_torpedo',    group: 'guns',  name: 'Торпеды' },
  { key: 'gun_emp',        group: 'guns',  name: 'ЭМИ-пушка' },
  { key: 'gun_tractor',    group: 'guns',  name: 'Луч захвата' },
  { key: 'life_support', group: 'service', name: 'Жизнеобеспечение' },
  { key: 'colonist',     group: 'service', name: 'Колониальный модуль' },
  { key: 'radar',        group: 'service', name: 'Радар' },
  { key: 'computer',     group: 'service', name: 'Вычислительный модуль' },
  { key: 'teleport',     group: 'service', name: 'Телепорт-модуль' },
  { key: 'miner',        group: 'service', name: 'Шахтёр' },
  { key: 'repair',       group: 'service', name: 'Ремонтный модуль' },
  { key: 'cargo',        group: 'service', name: 'Грузовой отсек' },
  { key: 'dock',         group: 'service', name: 'Стыковочный док' },
  { key: 'hangar',       group: 'service', name: 'Ангар' },
];
const PART = Object.fromEntries(PARTS.map(p => [p.key, p]));

// ---------- Энергоёмкость топлива ----------
// Энергетическое сырьё — это и есть топливо: водород (1 ур.), тритий (2 ур.), антиматерия (3 ур.).
// Сжигая ОДНУ единицу за цикл, газохранилище выдаёт столько энергии, сколько задано здесь;
// дальше эта энергия тратится оборудованием корабля наравне с выработкой реакторов.
// По умолчанию — числа, которые уже работают в игре (FUEL.yield в ships.js: 10 / 100 / 1000).
const FUEL_RES = MAT_TYPE.energy.res;                       // ключи RESOURCES по уровням
const FUEL_ENERGY_DEFAULT = FUEL_KEYS.map(k => FUEL[k].yield);
// Сколько энергии за цикл даёт одно газохранилище на топливе уровня tier.
const fuelEnergy = (tbl, tier) => +(tbl.fuel || [])[tier - 1] || 0;

// ---------- Хранилище: влияние компонентов + составы оборудования ----------
// inf[типКомпонента][параметр] = [ур1, ур2, ур3] — влияние ОДНОГО компонента на параметр.
// comp[оборудование][типКомпонента] = сколько штук входит (от уровня не зависит).
const PARTS_KEY = 'ouro.v3.parts';
function blankParts() {
  const inf = {}, comp = {};
  for (const m of MAT_TYPES) {
    inf[m.key] = {};
    for (const p of PARAMS) inf[m.key][p.key] = TIERS.map(t => p.derived ? componentMass(m.key, t) : null);
  }
  for (const p of PARTS) { comp[p.key] = {}; for (const m of MAT_TYPES) comp[p.key][m.key] = null; }
  return { inf, comp, fuel: FUEL_ENERGY_DEFAULT.slice() };
}
function loadParts() {
  const base = blankParts();
  try {
    const s = JSON.parse(localStorage.getItem(PARTS_KEY));
    if (s && s.inf) for (const t in base.inf) for (const p in base.inf[t])
      if (!PARAM[p].derived && s.inf[t] && Array.isArray(s.inf[t][p])) base.inf[t][p] = s.inf[t][p].slice(0, 3);
    if (s && s.comp) for (const k in base.comp) for (const t in base.comp[k])
      if (s.comp[k] && s.comp[k][t] !== undefined) base.comp[k][t] = s.comp[k][t];
    if (s && Array.isArray(s.fuel)) base.fuel = s.fuel.slice(0, 3);
  } catch (_) { /* нет или испорчено — пустой шаблон */ }
  return base;
}
function saveParts(t) { try { localStorage.setItem(PARTS_KEY, JSON.stringify(t)); } catch (_) { /* приватный режим */ } }

// Влияние одного компонента типа t на параметр p при уровне tier.
const influence = (tbl, t, p, tier) => {
  if (PARAM[p] && PARAM[p].derived) return componentMass(t, tier);   // масса — из сырья
  const a = tbl.inf[t] && tbl.inf[t][p];
  return a ? (+a[tier - 1] || 0) : 0;
};
// ГЛАВНАЯ ФОРМУЛА: параметр оборудования = Σ (компонентов в составе × влияние компонента).
// Масса дополнительно теряет CRAFT_LOSS при сборке — передел, как и у компонента (правило v2).
function partParam(tbl, partKey, p, tier) {
  const c = tbl.comp[partKey]; if (!c) return 0;
  let s = 0;
  for (const m of MAT_TYPES) s += (+c[m.key] || 0) * influence(tbl, m.key, p, tier);
  return p === 'mass' ? s * (1 - CRAFT_LOSS) : s;
}
// Сколько всего компонентов в предмете (для подписи «состав»).
const partSize = (tbl, k) => MAT_TYPES.reduce((s, m) => s + (+tbl.comp[k][m.key] || 0), 0);

// ---------- Итоги корабля ----------
// Галактический сектор: пятая часть радиуса галактики (толщина зоны), пересекается по модели
// межзвёздного перелёта (разгон до 0,98 c → сверхсветовой скачок → торможение).
const SECTOR_UNITS = (GALAXY_RADIUS_KPC / GALAXY_ZONES.length) * UNITS_PER_KPC;
const WARP_V = 0.98 * SHIP_LIGHT;

function shipTotals(tbl, design, tier = 2, gun = 'gun_autocannon', fuelTier = tier) {
  const mods = designModules(design), decks = design.decks.length;
  const count = { frame: decks };
  for (const k of mods) count[k] = (count[k] || 0) + 1;
  if (count.weapon_mount && gun) count[gun] = count.weapon_mount;   // в каждое место — одно орудие

  const sum = {};
  for (const p of PARAMS) sum[p.key] = 0;
  let drive = 0;                                    // активный расход только двигателей
  for (const k in count) {
    const n = count[k]; if (!PART[k] || !n) continue;
    for (const p of PARAMS) sum[p.key] += n * partParam(tbl, k, p.key, tier);
    if (isEngine(k)) drive += n * partParam(tbl, k, 'enActive', tier);
  }
  // Два источника энергии: выработка оборудования (реакторы, панели — без топлива) и сжигание
  // топлива в газохранилищах. Газохранилище жжёт не больше ОДНОЙ единицы за цикл (v2), поэтому
  // энергия от топлива = число газохранилищ × энергоёмкость единицы выбранного топлива.
  const tanks = count.gas_storage || 0;
  const burn = tanks * fuelEnergy(tbl, fuelTier);
  const supply = sum.enGen + burn;
  // Пассивный расход идёт всегда, активный — только у работающих модулей.
  // На разгоне работают ТОЛЬКО двигатели, в бою — ВСЕ системы (требование пользователя).
  const needThrust = sum.enPassive + drive, needCombat = sum.enPassive + sum.enActive;
  const ratio = needThrust > 0 ? Math.min(1, supply / needThrust) : 1;
  // «На 100 т» — это тяга 100 × параметр; ускорение корабля = Σтяга / масса.
  const accel = sum.mass > 0 ? sum.accel100 * 100 * ratio / sum.mass : 0;
  const turnRate = sum.mass > 0 ? sum.turn100 * 100 / sum.mass : 0;
  return {
    name: design.name, cls: shipClass(decks), decks, modules: mods.length, count, tier, gun, sum,
    mass: sum.mass, durability: sum.dur, rad: sum.rad, heat: sum.heat, damage: sum.dmg,
    fuelTier, tanks, energyBurn: burn, energyGen: sum.enGen, energySupply: supply,
    energyPassive: sum.enPassive, energyActive: sum.enActive, energyDrive: drive,
    energyThrust: needThrust, energyCombat: needCombat, energyRatio: ratio,
    deficitThrust: Math.max(0, needThrust - supply), deficitCombat: Math.max(0, needCombat - supply),
    accel, ms2: accel * MS2_PER_UNIT, turnRate,
    toLight: accel > 0 ? timeToSpeed(accel, SHIP_LIGHT) : Infinity,
    crossSystem: travelTime(accel, 2 * SYSTEM_RADIUS),
    crossSector: accel > 0 ? sectorTime(accel) : Infinity,
  };
}
// Пересечение сектора: разгон до 0,98 c, скачок (мгновенно), торможение на AP_BRAKE доли тяги.
function sectorTime(a) {
  const ta = timeToSpeed(a, WARP_V), tb = timeToSpeed(AP_BRAKE * a, WARP_V);
  const sa = stopDistance(WARP_V, a, 1), sb = stopDistance(WARP_V, a, AP_BRAKE);
  return sa + sb >= SECTOR_UNITS ? travelTime(a, SECTOR_UNITS) : ta + tb;
}
