// The SOLMAP Mars texture (public/models/mars-8k.jpg) as a tile layer.
// It is a full-planet equirectangular image, so each tile is a crop of it.
import BaseTileLayer, { type BaseTileLayerProperties } from '@arcgis/core/layers/BaseTileLayer';
import Extent from '@arcgis/core/geometry/Extent';
import { marsSR, marsTileInfo, tileExtent } from './mars';

/**
 * The texture is stored south-up (row 0 is the south pole), with its left edge at 180°W.
 * Flip this if a different texture appears upside down against the CTX mosaic.
 */
const TEXTURE_SOUTH_UP = true;

async function loadImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return createImageBitmap(await res.blob());
}

export function createModelTextureLayer(imageUrl: string, props: BaseTileLayerProperties = {}): BaseTileLayer {
  let bitmap: Promise<ImageBitmap> | null = null;
  const Layer = BaseTileLayer.createSubclass({
    fetchTile(level: number, row: number, col: number) {
      bitmap ??= loadImage(imageUrl);
      return bitmap.then((img) => {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const e = tileExtent(level, row, col);
        const sx = ((e.xmin + 180) / 360) * img.width;
        const sw = ((e.xmax - e.xmin) / 360) * img.width;
        const sh = ((e.ymax - e.ymin) / 180) * img.height;
        if (TEXTURE_SOUTH_UP) {
          const sy = ((e.ymin + 90) / 180) * img.height;
          ctx.translate(0, size);
          ctx.scale(1, -1);
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        } else {
          const sy = ((90 - e.ymax) / 180) * img.height;
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        }
        return canvas;
      });
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
