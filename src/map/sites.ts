// The landing areas the app can open: where each one is, its data files, and what it has data for.
// Each site has its own 20 m terrain model; the map, the rover drive, the Side stack and the route planner
// all read the site they were opened with.
import Extent from '@arcgis/core/geometry/Extent';
import { marsSR } from './mars';

export type SiteId = 'jezero' | 'gale';
type Box = { xmin: number; ymin: number; xmax: number; ymax: number };

export type Site = {
  id: SiteId;
  name: string; // "Jezero Crater"
  short: string; // "Jezero", for group titles and messages
  rover: string; // the rover that explored it
  /** Area of the site's 20 m terrain model (degrees). */
  extent: Box;
  /** The first point of the rover traverse, where the rover lands. */
  landing: { lon: number; lat: number };
  /** Ground height at the landing point (m), until the terrain query answers. */
  landingElevationM: number;
  /** Files in public/. Minerals, samples and depot only where there is data for them. */
  files: {
    dtm: string;
    slope: string;
    minerals?: string;
    traverse: string;
    samples?: string;
    sampleBoard?: string; // what each sample's info board shows, filled in by hand
    depot?: string;
    environment?: string; // measured radiation (RAD) and weather (REMS), see scripts/build_gale_layers.py
    radiation?: string; // measured RAD dose at each rover stop, see scripts/build_gale_rad.py
  };
  /** An artist's color texture of the area, placed on the 3D ground (not NASA data). */
  texture?: { file: string; box: Box; title: string; credit: { text: string; url: string } };
  /** Layer ids shown in the Rover view: just the ground, for an immersive ride. */
  immersiveLayers: string[];
  /** Elevation colors, low to high (m). */
  elevationStops: number[];
  dtmSource: { name: string; url: string };
  roverSource: { traverse: string; until: string };
};

/** Same colors for every site, spread over each site's own elevation range. */
export const ELEVATION_COLORS = [
  [43, 24, 92],
  [44, 104, 160],
  [74, 168, 120],
  [230, 196, 92],
  [250, 245, 225],
];

export const SITES: Record<SiteId, Site> = {
  jezero: {
    id: 'jezero',
    name: 'Jezero Crater',
    short: 'Jezero',
    rover: 'Perseverance',
    // From scripts/build_jezero_layers.py.
    extent: { xmin: 77.16047, ymin: 18.21103, xmax: 77.69898, ymax: 18.72119 },
    // Octavia E. Butler Landing, 18 February 2021.
    landing: { lon: 77.4508857, lat: 18.4446271 },
    landingElevationM: -2570,
    files: {
      dtm: 'data/jezero/ctx_dtm_20m.tif',
      slope: 'data/jezero/ctx_slope_20m.tif',
      minerals: 'data/jezero/crism_minerals_20m.tif',
      traverse: 'data/jezero/m20_traverse.geojson',
      samples: 'data/jezero/m20_samples.geojson',
      sampleBoard: 'data/jezero/sample_board.json',
      depot: 'data/jezero/m20_depot.geojson',
    },
    // "Jezero Crater (Mars)" by Gaia, CC BY 4.0: its texture, georeferenced by matching the model's heights to the
    // USGS CTX DTM (RMS 17 m). See public/models/jezero-crater-texture.LICENSE.txt.
    texture: {
      file: 'models/jezero-crater-texture.jpg',
      box: { xmin: 77.0095, ymin: 17.56576, xmax: 78.5345, ymax: 19.30224 },
      title: 'Crater model texture',
      credit: {
        text: '“Jezero Crater (Mars)” by Gaia, CC BY 4.0',
        url: 'https://sketchfab.com/3d-models/jezero-crater-mars-f8501fbe652241b585f7734bee259ad3',
      },
    },
    immersiveLayers: ['mdim', 'ctx-mosaic', 'crater-texture'],
    elevationStops: [-2711, -2400, -2100, -1800, -1516],
    dtmSource: { name: 'USGS Astrogeology, Mars 2020 TRN CTX DTM (Fergason et al. 2020)', url: 'https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/' },
    roverSource: {
      traverse: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json',
      until: 'drive by drive, to sol 2022',
    },
  },
  gale: {
    id: 'gale',
    name: 'Gale Crater',
    short: 'Gale',
    rover: 'Curiosity',
    // From scripts/build_gale_layers.py.
    extent: { xmin: 137.124167, ymin: -5.098652, xmax: 137.680559, ymax: -4.129605 },
    // Bradbury Landing, 6 August 2012.
    landing: { lon: 137.441633, lat: -4.589467 },
    landingElevationM: -4501,
    files: {
      dtm: 'data/gale/gale_dem_20m.tif',
      slope: 'data/gale/gale_slope_20m.tif',
      traverse: 'data/gale/msl_traverse.geojson',
      environment: 'data/gale/msl_environment.json',
      radiation: 'data/gale/msl_rad.geojson',
    },
    immersiveLayers: ['mdim', 'ctx-mosaic'],
    elevationStops: [-4625, -4300, -3900, -3000, -1500],
    dtmSource: {
      name: 'USGS Astrogeology, MSL Gale merged DEM (HiRISE + CTX), averaged to 20 m',
      url: 'https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m',
    },
    roverSource: {
      traverse: 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json',
      until: 'drive by drive, to sol 5073',
    },
  },
};

export const siteExtent = (s: Site) => new Extent({ ...s.extent, spatialReference: marsSR() });

/** The site's terrain extent, re-centred on the landing point: where the intro flight ends. */
export const landingExtent = (s: Site) => {
  const w = Math.min(s.extent.xmax - s.extent.xmin, s.extent.ymax - s.extent.ymin) / 2;
  const { lon, lat } = s.landing;
  return new Extent({ xmin: lon - w, xmax: lon + w, ymin: lat - w, ymax: lat + w, spatialReference: marsSR() });
};

export const insideSite = (s: Site, p: { lon: number; lat: number }) =>
  p.lon >= s.extent.xmin && p.lon <= s.extent.xmax && p.lat >= s.extent.ymin && p.lat <= s.extent.ymax;

/** "18.44° N, 77.45° E" */
export const formatLatLon = (lat: number, lon: number, digits = 2) =>
  `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`;
