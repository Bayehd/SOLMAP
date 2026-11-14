import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import type * as THREE from 'three';
import { CameraRig, type FlightRequest, type View } from './mars/CameraRig';
import { CameraLight } from './mars/CameraLight';
import { buildLayerBlock } from './mars/layerBlock';
import { LayerBlockView } from './mars/LayerBlockView';
import { INITIAL_LAYERS, LayersPanel, type Layer } from './mars/LayersPanel';
import { getMarsColorMap } from './mars/loadMarsColorMap';
import { MarsGlobe } from './mars/MarsGlobe';
import { ROVER_URL, Rover, type RoverTarget } from './mars/Rover';
import { loadSiteGrid, type MolaGrid } from './mars/mola';
import { SiteMarkers } from './mars/SiteMarkers';
import { SITES, type Site } from './mars/sites';
import './styles.css';

type GridState = { status: 'loading' | 'missing' | 'error'; message?: string } | { status: 'ready'; grid: MolaGrid };
type SiteView = 'top' | 'front';

const HINTS: Record<View, string> = {
  globe: 'Drag to spin · scroll or pinch to zoom · click a site',
  flying: '',
  top: 'Click to drive the rover · drag to pan · scroll or pinch to zoom',
  front: 'Drag sideways to turn · scroll or pinch to zoom',
};

export function App() {
  const [view, setView] = useState<View>('globe');
  const [site, setSite] = useState<Site | null>(null);
  const [flight, setFlight] = useState<FlightRequest | null>(null);
  const [layers, setLayers] = useState<Layer[]>(INITIAL_LAYERS);
  const [gridState, setGridState] = useState<GridState>({ status: 'loading' });
  const [roverTarget, setRoverTarget] = useState<RoverTarget | null>(null);
  const [frontEntry, setFrontEntry] = useState(0); // changes on each entry into the Front view
  const [colorMap, setColorMap] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    getMarsColorMap().then(setColorMap, (err) => console.error(err));
  }, []);

  // Load the site's MOLA grid as soon as a site is chosen, so it is ready on arrival.
  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    setGridState({ status: 'loading' });
    loadSiteGrid(site.id).then(
      (grid) => !cancelled && setGridState(grid ? { status: 'ready', grid } : { status: 'missing' }),
      (err: Error) => !cancelled && setGridState({ status: 'error', message: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [site]);

  // The Front view's exploded block: one slab per visible layer, top to bottom.
  const visibleKey = layers.filter((l) => l.visible).map((l) => l.id).join(',');
  const block = useMemo(() => {
    if (!site || gridState.status !== 'ready') return null;
    try {
      return buildLayerBlock(site, gridState.grid, layers.filter((l) => l.visible), colorMap);
    } catch (err) {
      console.error(err);
      return null;
    }
  }, [site, gridState, visibleKey, colorMap]);
  useEffect(() => () => block?.dispose(), [block]);
  const focus = useMemo(() => (block ? { center: block.center, radius: block.radius } : null), [block]);
  useEffect(() => {
    if (site && gridState.status === 'missing') console.warn(`No MOLA grid for ${site.id}: run scripts/build_mola_sites.py ${site.id}`);
    if (gridState.status === 'error') console.error(`Could not load MOLA data: ${gridState.message}`);
  }, [site, gridState]);

  // Layers belong to the Front view; the Top view and the globe stay clean.
  const showLayers = view === 'front' || (view === 'flying' && flight?.to === 'front');

  const fly = (to: FlightRequest['to']) => {
    const id = Date.now();
    setView('flying');
    setFlight({ to, id });
    if (to === 'front') setFrontEntry(id);
  };
  const flyToSite = (s: Site) => {
    if (view !== 'globe') return;
    setSite(s);
    setRoverTarget(null);
    useGLTF.preload(ROVER_URL); // load the rover during the flight
    fly('top');
  };
  const flyHome = () => {
    setLayers(INITIAL_LAYERS);
    fly('globe');
  };
  const onArrive = useCallback((v: Exclude<View, 'flying'>) => {
    setView(v);
    if (v === 'globe') setSite(null);
  }, []);

  const arrived = view === 'top' || view === 'front';
  return (
    <>
      <Canvas gl={{ logarithmicDepthBuffer: true }} camera={{ position: [0, 0, 3], fov: 45, near: 1e-5, far: 100 }}>
        <ambientLight intensity={0.35} />
        <CameraLight />
        <MarsGlobe onPick={view === 'top' ? (point) => setRoverTarget({ point, id: Date.now() }) : undefined} />
        {block && showLayers && <LayerBlockView block={block} entryId={frontEntry} />}
        {site && (
          <Suspense fallback={null}>
            <Rover site={site} grid={gridState.status === 'ready' ? gridState.grid : null} visible={view === 'top'} target={roverTarget} />
          </Suspense>
        )}
        <SiteMarkers sites={SITES} enabled={view === 'globe'} onSelect={flyToSite} />
        <CameraRig view={view} site={site} focus={focus} flight={flight} onArrive={onArrive} />
      </Canvas>

      <div className="hud">
        {arrived && site && (
          <div className="panel site-card">
            <h2>{site.name}</h2>
            <p className="muted">{site.description}</p>
            <div className="actions">
              <button className="btn" onClick={flyHome}>
                Back to globe
              </button>
              <div className="segmented" role="group" aria-label="View">
                {(['top', 'front'] as SiteView[]).map((v) => (
                  <button key={v} className="btn" aria-pressed={view === v} onClick={() => view !== v && fly(v)}>
                    {v === 'top' ? 'Top view' : 'Front view'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {view === 'front' && site && (
          <LayersPanel
            layers={layers}
            onToggle={(id) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)))}
            disabled={gridState.status === 'ready' ? [] : layers.map((l) => l.id)}
          />
        )}

        <div className="hint">{HINTS[view]}</div>
      </div>
    </>
  );
}
