// Проверка хака «всегда быстро + быстрый съём по планетам» — НАСТОЯЩИМ кодом игры.
//
// Вопрос пользователя (2026-11-27): «проверь, нет ли такого хака: полёт всегда в быстром режиме
// с добычей на планетах быстрым сбором, чтоб компенсировать затраты. Корабли могут потреблять
// ресурсы, добытые на планетах быстрой добычей, но не на всех планетах есть ресурсы, да и это
// время полёта до них». Чинить пока не велено — только проверить, сработает или нет.
//
// Почему это вообще может быть хаком: лимит съёма — ОДИН гекс на ПЛАНЕТУ за такт (ТЗ §8.10), и
// хранится он на корабле по планетам. Значит, корабль, который за 10 минут облетает несколько
// планет, снимает норму с каждой — в разы больше, чем стоя на одной. Цена — топливо «Быстро».
// Окупается, если съём на планетах сам даёт топливо корабля (у шаттла — тритий) в достатке.
//
// Сценарий: стартовый шаттл с полным баком и 3 000 водорода на съёмы в трюме, без колонии и без
// заправки со склада. Облетает твёрдые планеты и газовые гиганты своей системы по порядку орбит,
// туда-обратно, «Быстро» (тяга всё время, груз тяжелит — Ship.loaded). На каждой планете — один
// мгновенный съём с лучшего гекса (Ship.harvest: все ресурсы гекса, 100 водорода из трюма), сразу
// долив бака из трюма (Ship.refuel). Время: перелёты в секундах; на планету, где в этом такте уже
// брали, корабль не летит раньше следующего такта. Конец — трюм полон, кончился водород на съёмы
// или не хватает бака на следующий перелёт («застрял»).
//
// Сравнение — «стоять на одной планете»: съём раз в такт с лучшего гекса той же системы.
//
// Запуск: node tools/fasthop.js [--n=40] [--seed=7] [--zone=1]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const ctx = {
  Math, console, Date, JSON, Object, Array, Number, String, Set, Map, isFinite, isNaN, parseInt, parseFloat, Infinity, NaN,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  World: { addShip() {}, save() {}, galaxy: () => null, design: () => null },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['js/data.js', 'js/gen.js', 'js/galaxy-gen.js', 'js/surface.js', 'js/ships.js', 'js/components.js',
  'js/parts-preset.js', 'js/colony.js', 'js/routes.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx, { filename: f });
const G = ctx;
const tbl = G.loadParts(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/parts.json'), 'utf8')));
G.Colony.setHoldUnit(G.partParam(tbl, 'cargo', 'capSolid', 1) + G.partParam(tbl, 'cargo', 'capGas', 1));
G.Colony.setMasses(tbl);
const { Colony, Ship, Routes, COL } = G;

const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? +a.split('=')[1] : d; };
const TICK = COL.TICK_MS;

function newShip(star, planet) {
  return { id: 1, design: G.START_DESIGN, star, planet, landed: true, at: 0, fuel: 1, cargo: { hydrogen: 3000 }, pax: 0, food: null };
}

// Лучший гекс планеты для хакера: больше всего топлива корабля, при равенстве — больше объёма.
function bestHex(surf, fuelKey) {
  let best = null, bv = -1;
  for (const h of surf.hexes) {
    const o = Colony.shipOutput(h), v = (o[fuelKey] || 0) * 1e6 + Object.values(o).reduce((a, x) => a + x, 0);
    if (v > bv) { bv = v; best = h; }
  }
  return best;
}

function runSystem(star) {
  const sys = G.generateSystem(star);
  const planets = sys.planets.filter(p => G.PLANET_TYPES[p.type].landable).sort((a, b) => a.a - b.a);
  if (planets.length < 2) return null;
  const surf = {}; for (const p of planets) surf[p.index] = G.generateSurface(p, star);
  const probe = newShip(star.id, planets[0].index);
  const tank = Ship.tankOf(probe);
  const st = Ship.stats(tbl, probe), hull = st.mass, fsEmpty = G.shipStats(G.findDesign(probe.design));
  const hex = {}; for (const p of planets) hex[p.index] = bestHex(surf[p.index], tank.key);
  const fuelPerHarvest = planets.map(p => Colony.shipOutput(hex[p.index])[tank.key] || 0);

  // Гексы планеты для хакера — лучшие первыми (больше топлива корабля, потом объёма).
  const order = {};
  for (const p of planets) order[p.index] = surf[p.index].hexes.slice().sort((x, y) => {
    const ox = Colony.shipOutput(x), oy = Colony.shipOutput(y);
    return ((oy[tank.key] || 0) - (ox[tank.key] || 0)) * 1e6 + (Object.values(oy).reduce((a, v) => a + v, 0) - Object.values(ox).reduce((a, v) => a + v, 0));
  });

  // ── хакер: облёт «Быстро». Правила съёма (2026-11-27): журнал корабля — один гекс на планету за
  // такт; журнал гексов — снятый гекс закрыт до конца такта для всех. Корабль один, так что
  // решает журнал корабля: на каждой посадке — один съём с лучшего свободного гекса. ──
  Ship.resetHexLog();
  const ship = newShip(star.id, planets[0].index);
  let now = 0, i = 0, dir = 1, harvests = 0, fuelBurned = 0, fuelMined = 0, end = null, waits = 0, landings = 0;
  const t0 = now;
  for (let guard = 0; guard < 5000 && !end; guard++) {
    const p = planets[i];
    const h = order[p.index].find(x => Ship.harvestReady(ship, star.id, p.index, x, now));
    if (!h) { now = (Colony.tickAt(now) + 1) * TICK; continue; }        // здесь уже брал — ждём такт
    landings++;
    const before = (ship.cargo || {})[tank.key] || 0;
    const r = Ship.harvest(tbl, ship, h, star.id, p.index, now);
    if (r.err) { end = r.err === 'трюм полон' ? 'трюм полон' : r.err.startsWith('в трюме нет водорода') ? 'кончился водород на съёмы' : r.err; break; }
    harvests++;
    fuelMined += ((ship.cargo || {})[tank.key] || 0) - before;
    Ship.refuel(ship, null);
    // Конец — 90 % трюма: дальше съём режется под свободное место и корабль часами добирает крохи.
    if (r.full || Ship.cargoUsed(ship) >= 0.9 * st.capacity) { end = 'трюм полон'; break; }
    // следующая планета: туда-обратно по орбитам
    if (i + dir < 0 || i + dir >= planets.length) dir = -dir;
    const q = planets[i + dir];
    const fsL = Ship.loaded(fsEmpty, hull / (hull + Ship.cargoMass(ship)));
    const need = Routes.legFuel(fsL, star.id, p, star.id, q);
    if (need > ship.fuel + 1e-9) {
      // Бака не хватает. Если планета даёт топливо — ждём такт, снимаем ещё и доливаем; нет — застрял.
      if ((Colony.shipOutput(order[p.index][0])[tank.key] || 0) > 0) { waits++; now = (Colony.tickAt(now) + 1) * TICK; continue; }
      end = 'застрял: бака нет, топлива тут нет'; break;
    }
    const sec = Routes.legSec(fsL, star.id, p, star.id, q);
    ship.fuel -= need; fuelBurned += need * tank.units;
    now += sec * 1000;
    i += dir;
  }
  const hours = Math.max(1e-9, (now - t0) / 3600000);
  const vol = Ship.cargoUsed(ship);

  // ── сравнение: стоять на лучшей планете, съём раз в такт с лучшего гекса ──
  let bestVol = 0;
  for (const p of planets) { const v = Object.values(Colony.shipOutput(order[p.index][0])).reduce((a, x) => a + x, 0); if (v > bestVol) bestVol = v; }
  const stayPerHour = 6 * bestVol;
  const cap = st.capacity;
  return {
    cap, fill: vol / cap, hoursFull: end === 'трюм полон' ? hours : Infinity,
    stayFull: stayPerHour > 0 ? 0.9 * cap / stayPerHour : Infinity, waits, landings,
    name: star.name, type: star.type.key, zone: star.zone, planets: planets.length,
    fuelPlanets: fuelPerHarvest.filter(x => x > 0).length, maxFuel: Math.max(...fuelPerHarvest),
    harvests, hours, end: end || 'лимит шагов', vol, perHour: vol / hours, stayPerHour,
    fuelBurned, fuelMined, tankLeft: ship.fuel,
  };
}

// ── выборка систем ──
const gal = G.generateGalaxy(1);
const rnd = G.mulberry32(arg('seed', 7));
const zone = arg('zone', 0);
const pool = gal.stars.filter(s => !zone || s.zone === zone);
const N = arg('n', 40), rows = [];
while (rows.length < N && pool.length) {
  const s = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
  const r = runSystem(s); if (r) rows.push(r);
}
const fuelName = G.FUEL[Ship.tankOf(newShip(0, 0)).key].name.toLowerCase();
const f1 = x => (Math.round(x * 10) / 10).toString().replace('.', ',');
console.log('ХАК «ВСЕГДА БЫСТРО + СЪЁМ ПО ПЛАНЕТАМ»: ' + rows.length + ' систем' + (zone ? ', зона ' + zone : '') +
  ', стартовый шаттл (топливо — ' + fuelName + ', бак ' + Ship.tankOf(newShip(0, 0)).units + ')');
console.log('система            звезда   план  с топл  макс/съём  съёмов  ждал   часов  трюм  итог                              90% за, ч  стоя, ч     ×');
let wins = 0, stuck = 0;
const ks = [];
for (const r of rows) {
  // Мерило — за сколько часов набирается 90 % трюма: облётом (только если реально набрал) и стоя.
  const k = isFinite(r.hoursFull) && r.hoursFull > 0 && isFinite(r.stayFull) ? r.stayFull / r.hoursFull : 0;
  ks.push(k);
  if (k >= 1.5) wins++;
  if (r.end.startsWith('застрял')) stuck++;
  console.log(r.name.padEnd(18) + r.type.padEnd(9) + String(r.planets).padStart(4) + String(r.fuelPlanets).padStart(8)
    + f1(r.maxFuel).padStart(11) + String(r.harvests).padStart(8) + String(r.waits).padStart(6) + f1(r.hours).padStart(8)
    + (Math.round(r.fill * 100) + '%').padStart(6) + '  ' + r.end.padEnd(34)
    + (isFinite(r.hoursFull) ? f1(r.hoursFull) : '—').padStart(10) + f1(r.stayFull).padStart(9) + f1(k).padStart(6));
}
ks.sort((a, b) => a - b);
console.log('\nХАК ВЫГОДЕН (90 % трюма в 1,5+ раза быстрее, чем стоя на лучшей планете): ' + wins + ' из ' + rows.length
  + ' = ' + Math.round(wins / rows.length * 100) + '%;  медиана выигрыша ×' + f1(ks[ks.length >> 1])
  + ';  застрял без топлива (на планете, где нет топлива корабля): ' + stuck + ' из ' + rows.length);
