// SOLMAP data map: one ArcGIS Map of Mars in a 3D SceneView, with 3D / Side / Top camera views of Jezero.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type Layer from '@arcgis/core/layers/Layer';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import ArcGISMap from '@arcgis/core/Map';
import Camera from '@arcgis/core/Camera';
import Point from '@arcgis/core/geometry/Point';
import { whenOnce } from '@arcgis/core/core/reactiveUtils';
import SceneView from '@arcgis/core/views/SceneView';
import { LAYERS, MINERAL_CLASSES, SLOPE_CLASSES, globalElevationLayer, type LayerDef } from './layers';
import { createJezeroElevationLayer } from './JezeroElevationLayer';
import { JEZERO_DTM_EXTENT, LANDING_SITE, jezeroExtent, landingExtent, marsSR } from './mars';
import { ROVER_CREDIT, attachRover, createRoverLayer, type DriveState, type RoverControl } from './rover';
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
};

const initialVisibility = () => Object.fromEntries(LAYERS.map((l) => [l.id, l.visible]));
const GROUPS = [...new Set(LAYERS.map((l) => l.group))];

function slopeClass(deg: number) {
  return SLOPE_CLASSES.find((c) => deg < c.max) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
}

/** Opening sequence from the home page: start on the whole planet, then fly down to Jezero. */
export type MapIntro = {
  fly: boolean; // set once the home page is out of the way
  onReady: () => void; // the globe has loaded
  onArrive: () => void; // the camera has reached Jezero
};

const globeCamera = () =>
  new Camera({ position: new Point({ x: 77.4, y: 18.4, z: 12_000_000, spatialReference: marsSR() }), tilt: 0, heading: 0 });

// Camera views of the Jezero area.
type CameraView = '3d' | 'side' | 'top';
const CAMERA_VIEWS: { id: CameraView; label: string }[] = [
  { id: '3d', label: '3D' },
  { id: 'side', label: 'Side' },
  { id: 'top', label: 'Top' },
];
const JEZERO_CENTER = {
  lon: (JEZERO_DTM_EXTENT.xmin + JEZERO_DTM_EXTENT.xmax) / 2,
  lat: (JEZERO_DTM_EXTENT.ymin + JEZERO_DTM_EXTENT.ymax) / 2,
};
const SIDE_DISTANCE_DEG = 0.42; // side view: camera this far south of the centre (~25 km) ...
const SIDE_HEIGHT_M = -2600 + 3500; // ... about 3.5 km above the crater floor ...
const SIDE_TILT = 84; // ... looking almost level across the crater (90 = horizontal)

// Following the rover: each view frames the rover from its angle, closer in.
const VIEW_TILT: Record<CameraView, number> = { '3d': 55, side: SIDE_TILT, top: 0 };
const FOLLOW_SCALE = 25_000;

function cameraFor(v: CameraView) {
  if (v === '3d') return { target: jezeroExtent(), tilt: 55, heading: 0 };
  if (v === 'top') return { target: jezeroExtent(), tilt: 0, heading: 0 };
  return new Camera({
    position: new Point({ x: JEZERO_CENTER.lon, y: JEZERO_CENTER.lat - SIDE_DISTANCE_DEG, z: SIDE_HEIGHT_M, spatialReference: marsSR() }),
    heading: 0,
    tilt: SIDE_TILT,
  });
}

export function MapApp({
  intro,
  showRover = false,
  roverControl,
  onTravel,
  canTravel = false,
}: {
  intro?: MapIntro;
  showRover?: boolean;
  /** Filled while the 3D view is up, for the landing animation. */
  roverControl?: RefObject<RoverControl | null>;
  /** "Go to Earth" was clicked. pad = screen position of the rover, or null if it is off screen. */
  onTravel?: (pad: { x: number; y: number } | null) => void;
  canTravel?: boolean;
} = {}) {
  const roverControlRef = useRef(roverControl);
  roverControlRef.current = roverControl;
  const introRef = useRef(intro);
  introRef.current = intro;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SceneView | null>(null);
  const [cameraView, setCameraView] = useState<CameraView>('3d');
  const [visibility, setVisibility] = useState<Record<string, boolean>>(initialVisibility);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 640); // collapsed on phones
  const [drive, setDrive] = useState<DriveState>({ ready: false, playing: false, km: 0, totalKm: 0 });
  const roverRef = useRef<ReturnType<typeof attachRover> | null>(null);
  const [follow, setFollow] = useState(false);
  const followRef = useRef(follow);
  followRef.current = follow;
  const playingRef = useRef(drive.playing);
  playingRef.current = drive.playing;
  const aimingRef = useRef(false); // an animated goTo onto the rover is running: don't shift the camera under it

  // One Map and one set of layers for both views, so a toggle applies to both.
  const { map, layers, globalElevation, roverLayer } = useMemo(() => {
    const layers: Record<string, Layer> = {};
    for (const def of LAYERS) {
      const layer = def.create();
      layer.id = def.id;
      layer.title = def.title;
      layer.visible = def.visible;
      if (def.opacity !== undefined) layer.opacity = def.opacity;
      layers[def.id] = layer;
    }
    const globalElevation = globalElevationLayer();
    const roverLayer = createRoverLayer();
    const map = new ArcGISMap({
      layers: [...LAYERS.map((d) => layers[d.id]), roverLayer],
      ground: { layers: [createJezeroElevationLayer(globalElevation)] },
    });
    return { map, layers, globalElevation, roverLayer };
  }, []);

  useEffect(() => {
    for (const def of LAYERS) layers[def.id].visible = visibility[def.id];
  }, [visibility, layers]);

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
    // While following, move the camera by the same step as the rover, keeping whatever angle and zoom it has.
    const onMove = (dLon: number, dLat: number) => {
      if (!followRef.current || aimingRef.current || !view.ready || (!dLon && !dLat)) return;
      const cam = view.camera.clone();
      cam.position.x += dLon;
      cam.position.y += dLat;
      view.camera = cam;
    };
    const rover = attachRover(view, roverLayer, setDrive, onMove);
    roverRef.current = rover;
    if (roverControlRef.current) roverControlRef.current.current = rover;

    view.when(() => {
      if (introRef.current) {
        view.goTo(globeCamera(), { animate: false });
        // Wait for the globe tiles (at most 6 s) so the home page fades onto a loaded planet.
        const loaded = whenOnce(() => !view.updating);
        Promise.race([loaded, new Promise((r) => setTimeout(r, 6000))]).then(() => introRef.current?.onReady());
      } else view.goTo(cameraFor('3d'), { animate: false });
    });

    const click = view.on('click', async (event) => {
      const p = event.mapPoint;
      if (!p) return;
      const point = new Point({ x: p.longitude ?? p.x, y: p.latitude ?? p.y, spatialReference: marsSR() });
      const inDtm =
        point.x >= JEZERO_DTM_EXTENT.xmin && point.x <= JEZERO_DTM_EXTENT.xmax && point.y >= JEZERO_DTM_EXTENT.ymin && point.y <= JEZERO_DTM_EXTENT.ymax;
      const pixel = async (id: string) => {
        if (!inDtm) return null;
        const r = await (layers[id] as ImageryTileLayer).identify(point);
        const v = r.value?.[0];
        return v === undefined || v === null || v <= -32767 ? null : v;
      };
      const pointHits = view
        .hitTest(event, { include: [layers['m20-samples'], layers['m20-depot']] })
        .then((h) => {
          const attrs = (id: string) => {
            for (const r of h.results) if (r.type === 'graphic' && r.layer === layers[id]) return r.graphic.attributes;
            return null;
          };
          return { sample: attrs('m20-samples') as Probe['sample'], depot: attrs('m20-depot') as Probe['depot'] };
        })
        .catch(() => ({ sample: null, depot: null }));
      const [dtm, slope, mineral, global, hits] = await Promise.all([
        pixel('jezero-elevation'),
        pixel('jezero-slope'),
        pixel('jezero-minerals'),
        globalElevation
          .queryElevation(point)
          .then((r) => ((r.geometry as Point).z ?? null))
          .catch(() => null),
        pointHits,
      ]);
      setProbe({ lon: point.x, lat: point.y, dtm, slope, global, mineral: inDtm ? (mineral ?? 0) : null, ...hits });
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
  }, [map, layers, globalElevation, roverLayer]);

  useEffect(() => {
    roverLayer.visible = showRover;
  }, [showRover, roverLayer]);

  // Intro flight: globe -> Jezero, slow enough to read as a descent.
  const fly = intro?.fly ?? false;
  useEffect(() => {
    const view = viewRef.current;
    if (!fly || !view) return;
    let cancelled = false;
    view
      .when(() => view.goTo({ target: landingExtent(), tilt: 55 }, { duration: 5000, easing: 'cubic-in-out' }))
      .catch(() => {}) // interrupted by the user: land anyway
      .then(() => !cancelled && introRef.current?.onArrive());
    return () => {
      cancelled = true;
    };
  }, [fly]);

  const toggle = (def: LayerDef) =>
    setVisibility((v) => {
      const next = { ...v, [def.id]: !v[def.id] };
      if (def.basemap && next[def.id]) for (const o of LAYERS) if (o.basemap && o.id !== def.id) next[o.id] = false;
      return next;
    });

  /** Frame the rover at a tilt and heading; snaps instead of animating while it drives, so it stays centred. */
  const aimAtRover = async (tilt: number, heading: number) => {
    const view = viewRef.current;
    const rover = roverRef.current;
    if (!view || !rover) return;
    const { lon, lat } = rover.position();
    const z = await map.ground
      .queryElevation(new Point({ x: lon, y: lat, spatialReference: marsSR() }))
      .then((r) => (r.geometry as Point).z ?? 0)
      .catch(() => 0);
    const here = rover.position(); // it may have moved while the elevation was queried
    const target = new Point({ x: here.lon, y: here.lat, z, spatialReference: marsSR() });
    const animate = !playingRef.current;
    aimingRef.current = animate;
    await view.goTo({ target, tilt, heading, scale: FOLLOW_SCALE }, animate ? { duration: 1200 } : { animate: false }).catch(() => {});
    aimingRef.current = false;
  };

  const showView = (v: CameraView) => {
    setCameraView(v);
    if (followRef.current) void aimAtRover(VIEW_TILT[v], 0);
    else viewRef.current?.goTo(cameraFor(v), { duration: 1500 }).catch(() => {});
  };

  const toggleFollow = () => {
    const on = !followRef.current;
    followRef.current = on;
    setFollow(on);
    const cam = viewRef.current?.camera;
    if (on) void aimAtRover(cam?.tilt ?? VIEW_TILT[cameraView], cam?.heading ?? 0);
  };

  // The rocket takes off from wherever the rover is (the landing site until it has driven).
  const goEarth = async () => {
    const view = viewRef.current;
    const { lon, lat } = roverRef.current?.position() ?? { lon: LANDING_SITE.lon, lat: LANDING_SITE.lat };
    const ground = await map.ground
      .queryElevation(new Point({ x: lon, y: lat, spatialReference: marsSR() }))
      .then((r) => (r.geometry as Point).z ?? 0)
      .catch(() => 0);
    const site = new Point({ x: lon, y: lat, z: ground, spatialReference: marsSR() });
    const p = view?.toScreen(site);
    const onScreen = p && view && p.x > 0 && p.y > 0 && p.x < view.width && p.y < view.height;
    onTravel?.(onScreen ? { x: p.x, y: p.y } : null);
  };

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-view" />

      <div className="map-card panel">
        <h1>SOLMAP · Jezero Crater</h1>
        <p className="muted small">Real data layers on Mars (GCS Mars 2000). Click the map to read elevation and slope.</p>
        {showRover && (
          <p className="muted small">
            Rover model:{' '}
            <a className="link" href={ROVER_CREDIT.url} target="_blank" rel="noreferrer">
              {ROVER_CREDIT.text}
            </a>
          </p>
        )}
        <div className="row">
          <div className="segmented" role="group" aria-label="Camera view">
            {CAMERA_VIEWS.map(({ id, label }) => (
              <button key={id} className="btn" aria-pressed={cameraView === id} onClick={() => showView(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {showRover && (
          <div className="row drive-row">
            <button className="btn" onClick={() => roverRef.current?.toggleDrive()} disabled={!canTravel || !drive.ready}>
              {drive.playing ? 'Pause' : drive.km > 0 && drive.km < drive.totalKm ? 'Resume drive' : 'Drive route'}
            </button>
            <button className="btn" onClick={() => roverRef.current?.resetDrive()} disabled={!canTravel || !drive.ready || drive.km === 0}>
              Reset
            </button>
            <button className="btn" aria-pressed={follow} onClick={toggleFollow} disabled={!canTravel}>
              Follow
            </button>
            <span className="muted small" aria-live="off">
              {drive.ready ? `${drive.km.toFixed(1)} / ${drive.totalKm.toFixed(1)} km` : 'Loading route…'}
            </span>
          </div>
        )}
      </div>

      <div className="map-right">
      <div className="layer-panel panel" data-open={panelOpen}>
        <button className="panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
          Layers
        </button>
        {panelOpen &&
          GROUPS.map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {LAYERS.filter((l) => l.group === group).map((def) => (
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
            <dt>Position</dt>
            <dd>
              {probe.lat.toFixed(5)}° N, {probe.lon.toFixed(5)}° E
            </dd>
            <dt>Elevation (20 m DTM)</dt>
            <dd>{probe.dtm === null ? 'outside the Jezero DTM' : `${probe.dtm.toFixed(1)} m`}</dd>
            <dt>Slope (20 m DTM)</dt>
            <dd>
              {probe.slope === null ? '–' : (
                <>
                  {probe.slope.toFixed(1)}° <span className="swatch" style={{ background: `rgb(${slopeClass(probe.slope).color.join(',')})` }} />{' '}
                  {slopeClass(probe.slope).label}
                </>
              )}
            </dd>
            <dt>Mineral (CRISM)</dt>
            <dd>
              {probe.mineral === null ? '–' : probe.mineral === 0 ? 'none detected or no coverage' : (
                <>
                  <span className="swatch" style={{ background: `rgb(${MINERAL_CLASSES[probe.mineral - 1].color.join(',')})` }} />{' '}
                  {MINERAL_CLASSES[probe.mineral - 1].label}
                </>
              )}
            </dd>
            <dt>Elevation (MOLA, 463 m)</dt>
            <dd>{probe.global === null ? '–' : `${probe.global.toFixed(0)} m`}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
