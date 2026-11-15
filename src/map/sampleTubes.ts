// Sample tubes and boards for the Rover view.
// Tubes: at each sample stop, a 3D sample tube (public/models/sample-tube.glb) lying on the ground, enlarged so it
// shows from the mast camera, with a marker above it. It lies just beside the route, so the rover and the route
// line don't cover it.
// Boards: clicking a tube stands a board on the ground near the rover, facing the camera: the sample's image,
// description and a small map of the route around it. Image and description come from the site's sample board
// file (filled in by hand, public/data/jezero/sample_board.json); the facts come from the NASA sample list.
import Graphic from '@arcgis/core/Graphic';
import Mesh from '@arcgis/core/geometry/Mesh';
import Point from '@arcgis/core/geometry/Point';
import MeshComponent from '@arcgis/core/geometry/support/MeshComponent';
import MeshLocalVertexSpace from '@arcgis/core/geometry/support/MeshLocalVertexSpace';
import MeshMaterialMetallicRoughness from '@arcgis/core/geometry/support/MeshMaterialMetallicRoughness';
import MeshTexture from '@arcgis/core/geometry/support/MeshTexture';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import type SceneView from '@arcgis/core/views/SceneView';
import { METERS_PER_DEGREE, marsSR, publicUrl } from './mars';
import { formatLatLon, type Site } from './sites';

const TUBE_LENGTH_M = 0.6; // the tube model lying on the ground (real: 0.3 m), twice that so it shows from the mast camera, still far smaller than the rover (~3 m long)
const TUBE_ASIDE_M = 6; // from the route to the tube's center, to the right of the direction of travel
const TUBE_VIEW_DIST_M = 12; // with a board up, the camera is at least this far from the tube, so the tube is in view
const MAX_LOOK_DOWN_DEG = 20; // with a board up, the camera looks down at most this much from level
const LOOK_DOWN_SPARE_DEG = 14; // a tube this far below the view's center is still well inside the view
const BOARD_DOWN_SPARE_DEG = 7; // the board's center this far below the view's center, so a far target near the horizon shows too
const PIN_HEIGHT_M = 5; // a marker this high above each tube, so it can be spotted (and clicked) from afar

export const BOARD_W_M = 2.8;
export const BOARD_H_M = 2.7;
const BOARD_LIFT_M = 0.3; // gap between the ground and the board's bottom edge
const BOARD_DIST_M = 11; // from the camera
const VIEW_LEFT_DEG = 12; // the camera looks this far left of the tube, so the tube shows right of center
const BOARD_LEFT_DEG = 13; // the board's center is this far left of where the camera looks
export const BOARD_PX = 900; // canvas height; width follows the board's shape, so text keeps its size
const MAP_RADIUS_M = 400; // the board's small map shows this far around the sample
// The board's "+" (take the sample), a round button in its top-right corner: center and radius in canvas pixels.
const PLUS_R_PX = 38;
const plusCenter = (W: number) => [W - 30 - PLUS_R_PX, 30 + PLUS_R_PX] as const;
// Taken samples ride on the rover's deck.
const DECK_HEIGHT_M = 1.2; // above the ground
const DECK_BACK_M = 0.4; // behind the rover's center
const DECK_SPACING_M = 0.14; // between tubes, side by side across the deck
const TAKE_MS = 1400; // the tube's flight from the ground to the deck
const TAKE_ARC_M = 2.5; // how high above the straight line it arcs

export type SampleTube = { number: number; name: string; kind: string; sol: number; lon: number; lat: number };
type Entry = { image?: string; imageCaption?: string; text?: string };
export type Line = [number, number][];
export type GeoJSON = { features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[] };


export const json = <T,>(path: string) =>
  fetch(publicUrl(path))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) as Promise<T | null>;

export const mPerDegLon = (lat: number) => METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);

export function routeLines(g: GeoJSON | null): Line[] {
  const out: Line[] = [];
  for (const f of g?.features ?? []) {
    if (f.geometry.type === 'LineString') out.push(f.geometry.coordinates as Line);
    else if (f.geometry.type === 'MultiLineString') out.push(...(f.geometry.coordinates as Line[]));
  }
  return out;
}

/** Direction of travel (degrees from north) where the route passes nearest to this point. */
function travelHeading(lines: Line[], lon: number, lat: number): number {
  const mx = mPerDegLon(lat);
  let best = { d: Infinity, h: 0 };
  for (const l of lines)
    for (let i = 0; i + 1 < l.length; i++) {
      const d = Math.hypot((l[i][0] - lon) * mx, (l[i][1] - lat) * METERS_PER_DEGREE);
      if (d >= best.d) continue;
      const dx = (l[i + 1][0] - l[i][0]) * mx;
      const dy = (l[i + 1][1] - l[i][1]) * METERS_PER_DEGREE;
      if (dx || dy) best = { d, h: (Math.atan2(dx, dy) * 180) / Math.PI };
    }
  return best.h;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // a canvas with a cross-origin image can't become a texture without it
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = /^https?:/.test(src) ? src : publicUrl(src);
  });
}

export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.push('');
  }
  return lines;
}

/** The board's face: title, facts, image, description and a small map, on a dark see-through panel. */
async function drawBoard(samples: SampleTube[], entries: (Entry | null)[], route: Line[], others: [number, number][], plus: boolean) {
  const H = BOARD_PX;
  const W = Math.round((H * BOARD_W_M) / BOARD_H_M);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(38, 33, 29, 0.78)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, H - 4);

  const pad = 44;
  const font = (px: number, weight = 400) => (ctx.font = `${weight} ${px}px system-ui, -apple-system, Segoe UI, sans-serif`);
  ctx.fillStyle = '#f2ede8';
  font(52, 700);
  ctx.fillText(samples.map((s) => s.name).join(' · '), pad, pad + 44);
  font(28);
  ctx.fillStyle = '#c9bfb5';
  const s0 = samples[0];
  ctx.fillText(samples.map((s) => `${s.kind}, sealed sol ${s.sol}`).join(' · '), pad, pad + 90);
  ctx.fillText(formatLatLon(s0.lat, s0.lon, 4), pad, pad + 126);

  // Images: up to two samples at this stop that have one, side by side (the twins of a pair show both cores).
  const imgBox = { x: pad, y: pad + 156, w: W - 2 * pad, h: Math.round(H * 0.37) };
  const withImage = entries.filter((e): e is Entry => !!e?.image).slice(0, 2);
  const loaded = await Promise.all(withImage.map((e) => loadImage(e.image!)));
  const shown = withImage.map((e, i) => ({ entry: e, img: loaded[i] })).filter((x) => x.img);
  if (shown.length) {
    const gap = 16;
    const cellW = (imgBox.w - gap * (shown.length - 1)) / shown.length;
    shown.forEach(({ entry, img }, i) => {
      const x0 = imgBox.x + i * (cellW + gap);
      ctx.fillStyle = 'rgba(20, 16, 13, 0.6)';
      ctx.fillRect(x0, imgBox.y, cellW, imgBox.h);
      // Fill the box when little is cut off; otherwise show the whole picture inside it.
      const cover = Math.max(cellW / img!.width, imgBox.h / img!.height);
      const contain = Math.min(cellW / img!.width, imgBox.h / img!.height);
      const k = contain / cover >= 0.75 ? cover : contain;
      const dw = img!.width * k;
      const dh = img!.height * k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, imgBox.y, cellW, imgBox.h);
      ctx.clip();
      ctx.drawImage(img!, x0 + (cellW - dw) / 2, imgBox.y + (imgBox.h - dh) / 2, dw, dh);
      ctx.restore();
      if (entry.imageCaption) {
        font(18);
        ctx.fillStyle = '#c9bfb5';
        let cap = entry.imageCaption;
        while (cap.length > 4 && ctx.measureText(cap).width > cellW) cap = cap.slice(0, -2).trimEnd() + '…';
        ctx.fillText(cap, x0, imgBox.y + imgBox.h + 24);
      }
    });
  } else {
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.strokeRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h);
    ctx.setLineDash([]);
    font(30);
    ctx.fillStyle = '#a99f96';
    ctx.textAlign = 'center';
    ctx.fillText('No image yet', imgBox.x + imgBox.w / 2, imgBox.y + imgBox.h / 2 + 10);
    ctx.textAlign = 'left';
  }

  // Bottom: description on the left, small map on the right.
  const top = imgBox.y + imgBox.h + 56;
  const mapS = H - top - pad - 10;
  const textW = W - 3 * pad - mapS;
  font(26);
  ctx.fillStyle = '#f2ede8';
  // One description per stop. If the twins each have their own text, label them by name.
  const texts = samples.map((s, i) => ({ name: s.name, t: entries[i]?.text?.trim() ?? '' })).filter((x) => x.t);
  const text = texts.map((x) => (texts.length > 1 ? `${x.name}: ` : '') + x.t).join('\n\n');
  let y = top + 10;
  for (const line of wrap(ctx, text || 'No description yet.', textW)) {
    if (y > H - pad - 20) break;
    ctx.fillText(line, pad, y);
    y += line ? 34 : 16;
  }

  const mx0 = W - pad - mapS;
  ctx.fillStyle = 'rgba(20, 16, 13, 0.6)';
  ctx.fillRect(mx0, top - 20, mapS, mapS);
  const px = ([lon, lat]: [number, number]): [number, number] => [
    mx0 + mapS / 2 + ((lon - s0.lon) * mPerDegLon(s0.lat) * mapS) / (2 * MAP_RADIUS_M),
    top - 20 + mapS / 2 - ((lat - s0.lat) * METERS_PER_DEGREE * mapS) / (2 * MAP_RADIUS_M),
  ];
  ctx.save();
  ctx.beginPath();
  ctx.rect(mx0, top - 20, mapS, mapS);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 3;
  for (const l of route) {
    ctx.beginPath();
    l.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (const o of others) {
    ctx.beginPath();
    ctx.arc(...px(o), 6, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.fillStyle = '#f5b841';
  ctx.beginPath();
  ctx.arc(...px([s0.lon, s0.lat]), 12, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
  font(18);
  ctx.fillStyle = '#a99f96';
  ctx.fillText(`${(2 * MAP_RADIUS_M) / 1000} km across · north up`, mx0 + 8, top - 20 + mapS - 10);

  // Top right: "+", take the sample (the click is found on the board by plusAt).
  if (plus) {
    const [cx, cy] = plusCenter(W);
    ctx.fillStyle = '#b8432b';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, PLUS_R_PX, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - PLUS_R_PX * 0.5, cy);
    ctx.lineTo(cx + PLUS_R_PX * 0.5, cy);
    ctx.moveTo(cx, cy - PLUS_R_PX * 0.5);
    ctx.lineTo(cx, cy + PLUS_R_PX * 0.5);
    ctx.stroke();
  }
  return c;
}

/** A flat textured rectangle in a local east/north/up frame: corners [x, y, z] from top-left, clockwise. */
function quad(origin: [number, number, number], corners: number[][], texture: HTMLCanvasElement) {
  const rows = 2;
  const position: number[] = [];
  const uv: number[] = [];
  const faces: number[] = [];
  const [tl, tr, , bl] = corners;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < rows; i++) {
      const [u, v] = [i / (rows - 1), j / (rows - 1)];
      for (let k = 0; k < 3; k++) position.push(tl[k] + (tr[k] - tl[k]) * u + (bl[k] - tl[k]) * v);
      uv.push(u, v);
    }
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < rows - 1; i++) {
      const a = j * rows + i;
      faces.push(a, a + rows, a + 1, a + 1, a + rows, a + rows + 1);
    }
  const colorTexture = new MeshTexture({ data: texture, transparent: true });
  return new Mesh({
    spatialReference: marsSR(),
    vertexSpace: new MeshLocalVertexSpace({ origin }),
    vertexAttributes: { position: new Float64Array(position), uv: new Float32Array(uv) },
    components: [
      new MeshComponent({
        faces: new Uint32Array(faces),
        // Self-lit: the board's own colors, not tinted by the scene's light.
        material: new MeshMaterialMetallicRoughness({ color: [0, 0, 0, 1], colorTexture, emissiveTexture: colorTexture, emissiveColor: 'white', metallic: 0, roughness: 1, alphaMode: 'blend', doubleSided: true }),
      }),
    ],
  });
}

// A round marker on a stem above each tube, sized on screen so it shows from far along the route.
const PIN = {
  type: 'point-3d',
  symbolLayers: [{ type: 'icon', resource: { primitive: 'circle' }, size: 16, material: { color: [245, 184, 65] }, outline: { color: 'white', size: 2 } }],
  verticalOffset: { screenLength: 60, maxWorldLength: PIN_HEIGHT_M, minWorldLength: 1.5 },
  callout: { type: 'line', size: 1.5, color: 'white' },
} as const;

// The tube model (public/models/sample-tube.glb) lies along its length; sized by that length (glTF depth).
const tubeSymbol = (heading: number) =>
  new PointSymbol3D({
    symbolLayers: [new ObjectSymbol3DLayer({ resource: { href: publicUrl('models/sample-tube.glb') }, depth: TUBE_LENGTH_M, heading, anchor: 'bottom' })],
  });

export function createSampleTubes(site: Site) {
  const tubeLayer = new GraphicsLayer({ id: 'sample-tubes', title: 'Sample tubes', visible: false, elevationInfo: { mode: 'relative-to-ground' } });
  const boardLayer = new GraphicsLayer({ id: 'sample-boards', title: 'Sample board', visible: false, elevationInfo: { mode: 'absolute-height' } });
  const stops: SampleTube[][] = [];
  let route: Line[] = [];
  let all: SampleTube[] = [];
  const entries = site.files.sampleBoard ? json<{ samples: Record<string, Entry> }>(site.files.sampleBoard) : Promise.resolve(null);
  // The board up now: where it stands (to find a click on its "+") and the sample stop it is for (null: not a sample board).
  let frame: { lon: number; lat: number; ground: number; mid: number; right: number[]; up: number[]; hw: number; hh: number } | null = null;
  let boardStop: number | null = null;
  const taken: number[] = []; // sample stops whose tube is on the rover, in the order taken
  let flying: { stop: number; from: Point; t0: number } | null = null;
  const tubeOf = (k: number) => tubeLayer.graphics.find((g) => g.attributes.stop === k && !g.attributes.pin);
  const pinOf = (k: number) => tubeLayer.graphics.find((g) => g.attributes.stop === k && !!g.attributes.pin);

  /** Place the tubes once the samples and the route have loaded. */
  async function load() {
    if (!site.files.samples) return;
    const [g, t] = await Promise.all([json<GeoJSON>(site.files.samples), json<GeoJSON>(site.files.traverse)]);
    route = routeLines(t);
    all = (g?.features ?? []).map((f) => {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      return { ...(f.properties as Omit<SampleTube, 'lon' | 'lat'>), lon, lat };
    });
    const byStop = new Map<string, SampleTube[]>();
    for (const s of all) byStop.set(`${s.lon},${s.lat}`, [...(byStop.get(`${s.lon},${s.lat}`) ?? []), s]);
    stops.push(...byStop.values());

    // Each tube lies beside the route, turned a different way at each stop.
    const centers = stops.map((list) => {
      const { lon, lat } = list[0];
      const h = (travelHeading(route, lon, lat) * Math.PI) / 180;
      const [e, n] = [TUBE_ASIDE_M * Math.cos(h), -TUBE_ASIDE_M * Math.sin(h)]; // to the right of travel
      return [lon + e / mPerDegLon(lat), lat + n / METERS_PER_DEGREE];
    });
    centers.forEach(([x, y], k) => {
      const at = new Point({ x, y, z: 0, spatialReference: marsSR() }); // on the ground (layer heights are relative to it)
      tubeLayer.add(new Graphic({ geometry: at, symbol: tubeSymbol((stops[k][0].number * 47) % 360), attributes: { stop: k } }));
      tubeLayer.add(new Graphic({ geometry: at.clone(), symbol: PIN, attributes: { stop: k, pin: true } }));
    });
  }

  /** The samples at the clicked tube, from a hit test result's graphic; null if it isn't a tube. */
  const samplesOf = (graphic: Graphic) => (graphic.layer === tubeLayer ? (stops[graphic.attributes?.stop] ?? null) : null);

  /** Stand the board for these samples near the camera, left of the tube; returns the camera position and heading that show both. */
  async function showBoard(view: SceneView, samples: SampleTube[], eyeHeightM: number) {
    const tube = tubeLayer.graphics.find((g) => stops[g.attributes.stop] === samples)?.geometry as Point | undefined;
    const target = tube ?? new Point({ x: samples[0].lon, y: samples[0].lat, z: 0, spatialReference: marsSR() });
    const stop = stops.indexOf(samples);
    const canTake = !taken.includes(stop) && flying?.stop !== stop;
    const shown = standBoard(view, target, eyeHeightM, BOARD_W_M, () =>
      entries.then((e) => {
        const list = samples.map((s) => e?.samples[String(s.number)] ?? null);
        const others = all.filter((s) => !samples.includes(s)).map((s) => [s.lon, s.lat] as [number, number]);
        return drawBoard(samples, list, route, others, canTake);
      }),
    );
    boardStop = canTake ? stop : null;
    return shown;
  }

  /**
   * Stand a board widthM wide on the ground near the camera, left of a target on the ground (a tube, a pin), facing the
   * camera; its face is drawn by face() (height BOARD_PX, width to the board's shape). Returns the camera position and
   * heading that show the board and the target.
   */
  function standBoard(view: SceneView, target: Point, eyeHeightM: number, widthM: number, face: () => Promise<HTMLCanvasElement>) {
    boardLayer.removeAll();
    boardStop = null;
    let cam = view.camera.position;
    const at = [target.x, target.y];
    const mx = mPerDegLon(cam.y);
    const [dx, dy] = [(at[0] - cam.x) * mx, (at[1] - cam.y) * METERS_PER_DEGREE];
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
    // A target right by the rover would be under a level camera's view: step back from it first.
    const back = TUBE_VIEW_DIST_M - Math.hypot(dx, dy);
    if (back > 0) {
      const r = (bearing * Math.PI) / 180;
      cam = new Point({ x: cam.x - (back * Math.sin(r)) / mx, y: cam.y - (back * Math.cos(r)) / METERS_PER_DEGREE, z: cam.z, spatialReference: marsSR() });
    }
    // A wider board sits further left, so it doesn't cover the target.
    const leftExtra = ((widthM - BOARD_W_M) / 2 / BOARD_DIST_M) * (180 / Math.PI);
    const heading = (bearing - VIEW_LEFT_DEG - leftExtra / 2 + 360) % 360; // where the camera will look
    const ground = (cam.z ?? 0) - eyeHeightM; // the rover's ground: the view's quick terrain lookup is too coarse here
    // Look down just enough to have the target in view (it is on the ground, below eye level).
    const targetZ = (view.groundView?.elevationSampler?.queryElevation(target) as Point | null)?.z ?? ground;
    const dist = Math.max(TUBE_VIEW_DIST_M, Math.hypot(dx, dy));
    // ... and at least enough to have the whole board in view (a far target, like a mineral pin, is near the horizon).
    const boardDown = (Math.atan2(eyeHeightM - (BOARD_LIFT_M + BOARD_H_M / 2), BOARD_DIST_M) * 180) / Math.PI + BOARD_DOWN_SPARE_DEG;
    const toTarget = (Math.atan2((cam.z ?? 0) - targetZ, dist) * 180) / Math.PI - LOOK_DOWN_SPARE_DEG;
    const down = Math.min(MAX_LOOK_DOWN_DEG, Math.max(0, toTarget, boardDown));
    const b = ((heading - BOARD_LEFT_DEG - leftExtra / 2) * Math.PI) / 180;
    const lon = cam.x + (BOARD_DIST_M * Math.sin(b)) / mx;
    const lat = cam.y + (BOARD_DIST_M * Math.cos(b)) / METERS_PER_DEGREE;
    // Square to the camera's view: width along the camera's right-hand direction, height along its up direction
    // (leaning back as much as the camera looks down), so the board shows as a true rectangle, not a trapezoid.
    const h = (heading * Math.PI) / 180;
    const a = (down * Math.PI) / 180;
    const right = [Math.cos(h), -Math.sin(h), 0];
    const up = [Math.sin(a) * Math.sin(h), Math.sin(a) * Math.cos(h), Math.cos(a)];
    const [hw, hh] = [widthM / 2, BOARD_H_M / 2];
    const mid = BOARD_LIFT_M + hh * Math.cos(a); // center height, so the bottom edge is BOARD_LIFT_M above the ground
    const corner = (x: number, y: number) => [0, 1, 2].map((k) => right[k] * x + up[k] * y + (k === 2 ? mid : 0));
    const corners = [corner(-hw, hh), corner(hw, hh), corner(hw, -hh), corner(-hw, -hh)];
    frame = { lon, lat, ground, mid, right, up, hw, hh };
    void face().then((canvas) => {
      boardLayer.removeAll(); // a later click may have drawn one meanwhile
      boardLayer.add(new Graphic({ geometry: quad([lon, lat, ground], corners, canvas) }));
    });
    // The camera turns toward the target, a little to its left, so the board (left) and the target (right) both show.
    return { position: cam, heading, tilt: 90 - down };
  }

  const clearBoard = () => {
    boardLayer.removeAll();
    frame = null;
    boardStop = null;
  };

  /** Whether a point clicked on the board (its map point) is on the board's "+". */
  function plusAt(p: Point) {
    if (!frame || boardStop === null || p.z === undefined || p.z === null) return false;
    const f = frame;
    const d = [(p.x - f.lon) * mPerDegLon(f.lat), (p.y - f.lat) * METERS_PER_DEGREE, p.z - f.ground - f.mid];
    const x = d[0] * f.right[0] + d[1] * f.right[1] + d[2] * f.right[2]; // meters right of the board's center
    const y = d[0] * f.up[0] + d[1] * f.up[1] + d[2] * f.up[2]; // meters up from it
    const pxPerM = BOARD_PX / (2 * f.hh);
    const W = Math.round((BOARD_PX * f.hw) / f.hh);
    const [cx, cy] = plusCenter(W);
    const u = (x + f.hw) * pxPerM; // canvas pixels from the left edge
    const v = (f.hh - y) * pxPerM; // from the top
    return Math.hypot(u - cx, v - cy) <= PLUS_R_PX * 1.4; // a little slack around the button
  }

  type Pose = { lon: number; lat: number; travelHeading: number };
  /** Where the i-th taken tube sits on the rover's deck. */
  function deckSpot(p: Pose, i: number) {
    const h = (p.travelHeading * Math.PI) / 180;
    const across = (i - (taken.length - 1) / 2) * DECK_SPACING_M;
    const e = -DECK_BACK_M * Math.sin(h) + across * Math.cos(h);
    const n = -DECK_BACK_M * Math.cos(h) - across * Math.sin(h);
    return { x: p.lon + e / mPerDegLon(p.lat), y: p.lat + n / METERS_PER_DEGREE, heading: p.travelHeading };
  }

  /** Put the taken tubes on the rover's deck (call on every rover move). */
  function carry(p: Pose) {
    taken.forEach((k, i) => {
      if (flying?.stop === k) return;
      const g = tubeOf(k);
      if (!g) return;
      const s = deckSpot(p, i);
      g.geometry = new Point({ x: s.x, y: s.y, z: DECK_HEIGHT_M, spatialReference: marsSR() });
      g.symbol = tubeSymbol(s.heading);
    });
  }

  /**
   * Take the sample of the board up: its tube flies from the ground onto the rover's deck (pose() is where the rover
   * is) and rides there from then on; its marker goes. The board comes down. Resolves when the tube has landed.
   */
  function take(pose: () => Pose) {
    const k = boardStop;
    const g = k === null ? undefined : tubeOf(k);
    clearBoard();
    if (k === null || !g) return Promise.resolve(false);
    const pin = pinOf(k);
    if (pin) tubeLayer.remove(pin);
    taken.push(k);
    flying = { stop: k, from: g.geometry as Point, t0: performance.now() };
    const fly = flying;
    return new Promise<boolean>((resolve) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - fly.t0) / TAKE_MS);
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
        const to = deckSpot(pose(), taken.indexOf(k));
        const z = (fly.from.z ?? 0) + (DECK_HEIGHT_M - (fly.from.z ?? 0)) * e + Math.sin(Math.PI * e) * TAKE_ARC_M;
        g.geometry = new Point({ x: fly.from.x + (to.x - fly.from.x) * e, y: fly.from.y + (to.y - fly.from.y) * e, z, spatialReference: marsSR() });
        if (t < 1) requestAnimationFrame(step);
        else {
          flying = null;
          carry(pose());
          resolve(true);
        }
      };
      requestAnimationFrame(step);
    });
  }

  return { tubeLayer, boardLayer, load, samplesOf, showBoard, standBoard, clearBoard, plusAt, take, carry };
}
