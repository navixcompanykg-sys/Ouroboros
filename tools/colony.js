// Прогон экономики колонии — НАСТОЯЩИМ кодом игры. Сценарий пользователя: корабль с 10
// колонистами, шахтёрским оборудованием и стартовым сырьём в трюме садится на планету и
// поднимает колонию с нуля. Такт — 10 РЕАЛЬНЫХ минут, содержание зданий раз в час (ТЗ §8.7).
//
// ЗДЕСЬ НЕТ СВОЕЙ ЭКОНОМИКИ. Числа, формулы и правила берутся из js/colony.js, цены — из
// data/prices.json (их ведёт пользователь на prices.html), таблица компонентов — из
// data/parts.json. Раньше инструмент считал всё сам, второй реализацией, и неизбежно отставал
// от игры: к ноябрю у него остались цены вида «шахта 800 силикатов», содержание шахт сырьём и
// энергия без водорода — то есть прогон показывал экономику, которой в игре давно нет
// (docs/Уроки.md §3: второй реализации расчёта не заводить).
//
// Своё у инструмента ровно одно — ИГРОК: в каком порядке он строит, на какие гексы ставит шахты,
// куда гоняет корабль и когда разгружает трюм. Это и есть предмет прогона, всё помечено ИГРОК.
//
// Запуск:
//   node tools/colony.js                     — прогон на стартовой планете игрока
//   node tools/colony.js --star=333 --planet=2
//   node tools/colony.js --spread --n=60     — разброс по обитаемым планетам галактики #1
//   node tools/colony.js --up=2              — всё содержание (сырьё и энергия) ×2: поиск порога
//   node tools/colony.js --route=crypto      — корабль не копает на месте, а ходит авторейсами
//                                              (js/routes.js) за целью: need (путевой лист), crypto, e, s, c, b, value
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

// ───────────────────────── игра в одном контексте ─────────────────────────
// Порядок как на странице: data → gen → galaxy-gen → surface → ships → components → preset → colony.
// World в node нужен только космодрому (Colony.step зовёт World.addShip, когда собран корабль) —
// заглушка складывает такие корабли в массив, чтобы прогон их видел.
function loadGame() {
  const built = [];
  const ctx = {
    Math, console, Date, JSON, Object, Array, Number, String, Set, Map, isFinite, isNaN,
    parseInt, parseFloat, Infinity, NaN,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    World: {
      addShip(name, star, planet) { const s = { id: built.length + 2, design: name, star, planet }; built.push(s); return s; },
      save() {}, galaxy: () => null, design: () => null,
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['js/data.js', 'js/gen.js', 'js/galaxy-gen.js', 'js/surface.js',
    'js/ships.js', 'js/components.js', 'js/parts-preset.js', 'js/colony.js', 'js/routes.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx, { filename: f });
  ctx.__built = built;

  // Таблица компонентов и цены — те же файлы, что читает экран (js/planet-ui.js строки 20–26).
  const tbl = ctx.loadParts(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/parts.json'), 'utf8')));
  ctx.Colony.setHoldUnit(ctx.partParam(tbl, 'cargo', 'capSolid', 1) + ctx.partParam(tbl, 'cargo', 'capGas', 1));
  ctx.Colony.setMasses(tbl);
  const pricesFile = path.join(ROOT, 'data/prices.json');
  if (fs.existsSync(pricesFile)) ctx.Colony.setPrices(JSON.parse(fs.readFileSync(pricesFile, 'utf8')));
  ctx.__tbl = tbl;
  return ctx;
}

const G = loadGame();
const { COL, COL_GROUPS, COL_BUILDING, COL_BUILDINGS, Colony, Ship, Routes } = G;
const ROUTE_ARG = (process.argv.find(x => x.startsWith('--route=')) || '').split('=')[1] || null;
const tbl = G.__tbl;
const GROUP_NAME = G.COL_GROUP_NAME;
const GROUPS = COL_GROUPS;

// --food=N — норма еды на жителя за такт (COL.FOOD_PER_POP) — для подбора: сколько съедают люди.
{
  const a = process.argv.find(x => x.startsWith('--food='));
  if (a) COL.FOOD_PER_POP = +a.split('=')[1];
}
// --up=K множит ВСЁ содержание (сырьё и энергию) — так ищется порог рентабельности: цель
// пользователя «рентабельно 20–30 % планет, всё что ниже среднего не рентабельно».
{
  const a = process.argv.find(x => x.startsWith('--up='));
  if (a) { const k = +a.split('=')[1]; for (const B of COL_BUILDINGS) { B.up = (B.up || 0) * k; B.h2 = (B.h2 || 0) * k; } }
}

// ───────────────────────── мир ─────────────────────────
// Стартовая планета игрока — та же, что в игре: жёлтая звезда зоны 1, самая дальняя от центра
// (js/world.js startStarId), первая планета в кольце жизни.
function startStar(gal) {
  // То же правило, что в игре (js/world.js startStarId): дальняя жёлтая звезда окраины, у которой
  // есть обитаемая планета С ЖИЗНЬЮ — без биомассы колония не прокормится.
  const far = gal.stars.filter(s => s.type.key === 'yellow' && s.zone === 1)
    .sort((x, y) => (y.x * y.x + y.y * y.y) - (x.x * x.x + x.y * x.y));
  for (const s of far.slice(0, 400)) {
    const sys = G.generateSystem(s);
    if (sys.planets.some(p => p.habitable && G.PLANET_TYPES[p.type].landable && p.life !== 'none')) return s;
  }
  return far[0] || gal.stars[0];
}
function pickWorld(starId, planetIdx) {
  const gal = G.generateGalaxy(1);
  const st = starId != null ? gal.stars[starId] : startStar(gal);
  const sys = G.generateSystem(st);
  const p = planetIdx != null ? sys.planets[planetIdx]
    : sys.planets.find(x => x.habitable && G.PLANET_TYPES[x.type].landable && x.life !== 'none')
      || sys.planets.find(x => x.habitable && G.PLANET_TYPES[x.type].landable)
      || sys.planets.find(x => G.PLANET_TYPES[x.type].landable);
  return { st, p, surf: G.generateSurface(p, st) };
}

// ───────────────────────── ИГРОК ─────────────────────────
// Гексы под шахты группы — по убыванию ценности. ИГРОК: ценность — сумма, взвешенная редкостью
// (RESOURCE_STATS.avg по галактике), то есть единица сверхплотных дороже десятка силикатов.
// Исключение — энергоносители: там ценность это ЭНЕРГИЯ (содержание × энергоёмкость), колонии
// нужны киловатты, а не коллекция.
// ГЛАВНОЕ: у групп кроме энергоносителей гексы с сырьём 3 УРОВНЯ идут первыми. Без него не
// делается планетарная единица (§8.5), а без неё нет ни ферм, ни майнинг-фермы, ни купола —
// колония умирает от голода посреди полного склада.
// Ранжирование гексов под шахты — то же, что у автостройки (Colony.hexRank, js/colony.js).
const hexRank = (surf, group) => Colony.hexRank(surf, group);

// ИГРОК: порядок стройки. Вынужденный: без генератора колония жжёт только водород, без шахт нет
// сырья, без производства нет планетарных единиц, а купол, фермы и майнинг-ферма стоят по одной.
// Купол, генератор и ферма уже стоят на стартовой планете (Colony.startKit), поэтому в плане
// они идут последними — на других планетах их приходится ставить самому.
const PLAN = ['mine_e', 'mine_s', 'mine_c', 'prod', 'farm', 'mfarm', 'dome', 'gen', 'mine_b'];
const LABEL = k => COL_BUILDING[k].name.toLowerCase();
const FIX_EVERY = COL.DAY_TICKS;     // ИГРОК: раз в сутки смотрит, чего не хватает, и ставит шахту
const AUTO_HOLD = COL.DAY_TICKS;     // автономность засчитывается только после суток равновесия
const UNLOAD_AT = 0.9;               // ИГРОК: трюм забит на столько — идёт разгружаться

// ───────────────────────── прогон ─────────────────────────
function simulate(world, ticks, opts = {}) {
  const { st: gstar, p, surf } = world;
  const T0 = 0;                                  // виртуальные часы: такт = COL.TICK_MS
  const nowAt = t => T0 + t * COL.TICK_MS;

  // Колония и стартовый набор — ровно как в игре (js/planet-ui.js: startKit до выгрузки трюма).
  Ship.resetHexLog();                            // журнал снятых гексов — свой у каждого прогона
  const col = Colony.blank(nowAt(0), gstar.id, p.index);
  col.floraBase = Math.round((p.composition.find(x => x.key === 'flora') || {}).value || 0);
  col.pop = G.START_LOAD.pax;
  col.crypto = COL.CRYPTO_START;
  if (opts.startKit !== false) Colony.startKit(col, surf);
  col.auto = true;                               // прогон — это колония на автостройке

  // Корабль игрока — стартовый шаттл с его настоящей загрузкой (js/colony.js START_LOAD).
  const ship = { id: 1, design: G.START_DESIGN, star: gstar.id, planet: p.index, landed: true, at: nowAt(0) };
  Ship.ensureStart(ship);
  ship.pax = 0;   // колонисты высажены (как в игре, planet-ui found) — иначе экипаж 11 и жизнеобеспечения на 13 тактов
  const shipSt = Ship.stats(tbl, ship);
  Ship.unload(ship, col);                       // сырьё на склад, пища в запас колонии

  const rank = {}, used = {};
  for (const g in GROUPS) { rank[g] = hexRank(surf, g); used[g] = new Set(); }
  const taken = () => new Set(col.buildings.map(b => b.q + ',' + b.r));
  const nextHex = (g, want3) => {
    const busy = taken();
    return rank[g].find(h => !used[g].has(h) && !busy.has(h.q + ',' + h.r)
      && (!want3 || (h.res[GROUPS[g][2]] || 0) > 0)) || null;
  };
  // ИГРОК: корабль копает гекс той группы, которой сейчас не хватает на следующую постройку.
  const mineHex = g => rank[g][0] || rank.s[0] || surf.hexes[0];

  const events = [], hist = [];
  // Окружение авторейсов: галактика и поверхности из seed, колония — эта (других у прогона нет).
  const gal = G.generateGalaxy(1), surfs = {};
  const routeEnv = {
    galaxy: () => gal,
    surface: (s, i) => surfs[s + ':' + i] || (surfs[s + ':' + i] = (pl => pl ? G.generateSurface(pl, gal.stars[s]) : null)(G.generateSystem(gal.stars[s]).planets[i])),
    colony: (s, i) => (s === gstar.id && i === p.index ? col : null),
    advanceColony() {},   // колонию двигает сам прогон, такт за тактом
    placed() {},
  };
  let routeErr = null, routeTrips = 0;
  let auto = null, autoRun = 0, firstUniq = false, shipAt = null;
  const groupStock = g => Colony.inGroup(col, g);
  const planDone = () => PLAN.every(k => col.buildings.some(b => b.kind === k));
  // ВЕХИ ПУТИ К КОСМОДРОМУ (миссия колонии, решение пользователя 2026-11-27): такт, когда достигнута.
  const miles = {};
  const PORT = COL_BUILDING.port;
  const mark = (k, ok) => { if (ok && miles[k] == null) miles[k] = col.t; };

  for (let t = 1; t <= ticks; t++) {
    const now = nowAt(t);
    const live = Colony.live(col);

    // ИГРОК: чего колонии не хватает больше всего — на ближайшую постройку плана, на энергию зданий
    // и на содержание (на 6 часов вперёд). Туда же шлёт шаттл — копать на месте или в рейс.
    const needG = (() => {
      const next = PLAN.find(k => !col.buildings.some(b => b.kind === k));
      const cost = next ? COL_BUILDING[next].cost : {};
      let pick = 'e', worst = -Infinity;
      for (const g of ['s', 'c', 'e', 'b']) {
        const need = (cost[g === 's' ? 's' : g === 'c' ? 'c' : g === 'b' ? 'b' : 'e'] || 0)
          + (g === 'e' ? 6 * live.reduce((a, b) => a + (COL_BUILDING[b.kind].h2 || 0), 0) : 0)
          + 6 * live.reduce((a, b) => a + (COL_BUILDING[b.kind].upkeep === g ? (COL_BUILDING[b.kind].up || 0) : 0), 0)
          - groupStock(g);
        if (need > worst) { worst = need; pick = g; }
      }
      return pick;
    })();

    // ── КОРАБЛЬ В АВТОРЕЙСАХ (--route=цель): настоящий js/routes.js — сканер, полёт, съём,
    // выгрузка. Своего у инструмента тут нет ничего, кроме решения «отправить в рейс».
    if (ROUTE_ARG) {
      // ИГРОК: стоящий корабль снова отправляет в рейс раз в час, а не каждый такт.
      // ИГРОК: шаттл уходит в рейсы СРАЗУ (замечание пользователя: «шаттл может ходить в рейс сразу,
      // пополняя топливо на планетах, — зачем ждать майнинг-фермы»). Раньше прогон держал его дома до
      // фермы, и колонии без водорода до неё не доживали.
      // ИГРОК: шаттл везёт то, чего колонии не хватает больше всего (как без рейсов), а за целью
      // прогона (--route=…) — когда майнинг-ферма уже стоит. Сменилась нужда — рейс снимается.
      // --route=need — путевой лист по нуждам колонии (сама колония решает, что везти).
      const want = ROUTE_ARG === 'need' ? 'need' : Colony.has(col, 'mfarm') ? ROUTE_ARG : needG;
      if (ship.route && ship.route.target !== want && !ship.route.stop) Routes.stop(ship, now);
      if (!ship.route && ship.landed && ship.star === gstar.id && ship.planet === p.index && t % COL.UPKEEP_EVERY === 1) {
        const err = Routes.start(tbl, ship, col, want, null, now, routeEnv);
        if (err && !routeErr) { routeErr = err; events.push([t, 'авторейс не начат: ' + err]); }
      }
      Routes.tick(tbl, [ship], now, routeEnv);
      shipAt = ship.route ? 'route' : null;
    }
    if (!ship.route) {
      // ── КОРАБЛЬ. Ship.advance — настоящий код: ест пищу, снимает добычу с гекса (100 водорода
      // за съём, лимит один гекс на планету за такт), останавливается на пище, топливе и трюме.
      // needG — см. выше (чего колонии не хватает больше всего)
      const h = mineHex(needG);
      shipAt = h ? needG : null;
      if (h) ship.mine = { q: h.q, r: h.r };
      const sr = Ship.advance(tbl, ship, surf, now);
      // Разгрузка и дозаправка: трюм почти полон — выгружаем; пища на исходе — берём у колонии.
      if (Ship.cargoUsed(ship) >= shipSt.capacity * UNLOAD_AT) Ship.unload(ship, col);
      if (Ship.lifeShare(tbl, ship, shipSt) < 0.5) Ship.recharge(tbl, ship, col);
      // Водород на съём: корабль добывает его сам, а со склада берёт только из ИЗЛИШКА.
      // Так и поступил бы игрок: колонии водород нужнее — на нём стоит вся её энергия (100 за такт
      // на шахту и купол) и содержание фермы. Первый прогон этой политики без оглядки на излишек
      // высасывал склад дочиста, колония вставала «БЕЗ ЭНЕРГИИ», ферму разбирали за долги и
      // население умирало от голода при полном складе силикатов.
      const colH2Need = 6 * Colony.live(col).reduce((a2, b) => a2 + (COL_BUILDING[b.kind].h2 || 0), 0)
        + Colony.live(col).reduce((a2, b) => a2 + (COL_BUILDING[b.kind].upkeep === 'e' ? COL_BUILDING[b.kind].up || 0 : 0), 0);
      if (((ship.cargo || {}).hydrogen || 0) < Ship.HARVEST_H2 * 2 && Colony.inGroup(col, 'e') > colH2Need * 2)
        Ship.load(tbl, ship, col, 'hydrogen', Ship.HARVEST_H2 * 5);

    }

    // ── АВТОСТРОЙКА — настоящий Colony.autoStep (тот же, что в игре при включённой автостройке):
    // заказ производству и стройка. Своей логики стройки у прогона больше нет. Корабль у колонии
    // даёт на стройку свой трюм, как у игрока.
    {
      const here = ship.landed && ship.star === gstar.id && ship.planet === p.index;
      const plan = Colony.autoStep(col, surf, here ? ship : null);
      if (plan) events.push([t, 'начата стройка: ' + LABEL(plan.kind) + (plan.why ? ' (' + plan.why + ')' : '')
        + (Colony.ecology(col, surf).extra ? ' · токсичность ' + Colony.ecology(col, surf).tox : '')]);
    }

    // ── ТАКТ КОЛОНИИ — настоящий Colony.step: добыча, стройка, энергия, содержание, пища,
    // население, крипта, производство.
    if (ship.route && ship.route.trips > routeTrips) {
      routeTrips = ship.route.trips;
      if (routeTrips <= 3 || routeTrips % 10 === 0) events.push([t, 'авторейс #' + routeTrips + ' с ' + ship.route.last.from + ': '
        + Math.round(ship.route.last.brought) + ' (' + G.ROUTE_TARGETS[ship.route.target].unit + ')']);
    }
    const uniqWas = col.uniq, deadWas = col.buildings.filter(b => b.dead).length;
    const foodWas = col.food, cryptoWas = col.crypto;
    Colony.step(col, surf);
    {
      const L2 = Colony.live(col);
      mark('base', planDone());
      mark('mfarm', L2.some(b => b.kind === 'mfarm'));
      mark('prod2', L2.some(b => b.kind === 'prod' && b.lvl >= 2));
      mark('comps', Object.keys(PORT.comp).every(m => ((col.comp || {})[m + PORT.compTier] || 0) >= PORT.comp[m]));
      mark('port', L2.some(b => b.kind === 'port'));
    }
    if (col.uniq > uniqWas && !firstUniq) { firstUniq = true; events.push([t, 'первая планетарная единица']); }
    const demolished = col.buildings.filter(b => b.dead).length - deadWas;
    if (demolished > 0) events.push([t, 'РАЗОБРАНО за долги: ' + demolished + ' шт.']);

    // ── АВТОНОМНОСТЬ (критерий инструмента, в игре его нет): всё построено, рабочие
    // укомплектованы, энергия есть, долгов нет, пища не убывает, крипта не проедается,
    // сырьё 3 уровня под планетарную единицу есть и склад не тает.
    const sum = Colony.summary(col, surf);
    const back = hist[hist.length - AUTO_HOLD];
    const drain = back && (groupStock('s') < back.s - 1 || groupStock('c') < back.c - 1 || groupStock('e') < back.e - 1);
    const ok = planDone() && !col.site && !demolished && sum.workers === sum.jobs && sum.jobs > 0
      && col.powered !== false && Colony.live(col).every(b => b.missed === 0)
      && col.food >= foodWas - 1e-6 && col.crypto >= cryptoWas - 1e-6
      && !!Colony.uniqPick(col) && !drain;
    autoRun = ok ? autoRun + 1 : 0;
    if (!auto && autoRun >= AUTO_HOLD) { auto = t - AUTO_HOLD + 1; events.push([auto, '*** АВТОНОМНОСТЬ ***']); }

    hist.push({ t, pop: col.pop, paid: sum.workers, jobs: sum.jobs,
      food: Math.round(col.food), crypto: Math.round(col.crypto), uniq: col.uniq,
      s: Math.round(groupStock('s')), c: Math.round(groupStock('c')), e: Math.round(groupStock('e')),
      b: Math.round(groupStock('b')),
      mined: Math.round(Object.values(sum.rate).reduce((a, v) => a + v, 0)),
      alive: Colony.live(col).length, powered: col.powered !== false, shipAt,
      hold: Math.round(Ship.cargoUsed(ship)), cap: Math.round(sum.cap), usedCap: Math.round(sum.used) });
  }
  return { col, ship, shipSt, events, hist, auto, routeTrips, miles };
}

const fmtT = t => { const m = t * 10, d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return String(d).padStart(2) + 'д ' + String(h).padStart(2) + 'ч'; };

// ───────────────────────── отчёт ─────────────────────────
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? +a.split('=')[1] : d; };
const TICKS = arg('ticks', 2016); // 14 реальных суток
// --tox=old — прежнее правило экологии для сравнения: +10 за каждое здание на гексе сверх первого и без
// предела секций (все здания по 1 секции, TOX_PER_EXTRA = 10). Механику игры не меняет — только прогон.
if ((argv.find(x => x.startsWith('--tox=')) || '').split('=')[1] === 'old') {
  for (const B of G.COL_BUILDINGS) B.cells = 1;
  G.COL.TOX_PER_EXTRA = 10;
}

// ───────────────────────── ПОСЕВ: выживаемость колоний ─────────────────────────
// Цель пользователя (2026-11-27): «не все колонии должны выживать, чтоб мотивировать игрока искать
// пригодные планеты или обеспечивать колонии на старте. Посев из 20 колоний в разных системах:
// колония встаёт в случайной системе на периферии галактики. Без рейсов должно выживать примерно
// 50 %, с рейсами почти все — допускается, что кто-то не выживет, но не более 20 %».
// Колония получает то же, что стартовая игрока: набор (купол, генератор, ферма, 10 000 силикатов)
// и шаттл с загрузкой. Планета в системе — как у старта: обитаемая с жизнью, иначе обитаемая,
// иначе любая твёрдая.
// ВЫЖИЛА — к концу прогона рабочие работают, шахты добывают, население за последние сутки не
// убыло, и крипта либо не убывает, либо её хватит ещё на неделю при нынешнем расходе.
function survived(r) {
  const h = r.hist, last = h[h.length - 1], prev = h[h.length - 1 - COL.DAY_TICKS] || h[0];
  const dCrypto = last.crypto - prev.crypto;                    // за сутки
  const why = last.paid <= 0 ? 'рабочих нет' : last.mined <= 0 ? 'добыча стоит'
    : last.pop < prev.pop ? 'население убывает'
    : dCrypto < -1 && last.crypto < -dCrypto * 7 ? 'крипта кончится за неделю' : null;
  return { ok: !why, why, last };
}
if (argv.includes('--survive')) {
  const gal = G.generateGalaxy(1);
  const rnd = G.mulberry32(arg('seed', 20261127));
  const pool = gal.stars.filter(s => s.zone === 1);
  const N = arg('n', 20), picks = [];
  while (picks.length < N && pool.length) {
    const s = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    const sys = G.generateSystem(s);
    const solid = x => G.PLANET_TYPES[x.type].landable && !G.PLANET_TYPES[x.type].lowOrbit;
    const pl = sys.planets.find(x => x.habitable && solid(x) && x.life !== 'none')
      || sys.planets.find(x => x.habitable && solid(x)) || sys.planets.find(solid);
    if (pl) picks.push({ st: s, p: pl });
  }
  console.log('ПОСЕВ: ' + picks.length + ' колоний на периферии (зона 1), ' + TICKS + ' тактов, '
    + (ROUTE_ARG ? 'авторейсы «' + ROUTE_ARG + '»' : 'без рейсов') + ', seed ' + arg('seed', 20261127));
  console.log('планета                 звезда   жизнь     итог      насел  раб    крипта  план.ед  добыча  рейсов  токс(база+гексы−очист)  K    причина');
  let ok = 0; const toxAll = [], portRows = [];
  for (const w of picks) {
    const r = simulate({ st: w.st, p: w.p, surf: G.generateSurface(w.p, w.st) }, TICKS, { startKit: true });
    const v = survived(r);
    if (v.ok) ok++;
    portRows.push({ name: w.p.name, m: r.miles, ok: v.ok, col: r.col });
    const surf = G.generateSurface(w.p, w.st), e = Colony.ecology(r.col, surf), pr = r.col.popRates || {};
    toxAll.push({ tox: e.tox, extra: e.extra * COL.TOX_PER_EXTRA, base: e.base, ok: v.ok });
    const toxS = (e.tox + ' (' + e.base + '+' + e.extra * COL.TOX_PER_EXTRA + '−' + e.clean * COL.TOX_CLEAN + ')').padStart(22);
    console.log(w.p.name.padEnd(24) + w.st.type.key.padEnd(9) + String(w.p.life).padEnd(10)
      + (v.ok ? 'ЖИВА' : 'гибнет').padEnd(10) + String(v.last.pop).padStart(5) + (v.last.paid + '/' + v.last.jobs).padStart(6)
      + String(v.last.crypto).padStart(10) + String(v.last.uniq).padStart(9) + String(v.last.mined).padStart(8)
      + String(r.routeTrips || 0).padStart(8) + '  ' + toxS + String(Math.floor(pr.K || 0)).padStart(5) + '  ' + (v.why || ''));
  }
  const avg = f => (toxAll.reduce((a, x) => a + f(x), 0) / toxAll.length).toFixed(1);
  console.log('\nТОКСИЧНОСТЬ: средняя ' + avg(x => x.tox) + ', из неё от застройки гексов +' + avg(x => x.extra) + ' (максимум +' + Math.max(...toxAll.map(x => x.extra)) + ')');
  // Путь к космодрому: на каком такте пройдена каждая веха; где колония застряла.
  const STAGES = [['base', 'базовый набор'], ['mfarm', 'майнинг-ферма'], ['prod2', 'производство 2 ур.'], ['comps', 'компоненты на космодром'], ['port', 'КОСМОДРОМ']];
  const day = t => t == null ? '—' : (t / COL.DAY_TICKS).toFixed(1);
  console.log('\nПУТЬ К КОСМОДРОМУ (сутки)    ' + STAGES.map(x => x[1].slice(0, 12).padStart(13)).join('') + '   застряла на');
  for (const x of portRows) {
    const stuck = STAGES.find(st => x.m[st[0]] == null);
    const pr = Colony.live(x.col).find(b => b.kind === 'prod');
    const why = !stuck ? '' : stuck[0] === 'prod2' && pr ? ' (' + Colony.canUpgrade(x.col, pr) + ')'
      : stuck[0] === 'comps' ? ' (заказ ' + JSON.stringify(x.col.order) + ')' : '';
    console.log(x.name.padEnd(28) + STAGES.map(st => day(x.m[st[0]]).padStart(13)).join('') + '   ' + (stuck ? stuck[1] : 'дошла') + why + (x.ok ? '' : ' · гибнет'));
  }
  console.log('ДОШЛИ ДО КОСМОДРОМА: ' + portRows.filter(x => x.m.port != null).length + ' из ' + portRows.length
    + STAGES.map(st => ' · ' + st[1] + ' ' + portRows.filter(x => x.m[st[0]] != null).length).join(''));
  console.log('ВЫЖИЛО: ' + ok + ' из ' + picks.length + ' = ' + Math.round(ok / picks.length * 100) + '%');
  process.exit(0);
}

if (argv.includes('--spread')) {
  // Разброс по обитаемым планетам: где колония выходит в автономность, а где умирает. Стартовый
  // набор даётся ТОЛЬКО на планете спавна, поэтому в разбросе его нет — колония поднимается
  // с одного корабля, как любая вторая колония игрока.
  const gal = G.generateGalaxy(1);
  const rows = [];
  for (let i = 0; i < gal.stars.length && rows.length < arg('n', 60); i++) {
    const star = gal.stars[i];
    const sys = G.generateSystem(star);
    const pl = sys.planets.find(x => x.habitable && G.PLANET_TYPES[x.type].landable);
    if (!pl) continue;
    const surf = G.generateSurface(pl, star);
    const r = simulate({ st: star, p: pl, surf }, TICKS, { startKit: argv.includes('--kit') });
    const last = r.hist[r.hist.length - 1], prev = r.hist[r.hist.length - 1 - COL.DAY_TICKS] || r.hist[0];
    rows.push({ name: pl.name, zone: star.zone, life: pl.life, auto: r.auto, pop: last.pop, uniq: last.uniq,
      alive: last.alive, mined: last.mined,
      acc: Math.round((last.s + last.c + last.e - prev.s - prev.c - prev.e) / COL.DAY_TICKS) });
  }
  console.log('разброс по ' + rows.length + ' обитаемым планетам (' + TICKS + ' тактов, набор '
    + (argv.includes('--kit') ? 'даётся' : 'не даётся') + '):');
  console.log('планета              зона жизнь    автоном  насел  план.ед  зданий  добыча  копит/такт');
  for (const r of rows) console.log(r.name.padEnd(20) + String(r.zone).padStart(4) + ' ' + r.life.padEnd(8)
    + (r.auto ? fmtT(r.auto) : '   нет  ').padStart(9) + String(r.pop).padStart(7) + String(r.uniq).padStart(9)
    + String(r.alive).padStart(8) + String(r.mined).padStart(8) + String(r.acc).padStart(12));
  const good = rows.filter(r => r.auto);
  const mines = rows.map(r => r.mined).sort((a, b) => a - b);
  console.log('\nрентабельны (вышли в автономность): ' + good.length + ' из ' + rows.length
    + ' = ' + Math.round(good.length / rows.length * 100) + '%'
    + (good.length ? ', медиана времени ' + fmtT(good.map(r => r.auto).sort((a, b) => a - b)[good.length >> 1]).trim() : ''));
  console.log('добыча по выборке: средняя ' + Math.round(mines.reduce((a, b) => a + b, 0) / Math.max(1, mines.length))
    + ', медиана ' + mines[mines.length >> 1]
    + ', у рентабельных минимум ' + (good.length ? Math.min(...good.map(r => r.mined)) : '—') + ' ед./такт');
  process.exit(0);
}

const world = pickWorld(arg('star', null), arg('planet', null));
const r = simulate(world, TICKS, { startKit: !argv.includes('--nokit') });

console.log('ПЛАНЕТА: ' + world.p.name + ' (' + world.st.name + ', зона ' + world.st.zone + ', ' + world.p.type
  + ', кольцо жизни: ' + (world.p.habitable ? 'да' : 'нет') + ', жизнь: ' + world.p.life
  + ', гексов ' + world.surf.hexes.length + ')');
console.log('КОРАБЛЬ: ' + G.START_DESIGN + ' — трюм ' + Math.round(r.shipSt.capacity) + ' объёма, жизнеобеспечение на '
  + Ship.lifeCap(tbl, r.shipSt) + ' пищи (' + Ship.lifeTicks(tbl, r.ship, r.shipSt) + ' тактов при '
  + Ship.crew(r.ship) + ' душах), пассажиров ' + (r.ship.pax || 0));
console.log('ЦЕНЫ: шахта ' + (COL_BUILDING.mine_s.cost.s || 0) + ' структурного, производство '
  + (COL_BUILDING.prod.cost.s || 0) + '+' + (COL_BUILDING.prod.cost.c || 0) + ', ферма '
  + (COL_BUILDING.farm.cost.s || 0) + '+' + (COL_BUILDING.farm.cost.c || 0) + '+' + (COL_BUILDING.farm.cost.b || 0)
  + ', купол ' + (COL_BUILDING.dome.cost.s || 0) + '+' + (COL_BUILDING.dome.cost.c || 0) + '+' + (COL_BUILDING.dome.cost.b || 0)
  + '  (data/prices.json)');
console.log('ЭНЕРГИЯ: шахта ' + COL_BUILDING.mine_s.h2 + ' водорода за такт, купол ' + COL_BUILDING.dome.h2
  + ', производство ' + COL_BUILDING.prod.h2 + '; содержание сырьём: купол ' + COL_BUILDING.dome.up
  + ', ферма ' + COL_BUILDING.farm.up + ', генератор ' + COL_BUILDING.gen.up + ', шахты ' + COL_BUILDING.mine_s.up);
console.log('БАЗА НАСЕЛЕНИЯ по дикой флоре (§8.3): ' + (r.col.floraBase || 0)
  + ((r.col.floraBase || 0) === 0 ? ' — своей жизни нет, пища только искусственная' : ''));

console.log('\nГЕКСЫ ПОД ПЕРВЫЕ ШАХТЫ (следующие садятся на следующие по ценности):');
for (const g in GROUPS) {
  const h = hexRank(world.surf, g)[0];
  const row = h ? GROUPS[g].map(k => k + ' ' + Math.round(h.res[k] || 0)).join(', ') : 'ресурса нет';
  const out = h ? GROUPS[g].reduce((a, k) => a + COL.MINE_K * (h.res[k] || 0), 0) : 0;
  console.log('  ' + GROUP_NAME[g].padEnd(16) + (h ? (h.q + ',' + h.r).padEnd(7) + h.type.padEnd(11) : ''.padEnd(18))
    + row.padEnd(46) + '→ ' + Math.round(out) + ' ед./такт');
}

console.log('\nХОД СТРОЙКИ:');
for (const [t, s] of r.events) console.log('  ' + fmtT(t) + '  (такт ' + String(t).padStart(4) + ')  ' + s);

console.log('\nСОСТОЯНИЕ КОЛОНИИ:');
console.log('  время      такт  насел  раб  пища  крипта  план.ед  структ  вычисл  энергонос  добыча  трюм  корабль');
for (const h of r.hist) {
  if (h.t % COL.DAY_TICKS !== 0 && h.t !== r.hist.length && h.t !== r.auto) continue;
  console.log('  ' + fmtT(h.t) + ' ' + String(h.t).padStart(5) + String(h.pop).padStart(7)
    + (h.paid + '/' + h.jobs).padStart(6)
    + String(h.food).padStart(6) + String(h.crypto).padStart(8) + String(h.uniq).padStart(9)
    + String(h.s).padStart(8) + String(h.c).padStart(8) + String(h.e).padStart(11)
    + String(h.mined).padStart(8) + String(h.hold).padStart(7)
    + (h.shipAt === 'route' ? '  авторейс' : h.shipAt ? '  ' + GROUP_NAME[h.shipAt] : '  —')
    + (h.powered ? '' : '  БЕЗ ЭНЕРГИИ')
    + (h.t === r.auto ? '   ← автономность' : ''));
}

const last = r.hist[r.hist.length - 1], prev = r.hist[r.hist.length - 1 - COL.DAY_TICKS] || r.hist[0];
console.log('\nИТОГ: ' + (r.auto ? 'автономность на такте ' + r.auto + ' (' + fmtT(r.auto).trim() + ' реального времени)' : 'АВТОНОМНОСТИ НЕТ'));
console.log('  живых зданий ' + last.alive + ' из ' + PLAN.length + ', население ' + last.pop
  + ', планетарных единиц ' + last.uniq + ', склад ' + last.usedCap + ' из ' + last.cap + ' объёма');
const per = n => (n >= 0 ? '+' : '') + Math.round(n / COL.DAY_TICKS) + ' ед./такт';
const dS = last.s - prev.s, dC = last.c - prev.c, dE = last.e - prev.e;
console.log('  накопление за последние сутки: структурные ' + per(dS) + ', вычислительные ' + per(dC)
  + ', энергоносители ' + per(dE) + '  (добыча шахт ' + last.mined + ' ед./такт)');
const acc = (dS + dC + dE) / COL.DAY_TICKS, share = last.mined ? acc / last.mined : 0;
console.log('  копит ' + Math.round(share * 100) + '% добычи'
  + (Math.abs(share) < 0.1 ? ' — равновесие' : share > 0 ? ' — копит слишком много' : ' — проедает запас'));
// Отходы: что колония выбросила за прогон, когда склад был полон (col.waste, js/colony.js).
{
  const w = r.col.waste || {}, keys = Object.keys(w).filter(k => w[k] >= 1).sort((a, b) => w[b] - w[a]);
  console.log('  отходы (выброшено при полном складе): ' + (keys.length
    ? keys.map(k => k + ' ' + Math.round(w[k]).toLocaleString('ru')).join(', ') : 'нет'));
  const cm = r.col.comp || {};
  console.log('  на складе: сырьё ' + Math.round(Colony.volSum(r.col.stock)).toLocaleString('ru') + ' объёма, пища '
    + Math.round(r.col.food) + ', компоненты ' + Math.round(Colony.volSum(cm)).toLocaleString('ru') + ' объёма ('
    + Object.keys(cm).filter(k => cm[k] > 0.5).map(k => k + ' ' + Math.round(cm[k]) + ' шт. по ' + Colony.volOf(k)).join(', ') + ')');
  console.log('  майнинг-ферма 1 ур.: ' + COL.MFARM_CRYPTO + ' крипты за такт из ' + Math.round(COL.MFARM_H2) + ' водорода'
    + (ROUTE_ARG ? '; авторейсов ' + (r.routeTrips || 0) : ''));
}
if (r.col.log.length) {
  console.log('\nПОСЛЕДНИЕ ЗАПИСИ ЖУРНАЛА КОЛОНИИ (его же видит игрок на экране):');
  for (const l of r.col.log.slice(0, 12)) console.log('  такт ' + String(l.t).padStart(4) + '  ' + l.text);
}
