// The Perseverance 3D model (public/models/perseverance.glb) in the 3D view.
// Model: "Perseverance Mars rover" by Cybertron B-127, CC BY 4.0 (see ROVER_CREDIT and public/models/perseverance.LICENSE.txt).
// attachRover() returns a RoverControl: the landing animation uses it to fly the model down onto the route's
// origin, and the map uses it to drive the rover along the whole traverse (public/data/jezero/m20_traverse.geojson).
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer';
import { watch } from '@arcgis/core/core/reactiveUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import { LANDING_SITE, METERS_PER_DEGREE, marsSR, publicUrl } from './mars';

export const ROVER_CREDIT = {
  text: '“Perseverance Mars rover” by Cybertron B-127, CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/perseverance-mars-rover-53034dff0df04f698f2a5d532366adc4',
};

const REAL_HEIGHT_M = 2.2; // Perseverance is about 2.2 m tall
export const ROVER_WIDTH_PER_HEIGHT = 2.7 / 2.2; // model footprint width / height
const SCREEN_HEIGHT_PX = 40; // how tall it is drawn while the camera is too far away to see it at real size
const SITE_ELEVATION_M = -2570; // ground height at the landing site, until the terrain query answers
const PARKED_HEADING = 120; // degrees, so the parked model is seen from its side in the default view
const MODEL_HEADING_OFFSET = 180; // added to the direction of travel so the model drives arm (front) first
const DRIVE_SECONDS = 90; // time to drive the whole route
const HEADING_WINDOW_M = 40; // direction of travel is measured over ±this, so small wiggles don't jitter

/** What the landing animation needs from the 3D view. Altitudes are meters above the ground at the site. */
export type RoverControl = {
  heightM(): number; // current display height of the model (exaggerated when far away)
  setAltitude(m: number): void;
  toScreen(altitudeM: number): { x: number; y: number } | null; // the point above the site at that altitude
  metersPerPx(): number | null; // screen scale at the site
  position(): { lon: number; lat: number }; // where the rover is now
};

export type DriveState = { ready: boolean; playing: boolean; km: number; totalKm: number };

const roverSymbol = (height: number, heading: number) =>
  new PointSymbol3D({
    symbolLayers: [
      new ObjectSymbol3DLayer({
        resource: { href: publicUrl('models/perseverance.glb') },
        height,
        heading,
        anchor: 'bottom',
      }),
    ],
  });

const point = (lon: number, lat: number, z: number) => new Point({ x: lon, y: lat, z, spatialReference: marsSR() });

export function createRoverLayer() {
  // Heights relative to the terrain: z = 0 keeps the rover on the ground anywhere on the route,
  // z > 0 lifts it for the landing.
  const layer = new GraphicsLayer({ id: 'rover', title: 'Perseverance (3D model)', visible: false, elevationInfo: { mode: 'relative-to-ground' } });
  layer.add(new Graphic({ geometry: point(LANDING_SITE.lon, LANDING_SITE.lat, 0), symbol: roverSymbol(REAL_HEIGHT_M, PARKED_HEADING) }));
  return layer;
}

/** Screen scale at a ground point: project two points 1 km apart (east-west). */
function measureMetersPerPx(view: SceneView, lon: number, lat: number, groundZ: number) {
  const dLon = 1000 / (METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const a = view.toScreen(point(lon, lat, groundZ));
  const b = view.toScreen(point(lon + dLon, lat, groundZ));
  if (!a || !b) return null;
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  return px < 1e-3 ? null : 1000 / px;
}

// ---------- The traverse as one polyline with cumulative distance ----------

type Route = { lon: Float64Array; lat: Float64Array; dist: Float64Array; total: number };

const metersX = (lat: number) => METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);

async function loadRoute(): Promise<Route> {
  const geojson = await (await fetch(publicUrl('data/jezero/m20_traverse.geojson'))).json();
  const pts: number[][] = [];
  const gap = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * metersX(a[1]), (a[1] - b[1]) * METERS_PER_DEGREE);
  // Drives are in order. A few are stored ending where the rover already is, with the next drive starting
  // there too: out-and-back excursions, driven out (reversed) and back. The remaining few gaps in the data
  // (~0.5 km of 47) are bridged with straight lines.
  for (const f of geojson.features as { geometry: { coordinates: number[][] } }[]) {
    let coords = f.geometry.coordinates;
    const here = pts[pts.length - 1];
    if (here && gap(here, coords[0]) > 5 && gap(here, coords[coords.length - 1]) <= 5) coords = [...coords].reverse().concat(coords.slice(1));
    for (const c of coords) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) pts.push(c);
    }
  }
  const lon = new Float64Array(pts.length);
  const lat = new Float64Array(pts.length);
  const dist = new Float64Array(pts.length);
  pts.forEach(([x, y], i) => {
    lon[i] = x;
    lat[i] = y;
    if (i) dist[i] = dist[i - 1] + Math.hypot((x - lon[i - 1]) * metersX(y), (y - lat[i - 1]) * METERS_PER_DEGREE);
  });
  return { lon, lat, dist, total: dist[pts.length - 1] };
}

/** Position at distance s (m) along the route. */
function sample(r: Route, s: number) {
  s = Math.min(Math.max(s, 0), r.total);
  let lo = 0;
  let hi = r.dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.dist[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = r.dist[hi] - r.dist[lo];
  const t = seg > 0 ? (s - r.dist[lo]) / seg : 0;
  return { lon: r.lon[lo] + (r.lon[hi] - r.lon[lo]) * t, lat: r.lat[lo] + (r.lat[hi] - r.lat[lo]) * t };
}

/** Direction of travel at s, degrees clockwise from north. */
function headingAt(r: Route, s: number) {
  const a = sample(r, s - HEADING_WINDOW_M);
  const b = sample(r, s + HEADING_WINDOW_M);
  const east = (b.lon - a.lon) * metersX(a.lat);
  const north = (b.lat - a.lat) * METERS_PER_DEGREE;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Connect the rover layer to a 3D view: keep it about SCREEN_HEIGHT_PX tall while the camera is far away,
 * shrinking to its real size as you zoom in, and drive it along the traverse on request.
 */
export function attachRover(
  view: SceneView,
  layer: GraphicsLayer,
  onDrive?: (s: DriveState) => void,
  /** Called every time the rover moves along the route, with the step in degrees (for a following camera). */
  onMove?: (dLon: number, dLat: number) => void,
): RoverControl & {
  toggleDrive(): void;
  resetDrive(): void;
  remove(): void;
} {
  const graphic = layer.graphics.getItemAt(0)!;
  let groundZ = SITE_ELEVATION_M; // terrain height at the landing site, for screen projection during landing
  let altitude = 0;
  let lon = LANDING_SITE.lon;
  let lat = LANDING_SITE.lat;
  let height = REAL_HEIGHT_M;
  let heading = PARKED_HEADING;
  let removed = false;

  const place = () => (graphic.geometry = point(lon, lat, altitude));
  const resymbol = () => (graphic.symbol = roverSymbol(height, heading));

  view.map?.ground
    .queryElevation(point(LANDING_SITE.lon, LANDING_SITE.lat, 0))
    .then((r) => {
      const z = (r.geometry as Point).z;
      if (!removed && z !== undefined && z !== null) groundZ = z;
    })
    .catch(() => {});

  const sizing = watch(
    () => view.camera,
    (camera) => {
      if (!camera) return;
      const mpp = measureMetersPerPx(view, lon, lat, groundZ);
      if (!mpp) return;
      const h = Math.max(REAL_HEIGHT_M, SCREEN_HEIGHT_PX * mpp);
      if (Math.abs(h / height - 1) < 0.15) return;
      height = h;
      resymbol();
    },
    { initial: true },
  );

  // ---------- Driving ----------
  let route: Route | null = null;
  let s = 0; // meters driven
  let playing = false;
  let raf = 0;
  let lastReport = 0;
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastReport < 100) return; // ~10 updates a second is plenty for the UI
    lastReport = now;
    onDrive?.({ ready: !!route, playing, km: s / 1000, totalKm: (route?.total ?? 0) / 1000 });
  };
  loadRoute()
    .then((r) => {
      if (removed) return;
      route = r;
      report(true);
    })
    .catch(() => {});

  const moveTo = (dist: number) => {
    if (!route) return;
    s = Math.min(Math.max(dist, 0), route.total);
    const from = { lon, lat };
    ({ lon, lat } = sample(route, s));
    place();
    onMove?.(lon - from.lon, lat - from.lat);
    const h = (headingAt(route, s) + MODEL_HEADING_OFFSET) % 360;
    if (angleDiff(h, heading) > 3) {
      heading = h;
      resymbol();
    }
  };

  let last = 0;
  const frame = (now: number) => {
    if (!route || !playing) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    moveTo(s + (route.total / DRIVE_SECONDS) * dt);
    if (s >= route.total) playing = false;
    report(!playing);
    if (playing) raf = requestAnimationFrame(frame);
  };

  return {
    heightM: () => height,
    setAltitude(m) {
      altitude = m;
      place();
    },
    toScreen(m) {
      const p = view.toScreen(point(LANDING_SITE.lon, LANDING_SITE.lat, groundZ + m));
      return p ? { x: p.x, y: p.y } : null;
    },
    metersPerPx: () => measureMetersPerPx(view, LANDING_SITE.lon, LANDING_SITE.lat, groundZ),
    position: () => ({ lon, lat }),
    toggleDrive() {
      if (!route) return;
      if (playing) {
        playing = false;
        cancelAnimationFrame(raf);
      } else {
        if (s >= route.total) moveTo(0); // finished: start again from the landing site
        playing = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
      report(true);
    },
    resetDrive() {
      playing = false;
      cancelAnimationFrame(raf);
      moveTo(0);
      heading = PARKED_HEADING;
      resymbol();
      report(true);
    },
    remove() {
      removed = true;
      playing = false;
      cancelAnimationFrame(raf);
      sizing.remove();
    },
  };
}
