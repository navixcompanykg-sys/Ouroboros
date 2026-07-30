// ============================================================
// СКЛАД — ui/warehouse.js
// Открывается ВНУТРИ #planet-ui, заменяет центральную область.
// Экспортирует: open(planet, context), close()
// ============================================================

// Все ресурсы: id → { name, icon, mass, basePrice }
const RESOURCES = [
  // ── Газы ─────────────────────────────────────────────────
  { id:'helium3',       name:'Гелий-3',              icon:'🌀', mass:1,  basePrice:120, cat:'raw' },
  { id:'hydrogen',      name:'Водород',               icon:'💧', mass:2,  basePrice:40,  cat:'raw' },
  { id:'deuterium',     name:'Дейтерий',              icon:'⚛',  mass:3,  basePrice:90,  cat:'raw' },
  { id:'noble_gas',     name:'Благородные газы',      icon:'🫧', mass:3,  basePrice:55,  cat:'raw' },
  { id:'volc_gas',      name:'Вулканические газы',    icon:'🌋', mass:4,  basePrice:30,  cat:'raw' },
  // ── Минералы ─────────────────────────────────────────────
  { id:'water_ice',     name:'Водяной лёд',           icon:'🧊', mass:5,  basePrice:20,  cat:'raw' },
  { id:'biomass',       name:'Биомасса',              icon:'🌿', mass:5,  basePrice:25,  cat:'raw' },
  { id:'carbonates',    name:'Карбонаты',             icon:'🧱', mass:6,  basePrice:18,  cat:'raw' },
  { id:'bitumens',      name:'Битумы',                icon:'🛢', mass:7,  basePrice:22,  cat:'raw' },
  { id:'phosphates',    name:'Фосфаты',               icon:'🧪', mass:8,  basePrice:35,  cat:'raw' },
  { id:'silicates',     name:'Силикаты',              icon:'🪨', mass:8,  basePrice:15,  cat:'raw' },
  { id:'refract',       name:'Тугоплавкие металлы',   icon:'🌡', mass:10, basePrice:60,  cat:'raw' },
  { id:'iron',          name:'Железо',                icon:'⚙',  mass:12, basePrice:45,  cat:'raw' },
  { id:'rare_metals',   name:'Редкоземельные',        icon:'💎', mass:14, basePrice:110, cat:'raw' },
  { id:'hq_alloys_raw', name:'В/к сплавы (сырьё)',   icon:'✨', mass:16, basePrice:140, cat:'raw' },
  { id:'platinoids',    name:'Платиноиды',            icon:'🔆', mass:16, basePrice:180, cat:'raw' },
  { id:'radioact',      name:'Радиоактивные',         icon:'☢',  mass:18, basePrice:200, cat:'raw' },
  // ── Компоненты ───────────────────────────────────────────
  { id:'biosynthetics', name:'Биосинтетика',          icon:'🧬', mass:4,  basePrice:85,  cat:'comp' },
  { id:'polymers',      name:'Полимеры',              icon:'🧴', mass:4,  basePrice:70,  cat:'comp' },
  { id:'chem_reagents', name:'Хим. реагенты',         icon:'⚗',  mass:5,  basePrice:80,  cat:'comp' },
  { id:'electronics',   name:'Электроника',           icon:'💻', mass:3,  basePrice:160, cat:'comp' },
  { id:'power_elements',name:'Эл. питания',           icon:'🔋', mass:7,  basePrice:95,  cat:'comp' },
  { id:'cable',         name:'Кабельная продукция',   icon:'🔌', mass:8,  basePrice:75,  cat:'comp' },
  { id:'nuclear_comp',  name:'Ядерные компоненты',    icon:'☣',  mass:10, basePrice:220, cat:'comp' },
  { id:'hq_alloys',     name:'В/к сплавы',            icon:'🏗', mass:16, basePrice:190, cat:'comp' },
  { id:'metal_struct',  name:'Металлоконструкции',    icon:'🔩', mass:15, basePrice:130, cat:'comp' },
  { id:'ind_equip',     name:'Пром. оборудование',    icon:'🏭', mass:20, basePrice:250, cat:'comp' },
  { id:'weapons',       name:'Вооружение',            icon:'⚔',  mass:25, basePrice:400, cat:'comp' },
];

// Состояние склада (in-memory, пока без сервера)
// planet_key → { resources: { id → { qty, reserve, price, dumpStep } } }
const _state = {};

function _getState(planetKey) {
  if (!_state[planetKey]) {
    _state[planetKey] = { resources: {} };
    for (const r of RESOURCES) {
      _state[planetKey].resources[r.id] = {
        qty: 0,
        reserve: 0,
        price: r.basePrice,
        dumpStep: 10,  // каждые N ед. сверх мин. запаса → скидка −5%
      };
    }
  }
  return _state[planetKey];
}

// ── DOM ──────────────────────────────────────────────────────

let _planet = null;
let _planetKey = null;

export function open(planet, context) {
  _planet = planet;
  _planetKey = planet?.id ?? 'default';

  injectStyles();
  injectDOM();

  // Скрываем стандартные элементы planet-ui
  ['pui-left','pui-center','pui-right','pui-bottom-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const view = document.getElementById('wh-view');
  if (view) view.style.display = 'flex';

  renderTable();
}

export function close() {
  const view = document.getElementById('wh-view');
  if (view) view.remove();

  ['pui-left','pui-center','pui-right','pui-bottom-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

// ── STYLES ───────────────────────────────────────────────────

function injectStyles() {
  let s = document.getElementById('wh-styles');
  if (!s) { s = document.createElement('style'); s.id = 'wh-styles'; document.head.appendChild(s); }
  s.textContent = `
#wh-view {
  position:absolute; inset:0; z-index:200;
  display:flex; flex-direction:column;
  background:#040810; color:#c8d8f0;
  font-family:'Share Tech Mono',monospace; font-size:12px;
  overflow:hidden;
}
#wh-header {
  display:flex; align-items:center; gap:10px;
  padding:8px 14px; border-bottom:1px solid #1a3a6a;
  background:#060e1e; flex-shrink:0;
}
#wh-back-btn:hover { border-color:#00e5ff !important; color:#00e5ff !important; }
#wh-header .wh-title { color:#00e5ff; font-size:14px; letter-spacing:2px; flex:1; }
#wh-header .wh-cap { color:#7ecfff; font-size:11px; }
#wh-tabs {
  display:flex; gap:0; border-bottom:1px solid #1a3a6a;
  background:#060e1e; flex-shrink:0;
}
.wh-tab {
  padding:5px 16px; cursor:pointer; font-size:11px; color:#7ecfff;
  border-right:1px solid #1a3a6a; transition:background 0.15s;
  letter-spacing:1px;
}
.wh-tab:hover { background:#0a1a30; color:#00e5ff; }
.wh-tab.active { background:#0d1e38; color:#00e5ff; border-bottom:2px solid #00e5ff; }
#wh-body { flex:1; overflow-y:auto; padding:0; }
/* capacity bar */
#wh-capbar { padding:8px 14px; background:#06101e; border-bottom:1px solid #1a3a6a; flex-shrink:0; }
.wh-bar-track {
  height:8px; background:#0a1a2a; border-radius:4px; overflow:hidden;
  display:flex; margin-top:4px;
}
.wh-bar-own   { background:#00e5ff; height:100%; transition:width 0.3s; }
.wh-bar-free  { background:#1a3a5a; height:100%; transition:width 0.3s; }
.wh-bar-labels { display:flex; justify-content:space-between; margin-top:3px; font-size:10px; color:#5a8ab0; }
/* resource table */
#wh-res-table { width:100%; border-collapse:collapse; }
#wh-res-table thead th {
  position:sticky; top:0; background:#07111f;
  padding:5px 10px; text-align:left; font-size:10px;
  color:#4a7aaa; border-bottom:1px solid #1a3a6a;
  white-space:nowrap; letter-spacing:1px;
}
#wh-res-table thead th:nth-child(1) { width:32px; }
#wh-res-table thead th:nth-child(2) { min-width:130px; }
#wh-res-table thead th.th-r { text-align:right; }
#wh-res-table tbody tr { border-bottom:1px solid #0d1e30; transition:background 0.1s; }
#wh-res-table tbody tr:hover { background:#080f1c; }
#wh-res-table tbody td { padding:4px 10px; vertical-align:middle; }
.wh-res-icon { font-size:15px; text-align:center; }
.wh-res-name { color:#c8d8f0; }
.wh-res-cat  { font-size:9px; color:#4a7aaa; margin-top:1px; }
.wh-qty     { text-align:right; color:#e0f0ff; font-size:12px; }
.wh-mass    { text-align:right; color:#5a8ab0; font-size:10px; }
.wh-qty-zero { color:#2a4a6a; }
.wh-field {
  width:64px; background:#040d1a; border:1px solid #1a3a5a;
  color:#c8d8f0; font-family:'Share Tech Mono',monospace; font-size:11px;
  padding:2px 6px; border-radius:3px; text-align:right;
}
.wh-field:focus { outline:none; border-color:#00e5ff; color:#fff; }
.wh-price-cell { text-align:right; }
.wh-price-val { color:#ffcc44; font-size:11px; }
.wh-price-base { color:#4a7aaa; font-size:9px; }
.wh-on-market { color:#44ee88; font-size:9px; margin-top:1px; }
.wh-section-hdr {
  background:#07111f; padding:4px 10px;
  color:#4a7aaa; font-size:10px; letter-spacing:2px;
  border-bottom:1px solid #1a3a6a; border-top:1px solid #1a3a6a;
  position:sticky; top:29px;
}
/* ── transfer panel ── */
#wh-transfer { display:flex; flex-direction:column; height:100%; overflow:hidden; }
#tr-fleet-zone {
  padding:10px 14px; border-bottom:1px solid #1a3a6a;
  background:#06101e; flex-shrink:0;
}
#tr-fleet-zone .tr-zone-title {
  font-size:10px; color:#4a7aaa; letter-spacing:2px; margin-bottom:8px;
}
#tr-fleet-cards { display:flex; gap:8px; flex-wrap:wrap; }
.tr-fleet-card {
  width:90px; padding:8px 6px; border:1px solid #1a3a6a; border-radius:4px;
  background:#040c1a; cursor:pointer; text-align:center;
  transition:border-color 0.15s, background 0.15s; flex-shrink:0;
}
.tr-fleet-card:hover { border-color:#3a7aaa; background:#060f1e; }
.tr-fleet-card.selected { border-color:#00e5ff; background:#071422; }
.tr-fleet-card.fleet-own { border-color:#1a5a3a; }
.tr-fleet-card.fleet-own.selected { border-color:#44ee88; }
.tr-fleet-card.fleet-full { opacity:0.4; cursor:default; }
.tr-fleet-card.fleet-locked { opacity:0.25; cursor:not-allowed; }
.tr-fleet-icon { font-size:22px; margin-bottom:4px; }
.tr-fleet-name { font-size:9px; color:#c8d8f0; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tr-fleet-fill { font-size:9px; color:#5a8ab0; }
.tr-fleet-status { font-size:8px; margin-top:2px; }
.tr-fleet-status.full  { color:#ff5533; }
.tr-fleet-status.free  { color:#44ee88; }
.tr-fleet-status.warn  { color:#ffcc44; }
.tr-no-fleet-btn {
  display:flex; align-items:center; justify-content:center;
  width:90px; height:70px; border:1px dashed #1a3a6a; border-radius:4px;
  background:transparent; color:#3a6a9a; font-size:10px; cursor:pointer;
  text-align:center; line-height:1.4; transition:border-color 0.15s, color 0.15s;
}
.tr-no-fleet-btn:hover { border-color:#3a7aaa; color:#7ecfff; }
#tr-selected-label { font-size:10px; color:#7ecfff; margin-top:6px; min-height:14px; }
/* direction */
#tr-direction {
  display:flex; align-items:center; gap:8px;
  padding:8px 14px; border-bottom:1px solid #1a3a6a;
  background:#06101e; flex-shrink:0;
}
#tr-direction .tr-dir-label { font-size:10px; color:#4a7aaa; letter-spacing:1px; margin-right:4px; }
.tr-dir-btn {
  padding:4px 14px; border:1px solid #1a3a6a; border-radius:3px;
  background:#040c1a; color:#7ecfff; font-family:'Share Tech Mono',monospace;
  font-size:11px; cursor:pointer; transition:all 0.15s; letter-spacing:1px;
}
.tr-dir-btn:hover { border-color:#3a7aaa; color:#00e5ff; }
.tr-dir-btn.active { background:#0d1e38; border-color:#00e5ff; color:#00e5ff; }
/* resource transfer table */
#tr-body { flex:1; overflow-y:auto; }
#tr-res-table { width:100%; border-collapse:collapse; }
#tr-res-table thead th {
  position:sticky; top:0; background:#07111f;
  padding:5px 10px; font-size:10px; color:#4a7aaa;
  border-bottom:1px solid #1a3a6a; text-align:left; letter-spacing:1px;
}
#tr-res-table thead th.th-r { text-align:right; }
#tr-res-table tbody tr { border-bottom:1px solid #0d1e30; }
#tr-res-table tbody tr.tr-row-zero { opacity:0.35; }
#tr-res-table tbody tr:hover { background:#080f1c; }
#tr-res-table tbody td { padding:4px 10px; vertical-align:middle; }
/* footer */
#tr-footer {
  border-top:1px solid #1a3a6a; background:#06101e;
  padding:8px 14px; flex-shrink:0; display:flex;
  flex-direction:column; gap:6px;
}
#tr-mass-summary {
  display:flex; gap:20px; font-size:10px;
}
.tr-mass-item { display:flex; flex-direction:column; gap:1px; }
.tr-mass-label { color:#4a7aaa; }
.tr-mass-val   { color:#c8d8f0; font-size:12px; }
.tr-mass-val.warn { color:#ffcc44; }
.tr-mass-val.err  { color:#ff5533; }
#tr-btn-row { display:flex; gap:8px; justify-content:flex-end; align-items:center; }
.tr-btn-secondary {
  padding:5px 14px; border:1px solid #1a3a6a; border-radius:3px;
  background:transparent; color:#7ecfff; font-family:'Share Tech Mono',monospace;
  font-size:11px; cursor:pointer; transition:all 0.15s;
}
.tr-btn-secondary:hover { border-color:#3a7aaa; color:#00e5ff; }
.tr-btn-primary {
  padding:5px 18px; border:1px solid #00e5ff; border-radius:3px;
  background:#071422; color:#00e5ff; font-family:'Share Tech Mono',monospace;
  font-size:11px; cursor:pointer; letter-spacing:1px; transition:all 0.15s;
}
.tr-btn-primary:hover { background:#0d2040; }
.tr-btn-primary:disabled { opacity:0.3; cursor:default; border-color:#1a3a6a; color:#3a6a9a; }
#tr-warning { color:#ffcc44; font-size:10px; min-height:14px; }
`;
}

// ── DOM INJECT ───────────────────────────────────────────────

function injectDOM() {
  const old = document.getElementById('wh-view');
  if (old) old.remove();

  const view = document.createElement('div');
  view.id = 'wh-view';
  view.style.display = 'none';
  view.innerHTML = `
    <div id="wh-header">
      <button id="wh-back-btn" style="background:transparent;border:1px solid rgba(0,229,255,0.25);color:#7ecfff;font-family:'Share Tech Mono',monospace;font-size:10px;padding:2px 10px;border-radius:3px;cursor:pointer;letter-spacing:1px;flex-shrink:0;">← НАЗАД</button>
      <span class="wh-title">📦 СКЛАД</span>
      <span class="wh-cap" id="wh-cap-label">Уровень: встроенный · Ёмкость: 2 000 у.м.</span>
    </div>
    <div id="wh-capbar">
      <div class="wh-bar-labels">
        <span id="wh-bar-used">Занято: 0 у.м.</span>
        <span id="wh-bar-free-lbl">Свободно: 2 000 у.м.</span>
      </div>
      <div class="wh-bar-track">
        <div class="wh-bar-own" id="wh-bar-own-el" style="width:0%"></div>
        <div class="wh-bar-free" id="wh-bar-free-el" style="width:100%"></div>
      </div>
    </div>
    <div id="wh-tabs">
      <div class="wh-tab active" data-tab="resources">РЕСУРСЫ</div>
      <div class="wh-tab" data-tab="rent">АРЕНДА</div>
      <div class="wh-tab" data-tab="transfer">⇄ ПЕРЕГРУЗКА</div>
    </div>
    <div id="wh-body"></div>
  `;

  const overlay = document.getElementById('planet-ui') || document.body;
  overlay.appendChild(view);

  // Back button
  view.querySelector('#wh-back-btn').addEventListener('click', () => close());

  // Tab switching
  view.querySelectorAll('.wh-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      view.querySelectorAll('.wh-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderTab(tab.dataset.tab);
    });
  });
}

// ── RENDER ───────────────────────────────────────────────────

function renderTab(tab) {
  const body = document.getElementById('wh-body');
  if (!body) return;
  if (tab === 'resources') renderTable();
  else if (tab === 'rent') { body.innerHTML = '<div style="padding:20px;color:#4a7aaa">Аренда — в разработке</div>'; }
  else if (tab === 'transfer') renderTransfer();
}

// ── TRANSFER PANEL ───────────────────────────────────────────

// Состояние панели перегрузки
const _tr = {
  selectedFleet: null,   // null = не выбран
  direction: 'to_fleet', // 'to_fleet' | 'to_wh'
  amounts: {},           // resource_id → количество для перегрузки
};

// Заглушка-данные флотов (заменяются реальными когда появятся)
// Структура: { id, name, own, cargo_used, cargo_max, departing }
const MOCK_FLEETS = [
  // пока пусто — показываем placeholder
];

function renderTransfer() {
  const body = document.getElementById('wh-body');
  if (!body) return;

  body.innerHTML = `<div id="wh-transfer"></div>`;
  const wrap = document.getElementById('wh-transfer');

  wrap.innerHTML = `
    <!-- Зона флотов -->
    <div id="tr-fleet-zone">
      <div class="tr-zone-title">ФЛОТЫ НА ОРБИТЕ / ПЛАНЕТЕ:</div>
      <div id="tr-fleet-cards"></div>
      <div id="tr-selected-label">Флот не выбран</div>
    </div>

    <!-- Направление -->
    <div id="tr-direction">
      <span class="tr-dir-label">НАПРАВЛЕНИЕ:</span>
      <button class="tr-dir-btn active" id="tr-dir-to-fleet">▶ В трюм</button>
      <button class="tr-dir-btn" id="tr-dir-to-wh">◀ На склад</button>
    </div>

    <!-- Таблица ресурсов -->
    <div id="tr-body">
      <table id="tr-res-table">
        <thead>
          <tr>
            <th style="width:28px"></th>
            <th>Ресурс</th>
            <th class="th-r">На складе</th>
            <th class="th-r">В трюме</th>
            <th class="th-r">Перегрузить, ед.</th>
            <th class="th-r">Масса</th>
          </tr>
        </thead>
        <tbody id="tr-res-body"></tbody>
      </table>
    </div>

    <!-- Подвал -->
    <div id="tr-footer">
      <div id="tr-warning"></div>
      <div id="tr-mass-summary">
        <div class="tr-mass-item">
          <span class="tr-mass-label">Займёт в трюме:</span>
          <span class="tr-mass-val" id="tr-mass-fleet">0 у.м.</span>
        </div>
        <div class="tr-mass-item">
          <span class="tr-mass-label">Свободно в трюме:</span>
          <span class="tr-mass-val" id="tr-mass-fleet-free">— у.м.</span>
        </div>
        <div class="tr-mass-item">
          <span class="tr-mass-label">Освободит склад:</span>
          <span class="tr-mass-val" id="tr-mass-wh-rel">0 у.м.</span>
        </div>
        <div class="tr-mass-item">
          <span class="tr-mass-label">Свободно на складе:</span>
          <span class="tr-mass-val" id="tr-mass-wh-free">— у.м.</span>
        </div>
      </div>
      <div id="tr-btn-row">
        <button class="tr-btn-secondary" id="tr-btn-unload-all"
          title="Выгрузить всё из трюма выбранного флота на склад">
          ◀◀ Выгрузить всё из трюма
        </button>
        <button class="tr-btn-primary" id="tr-btn-execute" disabled>
          Выполнить ▶
        </button>
      </div>
    </div>
  `;

  _renderFleetCards();
  _renderTrResRows();
  _bindTrEvents();
}

function _renderFleetCards() {
  const zone = document.getElementById('tr-fleet-cards');
  if (!zone) return;

  if (MOCK_FLEETS.length === 0) {
    zone.innerHTML = `
      <button class="tr-no-fleet-btn" id="tr-btn-choose-fleet"
        title="Выбрать флот для перегрузки (будет доступно когда появятся флоты)">
        🚀<br>Выбрать<br>флот…
      </button>
      <div style="font-size:9px;color:#2a4a6a;align-self:center;margin-left:8px">
        Флотов на орбите нет.<br>Когда флот прибудет —<br>карточки появятся здесь.
      </div>
    `;
    document.getElementById('tr-selected-label').textContent = 'Флот не выбран';
    return;
  }

  let html = '';
  for (const fl of MOCK_FLEETS) {
    const free = fl.cargo_max - fl.cargo_used;
    const pct  = fl.cargo_max > 0 ? Math.round(fl.cargo_used / fl.cargo_max * 100) : 0;
    const full  = free <= 0;
    const locked = !fl.own && !fl.allow_load;
    const selected = _tr.selectedFleet === fl.id;

    let cls = 'tr-fleet-card';
    if (fl.own)    cls += ' fleet-own';
    if (full)      cls += ' fleet-full';
    if (locked)    cls += ' fleet-locked';
    if (selected)  cls += ' selected';

    let statusHtml = '';
    if (full) statusHtml = `<div class="tr-fleet-status full">ПОЛНЫЙ</div>`;
    else if (fl.departing) statusHtml = `<div class="tr-fleet-status warn">⚠ ВЫЛЕТ</div>`;
    else statusHtml = `<div class="tr-fleet-status free">${free.toLocaleString('ru')} св.</div>`;

    html += `
      <div class="${cls}" data-fleet-id="${fl.id}" ${locked ? 'title="Нет разрешения на загрузку"' : ''}>
        <div class="tr-fleet-icon">🚀</div>
        <div class="tr-fleet-name">${fl.name}</div>
        <div class="tr-fleet-fill">${fl.cargo_used}/${fl.cargo_max} у.м.</div>
        ${statusHtml}
      </div>
    `;
  }
  zone.innerHTML = html;

  // Update selected label
  const sel = MOCK_FLEETS.find(f => f.id === _tr.selectedFleet);
  const lbl = document.getElementById('tr-selected-label');
  if (lbl) lbl.textContent = sel ? `Выбран: ${sel.name}` : 'Флот не выбран';
}

function _renderTrResRows() {
  const tbody = document.getElementById('tr-res-body');
  if (!tbody) return;

  const st = _getState(_planetKey);
  const fleet = MOCK_FLEETS.find(f => f.id === _tr.selectedFleet) || null;
  const fleetFree = fleet ? (fleet.cargo_max - fleet.cargo_used) : null;
  const toFleet = _tr.direction === 'to_fleet';

  let rows = '';
  for (const r of RESOURCES) {
    const rs = st.resources[r.id];
    const amt = _tr.amounts[r.id] || 0;
    // Доступно к отгрузке со склада = qty - reserve
    const availFromWh = Math.max(0, rs.qty - rs.reserve);
    // Cargo qty — пока 0 (нет реальных флотов)
    const cargoQty = 0;

    // Строки с нулями в обоих источниках — приглушить
    const bothZero = rs.qty === 0 && cargoQty === 0;

    // Поле ввода: ограничение зависит от направления
    const maxVal = toFleet ? availFromWh : cargoQty;
    const disabled = !fleet || maxVal === 0;

    rows += `
      <tr class="${bothZero ? 'tr-row-zero' : ''}" data-id="${r.id}">
        <td style="font-size:15px;text-align:center">${r.icon}</td>
        <td>
          <div style="color:#c8d8f0">${r.name}</div>
          <div style="font-size:9px;color:#4a7aaa">${r.mass} у.м./ед.</div>
        </td>
        <td style="text-align:right;color:${rs.qty === 0 ? '#2a4a6a' : '#e0f0ff'}">
          ${rs.qty > 0 ? rs.qty.toLocaleString('ru') : '—'}
          ${toFleet && rs.reserve > 0 ? `<div style="font-size:9px;color:#3a6a9a">резерв: ${rs.reserve}</div>` : ''}
        </td>
        <td style="text-align:right;color:${cargoQty === 0 ? '#2a4a6a' : '#e0f0ff'}">
          ${cargoQty > 0 ? cargoQty.toLocaleString('ru') : '—'}
        </td>
        <td style="text-align:right">
          <input class="wh-field tr-amt-field" type="number"
            min="0" max="${maxVal}" value="${amt}"
            data-id="${r.id}" data-mass="${r.mass}"
            ${disabled ? 'disabled' : ''}
            style="${disabled ? 'opacity:0.3' : ''}">
        </td>
        <td style="text-align:right;font-size:10px;color:#5a8ab0" id="tr-mass-${r.id}">
          ${amt > 0 ? (amt * r.mass).toLocaleString('ru') + ' у.м.' : '—'}
        </td>
      </tr>
    `;
  }
  tbody.innerHTML = rows;

  _updateTrSummary();
}

function _updateTrSummary() {
  const fleet = MOCK_FLEETS.find(f => f.id === _tr.selectedFleet) || null;
  const fleetFree = fleet ? (fleet.cargo_max - fleet.cargo_used) : null;

  // Calc total mass
  let totalMass = 0;
  for (const r of RESOURCES) {
    const amt = _tr.amounts[r.id] || 0;
    totalMass += amt * r.mass;
  }

  // Warehouse free
  const st = _getState(_planetKey);
  let usedMass = 0;
  for (const r of RESOURCES) usedMass += (st.resources[r.id].qty || 0) * r.mass;
  const whFree = 2000 - usedMass;

  const toFleet = _tr.direction === 'to_fleet';
  const overCapacity = fleetFree !== null && totalMass > fleetFree;

  // Update labels
  const setEl = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'tr-mass-val' + (cls ? ' ' + cls : '');
  };

  if (toFleet) {
    setEl('tr-mass-fleet',      totalMass > 0 ? totalMass.toLocaleString('ru') + ' у.м.' : '0 у.м.', overCapacity ? 'err' : '');
    setEl('tr-mass-fleet-free', fleetFree !== null ? fleetFree.toLocaleString('ru') + ' у.м.' : '— у.м.', overCapacity ? 'warn' : '');
    setEl('tr-mass-wh-rel',     totalMass > 0 ? totalMass.toLocaleString('ru') + ' у.м.' : '0 у.м.', '');
    setEl('tr-mass-wh-free',    whFree.toLocaleString('ru') + ' у.м.', '');
  } else {
    setEl('tr-mass-fleet',      '— у.м.', '');
    setEl('tr-mass-fleet-free', fleetFree !== null ? fleetFree.toLocaleString('ru') + ' у.м.' : '— у.м.', '');
    setEl('tr-mass-wh-rel',     '— у.м.', '');
    setEl('tr-mass-wh-free',    totalMass > 0 ? (whFree - totalMass).toLocaleString('ru') + ' у.м.' : whFree.toLocaleString('ru') + ' у.м.',
      totalMass > whFree ? 'err' : '');
  }

  // Warning
  const warn = document.getElementById('tr-warning');
  if (warn) {
    if (!fleet) warn.textContent = '⚠ Выберите флот для перегрузки';
    else if (overCapacity) warn.textContent = '⚠ Превышена ёмкость трюма';
    else if (!toFleet && totalMass > whFree) warn.textContent = '⚠ Недостаточно места на складе';
    else if (fleet?.departing) warn.textContent = '⚠ Флот отправится в этом тике — успейте до конца тика';
    else warn.textContent = '';
  }

  // Execute button
  const execBtn = document.getElementById('tr-btn-execute');
  if (execBtn) {
    const canExec = fleet && totalMass > 0 && !overCapacity && !((!toFleet) && totalMass > whFree);
    execBtn.disabled = !canExec;
  }
}

function _bindTrEvents() {
  // Fleet card selection
  document.getElementById('tr-fleet-cards')?.addEventListener('click', e => {
    const card = e.target.closest('.tr-fleet-card');
    if (!card || card.classList.contains('fleet-full') || card.classList.contains('fleet-locked')) return;
    _tr.selectedFleet = card.dataset.fleetId;
    _tr.amounts = {};
    _renderFleetCards();
    _renderTrResRows();
  });

  // Direction buttons
  document.getElementById('tr-dir-to-fleet')?.addEventListener('click', () => {
    _tr.direction = 'to_fleet';
    _tr.amounts = {};
    document.getElementById('tr-dir-to-fleet')?.classList.add('active');
    document.getElementById('tr-dir-to-wh')?.classList.remove('active');
    _renderTrResRows();
  });
  document.getElementById('tr-dir-to-wh')?.addEventListener('click', () => {
    _tr.direction = 'to_wh';
    _tr.amounts = {};
    document.getElementById('tr-dir-to-fleet')?.classList.remove('active');
    document.getElementById('tr-dir-to-wh')?.classList.add('active');
    _renderTrResRows();
  });

  // Amount inputs (delegated)
  document.getElementById('tr-res-body')?.addEventListener('input', e => {
    const input = e.target.closest('.tr-amt-field');
    if (!input) return;
    const id = input.dataset.id;
    const mass = parseFloat(input.dataset.mass);
    const val = Math.max(0, Math.min(parseFloat(input.max) || 0, parseFloat(input.value) || 0));
    _tr.amounts[id] = val;
    // Update mass cell
    const massCell = document.getElementById(`tr-mass-${id}`);
    if (massCell) massCell.textContent = val > 0 ? (val * mass).toLocaleString('ru') + ' у.м.' : '—';
    _updateTrSummary();
  });

  // Unload all from fleet
  document.getElementById('tr-btn-unload-all')?.addEventListener('click', () => {
    const fleet = MOCK_FLEETS.find(f => f.id === _tr.selectedFleet);
    if (!fleet) { alert('Выберите флот'); return; }
    _tr.direction = 'to_wh';
    _tr.amounts = {};
    // В будущем: заполнить amounts данными из трюма флота
    document.getElementById('tr-dir-to-fleet')?.classList.remove('active');
    document.getElementById('tr-dir-to-wh')?.classList.add('active');
    _renderTrResRows();
  });

  // Execute
  document.getElementById('tr-btn-execute')?.addEventListener('click', () => {
    const fleet = MOCK_FLEETS.find(f => f.id === _tr.selectedFleet);
    if (!fleet) return;
    const lines = Object.entries(_tr.amounts)
      .filter(([,v]) => v > 0)
      .map(([id, v]) => {
        const r = RESOURCES.find(x => x.id === id);
        return `  ${r?.icon || ''} ${r?.name || id}: ${v} ед.`;
      }).join('\n');
    if (!lines) return;

    const dir = _tr.direction === 'to_fleet' ? 'Склад → Трюм' : 'Трюм → Склад';
    // TODO: отправить запрос на сервер POST /warehouse/.../transfer
    // Пока: применяем локально к _state
    const st = _getState(_planetKey);
    for (const [id, qty] of Object.entries(_tr.amounts)) {
      if (!qty) continue;
      if (_tr.direction === 'to_fleet') {
        st.resources[id].qty = Math.max(0, (st.resources[id].qty || 0) - qty);
      }
      // to_wh: добавляем на склад (когда появятся реальные флоты)
    }
    _tr.amounts = {};
    _renderTrResRows();
    // Обновить бар склада
    const activeTab = document.querySelector('.wh-tab.active');
    if (activeTab?.dataset.tab === 'transfer') {
      // остаёмся на вкладке, перерисовываем
    }
    // Обновить capbar
    _refreshCapBar();
  });
}

function _refreshCapBar() {
  const st = _getState(_planetKey);
  let usedMass = 0;
  for (const r of RESOURCES) usedMass += (st.resources[r.id].qty || 0) * r.mass;
  const capacity = 2000;
  const freeMass = capacity - usedMass;
  const usedPct = Math.min(100, (usedMass / capacity) * 100);
  const ownEl = document.getElementById('wh-bar-own-el');
  const freeEl = document.getElementById('wh-bar-free-el');
  const usedLbl = document.getElementById('wh-bar-used');
  const freeLbl = document.getElementById('wh-bar-free-lbl');
  if (ownEl) ownEl.style.width = usedPct + '%';
  if (freeEl) freeEl.style.width = (100 - usedPct) + '%';
  if (usedLbl) usedLbl.textContent = `Занято: ${usedMass.toLocaleString('ru')} у.м.`;
  if (freeLbl) freeLbl.textContent = `Свободно: ${freeMass.toLocaleString('ru')} у.м.`;
}

function renderTable() {
  const body = document.getElementById('wh-body');
  if (!body) return;

  const st = _getState(_planetKey);
  const rows = { raw: [], comp: [] };

  // Calculate used capacity
  let usedMass = 0;
  for (const r of RESOURCES) {
    const rs = st.resources[r.id];
    usedMass += rs.qty * r.mass;
  }
  const capacity = 2000;
  const freeMass = capacity - usedMass;
  const usedPct = Math.min(100, (usedMass / capacity) * 100);

  // Update bar
  const ownEl = document.getElementById('wh-bar-own-el');
  const freeEl = document.getElementById('wh-bar-free-el');
  const usedLbl = document.getElementById('wh-bar-used');
  const freeLbl = document.getElementById('wh-bar-free-lbl');
  if (ownEl) ownEl.style.width = usedPct + '%';
  if (freeEl) freeEl.style.width = (100 - usedPct) + '%';
  if (usedLbl) usedLbl.textContent = `Занято: ${usedMass.toLocaleString('ru')} у.м.`;
  if (freeLbl) freeLbl.textContent = `Свободно: ${freeMass.toLocaleString('ru')} у.м.`;

  // Build table rows
  for (const r of RESOURCES) {
    const rs = st.resources[r.id];
    const totalMass = rs.qty * r.mass;
    const isZero = rs.qty === 0;
    const onMarket = rs.qty > rs.reserve && rs.price > 0;

    // surplus = кол-во ресурсов доступных для продажи (сверх мин. запаса)
    const surplus = rs.qty - rs.reserve;
    // каждые dumpStep единиц сверх резерва → −5% к цене
    const steps = surplus > 0 ? Math.floor(surplus / rs.dumpStep) : 0;
    const effectivePrice = steps > 0
      ? Math.max(1, Math.round(rs.price * Math.pow(0.95, steps)))
      : rs.price;

    const priceChanged = steps > 0;

    rows[r.cat].push(`
      <tr data-id="${r.id}">
        <td class="wh-res-icon">${r.icon}</td>
        <td>
          <div class="wh-res-name">${r.name}</div>
          <div class="wh-res-cat">${r.mass} у.м./ед.</div>
        </td>
        <td class="wh-qty ${isZero ? 'wh-qty-zero' : ''}">
          ${isZero ? '—' : rs.qty.toLocaleString('ru')}
          ${!isZero ? `<div style="font-size:9px;color:#4a7aaa">${totalMass} у.м.</div>` : ''}
        </td>
        <td class="th-r">
          <input class="wh-field" type="number" min="0" data-field="reserve" data-id="${r.id}"
            value="${rs.reserve}" title="Мин. запас (ед.)">
        </td>
        <td class="wh-price-cell">
          <input class="wh-field" type="number" min="0" data-field="price" data-id="${r.id}"
            value="${rs.price}" title="Цена продажи (₮/ед.), 0 = не продаётся">
          ${priceChanged ? `<div class="wh-price-val" title="Цена со скидкой демпинга">${effectivePrice} ₮ ▾</div>` : `<div class="wh-price-base">базовая: ${r.basePrice} ₮</div>`}
        </td>
        <td class="th-r">
          <input class="wh-field" style="width:44px" type="number" min="1" data-field="dumpStep" data-id="${r.id}"
            value="${rs.dumpStep}" title="Каждые N ед. сверх мин. запаса → цена −5%">
          <div style="font-size:9px;color:#4a7aaa">ед./−5%</div>
        </td>
        <td style="text-align:right;min-width:90px">
          ${surplus > 0 && rs.price > 0
            ? `<span class="wh-on-market">✅ ${surplus.toLocaleString('ru')} ед.<br>${effectivePrice} ₮/ед.${priceChanged ? ` <span style="color:#ffaa44">(−${steps*5}%)</span>` : ''}</span>`
            : `<span style="font-size:9px;color:#2a4a6a">—</span>`}
        </td>
      </tr>
    `);
  }

  body.innerHTML = `
    <table id="wh-res-table">
      <thead>
        <tr>
          <th></th>
          <th>Ресурс</th>
          <th class="th-r">Кол-во</th>
          <th class="th-r">Мин. запас</th>
          <th class="th-r">Цена, ₮/ед.</th>
          <th class="th-r">Шаг скидки</th>
          <th class="th-r">Статус</th>
        </tr>
      </thead>
      <tbody>
        <tr><td colspan="7" class="wh-section-hdr">СЫРЬЁ</td></tr>
        ${rows.raw.join('')}
        <tr><td colspan="7" class="wh-section-hdr">КОМПОНЕНТЫ</td></tr>
        ${rows.comp.join('')}
      </tbody>
    </table>
  `;

  // Live input handlers
  body.querySelectorAll('.wh-field').forEach(input => {
    input.addEventListener('change', () => {
      const { id, field } = input.dataset;
      const val = parseFloat(input.value) || 0;
      _getState(_planetKey).resources[id][field] = val;
      renderTable();
    });
  });
}
