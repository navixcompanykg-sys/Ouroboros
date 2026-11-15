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

  H2_TICK: 100,          // ЭНЕРГИЯ: столько водорода (или его эквивалента) ест шахта за такт.
                         // Решение пользователя: «потребление шахты порядка 100 водорода в
                         // 10 минут, такая же цена добычи и у шахтёра на корабле».
  H2_PER_UNIT: { hydrogen: 1, tritium: 3, antimatter: 8 }, // во сколько водородов идёт единица
                         // (из энергоёмкости 100/300/800, ТЗ §7.3)
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

  CRYPTO_START: 20000,   // крипта, с которой начинает высаженная колония: деньги игрока,
                         // вложенные в высадку. Без неё рабочие не выходят с первой же минуты.
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

// Постройки 1 уровня.
//   cost — цена в СЫРЬЕ (s — структурное, c — вычислительное) и планетарных единицах (§8.6);
//   comp — цена в КОМПОНЕНТАХ 1 уровня по типам (шахты, купол, производство и ферма — из сырья:
//          с них колония начинается, компоненты делать ещё нечем);
//   up   — содержание СЫРЬЁМ за час, типа `upkeep`; 0 — содержания нет;
//   h2   — ЭНЕРГИЯ за такт, в водородах (его же эквивалент из трития и антиматерии);
//   work — нужен ли рабочий (§8.8).
//
// РЕШЕНИЯ ПОЛЬЗОВАТЕЛЯ ПО ЭКОНОМИКЕ:
//   «Шахты делаем бесплатными для содержания, они потребляют только водород для самостоятельной
//    выработки энергии» — у шахт up = 0, только h2.
//   «Купола для содержания требуют силикатов и водород для энергии», потребление водорода
//    такое же, как у шахты — 100 за такт.
//   «Карьер убрать и сделать генератор: генератор сжигает энергоресурсы и превращает их в
//    энергию, которая питает всё, шахты» — без генератора колония умеет жечь только ВОДОРОД,
//    с генератором — ещё тритий и антиматерию, а они втрое и вдесятеро плотнее.
//   «Шахты 1 уровня — безубыточная инвестиция, но долго окупаются, порядка 10 000 силикатов».
//   «Купол в 3 раза дешевле шахты, ферма в 2 раза дешевле, производство эквивалентно цене
//    шахты; для них нужны ресурсы всех трёх видов (кроме энергетических — это цена
//    поддержания)». Энергоносители в цену не входят вовсе — они идут только на содержание.
//    Берётся ТОЛЬКО сырьё 1 уровня: силикаты, кремний, микробиота.
//   «Биоресурсы должны требовать только купола и фермы, производство больше требует
//    вычислительных ресурсов» — поэтому у производства биомассы нет совсем, зато вычислительного
//    семь десятых цены; у фермы биомассы больше всего (она живая), у купола — поровну.
//   «Производство тоже по содержанию требует только водород» — у него, как у шахт, up = 0.
//
//   Расчёт: шахта 10 000 → производство 10 000 (3000 структ + 7000 выч), ферма 5 000
//   (1500 + 1500 + 2000 биомассы), купол 3 300 (поровну). Три шахты разных групп добывают три
//   вида сырья параллельно, поэтому набор окупается примерно за то же время, что одна шахта.
const COL_BUILDINGS = [
  { key: 'mine_s', name: 'Шахта структурная', group: 's', cost: { s: 10000 }, upkeep: 's', up: 0, h2: 100, work: true,
    desc: 'Силикаты, редкоземельные металлы, сверхплотные минералы с гекса' },
  { key: 'mine_c', name: 'Шахта вычислительная', group: 'c', cost: { s: 10000 }, upkeep: 'c', up: 0, h2: 100, work: true,
    desc: 'Кремний, ниобий, изотопы с гекса' },
  { key: 'mine_e', name: 'Шахта энергетическая', group: 'e', cost: { s: 10000 }, upkeep: 'e', up: 0, h2: 100, work: true,
    desc: 'Водород, тритий, антиматерия с гекса' },
  { key: 'mine_b', name: 'Шахта биохимическая', group: 'b', cost: { s: 10000 }, upkeep: 'b', up: 0, h2: 100, work: true,
    desc: 'Микробиота, дикая флора, битумы с гекса' },
  { key: 'gen', name: 'Генератор', cost: { s: 8000, c: 2000 }, upkeep: 's', up: 200, h2: 0, work: true,
    desc: 'Сжигает тритий и антиматерию, а не только водород: единица трития идёт за три водорода, антиматерии — за восемь' },
  { key: 'prod', name: 'Производство', cost: { s: 3000, c: 7000 }, upkeep: 's', up: 0, h2: 100, work: true,
    desc: 'Делает компоненты из сырья или планетарную единицу (§8.14)' },
  { key: 'farm', name: 'Фермы', cost: { s: 1500, c: 1500, b: 2000, uniq: 1 }, upkeep: 'e', up: 700, h2: 30, work: true,
    desc: 'Пища: из биомассы 1 к 1 либо искусственно за сырьё и энергию' },
  { key: 'mfarm', name: 'Майнинг-ферма', cost: { uniq: 1 }, comp: { struct: 80, compute: 240 }, upkeep: 'c', up: 700, h2: 0, work: true,
    desc: 'Жжёт энергию в крипту — ею платят рабочим' },
  { key: 'dome', name: 'Купол', cost: { s: 1100, c: 1100, b: 1100, uniq: 1 }, upkeep: 's', up: 500, h2: 100, work: false,
    desc: 'Жильё: предел населения 10 на уровень. Содержится силикатами и водородом' },
  { key: 'port', name: 'Космодром', cost: { uniq: 1 }, comp: { struct: 400, compute: 200 }, upkeep: 's', up: 700, h2: 40, work: true,
    desc: 'Собирает корабли из компонентов колонии' },
  // Газовый гигант: поверхности нет, корабль висит на низкой орбите и черпает газ с верхних
  // слоёв. Строить там можно только станцию, и эта ветка пока НЕ РАЗВИВАЕТСЯ (решение
  // пользователя) — кнопка есть, постройка отказывает.
  { key: 'station', name: 'Орбитальная станция', cost: { uniq: 1 }, comp: { struct: 600, compute: 400 },
    upkeep: 's', up: 700, h2: 50, work: true, orbital: true, todo: true,
    desc: 'Единственная постройка газового гиганта. Ветка пока не развивается' },
];
const COL_BUILDING = Object.fromEntries(COL_BUILDINGS.map(b => [b.key, b]));
// Кого укомплектовывают первым, если населения или крипты не хватает на всех (правило v2).
const COL_PRIO = { gen: 0, mine_s: 1, mine_c: 1, mine_e: 1, mine_b: 1, farm: 2, mfarm: 3, prod: 4, port: 5, station: 5, dome: 99 };

const Colony = (() => {
  const tickAt = ms => Math.floor(ms / COL.TICK_MS);

  // star/planet колония помнит сама: по ним космодром знает, где появится собранный корабль.
  function blank(now, star, planet) {
    return { t: tickAt(now), star, planet, stock: {}, food: 0, crypto: 0, pop: 0, uniq: 0,
      buildings: [], site: null, yard: null, powered: true, log: [] };
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

  // ЭНЕРГИЯ ЗДАНИЙ — в «водородах»: шахта и купол едят по 100 за такт (решение пользователя).
  // Без ГЕНЕРАТОРА колония умеет жечь только водород: сжечь тритий или антиматерию нечем.
  // С генератором идут и они, и идут выгодно — единица трития стоит трёх водородов, антиматерии
  // восьми (их энергоёмкость 300 и 800 против 100). В этом и смысл постройки.
  function burnH2(col, units, hasGen) {
    let need = units;
    const keys = hasGen ? ['hydrogen', 'tritium', 'antimatter'] : ['hydrogen'];
    for (const k of keys) {
      if (need <= 1e-9) break;
      const per = COL.H2_PER_UNIT[k] || 1;
      const take = Math.min(col.stock[k] || 0, need / per);
      col.stock[k] = (col.stock[k] || 0) - take;
      need -= take * per;
    }
    return units - Math.max(0, need);
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
      // Берём ВСЁ, что ведёт пользователь: сырьё трёх видов, планетарные единицы, содержание
      // сырьём и энергию. Раньше здесь терялась биомасса (у купола и фермы она в цене), а
      // содержание 0 подменялось на 700 — и шахты, которые пользователь сделал бесплатными,
      // снова начинали требовать сырьё, едва в data/prices.json появлялась строка.
      B.cost = { s: +v.s || 0, c: +v.c || 0, b: +v.b || 0, uniq: +v.uniq || 0 };
      if (v.up != null) B.up = +v.up || 0;
      if (v.h2 != null) B.h2 = +v.h2 || 0;
      if (v.comp) { // цена в компонентах, если она задана
        B.comp = {};
        for (const m in v.comp) if (+v.comp[m] > 0) B.comp[m] = +v.comp[m];
        if (!Object.keys(B.comp).length) delete B.comp;
      }
    }
  }

  // ---------- МАССА ----------
  // Трюм и склад меряются МАССОЙ, а не числом единиц (решение пользователя: «мерим по массе
  // предельную вместимость»). У сырья масса своя — от 1 у водорода до 10 у сверхплотных
  // (RESOURCES.mass), поэтому десять тысяч силикатов (масса 4) — это сорок тысяч массы, то есть
  // два-три грузовых отсека, а не «десять тысяч чего-то».
  let compMass = {};           // масса компонента по ключу вида 'struct1'
  function setMasses(tbl) {    // вызывает экран, когда загрузил таблицу компонентов
    compMass = {};
    for (const m of MAT_TYPES) for (const t of TIERS) compMass[m.key + t] = influence(tbl, m.key, 'mass', t);
  }
  const FOOD_MASS = 1;         // ДОПУЩЕНИЕ: пища лёгкая, как водород
  function massOf(key) {
    if (key === 'food') return FOOD_MASS;
    const r = RESOURCES.find(x => x.key === key);
    if (r) return r.mass;
    return compMass[key] || 1;
  }
  const massSum = store => Object.keys(store || {}).reduce((a, k) => a + store[k] * massOf(k), 0);

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
  const used = col => massSum(col.stock) + (col.food || 0) * FOOD_MASS + massSum(col.comp);
  const roomLeft = col => Math.max(0, capacity(col) - used(col));
  // Положить на склад, сколько влезет; вернуть, сколько легло.
  function store(col, key, qty) {
    const q = Math.min(qty, roomLeft(col) / massOf(key));   // место считается массой
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

    // 0. ЭНЕРГИЯ — в начале такта и ПО КАЖДОМУ ЗДАНИЮ ОТДЕЛЬНО, в порядке важности (COL_PRIO:
    // генератор, шахты, фермы...). Кому водорода не досталось — тот этот такт не работает
    // (b.off), но не рушится: кончившийся водород это беда на час, а не повод разбирать постройку.
    //
    // ПОЧЕМУ ПО ЗДАНИЮ, А НЕ ПО КОЛОНИИ. Раньше энергия считалась одной суммой на всю колонию и
    // при нехватке гасила ВСЮ добычу (col.powered). Это запирало колонию навсегда: водород
    // кончился → не работает и энергетическая шахта, которая его добывает → водорода не будет
    // никогда. Прогон tools/colony.js на стартовой планете встал так на 58-м такте и дальше
    // только разбирал постройки за долги. Теперь на себя шахте хватает своей же добычи: 100
    // водорода за такт против 650 с гексa.
    const hasGen = L.some(b => b.kind === 'gen' && manned.has(b));
    const byPrio = L.slice().sort((a, b) => COL_PRIO[a.kind] - COL_PRIO[b.kind]);
    let h2Need = 0, h2Got = 0;
    for (const b of byPrio) {
      const q = (COL_BUILDING[b.kind].h2 || 0) * b.lvl;
      b.off = false;
      if (q <= 0) continue;
      h2Need += q;
      // ЭНЕРГЕТИЧЕСКАЯ ШАХТА ПИТАЕТСЯ СВОЕЙ ЖЕ ДОБЫЧЕЙ. Слова пользователя: «шахты потребляют
      // только водород для самостоятельной выработки энергии» — шахта, которая водород и копает,
      // сжигает часть того, что достала этим же тактом. Иначе колония запирается навсегда:
      // запас водорода кончился → шахта стоит → водорода не будет → ничего не работает. Прогон
      // tools/colony.js вставал так на стартовой планете, где шахта даёт 650 за такт, а чтобы
      // начать ей нужно было 100 из пустого склада.
      const self = COL_BUILDING[b.kind].group === 'e' && manned.has(b)
        ? (h => h ? Object.keys(mineOutput(h, b.kind, b.lvl))
            .reduce((a2, k) => a2 + mineOutput(h, b.kind, b.lvl)[k] * (COL.H2_PER_UNIT[k] || 1), 0) : 0)(hexAt(b.q, b.r))
        : 0;
      if (self >= q) { h2Got += q; continue; }   // своей добычи хватает — со склада не берём
      const got = self + burnH2(col, q - self, hasGen);
      h2Got += got;
      if (got < q - 1e-9) b.off = true;
    }
    const powered = h2Need <= 0 || h2Got >= h2Need - 1e-9;
    if (!powered && !col.h2Warned) { col.h2Warned = true; note(col, 'Не хватает водорода: часть зданий стоит'); }
    if (powered) col.h2Warned = false;
    col.powered = powered;   // для интерфейса: хватило ли энергии всем

    // 1. добыча
    // Добыча кладётся на склад РЕДКИМ ВПЕРЁД (по средней распространённости в галактике,
    // RESOURCE_STATS). Иначе склад забивается дешёвым водородом, сырьё 3 уровня на него уже не
    // попадает — и планетарная единица (§8.5) не делается никогда: колония встаёт навсегда,
    // имея полный склад. Проверено прогоном: без этого 0 единиц за 160 тактов.
    let spill = 0;
    const mined = {};
    for (const b of L) {
      if (!COL_BUILDING[b.kind].group || !manned.has(b) || b.off) continue;
      const h = hexAt(b.q, b.r); if (!h) continue;
      const out = mineOutput(h, b.kind, b.lvl);
      for (const k in out) mined[k] = (mined[k] || 0) + out[k];
    }
    const rare = k => (RESOURCE_STATS[k] ? RESOURCE_STATS[k].avg : 1);
    // СНАЧАЛА ТОПЛИВО НА СВОЮ ЭНЕРГЕТИКУ, и только потом редкое. Водород — самый
    // распространённый ресурс, поэтому по правилу «редким вперёд» он ложится последним, а когда
    // склад полон — не ложится вовсе. Колония при этом глохнет, имея полный склад силикатов:
    // шахты встают без энергии, добыча падает, и вытащить себя она уже не может. Бронь — запас
    // на RESERVE_TICKS тактов работы всех зданий, не больше: остальное место по-прежнему
    // достаётся редкому сырью, иначе на складе не окажется третьего уровня для планетарной
    // единицы (§8.5).
    const RESERVE_TICKS = 6;
    const h2Res = L.reduce((a2, b) => a2 + (COL_BUILDING[b.kind].h2 || 0) * b.lvl, 0) * RESERVE_TICKS;
    if (h2Res > 0) {
      const have = inGroup(col, 'e');
      let room = Math.max(0, h2Res - have);
      for (const k of COL_GROUPS.e) {
        if (room <= 1e-9 || !mined[k]) continue;
        const per = COL.H2_PER_UNIT[k] || 1;
        const want = Math.min(mined[k], room / per);
        const got = store(col, k, want);
        mined[k] -= got; room -= got * per;
        if (mined[k] <= 1e-9) delete mined[k];
      }
    }
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

    // 3б. СОДЕРЖАНИЕ СЫРЬЁМ — раз в час, своим типом. У шахт его нет вовсе (решение
    // пользователя: «шахты делаем бесплатными для содержания»).
    if (col.t % COL.UPKEEP_EVERY === 0) for (const b of L) {
      const B = COL_BUILDING[b.kind], g = B.upkeep, q = (B.up || 0) * b.lvl;
      if (q <= 0) { b.missed = 0; continue; }
      if (inGroup(col, g) >= q) { spendIn(col, g, q); b.missed = 0; }
      else if (++b.missed >= COL.GRACE) {
        b.dead = true;
        note(col, 'Разобрано за долги: ' + COL_BUILDING[b.kind].name);
      }
    }

    // 4. пища и население
    const eaters = col.pop;
    const cap = L.reduce((a, b) => a + (b.kind === 'farm' && manned.has(b) && !b.off ? COL.FARM_CAP * b.lvl : 0), 0);
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
    const mf = L.find(b => b.kind === 'mfarm' && manned.has(b) && !b.off);
    const minted = mf ? burn(col, COL.MFARM_EN * mf.lvl) * COL.TOKEN_PER_EN : 0;
    col.crypto = Math.max(0, col.crypto + minted - paid * COL.WAGE);

    // 6. производство: заказ игрока — компоненты на склад или уникальный ресурс планеты
    const pr = L.find(b => b.kind === 'prod' && manned.has(b) && !b.off);
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

  // СТАРТОВЫЙ КОЛОНИАЛЬНЫЙ НАБОР (решение пользователя): на планете, где игрок начал, сразу
  // стоят купол, генератор и ферма, а на складе лежит 10 000 силикатов — ровно на первую шахту.
  // Без этого первый час уходит на то, чтобы наскрести на что угодно: шахта стоит 10 000, а
  // купол и ферма ещё и требуют биомассы, которой на стартовой планете может не быть вовсе.
  // Даётся ОДИН раз, первой колонии игрока.
  const START_KIT = ['dome', 'gen', 'farm'];
  const START_KIT_SILICATES = 10000;
  function startKit(col, surf) {
    const taken = new Set(col.buildings.map(b => b.q + ',' + b.r));
    // Ставим у центра карты: там же, где обычно садится корабль.
    const spots = surf.hexes.slice().sort((a, b) =>
      (Math.abs(a.q) + Math.abs(a.r) + Math.abs(a.q + a.r)) - (Math.abs(b.q) + Math.abs(b.r) + Math.abs(b.q + b.r)));
    for (const kind of START_KIT) {
      const h = spots.find(x => !taken.has(x.q + ',' + x.r));
      if (!h) break;
      taken.add(h.q + ',' + h.r);
      col.buildings.push({ kind, q: h.q, r: h.r, lvl: 1, missed: 0 });
    }
    add(col.stock, 'silicates', START_KIT_SILICATES);
    note(col, 'Стартовый набор: купол, генератор, ферма и ' + START_KIT_SILICATES + ' силикатов');
  }

  // ---------- стройка по приказу игрока ----------
  // Стройка берёт сырьё СО СКЛАДА и, если корабль стоит тут же, из его ТРЮМА. Иначе первую
  // шахту за 10 000 силикатов не построить: столько сразу на склад молодой колонии не влезает.
  const withShip = (col, ship, g) => inGroup(col, g) +
    (ship ? COL_GROUPS[g].reduce((a, k) => a + ((ship.cargo || {})[k] || 0), 0) : 0);

  function canBuild(col, key, hex, lowOrbit, ship) {
    const B = COL_BUILDING[key];
    if (!B) return 'нет такой постройки';
    if (B.todo) return 'эта ветка пока не развивается';
    if (!!B.orbital !== !!lowOrbit) return B.orbital ? 'только на низкой орбите газового гиганта' : 'нужна твёрдая поверхность';
    if (col.site) return 'уже идёт стройка: ' + COL_BUILDING[col.site.kind].name;
    if (!hex) return 'выберите гекс';
    if (col.buildings.some(b => !b.dead && b.q === hex.q && b.r === hex.r)) return 'гекс занят';
    if (B.group && !COL_GROUPS[B.group].some(k => (hex.res[k] || 0) > 0))
      return 'на этом гексе нет ' + COL_GROUP_NAME[B.group].toLowerCase();
    if (withShip(col, ship, 's') < (B.cost.s || 0)) return 'мало структурного сырья';
    if (withShip(col, ship, 'c') < (B.cost.c || 0)) return 'мало вычислительного сырья';
    if (withShip(col, ship, 'b') < (B.cost.b || 0)) return 'мало биомассы';
    if (col.uniq < (B.cost.uniq || 0)) return 'нужна планетарная единица';
    for (const m in B.comp || {}) {
      const key = m + '1';
      if (((col.comp || {})[key] || 0) < B.comp[m])
        return 'мало компонентов: ' + compName(m, 1).toLowerCase();
    }
    return null;
  }
  // Списываем сперва со склада, остаток — из трюма корабля.
  function spendBoth(col, ship, g, q) {
    const got = spendIn(col, g, q);
    let left = q - got;
    if (left > 1e-9 && ship && ship.cargo)
      for (const k of COL_GROUPS[g]) {
        if (left <= 1e-9) break;
        const take = Math.min(left, ship.cargo[k] || 0);
        ship.cargo[k] -= take; if (ship.cargo[k] <= 0) delete ship.cargo[k];
        left -= take;
      }
    return q - Math.max(0, left);
  }

  function build(col, key, hex, lowOrbit, ship) {
    const err = canBuild(col, key, hex, lowOrbit, ship); if (err) return err;
    const B = COL_BUILDING[key];
    spendBoth(col, ship, 's', B.cost.s || 0); spendBoth(col, ship, 'c', B.cost.c || 0);
    spendBoth(col, ship, 'b', B.cost.b || 0);
    col.uniq -= B.cost.uniq || 0;
    col.comp = col.comp || {};
    for (const m in B.comp || {}) col.comp[m + '1'] -= B.comp[m];
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
      upkeep: L.reduce((a, b) => a + (COL_BUILDING[b.kind].up || 0) * b.lvl, 0),
      h2: L.reduce((a, b) => a + (COL_BUILDING[b.kind].h2 || 0) * b.lvl, 0),
      gen: L.some(b => b.kind === 'gen'), powered: col.powered !== false, port: has(col, 'port'),
      stock: col.stock, food: col.food, crypto: col.crypto, pop: col.pop, uniq: col.uniq,
      popCap: domeCap(col), site: col.site };
  }

  return { blank, advance, step, build, canBuild, summary, live, has, inGroup, spendIn, add, startKit,
    capacity, used, roomLeft, store, setHoldUnit, setPrices, setMasses, massOf, massSum,
    compKey, compName, compCost, compTotal,
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

  const cargoUsed = ship => Colony.massSum(ship.cargo);   // трюм меряется массой
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
      const byFuel = Math.floor(((ship.cargo || {}).hydrogen || 0) / HARVEST_H2);
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
    if (full || ship.food <= 0 || ((ship.cargo || {}).hydrogen || 0) < HARVEST_H2) ship.mine = null;
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
  // Съём с гекса стоит столько же, сколько такт работы шахты — 100 водорода (решение
  // пользователя: «такая же цена добычи и у шахтёра на корабле»). Водород берётся ИЗ ТРЮМА:
  // корабль должен возить топливо, чтобы копать.
  const HARVEST_H2 = 100;
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
    if (((ship.cargo || {}).hydrogen || 0) < HARVEST_H2) return { err: 'в трюме нет водорода на съём (нужно ' + HARVEST_H2 + ')' };
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
    ship.cargo.hydrogen -= HARVEST_H2;
    if (ship.cargo.hydrogen <= 0) delete ship.cargo.hydrogen;
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
    advance, harvest, harvestReady, harvestWait, HARVEST_H2, unload, load, colonyGoods, recharge, loadFood, rechargeFromHold, foodPerUnit,
    cost: shipCost, costRaw: shipCostRaw, costTotal: shipCostTotal, paxCap, ensureStart,
    value: valueOfRaw, valueComp: valueOfComp, valueComps: valueOfComps };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Стоимость корабля в сырье и стартовая загрузка.
//
// ---------- единый эталон стоимости (у.е.) ----------
// Любую цену — сырья, компонента, постройки, корабля — можно свести к одному числу через
// RESOURCE_VALUE (data.js, формула v2). Это и есть «универсальный эталон»: сравнивать шахту с
// кораблём иначе нечем, у них разные валюты.
function valueOfRaw(raw) {
  let v = 0;
  for (const k in raw) v += raw[k] * (RESOURCE_VALUE[k] || 0);
  return v;
}
// Компонент стоит столько, сколько стоит ушедшее на него сырьё (CRAFT).
function valueOfComp(mat, tier) { return valueOfRaw(Colony.compCost(mat, tier)); }
function valueOfComps(comps) {
  let v = 0;
  for (const k in comps) v += comps[k] * valueOfComp(k.slice(0, -1), +k.slice(-1));
  return v;
}

// ЧАСТИ КОРАБЛЯ СОБИРАЮТСЯ ИЗ КОМПОНЕНТОВ, А НЕ ИЗ СЫРЬЯ (решение пользователя). Состав предмета
// в таблице пользователя (data/parts.json) — это сколько компонентов каждого типа в него идёт;
// с масштабом корабля ×10 (см. SHIP_SCALE) это и есть цена сборки. Сырьё в компоненты превращает
// постройка «Производство» (ТЗ §8.14), поэтому верфь без производства бесполезна.
//
// Ключ компонента — 'struct1', 'compute1' и т. д.: на этом этапе игры всё оборудование 1 уровня
// с базовыми настройками, значит и компоненты первого уровня.
function shipCost(tbl, design) {
  const out = {};
  const mods = designModules(design).concat(design.decks.map(() => 'frame'));
  for (const key of mods) {
    const comp = (tbl.comp || {})[key]; if (!comp) continue;
    for (const m of MAT_TYPES) {
      const n = (+comp[m.key] || 0) * SHIP_SCALE;
      if (n) Colony.add(out, m.key + '1', n);
    }
  }
  return out;
}
// Во что эти компоненты обошлись бы сырьём — справка для расценок: компонент 1 уровня стоит
// 3 единицы сырья 1 уровня своего типа (CRAFT).
function shipCostRaw(tbl, design) {
  const out = {}, cost = shipCost(tbl, design);
  for (const key in cost) {
    const mat = key.slice(0, -1), tier = +key.slice(-1);
    const need = Colony.compCost(mat, tier);
    for (const k in need) Colony.add(out, k, need[k] * cost[key]);
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
// Трюм стартового шаттла — 40 000 массы (2,5 грузовых отсека). Грузим так, чтобы хватило на
// первые часы: водород нужен и на съём кораблём (100 за раз), и на содержание первой шахты.
const START_LOAD = { silicates: 2000, silicon: 1000, hydrogen: 6000, food: 2000, pax: 10 };
function ensureStart(ship) {
  if (ship.seeded || ship.id !== 1) return false;
  ship.seeded = true;
  ship.cargo = ship.cargo || {};
  for (const k in START_LOAD) if (k !== 'pax') Colony.add(ship.cargo, k, START_LOAD[k]);
  ship.pax = START_LOAD.pax;
  World.save();
  return true;
}

// МАСШТАБ КОРАБЛЯ ×3 (решение пользователя: «корабль просто умножь на 10 все компоненты и
// тягу — так как масса вырастет тоже в 10 раз — и корабль будет эквивалентен шахте»).
// Один предмет оборудования — это десять наборов компонентов из таблицы, а не один: стартовый
// шаттл стоит 930 единиц сырья вместо 93, то есть примерно как шахта (1000). Масса и тяга
// растут тем же множителем, поэтому ускорение, время разгона и все полётные числа НЕ меняются —
// в ships.js и components.js править нечего, множитель нужен только там, где платят сырьём.
//
// Сперва множитель был 10 — тогда компонент стоил 3 единицы сырья. Когда компонент подорожал
// до 50/30/20, корабль стал дороже шахты, и пользователь поправил: «можешь снизить число
// компонентов для кораблей, так как они стали дороже; корабль уровня корвет или шатл должен
// в совокупности обходиться в 2 раза дешевле шахты, чтоб у игрока была развилка: построить одну
// шахту для пассивной добычи или пару кораблей для активной». При ×3 укомплектованный шаттл
// стоит 4 650 сырья против 10 000 за шахту — ровно вдвое дешевле.
const SHIP_SCALE = 3;
function shipBuildTicks(design) {
  // Время сборки: час на каждые четыре модуля (ДОПУЩЕНИЕ).
  return COL.BUILD_TICKS * Math.max(1, Math.ceil((designModules(design).length + design.decks.length) / 4));
}
