// Панель колонии и флота на экране планеты (этапы 1–3):
//   1. корабельная добыча с гекса, трюм, жизнеобеспечение на пище, оповещения игроку;
//   2. меню строительства колонии — планета добывает сама, по тактам реального времени;
//   3. космодром: постройка кораблей (всё оборудование 1 уровня, базовые настройки) и
//      переключение между кораблями флота.
//
// Расчёт корабля и экономика колонии — в js/colony.js (общие с tools/colony.js числа), здесь
// только интерфейс. Карту рисует js/planet.js, он же даёт выбранный гекс через PlanetUI.hooks.
const PlanetUI = (() => {
  const $ = id => document.getElementById(id);
  let tbl = null, col = null, ctxRef = null, every = null;

  // ctxRef: { gstar, planet, surf, selected: () => гекс, redraw: () => void }
  async function init(c) {
    ctxRef = c;
    const got = await Store.load('parts');
    tbl = loadParts(got.data);
    const pick = parseInt(new URLSearchParams(location.search).get('pick'), 10);
    if (pick > 0 && World.fleet().some(s => s.id === pick)) World.setActive(pick);
    col = World.colony(ctxRef.gstar.id, ctxRef.planet.index);
    Ship.ensureStart(World.active());
    bind();
    tick();
    every = setInterval(tick, 1000); // раз в секунду: добыча и пища идут непрерывно
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
    if (col) {
      const before = col.t;
      Colony.advance(col, ctxRef.surf, now);
      if (col.t !== before) World.save();
    }
    World.save();
    render();
    ctxRef.redraw();
  }

  const shipName = s => (s.design || 'корабль') + ' #' + s.id;
  const f2 = v => (v / 100).toLocaleString('ru', { maximumFractionDigits: 2 });
  const n0 = v => Math.round(v).toLocaleString('ru');
  const hrs = ticks => {
    const m = ticks * 10;
    return m >= 1440 ? Math.floor(m / 1440) + ' сут ' + Math.round(m % 1440 / 60) + ' ч'
      : m >= 60 ? Math.floor(m / 60) + ' ч ' + Math.round(m % 60) + ' мин' : Math.round(m) + ' мин';
  };
  const bar = (frac, warn) => `<div class="bar${warn ? ' warn' : ''}"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%"></i></div>`;

  // ---------- отрисовка ----------
  function render() {
    if (!tbl) return;
    const ship = World.active();
    const st = Ship.stats(tbl, ship);
    const here = ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index && ship.landed;
    const sel = ctxRef.selected();
    const next = COL.TICK_MS - (Date.now() % COL.TICK_MS);
    $('colony').innerHTML =
      shipBlock(ship, st, here, sel) +
      colonyBlock(ship, here, sel, next) +
      portBlock(ship, here) +
      fleetBlock(ship) +
      logBlock();
  }

  function shipBlock(ship, st, here, sel) {
    const used = Ship.cargoUsed(ship), free = Ship.cargoFree(tbl, ship, st);
    const lifeF = Ship.lifeShare(tbl, ship, st), lt = Ship.lifeTicks(tbl, ship, st);
    const rows = Object.entries(ship.cargo || {}).filter(([, v]) => v > 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<div class="kv"><span>${k === 'food' ? 'Пища' : (RESOURCES.find(r => r.key === k) || {}).name || k}</span><b>${n0(v)}</b></div>`).join('');
    // Съём добычи: гекс отдаёт десятиминутную норму сразу и восстанавливается раз в такт.
    const now = Date.now();
    const yield0 = sel ? Object.values(Colony.shipOutput(sel)).reduce((a, v) => a + v, 0) : 0;
    const wait = Ship.harvestWait(ship, ctxRef.gstar.id, ctxRef.planet.index, now);
    let acts = '';
    if (!here) acts = `<div class="note">Корабль не на этой планете. Он у звезды ${World.galaxy().stars[ship.star].name}.</div>`;
    else if (!Ship.hasMiner(ship)) acts = `<div class="note">Нет модуля «Шахтёр» — снимать добычу нечем. Поставьте его в конструкторе.</div>`;
    else if (!sel) acts = `<div class="note">Выберите гекс на карте — с него можно снять добычу.</div>`;
    else {
      const parked = ship.mine && ship.mine.q === sel.q && ship.mine.r === sel.r;
      acts = `<div class="kv"><span>Гекс ${sel.q}, ${sel.r} отдаст</span><b>${n0(yield0)} ед.</b></div>` +
        `<div class="actions"><button data-act="harvest" class="primary" ${wait || free <= 0 ? 'disabled' : ''}>` +
        (wait ? 'Восстановится через ' + wait + ' с' : free <= 0 ? 'Трюм полон' : 'Снять добычу') + `</button>` +
        `<button data-act="${parked ? 'unpark' : 'park'}">${parked ? 'Снять с добычи' : 'Оставить на добыче'}</button></div>` +
        (ship.mine ? `<div class="note">Корабль стоит на гексе ${ship.mine.q}, ${ship.mine.r} и снимает добычу каждые 10 минут, пока есть пища и топливо и не забит трюм.</div>` : '') +
        `<div class="note">Вдвое меньше, чем взяла бы шахта. Стоит ${Math.round(Ship.HARVEST_FUEL * 100)} % бака. Один гекс на планету за 10 минут на каждый корабль; на другой планете свой счёт.</div>`;
    }

    const transfer = here && col ? `<div class="actions" style="margin-top:6px">` +
      `<button data-act="unload" ${used > 0 ? '' : 'disabled'}>Выгрузить в колонию</button>` +
      `<button data-act="recharge" ${col.food > 0 && lifeF < 1 ? '' : 'disabled'}>Зарядить пищей</button>` +
      `<button data-act="takefood" ${col.food > 0 && free > 0 ? '' : 'disabled'}>Пища в трюм</button></div>` : '';
    const fromHold = (ship.cargo && ship.cargo.food > 0 && lifeF < 1)
      ? `<div class="actions" style="margin-top:6px"><button data-act="holdfood">Зарядить из трюма</button></div>` : '';

    return `<h4>Корабль · ${shipName(ship)}<span class="tag">${st.cls ? st.cls.name : ''}</span></h4>` +
      `<div class="sub">Экипаж ${Ship.crew(ship)} (${ship.pax || 0} пассажиров) · ест ${Ship.crew(ship)} пищи за такт</div>` +
      `<div class="kv"><span>Трюм</span><b>${n0(used)} / ${n0(st.capacity)}</b></div>${bar(used / st.capacity)}` +
      `<div class="kv"><span>Топливо</span><b>${Math.round(World.fuel() * 100)} % · ${Math.floor(World.fuel() / Ship.HARVEST_FUEL)} съёмов</b></div>` +
      `<div class="kv"><span>Жизнеобеспечение</span><b>${n0(Ship.lifeLeft(tbl, ship, st))} пищи · ${hrs(lt)}</b></div>` +
      bar(lifeF, lifeF <= COL.ALERT_LIFE) +
      acts + transfer + fromHold +
      (rows ? `<div class="sect"><div class="rg-h">В трюме</div>${rows}</div>` : '');
  }

  function colonyBlock(ship, here, sel, next) {
    if (!col) {
      const can = here && (ship.pax || 0) > 0;
      return `<div class="sect"><h4>Колонии нет</h4>` +
        `<div class="sub">Высадите колонистов — они станут населением, трюм станет складом.</div>` +
        `<div class="actions"><button data-act="found" class="primary" ${can ? '' : 'disabled'}>` +
        `Высадить ${ship.pax || 0} колонистов</button></div>` +
        (here ? '' : '<div class="note">Корабль должен сесть на эту планету.</div>') + `</div>`;
    }
    const s = Colony.summary(col, ctxRef.surf);
    const groups = ['s', 'c', 'e', 'b'].map(g =>
      `<div class="kv"><span>${COL_GROUP_NAME[g]}</span><b>${n0(Colony.inGroup(col, g))}</b></div>`).join('');
    const rateSum = Object.values(s.rate).reduce((a, v) => a + v, 0);
    const site = s.site ? `<div class="kv"><span>Строится ${COL_BUILDING[s.site.kind].name}</span><b>${hrs(s.site.left)}</b></div>` : '';
    return `<div class="sect"><h4>Колония</h4>` +
      `<div class="sub">Такт 10 минут · следующий через ${Math.ceil(next / 1000)} с · содержание раз в час</div>` +
      `<div class="kv"><span>Население</span><b>${s.pop} / ${s.cap || 0}</b></div>` +
      `<div class="kv"><span>Рабочих</span><b>${s.workers} из ${s.jobs}</b></div>` +
      `<div class="kv"><span>Пища</span><b>${n0(s.food)}</b></div>` +
      `<div class="kv"><span>Крипта</span><b>${n0(s.crypto)}</b></div>` +
      `<div class="kv"><span>Планетарные единицы</span><b>${s.uniq}</b></div>` +
      `<div class="kv"><span>Добыча</span><b>${n0(rateSum)} ед./такт</b></div>` +
      `<div class="kv"><span>Содержание</span><b>${n0(s.upkeep)} ед./час</b></div>` +
      site + `<div class="sect"><div class="rg-h">Склад</div>${groups}</div>` + buildBlock(sel);
  }

  function buildBlock(sel) {
    const rows = COL_BUILDINGS.map(B => {
      const err = Colony.canBuild(col, B.key, sel);
      const price = [B.cost.s ? B.cost.s + ' стр.' : '', B.cost.c ? B.cost.c + ' выч.' : '',
        B.cost.uniq ? B.cost.uniq + ' план. ед.' : ''].filter(Boolean).join(' · ');
      const n = Colony.live(col).filter(b => b.kind === B.key).length;
      return `<button class="bl" data-build="${B.key}" ${err ? 'disabled' : ''} title="${err || B.desc}">` +
        `<span>${B.name}${n ? ' ×' + n : ''}<i>${err || B.desc}</i></span><b>${price}</b></button>`;
    }).join('');
    return `<div class="sect"><div class="rg-h">Строительство${sel ? ' · гекс ' + sel.q + ', ' + sel.r : ' · выберите гекс'}</div>${rows}</div>`;
  }

  function portBlock(ship, here) {
    if (!col || !Colony.has(col, 'port')) return '';
    const rows = loadDesigns().map(d => {
      const cost = Ship.cost(tbl, d), tot = Ship.costTotal(cost);
      const okRaw = Object.keys(cost).every(k => (col.stock[k] || 0) >= cost[k]);
      const ok = okRaw && !col.yard;
      return `<button class="bl" data-ship="${d.name}" ${ok ? '' : 'disabled'} ` +
        `title="${okRaw ? 'Собрать' : 'мало сырья'}">` +
        `<span>${d.name}<i>${designModules(d).length} модулей · ${hrs(shipBuildTicks(d))}</i></span>` +
        `<b>${n0(tot)} сырья</b></button>`;
    }).join('');
    const busy = col.yard ? `<div class="kv"><span>Собирается ${col.yard.name}</span><b>${hrs(col.yard.left)}</b></div>` : '';
    return `<div class="sect"><div class="rg-h">Космодром · постройка кораблей (всё 1 уровня)</div>${busy}${rows}</div>`;
  }

  function fleetBlock(active) {
    const rows = World.fleet().map(s => {
      const st = World.galaxy().stars[s.star];
      const where = s.landed && s.planet != null ? 'на планете' : s.planet != null ? 'на орбите' : 'в системе';
      return `<button class="bl" data-pick="${s.id}" ${s.id === active.id ? 'disabled' : ''}>` +
        `<span>${shipName(s)}<i>${st ? st.name : '?'} · ${where}</i></span>` +
        `<b>${s.id === active.id ? 'активный' : 'выбрать'}</b></button>`;
    }).join('');
    return `<div class="sect"><div class="rg-h">Флот</div>${rows}</div>`;
  }

  function logBlock() {
    if (!col || !col.log || !col.log.length) return '';
    return `<div class="sect"><div class="rg-h">Журнал колонии</div>` +
      col.log.slice(0, 8).map(e => `<div class="note">${e.text}</div>`).join('') + `</div>`;
  }

  // ---------- действия ----------
  function bind() {
    $('colony').addEventListener('click', e => {
      const ship = World.active(), sel = ctxRef.selected();
      const b = e.target.closest('[data-act],[data-build],[data-ship],[data-pick]');
      if (!b || b.disabled) return;
      if (b.dataset.act) act(b.dataset.act, ship, sel);
      else if (b.dataset.build) { const err = Colony.build(col, b.dataset.build, sel); if (err) alert(err); World.save(); }
      else if (b.dataset.ship) buildShip(b.dataset.ship);
      else if (b.dataset.pick) pickShip(+b.dataset.pick);
      tick();
    });
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
    if (a === 'takefood' && col) Ship.loadFood(tbl, ship, col, Math.min(col.food, 500));
    if (a === 'holdfood') Ship.rechargeFromHold(tbl, ship);
    if (a === 'found') found(ship);
    World.save();
  }

  // Высадка колонистов: они становятся населением, трюм — складом колонии, пища — её запасом.
  // База населения по дикой флоре (ТЗ §8.3) — ниже неё население само не опускается.
  function found(ship) {
    const c = Colony.blank(Date.now(), ctxRef.gstar.id, ctxRef.planet.index);
    const flora = (ctxRef.planet.composition.find(x => x.key === 'flora') || {}).value || 0;
    c.floraBase = Math.round(flora);
    c.pop = ship.pax || 0;
    ship.pax = 0;
    c.food = (ship.cargo && ship.cargo.food) || 0;
    if (ship.cargo) delete ship.cargo.food;
    Ship.unload(ship, c);
    Colony.note(c, 'Колония основана, высажено ' + c.pop + ' колонистов');
    col = c;
    World.putColony(ctxRef.gstar.id, ctxRef.planet.index, c);
  }

  function buildShip(name) {
    const d = loadDesigns().find(x => x.name === name); if (!d || !col) return;
    if (col.yard) return alert('Космодром уже собирает ' + col.yard.name);
    const cost = Ship.cost(tbl, d);
    for (const k in cost) if ((col.stock[k] || 0) < cost[k]) return alert('Мало сырья: ' + k);
    for (const k in cost) col.stock[k] -= cost[k];
    col.yard = { name, left: shipBuildTicks(d) };
    Colony.note(col, 'Космодром начал сборку: ' + name);
    World.save();
  }

  function pickShip(id) {
    const s = World.setActive(id); if (!s) return;
    if (s.star !== ctxRef.gstar.id) { location.href = Notify.shipUrl(s); return; }
    if (!(s.landed && s.planet === ctxRef.planet.index)) { location.href = Notify.shipUrl(s); return; }
  }

  // Что нарисовать на карте: постройки колонии, стройка и гекс, который копает корабль.
  function marks() {
    const out = [];
    if (!ctxRef) return out; // карта рисуется раньше, чем догрузится таблица компонентов
    if (col) {
      for (const b of Colony.live(col)) out.push({ q: b.q, r: b.r, text: COL_BUILDING[b.kind].name[0], kind: 'b' });
      if (col.site) out.push({ q: col.site.q, r: col.site.r, text: '…', kind: 'site' });
    }
    // Гекс, с которого этот корабль уже снял добычу в этом такте, и гекс, на котором он стоит.
    const ship = World.active();
    if (ship.star === ctxRef.gstar.id && ship.planet === ctxRef.planet.index) {
      const h = (ship.hv || {})[ctxRef.gstar.id + ':' + ctxRef.planet.index];
      if (h && Colony.tickAt(Date.now()) <= h.t) out.push({ q: h.q, r: h.r, text: '⛏', kind: 'ship' });
      if (ship.mine) out.push({ q: ship.mine.q, r: ship.mine.r, text: '⏻', kind: 'site' });
    }
    return out;
  }

  return { init, render, tick, marks, colony: () => col, table: () => tbl };
})();
