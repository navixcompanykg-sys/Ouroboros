// Камера и ввод для canvas-экранов (галактика, система): мышь + тач через Pointer Events.
// Щелчок/тап → opts.onTap(sx, sy); перетаскивание двигает камеру; колесо и щипок — масштаб.
function createViewport(cvs, opts) {
  const vp = { x: 0, y: 0, zoom: 1, zoomGoal: 0, follow: false, W: 0, H: 0, DPR: 1 };

  vp.toScreen = (x, y) => ({ x: (x - vp.x) * vp.zoom + vp.W / 2, y: (y - vp.y) * vp.zoom + vp.H / 2 });
  vp.toWorld = (sx, sy) => ({ x: (sx - vp.W / 2) / vp.zoom + vp.x, y: (sy - vp.H / 2) / vp.zoom + vp.y });

  vp.zoomAt = (sx, sy, factor) => {
    vp.zoomGoal = 0; // ручной масштаб отменяет автозум
    const before = vp.toWorld(sx, sy);
    vp.zoom = Math.min(opts.maxZoom(), Math.max(opts.minZoom(), vp.zoom * factor));
    const after = vp.toWorld(sx, sy);
    if (!vp.follow) { vp.x += before.x - after.x; vp.y += before.y - after.y; }
  };

  // Плавный автозум к vp.zoomGoal — вызывать каждый кадр.
  vp.step = dt => {
    if (!vp.zoomGoal) return;
    vp.zoom *= Math.pow(vp.zoomGoal / vp.zoom, Math.min(1, dt * 2));
    if (Math.abs(Math.log(vp.zoomGoal / vp.zoom)) < 0.01) vp.zoomGoal = 0;
  };

  function resize() {
    vp.DPR = Math.min(window.devicePixelRatio || 1, 2);
    vp.W = window.innerWidth; vp.H = window.innerHeight;
    cvs.width = Math.round(vp.W * vp.DPR); cvs.height = Math.round(vp.H * vp.DPR);
    cvs.style.width = vp.W + 'px'; cvs.style.height = vp.H + 'px';
    if (opts.onResize) opts.onResize();
  }
  window.addEventListener('resize', resize);
  resize();

  const pointers = new Map();
  let drag = null, pinch = null;

  cvs.addEventListener('pointerdown', e => {
    try { cvs.setPointerCapture(e.pointerId); } catch (_) { /* синтетические события */ }
    // Мышь — всегда один указатель: не даём «залипшему» указателю превратить клик в щипок.
    if (e.pointerType !== 'touch') { pointers.clear(); pinch = null; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null;
    }
  });
  cvs.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) { if (opts.onHover) opts.onHover(e.clientX, e.clientY); return; }
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      vp.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
      pinch.d = d;
    } else if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 7) {
        drag.moved = true;
        if (opts.onPanStart) opts.onPanStart();
      }
      if (drag.moved) {
        vp.x -= (e.clientX - prev.x) / vp.zoom;
        vp.y -= (e.clientY - prev.y) / vp.zoom;
      }
    }
  });
  const endPointer = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (drag && !drag.moved && e.type === 'pointerup') opts.onTap(e.clientX, e.clientY);
    if (pointers.size < 2) pinch = null;
    drag = null;
  };
  cvs.addEventListener('pointerup', endPointer);
  cvs.addEventListener('pointercancel', endPointer);
  cvs.addEventListener('wheel', e => {
    e.preventDefault();
    vp.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  return vp;
}

// Звёздный фон экрана (не мировые координаты): лёгкий параллакс от камеры.
function drawBackdrop(ctx, vp, stars) {
  ctx.fillStyle = '#04060c';
  ctx.fillRect(0, 0, vp.W, vp.H);
  const px = vp.x * vp.zoom * 0.03, py = vp.y * vp.zoom * 0.03;
  ctx.fillStyle = '#cfd8ff';
  for (const st of stars) {
    ctx.globalAlpha = st.a;
    ctx.fillRect(((st.x * vp.W - px) % vp.W + vp.W) % vp.W, ((st.y * vp.H - py) % vp.H + vp.H) % vp.H, st.s, st.s);
  }
  ctx.globalAlpha = 1;
}

// Масштабная сетка: n × n клеток по короткой стороне экрана, привязана к миру (едет при
// перетаскивании), каждая 10-я линия ярче. Возвращает размер клетки в мировых единицах —
// экран сам переводит его в свои единицы (св. годы, а. е.) для подписи.
function drawGridLines(ctx, vp, n) {
  const cell = Math.min(vp.W, vp.H) / n / vp.zoom;
  const tl = vp.toWorld(0, 0), br = vp.toWorld(vp.W, vp.H);
  ctx.lineWidth = 1;
  for (const axis of ['x', 'y']) {
    const lo = axis === 'x' ? tl.x : tl.y, hi = axis === 'x' ? br.x : br.y;
    for (let i = Math.floor(lo / cell); i <= Math.ceil(hi / cell); i++) {
      ctx.strokeStyle = i % 10 === 0 ? 'rgba(120,160,230,0.16)' : 'rgba(120,160,230,0.055)';
      const p = vp.toScreen(i * cell, i * cell);
      const v = Math.round(axis === 'x' ? p.x : p.y) + 0.5;
      ctx.beginPath();
      if (axis === 'x') { ctx.moveTo(v, 0); ctx.lineTo(v, vp.H); } else { ctx.moveTo(0, v); ctx.lineTo(vp.W, v); }
      ctx.stroke();
    }
  }
  return cell;
}

// Число с разумной точностью для подписей масштаба: 3 значащие цифры, пробелы в тысячах.
function niceNum(v) {
  return v >= 100 ? Math.round(Number(v.toPrecision(3))).toLocaleString('ru') : Number(v.toPrecision(2)).toLocaleString('ru');
}

// Поток частиц вдоль квадратичной кривой Безье p → m → q (вещество, которое чёрная дыра
// вытягивает из звезды). Частицы срываются по всей ширине W0 у начала, к концу поток
// сужается, частицы ускоряются и раскаляются; появляются и гаснут плавно — без резких краёв.
// time — секунды; parts — makeFlowParticles(seed). fromCol — цвет звезды (#rrggbb).
function makeFlowParticles(seed, n) {
  const rng = mulberry32(seed ^ 0xbeef);
  return Array.from({ length: n }, () => ({
    phase: rng(), speed: 0.06 + rng() * 0.08, off: gauss(rng) * 0.45, size: 0.7 + rng() * 1.2, a: 0.5 + rng() * 0.5,
  }));
}
function drawBezierFlow(ctx, p, m, q, W0, parts, time, fromCol, sizeK = 1) {
  const n = parseInt(fromCol.slice(1), 16), fr = n >> 16, fg = (n >> 8) & 255, fb = n & 255;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const pa of parts) {
    const tl = (pa.phase + pa.speed * time) % 1;
    const t = Math.pow(tl, 1.6); // у звезды медленно и густо, к дыре разгоняются и редеют
    const u = 1 - t;
    const x = u * u * p.x + 2 * u * t * m.x + t * t * q.x, y = u * u * p.y + 2 * u * t * m.y + t * t * q.y;
    let dx = 2 * u * (m.x - p.x) + 2 * t * (q.x - m.x), dy = 2 * u * (m.y - p.y) + 2 * t * (q.y - m.y);
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const w = W0 * Math.pow(u, 1.25) * pa.off;
    const cx = x - dy * w, cy = y + dx * w;
    const fade = Math.min(1, tl * 6) * Math.min(1, (1 - tl) * 5); // плавно появляются и гаснут
    const hot = Math.min(1, t * 1.4);
    const r = Math.round(fr + (255 - fr) * hot), g = Math.round(fg + (170 - fg) * hot), b = Math.round(fb + (80 - fb) * hot);
    const len = (1 + t * 4) * sizeK;
    ctx.strokeStyle = `rgba(${r},${g},${b},${pa.a * fade})`;
    ctx.lineWidth = pa.size * sizeK;
    ctx.beginPath(); ctx.moveTo(cx - dx * len, cy - dy * len); ctx.lineTo(cx + dx * len * 0.3, cy + dy * len * 0.3); ctx.stroke();
  }
  ctx.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
