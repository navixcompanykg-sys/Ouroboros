// Окупаемость терраформирования — по всей выборке твёрдых планет, НАСТОЯЩИМИ числами игры.
//
// Вопрос пользователя (2026-11-28): «сделай терраформирование рабочим и посмотрим, в каком проценте
// случаев оно окупит себя за пару-тройку месяцев».
//
// Мера — ШТУКИ сырья (шахта = 10 000; водород — тоже штуки). Терраформирование стоит компонентами 3 ур.
// (цена из data/prices.json, компонент 3 ур. = 20 сырья), содержание — цена за upkeepDays суток.
//
// ЧТО ОНО ДАЁТ (Colony.envOf / terraSurf):
//   1. Условия → норма расы: ёмкость купола 10 × min(1, Q) становится полной. Та же колония из P жителей
//      живёт в меньшем числе куполов: экономия = куполов_было − куполов_стало (содержание сырьём,
//      водород, цена постройки).
//   2. Посев жизни: на мёртвой планете фермы кормят из биомассы (60 жителей на ферму) вместо
//      искусственной пищи из силикатов (10 на ферму, силикаты P/2 за такт). Цена — одна биохимическая
//      шахта (энергия, рабочий) на засеянном гексе. Где биомасса уже была — этой выгоды нет.
// Рабочий стоит крипту: WAGE за такт = WAGE / TOKEN_PER_EN энергии = столько-то водорода (так платит
// майнинг-ферма). Купол рабочих не требует, ферма и шахта — по одному.
//
// Терраформирование ПОСТЕПЕННОЕ (COL.TERRA.rate): условия и посев идут к норме по суткам, пока идёт —
// содержание активной фазы. Окупилось = накопленная экономия минус содержание перекрыла цену.
//
// ДОПУЩЕНИЯ ПРОГОНА (не механика игры): колония фиксированного размера P (ключ --pop, по умолчанию
// 50 / 100 / 200 — сравнение), токсичность — только планетная (без лишних зданий и очистных), еда —
// ровно норма (без роста ×growEat). Планеты со смертельным фактором отброшены: колонии там нет,
// строить некому.
//
// Запуск: node tools/terrapay.js [--stars=1500] [--pop=100] [--days=90] [--rate=K] [--active=N]
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

const DAY = COL.DAY_TICKS, HOURS = 24;
const B = G.COL_BUILDING, T = B.terraform;
const craft = t => G.CRAFT[t - 1].need.reduce((a, b) => a + b, 0);
const TF_COST = Object.values(T.comp).reduce((a, x) => a + x, 0) * craft(T.compTier);   // штук сырья
const TF_DAY = TF_COST / (T.upkeepDays || 30);                                            // содержание в сутки
const WORKER_DAY = COL.WAGE / COL.TOKEN_PER_EN / G.FUEL.hydrogen.yield * DAY;             // водород на рабочего в сутки
const build = k => (B[k].cost.s || 0) + (B[k].cost.c || 0) + (B[k].cost.b || 0);
const run = (k, work) => (B[k].up || 0) * HOURS + (B[k].h2 || 0) * DAY + (work ? WORKER_DAY : 0);   // в сутки
const DOME_DAY = run('dome', B.dome.work), FARM_DAY = run('farm', true), BIO_DAY = run('mine_b', true);

// Издержки колонии из P жителей в сутки (+ разовая цена построек) при ёмкости купола q и наличии биомассы.
function costs(P, q, bio) {
  const domes = P / (COL.DOME_CAP * q);
  const farms = P / (bio ? COL.FARM_CAP : COL.FARM_ART_CAP);
  const sil = bio ? 0 : P / G.COL.FOOD_YIELD.silicates * DAY;                    // силикаты на искусственную пищу
  return { day: domes * DOME_DAY + farms * FARM_DAY + sil + (bio ? BIO_DAY : 0),
    once: domes * build('dome') + farms * build('farm') + (bio ? build('mine_b') : 0), domes, farms };
}

// Ручки подбора (только для прогона): --rate=K множит скорости хода, --active=N — суток цены в активной фазе.
if (argv.some(a => a.startsWith('--rate='))) for (const k in COL.TERRA.rate) COL.TERRA.rate[k] *= arg('rate', 1);
if (argv.some(a => a.startsWith('--active='))) COL.TERRA.activeDays = arg('active', 30);
const HORIZON = arg('days', 90);
const pops = argv.some(a => a.startsWith('--pop=')) ? [arg('pop', 100)] : [50, 100, 200];
const gal = G.generateGalaxy(1);
const rows = [];
let lethal = 0;
// Посуточный ход НАСТОЯЩИМ кодом: Colony.tfAdvance (сутки за шаг), birthEnv (условия), terraSurf (посев).
for (const s of gal.stars.slice(0, arg('stars', 1500))) for (const p of G.generateSystem(s).planets) {
  if (!G.PLANET_TYPES[p.type].landable || G.PLANET_TYPES[p.type].lowOrbit) continue;
  const surf = G.generateSurface(p, s);
  const col = Colony.blank(0, s.id, p.index);
  const k = Colony.birthEnv(col, surf);
  if (k.critical.length || k.all <= 0) { lethal++; continue; }
  const bestBio = () => surf.hexes.reduce((m, h) => Math.max(m, (h.res.microbiota || 0) * COL.FOOD_YIELD.microbiota + (h.res.flora || 0) * COL.FOOD_YIELD.flora), 0);
  const food0 = bestBio();
  col.buildings.push({ kind: 'terraform', q: 0, r: 0, lvl: 1, missed: 0 });
  const days = [];                                   // по суткам: q, пища с лучшего гекса, содержание
  for (let d = 0; d < HORIZON; d++) {
    Colony.tfAdvance(col, surf, DAY);
    Colony.terraSurf(surf, col);
    const cu = Colony.compUpkeep(T, col.buildings[0], col);
    days.push({ q: Math.min(1, Colony.birthEnv(col, surf).all), food: bestBio(),
      up: Object.values(cu.comp).reduce((a, x) => a + x, 0) * craft(T.compTier) * HOURS });
  }
  rows.push({ type: p.type, q0: Math.min(1, k.all), food0, days, toNorm: col.tf.done ? days.findIndex((_, i) => i >= 0) : null,
    left: Colony.tfDaysLeft(col, surf) });
  Colony.terraSurf(surf, null);
}
// Пища из биомассы есть, если одна биошахта на лучшем гексе кормит всю колонию: MINE_K × (выход пищи) ≥ P.
const bioOk = (P, food) => COL.MINE_K * food >= P;

const pct = (a, f) => (a.length ? Math.round(a.filter(f).length / a.length * 100) : 0) + '%';
const med = a => { const b = a.filter(isFinite).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1]) + ' сут' : '—'; };
console.log('ОКУПАЕМОСТЬ ТЕРРАФОРМИРОВАНИЯ (' + arg('stars', 1500) + ' звёзд, ' + rows.length + ' пригодных твёрдых планет, ещё ' + lethal + ' смертельных — отброшены)');
console.log('цена ' + TF_COST + ' шт. (' + TF_COST / 10000 + ' шахт); содержание: активная фаза — цена за ' + COL.TERRA.activeDays + ' сут ('
  + Math.round(TF_COST / COL.TERRA.activeDays) + ' шт./сут), потом за ' + T.upkeepDays + ' (' + Math.round(TF_DAY) + '); скорости в сутки: '
  + Object.entries(COL.TERRA.rate).map(([k, v]) => k + ' ' + +v.toFixed(3)).join(', '));
console.log('купол ' + Math.round(DOME_DAY) + ' шт./сут, ферма ' + Math.round(FARM_DAY) + ', биошахта ' + Math.round(BIO_DAY) + ' (рабочий ' + Math.round(WORKER_DAY) + ' водорода/сут); горизонт ' + HORIZON + ' сут');
const L = rows.map(r => r.left + (HORIZON)).filter(x => x > HORIZON);
console.log('до нормы дошли за ' + HORIZON + ' сут: ' + pct(rows, r => r.left <= 0));
for (const P of pops) {
  const pay = rows.map(r => {
    const base = costs(P, r.q0, bioOk(P, r.food0)).day;
    let cum = -TF_COST, day = Infinity;
    for (let d = 0; d < r.days.length; d++) {
      const x = r.days[d];
      cum += base - costs(P, x.q, bioOk(P, x.food)).day - x.up;
      if (cum >= 0) { day = d + 1; break; }
    }
    return { ...r, days: day, live: r.food0 > 0 };
  });
  console.log('\nКОЛОНИЯ ' + P + ' жителей            планет   ≤30 сут  ≤60 сут  ≤90 сут  медиана окупившихся');
  const line = (name, a) => console.log(name.padEnd(30) + String(a.length).padStart(6) + pct(a, x => x.days <= 30).padStart(9)
    + pct(a, x => x.days <= 60).padStart(9) + pct(a, x => x.days <= 90).padStart(9) + '  ' + med(a.map(x => x.days)));
  line('ВСЕ', pay);
  line('  мёртвые (посев жизни)', pay.filter(x => !x.live));
  line('  живые, купол < 90 %', pay.filter(x => x.live && x.q0 < 0.9));
  line('  живые, купол ≥ 90 %', pay.filter(x => x.live && x.q0 >= 0.9));
  for (const t of [...new Set(rows.map(r => r.type))]) line('  тип: ' + (G.PLANET_TYPES[t].name || t), pay.filter(x => x.type === t));
}
