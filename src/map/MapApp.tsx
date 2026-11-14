// SOLMAP data map: one ArcGIS Map of Mars shown as a 3D globe (SceneView), a 2D map (MapView), or the Side view:
// a 3D view where the data layers are lifted off the ground into a stack of separate slabs (layerStack.ts).
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type Layer from '@arcgis/core/layers/Layer';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import ArcGISMap from '@arcgis/core/Map';
import Camera from '@arcgis/core/Camera';
import Point from '@arcgis/core/geometry/Point';
import { watch, whenOnce } from '@arcgis/core/core/reactiveUtils';
import MapView from '@arcgis/core/views/MapView';
import SceneView from '@arcgis/core/views/SceneView';
import type Viewpoint from '@arcgis/core/Viewpoint';
import { LAYERS, MINERAL_CLASSES, SLOPE_CLASSES, globalElevationLayer, type LayerDef } from './layers';
import { createJezeroElevationLayer } from './JezeroElevationLayer';
import { STACKABLE, createLayerStack, type StackSlab } from './layerStack';
import { JEZERO_DTM_EXTENT, jezeroExtent, landingExtent, marsSR, marsTileInfo } from './mars';
import { ROVER_CREDIT, attachRover, createRoverLayer, type RoverControl } from './rover';
import '@arcgis/core/assets/esri/themes/dark/main.css';
import './map.css';

type Mode = '3d' | '2d' | 'side';
const MODE_LABELS: Record<Mode, string> = { '3d': '3D globe', '2d': '2D map', side: 'Side' };
const LABEL_GAP_PX = 24;
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

// Perseverance's landing site (Octavia E. Butler Landing); the rocket takes off from here when it is on screen.
const LANDING_SITE = { lon: 77.4509, lat: 18.4447, elevation: -2568 };

const globeCamera = () =>
  new Camera({ position: new Point({ x: 77.4, y: 18.4, z: 12_000_000, spatialReference: marsSR() }), tilt: 0, heading: 0 });

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
  /** "Go to Earth" was clicked. pad = screen position of the landing site, or null if it is off screen. */
  onTravel?: (pad: { x: number; y: number } | null) => void;
  canTravel?: boolean;
} = {}) {
  const roverControlRef = useRef(roverControl);
  roverControlRef.current = roverControl;
  const introRef = useRef(intro);
  introRef.current = intro;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | SceneView | null>(null);
  const viewpointRef = useRef<Viewpoint | null>(null);
  const [mode, setMode] = useState<Mode>('3d');
  const [visibility, setVisibility] = useState<Record<string, boolean>>(initialVisibility);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 640); // collapsed on phones
  const [slabs, setSlabs] = useState<StackSlab[]>([]);
  const [labelPos, setLabelPos] = useState<{ id: string; x: number; y: number }[]>([]);

  // One Map and one set of layers for both views, so a toggle applies to both.
  const { map, layers, globalElevation, roverLayer, stack } = useMemo(() => {
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
    const stack = createLayerStack();
    const map = new ArcGISMap({
      layers: [...LAYERS.map((d) => layers[d.id]), roverLayer, ...stack.layers],
      ground: { layers: [createJezeroElevationLayer(globalElevation)] },
    });
    return { map, layers, globalElevation, roverLayer, stack };
  }, []);

  // In the Side view the data layers leave the ground for the stack; the ground keeps the base maps.
  useEffect(() => {
    for (const def of LAYERS) layers[def.id].visible = visibility[def.id] && !(mode === 'side' && STACKABLE.has(def.id));
  }, [visibility, layers, mode]);

  // (Re)create the view when the mode changes, keeping the camera where it was.
  useEffect(() => {
    const container = containerRef.current!;
    const common = { container, map, spatialReference: marsSR(), popupEnabled: false };
    const view =
      mode !== '2d'
        ? new SceneView({ ...common, qualityProfile: 'high', environment: { lighting: { type: 'virtual' } } })
        : new MapView({ ...common, constraints: { rotationEnabled: false, lods: marsTileInfo().lods } });
    viewRef.current = view;
    if (import.meta.env.DEV) Object.assign(window, { solmap: { map, view, layers } }); // for the browser console
    view.ui.move(['zoom', 'compass', 'navigation-toggle'], 'bottom-right');
    // The 3D model is a 3D-only symbol; the 2D map doesn't show it.
    const rover = mode === '3d' && view instanceof SceneView ? attachRover(view, roverLayer) : null;
    if (roverControlRef.current) roverControlRef.current.current = rover;

    view.when(() => {
      if (mode === 'side') return; // the stack effect frames the stack
      if (viewpointRef.current) view.viewpoint = viewpointRef.current;
      else if (introRef.current && view instanceof SceneView) {
        view.goTo(globeCamera(), { animate: false });
        // Wait for the globe tiles (at most 6 s) so the home page fades onto a loaded planet.
        const loaded = whenOnce(() => !view.updating);
        Promise.race([loaded, new Promise((r) => setTimeout(r, 6000))]).then(() => introRef.current?.onReady());
      } else if (view instanceof SceneView) view.goTo({ target: jezeroExtent(), tilt: 55 }, { animate: false });
      else view.goTo(jezeroExtent(), { animate: false });
    });

    const click = view.on('click', async (event) => {
      const p = event.mapPoint;
      if (!p || mode === 'side') return;
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
      if (view.ready) viewpointRef.current = view.viewpoint?.clone() ?? null;
      click.remove();
      rover?.remove();
      if (roverControlRef.current?.current === rover) roverControlRef.current.current = null;
      // Detach the shared Map first: destroying a view also destroys its map and layers.
      view.map = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [mode, map, layers, globalElevation, roverLayer]);

  useEffect(() => {
    roverLayer.visible = showRover && mode === '3d';
  }, [showRover, mode, roverLayer]);

  // Side view: one slab per checked data layer, in catalog order from the ground up. Framed once on entry.
  const stackIds = LAYERS.filter((l) => STACKABLE.has(l.id) && visibility[l.id]).map((l) => l.id).join(',');
  const framed = useRef(false);
  useEffect(() => {
    const side = mode === 'side';
    for (const l of stack.layers) l.visible = side;
    if (!side) {
      framed.current = false;
      setSlabs([]);
      return;
    }
    let cancelled = false;
    stack
      .update(stackIds ? stackIds.split(',') : [])
      .then((placed) => {
        if (cancelled) return;
        setSlabs(placed);
        const view = viewRef.current;
        if (framed.current || !(view instanceof SceneView) || !placed.length) return;
        framed.current = true;
        view.when(() => view.goTo({ target: stack.stack.graphics.toArray(), heading: 35, tilt: 62 }, { animate: false }));
      })
      .catch((err) => console.error('Could not build the layer stack', err));
    return () => {
      cancelled = true;
    };
  }, [mode, stackIds, stack]);

  // Slab labels sit to the left of the stack (the layer panel is on the right), level with each slab.
  useEffect(() => {
    const view = viewRef.current;
    if (mode !== 'side' || !(view instanceof SceneView) || !slabs.length) {
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
  }, [mode, slabs]);

  // Intro flight: globe -> Jezero, slow enough to read as a descent.
  const fly = intro?.fly ?? false;
  useEffect(() => {
    const view = viewRef.current;
    if (!fly || !(view instanceof SceneView)) return;
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

  const goJezero = () => {
    const view = viewRef.current;
    if (view instanceof SceneView) view.goTo({ target: jezeroExtent(), tilt: 55 });
    else view?.goTo(jezeroExtent());
  };
  const goGlobe = () => {
    const view = viewRef.current;
    if (view instanceof SceneView) view.goTo(globeCamera());
    else view?.goTo({ center: [77.4, 18.4], scale: 60_000_000 });
  };

  const goEarth = () => {
    const view = viewRef.current;
    const site = new Point({ x: LANDING_SITE.lon, y: LANDING_SITE.lat, z: LANDING_SITE.elevation, spatialReference: marsSR() });
    const p = view instanceof SceneView ? view.toScreen(site) : view?.toScreen(site);
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
          <div className="segmented" role="group" aria-label="View">
            {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
              <button key={m} className="btn" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <button className="btn" onClick={goJezero}>
            Jezero
          </button>
          <button className="btn" onClick={goGlobe}>
            Whole planet
          </button>
        </div>
      </div>

      {mode === 'side' && (
        <div className="stack-labels" aria-hidden="true">
          {labelPos.map((p) => {
            const s = slabs.find((x) => x.id === p.id)!;
            return (
              <div key={p.id} className="slab-label" style={{ left: p.x, top: p.y }}>
                <span>{s.title}</span>
                <small>{s.detail}</small>
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
