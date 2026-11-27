// Проверка населения на планетах разной пригодности — НАСТОЯЩИМИ формулами игры
// (Colony.popRates, Colony.birthEnv, условия планет surface.js planetConditions).
//
// Вопросы пользователя (2026-11-27): «проверить, как падает население на менее пригодных
// планетах — что это постепенный процесс — и что это можно отрегулировать улучшением экологии,
// большим числом пищи или жилья»; «но должны быть точно планеты, где любые меры не позволят жить
// людям, иначе условия мягкие».
//
// Модель (ТЗ §8.21): Q = токсичность × радиация × температура × давление × пища относительно нормы
// расы; ёмкость K = места × min(1, Q); ниже K население растёт (POP_GROW × N × (1 − N/K)), выше —
// убывает (POP_DECLINE × (N − K)); фактор 0 (смертельный, или нет пищи) — колония гибнет сразу.
// 1. Классы по всей выборке (пища нормальная): оптимальная Q ≥ 0,9, терпимая 0,5…0,9, тяжёлая
//    < 0,5, смертельная — какой-то фактор 0. И сколько жителей держит купол.
// 2. Судьба колонии по суткам на четырёх показательных планетах: 10 жителей, 2 купола (20 мест),
//    пищи вдоволь — и варианты: +3 очистных, +1 купол, избыток ферм ×2, пищи вдвое меньше, пищи нет.
//
// Запуск: node tools/popcheck.js [--stars=1500] [--days=30]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ctx = {
  Math, console, Date, JSON, Object, Array, Number, String, Set, Map, isFinite, isNaN, parseInt, parseFloat, Infinity, NaN,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, World: { addShip() {}, save() {} },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['js/data.js', 'js/gen.js', 'js/galaxy-gen.js', 'js/surface.js', 'js/ships.js', 'js/components.js',
  'js/parts-preset.js', 'js/colony.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx, { filename: f });
const G = ctx, { Colony, COL } = G;
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? +a.split('=')[1] : d; };
const f2 = x => x.toFixed(2).replace('.', ',');
// Колония-заготовка: купола на отдельных гексах (не загрязняют), очистные — тоже отдельно.
function fakeCol(surf, domes, eco, pop) {
  const hx = surf.hexes, b = [];
  let i = 0;
  for (let d = 0; d < domes; d++) { const h = hx[i++ % hx.length]; b.push({ kind: 'dome', q: h.q, r: h.r, lvl: 1 }); }
  for (let e = 0; e < eco; e++) { const h = hx[i++ % hx.length]; b.push({ kind: 'eco', q: h.q, r: h.r, lvl: 1 }); }
  return { buildings: b, pop, floraBase: 0, stock: {}, comp: {} };
}
const envOf = (surf, eco) => Colony.birthEnv(fakeCol(surf, 1, eco, 10), surf).all;

// ── 1. классы ──
const gal = G.generateGalaxy(1);
const N = arg('stars', 1500), byType = {}, sample = [];
for (const s of gal.stars.slice(0, N)) for (const p of G.generateSystem(s).planets) {
  if (!G.PLANET_TYPES[p.type].landable || G.PLANET_TYPES[p.type].lowOrbit) {   // газовый гигант — непригоден
    const t = byType[p.type] = byType[p.type] || { n: 0, dome: 0 }; t.n++; t['газовый'] = (t['газовый'] || 0) + 1; continue;
  }
  const surf = G.generateSurface(p, s);
  const k = G.raceFactors(surf.env);
  const cls = G.Habitat.classOf(k)[0];
  const t = byType[p.type] = byType[p.type] || { n: 0, dome: 0 };
  t.n++; t[cls] = (t[cls] || 0) + 1; t.dome += COL.DOME_CAP * Math.min(1, k.all);
  sample.push({ p, s, surf, k, cls });
}
const CLS = ['оптимальная', 'терпимая', 'тяжёлая', 'непригодная', 'смертельная', 'газовый'];
console.log('ПРИГОДНОСТЬ ДЛЯ ЛЮДЕЙ (' + sample.length + ' твёрдых планет + газовые гиганты, ' + N + ' звёзд). Жителей на купол = '
  + COL.DOME_CAP + ' × min(1, Q); средний Q по галактике ' + f2(G.Habitat.average(gal)));
console.log('тип           всего  жит/купол' + CLS.map(c => c.padStart(13)).join(''));
const tot = { n: 0, dome: 0 };
for (const t in byType) {
  const r = byType[t]; tot.n += r.n; tot.dome += r.dome; for (const c of CLS) tot[c] = (tot[c] || 0) + (r[c] || 0);
  console.log((G.PLANET_TYPES[t].name).padEnd(12) + String(r.n).padStart(6) + f2(r.dome / r.n).padStart(11) + CLS.map(c => (Math.round((r[c] || 0) / r.n * 100) + '%').padStart(13)).join(''));
}
console.log('ВСЕГО'.padEnd(12) + String(tot.n).padStart(6) + f2(tot.dome / tot.n).padStart(11) + CLS.map(c => (Math.round((tot[c] || 0) / tot.n * 100) + '%').padStart(13)).join(''));
const unfit = (tot['непригодная'] || 0) + (tot['смертельная'] || 0) + (tot['газовый'] || 0);
console.log('НЕПРИГОДНЫ ДЛЯ ЗАСЕЛЕНИЯ (непригодная + смертельная + газовые): ' + Math.round(unfit / tot.n * 100) + '% всех планет');

// ── 2. судьба колоний ──
// Шаг — такт, как в игре (Colony.popRates — та же формула; гибель при K = 0 — сразу).
function run(surf, { domes = 2, eco = 0, food = 1, farms = 1.25, days = arg('days', 30) }) {
  const col = fakeCol(surf, domes, eco, 10);
  let birth = 0, death = 0;
  const out = [];
  for (let t = 1; t <= days * COL.DAY_TICKS; t++) {
    const need = col.pop * COL.FOOD_PER_POP, eaten = need * Math.min(1, food), made = eaten;
    const r = Colony.popRates(col, surf, made, eaten, col.pop, need * farms);
    if (r.wipe) col.pop = 0;
    else {
      birth += r.births / COL.DAY_TICKS; death += r.deaths / COL.DAY_TICKS;
      if (!r.births) birth = Math.min(birth, 1); if (!r.deaths) death = Math.min(death, 1);
      while (death >= 1 && col.pop > 0) { death--; col.pop--; }
      while (birth >= 1) { birth--; col.pop++; }
    }
    if (t % COL.DAY_TICKS === 0) out.push(col.pop);
  }
  return out;
}
const pick = (lo, hi) => sample.find(x => !x.k.critical.length && x.k.all >= lo && x.k.all < hi);
const cases = [
  ['оптимальная', pick(1, 9)],
  ['терпимая (Q ~0,6)', pick(0.55, 0.7)],
  ['тяжёлая (Q ~0,3)', pick(0.25, 0.35)],
  ['смертельная', sample.find(x => x.k.critical.length)],
];
const days = arg('days', 30), marks = [1, 3, 7, 14, 21, 30].filter(d => d <= days);
for (const [label, c] of cases) {
  if (!c) { console.log('\n' + label + ': в выборке нет'); continue; }
  const env = c.surf.env, b = c.k;
  console.log('\n' + label.toUpperCase() + ': ' + c.p.name + ' (' + G.PLANET_TYPES[c.p.type].name.toLowerCase() + ', ' + c.s.type.name.toLowerCase()
    + ') — токсичность ' + env.toxicity + ', радиация ' + env.radiation + ', ' + Math.round(env.tempK) + ' K, давление ' + env.pressure
    + ' → Q ×' + f2(b.all) + ' (токс ×' + f2(b.tox) + ', рад ×' + f2(b.rad) + ', темп ×' + f2(b.temp) + ', давл ×' + f2(b.press)
    + (b.critical.length ? ', СМЕРТЕЛЬНО: ' + b.critical.join(', ') : '') + ')');
  console.log('  вариант                                 ' + marks.map(d => ('сут ' + d).padStart(8)).join(''));
  const V = [['10 жителей, 2 купола, пища вдоволь', {}], ['  + 3 очистных (токсичность −30)', { eco: 3 }],
    ['  + купол (30 мест)', { domes: 3 }], ['  фермы вдвое мощнее нужды', { farms: 2 }],
    ['  пищи вдвое меньше', { food: 0.5 }], ['  пищи нет', { food: 0 }]];
  for (const [vl, o] of V) {
    const r = run(c.surf, o);
    console.log('  ' + vl.padEnd(40) + marks.map(d => String(r[d - 1]).padStart(8)).join(''));
  }
}
