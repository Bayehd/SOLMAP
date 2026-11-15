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
import { createSiteElevationLayer } from './SiteElevationLayer';
import { STACKABLE, createLayerStack, type StackSlab } from './layerStack';
import { marsSR } from './mars';
import { formatLatLon, insideSite, landingExtent, siteExtent, type Site } from './sites';
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
type CameraView = '3d' | 'side' | 'top';
const CAMERA_VIEWS: { id: CameraView; label: string }[] = [
  { id: '3d', label: '3D' },
  { id: 'side', label: 'Side' },
  { id: 'top', label: 'Top' },
];
// Side view: the layer stack, seen corner-on from the southwest.
const SIDE_TILT = 68;
const SIDE_HEADING = 35;
const LABEL_GAP_PX = 24; // between the stack and its labels
const TOP_ZOOM = 0.65; // top view frames this fraction of the site's area (smaller = closer)


/** Camera for the 3D and Top views; the Side view frames the stack once it is built. */
function cameraFor(site: Site, v: Exclude<CameraView, 'side'>) {
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

  // One Map and one set of layers for both views, so a toggle applies to both.
  const { map, layers, globalElevation, roverLayer, routeLayer, stack } = useMemo(() => {
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
    const stack = createLayerStack(site, defs);
    const map = new ArcGISMap({
      layers: [...defs.map((d) => layers[d.id]), routeLayer, roverLayer, ...stack.layers],
      ground: { layers: [createSiteElevationLayer(site, globalElevation)] },
    });
    return { map, layers, globalElevation, roverLayer, routeLayer, stack };
  }, [site, defs]);

  const planner = useRoutePlanner(routeLayer, layers, site);
  const plannerRef = useRef(planner);
  plannerRef.current = planner;

  // In the Side view the data layers leave the ground for the stack; the ground keeps the base maps.
  useEffect(() => {
    for (const def of defs) layers[def.id].visible = visibility[def.id] && !(cameraView === 'side' && STACKABLE.has(def.id));
  }, [visibility, layers, cameraView, defs]);

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
      const inDtm = insideSite(site, { lon: point.x, lat: point.y });
      const pixel = async (id: string) => {
        if (!inDtm || !layers[id]) return null;
        const r = await (layers[id] as ImageryTileLayer).identify(point);
        const v = r.value?.[0];
        return v === undefined || v === null || v <= -32767 ? null : v;
      };
      const pointHits = view
        .hitTest(event, { include: [layers['samples'], layers['depot']].filter(Boolean) })
        .then((h) => {
          const attrs = (id: string) => {
            for (const r of h.results) if (r.type === 'graphic' && r.layer === layers[id]) return r.graphic.attributes;
            return null;
          };
          return { sample: attrs('samples') as Probe['sample'], depot: attrs('depot') as Probe['depot'] };
        })
        .catch(() => ({ sample: null, depot: null }));
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
  }, [map, layers, globalElevation, roverLayer, site]);

  useEffect(() => {
    roverLayer.visible = showRover && cameraView !== 'side'; // hidden under the stack
  }, [showRover, roverLayer, cameraView]);

  // Side view: one slab per checked data layer, elevation on top (see layerStack.ts). Framed once on entry.
  const stackIds = defs.filter((l) => STACKABLE.has(l.id) && visibility[l.id]).map((l) => l.id).join(',');
  const baseIds = defs.filter((l) => l.group === 'Base map' && visibility[l.id]).map((l) => l.id).join(','); // drawn on every slab
  const framed = useRef(false);
  useEffect(() => {
    const side = cameraView === 'side';
    for (const l of stack.layers) l.visible = side;
    // Keep the stack clear of the title card (top left), where its labels go.
    if (viewRef.current) viewRef.current.padding = { top: side ? 160 : 0, left: side ? 120 : 0, right: 0, bottom: 0 };
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
        if (framed.current || !view || !placed.length) return;
        framed.current = true;
        view.goTo({ target: stack.stack.graphics.toArray(), heading: SIDE_HEADING, tilt: SIDE_TILT }, { duration: 1500 }).catch(() => {});
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

  const toggle = (def: LayerDef) =>
    setVisibility((v) => {
      const next = { ...v, [def.id]: !v[def.id] };
      if (def.basemap && next[def.id]) for (const o of defs) if (o.basemap && o.id !== def.id) next[o.id] = false;
      return next;
    });

  const showView = (v: CameraView) => {
    setCameraView(v);
    if (v !== 'side') viewRef.current?.goTo(cameraFor(site, v), { duration: 1500 }).catch(() => {}); // side: framed by the stack effect
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
            <button key={id} className="btn" aria-pressed={cameraView === id} onClick={() => showView(id)}>
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
      </div>
      <RoutePanel planner={planner} site={site} />
      </div>

      {showRover && (
        <p className="rover-credit">
          Rover model:{' '}
          <a className="link" href={ROVER_CREDIT.url} target="_blank" rel="noreferrer">
            {ROVER_CREDIT.text}
          </a>
          {site.rover !== 'Perseverance' && <> (Perseverance, standing in for {site.rover}: same chassis design)</>}
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

      <div className="map-right">
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
