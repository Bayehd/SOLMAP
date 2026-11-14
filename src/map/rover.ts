// The Perseverance 3D model (public/models/perseverance.glb) standing at its landing site in the 3D view.
// Model: "Perseverance Mars rover" by Cybertron B-127, CC BY 4.0 (see ROVER_CREDIT and public/models/perseverance.LICENSE.txt).
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
const SCREEN_HEIGHT_PX = 90; // how tall it is drawn while the camera is too far away to see it at real size
const SITE_ELEVATION_M = -2570; // ground height at the landing site (MOLA datum)
const HEADING = 120; // degrees, so the model is seen from its side in the default view

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

export function createRoverLayer() {
  const layer = new GraphicsLayer({ id: 'rover', title: 'Perseverance (3D model)', visible: false, elevationInfo: { mode: 'on-the-ground' } });
  layer.add(
    new Graphic({
      geometry: new Point({ x: LANDING_SITE.lon, y: LANDING_SITE.lat, spatialReference: marsSR() }),
      symbol: roverSymbol(REAL_HEIGHT_M),
    }),
  );
  return layer;
}

/**
 * Keep the rover about SCREEN_HEIGHT_PX tall on screen while the camera is far away, shrinking to its real
 * size as you zoom in close. Returns a handle to stop. Only re-symbolizes when the size changes by >15%.
 */
export function keepRoverVisible(view: SceneView, layer: GraphicsLayer) {
  const graphic = layer.graphics.getItemAt(0)!;
  let current = REAL_HEIGHT_M;
  return watch(
    () => view.camera,
    (camera) => {
      if (!camera) return;
      // Measure the screen scale at the site: project two ground points 1 km apart (east-west).
      const at = (dLon: number) => new Point({ x: LANDING_SITE.lon + dLon, y: LANDING_SITE.lat, z: SITE_ELEVATION_M, spatialReference: marsSR() });
      const a = view.toScreen(at(0));
      const b = view.toScreen(at(1000 / (METERS_PER_DEGREE * Math.cos((LANDING_SITE.lat * Math.PI) / 180))));
      if (!a || !b) return;
      const px = Math.hypot(b.x - a.x, b.y - a.y);
      if (px < 1e-3) return;
      const metersPerPx = 1000 / px;
      const height = Math.max(REAL_HEIGHT_M, SCREEN_HEIGHT_PX * metersPerPx);
      if (Math.abs(height / current - 1) < 0.15) return;
      current = height;
      graphic.symbol = roverSymbol(height);
    },
    { initial: true },
  );
}
