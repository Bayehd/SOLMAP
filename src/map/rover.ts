// The rover's 3D model (public/models/perseverance.glb) in the 3D view, at either landing site.
// Model: "Perseverance Mars rover" by Cybertron B-127, CC BY 4.0 (see ROVER_CREDIT and public/models/perseverance.LICENSE.txt).
// At Gale it stands in for Curiosity, whose chassis Perseverance's design was based on (same size, same six wheels).
// attachRover() returns a RoverControl: the landing animation uses it to fly the model down onto the route's
// origin, and the map uses it to drive the rover along the site's whole traverse (site.files.traverse).
import Graphic from '@arcgis/core/Graphic';
import Multipoint from '@arcgis/core/geometry/Multipoint';
import Point from '@arcgis/core/geometry/Point';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D';
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer';
import { whenOnce } from '@arcgis/core/core/reactiveUtils';
import type SceneView from '@arcgis/core/views/SceneView';
import { METERS_PER_DEGREE, marsSR, publicUrl } from './mars';
import type { Site } from './sites';

export const ROVER_CREDIT = {
  text: '“Perseverance Mars rover” by Cybertron B-127, CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/perseverance-mars-rover-53034dff0df04f698f2a5d532366adc4',
};

const REAL_HEIGHT_M = 2.2; // Perseverance and Curiosity are both about 2.2 m tall
export const ROVER_WIDTH_PER_HEIGHT = 2.7 / 2.2; // model footprint width / height
const SCREEN_HEIGHT_PX = 40; // how tall it is drawn in the site's default 3D view; its size in meters stays fixed from then on
const PARKED_HEADING = 120; // degrees, so the parked model is seen from its side in the default view
const MODEL_HEADING_OFFSET = 180; // added to the direction of travel so the model drives arm (front) first
const DRIVE_SECONDS = 90; // time to drive the whole route
const HEADING_WINDOW_M = 40; // direction of travel is measured over ±this, so small wiggles don't jitter
const PROFILE_STEP_M = 10; // ground heights along the route, for the Rover camera view, every this many meters
const TURN_STEP = 3; // degrees: the model is turned when the direction of travel has changed by more than this
const TURN_STEP_CLOSE = 0.5; // the same in the Rover view, where the model is right in front of the camera

/** What the landing animation needs from the 3D view. Altitudes are meters above the ground at the site. */
export type RoverControl = {
  heightM(): number; // display height of the model (m, enlarged so it shows at site scale)
  setAltitude(m: number): void;
  toScreen(altitudeM: number): { x: number; y: number } | null; // the point above the site at that altitude
  metersPerPx(): number | null; // screen scale at the site
  position(): { lon: number; lat: number }; // where the rover is now
};

export type DriveState = { ready: boolean; playing: boolean; km: number; totalKm: number };

/** Where the rover is and which way it is driving (degrees clockwise from north), for the Rover camera view. */
export type RoverPose = {
  lon: number;
  lat: number;
  travelHeading: number;
  groundZ: number | null;
  distM: number;
};

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

export function createRoverLayer(site: Site) {
  // Heights relative to the terrain: z = 0 keeps the rover on the ground anywhere on the route,
  // z > 0 lifts it for the landing.
  const layer = new GraphicsLayer({ id: 'rover', title: `${site.rover} (3D model)`, visible: false, elevationInfo: { mode: 'relative-to-ground' } });
  layer.add(new Graphic({ geometry: point(site.landing.lon, site.landing.lat, 0), symbol: roverSymbol(REAL_HEIGHT_M, PARKED_HEADING) }));
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

async function loadRoute(file: string): Promise<Route> {
  const geojson = await (await fetch(publicUrl(file))).json();
  const pts: number[][] = [];
  const gap = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * metersX(a[1]), (a[1] - b[1]) * METERS_PER_DEGREE);
  // Drives are in order. A few are stored ending where the rover already is, with the next drive starting
  // there too: out-and-back excursions, driven out (reversed) and back. The remaining few gaps in the data
  // (~0.5 km of 47 at Jezero) are bridged with straight lines.
  for (const f of geojson.features as { geometry: { coordinates: number[][] } }[]) {
    let coords = f.geometry.coordinates;
    const here = pts[pts.length - 1];
    if (here && gap(here, coords[0]) > 5 && gap(here, coords[coords.length - 1]) <= 5) coords = [...coords].reverse().concat(coords.slice(1));
    for (const c of coords) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) pts.push(c);
    }
  }
  return routeOf(pts);
}

/** A route from [lon, lat] points in driving order. */
function routeOf(pts: number[][]): Route {
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
 * Connect the rover layer to a 3D view: give it a fixed (enlarged) size in meters so it scales with the
 * terrain as you zoom, and drive it along the traverse on request.
 */
export function attachRover(
  view: SceneView,
  layer: GraphicsLayer,
  site: Site,
  onDrive?: (s: DriveState) => void,
): RoverControl & {
  toggleDrive(): void;
  pose(): RoverPose;
  /** Called on every move while driving (null: stop). */
  onMove(listener: ((p: RoverPose) => void) | null): void;
  /** Driving speed in m/s; null = the whole route in DRIVE_SECONDS. */
  setSpeed(mps: number | null): void;
  /** Draw the rover at its real size, for the Rover view (the camera rides on its front). */
  setRiding(on: boolean): void;
  /** Points along the route from fromM to toM (meters driven), every stepM. */
  routeBetween(fromM: number, toM: number, stepM: number): { lon: number; lat: number }[];
  /** The route point nearest (lon, lat): its distance along the route and how far (m) it is from the given point. */
  nearestOnRoute(lon: number, lat: number): { distM: number; offM: number } | null;
  /** Put the rover at distM along the route (driving, if it is, goes on from there). */
  jumpTo(distM: number): void;
  /** Drive this path ([lon, lat] points, start first) instead of the traverse; null: back to the traverse. The rover stops and goes to its start. */
  setRoute(path: [number, number][] | null): void;
  remove(): void;
} {
  const graphic = layer.graphics.getItemAt(0)!;
  let groundZ = site.landingElevationM; // terrain height at the landing site, for screen projection during landing
  let altitude = 0;
  const { lon: siteLon, lat: siteLat } = site.landing;
  let lon = siteLon;
  let lat = siteLat;
  let height = REAL_HEIGHT_M;
  let heading = PARKED_HEADING;
  let removed = false;
  let riding = false;

  const place = () => (graphic.geometry = point(lon, lat, altitude));
  const resymbol = () => (graphic.symbol = roverSymbol(riding ? REAL_HEIGHT_M : height, heading));

  view.map?.ground
    .queryElevation(point(siteLon, siteLat, 0))
    .then((r) => {
      const z = (r.geometry as Point).z;
      if (!removed && z !== undefined && z !== null) groundZ = z;
    })
    .catch(() => {});

  // One fixed size in meters, so zooming in makes the rover bigger along with the ground around it.
  // At real size (2.2 m) it would be invisible at site scale, so it is enlarged to SCREEN_HEIGHT_PX in the
  // default 3D view, which shows the whole site extent across the view.
  const siteWidthM = (site.extent.xmax - site.extent.xmin) * METERS_PER_DEGREE * Math.cos((siteLat * Math.PI) / 180);
  whenOnce(() => view.width > 0).then(() => {
    if (removed) return;
    height = Math.max(REAL_HEIGHT_M, (SCREEN_HEIGHT_PX * siteWidthM) / view.width);
    resymbol();
  });

  // ---------- Driving ----------
  let route: Route | null = null;
  let traverse: Route | null = null; // the site's traverse, the default route
  let custom: Route | null = null; // a planned route that replaces it (setRoute)
  let s = 0; // meters driven
  let playing = false;
  let raf = 0;
  let lastReport = 0;
  let speed: number | null = null;
  let moveListener: ((p: RoverPose) => void) | null = null;
  // Ground height along the route from the full-resolution terrain (the site DTM), read once when the Rover
  // view first needs it: the view's own quick height lookup is coarser than the drawn ground near the camera.
  let profile: Float64Array | null = null;
  let profileLoading = false;
  const loadProfile = () => {
    const ground = view.map?.ground;
    if (!route || profile || profileLoading || !ground) return;
    profileLoading = true;
    const r = route;
    const points: number[][] = [];
    for (let d = 0; d <= r.total; d += PROFILE_STEP_M) {
      const p = sample(r, d);
      points.push([p.lon, p.lat]);
    }
    ground
      .queryElevation(new Multipoint({ points, spatialReference: marsSR() }))
      .then((res) => {
        if (!removed && route === r) profile = Float64Array.from((res.geometry as Multipoint).points, (p) => p[2]);
      })
      .catch(() => {
        if (route === r) profileLoading = false;
      });
  };
  const groundAt = (dist: number) => {
    if (!profile) return null;
    const f = Math.min(Math.max(dist / PROFILE_STEP_M, 0), profile.length - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, profile.length - 1);
    return profile[i] + (profile[j] - profile[i]) * (f - i);
  };
  const pose = (): RoverPose => ({
    lon,
    lat,
    travelHeading: route ? headingAt(route, s) : (PARKED_HEADING - MODEL_HEADING_OFFSET + 360) % 360,
    groundZ: groundAt(s),
    distM: s,
  });
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastReport < 100) return; // ~10 updates a second is plenty for the UI
    lastReport = now;
    onDrive?.({ ready: !!route, playing, km: s / 1000, totalKm: (route?.total ?? 0) / 1000 });
  };
  loadRoute(site.files.traverse)
    .then((r) => {
      if (removed) return;
      traverse = r;
      if (!custom) route = r;
      report(true);
    })
    .catch(() => {});

  const moveTo = (dist: number) => {
    if (!route) return;
    s = Math.min(Math.max(dist, 0), route.total);
    ({ lon, lat } = sample(route, s));
    place();
    const h = (headingAt(route, s) + MODEL_HEADING_OFFSET) % 360;
    if (angleDiff(h, heading) > (riding ? TURN_STEP_CLOSE : TURN_STEP)) {
      heading = h;
      resymbol();
    }
    moveListener?.(pose());
  };

  let last = 0;
  const frame = (now: number) => {
    if (!route || !playing) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    moveTo(s + (speed ?? route.total / DRIVE_SECONDS) * dt);
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
      const p = view.toScreen(point(siteLon, siteLat, groundZ + m));
      return p ? { x: p.x, y: p.y } : null;
    },
    metersPerPx: () => measureMetersPerPx(view, siteLon, siteLat, groundZ),
    position: () => ({ lon, lat }),
    pose,
    onMove(listener) {
      moveListener = listener;
      if (listener) loadProfile();
    },
    setSpeed(mps) {
      speed = mps;
    },
    setRiding(on) {
      riding = on; // real size while riding; the enlarged size comes back afterwards
      resymbol();
      if (on) moveTo(s); // turn a parked rover to face the route
    },
    routeBetween(fromM, toM, stepM) {
      if (!route) return [];
      const a = Math.max(0, fromM);
      const b = Math.min(route.total, toM);
      const pts: { lon: number; lat: number }[] = [];
      for (let d = a; d < b; d += stepM) pts.push(sample(route, d));
      if (b > a) pts.push(sample(route, b));
      return pts;
    },
    nearestOnRoute(x, y) {
      if (!route) return null;
      const r = route;
      const mx = metersX(y);
      let best = { distM: 0, offM: Infinity };
      for (let i = 0; i + 1 < r.lon.length; i++) {
        // Project the point onto segment i (local meters around the point).
        const ax = (r.lon[i] - x) * mx;
        const ay = (r.lat[i] - y) * METERS_PER_DEGREE;
        const bx = (r.lon[i + 1] - x) * mx;
        const by = (r.lat[i + 1] - y) * METERS_PER_DEGREE;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
        const off = Math.hypot(ax + dx * t, ay + dy * t);
        if (off < best.offM) best = { distM: r.dist[i] + (r.dist[i + 1] - r.dist[i]) * t, offM: off };
      }
      return best;
    },
    jumpTo(distM) {
      moveTo(distM);
      report(true);
    },
    setRoute(path) {
      custom = path && path.length >= 2 ? routeOf(path) : null;
      route = custom ?? traverse;
      playing = false;
      cancelAnimationFrame(raf);
      profile = null; // the Rover view's ground heights are along the route: read again for the new one
      profileLoading = false;
      if (moveListener) loadProfile();
      moveTo(0);
      report(true);
    },
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
    remove() {
      removed = true;
      playing = false;
      moveListener = null;
      cancelAnimationFrame(raf);
    },
  };
}
