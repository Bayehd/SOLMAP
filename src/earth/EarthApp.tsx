// Earth page: a 3D ArcGIS globe of Earth, reached by rocket from the Mars map.
// Imagery is NASA's own: GIBS "Blue Marble" (shaded relief + bathymetry). No ground elevation is added,
// because the usual Earth elevation service is not NASA data.
import { useEffect, useRef } from 'react';
import ArcGISMap from '@arcgis/core/Map';
import Camera from '@arcgis/core/Camera';
import Point from '@arcgis/core/geometry/Point';
import WebTileLayer from '@arcgis/core/layers/WebTileLayer';
import SceneView from '@arcgis/core/views/SceneView';
import { whenOnce } from '@arcgis/core/core/reactiveUtils';
import '@arcgis/core/assets/esri/themes/dark/main.css';
import '../map/map.css';
import './earth.css';

// TODO(verify): open one tile in the browser to confirm this address, e.g.
// https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/2/1/1.jpeg
// The imagery only goes down to tile level 8, so the camera is kept above ALTITUDE_MIN.
const GIBS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{level}/{row}/{col}.jpeg';
const ALTITUDE_MIN = 900_000; // m
const FAR = new Camera({ position: new Point({ x: -60, y: 22, z: 26_000_000 }), tilt: 0, heading: 0 });
const NEAR = new Camera({ position: new Point({ x: -72, y: 30, z: 10_000_000 }), tilt: 0, heading: 0 });

export function EarthApp({ onReady, onBack, canLeave }: { onReady: () => void; onBack: () => void; canLeave: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const layer = new WebTileLayer({ urlTemplate: GIBS_URL, title: 'Blue Marble', copyright: 'NASA GIBS' });
    const map = new ArcGISMap({ layers: [layer] });
    const view = new SceneView({
      container: containerRef.current!,
      map,
      qualityProfile: 'high',
      popupEnabled: false,
      environment: { lighting: { type: 'virtual' }, atmosphereEnabled: true, starsEnabled: true },
      constraints: { altitude: { min: ALTITUDE_MIN, max: 60_000_000 } },
      camera: FAR,
    });
    view.ui.move(['zoom', 'compass', 'navigation-toggle'], 'bottom-right');

    let cancelled = false;
    view.when(() => {
      // Wait for the tiles (at most 6 s), tell the app, then drift in a little closer.
      const loaded = whenOnce(() => !view.updating);
      Promise.race([loaded, new Promise((r) => setTimeout(r, 6000))]).then(() => {
        if (cancelled) return;
        onReadyRef.current();
        setTimeout(() => {
          if (!cancelled) view.goTo(NEAR, { duration: 7000, easing: 'ease-out' }).catch(() => {});
        }, 700);
      });
    });

    return () => {
      cancelled = true;
      view.map = null;
      view.destroy();
    };
  }, []);

  return (
    <div className="map-app">
      <div ref={containerRef} className="map-view" />
      <div className="map-card panel">
        <h1>SOLMAP · Earth</h1>
        <p className="muted small">Home planet, in 3D. Imagery: NASA GIBS Blue Marble (shaded relief and bathymetry).</p>
        <div className="row">
          <button className="btn" onClick={onBack} disabled={!canLeave}>
            ← Back to Mars
          </button>
        </div>
      </div>
    </div>
  );
}
