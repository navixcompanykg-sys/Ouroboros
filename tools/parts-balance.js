// Пробный баланс компонентов для components.html (localStorage ouro.v3.parts).
//
// ЧИСЛА ВЛИЯНИЯ — РУКА ПОЛЬЗОВАТЕЛЯ (его таблица, лист «Сжигание топлива / компоненты»).
// Скрипт их НЕ подбирает и не правит: он только собирает таблицу (влияние + состав + места),
// считает, что из этого выходит, и проверяет два правила:
//   1) время разгона до скорости света и пересечения системы — каноничное (ТЗ §7.1);
//      само число «тяги» условно, масштаб подбирает js/components.js (thrustScale);
//   2) попадание выводит модуль из строя за 1…5 попаданий, урон идёт сначала по каркасу.
// Запуск: node tools/parts-balance.js [--write]  (--write → js/parts-preset.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

// ---------- загрузка игрового кода ----------
const ctx = { Math, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
vm.createContext(ctx);
for (const f of ['js/data.js', 'js/ships.js', 'js/components.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^const /gm, 'var '), ctx);
const G = ctx;

// ---------- ВЛИЯНИЕ КОМПОНЕНТОВ: таблица пользователя ----------
// Строка — параметр, в ней четыре тройки: конструктивный, ЭВМ, биохимический, энергетический
// (значения для компонентов 1, 2 и 3 уровня). Пустая строка — параметр пока не заполнен.
const INF = {
  mass:      { struct: [10, 12, 16], compute: [5, 15, 12], bio: [5, 7, 9], energy: [3, 4, 10] },
  dur:       { struct: [3, 2, 5],    compute: [0, 1, 3],   bio: [0, 0, 2], energy: [0, 0, 0] },
  heat:      { struct: [2, 1, 3],    compute: [1, 0, 0],   bio: [0, 0, 3], energy: [0, 0, 0] },
  rad:       { struct: [1, 3, 2],    compute: [0, 0, 2],   bio: [0, 0, 5], energy: [0, 0, 0] },
  thrust:    { struct: [100, 200, 300], compute: [100, 300, 800], bio: [50, 100, 200], energy: [0, 0, 300] },
  turn:      { struct: [2, 2, 2],    compute: [2, 3, 5],   bio: [1, 1, 2], energy: [0, 0, 4] },
  enPassive: { struct: [0, 0, 0],    compute: [6, 4, 2],   bio: [8, 3, 1], energy: [0, 0, 0] },
  enActive:  { struct: [0, 0, 0],    compute: [12, 8, 4],  bio: [24, 9, 3], energy: [0, 0, 0] },
  enGen:     { struct: [10, 20, 30], compute: [4, 20, 100], bio: [20, 30, 50], energy: [0, 0, 500] },
  durRegen:  { struct: [1, 2, 3],    compute: [2, 3, 5],   bio: [20, 30, 50], energy: [0, 0, 0] },
  capSolid:  { struct: [1000, 1500, 2000], compute: [0, 0, 0], bio: [0, 0, 0], energy: [0, 0, 0] },
  capGas:    { struct: [100, 150, 200], compute: [0, 0, 0], bio: [0, 0, 0], energy: [0, 0, 0] },
  capEnergy: { struct: [200, 300, 500], compute: [100, 200, 300], bio: [100, 200, 300], energy: [100, 200, 300] },
  lifeSup:   { struct: [1, 1, 1],    compute: [1, 2, 3],   bio: [2, 3, 5], energy: [0, 0, 0] },
  // ↓ ЭТИХ СТРОК В ТАБЛИЦЕ ПОЛЬЗОВАТЕЛЯ ПОКА НЕТ. Мои временные числа — только чтобы проверки
  // боя и РЭБ не остались без данных (без них разделы показывают прочерки). Соразмерны его
  // шкале прочности; как появятся настоящие — заменить, ничего другого трогать не нужно.
  dmgPhys:   { struct: [4, 6, 10],   compute: [1, 2, 3],    bio: [0, 0, 0],   energy: [0, 0, 20] },
  dmgRad:    { struct: [0, 0, 0],    compute: [0, 1, 2],    bio: [0, 0, 0],   energy: [2, 6, 30] },
  dmgHeat:   { struct: [0, 0, 0],    compute: [2, 3, 6],    bio: [0, 0, 0],   energy: [1, 3, 10] },
  fireRange: { struct: [50, 80, 120], compute: [200, 400, 800], bio: [0, 0, 0], energy: [0, 0, 500] },
  radar:     { struct: [20, 30, 50], compute: [300, 600, 1200], bio: [0, 0, 0], energy: [0, 0, 400] },
  ecmPower:  { struct: [0, 0, 0],    compute: [150, 300, 600], bio: [20, 30, 50], energy: [0, 0, 200] },
  ecmFreq:   { struct: [0, 0, 0],    compute: [1, 2, 3],    bio: [0, 0, 0],   energy: [0, 0, 1] },
  ecmDef:    { struct: [20, 30, 50], compute: [60, 120, 240], bio: [0, 0, 0],  energy: [0, 0, 100] },
  overheat:  { struct: [1, 2, 3],    compute: [2, 3, 5],    bio: [0, 0, 0],   energy: [0, 0, 10] },
  cooldown:  { struct: [1, 1, 2],    compute: [0, 0, 0],    bio: [2, 3, 5],   energy: [0, 0, 0] },
};
// Сжигание топлива: сколько энергии даёт одна единица за цикл (таблица пользователя).
const FUEL_ENERGY = [100, 300, 800];

// ---------- СОСТАВ И МЕСТА ----------
// comp: [конструктивный, ЭВМ, биохимический, энергетический] — сколько компонентов в предмете;
// slots: какие параметры у предмета ЕСТЬ (места 1–4 закреплены: масса, прочность,
// термостойкость, радиозащита — они у всего). Пользователь: «эту настройку сделай настройкой
// по умолчанию, не надо её менять при подборе комбинаций и балансировке».
const K = {
  // --- системы корабля ---
  frame:         { comp: [2, 0, 0, 0], slots: [] },                     // обшивка: только защита
  weapon_mount:  { comp: [1, 1, 0, 0], slots: [] },                     // место под орудие
  ecm:           { comp: [1, 2, 1, 1], slots: ['ecmPower', 'ecmDef', 'ecmFreq', 'enPassive'] },

  // --- двигатели ---
  engine:        { comp: [2, 1, 1, 0], slots: ['thrust', 'turn', 'enActive', 'capEnergy'] },
  engine_ion:    { comp: [2, 2, 0, 1], slots: ['thrust', 'turn', 'enActive', 'capEnergy'] },
  solar_sail:    { comp: [1, 1, 1, 0], slots: ['thrust', 'enGen', 'capEnergy'] },

  // --- энергетика ---
  reactor:       { comp: [1, 2, 1, 1], slots: ['enGen', 'capEnergy', 'overheat'] },
  gas_storage:   { comp: [2, 0, 0, 0], slots: ['capGas', 'capEnergy'] },
  battery:       { comp: [1, 1, 1, 1], slots: ['capEnergy'] },

  // --- орудия ---
  gun_autocannon:{ comp: [1, 1, 0, 0], slots: ['dmgPhys', 'fireRange', 'enActive', 'overheat'] },
  gun_railgun:   { comp: [2, 1, 0, 0], slots: ['dmgPhys', 'fireRange', 'enActive', 'overheat'] },
  gun_laser:     { comp: [1, 2, 0, 0], slots: ['dmgHeat', 'dmgRad', 'fireRange', 'enActive', 'overheat'] },
  gun_plasma:    { comp: [1, 2, 0, 1], slots: ['dmgRad', 'dmgPhys', 'fireRange', 'overheat', 'enActive'] },
  gun_missile:   { comp: [1, 1, 0, 0], slots: ['dmgPhys', 'fireRange', 'enActive', 'overheat'] },
  gun_torpedo:   { comp: [2, 1, 0, 0], slots: ['dmgPhys', 'fireRange', 'enActive', 'overheat'] },

  // --- служебные ---
  life_support:  { comp: [1, 1, 2, 0], slots: ['lifeSup', 'enPassive'] },
  colonist:      { comp: [1, 1, 2, 0], slots: ['capSolid', 'enPassive'] },
  radar:         { comp: [1, 1, 1, 1], slots: ['radar', 'enPassive'] },
  computer:      { comp: [1, 3, 1, 0], slots: ['ecmDef', 'enActive'] },
  teleport:      { comp: [1, 3, 0, 1], slots: ['enActive'] },
  miner:         { comp: [2, 1, 0, 0], slots: ['enActive', 'capSolid'] },
  repair:        { comp: [1, 1, 1, 0], slots: ['durRegen', 'enActive'] },
  cargo:         { comp: [2, 0, 1, 0], slots: ['capSolid'] },
  hangar:        { comp: [2, 1, 0, 0], slots: ['capSolid', 'enPassive'] },
};

// ---------- сборка таблицы ----------
function build() {
  const t = G.blankParts(false);
  t.fuel = FUEL_ENERGY.slice();
  for (const m of G.MAT_TYPES) for (const p of t.params) {
    const row = INF[p.key];
    t.inf[m.key][p.key] = row && row[m.key] ? row[m.key].slice() : [null, null, null];
  }
  for (const p of G.PARTS) {
    const k = K[p.key];
    if (!k) throw new Error('нет состава для ' + p.key);
    G.MAT_TYPES.forEach((m, i) => { t.comp[p.key][m.key] = k.comp[i]; });
    const list = [...G.FIXED_SLOTS, ...k.slots];
    for (let i = 0; i < G.PARAM_SLOTS; i++) t.slots[p.key][i] = list[i] || null;
    if (list.length > G.PARAM_SLOTS) throw new Error(p.key + ': мест больше ' + G.PARAM_SLOTS);
  }
  return t;
}

const tbl = build();
const designs = G.loadDesigns();
const design = name => designs.find(d => d.name === name);
const withEngines = designs.filter(d => G.designModules(d).some(k => G.isEngine(k)));

// ---------- отчёт ----------
const f = (x, k = 1) => !isFinite(x) ? '—' : x.toLocaleString('ru-RU', { minimumFractionDigits: k, maximumFractionDigits: k });
const T = s => !isFinite(s) ? '—' : s < 120 ? f(s, 1) + ' с' : f(s / 60, 1) + ' мин';
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log('ВЛИЯНИЕ КОМПОНЕНТОВ — числа пользователя, скрипт их не меняет.');
console.log('Масштаб тяги подобран под ТЗ: ' + f(G.thrustScale(tbl), 4) +
  ' ед./с² на единицу тяги при массе 1 т (эталон — «' + G.CAL_DESIGN + '», компоненты 2 ур.).\n');

console.log('1. ОДИН ПРЕДМЕТ (компоненты 1 / 2 / 3 уровня).');
const show = ['frame', 'engine', 'engine_ion', 'reactor', 'gas_storage', 'battery', 'radar', 'life_support'];
console.log('   ' + pad('предмет', 20) + ['масса', 'прочность', 'тяга', 'выработка', 'расход', 'запас']
  .map(h => padl(h, 18)).join(''));
for (const k of show) {
  const v = p => G.TIERS.map(t => f(G.partParam(tbl, k, p, t), 0)).join(' / ');
  console.log('   ' + pad(G.PART[k].name, 20) +
    [v('mass'), v('dur'), v('thrust'), v('enGen'), v('enActive'), v('capEnergy')]
      .map(s => padl(s, 18)).join(''));
}

console.log('\n1a. ПОТРЕБЛЕНИЕ ЭНЕРГИИ (компоненты 2 уровня).');
{
  const kind = k => {
    const has = p => (tbl.slots[k] || []).includes(p);
    return has('enActive') ? 'активное' : has('enPassive') ? 'пассивное'
      : (tbl.slots[k] || []).includes('enGen') ? 'сам даёт энергию' : 'не потребляет';
  };
  for (const g of G.PART_GROUPS) {
    const list = G.PARTS.filter(p => p.group === g.key);
    console.log('   ' + pad(g.name, 24) + list.map(p => {
      const v = G.partParam(tbl, p.key, 'enActive', 2) || G.partParam(tbl, p.key, 'enPassive', 2);
      return p.name + ' — ' + kind(p.key) + (v ? ' ' + f(v, 0) : '');
    }).join('; '));
  }
}

console.log('\n2. РАЗГОН. Цель ТЗ: до света ' + G.SHIP_LIGHT_T + ' с, система (500 а. е.) ' + G.SHIP_CROSS_T + ' с.');
console.log('   ' + pad('корабль', 20) + pad('ур.', 5) + pad('топливо', 12) + padl('масса, т', 10) +
  padl('тяга', 10) + padl('a₀', 9) + padl('до света', 11) + padl('система', 11) + padl('энергия', 9));
for (const [name, tier, fuel] of [['Корвет Патрульный', 1, 1], [G.CAL_DESIGN, 1, 1], [G.CAL_DESIGN, 2, 2],
    [G.CAL_DESIGN, 3, 3], ['Дредноут 1', 2, 2], ['Дредноут 1', 3, 3]]) {
  const st = G.shipTotals(tbl, design(name), tier, 'gun_autocannon', fuel, tier);
  console.log('   ' + pad(name, 20) + pad(tier, 5) + pad(['водород', 'тритий', 'антиматерия'][fuel - 1], 12) +
    padl(f(st.mass, 0), 10) + padl(f(st.thrust, 0), 10) + padl(f(st.accel, 1), 9) +
    padl(T(st.toLight), 11) + padl(T(st.crossSystem), 11) + padl(f(st.energyRatio * 100, 0) + '%', 9));
}

console.log('\n3. ВСЕ СБОРКИ КОНСТРУКТОРА: хватает ли энергии на полную тягу.');
console.log('   ' + pad('корабль', 20) + ['всё 1 ур.', 'источники отстают', 'всё 2 ур.', 'всё 3 ур.']
  .map(h => padl(h, 21)).join(''));
const cell = (d, tier, fuel, power) => {
  const st = G.shipTotals(tbl, d, tier, 'gun_autocannon', fuel, power);
  return f(st.energyRatio * 100, 0) + '% · ' + T(st.toLight);
};
for (const d of withEngines)
  console.log('   ' + pad(d.name, 20) +
    [cell(d, 1, 1, 1), cell(d, 2, 1, 1), cell(d, 2, 2, 2), cell(d, 3, 3, 3)].map(s => padl(s, 21)).join(''));

const GUNS = G.PARTS.filter(p => p.group === 'guns');
const TARGETS = ['engine', 'reactor', 'weapon_mount', 'radar', 'cargo'];
const armed = GUNS.filter(g => G.damageTotal(tbl, g.key, 2) > 0);
console.log('\n4. БОЙ: попаданий до вывода модуля (сначала каркас, потом модуль).');
if (!armed.length) console.log('   урон у орудий ещё не задан — проверять нечего.');
else for (const tier of G.TIERS) {
  console.log('   — всё ' + tier + ' уровня: ' + armed.map(g =>
    g.name + ' ' + TARGETS.map(k => G.hitsToKill(tbl, g.key, k, tier, tier)).join('/')).join(';  '));
}

// ---------- проверки ----------
const problems = [];
const mid = G.shipTotals(tbl, design(G.CAL_DESIGN), 2, 'gun_autocannon', 2, 2);
if (Math.abs(mid.toLight - G.SHIP_LIGHT_T) > 1) problems.push('до света ' + f(mid.toLight) + ' с вместо ' + G.SHIP_LIGHT_T);
if (Math.abs(mid.crossSystem - G.SHIP_CROSS_T) > 2) problems.push('система ' + f(mid.crossSystem) + ' с вместо ' + G.SHIP_CROSS_T);
for (const [tier, fuel, what] of [[1, 1, 'всё 1 уровня'], [2, 2, 'всё 2 уровня'], [3, 3, 'всё 3 уровня']]) {
  for (const d of withEngines) {
    const st = G.shipTotals(tbl, d, tier, 'gun_autocannon', fuel, tier);
    if (st.energyRatio < 1) { problems.push(`${what}: «${d.name}» выжимает ${f(st.energyRatio * 100, 0)} % тяги`); break; }
  }
}
for (const tier of G.TIERS) for (const g of armed) for (const k of TARGETS) {
  const h = G.hitsToKill(tbl, g.key, k, tier, tier);
  if (h < G.HITS_MIN || h > G.HITS_MAX) problems.push(`${g.name} → ${G.PART[k].name} (ур. ${tier}): ${h} попаданий`);
}
console.log('\nПРОВЕРКА: ' + (problems.length ? 'не сходится —\n  ' + problems.join('\n  ') : 'всё в рамках ТЗ'));

if (process.argv.includes('--write')) {
  tbl.build = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const out = path.join(ROOT, 'js', 'parts-preset.js');
  fs.writeFileSync(out,
    '// Таблица компонентов — СОБРАНА АВТОМАТОМ из tools/parts-balance.js, правки сюда бессмысленны.\n' +
    '// Числа влияния и сжигания топлива — из таблицы пользователя; состав и места оборудования —\n' +
    '// настройка по умолчанию. Это только НАЧАЛЬНОЕ заполнение: всё правится на странице.\n' +
    'const PARTS_PRESET = ' + JSON.stringify(tbl, null, 1) + ';\n');
  console.log('\nЗаписано: ' + path.relative(ROOT, out));
}
