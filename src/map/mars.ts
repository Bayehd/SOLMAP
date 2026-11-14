// Mars coordinate system, tiling scheme and the areas the app knows about.
import Extent from '@arcgis/core/geometry/Extent';
import SpatialReference from '@arcgis/core/geometry/SpatialReference';
import TileInfo from '@arcgis/core/layers/support/TileInfo';

/** GCS Mars 2000 Sphere (IAU), radius 3,396,190 m. Every layer and view in the app uses it. */
const MARS_WKID = 104971;
export const marsSR = () => new SpatialReference({ wkid: MARS_WKID });
const MARS_RADIUS_M = 3396190;
export const METERS_PER_DEGREE = (MARS_RADIUS_M * Math.PI) / 180;

/**
 * The tiling scheme of Esri's Mars services (astro.arcgis.com/arcgis/rest/services/OnMars):
 * 512 px tiles from (-180°, 90°), 0.3515625°/px at level 0, halving per level.
 * Custom tile and elevation layers use it so they line up with those services.
 */
export function marsTileInfo(levels = 18): TileInfo {
  const sr = marsSR();
  return new TileInfo({
    size: [512, 512],
    dpi: 96,
    format: 'png',
    origin: { x: -180, y: 90, spatialReference: sr },
    spatialReference: sr,
    lods: Array.from({ length: levels }, (_, level) => ({
      level,
      resolution: 0.3515625 / 2 ** level,
      scale: 78760513.4003741 / 2 ** level,
    })),
  });
}

/** Extent in degrees of tile (level, row, col) in marsTileInfo(). */
export function tileExtent(level: number, row: number, col: number) {
  const size = (512 * 0.3515625) / 2 ** level;
  const xmin = -180 + col * size;
  const ymax = 90 - row * size;
  return { xmin, ymin: ymax - size, xmax: xmin + size, ymax };
}

/** The area covered by the USGS CTX DTM of the Jezero landing site (from scripts/build_jezero_layers.py). */
export const JEZERO_DTM_EXTENT = { xmin: 77.16047, ymin: 18.21103, xmax: 77.69898, ymax: 18.72119 };
export const jezeroExtent = () => new Extent({ ...JEZERO_DTM_EXTENT, spatialReference: marsSR() });

/** Octavia E. Butler Landing, where Perseverance touched down on 18 February 2021:
 *  the first point of the traverse (public/data/jezero/m20_traverse.geojson), so the rover lands on its route. */
export const LANDING_SITE = { lon: 77.4508857, lat: 18.4446271 };
/** The Jezero DTM extent, re-centred on the landing site: where the intro flight ends. */
export const landingExtent = () => {
  const w = (JEZERO_DTM_EXTENT.xmax - JEZERO_DTM_EXTENT.xmin) / 2;
  const h = (JEZERO_DTM_EXTENT.ymax - JEZERO_DTM_EXTENT.ymin) / 2;
  const { lon, lat } = LANDING_SITE;
  return new Extent({ xmin: lon - w, xmax: lon + w, ymin: lat - h, ymax: lat + h, spatialReference: marsSR() });
};

/** Absolute URL of a file in public/. */
export const publicUrl = (path: string) => new URL(path.replace(/^\//, ''), new URL(import.meta.env.BASE_URL, location.href)).href;
