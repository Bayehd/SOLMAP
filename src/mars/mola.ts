// MOLA elevation grids, one per site. Format (see README, "Adding a site"):
// public/data/sites/{siteId}.bin holds little-endian Float32 values, row-major,
// width × height. Row 0 is maxLat, column 0 is minLon, and the bounds are the
// centers of the edge samples. Elevation in meters = value × metersPerValue
// (default 1). NaN means no data. Built by scripts/build_mola_sites.py.
import { MARS_RADIUS_M } from './geo';

export type MolaGrid = {
  width: number;
  height: number;
  minLat: number;
  maxLat: number;
  minLon: number; // east longitude, degrees (either -180..180 or 0..360)
  maxLon: number;
  metersPerValue?: number; // default 1 (values already in meters)
  minElevation?: number; // meters, over the whole grid
  maxElevation?: number;
  source?: string;
  data: Float32Array;
};

type ManifestEntry = Omit<MolaGrid, 'data'> & { id?: string; file?: string };

const cache = new Map<string, Promise<MolaGrid | null>>();

/** Loads a site's grid, or resolves to null when the manifest has no entry for it. */
export function loadSiteGrid(siteId: string): Promise<MolaGrid | null> {
  let p = cache.get(siteId);
  if (!p) {
    p = fetchGrid(siteId);
    p.catch(() => cache.delete(siteId)); // let a failed load be retried
    cache.set(siteId, p);
  }
  return p;
}

async function fetchGrid(siteId: string): Promise<MolaGrid | null> {
  const res = await fetch('/data/manifest.json');
  if (!res.ok) return null;
  let manifest: { sites?: Record<string, ManifestEntry> };
  try {
    manifest = await res.json();
  } catch {
    return null; // dev servers answer missing files with index.html
  }
  const entry = manifest.sites?.[siteId];
  if (!entry) return null;

  const file = entry.file ?? `sites/${siteId}.bin`;
  const bin = await fetch(`/data/${file}`);
  if (!bin.ok) throw new Error(`Could not load /data/${file} (${bin.status})`);
  const buf = await bin.arrayBuffer();
  const expected = entry.width * entry.height * 4;
  if (buf.byteLength !== expected) {
    throw new Error(`/data/${file} is ${buf.byteLength} bytes; expected ${expected} (${entry.width}×${entry.height} Float32)`);
  }
  return { ...entry, data: new Float32Array(buf) };
}

/** Bilinear elevation in meters at lat/lon (degrees), or NaN outside the grid or where data is missing. */
export function sampleGrid(g: MolaGrid, lat: number, lon: number): number {
  let x = lon;
  while (x < g.minLon) x += 360;
  while (x >= g.minLon + 360) x -= 360;
  const fx = ((x - g.minLon) / (g.maxLon - g.minLon)) * (g.width - 1);
  const fy = ((g.maxLat - lat) / (g.maxLat - g.minLat)) * (g.height - 1);
  if (!(fx >= 0 && fy >= 0 && fx <= g.width - 1 && fy <= g.height - 1)) return NaN;

  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, g.width - 1), y1 = Math.min(y0 + 1, g.height - 1);
  const tx = fx - x0, ty = fy - y0;
  const d = g.data, w = g.width;
  const top = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx;
  const bottom = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx;
  return (top * (1 - ty) + bottom * ty) * (g.metersPerValue ?? 1);
}

/** Surface slope in degrees at lat/lon, from central differences one grid cell apart. NaN near edges or gaps. */
export function slopeAt(g: MolaGrid, lat: number, lon: number): number {
  const dLat = (g.maxLat - g.minLat) / (g.height - 1);
  const dLon = (g.maxLon - g.minLon) / (g.width - 1);
  const rad = Math.PI / 180;
  const dzNorth = (sampleGrid(g, lat + dLat, lon) - sampleGrid(g, lat - dLat, lon)) / (2 * dLat * rad * MARS_RADIUS_M);
  const dzEast =
    (sampleGrid(g, lat, lon + dLon) - sampleGrid(g, lat, lon - dLon)) /
    (2 * dLon * rad * MARS_RADIUS_M * Math.cos(lat * rad));
  return Math.atan(Math.hypot(dzNorth, dzEast)) / rad;
}
