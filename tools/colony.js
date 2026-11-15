// Прототип экономики колонии (ТЗ §8.7–8.8). Сценарий пользователя: корабль с 10 колонистами,
// шахтёрским оборудованием и стартовым сырьём в трюме садится на планету в кольце жизни у
// стартовой звезды и строит колонию с нуля. Время ускорено: такт — 10 РЕАЛЬНЫХ минут (§8.7).
//
// ЧИСЛА ЗДЕСЬ — ПОДБОР, НЕ ТАБЛИЦА ПОЛЬЗОВАТЕЛЯ. Из его решений взяты только:
//   - такт 10 реальных минут и формула шахты 10 × уровень × содержание гекса (§8.7);
//   - цена планетарной единицы 10 + 10 + 10 сырья трёх уровней разных типов (§8.5);
//   - шахты и производство 1 уровня строятся из базового сырья, без уникальных ресурсов;
//   - рабочий ест пищу и получает крипту, неработающий ест только пищу (§8.8);
//   - энергоёмкость носителей 100 / 300 / 800 (ТЗ §7.3) — НЕ ТРОГАТЬ.
// Всё остальное — мои допущения, помечены ДОПУЩЕНИЕ.
//
// Запуск: node tools/colony.js [--star=N] [--planet=N] [--ticks=N] [--spread]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load } = require('./lib.js');
const ROOT = path.join(__dirname, '..');

// ───────────────────────── ЧИСЛА ─────────────────────────
const C = {
  MINE_K: 10,           // ТЗ §8.7: шахта даёт 10 × уровень × содержание гекса за такт
  SHIP_MINE_K: 5,       // ДОПУЩЕНИЕ: корабельный шахтёр вдвое слабее шахты 1 уровня, зато берёт
                        // ВСЕ ресурсы своего гекса, а не одну группу. Работает, пока колония не
                        // достроена: игрок стоит на планете, пока она не встанет на ноги.

  // ДОПУЩЕНИЕ: стоимость зданий 1 уровня. uniq — планетарных единиц (§8.6); у шахт и
  // производства их 0 — решение пользователя, иначе колонию не с чего начать.
  COST: {
    mine:  { s: 800,  c: 200,  uniq: 0 },
    prod:  { s: 1500, c: 600,  uniq: 0 },
    dome:  { s: 1200, c: 300,  uniq: 1 },
    farm:  { s: 900,  c: 500,  uniq: 1 },
    mfarm: { s: 400,  c: 1200, uniq: 1 },
  },
  BUILD_TICKS: 6,       // ДОПУЩЕНИЕ: здание 1 уровня строится реальный час (6 тактов)

  // ДОПУЩЕНИЕ: содержание здания за такт (× уровень). Главный рычаг равновесия.
  UPKEEP_RAW: 700,      // содержание здания 1 уровня за ЧАС, сырьём своего типа. ПОДОБРАНО
                        // прогоном по 200 обитаемым планетам галактики #1: в автономность выходят
                        // 27 % — то, что просил пользователь («рентабельно 20-30 % планет и это
                        // нормально, всё что ниже среднего не рентабельно»). 500 за час → 28 %,
                        // 1000 → 22 %, 2000 → 8 %.
  UPKEEP_EVERY: 6,      // Решение пользователя: добыча раз в 10 минут, а содержание раз в
                        // час — «это даёт шанс накопить что-то в первый час».
  GRACE: 3,            // ДОПУЩЕНИЕ (правило v2 на новом такте): 18 тактов = 3 реальных часа
                        // без полной оплаты содержания → здание разбирается

  EN_PER_UNIT: { hydrogen: 100, tritium: 300, antimatter: 800 }, // ТЗ §7.3, числа пользователя

  FOOD_PER_POP: 1,      // ДОПУЩЕНИЕ: житель съедает 1 пищу за такт
  FARM_CAP: 60,         // ДОПУЩЕНИЕ: ферма уровня L делает до 60 × L пищи за такт
  FOOD_BIO: 1,          // ДОПУЩЕНИЕ: 1 пища из 1 единицы биомассы (переработка, §8.7)
  FOOD_ART_RAW: 5,      // ДОПУЩЕНИЕ: искусственно — 5 единиц структурного сырья...
  FOOD_ART_EN: 2000,    // ...и 2000 энергии на 1 пищу («большее число энергии», §8.7)

  DOME_CAP: 10,         // ДОПУЩЕНИЕ (как поселение v2): купол уровня L держит 10 × L жителей
  POP_TICKS: 144,       // ДОПУЩЕНИЕ: ±1 житель раз в реальные сутки (v2 — ±1 в сутки игры)

  WAGE: 6,              // ДОПУЩЕНИЕ: крипты рабочему за такт (6 рабочих × 6 ≈ 40 намайненных)
  MFARM_EN: 200000,     // ДОПУЩЕНИЕ: майнинг-ферма уровня L жжёт до 200 000 × L энергии за такт —
                        // она и есть сток лишней энергии, иначе носители копятся без дела
  TOKEN_PER_EN: 0.0004, // ДОПУЩЕНИЕ: крипты за единицу энергии (→ до 80 крипты/такт на 1 уровне,
                        // жалованья хватает на 13 рабочих, если энергии вдоволь)

  UNIQ_RAW: 10,         // §8.5: по 10 единиц сырья 1, 2 и 3 уровня разных типов
  PROD_TICKS: 144,      // ДОПУЩЕНИЕ и ГЛАВНЫЙ ТОРМОЗ РОСТА: производство уровня L выдаёт одну
                        // планетарную единицу раз в 144 / L тактов — реальные сутки на 1 уровне.
                        // Цена сырья (30 единиц) против добычи в тысячи ничего не сдерживает,
                        // сдерживает только темп: здание 1 уровня стоит 1 единицу (§8.6), то
                        // есть колония прирастает примерно одной постройкой в сутки.

  // ДОПУЩЕНИЕ: что игрок грузит в трюм. Объём — настоящая грузоподъёмность стартового
  // корабля из конструктора (shipTotals.capacity, компоненты 1 уровня), не выдуманное число.
  HOLD_SPLIT: { s: 0.18, c: 0.12, e: 0.20, food: 0.50 },
  CRYPTO_START: 20000,  // ДОПУЩЕНИЕ: крипта игрока — цифровая, место в трюме не занимает. Её
                        // должно хватить до майнинг-фермы: без крипты рабочие не выходят, добыча
                        // встаёт и колония уже не поднимется. Майнинг-ферма — шестая по счёту
                        // и ждёт второй планетарной единицы, то есть встаёт к концу вторых
                        // суток: 6 рабочих × 6 крипты × ~470 тактов ≈ 17 000. На 10 000
                        // колония срывалась на третьи сутки — проверено.
  AUTO_HOLD: 144,       // ДОПУЩЕНИЕ: автономность засчитывается, только если колония держит
                        // равновесие реальные сутки подряд. На 12 тактах засчитывались и те,
                        // кто разваливался через час после стройки: долг по содержанию
                        // разбирает здание через GRACE = 18 тактов, то есть позже проверки.
  BUILD_RUNWAY: 100,    // ДОПУЩЕНИЕ: игрок не ставит здание, если нечем платить его
                        // рабочему — нужен запас крипты на 100 тактов вперёд либо свой майнинг
  FIX_EVERY: 144,       // ДОПУЩЕНИЕ: раз в реальные сутки колония смотрит, какой группы не
                        // хватает, и ставит ещё одну шахту этой группы
  COLONISTS: 10,        // запрос пользователя
};

// --up=K множит всё содержание: так ищется порог рентабельности (цель пользователя — рентабельны
// 20–30 % планет, всё ниже среднего нерентабельно).
{
  const a = process.argv.find(x => x.startsWith('--up='));
  if (a) { const k = +a.split('=')[1]; C.UPKEEP_RAW *= k; }
}

// Группы сырья по уровням: [1 уровень, 2 уровень, 3 уровень] — ступени внутри группы (§5).
const GROUPS = {
  s: ['silicates', 'rareEarth', 'superdense'],
  c: ['silicon', 'niobium', 'isotopes'],
  e: ['hydrogen', 'tritium', 'antimatter'],
  b: ['microbiota', 'flora', 'bitumen'],
};
const GROUP_NAME = { s: 'структурные', c: 'вычислительные', e: 'энергоносители', b: 'биомасса' };

// ───────────────────────── загрузка мира и корабля ─────────────────────────
const G = load(); // data.js + gen.js + galaxy-gen.js + surface.js

function shipHold() {
  const ctx = { Math, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  vm.createContext(ctx);
  for (const f of ['js/data.js', 'js/ships.js', 'js/components.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^const /gm, 'var '), ctx);
  const tbl = ctx.loadParts(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/parts.json'), 'utf8')));
  const r = ctx.shipTotals(tbl, ctx.findDesign(ctx.START_DESIGN), 1, null, 1, 1);
  return { capacity: r.capacity, lifeSupport: r.lifeSupport, name: ctx.START_DESIGN };
}

// ───────────────────────── планета и расстановка шахт ─────────────────────────
function pickPlanet(starId, planetIdx) {
  const gal = G.generateGalaxy(1);
  const st = starId != null ? gal.stars[starId]
    : gal.stars.find(s => s.type.key === 'yellow' && (s.zone === 2 || s.zone === 3));
  const sys = G.generateSystem(st);
  const p = planetIdx != null ? sys.planets[planetIdx] : sys.planets.find(x => x.habitable);
  const surf = G.generateSurface(p, st);
  return { st, p, surf };
}

// Гексы под шахты группы — по убыванию ценности. ДОПУЩЕНИЕ: ценность — сумма, взвешенная
// редкостью (RESOURCE_STATS.avg по галактике): единица сверхплотных дороже десятка силикатов.
// Исключение — энергоносители: там ценность это ЭНЕРГИЯ (содержание × энергоёмкость), колонии
// нужны киловатты, а не коллекция.
// ГЛАВНОЕ: у ГРУПП КРОМЕ ЭНЕРГОНОСИТЕЛЕЙ гексы с сырьём 3 УРОВНЯ идут первыми. Без сырья 3 уровня не
// делается планетарная единица (§8.5), а без неё нет ни ферм, ни майнинг-фермы, ни купола —
// колония умирает от голода, даже когда сырья завались. На Варрибе d (зона 1, 8265 ед./такт)
// шахта садилась на гекс с 202 силикатами и нулём сверхплотных, и планета разваливалась на
// пятые сутки, имея миллион единиц на складе.
// У энергоносителей наоборот: гекс с 6 антиматерии «редкий», но даёт 130 ед. носителей
// за такт против 2590 у водородного — колония задыхается без топлива. Антиматерию под
// планетарную единицу дают шахты других групп (сверхплотные, изотопы).
function hexRank(surf, group) {
  const weight = k => group === 'e' ? C.EN_PER_UNIT[k]
    : 1 / (G.RESOURCE_STATS[k] ? G.RESOURCE_STATS[k].avg : 1);
  return surf.hexes
    .filter(h => GROUPS[group].some(k => (h.res[k] || 0) > 0))
    .map(h => ({ h, v: GROUPS[group].reduce((a, k) => a + (h.res[k] || 0) * weight(k), 0) }))
    .sort((a, b) => b.v - a.v)
    .map(x => x.h);
}

// ───────────────────────── симуляция ─────────────────────────
// Порядок стройки — ДОПУЩЕНИЕ, но вынужденное: без энергии не платится содержание, без
// производства нет планетарных единиц, а купол/фермы/майнинг-ферма стоят по одной (§8.6).
const PLAN = ['mine_e', 'mine_s', 'mine_c', 'prod', 'farm', 'mfarm', 'dome', 'mine_b'];
const KIND = k => k.startsWith('mine') ? 'mine' : k;
const PRIO = { mine: 0, farm: 1, mfarm: 2, prod: 3, dome: 99 }; // купол рабочих не требует
// ДОПУЩЕНИЕ: какой тип сырья содержит какое здание — то, с чем здание работает.
const UPKEEP_GROUP = { mine_s: 's', mine_c: 'c', mine_e: 'e', mine_b: 'b',
  prod: 's', dome: 's', farm: 'e', mfarm: 'c' };
const LABEL = { mine_s: 'шахта структурная', mine_c: 'шахта вычислительная', mine_e: 'шахта энергетическая',
  mine_b: 'шахта биохимическая', prod: 'производство', dome: 'купол', farm: 'фермы', mfarm: 'майнинг-ферма' };

function simulate(world, ticks) {
  const { p, surf } = world;
  const hold = shipHold();
  const stock = {};
  const put = (k, q) => { if (q) stock[k] = (stock[k] || 0) + q; };
  put(GROUPS.s[0], Math.round(hold.capacity * C.HOLD_SPLIT.s));
  put(GROUPS.c[0], Math.round(hold.capacity * C.HOLD_SPLIT.c));
  put(GROUPS.e[0], Math.round(hold.capacity * C.HOLD_SPLIT.e));
  let food = Math.round(hold.capacity * C.HOLD_SPLIT.food);
  let crypto = C.CRYPTO_START, uniq = 0, pop = C.COLONISTS, popClock = 0, prodClock = 0;
  const built = [];           // {kind, lvl, hex, group, missed, dead}
  let site = null;            // стройка: {kind, left}
  const rank = {}, used = {};
  for (const g of Object.keys(GROUPS)) { rank[g] = hexRank(surf, g); used[g] = new Set(); }
  // следующий свободный гекс группы; want3 — обязательно с сырьём 3 уровня
  const nextHex = (g, want3) => rank[g].find(h => !used[g].has(h)
    && (!want3 || (h.res[GROUPS[g][2]] || 0) > 0)) || null;
  const hexes = {};
  for (const g of Object.keys(GROUPS)) hexes[g] = rank[g][0] || null;
  const compOf = k => (p.composition.find(c => c.key === k) || {}).value || 0;
  const floraBase = Math.round(compOf('flora'));
  const events = [];
  let auto = null, autoRun = 0, shipAt = null, firstUniq = false, prodReadyLast = false;
  const hist = [];

  const groupStock = g => GROUPS[g].reduce((a, k) => a + (stock[k] || 0), 0);
  // списать q единиц группы g, начиная с 1 уровня — ДОПУЩЕНИЕ: дешёвое расходуется первым,
  // редкое берегут под планетарные единицы
  function spend(g, q) {
    let left = q;
    for (const k of GROUPS[g]) {
      const take = Math.min(left, stock[k] || 0);
      stock[k] -= take; left -= take;
      if (left <= 1e-9) return true;
    }
    return left <= 1e-9;
  }
  // сжечь носители на en энергии, дешёвыми вперёд; вернуть, сколько энергии вышло
  function burn(en) {
    let need = en;
    for (const k of GROUPS.e) {
      if (need <= 0) break;
      const per = C.EN_PER_UNIT[k], have = stock[k] || 0;
      const take = Math.min(have, need / per);
      stock[k] -= take; need -= take * per;
    }
    return en - Math.max(0, need);
  }
  // Содержание здания 1 УРОВНЯ — сырьё ОДНОГО ОПРЕДЕЛЁННОГО ТИПА, но ЛЮБОЕ внутри него
  // (решение пользователя: «для первого уровня любого сырья определённого типа, для 2 уровня
  // будет уже другая система содержания»). Какой тип какому зданию — ДОПУЩЕНИЕ: то, с чем
  // здание работает.
  const anyIn = g => GROUPS[g].reduce((a, k) => a + (stock[k] || 0), 0);
  function spendIn(g, q) {
    let left = q;
    const by = GROUPS[g].slice().sort((a, b) => (stock[b] || 0) - (stock[a] || 0));
    for (const k of by) {
      if (left <= 1e-9) break;
      const take = Math.min(left, stock[k] || 0);
      stock[k] -= take; left -= take;
    }
    return q - Math.max(0, left);
  }
  const canPay = cost => groupStock('s') >= cost.s && groupStock('c') >= cost.c && uniq >= (cost.uniq || 0);

  for (let t = 1; t <= ticks; t++) {
    // ── рабочие: сколько мест укомплектовано (ограничено населением и криптой)
    const order = built.map((b, i) => ({ i, pr: PRIO[KIND(b.kind)], dead: b.dead }))
      .filter(x => x.pr < 99 && !x.dead).sort((a, b2) => a.pr - b2.pr);
    const paid = Math.min(pop, Math.floor(crypto / C.WAGE), order.length);
    const manned = new Set(order.slice(0, paid).map(x => x.i));

    // ── 1. добыча
    shipAt = null;
    const live0 = built.filter(b => !b.dead).length;
    let mined = 0;
    built.forEach((b, i) => {
      if (KIND(b.kind) !== 'mine' || !manned.has(i) || !b.hex) return;
      for (const k of GROUPS[b.group]) { const q = C.MINE_K * b.lvl * (b.hex.res[k] || 0); put(k, q); mined += q; }
    });
    // Корабельный шахтёр работает, пока колония не достроена (ДОПУЩЕНИЕ: игрок стоит на планете,
    // пока она не встала на ноги). ДОПУЩЕНИЕ: корабль ПЕРЕЛЕТАЕТ на гекс той группы, которой
    // сейчас не хватает на следующую постройку — ровно так поступил бы игрок с шахтёром. Без
    // этого колония садится на один гекс и, скажем, вычислительных не набирает никогда.
    const shipHere = !PLAN.every(k => built.some(b => b.kind === k));
    if (shipHere) {
      const nextK = PLAN.find(k => !built.some(b => b.kind === k));
      const cost = nextK ? C.COST[KIND(nextK)] : { s: 0, c: 0 };
      let pick = 'e', worst = -Infinity;
      for (const g of ['s', 'c', 'e']) {
        const need = (cost[g] || 0) + C.UPKEEP_RAW * live0 * 4 - groupStock(g);
        if (need > worst) { worst = need; pick = g; }
      }
      const h = hexes[pick] || hexes.s;
      shipAt = pick;
      for (const k in h.res) { const q = C.SHIP_MINE_K * h.res[k]; put(k, q); mined += q; }
    }

    // ── 2. стройка. Сверх основного плана колония достраивает ШАХТЫ по нужде — так поступил бы
    // игрок, и так она сама выходит в равновесие вместо медленной смерти на одной бедной группе.
    const planDone = PLAN.every(k => built.some(b => b.kind === k));
    if (!site && planDone && t % C.FIX_EVERY === 0) {
      let plan = null;
      // (а) НЕТ СЫРЬЯ 3 УРОВНЯ — ставим шахту туда, где оно лежит. Его нужно всего 10 единиц в
      // сутки, но без него нет планетарной единицы (§8.5), а значит ни ферм, ни купола, ни
      // майнинг-фермы: колония умирает от голода посреди полного склада.
      if (!prodReadyLast) {
        let best = null;
        for (const g of ['s', 'c', 'e', 'b']) {
          const h = nextHex(g, true);
          if (!h) continue;
          const v = h.res[GROUPS[g][2]] || 0;
          if (!best || v > best.v) best = { g, h, v };
        }
        if (best) plan = { g: best.g, h: best.h, why: 'нужно сырьё 3 уровня' };
      }
      // (б) ГРУППА ПРОСЕЛА — ещё одна шахта, но только если гекс отработает своё содержание:
      // шахта на бедном гексе делает хуже, а не лучше (проверено на Тазеэл c — три таких
      // шахты подряд разобрали за долги).
      if (!plan) for (const g of ['s', 'c', 'e']) {
        const was = hist[hist.length - C.FIX_EVERY];
        if (!was || groupStock(g) >= was[g]) continue;
        const h = nextHex(g, false);
        if (!h) continue;
        const perHour = C.UPKEEP_EVERY * C.MINE_K * GROUPS[g].reduce((a, k) => a + (h.res[k] || 0), 0);
        if (perHour <= C.UPKEEP_RAW) continue;
        plan = { g, h, why: GROUP_NAME[g] + ' просели' };
        break;
      }
      if (plan && canPay(C.COST.mine)) {
        spend('s', C.COST.mine.s); spend('c', C.COST.mine.c);
        used[plan.g].add(plan.h);
        site = { kind: 'mine_' + plan.g, left: C.BUILD_TICKS, hex: plan.h };
        events.push([t, 'дострой: ещё одна ' + LABEL['mine_' + plan.g] + ' (' + plan.why + ')']);
      }
    }
    if (!site) {
      const next = PLAN.find(k => !built.some(b => b.kind === k));
      if (next) {
        const g = next.startsWith('mine') ? next.slice(5) : null;
        const h = g ? nextHex(g, false) : null;
        if (g && !h) {
          built.push({ kind: next, lvl: 1, hex: null, group: g, missed: 0, dead: true });
          events.push([t, 'пропущено (нет ресурса на планете): ' + LABEL[next]]);
        } else {
          const cost = C.COST[KIND(next)];
          // ДОПУЩЕНИЕ: не ставим то, чьему рабочему нечем платить (§8.8) — иначе колония
          // достраивается и тут же встаёт без крипты
          const needW = (PRIO[KIND(next)] < 99 ? 1 : 0) + order.length;
          const affordable = crypto >= needW * C.WAGE * C.BUILD_RUNWAY
            || built.some((b, i) => b.kind === 'mfarm' && manned.has(i) && !b.dead);
          if (canPay(cost) && affordable) {
            spend('s', cost.s); spend('c', cost.c); uniq -= cost.uniq || 0;
            if (h) used[g].add(h);
            site = { kind: next, left: C.BUILD_TICKS, hex: h };
            events.push([t, 'начата стройка: ' + LABEL[next]]);
          }
        }
      }
    } else if (--site.left <= 0) {
      const g = site.kind.startsWith('mine') ? site.kind.slice(5) : null;
      built.push({ kind: site.kind, lvl: 1, hex: site.hex || null, group: g, missed: 0 });
      events.push([t, 'готово: ' + LABEL[site.kind]]);
      site = null;
    }

    // ── 3. содержание зданий: сырьё своего типа, любое внутри типа (§8.8, 1 уровень)
    const live = built.filter(b => !b.dead);
    let demolished = 0;
    const upkeepDue = t % C.UPKEEP_EVERY === 0;
    for (const b of built) {
      if (b.dead || !upkeepDue) continue;
      const g = UPKEEP_GROUP[b.kind], need = C.UPKEEP_RAW * b.lvl;
      if (anyIn(g) >= need) { spendIn(g, need); b.missed = 0; }
      else if (++b.missed >= C.GRACE) { b.dead = true; demolished++; events.push([t, 'РАЗОБРАНО за долги: ' + LABEL[b.kind]]); }
    }

    // ── 4. пища и население. Энергию жгут только пища и майнинг-ферма: содержание зданий
    // считается сырьём (выше), иначе энергия была бы вторым независимым порогом и рентабельных
    // планет осталось бы 2-8 % вместо нужных 20-30 %.
    const popFood = pop * C.FOOD_PER_POP;
    const farmCap = built.reduce((a, b, i) => a + (b.kind === 'farm' && manned.has(i) && !b.dead ? C.FARM_CAP * b.lvl : 0), 0);
    const bioAvail = GROUPS.b.reduce((a, k) => a + (stock[k] || 0), 0);
    const wantFood = Math.min(farmCap, Math.max(0, popFood * 2 - food)); // ДОПУЩЕНИЕ: держат двойной запас
    const fromBio = Math.min(wantFood, bioAvail * C.FOOD_BIO);
    let fromArt = wantFood - fromBio;
    if (fromArt > 0) { // искусственная пища ограничена и энергией, и сырьём
      fromArt = Math.min(fromArt, Math.floor(burn(fromArt * C.FOOD_ART_EN) / C.FOOD_ART_EN));
      fromArt = Math.min(fromArt, Math.floor(spendIn('s', fromArt * C.FOOD_ART_RAW) / C.FOOD_ART_RAW));
    }
    let bioLeft = fromBio;
    for (const k of GROUPS.b) { const take = Math.min(bioLeft, stock[k] || 0); stock[k] -= take; bioLeft -= take; }
    const madeFood = fromBio + fromArt;
    food += madeFood;
    const eaten = Math.min(food, popFood);
    food -= eaten;
    const hungry = eaten < popFood - 1e-9;
    const domeCap = built.reduce((a, b) => a + (b.kind === 'dome' && !b.dead ? C.DOME_CAP * b.lvl : 0), 0);
    if (++popClock >= C.POP_TICKS) {
      popClock = 0;
      if (hungry) pop = Math.max(floraBase, pop - 1);
      else if (pop < domeCap) pop++;
    }

    // ── 5. крипта: майнинг-ферма жжёт энергию, оставшуюся после пищи
    const mfarmIdx = built.findIndex((b, i) => b.kind === 'mfarm' && manned.has(i) && !b.dead);
    const minted = mfarmIdx >= 0 ? burn(C.MFARM_EN * built[mfarmIdx].lvl) * C.TOKEN_PER_EN : 0;
    crypto = Math.max(0, crypto + minted - paid * C.WAGE);

    // ── 7. планетарная единица: по 10 единиц сырья 1, 2 и 3 уровня ИЗ РАЗНЫХ ГРУПП (§8.5)
    const prodIdx = built.findIndex((b, i) => b.kind === 'prod' && manned.has(i) && !b.dead);
    let madeUniq = 0, prodReady = false;
    prodClock += prodIdx >= 0 ? built[prodIdx].lvl : 0;
    const due = prodIdx >= 0 && prodClock >= C.PROD_TICKS;
    if (prodIdx >= 0) for (let n = 0; n < 1; n++) {
      const pick = [], used = new Set();
      for (const tier of [2, 1, 0]) {
        let best = null, bv = 0;
        for (const g of Object.keys(GROUPS)) {
          if (used.has(g)) continue;
          const k = GROUPS[g][tier], have = stock[k] || 0;
          if (have >= C.UNIQ_RAW && have > bv) { bv = have; best = [g, k]; }
        }
        if (!best) { pick.length = 0; break; }
        used.add(best[0]); pick.push(best[1]);
      }
      if (!pick.length) break;
      prodReady = true;
      if (!due) break;
      prodClock -= C.PROD_TICKS;
      for (const k of pick) stock[k] -= C.UNIQ_RAW;
      uniq++; madeUniq++;
      if (!firstUniq) { firstUniq = true; events.push([t, 'первая планетарная единица: ' + pick.join(' + ')]); }
    }

    // Склад не должен убывать: иначе колония просто проедает запас, накопленный за стройку,
    // и через пару суток разваливается — так и засчитывались ложные автономности.
    const back = hist[hist.length - C.AUTO_HOLD];
    const drain = back && (groupStock('s') < back.s - 1 || groupStock('c') < back.c - 1
      || groupStock('e') < back.e - 1);
    // ── автономность: всё построено, рабочих хватает, пища и крипта в плюсе, долгов нет
    const allBuilt = PLAN.every(k => built.some(b => b.kind === k)) && !site;
    const needWork = built.filter(b => !b.dead && PRIO[KIND(b.kind)] < 99).length;
    const ok = allBuilt && !demolished && manned.size === needWork && !hungry && madeFood >= popFood
      && minted >= paid * C.WAGE && live.every(b => b.missed === 0) && prodReady && !drain;
    prodReadyLast = prodReady;
    autoRun = ok ? autoRun + 1 : 0;
    if (!auto && autoRun >= C.AUTO_HOLD) { auto = t - C.AUTO_HOLD + 1; events.push([auto, '*** АВТОНОМНОСТЬ ***']); }

    hist.push({ t, pop, paid, food: Math.round(food), crypto: Math.round(crypto), uniq,
      s: Math.round(groupStock('s')), c: Math.round(groupStock('c')), e: Math.round(groupStock('e')),
      mined: Math.round(mined), alive: live.length, shipAt, minted: Math.round(minted) });
  }
  return { events, hist, built, auto, hold, floraBase, hexes };
}

const fmtT = t => { const m = t * 10, d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return String(d).padStart(2) + 'д ' + String(h).padStart(2) + 'ч'; };

// ───────────────────────── отчёт ─────────────────────────
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? +a.split('=')[1] : d; };
const TICKS = arg('ticks', 2016); // 14 реальных суток

if (argv.includes('--spread')) {
  // разброс по обитаемым планетам: где колония выходит в автономность, а где умирает
  const gal = G.generateGalaxy(1);
  const rows = [];
  for (let i = 0; i < gal.stars.length && rows.length < arg('n', 60); i++) {
    const st = gal.stars[i];
    const sys = G.generateSystem(st);
    const p = sys.planets.find(x => x.habitable);
    if (!p) continue;
    const surf = G.generateSurface(p, st);
    const r = simulate({ st, p, surf }, TICKS);
    const last = r.hist[r.hist.length - 1], prev = r.hist[r.hist.length - 145];
    rows.push({ name: p.name, zone: st.zone, life: p.life, auto: r.auto, pop: last.pop, uniq: last.uniq,
      alive: last.alive, mined: last.mined, acc: Math.round((last.s + last.c + last.e - prev.s - prev.c - prev.e) / 144) });
  }
  console.log('разброс по ' + rows.length + ' обитаемым планетам (' + TICKS + ' тактов):');
  console.log('планета              зона жизнь    автоном  насел  план.ед  зданий  добыча  копит/такт');
  for (const r of rows) console.log(r.name.padEnd(20) + String(r.zone).padStart(4) + ' ' + r.life.padEnd(8)
    + (r.auto ? fmtT(r.auto) : '   нет  ').padStart(9) + String(r.pop).padStart(7) + String(r.uniq).padStart(9)
    + String(r.alive).padStart(8) + String(r.mined).padStart(8) + String(r.acc).padStart(12));
  const good = rows.filter(r => r.auto);
  const mines = rows.map(r => r.mined).sort((a, b) => a - b);
  const avg = Math.round(mines.reduce((a, b) => a + b, 0) / mines.length);
  console.log(String.fromCharCode(10) + 'рентабельны (вышли в автономность): ' + good.length + ' из ' + rows.length
    + ' = ' + Math.round(good.length / rows.length * 100) + '%'
    + (good.length ? ', медиана времени ' + fmtT(good.map(r => r.auto).sort((a, b) => a - b)[good.length >> 1]).trim() : ''));
  console.log('добыча по выборке: средняя ' + avg + ', медиана ' + mines[mines.length >> 1]
    + ', у рентабельных минимум ' + (good.length ? Math.min(...good.map(r => r.mined)) : '—') + ' ед./такт');
  process.exit(0);
  process.exit(0);
}

const world = pickPlanet(arg('star', null), arg('planet', null));
const r = simulate(world, TICKS);

console.log('ПЛАНЕТА: ' + world.p.name + ' (' + world.st.name + ', зона ' + world.st.zone + ', ' + world.p.type
  + ', кольцо жизни: ' + (world.p.habitable ? 'да' : 'нет') + ', жизнь: ' + world.p.life
  + ', гексов ' + world.surf.hexes.length + ')');
console.log('КОРАБЛЬ: ' + r.hold.name + ' — трюм ' + r.hold.capacity + ' ед. (из конструктора), жизнеобеспечение на '
  + r.hold.lifeSupport + ', колонистов ' + C.COLONISTS
  + (r.hold.lifeSupport < C.COLONISTS ? '  ← колонистов больше, чем жизнеобеспечения' : ''));
console.log('БАЗА НАСЕЛЕНИЯ по дикой флоре (§8.3): ' + r.floraBase
  + (r.floraBase === 0 ? ' — своей жизни нет, пища только искусственная' : ''));
console.log('\nГЕКСЫ ПОД ПЕРВЫЕ ШАХТЫ (следующие шахты садятся на следующие по ценности):');
for (const [g, h] of Object.entries(r.hexes)) {
  const row = h ? GROUPS[g].map(k => k + ' ' + (h.res[k] || 0)).join(', ') : 'ресурса нет';
  const out = h ? GROUPS[g].reduce((a, k) => a + C.MINE_K * (h.res[k] || 0), 0) : 0;
  console.log('  ' + GROUP_NAME[g].padEnd(16) + (h ? (h.q + ',' + h.r).padEnd(7) + h.type.padEnd(11) : ''.padEnd(18))
    + row.padEnd(46) + '→ ' + out + ' ед./такт');
}
console.log('\nХОД СТРОЙКИ:');
for (const [t, s] of r.events) console.log('  ' + fmtT(t) + '  (такт ' + String(t).padStart(4) + ')  ' + s);
console.log('\nСОСТОЯНИЕ КОЛОНИИ:');
console.log('  время      такт  насел  раб  пища  крипта  план.ед  структ  вычисл  энергонос  добыча  корабль');
for (const h of r.hist) {
  if (h.t % 144 !== 0 && h.t !== r.hist.length && h.t !== r.auto) continue;
  console.log('  ' + fmtT(h.t) + ' ' + String(h.t).padStart(5) + String(h.pop).padStart(7) + String(h.paid).padStart(5)
    + String(h.food).padStart(6) + String(h.crypto).padStart(8) + String(h.uniq).padStart(9)
    + String(h.s).padStart(8) + String(h.c).padStart(8) + String(h.e).padStart(11)
    + String(h.mined).padStart(8)
    + (h.shipAt ? '   ' + GROUP_NAME[h.shipAt] : '   ушёл')
  + (h.t === r.auto ? '   ← автономность' : ''));
}
const last = r.hist[r.hist.length - 1], prev = r.hist[r.hist.length - 145] || r.hist[0];
console.log('\nИТОГ: ' + (r.auto ? 'автономность на такте ' + r.auto + ' (' + fmtT(r.auto).trim() + ' реального времени)' : 'АВТОНОМНОСТИ НЕТ'));
console.log('  живых зданий ' + last.alive + ' из ' + PLAN.length + ', население ' + last.pop
  + ', планетарных единиц ' + last.uniq);
const dS = last.s - prev.s, dC = last.c - prev.c, dE = last.e - prev.e;
const per = n => (n >= 0 ? '+' : '') + Math.round(n / 144) + ' ед./такт';
console.log('  накопление за последние сутки: структурные ' + per(dS) + ', вычислительные ' + per(dC)
  + ', энергоносители ' + per(dE) + '  (добыча ' + last.mined + ' ед./такт)');
const acc = (dS + dC + dE) / 144, share = last.mined ? acc / last.mined : 0;
console.log('  копит ' + Math.round(share * 100) + '% добычи'
  + (Math.abs(share) < 0.1 ? ' — равновесие' : share > 0 ? ' — копит слишком много' : ' — проедает запас'));
