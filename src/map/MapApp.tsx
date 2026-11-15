// SOLMAP data map: one ArcGIS Map of Mars in a 3D SceneView, with 3D / Side / Top views of a landing site
// (Jezero or Gale, see sites.ts), showing the layers that site has data for.
// Side lifts the data layers off the ground into a stack of separate slabs (layerStack.ts).
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type Layer from '@arcgis/core/layers/Layer';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import ArcGISMap from '@arcgis/core/Map';
import Camera from '@arcgis/core/Camera';
import Point from '@arcgis/core/geometry/Point';
import { watch, whenOnce } from '@arcgis/core/core/reactiveUtils';
import SceneView from '@arcgis/core/views/SceneView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import { RoutePanel } from '../route/RoutePanel';
import { LayerLegend, hasLegend } from './MapLegend';
import { useRoutePlanner } from '../route/useRoutePlanner';
import type { RouteResult } from '../route/planner';
import { MINERAL_CLASSES, SLOPE_CLASSES, globalElevationLayer, layersFor, type LayerDef } from './layers';
import { createRouteGuideLayer, routeGuideUpdater } from './routeGuide';
import { createSampleTubes } from './sampleTubes';
import { MINERAL_BOARD_W_M, createMineralPins } from './mineralSpots';
import { createSiteElevationLayer } from './SiteElevationLayer';
import { STACKABLE, createLayerStack, groundLayerOf, type StackSlab } from './layerStack';
import { METERS_PER_DEGREE, marsSR, publicUrl } from './mars';
import { formatLatLon, insideSite, landingExtent, siteExtent, type Site } from './sites';
import { ROVER_CREDIT, attachRover, createRoverLayer, type DriveState, type RoverControl, type RoverPose } from './rover';
import '@arcgis/core/assets/esri/themes/dark/main.css';
import './map.css';

type Probe = {
  lon: number;
  lat: number;
  dtm: number | null; // m, 20 m DTM
  slope: number | null; // degrees
  global: number | null; // m, MOLA 463 m
  mineral: number | null; // MINERAL_CLASSES index + 1, 0 = none
};

const initialVisibility = (defs: LayerDef[]) => Object.fromEntries(defs.map((l) => [l.id, l.visible]));

function slopeClass(deg: number) {
  return SLOPE_CLASSES.find((c) => deg < c.max) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
}

/** Opening sequence from the home page: start on the whole planet, then fly down to the site. */
export type MapIntro = {
  fly: boolean; // set once the home page is out of the way
  onReady: () => void; // the globe has loaded
  onArrive: () => void; // the camera has reached the site
};

const globeCamera = (site: Site) =>
  new Camera({ position: new Point({ x: site.landing.lon, y: site.landing.lat, z: 12_000_000, spatialReference: marsSR() }), tilt: 0, heading: 0 });

// Camera views of the site's area.
type CameraView = '3d' | 'side' | 'top' | 'rover';
const CAMERA_VIEWS: { id: CameraView; label: string }[] = [
  { id: '3d', label: '3D' },
  { id: 'side', label: 'Side' },
  { id: 'top', label: 'Top' },
  { id: 'rover', label: 'Rover' },
];
// Side view: the layer stack, seen corner-on from the southwest.
const SIDE_TILT = 68;
const SIDE_HEADING = 35;
const SIDE_ZOOM = 0.85; // after framing the whole stack, move in this much closer (smaller = closer)
const LABEL_GAP_PX = 24; // between the stack and its labels
const TOP_ZOOM = 0.65; // top view frames this fraction of the site's area (smaller = closer)
// Rover view: a camera fixed on the front of the rover, looking where it drives: the front of the rover at the bottom
// of the screen, the route line ahead (routeGuide.ts) and the horizon. It moves and turns with the rover.
const ROVER_CAM_FORWARD_M = -1.5; // camera over the back of the deck, looking over the front
const ROVER_CAM_UP_M = 2.9; // camera height above the ground: above the top of the mast (the rover is 2.2 m tall)
const ROVER_TILT = 74; // degrees from straight down: the front of the rover at the bottom of the screen, more sky and horizon above
const ROVER_FOV = 85; // degrees, a wide lens
const DEFAULT_FOV = 55; // ArcGIS's, for the other views
/**
 * The front of the rover as seen from the Rover view's camera, cut out of a render of the 3D model
 * (scripts/capture_rover_front.mjs and scripts/cutout_rover_front.py). While riding it is drawn over the map, fixed
 * to the screen, instead of the 3D model: the view draws moved 3D graphics a frame or two after it moves the camera,
 * so a model driving at speed would shake in front of it. Sizes are in CSS px of the window it was made in (refW ×
 * refH); left/top are from that window's center. Remake it if the ROVER_CAM_* constants, tilt or fov change.
 */
const ROVER_FRONT = { file: 'models/rover-front.webp', refW: 1000, refH: 1613, left: -480, top: -33.3, width: 963.3 };
const ROVER_VIEW_SPEED = 30; // m/s while in this view (the whole route takes ~25 min instead of 90 s)
const ROVER_CLIP_NEAR_M = 0.5; // draw the ground from this close to the camera
const ROVER_CLIP_FAR_M = 400_000; // to the horizon and the crater rims
const ROUTE_CLICK_PX = 10; // a click this close to the route line (on screen) moves the rover there
const ROUTE_CLICK_MIN_M = 15;
const TAKEOFF_CAM_UP_M = 25; // Rover view take-off: the camera pulls back to this height above the rover...
const TAKEOFF_TILT = 62; // ...looking down at it at this tilt (degrees from straight down)
const RISE_AHEAD_M = 12; // "Return to Earth" stands on the ground this far past the end of the route
const PAD_SCORCH = [{ size: 74, alpha: 0.15 }, { size: 52, alpha: 0.2 }, { size: 32, alpha: 0.28 }]; // take-off scorch circle (pt on screen)
const BOARD_FOV = 60; // degrees: a normal lens while a sample board is up, so it isn't stretched (driving restores ROVER_FOV)


const normalLens = (camera: Camera) => {
  const c = camera.clone();
  c.fov = DEFAULT_FOV;
  return c;
};

/** Camera for the 3D and Top views; the Side view frames the stack once it is built, the Rover view follows the rover. */
function cameraFor(site: Site, v: Exclude<CameraView, 'side' | 'rover'>) {
  if (v === '3d') return { target: siteExtent(site), tilt: 55, heading: 0 };
  return { target: siteExtent(site).expand(TOP_ZOOM), tilt: 0, heading: 0 };
}

export function MapApp({
  site,
  intro,
  showRover = false,
  roverControl,
  onTravel,
  canTravel = false,
}: {
  site: Site;
  intro?: MapIntro;
  showRover?: boolean;
  /** Filled while the 3D view is up, for the landing animation. */
  roverControl?: RefObject<RoverControl | null>;
  /** "Return to Earth" was clicked (Rover view, end of the route). pad = screen position of the rover, or null if it is off
   * screen; route = the route chosen in the planner, for the mission report on Earth. */
  onTravel?: (pad: { x: number; y: number } | null, route: RouteResult | null) => void;
  canTravel?: boolean;
}) {
  const roverControlRef = useRef(roverControl);
  roverControlRef.current = roverControl;
  const introRef = useRef(intro);
  introRef.current = intro;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SceneView | null>(null);
  const [cameraView, setCameraView] = useState<CameraView>('3d');
  const cameraViewRef = useRef(cameraView);
  cameraViewRef.current = cameraView;
  const [slabs, setSlabs] = useState<StackSlab[]>([]);
  const [labelPos, setLabelPos] = useState<{ id: string; x: number; y: number }[]>([]);
  const [hoveredSlab, setHoveredSlab] = useState<string | null>(null);
  const defs = useMemo(() => layersFor(site), [site]);
  const groups = useMemo(() => [...new Set(defs.filter((l) => l.listed !== false).map((l) => l.group))], [defs]);
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => initialVisibility(defs));
  const [probe, setProbe] = useState<Probe | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [infoId, setInfoId] = useState<string | null>(null); // the layer whose source card is open
  const [routeOpen, setRouteOpen] = useState(false);
  const [drive, setDrive] = useState<DriveState>({ ready: false, playing: false, km: 0, totalKm: 0 });
  const [riding, setRiding] = useState(false); // in the Rover view, on the rover (after the camera has flown down)
  // Rover view, camera off the rover: a board is up, or the view was moved by hand. The camera stays where it is (no
  // snapping back) and the rover is drawn in 3D, not as the picture, until ▶ puts the camera back on the rover.
  const [boardUp, setBoardUp] = useState(false);
  const boardUpRef = useRef(boardUp);
  boardUpRef.current = boardUp;
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const roverRef = useRef<ReturnType<typeof attachRover> | null>(null);
  const driveRef = useRef(drive);
  driveRef.current = drive;
  const showRoverRef = useRef(showRover);
  showRoverRef.current = showRover;

  // One Map and one set of layers for both views, so a toggle applies to both.
  const { map, layers, globalElevation, roverLayer, routeLayer, guideLayer, tubes, minerals, stack } = useMemo(() => {
    const layers: Record<string, Layer> = {};
    for (const def of defs) {
      const layer = def.create();
      layer.id = def.id;
      layer.title = def.title;
      layer.visible = def.visible;
      if (def.opacity !== undefined) layer.opacity = def.opacity;
      layers[def.id] = layer;
    }
    const globalElevation = globalElevationLayer();
    const roverLayer = createRoverLayer(site);
    const routeLayer = new GraphicsLayer({ id: 'route', title: 'Safest route', elevationInfo: { mode: 'on-the-ground' } });
    const guideLayer = createRouteGuideLayer(); // the route line of the Rover view
    const stack = createLayerStack(site, defs);
    const tubes = createSampleTubes(site); // sample tubes and their boards, only in the Rover view
    const minerals = createMineralPins(site); // mineral pins, only in the Rover view
    const map = new ArcGISMap({
      layers: [...defs.map((d) => layers[d.id]), tubes.tubeLayer, minerals.layer, routeLayer, guideLayer, roverLayer, tubes.boardLayer, ...stack.layers],
      // Mars tan under the CTX mosaic, so its few coverage gaps don't show as white streaks.
      ground: { layers: [createSiteElevationLayer(site, globalElevation)], surfaceColor: [176, 128, 90] },
    });
    void tubes.load();
    void minerals.load();
    return { map, layers, globalElevation, roverLayer, routeLayer, guideLayer, tubes, minerals, stack };
  }, [site, defs]);

  const planner = useRoutePlanner(routeLayer, layers, site);
  const plannerRef = useRef(planner);
  plannerRef.current = planner;
  // A planned safest route takes the traverse's place: the rover drives it (▶, a click on it, the Rover view) and the
  // traverse is hidden until the route is cleared.
  const plannedPath = planner.plan?.safest?.path ?? null;
  const plannedRef = useRef(plannedPath);
  plannedRef.current = plannedPath;

  // In the Side view the data layers leave the ground for the stack; the ground keeps the base maps.
  useEffect(() => {
    // Rover view: only the ground (site.immersiveLayers), whatever is checked; the checks come back on leaving it.
    if (cameraView === 'rover') {
      for (const def of defs) layers[def.id].visible = site.immersiveLayers.includes(def.id);
      routeLayer.visible = false;
      return;
    }
    routeLayer.visible = true;
    // The bottom layer of the stack stays on the ground.
    const ground = groundLayerOf(defs.filter((l) => visibility[l.id]).map((l) => l.id));
    for (const def of defs)
      layers[def.id].visible =
        visibility[def.id] && !(cameraView === 'side' && STACKABLE.has(def.id) && def.id !== ground) && !(def.id === 'traverse' && plannedPath);
  }, [visibility, layers, cameraView, defs, site, routeLayer, plannedPath]);

  useEffect(() => {
    roverRef.current?.setRoute(plannedPath);
  }, [plannedPath]);

  useEffect(() => {
    const view = new SceneView({
      container: containerRef.current!,
      map,
      spatialReference: marsSR(),
      popupEnabled: false,
      qualityProfile: 'high',
      environment: { lighting: { type: 'virtual' } },
    });
    viewRef.current = view;
    if (import.meta.env.DEV) Object.assign(window, { solmap: { map, view, layers } }); // for the browser console
    // Bottom right, one column like Google Maps: the compass, zoom, then pan/rotate.
    view.ui.move(['compass', 'zoom', 'navigation-toggle'], 'bottom-right');
    const sizeWatch = watch(
      () => [view.width, view.height],
      ([width, height]) => setViewSize({ width, height }),
      { initial: true },
    );
    const rover = attachRover(view, roverLayer, site, setDrive);
    roverRef.current = rover;
    if (import.meta.env.DEV) Object.assign(window, { solmapRover: rover }); // for tests in the browser console
    if (roverControlRef.current) roverControlRef.current.current = rover;

    view.when(() => {
      if (introRef.current) {
        view.goTo(globeCamera(site), { animate: false });
        // Wait for the globe tiles (at most 6 s) so the home page fades onto a loaded planet.
        const loaded = whenOnce(() => !view.updating);
        Promise.race([loaded, new Promise((r) => setTimeout(r, 6000))]).then(() => introRef.current?.onReady());
      } else view.goTo(cameraFor(site, '3d'), { animate: false });
    });

    const click = view.on('click', async (event) => {
      const p = event.mapPoint;
      if (!p || cameraViewRef.current === 'side') return; // a click there lands on a slab, not the ground
      const point = new Point({ x: p.longitude ?? p.x, y: p.latitude ?? p.y, spatialReference: marsSR() });
      if (plannerRef.current.pick(point.x, point.y)) return; // picking a route point: don't open the probe
      // Rover view: a click on a sample tube stops the drive, stands its board beside the rover and turns the
      // camera so the board and the tube both show.
      if (cameraViewRef.current === 'rover') {
        const hit = await view.hitTest(event, { include: [tubes.tubeLayer, minerals.layer] }).catch(() => null);
        const g = hit?.results.find((r) => r.type === 'graphic');
        const spot = g && g.type === 'graphic' ? minerals.spotOf(g.graphic) : null;
        if (spot && g?.type === 'graphic') {
          // A mineral pin: like a sample tube, the drive stops and the mineral's (wider) board stands beside the rover.
          if (driveRef.current.playing) roverRef.current?.toggleDrive();
          setProbe(null);
          setBoardUp(true);
          boardUpRef.current = true;
          const { position, heading, tilt } = tubes.standBoard(view, g.graphic.geometry as Point, ROVER_CAM_UP_M, MINERAL_BOARD_W_M, () =>
            minerals.boardFace(g.graphic),
          );
          view.goTo(new Camera({ position, heading, tilt, fov: BOARD_FOV }), { duration: 1200, easing: 'cubic-in-out' }).catch(() => {});
          return;
        }
        const samples = g && g.type === 'graphic' ? tubes.samplesOf(g.graphic) : null;
        if (samples) {
          if (driveRef.current.playing) roverRef.current?.toggleDrive();
          setProbe(null);
          setBoardUp(true);
          boardUpRef.current = true; // before the camera turns, so nothing puts it back on the rover
          const { position, heading, tilt } = await tubes.showBoard(view, samples, ROVER_CAM_UP_M);
          view.goTo(new Camera({ position, heading, tilt, fov: BOARD_FOV }), { duration: 1200, easing: 'cubic-in-out' }).catch(() => {});
          return;
        }
      }
      const inDtm = insideSite(site, { lon: point.x, lat: point.y });
      const pixel = async (id: string) => {
        if (!inDtm || !layers[id]) return null;
        const r = await (layers[id] as ImageryTileLayer).identify(point);
        const v = r.value?.[0];
        return v === undefined || v === null || v <= -32767 ? null : v;
      };
      const pointHits = view
        .hitTest(event, { include: [layers['samples'], layers['depot'], layers['radiation'], layers['mineral-spots']].filter(Boolean) })
        .then((h) => h.results.some((r) => r.type === 'graphic')) // clicked a point
        .catch(() => false);
      // In the map views, a click on the rover's route (not on a point on it) moves the rover there; ▶ drives on from there.
      const rover = roverRef.current;
      const onRoute = rover && showRoverRef.current && cameraViewRef.current !== 'rover' ? rover.nearestOnRoute(point.x, point.y) : null;
      if (onRoute && rover && (layers['traverse']?.visible || plannedRef.current)) {
        // ROUTE_CLICK_PX on screen around the click, in meters.
        const side = view.toMap({ x: event.x + ROUTE_CLICK_PX, y: event.y });
        const m = side
          ? Math.hypot(((side.longitude ?? side.x) - point.x) * METERS_PER_DEGREE * Math.cos((point.y * Math.PI) / 180), ((side.latitude ?? side.y) - point.y) * METERS_PER_DEGREE)
          : 0;
        if (onRoute.offM <= Math.max(ROUTE_CLICK_MIN_M, m)) {
          if (!(await pointHits)) {
            rover.jumpTo(onRoute.distM);
            tubes.clearBoard();
            setBoardUp(false);
            setProbe(null);
            return;
          }
        }
      }
      // A click on a point (sample, depot tube, RAD stop, mineral spot) shows no info box.
      if (await pointHits) {
        setProbe(null);
        return;
      }
      const [dtm, slope, mineral, global] = await Promise.all([
        pixel('elevation'),
        pixel('slope'),
        pixel('minerals'),
        globalElevation
          .queryElevation(point)
          .then((r) => ((r.geometry as Point).z ?? null))
          .catch(() => null),
      ]);
      setProbe({ lon: point.x, lat: point.y, dtm, slope, global, mineral: inDtm && layers['minerals'] ? (mineral ?? 0) : null });
    });

    return () => {
      click.remove();
      sizeWatch.remove();
      rover.remove();
      if (roverRef.current === rover) roverRef.current = null;
      if (roverControlRef.current?.current === rover) roverControlRef.current.current = null;
      // Detach the shared Map first: destroying a view also destroys its map and layers.
      view.map = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [map, layers, globalElevation, roverLayer, tubes, minerals, site]);

  useEffect(() => {
    roverLayer.visible = showRover && cameraView !== 'side' && (!riding || boardUp); // hidden under the stack, or shown as a picture
    guideLayer.visible = cameraView === 'rover';
    tubes.tubeLayer.visible = tubes.boardLayer.visible = minerals.layer.visible = cameraView === 'rover';
    if (cameraView !== 'rover') {
      tubes.clearBoard();
      setBoardUp(false);
    }
  }, [showRover, roverLayer, guideLayer, tubes, minerals, cameraView, riding, boardUp]);

  // Driving on takes the board down.
  useEffect(() => {
    if (!drive.playing) return;
    tubes.clearBoard();
    setBoardUp(false); // the next drive step puts the camera back on the rover
  }, [drive.playing, tubes]);

  // Rover view: the camera rides behind the rover and looks along the route; it moves with every step of the drive.
  useEffect(() => {
    const view = viewRef.current;
    const rover = roverRef.current;
    if (cameraView !== 'rover' || !view || !rover) return;
    let lastZ: number | null = null;
    const cameraAt = (p: RoverPose) => {
      // The camera is fixed to the rover, which sits on the ground as the view draws it (its loaded terrain, read
      // synchronously): the camera height is measured from that same ground under the rover's middle. Until it is
      // loaded there, the route's profile from the full-resolution terrain stands in. The camera is also kept above
      // the drawn ground right under it, so on a slope it never dips into the hill.
      const h = (p.travelHeading * Math.PI) / 180;
      const lon = p.lon + (ROVER_CAM_FORWARD_M * Math.sin(h)) / (METERS_PER_DEGREE * Math.cos((p.lat * Math.PI) / 180));
      const lat = p.lat + (ROVER_CAM_FORWARD_M * Math.cos(h)) / METERS_PER_DEGREE;
      const quick = (x: number, y: number) => {
        const z = (view.groundView?.elevationSampler?.queryElevation(new Point({ x, y, spatialReference: marsSR() })) as Point | null | undefined)?.z;
        // It can answer a "no data" value (~3.4e37) while terrain is loading: only take real Martian heights.
        return typeof z === 'number' && Math.abs(z) < 30_000 ? z : null;
      };
      lastZ = quick(p.lon, p.lat) ?? p.groundZ ?? lastZ;
      const underCamera = quick(lon, lat);
      let z = (lastZ ?? site.landingElevationM) + ROVER_CAM_UP_M;
      if (underCamera !== null) z = Math.max(z, underCamera + ROVER_CLIP_NEAR_M * 2);
      const position = new Point({ x: lon, y: lat, z, spatialReference: marsSR() });
      return new Camera({ position, heading: p.travelHeading, tilt: ROVER_TILT, fov: ROVER_FOV });
    };
    let entering = true; // flying down into the rover; drive steps take over when it ends
    view
      .goTo(cameraAt(rover.pose()), { duration: 2500, easing: 'cubic-in-out' })
      .catch(() => {})
      .then(() => {
        entering = false;
        setRiding(true); // landed on the rover: the fixed picture takes over from the 3D model
      });
    rover.setSpeed(ROVER_VIEW_SPEED);
    rover.setRiding(true);
    const guide = routeGuideUpdater(guideLayer, rover);
    guide(rover.pose().distM);
    rover.onMove((p) => {
      guide(p.distM);
      if (!entering && !boardUpRef.current) view.camera = cameraAt(p);
    });
    // Moving the view by hand (drag, wheel, keys) leaves the camera where it is put.
    const handMoved = watch(
      () => view.interacting,
      (on) => {
        if (!on || boardUpRef.current) return;
        boardUpRef.current = true;
        setBoardUp(true);
      },
    );
    // Finer terrain keeps arriving after the camera lands (and while parked nothing else moves it): put the camera
    // back on the rover each time the view has finished loading, so it sits on the ground the rover is drawn on.
    const settle = watch(
      () => view.updating,
      (updating) => {
        if (updating) return;
        if (!entering && !boardUpRef.current) view.camera = cameraAt(rover.pose());
      },
    );
    // ArcGIS sets the near clipping plane from the camera's height (~8 m here), which would cut away the ground
    // just ahead of the rover: set it by hand while riding.
    const clip = view.constraints.clipDistance;
    clip.mode = 'manual';
    clip.near = ROVER_CLIP_NEAR_M;
    clip.far = ROVER_CLIP_FAR_M;
    return () => {
      rover.onMove(null);
      settle.remove();
      handMoved.remove();
      rover.setSpeed(null);
      rover.setRiding(false);
      setRiding(false);
      guideLayer.removeAll();
      // Normally showView has already put the lens back before flying out; setting the camera here would stop that flight.
      if (!view.destroyed && view.camera && view.camera.fov !== DEFAULT_FOV && !view.animation) view.camera = normalLens(view.camera);
      clip.mode = 'auto';
    };
  }, [cameraView, site, guideLayer]);

  // Side view: one slab per checked data layer, elevation on top (see layerStack.ts). Framed once on entry.
  const stackIds = defs.filter((l) => STACKABLE.has(l.id) && visibility[l.id]).map((l) => l.id).join(',');
  const baseIds = defs.filter((l) => l.group === 'Base map' && visibility[l.id]).map((l) => l.id).join(','); // drawn on every slab
  const framed = useRef(false);
  useEffect(() => {
    const side = cameraView === 'side';
    for (const l of stack.layers) l.visible = side;
    // Keep the stack clear of the toolbar and route panel (top left), where its labels go.
    if (viewRef.current) viewRef.current.padding = { top: side ? 120 : 0, left: side ? 120 : 0, right: 0, bottom: 0 };
    if (!side) {
      framed.current = false;
      setSlabs([]);
      return;
    }
    let cancelled = false;
    stack
      .update(stackIds ? stackIds.split(',') : [], baseIds ? baseIds.split(',').map((id) => layers[id]) : [])
      .then((placed) => {
        if (cancelled) return;
        setSlabs(placed);
        const view = viewRef.current;
        if (framed.current || !view || !stack.stack.graphics.length) return;
        framed.current = true;
        view
          .goTo({ target: stack.stack.graphics.toArray(), heading: SIDE_HEADING, tilt: SIDE_TILT }, { duration: 1500 })
          .then(() => view.goTo({ target: view.center, scale: view.scale * SIDE_ZOOM }, { duration: 500 }))
          .catch(() => {});
      })
      .catch((err) => console.error('Could not build the layer stack', err));
    return () => {
      cancelled = true;
    };
  }, [cameraView, stackIds, baseIds, stack, layers]);

  // Side view: the slab under the mouse (or whose label is under it) grows a little.
  useEffect(() => {
    const view = viewRef.current;
    if (cameraView !== 'side' || !view) {
      setHoveredSlab(null);
      return;
    }
    let pending = false;
    const move = view.on('pointer-move', (event) => {
      if (pending) return; // one hit test at a time
      pending = true;
      view
        .hitTest(event, { include: [stack.stack] })
        .then((hit) => {
          let id: string | null = null;
          for (const r of hit.results) {
            if (r.type === 'graphic' && r.graphic.attributes?.slab) {
              id = r.graphic.attributes.slab; // the nearest slab under the mouse
              break;
            }
          }
          setHoveredSlab(id);
        })
        .catch(() => {})
        .finally(() => (pending = false));
    });
    const leave = view.on('pointer-leave', () => setHoveredSlab(null));
    return () => {
      move.remove();
      leave.remove();
    };
  }, [cameraView, stack]);
  useEffect(() => stack.highlight(hoveredSlab), [hoveredSlab, stack]);

  // Slab labels sit to the left of the stack (the layer panel is on the right), level with each slab.
  useEffect(() => {
    const view = viewRef.current;
    if (cameraView !== 'side' || !view || !slabs.length) {
      setLabelPos([]);
      return;
    }
    const place = () => {
      const screen = slabs.map((s) => ({ id: s.id, pts: s.corners.flatMap((c) => view.toScreen(c) ?? []) }));
      const left = Math.min(...screen.flatMap((s) => s.pts.map((q) => q.x)));
      if (!Number.isFinite(left)) return;
      setLabelPos(screen.map((s) => ({ id: s.id, x: left - LABEL_GAP_PX, y: s.pts.reduce((a, q) => a + q.y, 0) / s.pts.length })));
    };
    const handle = watch(() => [view.camera, view.ready], place, { initial: true });
    return () => handle.remove();
  }, [cameraView, slabs]);

  // Intro flight: globe -> the site, slow enough to read as a descent.
  const fly = intro?.fly ?? false;
  useEffect(() => {
    const view = viewRef.current;
    if (!fly || !view) return;
    let cancelled = false;
    view
      .when(() => view.goTo({ target: landingExtent(site), tilt: 55 }, { duration: 5000, easing: 'cubic-in-out' }))
      .catch(() => {}) // interrupted by the user: land anyway
      .then(() => !cancelled && introRef.current?.onArrive());
    return () => {
      cancelled = true;
    };
  }, [fly, site]);

  const textureShown = !!layers['crater-texture'] && (cameraView === 'rover' ? site.immersiveLayers.includes('crater-texture') : visibility['crater-texture']);

  const toggle = (def: LayerDef) =>
    setVisibility((v) => {
      const next = { ...v, [def.id]: !v[def.id] };
      if (def.basemap && next[def.id]) for (const o of defs) if (o.basemap && o.id !== def.id) next[o.id] = false;
      return next;
    });

  const showView = (v: CameraView) => {
    const view = viewRef.current;
    if (cameraView === 'rover' && view) view.camera = normalLens(view.camera); // before any flight starts
    setCameraView(v);
    // side: framed by the stack effect; rover: placed by the rover-view effect
    if (v !== 'side' && v !== 'rover') viewRef.current?.goTo(cameraFor(site, v), { duration: 1500 }).catch(() => {});
  };


  // "Return to Earth" appears once the rover has driven to the end of its route.
  const atRouteEnd = drive.ready && drive.totalKm > 0 && drive.km >= drive.totalKm - 0.001;

  // The rocket takes off from wherever the rover is (the landing site until it has driven).
  const goEarth = async () => {
    const view = viewRef.current;
    const { lon, lat } = roverRef.current?.position() ?? site.landing;
    const ground = await map.ground
      .queryElevation(new Point({ x: lon, y: lat, spatialReference: marsSR() }))
      .then((r) => (r.geometry as Point).z ?? 0)
      .catch(() => 0);
    const pad = new Point({ x: lon, y: lat, z: ground, spatialReference: marsSR() });
    const p = view?.toScreen(pad);
    const onScreen = p && view && p.x > 0 && p.y > 0 && p.x < view.width && p.y < view.height;
    onTravel?.(onScreen ? { x: p.x, y: p.y } : null, plannerRef.current.plan?.safest ?? null); // the route chosen in the planner goes into the Earth report
  };

  // Rover view take-off: the camera leaves the rover and pulls back behind it, so the rover shows on screen, then the
  // rocket stands on it and lifts off as from the other views.
  const [leaving, setLeaving] = useState(false);
  const takeOff = async () => {
    const view = viewRef.current;
    const rover = roverRef.current;
    if (!view || !rover) return;
    setLeaving(true);
    const p = rover.pose();
    // A dark scorch circle where the rocket will stand: round on screen (not laid flat in perspective), a soft rim
    // around a darker middle.
    const pad = new Point({ x: p.lon, y: p.lat, spatialReference: marsSR() });
    view.graphics.addMany(
      PAD_SCORCH.map(
        ({ size, alpha }) => new Graphic({ geometry: pad, symbol: { type: 'simple-marker', style: 'circle', size, color: [20, 14, 10, alpha], outline: { width: 0 } } }),
      ),
    );
    view.camera = normalLens(view.camera);
    setCameraView('3d'); // shows the rover model again; the camera is moved here, not by showView
    const h = (p.travelHeading * Math.PI) / 180;
    const back = TAKEOFF_CAM_UP_M * Math.tan((TAKEOFF_TILT * Math.PI) / 180); // horizontal distance behind the rover
    const lon = p.lon - (back * Math.sin(h)) / (METERS_PER_DEGREE * Math.cos((p.lat * Math.PI) / 180));
    const lat = p.lat - (back * Math.cos(h)) / METERS_PER_DEGREE;
    const z = (p.groundZ ?? site.landingElevationM) + TAKEOFF_CAM_UP_M;
    await view
      .goTo(new Camera({ position: new Point({ x: lon, y: lat, z, spatialReference: marsSR() }), heading: p.travelHeading, tilt: TAKEOFF_TILT }), {
        duration: 2500,
        easing: 'cubic-in-out',
      })
      .catch(() => {});
    await goEarth();
  };

  // "Return to Earth" stands on the ground RISE_AHEAD_M past the end of the route; its screen spot follows the camera.
  const showRise = atRouteEnd && cameraView === 'rover' && !leaving;
  const riseRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = viewRef.current;
    const rover = roverRef.current;
    if (!showRise || !view || !rover) return;
    const p = rover.pose();
    const h = (p.travelHeading * Math.PI) / 180;
    const x = p.lon + (RISE_AHEAD_M * Math.sin(h)) / (METERS_PER_DEGREE * Math.cos((p.lat * Math.PI) / 180));
    const y = p.lat + (RISE_AHEAD_M * Math.cos(h)) / METERS_PER_DEGREE;
    const groundAt = () => {
      const z = (view.groundView?.elevationSampler?.queryElevation(new Point({ x, y, spatialReference: marsSR() })) as Point | null | undefined)?.z;
      return typeof z === 'number' && Math.abs(z) < 30_000 ? z : (p.groundZ ?? site.landingElevationM);
    };
    const place = () => {
      const el = riseRef.current;
      if (!el) return;
      const spot = new Point({ x, y, z: groundAt(), spatialReference: marsSR() });
      const s = view.toScreen(spot);
      // Hidden when the spot is behind the camera (it would project mirrored) or off screen.
      const cam = view.camera.position;
      const bearing = (Math.atan2((x - cam.x) * Math.cos((y * Math.PI) / 180), y - cam.y) * 180) / Math.PI;
      const ahead = Math.abs(((bearing - view.camera.heading + 540) % 360) - 180) < 80;
      const on = !!s && ahead && s.x > -200 && s.y > 0 && s.x < view.width + 200 && s.y < view.height + 100;
      el.style.visibility = on ? 'visible' : 'hidden';
      if (s) {
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      }
    };
    place();
    const moved = watch(() => view.camera, place);
    const loaded = watch(() => view.updating, place); // finer terrain changes the ground height
    return () => {
      moved.remove();
      loaded.remove();
    };
  }, [showRise, site]);

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-view" />

      <div className="map-left">
      <div className="map-toolbar">
        {showRover && (
          <button
            className="btn play-btn"
            onClick={() => roverRef.current?.toggleDrive()}
            disabled={!canTravel || !drive.ready}
            aria-label={drive.playing ? 'Pause drive' : 'Drive the route'}
            title={drive.playing ? 'Pause' : 'Drive the route'}
          >
            {drive.playing ? '❚❚' : '▶'}
          </button>
        )}
        {cameraView !== 'rover' && (
          <button
            className="btn"
            aria-pressed={routeOpen}
            aria-controls="route-panel"
            onClick={() => setRouteOpen((o) => !o)}
            title="Plan the safest route"
            aria-label="Safest route"
          >
            {/* a winding route between a start dot and an end pin */}
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="19" r="2" />
              <path d="M7 19h8.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H13" />
              <path d="M18 9.5s-3-2.9-3-5a3 3 0 0 1 6 0c0 2.1-3 5-3 5Z" />
              <circle cx="18" cy="4.5" r="0.6" fill="currentColor" />
            </svg>
          </button>
        )}
        {cameraView === 'rover' && (
          // How much of the route is driven, as a bar filled in red-brown.
          <span
            className="drive-bar"
            role="progressbar"
            aria-label="Route driven"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(drive.totalKm ? (100 * drive.km) / drive.totalKm : 0)}
          >
            <span style={{ width: `${drive.totalKm ? Math.min(100, (100 * drive.km) / drive.totalKm) : 0}%` }} />
          </span>
        )}
      </div>
      {cameraView !== 'rover' && <RoutePanel planner={planner} site={site} open={routeOpen} />}
      </div>

      {riding && !boardUp && viewSize.width > 0 && (
        <img
          className="rover-front"
          src={publicUrl(ROVER_FRONT.file)}
          alt=""
          style={(() => {
            // The camera's field of view is measured on the diagonal, so the picture scales with the window's diagonal.
            const k = Math.hypot(viewSize.width, viewSize.height) / Math.hypot(ROVER_FRONT.refW, ROVER_FRONT.refH);
            return {
              left: viewSize.width / 2 + ROVER_FRONT.left * k,
              top: viewSize.height / 2 + ROVER_FRONT.top * k,
              width: ROVER_FRONT.width * k,
            };
          })()}
        />
      )}

      {/* Rover view, end of the route: "Return to Earth" rises out of the ground ahead, with a round take-off button.
          It stands at a fixed spot on the ground (placed by the effect above), so it stays there as the camera moves. */}
      {showRise && (
        <div className="earth-rise" ref={riseRef}>
          <span className="earth-rise-text" aria-hidden="true">Return to Earth</span>
          <button className="earth-rise-btn" onClick={takeOff} disabled={!canTravel} aria-label="Return to Earth" title="Take off for Earth">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
              <path d="M2.5 19h19v2h-19v-2zm19.57-9.36c-.21-.8-1.04-1.28-1.84-1.06L14.92 10l-6.9-6.43-1.93.51 4.14 7.17-4.97 1.33-1.97-1.54-1.45.39 2.59 4.49L21 11.49c.81-.23 1.28-1.05 1.07-1.85z" />
            </svg>
          </button>
        </div>
      )}

      {/* Camera views, bottom left (▶ and the route stay at the top left). */}
      <div className="map-toolbar map-views">
          <div className="view-buttons" role="group" aria-label="Camera view">
          {CAMERA_VIEWS.map(({ id, label }) => (
            <button
              key={id}
              className="btn"
              aria-pressed={cameraView === id}
              onClick={() => showView(id)}
              disabled={id === 'rover' && !(showRover && canTravel && drive.ready)}
              title={id === 'rover' ? 'Ride on the rover along its route' : undefined}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {cameraView === 'side' && (
        <div className="stack-labels" aria-hidden="true">
          {labelPos.map((p) => {
            const s = slabs.find((x) => x.id === p.id)!;
            return (
              <div
                key={p.id}
                className="slab-label"
                data-active={hoveredSlab === p.id}
                style={{ left: p.x, top: p.y }}
                onMouseEnter={() => setHoveredSlab(p.id)}
                onMouseLeave={() => setHoveredSlab(null)}
              >
                <span>{s.title}</span>
              </div>
            );
          })}
          {!slabs.length && <p className="stack-hint muted small">Check a data layer to add it to the stack.</p>}
        </div>
      )}

      {/* The CC BY 4.0 models must be credited where they are shown: small, at the bottom right. */}
      {cameraView !== 'rover' && (showRover || textureShown) && (
        <p className="model-credits">
          {textureShown && site.texture && (
            <>
              Terrain texture:{' '}
              <a href={site.texture.credit.url} target="_blank" rel="noreferrer">
                {site.texture.credit.text} ↗
              </a>
            </>
          )}
          {textureShown && site.texture && showRover && ' · '}
          {showRover && (
            <>
              Rover model:{' '}
              <a href={ROVER_CREDIT.url} target="_blank" rel="noreferrer">
                {ROVER_CREDIT.text} ↗
              </a>
              {site.rover !== 'Perseverance' && <> (standing in for {site.rover})</>}
            </>
          )}
        </p>
      )}

      <div className="map-right" hidden={cameraView === 'rover'}>
      <div className="layer-panel panel" data-open={panelOpen}>
        <button
          className="layers-icon"
          aria-expanded={panelOpen}
          aria-label={panelOpen ? 'Hide layers' : 'Show layers'}
          title="Layers"
          onClick={() => setPanelOpen((o) => !o)}
        >
          {/* three stacked sheets */}
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" />
            <path d="m2.5 12 9.5 5 9.5-5" />
            <path d="m2.5 16 9.5 5 9.5-5" />
          </svg>
        </button>
        {panelOpen && (
        <div className="layer-list">
          {groups.map((group) => (
            <section key={group} aria-label={group}>
              {defs.filter((l) => l.group === group && l.listed !== false).map((def) => (
                <div key={def.id} className="layer-row" data-on={visibility[def.id]}>
                  {/* The name turns the layer on or off; a layer that is on shows its colors below it. */}
                  <button className="layer-name" aria-pressed={visibility[def.id]} onClick={() => toggle(def)}>
                    {def.title}
                  </button>
                  <button
                    className="layer-info-btn"
                    aria-expanded={infoId === def.id}
                    aria-label={`Where the ${def.title} data comes from`}
                    title="Data source"
                    onClick={() => setInfoId((id) => (id === def.id ? null : def.id))}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
                      <circle cx="8" cy="4.2" r="1.3" />
                      <rect x="6.9" y="6.6" width="2.2" height="6.6" rx="1" />
                    </svg>
                  </button>
                  {visibility[def.id] && hasLegend(def) && <LayerLegend layer={def} />}
                  {infoId === def.id && (
                    <div className="layer-info">
                      Source:{' '}
                      <a href={def.source.url} target="_blank" rel="noreferrer">
                        {def.source.name} ↗
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
        )}
      </div>
      </div>

      {probe && (
        <div className="probe panel">
          <button className="close" aria-label="Close" onClick={() => setProbe(null)}>
            ×
          </button>
          <dl>
            <dt>Position</dt>
            <dd>
              {formatLatLon(probe.lat, probe.lon, 5)}
            </dd>
            <dt>Elevation (20 m DTM)</dt>
            <dd>{probe.dtm === null ? `outside the ${site.short} DTM` : `${probe.dtm.toFixed(1)} m`}</dd>
            <dt>Slope (20 m DTM)</dt>
            <dd>
              {probe.slope === null ? '–' : (
                <>
                  {probe.slope.toFixed(1)}° <span className="swatch" style={{ background: `rgb(${slopeClass(probe.slope).color.join(',')})` }} />{' '}
                  {slopeClass(probe.slope).label}
                </>
              )}
            </dd>
            {layers['minerals'] && <dt>Mineral (CRISM)</dt>}
            {layers['minerals'] && <dd>
              {probe.mineral === null ? '–' : probe.mineral === 0 ? 'none detected or no coverage' : (
                <>
                  <span className="swatch" style={{ background: `rgb(${MINERAL_CLASSES[probe.mineral - 1].color.join(',')})` }} />{' '}
                  {MINERAL_CLASSES[probe.mineral - 1].label}
                </>
              )}
            </dd>}
            <dt>Elevation (MOLA, 463 m)</dt>
            <dd>{probe.global === null ? '–' : `${probe.global.toFixed(0)} m`}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
