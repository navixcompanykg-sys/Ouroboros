// Генератор одной звёздной системы (планеты и их состав) для звезды галактики.
// Детерминирован по seed звезды — планеты нигде не хранятся, а пересоздаются.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Перемешивание seed: у mulberry32 первые значения для «соседних» seed похожи.
function hashSeed(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// gstar — звезда из generateGalaxy: тип, имя, зона и seed уже заданы галактикой.
function generateSystem(gstar) {
  const rng = mulberry32(gstar.seed);
  const rand = (a, b) => a + (b - a) * rng();
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const chance = p => rng() < p;

  // --- Звезда ---
  const sc = gstar.type;
  const star = {
    name: gstar.name, type: sc,
    color: sc.color, lum: sc.lum * rand(0.8, 1.25), mass: sc.mass, radius: sc.radius,
  };
  star.excl = star.radius * 1.7; // ближе этого корабль к звезде не подходит

  const zone = GALAXY_ZONES[gstar.zone - 1];
  const galR = gstar.r, galAngle = Math.atan2(gstar.y, gstar.x);

  // --- Планеты ---
  // Расстояние меряем в «солнечных а.е.»: d = a / sqrt(L) — одинаковый нагрев
  // на одинаковом d у любой звезды. От d зависит тип планеты.
  const sqrtL = Math.sqrt(star.lum);
  const count = randInt(2, 9);
  const planets = [];
  let a = Math.max(star.radius * 3 + 20, rand(0.25, 0.45) * AU * sqrtL);
  let hasBelt = false;
  const letters = 'bcdefghijk';

  for (let i = 0; i < count; i++) {
    const d = a / (AU * sqrtL);
    let type;
    if (d < 0.55) type = chance(0.3) ? 'core' : 'hot';
    else if (d < 1.7) type = d > 1.3 && chance(0.3) ? 'cold' : 'rocky';
    else if (d < 3.5 && !hasBelt && chance(0.4)) { type = 'asteroid'; hasBelt = true; }
    else if (d < 3.5) type = chance(0.45) ? 'gas' : 'cold';
    else type = chance(0.6) ? 'gas' : 'cold';

    // Диаметр — как v2 (server/planets.go planetDiameter; горячая = lava, холодная = ice),
    // астероида в v2 не было — 0,2–0,3. От диаметра — размер гекс-карты (2/3/4) и видимый размер.
    const dr = PLANET_DIAMETER[type];
    const diameter = type === 'asteroid' ? 0.25 : rand(dr[0], dr[1]); // у астероида без броска — не сдвигать rng
    const size = diameter * 12;
    const hexRadius = planetHexRadius(diameter, type);

    // Зазор до предыдущей орбиты: тела и орбиты парковки соседей не должны пересекаться,
    // а рядом с поясом астероидов — ещё место под его полосу (с обеих сторон).
    const prev = planets[planets.length - 1];
    if (prev) {
      const beltRoom = (type === 'asteroid' || prev.type === 'asteroid') ? 2 * Math.max(6, a * 0.06) : 0;
      const need = prev.clearR + (size * 2 + 8) + 10 + beltRoom;
      if (a - prev.a < need) a = prev.a + need;
    }

    // Период обращения по 3-му закону Кеплера: T ∝ a^1.5 / sqrt(M).
    // 240 реальных секунд на оборот на 1 а.е. у звезды массой Солнца.
    const period = 240 * Math.pow(a / AU, 1.5) / Math.sqrt(star.mass);

    // Состояние жизни: только там, где у типа планеты есть биомасса в базе.
    const habitable = type === 'rocky' && d > 0.8 && d < 1.4;
    const hasBioBase = BIOMASS.some(k => PLANET_TYPES[type].base[RESOURCES.findIndex(r => r.key === k)] > 0);
    let life = 'none';
    if (hasBioBase) {
      const w = LIFE_CHANCE[habitable ? 'habitable' : type];
      let lr = rng() * 100;
      for (const k in w) { if ((lr -= w[k]) < 0) { life = k; break; } }
    }
    // Донор чёрной дыры — нестабильный мир, жизни нет (бросок выше всё равно делается,
    // чтобы не сдвинуть последовательность случайных чисел и не поменять остальной мир).
    if (gstar.bh) life = 'none';

    planets.push({
      index: i,
      name: star.name + ' ' + letters[i],
      type, a, d, r: size, diameter, hexRadius,
      ...planetPhysics(type, diameter), // настоящие радиус, масса, μ — без бросков rng
      phase: rand(0, Math.PI * 2),
      omega: (Math.PI * 2) / period,
      period,
      tempK: Math.round(278 * Math.pow(star.lum, 0.25) / Math.sqrt(a / AU)),
      habitable, life,
      composition: composition(type, sc, zone, life, gstar.bh ? gstar.bh.index : 0),
      // clearR — «зона» планеты для зазоров между орбитами и поясом (прежний радиус парковки;
      // не менять — от него зависят орбиты, а значит и весь мир). orbitR — низкая орбита парковки
      // корабля, ~1,3–1,4 радиуса нарисованной планеты (пользователь: «высоту орбиты снизить»).
      clearR: size * 2 + 8,
      orbitR: size * 1.2 + 1.5,
    });

    a = a * rand(1.45, 1.9) + 15;
  }

  // Пояс астероидов — полоса вокруг орбиты крупнейшего астероида. Её полуширина
  // ограничена зазором до соседних планет (с их телом и орбитой парковки корабля),
  // чтобы пояс никогда не ложился на чужую орбиту. Не больше 9% радиуса орбиты.
  const belt = planets.find(p => p.type === 'asteroid');
  if (belt) {
    let room = belt.a * 0.09;
    for (const p of planets) {
      if (p === belt) continue;
      const gap = Math.abs(p.a - belt.a) - p.r - p.clearR - belt.clearR;
      room = Math.min(room, gap * 0.8);
    }
    belt.beltHalfWidth = Math.max(1, room);
  }

  const outer = planets[planets.length - 1].a; // последняя орбита; граница системы — SYSTEM_RADIUS у всех
  const { comets, streams } = generateSmallBodies(gstar, star);
  return { seed: gstar.seed, gstar, star, planets, galR, galAngle, zone, outer, radius: SYSTEM_RADIUS, comets, streams };
}

// Кометы и метеорные потоки системы. Детерминированы от seed звезды (а значит — от seed галактики)
// СВОИМ rng: броски планет не сдвигаются, мир прежний. Число малых тел — SMALL_BODIES.min…max:
// чем ближе звезда к центру галактики, тем больше (у края ~min, у шара хаоса ~max, ±SMALL_BODIES.jitter).
// Орбиты — кеплеровы эллипсы вокруг звезды (μ = MU_SUN × масса): a — большая полуось, e —
// эксцентриситет, w — угол перицентра, m0 — средняя аномалия при t = 0, dir — +1 против часовой, −1 по ней.
// Кометы: перицентр у звезды, афелий — не дальше края системы (пользователь). Время малых тел
// ускорено в SMALL_BODIES.timeK раз — иначе они почти стоят (на них корабль и планеты не завязаны).
function generateSmallBodies(gstar, star) {
  const rng = mulberry32(hashSeed(gstar.seed) ^ 0xc0e75);
  const rand = (x, y) => x + (y - x) * rng();
  const SB = SMALL_BODIES, R = SYSTEM_RADIUS;
  const t = Math.max(0, Math.min(1, 1 - (gstar.r - GALAXY.chaosR) / (GALAXY_RADIUS_KPC - GALAXY.chaosR)));
  const n = Math.max(SB.min, Math.min(SB.max, Math.round(SB.min + (SB.max - SB.min) * t + rand(-SB.jitter, SB.jitter))));
  const mu = MU_SUN * star.mass;
  const orbit = (q, Q, retro) => {
    const A = (q + Q) / 2, e = (Q - q) / (Q + q);
    return { a: A, e, w: rand(0, 2 * Math.PI), m0: rand(0, 2 * Math.PI), dir: rng() < retro ? -1 : 1,
      n: Math.sqrt(mu / (A * A * A)) * SB.timeK }; // средняя угловая скорость, рад/с (× ускорение времени малых тел)
  };
  const comets = [], streams = [];
  let nC = 0;
  for (let i = 0; i < n; i++) if (rng() < SB.cometShare) nC++;
  for (let i = 0; i < nC; i++) {
    const q = AU * rand(0.3, 6) * Math.sqrt(star.lum) + star.radius * 3; // перицентр — у звезды
    // Афелий — не дальше края системы, чаще короткие орбиты (как кометы семейства Юпитера):
    // 15…250 а. е., квадрат броска сдвигает к малым (пользователь: «короче орбиты»).
    const o = orbit(q, Math.max(q * 1.5, AU * (15 + 235 * rng() ** 2)), 0.3); // кометы бывают обратными
    comets.push({ ...o, name: 'Комета ' + gstar.name.slice(0, 3).toUpperCase() + '-' + (i + 1), nucleus: rand(1.6, 2.8) });
  }
  // Метеорные потоки — ленты вдоль орбиты, как в жизни (пользователь выбрал все 4 пункта):
  //  1) частицы — по дуге орбиты длиной arc (доля оборота), лента изгибается по эллипсу;
  //  2) у «головы» (место кометы-родителя / средняя аномалия m0) гуще; молодые — узкие, 2–4 нитки
  //     (каждая — от своего прохода кометы), старые — длинные широкие, вплоть до кольца;
  //  3) часть потоков лежит на орбите кометы системы (parent) и тянется за ней, остальные — «сироты»;
  //  4) частицы медленно текут вдоль ленты (system.js).
  // age 0 — молодой, 1 — старый; width — полуширина ленты, мировые ед. Частицы строит экран системы
  // из seed (их тысячи, а генератор проходит всю галактику).
  const free = comets.map((c, i) => i);
  for (let i = nC; i < n; i++) {
    let o, parent = null;
    if (free.length && rng() < SB.parentShare) {
      parent = free.splice(Math.floor(rng() * free.length), 1)[0];
      const c = comets[parent];
      o = { a: c.a, e: c.e, w: c.w, m0: c.m0, dir: c.dir, n: c.n };
    } else {
      const q = AU * rand(0.4, 30);
      o = orbit(q, Math.min(R, q + AU * rand(2, 60)), 0.15);
    }
    const age = rng();
    streams.push({
      ...o, parent, age,
      arc: age < 0.5 ? rand(0.02, 0.08) : rand(0.25, 1),          // доля оборота
      width: (age < 0.5 ? rand(20, 60) : rand(60, 200)),            // полуширина, мировые ед.
      strands: age < 0.5 ? 2 + Math.floor(rng() * 3) : 1,
      seed: Math.floor(rng() * 4294967296),
    });
  }
  return { comets, streams };
}

// Положение тела на кеплеровой орбите в момент t: уравнение Кеплера E − e·sinE = M методом Ньютона.
function keplerPos(o, t) {
  const M = o.m0 + o.dir * o.n * t;
  let E = o.e > 0.8 ? Math.PI : M;
  for (let k = 0; k < 12; k++) E -= (E - o.e * Math.sin(E) - M) / (1 - o.e * Math.cos(E));
  const x = o.a * (Math.cos(E) - o.e), y = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  const c = Math.cos(o.w), sn = Math.sin(o.w);
  return { x: x * c - y * sn, y: x * sn + y * c };
}

// Настоящие числа планеты (PLANET_REAL): радиус, км; масса, M⊕; поверхностная g, м/с²;
// μ и радиус в мировых единицах — для гравитации корабля. Нарисована планета крупнее (p.r).
function planetPhysics(type, diameter) {
  const R = PLANET_REAL[type], d = PLANET_DIAMETER[type];
  const t = Math.max(0, Math.min(1, (diameter - d[0]) / (d[1] - d[0])));
  const km = R.km[0] + (R.km[1] - R.km[0]) * t;
  const massE = R.massE ? R.massE[0] + (R.massE[1] - R.massE[0]) * t : (km / 6371) ** 3 * R.rho / 5.51;
  return {
    radiusKm: Math.round(km), massE, gSurf: 9.81 * massE / (km / 6371) ** 2,
    mu: MU_SUN * massE / EARTHS_PER_SUN, rReal: km / KM_PER_UNIT,
  };
}

// Состав планеты, единиц массы на 100 единиц массы планеты. Каждый ресурс считается
// НЕЗАВИСИМО от остальных (прямое требование пользователя — один не влияет на другой):
//   значение = (база + поправка звезды, не ниже 0) × множитель зоны × множитель жизни (только биомасса);
//   база 0 → ресурса нет вовсе, поправка звезды его не создаёт;
//   у донора чёрной дыры (bhIndex > 0) — ещё × (1 + (BH_EFFECT − 1) × bhIndex).
// Сумма ≤ 100 обеспечивается САМОЙ таблицей (база, поправки, множители), а не формулой:
// перебор сумм по всем сочетаниям — страница table-check.html. Остаток до 100 — пустая порода.
// Каждый ресурс возвращается вместе со слагаемыми — карточка показывает, откуда число.
function composition(typeKey, starType, zone, lifeKey, bhIndex = 0) {
  const T = PLANET_TYPES[typeKey], L = LIFE_STATES[lifeKey];
  return RESOURCES.map((r, i) => {
    const base = T.base[i], mod = starType.mod[i], zm = zone.mult[i];
    const bi = BIOMASS.indexOf(r.key);
    const lm = bi >= 0 ? L.mult[bi] : 1;
    const bm = 1 + (BH_EFFECT[i] - 1) * bhIndex;
    const value = base > 0 ? Math.round(Math.max(0, base + mod) * zm * lm * bm * 100) / 100 : 0;
    return { key: r.key, bio: bi >= 0, value, base, mod, zoneMult: zm, lifeMult: bi >= 0 ? lm : null, bhMult: bhIndex ? bm : null };
  });
}
