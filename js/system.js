// Экран «Звёздная система»: отрисовка, ввод (мышь + тач), корабль.
(() => {
  const cvs = document.getElementById('view');
  const ctx = cvs.getContext('2d');
  const $ = id => document.getElementById(id);

  let sys, ship, simT = 0, selected = null;
  const cam = createViewport(cvs, {
    onTap: (x, y) => handleTap(x, y),
    onPanStart: () => setFollow(false),
    minZoom: () => (Math.min(cam.W, cam.H) * 0.2) / (sys.outer + 20),
    maxZoom: () => 40,
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
    const palette = ['#7a4cff', '#ff4f9a', '#3fb6ff', '#5fffc0'];
    nebula = sys.star.type.key !== 'nebula' ? [] : Array.from({ length: 16 }, () => {
      const ang = rng() * Math.PI * 2, d = Math.sqrt(rng()) * sys.outer * 1.2;
      return { x: Math.cos(ang) * d, y: Math.sin(ang) * d, r: sys.outer * (0.25 + rng() * 0.45),
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
      anim: 0, thrust: false, trail: [], pending: null,
      maxSpeed: Math.max(160, sys.outer / 18), accel: Math.max(90, sys.outer / 35),
    };
    selected = home;

    fitCamera();
    cam.follow = false; // после прыжка — обзор всей системы; «Корабль» включает слежение
    $('h-ship').textContent = shipStatus();
    renderHud();
    renderCard(true);
  }

  // ---------- Камера ----------
  function fitCamera() {
    cam.zoom = (Math.min(cam.W, cam.H) * 0.46) / (sys.outer + 20);
    cam.x = 0; cam.y = 0; cam.zoomGoal = 0;
  }

  // ---------- Корабль ----------
  const shipPlanetBusy = () => ['landing', 'landed', 'takeoff'].includes(ship.state);

  function orderFlyTo(target) {
    // target: {planet} или {x, y}
    if (ship.state === 'landed') { ship.pending = target; startTakeoff(); return; }
    if (ship.state === 'landing' || ship.state === 'takeoff') { ship.pending = target; return; }
    if (target.planet && ship.state === 'orbit' && ship.planet === target.planet) return;
    ship.state = 'flying';
    World.setShip(null);
    ship.planet = target.planet || null;
    ship.target = target.planet ? null : { x: target.x, y: target.y };
    setFollow(true);
    // Камера отъезжает, чтобы в кадре были и корабль, и цель.
    const tp = target.planet ? planetPos(target.planet, simT) : target;
    const dist = Math.hypot(tp.x - ship.x, tp.y - ship.y);
    if (cam.follow && dist > 1) cam.zoomGoal = Math.min(cam.zoom, (Math.min(cam.W, cam.H) * 0.4) / dist);
    renderCard();
  }
  function startLanding() {
    if (ship.state !== 'orbit' || !PLANET_TYPES[ship.planet.type].landable) return;
    ship.state = 'landing'; ship.anim = 0; renderCard();
  }
  function startTakeoff() {
    if (ship.state !== 'landed') return;
    ship.state = 'takeoff'; ship.anim = 0; renderCard();
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

  function updateShip(dt) {
    const s = ship;
    s.thrust = false;

    if (s.state === 'flying') {
      let tx, ty, tvx = 0, tvy = 0, stop = 0;
      if (s.planet) {
        const pp = planetPos(s.planet, simT), pv = planetVel(s.planet, simT);
        tx = pp.x; ty = pp.y; tvx = pv.x; tvy = pv.y; stop = s.planet.orbitR;
      } else { tx = s.target.x; ty = s.target.y; }

      const dist = Math.hypot(tx - s.x, ty - s.y);
      const way = avoidStar(s.x, s.y, tx, ty);
      let ax = tx, ay = ty, remain = Math.max(0, dist - stop);
      if (way) {
        ax = way.x; ay = way.y;
        remain = Math.hypot(way.x - s.x, way.y - s.y) + Math.hypot(tx - way.x, ty - way.y) - stop;
        tvx = tvy = 0;
      }
      const ad = Math.hypot(ax - s.x, ay - s.y) || 1;
      // Профиль «разгон — крейсер — торможение»: скорость не больше той,
      // с которой ещё успеваем остановиться на оставшемся пути.
      const vWant = Math.min(s.maxSpeed, Math.sqrt(2 * s.accel * remain * 0.85));
      const dvx = tvx + (ax - s.x) / ad * vWant - s.vx;
      const dvy = tvy + (ay - s.y) / ad * vWant - s.vy;
      const dv = Math.hypot(dvx, dvy);
      const maxDv = s.accel * dt;
      if (dv > maxDv) { s.vx += dvx / dv * maxDv; s.vy += dvy / dv * maxDv; } else { s.vx += dvx; s.vy += dvy; }
      s.thrust = dv > s.accel * 0.05;
      s.x += s.vx * dt; s.y += s.vy * dt;

      // Нос корабля — по направлению тяги (при торможении разворачивается).
      if (dv > 1) turnTo(Math.atan2(dvy, dvx), dt);

      const rel = Math.hypot(s.vx - tvx, s.vy - tvy);
      if (s.planet) {
        if (dist < stop * 1.6 && rel < Math.max(25, s.maxSpeed * 0.15)) enterOrbit(s.planet);
      } else if (remain < 1.5 && rel < 6) {
        s.vx = s.vy = 0; s.state = 'idle'; s.target = null; renderCard();
      }
    } else if (s.state === 'orbit' || s.state === 'landing' || s.state === 'landed' || s.state === 'takeoff') {
      const p = s.planet, pp = planetPos(p, simT), pv = planetVel(p, simT);
      s.orbitRad += (p.orbitR - s.orbitRad) * Math.min(1, dt * 2);
      s.orbitAng += dt * 0.9;
      const ox = pp.x + Math.cos(s.orbitAng) * s.orbitRad;
      const oy = pp.y + Math.sin(s.orbitAng) * s.orbitRad;

      if (s.state === 'orbit') {
        s.x = ox; s.y = oy; s.vx = pv.x; s.vy = pv.y;
        turnTo(s.orbitAng + Math.PI / 2, dt);
      } else {
        // Посадка/взлёт: корабль скользит между орбитой и поверхностью.
        if (s.state === 'landing' || s.state === 'takeoff') s.anim = Math.min(1, s.anim + dt / 1.6);
        let k = s.state === 'landing' ? s.anim : s.state === 'takeoff' ? 1 - s.anim : 1;
        k = k * k * (3 - 2 * k);
        const sx = pp.x + Math.cos(s.orbitAng) * p.r, sy = pp.y + Math.sin(s.orbitAng) * p.r;
        s.x = ox + (sx - ox) * k; s.y = oy + (sy - oy) * k;
        s.vx = pv.x; s.vy = pv.y;
        turnTo(s.orbitAng + Math.PI / 2 * (1 - k), dt * 3);
        s.thrust = s.state === 'takeoff' || (s.state === 'landing' && s.anim > 0.6);
        if (s.anim >= 1 && s.state === 'landing') {
          s.state = 'landed'; renderCard();
          // Как в v2: после посадки — экран поверхности планеты.
          World.setShip(s.planet.index, true);
          setTimeout(() => { location.href = World.planetUrl(sys.gstar.id, s.planet.index); }, 350);
        }
        else if (s.anim >= 1 && s.state === 'takeoff') {
          s.state = 'orbit'; renderCard();
          World.setShip(s.planet.index, false);
          if (s.pending) { const t = s.pending; s.pending = null; orderFlyTo(t); }
        }
      }
    }

    // Не пускаем корабль внутрь запретного радиуса звезды.
    const sd = Math.hypot(s.x, s.y);
    if (sd < sys.star.excl) { s.x *= sys.star.excl / sd; s.y *= sys.star.excl / sd; }

    if (s.state === 'flying') {
      const last = s.trail[s.trail.length - 1];
      if (!last || Math.hypot(last.x - s.x, last.y - s.y) > 3 / cam.zoom) s.trail.push({ x: s.x, y: s.y });
      if (s.trail.length > 160) s.trail.shift();
    } else if (s.trail.length) s.trail.shift();
  }
  function turnTo(target, dt) {
    let d = target - ship.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const max = 5 * dt;
    ship.heading += Math.max(-max, Math.min(max, d));
  }
  function enterOrbit(p) {
    const pp = planetPos(p, simT);
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

    // Орбиты.
    ctx.lineWidth = 1;
    for (const p of sys.planets) {
      if (p.type === 'asteroid') continue;
      ctx.strokeStyle = p === selected ? 'rgba(120,180,255,0.45)' : 'rgba(120,150,200,0.16)';
      ctx.beginPath(); ctx.arc(c.x, c.y, p.a * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    }

    // Пояс астероидов.
    ctx.fillStyle = 'rgba(200,190,180,0.8)';
    const bp = sys.planets.find(p => p.type === 'asteroid');
    if (bp) {
      const w = bp.omega * 0.9;
      for (const b of belt) {
        const ang = b.ang + w * simT;
        const x = c.x + Math.cos(ang) * b.r * cam.zoom, y = c.y + Math.sin(ang) * b.r * cam.zoom;
        if (x < -5 || y < -5 || x > cam.W + 5 || y > cam.H + 5) continue;
        ctx.fillRect(x, y, b.s, b.s);
      }
    }

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

    drawShip();
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
    const Lw = sys.outer * 1.8, L = Lw * cam.zoom;
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
      selected = best;
      orderFlyTo({ planet: best });
      renderCard(true);
      return;
    }
    const w = toWorld(sx, sy);
    // Точку внутри звезды выносим на границу запретной зоны.
    const wd = Math.hypot(w.x, w.y), ex = sys.star.excl * 1.1;
    if (wd < ex) { w.x *= ex / (wd || 1); w.y *= ex / (wd || 1); if (!wd) w.x = ex; }
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
  $('b-grid').onclick = () => { showGrid = !showGrid; $('b-grid').classList.toggle('on', showGrid); $('h-scale').hidden = !showGrid; };
  $('b-fit').onclick = () => { setFollow(false); fitCamera(); };
  $('b-galaxy').onclick = () => { location.href = World.galaxyUrl(); };
  $('minigal').onclick = () => { location.href = World.galaxyUrl(); };
  $('c-close').onclick = () => { selected = null; renderCard(true); };
  $('b-fly').onclick = () => selected && orderFlyTo({ planet: selected });
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
    switch (s.state) {
      case 'flying': return s.planet ? `Курс на ${pn}` : 'Полёт к точке';
      case 'orbit': return `На орбите ${pn}`;
      case 'landing': return `Посадка на ${pn}…`;
      case 'landed': return `На поверхности ${pn}`;
      case 'takeoff': return `Взлёт с ${pn}…`;
      default: return 'Дрейф';
    }
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
      (T.landable ? `<div><span>Размер</span>${SIZE_NAMES[p.hexRadius]} · ${hexCount(p.hexRadius)} гексов</div>` : '');
    $('c-desc').textContent = T.desc;

    const show = (id, on) => { $(id).hidden = !on; };
    const enRoute = here && ship.state === 'flying';
    show('b-fly', !here || enRoute);
    $('b-fly').disabled = enRoute;
    $('b-fly').textContent = enRoute ? 'В пути…' : 'Лететь';
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
    draw();
    if ((hudTimer += dt) > 0.2) {
      hudTimer = 0;
      $('h-ship').textContent = shipStatus();
      const v = Math.hypot(ship.vx, ship.vy);
      $('h-speed').textContent = ship.state === 'flying' ? `${(v / AU * 60).toFixed(1)} а.е./мин` : '';
      renderCard();
    }
    requestAnimationFrame(frame);
  }

  // Отладка из консоли: __dbg().ship, __dbg().screenOf(2) — экранные координаты планеты.
  window.__dbg = () => ({ sys, ship, cam, simT, selected, belt, screenOf: i => { const p = planetPos(sys.planets[i], simT); return toScreen(p.x, p.y); } });

  loadSystem(World.currentStar());
  // Вернулись с поверхности кнопкой «Взлёт» — корабль взлетает с планеты.
  if (new URLSearchParams(location.search).get('takeoff') && ship.state === 'landed') startTakeoff();
  setFollow(false);
  requestAnimationFrame(frame);
})();
