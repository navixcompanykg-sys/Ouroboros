// ============================================================
// КОСМОДРОМ — ui/spaceport.js
// Экспортирует: open(planet, context), close()
// ============================================================

const SHIP_TYPES = {
  pioneer:   { name:'Пионер',     icon:'🚀', desc:'Колониальный' },
  freighter: { name:'Грузовик',   icon:'🛸', desc:'Транспортный' },
  corvette:  { name:'Корвет',     icon:'🛩', desc:'Лёгкий боевой' },
  frigate:   { name:'Фрегат',     icon:'✈',  desc:'Средний боевой' },
  cruiser:   { name:'Крейсер',    icon:'🚢', desc:'Тяжёлый боевой' },
  scout:     { name:'Разведчик',  icon:'🛺', desc:'Разведчик' },
  tanker:    { name:'Танкер',     icon:'🛢', desc:'Газовый танкер' },
  transport: { name:'Транспорт',  icon:'📦', desc:'Войсковой' },
};

const ENGINE_TYPES = {
  ion:      { name:'Ионный',       icon:'⚡' },
  nuclear:  { name:'Ядерный',      icon:'☢' },
  fusion:   { name:'Термоядерный', icon:'🌟' },
  chemical: { name:'Химический',   icon:'🔥' },
};

const RESOURCES = [
  { id:'helium3',       name:'Гелий-3',         icon:'🌀', mass:1  },
  { id:'hydrogen',      name:'Водород',          icon:'💧', mass:2  },
  { id:'deuterium',     name:'Дейтерий',         icon:'⚛',  mass:3  },
  { id:'noble_gas',     name:'Благородные газы', icon:'🫧', mass:3  },
  { id:'volc_gas',      name:'Вулк. газы',       icon:'🌋', mass:4  },
  { id:'water_ice',     name:'Водяной лёд',      icon:'🧊', mass:5  },
  { id:'biomass',       name:'Биомасса',         icon:'🌿', mass:5  },
  { id:'carbonates',    name:'Карбонаты',        icon:'🧱', mass:6  },
  { id:'bitumens',      name:'Битумы',           icon:'🛢', mass:7  },
  { id:'phosphates',    name:'Фосфаты',          icon:'🧪', mass:8  },
  { id:'silicates',     name:'Силикаты',         icon:'🪨', mass:8  },
  { id:'refract',       name:'Тугоплавкие',      icon:'🌡', mass:10 },
  { id:'iron',          name:'Железо',           icon:'⚙',  mass:12 },
  { id:'rare_metals',   name:'Редкоземельные',   icon:'💎', mass:14 },
  { id:'platinoids',    name:'Платиноиды',       icon:'🔆', mass:16 },
  { id:'radioact',      name:'Радиоактивные',    icon:'☢',  mass:18 },
  { id:'biosynthetics', name:'Биосинтетика',     icon:'🧬', mass:4  },
  { id:'polymers',      name:'Полимеры',         icon:'🧴', mass:4  },
  { id:'chem_reagents', name:'Хим. реагенты',    icon:'⚗',  mass:5  },
  { id:'electronics',   name:'Электроника',      icon:'💻', mass:3  },
  { id:'power_elements',name:'Эл. питания',      icon:'🔋', mass:7  },
  { id:'cable',         name:'Кабельная',        icon:'🔌', mass:8  },
  { id:'nuclear_comp',  name:'Ядерные компон.',  icon:'☣',  mass:10 },
  { id:'hq_alloys',     name:'В/к сплавы',       icon:'🏗', mass:16 },
  { id:'metal_struct',  name:'Металлоконстр.',   icon:'🔩', mass:15 },
  { id:'ind_equip',     name:'Пром. обор.',      icon:'🏭', mass:20 },
  { id:'weapons',       name:'Вооружение',       icon:'⚔',  mass:25 },
];

// ── MOCK-ДАННЫЕ ───────────────────────────────────────────────

const _mockShips = {
  's1': { name:'Пионер-1',    type:'pioneer',   engine:'nuclear', speed:4,  cargo_max:2000 },
  's2': { name:'Грузовик-1',  type:'freighter', engine:'ion',     speed:3,  cargo_max:3000 },
  's3': { name:'Грузовик-2',  type:'freighter', engine:'ion',     speed:3,  cargo_max:3000 },
  's4': { name:'Корвет-1',    type:'corvette',  engine:'fusion',  speed:8,  cargo_max:200  },
  's5': { name:'Разведчик-1', type:'scout',     engine:'fusion',  speed:12, cargo_max:100  },
};

const _mockFleets = {
  'f1': { name:'Флот-1', ships:['s1','s2'], cargo:{ metal_struct:51, electronics:18 },
          orders:{ guard:false, trade:false, tradeRadius:5, tradeMaxPrice:{}, reinforce:false, reinforceRadius:3 } },
  'f2': { name:'Флот-2', ships:['s4'],      cargo:{},
          orders:{ guard:false, trade:false, tradeRadius:5, tradeMaxPrice:{}, reinforce:false, reinforceRadius:3 } },
};

// ── СОСТОЯНИЕ ────────────────────────────────────────────────

let _planet    = null;
let _planetKey = null;
let _selected  = null;   // 'unassigned' | fleet_id

function _unassigned() {
  const assigned = new Set(Object.values(_mockFleets).flatMap(f => f.ships));
  return Object.keys(_mockShips).filter(id => !assigned.has(id));
}
function _fleetCapacity(fid) {
  const fl = _mockFleets[fid]; if (!fl) return 0;
  return fl.ships.reduce((s, sid) => s + (_mockShips[sid]?.cargo_max || 0), 0);
}
function _fleetCargoMass(fid) {
  const fl = _mockFleets[fid]; if (!fl) return 0;
  let m = 0;
  for (const [rid, qty] of Object.entries(fl.cargo || {})) {
    m += qty * (RESOURCES.find(x => x.id === rid)?.mass || 1);
  }
  return m;
}
function _fleetSpeed(fid) {
  const fl = _mockFleets[fid]; if (!fl || !fl.ships.length) return null;
  return Math.min(...fl.ships.map(sid => _mockShips[sid]?.speed || 99));
}
function _fleetEngine(fid) {
  const fl = _mockFleets[fid]; if (!fl || !fl.ships.length) return null;
  const eng = [...new Set(fl.ships.map(sid => _mockShips[sid]?.engine))];
  return eng.length === 1 ? eng[0] : 'mixed';
}

// ── OPEN / CLOSE ──────────────────────────────────────────────

export function open(planet, context) {
  _planet    = planet;
  _planetKey = planet?.id ?? 'default';
  _selected  = null;

  injectStyles();
  injectDOM();

  ['pui-left','pui-center','pui-right','pui-bottom-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  document.getElementById('sp-view').style.display = 'flex';
  render();
}

export function close() {
  document.getElementById('sp-view')?.remove();
  document.getElementById('sp-modal')?.remove();
  ['pui-left','pui-center','pui-right','pui-bottom-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

// ── STYLES ────────────────────────────────────────────────────

function injectStyles() {
  let s = document.getElementById('sp-styles');
  if (!s) { s = document.createElement('style'); s.id = 'sp-styles'; document.head.appendChild(s); }
  s.textContent = `
#sp-view {
  position:absolute; inset:0; z-index:200;
  display:flex; flex-direction:column;
  background:#040810; color:#c8d8f0;
  font-family:'Share Tech Mono',monospace; font-size:12px; overflow:hidden;
}
#sp-header {
  display:flex; align-items:center; gap:10px;
  padding:7px 14px; border-bottom:1px solid #1a3a6a;
  background:#060e1e; flex-shrink:0;
}
#sp-back-btn {
  background:transparent; border:1px solid rgba(0,229,255,0.25);
  color:#7ecfff; font-family:'Share Tech Mono',monospace;
  font-size:10px; padding:2px 10px; border-radius:3px;
  cursor:pointer; letter-spacing:1px; transition:all 0.15s; flex-shrink:0;
}
#sp-back-btn:hover { border-color:#00e5ff; color:#00e5ff; }
.sp-title { color:#00e5ff; font-size:14px; letter-spacing:2px; flex:1; }

/* Main layout */
#sp-main { flex:1; display:flex; min-height:0; overflow:hidden; }

/* ── LEFT: fleet list ── */
#sp-left {
  width:320px; flex-shrink:0; border-right:1px solid #1a3a6a;
  display:flex; flex-direction:column; overflow:hidden;
}
#sp-left-title {
  padding:5px 10px; font-size:9px; color:#4a7aaa; letter-spacing:2px;
  border-bottom:1px solid #1a3a6a; background:#06101e; flex-shrink:0;
}
#sp-fleet-list { flex:1; overflow-y:auto; }

/* Fleet row: icon card + command buttons */
.sp-fleet-row {
  display:flex; align-items:stretch; border-bottom:1px solid #0d1e30;
  transition:background 0.1s; cursor:pointer;
}
.sp-fleet-row:hover { background:#070e1c; }
.sp-fleet-row.selected { background:#071422; }

/* Left part of row: fleet card */
.sp-fleet-card {
  width:72px; flex-shrink:0; padding:8px 4px;
  display:flex; flex-direction:column; align-items:center;
  justify-content:center; text-align:center; border-right:1px solid #0d1e30;
  transition:border-color 0.15s;
}
.sp-fleet-row.selected .sp-fleet-card { border-right-color:#00e5ff; }
.sp-fleet-card-icon { font-size:22px; margin-bottom:3px; }
.sp-fleet-card-name { font-size:8px; color:#7ecfff; line-height:1.2; }
.sp-fleet-card-sub  { font-size:8px; color:#3a6a9a; margin-top:2px; }

/* Unassigned row */
.sp-fleet-row.sp-unassigned .sp-fleet-card { border-left:2px solid #2a5a2a; }
.sp-fleet-row.sp-unassigned.selected .sp-fleet-card { border-left-color:#44ee88; }

/* Right part of row: 2x2 command buttons */
.sp-cmd-grid {
  flex:1; display:grid; grid-template-columns:1fr 1fr;
  grid-template-rows:1fr 1fr; gap:4px; padding:6px;
  align-items:stretch;
}
.sp-cmd-btn {
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  border:1px solid #1a3a6a; border-radius:4px; background:#06101e;
  cursor:pointer; font-family:'Share Tech Mono',monospace;
  font-size:8px; color:#5a8ab0; letter-spacing:0.5px; line-height:1.3;
  padding:4px 2px; transition:all 0.15s; text-align:center; gap:2px;
}
.sp-cmd-btn:hover { border-color:#3a7aaa; color:#00e5ff; background:#080f1e; }
.sp-cmd-btn .cmd-icon { font-size:14px; }
.sp-cmd-btn.active { border-color:#44ee88; color:#44ee88; background:#041808; }
.sp-cmd-btn.active:hover { border-color:#66ff99; }
.sp-cmd-btn.busy { border-color:#ffcc44; color:#ffcc44; background:#1a1200; }

/* ── RIGHT: detail panel ── */
#sp-right { flex:1; display:flex; flex-direction:column; overflow:hidden; }
#sp-detail-header {
  padding:8px 14px; border-bottom:1px solid #1a3a6a;
  background:#06101e; flex-shrink:0;
  display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;
}
#sp-detail-name { color:#00e5ff; font-size:13px; letter-spacing:1px; }
#sp-detail-meta { color:#5a8ab0; font-size:10px; }

#sp-capbar {
  padding:6px 14px; background:#06101e; border-bottom:1px solid #1a3a6a; flex-shrink:0;
}
.sp-bar-labels { display:flex; justify-content:space-between; font-size:10px; color:#5a8ab0; margin-bottom:3px; }
.sp-bar-track  { height:6px; background:#0a1a2a; border-radius:3px; overflow:hidden; display:flex; }
.sp-bar-cargo  { background:#00e5ff; height:100%; transition:width 0.3s; }
.sp-bar-free   { background:#1a3a5a; height:100%; }

#sp-detail-body { flex:1; display:flex; min-height:0; overflow:hidden; }

#sp-ships-col {
  width:220px; flex-shrink:0; border-right:1px solid #1a3a6a;
  display:flex; flex-direction:column; overflow:hidden;
}
.sp-col-title {
  padding:4px 10px; font-size:9px; color:#4a7aaa; letter-spacing:2px;
  border-bottom:1px solid #1a3a6a; background:#06101e; flex-shrink:0;
}
#sp-ships-list { flex:1; overflow-y:auto; }
.sp-ship-row {
  display:flex; align-items:center; gap:6px; padding:5px 10px;
  border-bottom:1px solid #0d1e30; transition:background 0.1s;
}
.sp-ship-row:hover { background:#080f1c; }
.sp-ship-icon { font-size:18px; flex-shrink:0; }
.sp-ship-info { flex:1; min-width:0; }
.sp-ship-name { color:#c8d8f0; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sp-ship-sub  { font-size:9px; color:#4a7aaa; }
.sp-ship-cargo-lbl { font-size:9px; color:#5a8ab0; margin-top:1px; }
.sp-ship-btn {
  flex-shrink:0; background:transparent; border:1px solid #2a3a6a; border-radius:3px;
  padding:2px 6px; font-size:9px; cursor:pointer;
  font-family:'Share Tech Mono',monospace; transition:all 0.15s; white-space:nowrap;
}
.sp-ship-btn.remove { color:#ff7755; border-color:#5a2a2a; }
.sp-ship-btn.remove:hover { border-color:#ff5533; background:#200808; }
.sp-ship-btn.assign { color:#44ee88; border-color:#1a5a3a; }
.sp-ship-btn.assign:hover { border-color:#44ee88; background:#082008; }
.sp-fleet-select {
  background:#040d1a; border:1px solid #1a3a5a; color:#c8d8f0;
  font-family:'Share Tech Mono',monospace; font-size:10px;
  padding:2px 4px; border-radius:3px; cursor:pointer;
}

#sp-cargo-col { flex:1; display:flex; flex-direction:column; overflow:hidden; }
#sp-cargo-list { flex:1; overflow-y:auto; }
.sp-cargo-row {
  display:flex; align-items:center; gap:8px;
  padding:4px 12px; border-bottom:1px solid #0d1e30;
}
.sp-cargo-icon { font-size:14px; flex-shrink:0; }
.sp-cargo-name { flex:1; color:#c8d8f0; font-size:11px; }
.sp-cargo-qty  { color:#e0f0ff; font-size:11px; text-align:right; min-width:50px; }
.sp-cargo-mass { color:#4a7aaa; font-size:9px; text-align:right; min-width:55px; }

.sp-empty-state { padding:20px 14px; text-align:center; color:#2a4a6a; font-size:11px; line-height:1.8; }

/* Error toast */
#sp-error {
  position:absolute; bottom:14px; left:50%; transform:translateX(-50%);
  background:#200808; border:1px solid #ff5533; color:#ff7755;
  padding:7px 18px; border-radius:4px; font-size:11px; letter-spacing:1px;
  z-index:300; display:none; max-width:80%; text-align:center; pointer-events:none;
}
#sp-error.show { display:block; animation:sp-fade 3.5s forwards; }
@keyframes sp-fade { 0%,75%{opacity:1;} 100%{opacity:0;} }

/* ── MODAL ── */
#sp-modal {
  position:fixed; inset:0; z-index:400;
  display:flex; align-items:center; justify-content:center;
  background:rgba(0,0,0,0.6); backdrop-filter:blur(2px);
}
.sp-modal-box {
  background:#060e1e; border:1px solid #2a5a9a; border-radius:6px;
  min-width:340px; max-width:520px; width:90%;
  font-family:'Share Tech Mono',monospace; color:#c8d8f0;
  display:flex; flex-direction:column; overflow:hidden;
  box-shadow:0 0 40px rgba(0,100,200,0.25);
}
.sp-modal-header {
  display:flex; align-items:center; padding:10px 14px;
  border-bottom:1px solid #1a3a6a; background:#07121e;
}
.sp-modal-title { flex:1; color:#00e5ff; font-size:12px; letter-spacing:2px; }
.sp-modal-close {
  background:transparent; border:none; color:#5a8ab0; font-size:16px;
  cursor:pointer; padding:0 4px; transition:color 0.15s;
}
.sp-modal-close:hover { color:#ff5533; }
.sp-modal-body { padding:14px; display:flex; flex-direction:column; gap:10px; }
.sp-modal-footer {
  padding:10px 14px; border-top:1px solid #1a3a6a; background:#07121e;
  display:flex; gap:8px; justify-content:flex-end;
}
.sp-form-row { display:flex; align-items:center; gap:8px; font-size:11px; }
.sp-form-label { color:#7ecfff; min-width:140px; }
.sp-form-input {
  background:#040d1a; border:1px solid #1a3a5a; color:#c8d8f0;
  font-family:'Share Tech Mono',monospace; font-size:11px;
  padding:3px 8px; border-radius:3px; width:80px;
}
.sp-form-input:focus { outline:none; border-color:#00e5ff; }
.sp-form-hint { font-size:9px; color:#3a6a9a; margin-top:-4px; }
.sp-btn-primary {
  padding:5px 16px; border:1px solid #00e5ff; border-radius:3px;
  background:#071422; color:#00e5ff; font-family:'Share Tech Mono',monospace;
  font-size:11px; cursor:pointer; letter-spacing:1px; transition:all 0.15s;
}
.sp-btn-primary:hover { background:#0d2040; }
.sp-btn-secondary {
  padding:5px 14px; border:1px solid #1a3a6a; border-radius:3px;
  background:transparent; color:#7ecfff; font-family:'Share Tech Mono',monospace;
  font-size:11px; cursor:pointer; transition:all 0.15s;
}
.sp-btn-secondary:hover { border-color:#3a7aaa; }

/* Journey modal specifics */
.sp-journey-map-placeholder {
  border:1px dashed #1a3a6a; border-radius:4px;
  background:#040810; height:160px;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  color:#2a4a6a; font-size:11px; gap:6px;
}
.sp-journey-map-placeholder .map-icon { font-size:32px; }
.sp-action-list { display:flex; flex-direction:column; gap:4px; }
.sp-action-item {
  display:flex; align-items:flex-start; gap:8px; padding:7px 10px;
  border:1px solid #1a3a6a; border-radius:4px; cursor:pointer;
  transition:all 0.15s; background:#040c1a;
}
.sp-action-item:hover { border-color:#3a7aaa; background:#06101e; }
.sp-action-item.selected { border-color:#00e5ff; background:#071422; }
.sp-action-item input[type=radio] { margin-top:2px; flex-shrink:0; accent-color:#00e5ff; }
.sp-action-label { color:#c8d8f0; font-size:11px; }
.sp-action-desc  { color:#4a7aaa; font-size:9px; margin-top:2px; }
.sp-action-warn  { color:#ffcc44; font-size:9px; margin-top:2px; }
`;
}

// ── DOM ───────────────────────────────────────────────────────

function injectDOM() {
  document.getElementById('sp-view')?.remove();
  const view = document.createElement('div');
  view.id = 'sp-view';
  view.style.display = 'none';
  view.innerHTML = `
    <div id="sp-header">
      <button id="sp-back-btn">← НАЗАД</button>
      <span class="sp-title">🚀 КОСМОДРОМ</span>
    </div>
    <div id="sp-main">
      <div id="sp-left">
        <div id="sp-left-title">ФЛОТЫ И ПРИКАЗЫ</div>
        <div id="sp-fleet-list"></div>
      </div>
      <div id="sp-right">
        <div id="sp-detail-header">
          <span id="sp-detail-name" style="color:#4a7aaa">Выберите флот слева</span>
          <span id="sp-detail-meta"></span>
        </div>
        <div id="sp-capbar" style="display:none">
          <div class="sp-bar-labels">
            <span id="sp-bar-used-lbl"></span>
            <span id="sp-bar-free-lbl"></span>
          </div>
          <div class="sp-bar-track">
            <div class="sp-bar-cargo" id="sp-bar-cargo-el" style="width:0%"></div>
            <div class="sp-bar-free" id="sp-bar-free-el" style="width:100%"></div>
          </div>
        </div>
        <div id="sp-detail-body">
          <div id="sp-ships-col">
            <div class="sp-col-title" id="sp-ships-title">КОРАБЛИ</div>
            <div id="sp-ships-list"></div>
          </div>
          <div id="sp-cargo-col">
            <div class="sp-col-title">ГРУЗ В ТРЮМЕ</div>
            <div id="sp-cargo-list"></div>
          </div>
        </div>
      </div>
    </div>
    <div id="sp-error"></div>
  `;
  const overlay = document.getElementById('planet-ui') || document.body;
  overlay.appendChild(view);
  view.querySelector('#sp-back-btn').addEventListener('click', () => close());
}

// ── RENDER ────────────────────────────────────────────────────

function render() { renderFleetList(); renderDetail(); }

function renderFleetList() {
  const list = document.getElementById('sp-fleet-list');
  if (!list) return;

  // Первая строка: нераспределённые корабли (без кнопок команд)
  const unassignedIds = _unassigned();
  const uSel = _selected === 'unassigned';
  let html = `
    <div class="sp-fleet-row sp-unassigned ${uSel ? 'selected' : ''}" data-sel="unassigned">
      <div class="sp-fleet-card">
        <div class="sp-fleet-card-icon">🛸</div>
        <div class="sp-fleet-card-name">Без флота</div>
        <div class="sp-fleet-card-sub">${unassignedIds.length} кор.</div>
      </div>
      <div style="flex:1;display:flex;align-items:center;padding:0 12px;color:#2a4a6a;font-size:10px;">
        ${unassignedIds.length === 0
          ? 'Все корабли распределены'
          : unassignedIds.map(sid => {
              const t = SHIP_TYPES[_mockShips[sid]?.type] || { icon:'🚀' };
              return `<span title="${_mockShips[sid]?.name}">${t.icon}</span>`;
            }).join(' ')}
      </div>
    </div>
  `;

  // Строки флотов
  for (const [fid, fl] of Object.entries(_mockFleets)) {
    const sel = _selected === fid;
    const cap  = _fleetCapacity(fid);
    const used = _fleetCargoMass(fid);
    const pct  = cap > 0 ? Math.round(used / cap * 100) : 0;
    const ord  = fl.orders;

    html += `
      <div class="sp-fleet-row ${sel ? 'selected' : ''}" data-sel="${fid}">
        <div class="sp-fleet-card">
          <div class="sp-fleet-card-icon">🚀</div>
          <div class="sp-fleet-card-name">${fl.name}</div>
          <div class="sp-fleet-card-sub">${fl.ships.length} кор. · ${pct}%</div>
        </div>
        <div class="sp-cmd-grid" data-fleet="${fid}">
          <button class="sp-cmd-btn ${ord.guard ? 'active' : ''}"
            data-cmd="guard" data-fleet="${fid}"
            title="Охранять систему — флот атакует вражеские флоты при вторжении">
            <span class="cmd-icon">🛡</span>
            <span>${ord.guard ? 'Охраняет' : 'Охранять'}</span>
          </button>
          <button class="sp-cmd-btn ${ord.trade ? 'busy' : ''}"
            data-cmd="trade" data-fleet="${fid}"
            title="Торговать — закупать дефицитные ресурсы на ближайших планетах">
            <span class="cmd-icon">💹</span>
            <span>${ord.trade ? 'В торговле' : 'Торговать'}</span>
          </button>
          <button class="sp-cmd-btn"
            data-cmd="journey" data-fleet="${fid}"
            title="Отправить флот в путешествие — выбрать цель и действие">
            <span class="cmd-icon">🗺</span>
            <span>В путь</span>
          </button>
          <button class="sp-cmd-btn ${ord.reinforce ? 'active' : ''}"
            data-cmd="reinforce" data-fleet="${fid}"
            title="Подкрепление — флот вылетает на помощь в системах в заданном радиусе при вторжении">
            <span class="cmd-icon">🆘</span>
            <span>${ord.reinforce ? 'Дежурит' : 'Подкреп.'}</span>
          </button>
        </div>
      </div>
    `;
  }

  list.innerHTML = html;

  // Click on fleet card → select
  list.querySelectorAll('.sp-fleet-row').forEach(row => {
    row.addEventListener('click', e => {
      // Не перехватывать клики по кнопкам
      if (e.target.closest('.sp-cmd-btn')) return;
      _selected = row.dataset.sel;
      renderFleetList();
      renderDetail();
    });
  });

  // Command buttons
  list.querySelectorAll('.sp-cmd-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { cmd, fleet: fid } = btn.dataset;
      handleCommand(cmd, fid);
    });
  });
}

// ── КОМАНДЫ ──────────────────────────────────────────────────

function handleCommand(cmd, fid) {
  const fl = _mockFleets[fid];
  if (!fl) return;

  if (cmd === 'guard') {
    fl.orders.guard = !fl.orders.guard;
    renderFleetList();

  } else if (cmd === 'trade') {
    openTradeModal(fid);

  } else if (cmd === 'journey') {
    openJourneyModal(fid);

  } else if (cmd === 'reinforce') {
    openReinforceModal(fid);
  }
}

// ── МОДАЛ: ТОРГОВЛЯ ───────────────────────────────────────────

function openTradeModal(fid) {
  const fl = _mockFleets[fid];
  closeModal();

  const modal = document.createElement('div');
  modal.id = 'sp-modal';
  modal.innerHTML = `
    <div class="sp-modal-box">
      <div class="sp-modal-header">
        <span class="sp-modal-title">💹 ТОРГОВЛЯ — ${fl.name}</span>
        <button class="sp-modal-close">✕</button>
      </div>
      <div class="sp-modal-body">
        <div style="font-size:10px;color:#5a8ab0;line-height:1.6">
          Флот будет искать ближайшие планеты где продаётся дефицитный ресурс (ниже мин. запаса на складе) и закупать его,
          если цена не превышает базовую цену на складе.
        </div>
        <div class="sp-form-row">
          <span class="sp-form-label">Радиус поиска:</span>
          <input class="sp-form-input" id="sp-trade-radius" type="number" min="1" max="50"
            value="${fl.orders.tradeRadius}">
          <span style="font-size:10px;color:#4a7aaa">пк</span>
        </div>
        <div class="sp-form-hint">Чем больше радиус, тем дальше флот ищет — но дольше летит.</div>

        <div style="border-top:1px solid #1a3a6a;padding-top:8px;font-size:9px;color:#4a7aaa;letter-spacing:1px">
          СОСТОЯНИЕ: ${fl.orders.trade
            ? '<span style="color:#ffcc44">● Флот выполняет торговый маршрут</span>'
            : '<span style="color:#3a6a9a">○ Ожидает команды</span>'}
        </div>
      </div>
      <div class="sp-modal-footer">
        <button class="sp-btn-secondary" id="sp-trade-cancel">Отмена</button>
        <button class="sp-btn-primary" id="sp-trade-confirm">
          ${fl.orders.trade ? '✕ Остановить торговлю' : '▶ Начать торговлю'}
        </button>
      </div>
    </div>
  `;

  document.getElementById('planet-ui').appendChild(modal);

  modal.querySelector('.sp-modal-close').addEventListener('click', closeModal);
  modal.querySelector('#sp-trade-cancel').addEventListener('click', closeModal);
  modal.querySelector('#sp-trade-confirm').addEventListener('click', () => {
    const radius = parseInt(document.getElementById('sp-trade-radius').value) || 5;
    fl.orders.tradeRadius = radius;
    fl.orders.trade = !fl.orders.trade;
    closeModal();
    renderFleetList();
  });
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
}

// ── МОДАЛ: ПУТЕШЕСТВИЕ ────────────────────────────────────────

const JOURNEY_ACTIONS = [
  {
    id: 'land',
    icon: '🛬',
    label: 'Приземлиться на космодром',
    desc: 'Флот летит к выбранной планете и приземляется на космодром.',
    warn: null,
    default: true,
  },
  {
    id: 'attack',
    icon: '⚔',
    label: 'Атаковать',
    desc: 'Флот атакует вражеские флоты и планету. Порядок действий: уничтожить флоты → бомбардировка → высадка десанта.',
    warn: '⚠ Бомбардировка уничтожает здания и население. Правила войны — в ТЗ.',
  },
  {
    id: 'pirate',
    icon: '🏴‍☠️',
    label: 'Пиратствовать',
    desc: 'Атаковать более слабые флоты в системе, избегать сильных и равных. Без захвата планеты.',
    warn: null,
  },
  {
    id: 'colonize',
    icon: '🌍',
    label: 'Колонизировать',
    desc: 'Высадить колониальный модуль на необитаемой планете. Требует корабль-«Пионер» в составе флота.',
    warn: null,
  },
  {
    id: 'mine',
    icon: '⛏',
    label: 'Добывать ресурсы',
    desc: 'Флот добывает ресурсы пока трюмы не заполнены, затем возвращается. Требует горнодобывающее оборудование.',
    warn: null,
  },
];

function openJourneyModal(fid) {
  const fl = _mockFleets[fid];
  closeModal();

  let selectedAction = 'land';

  const modal = document.createElement('div');
  modal.id = 'sp-modal';
  modal.innerHTML = `
    <div class="sp-modal-box" style="max-width:560px">
      <div class="sp-modal-header">
        <span class="sp-modal-title">🗺 ПУТЕШЕСТВИЕ — ${fl.name}</span>
        <button class="sp-modal-close">✕</button>
      </div>
      <div class="sp-modal-body">

        <div style="font-size:9px;color:#4a7aaa;letter-spacing:1px;margin-bottom:2px">ЦЕЛЬ</div>
        <div class="sp-journey-map-placeholder">
          <div class="map-icon">🌌</div>
          <div>Карта Галактики</div>
          <div style="font-size:9px;color:#1a3a6a">Выбор звезды и планеты — в разработке</div>
          <div style="font-size:9px;color:#3a6a9a;margin-top:4px">Цель: <span id="sp-journey-target" style="color:#7ecfff">не выбрана</span></div>
        </div>

        <div style="font-size:9px;color:#4a7aaa;letter-spacing:1px;margin-top:4px">ДЕЙСТВИЕ ПО ПРИБЫТИИ</div>
        <div class="sp-action-list" id="sp-action-list">
          ${JOURNEY_ACTIONS.map(a => `
            <label class="sp-action-item ${a.default ? 'selected' : ''}" data-action="${a.id}">
              <input type="radio" name="sp-action" value="${a.id}" ${a.default ? 'checked' : ''}>
              <div>
                <div class="sp-action-label">${a.icon} ${a.label}</div>
                <div class="sp-action-desc">${a.desc}</div>
                ${a.warn ? `<div class="sp-action-warn">${a.warn}</div>` : ''}
              </div>
            </label>
          `).join('')}
        </div>

      </div>
      <div class="sp-modal-footer">
        <button class="sp-btn-secondary" id="sp-journey-cancel">Отмена</button>
        <button class="sp-btn-primary" id="sp-journey-confirm">Отправить ▶</button>
      </div>
    </div>
  `;

  document.getElementById('planet-ui').appendChild(modal);

  // Action selection highlight
  modal.querySelectorAll('.sp-action-item').forEach(item => {
    item.addEventListener('click', () => {
      modal.querySelectorAll('.sp-action-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedAction = item.dataset.action;
      item.querySelector('input[type=radio]').checked = true;
    });
  });

  modal.querySelector('.sp-modal-close').addEventListener('click', closeModal);
  modal.querySelector('#sp-journey-cancel').addEventListener('click', closeModal);
  modal.querySelector('#sp-journey-confirm').addEventListener('click', () => {
    // TODO: выполнить отправку с реальными данными
    showError(`Флот "${fl.name}": цель не выбрана. Выберите звезду и планету на карте.`);
    closeModal();
  });
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
}

function openReinforceModal(fid) {
  const fl = _mockFleets[fid];
  closeModal();

  const modal = document.createElement('div');
  modal.id = 'sp-modal';
  modal.innerHTML = `
    <div class="sp-modal-box">
      <div class="sp-modal-header">
        <span class="sp-modal-title">🆘 ПОДКРЕПЛЕНИЕ — ${fl.name}</span>
        <button class="sp-modal-close">✕</button>
      </div>
      <div class="sp-modal-body">
        <div style="font-size:10px;color:#5a8ab0;line-height:1.6">
          Флот дежурит и автоматически вылетает в звёздные системы в заданном радиусе,
          если туда вторгаются силы <b style="color:#c8d8f0">превосходящие</b> по боевой мощи
          силы союзника или собственные силы игрока в этой системе.
          После победы или отступления противника флот возвращается на базу.
        </div>
        <div class="sp-form-row">
          <span class="sp-form-label">Радиус реагирования:</span>
          <input class="sp-form-input" id="sp-reinforce-radius" type="number"
            min="1" max="50" value="${fl.orders.reinforceRadius}">
          <span style="font-size:10px;color:#4a7aaa">пк</span>
        </div>
        <div class="sp-form-hint">Флот не покидает радиус дежурства без явного приказа.</div>
        <div style="border-top:1px solid #1a3a6a;padding-top:8px;font-size:9px;color:#4a7aaa;letter-spacing:1px">
          СОСТОЯНИЕ: ${fl.orders.reinforce
            ? '<span style="color:#44ee88">● Флот дежурит, готов к вылету</span>'
            : '<span style="color:#3a6a9a">○ Режим подкрепления не активен</span>'}
        </div>
      </div>
      <div class="sp-modal-footer">
        <button class="sp-btn-secondary" id="sp-reinforce-cancel">Отмена</button>
        <button class="sp-btn-primary" id="sp-reinforce-confirm">
          ${fl.orders.reinforce ? '✕ Снять с дежурства' : '▶ Поставить на дежурство'}
        </button>
      </div>
    </div>
  `;

  document.getElementById('planet-ui').appendChild(modal);

  modal.querySelector('.sp-modal-close').addEventListener('click', closeModal);
  modal.querySelector('#sp-reinforce-cancel').addEventListener('click', closeModal);
  modal.querySelector('#sp-reinforce-confirm').addEventListener('click', () => {
    fl.orders.reinforceRadius = parseInt(document.getElementById('sp-reinforce-radius').value) || 3;
    fl.orders.reinforce = !fl.orders.reinforce;
    closeModal();
    renderFleetList();
  });
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
}

function closeModal() {
  document.getElementById('sp-modal')?.remove();
}

// ── ПРАВАЯ ПАНЕЛЬ ─────────────────────────────────────────────

function renderDetail() {
  if (!_selected) return;
  _selected === 'unassigned' ? renderUnassigned() : renderFleet(_selected);
}

function renderUnassigned() {
  document.getElementById('sp-detail-name').textContent = 'Корабли без флота';
  document.getElementById('sp-detail-meta').textContent = '';
  document.getElementById('sp-capbar').style.display = 'none';
  document.getElementById('sp-ships-title').textContent = 'КОРАБЛИ БЕЗ ФЛОТА';

  const ids = _unassigned();
  const shipsList = document.getElementById('sp-ships-list');
  const cargoList = document.getElementById('sp-cargo-list');

  if (ids.length === 0) {
    shipsList.innerHTML = `<div class="sp-empty-state">Все корабли распределены по флотам</div>`;
    cargoList.innerHTML = '';
    return;
  }

  shipsList.innerHTML = ids.map(sid => {
    const s = _mockShips[sid];
    const t = SHIP_TYPES[s.type] || { name: s.type, icon:'🚀' };
    const eng = ENGINE_TYPES[s.engine] || { name: s.engine, icon:'⚡' };
    const opts = Object.entries(_mockFleets).map(([fid, fl]) =>
      `<option value="${fid}">${fl.name}</option>`).join('');
    return `
      <div class="sp-ship-row">
        <div class="sp-ship-icon">${t.icon}</div>
        <div class="sp-ship-info">
          <div class="sp-ship-name">${s.name}</div>
          <div class="sp-ship-sub">${t.name} · ${eng.icon} · ✦${s.speed}</div>
          <div class="sp-ship-cargo-lbl">Трюм: ${s.cargo_max.toLocaleString('ru')} у.м.</div>
        </div>
        <select class="sp-fleet-select" data-ship="${sid}">
          <option value="">— флот —</option>${opts}
        </select>
        <button class="sp-ship-btn assign" data-ship="${sid}">+ Флот</button>
      </div>
    `;
  }).join('');

  cargoList.innerHTML = `<div class="sp-empty-state">Выберите корабль</div>`;

  shipsList.querySelectorAll('.sp-ship-btn.assign').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.ship;
      const sel = shipsList.querySelector(`.sp-fleet-select[data-ship="${sid}"]`);
      if (!sel?.value) { showError('Выберите флот из списка'); return; }
      _mockFleets[sel.value].ships.push(sid);
      render();
    });
  });
}

function renderFleet(fid) {
  const fl = _mockFleets[fid];
  if (!fl) return;

  const capacity  = _fleetCapacity(fid);
  const cargoMass = _fleetCargoMass(fid);
  const free      = capacity - cargoMass;
  const pct       = capacity > 0 ? Math.min(100, cargoMass / capacity * 100) : 0;
  const speed     = _fleetSpeed(fid);
  const engine    = _fleetEngine(fid);
  const engLabel  = engine === 'mixed' ? 'Смешанные'
    : engine ? `${ENGINE_TYPES[engine]?.icon} ${ENGINE_TYPES[engine]?.name}` : '—';

  document.getElementById('sp-detail-name').textContent = fl.name;
  document.getElementById('sp-detail-meta').textContent =
    `${fl.ships.length} кор. · ${engLabel} · ✦ ${speed ?? '—'} пк/тик`;

  const capbar = document.getElementById('sp-capbar');
  capbar.style.display = '';
  document.getElementById('sp-bar-used-lbl').textContent = `Груз: ${cargoMass.toLocaleString('ru')} у.м.`;
  document.getElementById('sp-bar-free-lbl').textContent = `Свободно: ${free.toLocaleString('ru')} / ${capacity.toLocaleString('ru')} у.м.`;
  document.getElementById('sp-bar-cargo-el').style.width = pct + '%';
  document.getElementById('sp-bar-free-el').style.width = (100 - pct) + '%';

  document.getElementById('sp-ships-title').textContent = 'СОСТАВ ФЛОТА';

  const shipsList = document.getElementById('sp-ships-list');
  if (fl.ships.length === 0) {
    shipsList.innerHTML = `<div class="sp-empty-state">Флот пуст.<br>Добавьте корабли из «Без флота».</div>`;
  } else {
    const typeCounts = {};
    for (const sid of fl.ships) {
      const t = _mockShips[sid]?.type || '?';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const summary = Object.entries(typeCounts).map(([t, n]) =>
      `${SHIP_TYPES[t]?.icon || '🚀'} ${SHIP_TYPES[t]?.name || t}: ${n}`).join(' · ');

    shipsList.innerHTML = `
      <div style="padding:4px 10px;font-size:9px;color:#4a7aaa;border-bottom:1px solid #0d1e30;background:#06101e">
        ${summary}
      </div>
      ${fl.ships.map(sid => {
        const s = _mockShips[sid]; if (!s) return '';
        const t = SHIP_TYPES[s.type] || { name:s.type, icon:'🚀' };
        const eng = ENGINE_TYPES[s.engine] || { name:s.engine, icon:'⚡' };
        return `
          <div class="sp-ship-row">
            <div class="sp-ship-icon">${t.icon}</div>
            <div class="sp-ship-info">
              <div class="sp-ship-name">${s.name}</div>
              <div class="sp-ship-sub">${t.name} · ${eng.icon} · ✦${s.speed}</div>
              <div class="sp-ship-cargo-lbl">Трюм: ${s.cargo_max.toLocaleString('ru')} у.м.</div>
            </div>
            <button class="sp-ship-btn remove" data-ship="${sid}" data-fleet="${fid}">✕ Убрать</button>
          </div>
        `;
      }).join('')}
    `;
  }

  shipsList.querySelectorAll('.sp-ship-btn.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.ship;
      const shipCargo   = _mockShips[sid]?.cargo_max || 0;
      const newCapacity = _fleetCapacity(fid) - shipCargo;
      const usedMass    = _fleetCargoMass(fid);
      if (newCapacity < usedMass) {
        showError(`Нельзя убрать ${_mockShips[sid]?.name}: груз ${usedMass} у.м. не поместится (не хватает ${usedMass - newCapacity} у.м.). Сначала выгрузите груз.`);
        return;
      }
      fl.ships = fl.ships.filter(id => id !== sid);
      render();
    });
  });

  const cargoList = document.getElementById('sp-cargo-list');
  const entries = Object.entries(fl.cargo || {}).filter(([, q]) => q > 0);
  if (entries.length === 0) {
    cargoList.innerHTML = `<div class="sp-empty-state">Трюм пуст</div>`;
  } else {
    cargoList.innerHTML = entries.map(([rid, qty]) => {
      const r = RESOURCES.find(x => x.id === rid); if (!r) return '';
      return `
        <div class="sp-cargo-row">
          <div class="sp-cargo-icon">${r.icon}</div>
          <div class="sp-cargo-name">${r.name}</div>
          <div class="sp-cargo-qty">${qty.toLocaleString('ru')} ед.</div>
          <div class="sp-cargo-mass">${(qty * r.mass).toLocaleString('ru')} у.м.</div>
        </div>
      `;
    }).join('') + `
      <div class="sp-cargo-row" style="border-top:1px solid #1a3a6a;background:#06101e">
        <div class="sp-cargo-icon">📦</div>
        <div class="sp-cargo-name" style="color:#7ecfff">ИТОГО</div>
        <div class="sp-cargo-qty"></div>
        <div class="sp-cargo-mass" style="color:#7ecfff">${cargoMass.toLocaleString('ru')} у.м.</div>
      </div>
    `;
  }
}

function showError(msg) {
  const el = document.getElementById('sp-error');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 3500);
}
