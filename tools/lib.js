// Общее для инструментов баланса: загрузка data.js/генераторов и распределение планет
// галактики #1 по сочетаниям (тип планеты × звезда × зона × жизнь × индекс чёрной дыры). Распределение не зависит
// от таблицы ресурсов, поэтому кэшируется в tools/.hist-g1.json (удалить при смене генератора).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
function load() {
  const ctx = { Math };
  vm.createContext(ctx);
  for (const f of ['js/data.js', 'js/gen.js', 'js/galaxy-gen.js', 'js/surface.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^const /gm, 'var '), ctx);
  return ctx;
}
function histogram(ctx) {
  const file = path.join(__dirname, '.hist-g1.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const hist = {};
  let planets = 0;
  for (const st of ctx.generateGalaxy(1).stars) for (const p of ctx.generateSystem(st).planets) {
    const k = [p.type, st.type.key, st.zone - 1, p.life, st.bh ? st.bh.index : 0].join('|');
    hist[k] = (hist[k] || 0) + 1;
    planets++;
  }
  const out = { planets, hist };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}
module.exports = { ROOT, load, histogram };
