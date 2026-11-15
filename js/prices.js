// Страница «Расценки» (prices.html): три таблицы.
//   1. Сколько ресурсов в гексе — СЧИТАЕТСЯ из генератора, не вводится. Нужна, чтобы назначать
//      цены от реальной добычи: в гексе показано столько, сколько возьмёт шахта 1 уровня за
//      10 минут (ТЗ §8.7), корабль — вдвое меньше.
//   2. Здания 1 уровня — цена и содержание, ВВОДИТ ПОЛЬЗОВАТЕЛЬ.
//   3. Оборудование корабля — цена в сырье, ВВОДИТ ПОЛЬЗОВАТЕЛЬ; рядом расчёт по таблице
//      компонентов (состав × масштаб корабля), чтобы было видно, от чего отклоняешься.
//
// ПРАВИЛО ХРАНЕНИЯ (CLAUDE.md): всё введённое лежит в файле проекта — data/prices.json через
// js/store.js. localStorage — только зеркало. Введённое НИКОГДА не перезаписывается кодом:
// пустое место заполняется расчётом, дальше правит только пользователь.
(() => {
  const $ = id => document.getElementById(id);
  const n0 = v => Math.round(v).toLocaleString('ru');
  let tbl = null, prices = null, dirty = false;

  // ---------- хранилище ----------
  const BLANK = { v: 2, buildings: {}, parts: {} };
  // Откуда взялись числа на экране — говорим прямо и всегда. Беда, которую это лечит: страницу
  // открывали двойным щелчком по файлу, fetch к data/ браузер запрещал, и показывалось зеркало
  // из localStorage, то есть СТАРЫЕ цены — молча, без единого намёка.
  function showSource(from) {
    const el = $('where');
    const viaFile = location.protocol === 'file:';
    el.classList.toggle('warn', from !== 'file');
    el.textContent = from === 'file' ? 'данные из файла data/prices.json — то, что лежит в проекте'
      : viaFile ? 'СТРАНИЦА ОТКРЫТА КАК ФАЙЛ: data/prices.json не читается, показано зеркало из браузера. Откройте http://localhost:8080/prices.html'
      : from === 'local' ? 'serve.js не отвечает: файл не прочитан, показано зеркало из браузера'
      : 'файла ещё нет — вбиты текущие значения кода, нажмите «Сохранить»';
  }

  async function load() {
    const got = await Store.load('prices');
    prices = (got.data && got.data.v === 2) ? got.data : JSON.parse(JSON.stringify(BLANK));
    prices.buildings = prices.buildings || {};
    prices.parts = prices.parts || {};
    showSource(got.from);
    // Файла ещё нет — значит в нём только что вбиты текущие значения кода, и их надо сохранить:
    // показываем «Сохранить» активной, а не делаем вид, что всё уже записано.
    if (!got.from || !(got.data && got.data.v === 2)) dirty = true;
    seed();
  }
  // Пустое место заполняем ТЕКУЩИМИ значениями кода — просьба пользователя «вбей сейчас текущие
  // значения». Уже введённое не трогаем.
  function seed() {
    for (const B of COL_BUILDINGS) {
      const cur = prices.buildings[B.key];
      if (cur) continue;
      prices.buildings[B.key] = { s: B.cost.s || 0, c: B.cost.c || 0, uniq: B.cost.uniq || 0,
        up: B.up || COL.UPKEEP_RAW,
        comp: { struct: (B.comp || {}).struct || 0, compute: (B.comp || {}).compute || 0,
          bio: (B.comp || {}).bio || 0, energy: (B.comp || {}).energy || 0 } };
    }
    for (const P of PARTS) {
      if (prices.parts[P.key]) continue;
      prices.parts[P.key] = computedPart(P.key);
    }
  }
  async function save() {
    const r = await Store.save('prices', prices);
    dirty = false;
    showSource(r.where === 'file' ? 'file' : r.where === 'local' ? 'local' : null);
    if (r.where === 'file') $('where').textContent = 'сохранено в data/prices.json';
    render();
  }

  // Перечитать файл: правил ли его кто-то снаружи, запускался ли инструмент. Если на экране
  // есть несохранённые правки — спрашиваем, а не затираем молча.
  async function reload(ask) {
    if (dirty && ask && !confirm('На экране есть несохранённые правки. Перечитать файл и потерять их?')) return;
    dirty = false;
    await load();
    render();
    renderHex();
  }
  $('reload').onclick = () => reload(true);
  // Вернулись на вкладку — подтягиваем файл сам, чтобы не смотреть в устаревшее.
  window.addEventListener('focus', () => { if (!dirty) reload(false); });

  // ---------- расчёт по таблице компонентов ----------
  // Сколько сырья уходит на предмет по составу из data/parts.json, с масштабом корабля ×10
  // (ТЗ §8.10). Это справка: цена может быть назначена и другая.
  // Части корабля собираются ИЗ КОМПОНЕНТОВ (решение пользователя): состав предмета из таблицы
  // компонентов × масштаб корабля ×10 (ТЗ §8.10).
  function computedPart(key) {
    const comp = (tbl.comp || {})[key] || {};
    const out = {};
    for (const m of MAT_TYPES) out[m.key] = (+comp[m.key] || 0) * SHIP_SCALE;
    return out;
  }
  // Один компонент 1 уровня в условных единицах (RESOURCE_VALUE, data.js).
  const compValue = mat => Ship.valueComp(mat, 1);
  const partValue = v => MAT_TYPES.reduce((a, m) => a + (v[m.key] || 0) * compValue(m.key), 0);

  // ---------- 1. сколько ресурсов в гексе ----------
  function hexStats(limit) {
    const gal = generateGalaxy(World.seed);
    const sum = {}, max = {}, perPlanetBest = {}, groupSum = { s: 0, c: 0, e: 0, b: 0 };
    const groupBest = { s: [], c: [], e: [], b: [] };
    let hexes = 0, planets = 0;
    for (let i = 0; i < gal.stars.length && planets < limit; i++) {
      const sys = generateSystem(gal.stars[i]);
      for (const pl of sys.planets) {
        if (planets >= limit) break;
        const surf = generateSurface(pl, gal.stars[i]);
        if (!surf) continue;
        planets++;
        const localBest = {}, localGroup = { s: 0, c: 0, e: 0, b: 0 };
        for (const h of surf.hexes) {
          hexes++;
          const gsum = { s: 0, c: 0, e: 0, b: 0 };
          for (const k in h.res) {
            sum[k] = (sum[k] || 0) + h.res[k];
            if (!max[k] || h.res[k] > max[k]) max[k] = h.res[k];
            groupSum[COL_KEY_GROUP[k]] += h.res[k];
            gsum[COL_KEY_GROUP[k]] += h.res[k];
            if (!localBest[k] || h.res[k] > localBest[k]) localBest[k] = h.res[k];
          }
          for (const g in gsum) if (gsum[g] > localGroup[g]) localGroup[g] = gsum[g];
        }
        // Лучший гекс ЭТОЙ планеты — по каждому ресурсу и по каждой группе.
        for (const k in localBest) (perPlanetBest[k] = perPlanetBest[k] || []).push(localBest[k]);
        for (const g in localGroup) if (localGroup[g] > 0) groupBest[g].push(localGroup[g]);
      }
    }
    const median = a => { if (!a || !a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
    return { sum, max, groupSum, hexes, planets,
      best: k => median(perPlanetBest[k]), bestGroup: g => median(groupBest[g]) };
  }

  function renderHex() {
    const st = hexStats(+$('hex-n').value || 150);
    const K = COL.MINE_K; // в гексе показываем добычу за 10 минут
    const rows = RESOURCES.map(r => {
      const avg = (st.sum[r.key] || 0) / st.hexes, best = st.best(r.key);
      return `<tr><td>${r.name}</td><td class="g">${COL_GROUP_NAME[COL_KEY_GROUP[r.key]]}</td>` +
        `<td class="n">${n0(avg * K)}</td><td class="n">${n0(best * K)}</td>` +
        `<td class="n">${n0(st.max[r.key] * K || 0)}</td><td class="n">${n0(best * K / 2)}</td></tr>`;
    }).join('');
    const groups = ['s', 'c', 'e', 'b'].map(g => {
      const avg = st.groupSum[g] / st.hexes, best = st.bestGroup(g);
      return `<tr><td colspan="2"><b>${COL_GROUP_NAME[g]} — вся группа</b></td>` +
        `<td class="n"><b>${n0(avg * K)}</b></td><td class="n"><b>${n0(best * K)}</b></td>` +
        `<td></td><td class="n"><b>${n0(best * K / 2)}</b></td></tr>`;
    }).join('');
    $('hex-body').innerHTML = rows + groups;
    $('hex-note').innerHTML = `Выборка: ${st.planets} планет, ${n0(st.hexes)} гексов галактики #${World.seed}.
      <b>Средний гекс</b> — по всем гексам подряд, включая пустые. <b>Лучший на планете</b> — медиана:
      столько даёт лучший гекс на обычной планете, именно сюда игрок и ставит шахту. <b>Рекорд выборки</b>
      — максимум по всем ${n0(st.hexes)} гексам; он растёт вместе с выборкой, и сравнивать со средним
      его нельзя. Разрыв между средним и лучшим — это месторождения: по правилам v2 ресурс лежит
      фоном на 2–65 % гексов плюс 2–4 месторождения, где и собрано почти всё (ТЗ §5).`;
  }

  // ---------- 2. здания ----------
  // Цена шахты — мера, с которой всё сравнивается на глаз (просьба пользователя «корабль
  // небольшой примерно как шахта»). Пересчитывается на каждый ввод, как и всё остальное.
  function mineValue() {
    const v = prices.buildings.mine_s; if (!v) return 0;
    return v.s * (RESOURCE_VALUE.silicates || 0) + v.c * (RESOURCE_VALUE.silicon || 0) +
      MAT_TYPES.reduce((a, m) => a + ((v.comp || {})[m.key] || 0) * compValue(m.key), 0);
  }
  let mineRef = 0;

  function renderBuildings() {
    mineRef = mineValue();
    $('bld-body').innerHTML = COL_BUILDINGS.map(B => {
      const v = prices.buildings[B.key];
      v.comp = v.comp || { struct: 0, compute: 0, bio: 0, energy: 0 };
      const num = (f, title) => `<td class="n"><input type="number" min="0" step="10" data-b="${B.key}" data-f="${f}" value="${v[f]}" title="${title}"></td>`;
      const cnum = m => `<td class="n"><input type="number" min="0" step="10" data-b="${B.key}" data-cf="${m}" value="${v.comp[m] || 0}" title="компонентов типа «${MAT_TYPE[m].name}»"></td>`;
      const val = v.s * (RESOURCE_VALUE.silicates || 0) + v.c * (RESOURCE_VALUE.silicon || 0) +
        MAT_TYPES.reduce((a, m) => a + (v.comp[m.key] || 0) * compValue(m.key), 0);
      return `<tr><td>${B.name}<i>${B.desc}</i></td>` +
        `<td class="g">${COL_GROUP_NAME[B.upkeep]}</td>` +
        num('s', 'структурного сырья на постройку') + num('c', 'вычислительного сырья на постройку') +
        cnum('struct') + cnum('compute') +
        `<td class="n"><input type="number" min="0" step="1" data-b="${B.key}" data-f="uniq" value="${v.uniq}" title="планетарных единиц"></td>` +
        num('up', 'содержание за час, сырьём своего типа') +
        `<td class="n" data-bval="${B.key}"><b>${n0(val)}</b><i>${mineRef ? (val / mineRef).toFixed(1) + ' шахты' : ''}</i></td></tr>`;
    }).join('');
  }

  // ---------- 3. оборудование корабля ----------
  function renderParts() {
    let group = null, out = '';
    for (const P of PARTS) {
      if (P.group !== group) {
        group = P.group;
        const G = PART_GROUPS.find(x => x.key === group);
        out += `<tr class="hd"><td colspan="7">${G ? G.name : group}</td></tr>`;
      }
      const v = prices.parts[P.key], calc = computedPart(P.key);
      const comp = (tbl.comp || {})[P.key] || {};
      const compTxt = MAT_TYPES.filter(m => comp[m.key]).map(m => m.name.toLowerCase() + ' ' + comp[m.key]).join(', ') || '—';
      const num = m => `<td class="n"><input type="number" min="0" step="10" data-p="${P.key}" data-f="${m}" value="${v[m] || 0}"></td>`;
      const total = MAT_TYPES.reduce((a, m) => a + (v[m.key] || 0), 0);
      const calcTotal = MAT_TYPES.reduce((a, m) => a + (calc[m.key] || 0), 0);
      out += `<tr><td>${P.name}<i>состав: ${compTxt}</i></td>` +
        MAT_TYPES.map(m => num(m.key)).join('') +
        `<td class="n" data-ptot="${P.key}"><b>${n0(total)}</b>${total !== calcTotal ? `<i>расчёт ${n0(calcTotal)}</i>` : ''}</td>` +
        `<td class="n" data-pval="${P.key}">${n0(partValue(v))}</td></tr>`;
    }
    $('part-body').innerHTML = out;
  }

  // ---------- эталон стоимости ----------
  function renderValue() {
    const rows = RESOURCES.map(r => `<tr><td>${r.name}</td><td class="g">${COL_GROUP_NAME[COL_KEY_GROUP[r.key]]}</td>` +
      `<td class="n">${n0(RESOURCE_VALUE[r.key])}</td><td class="n">${RESOURCE_STATS[r.key].avg}</td></tr>`).join('');
    const comps = MAT_TYPES.map(m => `<tr><td>Компонент: ${m.name}</td><td class="g">1 уровень</td>` +
      `<td class="n">${n0(compValue(m.key))}</td><td class="n g">3 × ${RESOURCES.find(r => r.key === m.res[0]).name.toLowerCase()}</td></tr>`).join('');
    $('val-body').innerHTML = rows + comps;
  }

  // Готовые корабли из библиотеки: цена в компонентах и в шахтах — чтобы правку цены предмета
  // было видно сразу на итоге, а не считать в уме.
  function renderShips() {
    const rows = loadDesigns().map(d => {
      const cost = {}, mods = designModules(d).concat(d.decks.map(() => 'frame'));
      for (const key of mods) {
        const v = prices.parts[key]; if (!v) continue;
        for (const m of MAT_TYPES) cost[m.key] = (cost[m.key] || 0) + (v[m.key] || 0);
      }
      const tot = MAT_TYPES.reduce((a, m) => a + (cost[m.key] || 0), 0);
      const val = MAT_TYPES.reduce((a, m) => a + (cost[m.key] || 0) * compValue(m.key), 0);
      return { name: d.name, mods: designModules(d).length, tot, val };
    }).sort((a, b) => a.val - b.val);
    $('ship-body').innerHTML = rows.map(r =>
      `<tr><td>${r.name}</td><td class="g">${r.mods} модулей</td><td class="n">${n0(r.tot)}</td>` +
      `<td class="n">${n0(r.val)}</td><td class="n">${mineRef ? (r.val / mineRef).toFixed(1) : '—'}</td></tr>`).join('');
  }

  // Пересчитать ТОЛЬКО производные числа: итоги строк, «в шахтах» и таблицу кораблей.
  // Поля ввода не трогаем — иначе при наборе слетает фокус и каретка.
  function refreshDerived() {
    mineRef = mineValue();
    for (const B of COL_BUILDINGS) {
      const v = prices.buildings[B.key]; if (!v) continue;
      v.comp = v.comp || {};
      const val = v.s * (RESOURCE_VALUE.silicates || 0) + v.c * (RESOURCE_VALUE.silicon || 0) +
        MAT_TYPES.reduce((a, m) => a + (v.comp[m.key] || 0) * compValue(m.key), 0);
      const cell = document.querySelector('[data-bval="' + B.key + '"]');
      if (cell) cell.innerHTML = '<b>' + n0(val) + '</b><i>' + (mineRef ? (val / mineRef).toFixed(1) + ' шахты' : '') + '</i>';
    }
    for (const P of PARTS) {
      const v = prices.parts[P.key]; if (!v) continue;
      const calc = computedPart(P.key);
      const total = MAT_TYPES.reduce((a, m) => a + (v[m.key] || 0), 0);
      const calcTotal = MAT_TYPES.reduce((a, m) => a + (calc[m.key] || 0), 0);
      const t = document.querySelector('[data-ptot="' + P.key + '"]');
      const w = document.querySelector('[data-pval="' + P.key + '"]');
      if (t) t.innerHTML = '<b>' + n0(total) + '</b>' + (total !== calcTotal ? '<i>расчёт ' + n0(calcTotal) + '</i>' : '');
      if (w) w.textContent = n0(partValue(v));
    }
    renderShips();
  }

  function render() {
    renderValue();
    renderBuildings();
    renderParts();
    renderShips();
    $('save').disabled = !dirty;
    $('save').textContent = dirty ? 'Сохранить' : 'Сохранено';
  }

  // ---------- ввод ----------
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.matches('input[type=number]')) return;
    const val = Math.max(0, Math.round(+el.value || 0));
    if (el.dataset.b && el.dataset.cf) prices.buildings[el.dataset.b].comp[el.dataset.cf] = val;
    else if (el.dataset.b) prices.buildings[el.dataset.b][el.dataset.f] = val;
    else if (el.dataset.p) prices.parts[el.dataset.p][el.dataset.f] = val;
    dirty = true;
    $('save').disabled = false;
    $('save').textContent = 'Сохранить';
    refreshDerived(); // изменения видны сразу, без пересборки полей
  });
  $('save').onclick = save;
  $('hex-go').onclick = renderHex;
  // Пересчёт по текущему коду — по ЯВНОЙ кнопке и с предупреждением (правило хранения).
  $('reset').onclick = async () => {
    if (!confirm('Заменить все цены текущими значениями кода? Введённые вами числа будут потеряны.')) return;
    const copy = await Store.backup('prices', prices);
    prices = JSON.parse(JSON.stringify(BLANK));
    seed(); dirty = true; render();
    alert(copy ? 'Прежние цены сохранены копией: ' + copy : 'Копию файлом сделать не удалось (нет serve.js)');
  };

  (async () => {
    const got = await Store.load('parts');
    tbl = loadParts(got.data);
    await load();
    render();
    renderHex();
  })();
})();
