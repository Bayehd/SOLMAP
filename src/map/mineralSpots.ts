// Mineral spots: the main patches of each mineral in the CRISM mineral map near the rover's route
// (public/data/jezero/crism_mineral_spots.geojson, scripts/build_jezero_mineral_spots.py), with a short note on
// what each mineral tells. Shown as dark red-brown points in the map views (layer 'mineral-spots' in layers.ts) and
// as dark red-brown pins in the Rover view (here), set apart from the yellow sample-tube pins.
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import { METERS_PER_DEGREE, marsSR, publicUrl } from './mars';
import { BOARD_H_M, BOARD_PX, BOARD_W_M, json, mPerDegLon, routeLines, wrap, type GeoJSON, type Line } from './sampleTubes';
import { formatLatLon, type Site } from './sites';

/** Dark red-brown (with a white outline): unlike the sample points (cyan, orange, white) and the sample-tube pins (yellow). */
export const SPOT_COLOR = [128, 52, 31] as const;
const PIN_HEIGHT_M = 8; // highest the pin's stem gets above the ground
/** The mineral board is wider than the sample board: there is no picture, the note and the map sit side by side. */
export const MINERAL_BOARD_W_M = BOARD_W_M * 1.45;
const MAP_RADIUS_M = 1200; // the board's small map shows this far around the spot (spots can be ~1 km off the route)

export type MineralSpot = { mineral: string; class: number; area_km2: number; route_dist_m: number };

/** What each mineral says about the place, in a sentence or two. */
export const MINERAL_NOTES: Record<string, string> = {
  'Mg-carbonate':
    'Carbonates form when water and carbon dioxide react with rock. At Jezero they line the inner rim, possibly an old lake shore, a good place to look for signs of past life.',
  'Fe/Mg clay (smectite)':
    'Clays form when water alters rock for a long time. In the delta they were carried in by the river that once filled the crater lake.',
  'Hydrated silica': 'Silica holding water, left by water flowing through rock. On Earth it can keep traces of microbes.',
  Olivine:
    'A volcanic mineral that water breaks down quickly: where it is left, the rock has seen little water since it formed.',
  Pyroxene: 'A volcanic mineral of basalt, the dark lava rock that floors much of the crater.',
};

// A dark red-brown circle on a stem, sized on screen so it shows from far along the route.
const PIN = {
  type: 'point-3d',
  symbolLayers: [
    { type: 'icon', resource: { primitive: 'circle' }, size: 18, material: { color: [...SPOT_COLOR] }, outline: { color: 'white', size: 2 } },
  ],
  verticalOffset: { screenLength: 80, maxWorldLength: PIN_HEIGHT_M, minWorldLength: 2 },
  callout: { type: 'line', size: 2, color: [...SPOT_COLOR] },
} as const;

/** The board's face: the mineral, what it tells, the CRISM facts, and a small map of the route around the spot. */
function drawBoard(spot: MineralSpot, at: [number, number], route: Line[], others: [number, number][]) {
  const H = BOARD_PX;
  const W = Math.round((H * MINERAL_BOARD_W_M) / BOARD_H_M);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(38, 33, 29, 0.78)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = `rgba(${SPOT_COLOR.join(',')}, 0.95)`;
  ctx.lineWidth = 8;
  ctx.strokeRect(3, 3, W - 6, H - 6);
  const pad = 48;
  const font = (px: number, weight = 400) => (ctx.font = `${weight} ${px}px system-ui, -apple-system, Segoe UI, sans-serif`);

  // Title, with a circle like the pin.
  const d = 20;
  ctx.fillStyle = `rgb(${SPOT_COLOR.join(',')})`;
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(pad + d, pad + 6 + d, d, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f2ede8';
  font(56, 700);
  ctx.fillText(spot.mineral, pad + 2 * d + 22, pad + 48);
  font(28);
  ctx.fillStyle = '#c9bfb5';
  ctx.fillText(`Mineral spot · seen from orbit by CRISM · ${formatLatLon(at[1], at[0], 4)}`, pad, pad + 100);

  // Left: the note and the facts. Right: the map.
  const top = pad + 150;
  const mapS = H - top - pad;
  const textW = W - 3 * pad - mapS;
  font(34);
  ctx.fillStyle = '#f2ede8';
  let y = top + 30;
  for (const line of wrap(ctx, MINERAL_NOTES[spot.mineral] ?? '', textW)) {
    if (!line) break;
    ctx.fillText(line, pad, y);
    y += 46;
  }
  y += 30;
  font(28);
  ctx.fillStyle = '#c9bfb5';
  const area = spot.area_km2 < 0.1 ? `${Math.round(spot.area_km2 * 1e6).toLocaleString()} m²` : `${spot.area_km2.toFixed(2)} km²`;
  const facts = [
    `Patch: ${area}`,
    spot.route_dist_m < 50 ? 'On the rover\'s route' : `${spot.route_dist_m.toLocaleString()} m from the rover's route`,
    'Indicative: orbital detection, not checked on the ground.',
  ];
  for (const f of facts)
    for (const line of wrap(ctx, f, textW)) {
      if (!line) continue;
      ctx.fillText(line, pad, y);
      y += 40;
    }

  const mx0 = W - pad - mapS;
  ctx.fillStyle = 'rgba(20, 16, 13, 0.6)';
  ctx.fillRect(mx0, top, mapS, mapS);
  const px = ([lon, lat]: [number, number]): [number, number] => [
    mx0 + mapS / 2 + ((lon - at[0]) * mPerDegLon(at[1]) * mapS) / (2 * MAP_RADIUS_M),
    top + mapS / 2 - ((lat - at[1]) * METERS_PER_DEGREE * mapS) / (2 * MAP_RADIUS_M),
  ];
  ctx.save();
  ctx.beginPath();
  ctx.rect(mx0, top, mapS, mapS);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 3;
  for (const l of route) {
    ctx.beginPath();
    l.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(${SPOT_COLOR.join(',')}, 0.85)`;
  for (const o of others) {
    ctx.beginPath();
    ctx.arc(...px(o), 7, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.fillStyle = `rgb(${SPOT_COLOR.join(',')})`;
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(...px(at), 14, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  font(20);
  ctx.fillStyle = '#a99f96';
  ctx.fillText(`${(2 * MAP_RADIUS_M) / 1000} km across · north up`, mx0 + 10, top + mapS - 12);
  return c;
}

/** The Rover view's mineral pins: a layer (hidden until the view shows it) and its loader. */
export function createMineralPins(site: Site) {
  const layer = new GraphicsLayer({ id: 'mineral-pins', title: 'Mineral pins', listMode: 'hide', visible: false, elevationInfo: { mode: 'relative-to-ground' } });
  let route: Line[] = [];
  async function load() {
    if (!site.files.mineralSpots) return;
    void json<GeoJSON>(site.files.traverse).then((t) => (route = routeLines(t)));
    const g = await fetch(publicUrl(site.files.mineralSpots))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    for (const f of g?.features ?? []) {
      const [x, y] = f.geometry.coordinates as [number, number];
      layer.add(new Graphic({ geometry: new Point({ x, y, z: 0, spatialReference: marsSR() }), symbol: PIN, attributes: { ...f.properties } }));
    }
  }
  /** The spot of a clicked pin; null if the graphic isn't one. */
  const spotOf = (graphic: Graphic) => (graphic.layer === layer ? (graphic.attributes as MineralSpot) : null);
  /** The face of the clicked pin's board. */
  const boardFace = (graphic: Graphic) => {
    const p = graphic.geometry as Point;
    const others = layer.graphics
      .filter((g) => g !== graphic)
      .map((g) => [(g.geometry as Point).x, (g.geometry as Point).y] as [number, number])
      .toArray();
    return Promise.resolve(drawBoard(graphic.attributes as MineralSpot, [p.x, p.y], route, others));
  };
  return { layer, load, spotOf, boardFace };
}
