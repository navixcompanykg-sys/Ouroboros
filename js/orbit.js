// Орбитальная механика для экономного полёта: корабль включает двигатель коротко, а дальше летит
// по инерции по дуге под притяжением звезды (настоящий μ — см. MU_SUN в data.js). Плоская задача.
//  - lambert: какая скорость нужна в точке r1, чтобы за время tof по дуге прийти в r2;
//  - planEco: прокладка — перебор времени старта (окно) и времени полёта, напрямую или через
//    гравманёвр у ближайших планет; цель — меньше топлива (Δv) с небольшой ценой времени.
// Планеты притягивают корабль только у самих себя (сфера влияния настоящей планеты крошечная):
// это учтено «склейкой дуг» — взлёт/захват с выигрышем Оберта и мгновенный поворот при пролёте.

// Функции Штумпфа.
function stumpffC(z) {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24;
}
function stumpffS(z) {
  if (z > 1e-6) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120;
}

// Задача Ламберта в универсальных переменных (Curtis, алг. 5.2), один виток, прямой ход
// (против часовой, как планеты). r1, r2 — {x, y}; возвращает {v1, v2} или null.
function lambert(r1, r2, tof, mu) {
  const R1 = Math.hypot(r1.x, r1.y), R2 = Math.hypot(r2.x, r2.y);
  const cross = r1.x * r2.y - r1.y * r2.x, cosd = (r1.x * r2.x + r1.y * r2.y) / (R1 * R2);
  let dth = Math.acos(Math.max(-1, Math.min(1, cosd)));
  if (cross < 0) dth = 2 * Math.PI - dth;
  if (dth < 1e-4 || Math.abs(dth - Math.PI) < 1e-4) return null; // вырожденные случаи
  const A = Math.sin(dth) * Math.sqrt(R1 * R2 / (1 - Math.cos(dth)));
  const yz = z => R1 + R2 + A * (z * stumpffS(z) - 1) / Math.sqrt(stumpffC(z));
  const smu = Math.sqrt(mu);
  const F = z => { const y = yz(z), C = stumpffC(z); return (y / C) ** 1.5 * stumpffS(z) + A * Math.sqrt(y) - smu * tof; };
  // Производная F по z (Curtis, ф. 5.43) — для метода Ньютона.
  const dF = (z, y) => {
    if (Math.abs(z) < 1e-6) return Math.SQRT2 / 40 * y ** 1.5 + A / 8 * (Math.sqrt(y) + A * Math.sqrt(1 / (2 * y)));
    const C = stumpffC(z), S = stumpffS(z);
    return (y / C) ** 1.5 * (1 / (2 * z) * (C - 3 * S / (2 * C)) + 3 * S * S / (4 * C)) +
      A / 8 * (3 * S / C * Math.sqrt(y) + A * Math.sqrt(C / y));
  };
  let lo = -150, hi = 4 * Math.PI * Math.PI - 1e-4;
  if (yz(lo) < 0) { // y должен быть > 0 — поднимаем нижнюю границу до первой точки с y > 0
    let a = lo, b = hi;
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (yz(m) < 0) a = m; else { b = m; if (m - a < 1) break; } }
    lo = b;
  }
  if (F(lo) > 0 || F(hi) < 0) return null;
  // Ньютон со страховкой: шаг за пределы вилки [lo, hi] заменяется делением пополам.
  let z = Math.max(lo, Math.min(hi, 0));
  const tol = 1e-10 * smu * tof;
  for (let i = 0; i < 50; i++) {
    const y0 = yz(z), f0 = F(z);
    if (Math.abs(f0) < tol) break;
    if (f0 > 0) hi = z; else lo = z;
    let zn = z - f0 / dF(z, y0);
    if (!(zn > lo && zn < hi) || yz(zn) <= 0) zn = (lo + hi) / 2;
    z = zn;
  }
  const y = yz(z);
  const f = 1 - y / R1, g = A * Math.sqrt(y / mu), gd = 1 - y / R2;
  if (!isFinite(g) || Math.abs(g) < 1e-12) return null;
  return {
    v1: { x: (r2.x - f * r1.x) / g, y: (r2.y - f * r1.y) / g },
    v2: { x: (gd * r2.x - r1.x) / g, y: (gd * r2.y - r1.y) / g },
  };
}

// Проходит ли дуга (r1, v1) → r2 ближе rMin к звезде: перицентр ближе и лежит на участке.
function arcTooClose(r1, v1, r2, mu, rMin) {
  const R = Math.hypot(r1.x, r1.y), h = r1.x * v1.y - r1.y * v1.x;
  const rv = r1.x * v1.x + r1.y * v1.y, v2 = v1.x * v1.x + v1.y * v1.y;
  const ex = ((v2 - mu / R) * r1.x - rv * v1.x) / mu, ey = ((v2 - mu / R) * r1.y - rv * v1.y) / mu;
  const e = Math.hypot(ex, ey), rp = h * h / mu / (1 + e);
  if (rp >= rMin) return false;
  if (e < 1e-9) return true;
  const nu = r => { const a = Math.atan2((ex * r.y - ey * r.x) * Math.sign(h || 1), ex * r.x + ey * r.y); return a < 0 ? a + 2 * Math.PI : a; };
  const n1 = nu(r1), n2 = nu(r2), dn = ((n2 - n1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return n1 + dn >= 2 * Math.PI; // перицентр (ν = 0 ≡ 2π) пройден на участке
}

// Движение под притяжением звезды (μ в центре) — скоростной Верле с мелкими подшагами.
function propagate(s, dt, mu) {
  const n = Math.max(1, Math.ceil(dt / 0.02)), h = dt / n;
  let { x, y, vx, vy } = s;
  const acc = () => { const r2 = x * x + y * y, r = Math.sqrt(r2), k = -mu / (r2 * r); return [k * x, k * y]; };
  let [ax, ay] = acc();
  for (let i = 0; i < n; i++) {
    vx += ax * h / 2; vy += ay * h / 2;
    x += vx * h; y += vy * h;
    [ax, ay] = acc();
    vx += ax * h / 2; vy += ay * h / 2;
  }
  s.x = x; s.y = y; s.vx = vx; s.vy = vy;
}

// Δv перехода между низкой орбитой планеты и дугой с избытком скорости vInf (взлёт или захват) —
// с выигрышем Оберта: двигатель работает глубоко в колодце планеты.
function oberthDv(vInf, p) {
  const rp = p.rReal * ECO.parkK, vc = Math.sqrt(p.mu / rp);
  return Math.sqrt(vInf * vInf + 2 * vc * vc) - vc;
}

// Гравманёвр у планеты: поворот избытка скорости от vin к vout. Притяжение поворачивает
// бесплатно не больше чем на δmax (перицентр не ниже ECO.flybyK радиуса); разницу модулей и
// недостающий поворот добирает двигатель. Возвращает Δv двигателя.
function flybyDv(vin, vout, p) {
  const a = Math.hypot(vin.x, vin.y), b = Math.hypot(vout.x, vout.y);
  if (a < 1e-9 || b < 1e-9) return Math.abs(a - b);
  const rp = p.rReal * ECO.flybyK;
  const dmax = 2 * Math.asin(1 / (1 + rp * a * a / p.mu));
  const ang = Math.acos(Math.max(-1, Math.min(1, (vin.x * vout.x + vin.y * vout.y) / (a * b))));
  if (ang <= dmax) return Math.abs(a - b);
  // Не хватило поворота: доворачиваем двигателем — разница между достижимым и нужным вектором.
  const ex = ang - dmax; // недоворот, рад
  return Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(ex));
}

// Параметры прокладки. Допущения.
const ECO = {
  maxT: 300,        // полёт не дольше, с (время игры)
  waits: [0, 3, 8, 15, 25, 40, 60, 90], // варианты ожидания окна старта, с
  tofN: 14,         // вариантов времени полёта (геометрически от tofMin до maxT)
  tofMin: 3,
  timeWeight: 0.0005, // цена секунды в Δv (ед./с) — чтобы не выбирать «чуть экономнее, но вдвое дольше»
  flybyBodies: 3,   // сколько ближайших планет пробовать для манёвра (2 у старта + 1 у цели)
  flybyWaits: [0, 8, 25, 60], // окна старта для манёвра — реже, чем для прямого
  parkK: 1.15,      // низкая орбита — 1,15 настоящего радиуса планеты
  flybyK: 1.1,      // пролёт не ниже 1,1 радиуса
  starK: 1.05,      // дуга не ближе 1,05 запретного радиуса звезды
};

function geomRange(a, b, n) { const out = []; for (let i = 0; i < n; i++) out.push(a * (b / a) ** (i / (n - 1))); return out; }

// Прокладка экономного курса.
// w = {mu, excl, planets, pos(p, t), vel(p, t)}; start = {planet} | {x, y, vx, vy, moving};
// target = {planet} | {x, y}; t — сейчас. Возвращает план или null.
// opts.keep — сохранить текущую скорость (после газа): импульс старта ×8 дороже — выбирается дуга,
// на которой скорость корабля почти не меняется (набранное не гасится, прилёт раньше).
function planEco(w, start, target, t, opts = {}) {
  const t0 = performance.now();
  const sp = start.planet, tp = target.planet;
  const waits = start.moving ? [0] : ECO.waits;
  const tofs = geomRange(ECO.tofMin, ECO.maxT, ECO.tofN);
  const rMin = w.excl * ECO.starK;
  const startAt = tt => sp ? { r: w.pos(sp, tt), v: w.vel(sp, tt) } : { r: { x: start.x, y: start.y }, v: { x: start.vx || 0, y: start.vy || 0 } };
  const endAt = tt => tp ? { r: w.pos(tp, tt), v: w.vel(tp, tt) } : { r: { x: target.x, y: target.y }, v: { x: 0, y: 0 } };
  const depDv = (v1, s) => sp ? oberthDv(Math.hypot(v1.x - s.v.x, v1.y - s.v.y), sp) : Math.hypot(v1.x - s.v.x, v1.y - s.v.y);
  const arrDv = (v2, e) => tp ? oberthDv(Math.hypot(v2.x - e.v.x, v2.y - e.v.y), tp) : Math.hypot(v2.x, v2.y);
  let best = null, tries = 0;
  const consider = c => { c.cost = c.dv + (opts.keep ? 7 * c.dvDep : 0) + ECO.timeWeight * (c.wait + c.tof); if (!best || c.cost < best.cost) best = c; };

  // Напрямую.
  const direct = (wait, tof) => {
    const ta = t + wait, s = startAt(ta), e = endAt(ta + tof);
    tries++;
    const L = lambert(s.r, e.r, tof, w.mu);
    if (!L || arcTooClose(s.r, L.v1, e.r, w.mu, rMin)) return null;
    const dvDep = depDv(L.v1, s), dvArr = arrDv(L.v2, e);
    return { wait, tof, dv: dvDep + dvArr, dvDep, dvArr, legs: [{ ta, tb: ta + tof, r1: s.r, v1: L.v1, r2: e.r, v2: L.v2, end: tp || null }] };
  };
  for (const wait of waits) for (const tof of tofs) { const c = direct(wait, tof); if (c) consider(c); }
  // Уточнение вокруг лучшего прямого — покоординатный поиск.
  if (best) {
    let { wait, tof } = best, st = 0.25;
    for (let i = 0; i < 24; i++) {
      let moved = false;
      for (const [dw, df] of [[0, 1 + st], [0, 1 / (1 + st)], [st * 20, 1], [-st * 20, 1]]) {
        const nw = start.moving ? 0 : Math.min(ECO.waits[ECO.waits.length - 1], Math.max(0, wait + dw)), nf = Math.min(ECO.maxT, Math.max(ECO.tofMin, tof * df));
        const c = direct(nw, nf);
        if (c) { const old = best; consider(c); if (best !== old) { wait = nw; tof = nf; moved = true; } }
      }
      if (!moved) st /= 2;
    }
  }
  const directBest = best;

  // Через гравманёвр у ближайших планет.
  const s0 = startAt(t).r, e0 = endAt(t).r;
  const cand = w.planets.filter(p => p !== sp && p !== tp && p.type !== 'asteroid');
  const dist = (p, r) => { const q = w.pos(p, t); return Math.hypot(q.x - r.x, q.y - r.y); };
  const nearS = [...cand].sort((a, b) => dist(a, s0) - dist(b, s0)).slice(0, ECO.flybyBodies - 1);
  const nearE = [...cand].filter(p => !nearS.includes(p)).sort((a, b) => dist(a, e0) - dist(b, e0)).slice(0, 1);
  const legT = geomRange(ECO.tofMin, ECO.maxT * 0.8, 9);
  for (const B of [...nearS, ...nearE]) {
    for (const wait of (start.moving ? [0] : ECO.flybyWaits)) for (const t1 of legT) for (const t2 of legT) {
      if (t1 + t2 > ECO.maxT) continue;
      const ta = t + wait, s = startAt(ta), rb = w.pos(B, ta + t1), vb = w.vel(B, ta + t1), e = endAt(ta + t1 + t2);
      tries += 2;
      const L1 = lambert(s.r, rb, t1, w.mu); if (!L1 || arcTooClose(s.r, L1.v1, rb, w.mu, rMin)) continue;
      const L2 = lambert(rb, e.r, t2, w.mu); if (!L2 || arcTooClose(rb, L2.v1, e.r, w.mu, rMin)) continue;
      const dvDep = depDv(L1.v1, s), dvArr = arrDv(L2.v2, e);
      const dvFly = flybyDv({ x: L1.v2.x - vb.x, y: L1.v2.y - vb.y }, { x: L2.v1.x - vb.x, y: L2.v1.y - vb.y }, B);
      consider({ wait, tof: t1 + t2, dv: dvDep + dvFly + dvArr, dvDep, dvArr, dvFly, flyby: B,
        legs: [{ ta, tb: ta + t1, r1: s.r, v1: L1.v1, r2: rb, end: B, flyby: true },
               { ta: ta + t1, tb: ta + t1 + t2, r1: rb, v1: L2.v1, r2: e.r, v2: L2.v2, end: tp || null }] });
    }
  }
  if (!best) return null;
  best.direct = directBest;
  best.ms = performance.now() - t0;
  best.tries = tries;
  // Линия курса для отрисовки — дуги, проигранные численно.
  best.path = [];
  for (const L of best.legs) {
    const s = { x: L.r1.x, y: L.r1.y, vx: L.v1.x, vy: L.v1.y }, n = 60, dt = (L.tb - L.ta) / n;
    best.path.push({ x: s.x, y: s.y });
    for (let i = 0; i < n; i++) { propagate(s, dt, w.mu); best.path.push({ x: s.x, y: s.y }); }
  }
  return best;
}
