// The color texture of the SOLMAP Mars model (public/models/mars-8k.glb) as a tile layer.
// The texture is a full-planet equirectangular image, so each tile is a crop of it.
import BaseTileLayer, { type BaseTileLayerProperties } from '@arcgis/core/layers/BaseTileLayer';
import Extent from '@arcgis/core/geometry/Extent';
import { marsSR, marsTileInfo, tileExtent } from './mars';

/**
 * The model's texture is stored south-up (row 0 is the south pole), with its left edge at 180°W.
 * Flip this if a different texture appears upside down against the MDIM basemap.
 */
const TEXTURE_SOUTH_UP = true;

/** Reads the first image embedded in a GLB file. */
async function loadGlbImage(url: string): Promise<ImageBitmap> {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${url} is not a GLB file`);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const image = json.images?.[0];
  if (!image) throw new Error(`${url} has no embedded image`);
  const bv = json.bufferViews[image.bufferView];
  const bytes = new Uint8Array(buf, binStart + (bv.byteOffset ?? 0), bv.byteLength);
  return createImageBitmap(new Blob([bytes], { type: image.mimeType }));
}

export function createModelTextureLayer(glbUrl: string, props: BaseTileLayerProperties = {}): BaseTileLayer {
  let bitmap: Promise<ImageBitmap> | null = null;
  const Layer = BaseTileLayer.createSubclass({
    fetchTile(level: number, row: number, col: number) {
      bitmap ??= loadGlbImage(glbUrl);
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
