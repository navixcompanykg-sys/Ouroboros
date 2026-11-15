// Страница обязана работать ЧЕРЕЗ СЕРВЕР, а не быть открытой как файл.
//
// Беда, которую это лечит (пользователь ловил её дважды): страницу открывают двойным щелчком по
// файлу — `file:///E:/Уроборос/prices.html`. Скрипты при этом грузятся, а `fetch` к `data/`
// браузер запрещает, поэтому таблицы, которые пользователь вводит, молча подменяются зеркалом
// из localStorage. На экране старые числа, и ничем от свежих они не отличаются. Решение
// пользователя: «просто сделай полноценный сервер».
//
// Что делает этот файл: если страницу открыли как файл, он проверяет, поднят ли serve.js, и
//   - поднят  → перебрасывает на тот же адрес через http://localhost:8080;
//   - не поднят → показывает во весь экран, что делать, и НИЧЕГО не рисует: лучше пустая
//     страница с объяснением, чем правдоподобные устаревшие числа.
// Подключать ПЕРВЫМ скриптом на каждой странице.
(() => {
  if (location.protocol !== 'file:') return;

  const PORT = 8080;
  const name = (location.pathname.split('/').pop() || 'menu.html');
  const target = 'http://localhost:' + PORT + '/' + name + location.search + location.hash;

  // Проверка «сервер жив» через <script>: он грузится между источниками без CORS, в отличие
  // от fetch, которому из file:// ходить никуда нельзя.
  const probe = document.createElement('script');
  probe.src = 'http://localhost:' + PORT + '/ping.js?t=' + Date.now();
  probe.onload = () => location.replace(target);
  probe.onerror = () => banner();
  document.head.appendChild(probe);

  // Пока проверяем — прячем содержимое, чтобы устаревшие числа даже не мелькнули.
  const hide = document.createElement('style');
  hide.textContent = 'body > *:not(#no-server) { visibility: hidden !important; }';
  document.documentElement.appendChild(hide);

  function banner() {
    const show = () => {
      const el = document.createElement('div');
      el.id = 'no-server';
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
        'justify-content:center;background:#04060c;color:#e8eefc;font:15px/1.6 system-ui,sans-serif;' +
        'padding:24px;text-align:center';
      el.innerHTML =
        '<div style="max-width:560px">' +
        '<div style="font-size:21px;font-weight:600;margin-bottom:10px">Игра не запущена</div>' +
        '<p style="color:#9db4cc;margin:0 0 14px">Страница открыта как файл, поэтому она не видит ' +
        'данные проекта из папки <code style="color:#ffd9a0">data/</code> — а значит, показала бы ' +
        'старые числа из браузера вместо настоящих.</p>' +
        '<p style="margin:0 0 14px">Запустите <b>start-game.bat</b> (или <code style="color:#ffd9a0">node serve.js</code>) ' +
        'и откройте <a href="' + target + '" style="color:#6fa8ff">' + target + '</a></p>' +
        '<button id="no-server-retry" style="font:inherit;color:#e8eefc;background:#1e2c4a;' +
        'border:1px solid #2a3a5c;border-radius:8px;padding:8px 16px;cursor:pointer">Проверить снова</button>' +
        '</div>';
      document.body.appendChild(el);
      el.querySelector('#no-server-retry').onclick = () => location.reload();
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
  }
})();
