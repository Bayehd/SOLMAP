// Side view: a square of Jezero around the rover's route, pulled apart into one slab per data layer and
// stacked above the ground (an exploded block diagram), so each layer can be seen on its own.
// Slabs are drawn from the same files as the map layers; the ground under the stack keeps the base map.
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
import { ELEVATION_RAMP, LAYERS, MINERAL_CLASSES, SAMPLE_KINDS, SLOPE_CLASSES } from './layers';
import { METERS_PER_DEGREE, marsSR, publicUrl } from './mars';

/** Center and width of the cut-out: the rover's route from the crater floor up the delta (all inside the 20 m DTM). */
const CENTER = { lon: 77.34, lat: 18.46 };
const SLICE_M = 16_000;
/** Relief on the elevation slab is exaggerated so the delta and crater rim read at this scale. */
const VERTICAL_EXAGGERATION = 2;
// Proportions, as fractions of the slice width.
const THICKNESS = 0.015;
const GAP = 0.16;
const LIFT = 0.1; // bottom of the stack above the highest ground in the slice
const RASTER_PX = 512; // raster samples per side (~31 m)
const VECTOR_PX = 1024; // texture size for the vector slabs, so thin lines stay sharp
const RELIEF_STEP = 4; // relief mesh = every 4th raster sample (128 × 128)
// Slabs are see-through except where they carry data, so the slabs below stay visible.
const SLAB_FILL = 'rgba(60, 66, 80, 0.3)';
const SIDE_COLOR = [70, 76, 92, 0.6];

const HALF_LON = SLICE_M / 2 / (METERS_PER_DEGREE * Math.cos((CENTER.lat * Math.PI) / 180));
const HALF_LAT = SLICE_M / 2 / METERS_PER_DEGREE;
const EXTENT = { xmin: CENTER.lon - HALF_LON, xmax: CENTER.lon + HALF_LON, ymin: CENTER.lat - HALF_LAT, ymax: CENTER.lat + HALF_LAT };

/** Layer id → how its slab looks. Layers without an entry (the base maps) stay on the ground. */
const SLABS: Record<string, (d: SliceData) => SlabArt> = {
  'jezero-elevation': (d) => ({
    texture: rasterCanvas((k) => elevationColor(d.dtm[k], d.shade[k])),
    relief: true,
    detail: `${Math.round(d.min)} to ${Math.round(d.max)} m · ${VERTICAL_EXAGGERATION}× vertical`,
  }),
  'jezero-slope': (d) => ({
    texture: rasterCanvas((k) => {
      const s = d.slope[k];
      if (!(s >= 0)) return null;
      const c = SLOPE_CLASSES.find((c) => s < c.max) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
      return c.painted ? c.color : null; // as on the map: walkable ground is left clear
    }),
    detail: SLOPE_CLASSES.map((c) => c.label.split(' ')[0]).join(' · '),
  }),
  'jezero-minerals': (d) => ({
    texture: rasterCanvas((k) => MINERAL_CLASSES[d.mineral[k] - 1]?.color ?? null),
    detail: 'CRISM, uncolored = none detected or no coverage',
  }),
  'm20-traverse': (d) => ({
    texture: vectorCanvas((ctx, xy) => {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 8;
      for (const line of d.traverse) {
        ctx.beginPath();
        line.forEach((c, i) => (i ? ctx.lineTo(...xy(c)) : ctx.moveTo(...xy(c))));
        ctx.stroke();
      }
    }),
  }),
  'm20-waypoints': (d) => ({ texture: vectorCanvas((ctx, xy) => d.stops.forEach((c) => dot(ctx, xy(c), 7, '#ffd166'))) }),
  'm20-samples': (d) => ({
    texture: vectorCanvas((ctx, xy) =>
      d.samples.forEach((s) => dot(ctx, xy(s.c), 13, `rgb(${(SAMPLE_KINDS.find((k) => k.label === s.kind) ?? SAMPLE_KINDS[0]).color.join(',')})`)),
    ),
  }),
  'm20-depot': (d) => ({
    texture: vectorCanvas((ctx, xy) =>
      d.depot.forEach((c) => {
        const [x, y] = xy(c);
        ctx.fillStyle = '#ff3dc8';
        ctx.beginPath();
        ctx.moveTo(x, y - 16), ctx.lineTo(x + 16, y), ctx.lineTo(x, y + 16), ctx.lineTo(x - 16, y);
        ctx.fill();
      }),
    ),
    detail: 'tiny at this scale: 10 tubes within ~100 m',
  }),
};

export const STACKABLE = new Set(Object.keys(SLABS));

type LonLat = [number, number];
type SliceData = {
  dtm: Float32Array; // meters, row 0 = north; NaN = no data
  shade: Float32Array; // 0–1 hillshade
  slope: Float32Array; // degrees
  mineral: Uint8Array; // MINERAL_CLASSES index + 1, 0 = none
  min: number;
  max: number;
  traverse: LonLat[][];
  stops: LonLat[];
  samples: { c: LonLat; kind: string }[];
  depot: LonLat[];
};
type SlabArt = { texture: HTMLCanvasElement; relief?: boolean; detail?: string };

/** A slab as placed in the stack, for the labels: its corners at mid-height. */
export type StackSlab = { id: string; title: string; detail: string; corners: Point[] };

let data: Promise<SliceData> | null = null;

export function createLayerStack() {
  const stack = new GraphicsLayer({ id: 'side-stack', title: 'Side view stack', visible: false, elevationInfo: { mode: 'absolute-height' } });
  const footprint = new GraphicsLayer({ id: 'side-footprint', title: 'Side view footprint', visible: false, elevationInfo: { mode: 'on-the-ground' } });
  let built = new Map<string, SlabArt>(); // textures are kept between rebuilds

  /** Rebuild the stack with these layer ids, bottom to top. Returns the slabs placed, top to bottom. */
  async function update(ids: string[]): Promise<StackSlab[]> {
    data ??= loadSliceData();
    const d = await data;
    const ordered = ids.filter((id) => SLABS[id]);
    const art = new Map(ordered.map((id) => [id, built.get(id) ?? SLABS[id](d)]));
    built = new Map([...built, ...art]);

    const graphics: Graphic[] = [];
    const slabs: StackSlab[] = [];
    const bottom = d.max + LIFT * SLICE_M;
    let z = bottom;
    for (const id of ordered) {
      const a = art.get(id)!;
      const t = THICKNESS * SLICE_M;
      const relief = a.relief ? reliefGrid(d) : null;
      const height = t + (relief ? (d.max - d.min) * VERTICAL_EXAGGERATION : 0);
      graphics.push(new Graphic({ geometry: slabMesh(z, t, a.texture, relief), symbol: { type: 'mesh-3d', symbolLayers: [{ type: 'fill' }] } }));
      const def = LAYERS.find((l) => l.id === id)!;
      slabs.unshift({ id, title: def.title, detail: a.detail ?? def.resolution, corners: corners(z + height / 2) });
      z += height + GAP * SLICE_M;
    }
    // Dashed guides from the ground up to the bottom of the stack.
    if (ordered.length) {
      for (const [lon, lat] of cornerLonLats()) {
        const ground = dtmAt(d, lon, lat);
        graphics.push(
          new Graphic({
            geometry: new Polyline({ paths: [[[lon, lat, ground], [lon, lat, bottom]]], hasZ: true, spatialReference: marsSR() }),
            symbol: { type: 'simple-line', color: [255, 209, 102, 0.8], width: 1.5, style: 'dash' },
          }),
        );
      }
    }
    stack.removeAll();
    stack.addMany(graphics);
    footprint.removeAll();
    if (ordered.length) {
      const ring = cornerLonLats();
      footprint.add(
        new Graphic({
          geometry: new Polyline({ paths: [[...ring, ring[0]]], spatialReference: marsSR() }),
          symbol: { type: 'simple-line', color: [255, 209, 102], width: 2 },
        }),
      );
    }
    return slabs;
  }

  return { layers: [footprint, stack], stack, update };
}

async function loadSliceData(): Promise<SliceData> {
  const extent = new Extent({ ...EXTENT, spatialReference: marsSR() });
  const raster = async (file: string) => {
    const layer = new ImageryTileLayer({ url: publicUrl(`data/jezero/${file}`) });
    await layer.load();
    const r = await layer.fetchPixels(extent, RASTER_PX, RASTER_PX);
    return r.pixelBlock.pixels[0] as ArrayLike<number>;
  };
  const json = (file: string) => fetch(publicUrl(`data/jezero/${file}`)).then((r) => r.json());
  const [dtmRaw, slopeRaw, mineralRaw, traverse, stops, samples, depot] = await Promise.all([
    raster('ctx_dtm_20m.tif'),
    raster('ctx_slope_20m.tif'),
    raster('crism_minerals_20m.tif'),
    json('m20_traverse.geojson'),
    json('m20_waypoints.geojson'),
    json('m20_samples.geojson'),
    json('m20_depot.geojson'),
  ]);
  const n = RASTER_PX * RASTER_PX;
  const dtm = new Float32Array(n);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = dtmRaw[k];
    dtm[k] = v <= -32767 ? NaN : v;
    if (v > -32767) (min = Math.min(min, v)), (max = Math.max(max, v));
  }
  type F = { geometry: { coordinates: unknown }; properties: { kind?: string } };
  const pts = (fc: { features: F[] }) => fc.features.map((f) => f.geometry.coordinates as LonLat);
  return {
    dtm,
    shade: hillshade(dtm),
    slope: Float32Array.from({ length: n }, (_, k) => slopeRaw[k]),
    mineral: Uint8Array.from({ length: n }, (_, k) => mineralRaw[k]),
    min,
    max,
    traverse: (traverse.features as F[]).map((f) => f.geometry.coordinates as LonLat[]),
    stops: pts(stops),
    samples: (samples.features as F[]).map((f) => ({ c: f.geometry.coordinates as LonLat, kind: f.properties.kind ?? '' })),
    depot: pts(depot),
  };
}

/** Multiply-style hillshade, sun from the northwest at 45°, on the exaggerated relief. */
function hillshade(dtm: Float32Array): Float32Array {
  const n = RASTER_PX;
  const cell = SLICE_M / n;
  const out = new Float32Array(n * n).fill(1);
  const [sx, sy, sz] = [-0.5, 0.5, Math.SQRT1_2]; // toward the sun: northwest, 45° up
  const at = (i: number, j: number) => dtm[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const dzdx = ((at(i + 1, j) - at(i - 1, j)) / (2 * cell)) * VERTICAL_EXAGGERATION;
      const dzdy = ((at(i, j - 1) - at(i, j + 1)) / (2 * cell)) * VERTICAL_EXAGGERATION; // row 0 = north
      const len = Math.hypot(dzdx, dzdy, 1);
      const lit = (-dzdx * sx - dzdy * sy + sz) / len;
      if (Number.isFinite(lit)) out[j * n + i] = 0.45 + 0.55 * Math.max(0, lit) / sz;
    }
  return out;
}

function elevationColor(h: number, shade: number): readonly number[] | null {
  if (!Number.isFinite(h)) return null;
  const r = ELEVATION_RAMP;
  let i = 1;
  while (i < r.length - 1 && h > r[i].at) i++;
  const t = Math.min(1, Math.max(0, (h - r[i - 1].at) / (r[i].at - r[i - 1].at)));
  return r[i].color.map((c, k) => Math.min(255, (r[i - 1].color[k] + (c - r[i - 1].color[k]) * t) * shade));
}

function rasterCanvas(color: (k: number) => readonly number[] | null): HTMLCanvasElement {
  const n = RASTER_PX;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = SLAB_FILL;
  ctx.fillRect(0, 0, n, n);
  const img = ctx.getImageData(0, 0, n, n);
  for (let k = 0; k < n * n; k++) {
    const c = color(k);
    if (c) img.data.set([c[0], c[1], c[2], 255], k * 4);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function vectorCanvas(draw: (ctx: CanvasRenderingContext2D, xy: (c: LonLat) => [number, number]) => void): HTMLCanvasElement {
  const n = VECTOR_PX;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = SLAB_FILL;
  ctx.fillRect(0, 0, n, n);
  ctx.lineJoin = ctx.lineCap = 'round';
  draw(ctx, ([lon, lat]) => [((lon - EXTENT.xmin) / (EXTENT.xmax - EXTENT.xmin)) * n, ((EXTENT.ymax - lat) / (EXTENT.ymax - EXTENT.ymin)) * n]);
  return canvas;
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
      z[j * size + i] = Number.isFinite(h) ? (h - d.min) * VERTICAL_EXAGGERATION : 0;
    }
  return { size, z };
}

/** A slab: textured top (flat, or the relief grid) with plain side walls, its bottom at height z (m). */
function slabMesh(z: number, thickness: number, texture: HTMLCanvasElement, relief: { size: number; z: Float32Array } | null): Mesh {
  const size = relief?.size ?? 2;
  const h = SLICE_M / 2;
  const position: number[] = [];
  const uv: number[] = [];
  const top: number[] = [];
  const sides: number[] = [];
  const topZ = (i: number, j: number) => thickness + (relief ? relief.z[j * size + i] : 0);

  // Top grid, row 0 = north (texture row 0).
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      position.push(-h + (i / (size - 1)) * SLICE_M, h - (j / (size - 1)) * SLICE_M, topZ(i, j));
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
      const x = -h + (i / (size - 1)) * SLICE_M, y = h - (j / (size - 1)) * SLICE_M;
      position.push(x, y, topZ(i, j), x, y, 0);
      uv.push(0, 0, 0, 0);
    }
    for (let m = 0; m < edge.length - 1; m++) {
      const a = start + m * 2;
      sides.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return new Mesh({
    spatialReference: marsSR(),
    vertexSpace: new MeshLocalVertexSpace({ origin: [CENTER.lon, CENTER.lat, z] }),
    vertexAttributes: { position: new Float64Array(position), uv: new Float32Array(uv) },
    components: [
      new MeshComponent({ faces: new Uint32Array(top), material: new MeshMaterial({ colorTexture: new MeshTexture({ data: texture, transparent: true }), alphaMode: 'blend', doubleSided: true }) }),
      new MeshComponent({ faces: new Uint32Array(sides), material: new MeshMaterial({ color: SIDE_COLOR, alphaMode: 'blend', doubleSided: true }) }),
    ],
  });
}

function cornerLonLats(): [number, number][] {
  return [
    [EXTENT.xmin, EXTENT.ymin],
    [EXTENT.xmax, EXTENT.ymin],
    [EXTENT.xmax, EXTENT.ymax],
    [EXTENT.xmin, EXTENT.ymax],
  ];
}

function corners(z: number): Point[] {
  return cornerLonLats().map(([x, y]) => new Point({ x, y, z, spatialReference: marsSR() }));
}

function dtmAt(d: SliceData, lon: number, lat: number): number {
  const i = Math.round(((lon - EXTENT.xmin) / (EXTENT.xmax - EXTENT.xmin)) * (RASTER_PX - 1));
  const j = Math.round(((EXTENT.ymax - lat) / (EXTENT.ymax - EXTENT.ymin)) * (RASTER_PX - 1));
  const v = d.dtm[j * RASTER_PX + i];
  return Number.isFinite(v) ? v : d.min;
}
