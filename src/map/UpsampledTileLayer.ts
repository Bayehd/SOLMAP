// A cached Mars tile service that only has tiles down to `maxLevel`, even if it advertises more.
// Deeper tiles are cut from the level-`maxLevel` ancestor and enlarged, instead of requesting
// tiles the server doesn't have (which fail with HTTP 400 and no CORS header).
import Extent from '@arcgis/core/geometry/Extent';
import BaseTileLayer, { type BaseTileLayerProperties } from '@arcgis/core/layers/BaseTileLayer';
import esriRequest from '@arcgis/core/request';
import { marsSR, marsTileInfo } from './mars';

/** The deepest level of the CTX mosaic service (OnMars/CTX1): ~5 m/px, CTX's own resolution. */
export const CTX_MAX_LEVEL = 12;

export function createUpsampledTileLayer(serviceUrl: string, maxLevel: number, props: BaseTileLayerProperties = {}): BaseTileLayer {
  const Layer = BaseTileLayer.createSubclass({
    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      const shift = Math.max(0, level - maxLevel);
      const res = await esriRequest(`${serviceUrl}/tile/${level - shift}/${row >> shift}/${col >> shift}`, {
        responseType: 'image',
        signal: options?.signal,
      });
      const img = res.data as HTMLImageElement;
      if (shift === 0) return img;
      const n = 2 ** shift;
      const size = img.width / n;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = img.width;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (col % n) * size, (row % n) * size, size, size, 0, 0, canvas.width, canvas.height);
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
