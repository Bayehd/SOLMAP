// Reads a window of the site's 20 m terrain model (and its CRISM mineral raster, where it has one) from the layers already on the map.
import Extent from '@arcgis/core/geometry/Extent';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import { marsSR, publicUrl } from '../map/mars';
import type { Site } from '../map/sites';
import { ASSUMPTIONS } from './config';
import { M_PER_DEG, mPerDegLon, type Grid, type LonLat, type SamplePoint } from './planner';

const samplesPromise = new Map<string, Promise<SamplePoint[]>>();
function loadSamples(file: string | undefined): Promise<SamplePoint[]> {
  if (!file) return Promise.resolve([]);
  if (!samplesPromise.has(file)) samplesPromise.set(file, fetch(publicUrl(file))
    .then((r) => r.json())
    .then((gj) =>
      (gj.features as { properties: { number: number; name: string; sol?: number; kind?: string }; geometry: { coordinates: [number, number] } }[]).map((f) => ({
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        name: f.properties.name,
        number: f.properties.number,
        sol: f.properties.sol,
        kind: f.properties.kind,
      })),
    )
    .catch(() => []));
  return samplesPromise.get(file)!;
}

function windowFor(site: Site, points: LonLat[]) {
  const E = site.extent;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mx = ASSUMPTIONS.windowMarginM / mPerDegLon(midLat), my = ASSUMPTIONS.windowMarginM / M_PER_DEG;
  return {
    xmin: Math.max(E.xmin, Math.min(...lons) - mx),
    xmax: Math.min(E.xmax, Math.max(...lons) + mx),
    ymin: Math.max(E.ymin, Math.min(...lats) - my),
    ymax: Math.min(E.ymax, Math.max(...lats) + my),
  };
}

const NODATA = -32767;

/** Loads elevation and minerals for the area around the points (and the base antenna). Derived rasters come from prepareGrid(). */
export async function loadGrid(site: Site, elevation: ImageryTileLayer, minerals: ImageryTileLayer | undefined, points: LonLat[]): Promise<Grid> {
  const ext = windowFor(site, points);
  const midLat = (ext.ymin + ext.ymax) / 2;
  const wM = (ext.xmax - ext.xmin) * mPerDegLon(midLat), hM = (ext.ymax - ext.ymin) * M_PER_DEG;
  const width = Math.max(8, Math.min(ASSUMPTIONS.maxSideCells, Math.round(wM / ASSUMPTIONS.cellM)));
  const height = Math.max(8, Math.min(ASSUMPTIONS.maxSideCells, Math.round(hM / ASSUMPTIONS.cellM)));
  const extent = new Extent({ ...ext, spatialReference: marsSR() });
  const [ez, mz, samples] = await Promise.all([
    elevation.fetchPixels(extent, width, height),
    minerals ? minerals.fetchPixels(extent, width, height).catch(() => null) : null,
    loadSamples(site.files.samples),
  ]);
  const band = ez?.pixelBlock?.pixels?.[0];
  if (!ez?.pixelBlock || !band) throw new Error('The terrain model returned no pixels for this area.');
  const mask = ez.pixelBlock.mask;
  const z = new Float32Array(width * height);
  for (let i = 0; i < z.length; i++) {
    const v = band[i];
    z[i] = (mask && mask[i] === 0) || v === undefined || v === null || v <= NODATA || Number.isNaN(v) ? NaN : v;
  }
  const min = new Uint8Array(width * height);
  const mband = mz?.pixelBlock?.pixels?.[0];
  if (mband) {
    const mm = mz!.pixelBlock!.mask;
    for (let i = 0; i < min.length; i++) {
      const v = mband[i];
      min[i] = (mm && mm[i] === 0) || !(v > 0) || v <= NODATA ? 0 : Math.min(255, Math.round(v));
    }
  }
  return {
    width, height, extent: ext,
    dxM: wM / width, dyM: hM / height,
    z, minerals: min, samples,
    slope: new Float32Array(0), rough: new Float32Array(0), los: new Uint8Array(0),
    rad: new Float32Array(0), sci: new Float32Array(0), radioBaseOk: false,
  };
}
