// Генератор галактики: неподвижные звёзды в спиральных рукавах, 5 зон × 12 секторов.
// Детерминирован по seed галактики. Планеты звезды генерируются отдельно
// (generateSystem в gen.js) из собственного seed звезды — хранить их не нужно.

function gauss(rng) {
  return Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
}

// Зона по расстоянию от центра (кпк): 5 равных колец, 1 — край, 5 — центр.
function zoneOf(rKpc) {
  return Math.min(5, Math.max(1, 5 - Math.floor(rKpc / (GALAXY_RADIUS_KPC / 5))));
}
// Угловой сектор 0…11 по направлению от центра.
function sectorOf(x, y) {
  const a = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  return Math.floor(a / (Math.PI * 2 / GALAXY.sectorsAround)) % GALAXY.sectorsAround;
}
const sectorKey = (zone, sector) => zone + '-' + String(sector + 1).padStart(2, '0');

// Логарифмическая спираль рукава: угол на радиусе r. Рукава 0…arms-1 — главные,
// следующие secondaryArms — второстепенные, посередине между главными.
function armAngle(rKpc, arm) {
  const main = GALAXY.arms, step = Math.PI * 2 / main;
  const base = arm < main ? arm * step : (arm - main) * step + step / 2;
  return base + Math.log(rKpc / 0.8) / Math.tan(GALAXY.pitchDeg * Math.PI / 180);
}

// Радиальная плотность диска (звёзд на единицу площади) — профиль v2 (server/galaxy.go,
// поле Density по 12 зонам): 3.0 у центра → 0.9 на краю. Здесь — опорные точки по радиусу.
const DISK_DENSITY = [3.0, 2.9, 2.6, 2.5, 2.7, 2.3, 2.0, 1.8, 1.5, 1.3, 1.1, 0.9];
function diskDensity(rKpc) {
  const f = Math.min(0.9999, rKpc / GALAXY_RADIUS_KPC) * (DISK_DENSITY.length - 1);
  const i = Math.floor(f), t = f - i;
  return DISK_DENSITY[i] * (1 - t) + DISK_DENSITY[i + 1] * t;
}

// Галактика не обрывается на краю круга: плотность звёзд плавно (по гауссу) спадает начиная с
// TAPER_START·R и продолжается за край до HALO_R·R. Круг R — лишь граница, докуда можно летать:
// настоящие звёзды берутся из распределения внутри него, декоративные (без имён) — снаружи.
// Одно распределение на обе стороны — поэтому на границе нет ни скачка плотности, ни кромки.
const HALO_R = 1.6, TAPER_START = 0.45, TAPER_WIDTH = 0.6;
function galaxyTaper(r) {
  const R = GALAXY_RADIUS_KPC, r0 = TAPER_START * R;
  return r < r0 ? 1 : Math.exp(-(((r - r0) / (TAPER_WIDTH * R)) ** 2));
}

function rawGalaxyPoint(rng) {
  const Rmax = GALAXY_RADIUS_KPC * HALO_R, roll = rng();
  let r, th, inArm = false;
  if (roll < GALAXY.bulgeShare) {
    r = Math.abs(gauss(rng)) * 1.5; th = rng() * Math.PI * 2;
  } else if (roll < GALAXY.bulgeShare + GALAXY.armShare) {
    inArm = true;
    r = 1.2 + Math.pow(rng(), 0.9) * (Rmax - 1.2);
    const secondary = rng() < GALAXY.secondaryShare;
    const arm = secondary ? GALAXY.arms + Math.floor(rng() * GALAXY.secondaryArms) : Math.floor(rng() * GALAXY.arms);
    // Ширина рукава поперёк (кпк) растёт к краю; второстепенные — уже.
    const width = (GALAXY.armWidth + r * GALAXY.armWidthGrow) * (secondary ? 0.6 : 1);
    th = armAngle(r, arm) + gauss(rng) * width / r;
    r += gauss(rng) * width * 0.3;
  } else {
    // Диск: радиус по профилю плотности v2 (выборка с отказом по r·density); за краем — как на краю.
    do { r = rng() * Rmax; } while (rng() * Rmax * 3.0 > r * diskDensity(Math.min(r, GALAXY_RADIUS_KPC * 0.999)));
    th = rng() * Math.PI * 2;
  }
  r = Math.max(0.02, Math.abs(r)); // без «дыры» в центре: ядро сплошное
  return { x: Math.cos(th) * r, y: Math.sin(th) * r, r, inArm };
}

// Одна точка распределения галактики: балдж, рукава или диск между ними, с плавным спадом к краю.
// inside = true — только внутри круга R (настоящие звёзды); false — вся галактика с внешним краем
// (свечение и декоративные звёзды). Ту же функцию использует картинка свечения — звёзды и свет совпадают.
function sampleGalaxyPoint(rng, inside = true) {
  for (;;) {
    const p = rawGalaxyPoint(rng);
    if (p.r > GALAXY_RADIUS_KPC * HALO_R || rng() > galaxyTaper(p.r)) continue;
    // Настоящие звёзды — только между шаром хаоса и краем круга.
    if (inside && (p.r >= GALAXY_RADIUS_KPC * 0.999 || p.r < GALAXY.chaosR)) continue;
    return p;
  }
}

function generateGalaxy(seed) {
  const rng = mulberry32(hashSeed(seed));
  const R = GALAXY_RADIUS_KPC;
  const raw = [];

  function place(rKpc, theta, inArm) {
    rKpc = Math.min(R * 0.995, Math.max(0.02, rKpc));
    raw.push({ x: Math.cos(theta) * rKpc, y: Math.sin(theta) * rKpc, r: rKpc, inArm });
  }

  for (let i = 0; i < GALAXY.stars; i++) raw.push(sampleGalaxyPoint(rng));

  // Правило v2: ни один сектор не пустует — добираем звёзды в бедные сектора.
  const per = {};
  for (const s of raw) { const k = sectorKey(zoneOf(s.r), sectorOf(s.x, s.y)); per[k] = (per[k] || 0) + 1; }
  const ringW = R / 5, wedge = Math.PI * 2 / GALAXY.sectorsAround;
  for (let z = 1; z <= 5; z++) {
    for (let sc = 0; sc < GALAXY.sectorsAround; sc++) {
      const k = sectorKey(z, sc);
      for (let n = per[k] || 0; n < GALAXY.minPerSector; n++) {
        const r0 = Math.max((5 - z) * ringW, GALAXY.chaosR);
        // Равномерно по площади кольцевого сегмента.
        const r1 = (5 - z + 1) * ringW;
        const r = Math.sqrt(r0 * r0 + rng() * (r1 ** 2 - r0 * r0));
        place(Math.min(r, r1 - ringW * 0.02), (sc + 0.02 + rng() * 0.96) * wedge, false);
      }
    }
  }

  // Тип, имя, зона, сектор, собственный seed.
  const usedNames = new Set();
  const stars = raw.map((s, id) => {
    const zone = zoneOf(s.r), sector = sectorOf(s.x, s.y);
    const w = STAR_WEIGHTS_BY_ZONE[zone - 1];
    let total = 0;
    const weights = STAR_TYPES.map(t => { const v = (w[t.key] || 0) * (s.inArm ? (ARM_BONUS[t.key] || 1) : 1); total += v; return v; });
    let roll = rng() * total, type = STAR_TYPES[0];
    for (let i = 0; i < weights.length; i++) { if ((roll -= weights[i]) < 0) { type = STAR_TYPES[i]; break; } }
    return {
      id, x: s.x, y: s.y, r: s.r, inArm: s.inArm,
      zone, sector, sectorKey: sectorKey(zone, sector),
      type, name: uniqueStarName(rng, usedNames),
      seed: hashSeed((seed * 7919 + id) >>> 0),
    };
  });

  // Доноры чёрных дыр: каждая дыра берёт до BH_DONORS ближайших звёзд в радиусе BH_REACH.
  // Случайных бросков нет — мир не меняется. Звезда у двух дыр получает больший индекс.
  for (const b of stars) {
    if (b.type.key !== 'blackhole') continue;
    stars.filter(s => s !== b && s.type.key !== 'blackhole')
      .map(s => ({ s, d: Math.hypot(s.x - b.x, s.y - b.y) }))
      .filter(o => o.d < BH_REACH).sort((p, q) => p.d - q.d).slice(0, BH_DONORS)
      .forEach(({ s, d }) => {
        const idx = Math.round((1 - d / BH_REACH) * 100) / 100;
        if (!s.bh || idx > s.bh.index) s.bh = { id: b.id, index: idx };
      });
  }

  const sectors = {};
  for (const s of stars) (sectors[s.sectorKey] ||= { key: s.sectorKey, zone: s.zone, sector: s.sector, stars: [] }).stars.push(s);
  return { seed, stars, sectors };
}

function uniqueStarName(rng, used) {
  const syl = ['Ка', 'Ри', 'Ол', 'Ве', 'Та', 'Сур', 'Ан', 'Ми', 'Зе', 'Ор', 'Ла', 'Нис', 'Вар', 'Тэ', 'Ки', 'Мор', 'Эл', 'Дан',
    'Ас', 'Бе', 'Го', 'Иль', 'Ну', 'Пра', 'Ск', 'Ул', 'Фе', 'Хо', 'Це', 'Шар', 'Юм', 'Яр'];
  for (let tries = 0; ; tries++) {
    let name = '';
    for (let i = 2 + Math.floor(rng() * 2); i > 0; i--) name += syl[Math.floor(rng() * syl.length)];
    name = name[0] + name.slice(1).toLowerCase();
    if (tries > 3 || rng() < 0.3) name += '-' + (2 + Math.floor(rng() * 998));
    if (!used.has(name)) { used.add(name); return name; }
  }
}
