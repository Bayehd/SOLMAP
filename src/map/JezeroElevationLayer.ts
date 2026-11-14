// 3D ground: NASA MGS MOLA global elevation (463 m), with the 20 m USGS CTX DTM of the
// Jezero landing site in its place where it has data. Both are in meters above the MOLA areoid.
import type ElevationLayer from '@arcgis/core/layers/ElevationLayer';
import BaseElevationLayer, { type BaseElevationLayerProperties } from '@arcgis/core/layers/BaseElevationLayer';
import Extent from '@arcgis/core/geometry/Extent';
import ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import { JEZERO_DTM_EXTENT, marsSR, marsTileInfo, publicUrl, tileExtent } from './mars';

/** Deepest level the MOLA service has (0.0055°/sample ≈ 326 m, finer than MOLA's 463 m). Deeper tiles upsample it. */
const GLOBAL_MAX_LEVEL = 6;
/** Level 10 ≈ 20 m per sample, the DTM's resolution. */
const MAX_LEVEL = 10;
/** Below this level a tile is too coarse for the DTM to change it. */
const DTM_MIN_LEVEL = 5;
/** Width (degrees, ≈ 600 m) over which the DTM fades into the global DEM at its edges. */
const FEATHER_DEG = 0.01;

type Tile = { values: ArrayLike<number>; width: number; height: number; noDataValue: number };

/** Positions of a tile's samples: corner-aligned for odd sizes (e.g. 257), pixel centers otherwise. */
function sampleCoord(min: number, max: number, n: number, i: number) {
  return n % 2 === 1 ? min + (i * (max - min)) / (n - 1) : min + ((i + 0.5) * (max - min)) / n;
}

/** Bilinear sample of a tile at (x, y) in degrees, given the tile's extent. */
function sampleTile(t: Tile, e: ReturnType<typeof tileExtent>, x: number, y: number) {
  const odd = t.width % 2 === 1;
  const fx = odd ? ((x - e.xmin) / (e.xmax - e.xmin)) * (t.width - 1) : ((x - e.xmin) / (e.xmax - e.xmin)) * t.width - 0.5;
  const fy = odd ? ((e.ymax - y) / (e.ymax - e.ymin)) * (t.height - 1) : ((e.ymax - y) / (e.ymax - e.ymin)) * t.height - 0.5;
  const x0 = Math.max(0, Math.min(t.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(t.height - 1, Math.floor(fy)));
  const x1 = Math.min(x0 + 1, t.width - 1);
  const y1 = Math.min(y0 + 1, t.height - 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = t.values, w = t.width;
  return (
    (v[y0 * w + x0] * (1 - tx) + v[y0 * w + x1] * tx) * (1 - ty) + (v[y1 * w + x0] * (1 - tx) + v[y1 * w + x1] * tx) * ty
  );
}

export function createJezeroElevationLayer(global: ElevationLayer, props: BaseElevationLayerProperties = {}): BaseElevationLayer {
  const dtm = new ImageryTileLayer({ url: publicUrl('data/jezero/ctx_dtm_20m.tif') });
  const J = JEZERO_DTM_EXTENT;

  const Layer = BaseElevationLayer.createSubclass({
    load(this: BaseElevationLayer) {
      // The DTM is optional: without it the ground is the global DEM.
      this.addResolvingPromise(Promise.all([global.load(), dtm.load().catch((err: unknown) => console.warn('Jezero DTM not loaded', err))]));
    },

    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      const baseLevel = Math.min(level, GLOBAL_MAX_LEVEL);
      const shift = level - baseLevel;
      const base: Tile = await global.fetchTile(baseLevel, row >> shift, col >> shift, options);
      const e = tileExtent(level, row, col);
      const { width: W, height: H, noDataValue } = base;

      let values: Float32Array;
      if (shift === 0) values = Float32Array.from(base.values);
      else {
        const be = tileExtent(baseLevel, row >> shift, col >> shift);
        values = new Float32Array(W * H);
        for (let j = 0; j < H; j++) {
          const y = sampleCoord(e.ymax, e.ymin, H, j);
          for (let i = 0; i < W; i++) values[j * W + i] = sampleTile(base, be, sampleCoord(e.xmin, e.xmax, W, i), y);
        }
      }

      const overlaps = e.xmin < J.xmax && e.xmax > J.xmin && e.ymin < J.ymax && e.ymax > J.ymin;
      if (level >= DTM_MIN_LEVEL && overlaps && dtm.loaded) {
        // Request a DTM block whose pixel centers sit on this tile's sample positions.
        const odd = W % 2 === 1;
        const dx = (e.xmax - e.xmin) / (odd ? W - 1 : W);
        const dy = (e.ymax - e.ymin) / (odd ? H - 1 : H);
        const pad = odd ? 0.5 : 0;
        const extent = new Extent({
          xmin: e.xmin - pad * dx,
          xmax: e.xmax + pad * dx,
          ymin: e.ymin - pad * dy,
          ymax: e.ymax + pad * dy,
          spatialReference: marsSR(),
        });
        try {
          const px = await dtm.fetchPixels(extent, W, H, { signal: options?.signal });
          const block = px?.pixelBlock;
          const band = block?.pixels?.[0] as ArrayLike<number> | undefined;
          if (band) {
            const mask = block.mask as ArrayLike<number> | null | undefined;
            for (let j = 0; j < H; j++) {
              const y = sampleCoord(e.ymax, e.ymin, H, j);
              for (let i = 0; i < W; i++) {
                const k = j * W + i;
                const z = band[k];
                if ((mask && !mask[k]) || !(z > -32000) || values[k] === noDataValue) continue;
                const x = sampleCoord(e.xmin, e.xmax, W, i);
                const edge = Math.min(x - J.xmin, J.xmax - x, y - J.ymin, J.ymax - y);
                const w = Math.max(0, Math.min(1, edge / FEATHER_DEG));
                values[k] = values[k] * (1 - w) + z * w;
              }
            }
          }
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') console.warn('Jezero DTM tile failed', err);
        }
      }
      return { values, width: W, height: H, noDataValue, maxZError: 0.5 };
    },
  });
  // Tiling and extent go through the constructor: as class-definition keys they would not set the properties.
  return new (Layer as unknown as new (p: BaseElevationLayerProperties) => BaseElevationLayer)({
    tileInfo: marsTileInfo(MAX_LEVEL + 1),
    spatialReference: marsSR(),
    fullExtent: new Extent({ xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: marsSR() }),
    ...props,
  });
}
