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
  // SCREEN_UE — у.е.·с на 1 экран/клеть (200000×5, ТЗ.md §2.7.4) — то же
  // самое, что screenUE в server/ship.go, нужна клиенту для доводки позиции
  // ручного полёта между опросами (shipManualDelta ниже).
  const SCREEN_UE = 1000000;
  // SPEED_REALTIME — «нормальная» скорость игровых часов (игровых месяцев в
  // реальную секунду), то же число, что gameSpeedRealtime в server/clock.go.
  // Нужна, чтобы клиент знал ТЕКУЩИЙ множитель ускорения времени (timeFactor
  // ниже): сервер гонит физику корабля в этом же темпе (settleFlight), и без
  // множителя доводка позиции между опросами отставала бы в сотни раз на
  // отладочных пресетах админ-панели — корабль дёргался бы скачком на каждом
  // опросе вместо плавного хода.
  const SPEED_REALTIME = 12 / (365.2425 * 24 * 60 * 60);

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
    shipSyncedAt: 0, // performance.now() на момент ПОСЛЕДНЕГО присвоения state.ship — см. setShip/shipHeadingDeg
    star: null,      // звезда системы, в которой сейчас корабль
    objects: null,   // весь состав сектора (нужен карте сектора)
    fleets: null,     // раскладка флотов игрока (server/fleets.go), нужна карте сектора
    online: false,
    error: null,
  };

  // setShip — единая точка присвоения state.ship (опрос/навигация/ручное
  // управление/переключение флота/debug-урон — все проходят здесь), чтобы
  // shipSyncedAt всегда отражало момент последнего снимка. Нужен для
  // клиентской доводки курса/позиции между опросами (shipHeadingDeg/shipPos
  // ниже) — сервер шлёт снимок РАЗ В СЕКУНДУ, а корабль на ручном управлении
  // продолжает поворачиваться/ускоряться и между опросами.
  function setShip(ship){
    state.ship = ship;
    state.shipSyncedAt = performance.now();
  }

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
      setShip(ship);
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

  // ── кинематика автопилота: зеркало server/ship.go flightProfile ─────────
  // Сервер присылает в Transit весь профиль перелёта (разгон/крейсер/
  // торможение, ускорение, курс и разворот) — клиент по нему покадрово
  // считает, ГДЕ корабль и с КАКОЙ скоростью, вместо прежней линейной
  // интерполяции From→To по времени. Линейная давала постоянную «среднюю»
  // скорость: корабль трогался рывком и так же рывком замирал у планеты —
  // ровно то, что читалось как телепортация (прямая жалоба пользователя).
  // Формулы обязаны совпадать с серверными: расхождение — это расхождение
  // картинки с авторитетной позицией, которая приезжает раз в секунду.
  function timeFactor(){
    const f = clock.speed / SPEED_REALTIME;
    return f > 0 ? f : 1;
  }
  let staleServerWarned = false;
  function warnStaleServerOnce(){
    if(staleServerWarned) return;
    staleServerWarned = true;
    console.warn('Сервер не присылает кинематику перелёта (Transit.profile) — ' +
      'скорее всего запущена старая сборка сервера. Пересоберите/перезапустите ' +
      'его (cd server && go run .), иначе перелёт рисуется по-старому: линейно, ' +
      'без разгона и торможения.');
  }
  function profileStateAt(p, t){
    const total = p.accelSec + p.cruiseSec + p.decelSec;
    if(t <= 0) return { dist:0, speed:p.entrySpeed };
    if(t >= total) return { dist:p.distanceUe, speed:p.exitSpeed };
    if(t <= p.accelSec){
      return { dist: p.entrySpeed*t + 0.5*p.accelUe*t*t, speed: p.entrySpeed + p.accelUe*t };
    }
    const distAcc = p.entrySpeed*p.accelSec + 0.5*p.accelUe*p.accelSec*p.accelSec;
    t -= p.accelSec;
    if(t <= p.cruiseSec) return { dist: distAcc + p.peakSpeed*t, speed: p.peakSpeed };
    t -= p.cruiseSec;
    // Торможение — СВОИМ ускорением: у планеты автопилот тормозит в её
    // гравитационном колодце (server/ship.go navDecelFor), и оно на порядок
    // сильнее разгонного. Старые снимки без decelUe (сервер прошлой сборки) —
    // симметричный профиль, как было.
    const decel = p.decelUe > 0 ? p.decelUe : p.accelUe;
    return {
      dist: distAcc + p.peakSpeed*p.cruiseSec + p.peakSpeed*t - 0.5*decel*t*t,
      speed: p.peakSpeed - decel*t,
    };
  }
  // transitState — доля пройденного пути, скорость (у.е.) и курс (градусы)
  // на СЕЙЧАС. «Время корабля» = реальные секунды с отправления × множитель
  // ускорения, зафиксированный сервером на момент прокладки курса
  // (Transit.TimeFactor) — не текущий: перелёт, начатый на одном пресете
  // времени, доигрывается в его темпе (ТЗ.md §2.7.4).
  function transitState(t){
    if(!t) return { frac:1, speed:0, headingDeg:0 };
    const p = t.profile;
    // ── страховка от рассинхрона версий ────────────────────────────────────
    // Профиля нет — значит на том конце СТАРЫЙ сервер (собранный до этой
    // правки), а клиент уже новый: например, запущен старый `server.exe`
    // вместо пересобранного. Без этой ветки `frac` оставался бы 1, и корабль
    // МГНОВЕННО оказывался бы в точке цели — «корабль исчез» сразу после
    // нажатия ЛЕТЕТЬ. Откатываемся на прежнее поведение (линейно по времени)
    // и один раз говорим об этом в консоль, чтобы причина была видна.
    if(!p){
      warnStaleServerOnce();
      const departed = new Date(t.departedAt).getTime();
      const arrive = new Date(t.arriveAt).getTime();
      const frac = arrive > departed
        ? Math.min(1, Math.max(0, (Date.now() - departed) / (arrive - departed)))
        : 1;
      return { frac, speed:0, headingDeg: t.headingToDeg || 0 };
    }
    const ts = Math.max(0, (Date.now() - new Date(t.departedAt).getTime()) / 1000) * (t.timeFactor > 0 ? t.timeFactor : 1);
    const st = profileStateAt(p, ts);
    const frac = p.distanceUe > 0 ? Math.min(1, st.dist / p.distanceUe) : 1;
    return { frac, speed: st.speed, headingDeg: transitHeadingDeg(t, ts, frac) };
  }
  // ── ломаный маршрут: обход светила ──────────────────────────────────────
  // Маршрут, проходящий слишком близко к звезде, сервер ломает на два участка
  // (Transit.HasMid/MidX/MidY, server/ship.go avoidStarWaypoint — «корабли не
  // приближаются к звёздам, если маршрут пересекает звезду, они огибают её»).
  // Значит и позиция, и курс считаются по ПУТИ, а не линейной интерполяцией
  // From→To: та срезала бы угол ровно там, где корабль обходит светило.
  const CORNER_BLEND_CELLS = 0.35; // то же, что cornerBlendCells на сервере
  function transitLegs(t){
    if(!t.hasMid) return [Math.hypot(t.toX-t.fromX, t.toY-t.fromY), 0];
    return [Math.hypot(t.midX-t.fromX, t.midY-t.fromY), Math.hypot(t.toX-t.midX, t.toY-t.midY)];
  }
  function transitPointAt(t, frac){
    const [l1, l2] = transitLegs(t);
    const total = l1 + l2;
    if(total <= 0) return { x: t.toX, y: t.toY };
    const d = frac * total;
    const midX = t.hasMid ? t.midX : t.toX, midY = t.hasMid ? t.midY : t.toY;
    if(d <= l1 || l2 <= 0){
      const k = l1 > 0 ? Math.min(1, d / l1) : 0;
      return { x: t.fromX + (midX - t.fromX) * k, y: t.fromY + (midY - t.fromY) * k };
    }
    const k = Math.min(1, (d - l1) / l2);
    return { x: t.midX + (t.toX - t.midX) * k, y: t.midY + (t.toY - t.midY) * k };
  }
  // physicsStepSec на сервере (ship.go) — тот же приём численного
  // интегрирования, зеркалим шаг.
  const PHYSICS_STEP_SEC = 0.05;

  // legFromTo/waypointAfter/integrateTurn/transitPositionAt — зеркало
  // server/ship.go positionAt/integrateTurn/waypointAfter (ТЗ.md §2.7.6, по
  // прямой жалобе пользователя: «когда корабль поворачивает, линия
  // траектории сразу показывает куда, а не реальную траекторию — корабль
  // должен идти с округлой траекторией»). Раньше позиция считалась чисто по
  // пройденному РАССТОЯНИЮ вдоль прямой (transitPointAt выше) — курс
  // поворачивался отдельно (transitHeadingDeg), независимо от позиции: нос
  // разворачивался на месте, пока сам корабль уже ехал по прямой к цели.
  // Подробное объяснение подхода (интеграл Френеля не берётся в замкнутом
  // виде, поэтому фаза разворота считается численно, а после нее — честное
  // прицеливание на актуальную путевую точку) — см. комментарий у
  // server/ship.go Transit.positionAt, здесь не дублируется.
  function waypointAfter(t, distSoFar){
    const [l1] = transitLegs(t);
    if(t.hasMid && distSoFar < l1) return { x: t.midX, y: t.midY };
    return { x: t.toX, y: t.toY };
  }
  function integrateTurn(t, ts){
    let x = t.fromX, y = t.fromY;
    if(ts <= 0) return { x, y };
    let steps = Math.floor(ts / PHYSICS_STEP_SEC);
    if(steps < 1) steps = 1;
    if(steps > 4000) steps = 4000; // physicsMaxSteps на сервере
    const dt = ts / steps;
    for(let i = 0; i < steps; i++){
      const at = dt * (i + 0.5);
      const headingRad = transitHeadingDeg(t, at, 0) * Math.PI / 180;
      const speed = profileStateAt(t.profile, at).speed;
      const cellsPerSec = speed / SCREEN_UE;
      x += cellsPerSec * Math.cos(headingRad) * dt;
      y += cellsPerSec * Math.sin(headingRad) * dt;
    }
    return { x, y };
  }
  function transitPositionAt(t, ts){
    const total = t.profile.accelSec + t.profile.cruiseSec + t.profile.decelSec;
    if(total <= 0 || ts <= 0) return { x: t.fromX, y: t.fromY };
    if(ts >= total) return { x: t.toX, y: t.toY };
    const turnEnd = Math.min(t.turnSec || 0, total);
    if(ts <= turnEnd) return integrateTurn(t, ts);
    const turn = integrateTurn(t, turnEnd);
    const distAtTurnEnd = profileStateAt(t.profile, turnEnd).dist / SCREEN_UE;
    const distNow = profileStateAt(t.profile, ts).dist / SCREEN_UE;
    const aim = waypointAfter(t, distAtTurnEnd);
    const dx = aim.x - turn.x, dy = aim.y - turn.y;
    const segLen = Math.hypot(dx, dy);
    if(segLen < 1e-9) return turn;
    let k = (distNow - distAtTurnEnd) / segLen;
    if(k > 1) k = 1;
    return { x: turn.x + dx * k, y: turn.y + dy * k };
  }
  function shortestDeg(a, b){
    let d = (b - a) % 360;
    if(d > 180) d -= 360;
    if(d <= -180) d += 360;
    return d;
  }
  // Курс самого маршрута: направление текущего участка, у путевой точки —
  // плавный переход между участками.
  function transitCourseDeg(t, frac){
    const midX = t.hasMid ? t.midX : t.toX, midY = t.hasMid ? t.midY : t.toY;
    const h1 = Math.atan2(midY - t.fromY, midX - t.fromX) * 180 / Math.PI;
    const [l1, l2] = transitLegs(t);
    if(!t.hasMid || l2 <= 0) return h1;
    const h2 = Math.atan2(t.toY - t.midY, t.toX - t.midX) * 180 / Math.PI;
    const d = frac * (l1 + l2);
    const blend = Math.min(CORNER_BLEND_CELLS, l1, l2);
    if(blend <= 0) return d <= l1 ? h1 : h2;
    if(d <= l1 - blend) return h1;
    if(d >= l1 + blend) return h2;
    return h1 + shortestDeg(h1, h2) * ((d - (l1 - blend)) / (2 * blend));
  }
  // Разворот на курс маршрута идёт одновременно с разгоном (см. Transit.TurnSec
  // на сервере) — камера доворачивается плавно, а не скачком в момент нажатия
  // «ЛЕТЕТЬ».
  function transitHeadingDeg(t, ts, frac){
    const course = t.mode === 'system' ? transitCourseDeg(t, frac) : t.headingToDeg;
    if(!t.turnSec || ts >= t.turnSec) return course;
    return t.headingFromDeg + shortestDeg(t.headingFromDeg, course) * (ts / t.turnSec);
  }

  // shipPos — положение корабля в локальных координатах его системы.
  // Все случаи считаются локально покадрово, а не берутся из снимка:
  //  1) в перелёте — движение по профилю разгон/крейсер/торможение;
  //  2) стоит у планеты — НАСЛЕДУЕТ её орбитальное движение (та же угловая
  //     скорость, planetDockPos), иначе корабль дёргался бы за планетой с
  //     частотой опроса; координаты — внутри диска планеты, а не её центр;
  //  3) свободно висит в системе — хранимые координаты.
  function shipPos(){
    const ship = state.ship;
    if(!ship) return { x:0, y:0 };
    const t = ship.transit;
    if(t && t.mode === 'system'){
      const frac = transitState(t).frac;
      // Долетели, но снимок с сервера ещё не пришёл (опрос раз в секунду):
      // не зависаем в конечной точке маршрута, пока планета продолжает уходить
      // по орбите, а сразу переходим на её живую стоянку. Иначе на подтверждении
      // прилёта корабль скачком догонял бы планету.
      if(frac >= 1 && t.targetKind === 'planet'){
        const docked = dockedPos(t.targetPlanetIndex, ship.dockAngleOffset);
        if(docked) return docked;
      }
      // Позиция — С УЧЁТОМ разворота в движении (transitPositionAt), не
      // просто «по пройденному расстоянию вдоль прямой» (transitPointAt,
      // прежнее поведение) — та же формула, что и сервер (см. комментарий
      // у transitPositionAt выше). Время — та же «шипсекунда», что и весь
      // остальной transitState (реальные секунды с отправления × TimeFactor).
      const ts = Math.max(0, (Date.now() - new Date(t.departedAt).getTime()) / 1000) * (t.timeFactor > 0 ? t.timeFactor : 1);
      return transitPositionAt(t, ts);
    }
    if(!t && ship.atPlanetIndex >= 0){
      const docked = dockedPos(ship.atPlanetIndex, ship.dockAngleOffset);
      if(docked) return docked;
    }
    // Свободный (ручной) полёт — сервер отдаёт снимок раз в секунду
    // (start(pollMs)), а корабль на зажатом «Форсаже»/повороте продолжает
    // двигаться между опросами; довручиваем позицию тем же курсом/скоростью,
    // что уже в снимке (shipManualDelta) — иначе corабль дёргался бы раз в
    // секунду вместо плавного хода.
    const d = shipManualDelta();
    return { x: ship.sx + d.dx, y: ship.sy + d.dy };
  }

  // shipManualDelta — курс СЕЙЧАС и смещение с момента последнего снимка
  // (state.shipSyncedAt), для РУЧНОГО полёта (см. shipPos/shipHeadingDeg).
  // Один линейный шаг, не пошаговая численная интеграция, как на сервере
  // (settleFlight, ship.go) — на интервале между опросами (<1с) разница
  // визуально не заметна, а деталь важна только для HUD, не для авторитетной
  // позиции (та всегда пересчитывается сервером на каждый опрос/действие).
  function shipManualDelta(){
    const ship = state.ship;
    if(!ship) return { headingRad:0, speed:0, dx:0, dy:0 };
    // Физика корабля на сервере идёт в темпе игровых часов (settleFlight
    // умножает шаг на тот же множитель) — доводка обязана делать то же, иначе
    // на ускоренном времени картинка отстаёт от снимка и корабль дёргается
    // вперёд на каждом опросе.
    const dt = Math.max(0, (performance.now() - state.shipSyncedAt) / 1000) * timeFactor();
    const c = ship.control || {};
    let headingRad = ship.headingDeg * Math.PI / 180;
    const turnRateRad = (ship.turnRateDeg || 0) * Math.PI / 180;
    if(c.turnLeft) headingRad += turnRateRad * dt;
    if(c.turnRight) headingRad -= turnRateRad * dt;
    // Скорость между опросами тоже МЕНЯЕТСЯ, если тяга/торможение зажаты —
    // раньше доводка считала её постоянной, и на разгоне показание скорости
    // (а с ним и параллакс фона) раз в секунду прыгало ступенькой.
    const accel = ship.accelUe || 0;
    let speed = ship.speed || 0;
    if(c.thrust) speed += accel * dt;
    if(c.brake) speed -= accel * dt;
    speed = Math.max(0, Math.min(ship.maxSpeed || speed, speed));
    const avgCellsPerSec = ((ship.speed || 0) + speed) / 2 / SCREEN_UE;
    return {
      headingRad, speed,
      dx: avgCellsPerSec * Math.cos(headingRad) * dt,
      dy: avgCellsPerSec * Math.sin(headingRad) * dt,
    };
  }
  // shipHeadingDeg — курс корабля СЕЙЧАС, градусы, математическая конвенция
  // (0=+X, рост против часовой — та же, что headingDeg с сервера). В перелёте
  // курс ведёт автопилот (Transit.headingAt: разворот на маршрут, дальше сам
  // маршрут) — берём его оттуда, а не хранимый Heading.
  function shipHeadingDeg(){
    const t = state.ship && state.ship.transit;
    if(t && t.profile) return transitState(t).headingDeg;
    return shipManualDelta().headingRad * 180 / Math.PI;
  }
  // shipSpeed — скорость корабля СЕЙЧАС (у.е., ТЗ.md §2.7.4), одинаково для
  // ручного полёта и автопилота. Всё, что показывает игроку скорость
  // (звёздный фон, показание HUD, пунктир траектории), обязано брать её
  // отсюда: снимок с сервера приходит раз в секунду, а в перелёте до этой
  // правки вообще сообщал ноль.
  function shipSpeed(){
    const ship = state.ship;
    if(!ship) return 0;
    const t = ship.transit;
    if(t && t.profile) return transitState(t).speed;
    return shipManualDelta().speed;
  }

  // Положение корабля в СЕКТОРНЫХ координатах (r, дуга) — для карты сектора.
  // В межзвёздном перелёте интерполируется, иначе берётся от своей звезды.
  function shipSectorPos(){
    const ship = state.ship;
    if(!ship) return null;
    const t = ship.transit;
    if(t && t.mode === 'interstellar'){
      const frac = transitState(t).frac; // тот же профиль разгон/крейсер/торможение, что и внутри системы
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
  // сперва читаем текст и парсим только при res.ok. postJSON — низкоуровневый
  // помощник (fetch+разбор), post — его обёртка для эндпоинтов, которые
  // отвечают ГОЛЫМ ShipView (navigate/land/launch/control) и сразу
  // применяются в state.ship. Активация флота и debug-урон отвечают ДРУГОЙ
  // формой ({fleets,ship} / {deck,ship}) — у них свои обёртки ниже, не post().
  async function postJSON(path, body){
    const res = await fetch(path, {
      method:'POST',
      headers: body ? {'Content-Type':'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if(!res.ok) throw new Error(text || ('HTTP ' + res.status));
    return JSON.parse(text);
  }
  async function post(path, body){
    const data = await postJSON(path, body);
    setShip(data);      // сразу применяем — не ждём следующего опроса
    notify();
    return data;
  }
  const navigate = (kind, starId, planetIndex = 0) =>
    post('api/ship/navigate', { kind, starId, planetIndex });
  const land   = () => post('api/ship/land');
  const launch = () => post('api/ship/launch');
  // setControl — какие органы ручного управления зажаты ПРЯМО СЕЙЧАС
  // (client/ship.html: боковые «манёвр», тумблеры «Форсаж»/«Тормож.») —
  // курс/скорость/позиция между вызовами сервер доводит аналитически сам
  // (server/ship.go settleFlight), клиент лишь сообщает набор нажатых кнопок.
  const setControl = (thrust, brake, turnLeft, turnRight) =>
    post('api/ship/control', { thrust, brake, turnLeft, turnRight });
  // boost — кнопка УСКОРИТЬ/МЕДЛЕННЕЕ (client/ship.html): "kick" разовый
  // импульс, "engage"/"disengage" защёлкивает/снимает устойчивый форсаж на
  // гелии (server/ship.go SetBoost/Kick). charge — кнопка ЗАРЯДИТЬ, сжигает
  // металлический водород в заряд аккумуляторов (server/ship.go Charge).
  const boost = (action) => post('api/ship/boost', { action });
  const charge = () => post('api/ship/charge');
  // jettison/pickup — окно осмотра корабля (client/ship.html): выбросить
  // груз из трюма в космос / подобрать груз с клети, где сейчас корабль
  // (server/cargo.go). jettison отвечает голым ShipView (post()), pickup —
  // {picked,ship} (своя обёртка, как activateFleet/debugDamage).
  const jettison = (key, amount) => post('api/ship/jettison', { key, amount });
  async function pickup(){
    const data = await postJSON('api/ship/pickup', null);
    setShip(data.ship);
    notify();
    return data.picked;
  }
  // cargoBoxesAt — коробки с грузом в звёздной системе (без кеша — окно
  // осмотра корабля запрашивает по факту открытия/подбора, не на каждый
  // секундный опрос всего сектора).
  async function cargoBoxesAt(starId){
    const res = await fetch(`api/cargo-boxes?starId=${starId}`, {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // activateFleet — переключить активный флот (реальное переключение, не
  // локальный просмотр — см. client/galaxy.html). Отвечает {fleets,ship}, не
  // голым ShipView, поэтому не через post().
  async function activateFleet(id){
    const data = await postJSON('api/fleets/activate', { id });
    setShip(data.ship);
    state.fleets = data.fleets;
    notify();
    return data;
  }
  // debugDamage — служебное действие (настоящего боя/столкновений ещё нет,
  // ТЗ.md §2.7.5 — только текст): случайный урон случайной палубе активного
  // корабля, чтобы показать заполнение HP-чекбоксов на скелете (ship.html).
  async function debugDamage(){
    const data = await postJSON('api/ship/debug-damage', null);
    setShip(data.ship);
    notify();
    return data.deck;
  }

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

  // estimateTravel — предпросчёт полёта ДО нажатия «лететь» (server/ship.go
  // EstimateTravel): время и расход топлива для цели, ничего не меняя в
  // состоянии корабля. GET, без кеша — вызывается при каждом выборе цели на
  // радаре (client/ship.html), результат сиюминутный (по прямому требованию
  // пользователя — оценка должна быть видна ПЕРЕД полётом).
  async function estimateTravel(kind, starId, planetIndex = 0){
    const res = await fetch(`api/ship/eta?kind=${kind}&starId=${starId}&planetIndex=${planetIndex}`, {cache:'no-store'});
    const text = await res.text();
    if(!res.ok) throw new Error(text || ('HTTP ' + res.status));
    return JSON.parse(text);
  }

  return {
    FACTIONS, PLANET_TYPES, SURFACE_TYPES, BUILDING_TYPES, STAR_COLORS, STAR_NAMES, RESOURCES, SCALE, SEC_PER_MONTH, SCREEN_UE,
    state, subscribe, refresh, start,
    gameMonths, clock,
    planetPos, shipPos, shipSectorPos, shipHeadingDeg, shipSpeed, transitState, transitPointAt, transitPositionAt, timeFactor,
    orbitalPeriodHours, formatPeriod, planetMass, planetGravity, planetInfoGrid,
    starLabel, starColor, planetLabel, planetColor,
    navigate, land, launch, setControl, activateFleet, debugDamage, planetSurfaceDetail, estimateTravel,
    boost, charge, jettison, pickup, cargoBoxesAt,
  };
})();
