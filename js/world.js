// Общее состояние мира для всех экранов: какая галактика (seed), ФЛОТ игрока и КОЛОНИИ.
// Галактика не хранится — пересоздаётся из seed (детерминированно). В localStorage лежат seed,
// текущая звезда, корабли и колонии; адрес (?g=, ?star=) имеет приоритет.
//
// Корабль игрока — это АКТИВНЫЙ корабль флота. Старые обращения (World.design/fuel/ship) читают
// и пишут именно его, поэтому экраны галактики и системы о флоте знать не обязаны.
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

  // Стартовая звезда — жёлтая на ОКРАИНЕ галактики (решение пользователя: «первоначальный
  // корабль нужно размещать на внешних звёздах вселенной на окраине, а не ближе к центру»).
  // Зона 1 — самый край (data.js GALAXY_ZONES), внутри неё берём самую дальнюю от центра: так
  // игрок начинает в бедном спокойном углу и растёт к центру, а не наоборот.
  //
  // И ОБЯЗАТЕЛЬНО С ЖИЗНЬЮ: на стартовой планете должна расти биомасса. Без неё пища только
  // искусственная, а она стоит 2000 энергии за единицу (ТЗ §8.7) — это 200 водорода, тогда как
  // лучший водородный гекс даёт 650 за такт на всю колонию. Прогон tools/colony.js показал, что
  // на безжизненной планете десять колонистов съедают вчетверо больше энергии, чем колония
  // способна добыть: население вымирает к десятым суткам, что бы игрок ни делал. Поэтому из
  // дальних жёлтых звёзд окраины берётся первая, у которой есть обитаемая планета с жизнью.
  function startStarId() {
    const far = galaxy().stars
      .filter(st => st.type.key === 'yellow' && st.zone === 1)
      .sort((x, y) => (y.x * y.x + y.y * y.y) - (x.x * x.x + x.y * x.y));
    for (const st of far.slice(0, 400)) {
      const sys = generateSystem(st);
      const ok = sys.planets.some(p => p.habitable && PLANET_TYPES[p.type].landable && p.life !== 'none');
      if (ok) return st.id;
    }
    if (far[0]) return far[0].id;
    const any = galaxy().stars.find(st => st.type.key === 'yellow');
    return any ? any.id : 0;
  }

  // ---------- ФЛОТ ----------
  // Корабль: {id, design, star, planet, landed, fuel, cargo, food, pax, mine, seen}
  //   cargo — сырьё в трюме {ключ ресурса: единицы}; food — пища в жизнеобеспечении;
  //   pax    — пассажиры (колонисты, армия) сверх экипажа: каждый ест пищу как колонист;
  //   mine   — гекс, который корабль добывает: {q, r, since} (мс);
  //   seen   — какие оповещения игрок уже видел.
  function initFleet() {
    if (!(state.star >= 0)) state.star = startStarId();
    state.fleet = [{
      id: 1, design: state.design || (typeof START_DESIGN === 'string' ? START_DESIGN : null),
      star: state.star, planet: state.ship ? state.ship.planet : null,
      landed: state.ship ? !!state.ship.landed : false,
      fuel: typeof state.fuel === 'number' ? state.fuel : 1,
      cargo: {}, food: null, pax: 0, mine: null, seen: {},
    }];
    state.active = 1;
    save();
  }
  function fleet() {
    if (!Array.isArray(state.fleet) || !state.fleet.length) initFleet();
    return state.fleet;
  }
  function active() {
    const f = fleet();
    return f.find(s => s.id === state.active) || f[0];
  }
  function addShip(design, star, planet) {
    const f = fleet();
    const id = f.reduce((a, s) => Math.max(a, s.id), 0) + 1;
    const s = { id, design, star, planet, landed: true, fuel: 1, cargo: {}, food: null, pax: 0, mine: null, seen: {} };
    f.push(s); save();
    return s;
  }
  // Переключение корабля: активный корабль — он же «корабль игрока», значит текущая звезда и
  // положение в системе берутся от него.
  function setActive(id) {
    const s = fleet().find(x => x.id === id); if (!s) return null;
    state.active = id; state.star = s.star;
    state.ship = s.planet == null ? null : { planet: s.planet, landed: !!s.landed };
    save();
    return s;
  }

  function currentStarId() {
    const n = galaxy().stars.length;
    const fromUrl = parseInt(qs.get('star'), 10);
    if (fromUrl >= 0 && fromUrl < n) { setCurrent(fromUrl); return fromUrl; }
    if (state.star >= 0 && state.star < n) return state.star;
    setCurrent(startStarId());
    return state.star;
  }
  function setCurrent(id) {
    if (state.star !== id) { state.ship = null; const a = active(); a.planet = null; a.landed = false; a.mine = null; }
    state.star = id; active().star = id; save();
  }
  // Где корабль внутри системы текущей звезды: номер планеты и сел ли он на неё.
  function setShip(planet, landed) {
    state.ship = planet == null ? null : { planet, landed: !!landed };
    const a = active();
    a.planet = planet == null ? null : planet; a.landed = !!landed;
    if (!landed) a.mine = null; // взлетел — добыча прекращается
    save();
  }
  // Корабль игрока — имя дизайна из конструктора (ships.js); топливо — доля полного бака (0…1).
  const design = () => active().design || null;
  function setDesign(name) { const a = active(); a.design = name; a.fuel = 1; state.design = name; save(); }
  const fuel = () => { const f = active().fuel; return typeof f === 'number' ? f : 1; };
  function setFuel(f) { active().fuel = Math.max(0, Math.min(1, Math.round(f * 1e6) / 1e6)); save(); }
  // Межзвёздный скачок: откуда шёл корабль (единичный вектор по карте галактики) — система
  // назначения ставит его на подлёте с этой стороны. Читается один раз.
  function setArrival(a) { state.arrival = a; save(); }
  function takeArrival() { const a = state.arrival || null; delete state.arrival; save(); return a; }
  // Межзвёздный перелёт в межзвёздном пространстве (карта галактики): откуда, куда, где и с какой скоростью.
  const travel = () => state.travel || null;
  function setTravel(t) { if (t) state.travel = t; else delete state.travel; save(); }

  // ---------- КОЛОНИИ ----------
  // Ключ — звезда и номер планеты. Колония живёт по реальному времени (js/colony.js), поэтому
  // хранится целиком: склад, здания, население, крипта, номер последнего посчитанного такта.
  const colKey = (star, planet) => star + ':' + planet;
  const colonies = () => (state.col = state.col || {});
  const colony = (star, planet) => colonies()[colKey(star, planet)] || null;
  function putColony(star, planet, col) { colonies()[colKey(star, planet)] = col; save(); }
  function colonyList() {
    return Object.entries(colonies()).map(([k, col]) => {
      const [star, planet] = k.split(':').map(Number);
      return { star, planet, col };
    });
  }

  // Журнал снятых гексов текущего такта (js/colony.js, Ship.harvest): только снятые, сбрасывается
  // каждые 10 минут.
  const hexLog = () => (state.hexLog = state.hexLog || { t: -1, taken: {} });

  return {
    hexLog,
    seed, galaxy, setCurrent, setShip, design, setDesign, fuel, setFuel, setArrival, takeArrival, travel, setTravel,
    ship: () => state.ship || null,
    currentStarId,
    currentStar: () => galaxy().stars[currentStarId()],
    fleet, active, addShip, setActive, activeId: () => active().id,
    startStarId,   // где игрок начал: там его стартовая колония
    colony, putColony, colonyList, save,
    galaxyUrl: () => `index.html?g=${seed}`,
    systemUrl: id => `system.html?g=${seed}&star=${id}`,
    planetUrl: (id, p) => `planet.html?g=${seed}&star=${id}&p=${p}`,
  };
})();
