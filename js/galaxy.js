// Экран «Галактика»: спираль из неподвижных звёзд, сетка 5 зон × 12 секторов,
// выбор звезды/сектора, прыжок корабля к звезде (пока мгновенный).
(() => {
  const cvs = document.getElementById('view');
  const mainCtx = cvs.getContext('2d');
  let ctx = mainCtx; // на время отрисовки слоя указывает на его контекст
  const $ = id => document.getElementById(id);

  const gal = World.galaxy();
  const K = GALAXY.kpc;                 // мировых единиц на кпк
  const RW = GALAXY_RADIUS_KPC * K;     // радиус галактики в мировых единицах
  let selected = null, selSector = null, hovered = null, showGrid = true, t = 0;

  const cam = createViewport(cvs, {
    onTap: handleTap,
    onHover: (x, y) => { hovered = starAt(x, y); },
    minZoom: () => fitZoom(), // дальше «всё в экран» не отдаляем
    maxZoom: () => fitZoom() * 60,
    panLimit: () => RW, // центр обзора — внутри галактики
    onResize: () => {},
  });
  const fitZoom = () => (Math.min(cam.W, cam.H) * 0.48) / (RW * 1.04);
  function fit() { cam.zoom = fitZoom(); cam.x = 0; cam.y = 0; cam.zoomGoal = 0; }

  // ---------- Свечение галактики: рисуется один раз во внеэкранный canvas ----------
  const glow = document.createElement('canvas');
  const GS = 2000;                       // разрешение текстуры свечения
  const gExt = RW * HALO_R * 1.02;       // мировой полуразмер, который покрывает текстура

  // Звёзды за краем круга — декорация без имён и выбора, из ТОГО ЖЕ распределения, что и
  // настоящие (sampleGalaxyPoint с внешним краем): берём выборку того же размера, что дала бы
  // GALAXY.stars звёзд внутри, и оставляем только внешние — плотность на границе непрерывна.
  // Свой rng — на мир (звёзды, планеты) это не влияет.
  const haloStars = (() => {
    const rng = mulberry32(hashSeed(gal.seed) ^ 0xa10), R = GALAXY_RADIUS_KPC, out = [];
    const kinds = ['white', 'yellow', 'red', 'red', 'blue'];
    for (let inside = 0; inside < GALAXY.stars;) {
      const p = sampleGalaxyPoint(rng, false);
      if (p.r < GALAXY.chaosR) continue; // внутри шара хаоса — только свечение
      if (p.r < R) { inside++; continue; }
      const k = kinds[Math.floor(rng() * kinds.length)];
      // Тот же размер, что у настоящей звезды того же цвета; яркость гаснет плавно с удалением.
      out.push({ x: p.x, y: p.y, k, col: STAR_TYPES.find(t => t.key === k).color, a: 0.9 * Math.exp(-(p.r - R) / (R * 0.5)) });
    }
    return out;
  })();
  (function paintGlow() {
    glow.width = glow.height = GS;
    const g = glow.getContext('2d');
    const k = GS / 2 / gExt, rng = mulberry32(hashSeed(gal.seed) ^ 0x51ed);
    const px = (xk, yk) => [GS / 2 + xk * K * k, GS / 2 + yk * K * k];

    // Ядро — тёплый градиент.
    const core = g.createRadialGradient(GS / 2, GS / 2, 0, GS / 2, GS / 2, 3.6 * K * k);
    core.addColorStop(0, 'rgba(255,240,215,1)');
    core.addColorStop(0.15, 'rgba(255,200,140,0.75)');
    core.addColorStop(0.5, 'rgba(200,120,70,0.25)');
    core.addColorStop(1, 'rgba(120,60,40,0)');
    g.fillStyle = core; g.fillRect(0, 0, GS, GS);

    // Звёздная пыль рукавов и диска (аддитивно).
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 180000; i++) {
      const pt = sampleGalaxyPoint(rng, false);
      const [x, y] = px(pt.x, pt.y);
      const warm = Math.max(0, 1 - pt.r / 4.5);
      const pink = pt.inArm && pt.r > 3 && rng() < 0.02;
      g.fillStyle = pink ? 'rgba(255,120,190,0.3)'
        : `rgba(${110 + 145 * warm | 0},${150 + 50 * warm | 0},${255 - 135 * warm | 0},${pt.inArm ? 0.13 : 0.09})`;
      const s = rng() < 0.03 ? 3.5 : 2.4;
      g.fillRect(x, y, s, s);
    }

    // Пылевые прожилки по внутреннему краю рукавов.
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 26000; i++) {
      const r = 1.5 + rng() * (GALAXY_RADIUS_KPC * HALO_R - 2);
      if (rng() > galaxyTaper(r)) continue;
      const arm = Math.floor(rng() * GALAXY.arms);
      const w = GALAXY.armWidth + r * GALAXY.armWidthGrow;
      const th = armAngle(r, arm) - 0.7 * w / r + gauss(rng) * 0.2 * w / r; // по внутреннему краю рукава
      const [x, y] = px(Math.cos(th) * r, Math.sin(th) * r);
      g.fillStyle = 'rgba(40,18,10,0.10)';
      g.fillRect(x, y, 2, 2);
    }
  })();

  // ---------- Отрисовка ----------
  const bgStars = (() => { const r = mulberry32(7); return Array.from({ length: 350 }, () => ({ x: r(), y: r(), s: r() * 1.2 + 0.2, a: r() * 0.5 + 0.15 })); })();
  const starPos = s => cam.toScreen(s.x * K, s.y * K);
  const zoomRel = () => cam.zoom / fitZoom();
  const DOT = { red: 0.9, yellow: 1.2, white: 1.2, blue: 1.7, neutron: 1, protostar: 1.4, blackhole: 1.6, nebula: 1.4 };
  const MAP_COLOR = { nebula: '#d08cff' }; // у туманности на карте свой цвет, а не цвет звезды внутри

  const layer = document.createElement('canvas');
  let layerKey = '';
  function renderLayer() {
    if (layer.width !== cvs.width || layer.height !== cvs.height) { layer.width = cvs.width; layer.height = cvs.height; }
    ctx = layer.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.setTransform(cam.DPR, 0, 0, cam.DPR, 0, 0);
    const c = cam.toScreen(0, 0), zr = zoomRel();
    const size = gExt * 2 * cam.zoom;
    ctx.globalAlpha = Math.max(0.35, Math.min(1, 1.6 / Math.sqrt(zr)));
    ctx.drawImage(glow, c.x - size / 2, c.y - size / 2, size, size);
    ctx.globalAlpha = 1;

    // Звёзды за краем: декорация, без имён и без выбора.
    const hs = Math.min(4, Math.max(1, Math.sqrt(zr)));
    for (const s of haloStars) {
      const p = cam.toScreen(s.x * K, s.y * K);
      if (p.x < -5 || p.y < -5 || p.x > cam.W + 5 || p.y > cam.H + 5) continue;
      ctx.globalAlpha = s.a;
      if (hs > 1.6) { // ореол — как у настоящих звёзд при приближении
        ctx.fillStyle = hexA(s.col, 0.25);
        ctx.beginPath(); ctx.arc(p.x, p.y, DOT[s.k] * hs * 2.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = s.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, DOT[s.k] * hs, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (showGrid) drawScaleGrid();
    drawChaosCore();
    if (selSector && !selSector.chaos) drawSectorFill(selSector);
    if (showGrid) drawGrid(c);

    // Звёзды.
    const scale = Math.min(4, Math.max(1, Math.sqrt(zr)));
    const holes = [];
    for (const s of gal.stars) {
      const p = starPos(s);
      if (p.x < -10 || p.y < -10 || p.x > cam.W + 10 || p.y > cam.H + 10) continue;
      const k = s.type.key, r = DOT[k] * scale;
      if (k === 'blackhole') {
        // Чёрная дыра — неброско: маленькая тёмная точка с тонким тусклым ободком,
        // чтобы у ядра (где их много) не перебивала остальные звёзды.
        holes.push({ id: s.id, x: p.x, y: p.y, bh: r * 0.7 }); // рисуются после всех звёзд — см. drawHoles
        continue;
      }
      const col = MAP_COLOR[k] || s.type.color;
      if (k === 'nebula') {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
        g.addColorStop(0, hexA(col, 0.4)); g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2); ctx.fill();
      }
      if (scale > 1.6) {
        ctx.fillStyle = hexA(col, 0.25);
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }

    drawStreams(scale);
    drawHoles(holes);

    // Подписи при сильном приближении.
    if (zr > 9) {
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(200,215,240,0.7)';
      for (const s of gal.stars) {
        const p = starPos(s);
        if (p.x < 0 || p.y < 0 || p.x > cam.W || p.y > cam.H) continue;
        ctx.fillText(s.name, p.x, p.y + 14);
      }
    }

    ctx = mainCtx;
  }

  function draw() {
    ctx.setTransform(cam.DPR, 0, 0, cam.DPR, 0, 0);
    drawBackdrop(ctx, cam, bgStars);

    // Неподвижная часть (свечение, сетка, звёзды) кэшируется и перерисовывается,
    // только когда сдвинулась камера или сменилось выделение сектора.
    const key = [cam.x, cam.y, cam.zoom, cam.W, cam.H, cam.DPR, showGrid, selSector && selSector.key].join();
    if (key !== layerKey) { layerKey = key; renderLayer(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(cam.DPR, 0, 0, cam.DPR, 0, 0);

    drawStreamParticles();

    // Корабль — пульсирующее кольцо у текущей звезды.
    const cur = gal.stars[World.currentStarId()], cp = starPos(cur);
    const pulse = 8 + Math.sin(t * 3) * 2;

    // Перекрестие через корабль на весь экран — чтобы быстро найти его на карте.
    // Тонкое и полупрозрачное, с разрывом вокруг метки, чтобы не закрывать звезду.
    const gap = 16;
    ctx.strokeStyle = 'rgba(80,140,255,0.55)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cp.y); ctx.lineTo(cp.x - gap, cp.y);
    ctx.moveTo(cp.x + gap, cp.y); ctx.lineTo(cam.W, cp.y);
    ctx.moveTo(cp.x, 0); ctx.lineTo(cp.x, cp.y - gap - 12); // над меткой — ещё и треугольник
    ctx.moveTo(cp.x, cp.y + gap); ctx.lineTo(cp.x, cam.H);
    ctx.stroke();

    ctx.strokeStyle = '#6fffb0'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cp.x, cp.y, pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#6fffb0'; ctx.beginPath();
    ctx.moveTo(cp.x, cp.y - pulse - 3); ctx.lineTo(cp.x - 4, cp.y - pulse - 10); ctx.lineTo(cp.x + 4, cp.y - pulse - 10); ctx.fill();

    for (const [s, color] of [[hovered, 'rgba(255,255,255,0.5)'], [selected, '#7fb6ff']]) {
      if (!s) continue;
      const p = starPos(s);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.stroke();
      if (s === hovered && s !== selected) {
        ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#dbe5f7';
        ctx.fillText(s.name, p.x, p.y - 16);
      }
    }
    // Линия прыжка от корабля к выбранной звезде.
    if (selected && selected !== cur) {
      const p = starPos(selected);
      ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(111,255,176,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cp.x, cp.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // Масштабная сетка (линии — drawGridLines в viewport.js): всегда 100 × 100 клеток.
  // Подпись — световых лет в клетке и в экране. 1 кпк = 3261,56 св. года (реальные размеры: радиус ≈ 48 900 св. лет).
  const LY_PER_KPC = 3261.56, GRID_N = 100;
  function drawScaleGrid() {
    const cell = drawGridLines(ctx, cam, GRID_N); // мировых единиц в клетке
    const ly = cell / K * LY_PER_KPC;
    $('h-scale').textContent = `Сетка 100 × 100 · клетка ≈ ${niceNum(ly)} св. лет · экран ≈ ${niceNum(ly * GRID_N)} св. лет`;
  }

  // Шар абсолютного хаоса в центре: ослепительное ядро и рваный край из вспышек.
  // Край — заранее разыгранные «вспышки» в оболочке шара (свой rng, на мир не влияет).
  const chaosSpecks = (() => {
    const rng = mulberry32(hashSeed(gal.seed) ^ 0xc4a0);
    return Array.from({ length: 900 }, () => {
      // Разброс шире границы, яркость гаснет наружу — край растворяется в окружающих звёздах.
      const ang = rng() * Math.PI * 2, f = 0.4 + Math.pow(rng(), 0.8) * 1.4, r = GALAXY.chaosR * f;
      return { x: Math.cos(ang) * r, y: Math.sin(ang) * r, s: 0.6 + rng() * 1.6, a: (0.06 + rng() * 0.22) * Math.min(1, 1.6 - f * 0.75),
        col: ['255,240,210', '255,190,120', '255,120,80', '200,170,255'][Math.floor(rng() * 4)] };
    });
  })();
  function drawChaosCore() {
    const c = cam.toScreen(0, 0), R = GALAXY.chaosR * K * cam.zoom;
    // Мягкое свечение, далеко выходящее за границу шара: без резкого края и не слепит.
    const G = R * 2.4;
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, G);
    g.addColorStop(0, 'rgba(255,240,215,0.5)');
    g.addColorStop(0.15, 'rgba(255,220,175,0.4)');
    g.addColorStop(0.3, 'rgba(255,180,120,0.3)');
    g.addColorStop(0.45, 'rgba(230,140,95,0.15)');
    g.addColorStop(0.7, 'rgba(180,100,80,0.05)');
    g.addColorStop(1, 'rgba(120,60,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c.x, c.y, G, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    const k = Math.min(2.5, Math.max(1, Math.sqrt(zoomRel())));
    for (const p of chaosSpecks) {
      const q = cam.toScreen(p.x * K, p.y * K);
      ctx.fillStyle = `rgba(${p.col},${p.a})`;
      ctx.beginPath(); ctx.arc(q.x, q.y, p.s * k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    // Граница доступа — тонкий красноватый пунктир.
    ctx.setLineDash([3, 6]); ctx.strokeStyle = 'rgba(255,120,90,0.28)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  // Поток вещества от звезды-донора к чёрной дыре — движущиеся частицы (drawBezierFlow
  // в viewport.js): срываются по всей ширине звезды, к дыре сужаются, ускоряются и раскаляются.
  // Сам конус не рисуется — пользователь: «резкий переход, неестественно».
  // Геометрия одна на слой (диск у дыры) и на покадровые частицы — streamGeom.
  const diskAngle = new Map(), flowParts = new Map();
  function streamGeom(s, scale) {
    const b = gal.stars[s.bh.id], p = starPos(s), q = starPos(b);
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 6) return null; // слишком мелко — не видно
    if (Math.max(p.x, q.x) < -60 || Math.min(p.x, q.x) > cam.W + 60 || Math.max(p.y, q.y) < -60 || Math.min(p.y, q.y) > cam.H + 60) return null;
    // Изгиб — поток закручивается вокруг дыры (против часовой стрелки).
    const m = { x: (p.x + q.x) / 2 - (q.y - p.y) * 0.3, y: (p.y + q.y) / 2 + (q.x - p.x) * 0.3 };
    const W0 = Math.max(1.5, Math.min(len * 0.35, DOT[s.type.key] * scale * (1.6 + 1.6 * s.bh.index)));
    return { b, p, q, m, W0 };
  }
  function drawStreams(scale) { // в слое: только направление подлёта к дыре — для диска
    diskAngle.clear();
    for (const s of gal.stars) {
      if (!s.bh) continue;
      const gm = streamGeom(s, scale);
      if (gm && !diskAngle.has(gm.b.id)) diskAngle.set(gm.b.id, Math.atan2(gm.q.y - gm.m.y, gm.q.x - gm.m.x));
    }
  }
  function drawStreamParticles() { // каждый кадр поверх слоя
    const scale = Math.min(4, Math.max(1, Math.sqrt(zoomRel())));
    for (const s of gal.stars) {
      if (!s.bh) continue;
      const gm = streamGeom(s, scale);
      if (!gm) continue;
      if (!flowParts.has(s.id)) flowParts.set(s.id, makeFlowParticles(s.seed, 110));
      drawBezierFlow(ctx, gm.p, gm.m, gm.q, gm.W0, flowParts.get(s.id), t * (0.6 + s.bh.index * 0.8),
        MAP_COLOR[s.type.key] || s.type.color, Math.min(1.6, Math.max(0.6, scale * 0.45)));
    }
  }

  // Чёрные дыры с гравитационной линзой: картинка вокруг (свечение и звёзды) «стягивается»
  // к дыре — кольцами, чем ближе к центру, тем сильнее сжатие; затем затемнение у горизонта
  // и тонкое светящееся кольцо. Линза — по снимку уже нарисованного слоя, поэтому рисуется
  // после всех звёзд. Мелкие (при отдалённой карте) — без линзы, просто тёмная точка.
  const lensSrc = document.createElement('canvas');
  function drawHoles(holes) {
    const D = cam.DPR, RINGS = 12, LENS = 11; // LENS — радиус линзы в радиусах дыры
    const lensed = holes.filter(h => h.bh * LENS >= 12);
    if (lensed.length) {
      if (lensSrc.width !== layer.width || lensSrc.height !== layer.height) { lensSrc.width = layer.width; lensSrc.height = layer.height; }
      const lc = lensSrc.getContext('2d');
      lc.clearRect(0, 0, lensSrc.width, lensSrc.height);
      lc.drawImage(layer, 0, 0);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const h of lensed) {
        const x = h.x * D, y = h.y * D, R = h.bh * LENS * D;
        for (let i = RINGS; i >= 1; i--) {
          const ro = R * i / RINGS, ri = R * (i - 1) / RINGS;
          const s = 1 - 0.7 * (1 - i / RINGS) ** 1.1; // у края 1 (без искажения), к центру — сильное сжатие
          ctx.save();
          ctx.beginPath(); ctx.arc(x, y, ro, 0, Math.PI * 2); ctx.arc(x, y, ri, 0, Math.PI * 2, true); ctx.clip();
          ctx.clearRect(x - ro, y - ro, ro * 2, ro * 2); // иначе копия ляжет поверх оригинала и удвоит яркость
          ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y);
          ctx.drawImage(lensSrc, 0, 0);
          ctx.restore();
        }
        const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, 'rgba(0,0,0,1)');
        gr.addColorStop(0.12, 'rgba(0,0,0,0.9)');
        gr.addColorStop(0.35, 'rgba(0,0,0,0.3)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
        // Кольцо света, обогнувшего дыру, — мягкое свечение у горизонта.
        const ringR = h.bh * 2.2 * D;
        const rg = ctx.createRadialGradient(x, y, ringR * 0.75, x, y, ringR * 1.6);
        rg.addColorStop(0, 'rgba(255,200,140,0)');
        rg.addColorStop(0.3, 'rgba(255,200,140,0.35)');
        rg.addColorStop(1, 'rgba(255,200,140,0)');
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.arc(x, y, ringR * 1.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    for (const h of holes) {
      const lens = h.bh * 11 >= 12;
      // Аккреционный диск у дыры, которая питается от звезды: сплюснутый голубоватый эллипс
      // в плоскости подлёта потока.
      if (lens && diskAngle.has(h.id)) {
        const ang = diskAngle.get(h.id), rx = h.bh * 4, ry = h.bh * 1.3;
        ctx.save();
        ctx.translate(h.x, h.y); ctx.rotate(ang); ctx.scale(1, ry / rx);
        const dg = ctx.createRadialGradient(0, 0, h.bh * 0.9, 0, 0, rx);
        dg.addColorStop(0, 'rgba(235,245,255,0.95)');
        dg.addColorStop(0.35, 'rgba(150,200,255,0.7)');
        dg.addColorStop(1, 'rgba(80,130,255,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = dg;
        ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = lens ? '#000' : 'rgba(10,6,4,0.55)';
      ctx.beginPath(); ctx.arc(h.x, h.y, h.bh, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lens ? 'rgba(255,190,120,0.55)' : 'rgba(255,150,60,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.bh * (lens ? 1.5 : 1) + 0.8, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawGrid(c) {
    const ringW = GALAXY_RADIUS_KPC / 5;
    ctx.strokeStyle = 'rgba(140,170,230,0.16)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
      ctx.beginPath(); ctx.arc(c.x, c.y, i * ringW * K * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    }
    const wedge = Math.PI * 2 / GALAXY.sectorsAround, R = RW * cam.zoom;
    for (let i = 0; i < GALAXY.sectorsAround; i++) {
      const a = i * wedge;
      ctx.beginPath(); ctx.moveTo(c.x + Math.cos(a) * ringW * K * cam.zoom, c.y + Math.sin(a) * ringW * K * cam.zoom);
      ctx.lineTo(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R); ctx.stroke();
    }
    // Номера зон вдоль одного луча, номера секторов по внешнему краю.
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(160,185,235,0.55)';
    for (let z = 1; z <= 5; z++) {
      const rr = ((5 - z) + 0.5) * ringW * K * cam.zoom;
      ctx.fillText('зона ' + z, c.x + Math.cos(-wedge / 2) * rr, c.y + Math.sin(-wedge / 2) * rr);
    }
    for (let i = 0; i < GALAXY.sectorsAround; i++) {
      const a = (i + 0.5) * wedge, rr = R + 14;
      ctx.fillText(String(i + 1), c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr + 4);
    }
  }

  function drawSectorFill(sec) {
    const c = cam.toScreen(0, 0), ringW = GALAXY_RADIUS_KPC / 5 * K * cam.zoom;
    const r0 = (5 - sec.zone) * ringW, r1 = r0 + ringW, wedge = Math.PI * 2 / GALAXY.sectorsAround;
    const a0 = sec.sector * wedge, a1 = a0 + wedge;
    ctx.fillStyle = 'rgba(111,168,255,0.12)'; ctx.strokeStyle = 'rgba(111,168,255,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(c.x, c.y, r1, a0, a1); ctx.arc(c.x, c.y, r0, a1, a0, true); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  // ---------- Ввод ----------
  function starAt(sx, sy) {
    let best = null, bd = 16;
    for (const s of gal.stars) {
      const p = starPos(s), d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bd) { best = s; bd = d; }
    }
    return best;
  }
  function handleTap(sx, sy) {
    const s = starAt(sx, sy);
    if (s) { selected = s; selSector = gal.sectors[s.sectorKey]; renderCard(); return; }
    const w = cam.toWorld(sx, sy), r = Math.hypot(w.x, w.y) / K;
    selected = null;
    selSector = r < GALAXY.chaosR ? { chaos: true }
      : r <= GALAXY_RADIUS_KPC ? gal.sectors[sectorKey(zoneOf(r), sectorOf(w.x, w.y))] : null;
    renderCard();
  }

  // ---------- Интерфейс ----------
  const distKpc = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const fmt = n => n.toFixed(n < 10 ? 2 : 1).replace('.', ',');

  function renderHud() {
    const cur = World.currentStar();
    $('h-star').textContent = 'Галактика';
    $('h-seed').textContent = '#' + gal.seed;
    $('h-class').textContent = `Звёзд: ${gal.stars.length} · секторов: ${Object.keys(gal.sectors).length}`;
    $('h-gal').textContent = `Корабль у звезды ${cur.name} (сектор ${cur.sectorKey})`;
  }

  function renderCard() {
    const card = $('card');
    if (!selected && !selSector) { card.hidden = true; return; }
    card.hidden = false;
    const cur = World.currentStar();
    if (selSector && selSector.chaos) {
      $('c-swatch').style.background = 'radial-gradient(circle, #fff 10%, #ffd9a0 35%, #c0582a 65%, transparent 75%)';
      $('c-name').textContent = 'Ядро галактики';
      $('c-type').textContent = 'Зона абсолютного хаоса';
      $('c-facts').innerHTML = `<div><span>Радиус</span>${fmt(GALAXY.chaosR)} кпк</div><div><span>Доступ</span>закрыт</div>`;
      $('c-desc').innerHTML = '<div class="bhwarn">Сверхплотное скопление звёзд, чёрных дыр и раскалённого газа. Гравитация и излучение рвут любой корабль — залететь сюда нельзя.</div>';
      $('b-jump').hidden = true; $('c-dest-wrap').hidden = true;
      $('c-list').hidden = true;
      return;
    }
    if (selected) {
      const s = selected, sys = generateSystem(s);
      const here = s.id === cur.id;
      const counts = {};
      for (const p of sys.planets) counts[p.type] = (counts[p.type] || 0) + 1;
      $('c-swatch').style.background = s.type.key === 'blackhole'
        ? 'radial-gradient(circle, #000 45%, #ff9a3c 60%, transparent 72%)'
        : `radial-gradient(circle at 40% 40%, #fff, ${MAP_COLOR[s.type.key] || s.type.color} 55%, transparent 75%)`;
      $('c-name').textContent = s.name;
      $('c-type').textContent = s.type.name + (s.inArm ? ' · рукав' : '') + (s.bh ? ' · донор чёрной дыры' : '');
      $('c-facts').innerHTML =
        `<div><span>Зона</span>${GALAXY_ZONES[s.zone - 1].name}</div>` +
        `<div><span>Сектор</span>${s.sectorKey}</div>` +
        `<div><span>От центра</span>${fmt(s.r)} кпк</div>` +
        `<div><span>От корабля</span>${here ? 'здесь' : fmt(distKpc(s, cur)) + ' кпк'}</div>` +
        (here ? '' : (() => { const a = shipStats(findDesign(World.design())).accel, t = SHIP_LIGHT / a;
          const m = x => x < 120 ? Math.round(x) + ' с' : (x / 60).toFixed(1).replace('.', ',') + ' мин';
          return a > 0 ? `<div><span>Перелёт</span>разгон ${m(t)} · скачок · торможение ${m(t / 0.85)}</div>` : '<div><span>Перелёт</span>нет двигателей</div>'; })());
      $('c-desc').innerHTML = `Планет: ${sys.planets.length} — ` +
        Object.entries(counts).map(([k, n]) => `${PLANET_TYPES[k].name.toLowerCase()} ${n}`).join(', ') +
        (s.bh ? `<div class="bhwarn">Чёрная дыра ${gal.stars[s.bh.id].name} вытягивает вещество звезды. Индекс влияния ${fmt(s.bh.index)} — мир нестабилен: жизни нет, больше антиматерии, изотопов и трития, меньше водорода и силикатов.</div>` : '');
      $('b-jump').hidden = false;
      $('b-jump').textContent = here ? 'Открыть систему' : 'Лететь';
      // Цель внутри системы назначения: планета из списка — после скачка автопилот сразу ведёт к ней;
      // «к звезде» — корабль тормозит к звезде, планету игрок укажет на месте.
      $('c-dest-wrap').hidden = here;
      if (!here) $('c-dest').innerHTML = '<option value="">К звезде — планету выберу на месте</option>' +
        sys.planets.map(p => `<option value="${p.index}">${p.name} — ${PLANET_TYPES[p.type].name.toLowerCase()}${PLANET_TYPES[p.type].landable ? '' : ' (без посадки)'}</option>`).join('');
      $('c-list').hidden = true;
    } else {
      const sec = selSector, byType = {};
      for (const s of sec.stars) byType[s.type.key] = (byType[s.type.key] || 0) + 1;
      $('c-swatch').style.background = 'conic-gradient(from 0deg, #2f6fe0 0 30deg, transparent 30deg)';
      $('c-name').textContent = 'Сектор ' + sec.key;
      $('c-type').textContent = GALAXY_ZONES[sec.zone - 1].name;
      $('c-facts').innerHTML = STAR_TYPES.filter(t => byType[t.key])
        .map(t => `<div><span>${t.name}</span>${byType[t.key]}</div>`).join('');
      $('c-desc').textContent = `Звёзд в секторе: ${sec.stars.length}`;
      $('b-jump').hidden = true; $('c-dest-wrap').hidden = true;
      // Список звёзд сектора — нажатие выбирает звезду.
      const list = $('c-list');
      list.hidden = false;
      list.innerHTML = sec.stars.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .map(s => `<button class="li" data-id="${s.id}"><i style="background:${MAP_COLOR[s.type.key] || s.type.color}"></i>${s.name}<span>${s.type.name}</span></button>`).join('');
    }
  }
  $('c-list').addEventListener('click', e => {
    const b = e.target.closest('.li'); if (!b) return;
    selected = gal.stars[+b.dataset.id];
    const p = selected;
    cam.x = p.x * K; cam.y = p.y * K;
    if (zoomRel() < 6) cam.zoomGoal = fitZoom() * 6;
    renderCard();
  });
  $('c-close').onclick = () => { selected = null; selSector = null; renderCard(); };
  $('b-jump').onclick = () => {
    if (!selected) return;
    const cur = World.currentStarId();
    if (selected.id === cur) { location.href = World.systemUrl(cur); return; }
    // Межзвёздный перелёт (system.js startWarp): в своей системе корабль разгоняется к выбранной звезде
    // до скорости света, уходит в скачок и сразу оказывается в её системе, на подлёте — тормозит.
    const dest = $('c-dest').value;
    location.href = World.systemUrl(cur) + '&warp=' + selected.id + (dest !== '' ? '&dest=' + dest : '');
  };
  // «Корабль» — камера ныряет к звезде корабля (приближение + затемнение) и открывается его система;
  // там пролёт продолжается до самого корабля (system.html?arrive=1).
  $('b-ship').onclick = () => {
    if (cam.fly) return;
    const s = World.currentStar(), p = { x: s.x * K, y: s.y * K };
    const DUR = 1.8;
    cam.flyTo(() => p, Math.max(cam.zoom, fitZoom() * 120), DUR,
      () => { location.href = World.systemUrl(s.id) + '&arrive=1'; });
    setTimeout(() => screenFade(1, 600), DUR * 1000 - 600);
  };
  // Возврат назад из истории браузера (bfcache) — снять затемнение.
  window.addEventListener('pageshow', e => { if (e.persisted) { cam.fly = null; screenFade(0, 0); } });
  $('b-fit').onclick = fit;
  $('b-grid').onclick = () => { showGrid = !showGrid; $('b-grid').classList.toggle('on', showGrid); $('h-scale').hidden = !showGrid; };
  $('b-newgal').onclick = () => {
    if (!confirm('Сгенерировать новую галактику? Корабль окажется у стартовой звезды нового мира.')) return;
    location.href = `index.html?g=${(Math.random() * 2 ** 31) >>> 0}`;
  };

  // ---------- Цикл ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    cam.step(dt);
    cam.flyStep(dt);
    draw();
    requestAnimationFrame(frame);
  }

  window.__dbg = () => ({ gal, cam, selected, selSector, screenOf: id => starPos(gal.stars[id]) });

  history.replaceState(null, '', World.galaxyUrl());
  fit();
  renderHud();
  requestAnimationFrame(frame);
})();
