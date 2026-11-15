// An image of one region (north up, covering a lon/lat box) as a tile layer, shown only inside `clip` (the site's
// data area) and clear outside it.
// Used for the Jezero crater model texture (public/models/jezero-crater-texture.jpg). That texture is ~84 m/px,
// so from close up (the Rover view) it is multiplied by the detail of the CTX mosaic (~5 m/px): each pixel keeps
// the texture's color, brightened or darkened by how the CTX pixel compares with the average CTX brightness of the
// surrounding ~10 km (one level-10 tile), so neighbouring tiles match.
import Extent from '@arcgis/core/geometry/Extent';
import BaseTileLayer, { type BaseTileLayerProperties } from '@arcgis/core/layers/BaseTileLayer';
import { marsSR, marsTileInfo, tileExtent } from './mars';
import { CTX_MAX_LEVEL, createUpsampledTileLayer } from './UpsampledTileLayer';

type Box = { xmin: number; ymin: number; xmax: number; ymax: number };

const SIZE = 512;
/** From this tile level on (~20 m/px and finer), the CTX detail is added. */
const DETAIL_FROM_LEVEL = 10;
/** Strength of the CTX detail, and the limits of the brightness factor it applies. */
const DETAIL_STRENGTH = 0.8;
const DETAIL_RANGE: [number, number] = [0.45, 1.7];

async function loadImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return createImageBitmap(await res.blob());
}

function grayPixels(img: CanvasImageSource): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

export function createRegionTextureLayer(
  imageUrl: string,
  box: Box,
  clip: Box,
  detailServiceUrl?: string,
  props: BaseTileLayerProperties = {},
): BaseTileLayer {
  // The part of the image that is shown: where it overlaps the clip area.
  const area: Box = {
    xmin: Math.max(box.xmin, clip.xmin),
    ymin: Math.max(box.ymin, clip.ymin),
    xmax: Math.min(box.xmax, clip.xmax),
    ymax: Math.min(box.ymax, clip.ymax),
  };
  let bitmap: Promise<ImageBitmap> | null = null;
  // CTX only has tiles to level 12 (~5 m/px); closer tiles are cut from those and enlarged.
  const detail = detailServiceUrl ? createUpsampledTileLayer(detailServiceUrl, CTX_MAX_LEVEL) : null;
  // Average CTX brightness of each level-DETAIL_FROM_LEVEL tile, shared by all the smaller tiles inside it.
  const means = new Map<string, Promise<number | null>>();
  const meanOf = (row: number, col: number) => {
    const key = `${row}/${col}`;
    if (!means.has(key))
      means.set(
        key,
        (detail!.fetchTile(DETAIL_FROM_LEVEL, row, col) as Promise<CanvasImageSource>)
          .then((img) => {
            const px = grayPixels(img);
            let sum = 0, n = 0;
            for (let k = 0; k < px.length; k += 4) if (px[k + 3]) (sum += px[k]), n++;
            return n ? Math.max(1, sum / n) : null;
          })
          .catch(() => {
            means.delete(key); // try again next time
            return null;
          }),
      );
    return means.get(key)!;
  };
  const Layer = BaseTileLayer.createSubclass({
    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      bitmap ??= loadImage(imageUrl);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const e = tileExtent(level, row, col);
      if (e.xmax <= area.xmin || e.xmin >= area.xmax || e.ymax <= area.ymin || e.ymin >= area.ymax) return canvas; // outside: clear

      // The image, placed on the tile (it may cover only part of it).
      const img = await bitmap;
      // Crop the part of the image under the tile (clamped to the shown area) and draw it where it falls on the tile,
      // rather than drawing the whole image hugely enlarged when the tile is small.
      const x0 = Math.max(e.xmin, area.xmin), x1 = Math.min(e.xmax, area.xmax);
      const y0 = Math.max(e.ymin, area.ymin), y1 = Math.min(e.ymax, area.ymax);
      const ix = (lon: number) => ((lon - box.xmin) / (box.xmax - box.xmin)) * img.width;
      const iy = (lat: number) => ((box.ymax - lat) / (box.ymax - box.ymin)) * img.height;
      const tx = (lon: number) => ((lon - e.xmin) / (e.xmax - e.xmin)) * SIZE;
      const ty = (lat: number) => ((e.ymax - lat) / (e.ymax - e.ymin)) * SIZE;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, ix(x0), iy(y1), ix(x1) - ix(x0), iy(y0) - iy(y1), tx(x0), ty(y1), tx(x1) - tx(x0), ty(y0) - ty(y1));

      if (!detail || level < DETAIL_FROM_LEVEL) return canvas;
      const up = level - DETAIL_FROM_LEVEL;
      const [gray, mean] = await Promise.all([
        (detail.fetchTile(level, row, col, options) as Promise<CanvasImageSource>).catch(() => null), // no CTX here: the texture alone
        meanOf(row >> up, col >> up),
      ]);
      if (!gray || !mean) return canvas;
      const gp = grayPixels(gray);
      const out = ctx.getImageData(0, 0, SIZE, SIZE);
      const d = out.data;
      for (let k = 0; k < d.length; k += 4) {
        if (!d[k + 3] || !gp[k + 3]) continue;
        const f = Math.min(DETAIL_RANGE[1], Math.max(DETAIL_RANGE[0], 1 + DETAIL_STRENGTH * (gp[k] / mean - 1)));
        d[k] *= f;
        d[k + 1] *= f;
        d[k + 2] *= f;
      }
      ctx.putImageData(out, 0, 0);
      return canvas;
    },
  });
  // Tiling and extent go through the constructor: as class-definition keys they would not set the properties.
  return new (Layer as unknown as new (p: BaseTileLayerProperties) => BaseTileLayer)({
    tileInfo: marsTileInfo(),
    spatialReference: marsSR(),
    fullExtent: new Extent({ ...area, spatialReference: marsSR() }),
    ...props,
  });
}
