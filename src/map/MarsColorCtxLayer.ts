// The CTX mosaic (grayscale, ~5 m/px) in Mars color: each pixel keeps the CTX brightness and is tinted with the
// Martian surface color, nudged by the Viking MDIM 2.1 color mosaic at the same place (232 m/px) for local
// variation. Both are NASA data on the same tiling scheme, so a CTX tile and the color tile under it cover
// exactly the same area. MDIM's colors are enhanced (dark ground turns blue), so it only adds a share of its hue.
import Extent from '@arcgis/core/geometry/Extent';
import BaseTileLayer, { type BaseTileLayerProperties } from '@arcgis/core/layers/BaseTileLayer';
import { marsSR, marsTileInfo } from './mars';
import { CTX_MAX_LEVEL, createUpsampledTileLayer } from './UpsampledTileLayer';

const SIZE = 512;
/** Darkest color luminance divided by, so near-black color pixels don't blow up. */
const MIN_LUMA = 12;
/**
 * ASSUMPTION: the base surface color, a butterscotch tan like Perseverance's natural-color images of Jezero.
 * Change it, or MDIM_SHARE, to retune the look.
 */
const MARS_TINT = [184, 132, 92];
/** How much of MDIM's own hue is mixed into the tint (0 = plain tint, 1 = MDIM colors). */
const MDIM_SHARE = 0.3;

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function pixels(img: CanvasImageSource): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

export function createMarsColorCtxLayer(ctxServiceUrl: string, colorLayer: BaseTileLayer, props: BaseTileLayerProperties = {}): BaseTileLayer {
  // The service only has tiles to level 12; closer tiles are cut from those and enlarged (deeper requests fail with 400).
  const ctxTiles = createUpsampledTileLayer(ctxServiceUrl, CTX_MAX_LEVEL);
  const Layer = BaseTileLayer.createSubclass({
    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      const [gray, color] = await Promise.all([
        ctxTiles.fetchTile(level, row, col, options) as Promise<CanvasImageSource>,
        colorLayer.fetchTile(level, row, col, options) as Promise<CanvasImageSource>,
      ]);
      const g = pixels(gray);
      const c = pixels(color);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext('2d')!;
      const out = ctx.createImageData(SIZE, SIZE);
      const tintLuma = luma(MARS_TINT[0], MARS_TINT[1], MARS_TINT[2]);
      for (let k = 0; k < g.length; k += 4) {
        if (!g[k + 3]) continue; // no CTX coverage: leave clear
        const cl = Math.max(MIN_LUMA, luma(c[k], c[k + 1], c[k + 2]));
        // Color per unit of brightness: mostly the tint, partly MDIM's hue here; then scaled to the CTX brightness.
        for (let ch = 0; ch < 3; ch++) {
          const hue = (1 - MDIM_SHARE) * (MARS_TINT[ch] / tintLuma) + MDIM_SHARE * (c[k + ch] / cl);
          out.data[k + ch] = g[k] * hue;
        }
        out.data[k + 3] = g[k + 3];
      }
      ctx.putImageData(out, 0, 0);
      return canvas;
    },
  });
  // Tiling and extent go through the constructor: as class-definition keys they would not set the properties.
  return new (Layer as unknown as new (p: BaseTileLayerProperties) => BaseTileLayer)({
    tileInfo: marsTileInfo(),
    spatialReference: marsSR(),
    fullExtent: new Extent({ xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: marsSR() }),
    ...props,
  });
}
