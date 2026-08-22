'use strict';
// ══════════════════════════════════════════════════════════════════════════
// МИР — ЕДИНЫЙ ИСТОЧНИК ДАННЫХ ДЛЯ ВСЕХ ЭКРАНОВ
//
// Экранов у игрока несколько (HUD корабля, карта системы, карта сектора), но
// реальность одна: те же звезда, планеты и корабль, просто в разном масштабе.
// Дублировать её по файлам странно и опасно — разъезжаются формулы: положение
// планеты, посчитанное для радара, обязано совпадать с тем, куда её рисует
// карта, и с тем, куда полетит корабль.
//
// Поэтому здесь собрано ВСЁ, что описывает мир:
//   • справочники (фракции, типы планет и звёзд);
//   • часы игрового времени (сервер — источник, клиент экстраполирует);
//   • состояние (корабль + состав сектора) с общим опросом на все экраны;
//   • положения тел как чистые функции времени;
//   • действия корабля (навигация, посадка, взлёт);
//   • масштабы экранов в одних единицах.
//
// Экраны из этого модуля только ЧИТАЮТ и рисуют. Ни один экран не считает
// положение тел сам и не ходит в API за состоянием мира напрямую.
// ══════════════════════════════════════════════════════════════════════════

const World = (() => {

  // ── справочники отображения: сервер шлёт только ключи ───────────────────
  // genitive — родительный падеж («Столица ЧЕГО» — planetLabel ниже), нужен
  // только для отображения, сервер его не знает и никогда не присылает.
  const FACTIONS = {
    technocracy: { name:'Технократия',        genitive:'Технократии',        color:'#4fd1ff' },
    tradefed:    { name:'Торговая федерация', genitive:'Торговой федерации', color:'#ffd24f' },
    monarchy:    { name:'Монархия',           genitive:'Монархии',           color:'#c084fc' },
    miners:      { name:'Рудокопы',           genitive:'Рудокопов',          color:'#ff8c42' },
    pirates:     { name:'Пираты',             genitive:'Пиратов',            color:'#ff4d6d' },
    smugglers:   { name:'Контрабандисты',     genitive:'Контрабандистов',    color:'#9aa0a8' },
    rebels:      { name:'Повстанцы',          genitive:'Повстанцев',         color:'#4dff88' },
    none:        { name:'Независимая',        genitive:'Независимой',        color:'#3a4256' },
  };
  // Пять эффективных типов планет (ТЗ.md §2.5), порядок — от звезды наружу.
  const PLANET_TYPES = {
    core:  { name:'Голое ядро',  color:'#6a6f7a' },
    lava:  { name:'Лавовая',     color:'#ff5a3c' },
    rocky: { name:'Каменистая',  color:'#a99274' },
    ice:   { name:'Ледяная',     color:'#bfe8ff' },
    gas:   { name:'Газ. гигант', color:'#e0c088' },
  };
  const STAR_COLORS = {
    red:'rgb(255,100,68)', yellow:'rgb(255,224,102)', blue:'rgb(160,200,255)',
    white:'rgb(210,235,255)', neutron:'rgb(180,255,210)', stable:'#ffcf6b',
  };
  const STAR_NAMES = {
    red:'Красный карлик', yellow:'Жёлтый карлик', blue:'Синий гигант',
    white:'Белый карлик', neutron:'Нейтронная звезда', stable:'Стабильный мир',
  };
  // Типы гексов поверхности планеты (server/planets.go generateSurface,
  // ТЗ_UI.md §5). Цвета продолжают палитру архивного Planet UI (§43
  // OUROBOROS_design.md) там, где типы совпадают.
  // wasteland/steppe раньше был одним типом с двумя смыслами в названии —
  // разделены по признаку жизни (generateSurface): пустошь никогда не
  // появляется на живой атмосферной планете, и наоборот, степь никогда не
  // появляется без жизни — однозначность вместо общей метки.
  const SURFACE_TYPES = {
    water:     { name:'Вода',            color:'#2a6fdd' },
    icecap:    { name:'Ледяная шапка',   color:'#d8f2ff' },
    mountains: { name:'Горы',            color:'#887766' },
    hills:     { name:'Холмы',           color:'#a08868' },
    wasteland: { name:'Пустошь',         color:'#9c9464' },
    steppe:    { name:'Степь',           color:'#8fa050' },
    desert:    { name:'Пустыня',         color:'#cc9944' },
    forest:    { name:'Леса',            color:'#336633' },
    jungle:    { name:'Джунгли',         color:'#1f7a3d' },
  };
  // Здания (server/buildings.go, ТЗ_Экономика.md §12/§15). Только каталог
  // названий для отображения — сама модель (кто где стоит) приходит с
  // сервера через World.planetSurfaceDetail, ничего не разыгрывается тут.
  const BUILDING_TYPES = {
    mine:            'Горнодобывающая шахта',
    atmo_collector:  'Атмосферный собиратель',
    bio_extractor:   'Биоэкстрактор',
    hydro_farm:      'Гидроминеральная ферма',
    factory_metal:   'Металлургический завод',
    factory_chem:    'Химический завод',
    factory_elec:    'Электроинженерный завод',
    lab:             'Лаборатория передовых систем',
    housing:         'Жилой модуль',
    h2_generator:    'Водородный генератор',
    solar_panel:     'Солнечная панель',
    battery:         'Планетарная батарея',
    fort:            'Форт-казарма',
    shipyard:        'Верфь',
    adv_components:  'Завод улучшенных компонентов',
    radio:           'Радиостанция',
    science_center:  'Научный центр',
    crypto_farm:     'Криптоферма',
    transport_node:  'Транспортный узел',
    nuclear_plant:   'Атомная станция',
    recycler:        'Завод переработки',
  };
  // Ресурсы: ключ с сервера → имя. Шкала 0–10 000 у.е. (ТЗ.md §2.5).
  const RESOURCES = {
    silicates:'Силикаты', iron:'Железо', refractory:'Тугоплавкие',
    lightRare:'Лёгкие редкие', platinoids:'Платиноиды', inertGases:'Инертные газы',
    helium3:'Гелий-3', hydrogen:'Водород', volcanicGases:'Вулканич. газы',
    radioactives:'Радиоактивные', waterIce:'Водяной лёд', biomass:'Дикая биомасса',
    phosphates:'Фосфаты', carbonates:'Карбонаты', bitumens:'Битумы',
    metal_hydrogen:'Металл. водород',
  };

  // ── масштабы экранов, в одних единицах ──────────────────────────────────
  // Базовая единица длины — КЛЕТЬ системы, и по ТЗ.md §2.7.4 «в масштабе
  // корабля 1 клетка = 1 экран телефона». Отсюда оба предела:
  //   • масштаб 1:1 (клеть на экран) — только в HUD корабля, это его штатный
  //     и единственный масштаб: игрок «внутри» мира, а не смотрит на схему;
  //   • карта системы ближе 4 экранов не приближается — там нужен обзор,
  //     а не разглядывание одной точки в упор.
  // ── масштабы: всё считается от ИСТИННОГО размера тел ────────────────────
  //
  // Базовая единица — КЛЕТЬ, и она равна ширине экрана телефона (ТЗ.md §2.7.4).
  // Отсюда всё остальное следует само, без отдельных правил на каждый экран:
  //   • HUD корабля — 1 клеть на экран, самая крупная планета (⌀1 клеть, см.
  //     server/planets.go planetDiameter) занимает ровно экран целиком;
  //   • карта системы ближе 4 экранов не приближается, и на этом зуме та же
  //     планета — ровно ЧЕТВЕРТЬ ширины обзора.
  //
  // При отдалении видимый размер тел УБЫВАЕТ — просто потому, что обзор растёт,
  // а тело остаётся прежним. Никакого искусственного роста тел с зумом нет:
  // рисуется истинный размер и только он.
  const SCALE = {
    shipCellsPerScreen: 1,   // HUD корабля: 1 клеть на ширину экрана
    mapMinCells: 4,          // карта системы: ближайший обзор — 4 экрана
  };

  // Реальных секунд в игровом месяце: игровое время идёт 1:1 с календарём
  // (server/clock.go gameSpeedRealtime), средний григорианский месяц.
  const SEC_PER_MONTH = 365.2425 * 24 * 3600 / 12;

  // ── часы: сервер — источник, клиент лишь экстраполирует ─────────────────
  const clock = { months:0, speed:0, at:0 };
  function syncClock(months, speed){
    clock.months = months;
    clock.speed = speed;
    clock.at = performance.now();
  }
  // gameMonths — игровое время СЕЙЧАС. Все положения тел — функции от него.
  function gameMonths(){
    return clock.months + clock.speed * (performance.now() - clock.at) / 1000;
  }

  // ── состояние мира ──────────────────────────────────────────────────────
  const state = {
    ship: null,      // ShipView с сервера
    star: null,      // звезда системы, в которой сейчас корабль
    objects: null,   // весь состав сектора (нужен карте сектора)
    fleets: null,     // раскладка флотов игрока (server/fleets.go), нужна карте сектора
    online: false,
    error: null,
  };

  const listeners = new Set();
  function subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn); }
  function notify(){ listeners.forEach(fn => { try { fn(state); } catch(e){ console.error(e); } }); }

  let inFlight = false;
  async function refresh(){
    if(inFlight) return state;
    inFlight = true;
    try{
      const [shipRes, galRes, fleetRes] = await Promise.all([
        fetch('api/ship', {cache:'no-store'}),
        fetch('api/galaxy', {cache:'no-store'}),
        fetch('api/fleets', {cache:'no-store'}),
      ]);
      if(!shipRes.ok || !galRes.ok || !fleetRes.ok) throw new Error('HTTP ' + shipRes.status + '/' + galRes.status + '/' + fleetRes.status);
      const ship = await shipRes.json();
      const gal = await galRes.json();
      const fleetList = await fleetRes.json();
      syncClock(gal.months, gal.speed);
      state.ship = ship;
      state.objects = gal.objects || [];
      state.star = state.objects.find(o => o.id === ship.systemStarId) || null;
      state.fleets = fleetList || [];
      state.online = true;
      state.error = null;
    }catch(e){
      state.online = false;
      state.error = e.message || String(e);
    }finally{
      inFlight = false;
      notify();
    }
    return state;
  }

  let pollTimer = null;
  function start(pollMs = 1000){
    if(pollTimer) return;
    refresh();
    pollTimer = setInterval(refresh, pollMs);
  }

  // ── положения тел: чистые функции игрового времени ──────────────────────
  //
  // Зеркало серверных формул (server/planets.go planetPos, server/ship.go
  // effectivePos). Именно поэтому они живут здесь в одном экземпляре: если
  // разъедутся — «долететь до планеты» и «нарисовать планету» покажут разное.

  // planetPos — положение планеты в локальных координатах системы.
  // angle(t) = angle0 + angVel × t (третий закон Кеплера, ТЗ.md §2.5).
  function planetPos(p, t){
    const a = p.angle + (p.angVel || 0) * (t === undefined ? gameMonths() : t);
    return { x: p.orbit * Math.cos(a), y: p.orbit * Math.sin(a) };
  }

  // planetDockPos — где корабль СТОИТ У планеты: на 2/3 её радиуса от ЦЕНТРА,
  // то есть ВНУТРИ диска планеты, под углом angleOffset ОТНОСИТЕЛЬНО
  // собственного угла планеты — поэтому причал вращается ВМЕСТЕ с планетой,
  // сохраняя ту же сторону, с которой корабль подлетел (сервер считает
  // angleOffset в Navigate по фактическому курсу, а не всегда со стороны
  // звезды). Зеркало server/planets.go dockRadiusFactor/planetDockPos.
  const DOCK_RADIUS_FACTOR = 2 / 3;
  function planetDockPos(p, angleOffset, t){
    const a = p.angle + (p.angVel || 0) * (t === undefined ? gameMonths() : t);
    const pcx = p.orbit * Math.cos(a), pcy = p.orbit * Math.sin(a);
    const dockR = (p.d || 2) / 2 * DOCK_RADIUS_FACTOR;
    const dockAngle = a + (angleOffset || 0);
    return { x: pcx + dockR * Math.cos(dockAngle), y: pcy + dockR * Math.sin(dockAngle) };
  }

  // dockedPos — стоянка у планеты по её ЖИВОМУ положению. Общая для двух
  // случаев в shipPos: когда сервер уже подтвердил прилёт и когда перелёт по
  // часам клиента только что закончился, а подтверждение ещё в пути.
  function dockedPos(planetIndex, angleOffset){
    const p = state.star && state.star.planets && state.star.planets[planetIndex];
    return p ? planetDockPos(p, angleOffset) : null;
  }

  // shipPos — положение корабля в локальных координатах его системы.
  // Все случаи считаются локально покадрово, а не берутся из снимка:
  //  1) в перелёте — интерполяция From→To по доле пройденного времени;
  //  2) стоит у планеты — НАСЛЕДУЕТ её орбитальное движение (та же угловая
  //     скорость, planetDockPos), иначе корабль дёргался бы за планетой с
  //     частотой опроса; координаты — внутри диска планеты, а не её центр;
  //  3) свободно висит в системе — хранимые координаты.
  function shipPos(){
    const ship = state.ship;
    if(!ship) return { x:0, y:0 };
    const t = ship.transit;
    if(t && t.mode === 'system'){
      const departed = new Date(t.departedAt).getTime();
      const arrive = new Date(t.arriveAt).getTime();
      const frac = arrive > departed
        ? Math.min(1, Math.max(0, (Date.now() - departed) / (arrive - departed)))
        : 1;
      // Долетели, но снимок с сервера ещё не пришёл (опрос раз в секунду):
      // не зависаем в конечной точке маршрута, пока планета продолжает уходить
      // по орбите, а сразу переходим на её живую стоянку. Иначе на подтверждении
      // прилёта корабль скачком догонял бы планету.
      if(frac >= 1 && t.targetKind === 'planet'){
        const docked = dockedPos(t.targetPlanetIndex, ship.dockAngleOffset);
        if(docked) return docked;
      }
      return { x: t.fromX + (t.toX - t.fromX) * frac, y: t.fromY + (t.toY - t.fromY) * frac };
    }
    if(!t && ship.atPlanetIndex >= 0){
      const docked = dockedPos(ship.atPlanetIndex, ship.dockAngleOffset);
      if(docked) return docked;
    }
    return { x: ship.sx, y: ship.sy };
  }

  // Положение корабля в СЕКТОРНЫХ координатах (r, дуга) — для карты сектора.
  // В межзвёздном перелёте интерполируется, иначе берётся от своей звезды.
  function shipSectorPos(){
    const ship = state.ship;
    if(!ship) return null;
    const t = ship.transit;
    if(t && t.mode === 'interstellar'){
      const departed = new Date(t.departedAt).getTime();
      const arrive = new Date(t.arriveAt).getTime();
      const frac = arrive > departed
        ? Math.min(1, Math.max(0, (Date.now() - departed) / (arrive - departed)))
        : 1;
      return { r: t.fromR + (t.toR - t.fromR) * frac, x: t.fromArc + (t.toArc - t.fromArc) * frac };
    }
    const star = state.star;
    if(!star) return null;
    return { r: star.r, x: star.x0 + star.arc * (gameMonths() - star.t0) };
  }

  // ── производные характеристики ──────────────────────────────────────────
  // Период обращения планеты в РЕАЛЬНЫХ часах: считаем по канонической
  // игровой скорости (реальное время), а не по текущему множителю — «год
  // планеты» её свойство и не должен скакать от отладочного ускорения.
  function orbitalPeriodHours(p){
    if(!p || !p.angVel) return 0;
    return (2 * Math.PI / p.angVel) * SEC_PER_MONTH / 3600;
  }
  function formatPeriod(p){
    const h = orbitalPeriodHours(p);
    if(!h) return '—';
    if(h >= 48) return (h/24).toFixed(1) + ' сут';
    if(h >= 1)  return h.toFixed(1) + ' ч';
    return Math.round(h*60) + ' мин';
  }

  // Масса/гравитация — по требованию пользователя (короткая справка о
  // планете), в ТЗ формулы для них нет. Оценка САМОСТОЯТЕЛЬНАЯ: планета —
  // однородный шар, Масса ∝ Плотность×Диаметр³, Гравитация у поверхности
  // ∝ Плотность×Диаметр (Масса/Радиус²), плотность — по типу планеты
  // (реальная астрономия: газовые гиганты рыхлые, ядра/лава — плотные
  // металл/порода, лёд — лёгкий). Нормировано на среднюю каменистую планету
  // (diameter 0.715, плотность-множитель 1.0) = 1.0 — читается как «×Земли».
  const PLANET_DENSITY = { core: 1.3, lava: 1.1, rocky: 1.0, ice: 0.4, gas: 0.25 };
  const MASS_BASELINE_D = 0.715; // середина диапазона rocky (planetDiameter, server/planets.go)
  function planetMass(p){
    if(!p) return 0;
    const density = PLANET_DENSITY[p.type] ?? 1.0;
    return density * Math.pow((p.d || 0) / MASS_BASELINE_D, 3);
  }
  function planetGravity(p){
    if(!p) return 0;
    const density = PLANET_DENSITY[p.type] ?? 1.0;
    return density * (p.d || 0) / MASS_BASELINE_D;
  }

  // planetInfoGrid — короткая справка о планете (по требованию пользователя:
  // «должна содержать размер/давление/гравитацию/массу/период/удалённость/
  // население/фракцию/жизнь/радиацию и токсичность, в две колонки»). ОДНА
  // реализация на оба экрана (system.html — при наведении на планету,
  // planet.html — при посадке), а не дублируется в каждом — иначе разъедутся,
  // как и остальные производные величины в этом модуле (formatPeriod и т.д.).
  // Возвращает HTML 10 строк — вызывающая сторона оборачивает в контейнер со
  // своей сеткой (.info-grid, 2 колонки).
  function planetInfoGrid(p, star){
    const f = FACTIONS[p.owner] || FACTIONS.none;
    return [
      `размер: <b>${(p.d || 0).toFixed(2)}</b>`,
      `давление атм.: <b>${p.pressure}</b>`,
      `гравитация: <b>×${planetGravity(p).toFixed(2)}</b>`,
      `масса: <b>×${planetMass(p).toFixed(2)} M⊕</b>`,
      `период обращения: <b>${formatPeriod(p)}</b>`,
      `удалённость: <b>${p.orbit} кл</b>`,
      `население: <b>${p.population || 0}</b>`,
      `фракция: <b>${f.name}</b>`,
      `жизнь: <b>${p.life ? 'есть' : 'нет'}</b>`,
      `радиация/токс.: <b>${p.radiation} / ${p.toxicity}</b>`,
    ].map(row => `<div>${row}</div>`).join('');
  }

  // ── названия ────────────────────────────────────────────────────────────
  function starLabel(star){
    if(!star) return '—';
    if(star.stable) return (FACTIONS[star.faction] || {}).name || 'Стабильный мир';
    return STAR_NAMES[star.starType] || star.starType;
  }
  function starColor(star){
    if(!star) return '#fff';
    if(star.stable) return (FACTIONS[star.faction] || {}).color || '#fff';
    return STAR_COLORS[star.starType] || '#fff';
  }
  // star — опционален (не у всех вызовов планета известна вместе со звездой),
  // но без него столицу не подписать по фракции — тогда просто тип планеты.
  function planetLabel(p, star){
    if(p.capital && star){
      const f = FACTIONS[star.faction];
      return 'Столица ' + (f ? f.genitive : star.faction);
    }
    return (PLANET_TYPES[p.type] || { name:p.type }).name;
  }
  function planetColor(p){
    return (PLANET_TYPES[p.type] || { color:'#888' }).color;
  }

  // ── действия корабля ────────────────────────────────────────────────────
  // Сервер при ошибке отвечает text/plain (http.Error), а не JSON — поэтому
  // сперва читаем текст и парсим только при res.ok.
  async function post(path, body){
    const res = await fetch(path, {
      method:'POST',
      headers: body ? {'Content-Type':'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if(!res.ok) throw new Error(text || ('HTTP ' + res.status));
    const data = JSON.parse(text);
    state.ship = data;      // сразу применяем — не ждём следующего опроса
    notify();
    return data;
  }
  const navigate = (kind, starId, planetIndex = 0) =>
    post('api/ship/navigate', { kind, starId, planetIndex });
  const land   = () => post('api/ship/land');
  const launch = () => post('api/ship/launch');

  // planetSurfaceDetail — гекс-карта ОДНОЙ планеты С РЕСУРСАМИ по гексам
  // (server/main.go handlePlanetSurface). Намеренно НЕ часть общего опроса
  // (state/refresh/subscribe) — эти данные нужны только экрану планеты и
  // только для той планеты, на которой сейчас стоит корабль, а раздувать
  // ими секундный опрос всего сектора (/api/galaxy) незачем — см. комментарий
  // у SurfaceHex.res на сервере. Кэш на пару секунд — экран планеты
  // пересоздаёт запрос при каждом клике по гексу, а не только при заходе.
  // Возвращает {surface:[...], buildings:[...]} — buildings те же самые, что
  // и Planet.buildings в /api/galaxy (список небольшой, тоже там есть), но
  // раз экран и так делает отдельный запрос по гексам, проще брать их
  // отсюда же, а не собирать из двух источников.
  let surfaceDetailCache = null; // {key, at, promise}
  async function planetSurfaceDetail(starId, planetIndex){
    const key = starId + ':' + planetIndex;
    const fresh = surfaceDetailCache && surfaceDetailCache.key === key && (Date.now() - surfaceDetailCache.at) < 5000;
    if(fresh) return surfaceDetailCache.promise;
    const promise = fetch(`api/planet/surface?starId=${starId}&planetIndex=${planetIndex}`, {cache:'no-store'})
      .then(res => { if(!res.ok) throw new Error('HTTP ' + res.status); return res.json(); });
    surfaceDetailCache = { key, at: Date.now(), promise };
    return promise;
  }

  return {
    FACTIONS, PLANET_TYPES, SURFACE_TYPES, BUILDING_TYPES, STAR_COLORS, STAR_NAMES, RESOURCES, SCALE, SEC_PER_MONTH,
    state, subscribe, refresh, start,
    gameMonths, clock,
    planetPos, shipPos, shipSectorPos,
    orbitalPeriodHours, formatPeriod, planetMass, planetGravity, planetInfoGrid,
    starLabel, starColor, planetLabel, planetColor,
    navigate, land, launch, planetSurfaceDetail,
  };
})();
