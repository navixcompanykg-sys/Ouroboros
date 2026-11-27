// Окупаемость улучшения шахты — по всей выборке планет, НАСТОЯЩИМИ числами игры.
//
// Вопрос пользователя (2026-11-28): «содержание для 2 и 3 уровня станет в компонентах — проверить, в
// каком проценте случаев улучшение шахты окупает себя».
//
// Мера — ШТУКИ сырья (как пользователь меряет цены): шахта 1 уровня стоит 10 000. Улучшение:
//   до 2 уровня — компоненты 2 ур. (цена из data/prices.json, upgrades[2]), +20 % добычи от базы;
//   до 3 уровня — компоненты 3 ур. (upgrades[3]), ещё +10 % (всего +30 %).
// Компонент в штуках сырья — сколько сырья на него уходит (CRAFT: 2 ур. — 30, 3 ур. — 20).
// Содержание ступени — её цена за COMP_UPKEEP_HOURS часов (месяц), компонентами.
// Прибавка в сутки = MINE_K × содержание гекса × доля × 144 такта. Энергия шахты — × уровень (водород,
// в штуках: каждый уровень сверх первого — ещё h2 × 144 в сутки). Окупаемость = цена / (прибавка −
// содержание компонентами − лишний водород).
// Шахта стоит на ЛУЧШЕМ гексе своей группы (Colony.hexRank — так ставит автостройка).
//
// Запуск: node tools/minepay.js [--stars=1500]
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
Colony.setPrices(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prices.json'), 'utf8')));
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? +a.split('=')[1] : d; };

const craft = t => G.CRAFT[t - 1].need.reduce((a, b) => a + b, 0);
const stepCost = (B, L) => { const U = B.upgrades[L]; return Object.values(U.comp).reduce((a, x) => a + x, 0) * craft(U.tier); };
const DAY = COL.DAY_TICKS, MONTH_DAYS = COL.COMP_UPKEEP_HOURS / 24;
const GROUP = { s: 'mine_s', c: 'mine_c', e: 'mine_e', b: 'mine_b' };
const NAME = { s: 'структурная', c: 'вычислительная', e: 'энергетическая', b: 'биохимическая' };

const gal = G.generateGalaxy(1);
const res = {};
for (const g in GROUP) res[g] = { n: 0, l2: [], l3: [] };
for (const s of gal.stars.slice(0, arg('stars', 1500))) for (const p of G.generateSystem(s).planets) {
  if (!G.PLANET_TYPES[p.type].landable || G.PLANET_TYPES[p.type].lowOrbit) continue;
  const surf = G.generateSurface(p, s);
  for (const g in GROUP) {
    const h = Colony.hexRank(surf, g)[0]; if (!h) continue;
    const c = G.COL_GROUPS[g].reduce((a, k) => a + (h.res[k] || 0), 0);
    const B = G.COL_BUILDING[GROUP[g]];
    const base = COL.MINE_K * c * DAY;                                    // добыча 1 уровня в сутки, ед.
    const c2 = stepCost(B, 2), c3 = stepCost(B, 3);
    const h2Day = (B.h2 || 0) * DAY;                                       // водород 1 уровня в сутки
    const E = COL.MINE_H2 || { 1: 1, 2: 2, 3: 3 };                         // энергия по уровням
    const net2 = base * (COL.MINE_LVL[2] - 1) - c2 / MONTH_DAYS - h2Day * (E[2] - E[1]);  // прибавка − содержание − лишняя энергия
    const net3 = base * (COL.MINE_LVL[3] - COL.MINE_LVL[2]) - c3 / MONTH_DAYS - h2Day * (E[3] - E[2]);
    res[g].n++;
    res[g].l2.push(net2 > 0 ? c2 / net2 : Infinity);
    res[g].l3.push(net3 > 0 ? c3 / net3 : Infinity);
  }
}
const pct = (a, f) => Math.round(a.filter(f).length / a.length * 100) + '%';
const med = a => { const b = a.filter(isFinite).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1]) + ' сут' : '—'; };
const B0 = G.COL_BUILDING.mine_s;
console.log('ОКУПАЕМОСТЬ УЛУЧШЕНИЯ ШАХТЫ (лучший гекс своей группы на каждой твёрдой планете, ' + arg('stars', 1500) + ' звёзд)');
console.log('цена: до 2 ур. ' + stepCost(B0, 2) + ' ед. (×' + (stepCost(B0, 2) / 10000) + ' шахты), до 3 ур. ' + stepCost(B0, 3) + ' ед. (×' + (stepCost(B0, 3) / 10000)
  + '); содержание — цена за ' + MONTH_DAYS + ' суток; энергия ×' + (COL.MINE_H2 ? COL.MINE_H2[2] + ' / ×' + COL.MINE_H2[3] : '2 / ×3') + '; прибавка +20 % / ещё +10 % добычи 1 уровня');
console.log('шахта            планет   2 ур.: окупится за 30 сут / 90 сут / никогда (медиана)   3 ур.: 30 / 90 / никогда (медиана)');
for (const g in GROUP) {
  const r = res[g];
  console.log(NAME[g].padEnd(16) + String(r.n).padStart(6) + '   ' +
    [pct(r.l2, x => x <= 30), pct(r.l2, x => x <= 90), pct(r.l2, x => !isFinite(x))].map(x => x.padStart(5)).join(' / ') + '  (' + med(r.l2) + ')'.padEnd(10) +
    '   ' + [pct(r.l3, x => x <= 30), pct(r.l3, x => x <= 90), pct(r.l3, x => !isFinite(x))].map(x => x.padStart(5)).join(' / ') + '  (' + med(r.l3) + ')');
}
const all2 = Object.values(res).flatMap(r => r.l2), all3 = Object.values(res).flatMap(r => r.l3);
console.log('ВСЕГО'.padEnd(16) + String(all2.length).padStart(6) + '   ' +
  [pct(all2, x => x <= 30), pct(all2, x => x <= 90), pct(all2, x => !isFinite(x))].map(x => x.padStart(5)).join(' / ') + '  (' + med(all2) + ')'.padEnd(10) +
  '   ' + [pct(all3, x => x <= 30), pct(all3, x => x <= 90), pct(all3, x => !isFinite(x))].map(x => x.padStart(5)).join(' / ') + '  (' + med(all3) + ')');
