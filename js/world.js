// Общее состояние мира для всех экранов: какая галактика (seed) и у какой звезды корабль.
// Галактика не хранится — пересоздаётся из seed (детерминированно). В localStorage лежат
// только seed и id текущей звезды; адрес (?g=, ?star=) имеет приоритет.
const World = (() => {
  const KEY = 'ouro.v3';
  const qs = new URLSearchParams(location.search);
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* приватный режим */ } };

  let state = load();
  const seed = (parseInt(qs.get('g') || state.g || '1', 10) >>> 0) || 1;
  if (state.g !== seed) state = { g: seed }; // другая галактика — прежнее положение корабля не годится

  let gal = null;
  const galaxy = () => gal || (gal = generateGalaxy(seed));

  // Стартовая звезда: первая жёлтая в зоне 2–3 — спокойное место для начала.
  function startStarId() {
    const s = galaxy().stars.find(st => st.type.key === 'yellow' && (st.zone === 2 || st.zone === 3));
    return s ? s.id : 0;
  }

  function currentStarId() {
    const n = galaxy().stars.length;
    const fromUrl = parseInt(qs.get('star'), 10);
    if (fromUrl >= 0 && fromUrl < n) { setCurrent(fromUrl); return fromUrl; }
    if (state.star >= 0 && state.star < n) return state.star;
    setCurrent(startStarId());
    return state.star;
  }
  function setCurrent(id) { if (state.star !== id) state.ship = null; state.star = id; save(); }
  // Где корабль внутри системы текущей звезды: номер планеты и сел ли он на неё.
  function setShip(planet, landed) { state.ship = planet == null ? null : { planet, landed: !!landed }; save(); }
  // Корабль игрока — имя дизайна из конструктора (ships.js); топливо — доля полного бака (0…1).
  // Новый мир или другой корабль — полный бак.
  const design = () => state.design || null;
  function setDesign(name) { state.design = name; state.fuel = 1; save(); }
  const fuel = () => (typeof state.fuel === 'number' ? state.fuel : 1);
  // Межзвёздный скачок: откуда шёл корабль (единичный вектор по карте галактики) — система
  // назначения ставит его на подлёте с этой стороны. Читается один раз.
  function setArrival(a) { state.arrival = a; save(); }
  function takeArrival() { const a = state.arrival || null; delete state.arrival; save(); return a; }
  function setFuel(f) { state.fuel = Math.max(0, Math.min(1, Math.round(f * 1e6) / 1e6)); save(); }

  return {
    seed, galaxy, setCurrent, setShip, design, setDesign, fuel, setFuel, setArrival, takeArrival,
    ship: () => state.ship || null,
    currentStarId,
    currentStar: () => galaxy().stars[currentStarId()],
    galaxyUrl: () => `index.html?g=${seed}`,
    systemUrl: id => `system.html?g=${seed}&star=${id}`,
    planetUrl: (id, p) => `planet.html?g=${seed}&star=${id}&p=${p}`,
  };
})();
