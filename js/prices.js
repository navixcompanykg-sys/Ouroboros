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
  const BLANK = { v: 1, buildings: {}, parts: {} };
  async function load() {
    const got = await Store.load('prices');
    prices = (got.data && got.data.v === 1) ? got.data : JSON.parse(JSON.stringify(BLANK));
    prices.buildings = prices.buildings || {};
    prices.parts = prices.parts || {};
    $('where').textContent = got.from === 'file' ? 'из файла data/prices.json'
      : got.from === 'local' ? 'из браузера (serve.js не отвечает)' : 'файла пока нет — вбиты текущие значения';
    // Файла ещё нет — значит в нём только что вбиты текущие значения кода, и их надо сохранить:
    // показываем «Сохранить» активной, а не делаем вид, что всё уже записано.
    if (!got.from) dirty = true;
    seed();
  }
  // Пустое место заполняем ТЕКУЩИМИ значениями кода — просьба пользователя «вбей сейчас текущие
  // значения». Уже введённое не трогаем.
  function seed() {
    for (const B of COL_BUILDINGS) {
      const cur = prices.buildings[B.key];
      if (cur) continue;
      prices.buildings[B.key] = { s: B.cost.s || 0, c: B.cost.c || 0, uniq: B.cost.uniq || 0, up: COL.UPKEEP_RAW };
    }
    for (const P of PARTS) {
      if (prices.parts[P.key]) continue;
      prices.parts[P.key] = computedPart(P.key);
    }
  }
  async function save() {
    const r = await Store.save('prices', prices);
    dirty = false;
    $('where').textContent = r.where === 'file' ? 'сохранено в data/prices.json'
      : r.where === 'local' ? 'сохранено только в браузере (serve.js не отвечает)' : 'сохранить не удалось';
    render();
  }

  // ---------- расчёт по таблице компонентов ----------
  // Сколько сырья уходит на предмет по составу из data/parts.json, с масштабом корабля ×10
  // (ТЗ §8.10). Это справка: цена может быть назначена и другая.
  function computedPart(key) {
    const comp = (tbl.comp || {})[key] || {};
    const out = { s: 0, c: 0, b: 0, e: 0 };
    const map = { struct: 's', compute: 'c', bio: 'b', energy: 'e' };
    for (const m of MAT_TYPES) {
      const per = rawPerItem(comp, 1)[m.key];
      out[map[m.key]] += (per[0] + per[1] + per[2]) * SHIP_SCALE;
    }
    return out;
  }

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
  function renderBuildings() {
    $('bld-body').innerHTML = COL_BUILDINGS.map(B => {
      const v = prices.buildings[B.key];
      const num = (f, title) => `<td class="n"><input type="number" min="0" step="10" data-b="${B.key}" data-f="${f}" value="${v[f]}" title="${title}"></td>`;
      return `<tr><td>${B.name}<i>${B.desc}</i></td>` +
        `<td class="g">${COL_GROUP_NAME[B.upkeep]}</td>` +
        num('s', 'структурного сырья на постройку') + num('c', 'вычислительного сырья на постройку') +
        `<td class="n"><input type="number" min="0" step="1" data-b="${B.key}" data-f="uniq" value="${v.uniq}" title="планетарных единиц"></td>` +
        num('up', 'содержание за час, сырьём своего типа') + `</tr>`;
    }).join('');
  }

  // ---------- 3. оборудование корабля ----------
  function renderParts() {
    let group = null, out = '';
    for (const P of PARTS) {
      if (P.group !== group) {
        group = P.group;
        const G = PART_GROUPS.find(x => x.key === group);
        out += `<tr class="hd"><td colspan="6">${G ? G.name : group}</td></tr>`;
      }
      const v = prices.parts[P.key], calc = computedPart(P.key);
      const comp = (tbl.comp || {})[P.key] || {};
      const compTxt = MAT_TYPES.filter(m => comp[m.key]).map(m => m.name.toLowerCase() + ' ' + comp[m.key]).join(', ') || '—';
      const num = f => `<td class="n"><input type="number" min="0" step="10" data-p="${P.key}" data-f="${f}" value="${v[f]}"></td>`;
      const total = v.s + v.c + v.b + v.e, calcTotal = calc.s + calc.c + calc.b + calc.e;
      out += `<tr><td>${P.name}<i>${compTxt}</i></td>` + num('s') + num('c') + num('b') + num('e') +
        `<td class="n"><b>${n0(total)}</b>${total !== calcTotal ? `<i>расчёт ${n0(calcTotal)}</i>` : ''}</td></tr>`;
    }
    $('part-body').innerHTML = out;
  }

  function render() {
    renderBuildings();
    renderParts();
    $('save').disabled = !dirty;
    $('save').textContent = dirty ? 'Сохранить' : 'Сохранено';
  }

  // ---------- ввод ----------
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.matches('input[type=number]')) return;
    const val = Math.max(0, Math.round(+el.value || 0));
    if (el.dataset.b) prices.buildings[el.dataset.b][el.dataset.f] = val;
    else if (el.dataset.p) prices.parts[el.dataset.p][el.dataset.f] = val;
    dirty = true;
    $('save').disabled = false;
    $('save').textContent = 'Сохранить';
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
