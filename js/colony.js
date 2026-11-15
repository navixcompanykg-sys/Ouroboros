// Экономика колонии и корабельная добыча (ТЗ §8.7–8.9). Числа — подбор из tools/colony.js,
// проверенный прогоном: стартовая планета выходит в автономность за 3 суток 6 часов реального
// времени, рентабельны 27 % обитаемых планет. Менять их здесь и в tools/colony.js ВМЕСТЕ —
// второй реализации расчёта не заводить (docs/Уроки.md §3).
//
// Такт — 10 РЕАЛЬНЫХ минут (решение пользователя), содержание зданий — раз в час (6 тактов).
// Время берётся с часов: сколько тактов прошло с последнего визита, столько и считается.
// Корабельная добыча идёт НЕПРЕРЫВНО (доля такта за секунду) — иначе игрок десять минут смотрит
// на пустой трюм.
const COL = {
  TICK_MS: 10 * 60 * 1000,

  MINE_K: 10,            // шахта: 10 × уровень × содержание гекса за такт (ТЗ §8.7)
  SHIP_MINE_K: 5,        // корабль ВДВОЕ слабее шахты 1 уровня (решение пользователя), зато берёт
                         // все ресурсы гекса сразу и может привезти то, чего колонии не хватает

  UPKEEP_RAW: 700,       // содержание здания 1 уровня за ЧАС, сырьём своего типа (любым внутри типа)
  UPKEEP_EVERY: 6,       // содержание раз в час, добыча раз в 10 минут
  GRACE: 3,              // три часа подряд без оплаты → здание разбирают

  BUILD_TICKS: 6,        // здание 1 уровня строится реальный час

  FOOD_PER_POP: 1,       // житель (и экипаж корабля — он эквивалентен одному колонисту) ест 1 пищу за такт
  FARM_CAP: 60,          // ферма уровня L делает до 60 × L пищи за такт
  FOOD_ART_RAW: 5,       // искусственная пища: 5 ед. структурного сырья...
  FOOD_ART_EN: 2000,     // ...и 2000 энергии на единицу
  FOOD_KEEP: 4,          // ДОПУЩЕНИЕ: колония держит запас пищи на столько тактов потребления

  DOME_CAP: 10,          // купол уровня L держит 10 × L жителей
  POP_TICKS: 144,        // ±1 житель раз в реальные сутки

  WAGE: 6,               // крипты рабочему за такт
  MFARM_EN: 200000,      // майнинг-ферма жжёт до 200 000 × уровень энергии за такт
  TOKEN_PER_EN: 0.0004,  // крипты за единицу энергии

  UNIQ_RAW: 10,          // планетарная единица: по 10 ед. сырья 1, 2 и 3 уровня разных типов (§8.5)
  PROD_TICKS: 144,       // производство уровня L выдаёт одну планетарную единицу раз в 144 / L тактов
  PROD_COMP: 10,         // ДОПУЩЕНИЕ: или столько компонентов за такт (× уровень), если задан такой заказ

  DAY_TICKS: 144,        // реальные сутки
  ALERT_LIFE: 0.5,       // оповещение, когда жизнеобеспечение истощено больше чем наполовину
};

// Группы сырья по уровням: [1 уровень, 2 уровень, 3 уровень] — ступени внутри группы (ТЗ §5).
const COL_GROUPS = {
  s: ['silicates', 'rareEarth', 'superdense'],
  c: ['silicon', 'niobium', 'isotopes'],
  e: ['hydrogen', 'tritium', 'antimatter'],
  b: ['microbiota', 'flora', 'bitumen'],
};
const COL_GROUP_NAME = { s: 'Структурные', c: 'Вычислительные', e: 'Энергоносители', b: 'Биомасса' };
const COL_KEY_GROUP = {};
for (const g in COL_GROUPS) COL_GROUPS[g].forEach(k => { COL_KEY_GROUP[k] = g; });

// Постройки 1 уровня. uniq — планетарных единиц (§8.6); у шахт и производства 0 — решение
// пользователя, иначе колонию не с чего начать. upkeep — тип сырья, которым здание содержится
// (ДОПУЩЕНИЕ: то, с чем здание работает); work — нужен ли рабочий (§8.8).
const COL_BUILDINGS = [
  { key: 'mine_s', name: 'Шахта структурная', group: 's', cost: { s: 800, c: 200 }, upkeep: 's', work: true,
    desc: 'Силикаты, редкоземельные металлы, сверхплотные минералы с гекса' },
  { key: 'mine_c', name: 'Шахта вычислительная', group: 'c', cost: { s: 800, c: 200 }, upkeep: 'c', work: true,
    desc: 'Кремний, ниобий, изотопы с гекса' },
  { key: 'mine_e', name: 'Шахта энергетическая', group: 'e', cost: { s: 800, c: 200 }, upkeep: 'e', work: true,
    desc: 'Водород, тритий, антиматерия с гекса' },
  { key: 'mine_b', name: 'Шахта биохимическая', group: 'b', cost: { s: 800, c: 200 }, upkeep: 'b', work: true,
    desc: 'Микробиота, дикая флора, битумы с гекса' },
  { key: 'prod', name: 'Производство', cost: { s: 1500, c: 600 }, upkeep: 's', work: true,
    desc: 'Делает планетарную единицу: 10 + 10 + 10 сырья трёх уровней разных типов' },
  { key: 'farm', name: 'Фермы', cost: { s: 900, c: 500, uniq: 1 }, upkeep: 'e', work: true,
    desc: 'Пища: из биомассы 1 к 1 либо искусственно за сырьё и энергию' },
  { key: 'mfarm', name: 'Майнинг-ферма', cost: { s: 400, c: 1200, uniq: 1 }, upkeep: 'c', work: true,
    desc: 'Жжёт энергию в крипту — ею платят рабочим' },
  { key: 'dome', name: 'Купол', cost: { s: 1200, c: 300, uniq: 1 }, upkeep: 's', work: false,
    desc: 'Жильё: предел населения 10 на уровень' },
  { key: 'port', name: 'Космодром', cost: { s: 2000, c: 1000, uniq: 1 }, upkeep: 's', work: true,
    desc: 'Строит корабли из сырья колонии' },
  // Газовый гигант: поверхности нет, корабль висит на низкой орбите и черпает газ с верхних
  // слоёв. Строить там можно только станцию, и эта ветка пока НЕ РАЗВИВАЕТСЯ (решение
  // пользователя) — кнопка есть, постройка отказывает.
  { key: 'station', name: 'Орбитальная станция', cost: { s: 3000, c: 2000, uniq: 1 }, upkeep: 's', work: true,
    orbital: true, todo: true, desc: 'Единственная постройка газового гиганта. Ветка пока не развивается' },
];
const COL_BUILDING = Object.fromEntries(COL_BUILDINGS.map(b => [b.key, b]));
// Кого укомплектовывают первым, если населения или крипты не хватает на всех (правило v2).
const COL_PRIO = { mine_s: 0, mine_c: 0, mine_e: 0, mine_b: 0, farm: 1, mfarm: 2, prod: 3, port: 4, dome: 99 };

const Colony = (() => {
  const tickAt = ms => Math.floor(ms / COL.TICK_MS);

  // star/planet колония помнит сама: по ним космодром знает, где появится собранный корабль.
  function blank(now, star, planet) {
    return { t: tickAt(now), star, planet, stock: {}, food: 0, crypto: 0, pop: 0, uniq: 0,
      buildings: [], site: null, yard: null, log: [] };
  }

  // ---------- склад ----------
  const inGroup = (col, g) => COL_GROUPS[g].reduce((a, k) => a + (col.stock[k] || 0), 0);
  function spendIn(col, g, q) { // списать из группы, начиная с самого обильного
    let left = q;
    for (const k of COL_GROUPS[g].slice().sort((a, b) => (col.stock[b] || 0) - (col.stock[a] || 0))) {
      if (left <= 1e-9) break;
      const take = Math.min(left, col.stock[k] || 0);
      col.stock[k] = (col.stock[k] || 0) - take; left -= take;
    }
    return q - Math.max(0, left);
  }
  function burn(col, en) { // сжечь носители на en энергии, дешёвыми вперёд (ТЗ §7.3: 100/300/800)
    let need = en;
    for (const k of COL_GROUPS.e) {
      if (need <= 1e-9) break;
      const per = FUEL[k] ? FUEL[k].yield : 100;
      const take = Math.min(col.stock[k] || 0, need / per);
      col.stock[k] = (col.stock[k] || 0) - take; need -= take * per;
    }
    return en - Math.max(0, need);
  }
  const add = (store, k, q) => { if (q) store[k] = (store[k] || 0) + q; };

  // ---------- ЦЕНЫ ПОЛЬЗОВАТЕЛЯ ----------
  // Расценки зданий ведёт пользователь на странице prices.html, хранятся в data/prices.json.
  // Числа в COL_BUILDINGS — только значение по умолчанию на случай, когда файла ещё нет.
  function setPrices(pr) {
    if (!pr || !pr.buildings) return;
    for (const key in pr.buildings) {
      const B = COL_BUILDING[key], v = pr.buildings[key];
      if (!B || !v) continue;
      B.cost = { s: +v.s || 0, c: +v.c || 0, uniq: +v.uniq || 0 };
      B.up = +v.up || COL.UPKEEP_RAW;
    }
  }

  // ---------- СКЛАД ПЛАНЕТЫ ----------
  // Решение пользователя: «каждой планете, где есть хоть одна постройка, нужен свой склад;
  // каждая постройка — это как два трюма на корабле, это и задаёт лимит хранения».
  // Трюм — грузовой отсек 1 уровня из таблицы компонентов (2000 ед.), значит постройка даёт
  // 4000. Число берётся из таблицы пользователя, не выдумывается: holdUnit ставит экран, когда
  // таблица загрузилась (setHoldUnit).
  //
  // ДОПУЩЕНИЕ: у колонии без построек склад считается как за ОДНУ постройку — иначе высаженный
  // груз некуда деть и первую шахту (1000 ед.) не на что построить.
  let holdUnit = 2000;
  const setHoldUnit = n => { if (n > 0) holdUnit = n; };
  const capacity = col => Math.max(1, live(col).length) * 2 * holdUnit;
  const used = col => Object.values(col.stock).reduce((a, v) => a + v, 0) + (col.food || 0) + compTotal(col);
  const roomLeft = col => Math.max(0, capacity(col) - used(col));
  // Положить на склад, сколько влезет; вернуть, сколько легло.
  function store(col, key, qty) {
    const q = Math.min(qty, roomLeft(col));
    if (q > 0) add(col.stock, key, q);
    return q;
  }

  // ---------- КОМПОНЕНТЫ НА СКЛАДЕ ----------
  // Производство делает из сырья либо КОМПОНЕНТЫ (они идут на склад и из них потом собирают
  // оборудование и корабли), либо УНИКАЛЬНЫЙ РЕСУРС планеты (§8.5). Что именно — задаёт игрок
  // заказом (col.order). Рецепт компонента — CRAFT из components.js, числа пользователя.
  const compKey = (mat, tier) => mat + tier;
  const compName = (mat, tier) => (MAT_TYPE[mat] ? MAT_TYPE[mat].name : mat) + ' ' + tier + ' ур.';
  const compTotal = col => Object.values(col.comp || {}).reduce((a, v) => a + v, 0);
  // Сколько сырья уходит на один компонент: CRAFT[tier-1].need — по уровням сырья СВОЕГО типа.
  function compCost(mat, tier) {
    const need = CRAFT[tier - 1].need, res = MAT_TYPE[mat].res, out = {};
    need.forEach((n, i) => { if (n) out[res[i]] = n; });
    return out;
  }

  // ---------- что колония умеет ----------
  const live = col => col.buildings.filter(b => !b.dead);
  const has = (col, key) => live(col).some(b => b.kind === key);
  const domeCap = col => live(col).reduce((a, b) => a + (b.kind === 'dome' ? COL.DOME_CAP * b.lvl : 0), 0);
  function mineOutput(hex, kind, lvl) { // ед./такт по каждому ресурсу группы
    const out = {};
    const g = COL_BUILDING[kind].group;
    for (const k of COL_GROUPS[g]) { const v = COL.MINE_K * lvl * (hex.res[k] || 0); if (v) out[k] = v; }
    return out;
  }
  // Корабельная добыча: ВСЕ ресурсы гекса, вдвое слабее шахты 1 уровня.
  function shipOutput(hex) {
    const out = {};
    for (const k in hex.res) { const v = COL.SHIP_MINE_K * hex.res[k]; if (v) out[k] = v; }
    return out;
  }

  // ---------- такт колонии ----------
  function step(col, surf) {
    const hexAt = (q, r) => surf.hexes.find(h => h.q === q && h.r === r);
    const L = live(col);

    // рабочие: сколько мест укомплектовано (население и крипта, §8.8)
    const need = L.filter(b => COL_BUILDING[b.kind].work)
      .sort((a, b) => COL_PRIO[a.kind] - COL_PRIO[b.kind]);
    const paid = Math.min(col.pop, Math.floor(col.crypto / COL.WAGE), need.length);
    const manned = new Set(need.slice(0, paid));

    // 1. добыча
    // Добыча кладётся на склад РЕДКИМ ВПЕРЁД (по средней распространённости в галактике,
    // RESOURCE_STATS). Иначе склад забивается дешёвым водородом, сырьё 3 уровня на него уже не
    // попадает — и планетарная единица (§8.5) не делается никогда: колония встаёт навсегда,
    // имея полный склад. Проверено прогоном: без этого 0 единиц за 160 тактов.
    let spill = 0;
    const mined = {};
    for (const b of L) {
      if (!COL_BUILDING[b.kind].group || !manned.has(b)) continue;
      const h = hexAt(b.q, b.r); if (!h) continue;
      const out = mineOutput(h, b.kind, b.lvl);
      for (const k in out) mined[k] = (mined[k] || 0) + out[k];
    }
    const rare = k => (RESOURCE_STATS[k] ? RESOURCE_STATS[k].avg : 1);
    for (const k of Object.keys(mined).sort((a, b) => rare(a) - rare(b)))
      spill += mined[k] - store(col, k, mined[k]);
    if (spill > 0 && !col.fullWarned) { col.fullWarned = true; note(col, 'Склад полон — добыча пропадает'); }
    if (spill <= 0) col.fullWarned = false;

    // 2. стройка
    if (col.site && --col.site.left <= 0) {
      col.buildings.push({ kind: col.site.kind, q: col.site.q, r: col.site.r, lvl: 1, missed: 0 });
      note(col, 'Готово: ' + COL_BUILDING[col.site.kind].name);
      col.site = null;
    }

    // 2б. космодром: корабль собирается своё время, по готовности встаёт на этой же планете
    if (col.yard && --col.yard.left <= 0) {
      const sh = World.addShip(col.yard.name, col.star, col.planet);
      sh.seeded = true; sh.at = Date.now();
      note(col, 'Космодром собрал корабль: ' + col.yard.name);
      col.yard = null;
    }

    // 3. содержание — раз в час, сырьём своего типа (§8.8, 1 уровень)
    if (col.t % COL.UPKEEP_EVERY === 0) for (const b of L) {
      const B = COL_BUILDING[b.kind], g = B.upkeep, q = (B.up || COL.UPKEEP_RAW) * b.lvl;
      if (inGroup(col, g) >= q) { spendIn(col, g, q); b.missed = 0; }
      else if (++b.missed >= COL.GRACE) {
        b.dead = true;
        note(col, 'Разобрано за долги: ' + COL_BUILDING[b.kind].name);
      }
    }

    // 4. пища и население
    const eaters = col.pop;
    const cap = L.reduce((a, b) => a + (b.kind === 'farm' && manned.has(b) ? COL.FARM_CAP * b.lvl : 0), 0);
    const want = Math.min(cap, Math.max(0, eaters * COL.FOOD_KEEP - col.food));
    const bio = Math.min(want, inGroup(col, 'b'));
    let art = want - bio;
    if (art > 0) {
      art = Math.min(art, Math.floor(burn(col, art * COL.FOOD_ART_EN) / COL.FOOD_ART_EN));
      art = Math.min(art, Math.floor(spendIn(col, 's', art * COL.FOOD_ART_RAW) / COL.FOOD_ART_RAW));
    }
    if (bio > 0) spendIn(col, 'b', bio);
    col.food += Math.min(bio + art, roomLeft(col)); // место, которое освободили биомасса и сырьё, уже учтено
    const eaten = Math.min(col.food, eaters * COL.FOOD_PER_POP);
    col.food -= eaten;
    const hungry = eaten < eaters * COL.FOOD_PER_POP - 1e-9;
    col.popClock = (col.popClock || 0) + 1;
    if (col.popClock >= COL.POP_TICKS) {
      col.popClock = 0;
      if (hungry) { col.pop = Math.max(col.floraBase || 0, col.pop - 1); note(col, 'Голод: население убыло'); }
      else if (col.pop < domeCap(col)) { col.pop++; note(col, 'Население выросло до ' + col.pop); }
    }

    // 5. крипта
    const mf = L.find(b => b.kind === 'mfarm' && manned.has(b));
    const minted = mf ? burn(col, COL.MFARM_EN * mf.lvl) * COL.TOKEN_PER_EN : 0;
    col.crypto = Math.max(0, col.crypto + minted - paid * COL.WAGE);

    // 6. производство: заказ игрока — компоненты на склад или уникальный ресурс планеты
    const pr = L.find(b => b.kind === 'prod' && manned.has(b));
    if (pr) {
      const order = col.order || { kind: 'uniq' };
      if (order.kind === 'comp') {
        const cost = compCost(order.mat, order.tier);
        let n = COL.PROD_COMP * pr.lvl;
        for (const k in cost) n = Math.min(n, Math.floor((col.stock[k] || 0) / cost[k]));
        if (n > 0) {
          for (const k in cost) col.stock[k] -= cost[k] * n;
          col.comp = col.comp || {};
          const key = compKey(order.mat, order.tier);
          col.comp[key] = (col.comp[key] || 0) + n;
        }
      } else {
        col.prodClock = (col.prodClock || 0) + pr.lvl;
        const pick = uniqPick(col);
        if (pick && col.prodClock >= COL.PROD_TICKS) {
          col.prodClock -= COL.PROD_TICKS;
          for (const k of pick) col.stock[k] -= COL.UNIQ_RAW;
          col.uniq++;
          note(col, 'Планетарная единица готова (' + pick.length + ' вида сырья)');
        }
      }
    }
    col.t++;
  }

  // Сырьё под планетарную единицу: сначала САМЫЙ РЕДКИЙ, 3 уровень — иначе жадность занимает
  // единственную группу с третьим уровнем под первый, и производство встаёт навсегда.
  function uniqPick(col) {
    const pick = [], used = new Set();
    for (const tier of [2, 1, 0]) {
      let best = null, bv = 0;
      for (const g in COL_GROUPS) {
        if (used.has(g)) continue;
        const k = COL_GROUPS[g][tier], have = col.stock[k] || 0;
        if (have >= COL.UNIQ_RAW && have > bv) { bv = have; best = [g, k]; }
      }
      if (!best) return null;
      used.add(best[0]); pick.push(best[1]);
    }
    return pick;
  }

  function note(col, text) {
    col.log = col.log || [];
    col.log.unshift({ t: col.t, text });
    if (col.log.length > 40) col.log.length = 40;
  }

  // ---------- догнать время ----------
  // Сколько тактов прошло с прошлого визита — столько и считаем. Предел на случай, когда игрок
  // не заходил неделями: больше 4032 тактов (четыре недели) за раз не отматываем.
  function advance(col, surf, now) {
    const target = tickAt(now);
    let n = Math.min(Math.max(0, target - col.t), 4032);
    while (n-- > 0) step(col, surf);
    col.t = target;
    return col;
  }

  // ---------- стройка по приказу игрока ----------
  function canBuild(col, key, hex, lowOrbit) {
    const B = COL_BUILDING[key];
    if (!B) return 'нет такой постройки';
    if (B.todo) return 'эта ветка пока не развивается';
    if (!!B.orbital !== !!lowOrbit) return B.orbital ? 'только на низкой орбите газового гиганта' : 'нужна твёрдая поверхность';
    if (col.site) return 'уже идёт стройка: ' + COL_BUILDING[col.site.kind].name;
    if (!hex) return 'выберите гекс';
    if (col.buildings.some(b => !b.dead && b.q === hex.q && b.r === hex.r)) return 'гекс занят';
    if (B.group && !COL_GROUPS[B.group].some(k => (hex.res[k] || 0) > 0))
      return 'на этом гексе нет ' + COL_GROUP_NAME[B.group].toLowerCase();
    if (inGroup(col, 's') < (B.cost.s || 0)) return 'мало структурного сырья';
    if (inGroup(col, 'c') < (B.cost.c || 0)) return 'мало вычислительного сырья';
    if (col.uniq < (B.cost.uniq || 0)) return 'нужна планетарная единица';
    return null;
  }
  function build(col, key, hex, lowOrbit) {
    const err = canBuild(col, key, hex, lowOrbit); if (err) return err;
    const B = COL_BUILDING[key];
    spendIn(col, 's', B.cost.s || 0); spendIn(col, 'c', B.cost.c || 0);
    col.uniq -= B.cost.uniq || 0;
    col.site = { kind: key, q: hex.q, r: hex.r, left: COL.BUILD_TICKS };
    note(col, 'Начата стройка: ' + B.name);
    return null;
  }

  // ---------- сводка для интерфейса ----------
  function summary(col, surf) {
    const L = live(col);
    const need = L.filter(b => COL_BUILDING[b.kind].work).sort((a, b) => COL_PRIO[a.kind] - COL_PRIO[b.kind]);
    const paid = Math.min(col.pop, Math.floor(col.crypto / COL.WAGE), need.length);
    const rate = {};
    const hexAt = (q, r) => surf.hexes.find(h => h.q === q && h.r === r);
    need.slice(0, paid).forEach(b => {
      if (!COL_BUILDING[b.kind].group) return;
      const h = hexAt(b.q, b.r); if (!h) return;
      const out = mineOutput(h, b.kind, b.lvl);
      for (const k in out) add(rate, k, out[k]);
    });
    return { live: L, workers: paid, jobs: need.length, rate, yard: col.yard, order: col.order || { kind: 'uniq' },
      cap: capacity(col), used: used(col), room: roomLeft(col),
      upkeep: L.reduce((a, b) => a + (COL_BUILDING[b.kind].up || COL.UPKEEP_RAW) * b.lvl, 0), port: has(col, 'port'),
      stock: col.stock, food: col.food, crypto: col.crypto, pop: col.pop, uniq: col.uniq,
      popCap: domeCap(col), site: col.site };
  }

  return { blank, advance, step, build, canBuild, summary, live, has, inGroup, spendIn, add,
    capacity, used, roomLeft, store, setHoldUnit, setPrices, compKey, compName, compCost, compTotal,
    shipOutput, mineOutput, tickAt, note, domeCap, uniqPick };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Корабль: трюм, добыча с гекса, жизнеобеспечение на пище.
//
// Правила пользователя:
//   - корабельная добыча ВДВОЕ слабее шахты 1 уровня, зато берёт все ресурсы гекса сразу и
//     может привезти колонии то, чего ей критически не хватает;
//   - системы жизнеобеспечения пополняются ПИЩЕЙ;
//   - экипаж корабля эквивалентен одному колонисту и ест пищу так же;
//   - стандартного блока жизнеобеспечения хватает на СУТКИ (144 такта);
//   - везёшь колонистов или армию — высаживай быстрее, ставь больше блоков или вези пищу
//     в трюме: каждый пассажир ест как колонист, и запас тает во столько же раз быстрее.
const Ship = (() => {
  // Сколько пищи вмещает единица параметра «запас жизнеобеспечения». Выводится из СТАНДАРТНОГО
  // блока 1 уровня, чтобы правило «блока хватает на сутки» держалось при любых числах
  // пользователя в таблице компонентов.
  function foodPerUnit(tbl) {
    const one = partParam(tbl, 'life_support', 'lifeSup', 1);
    return one > 0 ? COL.DAY_TICKS / one : COL.DAY_TICKS / 6;
  }
  // Корабль считается ВСЕГДА на компонентах 1 уровня с базовыми настройками (этап игры).
  const stats = (tbl, ship) => shipTotals(tbl, findDesign(ship.design), 1, null, 1, 1);
  const crew = ship => 1 + (ship.pax || 0);                 // экипаж + пассажиры
  const lifeCap = (tbl, st) => Math.round(st.lifeSupport * foodPerUnit(tbl));
  const lifeLeft = (tbl, ship, st) => ship.food == null ? lifeCap(tbl, st) : Math.max(0, ship.food);
  const lifeShare = (tbl, ship, st) => { const c = lifeCap(tbl, st); return c > 0 ? lifeLeft(tbl, ship, st) / c : 0; };
  // На сколько тактов хватит запаса при нынешнем экипаже (с пассажирами — меньше).
  const lifeTicks = (tbl, ship, st) => Math.floor(lifeLeft(tbl, ship, st) / (crew(ship) * COL.FOOD_PER_POP));

  const cargoUsed = ship => Object.values(ship.cargo || {}).reduce((a, v) => a + v, 0);
  const cargoFree = (tbl, ship, st) => Math.max(0, st.capacity - cargoUsed(ship));
  const hasMiner = ship => designModules(findDesign(ship.design)).includes('miner');

  // Догнать время. Пища расходуется непрерывно (экипаж и пассажиры едят всегда), добыча —
  // тактами: корабль, ОСТАВЛЕННЫЙ НА ДОБЫЧЕ (ship.mine), каждые 10 минут снимает с гекса норму
  // и не улетает, пока не кончится пища, не кончится топливо или не забьётся трюм (решение
  // пользователя). Если игрока не было, выдаём всё, что он накопил бы за это время.
  function advance(tbl, ship, surf, now) {
    const st = stats(tbl, ship);
    if (ship.food == null) ship.food = lifeCap(tbl, st);
    const wasLow = lifeShare(tbl, ship, st) <= COL.ALERT_LIFE;
    const last = ship.at || now;
    const dt = Math.max(0, Math.min(now - last, 28 * 24 * 3600 * 1000)); // больше четырёх недель за раз не отматываем
    const ticks = dt / COL.TICK_MS;
    const foodTicks = Math.floor(lifeLeft(tbl, ship, st) / (crew(ship) * COL.FOOD_PER_POP));
    ship.at = now;
    if (ticks > 0) ship.food = Math.max(0, ship.food - ticks * crew(ship) * COL.FOOD_PER_POP);

    let auto = 0, got = null, stop = null;
    const h = ship.mine && ship.landed && surf
      ? surf.hexes.find(x => x.q === ship.mine.q && x.r === ship.mine.r) : null;
    if (h && hasMiner(ship)) {
      const t0 = Colony.tickAt(last), t1 = Colony.tickAt(now);
      const lastH = hvOf(ship, ship.star, ship.planet);
      let n = Math.max(0, t1 - Math.max(t0, lastH ? lastH.t : -1));
      const per = Object.values(Colony.shipOutput(h)).reduce((a, v) => a + v, 0);
      const byFuel = Math.floor(World.fuel() / HARVEST_FUEL);
      const byCargo = per > 0 ? Math.ceil(cargoFree(tbl, ship, st) / per) : 0;
      if (n > foodTicks) { n = Math.max(0, foodTicks); stop = 'пища'; }
      if (n > byFuel) { n = byFuel; stop = 'топливо'; }
      if (n > byCargo) { n = byCargo; stop = 'трюм'; }
      for (let i = 0; i < n; i++) {
        const r = harvest(tbl, ship, h, ship.star, ship.planet, now, true);
        if (r.err) { stop = r.err; break; }
        auto++; got = got || {};
        for (const k in r.got) got[k] = (got[k] || 0) + r.got[k];
      }
      
    }
    const full = cargoFree(tbl, ship, st) <= 0, low = lifeShare(tbl, ship, st) <= COL.ALERT_LIFE;
    if (full || ship.food <= 0 || World.fuel() < HARVEST_FUEL) ship.mine = null; // добывать больше нечем
    return { st, ticks, full, low, justLow: low && !wasLow, auto, got, stop };
  }

  // МГНОВЕННЫЙ СЪЁМ ДОБЫЧИ С ГЕКСА (решение пользователя: «чтоб игроку всегда было чем
  // заняться»). Корабль забирает с гекса ровно десятиминутную норму — вдвое меньше, чем взяла
  // бы шахта 1 уровня, — и тратит на это только ТОПЛИВО (оно же энергия, ТЗ §7.3).
  //
  // ЛИМИТ У ГЕКСА, А НЕ У КОРАБЛЯ И НЕ У ПЛАНЕТЫ: гекс отдаёт раз в 10 минут, и другим кораблём
  // с ТОГО ЖЕ гекса снова не снять — а с соседнего можно. Прилетел на другую планету — там свои
  // гексы со своими лимитами. Отсюда и смысл флота: пока один корабль в пути, другим дают
  // приказы, и чем больше игрок играет, тем быстрее растёт колония (ТЗ §1, автосимулятор).
  const HARVEST_FUEL = 0.01;   // ДОПУЩЕНИЕ: доля бака за один съём
  // ЛИМИТ ХРАНИТСЯ В ПАМЯТИ КОРАБЛЯ (решение пользователя): ship.hv — по одной записи на
  // планету, {t: номер такта, q, r: откуда брали}. Один корабль снимает с ОДНОЙ планеты один
  // гекс за 10 минут; прилетел на другую — там свой счёт.
  //
  // ПОЧЕМУ НА КОРАБЛЕ, А НЕ НА ПЛАНЕТЕ (вопрос про ММО). История не нужна ни там, ни там:
  // запись старше текущего такта уже ничего не ограничивает, её сразу выбрасываем — поэтому
  // у корабля остаются одна-две записи, то есть O(1). Главное же не память, а ЗАПИСЬ: лимит на
  // корабле пишется только в собственную строку корабля — ни блокировок, ни гонок между
  // игроками, шардится по игроку. Лимит на гексе пришлось бы писать в ОБЩЕЕ состояние планеты
  // на самом горячем пути. Плата за выбор: два корабля могут снять с одного гекса в один такт.
  // Понадобится ограничить толпу на гексе — добавим хекс-лимит ПОВЕРХ, не убирая корабельный.
  const hvKey = (star, planet) => star + ':' + planet;
  const hvOf = (ship, star, planet) => (ship.hv || {})[hvKey(star, planet)] || null;
  function harvestReady(ship, star, planet, now) {
    const h = hvOf(ship, star, planet);
    return !h || Colony.tickAt(now) > h.t;
  }
  function harvestWait(ship, star, planet, now) { // секунд до следующего съёма на этой планете
    if (harvestReady(ship, star, planet, now)) return 0;
    return Math.ceil((COL.TICK_MS - (now % COL.TICK_MS)) / 1000);
  }
  function harvest(tbl, ship, hex, star, planet, now, auto) {
    if (!hasMiner(ship)) return { err: 'нет модуля «Шахтёр»' };
    if (!auto && !harvestReady(ship, star, planet, now)) return { err: 'на этой планете корабль уже брал добычу в этом такте' };
    const st = stats(tbl, ship);
    const free = cargoFree(tbl, ship, st);
    if (free <= 0) return { err: 'трюм полон' };
    if (World.fuel() < HARVEST_FUEL) return { err: 'нет топлива на съём' };
    const out = Colony.shipOutput(hex);
    const want = Object.values(out).reduce((a, v) => a + v, 0);
    if (want <= 0) return { err: 'на гексе нечего брать' };
    // Не влезает — режем ВСЕ ресурсы одной долей, иначе редкое вытесняется водородом.
    const k = want > free ? free / want : 1;
    const got = {};
    ship.cargo = ship.cargo || {};
    for (const key in out) { const q = out[key] * k; if (q > 0) { ship.cargo[key] = (ship.cargo[key] || 0) + q; got[key] = q; } }
    const nowT = Colony.tickAt(now);
    ship.hv = ship.hv || {};
    for (const k in ship.hv) if (ship.hv[k].t < nowT) delete ship.hv[k]; // мёртвые записи не храним
    ship.hv[hvKey(star, planet)] = { t: nowT, q: hex.q, r: hex.r };
    World.setFuel(World.fuel() - HARVEST_FUEL);
    return { got, total: want * k, full: cargoFree(tbl, ship, st) <= 0 };
  }

  // Выгрузить трюм на склад колонии.
  // Выгрузка на склад планеты: что не влезло — остаётся в трюме (склад планеты ограничен,
  // ТЗ §8.12: постройка = два трюма).
  function unload(ship, col) {
    let n = 0, left = 0;
    for (const k of Object.keys(ship.cargo || {})) {
      if (k === 'food') continue; // пища идёт в запас колонии, а не в сырьё
      const isComp = !RESOURCES.some(r => r.key === k);
      const room = Colony.roomLeft(col);
      const got = isComp ? Math.min(ship.cargo[k], room) : Colony.store(col, k, ship.cargo[k]);
      if (isComp && got > 0) { col.comp = col.comp || {}; col.comp[k] = (col.comp[k] || 0) + got; }
      n += got;
      if (got < ship.cargo[k]) { ship.cargo[k] -= got; left += ship.cargo[k]; } else delete ship.cargo[k];
    }
    if (ship.cargo && ship.cargo.food > 0) {
      const room = Colony.roomLeft(col), got = Math.min(ship.cargo.food, room);
      col.food += got; n += got;
      if (got < ship.cargo.food) { ship.cargo.food -= got; left += ship.cargo.food; } else delete ship.cargo.food;
    }
    if (n > 0) Colony.note(col, 'Корабль выгрузил ' + Math.round(n) + ' ед.' + (left > 0 ? ', ' + Math.round(left) + ' не влезло' : ''));
    return n;
  }
  // Что лежит на складе колонии одной таблицей: сырьё, компоненты и пища. Ключ компонента —
  // 'struct1', 'compute2' и т. д., пищи — 'food'; по нему же добро кладётся в трюм.
  function colonyGoods(col) {
    const out = [];
    for (const r of RESOURCES) if ((col.stock[r.key] || 0) > 0.5) out.push({ key: r.key, name: r.name, qty: col.stock[r.key] });
    for (const k in col.comp || {}) if (col.comp[k] > 0.5)
      out.push({ key: k, name: Colony.compName(k.slice(0, -1), +k.slice(-1)), qty: col.comp[k] });
    if (col.food > 0.5) out.push({ key: 'food', name: 'Пища', qty: col.food });
    return out;
  }
  const takeFromColony = (col, key, q) => {
    if (key === 'food') { col.food -= q; return; }
    if (col.stock[key] != null) { col.stock[key] -= q; return; }
    col.comp[key] -= q;
  };
  // Склад → трюм: сколько влезет в трюм и сколько есть на складе.
  function load(tbl, ship, col, key, qty) {
    const st = stats(tbl, ship);
    const have = key === 'food' ? col.food : (col.stock[key] != null ? col.stock[key] : (col.comp || {})[key] || 0);
    const q = Math.min(qty, have, cargoFree(tbl, ship, st));
    if (q <= 0) return 0;
    takeFromColony(col, key, q);
    ship.cargo = ship.cargo || {};
    ship.cargo[key] = (ship.cargo[key] || 0) + q;
    return q;
  }

  // Зарядить жизнеобеспечение пищей колонии.
  function recharge(tbl, ship, col) {
    const st = stats(tbl, ship), cap = lifeCap(tbl, st);
    const need = Math.max(0, cap - lifeLeft(tbl, ship, st));
    const got = Math.min(need, col.food);
    col.food -= got; ship.food = lifeLeft(tbl, ship, st) + got;
    return got;
  }
  // Положить пищу в трюм — ею потом заряжают жизнеобеспечение в полёте.
  function loadFood(tbl, ship, col, qty) {
    const st = stats(tbl, ship);
    const got = Math.min(qty, col.food, cargoFree(tbl, ship, st));
    col.food -= got; ship.cargo = ship.cargo || {};
    ship.cargo.food = (ship.cargo.food || 0) + got;
    return got;
  }
  // Зарядить жизнеобеспечение пищей ИЗ ТРЮМА (в полёте колонии под рукой нет).
  function rechargeFromHold(tbl, ship) {
    const st = stats(tbl, ship), cap = lifeCap(tbl, st);
    const need = Math.max(0, cap - lifeLeft(tbl, ship, st));
    const got = Math.min(need, (ship.cargo && ship.cargo.food) || 0);
    if (got <= 0) return 0;
    ship.cargo.food -= got; if (ship.cargo.food <= 0) delete ship.cargo.food;
    ship.food = lifeLeft(tbl, ship, st) + got;
    return got;
  }

  return { stats, crew, lifeCap, lifeLeft, lifeShare, lifeTicks, cargoUsed, cargoFree, hasMiner,
    advance, harvest, harvestReady, harvestWait, HARVEST_FUEL, unload, load, colonyGoods, recharge, loadFood, rechargeFromHold, foodPerUnit,
    cost: shipCost, costTotal: shipCostTotal, paxCap, ensureStart };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Стоимость корабля в сырье и стартовая загрузка.
//
// Корабль собирается из компонентов 1 уровня (базовые настройки этого этапа игры), а компонент
// 1 уровня — это 3 единицы сырья 1 уровня СВОЕГО типа (CRAFT в components.js). Состав предметов
// берётся из таблицы пользователя (data/parts.json) — своих чисел здесь нет.
function shipCost(tbl, design) {
  const out = {};
  const mods = designModules(design).concat(design.decks.map(() => 'frame'));
  for (const key of mods) {
    const comp = (tbl.comp || {})[key]; if (!comp) continue;
    const per = rawPerItem(comp, 1);                  // {тип: [1ур, 2ур, 3ур]}
    for (const m of MAT_TYPES) for (let i = 0; i < 3; i++) {
      const q = per[m.key][i] * SHIP_SCALE; if (q) Colony.add(out, m.res[i], q);
    }
  }
  return out;
}
function shipCostTotal(cost) { return Object.values(cost).reduce((a, v) => a + v, 0); }

// ДОПУЩЕНИЕ: один колониальный модуль возит 10 пассажиров (колонистов или солдат). Каждый ест
// пищу как колонист, поэтому с полным модулем стандартный блок жизнеобеспечения кончается не
// за сутки, а за два с небольшим часа — высаживать надо быстро либо ставить блоки и возить пищу.
const PAX_PER_MODULE = 10;
function paxCap(design) { return designModules(design).filter(k => k === 'colonist').length * PAX_PER_MODULE; }

// Стартовая загрузка первого корабля — ровно та, что в прогоне tools/colony.js: сырьё на первую
// шахту, водород на первые часы, пища на колонистов. Делается один раз на новую игру.
const START_LOAD = { silicates: 400, silicon: 260, hydrogen: 440, food: 1100, pax: 10 };
function ensureStart(ship) {
  if (ship.seeded || ship.id !== 1) return false;
  ship.seeded = true;
  ship.cargo = ship.cargo || {};
  for (const k in START_LOAD) if (k !== 'pax') Colony.add(ship.cargo, k, START_LOAD[k]);
  ship.pax = START_LOAD.pax;
  World.save();
  return true;
}

// МАСШТАБ КОРАБЛЯ ×10 (решение пользователя: «корабль просто умножь на 10 все компоненты и
// тягу — так как масса вырастет тоже в 10 раз — и корабль будет эквивалентен шахте»).
// Один предмет оборудования — это десять наборов компонентов из таблицы, а не один: стартовый
// шаттл стоит 930 единиц сырья вместо 93, то есть примерно как шахта (1000). Масса и тяга
// растут тем же множителем, поэтому ускорение, время разгона и все полётные числа НЕ меняются —
// в ships.js и components.js править нечего, множитель нужен только там, где платят сырьём.
const SHIP_SCALE = 10;
function shipBuildTicks(design) {
  // Время сборки: час на каждые четыре модуля (ДОПУЩЕНИЕ).
  return COL.BUILD_TICKS * Math.max(1, Math.ceil((designModules(design).length + design.decks.length) / 4));
}
