// Оповещения игрока. Требование пользователя: когда добывающий корабль забил трюм или его
// жизнеобеспечение истощено больше чем наполовину, игрок должен об этом узнать, а щелчок по
// оповещению — ОТПРАВИТЬ К КОРАБЛЮ, чтобы можно было сразу дать приказ.
//
// Оповещения живут в localStorage, поэтому доходят и до других экранов: событие случилось на
// карте галактики — сообщение появится и там, и на экране планеты, пока его не закроют.
const Notify = (() => {
  const KEY = 'ouro.v3.alerts';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (_) { return []; } };
  const write = a => { try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, 12))); } catch (_) {} };

  let host = null;
  function mount() {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'alerts';
    document.body.appendChild(host);
    return host;
  }

  // id — чтобы одно и то же событие не плодило десяток сообщений.
  function push(a) {
    const all = read();
    if (a.id && all.some(x => x.id === a.id)) return;
    all.unshift({ ...a, ts: Date.now() });
    write(all); render();
  }
  function drop(id) { write(read().filter(x => x.id !== id)); render(); }
  function clear() { write([]); render(); }

  function render() {
    const all = read(), el = mount();
    el.innerHTML = all.map(a => `<div class="al ${a.kind || ''}" data-id="${a.id || ''}">` +
      `<div class="al-t">${a.text}</div>` +
      (a.url ? `<button class="al-go" data-url="${a.url}">К кораблю</button>` : '') +
      `<button class="al-x" aria-label="Закрыть">✕</button></div>`).join('');
  }

  document.addEventListener('click', e => {
    const go = e.target.closest('.al-go');
    if (go) { location.href = go.dataset.url; return; }
    const x = e.target.closest('.al-x');
    if (x) { const row = x.closest('.al'); drop(row.dataset.id); }
  });

  // Адрес, по которому игрок увидит именно этот корабль: сел на планету — экран планеты,
  // иначе — система, где он находится. Корабль по дороге делается активным (?pick=).
  function shipUrl(ship) {
    return ship.landed && ship.planet != null
      ? World.planetUrl(ship.star, ship.planet) + '&pick=' + ship.id
      : World.systemUrl(ship.star) + '&pick=' + ship.id;
  }
  const shipAlert = (ship, id, text, kind) => push({ id: 'ship' + ship.id + ':' + id, text, kind, url: shipUrl(ship) });

  // На загрузке экрана показываем то, что накопилось.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();

  return { push, drop, clear, render, shipUrl, shipAlert, list: read };
})();
