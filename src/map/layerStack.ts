// Side view: the site's terrain area (the extent of its 20 m DTM, the colored area on the map) lifted off the
// ground and pulled apart into one slab per data layer (an exploded block diagram), so each layer can be seen
// on its own. Every slab shows the base map that is on the ground, with its layer's data on top, drawn from
// the same files and at the same opacity as on the map.
import Graphic from '@arcgis/core/Graphic';
import Extent from '@arcgis/core/geometry/Extent';
import Mesh from '@arcgis/core/geometry/Mesh';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import MeshComponent from '@arcgis/core/geometry/support/MeshComponent';
import MeshLocalVertexSpace from '@arcgis/core/geometry/support/MeshLocalVertexSpace';
import MeshMaterial from '@arcgis/core/geometry/support/MeshMaterial';
import MeshTexture from '@arcgis/core/geometry/support/MeshTexture';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import type Layer from '@arcgis/core/layers/Layer';
import type TileInfo from '@arcgis/core/layers/support/TileInfo';
import { MINERAL_CLASSES, SAMPLE_KINDS, SLOPE_CLASSES, elevationRamp, type LayerDef } from './layers';
import { METERS_PER_DEGREE, marsSR, publicUrl } from './mars';
import type { Site } from './sites';

/** The slab that goes on top of the stack; the others stack from the ground up in catalog order. */
const TOP_SLAB = 'elevation';
/** The rover traverse goes at the bottom of the stack, on the ground. */
const BOTTOM_SLAB = 'traverse';

/** The site's area: its extent, center and size on the ground. */
type Area = { extent: Site['extent']; center: { lon: number; lat: number }; widthM: number; heightM: number; sizeM: number };
function areaOf(site: Site): Area {
  const e = site.extent;
  const center = { lon: (e.xmin + e.xmax) / 2, lat: (e.ymin + e.ymax) / 2 };
  const widthM = (e.xmax - e.xmin) * METERS_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180);
  const heightM = (e.ymax - e.ymin) * METERS_PER_DEGREE;
  return { extent: e, center, widthM, heightM, sizeM: Math.max(widthM, heightM) };
}
/** Relief on the elevation slab is exaggerated so the delta and crater rim read at this scale: up to 2×, less where
 *  the relief is already tall (Gale's 4 km of Mount Sharp), so it rises RELIEF_SHARE of the area's size at most. */
const MAX_EXAGGERATION = 2;
const RELIEF_SHARE = 0.08; // Jezero: 2×, as before; Gale: about 1×
// Proportions, as fractions of the area's size. The gaps are wide so the slabs below stay in view.
const THICKNESS = 0.012;
const GAP = 0.3;
const LIFT = 0.08; // bottom of the stack above the highest ground
const TEX_PX = 1536; // slab texture size (~20 m/px)
const RASTER_PX = 768; // data raster samples per side (~40 m)
const RELIEF_STEP = 6; // relief mesh = every 6th raster sample (128 × 128)
const SIDE_COLOR = [150, 156, 170, 0.35]; // slab edges, light and see-through
const NO_MAP_COLOR = '#2a2f3a'; // under the base map, where it has no tiles
/** Laid over the base map on the slabs to soften its contrast, so the data drawn on top stands out. */
const BASE_WASH = 'rgba(42, 47, 58, 0.15)';
/** Opacity of the base map on the slabs: below 1 the slabs underneath show through. The data stays opaque. */
const BASE_OPACITY = 0.55;
/** A slab under the mouse grows to this size, so it can be seen better. */
const HOVER_SCALE = 1.12;

/** Layer id → what its slab draws over the base map. Layers without an entry (the base maps) stay on the ground. */
const SLABS: Record<string, { draw: (ctx: CanvasRenderingContext2D, d: SliceData) => void; relief?: boolean }> = {
  elevation: {
    draw: (ctx, d) => rasterOverlay(ctx, (k) => elevationColor(d.ramp, d.dtm[k], d.shade[k])),
    relief: true,
  },
  slope: {
    draw: (ctx, d) =>
      rasterOverlay(ctx, (k) => {
        const s = d.slope[k];
        if (!(s >= 0)) return null;
        const c = SLOPE_CLASSES.find((c) => s < c.max) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
        return c.painted ? c.color : null; // as on the map: walkable ground is left clear
      }),
  },
  minerals: {
    draw: (ctx, d) => rasterOverlay(ctx, (k) => MINERAL_CLASSES[d.mineral[k] - 1]?.color ?? null),
  },
  traverse: {
    draw: (ctx, d) => {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 10;
      ctx.lineJoin = ctx.lineCap = 'round';
      for (const line of d.traverse) {
        ctx.beginPath();
        line.forEach((c, i) => (i ? ctx.lineTo(...xy(d.area, c)) : ctx.moveTo(...xy(d.area, c))));
        ctx.stroke();
      }
    },
  },
  samples: {
    draw: (ctx, d) =>
      d.samples.forEach((s) => dot(ctx, xy(d.area, s.c), 15, `rgb(${(SAMPLE_KINDS.find((k) => k.label === s.kind) ?? SAMPLE_KINDS[0]).color.join(',')})`)),
  },
  depot: {
    draw: (ctx, d) =>
      d.depot.forEach((c) => {
        const [x, y] = xy(d.area, c);
        ctx.fillStyle = '#ff3dc8';
        ctx.beginPath();
        ctx.moveTo(x, y - 20), ctx.lineTo(x + 20, y), ctx.lineTo(x, y + 20), ctx.lineTo(x - 20, y);
        ctx.fill();
      }),
  },
};

export const STACKABLE = new Set(Object.keys(SLABS));

/**
 * Stack order of these layer ids, bottom to top: catalog order, with BOTTOM_SLAB moved to the bottom (so it stays on
 * the ground) and TOP_SLAB to the top.
 */
export function stackOrder(ids: string[]): string[] {
  const ends = [BOTTOM_SLAB, TOP_SLAB];
  const middle = ids.filter((id) => SLABS[id] && !ends.includes(id));
  return [...(ids.includes(BOTTOM_SLAB) ? [BOTTOM_SLAB] : []), ...middle, ...(ids.includes(TOP_SLAB) ? [TOP_SLAB] : [])];
}

/** The bottom layer is not lifted: it stays on the ground (as the map layer itself), under the slabs. */
export const groundLayerOf = (ids: string[]): string | undefined => stackOrder(ids)[0];

type LonLat = [number, number];
type SliceData = {
  area: Area;
  exaggeration: number; // vertical, for the relief slab
  ramp: { at: number; color: number[] }[];
  dtm: Float32Array; // meters, row 0 = north; NaN = no data
  shade: Float32Array; // 0–1 hillshade
  slope: Float32Array; // degrees
  mineral: Uint8Array; // MINERAL_CLASSES index + 1, 0 = none
  min: number;
  max: number;
  traverse: LonLat[][];
  samples: { c: LonLat; kind: string }[];
  depot: LonLat[];
};
type TiledLayer = Layer & {
  tileInfo?: TileInfo;
  fetchTile(level: number, row: number, col: number): Promise<CanvasImageSource>;
};

/** A slab as placed in the stack, for the labels: its corners at mid-height. */
export type StackSlab = { id: string; title: string; corners: Point[] };

const data = new Map<string, Promise<SliceData>>(); // per site, kept between visits

export function createLayerStack(site: Site, defs: LayerDef[]) {
  const area = areaOf(site);
  const SIZE_M = area.sizeM;
  const stack = new GraphicsLayer({ id: 'side-stack', title: 'Side view stack', visible: false, elevationInfo: { mode: 'absolute-height' } });
  const footprint = new GraphicsLayer({ id: 'side-footprint', title: 'Side view footprint', visible: false, elevationInfo: { mode: 'on-the-ground' } });
  // The base map image and the slab textures, kept until the base maps change.
  let base: { key: string; image: Promise<HTMLCanvasElement>; textures: Map<string, HTMLCanvasElement> } | null = null;
  // The slabs in the stack, with their current hover size.
  let pieces = new Map<string, { graphic: Graphic; mesh: Mesh; scale: number }>();
  let hovered: string | null = null;
  let frame = 0;

  const sized = (p: { mesh: Mesh; scale: number }) => (p.scale === 1 ? p.mesh : p.mesh.clone().scale(p.scale));
  /** Ease every slab toward its size (the hovered one bigger) over a few frames. */
  function animate() {
    cancelAnimationFrame(frame);
    const tick = () => {
      let moving = false;
      for (const [id, p] of pieces) {
        const target = id === hovered ? HOVER_SCALE : 1;
        if (p.scale === target) continue;
        p.scale = Math.abs(target - p.scale) < 0.003 ? target : p.scale + (target - p.scale) * 0.35;
        p.graphic.geometry = sized(p);
        moving ||= p.scale !== target;
      }
      if (moving) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  /** Enlarge this slab (null: none). */
  function highlight(id: string | null) {
    if (id === hovered) return;
    hovered = id;
    animate();
  }

  /**
   * Rebuild the stack with these data layer ids (see stackOrder; the bottom one stays on the ground) over these base map layers
   * (bottom to top, as on the ground). Returns the slabs placed, top to bottom.
   */
  async function update(ids: string[], baseLayers: Layer[]): Promise<StackSlab[]> {
    if (!data.has(site.id)) data.set(site.id, loadSliceData(site, area));
    const key = baseLayers.map((l) => l.id).join(',');
    if (base?.key !== key) base = { key, image: baseImage(area, baseLayers), textures: new Map() };
    const current = base;
    const [d, map] = await Promise.all([data.get(site.id)!, current.image]);
    const [groundId, ...lifted] = stackOrder(ids);

    const graphics: Graphic[] = [];
    const placed = new Map<string, { graphic: Graphic; mesh: Mesh; scale: number }>();
    const slabs: StackSlab[] = [];
    const bottom = d.max + LIFT * SIZE_M;
    let z = bottom;
    for (const id of lifted) {
      const def = defs.find((l) => l.id === id)!;
      let texture = current.textures.get(id);
      if (!texture) {
        texture = canvas(TEX_PX);
        const ctx = texture.getContext('2d')!;
        ctx.globalAlpha = BASE_OPACITY;
        ctx.drawImage(map, 0, 0);
        ctx.globalAlpha = def.opacity ?? 1;
        SLABS[id].draw(ctx, d);
        current.textures.set(id, texture);
      }
      const t = THICKNESS * SIZE_M;
      const relief = SLABS[id].relief ? reliefGrid(d) : null;
      const height = t + (relief ? (d.max - d.min) * d.exaggeration : 0);
      const mesh = slabMesh(area, z, t, texture, relief);
      const piece = { mesh, scale: 1, graphic: new Graphic({ geometry: mesh, attributes: { slab: id }, symbol: { type: 'mesh-3d', symbolLayers: [{ type: 'fill' }] } }) };
      placed.set(id, piece);
      graphics.push(piece.graphic);
      slabs.unshift({ id, title: def.title, corners: corners(area, z + height / 2) });
      z += height + GAP * SIZE_M;
    }
    // The bottom layer's label, next to the ground.
    if (groundId) {
      const title = defs.find((l) => l.id === groundId)!.title;
      slabs.push({ id: groundId, title, corners: cornerLonLats(area).map(([x, y]) => new Point({ x, y, z: dtmAt(d, x, y), spatialReference: marsSR() })) });
    }
    // Dashed guides from the ground up to the bottom of the stack.
    if (lifted.length) {
      for (const [lon, lat] of cornerLonLats(area)) {
        graphics.push(
          new Graphic({
            geometry: new Polyline({ paths: [[[lon, lat, dtmAt(d, lon, lat)], [lon, lat, bottom]]], hasZ: true, spatialReference: marsSR() }),
            symbol: { type: 'simple-line', color: [255, 209, 102, 0.8], width: 1.5, style: 'dash' },
          }),
        );
      }
    }
    stack.removeAll();
    stack.addMany(graphics);
    pieces = placed;
    animate(); // a slab still hovered grows again
    footprint.removeAll();
    if (groundId) {
      const ring = cornerLonLats(area);
      footprint.add(
        new Graphic({
          geometry: new Polyline({ paths: [[...ring, ring[0]]], spatialReference: marsSR() }),
          symbol: { type: 'simple-line', color: [255, 209, 102], width: 2 },
        }),
      );
    }
    return slabs;
  }

  return { layers: [footprint, stack], stack, update, highlight };
}

/** The base map layers over the area, composited like on the ground, from their own tiles. */
async function baseImage(area: Area, layers: Layer[]): Promise<HTMLCanvasElement> {
  const EXTENT = area.extent;
  const out = canvas(TEX_PX);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = NO_MAP_COLOR;
  ctx.fillRect(0, 0, TEX_PX, TEX_PX);
  const w = EXTENT.xmax - EXTENT.xmin;
  const h = EXTENT.ymax - EXTENT.ymin;
  for (const layer of layers as TiledLayer[]) {
    await layer.load();
    const info = layer.tileInfo;
    if (!info) continue;
    // The coarsest level that is at least as sharp as the texture.
    const lod = info.lods.find((l) => l.resolution <= w / TEX_PX) ?? info.lods[info.lods.length - 1];
    const tileDeg = info.size[0] * lod.resolution;
    const { x: ox, y: oy } = info.origin;
    const cols = [Math.floor((EXTENT.xmin - ox) / tileDeg), Math.floor((EXTENT.xmax - ox) / tileDeg)];
    const rows = [Math.floor((oy - EXTENT.ymax) / tileDeg), Math.floor((oy - EXTENT.ymin) / tileDeg)];
    const tiles: { row: number; col: number }[] = [];
    for (let row = rows[0]; row <= rows[1]; row++) for (let col = cols[0]; col <= cols[1]; col++) tiles.push({ row, col });
    const images = await Promise.all(tiles.map((t) => layer.fetchTile(lod.level, t.row, t.col).catch(() => null)));
    ctx.globalAlpha = layer.opacity;
    tiles.forEach(({ row, col }, i) => {
      const img = images[i];
      if (!img) return;
      const x = ((ox + col * tileDeg - EXTENT.xmin) / w) * TEX_PX;
      const y = ((EXTENT.ymax - (oy - row * tileDeg)) / h) * TEX_PX;
      ctx.drawImage(img, x, y, (tileDeg / w) * TEX_PX, (tileDeg / h) * TEX_PX);
    });
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = BASE_WASH;
  ctx.fillRect(0, 0, TEX_PX, TEX_PX);
  return out;
}

async function loadSliceData(site: Site, area: Area): Promise<SliceData> {
  const extent = new Extent({ ...area.extent, spatialReference: marsSR() });
  const n = RASTER_PX * RASTER_PX;
  const raster = async (file: string | undefined) => {
    if (!file) return new Float32Array(n); // no data of this kind at the site
    const layer = new ImageryTileLayer({ url: publicUrl(file) });
    await layer.load();
    const r = await layer.fetchPixels(extent, RASTER_PX, RASTER_PX);
    // Outside the raster's footprint the values are 0 with a mask: make them NaN (no data).
    const band = r.pixelBlock.pixels[0] as ArrayLike<number>;
    const mask = r.pixelBlock.mask as ArrayLike<number> | null | undefined;
    return Float32Array.from({ length: n }, (_, k) => (mask && !mask[k] ? NaN : band[k]));
  };
  const none = { features: [] };
  const json = (file: string | undefined) => (file ? fetch(publicUrl(file)).then((r) => r.json()) : Promise.resolve(none));
  const f = site.files;
  const [dtmRaw, slopeRaw, mineralRaw, traverse, samples, depot] = await Promise.all([
    raster(f.dtm),
    raster(f.slope),
    raster(f.minerals),
    json(f.traverse),
    json(f.samples),
    json(f.depot),
  ]);
  const dtm = new Float32Array(n);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = dtmRaw[k];
    dtm[k] = v <= -32767 || Number.isNaN(v) ? NaN : v;
    if (v > -32767) (min = Math.min(min, v)), (max = Math.max(max, v));
  }
  const exaggeration = Math.min(MAX_EXAGGERATION, (RELIEF_SHARE * area.sizeM) / Math.max(1, max - min));
  type F = { geometry: { coordinates: unknown }; properties: { kind?: string } };
  const pts = (fc: { features: F[] }) => fc.features.map((f) => f.geometry.coordinates as LonLat);
  return {
    area,
    ramp: elevationRamp(site),
    dtm,
    exaggeration,
    shade: hillshade(area, dtm, exaggeration),
    slope: Float32Array.from({ length: n }, (_, k) => slopeRaw[k]),
    mineral: Uint8Array.from({ length: n }, (_, k) => mineralRaw[k]),
    min,
    max,
    traverse: (traverse.features as F[]).map((f) => f.geometry.coordinates as LonLat[]),
    samples: (samples.features as F[]).map((f) => ({ c: f.geometry.coordinates as LonLat, kind: f.properties.kind ?? '' })),
    depot: pts(depot),
  };
}

/** Multiply-style hillshade, sun from the northwest at 45°, on the exaggerated relief. */
function hillshade(area: Area, dtm: Float32Array, exaggeration: number): Float32Array {
  const n = RASTER_PX;
  const [cx, cy] = [area.widthM / n, area.heightM / n];
  const out = new Float32Array(n * n).fill(1);
  const [sx, sy, sz] = [-0.5, 0.5, Math.SQRT1_2]; // toward the sun: northwest, 45° up
  const at = (i: number, j: number) => dtm[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const dzdx = ((at(i + 1, j) - at(i - 1, j)) / (2 * cx)) * exaggeration;
      const dzdy = ((at(i, j - 1) - at(i, j + 1)) / (2 * cy)) * exaggeration; // row 0 = north
      const lit = (-dzdx * sx - dzdy * sy + sz) / Math.hypot(dzdx, dzdy, 1);
      if (Number.isFinite(lit)) out[j * n + i] = 0.45 + (0.55 * Math.max(0, lit)) / sz;
    }
  return out;
}

function elevationColor(r: SliceData['ramp'], h: number, shade: number): readonly number[] | null {
  if (!Number.isFinite(h)) return null;
  let i = 1;
  while (i < r.length - 1 && h > r[i].at) i++;
  const t = Math.min(1, Math.max(0, (h - r[i - 1].at) / (r[i].at - r[i - 1].at)));
  return r[i].color.map((c, k) => Math.min(255, (r[i - 1].color[k] + (c - r[i - 1].color[k]) * t) * shade));
}

function canvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Draws a data raster over the slab: colored where color() returns a color, clear elsewhere. */
function rasterOverlay(ctx: CanvasRenderingContext2D, color: (k: number) => readonly number[] | null) {
  const n = RASTER_PX;
  const layer = canvas(n);
  const lctx = layer.getContext('2d')!;
  const img = lctx.createImageData(n, n);
  for (let k = 0; k < n * n; k++) {
    const c = color(k);
    if (c) img.data.set([c[0], c[1], c[2], 255], k * 4);
  }
  lctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layer, 0, 0, TEX_PX, TEX_PX);
}

/** Texture pixel of a lon/lat. */
function xy({ extent: EXTENT }: Area, [lon, lat]: LonLat): [number, number] {
  return [((lon - EXTENT.xmin) / (EXTENT.xmax - EXTENT.xmin)) * TEX_PX, ((EXTENT.ymax - lat) / (EXTENT.ymax - EXTENT.ymin)) * TEX_PX];
}

function dot(ctx: CanvasRenderingContext2D, [x, y]: [number, number], r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Relief heights above the slab's top, meters (exaggerated), on the relief mesh grid. */
function reliefGrid(d: SliceData): { size: number; z: Float32Array } {
  const size = RASTER_PX / RELIEF_STEP;
  const z = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const h = d.dtm[Math.min(RASTER_PX - 1, j * RELIEF_STEP) * RASTER_PX + Math.min(RASTER_PX - 1, i * RELIEF_STEP)];
      z[j * size + i] = Number.isFinite(h) ? (h - d.min) * d.exaggeration : NaN;
    }
  // Where the DTM has no data (Gale's mosaic has an irregular outline), grow the surface outward from its
  // neighbours, so the slab has a smooth edge instead of a comb of spikes. Only the mesh: no colors are drawn there.
  for (let pass = 0, missing = true; missing && pass < size; pass++) {
    missing = false;
    const prev = z.slice();
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        if (!Number.isNaN(prev[j * size + i])) continue;
        let sum = 0, n = 0;
        for (const [dj, di] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const jj = j + dj, ii = i + di;
          if (jj < 0 || ii < 0 || jj >= size || ii >= size) continue;
          const v = prev[jj * size + ii];
          if (!Number.isNaN(v)) (sum += v), n++;
        }
        if (n) z[j * size + i] = sum / n;
        else missing = true;
      }
  }
  for (let k = 0; k < z.length; k++) if (Number.isNaN(z[k])) z[k] = 0;
  return { size, z };
}

/** A slab: textured top (flat, or the relief grid) with plain side walls, its bottom at height z (m). */
function slabMesh(area: Area, z: number, thickness: number, texture: HTMLCanvasElement, relief: { size: number; z: Float32Array } | null): Mesh {
  const size = relief?.size ?? 2;
  const { widthM: WIDTH_M, heightM: HEIGHT_M } = area;
  const [hw, hh] = [WIDTH_M / 2, HEIGHT_M / 2];
  const at = (i: number, j: number): [number, number] => [-hw + (i / (size - 1)) * WIDTH_M, hh - (j / (size - 1)) * HEIGHT_M];
  const position: number[] = [];
  const uv: number[] = [];
  const top: number[] = [];
  const sides: number[] = [];
  const topZ = (i: number, j: number) => thickness + (relief ? relief.z[j * size + i] : 0);

  // Top grid, row 0 = north (texture row 0).
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      position.push(...at(i, j), topZ(i, j));
      uv.push(i / (size - 1), j / (size - 1));
    }
  for (let j = 0; j < size - 1; j++)
    for (let i = 0; i < size - 1; i++) {
      const a = j * size + i, b = a + 1, d = a + size, e = d + 1;
      top.push(a, d, b, b, d, e);
    }
  // Side walls: each edge of the top, dropped to the slab's bottom.
  const edges = [
    Array.from({ length: size }, (_, i) => [i, 0]),
    Array.from({ length: size }, (_, i) => [i, size - 1]),
    Array.from({ length: size }, (_, j) => [0, j]),
    Array.from({ length: size }, (_, j) => [size - 1, j]),
  ];
  for (const edge of edges) {
    const start = position.length / 3;
    for (const [i, j] of edge) {
      position.push(...at(i, j), topZ(i, j), ...at(i, j), 0);
      uv.push(0, 0, 0, 0);
    }
    for (let m = 0; m < edge.length - 1; m++) {
      const a = start + m * 2;
      sides.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return new Mesh({
    spatialReference: marsSR(),
    vertexSpace: new MeshLocalVertexSpace({ origin: [area.center.lon, area.center.lat, z] }),
    vertexAttributes: { position: new Float64Array(position), uv: new Float32Array(uv) },
    components: [
      new MeshComponent({ faces: new Uint32Array(top), material: new MeshMaterial({ colorTexture: new MeshTexture({ data: texture, transparent: true }), alphaMode: 'blend', doubleSided: true }) }),
      new MeshComponent({ faces: new Uint32Array(sides), material: new MeshMaterial({ color: SIDE_COLOR, alphaMode: 'blend', doubleSided: true }) }),
    ],
  });
}

function cornerLonLats({ extent: EXTENT }: Area): [number, number][] {
  return [
    [EXTENT.xmin, EXTENT.ymin],
    [EXTENT.xmax, EXTENT.ymin],
    [EXTENT.xmax, EXTENT.ymax],
    [EXTENT.xmin, EXTENT.ymax],
  ];
}

function corners(area: Area, z: number): Point[] {
  return cornerLonLats(area).map(([x, y]) => new Point({ x, y, z, spatialReference: marsSR() }));
}

function dtmAt(d: SliceData, lon: number, lat: number): number {
  const EXTENT = d.area.extent;
  const i = Math.min(RASTER_PX - 1, Math.round(((lon - EXTENT.xmin) / (EXTENT.xmax - EXTENT.xmin)) * (RASTER_PX - 1)));
  const j = Math.min(RASTER_PX - 1, Math.round(((EXTENT.ymax - lat) / (EXTENT.ymax - EXTENT.ymin)) * (RASTER_PX - 1)));
  const v = d.dtm[j * RASTER_PX + i];
  return Number.isFinite(v) ? v : d.min;
}
