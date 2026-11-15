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
import { RoutePanel } from '../route/RoutePanel';
import { useRoutePlanner } from '../route/useRoutePlanner';
import { MINERAL_CLASSES, SLOPE_CLASSES, globalElevationLayer, layersFor, type LayerDef } from './layers';
import { createRouteGuideLayer, routeGuideUpdater } from './routeGuide';
import { createSampleTubes } from './sampleTubes';
import { createSiteElevationLayer } from './SiteElevationLayer';
import { STACKABLE, createLayerStack, groundLayerOf, type StackSlab } from './layerStack';
import { METERS_PER_DEGREE, marsSR } from './mars';
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
  sample: { number: number; name: string; kind: string; sol: number } | null; // clicked sample point
  depot: { name: string; sol: number } | null; // clicked depot tube
  rad: { sol_start: number; sol_end: number; sols_measured: number; dose_si: number; dose_plastic: number | null } | null; // clicked RAD stop
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
// Rover view: riding on the rover at the height of its mast cameras, looking where it drives. Only its wheels are drawn
// (rover.ts), at the bottom of the screen, with the route line ahead (routeGuide.ts).
const ROVER_CAM_BACK_M = 3; // camera behind the middle of the wheels, so the front and middle wheels are in view
const ROVER_CAM_UP_M = 2.2; // camera height above the ground: the top of the mast
const ROVER_TILT = 70; // degrees from straight down: the front wheels at the bottom of the screen, the horizon at the top
const ROVER_FOV = 85; // degrees, a wide lens so the wheels on both sides fit
const DEFAULT_FOV = 55; // ArcGIS's, for the other views
const ROVER_VIEW_SPEED = 30; // m/s while in this view (the whole route takes ~25 min instead of 90 s)
const ROVER_CLIP_NEAR_M = 0.5; // draw the ground from this close to the camera
const ROVER_CLIP_FAR_M = 400_000; // to the horizon and the crater rims
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
  /** "Go to Earth" was clicked. pad = screen position of the rover, or null if it is off screen. */
  onTravel?: (pad: { x: number; y: number } | null) => void;
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
  const groups = useMemo(() => [...new Set(defs.map((l) => l.group))], [defs]);
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => initialVisibility(defs));
  const [probe, setProbe] = useState<Probe | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 640); // collapsed on phones
  const [drive, setDrive] = useState<DriveState>({ ready: false, playing: false, km: 0, totalKm: 0 });
  const roverRef = useRef<ReturnType<typeof attachRover> | null>(null);
  const driveRef = useRef(drive);
  driveRef.current = drive;

  // One Map and one set of layers for both views, so a toggle applies to both.
  const { map, layers, globalElevation, roverLayer, routeLayer, guideLayer, tubes, stack } = useMemo(() => {
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
    const map = new ArcGISMap({
      layers: [...defs.map((d) => layers[d.id]), tubes.tubeLayer, routeLayer, guideLayer, roverLayer, tubes.boardLayer, ...stack.layers],
      ground: { layers: [createSiteElevationLayer(site, globalElevation)] },
    });
    void tubes.load();
    return { map, layers, globalElevation, roverLayer, routeLayer, guideLayer, tubes, stack };
  }, [site, defs]);

  const planner = useRoutePlanner(routeLayer, layers, site);
  const plannerRef = useRef(planner);
  plannerRef.current = planner;

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
      layers[def.id].visible = visibility[def.id] && !(cameraView === 'side' && STACKABLE.has(def.id) && def.id !== ground);
  }, [visibility, layers, cameraView, defs, site, routeLayer]);

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
    view.ui.move(['zoom', 'compass', 'navigation-toggle'], 'bottom-right');
    const rover = attachRover(view, roverLayer, site, setDrive);
    roverRef.current = rover;
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
        const hit = await view.hitTest(event, { include: [tubes.tubeLayer] }).catch(() => null);
        const g = hit?.results.find((r) => r.type === 'graphic');
        const samples = g && g.type === 'graphic' ? tubes.samplesOf(g.graphic) : null;
        if (samples) {
          if (driveRef.current.playing) roverRef.current?.toggleDrive();
          setProbe(null);
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
        .hitTest(event, { include: [layers['samples'], layers['depot'], layers['radiation']].filter(Boolean) })
        .then((h) => {
          const attrs = (id: string) => {
            for (const r of h.results) if (r.type === 'graphic' && r.layer === layers[id]) return r.graphic.attributes;
            return null;
          };
          return {
            sample: attrs('samples') as Probe['sample'],
            depot: attrs('depot') as Probe['depot'],
            rad: attrs('radiation') as Probe['rad'],
          };
        })
        .catch(() => ({ sample: null, depot: null, rad: null }));
      const [dtm, slope, mineral, global, hits] = await Promise.all([
        pixel('elevation'),
        pixel('slope'),
        pixel('minerals'),
        globalElevation
          .queryElevation(point)
          .then((r) => ((r.geometry as Point).z ?? null))
          .catch(() => null),
        pointHits,
      ]);
      setProbe({ lon: point.x, lat: point.y, dtm, slope, global, mineral: inDtm && layers['minerals'] ? (mineral ?? 0) : null, ...hits });
    });

    return () => {
      click.remove();
      rover.remove();
      if (roverRef.current === rover) roverRef.current = null;
      if (roverControlRef.current?.current === rover) roverControlRef.current.current = null;
      // Detach the shared Map first: destroying a view also destroys its map and layers.
      view.map = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [map, layers, globalElevation, roverLayer, tubes, site]);

  useEffect(() => {
    roverLayer.visible = showRover && cameraView !== 'side'; // hidden under the stack
    guideLayer.visible = cameraView === 'rover';
    tubes.tubeLayer.visible = tubes.boardLayer.visible = cameraView === 'rover';
    if (cameraView !== 'rover') tubes.clearBoard();
  }, [showRover, roverLayer, guideLayer, tubes, cameraView]);

  // Driving on takes the board down.
  useEffect(() => {
    if (drive.playing) tubes.clearBoard();
  }, [drive.playing, tubes]);

  // Rover view: the camera rides behind the rover and looks along the route; it moves with every step of the drive.
  useEffect(() => {
    const view = viewRef.current;
    const rover = roverRef.current;
    if (cameraView !== 'rover' || !view || !rover) return;
    let lastZ: number | null = null;
    const cameraAt = (p: RoverPose) => {
      // Ground height: the route's profile from the full-resolution terrain once it has loaded, and the terrain
      // already loaded in the view (synchronous, but coarser), whichever is higher, so the camera never dips under the ground.
      // The camera is behind the rover, so the ground under it is checked too (it may be higher on a slope).
      const h = (p.travelHeading * Math.PI) / 180;
      const lon = p.lon - (ROVER_CAM_BACK_M * Math.sin(h)) / (METERS_PER_DEGREE * Math.cos((p.lat * Math.PI) / 180));
      const lat = p.lat - (ROVER_CAM_BACK_M * Math.cos(h)) / METERS_PER_DEGREE;
      const quick = (x: number, y: number) =>
        (view.groundView?.elevationSampler?.queryElevation(new Point({ x, y, spatialReference: marsSR() })) as Point | null | undefined)?.z;
      const zs = [p.groundZ, quick(p.lon, p.lat), quick(lon, lat)].filter((z): z is number => typeof z === 'number' && Number.isFinite(z));
      if (zs.length) lastZ = Math.max(...zs);
      const position = new Point({ x: lon, y: lat, z: (lastZ ?? site.landingElevationM) + ROVER_CAM_UP_M, spatialReference: marsSR() });
      return new Camera({ position, heading: p.travelHeading, tilt: ROVER_TILT, fov: ROVER_FOV });
    };
    let entering = true; // flying down into the rover; drive steps take over when it ends
    view
      .goTo(cameraAt(rover.pose()), { duration: 2500, easing: 'cubic-in-out' })
      .catch(() => {})
      .then(() => (entering = false));
    rover.setSpeed(ROVER_VIEW_SPEED);
    rover.setRiding(true);
    const guide = routeGuideUpdater(guideLayer, rover.routeBetween);
    guide(rover.pose().distM, true);
    rover.onMove((p) => {
      guide(p.distM);
      if (!entering) view.camera = cameraAt(p);
    });
    // ArcGIS sets the near clipping plane from the camera's height (~8 m here), which would cut away the ground
    // just ahead of the rover: set it by hand while riding.
    const clip = view.constraints.clipDistance;
    clip.mode = 'manual';
    clip.near = ROVER_CLIP_NEAR_M;
    clip.far = ROVER_CLIP_FAR_M;
    return () => {
      rover.onMove(null);
      rover.setSpeed(null);
      rover.setRiding(false);
      guideLayer.removeAll();
      // Normally showView has already put the lens back before flying out; setting the camera here would stop that flight.
      if (view.camera.fov !== DEFAULT_FOV && !view.animation) view.camera = normalLens(view.camera);
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
    onTravel?.(onScreen ? { x: p.x, y: p.y } : null);
  };

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-view" />

      <div className="map-left">
      <div className="map-toolbar">
        <div className="segmented" role="group" aria-label="Camera view">
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
        {cameraView === 'rover' && (
          <span className="drive-km" aria-live="off">
            {drive.km.toFixed(2)} / {drive.totalKm.toFixed(1)} km
          </span>
        )}
      </div>
      {cameraView !== 'rover' && <RoutePanel planner={planner} site={site} />}
      </div>

      {(showRover || textureShown) && (
        <p className="rover-credit">
          {textureShown && site.texture && (
            <>
              Terrain texture:{' '}
              <a className="link" href={site.texture.credit.url} target="_blank" rel="noreferrer">
                {site.texture.credit.text}
              </a>
              {showRover && ' · '}
            </>
          )}
          {showRover && <>Rover model:{' '}
          <a className="link" href={ROVER_CREDIT.url} target="_blank" rel="noreferrer">
            {ROVER_CREDIT.text}
          </a>
          {site.rover !== 'Perseverance' && <> (Perseverance, standing in for {site.rover}: same chassis design)</>}</>}
        </p>
      )}

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

      <div className="map-right" hidden={cameraView === 'rover'}>
      <div className="layer-panel panel" data-open={panelOpen}>
        <button className="panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
          Layers
        </button>
        {panelOpen &&
          groups.map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {defs.filter((l) => l.group === group).map((def) => (
                <div key={def.id} className="layer-row">
                  <label>
                    <input
                      type={def.basemap ? 'radio' : 'checkbox'}
                      name={def.basemap ? 'basemap' : undefined}
                      checked={visibility[def.id]}
                      onChange={() => toggle(def)}
                      onClick={() => def.basemap && visibility[def.id] && toggle(def)}
                    />
                    <span>{def.title}</span>
                  </label>
                </div>
              ))}
            </section>
          ))}
      </div>
      <button className="btn earth-btn" onClick={goEarth} disabled={!canTravel}>
        Go to Earth →
      </button>
      </div>

      {probe && (
        <div className="probe panel">
          <button className="close" aria-label="Close" onClick={() => setProbe(null)}>
            ×
          </button>
          <dl>
            {probe.sample && (
              <>
                <dt>Sample</dt>
                <dd>
                  #{probe.sample.number} {probe.sample.name} ({probe.sample.kind.toLowerCase()}, sealed sol {probe.sample.sol})
                </dd>
              </>
            )}
            {probe.depot && (
              <>
                <dt>Depot tube</dt>
                <dd>
                  {probe.depot.name} (dropped sol {probe.depot.sol})
                </dd>
              </>
            )}
            {probe.rad && (
              <>
                <dt>Radiation</dt>
                <dd>
                  {probe.rad.dose_si.toFixed(0)} µGy/day in silicon
                  {probe.rad.dose_plastic !== null && `, ${probe.rad.dose_plastic.toFixed(0)} tissue-equivalent`}
                  <br />
                  sols {probe.rad.sol_start}–{probe.rad.sol_end} ({probe.rad.sols_measured} measured)
                </dd>
              </>
            )}
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
