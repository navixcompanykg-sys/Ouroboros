// ============================================================
// МИН. РАЗВИТИЯ — ui/development.js
// Открывается ВНУТРИ #planet-ui, заменяет центральную область.
// Экспортирует: open(planet, context), close()
// ============================================================

// ── BUILDINGS CONFIG ─────────────────────────────────────────

const RES_ICONS = {
  silicates:'🪨', carbonates:'🧱', bitumens:'🛢', iron:'⚙',
  refract:'🌡', rare_metals:'💎', platinoids:'✨',
  hydrogen:'💧', deuterium:'⚛', helium3:'🌀',
  noble_gas:'🫧', volc_gas:'🌋', radioact:'☢',
  biomass:'🌿', phosphates:'🧪', water_ice:'🧊',
  metal_struct:'🔩', hq_alloys:'🏗', ind_equip:'🏭',
  electronics:'💻', cable:'🔌', power_elements:'🔋',
  polymers:'🧴', chem_reagents:'⚗', weapons:'⚔',
  nuclear_comp:'☣', biosynthetics:'🧬',
};

const RES_NAMES = {
  silicates:'Силикаты', carbonates:'Карбонаты', bitumens:'Битумы', iron:'Железо',
  refract:'Тугоплавкие', rare_metals:'Редкоземельные', platinoids:'Платиноиды',
  hydrogen:'Водород', deuterium:'Дейтерий', helium3:'Гелий-3',
  noble_gas:'Благородные газы', volc_gas:'Вулканические газы', radioact:'Радиоактивные',
  biomass:'Биомасса', phosphates:'Фосфаты', water_ice:'Водяной лёд',
  metal_struct:'Металлоконстр.', hq_alloys:'В/к сплавы', ind_equip:'Пром. обор.',
  electronics:'Электроника', cable:'Кабельная', power_elements:'Эл. питания',
  polymers:'Полимеры', chem_reagents:'Хим. реагенты', weapons:'Вооружение',
  nuclear_comp:'Ядерные компон.', biosynthetics:'Биосинтетика',
};

const BUILDINGS_CFG = {
  // ЭНЕРГЕТИКА
  hydrogen_station: {
    name: 'Водородная станция', icon: '⚡', category: 'energy',
    desc: 'Сжигает водород для получения энергии',
    effect: '+10 энергии/ур',
    maxLevel: 12, energyOutput: 10,
    baseCost: { silicates:18, carbonates:8, bitumens:3, iron:9, metal_struct:6, cable:3 },
  },
  atomic_station: {
    name: 'Атомная станция', icon: '☢', category: 'energy',
    desc: 'Ядерное расщепление, высокий КПД',
    effect: '+50 энергии/ур',
    maxLevel: 12, energyOutput: 50,
    baseCost: { silicates:30, carbonates:12, bitumens:6, iron:12, metal_struct:15,
                hq_alloys:9, cable:8, electronics:5, nuclear_comp:2, power_elements:5 },
  },
  hydro_station: {
    name: 'Гидростанция', icon: '🌊', category: 'energy',
    desc: 'Использует водные и паровые потоки',
    effect: '+20 энергии/ур',
    maxLevel: 12, energyOutput: 20,
    baseCost: { silicates:120, carbonates:45, bitumens:18, iron:53, metal_struct:27, ind_equip:6 },
  },
  green_energy: {
    name: 'Зелёная энергетика', icon: '🌿', category: 'energy',
    desc: 'Солнечные панели и ветрогенераторы',
    effect: '+10 энергии/ур, без токсичности',
    maxLevel: 12, energyOutput: 10,
    baseCost: { silicates:15, carbonates:6, bitumens:3, metal_struct:6,
                hq_alloys:5, rare_metals:8, platinoids:3, cable:5 },
  },
  // ДОБЫЧА
  mine: {
    name: 'Горнодобывающая', icon: '⛏', category: 'extraction',
    desc: 'Подземная добыча твёрдых руд',
    effect: '+добыча минералов/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:35, carbonates:14, bitumens:7, iron:12, metal_struct:6, ind_equip:4 },
  },
  atmo_collector: {
    name: 'Атмосферный собиратель', icon: '🌬', category: 'extraction',
    desc: 'Сбор газов из атмосферы планеты',
    effect: '+добыча газов/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:20, carbonates:8, bitumens:4, iron:6, metal_struct:6, cable:3 },
  },
  bioextractor: {
    name: 'Биоэкстрактор', icon: '🧬', category: 'extraction',
    desc: 'Извлечение органической биомассы',
    effect: '+биомасса, фосфаты/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:22, carbonates:9, bitumens:10, iron:4, metal_struct:5, polymers:4 },
  },
  hydro_farm: {
    name: 'Гидроминеральная ферма', icon: '💧', category: 'extraction',
    desc: 'Добыча из океанов и водоёмов',
    effect: '+вода, фосфаты/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:18, carbonates:8, bitumens:14, iron:3, metal_struct:4, polymers:5 },
  },
  // ПРОИЗВОДСТВО
  metallurgy: {
    name: 'Металлургия', icon: '🔩', category: 'production',
    desc: 'Переплавка руд в конструкционные материалы',
    effect: '+металлоконстр., сплавы/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:50, carbonates:18, bitumens:8, iron:12, metal_struct:10, ind_equip:6, refract:5 },
  },
  chem_plant: {
    name: 'Химический завод', icon: '🧪', category: 'production',
    desc: 'Органический и неорганический синтез',
    effect: '+полимеры, реагенты/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:30, carbonates:12, bitumens:10, iron:7, metal_struct:8, polymers:6, chem_reagents:3 },
  },
  electro_plant: {
    name: 'Электрозавод', icon: '🔌', category: 'production',
    desc: 'Производство электронных компонентов',
    effect: '+электроника, кабель/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:25, carbonates:10, bitumens:5, iron:6, metal_struct:8, cable:6, power_elements:3 },
  },
  advanced_lab: {
    name: 'Лаборатория систем', icon: '🔬', category: 'production',
    desc: 'Разработка передовых технологий',
    effect: '+скорость исследований',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:20, carbonates:8, bitumens:4, iron:4, metal_struct:7, cable:5, electronics:3, power_elements:2 },
  },
  // НАСЕЛЕНИЕ
  housing: {
    name: 'Жилые кварталы', icon: '🏠', category: 'population',
    desc: 'Жилые блоки для населения',
    effect: '+1000 мест/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:25, carbonates:10, bitumens:5, iron:8, metal_struct:4 },
  },
  dome: {
    name: 'Защитные купола', icon: '🔮', category: 'population',
    desc: 'Изолирует от токсичной и радиоактивной среды',
    effect: 'снижает токс./рад., −1 мораль на 2 купола',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:40, carbonates:15, bitumens:8, metal_struct:8, polymers:6 },
  },
  food_production: {
    name: 'Пищевое производство', icon: '🌾', category: 'population',
    desc: 'Промышленный синтез пищи',
    effect: '+20 еды/ур/тик',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:15, carbonates:6, bitumens:3, iron:5, metal_struct:3, polymers:4 },
  },
  plantation: {
    name: 'Плантации', icon: '🌱', category: 'population',
    desc: 'Органическое земледелие',
    effect: '+10 еды/ур/тик',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:10, carbonates:4, bitumens:5, iron:3, metal_struct:2, polymers:5 },
  },
  // ОБОРОНА
  planetary_battery: {
    name: 'Планетарные батареи', icon: '🛡', category: 'defense',
    desc: 'Орбитальная артиллерия планеты',
    effect: '+защита орбиты/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:25, carbonates:10, bitumens:5, iron:10, metal_struct:10,
                hq_alloys:8, weapons:6, electronics:4, cable:4, power_elements:3 },
  },
  shipyard: {
    name: 'Верфь', icon: '🚀', category: 'defense',
    desc: 'Строительство и ремонт кораблей',
    effect: 'разблокирует постройку флота',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:35, carbonates:14, bitumens:7, iron:10, metal_struct:15,
                hq_alloys:8, ind_equip:6, cable:5, electronics:3, power_elements:3 },
  },
  cryptofarm: {
    name: 'Криптоферма', icon: '💎', category: 'special',
    desc: 'Майнинг цифровой валюты',
    effect: '+доход в тик (высокий расход энергии)',
    maxLevel: 12, energyPerLevel: 3,
    baseCost: { silicates:10, carbonates:4, bitumens:2, metal_struct:5,
                electronics:6, cable:5, power_elements:4, rare_metals:5 },
  },
  warehouse: {
    name: 'Склад', icon: '📦', category: 'special',
    desc: 'Хранение ресурсов и резервов',
    effect: '+5000 складских мест/ур',
    maxLevel: 12, energyPerLevel: 0,
    baseCost: { silicates:40, carbonates:15, bitumens:10, iron:20, metal_struct:12, ind_equip:4 },
  },
  // ЭКОЛОГИЯ / НАУКА / РАЗВЕДКА
  purification: {
    name: 'Очистительные сооружения', icon: '♻', category: 'ecology',
    desc: 'Фильтрация промышленных выбросов',
    effect: '−8% токсичности/ур/тик',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:20, carbonates:8, bitumens:4, iron:5, metal_struct:8,
                hq_alloys:4, ind_equip:5, chem_reagents:6, electronics:3, cable:4, polymers:5 },
  },
  cultural_center: {
    name: 'Культурный центр', icon: '🎭', category: 'ecology',
    desc: 'Повышает моральный дух населения',
    effect: '+1 мораль/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:25, carbonates:10, bitumens:5, iron:8, metal_struct:6,
                ind_equip:3, electronics:5, cable:4, power_elements:3, polymers:8 },
  },
  science_center: {
    name: 'Научный центр', icon: '🔭', category: 'special',
    desc: 'Фундаментальные исследования',
    effect: '+1 очко науки/тик/ур',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:15, carbonates:6, bitumens:3, metal_struct:5,
                hq_alloys:4, ind_equip:3, electronics:6, cable:4, power_elements:4, rare_metals:15 },
  },
  radio_intel: {
    name: 'Радиоразведка', icon: '📡', category: 'special',
    desc: 'Наблюдение за перемещениями в галактике',
    effect: '+5 у.е. радиус/ур, −2% шанс шпионажа',
    maxLevel: 12, energyPerLevel: 1,
    baseCost: { silicates:20, carbonates:8, bitumens:4, metal_struct:6,
                hq_alloys:5, ind_equip:4, electronics:7, cable:5, power_elements:5, rare_metals:25 },
  },
};

// ── HELPERS ──────────────────────────────────────────────────

function upgradeCost(id, targetLevel) {
  const cfg = BUILDINGS_CFG[id];
  if (!cfg) return null;
  const cost = {};
  for (const [r, base] of Object.entries(cfg.baseCost))
    cost[r] = Math.ceil(base * targetLevel * 1.5);
  return cost;
}

function calcEnergyUsed(bld) {
  let v = 0;
  for (const [id, lvl] of Object.entries(bld))
    v += (BUILDINGS_CFG[id]?.energyPerLevel || 0) * lvl;
  return v;
}

function calcEnergyTotal(bld) {
  let v = 0;
  for (const [id, lvl] of Object.entries(bld))
    v += (BUILDINGS_CFG[id]?.energyOutput || 0) * lvl;
  return v;
}

// ── STATE ────────────────────────────────────────────────────

let _planet    = null;
let _context   = null;
let _selected  = null;   // selected building id
let _isOpen    = false;

// ── CSS ──────────────────────────────────────────────────────

function injectStyles() {
  let s = document.getElementById('dev-styles');
  if (!s) { s = document.createElement('style'); s.id = 'dev-styles'; document.head.appendChild(s); }
  s.textContent = `
/* Overlay inside pui-main */
#dev-view {
  display: none;
  flex-direction: row;
  width: 100%; height: 100%;
  overflow: hidden;
}
#dev-view.open { display: flex; }

/* Left: scrollable grid of building cards */
#dev-grid-wrap {
  flex: 1;
  overflow: hidden;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
}
#dev-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(6, 1fr);
  gap: 5px;
  flex: 1;
  min-height: 0;
}

/* Building card — horizontal layout */
.dev-card {
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  background: rgba(6,10,24,0.65);
  transition: border-color 0.15s, background 0.15s;
  min-height: 0;
  overflow: hidden;
}
.dev-card:hover { border-color: var(--accent); background: rgba(42,80,140,0.18); }
.dev-card.selected { border-color: var(--accent2); background: rgba(0,229,255,0.07); }
.dev-card.built { border-color: rgba(68,221,136,0.35); }

/* Top body: text left + icon right */
.dev-card-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.dev-card-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 7px 8px 5px;
  overflow: hidden;
  gap: 3px;
}
.dev-card-name {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-bright);
  font-weight: bold;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dev-card-desc {
  font-family: var(--mono);
  font-size: 7.5px;
  color: var(--text);
  opacity: 0.5;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dev-card-effect {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--accent2);
  opacity: 0.85;
  line-height: 1.3;
}
.dev-card-lvlbadge {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--accent2);
  font-weight: bold;
  margin-top: auto;
}
.dev-card-lvlbadge.zero { color: rgba(255,255,255,0.2); }

/* Big icon on the right */
.dev-card-icon {
  font-size: 32px;
  line-height: 1;
  padding: 8px 10px 8px 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0.82;
}

/* Bottom cost bar */
.dev-card-costs {
  border-top: 1px solid rgba(255,255,255,0.06);
  padding: 3px 8px;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  flex-shrink: 0;
  background: rgba(0,0,0,0.15);
}
.dev-cost-item {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--text);
  opacity: 0.65;
  display: flex;
  align-items: center;
  gap: 1px;
  white-space: nowrap;
}
.dev-cost-item.lack { opacity: 1; color: #ff6644; }
.dev-cost-sep {
  flex: 1;
}
.dev-maint {
  font-family: var(--mono);
  font-size: 7.5px;
  color: #ffcc44;
  opacity: 0.7;
  white-space: nowrap;
}

/* Right: detail panel */
#dev-detail {
  width: 230px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Planet stats block (always visible, top of right panel) */
#dev-stats {
  overflow-y: auto;
  border-bottom: 1px solid var(--border);
  flex: 1;
  min-height: 0;
}
.dev-stat-sec {
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 2px;
  color: #7ecfff;
  padding: 8px 12px 3px;
  text-transform: uppercase;
}
.dev-stat-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-family: var(--mono);
  font-size: 10px;
  padding: 3px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.dev-stat-key { color: #aabbcc; }
.dev-stat-val { color: #ffffff; text-align: right; font-weight: bold; }
.dev-stat-val.good  { color: #44ee88; }
.dev-stat-val.warn  { color: #ffcc44; }
.dev-stat-val.bad   { color: #ff5533; }
.dev-stat-sub {
  font-size: 8.5px;
  color: #8899aa;
  padding: 1px 12px 1px 22px;
  font-family: var(--mono);
  border-bottom: 1px solid rgba(255,255,255,0.03);
}

/* Building detail block (bottom, shown when building selected) */
#dev-bld-panel {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  max-height: 45%;
}
#dev-detail-scroll {
  overflow-y: auto;
  padding: 8px 12px 4px;
  flex: 1;
  min-height: 0;
}
.dev-det-empty {
  font-family: var(--mono);
  font-size: 10px;
  color: #8899aa;
  text-align: center;
  padding: 12px 0;
}
.dev-det-title {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-bright);
  margin-bottom: 1px;
  white-space: pre-line;
  line-height: 1.3;
}
.dev-det-lvl {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--text);
  opacity: 0.45;
  margin-bottom: 6px;
  letter-spacing: 1px;
}
.dev-det-sec {
  font-family: var(--mono);
  font-size: 7px;
  letter-spacing: 2px;
  color: var(--accent);
  opacity: 0.65;
  margin: 6px 0 3px;
}
.dev-det-row {
  display: flex;
  justify-content: space-between;
  font-family: var(--mono);
  font-size: 9px;
  margin-bottom: 2px;
  padding-bottom: 2px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.dev-det-row:last-of-type { border-bottom: none; }
.dev-det-key { color: var(--text); opacity: 0.6; }
.dev-det-val { color: var(--text-bright); }
.dev-det-val.lack { color: #ff6644; }

#dev-build-btn {
  margin: 6px 12px 8px;
  padding: 6px 0;
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 2px;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent2);
  width: calc(100% - 24px);
  transition: all 0.15s;
  flex-shrink: 0;
}
#dev-build-btn:hover:not(:disabled) { background: rgba(42,127,255,0.1); }
#dev-build-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  border-color: var(--border);
  color: var(--text);
}
`;
}

// ── DOM ───────────────────────────────────────────────────────

function injectDOM() {
  // Всегда удаляем старый DOM чтобы не было артефактов от кешированных версий
  const old = document.getElementById('dev-view');
  if (old) old.remove();

  const el = document.createElement('div');
  el.id = 'dev-view';
  el.style.cssText = 'display:none;flex-direction:row;width:100%;height:100%;overflow:hidden;';
  el.innerHTML = `
    <div id="dev-grid-wrap" style="flex:1;overflow:hidden;padding:6px 8px;display:flex;flex-direction:column;">
      <div id="dev-grid" style="display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(6,1fr);gap:5px;flex:1;min-height:0;"></div>
    </div>
    <div id="dev-detail" style="width:230px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid rgba(60,130,200,0.25);align-self:stretch;">
      <div id="dev-stats" style="flex:1;min-height:0;overflow-y:auto;"></div>
      <div id="dev-bld-panel" style="flex-shrink:0;border-top:1px solid rgba(60,130,200,0.2);display:flex;flex-direction:column;max-height:45%;">
        <div id="dev-detail-scroll" style="overflow-y:auto;padding:8px 12px 4px;flex:1;min-height:0;">
          <div style="font-family:monospace;font-size:10px;color:#8899aa;text-align:center;padding:12px 0;">Выберите здание</div>
        </div>
        <button id="dev-build-btn" disabled style="margin:6px 12px 8px;padding:6px 0;font-family:monospace;font-size:8px;letter-spacing:2px;cursor:pointer;background:transparent;border:1px solid #2a7fff;color:#00e5ff;width:calc(100% - 24px);transition:all 0.15s;">—</button>
      </div>
    </div>
  `;

  // Insert into pui-main (replaces planet content visually)
  const puiMain = document.getElementById('pui-main');
  puiMain.appendChild(el);

  document.getElementById('dev-build-btn').addEventListener('click', () => {
    if (!_selected) return;
    const lvl  = (_planet.buildings[_selected] || 0) + 1;
    const cost = upgradeCost(_selected, lvl);
    if (!cost) return;
    for (const [r, amt] of Object.entries(cost))
      _planet.resources[r] = (_planet.resources[r] || 0) - amt;
    _planet.buildings[_selected] = lvl;
    renderGrid();
    renderDetail();
    renderStats();
  });
}

// ── RENDER ────────────────────────────────────────────────────

function renderGrid() {
  const grid = document.getElementById('dev-grid');
  const res  = _planet.resources || {};

  grid.innerHTML = Object.entries(BUILDINGS_CFG).map(([id, cfg]) => {
    const lvl   = _planet.buildings[id] || 0;
    const next  = lvl + 1;
    const cost  = lvl < cfg.maxLevel ? upgradeCost(id, next) : null;
    const sel   = _selected === id ? ' selected' : '';
    const built = lvl > 0 ? ' built' : '';

    // Cost chips — show all resources, red if lacking
    let costHtml = '';
    if (cost) {
      costHtml = Object.entries(cost).map(([r, amt]) => {
        const have = res[r] || 0;
        const lack = have < amt ? ' lack' : '';
        return `<span class="dev-cost-item${lack}">${RES_ICONS[r] || '▪'}${amt}</span>`;
      }).join('');
    } else {
      costHtml = `<span class="dev-cost-item" style="color:var(--accent2);opacity:0.8">МАКС</span>`;
    }

    // Maintenance: energy per tick
    const maint = cfg.energyPerLevel
      ? `<span class="dev-maint">⚡${cfg.energyPerLevel * Math.max(1, lvl)}/тик</span>`
      : '';

    const lvlCls = lvl === 0 ? ' zero' : '';

    return `
      <div class="dev-card${sel}${built}" data-bid="${id}">
        <div class="dev-card-body">
          <div class="dev-card-text">
            <div class="dev-card-name">${cfg.name}</div>
            <div class="dev-card-desc">${cfg.desc}</div>
            <div class="dev-card-effect">${cfg.effect}</div>
            <div class="dev-card-lvlbadge${lvlCls}">УР.${lvl}/${cfg.maxLevel}</div>
          </div>
          <div class="dev-card-icon">${cfg.icon}</div>
        </div>
        <div class="dev-card-costs">
          ${costHtml}
          <div class="dev-cost-sep"></div>
          ${maint}
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.dev-card').forEach(c =>
    c.addEventListener('click', () => {
      _selected = c.dataset.bid;
      renderGrid();
      renderDetail();
    }));
}

// ── STATS CALCULATIONS ────────────────────────────────────────

function calcStats() {
  const bld = _planet.buildings || {};
  const p   = _planet;

  // Energy
  const energyProd    = calcEnergyTotal(bld);
  const energyUsed    = calcEnergyUsed(bld);
  const energyBalance = energyProd - energyUsed;

  // Population & housing
  const housingLvl    = bld.housing || 0;
  const housingCap    = housingLvl * 1000;          // 1000 чел/ур
  const population    = p.population || 0;
  const freeHousing   = Math.max(0, housingCap - population);
  const workers       = population;                 // упрощённо — всё население работники
  const jobDemand     = Object.entries(bld).reduce((s,[id,lvl]) => {
    if (id === 'housing') return s;
    return s + lvl * 50;                            // 50 рабочих на уровень
  }, 0);
  const workerBalance = workers - jobDemand;        // >0 избыток, <0 нехватка

  // Computed planet params (set by openPlanetUI in galaxy.html)
  const cp            = p._computed || {};

  // Population growth factors
  const moraleVal     = p.morale ?? 2;
  const radiation     = cp.surfRad   ?? p.radiation ?? 0;
  const toxicity      = cp.toxicity  ?? p.toxicity  ?? 0;
  const foodStock     = (p.resources?.food || p.resources?.biomass || 0);
  const foodProd      = (bld.food_production || 0) * 20 + (bld.plantation || 0) * 10;
  const foodConsume   = Math.ceil(population / 100); // 1 ед. на 100 чел/тик
  const foodBalance   = foodProd - foodConsume;
  const hasFood       = foodStock > 0 || foodProd > 0;

  // Morale factors (from TZEconomy §15)
  const domeLvl       = bld.dome || 0;
  const domePenalty   = -Math.floor(domeLvl / 2);
  const cultureLvl    = bld.cultural_center || 0;
  const cultureBonus  = cultureLvl;                 // +1/ур
  const toxFactor     = toxicity <= 20 ? 1 : toxicity <= 50 ? 0 : -1;
  const radFactor     = radiation <= 20 ? 1 : radiation <= 50 ? 0 : -1;
  const foodFactor    = hasFood ? 1 : -2;
  const economyFactor = p.economyTrend ?? 0;       // +1/0/-1 от тика
  const BASE_MORALE   = 2;
  const moraleCalc    = BASE_MORALE + cultureBonus + toxFactor + radFactor
                      + foodFactor + economyFactor + domePenalty + (p.moraleExtra || 0);

  // Growth
  const growthRate    = moraleCalc <= 0 ? 0 : Math.max(0, Math.round(population * 0.01 * moraleCalc / 10));

  // Toxicity
  const toxProd       = Object.entries(bld).reduce((s,[id,lvl]) => {
    const t = { mine:3, metallurgy:5, chem_plant:4, atomic_station:2 };
    return s + (t[id] || 0) * lvl;
  }, 0);
  const toxProcess    = (bld.purification || 0) * 8;  // 8 ед./ур/тик

  // Science & recon
  const sciencePerTick = bld.science_center || 0;
  const reconRange     = (bld.radio_intel || 0) * 5;

  return {
    energyProd, energyUsed, energyBalance,
    housingCap, population, freeHousing,
    workerBalance, jobDemand, workers,
    moraleCalc, domePenalty, cultureBonus, toxFactor, radFactor,
    foodFactor, economyFactor, BASE_MORALE,
    growthRate,
    foodStock, foodProd, foodConsume, foodBalance, hasFood,
    toxicity, toxProd, toxProcess,
    radiation,
    sciencePerTick, reconRange,
  };
}

const S = {
  sec:  'display:block;padding:8px 12px 3px;font-size:8px;letter-spacing:2px;color:#7ecfff;font-family:monospace;text-transform:uppercase;',
  row:  'display:flex;justify-content:space-between;align-items:baseline;padding:3px 12px;font-size:10px;font-family:monospace;border-bottom:1px solid rgba(255,255,255,0.05);',
  key:  'color:#aabbcc;',
  val:  'color:#ffffff;font-weight:bold;',
  good: 'color:#44ee88;font-weight:bold;',
  warn: 'color:#ffcc44;font-weight:bold;',
  bad:  'color:#ff5533;font-weight:bold;',
  sub:  'display:block;padding:1px 12px 1px 22px;font-size:8.5px;font-family:monospace;color:#8899aa;border-bottom:1px solid rgba(255,255,255,0.03);',
};

function statRow(k, v, color = '') {
  const vc = color ? S[color] || S.val : S.val;
  return `<div style="${S.row}"><span style="${S.key}">${k}</span><span style="${vc}">${v}</span></div>`;
}
function subRow(t) { return `<div style="${S.sub}">${t}</div>`; }
function sec(t)    { return `<div style="${S.sec}">${t}</div>`; }

function renderStats() {
  const el = document.getElementById('dev-stats');
  if (!el) return;
  el.style.cssText = 'overflow-y:auto;flex:1;min-height:0;background:rgba(8,16,40,0.95);border-left:1px solid rgba(60,130,200,0.3);';
  const s = calcStats();

  const eClass = s.energyBalance < 0 ? 'bad' : s.energyBalance === 0 ? 'warn' : 'good';
  const mClass = s.moraleCalc < 0 ? 'bad' : s.moraleCalc < 2 ? 'warn' : 'good';
  const fClass = !s.hasFood ? 'bad' : s.foodBalance < 0 ? 'warn' : 'good';
  const wClass = s.workerBalance < 0 ? 'bad' : s.workerBalance > s.workers * 0.3 ? 'warn' : 'good';

  el.innerHTML =
    sec('ЭНЕРГИЯ') +
    statRow('Производство', `${s.energyProd} ед.`, 'good') +
    statRow('Потребление',  `${s.energyUsed} ед.`) +
    statRow('Баланс',       `${s.energyBalance >= 0 ? '+' : ''}${s.energyBalance} ед.`, eClass) +

    sec('НАСЕЛЕНИЕ') +
    statRow('Население',    s.population.toLocaleString()) +
    statRow('Жильё (мест)', s.housingCap.toLocaleString()) +
    statRow('Свободно',     s.freeHousing.toLocaleString(), s.freeHousing === 0 ? 'bad' : 'good') +
    statRow('Рабочие мест', s.jobDemand.toLocaleString()) +
    statRow('Баланс раб.',  `${s.workerBalance >= 0 ? '+' : ''}${s.workerBalance}`, wClass) +
    statRow('Прирост/тик',  `+${s.growthRate}`, s.growthRate > 0 ? 'good' : 'warn') +

    sec('МОРАЛЬ') +
    statRow('Мораль итого', s.moraleCalc, mClass) +
    subRow(`База: +${s.BASE_MORALE}`) +
    (s.cultureBonus   ? subRow(`Культ. центр: +${s.cultureBonus}`) : '') +
    subRow(`Токсичность: ${s.toxFactor >= 0 ? '+' : ''}${s.toxFactor}`) +
    subRow(`Радиация: ${s.radFactor >= 0 ? '+' : ''}${s.radFactor}`) +
    subRow(`Питание: ${s.foodFactor >= 0 ? '+' : ''}${s.foodFactor}`) +
    (s.domePenalty    ? subRow(`Купола: ${s.domePenalty}`) : '') +
    (s.economyFactor  ? subRow(`Экономика: ${s.economyFactor >= 0 ? '+' : ''}${s.economyFactor}`) : '') +

    sec('ПИТАНИЕ') +
    statRow('Добыча/тик',   `+${s.foodProd}`, s.foodProd > 0 ? 'good' : 'bad') +
    statRow('Потребление',  `-${s.foodConsume}`) +
    statRow('Баланс/тик',   `${s.foodBalance >= 0 ? '+' : ''}${s.foodBalance}`, fClass) +
    statRow('Запас',        s.foodStock.toLocaleString()) +

    sec('ТОКСИЧНОСТЬ') +
    statRow('На планете',   `${s.toxicity}%`, s.toxicity > 50 ? 'bad' : s.toxicity > 20 ? 'warn' : 'good') +
    statRow('Выработка/тик',`+${s.toxProd}`) +
    statRow('Очистка/тик',  `-${s.toxProcess}`, s.toxProcess > 0 ? 'good' : '') +

    sec('ПРОЧЕЕ') +
    statRow('Радиация',     `${s.radiation}%`, s.radiation > 50 ? 'bad' : s.radiation > 20 ? 'warn' : 'good') +
    statRow('Наука/тик',    `+${s.sciencePerTick}`, s.sciencePerTick > 0 ? 'good' : '') +
    (s.reconRange ? statRow('Разведка', `${s.reconRange} у.е.`) : '');
}

function renderDetail() {
  const scroll = document.getElementById('dev-detail-scroll');
  const btn    = document.getElementById('dev-build-btn');
  if (!_selected) {
    scroll.innerHTML = '<div class="dev-det-empty">Выберите здание</div>';
    btn.textContent  = '—';
    btn.disabled     = true;
    return;
  }

  const id  = _selected;
  const cfg = BUILDINGS_CFG[id];
  const lvl = _planet.buildings[id] || 0;
  const next = lvl + 1;
  const maxed = lvl >= cfg.maxLevel;
  const cost  = maxed ? null : upgradeCost(id, next);
  const res   = _planet.resources || {};

  // Effect rows
  let effectRows = '';
  if (cfg.energyOutput)   effectRows += row('Энергия/ур.', `+${cfg.energyOutput}`);
  if (cfg.energyPerLevel) effectRows += row('Потребление/ур.', `${cfg.energyPerLevel} ед./тик`);

  // Cost rows
  let costRows = '', canAfford = true;
  if (cost) {
    for (const [r, amt] of Object.entries(cost)) {
      const have = res[r] || 0;
      const lack = have < amt;
      if (lack) canAfford = false;
      costRows += `<div class="dev-det-row">
        <span class="dev-det-key">${RES_NAMES[r] || r}</span>
        <span class="dev-det-val${lack ? ' lack' : ''}">${have}/${amt}</span>
      </div>`;
    }
  }

  const used  = calcEnergyUsed(_planet.buildings || {});
  const tot   = calcEnergyTotal(_planet.buildings || {});
  const needE = cfg.energyPerLevel || 0;
  const hasE  = needE === 0 || (tot - used) >= needE;

  scroll.innerHTML = `
    <div class="dev-det-title">${cfg.name}</div>
    <div class="dev-det-lvl">УРОВЕНЬ ${lvl} / ${cfg.maxLevel}</div>
    ${effectRows ? `<div class="dev-det-sec">ЭФФЕКТ</div>${effectRows}` : ''}
    ${cost ? `<div class="dev-det-sec">СТОИМОСТЬ УР.${next}</div>${costRows}` : ''}
  `;

  if (maxed) {
    btn.textContent = 'МАКСИМУМ'; btn.disabled = true;
  } else if (!canAfford) {
    btn.textContent = 'НЕТ РЕСУРСОВ'; btn.disabled = true;
  } else if (!hasE) {
    btn.textContent = 'НЕТ ЭНЕРГИИ'; btn.disabled = true;
  } else {
    btn.textContent = `ПОСТРОИТЬ УР.${next}`; btn.disabled = false;
  }
}

function row(k, v) {
  return `<div class="dev-det-row"><span class="dev-det-key">${k}</span><span class="dev-det-val">${v}</span></div>`;
}

// ── PUBLIC API ────────────────────────────────────────────────

export function open(planet, context) {
  injectStyles();
  injectDOM();

  _planet  = planet;
  _context = context;
  if (!_planet.buildings)         _planet.buildings         = {};
  if (!_planet.resources)         _planet.resources         = {};
  if (!_planet.constructionQueue) _planet.constructionQueue = [];

  _selected = null;
  _isOpen   = true;

  // Hide planet content, show dev grid
  document.getElementById('pui-stats').style.display  = 'none';
  document.getElementById('pui-center').style.display = 'none';
  document.getElementById('pui-moons').style.display  = 'none';
  document.getElementById('pui-surface').style.display = 'none';
  document.getElementById('dev-view').style.display = 'flex';

  renderGrid();
  renderDetail();
  renderStats();
}

export function close() {
  if (!_isOpen) return;
  _isOpen = false;

  const el = document.getElementById('dev-view');
  if (el) el.style.display = 'none';

  // Restore planet content
  document.getElementById('pui-stats').style.display  = '';
  document.getElementById('pui-center').style.display = '';
  document.getElementById('pui-moons').style.display  = '';
  document.getElementById('pui-surface').style.display = '';
}
