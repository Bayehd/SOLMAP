// SOLMAP data map: one ArcGIS Map of Mars shown as a 3D globe (SceneView) or a 2D map (MapView).
import { useEffect, useMemo, useRef, useState } from 'react';
import type Layer from '@arcgis/core/layers/Layer';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import ArcGISMap from '@arcgis/core/Map';
import Camera from '@arcgis/core/Camera';
import Point from '@arcgis/core/geometry/Point';
import MapView from '@arcgis/core/views/MapView';
import SceneView from '@arcgis/core/views/SceneView';
import type Viewpoint from '@arcgis/core/Viewpoint';
import { LAYERS, SLOPE_CLASSES, globalElevationLayer, type LayerDef } from './layers';
import { createJezeroElevationLayer } from './JezeroElevationLayer';
import { JEZERO_DTM_EXTENT, jezeroExtent, marsSR, marsTileInfo } from './mars';
import '@arcgis/core/assets/esri/themes/dark/main.css';
import './map.css';

type Mode = '3d' | '2d';
type Probe = {
  lon: number;
  lat: number;
  dtm: number | null; // m, 20 m DTM
  slope: number | null; // degrees
  global: number | null; // m, 200 m global DEM
};

const initialVisibility = () => Object.fromEntries(LAYERS.map((l) => [l.id, l.visible]));
const GROUPS = [...new Set(LAYERS.map((l) => l.group))];

function slopeClass(deg: number) {
  return SLOPE_CLASSES.find((c) => deg < c.max) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
}

export function MapApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | SceneView | null>(null);
  const viewpointRef = useRef<Viewpoint | null>(null);
  const [mode, setMode] = useState<Mode>('3d');
  const [visibility, setVisibility] = useState<Record<string, boolean>>(initialVisibility);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 640); // collapsed on phones

  // One Map and one set of layers for both views, so a toggle applies to both.
  const { map, layers, globalElevation } = useMemo(() => {
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
    const map = new ArcGISMap({
      layers: LAYERS.map((d) => layers[d.id]),
      ground: { layers: [createJezeroElevationLayer(globalElevation)] },
    });
    return { map, layers, globalElevation };
  }, []);

  useEffect(() => {
    for (const def of LAYERS) layers[def.id].visible = visibility[def.id];
  }, [visibility, layers]);

  // (Re)create the view when the mode changes, keeping the camera where it was.
  useEffect(() => {
    const container = containerRef.current!;
    const common = { container, map, spatialReference: marsSR(), popupEnabled: false };
    const view =
      mode === '3d'
        ? new SceneView({ ...common, qualityProfile: 'high', environment: { lighting: { type: 'virtual' } } })
        : new MapView({ ...common, constraints: { rotationEnabled: false, lods: marsTileInfo().lods } });
    viewRef.current = view;
    if (import.meta.env.DEV) Object.assign(window, { solmap: { map, view, layers } }); // for the browser console
    view.ui.move(['zoom', 'compass', 'navigation-toggle'], 'bottom-right');

    view.when(() => {
      if (viewpointRef.current) view.viewpoint = viewpointRef.current;
      else if (view instanceof SceneView) view.goTo({ target: jezeroExtent(), tilt: 55 }, { animate: false });
      else view.goTo(jezeroExtent(), { animate: false });
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
      const [dtm, slope, global] = await Promise.all([
        pixel('jezero-elevation'),
        pixel('jezero-slope'),
        globalElevation
          .queryElevation(point)
          .then((r) => ((r.geometry as Point).z ?? null))
          .catch(() => null),
      ]);
      setProbe({ lon: point.x, lat: point.y, dtm, slope, global });
    });

    return () => {
      if (view.ready) viewpointRef.current = view.viewpoint?.clone() ?? null;
      click.remove();
      // Detach the shared Map first: destroying a view also destroys its map and layers.
      view.map = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [mode, map, layers, globalElevation]);

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
    if (view instanceof SceneView) view.goTo(new Camera({ position: new Point({ x: 77.4, y: 18.4, z: 12_000_000, spatialReference: marsSR() }), tilt: 0, heading: 0 }));
    else view?.goTo({ center: [77.4, 18.4], scale: 60_000_000 });
  };

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-view" />

      <div className="map-card panel">
        <h1>SOLMAP · Jezero Crater</h1>
        <p className="muted small">Real data layers on Mars (GCS Mars 2000). Click the map to read elevation and slope.</p>
        <div className="row">
          <div className="segmented" role="group" aria-label="View">
            {(['3d', '2d'] as Mode[]).map((m) => (
              <button key={m} className="btn" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === '3d' ? '3D globe' : '2D map'}
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
        <a className="small link" href="classic.html">
          Open the classic 3D model view
        </a>
      </div>

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
                    <span className={`badge badge-${def.kind}`}>{def.kind}</span>
                  </label>
                  {visibility[def.id] && (
                    <div className="layer-detail">
                      <p className="muted small">{def.description}</p>
                      {def.legend && (
                        <ul className="legend">
                          {def.legend.map((item) => (
                            <li key={item.label}>
                              <span className="swatch" style={{ background: item.color }} />
                              {item.label}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="muted small">
                        {def.resolution} ·{' '}
                        <a className="link" href={def.source.url} target="_blank" rel="noreferrer">
                          {def.source.name}
                        </a>
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
      </div>

      {probe && (
        <div className="probe panel">
          <button className="close" aria-label="Close" onClick={() => setProbe(null)}>
            ×
          </button>
          <dl>
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
            <dt>Elevation (200 m global DEM)</dt>
            <dd>{probe.global === null ? '–' : `${probe.global.toFixed(0)} m`}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
