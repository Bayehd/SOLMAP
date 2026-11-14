// Reads a window of the 20 m Jezero terrain model and the CRISM mineral raster from the layers already on the map.
import Extent from '@arcgis/core/geometry/Extent';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import { JEZERO_DTM_EXTENT, marsSR, publicUrl } from '../map/mars';
import { ASSUMPTIONS } from './config';
import { M_PER_DEG, mPerDegLon, type Grid, type LonLat, type SamplePoint } from './planner';

let samplesPromise: Promise<SamplePoint[]> | null = null;
function loadSamples(): Promise<SamplePoint[]> {
  samplesPromise ??= fetch(publicUrl('data/jezero/m20_samples.geojson'))
    .then((r) => r.json())
    .then((gj) =>
      (gj.features as { properties: { number: number; name: string }; geometry: { coordinates: [number, number] } }[]).map((f) => ({
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        name: f.properties.name,
        number: f.properties.number,
      })),
    )
    .catch(() => []);
  return samplesPromise;
}

export const insideDtm = (p: LonLat) =>
  p.lon >= JEZERO_DTM_EXTENT.xmin && p.lon <= JEZERO_DTM_EXTENT.xmax && p.lat >= JEZERO_DTM_EXTENT.ymin && p.lat <= JEZERO_DTM_EXTENT.ymax;

function windowFor(points: LonLat[]) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mx = ASSUMPTIONS.windowMarginM / mPerDegLon(midLat), my = ASSUMPTIONS.windowMarginM / M_PER_DEG;
  return {
    xmin: Math.max(JEZERO_DTM_EXTENT.xmin, Math.min(...lons) - mx),
    xmax: Math.min(JEZERO_DTM_EXTENT.xmax, Math.max(...lons) + mx),
    ymin: Math.max(JEZERO_DTM_EXTENT.ymin, Math.min(...lats) - my),
    ymax: Math.min(JEZERO_DTM_EXTENT.ymax, Math.max(...lats) + my),
  };
}

const NODATA = -32767;

/** Loads elevation and minerals for the area around the points (and the base antenna). Derived rasters come from prepareGrid(). */
export async function loadGrid(elevation: ImageryTileLayer, minerals: ImageryTileLayer, points: LonLat[]): Promise<Grid> {
  const ext = windowFor(points);
  const midLat = (ext.ymin + ext.ymax) / 2;
  const wM = (ext.xmax - ext.xmin) * mPerDegLon(midLat), hM = (ext.ymax - ext.ymin) * M_PER_DEG;
  const width = Math.max(8, Math.min(ASSUMPTIONS.maxSideCells, Math.round(wM / ASSUMPTIONS.cellM)));
  const height = Math.max(8, Math.min(ASSUMPTIONS.maxSideCells, Math.round(hM / ASSUMPTIONS.cellM)));
  const extent = new Extent({ ...ext, spatialReference: marsSR() });
  const [ez, mz, samples] = await Promise.all([
    elevation.fetchPixels(extent, width, height),
    minerals.fetchPixels(extent, width, height).catch(() => null),
    loadSamples(),
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
