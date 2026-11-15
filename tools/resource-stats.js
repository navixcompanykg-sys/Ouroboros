// Редкость ресурсов в галактике: средняя концентрация каждого из 12 ресурсов по ВСЕМ планетам
// галактики #1 и её отношение к среднему по всем ресурсам. Числа нужны справочнику — игроку
// важно знать, что он ищет: водород встречается всюду, антиматерия почти нигде.
//
// Запуск: node tools/resource-stats.js [--write]   (--write вписывает RESOURCE_STATS в js/data.js)
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
  s = s.includes('const RESOURCE_STATS = {')
    ? s.replace(/\/\/ ЗАМЕР РЕДКОСТИ[\s\S]*?const RESOURCE_STATS = \{[\s\S]*?\n\};/, block)
    : s.replace(/const RARITY_RANK = \{/, block + '\n\nconst RARITY_RANK = {');
  fs.writeFileSync(file, crlf ? s.split('\n').join('\r\n') : s);
  console.log('\nЗаписано в js/data.js: RESOURCE_STATS');
}
