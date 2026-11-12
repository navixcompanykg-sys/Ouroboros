// Экран «Планета»: гекс-карта поверхности (pointy-top, осевые координаты, как v2 planet.html),
// слой местности или концентрации выбранного ресурса, карточка гекса/планеты.
(() => {
  const cvs = document.getElementById('view');
  const ctx = cvs.getContext('2d');
  const $ = id => document.getElementById(id);

  const qs = new URLSearchParams(location.search);
  const gstar = World.currentStar();
  const sys = generateSystem(gstar);
  const planet = sys.planets[Math.min(sys.planets.length - 1, Math.max(0, parseInt(qs.get('p'), 10) || 0))];
  const surf = generateSurface(planet, gstar);
  if (!surf) { location.href = World.systemUrl(gstar.id); return; } // газовый гигант — поверхности нет
  World.setShip(planet.index, true);

  const S = 40; // размер гекса (мировые единицы)
  const center = h => ({ x: S * Math.sqrt(3) * (h.q + h.r / 2), y: S * 1.5 * h.r });
  let layer = 'terrain', selected = null;

  const cam = createViewport(cvs, {
    onTap: handleTap,
    minZoom: () => fitZoom(), // дальше «всё в экран» не отдаляем
    maxZoom: () => fitZoom() * 6,
    panLimit: () => S * 1.5 * (surf.radius + 1), // центр обзора — над картой
  });
  const fitZoom = () => Math.min(cam.W, cam.H) * 0.36 / (S * 1.5 * (surf.radius + 0.8));
  cam.zoom = fitZoom();
  cam.y = -S * 0.8; // чуть ниже центра — сверху панели

  // ---------- Слой ресурса: максимум по гексам — для шкалы цвета ----------
  const maxOf = key => Math.max(1, ...surf.hexes.map(h => h.res[key] || 0));
  function heat(v) { // 0..1 → тёмно-синий → бирюзовый → жёлтый → красный
    const st = [[0, [20, 30, 60]], [0.35, [40, 150, 170]], [0.7, [240, 210, 80]], [1, [240, 80, 50]]];
    for (let i = 1; i < st.length; i++) if (v <= st[i][0]) {
      const [a, ca] = st[i - 1], [b, cb] = st[i], k = (v - a) / (b - a);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(',')})`;
    }
    return 'rgb(240,80,50)';
  }

  // ---------- Отрисовка ----------
  const bgStars = (() => { const r = mulberry32(gstar.seed); return Array.from({ length: 300 }, () => ({ x: r(), y: r(), s: r() * 1.2 + 0.2, a: r() * 0.5 + 0.15 })); })();
  function hexPath(cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      const x = cx + size * Math.cos(a), y = cy + size * Math.sin(a);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  function draw() {
    ctx.setTransform(cam.DPR, 0, 0, cam.DPR, 0, 0);
    drawBackdrop(ctx, cam, bgStars);
    const sz = S * cam.zoom, mx = layer === 'terrain' ? 0 : maxOf(layer);
    for (const h of surf.hexes) {
      const c = center(h), p = cam.toScreen(c.x, c.y);
      hexPath(p.x, p.y, sz * 0.97);
      ctx.fillStyle = layer === 'terrain' ? SURFACE_TYPES[h.type].color : heat((h.res[layer] || 0) / mx);
      ctx.fill();
      if (layer === 'terrain' && h.crater) { // кратеры — тёмные кольца
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = Math.max(1, sz * 0.05);
        ctx.beginPath(); ctx.arc(p.x - sz * 0.2, p.y + sz * 0.1, sz * 0.22, 0, Math.PI * 2); ctx.stroke();
      }
      if (layer !== 'terrain' && h.deposits && h.deposits.includes(layer)) { // месторождение — ромб
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.moveTo(p.x, p.y - sz * 0.25); ctx.lineTo(p.x + sz * 0.18, p.y); ctx.lineTo(p.x, p.y + sz * 0.25); ctx.lineTo(p.x - sz * 0.18, p.y); ctx.fill();
      }
      if (layer === 'terrain' && h.fresh && h.type !== 'icecap') { // пресная вода — голубая точка
        ctx.fillStyle = 'rgba(160,220,255,0.85)';
        ctx.beginPath(); ctx.arc(p.x + sz * 0.3, p.y - sz * 0.3, Math.max(1.5, sz * 0.07), 0, Math.PI * 2); ctx.fill();
      }
    }
    // Тонкие границы и выделение.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    for (const h of surf.hexes) { const c = center(h), p = cam.toScreen(c.x, c.y); hexPath(p.x, p.y, sz * 0.97); ctx.stroke(); }
    if (selected) {
      const c = center(selected), p = cam.toScreen(c.x, c.y);
      hexPath(p.x, p.y, sz * 0.97); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }

  // ---------- Ввод ----------
  function handleTap(sx, sy) {
    const w = cam.toWorld(sx, sy);
    // Перевод пикселей в осевые координаты с округлением кубических (pointy-top).
    const q = (Math.sqrt(3) / 3 * w.x - w.y / 3) / S, r = (2 / 3 * w.y) / S;
    let x = q, z = r, y = -x - z;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy <= dz) rz = -rx - ry;
    selected = surf.hexes.find(h => h.q === rx && h.r === rz) || null;
    renderCard();
  }

  // ---------- Интерфейс ----------
  const f2 = v => (v / 100).toLocaleString('ru', { maximumFractionDigits: 2 });
  function renderHud() {
    const T = PLANET_TYPES[planet.type], e = surf.env;
    $('h-name').textContent = planet.name;
    $('h-dot').style.background = T.colors[1];
    $('h-type').textContent = `${T.name} · ${SIZE_NAMES[planet.hexRadius]} · ${surf.hexes.length} гексов`;
    $('h-env').textContent = `Вода ${Math.round(e.water * 100)}% · атмосфера ${e.atmo ? 'есть' : 'нет'} · жизнь: ${LIFE_STATES[planet.life].name.toLowerCase()} · ${planet.tempK} K`;
    $('h-bh').hidden = !gstar.bh;
    if (gstar.bh) $('h-bh').textContent = `Донор чёрной дыры · индекс ${String(gstar.bh.index).replace('.', ',')} — мир нестабилен`;
  }
  function renderLayers() {
    const present = RESOURCES.filter(r => surf.hexes.some(h => h.res[r.key]));
    $('layers').innerHTML = `<button class="chip${layer === 'terrain' ? ' on' : ''}" data-l="terrain">Местность</button>` +
      present.map(r => `<button class="chip${layer === r.key ? ' on' : ''}" data-l="${r.key}">${r.name}</button>`).join('');
  }
  $('layers').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    layer = b.dataset.l; renderLayers(); renderCard();
  });

  function resRows(res, deposits) {
    const rows = RESOURCES.filter(r => res[r.key]).sort((a, b) => res[b.key] - res[a.key]);
    if (!rows.length) return '<div class="note">Ресурсов нет.</div>';
    const mx = Math.max(...rows.map(r => res[r.key]));
    return rows.map(r => `<div class="rr${layer === r.key ? ' hl' : ''}"><span class="rn">${r.name}${deposits && deposits.includes(r.key) ? ' ◆' : ''}</span>` +
      `<span class="rb"><i style="width:${res[r.key] / mx * 100}%"></i></span><span class="rv">${f2(res[r.key])}</span></div>`).join('');
  }
  function renderCard() {
    $('c-close').hidden = !selected;
    if (selected) {
      const h = selected, ST = SURFACE_TYPES[h.type];
      $('c-swatch').style.background = ST.color;
      $('c-name').textContent = ST.name;
      $('c-type').textContent = `Гекс ${h.q}, ${h.r}` + (h.crater ? ' · кратеры' : '') + (h.fresh ? ' · пресная вода' : '') + (h.deposits ? ' · месторождение' : '');
      $('c-body').innerHTML = resRows(h.res, h.deposits) + '<div class="note">Единиц массы на гекс. ◆ — месторождение.</div>';
    } else {
      const T = PLANET_TYPES[planet.type];
      const total = {};
      for (const h of surf.hexes) for (const k in h.res) total[k] = (total[k] || 0) + h.res[k];
      $('c-swatch').style.background = `radial-gradient(circle at 35% 35%, ${T.colors[0]}, ${T.colors[1]} 60%, ${T.colors[2]})`;
      $('c-name').textContent = 'Вся планета';
      $('c-type').textContent = 'Сумма по всем гексам';
      $('c-body').innerHTML = resRows(total) + '<div class="note">Сумма по гексам точно равна составу планеты. Выберите гекс — покажутся его ресурсы.</div>';
    }
  }
  $('c-close').onclick = () => { selected = null; renderCard(); };
  $('b-system').onclick = () => { location.href = World.systemUrl(gstar.id); };
  $('b-takeoff').onclick = () => { location.href = World.systemUrl(gstar.id) + '&takeoff=1'; };

  window.__dbg = () => ({ planet, surf, cam });

  renderHud(); renderLayers(); renderCard();
  (function frame() { draw(); requestAnimationFrame(frame); })();
})();
