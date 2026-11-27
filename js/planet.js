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
  if (!surf) { location.href = World.systemUrl(gstar.id); return; } // поверхности нет вовсе
  // У газового гиганта твёрдой поверхности нет: корабль висит на НИЗКОЙ ОРБИТЕ и черпает газ
  // с гексов верхних слоёв атмосферы (ТЗ §8.13).
  const lowOrbit = !!PLANET_TYPES[planet.type].lowOrbit;
  // Оповещение «к кораблю» приводит сюда с ?pick= — сначала делаем этот корабль активным.
  const pick = parseInt(qs.get('pick'), 10);
  if (pick > 0 && World.fleet().some(s => s.id === pick)) World.setActive(pick);
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
    // Постройки колонии, текущая стройка и гекс, который копает корабль (js/planet-ui.js).
    const marks = typeof PlanetUI !== 'undefined' ? PlanetUI.marks() : [];
    for (const m of marks) {
      const h = surf.hexes.find(x => x.q === m.q && x.r === m.r); if (!h) continue;
      const c = center(h), p = cam.toScreen(c.x, c.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, sz * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'ship' ? 'rgba(255,205,120,0.92)'
        : m.kind === 'site' ? 'rgba(130,160,210,0.75)' : 'rgba(14,22,40,0.88)';
      ctx.fill();
      ctx.strokeStyle = m.kind === 'ship' ? '#ffd48a' : '#8fb4ff'; ctx.lineWidth = Math.max(1, sz * 0.05); ctx.stroke();
      ctx.fillStyle = m.kind === 'ship' ? '#2a1c04' : '#dce7ff';
      ctx.font = Math.round(sz * 0.5) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(m.text, p.x, p.y + sz * 0.02);
    }
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
    if (typeof PlanetUI !== 'undefined') PlanetUI.render();
  }

  // ---------- Интерфейс ----------
  // На гексе показываем не концентрацию, а ДОБЫЧУ ЗА 10 МИНУТ — столько возьмёт с него шахта
  // 1 уровня за один такт (ТЗ §8.7: 10 × уровень × содержание). Корабль берёт вдвое меньше.
  // Решение пользователя: «в гексах сразу отражай добычу за 10 минут».
  const f2 = v => Math.round(v * COL.MINE_K).toLocaleString('ru');
  function renderHud() {
    const T = PLANET_TYPES[planet.type], e = surf.env;
    $('h-name').textContent = planet.name;
    $('h-dot').style.background = T.colors[1];
    $('h-type').textContent = `${T.name} · ${SIZE_NAMES[planet.hexRadius]} · ${surf.hexes.length} гексов`
      + (lowOrbit ? ' · корабль на низкой орбите' : '');
    $('h-env').textContent = lowOrbit
      ? `Верхние слои атмосферы · твёрдой поверхности нет · ${planet.tempK} K`
      : `Вода ${Math.round(e.water * 100)}% · атмосфера ${e.atmo ? 'есть' : 'нет'} · жизнь: ${LIFE_STATES[planet.life].name.toLowerCase()} · ${planet.tempK} K`;
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
      $('c-body').innerHTML = resRows(h.res, h.deposits) + '<div class="note">Добыча за 10 минут: столько возьмёт шахта 1 уровня, корабль — вдвое меньше. ◆ — месторождение.</div>';
    } else {
      const T = PLANET_TYPES[planet.type];
      const total = {};
      for (const h of surf.hexes) for (const k in h.res) total[k] = (total[k] || 0) + h.res[k];
      $('c-swatch').style.background = `radial-gradient(circle at 35% 35%, ${T.colors[0]}, ${T.colors[1]} 60%, ${T.colors[2]})`;
      $('c-name').textContent = 'Вся планета';
      $('c-type').textContent = 'Сумма по всем гексам';
      // Пригодность для заселения (Habitat, colony.js): с колонией — с её токсичностью.
      const col = typeof PlanetUI !== 'undefined' ? PlanetUI.colony() : null;
      const tox = col && typeof Colony !== 'undefined' ? Colony.ecology(col, surf).tox : null;
      const hab = typeof Habitat !== 'undefined' ? '<div class="habbox">' + Habitat.html(planet, gstar, World.galaxy(), tox) + '</div>' : '';
      $('c-body').innerHTML = hab + resRows(total) + '<div class="note">Сумма по всей планете в тех же единицах — добыча за 10 минут. Выберите гекс — покажутся его ресурсы.</div>';
    }
  }
  $('c-close').onclick = () => { selected = null; renderCard(); };
  $('b-system').onclick = () => { location.href = World.systemUrl(gstar.id); };
  $('b-takeoff').onclick = () => { location.href = World.systemUrl(gstar.id) + '&takeoff=1'; };
  if (lowOrbit) $('b-takeoff').textContent = 'Уйти с орбиты';

  // Рельсы сворачиваются шевроном (ПК/планшет) и выезжают снизу (телефон) — docs/Интерфейс.md.
  // Состояние запоминается, чтобы экран не пересобирался при каждом заходе.
  const RAIL_KEY = 'ouro.v3.rails';
  const rails = (() => { try { return JSON.parse(localStorage.getItem(RAIL_KEY)) || {}; } catch (_) { return {}; } })();
  const compact = () => window.matchMedia('(max-width: 860px), (max-height: 480px) and (orientation: landscape)').matches;
  function applyRails() {
    for (const side of ['l', 'r']) {
      const el = $('rail-' + side), open = rails[side] !== false;
      el.classList.toggle('off', !open && !compact());
      el.classList.toggle('on', !!rails['m' + side] && compact());
      $('tg-' + side).textContent = side === 'l' ? (open ? '‹' : '›') : (open ? '›' : '‹');
    }
  }
  function toggleRail(side) {
    if (compact()) rails['m' + side] = !rails['m' + side];
    else rails[side] = rails[side] === false;
    try { localStorage.setItem(RAIL_KEY, JSON.stringify(rails)); } catch (_) {}
    applyRails();
  }
  $('tg-l').onclick = () => toggleRail('l');
  $('tg-r').onclick = () => toggleRail('r');
  $('rail-r-x').onclick = () => { rails.mr = false; applyRails(); };
  window.addEventListener('resize', applyRails);
  applyRails();
  document.getElementById('vtabs').addEventListener('click', () => {
    if (compact() && !rails.mr) { rails.mr = true; applyRails(); }
  });
  if (typeof PlanetUI !== 'undefined') PlanetUI.init({
    gstar, planet, surf, selected: () => selected, redraw: () => {},
  });

  window.__dbg = () => ({ planet, surf, cam, colony: () => PlanetUI.colony(), ship: () => World.active(),
    // Прокрутить время вперёд: такт колонии 10 реальных минут, живьём не посмотреть.
    skip(mins = 60) {
      const back = mins * 60 * 1000;
      const sh = World.active(); if (sh.at) sh.at -= back;
      const dt = Math.floor(back / COL.TICK_MS);
      { const L = World.hexLog(); if (L.t >= 0) L.t -= dt; }   // журнал снятых гексов — тоже назад
      for (const k in sh.hv || {}) sh.hv[k].t -= dt; // иначе лимит корабля остаётся в будущем
      for (const s of World.fleet()) if (s.route) {   // авторейс: его метки времени тоже назад
        if (s !== sh && s.at) s.at -= back;
        for (const k of ['until', 'next', 'arr', 't0']) if (s.route[k]) s.route[k] -= back;
        if (s !== sh) for (const k in s.hv || {}) s.hv[k].t -= dt;
      }
      const col = PlanetUI.colony(); if (col) col.t -= Math.floor(back / COL.TICK_MS);
      World.save(); PlanetUI.tick();
      return { ship: sh, colony: PlanetUI.colony() };
    } });

  renderHud(); renderLayers(); renderCard();
  (function frame() { draw(); requestAnimationFrame(frame); })();
})();
