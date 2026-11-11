// Поверхность планеты: гекс-карта и раскладка ресурсов по гексам.
// Перенесено из v2 (server/planets.go: planetHexRadius, generateSurface, markFreshWater,
// distributeHexResources, largestRemainderAllocate, hexBioWeight) и адаптировано к 12 ресурсам v3.
// Поверхность не хранится — пересоздаётся детерминированно из seed звезды и номера планеты
// своим rng (на мир — звёзды, планеты, состав — не влияет).

// Типы местности и цвета — как в v2 (client/world.js SURFACE_TYPES).
const SURFACE_TYPES = {
  water:     { name: 'Вода',          color: '#2a6fdd' },
  icecap:    { name: 'Ледяная шапка', color: '#d8f2ff' },
  mountains: { name: 'Горы',          color: '#887766' },
  hills:     { name: 'Холмы',         color: '#a08868' },
  wasteland: { name: 'Пустошь',       color: '#9c9464' },
  steppe:    { name: 'Степь',         color: '#8fa050' },
  desert:    { name: 'Пустыня',       color: '#cc9944' },
  forest:    { name: 'Леса',          color: '#336633' },
  jungle:    { name: 'Джунгли',       color: '#1f7a3d' },
};

// Радиус гекс-карты по диаметру — как v2 planetHexRadius: шкала 1–3 по общему диапазону
// core..ice, округление делит её 25% / 50% / 25% (средняя — самый частый исход).
// Астероид (в v2 его не было) — всегда радиус 1, 7 гексов.
function planetHexRadius(diameter, type) {
  if (type === 'asteroid') return 1;
  const dMin = 0.50, dMax = 0.87;
  const size = 1 + 2 * Math.min(1, Math.max(0, (diameter - dMin) / (dMax - dMin)));
  return size < 1.5 ? 2 : size < 2.5 ? 3 : 4;
}
const SIZE_NAMES = { 1: 'крошечная', 2: 'малая', 3: 'средняя', 4: 'большая' };
const hexCount = R => 3 * R * R + 3 * R + 1;

// Соседи в осевых координатах (q, r).
const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function generateSurface(planet, gstar) {
  if (planet.type === 'gas') return null; // твёрдой поверхности нет
  const rng = mulberry32(hashSeed((gstar.seed ^ Math.imul(planet.index + 1, 0x9e3779b1)) >>> 0));
  const R = planet.hexRadius, t = planet.type;
  const env = surfaceEnv(planet, rng);

  const hexes = [];
  for (let r = -R; r <= R; r++) {
    for (let q = Math.max(-R, -R - r); q <= Math.min(R, R - r); q++) {
      hexes.push({ q, r, ...terrainAt(t, env, Math.abs(r) / Math.max(1, R), rng), res: {} });
    }
  }
  markFreshWater(hexes);
  distributeHexResources(rng, hexes, planet, env);
  return { radius: R, env, hexes };
}

// Условия планеты для рельефа. В v3 нет отдельных параметров воды/давления/вулканизма —
// берём из типа планеты (диапазоны воды — как v2 waterRange) и температуры.
function surfaceEnv(p, rng) {
  const rand = (a, b) => a + (b - a) * rng();
  const water = { core: 0, hot: rand(0, 0.02), rocky: rand(0.05, 0.6), cold: rand(0.5, 0.9), asteroid: 0 }[p.type];
  const life = p.life !== 'none';
  const atmo = p.type === 'core' || p.type === 'asteroid' ? false
    : life || rng() < ({ rocky: 0.75, cold: 0.45, hot: 0.55 }[p.type] || 0);
  const tectonic = { hot: rand(0.3, 0.8), rocky: rand(0.05, 0.35), cold: rand(0.02, 0.2), core: 0.05, asteroid: 0 }[p.type];
  // −1 холодная целиком, 0 нейтрально, +1 жаркая (по температуре планеты, 288 K — земная).
  const heatBias = Math.min(1, Math.max(-1, (p.tempK - 288) / 250));
  return { water, life, atmo, tectonic, heatBias };
}

// Тип гекса по широте и условиям — логика v2 generateSurface (пояса сдвигает heatBias,
// горы/холмы растут с тектоникой, лес/джунгли/степь — только при жизни и атмосфере).
function terrainAt(t, env, lat, rng) {
  const { water: w, atmo, tectonic, heatBias, life } = env;
  const effLat = Math.min(1, Math.max(0, lat - heatBias * 0.32 + (rng() - 0.5) * 0.22));
  const heat = 1 - effLat;
  const icecapThreshold = 0.85 - Math.max(0, -heatBias) * 0.35;

  if (t === 'core' || t === 'asteroid') { // голое ядро / астероид — кратеры, редкие горы
    return { type: rng() < (t === 'asteroid' ? 0.2 : 0.08) ? 'mountains' : 'wasteland', crater: true };
  }
  if (effLat > icecapThreshold && w > 0.08) return { type: 'icecap', crater: !atmo && rng() < 0.4 };
  if (atmo && w > 0.05 && rng() < w * (1 - effLat * 0.6) * 1.1) return { type: 'water', crater: false };
  if (rng() < 0.06 + tectonic * 0.6) {
    if (w > 0.08 && rng() < 0.25 * (1 - heat * 0.5)) return { type: 'icecap', crater: !atmo && rng() < 0.4 };
    return { type: 'mountains', crater: !atmo && rng() < 0.5 };
  }
  if (rng() < 0.09 + tectonic * 0.12) return { type: 'hills', crater: !atmo && rng() < 0.35 };
  const dry = 1 - w;
  if (life && atmo && heat > 0.5 && rng() < Math.min(0.92, 0.18 + w * 0.75)) return { type: 'jungle', crater: false };
  if (life && atmo && heat <= 0.4 && rng() < Math.min(0.85, 0.14 + w * 0.65)) return { type: 'forest', crater: false };
  if (life && atmo && rng() < Math.min(0.75, 0.14 + w * 0.55)) return { type: 'steppe', crater: false };
  if (dry > 0.6 || (heat > 0.7 && dry > 0.4)) return { type: 'desert', crater: !atmo && rng() < 0.5 };
  return { type: 'wasteland', crater: !atmo && rng() < 0.4 };
}

// Пресная вода — по связности (v2 markFreshWater): шапка всегда пресная; вода без соседей-воды —
// озеро (пресное), с соседями — море (солёное); соседи пресного источника — родники.
function markFreshWater(hexes) {
  const at = new Map(hexes.map((h, i) => [h.q + ',' + h.r, i]));
  const nb = h => HEX_DIRS.map(([dq, dr]) => at.get((h.q + dq) + ',' + (h.r + dr))).filter(i => i !== undefined);
  for (const h of hexes) {
    if (h.type === 'icecap') h.fresh = true;
    else if (h.type === 'water') h.fresh = !nb(h).some(i => hexes[i].type === 'water');
  }
  const sources = hexes.filter(h => h.fresh && (h.type === 'icecap' || h.type === 'water'));
  for (const s of sources) for (const i of nb(s)) hexes[i].fresh = true;
}

// Метод наибольшего остатка (v2 largestRemainderAllocate): делит total ЦЕЛИКОМ, сумма
// результата ТОЧНО равна total. Независимое округление на гекс теряло до 15–20% запаса.
function largestRemainderAllocate(total, weights) {
  const out = weights.map(() => 0), sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return out;
  const fr = weights.map((w, i) => { const s = total * w / sum, f = Math.floor(s); out[i] = f; return [s - f, i]; });
  let left = total - out.reduce((a, b) => a + b, 0);
  fr.sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < fr.length && left > 0; k++, left--) out[fr[k][1]]++;
  return out;
}

// Как раскладывается каждый ресурс. 'biome' — весь запас по весу типа гекса (+шум ±15%);
// 'deposits' — фон (доля bg) + n месторождений, mtn — месторождения втрое чаще на горах/холмах.
// Правила — перенос v2 по смыслу: силикаты/вода/биомасса — биом; металлы — 20% фон + 4 месторождения;
// радиоактивные — 15% + 3; самое ценное (платиноиды v2) — 2% + 2; гелий-3 v2 → тритий.
const HEX_RULES = {
  silicates:  { kind: 'biome' },
  rareEarth:  { kind: 'deposits', bg: 0.20, n: 4, mtn: true },
  superdense: { kind: 'deposits', bg: 0.05, n: 3, mtn: true },
  silicon:    { kind: 'biome' },
  niobium:    { kind: 'deposits', bg: 0.20, n: 4, mtn: true },
  isotopes:   { kind: 'deposits', bg: 0.15, n: 3, mtn: true },
  hydrogen:   { kind: 'biome' },
  tritium:    { kind: 'deposits', bg: 0.45, n: 3, mtn: false }, // в атмосфере рассеян; без неё — см. ниже
  antimatter: { kind: 'deposits', bg: 0.02, n: 2, mtn: true },
  microbiota: { kind: 'biome' },
  flora:      { kind: 'biome' },
  bitumen:    { kind: 'biome' },
};

// Во сколько раз гекс данного типа богаче среднего (v2 hexBioWeight; кремний, водород,
// микробиота, флора — новые по той же логике).
function hexWeight(key, h) {
  const T = h.type;
  switch (key) {
    case 'silicates': return { mountains: 2.5, hills: 1.6, water: 0.3, icecap: 0.5 }[T] ?? 1;
    case 'silicon':   return { desert: 2.2, wasteland: 1.3, mountains: 1.3, hills: 1.2, water: 0.3, icecap: 0.3 }[T] ?? 0.8;
    case 'hydrogen':  return T === 'icecap' ? 3 : T === 'water' ? 2.5 : h.fresh ? 0.8 : 0.2; // водород — из воды и льда
    case 'microbiota': return { jungle: 2.5, forest: 2, steppe: 1.2, water: 1.2 }[T] ?? 0.05;
    case 'flora':     return { jungle: 2.5, forest: 2, steppe: 1 }[T] ?? 0.02;
    case 'bitumen':   return { wasteland: 1.2, water: 0.8, mountains: 0.5 }[T] ?? 0.2;
  }
  return 1;
}

function distributeHexResources(rng, hexes, planet, env) {
  // Запас — в сотых долях единицы (у ресурсов v3 дробные значения): целые сотые
  // делятся без потерь, сумма по гексам точно равна составу планеты.
  RESOURCES.forEach((r, i) => {
    const total = Math.round(planet.composition[i].value * 100);
    if (total <= 0) return;
    let rule = HEX_RULES[r.key];
    if (planet.type === 'core' && r.key === 'superdense') rule = { kind: 'deposits', bg: 1, n: 0, mtn: false }; // ядро однородно
    if (r.key === 'tritium' && !env.atmo) rule = { kind: 'deposits', bg: 0.08, n: 2, mtn: true }; // реголит копит локально
    if (rule.kind === 'biome') {
      const amt = largestRemainderAllocate(total, hexes.map(h => hexWeight(r.key, h) * (0.85 + rng() * 0.3)));
      hexes.forEach((h, k) => { if (amt[k]) h.res[r.key] = (h.res[r.key] || 0) + amt[k]; });
      return;
    }
    const bgPool = Math.round(total * rule.bg), depPool = total - bgPool;
    const bg = largestRemainderAllocate(bgPool, hexes.map(() => 0.65 + rng() * 0.7));
    hexes.forEach((h, k) => { if (bg[k]) h.res[r.key] = (h.res[r.key] || 0) + bg[k]; });
    if (!rule.n || depPool <= 0) return;
    const dep = largestRemainderAllocate(depPool, Array.from({ length: rule.n }, () => -Math.log(rng() + 1e-9)));
    const used = new Set();
    for (let d = 0; d < rule.n; d++) {
      const k = pickHex(rng, hexes, rule.mtn, used);
      if (k < 0) break;
      used.add(k);
      hexes[k].res[r.key] = (hexes[k].res[r.key] || 0) + dep[d];
      (hexes[k].deposits ||= []).push(r.key);
    }
  });
}

function pickHex(rng, hexes, mtn, used) {
  const w = hexes.map((h, i) => used.has(i) ? 0 : (mtn && (h.type === 'mountains' || h.type === 'hills') ? 3 : 1));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return -1;
  let x = rng() * sum;
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0 && w[i] > 0) return i; }
  return w.findIndex(v => v > 0);
}
