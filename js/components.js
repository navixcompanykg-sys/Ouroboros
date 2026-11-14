// Универсальный конструктор: сырьё → компоненты → оборудование → корабль.
//
// ГЛАВНОЕ (модель пользователя): параметры принадлежат КОМПОНЕНТАМ, а не оборудованию.
// У оборудования задаётся только СОСТАВ — сколько компонентов каждого типа в него входит —
// и ПОРЯДОК ПАРАМЕТРОВ: свои 10 мест (слотов), в каждое ставится параметр из справочника,
// пустое место допустимо. Влияние компонентов задано ПО НОМЕРУ МЕСТА (Параметр 1…10), одно
// на всё оборудование: значение = Σ (компонентов в составе × влияние компонента на это место).
// Поэтому новое оборудование добавляется строкой состава и списком мест — числа появятся сами.
//
// Числа влияния, состав и перечень параметров вносит ПОЛЬЗОВАТЕЛЬ (components.html,
// localStorage 'ouro.v3.parts'). В коде — структура и расчёт. Исключение — масса: место, где
// стоит параметр с ролью «масса», считается из массы сырья (правило v2), влияние не читается.

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

// ---------- Сырьё на компонент (справка) ----------
// Сколько сырья уходит на один компонент — нужно для производства, но НА ПАРАМЕТРЫ больше не
// влияет: пользователь отказался от вывода массы из сырья («с сырьём слишком сложно»), масса
// стала обычным параметром компонента и вводится в таблице влияния наравне с остальными.
function rawPerItem(comp, tier) {
  const out = {};
  for (const m of MAT_TYPES) out[m.key] = CRAFT[tier - 1].need.map(x => x * (comp[m.key] || 0));
  return out;
}

// ---------- Параметры: справочник ведёт ПОЛЬЗОВАТЕЛЬ ----------
// Список, названия и порядок правятся на странице и хранятся вместе с числами. В коде —
// только начальный перечень пользователя и РОЛИ: роль говорит расчёту корабля, что это за
// число (масса, тяга, энергия…). Параметр без роли просто складывается по кораблю и показан
// отдельной строкой — добавлять такие можно сколько угодно, расчёт от этого не ломается.
const PARAM_SLOTS = 10;                       // мест под параметры у одного предмета
// Порядок и названия — из таблицы пользователя (его Лист «Сжигание топлива / компоненты»).
const DEFAULT_PARAMS = [
  { key: 'mass',      name: 'Масса',                     unit: 'т',       role: 'mass' },
  { key: 'dur',       name: 'Прочность',                 unit: '',        role: 'dur' },
  { key: 'heat',      name: 'Термостойкость',            unit: '',        role: 'heat' },
  { key: 'rad',       name: 'Радиозащита',               unit: '',        role: 'rad' },
  { key: 'thrust',    name: 'Тяга',                      unit: '',        role: 'thrust' },
  { key: 'turn',      name: 'Угол поворота',             unit: '°/с',     role: 'turn' },
  { key: 'enPassive', name: 'Пассивное потребление',     unit: 'за цикл', role: 'enPassive' },
  { key: 'enActive',  name: 'Активное потребление',      unit: 'за цикл', role: 'enActive' },
  { key: 'enGen',     name: 'Выработка энергии',         unit: 'за цикл', role: 'enGen' },
  { key: 'durRegen',  name: 'Восстановление прочности',  unit: 'за цикл', role: 'repair' },
  { key: 'capSolid',  name: 'Грузовая ёмкость твёрдое',  unit: 'ед.',     role: 'cap' },
  { key: 'capGas',    name: 'Грузовая ёмкость газовая',  unit: 'ед.',     role: 'cap' },
  { key: 'capEnergy', name: 'Ёмкость аккумулятора',      unit: 'ед.',     role: 'enCap' },
  { key: 'lifeSup',   name: 'Запас жизнеобеспечения',    unit: 'циклов',  role: 'life' },
  { key: 'dmgPhys',   name: 'Урон физический',           unit: '',        role: 'dmg' },
  { key: 'dmgRad',    name: 'Урон радиоактивный',        unit: '',        role: 'dmg' },
  { key: 'dmgHeat',   name: 'Урон тепловой',             unit: '',        role: 'dmg' },
  { key: 'fireRange', name: 'Дальность стрельбы',        unit: 'ед.',     role: 'fire' },
  { key: 'radar',     name: 'Дальность радара',          unit: 'ед.',     role: 'range' },
  { key: 'ecmPower',  name: 'Мощность РЭБ воздействия',  unit: '',        role: 'ecm' },
  { key: 'ecmFreq',   name: 'РЭБ частот',                unit: '' },
  { key: 'ecmDef',    name: 'РЭБ защита',                unit: '',        role: 'ecmDef' },
  { key: 'overheat',  name: 'Перегрев',                  unit: '' },
  { key: 'cooldown',  name: 'Остывание',                 unit: '' },
];
const paramList = tbl => (tbl && tbl.params) || DEFAULT_PARAMS;
const paramByKey = (tbl, key) => paramList(tbl).find(p => p.key === key) || null;
const isMass = p => !!p && p.role === 'mass';
// Новый параметр: ключ не повторяется, иначе его числа перепутаются с чужими.
function newParamKey(tbl, base = 'p') {
  let i = 1; const has = k => paramList(tbl).some(p => p.key === k);
  while (has(base + i)) i++;
  return base + i;
}

// ---------- Оборудование: только название, состав и порядок параметров ----------
// key совпадает с ключами модулей ships.js — дизайны из конструктора считаются напрямую.
// «Системы корабля» — оружейный модуль, каркас палубы и модуль РЭБ в одном блоке
// (решение пользователя): прежние «Корпус» и «Боевые системы» слиты сюда.
const PART_GROUPS = [
  { key: 'systems', name: 'Системы корабля' },
  { key: 'drive',   name: 'Двигатели' },
  { key: 'power',   name: 'Энергетика' },
  { key: 'guns',    name: 'Орудия (ставятся в оружейный модуль)' },
  { key: 'service', name: 'Служебные модули' },
];
const PARTS = [
  { key: 'weapon_mount', group: 'systems', name: 'Оружейный модуль', note: 'место под орудие' },
  { key: 'frame',        group: 'systems', name: 'Каркас палубы', note: 'ставится сам на каждую палубу' },
  { key: 'ecm',          group: 'systems', name: 'Модуль РЭБ' },
  { key: 'engine',       group: 'drive',   name: 'Двигатель' },
  { key: 'engine_ion',   group: 'drive',   name: 'Ионный двигатель' },
  { key: 'solar_sail',   group: 'drive',   name: 'Солнечный парус' },
  { key: 'reactor',      group: 'power',   name: 'Атомный реактор' },
  { key: 'gas_storage',  group: 'power',   name: 'Газохранилище' },
  { key: 'battery',      group: 'power',   name: 'Аккумуляторы' },
  { key: 'gun_autocannon', group: 'guns',  name: 'Автопушка' },
  { key: 'gun_railgun',    group: 'guns',  name: 'Рельсотрон' },
  { key: 'gun_laser',      group: 'guns',  name: 'Лазер' },
  { key: 'gun_plasma',     group: 'guns',  name: 'Плазмапушка' },
  { key: 'gun_missile',    group: 'guns',  name: 'Ракеты' },
  { key: 'gun_torpedo',    group: 'guns',  name: 'Торпеды' },
  { key: 'life_support', group: 'service', name: 'Жизнеобеспечение' },
  { key: 'colonist',     group: 'service', name: 'Колониальный модуль' },
  { key: 'radar',        group: 'service', name: 'Радар' },
  { key: 'computer',     group: 'service', name: 'Вычислительный модуль' },
  { key: 'teleport',     group: 'service', name: 'Телепорт-модуль' },
  { key: 'miner',        group: 'service', name: 'Шахтёр' },
  { key: 'repair',       group: 'service', name: 'Ремонтный модуль' },
  { key: 'cargo',        group: 'service', name: 'Грузовой отсек' },
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

// ЗАКРЕПЛЁННЫЕ МЕСТА: масса, прочность, термостойкость, радиозащита есть у ВСЕГО оборудования
// (прямое указание пользователя: «это есть у всего»), поэтому места 1–4 заняты ими всегда
// и не выбираются. Считаются они так же, как остальные параметры, — из влияния компонентов.
const FIXED_SLOTS = ['mass', 'dur', 'heat', 'rad'];

// ---------- Хранилище ----------
// params — справочник параметров; slots[оборудование] = 10 мест (какие параметры у него есть);
// inf[типКомпонента][ключПараметра] = [ур1, ур2, ур3] — влияние ОДНОГО компонента на параметр
// (решение пользователя: «делаем привязку параметров к компонентам, это проще»);
// comp[оборудование][типКомпонента] = сколько штук входит (от уровня не зависит).
const PARTS_KEY = 'ouro.v3.parts';
const PARTS_VER = 3;                          // 1 — по именам, 2 — по местам, 3 — снова по именам
// Пустая таблица: влияние и состав не заполнены, у каждого предмета заняты только места 1–4.
function blankParts() {
  const inf = {}, comp = {}, slots = {};
  for (const m of MAT_TYPES) {
    inf[m.key] = {};
    for (const p of DEFAULT_PARAMS) inf[m.key][p.key] = [null, null, null];
  }
  for (const p of PARTS) {
    comp[p.key] = {};
    for (const m of MAT_TYPES) comp[p.key][m.key] = null;
    slots[p.key] = Array.from({ length: PARAM_SLOTS }, (_, i) => FIXED_SLOTS[i] || null);
  }
  return { v: PARTS_VER, params: DEFAULT_PARAMS.map(p => ({ ...p })), seeded: DEFAULT_PARAMS.map(p => p.key),
    slots, inf, comp, fuel: FUEL_ENERGY_DEFAULT.slice() };
}
// saved — то, что уже прочитано из файла data/parts.json или из зеркала в браузере
// (js/store.js). Без аргумента читает зеркало сам — так удобнее в node-проверках.
function loadParts(saved) {
  let s = saved === undefined ? null : saved;
  if (saved === undefined)
    try { s = JSON.parse(localStorage.getItem(PARTS_KEY)); } catch (_) { /* испорчено — шаблон */ }
  const old = s && s.v !== PARTS_VER;         // формат сменился (см. PARTS_VER)
  // Ничего своего ещё нет — открываем страницу на ПРОБНОМ БАЛАНСЕ (js/parts-preset.js, собран
  // tools/parts-balance.js): сразу видны живые числа.
  if (!s && typeof PARTS_PRESET !== 'undefined' && PARTS_PRESET && PARTS_PRESET.inf)
    return JSON.parse(JSON.stringify(PARTS_PRESET));
  // ФОРМАТ СМЕНИЛСЯ. Раньше я просто подменял всё пресетом — и стёр пользователю состав
  // оборудования, который он вносил руками. Больше так нельзя: из старых данных переносим всё,
  // что от формата не зависит, — СОСТАВ, энергоёмкость топлива и список мест по ключам
  // параметров (ключи, которых уже нет, отбрасываем). Пропадают только числа влияния, они
  // действительно лежали иначе.
  if (old && typeof PARTS_PRESET !== 'undefined' && PARTS_PRESET && PARTS_PRESET.inf) {
    const t = JSON.parse(JSON.stringify(PARTS_PRESET));
    const keys = new Set(t.params.map(p => p.key));
    // Параметры, которые сменили ключ при смене формата: место в списке не должно пропасть.
    const RENAME = { accel100: 'thrust', turn100: 'turn', heatUp: 'overheat', coolTime: 'cooldown', dmg: 'dmgPhys' };
    if (s.slots) for (const k in s.slots) if (Array.isArray(s.slots[k]))
      s.slots[k] = s.slots[k].map(x => RENAME[x] || x);
    if (s.comp) for (const k in t.comp) if (s.comp[k])
      for (const m in t.comp[k]) if (s.comp[k][m] !== undefined) t.comp[k][m] = s.comp[k][m];
    if (s.slots) for (const k in t.slots) if (Array.isArray(s.slots[k])) {
      const kept = s.slots[k].filter(x => x && keys.has(x));
      if (kept.length) for (let i = 0; i < PARAM_SLOTS; i++)
        t.slots[k][i] = i < FIXED_SLOTS.length ? FIXED_SLOTS[i] : (kept.filter(x => !FIXED_SLOTS.includes(x))[i - FIXED_SLOTS.length] || null);
    }
    if (Array.isArray(s.fuel)) t.fuel = s.fuel.slice(0, 3);
    return t;
  }
  const base = blankParts();
  if (s) {
    if (Array.isArray(s.params) && s.params.length) {
      base.params = s.params.map(p => ({ ...p }));
      // Параметр, добавленный в код ПОСЛЕ того, как пользователь сохранил свой список,
      // дописывается в конец один раз. `seeded` помнит, что он уже предлагался: удалил —
      // значит удалил, обратно не вернётся.
      // Роль — техническая связь с расчётом, пользователь её не правит: берём из кода по ключу,
      // иначе новая роль (как у РЭБ) не дошла бы до тех, кто уже сохранил свой список.
      for (const p of base.params) {
        const d = DEFAULT_PARAMS.find(x => x.key === p.key);
        if (d) { if (d.role) p.role = d.role; else delete p.role; }
      }
      const seen = new Set([...base.params.map(p => p.key), ...(s.seeded || [])]);
      for (const p of DEFAULT_PARAMS) if (!seen.has(p.key)) base.params.push({ ...p });
    }
    if (!old && s.inf) for (const m of MAT_TYPES) if (s.inf[m.key])
      for (const key in s.inf[m.key])
        if (Array.isArray(s.inf[m.key][key])) base.inf[m.key][key] = s.inf[m.key][key].slice(0, 3);
    if (!old && s.slots) for (const k in base.slots) if (Array.isArray(s.slots[k]))
      for (let i = 0; i < PARAM_SLOTS; i++) base.slots[k][i] = s.slots[k][i] || null;
    for (const k in base.slots)                            // места 1–4 закреплены за всеми
      FIXED_SLOTS.forEach((p, i) => { base.slots[k][i] = p; });
    if (s.comp) for (const k in base.comp) for (const t in base.comp[k])
      if (s.comp[k] && s.comp[k][t] !== undefined) base.comp[k][t] = s.comp[k][t];
    if (Array.isArray(s.fuel)) base.fuel = s.fuel.slice(0, 3);
    if (s.build) base.build = s.build;        // от какой сборки пресета пошли эти числа
  }
  base.seeded = [...new Set([...(s && s.seeded || []), ...DEFAULT_PARAMS.map(p => p.key), ...base.params.map(p => p.key)])];
  // Числа влияния пересобраны (у пресета новая отметка build) — подхватываем их САМИ, просто
  // при обновлении страницы, без всяких кнопок. Состав оборудования, места и справочник
  // параметров при этом НЕ трогаем: это ввод пользователя (я уже стирал ему состав — больше нет).
  if (typeof PARTS_PRESET !== 'undefined' && PARTS_PRESET && PARTS_PRESET.inf && base.build !== PARTS_PRESET.build) {
    for (const m of MAT_TYPES) {
      const row = PARTS_PRESET.inf[m.key] || {};
      for (const key in row) if (Array.isArray(row[key])) base.inf[m.key][key] = row[key].slice();
    }
    if (Array.isArray(PARTS_PRESET.fuel)) base.fuel = PARTS_PRESET.fuel.slice();
    base.build = PARTS_PRESET.build;
  }
  return base;
}
function saveParts(t) { try { localStorage.setItem(PARTS_KEY, JSON.stringify(t)); } catch (_) { /* приватный режим */ } }

// Влияние одного компонента типа t на ПАРАМЕТР при уровне tier.
const influence = (tbl, t, paramKey, tier) => {
  const a = tbl.inf[t] && tbl.inf[t][paramKey];
  return a ? (+a[tier - 1] || 0) : 0;
};
// Какой параметр стоит на месте slot у предмета partKey.
const slotParam = (tbl, partKey, slot) => {
  const k = tbl.slots[partKey] && tbl.slots[partKey][slot];
  return k ? paramByKey(tbl, k) : null;
};
// ГЛАВНАЯ ФОРМУЛА: значение параметра у предмета = Σ (компонентов в составе × влияние
// компонента на ЭТОТ ПАРАМЕТР). Масса считается так же, как всё остальное.
function paramValue(tbl, partKey, paramKey, tier) {
  const c = tbl.comp[partKey]; if (!c || !paramKey) return 0;
  let s = 0;
  for (const m of MAT_TYPES) {
    const n = +c[m.key] || 0; if (!n) continue;
    s += n * influence(tbl, m.key, paramKey, tier);
  }
  return s;
}
// Значение на месте: место — это просто «какой параметр у предмета есть», число берётся
// по имени параметра.
function slotValue(tbl, partKey, slot, tier) {
  const p = slotParam(tbl, partKey, slot); if (!p) return null;
  return paramValue(tbl, partKey, p.key, tier);
}
// Крайние значения (как в примере пользователя: столбцы «Мин» и «Макс»): предмет собран
// целиком из компонентов 1 уровня и целиком из компонентов 3 уровня. Игрок мешает уровни
// как хочет, поэтому настоящее значение всегда между ними.
const slotMin = (tbl, k, slot) => slotValue(tbl, k, slot, 1);
const slotMax = (tbl, k, slot) => slotValue(tbl, k, slot, TIERS.length);
// Значение параметра у предмета — только если этот параметр у него вообще есть (стоит на месте).
function partParam(tbl, partKey, paramKey, tier) {
  const has = (tbl.slots[partKey] || []).includes(paramKey);
  return has ? paramValue(tbl, partKey, paramKey, tier) : 0;
}
// ---------- Бой: как орудие ведёт себя с расстоянием ----------
// Требование пользователя: у разных орудий урон и точность падают с дальностью по-разному,
// и это свойство ТИПА орудия, а не число компонента.
//   dmg: 'none' — урон не падает, 'linear' — падает линейно, 'quad' — квадратично (быстро);
//   acc: 'none' — точность не падает, 'linear' — падает линейно (снаряд летит дольше);
//   у ракет и торпед наведение, поэтому точность держится, зато их перехватывает ПВО.
// Доля дальности r = расстояние ÷ дальность стрельбы; за пределами дальности — ноль.
const GUN_RULES = {
  gun_autocannon: { dmg: 'none',   acc: 'linear', note: 'урон не падает, падает точность; работает как ПВО' },
  gun_railgun:    { dmg: 'none',   acc: 'linear', note: 'урон не падает, падает точность; дальность можно наращивать рядом (ТЗ §7.4)' },
  gun_laser:      { dmg: 'quad',   acc: 'none',   note: 'точность не падает, тепловой урон спадает квадратично' },
  gun_plasma:     { dmg: 'linear', acc: 'linear', note: 'сгусток рассеивается — допущение, пользователь спад не задавал' },
  gun_missile:    { dmg: 'none',   acc: 'none',   note: 'наведение; трудно перехватить ПВО' },
  gun_torpedo:    { dmg: 'none',   acc: 'none',   note: 'наведение; легко перехватить ПВО' },
};
const falloff = (kind, r) => kind === 'quad' ? Math.pow(Math.max(0, 1 - r), 2)
  : kind === 'linear' ? Math.max(0, 1 - r) : 1;
// Доля урона и точности на расстоянии d (мировые единицы).
function gunAt(tbl, gunKey, tier, d) {
  const rng = partParam(tbl, gunKey, 'fireRange', tier);
  const rules = GUN_RULES[gunKey] || { dmg: 'none', acc: 'none' };
  if (rng <= 0) return { inRange: false, dmg: 0, acc: 0, damage: 0 };
  const r = d / rng, inRange = r <= 1;
  const dmg = inRange ? falloff(rules.dmg, r) : 0, acc = inRange ? falloff(rules.acc, r) : 0;
  return { inRange, dmg, acc, damage: damageTotal(tbl, gunKey, tier) * dmg };
}
// Перехват ПВО: уязвимость цели против её же наведения. Ракета с наведением уходит от ПВО,
// тяжёлая торпеда без него — нет.
function interceptChance(tbl, gunKey, tier) {
  const v = partParam(tbl, gunKey, 'aaVuln', tier);
  if (v <= 0) return 0;                       // не перехватывается (луч, снаряд)
  const g = partParam(tbl, gunKey, 'guidance', tier);
  return v / (v + g);
}

// ---------- Бой: сколько попаданий выводит модуль из строя ----------
// Правило пользователя: урон идёт СНАЧАЛА по каркасу палубы (обшивке) и только потом по самому
// модулю, поэтому на вывод одного модуля нужно пробить прочность каркаса + прочность модуля.
// Цель баланса — 1…5 попаданий при компонентах одного уровня.
const HITS_MIN = 1, HITS_MAX = 5;
const DAMAGE_ROLES = ['dmg'];                       // все параметры с ролью «урон» складываются
function damageTotal(tbl, gunKey, tier) {
  return paramList(tbl).filter(p => DAMAGE_ROLES.includes(p.role))
    .reduce((s, p) => s + partParam(tbl, gunKey, p.key, tier), 0);
}
function hitsToKill(tbl, gunKey, partKey, gunTier, hullTier = gunTier) {
  const d = damageTotal(tbl, gunKey, gunTier); if (d <= 0) return Infinity;
  const dur = p => paramList(tbl).filter(x => x.role === 'dur')
    .reduce((s, x) => s + partParam(tbl, p, x.key, hullTier), 0);
  return Math.ceil((dur('frame') + dur(partKey)) / d);
}

// Сколько всего компонентов в предмете (для подписи «состав»).
const partSize = (tbl, k) => MAT_TYPES.reduce((s, m) => s + (+tbl.comp[k][m.key] || 0), 0);

// ---------- РЭБ ----------
// Правило пользователя: РЭБ действует в радиусе радара; воздействие удаётся, когда оно сильнее
// защиты цели, и с расстоянием падает ЛИНЕЙНО — у самого радара (d = R) от него ничего не
// остаётся. Поэтому вблизи мощность почти всегда пробивает, а на удалении достаточная защита
// делает корабль неуязвимым для подавления.
//   действующая мощность = P × (1 − d/R),  подавление идёт, пока она больше защиты D
//   отсюда радиус подавления: d < R × (1 − D/P)
const ecmAt = (power, radar, d) => radar > 0 ? power * Math.max(0, 1 - d / radar) : 0;
function ecmReach(power, defense, radar) {
  if (power <= 0 || radar <= 0) return 0;
  return Math.max(0, radar * (1 - defense / power));
}

// ---------- Масштаб тяги ----------
// Пользователь вводит «тягу» в своих единицах, а время разгона должно остаться каноничным
// (ТЗ §7.1: средний корабль библиотеки на тритии разгоняется до света за SHIP_LIGHT_T и
// пересекает систему за SHIP_CROSS_T). Поэтому тягу переводим в ускорение через множитель,
// который подбирается ПО ЭТАЛОННОМУ КОРАБЛЮ — числа пользователя при этом не трогаются.
// Эталон — встроенная сборка `CAL_SHIP` (ships.js), а НЕ корабль из библиотеки: корабли в
// конструкторе пользователь собирает сам, и пустой дизайн обнулил бы масштаб времени.
let _ts = null, _tsFor = null;
function thrustScale(tbl) {
  if (_tsFor === tbl && _ts !== null) return _ts;
  _tsFor = tbl; _ts = 1;                      // на время подбора масштаб единичный
  try {
    const raw = shipTotals(tbl, CAL_SHIP, 2, 'gun_autocannon', 2, 2).accel;
    _ts = raw > 0 ? calibrate().a / raw : 1;
  } catch (_) { _ts = 1; }
  return _ts;
}

// ---------- Итоги корабля ----------
// Галактический сектор: пятая часть радиуса галактики (толщина зоны), пересекается по модели
// межзвёздного перелёта (разгон до 0,98 c → сверхсветовой скачок → торможение).
const SECTOR_UNITS = (GALAXY_RADIUS_KPC / GALAXY_ZONES.length) * UNITS_PER_KPC;
const WARP_V = 0.98 * SHIP_LIGHT;

// Источник энергии — предмет, у которого есть параметр с ролью «выработка» (реактор, парус).
// Газохранилище сюда не входит: его вклад задаёт уровень ТОПЛИВА, а не его собственный.
const isPowerSource = (tbl, partKey) => {
  for (let i = 0; i < PARAM_SLOTS; i++) {
    const p = slotParam(tbl, partKey, i);
    if (p && p.role === 'enGen') return true;
  }
  return false;
};
// powerTier — уровень компонентов У ИСТОЧНИКОВ ЭНЕРГИИ, он задаётся отдельно (правило
// пользователя): всё одного уровня — энергии хватает; источники слабее потребителей —
// не хватает; всё топовое — работает на полную.
function shipTotals(tbl, design, tier = 2, gun = 'gun_autocannon', fuelTier = tier, powerTier = tier) {
  const mods = designModules(design), decks = design.decks.length;
  const count = { frame: decks };
  for (const k of mods) count[k] = (count[k] || 0) + 1;
  if (count.weapon_mount && gun) count[gun] = count.weapon_mount;   // в каждое место — одно орудие

  // Складываем ПО ПАРАМЕТРАМ: на каком месте параметр стоит у конкретного предмета — его дело.
  const sum = {}, best = {};
  for (const p of paramList(tbl)) sum[p.key] = best[p.key] = 0;
  let drive = 0;                                    // активный расход только двигателей
  for (const k in count) {
    const n = count[k]; if (!PART[k] || !n) continue;
    const lvl = isPowerSource(tbl, k) ? powerTier : tier;
    for (let i = 0; i < PARAM_SLOTS; i++) {
      const p = slotParam(tbl, k, i); if (!p) continue;
      const one = slotValue(tbl, k, i, lvl) || 0, v = n * one;
      sum[p.key] = (sum[p.key] || 0) + v;
      best[p.key] = Math.max(best[p.key] || 0, one);   // дальности: лучшее на корабле, не сумма
      if (p.role === 'enActive' && isEngine(k)) drive += v;
    }
  }
  // Роль говорит, что это за число: параметров одной роли может быть несколько (три вида урона,
  // две ёмкости) — тогда в итог идёт их сумма. Параметр без роли просто показывается отдельно.
  const byRole = r => paramList(tbl).filter(p => p.role === r).reduce((s, p) => s + (sum[p.key] || 0), 0);
  // Дальность радара и дальность стрельбы складывать нельзя (два радара не видят вдвое дальше) —
  // по кораблю берём лучшую из установленных. Допущение, в таблице пользователя этого нет.
  const bestRole = r => paramList(tbl).filter(p => p.role === r).reduce((s, p) => Math.max(s, best[p.key] || 0), 0);
  // Тяга двигателей не зависит от топлива напрямую: двигатель потребляет ЭНЕРГИЮ, а её дают
  // реактор и сжигание топлива в газохранилище (поправка пользователя). Класс топлива виден
  // через энергию: на водороде её меньше, значит тяги хватает не на полную.
  const mass = byRole('mass'), thrust = byRole('thrust'), turn = byRole('turn');
  const enGen = byRole('enGen'), enActive = byRole('enActive'), enPassive = byRole('enPassive');
  // Два источника энергии: выработка оборудования (реакторы, панели — без топлива) и сжигание
  // топлива в газохранилищах. Газохранилище жжёт не больше ОДНОЙ единицы за цикл (v2), поэтому
  // энергия от топлива = число газохранилищ × энергоёмкость единицы выбранного топлива.
  const tanks = count.gas_storage || 0;
  const burn = tanks * fuelEnergy(tbl, fuelTier);
  const supply = enGen + burn;
  // Пассивный расход идёт всегда, активный — только у работающих модулей.
  // На разгоне работают ТОЛЬКО двигатели, в бою — ВСЕ системы (требование пользователя).
  const needThrust = enPassive + drive, needCombat = enPassive + enActive;
  const ratio = needThrust > 0 ? Math.min(1, supply / needThrust) : 1;
  // Запас энергии (решение пользователя): откуда энергия пришла — неважно, она копится в
  // аккумуляторе ВНУТРИ оборудования (двигатель, реактор, газохранилище, парус) и в отдельных
  // аккумуляторах, которые просто увеличивают общий запас. Пока запас не исчерпан, нехватка
  // выработки тягу не режет: корабль доедает накопленное. Доля ratio — устойчивый режим,
  // то есть то, что останется, когда запас кончится.
  const store = byRole('enCap');
  const cycles = need => { const d = need - supply; return d > 0 ? (store > 0 ? store / d : 0) : Infinity; };
  // Ускорение считается из ТЯГИ НА МАССУ (решение пользователя). Сама величина условна:
  // ускорение всё равно растёт со скоростью (accelAt в ships.js), поэтому важно не число a₀,
  // а каноничное время разгона до скорости света — под него и подобран масштаб тяги
  // (thrustScale: средний корабль библиотеки идёт за SHIP_LIGHT_T).
  const accel = mass > 0 ? thrustScale(tbl) * thrust * ratio / mass : 0;
  const turnRate = mass > 0 ? turn * 100 / mass : 0;
  // Параметры без роли — отдельным списком, чтобы добавленное пользователем было видно в итогах.
  const extra = paramList(tbl).filter(p => !p.role && sum[p.key]).map(p => ({ ...p, value: sum[p.key] }));
  return {
    name: design.name, cls: shipClass(decks), decks, modules: mods.length, count, tier, powerTier, gun, sum, extra,
    thrust,
    mass, durability: byRole('dur'), rad: byRole('rad'), heat: byRole('heat'), damage: byRole('dmg'),
    capacity: byRole('cap'), battery: byRole('enCap'), lifeSupport: byRole('life'),
    ecmPower: byRole('ecm'), ecmDef: byRole('ecmDef'), repair: byRole('repair'),
    range: bestRole('range'), fireRange: bestRole('fire'),
    // Радиус подавления против такого же корабля: наглядно видно, кто кого глушит.
    ecmReachSelf: ecmReach(byRole('ecm'), byRole('ecmDef'), bestRole('range')),
    fuelTier, tanks, energyBurn: burn, energyGen: enGen, energySupply: supply,
    energyPassive: enPassive, energyActive: enActive, energyDrive: drive,
    energyThrust: needThrust, energyCombat: needCombat, energyRatio: ratio,
    energyStore: store, cyclesThrust: cycles(needThrust), cyclesCombat: cycles(needCombat),
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
