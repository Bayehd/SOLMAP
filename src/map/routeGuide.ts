// The route line of the Rover view, like a navigation app: the way ahead in blue with a darker edge, the part
// just driven in gray. It is a flat ribbon a little narrower than the rover, laid on the ground, rebuilt as the rover
// moves (only the stretch near the rover, so it stays light).
import Graphic from '@arcgis/core/Graphic';
import Polyline from '@arcgis/core/geometry/Polyline';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import LineSymbol3D from '@arcgis/core/symbols/LineSymbol3D';
import PathSymbol3DLayer from '@arcgis/core/symbols/PathSymbol3DLayer';
import { marsSR } from './mars';

const AHEAD_M = 3000; // how far ahead the line is drawn
const BEHIND_M = 400; // how much of the driven route is drawn
const STEP_M = 2; // vertex spacing: each vertex sits on the ground, so close spacing keeps the line on it
const REBUILD_EVERY_M = 8; // rebuild when the rover has moved this far

/** A flat strip of this width (m), raised a few cm above the ground so it is not hidden by it. */
const strip = (width: number, color: number[], lift: number) => ({
  symbol: new LineSymbol3D({
    symbolLayers: [new PathSymbol3DLayer({ profile: 'quad', width, height: 0.02, material: { color }, cap: 'butt', join: 'round' })],
  }),
  lift,
});
const AHEAD_EDGE = strip(1.6, [25, 90, 200, 1], 0.06);
const AHEAD = strip(1.2, [66, 150, 255, 1], 0.08);
const DRIVEN_EDGE = strip(1.6, [110, 110, 120, 0.9], 0.06);
const DRIVEN = strip(1.2, [175, 175, 185, 0.9], 0.08);

type Sampler = (fromM: number, toM: number, stepM: number) => { lon: number; lat: number }[];

export function createRouteGuideLayer() {
  return new GraphicsLayer({
    id: 'route-guide',
    title: 'Route guide',
    listMode: 'hide',
    visible: false,
    elevationInfo: { mode: 'relative-to-ground' }, // vertex z = height above the ground
  });
}

/** Redraw the guide for a rover that has driven distM meters, if it has moved enough since the last time. */
export function routeGuideUpdater(layer: GraphicsLayer, routeBetween: Sampler) {
  let built: number | null = null;
  return (distM: number, force = false) => {
    if (!force && built !== null && Math.abs(distM - built) < REBUILD_EVERY_M) return;
    built = distM;
    const graphics: Graphic[] = [];
    const add = (pts: { lon: number; lat: number }[], s: { symbol: LineSymbol3D; lift: number }) => {
      if (pts.length < 2) return;
      const geometry = new Polyline({ paths: [pts.map((p) => [p.lon, p.lat, s.lift])], hasZ: true, spatialReference: marsSR() });
      graphics.push(new Graphic({ geometry, symbol: s.symbol }));
    };
    const ahead = routeBetween(distM, distM + AHEAD_M, STEP_M);
    const driven = routeBetween(distM - BEHIND_M, distM, STEP_M);
    add(ahead, AHEAD_EDGE);
    add(driven, DRIVEN_EDGE);
    add(driven, DRIVEN);
    add(ahead, AHEAD);
    layer.removeAll();
    layer.addMany(graphics);
  };
}
