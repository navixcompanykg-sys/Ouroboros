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
  // Газовый гигант: «поверхность» — верхние слои атмосферы, корабль берёт газ с них.
  clouds:    { name: 'Светлая зона',  color: '#d9c9a6' },
  belt:      { name: 'Тёмный пояс',   color: '#9a7850' },
  storm:     { name: 'Вихрь',         color: '#c96a4a' },
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
  // У газового гиганта твёрдой поверхности нет, но гексы есть: это верхние слои атмосферы,
  // с них корабль и забирает газ (решение пользователя). Садиться на него нельзя — корабль
  // встаёт на НИЗКУЮ ОРБИТУ, см. planet.js.
  const rng = mulberry32(hashSeed((gstar.seed ^ Math.imul(planet.index + 1, 0x9e3779b1)) >>> 0));
  const R = planet.hexRadius, t = planet.type;
  const env = surfaceEnv(planet, rng);
  // Условия среды для колонии (ТЗ §8.21): радиация и токсичность по формулам v2, температура планеты.
  Object.assign(env, planetConditions(planet, gstar, env));

  const hexes = [];
  for (let r = -R; r <= R; r++) {
    for (let q = Math.max(-R, -R - r); q <= Math.min(R, R - r); q++) {
      hexes.push({ q, r, ...terrainAt(t, env, Math.abs(r) / Math.max(1, R), rng), res: {} });
    }
  }
  if (t === 'gas') markStorms(rng, hexes, R);
  markFreshWater(hexes);
  distributeHexResources(rng, hexes, planet, env);
  return { radius: R, env, hexes };
}

// Условия планеты для рельефа. В v3 нет отдельных параметров воды/давления/вулканизма —
// берём из типа планеты (диапазоны воды — как v2 waterRange) и температуры.
function surfaceEnv(p, rng) {
  const rand = (a, b) => a + (b - a) * rng();
  const water = { core: 0, hot: rand(0, 0.02), rocky: rand(0.05, 0.6), cold: rand(0.5, 0.9), asteroid: 0, gas: 0 }[p.type];
  const life = p.life !== 'none';
  const atmo = p.type === 'gas' ? true
    : p.type === 'core' || p.type === 'asteroid' ? false
    : life || rng() < ({ rocky: 0.75, cold: 0.45, hot: 0.55 }[p.type] || 0);
  const tectonic = { hot: rand(0.3, 0.8), rocky: rand(0.05, 0.35), cold: rand(0.02, 0.2), core: 0.05, asteroid: 0, gas: 0 }[p.type];
  // −1 холодная целиком, 0 нейтрально, +1 жаркая (по температуре планеты, 288 K — земная).
  const heatBias = Math.min(1, Math.max(-1, (p.tempK - 288) / 250));
  return { water, life, atmo, tectonic, heatBias };
}

// УСЛОВИЯ СРЕДЫ ПЛАНЕТЫ, 0…100 — формулы v2 (server/planets.go envRoll). Решения пользователя:
// «у планет уже есть показатель токсичности — не плодим сущности, учитываем её как базовую»;
// «добавляй радиацию и делаем по аналогии с версией 2». Без бросков rng — мир не сдвигается.
//   вулканизм = тектоника карты × 100 (в v2 тектоника и была вулканизм / 100);
//   давление  = есть атмосфера ? база по типу (горячая 15, скалистая 25, холодная 10, газ 90)
//               + вулканизм × 0,3 : 0;
//   радиация  = 100 × (d₀ / d)² × (1 − экран) + фон пород. d — «солнечное» расстояние планеты
//               (a / √L, gen.js), d₀ — где в v2 было 100: граница выжженного ядра z0. В v2 лава
//               кончалась на z1, в v3 — на d = 0,55, отсюда d₀ = 0,55 × z0 / z1 по типу звезды
//               (красная и белая 3/5, жёлтая 4/7, синяя и нейтронная 5/10; протозвезда и туманность
//               — как жёлтая, чёрная дыра — как нейтронная: ДОПУЩЕНИЕ). Экран атмосферы — до 85 %
//               (давление / 100 × 0,85). Фон — от радиоактивных пород: в v2 √(радиоактивы 0…10000) × 0,5,
//               в v3 радиоактивного сырья нет, ближе всего изотопы — √(доля изотопов × 100) × 0,5 (ДОПУЩЕНИЕ);
//   токсичность = тип (ядро 5, горячая 40, скалистая 10, холодная 15, газ 60, астероид 5)
//               + вулканизм × 0,4 + радиация × 0,2 + давление × 0,1.
// Условия планеты БЕЗ гекс-карты (для статуса пригодности и среднего по галактике): тот же rng и
// те же первые броски, что у generateSurface, — значения совпадают, а 33 тысячи планет считаются
// за доли секунды.
function planetEnv(planet, gstar) {
  const rng = mulberry32(hashSeed((gstar.seed ^ Math.imul(planet.index + 1, 0x9e3779b1)) >>> 0));
  const env = surfaceEnv(planet, rng);
  return Object.assign(env, planetConditions(planet, gstar, env));
}

const RAD_Z = { red: [3, 5], white: [3, 5], yellow: [4, 7], protostar: [4, 7], nebula: [4, 7],
  blue: [5, 10], neutron: [5, 10], blackhole: [5, 10] };
function planetConditions(p, gstar, env) {
  const clamp = x => Math.max(0, Math.min(100, x));
  const volc = clamp((env.tectonic || 0) * 100);
  const pressure = env.atmo ? clamp(({ core: 0, hot: 15, rocky: 25, cold: 10, gas: 90, asteroid: 0 }[p.type] || 0) + volc * 0.3) : 0;
  const z = RAD_Z[gstar && gstar.type ? gstar.type.key : 'yellow'] || RAD_Z.yellow;
  const d0 = 0.55 * z[0] / z[1];
  const d = p.d > 0 ? p.d : 1;
  const shield = Math.min(0.85, pressure / 100 * 0.85);
  const iso = ((p.composition || []).find(x => x.key === 'isotopes') || {}).value || 0;
  const radiation = Math.round(clamp(100 * Math.pow(d0 / d, 2) * (1 - shield) + Math.sqrt(iso * 100) * 0.5));
  const base = { core: 5, hot: 40, rocky: 10, cold: 15, gas: 60, asteroid: 5 }[p.type] || 10;
  const toxicity = Math.round(clamp(base + volc * 0.4 + radiation * 0.2 + pressure * 0.1));
  return { volcanic: Math.round(volc), pressure: Math.round(pressure), radiation, toxicity, tempK: p.tempK };
}


// БУРЯ НА ГАЗОВОМ ГИГАНТЕ ЗАНИМАЕТ НЕСКОЛЬКО ГЕКСОВ, а не один (решение пользователя).
// Раньше каждый гекс сам бросал 5 % на «вихрь», и бури получались россыпью одиночных точек —
// на газовом гиганте так не бывает: это вихрь размером с планету (Большое красное пятно вдвое
// шире Земли). Ставим одно-два пятна: центр и его соседи, у крупной карты иногда второе кольцо.
function markStorms(rng, hexes, R) {
  const at = (q, r) => hexes.find(h => h.q === q && h.r === r);
  const NB = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const count = R >= 4 && rng() < 0.3 ? 2 : 1;            // обычно одно пятно, иногда два
  for (let n = 0; n < count; n++) {
    const c = hexes[Math.floor(rng() * hexes.length)];
    const ring = R >= 4 && rng() < 0.25 ? 2 : 1;           // изредка пятно пошире
    c.type = 'storm';
    let wave = [c];
    for (let d = 0; d < ring; d++) {
      const next = [];
      for (const h of wave) for (const [dq, dr] of NB) {
        const nb = at(h.q + dq, h.r + dr);
        if (nb && nb.type !== 'storm') { nb.type = 'storm'; next.push(nb); }
      }
      wave = next;
    }
  }
}

// Тип гекса по широте и условиям — логика v2 generateSurface (пояса сдвигает heatBias,
// горы/холмы растут с тектоникой, лес/джунгли/степь — только при жизни и атмосфере).
function terrainAt(t, env, lat, rng) {
  const { water: w, atmo, tectonic, heatBias, life } = env;
  if (t === 'gas') { // полосы по широте: светлые зоны и тёмные пояса; вихри ставятся отдельно
    // Полосы через синус, а не делением широты: широта квантуется радиусом карты, и
    // при делении на целые полосы почти всё сваливалось в один тип.
    const band = Math.sin(lat * Math.PI * 3.5 + (rng() - 0.5) * 0.5);
    return { type: band > 0 ? 'clouds' : 'belt', crater: false };
  }
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

// Как раскладывается каждый ресурс — ТОЧНО по правилам v2 (server/planets.go distributeHexResources),
// каждому нашему ресурсу — правило его аналога в v2 (требование пользователя «как в версии 2»):
//   силикаты → силикаты (биом), кремний → металлическое железо (биом, тяготеет к горам),
//   редкоземельные и ниобий → металлы (20% фон + 4 месторождения, к горам),
//   сверхплотные → тугоплавкие металлы (5% + 4, к горам; на голом ядре — ровно, без месторождений),
//   изотопы → радиоактивные (15% + 3, к горам), водород → водород (топливо: 65% + 2, без гор),
//   тритий → гелий-3 (с атмосферой 45% + 3 без гор; без атмосферы — реголит: 8% + 2, к горам),
//   антиматерия → платиноиды (2% + 2, к горам), флора → дикая биомасса, микробиота → фосфаты,
//   битумы → битумы (все три — биом).
// 'biome' — весь запас по весу типа гекса (+шум ±15%); 'deposits' — фон (доля bg, шум 0,65–1,35)
// + n месторождений (экспоненциальный разброс), mtn — месторождения втрое чаще на горах/холмах.
// РАСПРЕДЕЛЕНИЕ ПО ГЕКСАМ: фон плюс месторождения. Два требования пользователя, которые тянут
// в разные стороны, и оба надо выполнить:
//   1. «гекс с девятью тысячами — это дисбаланс»: одно месторождение не должно держать половину
//      запаса планеты, как было в v2 (там доля доходила до 49 %);
//   2. «редким ресурсам важно сделать большую концентрацию в конкретных месторождениях, иначе
//      они размажутся до полной незаметности».
//
// Решение — РАЗНАЯ политика по редкости, а не одна на всех:
//   распространённые (водород) — большой фон, доля месторождения мала: он и так везде;
//   средние (редкоземельные, ниобий, тритий) — фон поменьше, доля около 9 %;
//   РЕДКИЕ (сверхплотные, изотопы, антиматерия) — фон МАЛЕНЬКИЙ, а доля месторождения большая:
//      17–18 %. Абсолютный максимум остаётся скромным просто потому, что самого ресурса мало,
//      зато месторождение выделяется на фоне в десятки раз — его есть смысл искать.
//
// СЫРЬЁ 3 УРОВНЯ — ТОЛЬКО В МЕСТОРОЖДЕНИЯХ, фона нет совсем (решение пользователя: «редкие
// 3 уровня вообще только в месторождениях, нескольких»). Сверхплотные, изотопы, антиматерия и
// битумы не валяются под ногами: на планете их держат пять точек, остальная карта пуста. Это и
// делает находку находкой, и задаёт смысл разведке: сырьё 3 уровня нужно для планетарной
// единицы (ТЗ §8.5), а взять его можно только там.
//
//   ресурс           v2 (фон/мест. → доля)   сейчас          доля одного месторождения
//   водород          0,65 / 2 → 18 %         0,80 / 4        5,0 %
//   тритий           0,45 / 3 → 18 %         0,60 / 5        8,0 %
//   редкоземельные   0,20 / 4 → 20 %         0,45 / 6        9,2 %
//   ниобий           0,20 / 4 → 20 %         0,45 / 6        9,2 %
//   ─── 3 уровень, фона нет ───
//   изотопы          0,15 / 3 → 28 %         0    / 5       20 %
//   сверхплотные     0,05 / 4 → 24 %         0    / 5       20 %
//   антиматерия      0,02 / 2 → 49 %         0    / 5       20 %
//   битумы           биом по местности       0    / 10      10 %  (их больше, чем прочего 3 уровня)
//   тритий без атм.  0,08 / 2 → 46 %         0,15 / 5       17 %
const HEX_RULES = {
  silicates:  { kind: 'biome' },
  rareEarth:  { kind: 'deposits', bg: 0.45, n: 6, mtn: true },
  superdense: { kind: 'deposits', bg: 0,    n: 5, mtn: true },
  silicon:    { kind: 'biome' },
  niobium:    { kind: 'deposits', bg: 0.45, n: 6, mtn: true },
  isotopes:   { kind: 'deposits', bg: 0,    n: 5, mtn: true },
  hydrogen:   { kind: 'deposits', bg: 0.80, n: 4, mtn: false },
  tritium:    { kind: 'deposits', bg: 0.60, n: 5, mtn: false }, // без атмосферы — см. distributeHexResources
  antimatter: { kind: 'deposits', bg: 0,    n: 5, mtn: true },
  microbiota: { kind: 'biome' },
  flora:      { kind: 'biome' },
  // Битумы — тоже 3 уровень своей группы, поэтому тоже только месторождениями. В v2 они были
  // биомными (тяготели к пустошам и воде); если захочется вернуть — kind: 'biome'.
  bitumen:    { kind: 'deposits', bg: 0,    n: 10, mtn: false },
};

// Во сколько раз гекс данного типа богаче среднего — v2 hexBioWeight для аналога.
function hexWeight(key, h) {
  const T = h.type;
  // ДОПУЩЕНИЕ: у газового гиганта вихрь поднимает вещество из глубины, тёмный пояс беднее.
  // Проверка идёт ДО switch: иначе биомные ресурсы ушли бы по весам твёрдой поверхности.
  if (T === 'storm' || T === 'belt' || T === 'clouds') return { storm: 2, belt: 0.7, clouds: 1 }[T];
  switch (key) {
    case 'silicates':  return { mountains: 2.5, hills: 1.6, water: 0.3, icecap: 0.5 }[T] ?? 1; // v2 силикаты
    case 'silicon':    return { mountains: 2.0, hills: 1.3 }[T] ?? 1;                             // v2 железо
    case 'flora':      return { jungle: 2.5, forest: 2.0, steppe: 1.2, water: 0.5 }[T] ?? 0.05;   // v2 биомасса
    case 'microbiota': return { water: 1.8, jungle: 1.0, steppe: 0.8 }[T] ?? 0.1;                 // v2 фосфаты
    case 'bitumen':    return { wasteland: 1.2, water: 0.8, mountains: 0.5 }[T] ?? 0.2;           // v2 битумы
  }
  return 1;
}

const DEPOSIT_SPREAD = [0.6, 1.8]; // разброс богатства месторождений между собой

// Среднее число гексов на планету по галактике (замер: 7 гексов у 7 % планет, 19 у 3 %,
// 37 у 41 %, 61 у 49 % — в среднем 46,1). От него нормируется норма ресурсов, см. ниже.
const HEX_REF = 46;

function distributeHexResources(rng, hexes, planet, env) {
  // НОРМА РЕСУРСОВ НОРМИРУЕТСЯ ПО ЧИСЛУ ГЕКСОВ (решение пользователя: «чтоб более мелкие
  // планеты не имели большей концентрации, норму ресурсов нужно повышать или резать от
  // среднего значения по числу гексов»).
  //
  // Состав планеты из таблицы — это ДОЛЯ (сумма по планете ≤ 100), то есть концентрация, а не
  // количество. Раньше её делили на число гексов: один и тот же состав у астероида из 7 гексов
  // и у планеты из 61 давал в девять раз более густой гекс на астероиде. Теперь запас на карту
  // = состав × (гексов / 46): концентрация в гексе одинакова, а большая планета богаче В СУММЕ,
  // потому что гексов больше. Это и физически верно, и убирает из разлёта множитель ×9.
  //
  // Платой идёт прежний инвариант «сумма по гексам ТОЧНО равна составу»: теперь она равна
  // составу × (гексов / 46). Для карты среднего размера ничего не изменилось.
  const sizeK = hexes.length / HEX_REF;
  RESOURCES.forEach((r, i) => {
    const total = Math.round(planet.composition[i].value * 100 * sizeK);
    if (total <= 0) return;
    let rule = HEX_RULES[r.key];
    if (planet.type === 'core' && r.key === 'superdense') rule = { kind: 'deposits', bg: 1, n: 0, mtn: false }; // ядро однородно
    if (r.key === 'tritium' && !env.atmo) rule = { kind: 'deposits', bg: 0.15, n: 5, mtn: true }; // реголит копит локально
    // ГАЗОВЫЙ ГИГАНТ — БЕЗ МЕСТОРОЖДЕНИЙ: в облаках не бывает жил, вещество рассеяно самой
    // атмосферой. В v2 это решали радикально — гекс-карты у газовых гигантов не было вовсе, а
    // газ был одним числом на планету («рассеян по смыслу самого источника»). В v3 карта есть
    // (с неё черпает корабль, ТЗ §8.13), но правило «фон + 2-4 жилы» перенеслось механически и
    // давало дичь: на Даннис-680 i один гекс пояса держал 26 % всего водорода планеты —
    // рекорд 12 870 против среднего 82. Теперь по облакам ровно, с лёгким перекосом по полосам
    // (вихрь богаче, тёмный пояс беднее — hexWeight).
    if (planet.type === 'gas') rule = { kind: 'biome' };
    if (rule.kind === 'biome') {
      const amt = largestRemainderAllocate(total, hexes.map(h => hexWeight(r.key, h) * (0.85 + rng() * 0.3)));
      hexes.forEach((h, k) => { if (amt[k]) h.res[r.key] = (h.res[r.key] || 0) + amt[k]; });
      return;
    }
    const bgPool = Math.round(total * rule.bg), depPool = total - bgPool;
    const bg = largestRemainderAllocate(bgPool, hexes.map(() => 0.65 + rng() * 0.7));
    hexes.forEach((h, k) => { if (bg[k]) h.res[r.key] = (h.res[r.key] || 0) + bg[k]; });
    if (!rule.n || depPool <= 0) return;
    // ОТСТУПЛЕНИЕ ОТ ПРАВИЛ v2 (решение пользователя: «даже если берётся максимум по всей
    // выборке, гекс с 4000 — это очень много и дисбаланс»). В v2 доли месторождений делились по
    // ЭКСПОНЕНТЕ (-log(u)) — хвост неограничен, и одно месторождение забирало почти весь запас:
    // на рекордных планетах в одном гексе оказывалось до 60-70 %% всего ресурса планеты, то есть
    // полсотни средних гексов. Делим тем же разбросом, что и фон: 0,6…1,8, то есть богатейшее
    // месторождение вдвое-втрое богаче бедного, но не в полсотни раз. DEPOSIT_SPREAD — ручка.
    // Месторождений не может быть больше, чем гексов на карте: на астероиде из семи гексов
    // восемь месторождений не разместить, а если просто оборвать цикл, часть запаса пропадёт и
    // сумма по гексам перестанет сходиться. Лишние месторождения просто сливаются в имеющиеся
    // гексы — на мелком теле распределение становится почти ровным, что и требовалось.
    const nDep = Math.min(rule.n, hexes.length);
    const dep = largestRemainderAllocate(depPool, Array.from({ length: nDep }, () => DEPOSIT_SPREAD[0] + rng() * (DEPOSIT_SPREAD[1] - DEPOSIT_SPREAD[0])));
    const used = new Set();
    for (let d = 0; d < nDep; d++) {
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
