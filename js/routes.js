// АВТОРЕЙСЫ: колония сама гоняет корабль за ресурсом (ТЗ §8.18).
//
// Слова пользователя (2026-11-27): «для майнинга крипты нужен водород, его может подвозить корабль;
// нужно научить колонию использовать корабль для добычи ресурсов на ближних планетах автоматом
// с подвозом к колонии, со сканером ближайших планет в системах рядом, с учётом времени полёта
// и рентабельности, чтоб искать оптимальные планеты для забора ресурса».
// ТЗ §8.10 это предусматривал: игра — автосимулятор, приказы кораблям можно автоматизировать,
// и это легально — автоматизация даёт только скорость.
//
// НИЧЕГО СВОЕГО ЗДЕСЬ НЕ СЧИТАЕТСЯ. Съём с гекса — Ship.harvest/Ship.advance (100 водорода за съём,
// один гекс на планету за такт, все ресурсы гекса), выгрузка — Ship.unload, пища — Ship.recharge,
// время полёта — travelTime и warpEstimate из ships.js (те же, что у полёта на экранах). Модуль
// только решает, КУДА лететь, и ведёт корабль по фазам: туда → копать → обратно → выгрузить.
//
// Корабль в рейсе живёт по часам, как колония: фазы считаются по меткам времени, поэтому рейс идёт
// и когда игрок на другом экране или вовсе не заходил (догоняется при следующем визите).
const ROUTE = {
  STARS: 6,          // ДОПУЩЕНИЕ: сканер смотрит свою систему и 6 ближайших звёзд...
  KPC: 1,            // ...не дальше 1 кпк (≈ 3 260 св. лет). Скачок мгновенный (§6.1), поэтому
                     // соседняя звезда стоит те же ~6 минут, что и дальняя: предел — дальность сканера
  LIFE_SPARE: 6,     // пищи в жизнеобеспечении сверх обратной дороги: час про запас
  MAX_TICKS: 144,    // ДОПУЩЕНИЕ: на месте не дольше суток за рейс, даже если трюм не забит
  MAX_EVENTS: 50000, // предохранитель догона за один вызов
};

// Что колония заказывает кораблю. Вес ресурса — сколько единицы цели он стоит:
//   crypto — сколько крипты намайнит из него майнинг-ферма: энергоёмкость топлива (FUEL.yield:
//            водород 10, тритий 100, антиматерия 1000) × COL.TOKEN_PER_EN. Ради этого рейсы и
//            затевались: тритий здесь в десять раз ценнее водорода, а не в три, как у зданий;
//   e — энергия зданий в «водородах» (тритий ×3, антиматерия ×8, как жжёт генератор, COL.H2_PER_UNIT);
//   s, c, b — штуки сырья своей группы;
//   value — всё по эталону стоимости (RESOURCE_VALUE, у.е.).
// Веса нужд колонии для цели 'need' (Colony.needs) — ставятся перед сканом и на каждой стоянке.
let ROUTE_NEED_W = {};
const ROUTE_TARGETS = {
  need: { name: 'Нужды колонии', unit: 'ед. нужного', w: k => ROUTE_NEED_W[k] || 0 },
  crypto: { name: 'Крипта', unit: 'крипты', w: k => COL_KEY_GROUP[k] === 'e' && FUEL[k] ? FUEL[k].yield * COL.TOKEN_PER_EN : 0 },
  e: { name: 'Энергия', unit: 'водорода', w: k => COL_KEY_GROUP[k] === 'e' ? (COL.H2_PER_UNIT[k] || 1) : 0 },
  s: { name: 'Структурные', unit: 'ед.', w: k => COL_KEY_GROUP[k] === 's' ? 1 : 0 },
  c: { name: 'Вычислительные', unit: 'ед.', w: k => COL_KEY_GROUP[k] === 'c' ? 1 : 0 },
  b: { name: 'Биомасса', unit: 'ед.', w: k => COL_KEY_GROUP[k] === 'b' ? 1 : 0 },
  value: { name: 'Всё по ценности', unit: 'у.е.', w: k => RESOURCE_VALUE[k] || 0 },
};

const Routes = (() => {
  const TICK = COL.TICK_MS;
  const H2 = () => Ship.HARVEST_H2;
  const fly = ship => shipStats(findDesign(ship.design));

  // ---------- время в пути ----------
  // Внутри системы — travelTime (разгон до середины, торможение) на СРЕДНЕЕ расстояние между
  // орбитами √(a₁² + a₂²): планеты обегают звезду за минуты (год на 1 а. е. = 240 с), поэтому
  // расстояние в момент вылета ничего не говорит о следующем рейсе. ДОПУЩЕНИЕ.
  // Между звёздами — разгон до c и торможение (warpEstimate, режим «Быстро»: скачок мгновенный,
  // §6.1) плюс подход от края к планете назначения. Взлёт и посадка не считаются.
  function legSec(fs, fromStar, fromP, toStar, toP) {
    if (!(fs.accel > 0)) return Infinity;
    if (fromStar === toStar) {
      if (fromP.index === toP.index) return 0;
      return travelTime(fs.accel, Math.sqrt(fromP.a * fromP.a + toP.a * toP.a));
    }
    const w = warpEstimate(fs, 'fast');
    return w.accel + w.brake + travelTime(fs.accel, toP.a);
  }
  function warpFuel(fs) { return isFinite(fs.dv) && fs.dv > 0 ? warpEstimate(fs, 'fast').fuel : 0; }
  // ТОПЛИВО НА ПЕРЕЛЁТ — доля бака. Рейс летит «Быстро»: тяга всё время, каждая секунда тяги стоит
  // burnPerCycle единиц (вместе с пассивными системами); груз удлиняет полёт — значит и расход.
  // Между звёздами — скачок (warpEstimate) плюс подход к планете.
  function legFuel(fs, fromStar, fromP, toStar, toP) {
    if (!(fs.burnPerCycle > 0) || !(fs.fuelUnits > 0)) return 0;          // реактор кормит двигатели
    const per = fs.burnPerCycle / fs.fuelUnits;
    if (fromStar === toStar) return fromP.index === toP.index ? 0 : per * legSec(fs, fromStar, fromP, toStar, toP);
    return warpFuel(fs) + per * travelTime(fs.accel, toP.a);
  }

  // ---------- что даёт гекс за один съём ----------
  // Без генератора колония жжёт только водород (Colony.step: burnH2) — тритий и антиматерия для
  // цели «энергия» тогда ничего не стоят, сканер их не засчитывает.
  const weight = (target, gen) => target === 'e' && !gen ? (k => k === 'hydrogen' ? 1 : 0) : ROUTE_TARGETS[target].w;
  function hexYield(hex, target, gen = true) {
    const out = Colony.shipOutput(hex), w = weight(target, gen);
    let vol = 0, mass = 0, tgt = 0;
    for (const k in out) { vol += out[k] * Colony.volOf(k); mass += out[k] * Colony.massOf(k); tgt += out[k] * w(k); }
    return { out, vol, mass, tgt, h2: out.hydrogen || 0 };
  }

  // ---------- оценка одного рейса ----------
  // Трюм пустой (корабль выгрузился у колонии), жизнеобеспечение полное (заряжено пищей колонии),
  // бак полный (заправлен со склада колонии, Ship.refuel). Сколько съёмов n влезет:
  //   по трюму — пока масса добычи не забьёт трюм (последний съём режется долей, как в harvest);
  //   по пище  — экипаж ест такт за тактом, на обратную дорогу и час запаса должно остаться;
  //   по сроку — не больше суток на месте (ROUTE.MAX_TICKS).
  // Цена рейса: 100 водорода за съём (Ship.HARVEST_H2) — переводится в единицы цели и вычитается
  // из привезённого; водород, которого гекс не даёт сам, корабль везёт от колонии.
  // Полёт ГРУЖЁНЫЙ: туда корабль везёт водород на съёмы, обратно — всю добычу. Масса груза
  // снижает разгон (Ship.loaded: ускорение и запас Δv × корпус / (корпус + груз)), поэтому
  // тяжёлая добыча — сверхплотные, битумы — возвращается заметно дольше, чем лёгкий водород.
  const kOf = (hull, t) => hull > 0 ? hull / (hull + Math.max(0, t)) : 1;
  function legs(fs, home, dest, hull) {
    const warp = dest.star.id !== home.star.id;
    const out = t => legSec(Ship.loaded(fs, kOf(hull, t)), home.star.id, home.planet, dest.star.id, dest.planet);
    const back = t => legSec(Ship.loaded(fs, kOf(hull, t)), dest.star.id, dest.planet, home.star.id, home.planet);
    const fOut = t => legFuel(Ship.loaded(fs, kOf(hull, t)), home.star.id, home.planet, dest.star.id, dest.planet);
    const fBack = t => legFuel(Ship.loaded(fs, kOf(hull, t)), dest.star.id, dest.planet, home.star.id, home.planet);
    return { out, back, fOut, fBack, warp, hull, fs, tOut: out(0), tBack: back(0) };
  }
  function estimate(tbl, ship, st, fs, L, hex, target, gen = true) {
    const y = hexYield(hex, target, gen);
    if (y.vol <= 0 || y.tgt <= 0) return null;
    if (!isFinite(L.tOut) || !isFinite(L.tBack)) return null;
    const life = Math.floor(Ship.lifeCap(tbl, st) / (Ship.crew(ship) * COL.FOOD_PER_POP));
    const selfFuel = y.h2 >= H2();
    // Водород на съёмы, которого гекс не даёт, лежит в трюме и занимает место (объём 1).
    const carryPer = selfFuel ? 0 : H2() - y.h2;
    const byCargo = Math.max(1, Math.ceil((st.capacity - H2()) / (y.vol + carryPer * Colony.volOf('hydrogen'))));
    // Два прохода: сперва полёт порожним, потом — с массой того, что реально повезём.
    let n = 0, tOut = L.tOut, tBack = L.tBack, byLife = 0, fill = 1;
    for (let pass = 0; pass < 2; pass++) {
      const flightTicks = Math.ceil((tOut + tBack) / (TICK / 1000));
      byLife = life - flightTicks - ROUTE.LIFE_SPARE;
      if (byLife < 1) return { err: 'не хватит жизнеобеспечения' };
      n = Math.min(byCargo, byLife, ROUTE.MAX_TICKS);
      fill = Math.min(1, st.capacity / (n * y.vol));       // последний съём режется долей (по объёму)
      const h2Carry = selfFuel ? H2() : n * carryPer + H2();
      tOut = L.out(h2Carry * Colony.massOf('hydrogen'));
      tBack = L.back(n * y.mass * fill);
      if (!isFinite(tOut) || !isFinite(tBack)) return { err: 'гружёный не взлетит' };
    }
    // ТОПЛИВО РЕЙСА (решение пользователя: заправка не бесплатна — из трюма или со склада колонии).
    // Туда летит с водородом на съёмы, обратно — с добычей. На месте бак доливается из трюма тем
    // топливом, что дал гекс (у шаттла — тритий); остальное колония отдаёт со склада. Сжечь больше
    // бака за один перелёт нельзя.
    const fOut = L.fOut((selfFuel ? H2() : n * carryPer + H2()) * Colony.massOf('hydrogen'));
    const fBack = L.fBack(n * y.mass * fill);
    if (fOut > 1) return { err: 'не хватит бака на перелёт туда' };
    if (fBack > 1) return { err: 'не хватит бака на обратный перелёт с грузом' };
    const tank = Ship.tankOf(ship);
    const fuelBurn = tank ? (fOut + fBack) * tank.units : 0;                  // единиц топлива за рейс
    const fuelHere = tank ? n * (y.out[tank.key] || 0) * fill : 0;           // гекс сам даёт топливо
    const fromHold = tank ? Math.min(fuelHere, fOut * tank.units) : 0;       // долив на месте
    // Сколько бака должно быть при вылете: туда + обратно минус то, что дольёт гекс.
    const fuelNeed = tank ? Math.max(fOut, fOut + fBack - fuelHere / tank.units) : 0;
    const gross = n * y.tgt * fill;
    const h2Cost = n * H2();
    // В единицах цели: водород на съёмы и сожжённое топливо (из трюма — минус к привезённому,
    // со склада — расход колонии; со склада своим кораблям бесплатно, но склад-то пустеет).
    const cost = h2Cost * weight(target, gen)('hydrogen') + (tank ? fuelBurn * weight(target, gen)(tank.key) : 0);
    const net = gross - cost;
    const sec = tOut + tBack + n * TICK / 1000;
    const goods = {};
    for (const k in y.out) goods[k] = y.out[k] * n * fill;
    goods.hydrogen = Math.max(0, (goods.hydrogen || 0) - h2Cost);
    if (!goods.hydrogen) delete goods.hydrogen;
    if (tank) { goods[tank.key] = Math.max(0, (goods[tank.key] || 0) - fromHold); if (!goods[tank.key]) delete goods[tank.key]; }
    return { n, tOut, tBack, fOut, fBack, fuelBurn, fuelNeed, fuelKey: tank && tank.key, sec, gross, net, perHour: net / (sec / 3600), goods,
      h2Need: selfFuel ? H2() : Math.ceil(n * carryPer) + H2(), selfFuel, byCargo, byLife };
  }

  // ---------- СКАНЕР ----------
  // Своя система и ближайшие звёзды; на каждой планете — лучший гекс под цель. Итог по убыванию
  // чистой выгоды в час: то, что колония получит за час рейса за вычетом водорода на съёмы.
  const geoOf = (hs, hp, ds, dp) => ({ hs: hs.id, hp: { index: hp.index, a: hp.a }, ds: ds.id, dp: { index: dp.index, a: dp.a } });
  function nearStars(gal, home) {
    return gal.stars.filter(s => s.id !== home.id)
      .map(s => ({ s, d: Math.hypot(s.x - home.x, s.y - home.y) }))
      .filter(x => x.d <= ROUTE.KPC)
      .sort((a, b) => a.d - b.d).slice(0, ROUTE.STARS);
  }
  // Кэш скана: мир неподвижен (seed), оценка считается для пустого трюма и полного
  // жизнеобеспечения — значит для той же колонии, цели, корабля и таблицы она одна и та же.
  // Без кэша колония с авторейсом пересканировала 40 планет после каждого рейса.
  const scanCache = new WeakMap();
  function scan(tbl, ship, homeRef, target, env) {
    const hcol = env.colony(homeRef.star, homeRef.planet);
    const key = [homeRef.star, homeRef.planet, target, target === 'need' && hcol ? JSON.stringify(Colony.needs(hcol).def) : '', !!(hcol && Colony.has(hcol, 'gen')), ship.design, Ship.crew(ship),
      FUEL.hydrogen.yield, FUEL.tritium.yield, FUEL.antimatter.yield].join('|');
    let byTbl = scanCache.get(tbl);
    if (!byTbl) scanCache.set(tbl, byTbl = new Map());
    if (byTbl.has(key)) return byTbl.get(key).map(x => Object.assign({}, x));
    const rows = scanRaw(tbl, ship, homeRef, target, env);
    if (byTbl.size > 64) byTbl.clear();
    byTbl.set(key, rows);
    return rows.map(x => Object.assign({}, x));
  }
  function scanRaw(tbl, ship, homeRef, target, env) {
    const gal = env.galaxy();
    const hs = gal.stars[homeRef.star];
    const hp = generateSystem(hs).planets[homeRef.planet];
    const st = Ship.stats(tbl, ship), fs = fly(ship);
    const home = { star: hs, planet: hp };
    const hc = env.colony(homeRef.star, homeRef.planet), gen = !!(hc && Colony.has(hc, 'gen'));
    if (target === 'need' && hc) ROUTE_NEED_W = Colony.needs(hc).w;
    const out = [];
    // Путевой лист (цель 'need') — по планетам СВОЕЙ системы: между ними секунды, а скачок с грузом — часы.
    const stars = [{ s: hs, d: 0 }].concat(target === 'need' ? [] : nearStars(gal, hs));
    for (const { s, d } of stars) {
      const sys = generateSystem(s);
      for (const p of sys.planets) {
        if (!PLANET_TYPES[p.type].landable) continue;
        const surf = env.surface(s.id, p.index);
        if (!surf) continue;
        const L = legs(fs, home, { star: s, planet: p }, st.mass);
        let best = null;
        for (const h of surf.hexes) {
          const e = estimate(tbl, ship, st, fs, L, h, target, gen);
          if (!e || e.err) { if (e && e.err && !best) best = { err: e.err, hex: h }; continue; }
          if (!best || best.err || e.perHour > best.perHour) best = Object.assign(e, { hex: h });
        }
        if (!best) continue;
        out.push(Object.assign(best, { geo: geoOf(hs, hp, s, p), hull: st.mass, star: s.id, planet: p.index, q: best.hex.q, r: best.hex.r,
          name: p.name, sysName: s.name, kpc: d, home: s.id === hs.id && p.index === hp.index,
          gas: !!PLANET_TYPES[p.type].lowOrbit }));
        delete best.hex;
      }
    }
    return out.sort((a, b) => (a.err ? 1 : 0) - (b.err ? 1 : 0) || (b.perHour || 0) - (a.perHour || 0));
  }
  const best = (tbl, ship, home, target, env) => scan(tbl, ship, home, target, env).find(x => !x.err && x.net > 0) || null;

  // ---------- подготовка к вылету у колонии ----------
  // Выгрузить трюм, зарядить жизнеобеспечение, заправиться, взять водород на съёмы — только из
  // ИЗЛИШКА колонии: бронь энергоносителей (Colony.h2Reserve) не трогаем, на ней стоят здания.
  function prepare(tbl, ship, col, pick) {
    if (pick.multi) pick.need = Colony.needs(col);      // путевой лист: снимок нужд на этот вылет
    // Что не влезло на склад даже после выброса ненужного — выбрасывается со счётом в отходах
    // колонии (col.waste), а не возвращается в трюме: иначе корабль кружил бы туда-обратно с тем
    // же грузом (прогон: сотни «рейсов» за сутки).
    Ship.unload(ship, col, true);
    Ship.recharge(tbl, ship, col);
    // Пищи в жизнеобеспечении — хотя бы на 6 съёмов, обратную дорогу и запас. Иначе корабль снимает
    // один гекс и разворачивается — и так сотни пустых рейсов (прогон: рейс каждые 10 минут, тритий
    // со склада уходил впустую).
    const stL = Ship.stats(tbl, ship);
    const backT = Math.ceil((pick.tBack || 0) / (TICK / 1000)), outT = Math.ceil((pick.tOut || 0) / (TICK / 1000));
    if (Ship.lifeTicks(tbl, ship, stL) < outT + backT + ROUTE.LIFE_SPARE + 6) return 'мало пищи на жизнеобеспечение — фермы колонии наработают';
    // Бак — со склада колонии (своему кораблю бесплатно, но склад расходуется) и из трюма.
    Ship.refuel(ship, col);
    if ((pick.fuelNeed || 0) > (typeof ship.fuel === 'number' ? ship.fuel : 1) + 1e-9) {
      const T = Ship.tankOf(ship);
      return 'мало топлива: нужно ' + Math.round(pick.fuelNeed * 100) + ' % бака, есть ' + Math.round((ship.fuel || 0) * 100)
        + ' % — на складе нет ' + (T && FUEL[T.key] ? FUEL[T.key].name.toLowerCase() : 'топлива');
    }
    const have = (ship.cargo || {}).hydrogen || 0;
    // Путевой лист — много стоянок: водорода на съёмы берём с запасом (до 20 съёмов), если он есть.
    const want = Math.max(0, (ship.route && ship.route.target === 'need' || pick.multi ? Math.max(pick.h2Need, 20 * H2()) : pick.h2Need) - have);
    const spare = Math.max(0, (col.stock.hydrogen || 0) - Colony.h2Reserve(col));
    if (want > 0 && spare > 0) Ship.load(tbl, ship, col, 'hydrogen', Math.min(want, spare));
    // На ПЕРВЫЙ съём можно взять и из брони: корабль привезёт в десятки раз больше, а без этого
    // колония, у которой водород на исходе, не смогла бы за ним послать.
    const h = (ship.cargo || {}).hydrogen || 0;
    if (h < H2()) Ship.load(tbl, ship, col, 'hydrogen', H2() - h);
    if (((ship.cargo || {}).hydrogen || 0) < H2()) return 'нет водорода на первый съём (нужно ' + H2() + ' сверх брони колонии)';
    return null;
  }
  function depart(ship, pick, now, r) {
    Object.assign(r, { dest: { star: pick.star, planet: pick.planet, q: pick.q, r: pick.r, name: pick.name, sysName: pick.sysName },
      plan: { n: pick.n, net: pick.net, perHour: pick.perHour, tOut: pick.tOut, tBack: pick.tBack, fOut: pick.fOut || 0, fBack: pick.fBack || 0 },
      geo: pick.geo || null, hull: pick.hull || 0,
      phase: 'out', t0: now, until: now + pick.tOut * 1000, mined: 0, sheet: [], ticks0: Colony.tickAt(now),
      need: r.target === 'need' && pick.need ? pick.need : null });
    ship.mine = null; ship.landed = false; ship.planet = null;
  }

  // ---------- запуск и снятие ----------
  // pick — строка сканера (полёт туда, куда выбрал игрок) или null — «лучшая, сама выбирает»:
  // тогда после каждого рейса колония сканирует заново и может сменить цель.
  function start(tbl, ship, col, target, pick, now, env) {
    if (!Ship.hasMiner(ship)) return 'нет модуля «Шахтёр»';
    if (!(fly(ship).accel > 0)) return 'у корабля нет двигателей';
    if (!(ship.landed && ship.star === col.star && ship.planet === col.planet)) return 'корабль должен стоять у колонии';
    const home = { star: col.star, planet: col.planet };
    const p = pick || best(tbl, ship, home, target, env);
    if (!p) return 'сканер не нашёл рентабельной планеты';
    if (p.err) return p.err;
    if (target === 'need') p.multi = true;
    const err = prepare(tbl, ship, col, p); if (err) return err;
    ship.route = { home, target, auto: !pick, stop: false, trips: 0, last: null, sheet: [] };
    depart(ship, p, now, ship.route);
    Colony.note(col, 'Авторейс: ' + shipLabel(ship) + ' → ' + p.name + ' за «' + ROUTE_TARGETS[target].name.toLowerCase() + '»');
    env.placed(ship);
    return null;
  }
  // Снять с рейса: корабль доделывает текущий заход, возвращается к колонии, выгружается и
  // встаёт. Бросить его посреди пустоты нельзя — он не на чём не стоит.
  function stop(ship, now) {
    const r = ship.route; if (!r) return;
    r.stop = true;
    if (r.phase === 'mine') leave(ship, now);
    if (r.phase === 'idle') ship.route = null;
  }

  const shipLabel = s => (s.design || 'корабль') + ' #' + s.id;
  // Обратная дорога считается по НАСТОЯЩЕЙ массе трюма в момент отлёта, а не по плану
  // (r.geo — орбиты и звёзды рейса, r.hull — масса корпуса; хранятся в рейсе, он сохраняется).
  function leave(ship, T) {
    const r = ship.route;
    let back = r.plan.tBack || 0;
    if (r.geo && r.hull > 0) {
      const g = r.geo, t = legSec(Ship.loaded(fly(ship), kOf(r.hull, Ship.cargoMass(ship))), g.ds, g.dp, g.hs, g.hp);
      if (isFinite(t)) back = t;
    }
    // Перед отлётом бак доливается из трюма — тем топливом, что дал гекс.
    Ship.refuel(ship, null);
    r.fBackNow = r.plan.fBack || 0;
    if (r.geo && r.hull > 0) {
      const g = r.geo, f = legFuel(Ship.loaded(fly(ship), kOf(r.hull, Ship.cargoMass(ship))), g.ds, g.dp, g.hs, g.hp);
      if (isFinite(f)) r.fBackNow = f;
    }
    ship.mine = null; ship.landed = false; ship.planet = null;
    r.phase = 'back'; r.until = T + back * 1000;
  }

  // Сжечь долю бака; ниже нуля не уходит (дотянул на остатке — ДОПУЩЕНИЕ: в рейс не выпускаем,
  // если бака не хватает, см. prepare/fuelNeed).
  function burnFuel(ship, frac) {
    if (!(frac > 0) || !Ship.tankOf(ship)) return;
    ship.fuel = Math.max(0, (typeof ship.fuel === 'number' ? ship.fuel : 1) - frac);
  }

  // ---------- ПУТЕВОЙ ЛИСТ: облёт планет системы по нуждам колонии ----------
  // Решение пользователя: «научить шаттл летать по планетам системы и собирать нужные ресурсы для
  // колонии с разных планет, а не только энергоносители: выгоднее летать по разным планетам, собирая
  // гексы, чем сидеть на одной; колония формирует путевой лист при каждом вылете по своим нуждам».
  // На каждой стоянке: съём лучшего по нуждам свободного гекса (журнал гексов) → долив бака из трюма →
  // следующая планета системы, где корабль в этом такте ещё не брал (журнал корабля), — по ценности
  // нужного на секунду полёта. Свободных нет — ждёт такта на месте. Домой — когда трюм почти полон,
  // нужды закрыты, кончается пища, не хватает бака или прошли сутки (ROUTE.MAX_TICKS).
  // НУЖДЫ — СНИМОК ПРИ ВЫЛЕТЕ (r.need), в пути корабль с колонией не сверяется (решение пользователя:
  // «пока корабль на маршруте, он не сверяется с текущими реальными нуждами, как бы выполняя первое
  // задание — это снизит нагрузку на серверы при большом числе кораблей»). Остаток нужд = снимок
  // минус то, что уже в трюме.
  function remainingW(r, ship) {
    const N = r.need; if (!N) return { w: {}, done: true };
    const left = Object.assign({}, N.def), w = {};
    for (const k in ship.cargo || {}) { const g = COL_KEY_GROUP[k]; if (g && left[g] != null) left[g] -= ship.cargo[k]; }
    for (const g in COL_GROUPS) COL_GROUPS[g].forEach(k => { w[k] = left[g] > 0 ? N.w[k] : Math.min(N.w[k], 0.02 + (N.w[k] >= 2 ? 2 : 0)); });
    return { w, done: Object.values(left).every(v => v <= 0) };
  }
  function hexValue(hex, w) {
    const o = Colony.shipOutput(hex);
    let v = 0; for (const k in o) v += o[k] * (w[k] || 0);
    return v;
  }
  function bestHexAt(star, planet, surf, w, T) {
    let best = null, bv = 0;
    for (const h of surf.hexes) {
      if (!Ship.harvestReady({ hv: {} }, star, planet, h, T)) continue;    // гекс свободен в журнале гексов
      const v = hexValue(h, w); if (v > bv) { bv = v; best = h; }
    }
    return best ? { hex: best, v: bv } : null;
  }
  // Съём на текущей стоянке (по нуждам) и запись в путевой лист.
  function harvestHere(tbl, ship, T, env) {
    const r = ship.route, col = env.colony(r.home.star, r.home.planet);
    const surf = env.surface(ship.star, ship.planet); if (!surf) return null;
    if (!Ship.harvestReady(ship, ship.star, ship.planet, null, T)) return { wait: true };
    const W = remainingW(r, ship).w;
    const b = bestHexAt(ship.star, ship.planet, surf, W, T); if (!b) return { none: true };
    const got = Ship.harvest(tbl, ship, b.hex, ship.star, ship.planet, T);
    if (!got.err) {
      Ship.refuel(ship, null);                                   // бак — из трюма, тем, что дал гекс
      r.sheet.push({ name: r.dest.name, q: b.hex.q, r: b.hex.r, t: T, vol: Math.round(got.total || 0) });
      if (r.sheet.length > 40) r.sheet.shift();
    }
    return got;
  }
  function decideNext(tbl, ship, T, env) {
    const r = ship.route, col = env.colony(r.home.star, r.home.planet);
    const st = Ship.stats(tbl, ship), fs = fly(ship), gs = env.galaxy().stars[r.home.star];
    const sys = generateSystem(gs), hp = sys.planets[r.home.planet], cur = sys.planets[ship.planet];
    const k = kOf(st.mass, Ship.cargoMass(ship)), fsL = Ship.loaded(fs, k);
    const backSec = legSec(fsL, gs.id, cur, gs.id, hp), backF = legFuel(fsL, gs.id, cur, gs.id, hp);
    const backT = Math.ceil(backSec / (TICK / 1000));
    const R = remainingW(r, ship);
    const tired = Ship.lifeTicks(tbl, ship, st) <= backT + ROUTE.LIFE_SPARE;
    const full = Ship.cargoFree(tbl, ship, st) < 0.1 * st.capacity;
    const long = Colony.tickAt(T) - (r.ticks0 || Colony.tickAt(T)) >= ROUTE.MAX_TICKS;
    const noH2 = ((ship.cargo || {}).hydrogen || 0) < H2();
    r.geo = geoOf(gs, hp, gs, cur); r.hull = st.mass;
    r.plan.tBack = backSec; r.plan.fBack = backF;
    if (r.stop || full || R.done || tired || long || noH2) { r.why = r.stop ? 'снят' : full ? 'трюм' : R.done ? 'нужды закрыты' : tired ? 'пища' : long ? 'сутки' : 'водород'; leave(ship, T); return; }
    // Следующая стоянка: где в этом такте ещё не брали; ценность нужного / (секунды полёта + 10).
    let best = null;
    for (const p of sys.planets) {
      if (p.index === cur.index || !PLANET_TYPES[p.type].landable) continue;
      if (!Ship.harvestReady(ship, gs.id, p.index, null, T)) continue;
      const surf = env.surface(gs.id, p.index); if (!surf) continue;
      const b = bestHexAt(gs.id, p.index, surf, R.w, T); if (!b || b.v <= 0) continue;
      const sec = legSec(fsL, gs.id, cur, gs.id, p), f = legFuel(fsL, gs.id, cur, gs.id, p) + legFuel(fsL, gs.id, p, gs.id, hp);
      if (!isFinite(sec) || f > (typeof ship.fuel === 'number' ? ship.fuel : 1) + 1e-9) continue;
      const score = b.v / (sec + 10);
      if (!best || score > best.score) best = { p, sec, f: legFuel(fsL, gs.id, cur, gs.id, p), score };
    }
    if (best) {
      r.dest = { star: gs.id, planet: best.p.index, q: null, r: null, name: best.p.name, sysName: gs.name };
      r.phase = 'hop'; r.until = T + best.sec * 1000; r.hopFuel = best.f;
      ship.mine = null; ship.landed = false; ship.planet = null;
      return;
    }
    // Свободных планет в этом такте нет — ждать такта здесь (журналы сбросятся), если тут есть что брать.
    const here = env.surface(gs.id, cur.index), hb = here && bestHexAt(gs.id, cur.index, here, R.w, (Colony.tickAt(T) + 1) * TICK);
    if (hb && hb.v > 0) { r.phase = 'wait'; r.next = (Colony.tickAt(T) + 1) * TICK; return; }
    r.why = 'нечего брать'; leave(ship, T);
  }

  // ---------- РЕЙС СНАБЖЕНИЯ (ТЗ §8.31) ----------
  // Две работы одним рейсом: ОСНОВАТЬ субколонию (везём жителей и сырьё) и ВЫВЕЗТИ накопленное
  // у уже стоящих. Съёма гексов здесь нет — только погрузка у колонии и выгрузка дома, поэтому
  // ветка своя, а время и топливо считаются теми же legSec/legFuel, что у обычного рейса.
  // Слова пользователя: «кораблю нужно будет периодически туда залетать, чтоб забрать накопленное».
  function supLeg(tbl, ship, fromStar, fromP, toStar, toP) {
    const st = Ship.stats(tbl, ship), fsL = Ship.loaded(fly(ship), kOf(st.mass, Ship.cargoMass(ship)));
    return { sec: legSec(fsL, fromStar, fromP, toStar, toP), fuel: legFuel(fsL, fromStar, fromP, toStar, toP) };
  }
  // Оборот «туда-обратно» в ТАКТАХ — им subPlan проверяет, успеет ли флот вывозить.
  // Принимает НОМЕРА планет и окружение — вызывающему не нужно знать про объекты системы.
  function supRound(tbl, ship, env, starId, fromIdx, toIdx) {
    const sys = generateSystem(env.galaxy().stars[starId]);
    const a = sys.planets[fromIdx], b = sys.planets[toIdx];
    if (!a || !b) return Infinity;
    const leg = supLeg(tbl, ship, starId, a, starId, b);
    return isFinite(leg.sec) ? Math.ceil(2 * leg.sec / (TICK / 1000)) : Infinity;
  }
  // Запустить рейс снабжения. plan — от Colony.subPlan (основать) или {pickup:true, star, planet}.
  function startSupply(tbl, ship, col, plan, now, env) {
    let r0give = null;
    if (!(fly(ship).accel > 0)) return 'у корабля нет двигателей';
    if (!(ship.landed && ship.star === col.star && ship.planet === col.planet)) return 'корабль должен стоять у колонии';
    const gs = env.galaxy().stars[col.star], sys = generateSystem(gs);
    const hp = sys.planets[col.planet], tp = sys.planets[plan.planet];
    if (!tp) return 'планета не найдена';
    const out = supLeg(tbl, ship, gs.id, hp, gs.id, tp);
    if (!isFinite(out.sec)) return 'маршрут не проложен';
    const stL = Ship.stats(tbl, ship);
    const need = Math.ceil(2 * out.sec / (TICK / 1000)) + ROUTE.LIFE_SPARE;
    // СПЕРВА РАЗГРУЗИТЬСЯ: трюм занят своей добычей, и подвоз снабженцу в него не влезет.
    Ship.unload(ship, col, true);
    Ship.recharge(tbl, ship, col);
    if (Ship.lifeTicks(tbl, ship, stL) < need) return 'мало пищи на дорогу туда и обратно';
    Ship.refuel(ship, col);
    if (out.fuel * 2 > (typeof ship.fuel === 'number' ? ship.fuel : 1) + 1e-9) return 'мало топлива на оборот';
    // ОБМЕН (ТЗ §8.31): туда везём то, чего снабженцу не хватает на содержание, обратно —
    // накопленное им. Основание списывает своё по прилёте (Colony.foundSub).
    if (plan.pickup) {
      const sub = env.colony(col.star, plan.planet);
      if (sub) {
        const st2 = Ship.stats(tbl, ship);
        const give = Colony.subGrant(col, sub, Ship.cargoFree(tbl, ship, st2));
        for (const k in give) Ship.load(tbl, ship, col, k, give[k]);
        r0give = give;
      }
    }
    ship.route = { home: { star: col.star, planet: col.planet }, target: 'supply', sup: plan.pickup ? 'pickup' : 'found',
      stop: false, trips: 0, last: null, plan: { tOut: out.sec, tBack: out.sec, fOut: out.fuel, fBack: out.fuel },
      dest: { star: col.star, planet: plan.planet, name: plan.name || (tp && tp.name) },
      sub: plan, gave: r0give, phase: 'sup-out', t0: now, until: now + out.sec * 1000 };
    ship.mine = null; ship.landed = false; ship.planet = null;
    Colony.note(col, plan.pickup ? 'Рейс снабжения: ' + shipLabel(ship) + ' → ' + ship.route.dest.name + ' за накопленным'
      : 'Экспедиция: ' + shipLabel(ship) + ' → ' + ship.route.dest.name + ' основывать колонию-снабженец');
    env.placed(ship);
    return null;
  }
  // Прилёт к субколонии: основать или загрузиться. Возвращает true, если рейс продолжается.
  function supArrive(tbl, ship, T, env) {
    const r = ship.route;
    ship.star = r.dest.star; ship.planet = r.dest.planet; ship.landed = true;
    burnFuel(ship, r.plan.fOut);
    const surf = env.surface(r.dest.star, r.dest.planet);
    const home = env.colony(r.home.star, r.home.planet);
    if (!surf || !home) { r.phase = 'sup-back'; r.until = T + r.plan.tBack * 1000; return true; }
    if (r.sup === 'found') {
      const sub = Colony.foundSub(home, r.sub, surf, T);
      env.putColony(r.dest.star, r.dest.planet, sub);
      r.founded = true;
    } else {
      const sub = env.colony(r.dest.star, r.dest.planet);
      if (sub) {
        env.advanceColony(sub, r.dest.star, r.dest.planet, T);
        // СПЕРВА ОТДАЁМ ПОДВОЗ: содержание и пищу, ради чего и летели (обмен).
        if (r.gave) for (const k in r.gave) {
          const q = Math.min(r.gave[k], (ship.cargo || {})[k] || 0);
          if (q <= 0) continue;
          ship.cargo[k] -= q; if (ship.cargo[k] <= 1e-9) delete ship.cargo[k];
          Colony.store(sub, k, q);
        }
        // ЗАБИРАЕМ ИЗЛИШЕК субколонии — всё сверх её броней содержания, пищи и энергии.
        const give = Colony.subGive(sub);
        const st = Ship.stats(tbl, ship);
        for (const k in give) {
          const free = Ship.cargoFree(tbl, ship, st);
          if (free <= 0) break;
          const q = Math.min(give[k], free / Colony.volOf(k));
          if (q <= 0) continue;
          sub.stock[k] -= q; Colony.add(ship.cargo = ship.cargo || {}, k, q);
        }
        // БАЗА СОДЕРЖИТ СНАБЖЕНЦА: привозит крипту на жалованье — своего дохода у него нет
        // (майнинг-фермы ему не строят). Это и есть «снабжение» в обе стороны.
        const pay = Colony.subPay(home, sub, surf);
        if (pay > 0) { home.crypto -= pay; sub.crypto += pay; }
      }
    }
    r.phase = 'sup-back'; r.until = T + r.plan.tBack * 1000;
    ship.landed = false; ship.planet = null; ship.mine = null;
    return true;
  }
  // ---------- одно событие рейса ----------
  const nextAt = s => !s.route ? Infinity : (s.route.phase === 'mine' || s.route.phase === 'wait' || s.route.phase === 'idle') ? s.route.next : s.route.until;
  function step(tbl, ship, T, env) {
    const r = ship.route;
    if (r.phase === 'idle') {                                 // ждал у колонии — новый путевой лист
      const col = env.colony(r.home.star, r.home.planet);
      if (!col || r.stop) { ship.route = null; env.placed(ship); return; }
      env.advanceColony(col, r.home.star, r.home.planet, T);
      Ship.advance(tbl, ship, null, T);
      replan(tbl, ship, T, env, col);
      return;
    }
    if (r.sup) {                                            // рейс снабжения (ТЗ §8.31)
      Ship.advance(tbl, ship, null, T);                     // в полёте экипаж только ест
      if (r.phase === 'sup-out') { supArrive(tbl, ship, T, env); env.placed(ship); return; }
      // sup-back — домой: выгрузка на склад базы
      ship.star = r.home.star; ship.planet = r.home.planet; ship.landed = true;
      burnFuel(ship, r.plan.fBack);
      const col = env.colony(r.home.star, r.home.planet);
      if (!col) { ship.route = null; env.placed(ship); return; }
      env.advanceColony(col, r.home.star, r.home.planet, T);
      const goods = Object.assign({}, ship.cargo || {});
      const mass = Colony.massSum(goods);
      Ship.unload(ship, col, true);
      r.trips++;
      r.last = { t: T, from: r.dest.name, goods, brought: Colony.volSum(goods) };
      if (r.founded) Colony.note(col, 'Экспедиция вернулась с ' + r.dest.name);
      else Colony.note(col, 'Снабжение: привезено с ' + r.dest.name + ' ' + Math.round(mass).toLocaleString('ru') + ' т');
      ship.route = null;                                     // рейс снабжения — разовый
      env.placed(ship);
      return;
    }
    if (r.target === 'need' && (r.phase === 'out' || r.phase === 'hop' || r.phase === 'wait')) {
      Ship.advance(tbl, ship, null, T);                       // экипаж ест
      if (r.phase !== 'wait') {
        ship.star = r.dest.star; ship.planet = r.dest.planet; ship.landed = true;
        burnFuel(ship, r.phase === 'out' ? r.plan.fOut : r.hopFuel);
      }
      r.phase = 'mine-stop';
      const got = harvestHere(tbl, ship, T, env);
      if (got && got.err && got.err !== 'трюм полон') { /* гекс занят и т. п. — решаем дальше */ }
      decideNext(tbl, ship, T, env);
      env.placed(ship);
      return;
    }
    if (r.phase === 'out') {
      Ship.advance(tbl, ship, null, T);                       // в полёте экипаж только ест
      ship.star = r.dest.star; ship.planet = r.dest.planet; ship.landed = true;
      burnFuel(ship, r.plan.fOut);                              // перелёт туда
      const surf = env.surface(r.dest.star, r.dest.planet);
      const hex = surf && surf.hexes.find(h => h.q === r.dest.q && h.r === r.dest.r);
      if (!hex) { leave(ship, T); return; }
      // Первый съём — сразу по прилёту. Если в этом такте корабль на этой планете уже брал
      // (лимит один гекс на планету за такт — короткий рейс по своей же планете), ждёт следующего
      // такта, а не разворачивается: иначе рейс крутился бы на месте в одной и той же минуте.
      const ready = Ship.harvestReady(ship, r.dest.star, r.dest.planet, hex, T);
      const got = ready ? Ship.harvest(tbl, ship, hex, r.dest.star, r.dest.planet, T) : { wait: true };
      r.mined = got.err || got.wait ? 0 : 1;
      ship.mine = { q: hex.q, r: hex.r };
      r.phase = 'mine'; r.arr = T;
      r.next = (Colony.tickAt(T) + 1) * TICK;
      if (got.err || got.full) leave(ship, T);
      env.placed(ship);
      return;
    }
    if (r.phase === 'mine') {
      const surf = env.surface(r.dest.star, r.dest.planet);
      const res = Ship.advance(tbl, ship, surf, T);           // настоящий съём раз в такт
      r.mined += res.auto || 0;
      const st = Ship.stats(tbl, ship);
      const backTicks = Math.ceil((r.plan.tBack || 0) / (TICK / 1000));
      const tired = Ship.lifeTicks(tbl, ship, st) <= backTicks + ROUTE.LIFE_SPARE;
      // Трюм «забит», когда следующий съём целиком уже не влезает. Иначе в щель в 100 единиц корабль
      // копал бы вечно: съём кладёт 100, а 100 водорода на него же сгорают и освобождают место.
      const hex = surf && surf.hexes.find(h => h.q === r.dest.q && h.r === r.dest.r);
      const perVol = hex ? hexYield(hex, r.target).vol : 0;
      const full = Ship.cargoFree(tbl, ship, st) < Math.max(1, perVol - H2());
      if (!ship.mine || tired || r.stop || r.mined >= ROUTE.MAX_TICKS || full) leave(ship, T);
      else r.next += TICK;
      return;
    }
    // r.phase === 'back' — прилёт к колонии
    Ship.advance(tbl, ship, null, T);
    ship.star = r.home.star; ship.planet = r.home.planet; ship.landed = true;
    burnFuel(ship, r.fBackNow != null ? r.fBackNow : r.plan.fBack);  // перелёт обратно (с настоящим грузом)
    const col = env.colony(r.home.star, r.home.planet);
    if (!col) { ship.route = null; env.placed(ship); return; }
    env.advanceColony(col, r.home.star, r.home.planet, T);   // колония дожила до прилёта — потом выгрузка
    const goods = Object.assign({}, ship.cargo || {});
    const w = weight(r.target, Colony.has(col, 'gen'));
    const brought = Object.keys(goods).reduce((a, k) => a + goods[k] * w(k), 0);
    Ship.unload(ship, col, true);
    r.trips++;
    r.last = { t: T, from: r.dest.name, goods, brought };
    Colony.note(col, 'Авторейс #' + r.trips + ' с ' + r.dest.name + ': ' + Math.round(brought).toLocaleString('ru') + ' '
      + ROUTE_TARGETS[r.target].unit + ' (' + Math.round(Colony.massSum(goods)).toLocaleString('ru') + ' т груза)');
    if (r.stop) { ship.route = null; Colony.note(col, 'Авторейс снят: ' + shipLabel(ship) + ' у колонии'); env.placed(ship); return; }
    // Пустой путевой лист (ни одного съёма) — корабль остаётся у колонии: новый лист в ту же минуту дал
    // бы тот же пустой облёт (прогон: бесконечный цикл «вылет — возврат» в одну минуту).
    if (r.target === 'need' && !(r.sheet && r.sheet.length)) { idle(ship, T, col, 'путевой лист пуст'); env.placed(ship); return; }
    replan(tbl, ship, T, env, col);
  }
  // Путевой лист не выдать (нечего везти, мало пищи или топлива) — корабль ЖДЁТ у колонии час и
  // просит новый лист, а не снимается с рейса: нужды появятся, фермы наработают пищу.
  function idle(ship, T, col, why) {
    const r = ship.route;
    if (!r.idleNoted) Colony.note(col, shipLabel(ship) + ' ждёт у колонии: ' + why);
    r.idleNoted = true;
    r.phase = 'idle'; r.next = T + COL.UPKEEP_EVERY * TICK;
    ship.landed = true; ship.star = r.home.star; ship.planet = r.home.planet; ship.mine = null;
  }
  function replan(tbl, ship, T, env, col) {
    const r = ship.route;
    // Следующий заход: «сама выбирает» — сканируем заново, иначе туда же (оценку пересчитываем).
    const home = r.home;
    let pick = r.auto ? best(tbl, ship, home, r.target, env)
      : scan(tbl, ship, home, r.target, env).find(x => x.star === r.dest.star && x.planet === r.dest.planet) || null;
    if (pick && !r.auto) {
      // фиксированный рейс — на тот же гекс, а не на лучший гекс планеты
      const surf = env.surface(r.dest.star, r.dest.planet);
      const hex = surf && surf.hexes.find(h => h.q === r.dest.q && h.r === r.dest.r);
      const gs = env.galaxy().stars, hs = gs[home.star], ds = gs[r.dest.star], fs = fly(ship);
      const hp = generateSystem(hs).planets[home.planet], dp = generateSystem(ds).planets[r.dest.planet];
      const hull = Ship.stats(tbl, ship).mass;
      const L = legs(fs, { star: hs, planet: hp }, { star: ds, planet: dp }, hull);
      const e = hex && estimate(tbl, ship, Ship.stats(tbl, ship), fs, L, hex, r.target, Colony.has(col, 'gen'));
      pick = e && !e.err ? Object.assign(e, { geo: geoOf(hs, hp, ds, dp), hull, star: ds.id, planet: r.dest.planet, q: hex.q, r: hex.r, name: r.dest.name, sysName: r.dest.sysName }) : null;
    }
    if (pick && r.target === 'need') pick.multi = true;     // новый путевой лист — новый снимок нужд
    if (!pick || pick.err || !(pick.net > 0)) {
      if (r.target === 'need') { idle(ship, T, col, 'нечего везти'); env.placed(ship); return; }
      ship.route = null; Colony.note(col, 'Авторейс остановлен: нет рентабельной цели'); env.placed(ship); return;
    }
    const err = prepare(tbl, ship, col, pick);
    if (err) {
      if (r.target === 'need') { idle(ship, T, col, err); env.placed(ship); return; }
      ship.route = null; Colony.note(col, 'Авторейс остановлен: ' + err); env.placed(ship); return;
    }
    r.idleNoted = false;
    depart(ship, pick, T, r);
    env.placed(ship);
  }

  // ---------- догнать время для всего флота ----------
  // События всех кораблей идут ПО ПОРЯДКУ времени: прилёт к колонии сперва доводит колонию до этой
  // минуты и только потом выгружает, поэтому порядок кораблей ничего не меняет.
  function tick(tbl, ships, now, env) {
    if (!tbl) return 0;
    let n = 0;
    for (;;) {
      let s = null, t = Infinity;
      for (const x of ships) { const a = nextAt(x); if (a < t) { t = a; s = x; } }
      if (!s || t > now || n++ > ROUTE.MAX_EVENTS) break;
      step(tbl, s, t, env);
    }
    return n;
  }

  // Строка для интерфейса: где корабль и когда следующее событие.
  function status(ship, now) {
    const r = ship.route; if (!r) return null;
    const left = s => { s = Math.max(0, Math.round(s)); return s < 90 ? s + ' с' : s < 5400 ? Math.round(s / 60) + ' мин' : (s / 3600).toFixed(1).replace('.', ',') + ' ч'; };
    if (r.target === 'need') {
      const n = (r.sheet || []).length;
      if (r.phase === 'back') return 'путевой лист: ' + n + ' съёмов, возвращается' + (r.why ? ' (' + r.why + ')' : '') + ' · через ' + left((r.until - now) / 1000);
      if (r.phase === 'wait') return 'путевой лист: ' + n + ' съёмов, ждёт такта на ' + (r.dest && r.dest.name);
      if (r.phase === 'idle') return 'ждёт у колонии новый путевой лист · через ' + left((r.next - now) / 1000);
      return 'путевой лист: ' + n + ' съёмов, летит к ' + (r.dest && r.dest.name) + ' · через ' + left((r.until - now) / 1000);
    }
    if (r.phase === 'out') return 'летит к ' + r.dest.name + ' · прилёт через ' + left((r.until - now) / 1000);
    if (r.phase === 'mine') return 'копает на ' + r.dest.name + ' (гекс ' + r.dest.q + ', ' + r.dest.r + ') · съёмов ' + r.mined
      + ' из ~' + r.plan.n + (r.stop ? ' · снят, возвращается' : '');
    return 'возвращается с ' + r.dest.name + ' · через ' + left((r.until - now) / 1000) + (r.stop ? ' · рейс будет снят' : '');
  }

  // ---------- окружение браузера ----------
  // Поверхности не хранятся — пересоздаются из seed и кэшируются (как в heartbeat.js).
  const surfCache = {};
  function surfaceOf(star, planet) {
    const k = star + ':' + planet;
    if (surfCache[k] !== undefined) return Colony.terraSurf(surfCache[k], World.colony(star, planet));
    const gs = World.galaxy().stars[star];
    const p = gs && generateSystem(gs).planets[planet];
    surfCache[k] = p ? generateSurface(p, gs) : null;
    return Colony.terraSurf(surfCache[k], World.colony(star, planet));   // посев терраформирования
  }
  const browserEnv = () => ({
    galaxy: () => World.galaxy(),
    surface: surfaceOf,
    colony: (star, planet) => World.colony(star, planet),
    advanceColony: (col, star, planet, t) => { const s = surfaceOf(star, planet); if (s) Colony.advance(col, s, t); },
    // Активный корабль — он же «корабль игрока» на экранах системы и галактики: держим их
    // положение в согласии с флотом, иначе после рейса экран посадит его туда, где он был до вылета.
    placed: ship => { if (World.activeId() === ship.id) World.setActive(ship.id); },
  });
  const tickWorld = (tbl, now) => tick(tbl, World.fleet(), now, browserEnv());

  // ---------- заслон на экранах системы и галактики ----------
  // Корабль в рейсе ведёт колония — вручную его не водят (ни щелчком по карте, ни скачком).
  // Пока активен такой корабль, экран показывает, где он, и предлагает колонию, снятие с рейса
  // или другой корабль флота. Рейс кончился — страница перезагружается и корабль снова в руках.
  function guard() {
    const ship = World.active();
    let el = document.getElementById('route-guard');
    if (!ship.route) { if (el) location.reload(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'route-guard';
      el.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;'
        + 'background:rgba(4,6,12,.62);font:14px system-ui,sans-serif;color:#dfe6f2';
      document.body.appendChild(el);
      el.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        const s = World.active();
        if (b.dataset.g === 'colony') location.href = World.planetUrl(s.route ? s.route.home.star : s.star, s.route ? s.route.home.planet : s.planet);
        if (b.dataset.g === 'stop') { stop(s, Date.now()); World.save(); guard(); }
        if (b.dataset.g === 'pick') { const o = World.fleet().find(x => x.id === +b.dataset.id); if (o) { World.setActive(o.id); location.href = Notify.shipUrl(o); } }
      });
    }
    const others = World.fleet().filter(x => x.id !== ship.id && !x.route);
    const btn = 'style="margin:4px;padding:8px 14px;border-radius:8px;border:1px solid #3a4a66;background:#16203a;color:#dfe6f2;cursor:pointer"';
    el.innerHTML = '<div style="max-width:440px;padding:18px 20px;border-radius:12px;background:#0d1424;border:1px solid #2a3858">'
      + '<div style="font-weight:600;margin-bottom:6px">' + shipLabel(ship) + ' в авторейсе</div>'
      + '<div style="opacity:.85;margin-bottom:12px">' + status(ship, Date.now()) + '. Корабль ведёт колония — вручную им сейчас не управлять.</div>'
      + '<button data-g="colony" ' + btn + '>К колонии</button>'
      + (ship.route.stop ? '' : '<button data-g="stop" ' + btn + '>Снять с рейса</button>')
      + others.map(o => '<button data-g="pick" data-id="' + o.id + '" ' + btn + '>Взять ' + shipLabel(o) + '</button>').join('')
      + '</div>';
  }

  return { ROUTE, scan, best, estimate, start, stop, tick, tickWorld, status, guard, legSec, legFuel, hexYield, nextAt,
    startSupply, supRound };
})();
