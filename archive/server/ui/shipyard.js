// ============================================================
// ВЕРФЬ — ui/shipyard.js
// Открывается ВНУТРИ #planet-ui, заменяет центральную область.
// Экспортирует: open(planet, context), close()
// ============================================================
'use strict';

// ─── ДАННЫЕ ──────────────────────────────────────────────────────────────────

const SY_CLASSES = [
  { id:'corvette',    name:'Корвет',   f:'mil', ue:1,  slots:8,  hull:100,  m:9, spd:10, icon:'🛩' },
  { id:'frigate',     name:'Фрегат',   f:'mil', ue:2,  slots:12, hull:200,  m:7, spd:8,  icon:'✈'  },
  { id:'destroyer',   name:'Эсминец',  f:'mil', ue:4,  slots:16, hull:400,  m:5, spd:6,  icon:'🛥'  },
  { id:'cruiser',     name:'Крейсер',  f:'mil', ue:8,  slots:20, hull:800,  m:3, spd:4,  icon:'🚢'  },
  { id:'battleship',  name:'Линкор',   f:'mil', ue:12, slots:26, hull:1200, m:2, spd:3,  icon:'🚀'  },
  { id:'dreadnought', name:'Дредноут', f:'mil', ue:21, slots:32, hull:2100, m:1, spd:2,  icon:'🌑'  },
  { id:'shuttle',     name:'Шаттл',    f:'civ', ue:1,  slots:8,  hull:100,  m:9, spd:10, icon:'🛺'  },
  { id:'transport',   name:'Челнок',   f:'civ', ue:2,  slots:12, hull:200,  m:7, spd:8,  icon:'🚁'  },
  { id:'clipper',     name:'Клипер',   f:'civ', ue:4,  slots:16, hull:400,  m:5, spd:6,  icon:'⛵'  },
  { id:'barge',       name:'Баржа',    f:'civ', ue:8,  slots:20, hull:800,  m:3, spd:4,  icon:'🛳'  },
  { id:'liner',       name:'Лайнер',   f:'civ', ue:12, slots:26, hull:1200, m:2, spd:3,  icon:'🛸'  },
  { id:'tanker',      name:'Танкер',   f:'civ', ue:21, slots:32, hull:2100, m:1, spd:2,  icon:'🛢'  },
];

const SY_MODS = [
  { id:'engine',     name:'Двигатель',           sz:1, energy:-2,  speedBonus:2  },
  { id:'hyperdrive', name:'Гиперсветовой модуль', sz:2, energy:-3,  driveLevel:1 },
  { id:'atomic',     name:'Атомный реактор',      sz:3, energy:+10, capacity:30, driveBonus:1 },
  { id:'reactor',    name:'Реактор',              sz:2, energy:+6,  capacity:20  },
  { id:'shield',     name:'Щит',                 sz:1, energy:-2,  shield:50    },
  { id:'armor',      name:'Броня',               sz:1, armorVal:30              },
  { id:'weapon',     name:'Место под орудия',     sz:1, weaponSlot:1             },
  { id:'cargo',      name:'Грузовой отсек',       sz:1, cargo:10                 },
  { id:'colonial',   name:'Колониальный модуль',  sz:2, energy:-1,  colonists:5 },
  { id:'marines',    name:'Десантный модуль',     sz:2, energy:-1,  marines:20  },
  { id:'sensors',    name:'Сенсорный массив',     sz:1, energy:-1,  range:5     },
];

// ─── СОСТОЯНИЕ ───────────────────────────────────────────────────────────────
// project: { id, name, fleetId, composition: { classId → { count, modules:[modId,...] } } }
// buildEntry: { projectId, ships:[{ classId, status:'pending'|'building'|'done'|'cancelled', ticksLeft }] }

let _planet       = null;
let _projects     = {};      // id → project
let _activeId     = null;    // активный проект (редактируется)
let _queuedIds    = [];      // очередь projectId к постройке
let _buildState   = null;    // { projectId, ships:[], startedAt }
let _fleets       = { 'none': '— Новый флот —', 'fleet1': 'Флот 1', 'fleet2': 'Флот 2' };
let _view         = 'list';  // 'list' | 'detail'
let _detailCid    = null;    // classId открытого детального вида
let _uidCounter   = 0;

function _newId()  { return 'prj' + (++_uidCounter); }
function _newName(){ return 'Проект ' + _uidCounter; }

function _newProject() {
  const id   = _newId();
  const comp = {};
  SY_CLASSES.forEach(c => { comp[c.id] = { count: 0, modules: [] }; });
  return { id, name: _newName(), fleetId: 'none', composition: comp };
}

function _getComp(cid) {
  const p = _projects[_activeId];
  return p ? (p.composition[cid] || { count: 0, modules: [] }) : { count: 0, modules: [] };
}

// ─── РАСЧЁТ ХАРАКТЕРИСТИК ─────────────────────────────────────────────────────
function calcStats(cid, modules) {
  const base = SY_CLASSES.find(c => c.id === cid);
  if (!base) return {};

  let energy = 0, capacity = 0, shield = 0, armor = 0;
  let weaponSlots = 0, driveLevel = 0, driveBonus = 0;
  let speedBonus = 0, rangeBonus = 0, slotsUsed = 0;

  modules.forEach(mid => {
    const m = SY_MODS.find(x => x.id === mid);
    if (!m) return;
    slotsUsed   += m.sz;
    if (m.energy)     energy      += m.energy;
    if (m.capacity)   capacity    += m.capacity;
    if (m.shield)     shield      += m.shield;
    if (m.armorVal)   armor       += m.armorVal;
    if (m.weaponSlot) weaponSlots += m.weaponSlot;
    if (m.driveLevel) driveLevel  += m.driveLevel;
    if (m.driveBonus) driveBonus  += m.driveBonus;
    if (m.speedBonus) speedBonus  += m.speedBonus;
    if (m.range)      rangeBonus  += m.range;
  });

  let driveType = 'Досветовой';
  if (driveLevel > 0 && driveBonus >= 2) driveType = 'Термоядерный ×2.5';
  else if (driveLevel > 0 && driveBonus >= 1) driveType = 'Ядерный ×1.5';
  else if (driveLevel > 0) driveType = 'Гиперсветовой ×1.0';

  const speed       = base.spd + speedBonus;
  const chargeTime  = (capacity > 0 && energy > 0) ? Math.ceil(capacity / Math.max(energy, 1)) + ' тик' : '—';
  const weaponPower = weaponSlots * 80;
  const weaponEnergy= weaponSlots * 10;
  const range       = rangeBonus > 0 ? rangeBonus + ' пк'
                    : driveLevel > 0 ? 'не ограничено' : 'внутри системы';

  const armorFour = armor > 0
    ? Math.ceil(armor * 0.35) + '/' + Math.ceil(armor * 0.25) + '/' +
      Math.ceil(armor * 0.2)  + '/' + Math.ceil(armor * 0.2)
    : '0/0/0/0';

  return {
    hull: base.hull, speed, driveType,
    energy, capacity, shield,
    weaponSlots, weaponPower, weaponEnergy,
    chargeTime, armorFour,
    range, slotsUsed, totalSlots: base.slots,
  };
}

function buildEstimate(projectId) {
  const p = _projects[projectId];
  if (!p) return 0;
  let ticks = 0;
  Object.entries(p.composition).forEach(([cid, comp]) => {
    const cls = SY_CLASSES.find(c => c.id === cid);
    if (!cls || comp.count === 0) return;
    const mCount = comp.modules.length || Math.floor(cls.slots / 2);
    ticks += Math.ceil(cls.ue * mCount * 0.5) * comp.count;
  });
  return ticks;
}

function totalShips(projectId) {
  const p = _projects[projectId];
  if (!p) return 0;
  return Object.values(p.composition).reduce((s, c) => s + c.count, 0);
}

// ─── СТИЛИ ───────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('sy-styles')) return;
  const s = document.createElement('style');
  s.id = 'sy-styles';
  s.textContent = `
#sy-view {
  position:absolute; inset:0; background:#020a14; overflow-y:auto;
  display:flex; flex-direction:column; z-index:10;
  font-family:'Courier New',monospace; color:#c8d8f0;
}
/* ── header bar ── */
#sy-topbar {
  display:flex; align-items:center; gap:8px;
  padding:8px 14px; border-bottom:1px solid #1a3a6a;
  background:#030d1c; flex-shrink:0; flex-wrap:wrap;
}
#sy-back-btn {
  background:none; border:1px solid #1a3a6a; color:#4a8aaa;
  padding:4px 10px; cursor:pointer; font:inherit; font-size:11px;
  letter-spacing:1px; border-radius:2px;
}
#sy-back-btn:hover { border-color:#00e5ff; color:#00e5ff; }
#sy-title { color:#00e5ff; font-size:12px; letter-spacing:4px; margin-right:8px; }

/* ── fleet / project row ── */
#sy-meta {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding:7px 14px; border-bottom:1px solid #112236;
  background:#030f1a; flex-shrink:0;
}
.sy-label { font-size:8px; letter-spacing:2px; color:#2a5a8a; text-transform:uppercase; }
.sy-select, .sy-input {
  background:#04111e; border:1px solid #1a3a6a; color:#a8c8e8;
  padding:3px 7px; font:inherit; font-size:11px; border-radius:2px; cursor:pointer;
}
.sy-select:focus, .sy-input:focus { outline:none; border-color:#00e5ff; }
.sy-btn {
  background:none; border:1px solid #1a3a6a; color:#6aaccc;
  padding:3px 9px; cursor:pointer; font:inherit; font-size:10px;
  letter-spacing:1px; border-radius:2px; white-space:nowrap;
}
.sy-btn:hover { border-color:#00e5ff; color:#00e5ff; }
.sy-btn.accent { border-color:#00aa66; color:#00cc88; }
.sy-btn.accent:hover { border-color:#00cc88; background:#00331a; }
.sy-btn.danger { border-color:#8a2a1a; color:#cc6644; }
.sy-btn.danger:hover { border-color:#cc4422; background:#2a0808; }
.sy-sep { width:1px; height:18px; background:#1a3a6a; flex-shrink:0; }

/* ── section header ── */
.sy-section-hdr {
  font-size:8px; letter-spacing:3px; color:#2a5a8a; text-transform:uppercase;
  padding:7px 14px 4px; border-bottom:1px solid #0e2030;
}
.sy-faction-hdr {
  font-size:7px; letter-spacing:3px; padding:5px 14px 2px;
  text-transform:uppercase; border-bottom:1px solid #0a1a28;
}
.sy-faction-hdr.mil { color:#1a5a8a; }
.sy-faction-hdr.civ { color:#1a6a3a; }

/* ── ship grid ── */
#sy-grid {
  display:grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap:5px; padding:8px 10px;
}
.sy-ship-card {
  border:1px solid #162e54; border-radius:3px; background:#030f1c;
  cursor:pointer; padding:8px; display:flex; flex-direction:column; gap:5px;
  transition:border-color .15s, background .15s;
  position:relative;
}
.sy-ship-card.civ { border-color:#163028; background:#030e0a; }
.sy-ship-card:hover { border-color:#1e5090; background:#04152a; }
.sy-ship-card.civ:hover { border-color:#1a6a3a; background:#040f0a; }
.sy-ship-card.selected { border-color:#00e5ff; background:#041828; }
.sy-ship-card.civ.selected { border-color:#00cc88; background:#04180c; }

.sy-ship-icon { font-size:28px; text-align:center; line-height:1.1; }
.sy-ship-name {
  font-size:10px; letter-spacing:2px; text-align:center; text-transform:uppercase;
}
.sy-ship-card.mil .sy-ship-name { color:#daeeff; }
.sy-ship-card.civ .sy-ship-name { color:#caeedd; }
.sy-ship-ue { font-size:7px; color:#2a4a6a; text-align:center; letter-spacing:1px; }
.sy-ship-card.civ .sy-ship-ue { color:#2a4a3a; }

/* count control */
.sy-count-row {
  display:flex; align-items:center; justify-content:center; gap:6px;
}
.sy-cnt-btn {
  width:20px; height:20px; border:1px solid #1a3a6a; background:none;
  color:#6aaccc; font:inherit; font-size:14px; cursor:pointer; border-radius:2px;
  display:flex; align-items:center; justify-content:center; line-height:1;
}
.sy-cnt-btn:hover { border-color:#00e5ff; color:#00e5ff; }
.sy-cnt-val {
  width:28px; text-align:center; font-size:13px; color:#c8d8f0;
  border:1px solid #1a3a6a; background:#04111e; border-radius:2px;
  padding:1px 0;
}
.sy-ship-card.civ .sy-cnt-btn { border-color:#1a3a28; color:#55aa88; }
.sy-ship-card.civ .sy-cnt-btn:hover { border-color:#00cc88; color:#00cc88; }
.sy-ship-card.civ .sy-cnt-val { border-color:#1a3a28; }

/* mini stats */
.sy-mini-stats {
  font-size:7.5px; color:#2a5070; line-height:1.7;
  border-top:1px solid #0e2030; padding-top:4px;
}
.sy-ship-card.civ .sy-mini-stats { border-color:#0e2820; }
.sy-mini-stats .sv { color:#7ecfff; }
.sy-ship-card.civ .sy-mini-stats .sv { color:#55e8b0; }
.sy-configure-hint {
  font-size:7px; letter-spacing:1px; text-align:center; color:#1a3a5a;
  cursor:pointer;
}
.sy-ship-card.civ .sy-configure-hint { color:#1a3a28; }
.sy-ship-card:hover .sy-configure-hint { color:#2a6090; }
.sy-ship-card.civ:hover .sy-configure-hint { color:#2a6040; }

/* ── build queue ── */
#sy-queue {
  border-top:1px solid #1a3a6a; background:#030d1c;
  flex-shrink:0; padding:10px 14px 12px;
}
.sy-queue-hdr {
  font-size:8px; letter-spacing:3px; color:#2a5a8a;
  text-transform:uppercase; margin-bottom:8px;
}
#sy-queue-list {
  display:flex; flex-direction:column; gap:3px; margin-bottom:8px;
  max-height:120px; overflow-y:auto;
}
.sy-q-ship {
  display:flex; align-items:center; gap:8px;
  font-size:10px; padding:3px 6px; border-radius:2px;
  border:1px solid #0e2030;
}
.sy-q-ship.building { background:#04152a; border-color:#1a4a8a; }
.sy-q-ship.done     { background:#041808; border-color:#1a4a2a; color:#55aa77; }
.sy-q-ship.cancelled{ text-decoration:line-through; color:#3a4a5a; }
.sy-q-status { font-size:8px; letter-spacing:1px; min-width:55px; }
.sy-q-status.b { color:#00e5ff; }
.sy-q-status.d { color:#00cc88; }
.sy-q-status.p { color:#4a6a8a; }
.sy-q-status.c { color:#4a3a3a; }
.sy-q-name   { flex:1; }
.sy-q-ticks  { color:#2a5a8a; font-size:9px; }

#sy-queue-footer {
  display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px;
}
.sy-time-est { font-size:9px; color:#2a5a8a; }
.sy-time-est span { color:#7ecfff; }
.sy-queue-btns { display:flex; gap:6px; }

/* ── detail panel (overlay) ── */
#sy-detail {
  position:absolute; inset:0; background:#020a14; z-index:20;
  display:flex; flex-direction:column; overflow-y:auto;
}
#sy-detail-header {
  display:flex; align-items:center; gap:10px;
  padding:8px 14px; border-bottom:1px solid #1a3a6a; flex-shrink:0;
  background:#030d1c;
}
#sy-detail-back {
  background:none; border:1px solid #1a3a6a; color:#4a8aaa;
  padding:4px 10px; cursor:pointer; font:inherit; font-size:11px; border-radius:2px;
}
#sy-detail-back:hover { border-color:#00e5ff; color:#00e5ff; }
#sy-detail-name { font-size:14px; letter-spacing:3px; text-transform:uppercase; }
.sy-detail-body {
  display:grid; grid-template-columns:1fr 1fr; gap:16px;
  padding:14px; flex:1;
}
@media(max-width:600px) { .sy-detail-body { grid-template-columns:1fr; } }

.sy-stat-block { display:flex; flex-direction:column; gap:0; }
.sy-stat-group { margin-bottom:10px; }
.sy-stat-group-name {
  font-size:7.5px; letter-spacing:2.5px; text-transform:uppercase;
  color:#1a5a8a; margin-bottom:4px; border-bottom:1px solid #0e2030; padding-bottom:2px;
}
.sy-stat-row {
  display:flex; justify-content:space-between; align-items:baseline;
  padding:2px 0; font-size:10px; border-bottom:1px solid #0a1828;
}
.sy-stat-label { color:#2a5070; letter-spacing:0.5px; }
.sy-stat-val   { color:#a8d8f0; font-size:11px; }
.sy-stat-row.warn .sy-stat-val { color:#cc8844; }

/* module slots */
.sy-mod-block { display:flex; flex-direction:column; gap:8px; }
.sy-mod-title {
  font-size:7.5px; letter-spacing:2.5px; text-transform:uppercase;
  color:#1a5a8a; border-bottom:1px solid #0e2030; padding-bottom:2px;
}
#sy-slots-grid {
  display:grid; grid-template-columns:repeat(4, 1fr); gap:4px;
}
.sy-slot {
  border:1px solid #1a3a6a; border-radius:2px; background:#04111e;
  padding:3px 4px; cursor:pointer; min-height:36px;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:1px; transition:border-color .12s;
}
.sy-slot:hover { border-color:#00e5ff; background:#041828; }
.sy-slot.filled { border-color:#1e5090; }
.sy-slot.filled:hover { border-color:#00e5ff; }
.sy-slot.sz2 { grid-column: span 2; }
.sy-slot.sz3 { grid-column: span 3; }
.sy-slot-name { font-size:7px; letter-spacing:0.5px; color:#4a7aaa; text-align:center; }
.sy-slot-sz   { font-size:7px; color:#1a3a5a; }
.sy-slot-empty-icon { font-size:16px; color:#1a2a3a; }
.sy-slot-add { font-size:10px; color:#1a4a6a; }
.sy-mod-legend { display:flex; flex-wrap:wrap; gap:4px; }
.sy-mod-tag {
  border:1px solid #1a3a6a; border-radius:2px; background:#040f1c;
  padding:2px 6px; font-size:8px; color:#4a7aaa; cursor:pointer;
  white-space:nowrap;
}
.sy-mod-tag:hover { border-color:#00e5ff; color:#00e5ff; }
.sy-mod-tag .sz { color:#1a4a6a; margin-left:3px; }
.sy-slots-info { font-size:8px; color:#2a4a6a; }

/* ── queued projects strip ── */
#sy-project-queue {
  display:flex; gap:6px; flex-wrap:wrap; padding:6px 14px;
  border-top:1px solid #0e2030; background:#030b18; flex-shrink:0;
}
.sy-prj-chip {
  border:1px solid #1a2a4a; border-radius:2px; background:#04111e;
  padding:3px 8px; font-size:8px; color:#3a6a9a; cursor:pointer;
  letter-spacing:1px;
}
.sy-prj-chip.active  { border-color:#00e5ff; color:#00e5ff; background:#041828; }
.sy-prj-chip.queued  { border-color:#1a3a6a; color:#2a5a8a; }
.sy-prj-chip:hover   { border-color:#2a7acc; color:#6aaccc; }
.sy-prj-add {
  border:1px dashed #1a2a4a; border-radius:2px;
  padding:3px 8px; font-size:10px; color:#1a3a5a; cursor:pointer; background:none;
  font-family:inherit;
}
.sy-prj-add:hover { border-color:#2a6acc; color:#4a8acc; }

/* scrollbar styling */
#sy-view::-webkit-scrollbar,
#sy-queue-list::-webkit-scrollbar { width:4px; }
#sy-view::-webkit-scrollbar-track,
#sy-queue-list::-webkit-scrollbar-track { background:#020a14; }
#sy-view::-webkit-scrollbar-thumb,
#sy-queue-list::-webkit-scrollbar-thumb { background:#1a3a6a; border-radius:2px; }
  `;
  document.head.appendChild(s);
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
function injectDOM() {
  const existing = document.getElementById('sy-view');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'sy-view';
  div.innerHTML = `
    <div id="sy-topbar">
      <button id="sy-back-btn">← НАЗАД</button>
      <span class="sy-title" id="sy-planet-name"></span>
      <span style="flex:1"></span>
      <span id="sy-total-badge" style="font-size:9px;color:#2a5a8a;letter-spacing:1px;"></span>
    </div>

    <div id="sy-meta">
      <span class="sy-label">ФЛОТ</span>
      <select class="sy-select" id="sy-fleet-sel"></select>
      <button class="sy-btn" id="sy-fleet-new">+ Новый флот</button>
      <div class="sy-sep"></div>
      <span class="sy-label">ПРОЕКТ</span>
      <input class="sy-input" id="sy-proj-name" style="width:120px" />
      <button class="sy-btn" id="sy-proj-save">Сохранить</button>
      <button class="sy-btn" id="sy-proj-revert">Сбросить</button>
    </div>

    <div id="sy-project-queue"></div>

    <div class="sy-section-hdr">КОРАБЛИ К ПОСТРОЙКЕ</div>
    <div class="sy-faction-hdr mil">⚔ БОЕВЫЕ</div>
    <div id="sy-grid-mil" class="sy-grid-row" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:5px;padding:6px 10px;"></div>
    <div class="sy-faction-hdr civ">◈ ГРАЖДАНСКИЕ</div>
    <div id="sy-grid-civ" class="sy-grid-row" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:5px;padding:6px 10px 10px;"></div>

    <div id="sy-queue">
      <div class="sy-queue-hdr">ОЧЕРЕДЬ СТРОИТЕЛЬСТВА</div>
      <div id="sy-queue-list"></div>
      <div id="sy-queue-footer">
        <div class="sy-time-est" id="sy-est"></div>
        <div class="sy-queue-btns">
          <button class="sy-btn accent" id="sy-btn-build">▶ Начать строительство</button>
          <button class="sy-btn danger"  id="sy-btn-cancel">✕ Прервать</button>
          <button class="sy-btn danger"  id="sy-btn-finish">⚑ Завершить досрочно</button>
        </div>
      </div>
    </div>

    <div id="sy-detail" style="display:none;">
      <div id="sy-detail-header">
        <button id="sy-detail-back">← К списку</button>
        <span id="sy-detail-name"></span>
        <span style="flex:1"></span>
        <span id="sy-detail-slots" style="font-size:9px;color:#2a5a8a;letter-spacing:1px;"></span>
      </div>
      <div class="sy-detail-body">
        <div class="sy-stat-block" id="sy-stat-block"></div>
        <div class="sy-mod-block">
          <div class="sy-mod-title">МОДУЛИ</div>
          <div class="sy-slots-info" id="sy-slots-info"></div>
          <div id="sy-slots-grid"></div>
          <div class="sy-mod-title" style="margin-top:8px;">ДОСТУПНЫЕ МОДУЛИ</div>
          <div class="sy-mod-legend" id="sy-mod-legend"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(div);
}

// ─── РЕНДЕР ГЛАВНОГО ВИДА ────────────────────────────────────────────────────
function renderAll() {
  renderMeta();
  renderProjectChips();
  renderGrid();
  renderQueue();
}

function renderMeta() {
  const p = _projects[_activeId];

  // Fleet selector
  const sel = document.getElementById('sy-fleet-sel');
  if (sel) {
    sel.innerHTML = Object.entries(_fleets).map(([k, v]) =>
      `<option value="${k}" ${p && p.fleetId === k ? 'selected' : ''}>${v}</option>`
    ).join('');
  }

  // Project name input
  const inp = document.getElementById('sy-proj-name');
  if (inp && p) inp.value = p.name;

  // Planet name
  const nm = document.getElementById('sy-planet-name');
  if (nm) nm.textContent = _planet ? _planet.name || _planet.id || 'ПЛАНЕТА' : '';

  updateTotalBadge();
}

function updateTotalBadge() {
  const badge = document.getElementById('sy-total-badge');
  if (!badge) return;
  const n = totalShips(_activeId);
  badge.textContent = n > 0 ? `${n} кораблей · ~${buildEstimate(_activeId)} тиков` : '';
}

function renderProjectChips() {
  const strip = document.getElementById('sy-project-queue');
  if (!strip) return;
  strip.innerHTML = '';

  const allIds = Object.keys(_projects);
  allIds.forEach(pid => {
    const p   = _projects[pid];
    const isQ = _queuedIds.includes(pid);
    const btn = document.createElement('button');
    btn.className = 'sy-prj-chip' + (pid === _activeId ? ' active' : '') + (isQ ? ' queued' : '');
    btn.textContent = p.name + (isQ ? ' [в очереди]' : '');
    btn.onclick = () => { _activeId = pid; renderAll(); };
    strip.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'sy-prj-add';
  addBtn.textContent = '+ Проект';
  addBtn.onclick = () => {
    const prj = _newProject();
    _projects[prj.id] = prj;
    _activeId = prj.id;
    renderAll();
  };
  strip.appendChild(addBtn);
}

function renderGrid() {
  ['mil', 'civ'].forEach(faction => {
    const grid = document.getElementById('sy-grid-' + faction);
    if (!grid) return;
    grid.innerHTML = '';
    SY_CLASSES.filter(c => c.f === faction).forEach(cls => {
      grid.appendChild(buildShipCard(cls));
    });
  });
}

function buildShipCard(cls) {
  const comp  = _getComp(cls.id);
  const stats = calcStats(cls.id, comp.modules);
  const hasMods = comp.modules.length > 0;

  const card = document.createElement('div');
  card.className = `sy-ship-card ${cls.f}`;
  card.dataset.cid = cls.id;

  const driveIcon = stats.driveType === 'Досветовой' ? '🔸' : '🔷';

  card.innerHTML = `
    <div class="sy-ship-icon">${cls.icon}</div>
    <div class="sy-ship-name">${cls.name}</div>
    <div class="sy-ship-ue">${cls.ue} у.е. · ${cls.slots} слотов</div>
    <div class="sy-count-row">
      <button class="sy-cnt-btn" data-delta="-1" data-cid="${cls.id}">−</button>
      <div class="sy-cnt-val">${comp.count}</div>
      <button class="sy-cnt-btn" data-delta="1"  data-cid="${cls.id}">+</button>
    </div>
    <div class="sy-mini-stats">
      Прч <span class="sv">${stats.hull}</span> &nbsp;
      Скр <span class="sv">${stats.speed}</span> пк/тик<br>
      Щит <span class="sv">${hasMods ? stats.shield : 0}</span> &nbsp;
      Орд <span class="sv">${hasMods ? stats.weaponSlots : 0}</span> &nbsp;
      ${driveIcon}<span class="sv" style="font-size:7px">${stats.driveType.split(' ')[0]}</span>
    </div>
    <div class="sy-configure-hint">⚙ настроить</div>
  `;

  // Count buttons
  card.querySelectorAll('.sy-cnt-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const delta = +btn.dataset.delta;
      const p = _projects[_activeId];
      if (!p) return;
      if (!p.composition[cls.id]) p.composition[cls.id] = { count: 0, modules: [] };
      p.composition[cls.id].count = Math.max(0, p.composition[cls.id].count + delta);
      renderGrid();
      renderQueue();
      updateTotalBadge();
    });
  });

  // Card click → detail
  card.addEventListener('click', () => { openDetail(cls.id); });

  return card;
}

// ─── ОЧЕРЕДЬ СТРОИТЕЛЬСТВА ───────────────────────────────────────────────────
function renderQueue() {
  const list = document.getElementById('sy-queue-list');
  const est  = document.getElementById('sy-est');
  if (!list) return;
  list.innerHTML = '';

  const p = _projects[_activeId];
  if (!p) { if (est) est.textContent = ''; return; }

  // Build ship list for active project (sorted cheapest first)
  const ships = [];
  SY_CLASSES
    .slice()
    .sort((a, b) => a.ue - b.ue)
    .forEach(cls => {
      const comp = p.composition[cls.id];
      if (!comp || comp.count === 0) return;
      const mods  = comp.modules.length || Math.floor(cls.slots / 2);
      const ticks = Math.ceil(cls.ue * mods * 0.5);
      for (let i = 0; i < comp.count; i++) {
        ships.push({ cls, ticks });
      }
    });

  if (ships.length === 0) {
    list.innerHTML = '<div style="font-size:9px;color:#1a3a5a;padding:4px">— Нет кораблей в проекте —</div>';
    if (est) est.innerHTML = '';
    return;
  }

  // Determine statuses from _buildState
  let buildingIdx = -1;
  let statuses = ships.map(() => 'pending');
  if (_buildState && _buildState.projectId === _activeId) {
    _buildState.ships.forEach((s, i) => { statuses[i] = s.status; });
    buildingIdx = statuses.indexOf('building');
  }

  ships.forEach((ship, i) => {
    const st    = statuses[i] || 'pending';
    const label = { building:'СТРОИТСЯ', done:'ГОТОВ', pending:'В ОЧЕРЕДИ', cancelled:'ОТМЕНЁН' }[st];
    const cls2  = { building:'b', done:'d', pending:'p', cancelled:'c' }[st];
    const row   = document.createElement('div');
    row.className = 'sy-q-ship ' + (st === 'building' ? 'building' : st === 'done' ? 'done' : st === 'cancelled' ? 'cancelled' : '');
    row.innerHTML = `
      <span class="sy-q-status ${cls2}">${label}</span>
      <span class="sy-q-name">${ship.cls.icon} ${ship.cls.name}</span>
      <span class="sy-q-ticks">${st === 'building' ? ship.ticks + ' тик' : st === 'pending' ? ship.ticks + ' тик' : ''}</span>
      ${(st === 'pending') ? `<button class="sy-btn danger" style="font-size:7px;padding:1px 5px;" data-cancel="${i}">✕</button>` : ''}
    `;
    const cancelBtn = row.querySelector('[data-cancel]');
    if (cancelBtn) {
      cancelBtn.onclick = e => {
        e.stopPropagation();
        if (_buildState && _buildState.projectId === _activeId) {
          _buildState.ships[i].status = 'cancelled';
          renderQueue();
        }
      };
    }
    list.appendChild(row);
  });

  const totalTicks = buildEstimate(_activeId);
  if (est) {
    est.innerHTML = `Флот: <span>${totalShips(_activeId)}</span> кор. · Время: <span>~${totalTicks}</span> тиков`;
  }
}

// ─── ДЕТАЛЬНЫЙ ВИД + МОДУЛИ ──────────────────────────────────────────────────
function openDetail(cid) {
  _detailCid = cid;
  _view = 'detail';

  const detail = document.getElementById('sy-detail');
  if (!detail) return;
  detail.style.display = 'flex';
  detail.style.flexDirection = 'column';

  renderDetail();
}

function closeDetail() {
  _view = 'list';
  _detailCid = null;
  const detail = document.getElementById('sy-detail');
  if (detail) detail.style.display = 'none';
}

function renderDetail() {
  const cid  = _detailCid;
  const cls  = SY_CLASSES.find(c => c.id === cid);
  if (!cls) return;

  const comp   = _getComp(cid);
  const mods   = comp.modules;
  const stats  = calcStats(cid, mods);

  // Header
  const nameEl = document.getElementById('sy-detail-name');
  if (nameEl) nameEl.textContent = cls.icon + '  ' + cls.name.toUpperCase();
  const slEl = document.getElementById('sy-detail-slots');
  if (slEl) slEl.textContent = `${stats.slotsUsed} / ${stats.totalSlots} слотов`;

  // Stats block
  const sb = document.getElementById('sy-stat-block');
  if (sb) {
    sb.innerHTML = `
      <div class="sy-stat-group">
        <div class="sy-stat-group-name">◼ КОРПУС</div>
        <div class="sy-stat-row"><span class="sy-stat-label">Прочность</span><span class="sy-stat-val">${stats.hull}</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Броня Н/К/Л/П</span><span class="sy-stat-val">${stats.armorFour}</span></div>
      </div>
      <div class="sy-stat-group">
        <div class="sy-stat-group-name">◼ ДВИЖЕНИЕ</div>
        <div class="sy-stat-row"><span class="sy-stat-label">Скорость</span><span class="sy-stat-val">${stats.speed} пк/тик</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Тип привода</span><span class="sy-stat-val">${stats.driveType}</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Дальность</span><span class="sy-stat-val">${stats.range}</span></div>
      </div>
      <div class="sy-stat-group">
        <div class="sy-stat-group-name">◼ ЭНЕРГИЯ</div>
        <div class="sy-stat-row ${stats.energy < 0 ? 'warn' : ''}"><span class="sy-stat-label">Свободная выработка</span><span class="sy-stat-val">${stats.energy > 0 ? '+' : ''}${stats.energy} ед/тик</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Ёмкость</span><span class="sy-stat-val">${stats.capacity} ед</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Время зарядки</span><span class="sy-stat-val">${stats.chargeTime}</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Потребл. залпа</span><span class="sy-stat-val">${stats.weaponEnergy} ед</span></div>
      </div>
      <div class="sy-stat-group">
        <div class="sy-stat-group-name">◼ БОЙ</div>
        <div class="sy-stat-row"><span class="sy-stat-label">Мощность щита</span><span class="sy-stat-val">${stats.shield} ед</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Орудийных мест</span><span class="sy-stat-val">${stats.weaponSlots}</span></div>
        <div class="sy-stat-row"><span class="sy-stat-label">Мощность залпа</span><span class="sy-stat-val">${stats.weaponPower} ед</span></div>
      </div>
    `;
  }

  // Slots
  const slotsGrid = document.getElementById('sy-slots-grid');
  const slotsInfo = document.getElementById('sy-slots-info');
  if (slotsInfo) slotsInfo.textContent = `Занято: ${stats.slotsUsed} из ${stats.totalSlots} слотов`;

  if (slotsGrid) {
    slotsGrid.innerHTML = '';
    let slotIdx = 0;
    mods.forEach((mid, i) => {
      const m   = SY_MODS.find(x => x.id === mid);
      const s   = document.createElement('div');
      s.className = `sy-slot filled sz${m ? m.sz : 1}`;
      s.innerHTML = `<div class="sy-slot-name">${m ? m.name : mid}</div><div class="sy-slot-sz">${m ? m.sz + ' сл' : ''}</div>`;
      s.onclick = () => removeModule(i);
      slotsGrid.appendChild(s);
      slotIdx += m ? m.sz : 1;
    });
    // Empty slots
    const remaining = stats.totalSlots - stats.slotsUsed;
    for (let i = 0; i < remaining; i++) {
      const s = document.createElement('div');
      s.className = 'sy-slot';
      s.innerHTML = '<div class="sy-slot-empty-icon">·</div><div class="sy-slot-add">добавить</div>';
      s.onclick = () => showModPicker();
      slotsGrid.appendChild(s);
    }
  }

  // Module legend
  const legend = document.getElementById('sy-mod-legend');
  if (legend) {
    legend.innerHTML = '';
    SY_MODS.forEach(m => {
      const tag = document.createElement('div');
      tag.className = 'sy-mod-tag';
      tag.innerHTML = `${m.name}<span class="sz">${m.sz}</span>`;
      tag.onclick = () => addModule(m.id);
      legend.appendChild(tag);
    });
  }
}

function addModule(mid) {
  const p = _projects[_activeId];
  if (!p) return;
  if (!p.composition[_detailCid]) p.composition[_detailCid] = { count: 0, modules: [] };
  const comp  = p.composition[_detailCid];
  const m     = SY_MODS.find(x => x.id === mid);
  const stats = calcStats(_detailCid, comp.modules);
  if (stats.slotsUsed + (m ? m.sz : 1) > stats.totalSlots) {
    showToast('Нет свободных слотов');
    return;
  }
  comp.modules.push(mid);
  renderDetail();
}

function removeModule(idx) {
  const p = _projects[_activeId];
  if (!p || !p.composition[_detailCid]) return;
  p.composition[_detailCid].modules.splice(idx, 1);
  renderDetail();
}

function showModPicker() {
  // Simple: clicking any module tag in legend adds it
  // (legend already wired up)
  document.getElementById('sy-mod-legend')?.scrollIntoView({ behavior: 'smooth' });
}

// ─── СОБЫТИЯ ─────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('sy-back-btn')?.addEventListener('click', close);
  document.getElementById('sy-detail-back')?.addEventListener('click', () => { closeDetail(); renderGrid(); });

  document.getElementById('sy-fleet-sel')?.addEventListener('change', e => {
    const p = _projects[_activeId];
    if (p) { p.fleetId = e.target.value; }
  });

  document.getElementById('sy-fleet-new')?.addEventListener('click', () => {
    const name = prompt('Название нового флота:');
    if (!name) return;
    const id = 'fleet' + Date.now();
    _fleets[id] = name;
    const p = _projects[_activeId];
    if (p) p.fleetId = id;
    renderMeta();
  });

  document.getElementById('sy-proj-name')?.addEventListener('change', e => {
    const p = _projects[_activeId];
    if (p) { p.name = e.target.value; renderProjectChips(); }
  });

  document.getElementById('sy-proj-save')?.addEventListener('click', () => {
    const p = _projects[_activeId];
    if (!p) return;
    // Deep-copy composition as a "saved" snapshot
    p._saved = JSON.parse(JSON.stringify(p.composition));
    showToast('Проект сохранён');
  });

  document.getElementById('sy-proj-revert')?.addEventListener('click', () => {
    const p = _projects[_activeId];
    if (!p || !p._saved) { showToast('Нет сохранённого состояния'); return; }
    p.composition = JSON.parse(JSON.stringify(p._saved));
    renderAll();
    showToast('Проект сброшен');
  });

  document.getElementById('sy-btn-build')?.addEventListener('click', () => {
    const p = _projects[_activeId];
    if (!p) return;
    if (totalShips(_activeId) === 0) { showToast('Добавьте корабли в проект'); return; }
    if (_queuedIds.includes(_activeId)) { showToast('Проект уже в очереди'); return; }
    _queuedIds.push(_activeId);
    // Init build state for first in queue if not building
    if (!_buildState) {
      startBuild(_queuedIds[0]);
    }
    renderProjectChips();
    renderQueue();
    showToast('Проект добавлен в очередь строительства');
  });

  document.getElementById('sy-btn-cancel')?.addEventListener('click', () => {
    if (!_buildState || _buildState.projectId !== _activeId) {
      showToast('Этот проект не строится');
      return;
    }
    // Cancel only pending ships
    _buildState.ships.forEach(s => { if (s.status === 'pending') s.status = 'cancelled'; });
    renderQueue();
    showToast('Непостроенные корабли отменены');
  });

  document.getElementById('sy-btn-finish')?.addEventListener('click', () => {
    if (!_buildState || _buildState.projectId !== _activeId) {
      showToast('Этот проект не строится');
      return;
    }
    _buildState.ships.forEach(s => { if (s.status !== 'cancelled') s.status = 'done'; });
    renderQueue();
    showToast('Строительство завершено досрочно');
  });
}

function startBuild(projectId) {
  const p = _projects[projectId];
  if (!p) return;
  const ships = [];
  SY_CLASSES
    .slice().sort((a, b) => a.ue - b.ue)
    .forEach(cls => {
      const comp = p.composition[cls.id];
      if (!comp || comp.count === 0) return;
      const mods  = comp.modules.length || Math.floor(cls.slots / 2);
      const ticks = Math.ceil(cls.ue * mods * 0.5);
      for (let i = 0; i < comp.count; i++) {
        ships.push({ classId: cls.id, status: i === 0 ? 'building' : 'pending', ticksLeft: ticks });
      }
    });
  _buildState = { projectId, ships };
}

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
    background:'#04152a', border:'1px solid #1a5a8a', color:'#7ecfff',
    padding:'6px 16px', fontSize:'11px', letterSpacing:'1px',
    borderRadius:'3px', zIndex:'9999', pointerEvents:'none',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────
export function open(planet, context) {
  _planet = planet;

  // Скрываем блоки planet-ui
  document.querySelectorAll('#planet-ui > *:not(#sy-view)').forEach(el => {
    el.dataset.syHidden = el.style.display || '';
    el.style.display = 'none';
  });

  injectStyles();
  injectDOM();

  // Создаём дефолтный проект если нет
  if (Object.keys(_projects).length === 0) {
    const prj = _newProject();
    _projects[prj.id] = prj;
    _activeId = prj.id;
  }

  renderAll();
  bindEvents();
}

export function close() {
  const view = document.getElementById('sy-view');
  if (view) view.remove();

  // Восстанавливаем блоки planet-ui
  document.querySelectorAll('#planet-ui > *').forEach(el => {
    if (el.dataset.syHidden !== undefined) {
      el.style.display = el.dataset.syHidden;
      delete el.dataset.syHidden;
    }
  });
}
