// Баланс таблицы ресурсов из ИСХОДНОЙ таблицы пользователя (tools/sheet-original.json).
// Запуск из корня проекта:
//   node tools/balance.js          — показать результат
//   node tools/balance.js --write  — записать в js/data.js и tools/sheet-paste.tsv
//
// Замысел (пользователь): ближе к центру галактики — больше редких ресурсов и энергии, меньше
// жизни и ресурсов, накопленных временем (нестабильно); дальше от центра — стабильно, больше
// жизни и времени, но меньше энергии и редкого (всё остыло). Редкость небиологических ресурсов —
// условная лесенка: средняя по галактике доля ресурса ранга n ∝ 1/n² (RARITY_RANK).
// Без общего коэффициента: режутся отдельные сектора (зоны) и база.
//
// Шаги:
//   1. ФОРМА ПО ЗОНАМ. Направление ресурса — из исходных множителей зон (центр > край → «к центру»).
//      Контраст усиливается квадратично: «к центру» — множитель зоны × (z/5)² (край ×0,04, центр ×1),
//      «к краю» — × ((6−z)/5)² (край ×1, центр ×0,04). Опорный водород (ранг 1) не трогается.
//   2. УРОВЕНЬ БАЗОЙ. База и поправки звёзд ресурса умножаются на одно число, чтобы его среднее по
//      галактике легло на свою ступень лесенки относительно водорода (только уменьшение).
//   3. ПРЕДЕЛ 100. Пока какое-то сочетание (тип × звезда × зона × жизнь) больше 100: в худшем берётся
//      ресурс с наибольшим вкладом; если его положительная поправка звезды ≥ четверти базы — она −шаг,
//      иначе база −шаг (база не ниже 0,01 — ресурс не исчезает). Множители зон тут НЕ трогаются,
//      поэтому форма шага 1 (край самый живой и т. д.) сохраняется.
// Звёзды-доноры чёрных дыр (BH_EFFECT, индекс 0…1) входят и в средние, и в проверку предела.
// Распределение планет по сочетаниям — замер галактики #1 (tools/lib.js).

const fs = require('fs');
const path = require('path');
const { ROOT, load, histogram } = require('./lib');

const STEEP = 2;   // степень усиления контраста зон (квадратично)
const LIMIT = 100;
const ANCHOR = 'hydrogen';

const c = load();
const { planets, hist } = histogram(c);
const orig = JSON.parse(fs.readFileSync(path.join(__dirname, 'sheet-original.json'), 'utf8'));
const R = c.RESOURCES, types = Object.keys(c.PLANET_TYPES), Z = orig.zone.length;
const BI = R.map((r, i) => c.BIOMASS.includes(r.key) ? i : -1).filter(i => i >= 0);
const r2 = v => Math.round(v * 100) / 100;

const base = JSON.parse(JSON.stringify(orig.base));
const mod = JSON.parse(JSON.stringify(orig.mod));
const zone = orig.zone.map(z => z.slice());

// --- 1. Форма по зонам ---
const dir = R.map((r, i) => r.key === ANCHOR ? 0 : (orig.zone[Z - 1][i] > orig.zone[0][i] ? +1 : -1));
for (let zi = 0; zi < Z; zi++) R.forEach((r, i) => {
  if (!dir[i]) return;
  const pos = dir[i] > 0 ? (zi + 1) / Z : (Z - zi) / Z;
  zone[zi][i] = r2(orig.zone[zi][i] * pos ** STEEP);
});

function val(t, s, zi, l, i, bh = 0) {
  const b = base[t][i];
  if (!(b > 0)) return 0;
  const lm = BI.includes(i) ? c.LIFE_STATES[l].mult[BI.indexOf(i)] : 1;
  return Math.max(0, b + mod[s][i]) * zone[zi][i] * lm * (1 + (c.BH_EFFECT[i] - 1) * bh);
}
function averages() {
  const a = R.map(() => 0), za = [...Array(Z)].map(() => R.map(() => 0)), zn = Array(Z).fill(0);
  for (const [k, n] of Object.entries(hist)) {
    const [t, s, zi, l, bh] = k.split('|');
    zn[zi] += n;
    R.forEach((r, i) => { const v = n * val(t, s, +zi, l, i, +bh); a[i] += v; za[zi][i] += v; });
  }
  return { avg: a.map(v => v / planets), zavg: za.map((z, zi) => z.map(v => v / zn[zi])) };
}

// --- 2. Уровень базой ---
const anchorI = R.findIndex(r => r.key === ANCHOR);
{
  const { avg } = averages();
  R.forEach((r, i) => {
    const rank = c.RARITY_RANK[r.key];
    if (!rank || r.key === ANCHOR) return;
    const k = Math.min(1, (avg[anchorI] / rank ** 2) / avg[i]);
    for (const t of types) if (base[t][i] > 0) base[t][i] = Math.max(0.01, r2(base[t][i] * k));
    for (const s in mod) mod[s][i] = r2(mod[s][i] * k);
  });
}

// --- 3. Предел 100 ---
function worst() {
  let w = { sum: -1 };
  // Индекс ЧД 0 и 1 (донор — без жизни): сумма линейна по индексу, крайние значения — худшие.
  for (const t of types) for (const s of c.STAR_TYPES) for (let zi = 0; zi < Z; zi++) for (const l in c.LIFE_STATES) for (const bh of [0, 1]) {
    if (bh && l !== 'none') continue;
    const v = R.map((r, i) => val(t, s.key, zi, l, i, bh)), sum = v.reduce((a, b) => a + b, 0);
    if (sum > w.sum) w = { sum, t, s: s.key, zi, l, v };
  }
  return w;
}
let steps = 0;
for (;;) {
  const w = worst();
  if (w.sum <= LIMIT + 1e-9) break;
  const i = w.v.indexOf(Math.max(...w.v));
  const b = base[w.t][i], m = mod[w.s][i];
  const step = b > 2 ? 1 : b > 0.2 ? 0.1 : 0.01;
  if (m > 0 && m >= b * 0.25) mod[w.s][i] = r2(Math.max(0, m - (m > 2 ? 1 : 0.1)));
  else if (b > 0.01) base[w.t][i] = r2(Math.max(0.01, b - step));
  else { console.error('Не уложиться в предел:', w); process.exit(1); }
  if (++steps > 200000) { console.error('Слишком много шагов'); process.exit(1); }
}

// --- Отчёт ---
const { avg, zavg } = averages();
const f = v => (Math.round(v * 100) / 100).toString().replace('.', ',');
console.log(`Планет в замере: ${planets}. Шагов до предела: ${steps}. Максимум суммы: ${f(worst().sum)}\n`);
console.log('Ресурс                 | ранг | цель доли | доля | среднее | по зонам 1 (край) … 5 (центр)');
const order = R.map((r, i) => i).sort((a, b) => (c.RARITY_RANK[R[a].key] || 99) - (c.RARITY_RANK[R[b].key] || 99));
for (const i of order) {
  const rank = c.RARITY_RANK[R[i].key];
  console.log(`${R[i].name.padEnd(22)} | ${String(rank || '—').padEnd(4)} | ${rank ? f(1 / rank ** 2).padEnd(9) : '—'.padEnd(9)} | ${(rank ? f(avg[i] / avg[anchorI]) : '—').padEnd(4)} | ${f(avg[i]).padStart(7)} | ${zavg.map(z => f(z[i])).join(' / ')}`);
}
console.log('\nСредняя сумма по зонам: ' + zavg.map(z => f(z.reduce((a, b) => a + b, 0))).join(' / '));

if (process.argv.includes('--write')) {
  const DATA = path.join(ROOT, 'js', 'data.js');
  let txt = fs.readFileSync(DATA, 'utf8');
  for (const t of types) txt = txt.replace(new RegExp(`(${t}: \\{[\\s\\S]*?base: \\[)[^\\]]*(\\])`), `$1${base[t].join(', ')}$2`);
  for (const s of c.STAR_TYPES) txt = txt.replace(new RegExp(`(key: '${s.key}',[\\s\\S]*?mod: \\[)[^\\]]*(\\])`), `$1${mod[s.key].join(', ')}$2`);
  c.GALAXY_ZONES.forEach((z, zi) => {
    txt = txt.replace(new RegExp(`(\\{ n: ${z.n}, name: '[^']*',\\s*mult: \\[)[^\\]]*(\\])`), `$1${zone[zi].join(', ')}$2`);
  });
  fs.writeFileSync(DATA, txt);
  const fc = v => String(v).replace('.', ',');
  const tsv = R.map((r, i) => [...types.map(t => fc(base[t][i])), ...c.STAR_TYPES.map(s => fc(mod[s.key][i])), ...zone.map(z => fc(z[i]))].join('\t'));
  fs.writeFileSync(path.join(__dirname, 'sheet-paste.tsv'), tsv.join('\n') + '\n');
  console.log('\nЗаписано в js/data.js и tools/sheet-paste.tsv');
}
