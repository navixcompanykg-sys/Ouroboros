// Редкость ресурсов в галактике: средняя концентрация каждого из 12 ресурсов по ВСЕМ планетам
// галактики #1 и её отношение к среднему по всем ресурсам. Числа нужны справочнику — игроку
// важно знать, что он ищет: водород встречается всюду, антиматерия почти нигде.
//
// Запуск: node tools/resource-stats.js [--write]
//   --write вписывает в js/data.js ДВА блока:
//     RESOURCE_STATS — средняя концентрация каждого ресурса на планету,
//     RESOURCE_VALUE — относительная стоимость сырья, ОДНА формула на всё, как в v2
//                      (server/economy.go recommendedPriceFromTotals):
//                      цена = 5 × (запас самого частого ÷ запас этого), кратно 5.
//   Оба блока генерируются здесь, вручную их не править: следующий прогон перезапишет.
// Распределение планет по сочетаниям берётся из кэша tools/.hist-g1.json (см. tools/lib.js) —
// он не зависит от таблицы ресурсов, но зависит от генератора: поменял генератор — удали кэш.
const fs = require('fs');
const path = require('path');
const { ROOT, load, histogram } = require('./lib.js');

const ctx = load();
const { hist, planets } = histogram(ctx);

// Сумма концентраций по всем планетам: ключ сочетания — тип планеты|звезда|зона|жизнь|индекс ЧД.
const total = {};
for (const r of ctx.RESOURCES) total[r.key] = 0;
for (const key in hist) {
  const [type, star, zone, life, bh] = key.split('|');
  const starType = ctx.STAR_TYPES.find(s => s.key === star);
  const comp = ctx.composition(type, starType, ctx.GALAXY_ZONES[+zone], life, +bh);
  const n = hist[key];
  for (const c of comp) total[c.key] += c.value * n;
}

const avg = {};                                   // средняя концентрация на планету
for (const r of ctx.RESOURCES) avg[r.key] = total[r.key] / planets;
const mean = Object.values(avg).reduce((a, b) => a + b, 0) / ctx.RESOURCES.length;

const f = (x, k = 2) => x.toLocaleString('ru-RU', { minimumFractionDigits: k, maximumFractionDigits: k });
const pad = (s, n) => String(s).padEnd(n), padl = (s, n) => String(s).padStart(n);

console.log('РЕДКОСТЬ РЕСУРСОВ (галактика #1, ' + planets.toLocaleString('ru-RU') + ' планет)');
console.log(pad('ресурс', 26) + pad('группа', 16) + padl('средняя', 10) + padl('× среднего', 12) + padl('реже среднего в', 18));
const rows = ctx.RESOURCES.map(r => ({ r, a: avg[r.key], rel: avg[r.key] / mean }))
  .sort((a, b) => b.a - a.a);
for (const { r, a, rel } of rows)
  console.log(pad(r.name, 26) + pad(r.group, 16) + padl(f(a), 10) + padl(f(rel), 12) +
    padl(rel >= 1 ? '—' : f(1 / rel, 1) + ' раза', 18));
console.log('\nсреднее по всем ресурсам: ' + f(mean) + ' на планету');

if (process.argv.includes('--write')) {
  const file = path.join(ROOT, 'js', 'data.js');
  let src = fs.readFileSync(file, 'utf8');
  const crlf = src.includes('\r\n');
  let s = src.split('\r\n').join('\n');
  const body = ctx.RESOURCES.map(r =>
    `  ${r.key}: { avg: ${+avg[r.key].toFixed(3)}, rel: ${+(avg[r.key] / mean).toFixed(3)} },`).join('\n');
  const block = `// ЗАМЕР РЕДКОСТИ (tools/resource-stats.js, галактика #1, ${planets} планет): avg — средняя
// концентрация ресурса на планету, rel — во сколько раз это больше среднего по всем ресурсам
// (${+mean.toFixed(3)}). Пересчитывать после правок генератора или таблицы ресурсов.
const RESOURCE_STATS = {
${body}
};`;
  // ---------- относительная стоимость: универсальный эталон ----------
  const maxAvg = Math.max(...ctx.RESOURCES.map(r => avg[r.key]));
  const round5 = v => Math.max(5, Math.round(v / 5) * 5);
  const value = {};
  for (const r of ctx.RESOURCES) value[r.key] = round5(5 * maxAvg / (avg[r.key] || 1e-9));
  const vBody = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]]
    .map(row => '  ' + row.map(i => ctx.RESOURCES[i].key + ': ' + value[ctx.RESOURCES[i].key]).join(', ') + ',').join('\n');
  const vBlock = `// ОТНОСИТЕЛЬНАЯ СТОИМОСТЬ СЫРЬЯ — универсальный эталон, ОДНА формула на все двенадцать, как
// в v2 (server/economy.go recommendedPriceFromTotals): цена = 5 × (запас самого распространённого
// ресурса ÷ запас этого), округлённо до пятёрки. Никаких отдельных игродизайнерских
// коэффициентов: кого в галактике меньше — тот дороже. Водород выходит в 5 у.е. не потому, что
// так назначено, а потому что он самый частый по факту генерации. Через эти условные единицы
// сравнивается что угодно: сырьё, компонент, постройка, корабль.
// Считается из RESOURCE_STATS — tools/resource-stats.js --write. Руками не править.
const RESOURCE_VALUE = {
${vBody}
};`;

  const both = block + '\n\n' + vBlock;
  s = s.includes('const RESOURCE_STATS = {')
    ? s.replace(/\/\/ ЗАМЕР РЕДКОСТИ[\s\S]*?const RESOURCE_STATS = \{[\s\S]*?\n\};(\s*\/\/ ОТНОСИТЕЛЬНАЯ СТОИМОСТЬ[\s\S]*?const RESOURCE_VALUE = \{[\s\S]*?\n\};)?/, both)
    : s.replace(/const RARITY_RANK = \{/, both + '\n\nconst RARITY_RANK = {');
  fs.writeFileSync(file, crlf ? s.split('\n').join('\r\n') : s);
  console.log('\nЭТАЛОН СТОИМОСТИ (у.е. за единицу сырья):');
  for (const r of ctx.RESOURCES) console.log('  ' + r.name.padEnd(26) + String(value[r.key]).padStart(5));
  console.log('\nЗаписано в js/data.js: RESOURCE_STATS и RESOURCE_VALUE');
}
