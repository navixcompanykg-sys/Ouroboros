// Экран «Конструктор кораблей» (перенос v2 client/ship-deck-sectors.html без цен).
// Библиотека дизайнов — ships.js (loadDesigns/saveDesigns, своя копия в браузере);
// «Сделать моим кораблём» — World.setDesign: этот корабль летает в системах.
(() => {
  const $ = id => document.getElementById(id);
  let list = loadDesigns();
  let cur = Math.max(0, list.findIndex(d => d.name === (World.design() || START_DESIGN)));
  let selDeck = null; // "r:c" выбранной палубы

  const design = () => list[cur];
  const deckAt = (d, r, c) => d.decks.find(x => x[0] === r && x[1] === c);
  const save = () => saveDesigns(list);
  const fmtT = t => !isFinite(t) ? '—' : t < 120 ? `${Math.round(t)} с` : t < 7200 ? `${(t / 60).toFixed(1).replace('.', ',')} мин` : `${(t / 3600).toFixed(1).replace('.', ',')} ч`;
  const fmtN = (x, k = 0) => x.toFixed(k).replace('.', ',');
  const kms = v => isFinite(v) ? `${Math.round(v * KMS_PER_UNIT).toLocaleString('ru-RU')} км/с` : '∞';

  // Цитадель: первые слоты — обязательные модули.
  function fixCitadel(d) {
    const cls = shipClass(d.decks.length);
    for (const dk of d.decks) if (deckSector(dk[0], dk[1]) === CITADEL_SECTOR)
      CITADEL_MANDATORY.forEach((m, i) => { if (i < cls.perDeck) dk[2][i] = m; });
  }
  // Двигатель на палубе (r, c) — только если все построенные палубы левее в том же ряду (ближе к корме)
  // целиком заняты двигателями (v2 canPlaceEngine: «чтоб не устанавливался задним числом»).
  function canPlaceEngine(d, r, c) {
    const per = shipClass(d.decks.length).perDeck;
    for (const dk of d.decks) if (dk[0] === r && dk[1] < c)
      for (let s = 0; s < per; s++) if (!isEngine(dk[2][s])) return false;
    return true;
  }

  // ---------- Библиотека ----------
  function renderList() {
    const mine = World.design() || START_DESIGN;
    $('lib-list').innerHTML = list.map((d, i) => {
      const st = shipStats(d);
      return `<button class="li${i === cur ? ' sel' : ''}" data-i="${i}"><b>${d.name === mine ? '★ ' : ''}${esc(d.name)}</b>` +
        `<span>${st.cls.name} · ${st.decks} пал. · ${fmtN(st.mass)} т · система ${fmtT(travelTime(st.accel, 2 * SYSTEM_RADIUS))}</span></button>`;
    }).join('');
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('lib-list').onclick = e => {
    const b = e.target.closest('.li'); if (!b) return;
    cur = +b.dataset.i; selDeck = null; render();
  };
  const uniqueName = base => { let n = base, i = 2; while (list.some(d => d.name === n)) n = `${base} ${i++}`; return n; };
  $('b-new').onclick = () => {
    list.push({ name: uniqueName('Новый корабль'), decks: [[2, 3, [...CITADEL_MANDATORY]]] });
    cur = list.length - 1; selDeck = '2:3'; save(); render();
  };
  $('b-copy').onclick = () => {
    const c = JSON.parse(JSON.stringify(design())); c.name = uniqueName(c.name + ' (копия)');
    list.splice(cur + 1, 0, c); cur++; save(); render();
  };
  $('b-del').onclick = () => {
    if (list.length <= 1) return;
    if (!confirm(`Удалить «${design().name}»?`)) return;
    list.splice(cur, 1); cur = Math.min(cur, list.length - 1); selDeck = null; save(); render();
  };
  $('b-reset').onclick = () => {
    if (!confirm('Вернуть исходную библиотеку (26 кораблей v2)? Ваши правки и новые корабли пропадут.')) return;
    list = JSON.parse(JSON.stringify(SHIP_LIBRARY)); saveDesigns(list);
    cur = Math.max(0, list.findIndex(d => d.name === (World.design() || START_DESIGN))); selDeck = null; render();
  };
  $('d-name').oninput = e => {
    const old = design().name, name = e.target.value.trim();
    if (!name || list.some((d, i) => i !== cur && d.name === name)) return; // пустое или занятое — не сохраняем
    design().name = name;
    if (World.design() === old) World.setDesign(name);
    save(); renderList(); renderStats();
  };

  // ---------- Палубы ----------
  function renderGrid() {
    const d = design(), g = $('deck-grid'), per = shipClass(d.decks.length).perDeck;
    let html = '';
    for (let r = 0; r < DECK_ROWS; r++) for (let c = 0; c < DECK_COLS; c++) {
      const sec = deckSector(r, c), dk = deckAt(d, r, c), key = r + ':' + c;
      const used = dk ? dk[2].slice(0, per).filter(Boolean).length : 0;
      html += `<button class="deck${dk ? ' built' : ''}${sec === CITADEL_SECTOR ? ' citadel' : ''}${key === selDeck ? ' sel' : ''}"` +
        ` data-r="${r}" data-c="${c}" title="${SECTOR_NAMES[sec]}">${sec === CITADEL_SECTOR ? 'Ц' : sec}` +
        (dk ? `<i>${used}/${per}</i>` : '') + '</button>';
    }
    g.innerHTML = html;
  }
  $('deck-grid').onclick = e => {
    const b = e.target.closest('.deck'); if (!b) return;
    const r = +b.dataset.r, c = +b.dataset.c, d = design(), key = r + ':' + c;
    if (!deckAt(d, r, c)) {
      d.decks.push([r, c, deckSector(r, c) === CITADEL_SECTOR ? [...CITADEL_MANDATORY] : []]);
      fixCitadel(d); save();
    }
    selDeck = key; render();
  };
  $('b-clear').onclick = () => { design().decks = []; selDeck = null; save(); render(); };
  $('b-fill').onclick = () => {
    const d = design();
    for (let r = 0; r < DECK_ROWS; r++) for (let c = 0; c < DECK_COLS; c++)
      if (!deckAt(d, r, c)) d.decks.push([r, c, []]);
    fixCitadel(d); save(); render();
  };

  // Модули выбранной палубы.
  function renderDeckEdit() {
    const el = $('deck-edit'), d = design();
    if (!selDeck) { el.innerHTML = ''; return; }
    const [r, c] = selDeck.split(':').map(Number), dk = deckAt(d, r, c);
    if (!dk) { el.innerHTML = ''; return; }
    const cls = shipClass(d.decks.length), sec = deckSector(r, c), cit = sec === CITADEL_SECTOR;
    const engOk = canPlaceEngine(d, r, c);
    let html = `<h3>Палуба ${r + 1}·${c + 1} — ${SECTOR_NAMES[sec]} · модулей на палубу: ${cls.perDeck}</h3>`;
    for (let s = 0; s < cls.perDeck; s++) {
      const curK = dk[2][s] || '';
      if (cit && s < CITADEL_MANDATORY.length) {
        html += `<div class="slot"><span>${s + 1}</span><div class="lock">🔒 ${SHIP_MODULE[curK].name} — обязательно</div></div>`;
        continue;
      }
      html += `<div class="slot"><span>${s + 1}</span><select data-s="${s}"><option value="">— пусто —</option>` +
        SHIP_MODULES.map(m => {
          const lock = isEngine(m.key) && !engOk;
          return `<option value="${m.key}"${m.key === curK ? ' selected' : ''}${lock ? ' disabled' : ''}>${m.name} · ${m.mass} т${lock ? ' (левее не двигатели)' : ''}</option>`;
        }).join('') + '</select></div>';
    }
    const extra = dk[2].slice(cls.perDeck).filter(Boolean).length;
    if (extra) html += `<div class="warn">При классе «${cls.name}» на палубе ${cls.perDeck} слота — ещё ${extra} модул. не учитываются.</div>`;
    html += `<div class="row"><button id="b-undeck">Снять палубу</button></div>`;
    el.innerHTML = html;
    el.querySelectorAll('select').forEach(sel => sel.onchange = () => {
      dk[2][+sel.dataset.s] = sel.value || null;
      while (dk[2].length && !dk[2][dk[2].length - 1]) dk[2].pop();
      save(); render();
    });
    $('b-undeck').onclick = () => {
      d.decks = d.decks.filter(x => x !== dk); selDeck = null; fixCitadel(d); save(); render();
    };
  }

  // ---------- Характеристики ----------
  function renderStats() {
    const d = design(), st = shipStats(d);
    // Ускорение в настоящих м/с²: 1 мировая ед./с² = 11,4 км/с за секунду игры (≈ 1,52 сут) ≈ 0,0865 м/с².
    const ms2 = st.accel * KMS_PER_UNIT * 1000 / (365.25 * 86400 / 240), g = ms2 / 9.81;
    const rows = [
      ['Класс', st.cls.name],
      ['Палуб / слотов / модулей', `${st.decks} / ${st.slots} / ${st.modules}`],
      ['Масса', `${fmtN(st.mass)} т`],
      ['Прочность', st.durability],
      ['Двигателей', st.engines],
      ['Выработка энергии', `${st.energyGen} / цикл`],
      ['Спрос двигателей', `${st.energyDemand} / цикл`],
      ['Подача на двигатели', st.energyDemand ? `${Math.round(st.ratio * 100)}%` : '—'],
      ['Постоянный расход', `${st.energyPassive} / цикл`],
      ['Расход в бою', `${st.energyCombat} / цикл`],
      ['Ускорение на старте', `<span class="hl">${fmtN(ms2, 2)} м/с² (${fmtN(g, 2)} g)</span>`],
      ['Систему (500 а. е.)', `<span class="hl">${fmtT(travelTime(st.accel, 2 * SYSTEM_RADIUS))}</span>`],
      ['Между планетами (9 а. е.)', fmtT(travelTime(st.accel, 9 * AU))],
      ['До скорости света', fmtT(timeToSpeed(st.accel, SHIP_LIGHT))],
      ['Топливо', `${st.fuelName} (${FUEL[st.fuelKey].tier})` + (st.burnPerCycle > 0 ? `, ${st.fuelUnits} ед.` : st.engines ? ' — двигатели кормит реактор' : '')],
      ['Запас Δv', st.burnPerCycle > 0 ? kms(st.dv) : st.engines ? '∞' : '—'],
      ['Орудий', st.weapons],
      ['Грузовых отсеков', st.cargo],
      ['Аккумуляторы', st.battery ? `${st.battery.toLocaleString('ru-RU')} энергии` : '—'],
    ];
    let html = '<div class="kv">' + rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('') + '</div>';
    if (st.engines && st.ratio < 1) html += `<div class="warn">Энергии хватает на ${Math.round(st.ratio * 100)}% тяги: спрос ${st.energyDemand}, подача ${st.supply} (реакторы + газохранилища).</div>`;
    if (!st.engines) html += '<div class="warn">Нет двигателей — корабль не полетит.</div>';
    html += '<div class="muted small-text">Массы модулей — по умолчанию, цен нет (экономика v3 другая). Расчёт тяги — в <a href="reference.html">справочнике</a>: ускорение растёт со скоростью; средний корабль на тритии пересекает систему за 1,5 мин и разгоняется до c за 2 мин.</div>';
    $('st-main').innerHTML = html;

    // Секторы: прочность палуб (3 + модули), орудия, щиты — без цитадели (v2 sectorStats).
    const per = st.cls.perDeck, sec = Array.from({ length: 6 }, () => ({ pp: 0, om: 0, zp: 0, n: 0 }));
    for (const [r, c, mods] of d.decks) {
      const s = deckSector(r, c); if (s === CITADEL_SECTOR) continue;
      let pp = 3;
      for (const k of mods.slice(0, per)) if (k && SHIP_MODULE[k]) {
        pp += SHIP_MODULE[k].dur;
        if (k === 'weapon_mount') sec[s].om++;
        if (k === 'shield') sec[s].zp++;
      }
      sec[s].pp += pp; sec[s].n++;
    }
    $('st-sectors').innerHTML = '<table><tr><th>Сектор</th><th>Палуб</th><th>🧱 прочн.</th><th>🎯 орудий</th><th>🛡 щитов</th></tr>' +
      sec.map((x, i) => `<tr><td>${SECTOR_NAMES[i]}</td><td>${x.n}</td><td>${x.pp}</td><td>${x.om}</td><td>${x.zp}</td></tr>`).join('') + '</table>';

    const mine = (World.design() || START_DESIGN) === d.name;
    $('b-mine').disabled = mine || !st.engines;
    $('b-mine').textContent = mine ? '★ Это ваш корабль' : 'Сделать моим кораблём';
    $('st-mine').textContent = `Сейчас ваш корабль: ${World.design() || START_DESIGN}. Смена корабля — с полным баком.`;
  }
  $('b-mine').onclick = () => { World.setDesign(design().name); renderList(); renderStats(); };

  // Топливо — класс скорости (ships.js FUEL): водород — медленные, тритий — средние, антиматерия — быстрые.
  $('d-fuel').innerHTML = FUEL_KEYS.map(k => `<option value="${k}">Топливо: ${FUEL[k].name} — ${FUEL[k].tier}</option>`).join('');
  $('d-fuel').onchange = e => { design().fuel = e.target.value; save(); renderList(); renderStats(); };

  function render() {
    $('d-name').value = design().name;
    $('d-fuel').value = designFuel(design());
    $('d-class').textContent = `${shipClass(design().decks.length).name} — палуб ${design().decks.length}, на каждой до ${shipClass(design().decks.length).perDeck} модулей`;
    renderList(); renderGrid(); renderDeckEdit(); renderStats();
  }
  render();
  window.__dbg = () => ({ list, cur, design: design(), stats: shipStats(design()) });
})();
