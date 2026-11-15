// Mission report: what the report on the Earth page shows about a route, built from a RouteResult.
// A walked route comes from the route planner; with none chosen, the report uses the rover's own traverse.
import ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import { publicUrl } from '../map/mars';
import { insideSite, type Site } from '../map/sites';
import { LIMITS } from './config';
import { loadGrid } from './loadGrid';
import { M_PER_DEG, cellToLonLat, describeRoute, lonLatToCell, mPerDegLon, prepareGrid, straightCells, type RouteResult, type SamplePoint } from './planner';

export type ReportKind = 'safest' | 'traverse';

export interface ReportSource {
  kind: ReportKind;
  route: RouteResult;
  /** Every sample of the site, for the little map; the report lists only those the route passes. */
  allSamples: SamplePoint[];
}

export interface HazardStretch {
  fromM: number;
  toM: number;
  maxDeg: number | null; // null: no elevation data there
}

/** Stretches of the route on slopes at or above the caution slope, or with no data, merged; steepest first. */
export function hazardStretches(route: RouteResult, cautionDeg = LIMITS.cautionDeg): HazardStretch[] {
  const { distM, slope } = route.profile;
  const out: HazardStretch[] = [];
  let cur: HazardStretch | null = null;
  for (let i = 1; i < slope.length; i++) {
    const s = slope[i];
    if (Number.isNaN(s) || s >= cautionDeg) {
      if (!cur) cur = { fromM: distM[i - 1], toM: distM[i], maxDeg: Number.isNaN(s) ? null : s };
      else {
        cur.toM = distM[i];
        if (!Number.isNaN(s)) cur.maxDeg = Math.max(cur.maxDeg ?? 0, s);
      }
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.sort((a, b) => (b.maxDeg ?? 99) - (a.maxDeg ?? 99));
}

/** Distance along the route to its steepest cell, in metres. */
export function steepestAtM(route: RouteResult): number | null {
  const { distM, slope } = route.profile;
  let best = -1, at: number | null = null;
  slope.forEach((s, i) => { if (!Number.isNaN(s) && s > best) { best = s; at = distM[i]; } });
  return at;
}

/** The rover's own traverse at a site (what it really drove, inside the 20 m terrain model), described like a walked route. */
export async function traverseSource(site: Site): Promise<ReportSource> {
  const gj = await fetch(publicUrl(site.files.traverse)).then((r) => r.json());
  const lines: [number, number][][] = [];
  for (const f of gj.features ?? []) {
    if (f.geometry.type === 'LineString') lines.push(f.geometry.coordinates);
    else if (f.geometry.type === 'MultiLineString') lines.push(...f.geometry.coordinates);
  }
  const pts = lines.flat().filter(([lon, lat]) => insideSite(site, { lon, lat }));
  if (pts.length < 2) throw new Error(`No ${site.rover} route inside the ${site.short} terrain model.`);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [x, y] of pts) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  const elevation = new ImageryTileLayer({ url: publicUrl(site.files.dtm) });
  const minerals = site.files.minerals ? new ImageryTileLayer({ url: publicUrl(site.files.minerals) }) : undefined;
  try {
    await Promise.all([elevation.load(), minerals?.load()]);
    const g = await loadGrid(site, elevation, minerals, [{ lon: xmin, lat: ymin }, { lon: xmax, lat: ymax }, site.landing]);
    await new Promise((r) => setTimeout(r, 0));
    prepareGrid(g, site.landing);
    const cells: number[] = [];
    let prev: [number, number] | null = null;
    for (const [lon, lat] of pts) {
      const cell = lonLatToCell(g, lon, lat);
      for (const idx of prev ? straightCells(g, prev, cell) : [cell[0] * g.width + cell[1]]) if (cells[cells.length - 1] !== idx) cells.push(idx);
      prev = cell;
    }
    const route = describeRoute(g, cells, LIMITS);
    // Keep the drawn path on the rover's real positions rather than the cell centres.
    route.path = cells.length ? cells.map((u) => cellToLonLat(g, (u / g.width) | 0, u % g.width)) : route.path;
    return { kind: 'traverse', route, allSamples: g.samples };
  } finally {
    elevation.destroy();
    minerals?.destroy();
  }
}

/** A name for a point: a sample, the landing site, or its coordinates. */
export function pointLabel(site: Site, p: [number, number], samples: SamplePoint[]): string | null {
  const near = (lon: number, lat: number) => Math.hypot((p[0] - lon) * mPerDegLon(lat), (p[1] - lat) * M_PER_DEG);
  if (near(site.landing.lon, site.landing.lat) < 150) return 'Landing site';
  const s = samples.find((x) => near(x.lon, x.lat) < 150);
  return s ? s.name : null;
}
