// The layer catalog: every data layer of a landing site, with its source.
// layersFor(site) lists the base maps (the same everywhere) and the site's own layers, only those it has data for.
// Each entry builds one ArcGIS layer in GCS Mars 2000 (wkid 104971). Ids are the same at every site
// ('elevation', 'traverse', ...), so the map, the Side stack and the planner find them by id.
import type Layer from '@arcgis/core/layers/Layer';
import ElevationLayer from '@arcgis/core/layers/ElevationLayer';
import ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import * as rasterFunctionUtils from '@arcgis/core/layers/support/rasterFunctionUtils';
import RasterColormapRenderer from '@arcgis/core/renderers/RasterColormapRenderer';
import RasterShadedReliefRenderer from '@arcgis/core/renderers/RasterShadedReliefRenderer';
import SimpleRenderer from '@arcgis/core/renderers/SimpleRenderer';
import UniqueValueRenderer from '@arcgis/core/renderers/UniqueValueRenderer';
import MultipartColorRamp from '@arcgis/core/rest/support/MultipartColorRamp';
import { marsGeoJSONLayer } from './geojson';
import { METERS_PER_DEGREE, publicUrl } from './mars';
import { ELEVATION_COLORS, type Site } from './sites';
import { createMarsColorCtxLayer } from './MarsColorCtxLayer';
import { createRegionTextureLayer } from './RegionTextureLayer';
import { createTrekTileLayer } from './TrekTileLayer';
import { SPOT_COLOR } from './mineralSpots';

type LegendItem = { color: string; label: string };
/** A continuous color range, low to high: each stop's color at its value (stops are placed by value). */
export type LegendRamp = { at: number; color: string; label: string }[];

export type LayerDef = {
  id: string;
  title: string;
  group: string; // 'Base map', '<site> terrain (20 m)', '<site> minerals', the rover's name or 'Radiation'
  /** false: drawn by the app but not offered in the layer list. */
  listed?: boolean;
  visible: boolean;
  opacity?: number;
  description: string;
  resolution: string;
  source: { name: string; url: string };
  /** Shown under the layer when it is on. */
  legend?: LegendItem[];
  /** Colors that run over a range of values (the map legend draws a color bar instead of the legend's squares). */
  ramp?: LegendRamp;
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

/**
 * Mineral classes of public/data/jezero/crism_minerals_20m.tif: pixel value = index + 1.
 * Same order as CLASSES in scripts/build_jezero_minerals.py, which holds the detection rules.
 */
export const MINERAL_CLASSES = [
  { label: 'Mg-carbonate', color: [46, 155, 255] },
  { label: 'Fe/Mg clay (smectite)', color: [224, 64, 160] },
  { label: 'Hydrated silica', color: [242, 233, 78] },
  { label: 'Olivine', color: [76, 211, 76] },
  { label: 'Pyroxene', color: [255, 140, 26] },
] as const;

const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;

/** Elevation colors for a site's DTM, low to high (meters). */
export const elevationRamp = (site: Site): { at: number; color: number[] }[] =>
  site.elevationStops.map((at, i) => ({ at, color: ELEVATION_COLORS[i] }));

/** Perseverance sample types, as `kind` in m20_samples.geojson (scripts/build_jezero_layers.py). */
export const SAMPLE_KINDS = [
  { label: 'Rock core', color: [0, 229, 255] },
  { label: 'Regolith', color: [255, 140, 66] },
  { label: 'Atmospheric', color: [235, 235, 235] },
] as const;

/** Base map: global, the same at every site. */
const BASE_MAPS: LayerDef[] = [
  {
    id: 'ctx-mosaic',
    title: 'Satellite photos',
    group: 'Base map',
    listed: false, // always shown under the data layers, not a choice in the list
    visible: true,
    kind: 'data',
    resolution: '~5 m/px',
    description:
      'Global mosaic of MRO Context Camera images (uncontrolled: features can be offset by tens of meters). CTX is grayscale: ' +
      'its brightness is shown in a Mars surface color (src/map/MarsColorCtxLayer.ts).',
    source: { name: 'Murray Lab, Caltech (NASA MRO CTX), hosted by Esri', url: 'https://murray-lab.caltech.edu/CTX/' },
    create: () => createMarsColorCtxLayer(`${ASTRO}/CTX1/MapServer`),
  },
];

/** THEMIS thermal infrared mosaics: global (to ±65° latitude), from NASA Mars Trek. */
const THEMIS_PAGE = 'https://trek.nasa.gov/mars/jpl/config/textRelease.html';
const THERMAL: LayerDef[] = [
  {
    id: 'themis-day',
    title: 'Daytime heat (THEMIS)',
    group: 'Surface temperature',
    visible: false,
    kind: 'data',
    resolution: '100 m/px',
    description:
      'Mars Odyssey THEMIS infrared images taken in the afternoon, mosaicked (controlled mosaic v2, 2018). Brighter = warmer: ' +
      'sunlit slopes and dark ground heat up most. Relative warmth, not temperature values.',
    source: { name: 'NASA Mars Odyssey THEMIS (ASU), via NASA Mars Trek', url: THEMIS_PAGE },
    legend: [
      { color: '#202020', label: 'Cooler' },
      { color: '#f0f0f0', label: 'Warmer' },
    ],
    ramp: [
      { at: 0, color: '#202020', label: 'Cooler' },
      { at: 1, color: '#f0f0f0', label: 'Warmer' },
    ],
    // Trek has tiles to level 9 (~80 m per pixel); closer tiles are cut from those.
    create: () => createTrekTileLayer('THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018', 9),
  },
  {
    id: 'themis-night',
    title: 'Nighttime heat (THEMIS)',
    group: 'Surface temperature',
    visible: false,
    kind: 'data',
    resolution: '100 m/px',
    description:
      'Mars Odyssey THEMIS infrared images taken before dawn, mosaicked (controlled mosaic v2, 2018). Brighter = warmer at night: ' +
      'rock and coarse ground keep the day\'s heat, fine dust and sand cool fast. Relative warmth, not temperature values.',
    source: { name: 'NASA Mars Odyssey THEMIS (ASU), via NASA Mars Trek', url: THEMIS_PAGE },
    legend: [
      { color: '#202020', label: 'Cools fast (dust, sand)' },
      { color: '#f0f0f0', label: 'Stays warm (rock)' },
    ],
    ramp: [
      { at: 0, color: '#202020', label: 'Cools fast (dust, sand)' },
      { at: 1, color: '#f0f0f0', label: 'Stays warm (rock)' },
    ],
    create: () => createTrekTileLayer('THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018', 9),
  },
];

/** Curiosity RAD dose rate color stops, microGray per day (absorbed dose in silicon). */
export const RAD_STOPS = [
  { value: 165, color: [255, 236, 160] },
  { value: 225, color: [245, 140, 50] },
  { value: 285, color: [190, 30, 70] },
];

/** Order of the layer list, most useful first: the safety and the rover's work, then minerals, then heat. Unlisted ids go last. */
const LIST_ORDER = ['slope', 'elevation', 'traverse', 'samples', 'depot', 'mineral-spots', 'minerals', 'radiation', 'themis-night', 'themis-day'];
export const listRank = (id: string) => {
  const i = LIST_ORDER.indexOf(id);
  return i < 0 ? LIST_ORDER.length : i;
};

/** Every layer of a site: the base maps, then the site's terrain, minerals and rover layers (where it has data). */
export function layersFor(site: Site): LayerDef[] {
  const terrain = `${site.short} terrain (20 m)`;
  const f = site.files;
  const ramp = elevationRamp(site);
  const rover = site.rover;
  const list: (LayerDef | false)[] = [
    ...BASE_MAPS,
    ...THERMAL,
    !!site.texture && {
      id: 'crater-texture',
      title: site.texture.title,
      group: terrain,
      listed: false,
      visible: true,
      kind: 'artistic',
      resolution: '~84 m/px, with CTX detail (~5 m/px) close up',
      description:
        `An artist's color texture of the ${site.name} area from a 3D model, placed on the 20 m terrain. For looks, not analysis. ` +
        'From close up, CTX image detail is multiplied in (src/map/RegionTextureLayer.ts).',
      source: { name: site.texture.credit.text, url: site.texture.credit.url },
      create: () => createRegionTextureLayer(publicUrl(site.texture!.file), site.texture!.box, site.extent, `${ASTRO}/CTX1/MapServer`),
    },
    {
      id: 'elevation',
      title: 'Height',
      group: terrain,
      visible: !site.texture, // where the site has a model texture, that is shown instead (the elevation colors would cover it)
      opacity: 0.7,
      kind: 'data',
      resolution: '20 m/px',
      description: `Elevation of the ${rover} landing area, shaded. Meters relative to the MOLA areoid.`,
      source: site.dtmSource,
      legend: ramp.filter((_, i, a) => i === 0 || i === a.length - 1).map((s) => ({ color: rgb(s.color), label: `${s.at} m` })),
      ramp: ramp.map((s) => ({ at: s.at, color: rgb(s.color), label: `${s.at.toLocaleString('en-US')} m` })),
      create: () =>
        new ImageryTileLayer({
          url: publicUrl(f.dtm),
          renderer: new RasterShadedReliefRenderer({
            hillshadeType: 'multi-directional',
            altitude: 45,
            azimuth: 315,
            // The grid is in degrees and heights in meters.
            zFactor: 1 / METERS_PER_DEGREE,
            scalingType: 'none',
            colorRamp: MultipartColorRamp.fromJSON({
              type: 'multipart',
              colorRamps: ramp.slice(1).map((s, i) => ({
                type: 'algorithmic',
                algorithm: 'esriCIELabAlgorithm',
                fromColor: [...ramp[i].color, 255],
                toColor: [...s.color, 255],
              })),
            }),
          }),
        }),
    },
    {
      id: 'slope',
      title: 'Hazards',
      group: terrain,
      visible: false,
      opacity: 0.65,
      kind: 'derived',
      resolution: '20 m/px',
      description: 'Ground slope computed from the 20 m DTM (Horn method), in walking classes. Class limits are assumptions (src/map/layers.ts).',
      source: { name: `Derived from the ${site.short} DTM by scripts/build_${site.id}_layers.py`, url: site.dtmSource.url },
      legend: SLOPE_CLASSES.filter((c) => c.painted).map((c) => ({ color: rgb(c.color), label: c.label })),
      create: () => {
        // Class i covers [previous max, max). Unmatched (unpainted) slopes become NoData, i.e. transparent.
        const classes = SLOPE_CLASSES.map((c, i) => ({ ...c, min: i === 0 ? 0 : SLOPE_CLASSES[i - 1].max, value: i + 1 }));
        const painted = classes.filter((c) => c.painted);
        return new ImageryTileLayer({
          url: publicUrl(f.slope),
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
    !!f.minerals && {
      id: 'minerals',
      title: 'Minerals',
      group: `${site.short} minerals`,
      visible: false,
      opacity: 0.85,
      kind: 'derived',
      resolution: '18 m/px, smoothed to ~90 m',
      description:
        'Minerals detected from orbit by CRISM, the MRO spectrometer: 4 observations (2007) covering about half of the 20 m area. ' +
        'Uncolored: nothing detected, or no CRISM coverage. Indicative only: detection thresholds are assumptions (scripts/build_jezero_minerals.py).',
      source: {
        name: 'NASA MRO CRISM MTRDR summary parameters (PDS Geosciences Node)',
        url: 'https://pds-geosciences.wustl.edu/missions/mro/crism.htm',
      },
      legend: MINERAL_CLASSES.map((c) => ({ color: rgb(c.color), label: c.label })),
      create: () =>
        new ImageryTileLayer({
          url: publicUrl(f.minerals!),
          renderer: new RasterColormapRenderer({
            colormapInfos: MINERAL_CLASSES.map((c, i) => ({ value: i + 1, color: [...c.color], label: c.label })),
          }),
        }),
    },
    !!f.mineralSpots && {
      id: 'mineral-spots',
      title: 'Mineral spots',
      group: `${site.short} minerals`,
      visible: true,
      kind: 'derived',
      resolution: 'patches of 0.01 km² or more, within 1.5 km of the route',
      description:
        'The main patches of each mineral in the CRISM mineral map near the rover\'s route, a few per mineral. ' +
        'Indicative, like the mineral map (scripts/build_jezero_mineral_spots.py).',
      source: { name: 'Derived from the CRISM mineral map', url: 'https://pds-geosciences.wustl.edu/missions/mro/crism.htm' },
      legend: [{ color: rgb(SPOT_COLOR), label: 'Mineral spot' }],
      create: () =>
        marsGeoJSONLayer({
          url: publicUrl(f.mineralSpots!),
          geometryType: 'point',
          fields: [
            { name: 'mineral', type: 'string' },
            { name: 'class', type: 'integer' },
            { name: 'area_km2', type: 'double' },
            { name: 'route_dist_m', type: 'integer' },
          ],
          outFields: ['*'],
          elevationInfo: { mode: 'on-the-ground' },
          renderer: new SimpleRenderer({
            symbol: { type: 'simple-marker', style: 'circle', size: 6, color: [...SPOT_COLOR], outline: { color: 'white', width: 0.75 } },
          }),
        }),
    },
    {
      id: 'traverse',
      title: 'Rover path',
      group: rover,
      visible: true,
      kind: 'data',
      resolution: site.roverSource.until,
      description: `The path ${rover} drove from landing.`,
      source: { name: `NASA/JPL-Caltech ${rover} (MMGIS)`, url: site.roverSource.page },
      legend: [{ color: '#ffffff', label: 'Drive path' }],
      create: () =>
        marsGeoJSONLayer({
          url: publicUrl(f.traverse),
          geometryType: 'polyline',
          fields: [],
          elevationInfo: { mode: 'on-the-ground' },
          renderer: new SimpleRenderer({ symbol: { type: 'simple-line', color: [255, 255, 255, 0.95], width: 2 } }),
        }),
    },
    !!f.samples && {
      id: 'samples',
      title: 'Rock samples',
      group: rover,
      visible: true,
      kind: 'data',
      resolution: '28 sealed samples, to sol 1441',
      description: 'Where Perseverance sealed each of its samples, placed at the rover position on that sol.',
      source: { name: 'NASA Mars 2020 rock sample list + MMGIS rover positions', url: 'https://science.nasa.gov/mission/mars-2020-perseverance/mars-rock-samples/' },
      legend: SAMPLE_KINDS.map((k) => ({ color: `rgb(${k.color.join(',')})`, label: k.label })),
      create: () =>
        marsGeoJSONLayer({
          url: publicUrl(f.samples!),
          geometryType: 'point',
          fields: [
            { name: 'number', type: 'integer' },
            { name: 'name', type: 'string' },
            { name: 'kind', type: 'string' },
            { name: 'sol', type: 'integer' },
          ],
          outFields: ['*'],
          elevationInfo: { mode: 'on-the-ground' },
          renderer: new UniqueValueRenderer({
            field: 'kind',
            uniqueValueInfos: SAMPLE_KINDS.map((k) => ({
              value: k.label,
              label: k.label,
              symbol: { type: 'simple-marker', size: 6, color: [...k.color], outline: { color: [20, 20, 20], width: 0.75 } },
            })),
          }),
        }),
    },
    !!f.depot && {
      id: 'depot',
      title: 'Sample depot',
      group: rover,
      visible: true,
      kind: 'data',
      resolution: '10 tubes, dropped sols 653–690',
      description:
        'The 10 sample tubes Perseverance left on the ground for a future return mission, at the rover position of each drop.',
      source: {
        name: 'NASA PDS Geosciences Node, Mars 2020 Three Forks depot',
        url: 'https://pds-geosciences.wustl.edu/missions/mars2020/three_forks_depot.htm',
      },
      legend: [{ color: 'rgb(255,61,200)', label: 'Depot tube' }],
      create: () =>
        marsGeoJSONLayer({
          url: publicUrl(f.depot!),
          geometryType: 'point',
          fields: [
            { name: 'name', type: 'string' },
            { name: 'sol', type: 'integer' },
          ],
          outFields: ['*'],
          elevationInfo: { mode: 'on-the-ground' },
          renderer: new SimpleRenderer({
            symbol: { type: 'simple-marker', style: 'diamond', size: 7, color: [255, 61, 200], outline: { color: [20, 20, 20], width: 0.75 } },
          }),
        }),
    },
    !!f.radiation && {
      id: 'radiation',
      title: 'Radiation',
      group: 'Radiation',
      visible: false,
      kind: 'data',
      resolution: '1,317 rover stops, sols 3–4843 (2012–2026)',
      description:
        `Radiation dose ${rover} measured at the surface at each place it stopped: the daily absorbed dose in silicon, averaged over the sols spent there. It rises and falls with the 11-year solar cycle (the Sun's activity shields Mars from galactic cosmic rays).`,
      source: { name: 'NASA PDS PPI Node, MSL RAD RDR + MSL MMGIS rover positions', url: 'https://pds.nasa.gov/ds-view/pds/viewDataset.jsp?dsid=MSL-M-RAD-3-RDR-V1.0' },
      legend: RAD_STOPS.map((s) => ({ color: `rgb(${s.color.join(',')})`, label: `${s.value} µGy/day` })),
      ramp: RAD_STOPS.map((s) => ({ at: s.value, color: rgb(s.color), label: `${s.value} µGy/day` })),
      create: () =>
        marsGeoJSONLayer({
          url: publicUrl(f.radiation!),
          geometryType: 'point',
          fields: [
            { name: 'sol_start', type: 'integer' },
            { name: 'sol_end', type: 'integer' },
            { name: 'sols_measured', type: 'integer' },
            { name: 'dose_si', type: 'double' },
            { name: 'dose_plastic', type: 'double' },
            { name: 'elevation_m', type: 'double' },
          ],
          outFields: ['*'],
          elevationInfo: { mode: 'on-the-ground' },
          renderer: new SimpleRenderer({
            symbol: { type: 'simple-marker', size: 7, color: [255, 255, 255], outline: { color: [20, 20, 20], width: 0.5 } },
            visualVariables: [{ type: 'color', field: 'dose_si', stops: RAD_STOPS.map((s) => ({ value: s.value, color: [...s.color] })) }],
          }),
        }),
    },
  ];
  return list.filter((l): l is LayerDef => !!l);
}


/**
 * The 3D ground outside the site: NASA MGS MOLA elevation (463 m), meters above the MOLA areoid,
 * hosted by Esri (source: USGS, NASA). Refined by the site's 20 m DTM; see SiteElevationLayer.
 */
const GLOBAL_ELEVATION_URL = `${ASTRO}/MOLA/ImageServer`;
export const globalElevationLayer = () => new ElevationLayer({ url: GLOBAL_ELEVATION_URL });
