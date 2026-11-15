// A NASA Mars Trek WMTS mosaic (equirectangular "EQ" tiles) on the app's Mars tiling.
// Trek's 256 px tile (level, row, col) covers the same area as the app's 512 px tile (level, row, col), so each tile is
// drawn enlarged; below Trek's deepest level, tiles are cut from the deepest ancestor. Missing tiles (outside the
// mosaic) come back clear.
import Extent from '@arcgis/core/geometry/Extent';
import BaseTileLayer, { type BaseTileLayerProperties } from '@arcgis/core/layers/BaseTileLayer';
import esriRequest from '@arcgis/core/request';
import { marsSR, marsTileInfo } from './mars';

const SIZE = 512;

/** `layer` is the Trek layer name, e.g. THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018. */
export const trekTileUrl = (layer: string) => `https://trek.nasa.gov/tiles/Mars/EQ/${layer}/1.0.0/default/default028mm`;

export function createTrekTileLayer(layer: string, maxLevel: number, props: BaseTileLayerProperties = {}): BaseTileLayer {
  const base = trekTileUrl(layer);
  const Layer = BaseTileLayer.createSubclass({
    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      const shift = Math.max(0, level - maxLevel);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      let img: HTMLImageElement;
      try {
        const res = await esriRequest(`${base}/${level - shift}/${row >> shift}/${col >> shift}.png`, { responseType: 'image', signal: options?.signal });
        img = res.data as HTMLImageElement;
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        return canvas; // no tile there
      }
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      const n = 2 ** shift;
      const size = img.width / n;
      ctx.drawImage(img, (col % n) * size, (row % n) * size, size, size, 0, 0, SIZE, SIZE);
      return canvas;
    },
  });
  // Tiling and extent go through the constructor: as class-definition keys they would not set the properties.
  return new (Layer as unknown as new (p: BaseTileLayerProperties) => BaseTileLayer)({
    tileInfo: marsTileInfo(),
    spatialReference: marsSR(),
    fullExtent: new Extent({ xmin: -180, ymin: -65, xmax: 180, ymax: 65, spatialReference: marsSR() }),
    ...props,
  });
}
