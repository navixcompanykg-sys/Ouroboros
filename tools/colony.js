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
    'js/ships.js', 'js/components.js', 'js/parts-preset.js', 'js/colony.js'])
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
const { COL, COL_GROUPS, COL_BUILDING, COL_BUILDINGS, Colony, Ship } = G;
const tbl = G.__tbl;
const GROUP_NAME = G.COL_GROUP_NAME;
const GROUPS = COL_GROUPS;

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
function hexRank(surf, group) {
  const weight = k => group === 'e' ? (COL.H2_PER_UNIT[k] || 1)
    : 1 / (G.RESOURCE_STATS[k] ? G.RESOURCE_STATS[k].avg : 1);
  const t3 = GROUPS[group][2];
  return surf.hexes
    .filter(h => GROUPS[group].some(k => (h.res[k] || 0) > 0))
    .map(h => ({ h, three: group !== 'e' && (h.res[t3] || 0) > 0 ? 1 : 0,
      v: GROUPS[group].reduce((a, k) => a + (h.res[k] || 0) * weight(k), 0) }))
    // Сначала ВСЕ гексы с сырьём 3 уровня, и только потом богатые. Без этого правила
    // взвешенная ценность ставит шахту на гекс «силикаты 159, сверхплотные 0», колония никогда
    // не набирает 10 единиц третьего уровня, планетарная единица не делается, а значит нет ни
    // майнинг-фермы, ни крипты — рабочие уходят и колония умирает при полном складе.
    .sort((a, b) => b.three - a.three || b.v - a.v)
    .map(x => x.h);
}

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
  const col = Colony.blank(nowAt(0), gstar.id, p.index);
  col.floraBase = Math.round((p.composition.find(x => x.key === 'flora') || {}).value || 0);
  col.pop = G.START_LOAD.pax;
  col.crypto = COL.CRYPTO_START;
  if (opts.startKit !== false) Colony.startKit(col, surf);

  // Корабль игрока — стартовый шаттл с его настоящей загрузкой (js/colony.js START_LOAD).
  const ship = { id: 1, design: G.START_DESIGN, star: gstar.id, planet: p.index, landed: true, at: nowAt(0) };
  Ship.ensureStart(ship);
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
  let auto = null, autoRun = 0, firstUniq = false, shipAt = null;
  const groupStock = g => Colony.inGroup(col, g);
  const planDone = () => PLAN.every(k => col.buildings.some(b => b.kind === k));

  for (let t = 1; t <= ticks; t++) {
    const now = nowAt(t);
    const live = Colony.live(col);

    // ── КОРАБЛЬ. Ship.advance — настоящий код: ест пищу, снимает добычу с гекса (100 водорода
    // за съём, лимит один гекс на планету за такт), останавливается на пище, топливе и трюме.
    const needG = (() => {
      const next = PLAN.find(k => !col.buildings.some(b => b.kind === k));
      const cost = next ? COL_BUILDING[next].cost : {};
      let pick = 'e', worst = -Infinity;
      for (const g of ['s', 'c', 'e', 'b']) {
        const need = (cost[g === 's' ? 's' : g === 'c' ? 'c' : g === 'b' ? 'b' : 'e'] || 0)
          + (g === 'e' ? 6 * live.reduce((a, b) => a + (COL_BUILDING[b.kind].h2 || 0), 0) : 0)
          - groupStock(g);
        if (need > worst) { worst = need; pick = g; }
      }
      return pick;
    })();
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

    // ── ИГРОК ЗАКАЗЫВАЕТ ПРОИЗВОДСТВУ. Сперва планетарная единица (без неё нельзя ставить
    // ферму, купол, майнинг-ферму), потом КОМПОНЕНТЫ на майнинг-ферму и космодром — они стоят
    // не сырьём, а компонентами (80 конструктивных и 240 ЭВМ у фермы), и без заказа производство
    // их не делает никогда. Это и запирало прогон: крипта кончалась на четвёртые сутки, рабочие
    // уходили, добыча вставала — при полном складе сырья.
    col.order = (() => {
      if (col.uniq < 1) return { kind: 'uniq' };
      for (const key of ['mfarm', 'port']) {
        if (Colony.has(col, key) || col.buildings.some(b => b.kind === key)) continue;
        const B = COL_BUILDING[key];
        for (const m in B.comp || {})
          if (((col.comp || {})[m + '1'] || 0) < B.comp[m]) return { kind: 'comp', mat: m, tier: 1 };
      }
      return { kind: 'uniq' };
    })();

    // ── ТАКТ КОЛОНИИ — настоящий Colony.step: добыча, стройка, энергия, содержание, пища,
    // население, крипта, производство.
    const uniqWas = col.uniq, deadWas = col.buildings.filter(b => b.dead).length;
    const foodWas = col.food, cryptoWas = col.crypto;
    Colony.step(col, surf);
    if (col.uniq > uniqWas && !firstUniq) { firstUniq = true; events.push([t, 'первая планетарная единица']); }
    const demolished = col.buildings.filter(b => b.dead).length - deadWas;
    if (demolished > 0) events.push([t, 'РАЗОБРАНО за долги: ' + demolished + ' шт.']);

    // ── ИГРОК СТРОИТ. Цену и запреты проверяет Colony.canBuild, списывает Colony.build —
    // со склада и из трюма стоящего рядом корабля.
    if (!col.site) {
      let plan = null;
      // ИГРОК: ЭНЕРГИЯ ПЕРВЕЕ ПЛАНА. Пока водорода добывается меньше, чем съедают здания (плюс
      // запас на то, что строится), ставится ещё одна энергетическая шахта — иначе часть зданий
      // просто стоит, а ферма гибнет от долгов по энергоносителям. Запас 1,3: содержание фермы
      // тоже идёт энергоносителями, и его надо откуда-то брать.
      const h2In = Colony.live(col).reduce((a2, b) => {
        if (COL_BUILDING[b.kind].group !== 'e' || b.dead) return a2;
        const hx = surf.hexes.find(x => x.q === b.q && x.r === b.r);
        if (!hx) return a2;
        const out = Colony.mineOutput(hx, b.kind, b.lvl);
        return a2 + Object.keys(out).reduce((v, k) => v + out[k] * (COL.H2_PER_UNIT[k] || 1), 0);
      }, 0);
      const h2Out = Colony.live(col).reduce((a2, b) => a2 + (COL_BUILDING[b.kind].h2 || 0) * b.lvl, 0)
        + Colony.live(col).reduce((a2, b) => a2 + (COL_BUILDING[b.kind].upkeep === 'e' ? (COL_BUILDING[b.kind].up || 0) / COL.UPKEEP_EVERY : 0), 0);
      if (h2In < h2Out * 1.3) {
        const hx = nextHex('e', false);
        if (hx) plan = { kind: 'mine_e', hex: hx, g: 'e', why: 'не хватает энергии' };
      }
      const next = plan ? null : PLAN.find(k => !col.buildings.some(b => b.kind === k));
      if (next && !plan) {
        const g = COL_BUILDING[next].group;
        const hx = g ? nextHex(g, false) : nextHex('s', false) || surf.hexes.find(x => !taken().has(x.q + ',' + x.r));
        if (g && !hx) {
          col.buildings.push({ kind: next, q: -99, r: -99, lvl: 1, missed: 0, dead: true });
          events.push([t, 'пропущено (нет ресурса на планете): ' + LABEL(next)]);
        } else if (hx) plan = { kind: next, hex: hx, g };
      } else if (t % FIX_EVERY === 0) {
        // ИГРОК: план пройден — раз в сутки добавляет шахту там, где просело. Сперва сырьё
        // 3 уровня (без него встаёт производство), потом группа, которая убывает.
        if (!Colony.uniqPick(col)) {
          let best = null;
          for (const g in GROUPS) {
            const hx = nextHex(g, true); if (!hx) continue;
            const v = hx.res[GROUPS[g][2]] || 0;
            if (!best || v > best.v) best = { kind: 'mine_' + g, hex: hx, g, v, why: 'нужно сырьё 3 уровня' };
          }
          if (best) plan = best;
        }
        if (!plan) for (const g of ['e', 's', 'c']) {
          const was = hist[hist.length - FIX_EVERY];
          if (!was || groupStock(g) >= was[g]) continue;
          const hx = nextHex(g, false); if (!hx) continue;
          // Шахта на бедном гексе делает хуже: за час она должна отдать больше, чем стоит её
          // содержание и энергия.
          const perHour = COL.UPKEEP_EVERY * COL.MINE_K * GROUPS[g].reduce((a, k) => a + (hx.res[k] || 0), 0);
          if (perHour <= (COL_BUILDING['mine_' + g].up || 0) + 6 * (COL_BUILDING['mine_' + g].h2 || 0)) continue;
          plan = { kind: 'mine_' + g, hex: hx, g, why: GROUP_NAME[g].toLowerCase() + ' просели' };
          break;
        }
      }
      if (plan) {
        const err = Colony.build(col, plan.kind, plan.hex, false, ship);
        if (!err) {
          if (plan.g) used[plan.g].add(plan.hex);
          events.push([t, 'начата стройка: ' + LABEL(plan.kind) + (plan.why ? ' (' + plan.why + ')' : '')]);
        }
      }
    }

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
  return { col, ship, shipSt, events, hist, auto };
}

const fmtT = t => { const m = t * 10, d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return String(d).padStart(2) + 'д ' + String(h).padStart(2) + 'ч'; };

// ───────────────────────── отчёт ─────────────────────────
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? +a.split('=')[1] : d; };
const TICKS = arg('ticks', 2016); // 14 реальных суток

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
console.log('КОРАБЛЬ: ' + G.START_DESIGN + ' — трюм ' + Math.round(r.shipSt.capacity) + ' массы, жизнеобеспечение на '
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
    + (h.shipAt ? '  ' + GROUP_NAME[h.shipAt] : '  —')
    + (h.powered ? '' : '  БЕЗ ЭНЕРГИИ')
    + (h.t === r.auto ? '   ← автономность' : ''));
}

const last = r.hist[r.hist.length - 1], prev = r.hist[r.hist.length - 1 - COL.DAY_TICKS] || r.hist[0];
console.log('\nИТОГ: ' + (r.auto ? 'автономность на такте ' + r.auto + ' (' + fmtT(r.auto).trim() + ' реального времени)' : 'АВТОНОМНОСТИ НЕТ'));
console.log('  живых зданий ' + last.alive + ' из ' + PLAN.length + ', население ' + last.pop
  + ', планетарных единиц ' + last.uniq + ', склад ' + last.usedCap + ' из ' + last.cap + ' массы');
const per = n => (n >= 0 ? '+' : '') + Math.round(n / COL.DAY_TICKS) + ' ед./такт';
const dS = last.s - prev.s, dC = last.c - prev.c, dE = last.e - prev.e;
console.log('  накопление за последние сутки: структурные ' + per(dS) + ', вычислительные ' + per(dC)
  + ', энергоносители ' + per(dE) + '  (добыча шахт ' + last.mined + ' ед./такт)');
const acc = (dS + dC + dE) / COL.DAY_TICKS, share = last.mined ? acc / last.mined : 0;
console.log('  копит ' + Math.round(share * 100) + '% добычи'
  + (Math.abs(share) < 0.1 ? ' — равновесие' : share > 0 ? ' — копит слишком много' : ' — проедает запас'));
if (r.col.log.length) {
  console.log('\nПОСЛЕДНИЕ ЗАПИСИ ЖУРНАЛА КОЛОНИИ (его же видит игрок на экране):');
  for (const l of r.col.log.slice(0, 12)) console.log('  такт ' + String(l.t).padStart(4) + '  ' + l.text);
}
