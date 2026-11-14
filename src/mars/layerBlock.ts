/*
 * Elevation: MOLA (NASA), exaggerated for display.
 *
 * Exploded block diagram for the Front view: a square slice of terrain cut out
 * at the site and drawn as one slab per visible layer, stacked with gaps so no
 * layer covers another. The "height" slab carries the MOLA relief (fixed 10×,
 * measured from the slice's lowest point); other slabs are flat, with their data
 * colored on top. The surface slab uses the globe's own color texture, so it
 * matches the planet; in the Front view the slabs rise out of the globe at the
 * site (see LayerBlockView). The temperature layer is SIMULATED (placeholder data, see
 * simulatedTemperature below), not a measurement. A footprint on the globe marks where the slice was cut from.
 *
 * Built in the site's local frame (x east, y up, z south) and placed on the
 * globe; at slice scale (≤ ~150 km) the surface curvature is negligible.
 */
import * as THREE from 'three';
import { MARS_RADIUS_KM, MARS_RADIUS_M, TEXTURE_LON_OFFSET_DEG, latLonToVec3, localToDirection, tangentFrame, vec3ToLatLon } from './geo';
import { sampleGrid, slopeAt, type MolaGrid } from './mola';
import type { Site } from './sites';

/** Fixed vertical exaggeration: real relief is too small to see at this scale. */
export const VERTICAL_EXAGGERATION = 10;

type Ramp = [number, THREE.ColorRepresentation][];
/** Height colors, low → high, over the slice's own range (used until the globe texture has loaded). */
export const HEIGHT_RAMP: Ramp = [
  [0, '#0b1d51'], // low: dark blue
  [0.35, '#2e7d5b'], // green
  [0.65, '#c8a46a'], // tan
  [1, '#ffffff'], // high: white
];
/** Slope colors, flat → steep, from 0° to SLOPE_MAX_DEG. */
export const SLOPE_RAMP: Ramp = [
  [0, '#1d2b45'],
  [0.3, '#2f7f86'],
  [0.65, '#e2b95b'],
  [1, '#c4453c'],
];
export const SLOPE_MAX_DEG = 30;
/** Temperature colors, cold → warm, over the slice's own range. */
export const TEMPERATURE_RAMP: Ramp = [
  [0, '#2b1a5c'], // cold: indigo
  [0.35, '#7b3294'], // purple
  [0.7, '#e66101'], // orange
  [1, '#fdb863'], // warm: light amber
];

// Proportions, as fractions of the slice width.
const SLAB_THICKNESS = 0.05;
const GAP = 0.07;
const LIFT = 0.2; // bottom of the stack above the globe
const SAMPLES = 128; // per side

export type BlockSlab = { layerId: string; label: string; detail: string; anchor: THREE.Vector3 };
export type LayerBlock = {
  group: THREE.Group;
  pieces: { object: THREE.Object3D; finalY: number }[]; // slabs, top to bottom, in block-local y
  guides: THREE.Object3D; // dashed lines from the footprint up to the stack
  stackTop: number; // block-local y of the stack's top
  slabs: BlockSlab[]; // top to bottom; anchor = slab center in world space, for labels
  corners: THREE.Vector3[]; // the stack's bounding box corners in world space
  center: THREE.Vector3; // middle of the stack, world space
  radius: number; // bounding sphere of the stack
  dispose(): void;
};

type SlabBuilder = (s: Slice, colorMap: THREE.Texture | null) => { object: THREE.Object3D; height: number; detail: string };
type Slice = { width: number; lat: number; elev: Float32Array; slope: Float32Array; uv: Float32Array; min: number; max: number };

/** Layer id → slab. Add an entry here (and to INITIAL_LAYERS) for a new layer. */
const SLABS: Record<string, SlabBuilder> = {
  height: (s, colorMap) => {
    const relief = (s.max - s.min) * (VERTICAL_EXAGGERATION / MARS_RADIUS_M);
    const t = s.width * SLAB_THICKNESS;
    const colors = s.elev.map((h) => (h - s.min) / (s.max - s.min || 1));
    return {
      object: reliefSlab(s, t, colors, HEIGHT_RAMP, colorMap),
      height: t + relief,
      detail: `${km(s.min)} to ${km(s.max)} km · ${VERTICAL_EXAGGERATION}× vertical`,
    };
  },
  temperature: (s) => {
    const t = s.width * SLAB_THICKNESS;
    const temp = simulatedTemperature(s);
    let lo = Infinity, hi = -Infinity;
    for (const v of temp) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    const values = temp.map((v) => (v - lo) / (hi - lo || 1));
    return { object: flatSlab(s.width, t, values, TEMPERATURE_RAMP), height: t, detail: `${lo.toFixed(0)} to ${hi.toFixed(0)} °C · simulated` };
  },
  slope: (s) => {
    const t = s.width * SLAB_THICKNESS;
    const values = s.slope.map((d) => (Number.isFinite(d) ? d / SLOPE_MAX_DEG : 0));
    return { object: flatSlab(s.width, t, values, SLOPE_RAMP), height: t, detail: `0° to ${SLOPE_MAX_DEG}°+` };
  },
};

/** Builds the block for the given layers (top to bottom). Returns null when none can be drawn. */
export function buildLayerBlock(
  site: Site,
  grid: MolaGrid,
  layers: { id: string; label: string }[],
  colorMap: THREE.Texture | null = null, // the globe's texture, for the surface slab
): LayerBlock | null {
  const usable = layers.filter((l) => SLABS[l.id] || void console.warn(`No slab builder for layer "${l.id}"`));
  if (!usable.length) return null;

  const slice = sampleSlice(site, grid);
  const w = slice.width;
  const group = new THREE.Group();
  group.name = `layer-block:${site.id}`;

  // Stack from the bottom up.
  const built = usable.map((l) => ({ layer: l, ...SLABS[l.id](slice, colorMap) }));
  let y = LIFT * w;
  const mids: number[] = [];
  for (let i = built.length - 1; i >= 0; i--) {
    built[i].object.position.y = y;
    group.add(built[i].object);
    mids[i] = y + built[i].height / 2;
    y += built[i].height + GAP * w;
  }
  const top = y - GAP * w;
  const bottom = LIFT * w;
  const { outline, guides } = footprint(w, bottom);
  group.add(outline, guides);

  const f = tangentFrame(latLonToVec3(site.lat, site.lon));
  const south = f.north.clone().negate();
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.east, f.up, south));
  group.position.copy(f.up);
  group.updateMatrixWorld(true);

  const world = (x: number, yy: number, z: number) => group.localToWorld(new THREE.Vector3(x, yy, z));
  const h = w / 2;
  const corners = [bottom, top].flatMap((yy) => [world(-h, yy, -h), world(h, yy, -h), world(-h, yy, h), world(h, yy, h)]);
  return {
    group,
    pieces: built.map((b) => ({ object: b.object, finalY: b.object.position.y })),
    guides,
    stackTop: top,
    slabs: built.map((b, i) => ({ layerId: b.layer.id, label: b.layer.label, detail: b.detail, anchor: world(0, mids[i], 0) })),
    corners,
    center: world(0, (bottom + top) / 2, 0),
    radius: Math.hypot(h * Math.SQRT2, (top - bottom) / 2),
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of [m.material].flat()) {
          const map = (mat as THREE.MeshStandardMaterial | undefined)?.map;
          if (map instanceof THREE.DataTexture) map.dispose(); // the globe's texture is shared: keep it
          (mat as THREE.Material | undefined)?.dispose();
        }
      });
    },
  };
}

/** MOLA elevation and slope on a SAMPLES × SAMPLES grid over the slice, row 0 = south. */
function sampleSlice(site: Site, grid: MolaGrid): Slice {
  const f = tangentFrame(latLonToVec3(site.lat, site.lon));
  const half = site.sliceKm / 2;
  const n = SAMPLES;
  const elev = new Float32Array(n * n);
  const slope = new Float32Array(n * n);
  const uv = new Float32Array(n * n * 2);
  const u0 = texU(site.lon);
  const dir = new THREE.Vector3();
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      localToDirection(f, -half + (i / (n - 1)) * 2 * half, -half + (j / (n - 1)) * 2 * half, dir);
      const { lat, lon } = vec3ToLatLon(dir);
      const h = sampleGrid(grid, lat, lon);
      elev[j * n + i] = h;
      slope[j * n + i] = slopeAt(grid, lat, lon);
      // Same texture coordinates as THREE.SphereGeometry at this lat/lon (unwrapped around the site).
      let u = texU(lon);
      if (u - u0 > 0.5) u -= 1;
      if (u0 - u > 0.5) u += 1;
      uv[(j * n + i) * 2] = u;
      uv[(j * n + i) * 2 + 1] = (lat + 90) / 180;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  if (!Number.isFinite(min)) throw new Error(`The MOLA grid for ${site.name} does not cover its slice`);
  for (let k = 0; k < elev.length; k++) if (Number.isNaN(elev[k])) elev[k] = min;
  return { width: site.sliceKm / MARS_RADIUS_KM, lat: site.lat, elev, slope, uv, min, max };
}

function texU(lon: number) {
  return ((((lon + 180 + TEXTURE_LON_OFFSET_DEG) / 360) % 1) + 1) % 1;
}

/**
 * SIMULATED afternoon surface temperature in °C: placeholder data, not a measurement.
 * Shaped to look plausible: colder toward the poles and at altitude (~2.5 °C/km),
 * warmer on slopes facing the equator, plus smooth deterministic variation.
 */
function simulatedTemperature(s: Slice): Float32Array {
  const n = SAMPLES;
  const cellM = (s.width * MARS_RADIUS_M) / (n - 1);
  const mean = s.elev.reduce((a, b) => a + b, 0) / s.elev.length;
  const base = -20 - 45 * Math.abs(s.lat / 90) ** 1.5;
  const toEquator = s.lat >= 0 ? -1 : 1; // +1 = north
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const at = (ii: number, jj: number) => s.elev[THREE.MathUtils.clamp(jj, 0, n - 1) * n + THREE.MathUtils.clamp(ii, 0, n - 1)];
      const dzNorth = (at(i, j + 1) - at(i, j - 1)) / (2 * cellM); // row index increases northward
      // Ground that faces the equator tilts toward the sun: its height falls toward the equator.
      const sunFacing = -dzNorth * toEquator;
      const x = i / (n - 1), y = j / (n - 1);
      const wobble = Math.sin(x * 7.3 + 1.1) * Math.cos(y * 5.9 + 0.4) + 0.5 * Math.sin((x + y) * 13.7 + 2.3);
      out[k] = base - 2.5 * ((s.elev[k] - mean) / 1000) + 60 * THREE.MathUtils.clamp(sunFacing, -0.3, 0.3) + 4 * wobble;
    }
  }
  return out;
}

/**
 * Slab whose top is the exaggerated relief, with side walls down to a flat bottom.
 * With colorMap it shows the globe's texture (walls darkened); otherwise the height ramp.
 */
function reliefSlab(s: Slice, thickness: number, t: Float32Array, ramp: Ramp, colorMap: THREE.Texture | null): THREE.Mesh {
  const n = SAMPLES;
  const h = s.width / 2;
  const scale = VERTICAL_EXAGGERATION / MARS_RADIUS_M;
  const pos: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const tint = (k: number, shade: number) =>
    colorMap ? c.setScalar(shade) : rampColor(t[k], ramp, c).multiplyScalar(shade);
  const c = new THREE.Color();
  const xAt = (i: number) => -h + (i / (n - 1)) * s.width;
  const zAt = (j: number) => h - (j / (n - 1)) * s.width; // row 0 = south = +z
  const yAt = (k: number) => thickness + (s.elev[k] - s.min) * scale;

  // Top surface.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      pos.push(xAt(i), yAt(k), zAt(j));
      tint(k, 1).toArray(col, col.length);
      uvs.push(s.uv[k * 2], s.uv[k * 2 + 1]);
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }

  // Side walls: each edge of the top, dropped to y = 0. Darker toward the bottom.
  const edges: number[][] = [
    Array.from({ length: n }, (_, i) => i), // south
    Array.from({ length: n }, (_, i) => (n - 1) * n + i), // north
    Array.from({ length: n }, (_, j) => j * n), // west
    Array.from({ length: n }, (_, j) => j * n + n - 1), // east
  ];
  for (const edge of edges) {
    const start = pos.length / 3;
    for (const k of edge) {
      const x = pos[k * 3], z = pos[k * 3 + 2];
      pos.push(x, pos[k * 3 + 1], z);
      tint(k, 0.55).toArray(col, col.length);
      pos.push(x, 0, z);
      tint(k, 0.25).toArray(col, col.length);
      uvs.push(s.uv[k * 2], s.uv[k * 2 + 1], s.uv[k * 2], s.uv[k * 2 + 1]);
    }
    for (let m = 0; m < edge.length - 1; m++) {
      const a = start + m * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: colorMap, vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  return new THREE.Mesh(g, mat);
}

/** Flat slab with the layer's values colored on its top face. */
function flatSlab(width: number, thickness: number, t: Float32Array, ramp: Ramp): THREE.Mesh {
  const n = SAMPLES;
  const data = new Uint8Array(n * n * 4);
  const c = new THREE.Color();
  for (let k = 0; k < n * n; k++) {
    rampColor(t[k], ramp, c).convertLinearToSRGB();
    data.set([c.r * 255, c.g * 255, c.b * 255, 255], k * 4);
  }
  const tex = new THREE.DataTexture(data, n, n); // row 0 = south = v 0 on the box's top face
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const side = rampColor(0.5, ramp, new THREE.Color()).multiplyScalar(0.4);
  const sideMat = new THREE.MeshStandardMaterial({ color: side, roughness: 0.9, metalness: 0 });
  const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
  // BoxGeometry faces: +x, -x, +y (top), -y, +z, -z
  const geo = new THREE.BoxGeometry(width, thickness, width).translate(0, thickness / 2, 0);
  return new THREE.Mesh(geo, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
}

/** Outline of the slice on the globe plus dashed guides up to the stack. */
function footprint(width: number, stackBottom: number) {
  const h = width / 2;
  const y = width * 0.002;
  const corners = [new THREE.Vector3(-h, y, -h), new THREE.Vector3(h, y, -h), new THREE.Vector3(h, y, h), new THREE.Vector3(-h, y, h)];
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(corners),
    new THREE.LineBasicMaterial({ color: '#ffd166' }),
  );
  const guides = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(corners.flatMap((p) => [p, new THREE.Vector3(p.x, stackBottom, p.z)])),
    new THREE.LineDashedMaterial({ color: '#ffd166', dashSize: width * 0.03, gapSize: width * 0.03, transparent: true, opacity: 0.7 }),
  );
  guides.computeLineDistances();
  return { outline, guides };
}

/** Color for t in 0–1 from a ramp. */
export function rampColor(t: number, ramp: Ramp, out = new THREE.Color()): THREE.Color {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  for (let s = 1; s < ramp.length; s++) {
    const [t1, c1] = ramp[s];
    if (x <= t1 || s === ramp.length - 1) {
      const [t0, c0] = ramp[s - 1];
      return out.set(c0).lerp(new THREE.Color(c1), (x - t0) / (t1 - t0 || 1));
    }
  }
  return out.set(ramp[0][1]);
}

const km = (m: number) => (m / 1000).toFixed(1);
