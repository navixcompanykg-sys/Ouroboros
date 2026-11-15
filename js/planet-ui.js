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

  const VIEWS = [['ship', 'Корабль'], ['wh', 'Склад'], ['build', 'Строительство'],
    ['prod', 'Производство'], ['yard', 'Верфь'], ['fleet', 'Флот']];

  async function init(c) {
    ctxRef = c;
    lowOrbit = !!(PLANET_TYPES[ctxRef.planet.type] || {}).lowOrbit;
    const got = await Store.load('parts');
    tbl = loadParts(got.data);
    // «постройка = два трюма»: размер трюма берём из таблицы пользователя, а не из головы
    Colony.setHoldUnit(partParam(tbl, 'cargo', 'capSolid', 1) + partParam(tbl, 'cargo', 'capGas', 1));
    col = World.colony(ctxRef.gstar.id, ctxRef.planet.index);
    Ship.ensureStart(World.active());
    bind();
    tick();
    setInterval(tick, 1000); // раз в секунду: пища расходуется непрерывно, такт — раз в 10 минут
  }

  // ---------- такт ----------
  function tick() {
    const now = Date.now();
    const ship = World.active();
    const here = ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index && ship.landed;
    const r = Ship.advance(tbl, ship, here ? ctxRef.surf : null, now);
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
      cell('Топливо', Math.round(World.fuel() * 100) + ' %', World.fuel()) +
      cell('Жизнеобеспечение', hrs(Ship.lifeTicks(tbl, ship, st)), lifeF, lifeF <= COL.ALERT_LIFE);
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
    const wait = Ship.harvestWait(ship, ctxRef.gstar.id, ctxRef.planet.index, Date.now());

    let acts = '';
    if (!here) acts = '<div class="note">Корабль не у этой планеты — он у звезды ' + World.galaxy().stars[ship.star].name + '.</div>';
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
        '<div class="note">Вдвое меньше, чем взяла бы шахта. Стоит ' + Math.round(Ship.HARVEST_FUEL * 100) +
        ' % бака. Один гекс на планету за 10 минут на каждый корабль; на другой планете свой счёт.</div>';
    }
    return '<h4>' + shipName(ship) + '<span class="tag">' + (st.cls ? st.cls.name : '') + '</span></h4>' +
      '<div class="sub">' + (here ? 'Корабль ' + (lowOrbit ? 'на низкой орбите' : 'на поверхности') : 'Корабль в другом месте') +
      ' · экипаж ' + Ship.crew(ship) + ' (' + (ship.pax || 0) + ' пассажиров), ест ' + Ship.crew(ship) + ' пищи за такт</div>' +
      kv('Трюм', n0(used) + ' / ' + n0(st.capacity)) + bar(used / st.capacity) +
      kv('Топливо', Math.round(World.fuel() * 100) + ' % · ' + Math.floor(World.fuel() / Ship.HARVEST_FUEL) + ' съёмов') +
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
      '<button data-act="holdfood" ' + ((ship.cargo || {}).food > 0 && lifeF < 1 ? '' : 'disabled') + '>Зарядить из трюма</button></div>'
      : '<div class="note">Перегрузка возможна, только когда корабль у этой планеты.</div>';

    return '<h4>Склад планеты</h4>' +
      '<div class="sub">' + n0(sum.used) + ' / ' + n0(sum.cap) + ' ед. · постройка даёт два трюма (' +
      n0(sum.cap / Math.max(1, sum.live.length)) + ' ед.)</div>' + bar(sum.used / sum.cap, sum.room <= 0) +
      (sum.room <= 0 ? '<div class="note bad">Склад полон: добыча пропадает. Стройте дальше или вывозите.</div>' : '') +
      rows + '<div class="sect"><div class="rg-h">⇄ Перегрузка</div>' + acts + '</div>' + holdBlock;
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
        const txt = Object.keys(cost).map(k => resName(k) + ' ' + cost[k]).join(' + ');
        return '<button class="bl" data-order="comp:' + m.key + ':' + t + '" ' + (on ? 'disabled' : '') + '>' +
          '<span>' + Colony.compName(m.key, t) + '<i>' + txt + ' за штуку · до ' + COL.PROD_COMP + ' за такт</i></span>' +
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
      kv('Содержание', n0(s.upkeep) + ' ед./час') +
      (s.site ? kv('Строится ' + COL_BUILDING[s.site.kind].name, hrs(s.site.left)) : '');
    const rows = COL_BUILDINGS.filter(B => !!B.orbital === lowOrbit).map(B => {
      const err = Colony.canBuild(col, B.key, sel, lowOrbit);
      const n = Colony.live(col).filter(b => b.kind === B.key).length;
      return '<button class="bl" data-open="' + B.key + '"><span>' + B.name + (n ? ' ×' + n : '') +
        '<i>' + (err || B.desc) + '</i></span><b>' + (err ? '—' : 'можно') + '</b></button>';
    }).join('');
    return '<h4>Колония</h4><div class="sub">Такт 10 минут · содержание раз в час</div>' + stats +
      '<div class="sect"><div class="rg-h">Постройки' + (sel ? ' · гекс ' + sel.q + ', ' + sel.r : ' · выберите гекс') +
      '</div>' + rows + '</div>';
  }

  // Модалка постройки — как в v2: название, цена, описание, «Построить» и «Закрыть».
  function renderModal(sel) {
    const B = COL_BUILDING[modal];
    const err = col ? Colony.canBuild(col, modal, sel, lowOrbit) : 'колонии нет';
    const cost = [B.cost.s ? B.cost.s + ' структурного' : '', B.cost.c ? B.cost.c + ' вычислительного' : '',
      B.cost.uniq ? B.cost.uniq + ' планетарная единица' : ''].filter(Boolean).join(' · ');
    $('con-modal').innerHTML = '<div class="cm-t">' + B.name + '</div>' +
      '<div class="sub">1 уровень · содержание ' + COL.UPKEEP_RAW + ' ед. (' +
      COL_GROUP_NAME[B.upkeep].toLowerCase() + ') в час · ' + (B.work ? 'нужен рабочий' : 'рабочий не нужен') +
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
      const ok = !col.yard && Object.keys(cost).every(k => (col.stock[k] || 0) >= cost[k]);
      return '<button class="bl" data-ship="' + d.name + '" ' + (ok ? '' : 'disabled') + ' title="' +
        Object.keys(cost).map(k => resName(k) + ' ' + cost[k]).join(', ') + '"><span>' + d.name +
        '<i>' + designModules(d).length + ' модулей · ' + hrs(shipBuildTicks(d)) + '</i></span><b>' +
        n0(tot) + ' сырья</b></button>';
    }).join('');
    return '<h4>Верфь</h4><div class="sub">Всё оборудование 1 уровня, базовые настройки</div>' + busy + rows;
  }

  // ---------- раздел «Флот» ----------
  function fleetView(active) {
    const rows = World.fleet().map(s => {
      const st = World.galaxy().stars[s.star];
      const where = s.landed && s.planet != null ? 'у планеты' : s.planet != null ? 'на орбите' : 'в системе';
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
      const b = e.target.closest('#colony [data-view],#colony [data-act],#colony [data-open],' +
        '#colony [data-ship],#colony [data-pick],#colony [data-order],#colony [data-take],' +
        '#colony [data-put],#con-modal [data-act]');
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
    if (a === 'found') found(ship);
    if (a === 'dobuild' && modal) { const err = Colony.build(col, modal, sel, lowOrbit); if (err) alert(err); else modal = null; }
    if (a === 'closemodal') modal = null;
    World.save();
  }

  // Высадка колонистов: они становятся населением, трюм — складом, пища — запасом колонии.
  // База населения по дикой флоре (ТЗ §8.3) — ниже неё население само не опускается.
  function found(ship) {
    const c = Colony.blank(Date.now(), ctxRef.gstar.id, ctxRef.planet.index);
    c.floraBase = Math.round((ctxRef.planet.composition.find(x => x.key === 'flora') || {}).value || 0);
    c.pop = ship.pax || 0;
    ship.pax = 0;
    Ship.unload(ship, c);
    Colony.note(c, 'Колония основана, высажено ' + c.pop + ' колонистов');
    col = c;
    World.putColony(ctxRef.gstar.id, ctxRef.planet.index, c);
  }

  function buildShip(name) {
    const d = loadDesigns().find(x => x.name === name); if (!d || !col) return;
    if (col.yard) return alert('Космодром уже собирает ' + col.yard.name);
    const cost = Ship.cost(tbl, d);
    for (const k in cost) if ((col.stock[k] || 0) < cost[k]) return alert('Мало сырья: ' + resName(k));
    for (const k in cost) col.stock[k] -= cost[k];
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
    if (ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index) {
      const h = (ship.hv || {})[ctxRef.gstar.id + ':' + ctxRef.planet.index];
      if (h && Colony.tickAt(Date.now()) <= h.t) out.push({ q: h.q, r: h.r, text: '⛏', kind: 'ship' });
      if (ship.mine) out.push({ q: ship.mine.q, r: ship.mine.r, text: '⏻', kind: 'site' });
    }
    return out;
  }

  return { init, render, tick, marks, colony: () => col, table: () => tbl, lowOrbit: () => lowOrbit };
})();
