// The route track of the Rover view: one continuous, very wide and see-through band on the ground along the route,
// in a darker shade of the ground's tan, so it reads as a road and the ground shows through it. Only the
// stretch near the rover is drawn, rebuilt as it drives.
import Graphic from '@arcgis/core/Graphic';
import Polyline from '@arcgis/core/geometry/Polyline';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import LineSymbol3D from '@arcgis/core/symbols/LineSymbol3D';
import PathSymbol3DLayer from '@arcgis/core/symbols/PathSymbol3DLayer';
import { marsSR } from './mars';

const AHEAD_M = 2500; // how far ahead the track is drawn
const BEHIND_M = 300; // how much of the driven route is drawn
const STEP_M = 2; // vertex spacing: each vertex sits on the ground, so close spacing keeps the band on it
const REBUILD_EVERY_M = 8; // rebuild when the rover has moved this far
const WIDTH_M = 5; // about twice the rover's width (2.7 m)
const LIFT_M = 0.08; // above the ground, so the ground does not hide it
/** The tan of the ground in the orbital images, a little darker, and mostly see-through. */
const COLOR = [150, 108, 78, 0.15];

type Rover = { routeBetween(fromM: number, toM: number, stepM: number): { lon: number; lat: number }[] };

export function createRouteGuideLayer() {
  return new GraphicsLayer({
    id: 'route-guide',
    title: 'Route guide',
    listMode: 'hide',
    visible: false,
    elevationInfo: { mode: 'relative-to-ground' }, // vertex z = height above the ground
  });
}

const BAND = new LineSymbol3D({
  symbolLayers: [
    new PathSymbol3DLayer({ profile: 'quad', width: WIDTH_M, height: 0.02, material: { color: COLOR }, cap: 'round', join: 'round' }),
  ],
});

/** Returns update(distM): redraws the track around a rover that has driven distM meters, if it has moved enough. */
export function routeGuideUpdater(layer: GraphicsLayer, rover: Rover) {
  let built: number | null = null;
  return (distM: number) => {
    if (built !== null && Math.abs(distM - built) < REBUILD_EVERY_M) return;
    built = distM;
    const pts = rover.routeBetween(distM - BEHIND_M, distM + AHEAD_M, STEP_M);
    layer.removeAll();
    if (pts.length < 2) return;
    layer.add(
      new Graphic({
        geometry: new Polyline({ paths: [pts.map((p) => [p.lon, p.lat, LIFT_M])], hasZ: true, spatialReference: marsSR() }),
        symbol: BAND,
      }),
    );
  };
}
