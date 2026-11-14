// The layer catalog: every data layer in the app, with its source.
// To add a layer, add an entry to LAYERS. Each entry builds one ArcGIS layer in GCS Mars 2000 (wkid 104971).
import type Layer from '@arcgis/core/layers/Layer';
import ElevationLayer from '@arcgis/core/layers/ElevationLayer';
import ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import TileLayer from '@arcgis/core/layers/TileLayer';
import * as rasterFunctionUtils from '@arcgis/core/layers/support/rasterFunctionUtils';
import RasterColormapRenderer from '@arcgis/core/renderers/RasterColormapRenderer';
import RasterShadedReliefRenderer from '@arcgis/core/renderers/RasterShadedReliefRenderer';
import SimpleRenderer from '@arcgis/core/renderers/SimpleRenderer';
import MultipartColorRamp from '@arcgis/core/rest/support/MultipartColorRamp';
import { marsGeoJSONLayer } from './geojson';
import { METERS_PER_DEGREE, publicUrl } from './mars';
import { createModelTextureLayer } from './ModelTextureLayer';
import { createUpsampledTileLayer } from './UpsampledTileLayer';

export type LayerGroup = 'Base map' | 'Jezero terrain (20 m)' | 'Perseverance';

export type LegendItem = { color: string; label: string };

export type LayerDef = {
  id: string;
  title: string;
  group: LayerGroup;
  /** Base maps are exclusive: turning one on turns the others off. */
  basemap?: boolean;
  visible: boolean;
  opacity?: number;
  description: string;
  resolution: string;
  source: { name: string; url: string };
  /** Shown under the layer when it is on. */
  legend?: LegendItem[];
  /** "data" = a measurement; "derived" = computed from one; "artistic" = for looks only. */
  kind: 'data' | 'derived' | 'artistic';
  create: () => Layer;
};

const ASTRO = 'https://astro.arcgis.com/arcgis/rest/services/OnMars';

/**
 * Walking-slope classes. ASSUMPTION, not a NASA standard: placeholders until the team picks
 * EVA limits. Slopes are from the 20 m DTM, so steps and boulders smaller than 20 m don't show.
 */
export const SLOPE_CLASSES = [
  // `painted: false` leaves the class transparent on the map so the imagery shows through.
  { max: 15, label: 'Walkable (< 15°)', color: [76, 175, 80], painted: false },
  { max: 25, label: 'Caution (15–25°)', color: [255, 193, 7], painted: true },
  { max: 90, label: 'No-go (≥ 25°)', color: [229, 57, 53], painted: true },
] as const;

const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;

/** Elevation colors for the Jezero DTM, low to high (meters). */
const ELEVATION_RAMP: { at: number; color: number[] }[] = [
  { at: -2711, color: [43, 24, 92] },
  { at: -2400, color: [44, 104, 160] },
  { at: -2100, color: [74, 168, 120] },
  { at: -1800, color: [230, 196, 92] },
  { at: -1516, color: [250, 245, 225] },
];

export const LAYERS: LayerDef[] = [
  {
    id: 'mdim',
    title: 'Viking color mosaic (MDIM 2.1)',
    group: 'Base map',
    basemap: true,
    visible: true,
    kind: 'data',
    resolution: '232 m/px',
    description: 'Global color mosaic from the Viking orbiters, colorized by NASA Ames.',
    source: { name: 'USGS / NASA Ames, hosted by Esri', url: `${ASTRO}/MDIM/MapServer` },
    // The service advertises 18 levels but only has tiles to level 7; beyond that, ArcGIS upsamples.
    // The service advertises 18 levels but only has tiles to level 7.
    create: () => createUpsampledTileLayer(`${ASTRO}/MDIM/MapServer`, 7),
  },
  {
    id: 'model-texture',
    title: 'SOLMAP model texture',
    group: 'Base map',
    basemap: true,
    visible: false,
    kind: 'artistic',
    resolution: '~2.6 km/px (8192 × 4096)',
    description: 'The color texture of public/models/mars-8k.glb. For looks, not for analysis.',
    source: {
      name: '"Mars the Red Planet" by DURVESH123, CC BY',
      url: 'https://sketchfab.com/3d-models/mars-the-red-planet-free-7cf3b31ca60f45cc8e52f7fa863ad09a',
    },
    create: () => createModelTextureLayer(publicUrl('models/mars-8k.glb')),
  },
  {
    id: 'ctx-mosaic',
    title: 'CTX image mosaic',
    group: 'Base map',
    visible: true,
    kind: 'data',
    resolution: '~5 m/px',
    description: 'Global grayscale mosaic of MRO Context Camera images (uncontrolled: features can be offset by tens of meters).',
    source: { name: 'Murray Lab, Caltech (MRO CTX), hosted by Esri', url: `${ASTRO}/CTX1/MapServer` },
    create: () => new TileLayer({ url: `${ASTRO}/CTX1/MapServer` }),
  },
  {
    id: 'jezero-elevation',
    title: 'Elevation',
    group: 'Jezero terrain (20 m)',
    visible: true,
    opacity: 0.7,
    kind: 'data',
    resolution: '20 m/px',
    description: 'Elevation of the Perseverance landing area, shaded. Meters relative to the MOLA areoid.',
    source: {
      name: 'USGS Astrogeology, Mars 2020 TRN CTX DTM (Fergason et al. 2020)',
      url: 'https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/',
    },
    legend: ELEVATION_RAMP.filter((_, i, a) => i === 0 || i === a.length - 1).map((s) => ({ color: rgb(s.color), label: `${s.at} m` })),
    create: () =>
      new ImageryTileLayer({
        url: publicUrl('data/jezero/ctx_dtm_20m.tif'),
        renderer: new RasterShadedReliefRenderer({
          hillshadeType: 'multi-directional',
          altitude: 45,
          azimuth: 315,
          // The grid is in degrees and heights in meters.
          zFactor: 1 / METERS_PER_DEGREE,
          scalingType: 'none',
          colorRamp: MultipartColorRamp.fromJSON({
            type: 'multipart',
            colorRamps: ELEVATION_RAMP.slice(1).map((s, i) => ({
              type: 'algorithmic',
              algorithm: 'esriCIELabAlgorithm',
              fromColor: [...ELEVATION_RAMP[i].color, 255],
              toColor: [...s.color, 255],
            })),
          }),
        }),
      }),
  },
  {
    id: 'jezero-slope',
    title: 'Slope hazard',
    group: 'Jezero terrain (20 m)',
    visible: false,
    opacity: 0.65,
    kind: 'derived',
    resolution: '20 m/px',
    description: 'Ground slope computed from the 20 m DTM (Horn method), in walking classes. Class limits are assumptions (src/map/layers.ts).',
    source: { name: 'Derived from the USGS CTX DTM by scripts/build_jezero_layers.py', url: 'https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/' },
    legend: SLOPE_CLASSES.map((c) => ({ color: c.painted ? rgb(c.color) : 'transparent', label: c.painted ? c.label : `${c.label}: not colored` })),
    create: () => {
      // Class i covers [previous max, max). Unmatched (unpainted) slopes become NoData, i.e. transparent.
      const classes = SLOPE_CLASSES.map((c, i) => ({ ...c, min: i === 0 ? 0 : SLOPE_CLASSES[i - 1].max, value: i + 1 }));
      const painted = classes.filter((c) => c.painted);
      return new ImageryTileLayer({
        url: publicUrl('data/jezero/ctx_slope_20m.tif'),
        rasterFunction: rasterFunctionUtils.remap({
          rangeMaps: painted.map((c) => ({ range: [c.min, c.max === 90 ? 91 : c.max], output: c.value })),
          allowUnmatched: false,
        }),
        renderer: new RasterColormapRenderer({
          colormapInfos: painted.map((c) => ({ value: c.value, color: [...c.color], label: c.label })),
        }),
      });
    },
  },
  {
    id: 'm20-traverse',
    title: 'Rover traverse',
    group: 'Perseverance',
    visible: true,
    kind: 'data',
    resolution: 'drive by drive, to sol 2022',
    description: 'The path Perseverance drove from landing (February 2021).',
    source: { name: 'NASA/JPL-Caltech Mars 2020 (MMGIS)', url: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json' },
    legend: [{ color: '#ffffff', label: 'Drive path' }],
    create: () =>
      marsGeoJSONLayer({
        url: publicUrl('data/jezero/m20_traverse.geojson'),
        geometryType: 'polyline',
        fields: [
          { name: 'sol', type: 'integer' },
          { name: 'length_m', type: 'double' },
        ],
        elevationInfo: { mode: 'on-the-ground' },
        renderer: new SimpleRenderer({ symbol: { type: 'simple-line', color: [255, 255, 255, 0.95], width: 2 } }),
      }),
  },
  {
    id: 'm20-waypoints',
    title: 'Rover stops',
    group: 'Perseverance',
    visible: false,
    kind: 'data',
    resolution: '708 end-of-drive positions',
    description: 'Where Perseverance stopped after each drive, with its elevation and distance driven so far.',
    source: { name: 'NASA/JPL-Caltech Mars 2020 (MMGIS)', url: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json' },
    legend: [{ color: '#ffd166', label: 'Stop' }],
    create: () =>
      marsGeoJSONLayer({
        url: publicUrl('data/jezero/m20_waypoints.geojson'),
        geometryType: 'point',
        fields: [
          { name: 'sol', type: 'integer' },
          { name: 'site', type: 'integer' },
          { name: 'drive', type: 'integer' },
          { name: 'elev_m', type: 'double' },
          { name: 'dist_total_m', type: 'double' },
        ],
        elevationInfo: { mode: 'on-the-ground' },
        renderer: new SimpleRenderer({
          symbol: { type: 'simple-marker', size: 5, color: [255, 209, 102], outline: { color: [30, 20, 10], width: 0.5 } },
        }),
      }),
  },
];

/**
 * The 3D ground outside Jezero: NASA MGS MOLA elevation (463 m), meters above the MOLA areoid,
 * hosted by Esri (source: USGS, NASA). Refined by the Jezero 20 m DTM; see JezeroElevationLayer.
 */
export const GLOBAL_ELEVATION_URL = `${ASTRO}/MOLA/ImageServer`;
export const globalElevationLayer = () => new ElevationLayer({ url: GLOBAL_ELEVATION_URL });
