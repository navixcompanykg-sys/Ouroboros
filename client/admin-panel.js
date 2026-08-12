'use strict';
// ══════════════════════════════════════════════════════════════════════════
// АДМИН-ПАНЕЛЬ СЕРВЕРА — сквозной элемент, не привязан ни к одному экрану.
//
// Подключается одной строкой (<script src="admin-panel.js">) на любой
// странице клиента: сама вставляет себе разметку/стили и живёт снаружи рамки
// телефона, справа от неё. Игрок её никогда не видит — это инструмент
// разработчика/администратора сервера (ТЗ_UI.md §1.1).
//
// Не зависит от того, что именно делает сама страница (грузит ли она карту
// сектора, держит SSE-соединение и т.п.) — опрашивает /api/stats раз в
// секунду самостоятельно, поэтому работает одинаково что на ship.html
// (сейчас статическая заглушка без связи с сервером), что на galaxy.html.
// ══════════════════════════════════════════════════════════════════════════

(function(){
  const css = `
    #admin{flex-shrink:0;width:150px;padding:12px;border:1px dashed rgba(255,100,68,0.4);
      background:rgba(20,8,8,0.5);}
    #admin h3{font-family:var(--mono);font-size:8px;letter-spacing:1px;color:#ff8060;margin-bottom:2px;}
    #admin .admin-note{font-family:var(--mono);font-size:6.5px;color:#ff8060;opacity:.7;line-height:1.5;margin-bottom:12px;}
    #admin .admin-group{margin-bottom:14px;}
    #admin .admin-label{font-family:var(--mono);font-size:7px;letter-spacing:1px;color:var(--text);opacity:.6;margin-bottom:5px;}
    #admin .admin-btn{display:block;width:100%;text-align:left;background:var(--panel-bg);border:1px solid var(--border);
      color:var(--text-bright);font-family:var(--mono);font-size:8.5px;padding:6px 8px;margin-bottom:3px;cursor:pointer;}
    #admin .admin-btn.game{border-color:#44cc88;color:#44cc88;}
    #admin .admin-btn.active{border-color:#ff8060;color:#ff8060;background:rgba(255,100,68,0.08);}
    #admin .admin-btn:active{border-color:#ff8060;}
    #admin .admin-stat{font-family:var(--mono);font-size:7px;color:var(--text);line-height:1.7;}
    #admin .admin-stat b{color:var(--accent2);font-weight:400;}
    #admin .admin-stat .bad{color:#ff8060;}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Базовая скорость — РЕАЛЬНОЕ время: 1 игровой месяц идёт ровно 1 календарный
  // месяц (gameSpeedRealtime в server/clock.go), это игровая скорость и значение
  // по умолчанию у сервера. Ускорители заданы КРАТНОСТЬЮ к ней, а не абсолютными
  // «месяцами в секунду»: абсолютные значения ни о чём не говорили («1 мес = 4
  // сек» — это во сколько раз быстрее игры?), а кратность читается сразу и не
  // требует пересчёта при смене базовой скорости.
  const REALTIME = 12 / (365.2425 * 24 * 60 * 60);
  // ×10000 добавлена по прямой просьбе пользователя — на ×120 движение звёзд
  // на карте сектора физически не заметить: даже у самой быстрой орбиты
  // (зона 1, 120 клетей/игровой месяц) одна клеть проходит за ~183 реальных
  // секунды (у самой медленной, зона 12, — почти 37 минут). На ×10000 та же
  // клеть — ~2.2 сек у зоны 1 (отчётливо видно), ~26 сек у зоны 12 (медленно,
  // но заметно за время наблюдения) — не баг, просто ×120 было мало.
  const MULTIPLIERS = [2, 5, 10, 60, 120, 10000];
  const SPEEDS = [
    { speed:0,        label:'пауза' },
    { speed:REALTIME, label:'× 1 — игровая (реальное время)', game:true },
    ...MULTIPLIERS.map(m => ({ speed: REALTIME*m, label: '× ' + m })),
  ];

  const root = document.createElement('div');
  root.id = 'admin';
  root.innerHTML = `
    <h3>АДМИН-ПАНЕЛЬ СЕРВЕРА</h3>
    <div class="admin-note">Вне экрана телефона — игрок этого не видит. Скорость меняется НА СЕРВЕРЕ и сразу действует для всех подключённых устройств и открытых экранов.</div>
    <div class="admin-group">
      <div class="admin-label">УСКОРЕНИЕ ВРЕМЕНИ</div>
      ${SPEEDS.map(s=>`<div class="admin-btn${s.game?' game':''}" data-speed="${s.speed}">${s.label}</div>`).join('')}
    </div>
    <div class="admin-group">
      <div class="admin-label">СОСТОЯНИЕ СЕРВЕРА</div>
      <div class="admin-stat" id="admin-stat">подключение…</div>
    </div>
    <div class="admin-group">
      <div class="admin-btn" id="admin-btn-planets">СПИСОК ПЛАНЕТ →</div>
      <div class="admin-btn" id="admin-btn-economy">ЭКОНОМИКА →</div>
      <div class="admin-btn" id="admin-btn-ship-sectors">СЕКТОРА ОБСТРЕЛА →</div>
    </div>
  `;
  document.body.appendChild(root);

  // ── лейаут: панель всегда рядом с рамкой телефона, а не скрыта media-
  // запросом по ширине. Каждая страница верстает #screen сама (ship.html /
  // galaxy.html), здесь только гарантируем, что body умеет расположить рядом
  // второй элемент и, если места по горизонтали не хватает (узкое окно —
  // например, эмулируем телефон на компьютере, сузив вкладку), перенести
  // панель под рамку и прокрутить страницу, а не спрятать панель вовсе. ──
  Object.assign(document.body.style, {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
    gap: '18px', minHeight: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '12px 0',
  });
  document.documentElement.style.height = '100%';

  // ── управление скоростью ──────────────────────────────────────────────
  const speedBtns = [...root.querySelectorAll('.admin-btn[data-speed]')];
  // Сравнение относительное, а не по фиксированному эпсилону: реальное время —
  // это ~3.8e-7 мес/сек, и любой абсолютный допуск вроде 1e-6 накрыл бы заодно
  // ноль, подсвечивая «паузу» одновременно с игровой скоростью.
  function sameSpeed(a, b){
    if (a === 0 || b === 0) return a === b;
    return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;
  }
  function markActive(speed){
    speedBtns.forEach(b=>b.classList.toggle('active', sameSpeed(Number(b.dataset.speed), speed)));
  }
  // Человекочитаемая скорость: «3.8e-7 мес/с» ничего не говорит. Главное —
  // кратность к игровой скорости, абсолютный темп — уточнением в скобках.
  function formatSpeed(speed){
    if (speed <= 0) return 'пауза';
    const mult = speed / REALTIME;
    const secPerMonth = 1 / speed;
    const per = secPerMonth >= 86400
      ? `${(secPerMonth/86400).toFixed(1)} сут`
      : `${(secPerMonth/3600).toFixed(1)} ч`;
    if (Math.abs(mult - 1) < 0.01) return `× 1 игровая (1 мес / ${per})`;
    return `× ${mult.toFixed(0)} (1 мес / ${per})`;
  }
  async function setSpeed(speed){
    try {
      const res = await fetch('api/speed', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({speed}),
      });
      const data = await res.json();
      markActive(data.speed);
    } catch(e) { /* следующий опрос /api/stats сам покажет «нет связи» */ }
  }
  speedBtns.forEach(btn => btn.onclick = () => setSpeed(Number(btn.dataset.speed)));

  root.querySelector('#admin-btn-planets').onclick = () => window.open('planets.html', '_blank');
  root.querySelector('#admin-btn-economy').onclick = () => window.open('economy.html', '_blank');
  root.querySelector('#admin-btn-ship-sectors').onclick = () => window.open('ship-deck-sectors.html', '_blank');

  // ── состояние сектора: собственный опрос, не зависит от логики страницы ──
  const statEl = root.querySelector('#admin-stat');
  async function poll(){
    try {
      const res = await fetch('api/stats', { cache:'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const s = await res.json();
      const by = s.byType || {};
      markActive(s.speed);
      statEl.innerHTML =
        `связь: <b>есть</b><br>` +
        `время: <b>${s.months.toFixed(2)}</b> мес<br>` +
        `скорость: <b>${formatSpeed(s.speed)}</b><br>` +
        `сид: <b>${s.seed}</b><br>` +
        `объектов: <b>${s.count}</b><br>` +
        `звёзд: <b>${by.star||0}</b> · ЧД: <b>${by.bh||0}</b><br>` +
        `туман.: <b>${by.neb||0}</b> · астер.: <b>${by.ast||0}</b><br>` +
        `масса: <b>${s.totalMass.toFixed(0)}</b> M☉`;
    } catch(e) {
      statEl.innerHTML = `связь: <b class="bad">нет</b><br>сервер не отвечает`;
    }
  }
  poll();
  setInterval(poll, 1000);
})();
