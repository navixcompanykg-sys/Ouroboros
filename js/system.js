// Экран «Звёздная система»: отрисовка, ввод (мышь + тач), корабль.
(() => {
  const cvs = document.getElementById('view');
  const ctx = cvs.getContext('2d');
  const $ = id => document.getElementById(id);

  let sys, ship, simT = 0, selected = null;
  const cam = createViewport(cvs, {
    onTap: (x, y) => handleTap(x, y),
    onPanStart: () => setFollow(false),
    minZoom: () => (Math.min(cam.W, cam.H) * 0.46) / sys.radius, // вся система в экран — дальше не отдаляем
    maxZoom: () => 40,
    panLimit: () => cam.follow && ship ? Math.max(sys.radius, Math.hypot(ship.x, ship.y) + 10) : sys.radius, // внутри системы; за кораблём — и за край
  });
  const toScreen = cam.toScreen, toWorld = cam.toWorld;
  let bgStars = [], belt = [], nebula = [];

  // ---------- Мир ----------
  function planetPos(p, t) {
    const ang = p.phase + p.omega * t;
    return { x: Math.cos(ang) * p.a, y: Math.sin(ang) * p.a };
  }
  function planetVel(p, t) {
    const ang = p.phase + p.omega * t;
    return { x: -Math.sin(ang) * p.a * p.omega, y: Math.cos(ang) * p.a * p.omega };
  }

  function loadSystem(gstar) {
    sys = generateSystem(gstar);
    bhParticles = null;
    simT = 0;
    selected = null;
    const rng = mulberry32(gstar.seed ^ 0x9e3779b9);
    bgStars = Array.from({ length: 450 }, () => ({
      x: rng(), y: rng(), s: rng() * 1.3 + 0.2, a: rng() * 0.7 + 0.2,
    }));
    const beltPlanet = sys.planets.find(p => p.type === 'asteroid');
    belt = beltPlanet ? Array.from({ length: 420 }, () => ({
      r: beltPlanet.a + (rng() - 0.5) * 2 * beltPlanet.beltHalfWidth, ang: rng() * Math.PI * 2, s: rng() * 1.4 + 1,
    })) : [];
    // Форма каждого астероида — своим rng от seed системы (броски выше не сдвигаются): неровный
    // многоугольник на 5–9 вершин, часть вытянуты; размер — мировые ед. (много мелких, мало крупных),
    // медленное вращение, оттенок серо-бурый (пользователь: «крупнее, чтоб узнавались разные формы»).
    const srng = mulberry32(hashSeed(gstar.seed) ^ 0xa57e);
    for (const b of belt) {
      const n = 5 + Math.floor(srng() * 5), stretch = 1 + srng() * srng() * 1.2;
      let prev = 0.75 + srng() * 0.25;
      b.pts = Array.from({ length: n }, (_, i) => {
        prev = Math.max(0.55, Math.min(1, prev + (srng() - 0.5) * 0.45)); // соседние вершины — похожей длины
        const a = (i + srng() * 0.6) / n * Math.PI * 2;
        return [Math.cos(a) * prev * stretch, Math.sin(a) * prev];
      });
      b.size = 0.15 + 0.85 * srng() ** 2.5;      // радиус, мировые ед.
      b.rot = srng() * Math.PI * 2; b.spin = (srng() - 0.5) * 0.8;
      const t = 150 + Math.floor(srng() * 60);
      b.col = [t, t - 10 - Math.floor(srng() * 20), t - 25 - Math.floor(srng() * 25)];
      b.craters = Array.from({ length: 2 + Math.floor(srng() * 2) }, () => [(srng() - 0.5) * 0.9, (srng() - 0.5) * 0.9, 0.08 + srng() * 0.12]);
    }
    const palette = ['#7a4cff', '#ff4f9a', '#3fb6ff', '#5fffc0'];
    nebula = sys.star.type.key !== 'nebula' ? [] : Array.from({ length: 16 }, () => {
      const ang = rng() * Math.PI * 2, d = Math.sqrt(rng()) * sys.radius * 1.2;
      return { x: Math.cos(ang) * d, y: Math.sin(ang) * d, r: sys.radius * (0.25 + rng() * 0.45),
        color: palette[Math.floor(rng() * palette.length)], a: 0.08 + rng() * 0.1 };
    });

    // Корабль стартует на орбите случайной планеты, где можно сесть.
    const landable = sys.planets.filter(p => PLANET_TYPES[p.type].landable);
    // Корабль — там, где его оставили (World.ship), иначе на орбите случайной планеты, где можно сесть.
    const saved = World.ship();
    const pick = landable.length ? landable[Math.floor(rng() * landable.length)] : sys.planets[0];
    const home = saved && sys.planets[saved.planet] ? sys.planets[saved.planet] : pick;
    const startLanded = !!(saved && saved.landed && PLANET_TYPES[home.type].landable);
    const pp = planetPos(home, 0);
    ship = {
      x: pp.x + home.orbitR, y: pp.y, vx: 0, vy: 0, heading: -Math.PI / 2,
      state: startLanded ? 'landed' : 'orbit', planet: home, target: null, orbitAng: 0, orbitRad: home.orbitR,
      anim: 0, thrust: false, trail: [], pending: null, eco: null,
      maxSpeed: SHIP_LIGHT, ...shipFromDesign(),
    };
    selected = home;

    fitCamera();
    cam.follow = false; // после прыжка — обзор всей системы; «Корабль» включает слежение
    $('h-ship').textContent = shipStatus();
    renderHud();
    renderCard(true);
  }

  // Корабль игрока — дизайн из конструктора: разгон, запас Δv, имя.
  function shipFromDesign() {
    const d = findDesign(World.design()), st = shipStats(d);
    const fuelMax = st.dv, frac = World.fuel();
    return { design: d.name, stats: st, accel: st.accel, fuelMax, fuel: isFinite(fuelMax) ? fuelMax * frac : Infinity };
  }

  // ---------- Камера ----------
  function fitCamera() {
    cam.zoom = (Math.min(cam.W, cam.H) * 0.46) / sys.radius;
    cam.x = 0; cam.y = 0; cam.zoomGoal = 0;
  }

  // ---------- Корабль ----------
  // Вспышки сверхсветового скачка (мировые координаты): out — уход в скачок, иначе выход из него.
  const flashes = [], FLASH_T = 0.7;
  // Угловая скорость корабля на орбите парковки, рад/с: виток ≈ 30 с (было 0,9 — виток за 7 с,
  // пользователь: «крутится очень быстро»). Орбита парковки условная, не по Кеплеру.
  const PARK_ORBIT_W = 0.2;
  // Уход с орбиты и захват на орбиту — плавные (пользователь: «корабль как останавливается и
  // начинает лететь»): настоящий импульс длится доли секунды, но орбита парковки нарисована в
  // тысячи раз крупнее настоящей, и мгновенная смена скорости выглядит остановкой. За ESC_T с
  // скорость корабля переходит от кружения вокруг планеты к скорости дуги (и обратно у цели).
  const ESC_T = 1.5, CAP_T = 1.5;
  const smooth = k => k * k * (3 - 2 * k);
  const ORBIT_W_ACC = 0.25; // рад/с² — предел изменения угловой скорости кружения
  const shipPlanetBusy = () => ['landing', 'landed', 'takeoff'].includes(ship.state);

  // ---------- Приказ «лететь» ----------
  // Два режима (выбор пользователя): 'fast' — тяга всё время, разгон до скорости света и скачок;
  // 'eco' — короткий импульс, дальше по инерции по дуге под притяжением звезды (orbit.js planEco),
  // с ожиданием окна старта и гравманёвром, если он выгоднее. Разгон и топливо — у корабля игрока
  // (конструктор, ships.js shipStats): топливо — запас Δv; Infinity — двигатели кормит реактор.
  let flightMode = (() => { try { return localStorage.getItem('ouro.v3.mode') || 'eco'; } catch (_) { return 'eco'; } })();
  let notice = '', noticeT = 0; // короткое сообщение в строке состояния (нет топлива и т. п.)
  const say = msg => { notice = msg; noticeT = 4; };
  const orbitWorld = () => ({ mu: MU_SUN * sys.star.mass, excl: sys.star.excl, planets: sys.planets, pos: planetPos, vel: planetVel });
  const ecoStart = () => ship.state === 'orbit' ? { planet: ship.planet }
    : { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, moving: ship.state !== 'idle' };

  function orderFlyTo(target, mode = flightMode) {
    ship.jumpIn = false;
    // target: {planet} или {x, y}
    if (ship.state === 'landed') { ship.pending = { target, mode }; startTakeoff(); return; }
    if (ship.state === 'landing' || ship.state === 'takeoff') { ship.pending = { target, mode }; return; }
    if (target.planet && ship.state === 'orbit' && ship.planet === target.planet) return;
    if (mode === 'eco') {
      const plan = planEco(orbitWorld(), ecoStart(), target, simT);
      if (!plan) { say('Дугу к цели не найти — попробуйте быстрый режим'); return; }
      if (plan.dv > ship.fuel) { say(`Не хватит топлива: нужно ${fmtDv(plan.dv)}, есть ${fmtDv(ship.fuel)}`); return; }
      plan.target = target; plan.leg = 0; plan.phase = 'wait'; plan.nextFix = 0;
      setArrivalOffset(plan);
      ship.eco = plan;
      if (ship.state !== 'orbit' && ship.state !== 'idle') launchEco(); // в полёте — сразу
    } else {
      if (!(ship.accel > 0)) { say('У корабля нет двигателей — лететь нечем'); return; }
      const est = estimateFast(target);
      if (est.fuel > ship.fuel) { say(`Не хватит топлива: нужно ${fmtDv(est.fuel)}, есть ${fmtDv(ship.fuel)}`); return; }
      ship.eco = null;
      ship.state = 'flying';
      World.setShip(null);
      ship.planet = target.planet || null;
      ship.target = target.planet ? null : { x: target.x, y: target.y };
    }
    setFollow(true);
    // Камера отъезжает, чтобы в кадре были и корабль, и цель (у дуги — вся дуга).
    const pts = ship.eco ? ship.eco.path : [target.planet ? planetPos(target.planet, simT) : target];
    let far = 1;
    for (const p of pts) far = Math.max(far, Math.hypot(p.x - ship.x, p.y - ship.y));
    if (cam.follow) cam.zoomGoal = Math.min(cam.zoom, (Math.min(cam.W, cam.H) * 0.42) / far);
    renderCard(true);
  }
  function startLanding() {
    if (ship.state !== 'orbit' || !PLANET_TYPES[ship.planet.type].landable) return;
    ship.eco = null;
    ship.state = 'landing'; ship.anim = 0; renderCard();
  }
  function startTakeoff() {
    if (ship.state !== 'landed') return;
    ship.state = 'takeoff'; ship.anim = 0; renderCard();
  }
  const fmtDv = dv => `${(dv * KMS_PER_UNIT).toFixed(dv * KMS_PER_UNIT < 100 ? 1 : 0).replace('.', ',')} км/с`;
  function useFuel(dv) {
    if (!isFinite(ship.fuelMax)) return;
    ship.fuel = Math.max(0, ship.fuel - dv); World.setFuel(ship.fuelMax ? ship.fuel / ship.fuelMax : 0);
  }

  // Путевая точка обхода звезды: если отрезок «корабль → цель» проходит
  // через запретный радиус, ведём корабль через точку сбоку от звезды.
  // Пересчитывается каждый кадр, поэтому огибание получается плавным.
  function avoidStar(fx, fy, tx, ty) {
    const ex = sys.star.excl;
    const dx = tx - fx, dy = ty - fy, len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return null;
    const t = Math.max(0, Math.min(1, (-fx * dx - fy * dy) / len2));
    const cx = fx + dx * t, cy = fy + dy * t;
    const cd = Math.hypot(cx, cy);
    if (cd >= ex * 1.15 || t <= 0 || t >= 1) return null;
    let nx = cx, ny = cy, n = cd;
    if (n < 1e-3) { nx = -dy; ny = dx; n = Math.sqrt(len2); }
    const k = (ex * 1.6) / n;
    return { x: nx * k, y: ny * k };
  }

  // Гравитация в точке — настоящие μ звезды и планет (data.js MU_SUN, gen.js planetPhysics), 1/r².
  // Ближе настоящего радиуса тела не считаем (там была бы поверхность); сумма ограничена
  // 2 × тяги — страховка от рывка, если быстрый полёт пройдёт сквозь центр планеты.
  function gravityAt(x, y, t) {
    let gx = 0, gy = 0;
    const add = (bx, by, mu, rMin) => {
      const dx = bx - x, dy = by - y, r = Math.max(rMin, Math.hypot(dx, dy)), g = mu / (r * r);
      gx += dx / r * g; gy += dy / r * g;
    };
    add(0, 0, MU_SUN * sys.star.mass, sys.star.excl);
    for (const p of sys.planets) { const pp = planetPos(p, t); add(pp.x, pp.y, p.mu, p.rReal); }
    const g = Math.hypot(gx, gy), cap = 2 * ship.accel;
    if (g > cap) { gx *= cap / g; gy *= cap / g; }
    return { x: gx, y: gy };
  }

  // Один шаг быстрого полёта — общий для живого корабля и прикидки (estimateFast).
  // f = {x, y, vx, vy, accel, maxSpeed, planet | target}. Пишет в f тягу (th, thx, thy) и
  // расход топлива fuelUsed (Δv = ∫тяга dt). Возвращает 'arrived', {jump: {x, y, h, R}} или undefined.
  function flightStep(f, t, dt) {
    let tx, ty, tvx = 0, tvy = 0, stop = 0;
    if (f.planet) {
      const pp = planetPos(f.planet, t), pv = planetVel(f.planet, t);
      tx = pp.x; ty = pp.y; tvx = pv.x; tvy = pv.y; stop = f.planet.orbitR;
    } else { tx = f.target.x; ty = f.target.y; }

    const dist = Math.hypot(tx - f.x, ty - f.y);
    let ax = tx, ay = ty, remain = Math.max(0, dist - stop);
    const way = avoidStar(f.x, f.y, tx, ty);
    if (way) {
      ax = way.x; ay = way.y;
      remain = Math.hypot(way.x - f.x, way.y - f.y) + Math.hypot(tx - way.x, ty - way.y) - stop;
      tvx = tvy = 0;
    }

    // Сверхсветовой скачок: корабль разогнался до скорости света (f.maxSpeed), а до цели
    // дальше, чем путь торможения со световой, — он исчезает и сразу появляется на расстоянии
    // торможения от цели (со стороны, откуда летел; при обходе звезды — со стороны путевой
    // точки) с той же скоростью и дальше тормозит обычным профилем. Ближе — обычный полёт.
    const brake = f.maxSpeed * f.maxSpeed / (2 * f.accel * 0.85); // тот же запас 0.85, что в vWant
    if (Math.hypot(f.vx - tvx, f.vy - tvy) >= f.maxSpeed * 0.98 && remain > brake * 1.2) {
      const fx = way ? way.x : f.x, fy = way ? way.y : f.y;
      const fd = Math.hypot(fx - tx, fy - ty) || 1, R = stop + brake;
      const nx = (fx - tx) / fd, ny = (fy - ty) / fd;
      const jump = { x: f.x, y: f.y, h: Math.atan2(f.vy - tvy, f.vx - tvx), R };
      f.x = tx + nx * R; f.y = ty + ny * R;
      f.vx = tvx - nx * f.maxSpeed; f.vy = tvy - ny * f.maxSpeed;
      f.heading = Math.atan2(-ny, -nx);
      f.th = 0;
      return { jump };
    }

    const ad = Math.hypot(ax - f.x, ay - f.y) || 1, ux = (ax - f.x) / ad, uy = (ay - f.y) / ad;
    const g = gravityAt(f.x, f.y, t);
    // Профиль «разгон — крейсер — торможение»: скорость не больше той, с которой ещё
    // успеваем остановиться на оставшемся пути. Гравитация, тянущая вперёд (к цели),
    // съедает часть тормозной тяги — учитываем её в запасе торможения.
    const gPull = Math.max(0, g.x * ux + g.y * uy);
    const brakeA = Math.max(f.accel * 0.1, f.accel * 0.85 - gPull);
    const vWant = Math.min(f.maxSpeed, Math.sqrt(2 * brakeA * remain));
    const dvx = tvx + ux * vWant - f.vx, dvy = tvy + uy * vWant - f.vy;
    // Тяга — то, что нужно для желаемой скорости, за вычетом того, что даёт гравитация; не больше f.accel.
    let thx = dvx / dt - g.x, thy = dvy / dt - g.y;
    const th = Math.hypot(thx, thy);
    if (th > f.accel) { thx *= f.accel / th; thy *= f.accel / th; }
    f.vx += (thx + g.x) * dt; f.vy += (thy + g.y) * dt;
    // Скорость света — предел (относительно цели).
    const rv = Math.hypot(f.vx - tvx, f.vy - tvy);
    if (rv > f.maxSpeed) { f.vx = tvx + (f.vx - tvx) * f.maxSpeed / rv; f.vy = tvy + (f.vy - tvy) * f.maxSpeed / rv; }
    f.th = Math.min(th, f.accel); f.thx = thx; f.thy = thy;
    f.fuelUsed = (f.fuelUsed || 0) + f.th * dt;
    f.x += f.vx * dt; f.y += f.vy * dt;
    // Не пускаем корабль внутрь запретного радиуса звезды.
    const sd = Math.hypot(f.x, f.y), ex = sys.star.excl;
    if (sd < ex) { f.x *= ex / sd; f.y *= ex / sd; }

    const rel = Math.hypot(f.vx - tvx, f.vy - tvy);
    if (f.planet) { if (dist < stop * 1.6 && rel < Math.max(3, stop * PARK_ORBIT_W * 2)) return 'arrived'; }
    else if (remain < 1.5 && rel < 6) return 'arrived';
  }

  // Прикидка быстрого полёта тем же flightStep: время и топливо. Взлёт с орбиты — с её скоростью.
  function estimateFast(target) {
    const f = { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, accel: ship.accel, maxSpeed: ship.maxSpeed,
      planet: target.planet || null, target: target.planet ? null : target, fuelUsed: 0 };
    const DT = 0.1;
    for (let t = 0; t < 600; t += DT) if (flightStep(f, simT + t, DT) === 'arrived') return { t, fuel: f.fuelUsed };
    return { t: Infinity, fuel: f.fuelUsed };
  }

  // ---------- Экономный полёт по дуге ----------
  // Конец текущего участка дуги: планета (её место в момент tb) или точка.
  // Конец дуги к планете — не её центр, а точка орбиты парковки со стороны подлёта (endOff):
  // планета нарисована в тысячи раз крупнее настоящей, и в центр корабль влетел бы сквозь диск,
  // а в орбиту парковки входил бы задолго до встречи.
  function legEnd(L) {
    if (!L.end) return L.r2;
    const p = planetPos(L.end, L.tb);
    return L.endOff ? { x: p.x + L.endOff.x, y: p.y + L.endOff.y } : p;
  }
  function setArrivalOffset(e) {
    const L = e.legs[e.legs.length - 1];
    if (!L.end || !L.v2) return;
    const pv = planetVel(L.end, L.tb), vx = L.v2.x - pv.x, vy = L.v2.y - pv.y, v = Math.hypot(vx, vy) || 1;
    L.endOff = { x: -vx / v * L.end.orbitR, y: -vy / v * L.end.orbitR }; // откуда корабль приходит к планете
  }
  // Старт: импульс с низкой орбиты (Δv с выигрышем Оберта — уже в плане) или из точки.
  // Дугу пересчитываем от настоящего места корабля (он на орбите парковки, не в центре планеты).
  function launchEco() {
    const e = ship.eco, L = e.legs[0];
    const tof = Math.max(0.5, L.tb - simT);
    const sol = lambert({ x: ship.x, y: ship.y }, legEnd(L), tof, MU_SUN * sys.star.mass);
    const v = sol ? sol.v1 : L.v1;
    e.esc = { t: 0, v0: { x: ship.vx, y: ship.vy }, v1: { x: v.x, y: v.y } }; // скорость сменится плавно (updateCoast)
    useFuel(e.dvDep);
    e.phase = 'coast'; e.nextFix = simT + 2;
    ship.state = 'coast'; ship.planet = null; ship.target = null;
    World.setShip(null);
    ship.burnT = 0.6; ship.heading = Math.atan2(v.y, v.x);
    renderCard(true);
  }
  // Полёт по инерции + коррекции: раз в 2 с дуга до конца участка пересчитывается от текущего
  // места, разница скоростей — маленький импульс (тоже топливо). Конец участка — гравманёвр или прибытие.
  function updateCoast(dt) {
    const s = ship, e = s.eco, L = e.legs[e.leg], mu = MU_SUN * sys.star.mass;
    if (e.esc) { // уход с орбиты: скорость от кружения к скорости дуги
      e.esc.t += dt;
      const k = smooth(Math.min(1, e.esc.t / ESC_T));
      s.vx = e.esc.v0.x + (e.esc.v1.x - e.esc.v0.x) * k; s.vy = e.esc.v0.y + (e.esc.v1.y - e.esc.v0.y) * k;
      s.x += s.vx * dt; s.y += s.vy * dt;
      turnTo(Math.atan2(s.vy, s.vx), dt * 2);
      // Дальше — коррекция дуги от места, где закончился переход; она — часть того же импульса
      // ухода (уже учтён в dvDep), топливо за неё не берём.
      if (e.esc.t >= ESC_T) { e.esc = null; e.nextFix = simT; e.freeFix = true; }
      return;
    }
    propagate(s, dt, mu);
    const end = legEnd(L);
    if (L.end && !L.flyby) { // прибытие к планете — захват, как только вошли в орбиту парковки
      const pp = planetPos(L.end, simT);
      // Захват — при входе в орбиту парковки, если скорость относительно планеты близка к плановой
      // (v∞ дуги): случайный ранний пролёт рядом с планетой идёт на чужой скорости, и захват на ней
      // стоил бы втрое дороже плана. Целиться в центр до конца нельзя — корабль влетит в диск планеты.
      const pv = planetVel(L.end, simT), vinf = L.v2 ? Math.hypot(L.v2.x - planetVel(L.end, L.tb).x, L.v2.y - planetVel(L.end, L.tb).y) : 0;
      const rel = Math.hypot(s.vx - pv.x, s.vy - pv.y);
      if ((Math.hypot(pp.x - s.x, pp.y - s.y) < L.end.orbitR * 1.1 && rel < vinf * 1.5 + 0.5 && simT > L.tb - 3) || simT >= L.tb) return arriveEco();
    } else if (simT >= L.tb) {
      if (L.flyby) return flybyEco();
      return arriveEco();
    }
    if (simT >= e.nextFix && L.tb - simT > 1.5) {
      e.nextFix = simT + 2;
      const sol = lambert({ x: s.x, y: s.y }, end, L.tb - simT, mu);
      if (sol) {
        const dv = Math.hypot(sol.v1.x - s.vx, sol.v1.y - s.vy);
        if (dv > 1e-6) {
          s.vx = sol.v1.x; s.vy = sol.v1.y;
          if (!e.freeFix) { useFuel(dv); e.fixDv = (e.fixDv || 0) + dv; }
        }
        e.freeFix = false;
      }
    }
    s.heading = Math.atan2(s.vy, s.vx);
  }
  // Пролёт у планеты: притяжение поворачивает скорость бесплатно (в пределах δmax), остальное —
  // двигатель (flybyDv). Дальше — следующий участок дуги.
  function flybyEco() {
    const s = ship, e = s.eco, B = e.legs[e.leg].end, next = e.legs[e.leg + 1];
    const bp = planetPos(B, simT), bv = planetVel(B, simT);
    s.x = bp.x; s.y = bp.y; // настоящая планета крошечная — мы в её центре с точностью дуги
    const sol = lambert({ x: s.x, y: s.y }, legEnd(next), Math.max(0.5, next.tb - simT), MU_SUN * sys.star.mass);
    const vout = sol ? sol.v1 : next.v1;
    const dv = flybyDv({ x: s.vx - bv.x, y: s.vy - bv.y }, { x: vout.x - bv.x, y: vout.y - bv.y }, B);
    s.vx = vout.x; s.vy = vout.y; useFuel(dv);
    flashes.push({ x: s.x, y: s.y, t: 0, out: false, sling: true });
    e.leg++; e.nextFix = simT + 2;
  }
  function arriveEco() {
    const s = ship, e = s.eco, tp = e.target.planet;
    if (tp) {
      // Захват — по плану (Оберт для v∞ дуги «центр в центр»), как и взлёт: подлёт к нарисованной
      // орбите парковки (она в тысячи раз крупнее настоящей) меняет скорость — это не физика.
      useFuel(e.dvArr);
      s.eco = null; s.burnT = 0.6;
      enterOrbit(tp);
    } else {
      useFuel(Math.hypot(s.vx, s.vy));
      s.vx = s.vy = 0; s.eco = null; s.state = 'idle'; s.burnT = 0.6; renderCard(true);
    }
  }

  // ---------- Подгазовка (ручная тяга) ----------
  // Кнопка «Газ» на экране и клавиша W: пока зажаты, двигатель тянет по носу корабля (жжёт топливо),
  // автопилот на это время уступает. Отпустили — автопилот НЕ выключен (пользователь): он пересчитывает
  // курс к той же цели от нового места и скорости, в том же режиме (дуга не нашлась — быстрым).
  // Цель: планета/точка полёта, а если корабль стоял на орбите — эта же планета (вернуться на орбиту).
  // Цели не было (дрейф) — летит дальше по инерции.
  // throttle: 0 — двигатель молчит, 1 — газ (W) по носу, −1 — тормоз (S) против скорости (до остановки).
  let throttle = 0, resume = null;
  function setThrottle(mode) {
    if (mode === throttle) return;
    const st = ship.state, was = throttle;
    if (mode && (st === 'landed' || st === 'landing' || st === 'takeoff')) return;
    throttle = mode;
    $('b-gas').classList.toggle('on', mode === 1);
    $('b-brake').classList.toggle('on', mode === -1);
    if (mode && !was) {
      resume = ship.eco ? { target: ship.eco.target, mode: 'eco' }
        : st === 'flying' ? { target: ship.planet ? { planet: ship.planet } : { ...ship.target }, mode: 'fast' }
        : st === 'orbit' ? { target: { planet: ship.planet }, mode: flightMode }
        : null;
      ship.eco = null;
      if (st === 'orbit') World.setShip(null);
      ship.state = 'adrift'; ship.planet = null; ship.target = null; ship.capturing = false;
      if (Math.hypot(ship.vx, ship.vy) > 1e-3) ship.heading = Math.atan2(ship.vy, ship.vx);
      setFollow(true);
      renderCard(true);
    } else if (!mode && resume && ship.state === 'adrift') {
      const r = resume; resume = null;
      orderFlyTo(r.target, r.mode);
      if (ship.state === 'adrift' && r.mode === 'eco') orderFlyTo(r.target, 'fast'); // дуги нет — быстрым
    }
  }

  // ---------- Межзвёздный перелёт ----------
  // Только время разгона (пользователь): корабль разгоняется к выбранной звезде (направление — по карте
  // галактики) до скорости света, уходит в скачок и сразу оказывается в системе назначения — на расстоянии
  // торможения от цели, со скоростью света, со стороны, откуда летел. Цель — планета, выбранная на карте
  // галактики, или звезда: тогда корабль тормозит к ней, а планету игрок укажет на месте (кнопки карточки
  // перестраивают курс на ходу). Расстояние торможения со скорости света — десятки тысяч а. е., поэтому
  // корабль приходит из глубокого космоса, а камера, следящая за ним, может уйти за край системы.
  const WARP_STAR_STOP = 3 * AU; // без выбранной планеты — остановка в 3 а. е. от звезды, со стороны подлёта
  function startWarp(id, dest) {
    const to = World.galaxy().stars[id], from = sys.gstar;
    if (!to || to.id === from.id) return;
    if (['landed', 'landing', 'takeoff'].includes(ship.state)) { say('Сначала взлетите с планеты'); return; }
    if (!(ship.accel > 0)) { say('У корабля нет двигателей — лететь нечем'); return; }
    if (isFinite(ship.fuelMax) && ship.fuel < 2 * SHIP_LIGHT) { say(`Не хватит топлива: нужно ${fmtDv(2 * SHIP_LIGHT)}, есть ${fmtDv(ship.fuel)}`); return; }
    let dx = to.x - from.x, dy = to.y - from.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    ship.eco = null;
    if (ship.state === 'orbit') World.setShip(null);
    ship.state = 'warpout'; ship.planet = null; ship.target = null; ship.capturing = false;
    ship.warp = { id, dest, dx, dy, name: to.name };
    setFollow(true);
    renderCard(true);
  }
  function jumpOut() {
    const s = ship, w = s.warp;
    flashes.push({ x: s.x, y: s.y, t: 0, out: true, h: Math.atan2(w.dy, w.dx) });
    s.hidden = 1e9; s.state = 'jumping';
    World.setArrival({ dx: w.dx, dy: w.dy, dest: w.dest ?? null, from: sys.gstar.id });
    World.setCurrent(w.id);
    screenFade(1, 500);
    setTimeout(() => { location.href = World.systemUrl(w.id) + '&jumpin=1'; }, 600);
  }
  // Выход из скачка в этой системе (по ?jumpin=1 и World.takeArrival()).
  function jumpIn(a) {
    const s = ship, c = SHIP_LIGHT, dx = a.dx, dy = a.dy;
    const dest = a.dest != null && sys.planets[a.dest] ? sys.planets[a.dest] : null;
    const brake = c * c / (2 * s.accel * 0.85);                  // тот же запас, что у автопилота
    let tx, ty, tvx = 0, tvy = 0, stop;
    if (dest) { const pp = planetPos(dest, simT), pv = planetVel(dest, simT); tx = pp.x; ty = pp.y; tvx = pv.x; tvy = pv.y; stop = dest.orbitR; }
    else { tx = -dx * WARP_STAR_STOP; ty = -dy * WARP_STAR_STOP; stop = 0; }
    s.x = tx - dx * (stop + brake); s.y = ty - dy * (stop + brake);
    s.vx = tvx + dx * c; s.vy = tvy + dy * c; s.heading = Math.atan2(dy, dx);
    s.eco = null; s.capturing = false; s.trail = [];
    s.state = 'flying'; s.planet = dest; s.target = dest ? null : { x: tx, y: ty };
    s.jumpIn = true;
    World.setShip(null);
    flashes.push({ x: s.x, y: s.y, t: 0, out: false });
    selected = dest;
    setFollow(true);
    renderCard(true);
  }

  function updateShip(dt) {
    const s = ship;
    s.thrust = false;
    if (s.hidden > 0) s.hidden -= dt;
    if (s.burnT > 0) { s.burnT -= dt; s.thrust = true; }
    if (noticeT > 0) noticeT -= dt;
    flashes.forEach(f => { f.t += dt; });
    while (flashes.length && flashes[0].t > FLASH_T) flashes.shift();
    // Ожидание окна старта экономного полёта (на орбите или в дрейфе).
    if (s.eco && s.eco.phase === 'wait' && simT >= s.eco.legs[0].ta && (s.state === 'orbit' || s.state === 'idle')) launchEco();

    if (s.state === 'warpout') {
      // Разгон к звезде назначения: полная тяга по направлению на неё, до скорости света — скачок.
      const w = s.warp;
      turnTo(Math.atan2(w.dy, w.dx), dt);
      s.vx += w.dx * s.accel * dt; s.vy += w.dy * s.accel * dt;
      const v = Math.hypot(s.vx, s.vy);
      if (v > s.maxSpeed) { s.vx *= s.maxSpeed / v; s.vy *= s.maxSpeed / v; }
      useFuel(s.accel * dt);
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.thrust = true;
      if (v >= s.maxSpeed * 0.98) jumpOut();
    }
    else if (s.state === 'coast') updateCoast(dt);
    else if (s.state === 'adrift') {
      // Ручной полёт: по инерции под притяжением звезды; пока зажат «Газ» (кнопка / W) — тяга по носу.
      if (throttle && s.fuel > 0 && s.accel > 0) {
        const v0 = Math.hypot(s.vx, s.vy);
        let used = s.accel * dt;
        if (throttle > 0) {
          // Газ — вдоль скорости (стоит — по носу); нос — по движению.
          if (v0 > 1e-3) s.heading = Math.atan2(s.vy, s.vx);
          s.vx += Math.cos(s.heading) * used; s.vy += Math.sin(s.heading) * used;
          const v = Math.hypot(s.vx, s.vy);
          if (v > s.maxSpeed) { s.vx *= s.maxSpeed / v; s.vy *= s.maxSpeed / v; }
        } else if (v0 > 0) {
          used = Math.min(used, v0);                    // тормоз: против скорости, до остановки
          s.vx -= s.vx / v0 * used; s.vy -= s.vy / v0 * used;
          s.heading = Math.atan2(-s.vy, -s.vx); // развернулся: нос против движения, струя — вперёд
        } else used = 0;
        if (used > 0) { useFuel(used); s.thrust = true; }
      }
      propagate(s, dt, MU_SUN * sys.star.mass);
    }
    else if (s.state === 'flying') {
      if (s.fuel <= 0) { s.state = 'adrift'; say('Топливо кончилось — корабль летит по инерции'); renderCard(true); return; }
      const before = s.fuelUsed || 0;
      const ev = flightStep(s, simT, dt);
      useFuel((s.fuelUsed || 0) - before);
      if (ev && ev.jump) {
        flashes.push({ x: ev.jump.x, y: ev.jump.y, t: 0, out: true, h: ev.jump.h });
        flashes.push({ x: s.x, y: s.y, t: 0, out: false });
        s.trail = []; s.hidden = 0.25;
        if (cam.follow) cam.zoomGoal = (Math.min(cam.W, cam.H) * 0.4) / ev.jump.R;
        return;
      }
      s.thrust = s.th > s.accel * 0.05;
      // Нос корабля — по направлению тяги (при торможении разворачивается).
      if (s.th > s.accel * 0.02) turnTo(Math.atan2(s.thy, s.thx), dt);
      if (ev === 'arrived') {
        if (s.planet) enterOrbit(s.planet);
        else { s.vx = s.vy = 0; s.state = 'idle'; s.target = null; renderCard(); }
      }
    } else if (s.state === 'orbit' || s.state === 'landing' || s.state === 'landed' || s.state === 'takeoff') {
      const p = s.planet, pp = planetPos(p, simT), pv = planetVel(p, simT);
      // Высота кружения выходит на орбиту парковки «пружиной» с критическим затуханием: радиальная
      // скорость (при захвате — скорость сближения) гасится плавно, без рывка.
      const OM = 2.5;
      s.orbitRadV = (s.orbitRadV || 0) + (-OM * OM * (s.orbitRad - p.orbitR) - 2 * OM * (s.orbitRadV || 0)) * dt;
      s.orbitRad = Math.max(p.r * 1.15, s.orbitRad + s.orbitRadV * dt);
      // Угловая скорость кружения: на поверхности корабль стоит; при взлёте она плавно растёт от 0
      // до орбитальной, при посадке — падает до 0 (пользователь: «на взлёте постепенно разгоняться»).
      // Кружит корабль в ту сторону, в какую подлетел (orbitDir: +1 — против часовой, −1 — по ней).
      const dir = s.orbitDir || 1, W = dir * PARK_ORBIT_W;
      let w = W;
      if (s.state === 'orbit' && s.eco && s.eco.phase === 'wait') w = phaseRate(s);
      else if (s.state === 'landed') w = 0;
      else if (s.state === 'takeoff') w = W * smooth(s.anim);
      else if (s.state === 'landing') w = W * (1 - smooth(s.anim));
      const cur = s.orbitW ?? w;
      if (s.capturing) {
        // После захвата корабль кружит со скоростью подлёта и плавно замедляется до орбитальной
        // (пользователь: «по прибытии вращается очень быстро — надо замедляться постепенно»).
        s.orbitW = cur + (w - cur) * Math.min(1, dt / CAP_T);
        if (Math.abs(s.orbitW - w) < 0.01) s.capturing = false;
      } else {
        // Угловая скорость меняется не скачком, а с ограниченным ускорением — без рывков скорости.
        const lim = ORBIT_W_ACC * dt;
        s.orbitW = cur + Math.max(-lim, Math.min(lim, w - cur));
      }
      w = s.orbitW;
      s.orbitAng += dt * w;
      const ox = pp.x + Math.cos(s.orbitAng) * s.orbitRad;
      const oy = pp.y + Math.sin(s.orbitAng) * s.orbitRad;
      // Скорость на орбите — скорость планеты + кружение вокруг неё: с ней корабль и уходит.
      const ca = Math.cos(s.orbitAng), sa = Math.sin(s.orbitAng), vr = s.orbitRadV || 0;
      const ovx = pv.x - sa * s.orbitRad * w + ca * vr, ovy = pv.y + ca * s.orbitRad * w + sa * vr;

      if (s.state === 'orbit') {
        s.x = ox; s.y = oy; s.vx = ovx; s.vy = ovy;
        turnTo(s.orbitAng + Math.sign(w || dir) * Math.PI / 2, dt * 2);
      } else {
        // Посадка/взлёт: корабль скользит между орбитой и поверхностью.
        if (s.state === 'landing' || s.state === 'takeoff') s.anim = Math.min(1, s.anim + dt / 1.6);
        let k = s.state === 'landing' ? s.anim : s.state === 'takeoff' ? 1 - s.anim : 1;
        k = k * k * (3 - 2 * k);
        const sx = pp.x + Math.cos(s.orbitAng) * p.r, sy = pp.y + Math.sin(s.orbitAng) * p.r;
        s.x = ox + (sx - ox) * k; s.y = oy + (sy - oy) * k;
        const rr = Math.hypot(s.x - pp.x, s.y - pp.y); // кружение на текущей высоте
        s.vx = pv.x - Math.sin(s.orbitAng) * rr * w; s.vy = pv.y + Math.cos(s.orbitAng) * rr * w;
        turnTo(s.orbitAng + dir * Math.PI / 2 * (1 - k), dt * 3);
        s.thrust = s.state === 'takeoff' || (s.state === 'landing' && s.anim > 0.6);
        if (s.anim >= 1 && s.state === 'landing') {
          s.state = 'landed'; renderCard();
          // Как в v2: после посадки — экран поверхности планеты. На поверхности — заправка (допущение).
          s.fuel = s.fuelMax; World.setFuel(1);
          World.setShip(s.planet.index, true);
          setTimeout(() => { location.href = World.planetUrl(sys.gstar.id, s.planet.index); }, 350);
        }
        else if (s.anim >= 1 && s.state === 'takeoff') {
          s.state = 'orbit'; renderCard();
          World.setShip(s.planet.index, false);
          if (s.pending) { const p = s.pending; s.pending = null; orderFlyTo(p.target, p.mode); }
        }
      }
    }

    // Не пускаем корабль внутрь запретного радиуса звезды.
    const sd = Math.hypot(s.x, s.y);
    if (sd < sys.star.excl) { s.x *= sys.star.excl / sd; s.y *= sys.star.excl / sd; }

    if (s.state === 'flying' || s.state === 'coast' || s.state === 'adrift' || s.state === 'warpout') {
      const last = s.trail[s.trail.length - 1];
      if (!last || Math.hypot(last.x - s.x, last.y - s.y) > 3 / cam.zoom) s.trail.push({ x: s.x, y: s.y });
      if (s.trail.length > 400) s.trail.shift();
    } else if (s.trail.length) s.trail.shift();
  }
  function turnTo(target, dt) {
    let d = target - ship.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const max = 5 * dt;
    ship.heading += Math.max(-max, Math.min(max, d));
  }
  // Пока корабль ждёт окна старта, он подстраивает своё место на орбите парковки: к моменту
  // старта нос (касательная кружения против часовой) смотрит туда, куда уходит дуга, — уход плавный.
  function phaseRate(s) {
    const L = s.eco.legs[0], left = L.ta - simT;
    if (left <= 0) return (s.orbitDir || 1) * PARK_ORBIT_W;
    const pv = planetVel(s.planet, L.ta);
    const dir = s.orbitDir || 1;
    const want = Math.atan2(L.v1.y - pv.y, L.v1.x - pv.x) - dir * Math.PI / 2; // касательная кружения
    let diff = want - (s.orbitAng + dir * PARK_ORBIT_W * left);
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const w = dir * PARK_ORBIT_W + diff / Math.max(2, left);
    return dir * Math.max(0.3 * PARK_ORBIT_W, Math.min(3 * PARK_ORBIT_W, dir * w));
  }

  function enterOrbit(p) {
    const pp = planetPos(p, simT), pv = planetVel(p, simT);
    // Захват: корабль продолжает кружить с угловой скоростью и в сторону подлёта (место и скорость
    // по касательной без скачка), дальше плавно замедляется до орбитальной (capturing, CAP_T).
    const rx = ship.x - pp.x, ry = ship.y - pp.y, r2 = rx * rx + ry * ry || 1;
    const w0 = (rx * (ship.vy - pv.y) - ry * (ship.vx - pv.x)) / r2;
    ship.orbitDir = w0 < 0 ? -1 : 1;
    ship.orbitW = Math.max(-3, Math.min(3, w0));
    ship.orbitRadV = (rx * (ship.vx - pv.x) + ry * (ship.vy - pv.y)) / Math.sqrt(r2); // скорость сближения
    ship.capturing = true;
    ship.state = 'orbit';
    World.setShip(p.index, false);
    ship.planet = p;
    ship.orbitAng = Math.atan2(ship.y - pp.y, ship.x - pp.x);
    ship.orbitRad = Math.hypot(ship.y - pp.y, ship.x - pp.x);
    // На орбите камера приближается к планете.
    if (cam.follow) cam.zoomGoal = (Math.min(cam.W, cam.H) * 0.14) / p.orbitR;
    renderCard();
  }

  // ---------- Отрисовка ----------
  function draw() {
    ctx.setTransform(cam.DPR, 0, 0, cam.DPR, 0, 0);
    drawBackdrop(ctx, cam, bgStars);
    if (showGrid) drawScaleGrid();

    const c = toScreen(0, 0);
    drawNebula();

    // Граница системы — одна для всех звёзд (SYSTEM_RADIUS).
    ctx.save();
    ctx.setLineDash([6, 8]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(140,170,220,0.22)';
    ctx.beginPath(); ctx.arc(c.x, c.y, sys.radius * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // Орбиты.
    ctx.lineWidth = 1;
    for (const p of sys.planets) {
      if (p.type === 'asteroid') continue;
      ctx.strokeStyle = p === selected ? 'rgba(120,180,255,0.45)' : 'rgba(120,150,200,0.16)';
      ctx.beginPath(); ctx.arc(c.x, c.y, p.a * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    }

    // Пояс астероидов.
    const bp = sys.planets.find(p => p.type === 'asteroid');
    if (bp) {
      const w = bp.omega * 0.9;
      for (const b of belt) {
        const ang = b.ang + w * simT;
        const x = c.x + Math.cos(ang) * b.r * cam.zoom, y = c.y + Math.sin(ang) * b.r * cam.zoom;
        const R = b.size * cam.zoom;
        if (x < -R - 5 || y < -R - 5 || x > cam.W + R + 5 || y > cam.H + R + 5) continue;
        const [cr, cg, cb] = b.col;
        if (R < 1.6) { // издалека — точка
          ctx.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
          const d = Math.max(1, R * 1.6); ctx.fillRect(x - d / 2, y - d / 2, d, d);
          continue;
        }
        // Вблизи — неровный камень, освещённый со стороны звезды (тёмная сторона — от неё).
        const rot = b.rot + b.spin * simT, cs = Math.cos(rot), sn = Math.sin(rot);
        // Контур сглажен: кривые через середины рёбер — округлый бугристый камень, а не кристалл.
        const P = b.pts.map(([px, py]) => [x + (px * cs - py * sn) * R, y + (px * sn + py * cs) * R]);
        const mid = (A, B) => [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
        ctx.beginPath();
        let m0 = mid(P[P.length - 1], P[0]); ctx.moveTo(m0[0], m0[1]);
        for (let i = 0; i < P.length; i++) { const m = mid(P[i], P[(i + 1) % P.length]); ctx.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]); }
        ctx.closePath();
        const lx = -Math.cos(ang), ly = -Math.sin(ang); // к звезде
        const g = ctx.createLinearGradient(x + lx * R, y + ly * R, x - lx * R, y - ly * R);
        g.addColorStop(0, `rgb(${cr + 40},${cg + 35},${cb + 30})`); g.addColorStop(0.55, `rgb(${cr - 40},${cg - 40},${cb - 40})`);
        g.addColorStop(1, `rgb(${cr - 110},${cg - 110},${cb - 110})`);
        ctx.fillStyle = g; ctx.fill();
        if (R > 6) {
          ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
          // Кратеры на крупных: 2–3 тёмных пятна, повёрнуты вместе с камнем.
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          for (const [cx0, cy0, cr0] of b.craters) {
            const X = x + (cx0 * cs - cy0 * sn) * R, Y = y + (cx0 * sn + cy0 * cs) * R;
            ctx.beginPath(); ctx.arc(X, Y, cr0 * R, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }

    drawSmallBodies(c);
    drawStar(c);

    // Планеты.
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const p of sys.planets) {
      const pp = planetPos(p, simT), s = toScreen(pp.x, pp.y);
      const r = planetScreenR(p);
      const col = PLANET_TYPES[p.type].colors;
      // Освещённая сторона — к звезде.
      const lx = (c.x - s.x), ly = (c.y - s.y), ll = Math.hypot(lx, ly) || 1;
      const g = ctx.createRadialGradient(s.x + lx / ll * r * 0.5, s.y + ly / ll * r * 0.5, r * 0.1, s.x, s.y, r);
      g.addColorStop(0, col[0]); g.addColorStop(0.6, col[1]); g.addColorStop(1, col[2]);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      if (p.type === 'gas' && r > 6) {
        ctx.strokeStyle = 'rgba(255,230,190,0.25)';
        ctx.beginPath(); ctx.ellipse(s.x, s.y, r * 1.7, r * 0.45, -0.4, 0, Math.PI * 2); ctx.stroke();
      }
      if (p === selected) {
        ctx.strokeStyle = '#7fb6ff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
      }
      if (p === selected || cam.zoom * p.a > 60) {
        ctx.fillStyle = p === selected ? '#cfe2ff' : 'rgba(200,215,240,0.6)';
        ctx.fillText(p.name, s.x, s.y + r + 16);
      }
    }

    // Точка назначения.
    if (ship.state === 'flying' && ship.target) {
      const t = toScreen(ship.target.x, ship.target.y);
      ctx.strokeStyle = 'rgba(127,182,255,0.8)';
      ctx.beginPath(); ctx.arc(t.x, t.y, 6, 0, Math.PI * 2);
      ctx.moveTo(t.x - 11, t.y); ctx.lineTo(t.x - 3, t.y); ctx.moveTo(t.x + 3, t.y); ctx.lineTo(t.x + 11, t.y);
      ctx.moveTo(t.x, t.y - 11); ctx.lineTo(t.x, t.y - 3); ctx.moveTo(t.x, t.y + 3); ctx.lineTo(t.x, t.y + 11);
      ctx.stroke();
    }

    // След.
    if (ship.trail.length > 1) {
      ctx.beginPath();
      ship.trail.forEach((pt, i) => { const s = toScreen(pt.x, pt.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      const s = toScreen(ship.x, ship.y); ctx.lineTo(s.x, s.y);
      ctx.strokeStyle = 'rgba(127,182,255,0.35)'; ctx.stroke();
    }

    // Экономный курс: дуга (пунктир), место встречи с целью и планета гравманёвра — где они будут
    // в момент встречи (кольцо), а не где сейчас.
    if (ship.eco) {
      const e = ship.eco;
      ctx.save(); ctx.setLineDash([4, 6]); ctx.strokeStyle = 'rgba(255,200,120,0.55)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      e.path.forEach((pt, i) => { const s = toScreen(pt.x, pt.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke(); ctx.setLineDash([]);
      for (const L of e.legs) if (L.end) {
        const q = toScreen(...Object.values(planetPos(L.end, L.tb)));
        ctx.strokeStyle = L.flyby ? 'rgba(255,170,90,0.8)' : 'rgba(255,220,150,0.8)';
        ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    flashes.forEach(drawFlash);
    if (!(ship.hidden > 0)) drawShip();
  }

  // Частицы хвоста кометы — свои у каждой кометы, детерминированы от seed системы и номера кометы.
  function makeTailParts(seed, i) {
    const rng = mulberry32(hashSeed(seed ^ (i * 7919 + 0x7a11)));
    const mk = (n, v0, v1) => Array.from({ length: n }, () => ({
      ph: rng(), sp: v0 + rng() * (v1 - v0), off: (rng() + rng() + rng() - 1.5) / 1.5, sz: 0.6 + rng() * 1.1, a: 0.5 + rng() * 0.5,
    }));
    // Хвост втрое длиннее и шире прежнего — частиц ~×7, плотность прежняя (пользователь).
    return { ion: mk(300, 0.25, 0.5), dust: mk(560, 0.06, 0.15) };
  }
  // Поток частиц хвоста вдоль кривой Безье p → m → q (экранные координаты): частицы вылетают из ядра,
  // летят к концу (sp — доля хвоста в секунду), расходятся от ширины W0 до W1 и гаснут к концу.
  // rgb — цвет, k — активность кометы (0…1), streak — длина чёрточки частицы.
  function drawTailFlow(p, m, q, W0, W1, parts, time, rgb, k, streak) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const pa of parts) {
      const t = (pa.ph + pa.sp * time) % 1, u = 1 - t;
      const x = u * u * p.x + 2 * u * t * m.x + t * t * q.x, y = u * u * p.y + 2 * u * t * m.y + t * t * q.y;
      let dx = 2 * u * (m.x - p.x) + 2 * t * (q.x - m.x), dy = 2 * u * (m.y - p.y) + 2 * t * (q.y - m.y);
      const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const w = (W0 + (W1 - W0) * Math.sqrt(t)) * pa.off;         // хвост расширяется от ядра
      const cx = x - dy * w, cy = y + dx * w;
      const fade = Math.min(1, t * 8) * Math.pow(u, 1.3);           // вспыхивают у ядра, гаснут к концу
      const len = (1 + t * 3) * streak;
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${pa.a * fade * (0.35 + 0.65 * k)})`;
      ctx.lineWidth = pa.sz;
      ctx.beginPath(); ctx.moveTo(cx - dx * len, cy - dy * len); ctx.lineTo(cx + dx * len * 0.3, cy + dy * len * 0.3); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- Метеорные потоки: ленты вдоль орбиты ----------
  // Таблица положений по средней аномалии M (ORB_K точек за оборот) — считается один раз на орбиту:
  // тысячам частиц не нужно каждый кадр решать уравнение Кеплера, берём из таблицы с интерполяцией.
  const ORB_K = 1024;
  function orbitTable(o) {
    if (o.tab) return o.tab;
    const tab = new Float64Array(ORB_K * 2);
    let per = 0;
    for (let k = 0; k < ORB_K; k++) {
      const p = keplerPos({ ...o, m0: 2 * Math.PI * k / ORB_K, n: 0, dir: 1 }, 0);
      tab[2 * k] = p.x; tab[2 * k + 1] = p.y;
      if (k) per += Math.hypot(p.x - tab[2 * k - 2], p.y - tab[2 * k - 1]);
    }
    o.perimeter = per + Math.hypot(tab[0] - tab[2 * ORB_K - 2], tab[1] - tab[2 * ORB_K - 1]);
    return (o.tab = tab);
  }
  // Точка и касательная орбиты при средней аномалии M.
  function orbitAt(tab, M) {
    let f = (M / (2 * Math.PI)) % 1; if (f < 0) f += 1;
    const x = f * ORB_K, i = Math.floor(x) % ORB_K, j = (i + 1) % ORB_K, u = x - Math.floor(x);
    const px = tab[2 * i] + (tab[2 * j] - tab[2 * i]) * u, py = tab[2 * i + 1] + (tab[2 * j + 1] - tab[2 * i + 1]) * u;
    let tx = tab[2 * j] - tab[2 * i], ty = tab[2 * j + 1] - tab[2 * i + 1]; const tl = Math.hypot(tx, ty) || 1;
    return { x: px, y: py, tx: tx / tl, ty: ty / tl };
  }
  // Частицы ленты — из seed потока (детерминированы). dM — сдвиг по средней аномалии от «головы»
  // (комета-родитель / m0), больше — позади по движению. Ядро (35%) — кучно у головы, остальные —
  // по всей дуге. lat — сдвиг поперёк ленты: у молодых — 2–4 узкие нитки, у старых — одна широкая.
  // rate — течение вдоль ленты: частицы отстают от головы на 50–100% её орбитальной скорости (o.n), как
  // пыль от кометы; раньше было «доля ленты в секунду» — в десятки раз быстрее самой ленты и у звезды
  // (где по Кеплеру всё растянуто) частицы мчались. С переносом в начало дуги.
  // Число — по площади ленты при плотности STREAM_DENSITY (как у прежних облаков), не больше STREAM_MAX.
  const STREAM_DENSITY = 65 / (Math.PI * 2.2 * 27.5 * 27.5), STREAM_MAX = 1500, STREAM_MIN = 150;
  function streamParts(o) {
    orbitTable(o);
    const rng = mulberry32(hashSeed(o.seed));
    const g = () => (rng() + rng() + rng() - 1.5) / 1.5; // ≈ нормальное, −1…1
    const span = 2 * Math.PI * o.arc, ring = o.arc > 0.95;
    o.lo = ring ? -span / 2 : -span * 0.8; o.hi = ring ? span / 2 : span * 0.2;
    const len = o.perimeter * o.arc;
    const n = Math.max(STREAM_MIN, Math.min(STREAM_MAX, Math.round(STREAM_DENSITY * len * 2 * o.width)));
    return Array.from({ length: n }, () => {
      const core = rng() < 0.35;
      const dM = core ? -Math.abs(g()) * span * 0.12 : o.lo + rng() * (o.hi - o.lo);
      const k = Math.floor(rng() * o.strands);
      const lat = o.strands > 1 ? (k - (o.strands - 1) / 2) * o.width * 0.7 + g() * o.width * 0.18 : g() * o.width * 0.6;
      return { dM, lat, rate: -(0.5 + rng() * 0.5) * o.n, core, s: 0.6 + rng(), ph: rng() * 6.28 };
    });
  }

  // Кометы и метеорные потоки (gen.js generateSmallBodies, keplerPos): кеплеровы орбиты вокруг звезды.
  // Комета — бледная орбита, ядро с комой и хвост от звезды: у звезды длинный и яркий, дальше
  // ~40 а. е. хвоста нет. Поток метеоров — облако частиц, вытянутое вдоль орбиты.
  function drawSmallBodies(c) {
    const z = cam.zoom;
    ctx.save();
    for (const o of sys.comets) {
      // Орбита: центр эллипса смещён от фокуса (звезды) на a·e против направления перицентра.
      ctx.strokeStyle = 'rgba(150,200,255,0.07)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(c.x - Math.cos(o.w) * o.a * o.e * z, c.y - Math.sin(o.w) * o.a * o.e * z,
        o.a * z, o.a * Math.sqrt(1 - o.e * o.e) * z, o.w, 0, Math.PI * 2);
      ctx.stroke();
      const p = keplerPos(o, simT), sp = toScreen(p.x, p.y);
      const r = Math.hypot(p.x, p.y), k = Math.max(0, 1 - r / (40 * AU)); // активность — у звезды
      if (sp.x < -900 || sp.y < -900 || sp.x > cam.W + 900 || sp.y > cam.H + 900) continue; // длинный хвост виден и при ядре за краем
      if (k > 0) {
        // Два хвоста, как у настоящих комет (пользователь заметил «хвост по направлению движения»):
        //  - газовый (ионный) — его сдувает звёздный ветер, ВСЕГДА строго от звезды, даже если комета
        //    уходит от звезды и хвост оказывается впереди; тонкий, голубоватый;
        //  - пылевой — пыль отстаёт от ядра: тянется ПОЗАДИ вдоль орбиты, изгибаясь от звезды;
        //    широкий, желтоватый — главный видимый хвост.
        // Длина растёт к перицентру (мировые ед.), на экране — не короче 6 px.
        const L = Math.max(18, (6 + 50 * k * k) * Math.sqrt(AU / Math.max(r, 0.2 * AU)) * 4.5 * z); // ×3 к прежнему (пользователь)
        const ux = p.x / r, uy = p.y / r;                                   // от звезды
        const p2 = keplerPos(o, simT + 0.05);
        let vx = p2.x - p.x, vy = p2.y - p.y; const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl; // по движению
        // Хвосты — потоки частиц (пользователь: «анимируй потоком частиц, а не плашкой»).
        const tp = o.tail || (o.tail = makeTailParts(sys.seed, sys.comets.indexOf(o)));
        // Газовый: прямо от звезды, быстрые голубые частицы, узкий.
        const gx = sp.x + ux * L * 1.1, gy = sp.y + uy * L * 1.1;
        drawTailFlow(sp, { x: (sp.x + gx) / 2, y: (sp.y + gy) / 2 }, { x: gx, y: gy }, 1, L * 0.07,
          tp.ion, simT, [150, 205, 255], k, 1.4);
        // Пылевой: изогнутая дуга — от ядра назад по орбите, к концу уходит от звезды; шире и медленнее.
        let dx = ux - vx * 1.3, dy = uy - vy * 1.3; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        const Ld = L * 0.85;
        drawTailFlow(sp, { x: sp.x - vx * Ld * 0.55, y: sp.y - vy * Ld * 0.55 }, { x: sp.x + dx * Ld, y: sp.y + dy * Ld },
          2, Ld * (0.22 + 0.2 * k), tp.dust, simT, [255, 228, 185], k, 1);
        // Кома.
        const cg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 4 + 8 * k);
        cg.addColorStop(0, `rgba(220,240,255,${0.5 * k + 0.15})`); cg.addColorStop(1, 'rgba(220,240,255,0)');
        ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(sp.x, sp.y, 4 + 8 * k, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#e8f4ff';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, o.nucleus, 0, Math.PI * 2); ctx.fill();
    }
    for (const o of sys.streams) {
      const parts = o.parts || (o.parts = streamParts(o)), tab = o.tab;
      const Mh = o.m0 + o.dir * o.n * simT, span = o.hi - o.lo;
      for (const q of parts) {
        // Сдвиг от головы течёт вдоль ленты и переносится в начало дуги.
        let dM = q.dM + q.rate * simT;
        dM = o.lo + (((dM - o.lo) % span) + span) % span;
        const P = orbitAt(tab, Mh - o.dir * dM);                  // позади головы — против движения
        const widen = 0.6 + 0.8 * Math.min(1, Math.abs(dM) / (span * 0.5)); // к хвосту ленты шире
        const wx = P.x - P.ty * q.lat * widen, wy = P.y + P.tx * q.lat * widen;
        const x = (wx - cam.x) * z + cam.W / 2, y = (wy - cam.y) * z + cam.H / 2;
        if (x < -4 || y < -4 || x > cam.W + 4 || y > cam.H + 4) continue;
        const edge = Math.min(1, (dM - o.lo) / (span * 0.08), (o.hi - dM) / (span * 0.05)); // концы дуги гаснут
        const tw = 0.55 + 0.45 * Math.sin(simT * 2 + q.ph);                                   // мерцание
        const a = (q.core ? 0.8 : 0.45) * (0.5 + 0.5 * tw) * Math.max(0, edge);
        if (a <= 0.02) continue;
        ctx.fillStyle = `rgba(255,${190 + (q.ph * 9 | 0) % 50},150,${a})`;
        const qs = q.s * 1.4;
        ctx.fillRect(x - qs / 2, y - qs / 2, qs, qs);
      }
    }
    ctx.restore();
  }

  // Вспышка скачка: яркое ядро гаснет, кольцо расходится; у ухода — ещё световой росчерк по курсу.
  function drawFlash(f) {
    const s = toScreen(f.x, f.y), u = f.t / FLASH_T, a = 1 - u;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const core = 22 * (f.out ? 1 - u * 0.6 : 0.4 + u * 0.6);
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, core);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.4, `rgba(150,200,255,${a * 0.6})`); g.addColorStop(1, 'rgba(80,140,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, core, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(170,210,255,${a * 0.8})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, 6 + u * 46, 0, Math.PI * 2); ctx.stroke();
    if (f.out && f.h !== undefined) {
      const L = 90 * (0.3 + u);
      ctx.strokeStyle = `rgba(200,225,255,${a})`; ctx.lineWidth = 2 * a + 0.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + Math.cos(f.h) * L, s.y + Math.sin(f.h) * L); ctx.stroke();
    }
    ctx.restore();
  }

  // Поток вещества, который чёрная дыра вытягивает из звезды-донора: движущиеся частицы
  // (drawBezierFlow в viewport.js) от звезды в сторону дыры (направление — как на карте
  // галактики); дыра — за пределами системы. Конус не рисуется — только частицы.
  let bhParticles = null;
  // Скорость — в а. е. во времени игры, как у планет (год на 1 а. е. = 240 с, т. е. игра
  // ≈ в 131 000 раз быстрее реального времени): ~500 км/с у звезды ≈ 0,44 а. е./с — примерно
  // в 17 раз быстрее Земли по орбите; к дыре частицы разгоняются, в среднем ~1 а. е./с,
  // чем ближе донор к дыре (индекс), тем быстрее. Поток привязан к миру (1,8 радиуса системы),
  // поэтому от масштаба экрана скорость не зависит.
  const FLOW_AU_PER_S = 1;
  function drawBhStream(c, sr) {
    const bh = sys.gstar.bh;
    if (!bh) return;
    const b = World.galaxy().stars[bh.id];
    const ang = Math.atan2(b.y - sys.gstar.y, b.x - sys.gstar.x);
    const Lw = sys.radius * 1.8, L = Lw * cam.zoom;
    const q = { x: c.x + Math.cos(ang) * L, y: c.y + Math.sin(ang) * L };
    const m = { x: (c.x + q.x) / 2 - Math.sin(ang) * L * 0.22, y: (c.y + q.y) / 2 + Math.cos(ang) * L * 0.22 };
    const W0 = Math.max(sr * (1.3 + 0.8 * bh.index), sys.star.radius * 4 * cam.zoom, 4);
    if (!bhParticles) bhParticles = makeFlowParticles(sys.gstar.seed, 420);
    // makeFlowParticles: средняя скорость ~0,1 пути за единицу времени → переводим в а. е./с.
    const rate = FLOW_AU_PER_S * (0.6 + 0.8 * bh.index) / (0.1 * (Lw / AU));
    drawBezierFlow(ctx, c, m, q, W0, bhParticles, simT * rate, sys.star.color, 1.3);
  }


  // Масштабная сетка 100 × 100 (линии — drawGridLines в viewport.js). Подпись — в а. е.
  // и в световом времени: 1 а. е. ≈ 8,317 световой минуты.
  let showGrid = true, lastScale = '';
  function lightTime(au) {
    const min = au * 8.317;
    if (min < 1) return niceNum(min * 60) + ' св. с';
    if (min < 60) return niceNum(min) + ' св. мин';
    if (min < 60 * 48) return niceNum(min / 60) + ' св. ч';
    return niceNum(min / 1440) + ' св. сут';
  }
  function drawScaleGrid() {
    const au = drawGridLines(ctx, cam, 100) / AU;
    const txt = `Сетка 100 × 100 · клетка ≈ ${niceNum(au)} а. е. (${lightTime(au)}) · экран ≈ ${niceNum(au * 100)} а. е. (${lightTime(au * 100)})`;
    if (txt !== lastScale) { lastScale = txt; $('h-scale').textContent = txt; }
  }

  function drawStar(c) {
    const st = sys.star, kind = st.type.key, col = st.color;
    const sr = Math.max(4, st.radius * cam.zoom);
    const disc = (r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill(); };

    if (kind === 'blackhole') {
      // Аккреционный диск — сплюснутое светящееся кольцо, в центре чёрный горизонт.
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(-0.35); ctx.scale(1, 0.32);
      const g = ctx.createRadialGradient(0, 0, sr * 0.9, 0, 0, sr * 3.4);
      g.addColorStop(0, hexA(col, 0.95)); g.addColorStop(0.35, hexA(col, 0.45)); g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, sr * 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      disc(sr, '#000');
      ctx.strokeStyle = hexA(col, 0.9); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(c.x, c.y, sr * 1.05, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
      return;
    }

    const glowR = sr * (kind === 'neutron' ? 7 : kind === 'protostar' ? 6 : 4);
    const glow = ctx.createRadialGradient(c.x, c.y, sr * 0.3, c.x, c.y, glowR);
    glow.addColorStop(0, col); glow.addColorStop(0.25, hexA(col, 0.35)); glow.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(c.x, c.y, glowR, 0, Math.PI * 2); ctx.fill();

    if (kind === 'neutron') {
      // Пульсар: два вращающихся луча.
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(simT * 2.5);
      for (const s of [1, -1]) {
        const g = ctx.createLinearGradient(0, 0, s * sr * 16, 0);
        g.addColorStop(0, hexA(col, 0.6)); g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * sr * 16, -sr * 1.2); ctx.lineTo(s * sr * 16, sr * 1.2); ctx.fill();
      }
      ctx.restore();
    }
    if (kind === 'protostar') {
      // Пылевой протопланетный диск.
      ctx.strokeStyle = 'rgba(190,120,70,0.35)'; ctx.lineWidth = Math.max(2, sr * 0.6);
      ctx.beginPath(); ctx.ellipse(c.x, c.y, sr * 3, sr * 0.9, -0.3, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
    }
    drawBhStream(c, sr);
    disc(sr * 0.9, '#fff');
    disc(sr, hexA(col, 0.8));
  }

  function drawNebula() {
    for (const b of nebula) {
      const s = toScreen(b.x, b.y), r = b.r * cam.zoom;
      if (s.x + r < 0 || s.y + r < 0 || s.x - r > cam.W || s.y - r > cam.H) continue;
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, hexA(b.color, b.a)); g.addColorStop(1, hexA(b.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawShip() {
    const s = toScreen(ship.x, ship.y);
    let scale = 1;
    if (ship.state === 'landing') scale = 1 - 0.55 * ship.anim;
    else if (ship.state === 'landed') scale = 0.45;
    else if (ship.state === 'takeoff') scale = 0.45 + 0.55 * ship.anim;
    const L = 13 * scale;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(ship.heading);
    if (ship.thrust) {
      ctx.fillStyle = `rgba(255,${150 + Math.random() * 80 | 0},80,0.9)`;
      ctx.beginPath();
      ctx.moveTo(-L * 0.6, -L * 0.25); ctx.lineTo(-L * (1.2 + Math.random() * 0.5), 0); ctx.lineTo(-L * 0.6, L * 0.25);
      ctx.fill();
    }
    ctx.fillStyle = '#e8f0ff';
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(L, 0); ctx.lineTo(-L * 0.7, -L * 0.6); ctx.lineTo(-L * 0.4, 0); ctx.lineTo(-L * 0.7, L * 0.6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  const planetScreenR = p => Math.max(p.type === 'asteroid' ? 2.5 : 4, p.r * cam.zoom);
  function handleTap(sx, sy) {
    // Планета под пальцем — с запасом, чтобы маленькие легко попадались на телефоне.
    let best = null, bestD = Infinity;
    for (const p of sys.planets) {
      const pp = planetPos(p, simT), s = toScreen(pp.x, pp.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < Math.max(planetScreenR(p) + 10, 22) && d < bestD) { best = p; bestD = d; }
    }
    if (best) {
      // Только выбор: как лететь — кнопками «Экономно»/«Быстро» в карточке (пользователь).
      selected = best;
      renderCard(true);
      return;
    }
    const w = toWorld(sx, sy);
    // Точку внутри звезды выносим на границу запретной зоны.
    const wd = Math.hypot(w.x, w.y), ex = sys.star.excl * 1.6; // не зависать в сильной гравитации у звезды
    if (wd < ex) { w.x *= ex / (wd || 1); w.y *= ex / (wd || 1); if (!wd) w.x = ex; }
    // За границу системы не летаем — точку снаружи ставим на границу.
    if (wd > sys.radius) { w.x *= sys.radius / wd; w.y *= sys.radius / wd; }
    selected = null;
    orderFlyTo({ x: w.x, y: w.y });
    renderCard(true);
  }

  // ---------- Интерфейс ----------
  function setFollow(on) {
    cam.follow = on;
    $('b-follow').classList.toggle('on', on);
  }
  $('b-follow').onclick = () => setFollow(!cam.follow);
  // «Газ»: удержание пальцем/мышью и клавиша W (по коду клавиши — работает и в русской раскладке).
  // «Газ» (W) и «Тормоз» (S): удержание пальцем/мышью или клавишей (по коду — и в русской раскладке).
  for (const [id, mode] of [['b-gas', 1], ['b-brake', -1]]) {
    $(id).addEventListener('pointerdown', e => { e.preventDefault(); $(id).setPointerCapture(e.pointerId); setThrottle(mode); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) $(id).addEventListener(ev, () => { if (throttle === mode) setThrottle(0); });
  }
  const KEYS = { KeyW: 1, KeyS: -1 };
  addEventListener('keydown', e => { if (KEYS[e.code] && !e.repeat && !(e.target instanceof HTMLInputElement)) setThrottle(KEYS[e.code]); });
  addEventListener('keyup', e => { if (KEYS[e.code] === throttle) setThrottle(0); });
  addEventListener('blur', () => setThrottle(0));
  $('b-grid').onclick = () => { showGrid = !showGrid; $('b-grid').classList.toggle('on', showGrid); $('h-scale').hidden = !showGrid; };
  $('b-fit').onclick = () => { setFollow(false); fitCamera(); };
  $('b-galaxy').onclick = () => { location.href = World.galaxyUrl(); };
  $('minigal').onclick = () => { location.href = World.galaxyUrl(); };
  $('c-close').onclick = () => { selected = null; renderCard(true); };
  $('b-fly').onclick = () => selected && orderFlyTo({ planet: selected }, 'fast');
  $('b-eco').onclick = () => selected && orderFlyTo({ planet: selected }, 'eco');
  // Режим для щелчка по карте (к планете или в точку); в карточке — обе кнопки.
  function renderMode() { $('b-mode').textContent = flightMode === 'eco' ? 'Режим: экономно' : 'Режим: быстро'; }
  $('b-mode').onclick = () => { flightMode = flightMode === 'eco' ? 'fast' : 'eco'; try { localStorage.setItem('ouro.v3.mode', flightMode); } catch (_) { /* приватный режим */ } renderMode(); };
  renderMode();
  $('b-land').onclick = startLanding;
  $('b-takeoff').onclick = startTakeoff;
  $('b-surface').onclick = () => { location.href = World.planetUrl(sys.gstar.id, ship.planet.index); };
  $('b-scan').onclick = () => { showScan = !showScan; renderCard(true); };
  let showScan = false;

  function renderHud() {
    const st = sys.star;
    $('h-star').textContent = st.name;
    $('h-class').textContent = `${st.type.name} · светимость ${st.lum.toFixed(2)}`;
    $('h-gal').textContent = `${sys.galR.toFixed(1)} кпк от центра · ${sys.zone.name}`;
    $('h-bh').hidden = !sys.gstar.bh;
    if (sys.gstar.bh) $('h-bh').textContent = `Донор чёрной дыры ${World.galaxy().stars[sys.gstar.bh.id].name} · индекс ${String(sys.gstar.bh.index).replace('.', ',')} · жизни нет`;
    $('h-planets').textContent = `Планет: ${sys.planets.length}`;
    $('h-seed').textContent = 'сектор ' + sys.gstar.sectorKey;
    $('h-dot').style.background = st.color;
    drawMiniGalaxy();
  }

  function drawMiniGalaxy() {
    const g = $('minigal'), gc = g.getContext('2d'), S = 56;
    g.width = S * cam.DPR; g.height = S * cam.DPR; gc.setTransform(cam.DPR, 0, 0, cam.DPR, 0, 0);
    gc.clearRect(0, 0, S, S);
    // Настоящие звёзды текущей галактики, текущая — красным кружком.
    const k = (S / 2 - 2) / GALAXY_RADIUS_KPC;
    for (const st of World.galaxy().stars) {
      gc.fillStyle = st.r < 3 ? 'rgba(255,210,160,0.8)' : 'rgba(160,185,255,0.55)';
      gc.fillRect(S / 2 + st.x * k, S / 2 + st.y * k, 1, 1);
    }
    const rr = sys.galR / GALAXY_RADIUS_KPC * (S / 2 - 3);
    const x = S / 2 + Math.cos(sys.galAngle) * rr, y = S / 2 + Math.sin(sys.galAngle) * rr;
    gc.strokeStyle = '#ff5a5a'; gc.lineWidth = 1.5;
    gc.beginPath(); gc.arc(x, y, 3.5, 0, Math.PI * 2); gc.stroke();
  }

  function shipStatus() {
    const s = ship, pn = s.planet ? s.planet.name : '';
    if (noticeT > 0) return notice;
    const e = s.eco, en = e && e.target.planet ? e.target.planet.name : 'точке';
    const fly = e && e.flyby ? ` через ${e.flyby.name}` : '';
    if (e && e.phase === 'wait') return `Ждём окна: старт к ${en} через ${Math.max(0, Math.ceil(e.legs[0].ta - simT))} с`;
    switch (s.state) {
      case 'flying': return s.jumpIn ? (s.planet ? `После скачка — торможение к ${pn}` : 'После скачка — торможение к звезде · выберите планету') : s.planet ? `Курс на ${pn}` : 'Полёт к точке';
      case 'warpout': return `Разгон к звезде ${s.warp.name}: ${Math.round(Math.hypot(s.vx, s.vy) / SHIP_LIGHT * 100)}% скорости света`;
      case 'jumping': return 'Скачок…';
      case 'coast': return `По дуге к ${en}${fly} · прибытие через ${Math.max(0, Math.ceil(e.legs[e.legs.length - 1].tb - simT))} с`;
      case 'adrift': return s.fuel > 0 ? (throttle > 0 ? 'Ручной полёт · газ' : throttle < 0 ? 'Ручной полёт · тормоз' : 'Ручной полёт · по инерции') : 'Нет топлива — полёт по инерции';
      case 'orbit': return `На орбите ${pn}`;
      case 'landing': return `Посадка на ${pn}…`;
      case 'landed': return `На поверхности ${pn}`;
      case 'takeoff': return `Взлёт с ${pn}…`;
      default: return 'Дрейф';
    }
  }
  const fmtT = t => !isFinite(t) ? '—' : t < 120 ? `${Math.round(t)} с` : `${(t / 60).toFixed(1).replace('.', ',')} мин`;
  const fuelPct = dv => {
    if (!isFinite(ship.fuelMax)) return isFinite(dv) ? 'не тратится (реактор)' : '∞';
    const p = dv / ship.fuelMax * 100;
    return (p < 0.01 ? '<0,01' : p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)).toString().replace('.', ',') + '%';
  };
  // Прикидка обоих режимов к планете — для карточки (раз при выборе; ~десятки мс).
  function estimates(p) {
    const f = estimateFast({ planet: p });
    const e = planEco(orbitWorld(), ecoStart(), { planet: p }, simT);
    return { fast: f, eco: e };
  }

  let lastCardKey = '';
  function renderCard(force) {
    const key = [selected && selected.index, ship.state, ship.planet && ship.planet.index, showScan].join('|');
    if (!force && key === lastCardKey) return;
    lastCardKey = key;

    const card = $('card');
    if (!selected) { card.hidden = true; showScan = false; return; }
    card.hidden = false;
    const p = selected, T = PLANET_TYPES[p.type];
    const here = ship.planet === p;
    $('c-name').textContent = p.name;
    $('c-type').textContent = T.name + (p.habitable ? ' · зона жизни' : '');
    $('c-swatch').style.background = `radial-gradient(circle at 35% 35%, ${T.colors[0]}, ${T.colors[1]} 60%, ${T.colors[2]})`;
    $('c-facts').innerHTML =
      `<div><span>Орбита</span>${(p.a / AU).toFixed(2)} а.е.</div>` +
      `<div><span>Год</span>${p.period < 120 ? Math.round(p.period) + ' с' : Math.round(p.period / 60) + ' мин'}</div>` +
      `<div><span>Температура</span>${p.tempK} K</div>` +
      `<div><span>Посадка</span>${T.landable ? 'возможна' : 'нет'}</div>` +
      `<div><span>Жизнь</span>${LIFE_STATES[p.life].name}</div>` +
      `<div><span>Масса</span>${p.massE < 10 ? p.massE.toFixed(2).replace('.', ',') : Math.round(p.massE)} M⊕</div>` +
      `<div><span>Радиус</span>${p.radiusKm.toLocaleString('ru-RU')} км · g ${p.gSurf.toFixed(1).replace('.', ',')} м/с²</div>` +
      (T.landable ? `<div><span>Размер</span>${SIZE_NAMES[p.hexRadius]} · ${hexCount(p.hexRadius)} гексов</div>` : '');
    $('c-desc').textContent = T.desc;

    const show = (id, on) => { $(id).hidden = !on; };
    const ecoTo = ship.eco && ship.eco.target.planet === p;
    const enRoute = (here && ship.state === 'flying') || ecoTo;
    show('b-fly', !here || enRoute);
    show('b-eco', !here && !enRoute);
    $('b-fly').disabled = enRoute;
    $('b-fly').textContent = enRoute ? 'В пути…' : 'Быстро';
    // Прикидка: время и топливо в обоих режимах.
    const est = $('c-est');
    est.hidden = here || enRoute;
    if (!est.hidden) {
      const E = estimates(p), e = E.eco;
      est.innerHTML =
        `<div><b>Быстро</b> — ${fmtT(E.fast.t)}, топливо ${fuelPct(E.fast.fuel)}</div>` +
        (e ? `<div><b>Экономно</b> — ${e.wait > 0.5 ? 'старт через ' + fmtT(e.wait) + ', ' : ''}в пути ${fmtT(e.tof)}, топливо ${fuelPct(e.dv)}` +
          (e.flyby ? `, гравманёвр у ${e.flyby.name}` : '') + '</div>' : '<div><b>Экономно</b> — дуги нет</div>') +
        `<div class="note">${ship.design} · ${isFinite(ship.fuelMax) ? 'в баке ' + fuelPct(ship.fuel) + ' (' + fmtDv(ship.fuel) + ' Δv)' : 'двигатели кормит реактор — топливо не тратится'}</div>`;
    }
    show('b-land', here && ship.state === 'orbit' && T.landable);
    show('b-takeoff', here && ship.state === 'landed');
    show('b-surface', here && ship.state === 'landed');
    const canScan = here && (ship.state === 'orbit' || ship.state === 'landed');
    show('b-scan', canScan);
    $('b-scan').textContent = showScan ? 'Скрыть скан' : 'Сканирование';
    if (!canScan) showScan = false;

    const res = $('c-res');
    res.hidden = !showScan;
    if (showScan) {
      const comp = p.composition;
      const total = Math.round(comp.reduce((s, x) => s + x.value, 0) * 10) / 10;
      const fmt = n => String(n).replace('.', ',');
      // Строка формулы: (база ± звезда) × зона [× жизнь] — раскрывается по нажатию на ресурс.
      const formula = x => {
        const sum = x.mod ? `(${x.base} ${x.mod > 0 ? '+' : '−'} ${Math.abs(x.mod)} звезда)` : `${x.base}`;
        if (x.base === 0) return 'базы нет — ресурса нет';
        return `база ${sum} × ${fmt(x.zoneMult)} зона` + (x.lifeMult !== null ? ` × ${fmt(x.lifeMult)} жизнь` : '') +
          (x.bhMult !== null && x.bhMult !== 1 ? ` × ${fmt(Math.round(x.bhMult * 100) / 100)} чёрная дыра` : '');
      };
      res.innerHTML =
        `<div class="note">${sys.star.type.name} · ${sys.zone.name} · жизнь: ${LIFE_STATES[p.life].name.toLowerCase()}</div>` +
        RESOURCE_GROUPS.map(g => {
          const rows = RESOURCES.map((r, i) => ({ r, x: comp[i] })).filter(o => o.r.group === g);
          return `<div class="rg"><div class="rg-h">${g}</div>` + rows.map(({ r, x }) =>
            `<div class="rr${x.value ? '' : ' zero'}"><span class="rn">${r.name}</span>` +
            `<span class="rb"><i style="width:${Math.min(100, x.value * 2)}%"></i></span><span class="rv">${fmt(x.value)}</span>` +
            `<div class="rf">${formula(x)}</div></div>`).join('') + '</div>';
        }).join('') +
        `<div class="rtot"><span>Итого ресурсов</span><b>${fmt(total)}</b></div>` +
        (total > 100
          ? `<div class="rtot warn"><span>Больше 100 — таблицу нужно поправить</span><b>+${fmt(Math.round((total - 100) * 10) / 10)}</b></div>`
          : `<div class="rtot"><span>Пустая порода</span><b>${fmt(Math.round((100 - total) * 10) / 10)}</b></div>`) +
        '<div class="note">Единиц массы на 100 единиц массы планеты. Нажмите на ресурс — покажется расчёт.</div>';
    }
  }
  $('c-res').addEventListener('click', e => {
    const row = e.target.closest('.rr');
    if (row) row.classList.toggle('open');
  });

  // ---------- Цикл ----------
  let last = performance.now(), hudTimer = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    simT += dt;
    updateShip(dt);
    if (cam.follow) {
      const k = Math.min(1, dt * 4);
      cam.x += (ship.x - cam.x) * k; cam.y += (ship.y - cam.y) * k;
    }
    cam.step(dt);
    cam.flyStep(dt);
    draw();
    if ((hudTimer += dt) > 0.2) {
      hudTimer = 0;
      $('h-ship').textContent = shipStatus();
      const v = Math.hypot(ship.vx, ship.vy);
      $('h-speed').textContent = (ship.state === 'flying' || ship.state === 'coast' || ship.state === 'adrift'
        ? `${(v / AU * 60).toFixed(1)} а.е./мин · ${(v * KMS_PER_UNIT).toFixed(0)} км/с · ${Math.min(1, v / ship.maxSpeed).toFixed(2).replace('.', ',')} c · ` : '') +
        (isFinite(ship.fuelMax) ? `топливо ${fuelPct(ship.fuel)}` : 'реактор');
      renderCard();
    }
    requestAnimationFrame(frame);
  }

  // Отладка из консоли: __dbg().ship, __dbg().screenOf(2) — экранные координаты планеты.
  window.__dbg = () => ({ sys, ship, cam, simT, selected, belt, screenOf: i => { const p = planetPos(sys.planets[i], simT); return toScreen(p.x, p.y); },
    // __dbg().plan(i) — прикидка к планете i обоими режимами без вылета (время прокладки — eco.ms).
    plan: i => estimates(sys.planets[i]),
    fly: (i, mode) => orderFlyTo({ planet: sys.planets[i] }, mode),
    // __dbg().run(с) — прокрутить время игры вперёд шагами по 0,05 с (проверка долгих полётов).
    run: sec => { for (let t = 0; t < sec; t += 0.05) { simT += 0.05; updateShip(0.05); } return { simT, state: ship.state, fuel: ship.fuel, planet: ship.planet && ship.planet.name }; } });

  loadSystem(World.currentStar());

  // Прилёт с карты галактики кнопкой «Корабль»: из темноты, система — точка вдали,
  // камера приближается к кораблю и дальше следует за ним.
  const qs = new URLSearchParams(location.search);
  if (qs.has('arrive')) {
    qs.delete('arrive');
    history.replaceState(null, '', location.pathname + '?' + qs); // перезагрузка не повторяет пролёт
    screenFade(1, 0); screenFade(0, 700);
    setFollow(false);
    cam.flyTo(() => ship, (Math.min(cam.W, cam.H) * 0.14) / ship.planet.orbitR, 2.2, () => setFollow(true));
  }
  // Межзвёздный перелёт: ?warp=ID[&dest=N] — разгон отсюда; ?jumpin=1 — выход из скачка здесь.
  {
    const q = new URLSearchParams(location.search), warp = q.get('warp'), dest = q.get('dest');
    if (warp !== null || q.has('jumpin')) {
      q.delete('warp'); q.delete('dest'); q.delete('jumpin');
      history.replaceState(null, '', location.pathname + '?' + q); // перезагрузка не повторяет
      if (warp !== null) startWarp(+warp, dest !== null ? +dest : null);
      else { const a = World.takeArrival(); if (a) { screenFade(1, 0); screenFade(0, 600); jumpIn(a); } }
    }
  }
  // Вернулись с поверхности кнопкой «Взлёт» — корабль взлетает с планеты.
  if (new URLSearchParams(location.search).get('takeoff') && ship.state === 'landed') startTakeoff();
  if (ship.state !== 'warpout' && !ship.jumpIn) setFollow(false); // при перелёте камера следит за кораблём
  requestAnimationFrame(frame);
})();
