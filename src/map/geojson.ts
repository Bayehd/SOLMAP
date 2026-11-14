// GeoJSON on Mars. ArcGIS's GeoJSONLayer treats coordinates as WGS84 (Earth) and cannot place
// them on Mars, so this reads [lon, lat] as GCS Mars 2000 and builds a client-side FeatureLayer.
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils';
import FeatureLayer, { type FeatureLayerProperties } from '@arcgis/core/layers/FeatureLayer';
import type Field from '@arcgis/core/layers/support/Field';
import { marsSR } from './mars';

type Geometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] };
type FeatureCollection = { features: { properties: Record<string, unknown> | null; geometry: Geometry | null }[] };

type MarsGeoJSONOptions = {
  url: string;
  geometryType: 'point' | 'polyline';
  /** Attribute fields to keep, with their types (empty for geometry only). Other properties are dropped. */
  fields: { name: string; type: 'integer' | 'double' | 'string'; alias?: string }[];
} & Omit<FeatureLayerProperties, 'source' | 'fields' | 'geometryType' | 'spatialReference' | 'url'>;

/** A FeatureLayer that loads a GeoJSON file in Mars lon/lat when it is first displayed. */
export function marsGeoJSONLayer({ url, geometryType, fields, ...props }: MarsGeoJSONOptions): FeatureLayer {
  const layer = new FeatureLayer({
    ...props,
    source: [],
    geometryType,
    spatialReference: marsSR(),
    objectIdField: 'oid',
    fields: [{ name: 'oid', type: 'oid' }, ...fields] as unknown as Field[],
  });
  let loaded = false;
  // Load on first display; layers that start hidden cost nothing.
  reactiveUtils.when(() => layer.visible, () => void load().catch((err) => console.error(err)), { initial: true });

  async function load() {
    if (loaded) return;
    loaded = true;
    const res = await fetch(url);
    if (!res.ok) {
      loaded = false; // allow a retry on the next toggle
      throw new Error(`Could not load ${url} (${res.status})`);
    }
    const fc: FeatureCollection = await res.json();
    const sr = marsSR();
    const graphics: Graphic[] = [];
    fc.features.forEach((f, i) => {
      const g = f.geometry;
      if (!g) return;
      const attributes: Record<string, unknown> = { oid: i + 1 };
      for (const { name } of fields) attributes[name] = f.properties?.[name] ?? null;
      const geometry =
        g.type === 'Point'
          ? new Point({ x: g.coordinates[0], y: g.coordinates[1], spatialReference: sr })
          : new Polyline({
              paths: g.type === 'LineString' ? [g.coordinates.map((c) => [c[0], c[1]])] : g.coordinates.map((p) => p.map((c) => [c[0], c[1]])),
              spatialReference: sr,
            });
      graphics.push(new Graphic({ geometry, attributes }));
    });
    await layer.applyEdits({ addFeatures: graphics });
  }
  return layer;
}
