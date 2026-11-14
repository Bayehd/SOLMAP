// Safest-route planner. Pure functions over a window of the 20 m Jezero terrain model, so they can be
// tested without a browser. Data loading is in loadGrid.ts, the React side in useRoutePlanner.ts.
//
// What the cost of a step is made of (see config.ts for the weights and their meaning):
//   effort   Minetti-style walking cost for the grade of the step (uphill and steep downhill cost more)
//   slope    extra cost rising towards the no-go slope; cells at or above the no-go slope are blocked
//   rough    extra cost on bumpy ground
//   radio    extra cost without radio line of sight to the base antenna
//   radiation extra cost where the MODELLED radiation exposure is higher
//   science  discount near CRISM mineral detections and Perseverance sample sites
// Cells with no elevation data are blocked: we never plan through nothing, and never treat it as flat.
import { ASSUMPTIONS, type Weights } from './config';

export const MARS_RADIUS_M = 3396190;
export const M_PER_DEG = (MARS_RADIUS_M * Math.PI) / 180;

export type Extent = { xmin: number; ymin: number; xmax: number; ymax: number };
export type LonLat = { lon: number; lat: number };
export type Limits = { cautionDeg: number; nogoDeg: number };
export type SamplePoint = { lon: number; lat: number; name: string; number: number };

export interface Grid {
  width: number;
  height: number;
  extent: Extent;
  dxM: number; // cell size east-west, m
  dyM: number; // cell size north-south, m
  z: Float32Array; // elevation, m. NaN = no data
  minerals: Uint8Array; // CRISM class index + 1, 0 = none or no coverage
  samples: SamplePoint[];
  // Derived by prepareGrid():
  slope: Float32Array; // degrees, NaN = unknown
  rough: Float32Array; // 0..1
  los: Uint8Array; // 1 line of sight to base, 0 blocked, 2 unknown
  rad: Float32Array; // 0..1 relative modelled radiation (NaN unknown)
  sci: Float32Array; // 0..1 science bonus
  radioBaseOk: boolean;
}

export interface RouteStats {
  distanceM: number;
  climbM: number;
  descentM: number;
  avgSlopeDeg: number;
  maxSlopeDeg: number;
  cautionM: number; // length on caution slopes
  nogoM: number; // length on no-go slopes or no data (only the direct line can have any)
  timeMin: number;
  losPct: number | null; // % of the length with radio line of sight to the base (null if unknown)
  radiation: number | null; // mean relative modelled radiation 0..1 along the route
  samplesNear: string[]; // sample sites within the science radius
  mineralCells: number; // cells on the route with a CRISM detection
}

export interface RouteResult {
  path: [number, number][]; // [lon, lat]
  stats: RouteStats;
  profile: { distM: number[]; z: number[]; slope: number[]; los: number[] };
}

export interface Plan {
  safest: RouteResult | null;
  direct: RouteResult;
  reason?: string;
  radiationWindowMean: number | null;
  cells: number;
  computeMs: number;
}

// ---------- geometry helpers ----------

export const mPerDegLon = (lat: number) => M_PER_DEG * Math.cos((lat * Math.PI) / 180);

export function lonLatToCell(g: Grid, lon: number, lat: number): [number, number] {
  const { xmin, ymin, xmax, ymax } = g.extent;
  const c = Math.min(g.width - 1, Math.max(0, Math.floor(((lon - xmin) / (xmax - xmin)) * g.width)));
  const r = Math.min(g.height - 1, Math.max(0, Math.floor(((ymax - lat) / (ymax - ymin)) * g.height)));
  return [r, c];
}

export function cellToLonLat(g: Grid, r: number, c: number): [number, number] {
  const { xmin, ymin, xmax, ymax } = g.extent;
  return [xmin + ((c + 0.5) / g.width) * (xmax - xmin), ymax - ((r + 0.5) / g.height) * (ymax - ymin)];
}

// ---------- derived rasters ----------

/** Slope in degrees (Horn's 3x3 method, the one GIS packages use). NaN where any neighbour has no data. */
export function computeSlope(g: Grid): Float32Array {
  const { width: W, height: H, z, dxM, dyM } = g;
  const out = new Float32Array(W * H).fill(NaN);
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      const i = r * W + c;
      const a = z[i - W - 1], b = z[i - W], cc = z[i - W + 1];
      const d = z[i - 1], f = z[i + 1];
      const gg = z[i + W - 1], h = z[i + W], k = z[i + W + 1];
      if (Number.isNaN(a + b + cc + d + f + gg + h + k + z[i])) continue;
      const dzdx = (cc + 2 * f + k - (a + 2 * d + gg)) / (8 * dxM);
      const dzdy = (gg + 2 * h + k - (a + 2 * b + cc)) / (8 * dyM);
      out[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return out;
}

/** Sum over a (2n+1)^2 window of v (NaN skipped) and the count of valid cells, via integral images. */
function boxSums(v: ArrayLike<number>, W: number, H: number, n: number) {
  const iw = W + 1;
  const sum = new Float64Array(iw * (H + 1));
  const cnt = new Float64Array(iw * (H + 1));
  for (let r = 0; r < H; r++) {
    let rs = 0, rc = 0;
    for (let c = 0; c < W; c++) {
      const x = v[r * W + c];
      if (!Number.isNaN(x)) { rs += x; rc += 1; }
      sum[(r + 1) * iw + c + 1] = sum[r * iw + c + 1] + rs;
      cnt[(r + 1) * iw + c + 1] = cnt[r * iw + c + 1] + rc;
    }
  }
  const at = (arr: Float64Array, r0: number, c0: number, r1: number, c1: number) =>
    arr[r1 * iw + c1] - arr[r0 * iw + c1] - arr[r1 * iw + c0] + arr[r0 * iw + c0];
  return (r: number, c: number) => {
    const r0 = Math.max(0, r - n), r1 = Math.min(H, r + n + 1), c0 = Math.max(0, c - n), c1 = Math.min(W, c + n + 1);
    return { s: at(sum, r0, c0, r1, c1), n: at(cnt, r0, c0, r1, c1) };
  };
}

/** Roughness 0..1: local spread (standard deviation) of slope in a 5x5 window (100 m), 5 degrees = 1. */
export function computeRoughness(slope: Float32Array, W: number, H: number): Float32Array {
  const sq = new Float32Array(slope.length);
  for (let i = 0; i < slope.length; i++) sq[i] = slope[i] * slope[i];
  const s1 = boxSums(slope, W, H, 2);
  const s2 = boxSums(sq, W, H, 2);
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const a = s1(r, c), b = s2(r, c);
      if (a.n < 3) continue;
      const mean = a.s / a.n;
      const sd = Math.sqrt(Math.max(0, b.s / b.n - mean * mean));
      out[r * W + c] = Math.min(1, sd / 5);
    }
  }
  return out;
}

/**
 * Radio line of sight to the base antenna and a sky-view based radiation index, on a coarse lattice
 * (at most ~300x300 nodes), then spread to all cells. Geometry only: straight rays over the terrain with the
 * planet's curvature, no diffraction, no link budget, no orbiter schedule. Same method as
 * scripts/build_jezero_safety_layers.py.
 */
export function computeRadioAndRadiation(g: Grid, base: LonLat) {
  const { width: W, height: H, z, dxM, dyM } = g;
  const los = new Uint8Array(W * H).fill(2);
  const radRaw = new Float32Array(W * H).fill(NaN);
  const [rb, cb] = lonLatToCell(g, base.lon, base.lat);
  const zBase = z[rb * W + cb];
  const baseOk = !Number.isNaN(zBase) && base.lon >= g.extent.xmin && base.lon <= g.extent.xmax && base.lat >= g.extent.ymin && base.lat <= g.extent.ymax;

  let zMin = Infinity;
  for (let i = 0; i < z.length; i++) if (z[i] < zMin) zMin = z[i];

  const k = Math.max(1, Math.ceil(Math.max(W, H) / 300));
  const cellM = Math.min(dxM, dyM);
  const horizonSteps = Math.min(80, Math.max(4, Math.round(ASSUMPTIONS.skyHorizonM / (cellM * k))));
  const dirs = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
  const R2 = 2 * MARS_RADIUS_M;

  for (let r0 = 0; r0 < H; r0 += k) {
    for (let c0 = 0; c0 < W; c0 += k) {
      const r = Math.min(H - 1, r0 + (k >> 1)), c = Math.min(W - 1, c0 + (k >> 1));
      const z0 = z[r * W + c];
      let losV = 2;
      let radV = NaN;
      if (!Number.isNaN(z0)) {
        // Radio: ray from the base antenna to the walker's antenna.
        if (baseOk) {
          const dx = (c - cb) * dxM, dy = (r - rb) * dyM;
          const dist = Math.hypot(dx, dy);
          if (dist < 1) losV = 1;
          else {
            const steps = Math.max(2, Math.ceil(dist / (cellM * 1.5)));
            const a0 = zBase + ASSUMPTIONS.baseAntennaM, a1 = z0 + ASSUMPTIONS.walkerAntennaM;
            losV = 1;
            for (let s = 1; s < steps; s++) {
              const f = s / steps;
              const zz = z[Math.round(rb + (r - rb) * f) * W + Math.round(cb + (c - cb) * f)];
              if (Number.isNaN(zz)) { losV = 2; break; }
              if (zz + (f * (1 - f) * dist * dist) / R2 > a0 + (a1 - a0) * f) { losV = 0; break; }
            }
          }
        }
        // Radiation: how much sky the surrounding terrain blocks (8 directions), and how high we are.
        let blocked = 0, used = 0;
        for (const [dr, dc] of dirs) {
          let maxTan = 0;
          for (let s = 1; s <= horizonSteps; s++) {
            const rr = r + dr * s * k, cc = c + dc * s * k;
            if (rr < 0 || cc < 0 || rr >= H || cc >= W) break;
            const zz = z[rr * W + cc];
            if (Number.isNaN(zz)) continue;
            const d = Math.hypot(dc * s * k * dxM, dr * s * k * dyM);
            const t = (zz - z0 - (d * d) / R2) / d;
            if (t > maxTan) maxTan = t;
          }
          const th = Math.atan(maxTan);
          blocked += Math.sin(th) ** 2;
          used++;
        }
        const svf = 1 - blocked / used;
        radV = (0.4 + 0.6 * svf) * (1 + (ASSUMPTIONS.radiationPerKm * (z0 - zMin)) / 1000);
      }
      for (let rr = r0; rr < Math.min(H, r0 + k); rr++) {
        for (let cc = c0; cc < Math.min(W, c0 + k); cc++) {
          los[rr * W + cc] = losV;
          radRaw[rr * W + cc] = radV;
        }
      }
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of radRaw) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const rad = new Float32Array(W * H).fill(NaN);
  for (let i = 0; i < rad.length; i++) if (!Number.isNaN(radRaw[i])) rad[i] = hi > lo ? (radRaw[i] - lo) / (hi - lo) : 0;
  return { los, rad, baseOk };
}

/** Science bonus 0..1: near a Perseverance sample site, or surrounded by CRISM mineral detections. */
export function computeScience(g: Grid): Float32Array {
  const { width: W, height: H, minerals, samples, dxM, dyM } = g;
  const out = new Float32Array(W * H);
  const det = new Float32Array(W * H);
  for (let i = 0; i < det.length; i++) det[i] = minerals[i] > 0 ? 1 : 0;
  const box = boxSums(det, W, H, 2);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const b = box(r, c); out[r * W + c] = b.n ? b.s / b.n : 0; }
  const R = ASSUMPTIONS.scienceRadiusM;
  for (const s of samples) {
    const [sr, sc] = lonLatToCell(g, s.lon, s.lat);
    const nr = Math.ceil(R / dyM), nc = Math.ceil(R / dxM);
    for (let r = Math.max(0, sr - nr); r <= Math.min(H - 1, sr + nr); r++) {
      for (let c = Math.max(0, sc - nc); c <= Math.min(W - 1, sc + nc); c++) {
        const d = Math.hypot((c - sc) * dxM, (r - sr) * dyM);
        if (d <= R) out[r * W + c] = Math.max(out[r * W + c], 1 - d / R);
      }
    }
  }
  return out;
}

/** Fill in everything derived from elevation, minerals and sample points. Call once per loaded window. */
export function prepareGrid(g: Grid, base: LonLat) {
  g.slope = computeSlope(g);
  g.rough = computeRoughness(g.slope, g.width, g.height);
  const rr = computeRadioAndRadiation(g, base);
  g.los = rr.los;
  g.rad = rr.rad;
  g.radioBaseOk = rr.baseOk;
  g.sci = computeScience(g);
}

// ---------- cost model ----------

/** Walking effort relative to flat ground for a step of the given grade (rise/run). Minetti et al. 2002, terrestrial. */
export function gradeFactor(grade: number): number {
  const i = Math.max(-0.45, Math.min(0.45, grade));
  return (280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5) / 2.5;
}
const F_MIN = (() => {
  let m = Infinity;
  for (let i = -0.45; i <= 0.45; i += 0.005) m = Math.min(m, gradeFactor(i));
  return m;
})();

/** Per-cell cost multiplier (>= 0.4). Infinity = blocked. */
export function costMultipliers(g: Grid, w: Weights, lim: Limits): Float32Array {
  const out = new Float32Array(g.width * g.height);
  const span = Math.max(1, lim.nogoDeg - ASSUMPTIONS.comfortSlopeDeg);
  for (let i = 0; i < out.length; i++) {
    const s = g.slope[i];
    if (Number.isNaN(s) || s >= lim.nogoDeg) { out[i] = Infinity; continue; }
    const slopePen = w.slope * (Math.max(0, s - ASSUMPTIONS.comfortSlopeDeg) / span) ** 2;
    const rad = Number.isNaN(g.rad[i]) ? 0 : g.rad[i];
    const m = 1 + slopePen + w.roughness * g.rough[i] + w.radiation * rad + (g.los[i] === 0 ? w.radio : 0) - w.science * g.sci[i];
    out[i] = Math.max(0.4, m);
  }
  return out;
}

class MinHeap {
  private k: Float64Array;
  private v: Int32Array;
  size = 0;
  constructor(cap = 1 << 16) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); }
  push(key: number, val: number) {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.size * 2); k2.set(this.k); this.k = k2;
      const v2 = new Int32Array(this.size * 2); v2.set(this.v); this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const key = this.k[--this.size], val = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

/** Least-cost cell path from start to end over the cost multipliers. Null when no path avoids blocked cells. */
export function findPath(g: Grid, mult: Float32Array, start: [number, number], end: [number, number]): number[] | null {
  const { width: W, height: H, z, dxM, dyM } = g;
  const s = start[0] * W + start[1], t = end[0] * W + end[1];
  if (!Number.isFinite(mult[s]) || !Number.isFinite(mult[t])) return null;
  const gScore = new Float32Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const done = new Uint8Array(W * H);
  const heap = new MinHeap();
  // Admissible heuristic: straight distance at the cheapest possible effort and multiplier.
  const hScale = F_MIN * 0.4;
  const h = (r: number, c: number) => Math.hypot((c - end[1]) * dxM, (r - end[0]) * dyM) * hScale;
  gScore[s] = 0;
  heap.push(h(start[0], start[1]), s);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    const r = (u / W) | 0, c = u - r * W;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
        const v = nr * W + nc;
        if (done[v] || !Number.isFinite(mult[v])) continue;
        const d = Math.hypot(dc * dxM, dr * dyM);
        const cost = d * gradeFactor((z[v] - z[u]) / d) * ((mult[u] + mult[v]) / 2);
        const ng = gScore[u] + cost;
        if (ng < gScore[v]) { gScore[v] = ng; prev[v] = u; heap.push(ng + h(nr, nc), v); }
      }
    }
  }
  if (!Number.isFinite(gScore[t])) return null;
  const path: number[] = [];
  for (let v = t; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

/** Cells on the straight line between two cells. */
export function straightCells(g: Grid, a: [number, number], b: [number, number]): number[] {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) || 1;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const idx = Math.round(a[0] + ((b[0] - a[0]) * i) / n) * g.width + Math.round(a[1] + ((b[1] - a[1]) * i) / n);
    if (out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

/** Numbers and profile for a cell path. */
export function describeRoute(g: Grid, cells: number[], lim: Limits): RouteResult {
  const W = g.width;
  let dist = 0, climb = 0, descent = 0, slopeSum = 0, slopeLen = 0, maxSlope = 0, caution = 0, nogo = 0, effort = 0;
  let losLen = 0, losKnown = 0, radSum = 0, radN = 0, minerals = 0;
  const profile = { distM: [] as number[], z: [] as number[], slope: [] as number[], los: [] as number[] };
  const path: [number, number][] = [];
  for (let i = 0; i < cells.length; i++) {
    const u = cells[i], r = (u / W) | 0, c = u - r * W;
    path.push(cellToLonLat(g, r, c));
    let step = 0;
    if (i > 0) {
      const p = cells[i - 1], pr = (p / W) | 0, pc = p - pr * W;
      step = Math.hypot((c - pc) * g.dxM, (r - pr) * g.dyM);
      const rise = g.z[u] - g.z[p];
      if (!Number.isNaN(rise)) { if (rise > 0) climb += rise; else descent -= rise; effort += step * gradeFactor(rise / step); }
      else effort += step;
      dist += step;
      const s = g.slope[u];
      if (Number.isNaN(s) || s >= lim.nogoDeg) nogo += step;
      else if (s >= lim.cautionDeg) caution += step;
      if (!Number.isNaN(s)) { slopeSum += s * step; slopeLen += step; maxSlope = Math.max(maxSlope, s); }
      if (g.los[u] !== 2) { losKnown += step; if (g.los[u] === 1) losLen += step; }
    }
    if (!Number.isNaN(g.rad[u])) { radSum += g.rad[u]; radN++; }
    if (g.minerals[u] > 0) minerals++;
    profile.distM.push(dist);
    profile.z.push(g.z[u]);
    profile.slope.push(g.slope[u]);
    profile.los.push(g.los[u]);
  }
  // Sample sites the route passes close to.
  const near: string[] = [];
  for (const sm of g.samples) {
    let best = Infinity;
    for (const [lon, lat] of path) {
      const d = Math.hypot((lon - sm.lon) * mPerDegLon(sm.lat), (lat - sm.lat) * M_PER_DEG);
      if (d < best) best = d;
    }
    if (best <= ASSUMPTIONS.scienceRadiusM) near.push(`#${sm.number} ${sm.name}`);
  }
  return {
    path,
    profile,
    stats: {
      distanceM: dist, climbM: climb, descentM: descent,
      avgSlopeDeg: slopeLen ? slopeSum / slopeLen : NaN,
      maxSlopeDeg: maxSlope, cautionM: caution, nogoM: nogo,
      timeMin: effort / ((ASSUMPTIONS.walkSpeedKmh * 1000) / 60),
      losPct: g.radioBaseOk && losKnown > 0 ? (100 * losLen) / losKnown : null,
      radiation: radN ? radSum / radN : null,
      samplesNear: near,
      mineralCells: minerals,
    },
  };
}

/** Safest route and the straight line between the same two points, on a prepared grid. */
export function planRoute(g: Grid, a: LonLat, b: LonLat, w: Weights, lim: Limits): Plan {
  const t0 = performance.now();
  const sCell = lonLatToCell(g, a.lon, a.lat), eCell = lonLatToCell(g, b.lon, b.lat);
  const direct = describeRoute(g, straightCells(g, sCell, eCell), lim);
  const mult = costMultipliers(g, w, lim);
  let reason: string | undefined;
  let safest: RouteResult | null = null;
  if (!Number.isFinite(mult[sCell[0] * g.width + sCell[1]])) reason = 'The start point is on ground that is too steep or has no elevation data.';
  else if (!Number.isFinite(mult[eCell[0] * g.width + eCell[1]])) reason = 'The end point is on ground that is too steep or has no elevation data.';
  else {
    const cells = findPath(g, mult, sCell, eCell);
    if (cells) safest = describeRoute(g, cells, lim);
    else reason = `No route avoids slopes of ${lim.nogoDeg}° or more (or ground with no data) between these points.`;
  }
  let rs = 0, rn = 0;
  for (const v of g.rad) if (!Number.isNaN(v)) { rs += v; rn++; }
  return { safest, direct, reason, radiationWindowMean: rn ? rs / rn : null, cells: g.width * g.height, computeMs: performance.now() - t0 };
}
