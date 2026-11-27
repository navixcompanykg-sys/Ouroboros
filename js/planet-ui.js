// Панель колонии и флота на экране планеты.
//
// ОРГАНИЗАЦИЯ МЕНЮ — КАК В V2 (`client/planet.html`, требование пользователя): наверху строка
// разделов, ниже один раздел за раз; у склада — полоса вместимости и «⇄ Перегрузка», у стройки —
// список построек и модалка с ценой, описанием и кнопкой «Построить».
//   КОРАБЛЬ · СКЛАД · СТРОИТЕЛЬСТВО · ВЕРФЬ · ФЛОТ
//
// Расчёт колонии и корабля — в js/colony.js (общие числа с tools/colony.js), здесь только
// интерфейс. Карту рисует js/planet.js, он же даёт выбранный гекс через PlanetUI.init.
const PlanetUI = (() => {
  const $ = id => document.getElementById(id);
  let tbl = null, col = null, ctxRef = null, view = 'ship', modal = null, lowOrbit = false;
  let rTarget = 'need', rScan = null;   // раздел «Рейсы»: цель и последний скан (кэш на 10 с)

  const VIEWS = [['ship', 'Корабль'], ['wh', 'Склад'], ['build', 'Строительство'],
    ['prod', 'Производство'], ['route', 'Рейсы'], ['yard', 'Верфь'], ['fleet', 'Флот']];

  async function init(c) {
    ctxRef = c;
    lowOrbit = !!(PLANET_TYPES[ctxRef.planet.type] || {}).lowOrbit;
    const got = await Store.load('parts');
    tbl = loadParts(got.data);
    // «постройка = два трюма»: размер трюма берём из таблицы пользователя, а не из головы
    Colony.setHoldUnit(partParam(tbl, 'cargo', 'capSolid', 1) + partParam(tbl, 'cargo', 'capGas', 1));
    Colony.setMasses(tbl);   // трюм и склад меряются массой
    // Расценки зданий ведёт пользователь (prices.html → data/prices.json).
    Store.load('prices').then(r => Colony.setPrices(r.data));
    col = World.colony(ctxRef.gstar.id, ctxRef.planet.index);
    Ship.ensureStart(World.active());
    // СТАРТОВАЯ КОЛОНИЯ (решение пользователя: «это как бы его стартовая колония»). На планете,
    // где игрок начал, колония уже стоит: купол, генератор, ферма и 10 000 силикатов на первую
    // шахту. Высаживать никого не надо — игрок приходит в готовое хозяйство.
    if (!col && !World.colonyList().length && ctxRef.gstar.id === World.startStarId()
        && ctxRef.planet.habitable && !lowOrbit) {
      found(World.active(), true);
    }
    bind();
    tick();
    setInterval(tick, 1000); // раз в секунду: пища расходуется непрерывно, такт — раз в 10 минут
  }

  // ---------- такт ----------
  function tick() {
    const now = Date.now();
    // Авторейсы всего флота — первыми: прилёт к колонии доводит её до своей минуты и выгружается.
    Routes.tickWorld(tbl, now);
    const ship = World.active();
    Ship.rememberHull(tbl, ship);   // масса корпуса для ручного полёта с грузом (Ship.flightK)
    const here = ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index && ship.landed;
    // Корабль в рейсе ведёт Routes — второй раз его не двигаем.
    const r = ship.route ? { full: false, justLow: false, low: false } : Ship.advance(tbl, ship, here ? ctxRef.surf : null, now);
    if (r.full) Notify.shipAlert(ship, 'full', 'Трюм забит: ' + shipName(ship) + ' больше не берёт добычу', '');
    else Notify.drop('ship' + ship.id + ':full');
    if (r.justLow) Notify.shipAlert(ship, 'low',
      'Жизнеобеспечение ' + shipName(ship) + ' истощено больше чем наполовину — нужно пополнить пищей', 'bad');
    if (!r.low) Notify.drop('ship' + ship.id + ':low');
    if (col) Colony.advance(col, ctxRef.surf, now);
    World.save();
    render();
  }

  const shipName = s => (s.design || 'корабль') + ' #' + s.id;
  const n0 = v => Math.round(v).toLocaleString('ru');
  const resName = k => k === 'food' ? 'Пища'
    : (RESOURCES.find(r => r.key === k) || {}).name
    || (MAT_TYPE[k.slice(0, -1)] ? Colony.compName(k.slice(0, -1), +k.slice(-1)) : k);
  const hrs = ticks => {
    const m = ticks * 10;
    return m >= 1440 ? Math.floor(m / 1440) + ' сут ' + Math.round(m % 1440 / 60) + ' ч'
      : m >= 60 ? Math.floor(m / 60) + ' ч ' + Math.round(m % 60) + ' мин' : Math.round(m) + ' мин';
  };
  const bar = (frac, warn) => '<div class="bar' + (warn ? ' warn' : '') + '"><i style="width:' +
    Math.max(0, Math.min(1, frac)) * 100 + '%"></i></div>';
  const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';

  // ---------- отрисовка ----------
  function render() {
    if (!tbl) return;
    const ship = World.active();
    const st = Ship.stats(tbl, ship);
    const here = ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index && ship.landed;
    const sel = ctxRef.selected();
    // Вкладки — в нижней ленте, счётчики — в верхней полосе, раздел — в правой рельсе
    // (docs/Интерфейс.md §1: частое не прячем за кнопкой).
    $('vtabs').innerHTML = VIEWS.map(v => '<button class="vt' + (view === v[0] ? ' on' : '') +
      '" data-view="' + v[0] + '">' + v[1] + '</button>').join('');
    $('tb-stats').innerHTML = topStats(ship, st);
    const body = view === 'ship' ? shipView(ship, st, here, sel)
      : view === 'wh' ? whView(ship, st, here)
      : view === 'build' ? buildView(ship, here, sel)
      : view === 'prod' ? prodView()
      : view === 'route' ? routeView(ship, here)
      : view === 'yard' ? yardView()
      : fleetView(ship);
    $('colony').innerHTML = body + logBlock();
    $('con-wrap').hidden = !modal;
    if (modal) renderModal(sel);
  }

  // ---------- верхняя полоса: то, на что игрок смотрит постоянно ----------
  function topStats(ship, st) {
    const used = Ship.cargoUsed(ship), lifeF = Ship.lifeShare(tbl, ship, st);
    const cell = (name, val, frac, warn) => '<div class="st"><u>' + name + '</u><b>' + val + '</b>' +
      (frac == null ? '' : bar(frac, warn)) + '</div>';
    let out = cell('Трюм', n0(used) + ' / ' + n0(st.capacity), used / st.capacity) +
      cell('Водород в трюме', n0(((ship.cargo || {}).hydrogen || 0)) + ' · ' + Math.floor(((ship.cargo || {}).hydrogen || 0) / Ship.HARVEST_H2) + ' съёмов',
        Math.min(1, ((ship.cargo || {}).hydrogen || 0) / (Ship.HARVEST_H2 * 20)), ((ship.cargo || {}).hydrogen || 0) < Ship.HARVEST_H2) +
      cell('Жизнеобеспечение', hrs(Ship.lifeTicks(tbl, ship, st)), lifeF, lifeF <= COL.ALERT_LIFE) +
      (Ship.tankOf(ship) ? cell('Бак', Math.round((typeof ship.fuel === 'number' ? ship.fuel : 1) * 100) + ' % · ' +
        FUEL[Ship.tankOf(ship).key].name.toLowerCase(), typeof ship.fuel === 'number' ? ship.fuel : 1, (ship.fuel || 0) < 0.2) : '');
    if (col) {
      const s = Colony.summary(col, ctxRef.surf);
      out += cell('Склад', n0(s.used) + ' / ' + n0(s.cap), s.used / s.cap, s.room <= 0) +
        cell('Население', s.pop + ' / ' + (s.popCap || 0), s.popCap ? s.pop / s.popCap : 0) +
        cell('Планет. единиц', s.uniq) + cell('Крипта', n0(s.crypto));
    }
    return out;
  }

  // ---------- раздел «Корабль» ----------
  function shipView(ship, st, here, sel) {
    const used = Ship.cargoUsed(ship), free = Ship.cargoFree(tbl, ship, st);
    const lifeF = Ship.lifeShare(tbl, ship, st), lt = Ship.lifeTicks(tbl, ship, st);
    const y = sel ? Object.values(Colony.shipOutput(sel)).reduce((a, v) => a + v, 0) : 0;
    const wait = sel ? Ship.harvestWait(ship, ctxRef.gstar.id, ctxRef.planet.index, sel, Date.now()) : 0;

    let acts = '';
    if (ship.route) acts = '<div class="note">В авторейсе: ' + Routes.status(ship, Date.now()) +
      '. Корабль ведёт колония — управление в разделе «Рейсы».</div>';
    else if (!here) acts = '<div class="note">Корабль не у этой планеты — он у звезды ' + World.galaxy().stars[ship.star].name + '.</div>';
    else if (!Ship.hasMiner(ship)) acts = '<div class="note">Нет модуля «Шахтёр» — снимать добычу нечем. Поставьте его в конструкторе.</div>';
    else if (!sel) acts = '<div class="note">Выберите гекс на карте — с него можно снять добычу.</div>';
    else {
      const parked = ship.mine && ship.mine.q === sel.q && ship.mine.r === sel.r;
      acts = kv('Гекс ' + sel.q + ', ' + sel.r + ' отдаст', n0(y) + ' ед.') +
        '<div class="actions"><button data-act="harvest" class="primary" ' + (wait || free <= 0 ? 'disabled' : '') + '>' +
        (wait ? 'Восстановится через ' + wait + ' с' : free <= 0 ? 'Трюм полон' : lowOrbit ? 'Зачерпнуть газ' : 'Снять добычу') +
        '</button><button data-act="' + (parked ? 'unpark' : 'park') + '">' +
        (parked ? 'Снять с добычи' : 'Оставить на добыче') + '</button></div>' +
        (ship.mine ? '<div class="note">Стоит на гексе ' + ship.mine.q + ', ' + ship.mine.r +
          ' и берёт добычу каждые 10 минут, пока есть пища и топливо и не забит трюм.</div>' : '') +
        '<div class="note">Вдвое меньше, чем взяла бы шахта. Стоит ' + Ship.HARVEST_H2 +
        ' водорода из трюма — столько же ест шахта за такт. Корабль берёт один гекс на планету за 10 минут; ' +
        'снятый гекс закрыт и для других кораблей до конца такта.</div>';
    }
    return '<h4>' + shipName(ship) + '<span class="tag">' + (st.cls ? st.cls.name : '') + '</span></h4>' +
      '<div class="sub">' + (here ? 'Корабль ' + (lowOrbit ? 'на низкой орбите' : 'на поверхности') : 'Корабль в другом месте') +
      ' · экипаж ' + Ship.crew(ship) + ' (' + (ship.pax || 0) + ' пассажиров), ест ' + Ship.crew(ship) + ' пищи за такт</div>' +
      kv('Трюм', n0(used) + ' / ' + n0(st.capacity)) + bar(used / st.capacity) +
      kv('Водород в трюме', n0(((ship.cargo || {}).hydrogen || 0)) + ' · ' + Math.floor(((ship.cargo || {}).hydrogen || 0) / Ship.HARVEST_H2) + ' съёмов') +
      kv('Жизнеобеспечение', n0(Ship.lifeLeft(tbl, ship, st)) + ' пищи · ' + hrs(lt)) + bar(lifeF, lifeF <= COL.ALERT_LIFE) +
      acts;
  }

  // ---------- раздел «Склад»: вместимость и перегрузка в обе стороны (как в v2) ----------
  function whView(ship, st, here) {
    const free = Ship.cargoFree(tbl, ship, st);
    const hold = Object.entries(ship.cargo || {}).filter(e => e[1] > 0.5).sort((a, b) => b[1] - a[1]);
    const holdRows = hold.length ? hold.map(e =>
      '<div class="tr"><span>' + resName(e[0]) + '</span><b>' + n0(e[1]) + '</b>' +
      (here && col ? '<button data-put="' + e[0] + '" title="Выгрузить на склад">→ склад</button>' : '') + '</div>'
    ).join('') : '<div class="note">Трюм пуст.</div>';
    const holdBlock = '<div class="sect"><div class="rg-h">Трюм корабля · ' + n0(Ship.cargoUsed(ship)) +
      ' / ' + n0(st.capacity) + '</div>' + bar(Ship.cargoUsed(ship) / st.capacity) + holdRows + '</div>';
    if (!col) return '<h4>Трюм корабля</h4>' + holdRows + '<div class="note">Колонии нет — выгружать некуда.</div>';

    const sum = Colony.summary(col, ctxRef.surf);
    const goods = Ship.colonyGoods(col);
    const rows = goods.length ? goods.map(g =>
      '<div class="tr"><span>' + g.name + '</span><b>' + n0(g.qty) + '</b>' +
      (here ? '<button data-take="' + g.key + '" ' + (free > 0 ? '' : 'disabled') + ' title="Взять в трюм">→ трюм</button>' : '') + '</div>'
    ).join('') : '<div class="note">Склад пуст.</div>';
    const lifeF = Ship.lifeShare(tbl, ship, st);
    const acts = here ? '<div class="actions">' +
      '<button data-act="unload" ' + (Ship.cargoUsed(ship) > 0 ? '' : 'disabled') + '>Выгрузить всё</button>' +
      '<button data-act="recharge" ' + (col.food > 0 && lifeF < 1 ? '' : 'disabled') + '>Зарядить пищей</button>' +
      '<button data-act="holdfood" ' + ((ship.cargo || {}).food > 0 && lifeF < 1 ? '' : 'disabled') + '>Зарядить из трюма</button>' +
      (Ship.tankOf(ship) ? '<button data-act="refuel" ' + ((ship.fuel ?? 1) < 1 - 1e-6 ? '' : 'disabled') + '>Заправить (' +
        FUEL[Ship.tankOf(ship).key].name.toLowerCase() + ': трюм, склад)</button>' : '') + '</div>'
      : '<div class="note">Перегрузка возможна, только когда корабль у этой планеты.</div>';

    return '<h4>Склад планеты</h4>' +
      '<div class="sub">' + n0(sum.used) + ' / ' + n0(sum.cap) + ' ед. · постройка даёт два трюма (' +
      n0(sum.cap / Math.max(1, sum.live.length)) + ' ед.)</div>' + bar(sum.used / sum.cap, sum.room <= 0) +
      (sum.room <= 0 ? '<div class="note bad">Склад полон: добыча пропадает. Стройте дальше или вывозите.</div>' : '') +
      rows + '<div class="sect"><div class="rg-h">⇄ Перегрузка</div>' + acts + '</div>' + holdBlock + wasteBlock();
  }

  // ---------- токсичность планеты (ТЗ §8.21) ----------
  function ecoBlock() {
    if (!col) return '';
    const e = Colony.ecology(col, ctxRef.surf);
    const tf = col.tf, tdl = Colony.tfDaysLeft(col, ctxRef.surf);
    const tfLine = !e.terra ? '' : kv('Терраформирование', tf && !tf.done ? 'идёт · до нормы ~' + Math.ceil(tdl) + ' сут' : 'завершено') +
      '<div class="note">' + (tf && !tf.done
        ? 'Температура ' + Math.round(tf.tempK) + ' K, давление ' + Math.round(tf.pressure) + ', токсичность ' + Math.round(tf.toxicity) + ', радиация ' + Math.round(tf.radiation) +
          '; посев на гекс: микробиота ' + tf.bio.microbiota.toFixed(1).replace('.', ',') + ', флора ' + tf.bio.flora.toFixed(1).replace('.', ',') +
          '. Пока идёт — содержание за ' + COL.TERRA.activeDays + ' суток цены, потом за ' + COL_BUILDING.terraform.upkeepDays + '.'
        : 'Условия планеты — по норме расы, жизнь засеяна.') + ' Разберут за долги — планета вернётся к своим условиям.</div>';
    return tfLine +
      kv('Токсичность', e.tox + ' из 100') +
      '<div class="note">База планеты ' + e.base + (e.extra ? ' · +' + e.extra * COL.TOX_PER_EXTRA + ' за ' + e.extra + ' секций гексов сверх первой' : '') +
      (e.clean ? ' · −' + e.clean * COL.TOX_CLEAN + ' очистные' : '') + '. Биомасса −' + e.tox + ' %.</div>' +
      kv('Радиация', e.radiation + ' из 100' + (e.radCut ? ' (−' + e.radCut + ' улучшенные очистные)' : '')) +
      (col.popRates ? kv('Ёмкость планеты', Math.floor(col.popRates.K) + ' жителей из ' + col.popRates.slots + ' мест (Q ×' +
        col.popRates.Q.toFixed(2).replace('.', ',') + ', пища ×' + col.popRates.food.toFixed(2).replace('.', ',') + ')') +
        kv('За сутки', '+' + col.popRates.births.toFixed(1).replace('.', ',') + ' рождений − ' + col.popRates.deaths.toFixed(1).replace('.', ',') + ' смертей') : '') +
      (b => kv('Условия', '×' + b.all.toFixed(2).replace('.', ',')) +
        '<div class="note">' + b.race + ', относительно нормы расы: токсичность ×' + b.tox.toFixed(2).replace('.', ',') +
        ', радиация ×' + b.rad.toFixed(2).replace('.', ',') + ', температура ' + (e.tempK != null ? Math.round(e.tempK) + ' K ' : '') +
        '×' + b.temp.toFixed(2).replace('.', ',') + ', давление ' + (Colony.envOf(col, ctxRef.surf).pressure ?? '—') + ' ×' + b.press.toFixed(2).replace('.', ',') +
        '. Больше 1 — лучше нормы и покрывает слабые стороны; 0 — смертельно.</div>')(Colony.birthEnv(col, ctxRef.surf));
  }

  // ---------- отходы: что выбросил полный склад (col.waste, js/colony.js) ----------
  // Решение пользователя: склад переполнен — колония выбрасывает ненужное, а счётчик показывает,
  // какие ресурсы и в каких объёмах уходят в отходы (потом их можно будет продавать на бирже или
  // утилизировать).
  function wasteBlock() {
    const w = (col && col.waste) || {};
    const keys = Object.keys(w).filter(k => w[k] >= 0.5).sort((a, b) => w[b] * Colony.volOf(b) - w[a] * Colony.volOf(a));
    const total = keys.reduce((a, k) => a + w[k] * Colony.volOf(k), 0);
    return '<div class="sect"><div class="rg-h">Отходы · выброшено при полном складе' +
      (keys.length ? ' · ' + n0(total) + ' объёма' : '') + '</div>' +
      (keys.length ? keys.map(k => '<div class="tr"><span>' + resName(k) + '</span><b>' + n0(w[k]) + '</b></div>').join('')
        : '<div class="note">Пока ничего не выброшено.</div>') +
      '<div class="note">Склад полон — уходит то, чего на нём больше всего; бронь энергии и сырья на содержание не трогается.</div></div>';
  }

  // ---------- раздел «Рейсы»: колония сама гоняет корабль за ресурсом (js/routes.js) ----------
  const fmtSec = s => s < 90 ? Math.round(s) + ' с' : s < 5400 ? Math.round(s / 60) + ' мин' : (s / 3600).toFixed(1).replace('.', ',') + ' ч';
  function scanNow(ship) {
    const now = Date.now();
    if (rScan && rScan.target === rTarget && rScan.ship === ship.id && now - rScan.at < 10000) return rScan.rows;
    const rows = Routes.scan(tbl, ship, { star: col.star, planet: col.planet }, rTarget, {
      galaxy: () => World.galaxy(),
      surface: (st, pl) => {
        if (st === ctxRef.gstar.id && pl === ctxRef.planet.index) return ctxRef.surf;
        const g = World.galaxy().stars[st], p = g && generateSystem(g).planets[pl];
        return p ? generateSurface(p, g) : null;
      },
      colony: (st, pl) => World.colony(st, pl),
    });
    rScan = { target: rTarget, ship: ship.id, at: now, rows };
    return rows;
  }
  // Путевой лист: нужды колонии, снятые при вылете (в пути корабль с ними не сверяется), и стоянки.
  function waybill(r) {
    const G = { s: 'структурных', c: 'вычислительных', e: 'энергии (в водородах)', b: 'биомассы' };
    const need = r.need ? Object.keys(r.need.def).filter(g => r.need.def[g] > 0).map(g => n0(r.need.def[g]) + ' ' + G[g]).join(', ') : '';
    const stops = (r.sheet || []).slice(-8).map(x => x.name + ' (' + x.q + ', ' + x.r + ') — ' + n0(x.vol)).join(' · ');
    return kv('Путевой лист', (r.sheet || []).length + ' съёмов') +
      '<div class="note">Задание при вылете: ' + (need || 'нужды закрыты — берёт сверх, что ценнее') + '.' +
      (stops ? ' Стоянки: ' + stops + '.' : '') + ' В пути корабль задание не меняет; новый лист — дома.</div>';
  }
  function routeView(ship, here) {
    const T = ROUTE_TARGETS;
    let head = '<h4>Авторейсы</h4><div class="sub">Колония сама гоняет корабль: долетел → копает гекс, пока не забит трюм → ' +
      'везёт домой → выгружает и выбирает следующую цель. Сканер смотрит свою систему и ' + Routes.ROUTE.STARS +
      ' ближайших звёзд (до ' + Routes.ROUTE.KPC + ' кпк).</div>';
    if (ship.route) {
      const r = ship.route;
      return head + kv('Цель', T[r.target].name) + kv('Сейчас', Routes.status(ship, Date.now())) +
        kv('Куда', r.dest.name + ' · гекс ' + r.dest.q + ', ' + r.dest.r + (r.auto ? ' · выбирает сама' : ' · выбран вручную')) +
        (r.target === 'need' ? waybill(r) : kv('План рейса', '~' + r.plan.n + ' съёмов · +' + n0(r.plan.perHour) + ' ' + T[r.target].unit + '/ч')) +
        kv('Рейсов сделано', r.trips) +
        (r.last ? kv('Последний', 'с ' + r.last.from + ': ' + n0(r.last.brought) + ' ' + T[r.target].unit) : '') +
        '<div class="actions"><button data-act="routestop" ' + (r.stop ? 'disabled' : '') + '>' +
        (r.stop ? 'Возвращается — рейс будет снят' : 'Вернуть и снять с рейса') + '</button></div>';
    }
    if (!col) return head + '<div class="note">Колонии нет — возить некуда.</div>';
    const tabs = '<div class="actions">' + Object.keys(T).map(k => '<button data-rtarget="' + k + '"' +
      (k === rTarget ? ' class="primary"' : '') + '>' + T[k].name + '</button>').join('') + '</div>';
    const why = !Ship.hasMiner(ship) ? 'Нет модуля «Шахтёр» — копать нечем.'
      : !here ? 'Корабль должен стоять у этой колонии — отсюда он уходит и сюда возвращается.' : null;
    const rows = scanNow(ship);
    const ok = rows.filter(x => !x.err);
    const list = ok.slice(0, 10).map((x, i) =>
      '<button class="bl" data-rgo="' + i + '" ' + (why || !(x.net > 0) ? 'disabled' : '') + '><span>' + x.name +
      (x.home ? ' · своя планета' : x.star === col.star ? ' · своя система' : ' · ' + x.kpc.toFixed(2).replace('.', ',') + ' кпк') +
      (x.gas ? ' · газовый гигант' : '') +
      '<i>гекс ' + x.q + ', ' + x.r + ' · ' + x.n + ' съёмов · рейс ' + fmtSec(x.sec) + ' (полёт ' + fmtSec(x.tOut + x.tBack) + ')' +
      (x.selfFuel ? '' : ' · водород на съёмы везёт с собой') + '</i></span><b>+' + n0(x.perHour) + '/ч</b></button>').join('');
    const bad = rows.filter(x => x.err).length;
    return head + '<div class="rg-h">Что возить</div>' + tabs +
      (why ? '<div class="note bad">' + why + '</div>' : '') +
      '<div class="actions"><button data-act="routeauto" class="primary" ' + (why || !ok.some(x => x.net > 0) ? 'disabled' : '') +
      '>Лучшая цель, выбирать самой</button></div>' +
      '<div class="sect"><div class="rg-h">Сканер · чистая выгода в час (' + T[rTarget].unit + ')</div>' +
      (list || '<div class="note">Рентабельных планет не найдено.</div>') +
      (bad ? '<div class="note">Недоступно ' + bad + ' планет (жизнеобеспечение или топливо).</div>' : '') + '</div>' +
      '<div class="note">Корабль берёт ВСЕ ресурсы гекса. Выгода — привезённое за вычетом водорода на съёмы (' + Ship.HARVEST_H2 +
      ' за раз), делённое на время рейса с полётом туда и обратно. Энергия считается по единой энергоёмкости: тритий выгоднее водорода во столько раз, во сколько он энергоёмче, — сканер сравнивает их сам. ' +
      'Что не влезло на склад — уходит в отходы.</div>';
  }

  // ---------- раздел «Производство»: компоненты на склад или уникальный ресурс ----------
  function prodView() {
    if (!col) return '<h4>Производство</h4><div class="note">Колонии нет.</div>';
    if (!Colony.has(col, 'prod')) return '<h4>Производство</h4>' +
      '<div class="note">Нужна постройка «Производство» — поставьте её в разделе «Строительство».</div>';
    const order = col.order || { kind: 'uniq' };
    const compRows = col.comp && Object.keys(col.comp).some(k => col.comp[k] > 0.5)
      ? Object.keys(col.comp).filter(k => col.comp[k] > 0.5).map(k => kv(resName(k), n0(col.comp[k]))).join('')
      : '<div class="note">Компонентов пока нет.</div>';
    const uniqOn = order.kind === 'uniq';
    const pick = Colony.uniqPick(col);
    const orders = '<button class="bl" data-order="uniq" ' + (uniqOn ? 'disabled' : '') + '>' +
      '<span>Уникальный ресурс планеты<i>' + (pick ? '10 + 10 + 10 сырья трёх уровней разных типов: ' +
        pick.map(resName).join(', ') : 'не хватает сырья трёх уровней разных типов') +
      ' · одна единица в сутки</i></span><b>' + (uniqOn ? 'делается' : 'заказать') + '</b></button>' +
      MAT_TYPES.map(m => TIERS.map(t => {
        const on = order.kind === 'comp' && order.mat === m.key && order.tier === t;
        const cost = Colony.compCost(m.key, t);
        const lvl = Colony.live(col).filter(b => b.kind === 'prod').reduce((a, b) => Math.max(a, b.lvl), 0);
        const locked = t > lvl;   // производство делает компоненты не выше своего уровня
        const txt = locked ? 'нужно производство ' + t + ' уровня — улучшение в «Строительстве»' : Object.keys(cost).map(k => resName(k) + ' ' + cost[k]).join(' + ');
        return '<button class="bl" data-order="comp:' + m.key + ':' + t + '" ' + (on || locked ? 'disabled' : '') + '>' +
          '<span>' + Colony.compName(m.key, t) + '<i>' + txt + (locked ? '' : ' за штуку · до ' + COL.PROD_COMP + ' за такт') + '</i></span>' +
          '<b>' + (on ? 'делается' : 'заказать') + '</b></button>';
      }).join('')).join('');
    return '<h4>Производство</h4>' +
      '<div class="sub">Делает из сырья склада. Заказ один: либо компоненты, либо уникальный ресурс.</div>' +
      kv('Планетарных единиц', col.uniq) +
      '<div class="sect"><div class="rg-h">Компоненты на складе</div>' + compRows + '</div>' +
      '<div class="sect"><div class="rg-h">Что делать</div>' + orders + '</div>';
  }

  // ---------- раздел «Строительство» ----------
  function buildView(ship, here, sel) {
    if (!col) {
      const can = here && (ship.pax || 0) > 0 && !lowOrbit;
      return '<h4>Колонии нет</h4>' +
        '<div class="sub">Высадите колонистов: они станут населением, трюм — складом, пища — запасом колонии.</div>' +
        '<div class="actions"><button data-act="found" class="primary" ' + (can ? '' : 'disabled') + '>' +
        'Высадить ' + (ship.pax || 0) + ' колонистов</button></div>' +
        (lowOrbit ? '<div class="note">Газовый гигант: поверхности нет, высаживать некуда. Здесь строят только орбитальную станцию.</div>'
          : here ? '' : '<div class="note">Корабль должен сесть на эту планету.</div>');
    }
    const s = Colony.summary(col, ctxRef.surf);
    const rateSum = Object.values(s.rate).reduce((a, v) => a + v, 0);
    const stats = kv('Население', s.pop + ' / ' + (s.popCap || 0)) +
      kv('Рабочих', s.workers + ' из ' + s.jobs) + kv('Крипта', n0(s.crypto)) +
      kv('Планетарные единицы', s.uniq) + kv('Добыча', n0(rateSum) + ' ед./такт') +
      kv('Содержание', n0(s.upkeep) + ' ед. сырья/час') +
      kv('Энергия', n0(s.h2) + ' водорода/такт' + (s.gen ? ' · генератор жжёт и тритий' : '') +
        (s.powered ? '' : ' · НЕ ХВАТАЕТ')) +
      (s.site ? kv('Строится ' + COL_BUILDING[s.site.kind].name, hrs(s.site.left)) : '') +
      (sel && !lowOrbit ? kv('Гекс ' + sel.q + ', ' + sel.r, 'занято ' + Colony.hexCells(col, sel) + ' из ' + HEX_CELLS + ' секций') : '') +
      ecoBlock();
    const rows = COL_BUILDINGS.filter(B => !!B.orbital === lowOrbit).map(B => {
      const err = Colony.canBuild(col, B.key, sel, lowOrbit, here ? ship : null);
      const n = Colony.live(col).filter(b => b.kind === B.key).length;
      return '<button class="bl" data-open="' + B.key + '"><span>' + B.name + (n ? ' ×' + n : '') + ' · ' + B.cells + '/' + HEX_CELLS +
        '<i>' + (err || B.desc) + '</i></span><b>' + (err ? '—' : 'можно') + '</b></button>';
    }).join('');
    const auto = '<div class="actions"><button data-act="auto" class="' + (col.auto ? 'primary' : '') + '">' +
      (col.auto ? 'Автостройка включена — выключить' : 'Включить автостройку') + '</button></div>' +
      '<div class="note">Автостройка сама ставит шахты, производство, фермы, купола для роста населения, ' +
      'майнинг-фермы под жалованье и очистные при высокой токсичности. Строить вручную можно всегда.</div>';
    // Улучшения стоящих зданий (пока — очистные: компоненты 3 уровня, −10 радиации за ступень).
    const ups = Colony.live(col).filter(b => COL_BUILDING[b.kind].upgrade || COL_BUILDING[b.kind].upgrades).map(b => {
      const U = Colony.upgradeSpec(COL_BUILDING[b.kind], b.lvl + 1), err = Colony.canUpgrade(col, b);
      const price = U ? Object.keys(U.comp || {}).map(m => n0(U.comp[m]) + ' × ' + Colony.compName(m, U.tier).toLowerCase())
        .concat(Object.keys(U.raw || {}).map(k => n0(U.raw[k]) + ' ' + resName(k).toLowerCase())).join(' + ') : '';
      const effect = b.kind === 'prod' ? 'компоненты ' + (b.lvl + 1) + ' уровня' : U && U.radiation ? 'ещё −' + U.radiation + ' радиации' : '';
      return '<button class="bl" data-upg="' + b.q + ',' + b.r + ',' + b.kind + '" ' + (err ? 'disabled' : '') + '><span>' +
        COL_BUILDING[b.kind].name + ' (' + b.q + ', ' + b.r + ') · уровень ' + b.lvl + '<i>' + (err && !price ? err : (err ? err.replace(/\.$/, '') + '. ' : '') + 'Улучшить: ' + price + (effect ? ' — ' + effect : '')) +
        '</i></span><b>' + (err ? '—' : 'улучшить') + '</b></button>';
    }).join('');
    return '<h4>Колония</h4><div class="sub">Такт 10 минут · содержание раз в час</div>' + stats + auto +
      (ups ? '<div class="sect"><div class="rg-h">Улучшения</div>' + ups + '</div>' : '') +
      '<div class="sect"><div class="rg-h">Постройки' + (sel ? ' · гекс ' + sel.q + ', ' + sel.r : ' · выберите гекс') +
      '</div>' + rows + '</div>';
  }

  // Модалка постройки — как в v2: название, цена, описание, «Построить» и «Закрыть».
  function renderModal(sel) {
    const B = COL_BUILDING[modal];
    const here = World.active().star === ctxRef.gstar.id && World.active().planet === ctxRef.planet.index && World.active().landed;
    const err = col ? Colony.canBuild(col, modal, sel, lowOrbit, here ? World.active() : null) : 'колонии нет';
    const cost = [B.cost.s ? n0(B.cost.s) + ' структурного сырья' : '', B.cost.c ? n0(B.cost.c) + ' вычислительного сырья' : '',
      B.cost.b ? n0(B.cost.b) + ' биомассы' : '']
      .concat(Object.keys(B.comp || {}).map(m => n0(B.comp[m]) + ' × ' + Colony.compName(m, B.compTier || 1).toLowerCase()))
      .concat(B.cost.uniq ? [B.cost.uniq + ' планетарная единица'] : []).filter(Boolean).join(' · ');
    $('con-modal').innerHTML = '<div class="cm-t">' + B.name + '</div>' +
      '<div class="sub">1 уровень · ' +
      (B.up ? 'содержание ' + n0(B.up) + ' ед. (' + COL_GROUP_NAME[B.upkeep].toLowerCase() + ') в час' : 'содержания нет') +
      (B.h2 ? ' · энергия ' + B.h2 + ' водорода за такт' : '') +
      ' · ' + (B.work ? 'нужен рабочий' : 'рабочий не нужен') +
      ' · стройка ' + hrs(COL.BUILD_TICKS) + '</div>' +
      '<div class="cm-c">Цена: ' + cost + '</div><div class="cm-d">' + B.desc + '</div>' +
      (err ? '<div class="note bad">' + err + '</div>' : '<div class="note">Гекс ' + sel.q + ', ' + sel.r + '</div>') +
      '<div class="actions"><button data-act="dobuild" class="primary" ' + (err ? 'disabled' : '') + '>Построить</button>' +
      '<button data-act="closemodal">Закрыть</button></div>';
  }

  // ---------- раздел «Верфь» ----------
  function yardView() {
    if (!col) return '<h4>Верфь</h4><div class="note">Колонии нет.</div>';
    if (!Colony.has(col, 'port')) return '<h4>Верфь</h4><div class="note">Нужен космодром — постройте его в разделе «Строительство».</div>';
    const busy = col.yard ? kv('Собирается ' + col.yard.name, hrs(col.yard.left)) : '';
    const rows = loadDesigns().map(d => {
      const cost = Ship.cost(tbl, d), tot = Ship.costTotal(cost);
      const have = k => (col.comp || {})[k] || 0;
      const ok = !col.yard && Object.keys(cost).every(k => have(k) >= cost[k]);
      const txt = Object.keys(cost).map(k => resName(k) + ' ' + n0(cost[k]) + ' (есть ' + n0(have(k)) + ')').join(' · ');
      return '<button class="bl" data-ship="' + d.name + '" ' + (ok ? '' : 'disabled') + '><span>' + d.name +
        '<i>' + txt + '</i></span><b>' + n0(tot) + ' комп. · ' + hrs(shipBuildTicks(d)) + '</b></button>';
    }).join('');
    return '<h4>Верфь</h4><div class="sub">Корабль собирается ИЗ КОМПОНЕНТОВ со склада — их делает ' +
      'производство. Всё оборудование 1 уровня, базовые настройки.</div>' + busy + rows;
  }

  // ---------- раздел «Флот» ----------
  function fleetView(active) {
    const rows = World.fleet().map(s => {
      const st = World.galaxy().stars[s.star];
      const where = s.route ? 'авторейс: ' + Routes.status(s, Date.now())
        : s.landed && s.planet != null ? 'у планеты' : s.planet != null ? 'на орбите' : 'в системе';
      return '<button class="bl" data-pick="' + s.id + '" ' + (s.id === active.id ? 'disabled' : '') +
        '><span>' + shipName(s) + '<i>' + (st ? st.name : '?') + ' · ' + where + '</i></span><b>' +
        (s.id === active.id ? 'активный' : 'выбрать') + '</b></button>';
    }).join('');
    return '<h4>Флот</h4><div class="sub">Пока один корабль в пути, другим можно отдавать приказы</div>' + rows;
  }

  function logBlock() {
    if (!col || !col.log || !col.log.length) return '';
    return '<div class="sect"><div class="rg-h">Журнал колонии</div>' +
      col.log.slice(0, 6).map(e => '<div class="note">' + e.text + '</div>').join('') + '</div>';
  }

  // ---------- действия ----------
  function bind() {
    document.addEventListener('click', e => {
      // Вкладки живут в НИЖНЕЙ ЛЕНТЕ (#vtabs), а не в панели: после переноса их перестало
      // ловить, и разделы не переключались.
      const b = e.target.closest('#vtabs [data-view],#colony [data-act],#colony [data-open],' +
        '#colony [data-ship],#colony [data-pick],#colony [data-order],#colony [data-take],' +
        '#colony [data-put],#colony [data-rgo],#colony [data-rtarget],#colony [data-upg],#con-modal [data-act]');
      if (!b || b.disabled) return;
      const ship = World.active(), sel = ctxRef.selected();
      if (b.dataset.view) view = b.dataset.view;
      else if (b.dataset.open) modal = b.dataset.open;
      else if (b.dataset.act) act(b.dataset.act, ship, sel);
      else if (b.dataset.ship) buildShip(b.dataset.ship);
      else if (b.dataset.pick) pickShip(+b.dataset.pick);
      else if (b.dataset.order) setOrder(b.dataset.order);
      else if (b.dataset.take) { Ship.load(tbl, ship, col, b.dataset.take, Infinity); World.save(); }
      else if (b.dataset.put) putOne(ship, b.dataset.put);
      else if (b.dataset.rtarget) { rTarget = b.dataset.rtarget; rScan = null; }
      else if (b.dataset.upg && col) {
        const [q, r, kind] = b.dataset.upg.split(',');
        const bl = Colony.live(col).find(x => x.kind === kind && x.q === +q && x.r === +r);
        const err = bl ? Colony.upgrade(col, bl) : 'здания нет';
        if (err) alert(err); World.save();
      }
      else if (b.dataset.rgo) routeGo(ship, rScan && rScan.rows.filter(x => !x.err)[+b.dataset.rgo]);
      tick();
    });
  }

  // Заказ производства: 'uniq' или 'comp:<тип>:<уровень>'.
  function setOrder(v) {
    if (!col) return;
    if (v === 'uniq') col.order = { kind: 'uniq' };
    else { const parts = v.split(':'); col.order = { kind: 'comp', mat: parts[1], tier: +parts[2] }; }
    World.save();
  }
  // Выгрузить на склад одну позицию трюма: подсовываем Ship.unload корабль с одной строкой,
  // чтобы правило «что не влезло — остаётся в трюме» было общим и не раздваивалось.
  function putOne(ship, key) {
    if (!col) return;
    const one = { cargo: {} };
    one.cargo[key] = (ship.cargo || {})[key] || 0;
    Ship.unload(one, col);
    const left = one.cargo[key] || 0;
    if (left > 0) ship.cargo[key] = left; else delete ship.cargo[key];
    World.save();
  }

  function act(a, ship, sel) {
    if (a === 'harvest' && sel) {
      const r = Ship.harvest(tbl, ship, sel, ctxRef.gstar.id, ctxRef.planet.index, Date.now());
      if (r.err) alert(r.err);
    }
    if (a === 'park' && sel) ship.mine = { q: sel.q, r: sel.r };
    if (a === 'unpark') ship.mine = null;
    if (a === 'unload' && col) Ship.unload(ship, col);
    if (a === 'recharge' && col) Ship.recharge(tbl, ship, col);
    if (a === 'holdfood') Ship.rechargeFromHold(tbl, ship);
    if (a === 'refuel') { const r = Ship.refuel(ship, col); if (!(r.got > 0)) alert('Нечем заправить: нет ' + FUEL[Ship.tankOf(ship).key].name.toLowerCase() + ' ни в трюме, ни на складе'); }
    if (a === 'found') found(ship);
    if (a === 'dobuild' && modal) {
      const here = ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index && ship.landed;
      const err = Colony.build(col, modal, sel, lowOrbit, here ? ship : null);
      if (err) alert(err); else modal = null;
    }
    if (a === 'closemodal') modal = null;
    if (a === 'auto' && col) { col.auto = !col.auto; Colony.note(col, col.auto ? 'Автостройка включена' : 'Автостройка выключена'); }
    if (a === 'routeauto') routeGo(ship, null);
    if (a === 'routestop') Routes.stop(ship, Date.now());
    World.save();
  }

  // Высадка колонистов: они становятся населением, трюм — складом, пища — запасом колонии.
  // База населения по дикой флоре (ТЗ §8.3) — ниже неё население само не опускается.
  function found(ship, isStart) {
    const c = Colony.blank(Date.now(), ctxRef.gstar.id, ctxRef.planet.index);
    c.floraBase = Math.round((ctxRef.planet.composition.find(x => x.key === 'flora') || {}).value || 0);
    c.pop = ship.pax || 0;
    // Стартовый капитал колонии: без крипты рабочие не выходят, шахта стоит и колония мертва
    // с первой минуты. Это деньги игрока, вложенные в высадку (ТЗ §8.8).
    c.crypto = COL.CRYPTO_START;
    ship.pax = 0;
    // Стартовая колония строится раньше выгрузки: склад у неё уже есть под постройки набора.
    if (isStart) Colony.startKit(c, ctxRef.surf);
    Ship.unload(ship, c);
    // Корабль выгружает всё, включая водород, — а без водорода он не может снять добычу
    // (100 за съём). Возвращаем ему топливо, чтобы с первой минуты было чем копать.
    if (isStart) Ship.load(tbl, ship, c, 'hydrogen', 3000);
    Colony.note(c, isStart ? 'Стартовая колония: высажено ' + c.pop + ' колонистов'
      : 'Колония основана, высажено ' + c.pop + ' колонистов');
    col = c;
    World.putColony(ctxRef.gstar.id, ctxRef.planet.index, c);
  }

  function routeGo(ship, pick) {
    if (!col) return;
    const env = {
      galaxy: () => World.galaxy(),
      surface: (st, pl) => {
        if (st === ctxRef.gstar.id && pl === ctxRef.planet.index) return ctxRef.surf;
        const g = World.galaxy().stars[st], p = g && generateSystem(g).planets[pl];
        return p ? generateSurface(p, g) : null;
      },
      colony: (st, pl) => World.colony(st, pl),
      placed: s => { if (World.activeId() === s.id) World.setActive(s.id); },
    };
    const err = Routes.start(tbl, ship, col, rTarget, pick || null, Date.now(), env);
    if (err) alert(err);
    rScan = null;
    World.save();
  }

  function buildShip(name) {
    const d = loadDesigns().find(x => x.name === name); if (!d || !col) return;
    if (col.yard) return alert('Космодром уже собирает ' + col.yard.name);
    const cost = Ship.cost(tbl, d);
    col.comp = col.comp || {};
    for (const k in cost) if ((col.comp[k] || 0) < cost[k]) return alert('Мало компонентов: ' + resName(k));
    for (const k in cost) col.comp[k] -= cost[k];
    col.yard = { name, left: shipBuildTicks(d) };
    Colony.note(col, 'Космодром начал сборку: ' + name);
    World.save();
  }

  function pickShip(id) {
    const s = World.setActive(id); if (!s) return;
    if (s.star !== ctxRef.gstar.id || !(s.landed && s.planet === ctxRef.planet.index)) location.href = Notify.shipUrl(s);
  }

  // Что нарисовать на карте: постройки колонии, стройка, гекс добычи и стоянка корабля.
  function marks() {
    const out = [];
    if (!ctxRef) return out; // карта рисуется раньше, чем догрузится таблица компонентов
    if (col) {
      for (const b of Colony.live(col)) out.push({ q: b.q, r: b.r, text: COL_BUILDING[b.kind].name[0], kind: 'b' });
      if (col.site) out.push({ q: col.site.q, r: col.site.r, text: '…', kind: 'site' });
    }
    const ship = World.active();
    // Снятые в этом такте гексы — любым кораблём: они закрыты до конца такта.
    for (const h of Ship.hexesTaken(ctxRef.gstar.id, ctxRef.planet.index, Date.now())) out.push({ q: h.q, r: h.r, text: '⛏', kind: 'ship' });
    if (ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index) {
      if (ship.mine) out.push({ q: ship.mine.q, r: ship.mine.r, text: '⏻', kind: 'site' });
    }
    return out;
  }

  return { init, render, tick, marks, colony: () => col, table: () => tbl, lowOrbit: () => lowOrbit };
})();
