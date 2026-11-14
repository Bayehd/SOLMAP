// The Perseverance 3D model (public/models/perseverance.glb) at its landing site in the 3D view.
// Model: "Perseverance Mars rover" by Cybertron B-127, CC BY 4.0 (see ROVER_CREDIT and public/models/perseverance.LICENSE.txt).
// attachRover() returns a RoverControl the landing animation uses to fly the model down onto the terrain.
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
const SCREEN_HEIGHT_PX = 90; // how tall it is drawn while the camera is too far away to see it at real size
const SITE_ELEVATION_M = -2570; // ground height at the landing site, until the terrain query answers
const HEADING = 120; // degrees, so the model is seen from its side in the default view

/** What the landing animation needs from the 3D view. Altitudes are meters above the ground at the site. */
export type RoverControl = {
  heightM(): number; // current display height of the model (exaggerated when far away)
  setAltitude(m: number): void;
  toScreen(altitudeM: number): { x: number; y: number } | null; // the point above the site at that altitude
  metersPerPx(): number | null; // screen scale at the site
};

const roverSymbol = (height: number) =>
  new PointSymbol3D({
    symbolLayers: [
      new ObjectSymbol3DLayer({
        resource: { href: publicUrl('models/perseverance.glb') },
        height,
        heading: HEADING,
        anchor: 'bottom',
      }),
    ],
  });

const sitePoint = (z: number) => new Point({ x: LANDING_SITE.lon, y: LANDING_SITE.lat, z, spatialReference: marsSR() });

export function createRoverLayer() {
  // Absolute heights, so the model can be flown down; z = ground elevation + altitude.
  const layer = new GraphicsLayer({ id: 'rover', title: 'Perseverance (3D model)', visible: false, elevationInfo: { mode: 'absolute-height' } });
  layer.add(new Graphic({ geometry: sitePoint(SITE_ELEVATION_M), symbol: roverSymbol(REAL_HEIGHT_M) }));
  return layer;
}

/** Screen scale at the site: project two ground points 1 km apart (east-west). */
function measureMetersPerPx(view: SceneView, groundZ: number) {
  const dLon = 1000 / (METERS_PER_DEGREE * Math.cos((LANDING_SITE.lat * Math.PI) / 180));
  const a = view.toScreen(sitePoint(groundZ));
  const b = view.toScreen(new Point({ x: LANDING_SITE.lon + dLon, y: LANDING_SITE.lat, z: groundZ, spatialReference: marsSR() }));
  if (!a || !b) return null;
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  return px < 1e-3 ? null : 1000 / px;
}

/**
 * Connect the rover layer to a 3D view: place it on the real terrain and keep it about SCREEN_HEIGHT_PX tall
 * while the camera is far away, shrinking to its real size as you zoom in (only re-symbolizes on >15% change).
 */
export function attachRover(view: SceneView, layer: GraphicsLayer): RoverControl & { remove(): void } {
  const graphic = layer.graphics.getItemAt(0)!;
  let groundZ = SITE_ELEVATION_M;
  let altitude = 0;
  let height = REAL_HEIGHT_M;
  let removed = false;
  const place = () => (graphic.geometry = sitePoint(groundZ + altitude));

  view.map?.ground
    .queryElevation(sitePoint(0))
    .then((r) => {
      const z = (r.geometry as Point).z;
      if (removed || z === undefined || z === null) return;
      groundZ = z;
      place();
    })
    .catch(() => {});

  const sizing = watch(
    () => view.camera,
    (camera) => {
      if (!camera) return;
      const mpp = measureMetersPerPx(view, groundZ);
      if (!mpp) return;
      const h = Math.max(REAL_HEIGHT_M, SCREEN_HEIGHT_PX * mpp);
      if (Math.abs(h / height - 1) < 0.15) return;
      height = h;
      graphic.symbol = roverSymbol(h);
    },
    { initial: true },
  );

  return {
    heightM: () => height,
    setAltitude(m) {
      altitude = m;
      place();
    },
    toScreen(m) {
      const p = view.toScreen(sitePoint(groundZ + m));
      return p ? { x: p.x, y: p.y } : null;
    },
    metersPerPx: () => measureMetersPerPx(view, groundZ),
    remove() {
      removed = true;
      sizing.remove();
    },
  };
}
