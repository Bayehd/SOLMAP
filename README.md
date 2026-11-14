# SOLMAP

Solmap is a layered, interactive map of Mars for planning a human walk on the surface. It brings data from several NASA missions into one view, so an explorer can see where it is safe to walk, where the science is, and which route is best.

 NASA Space Apps Challenge 2026: Interplanetary Survival Guide: Martian Map.

## The problem
Mars data is spread across missions, formats and archives. An explorer planning a Marswalk needs it in one place: terrain, hazards, conditions and science targets, all on the same map.

## What Solmap does
- **Route planner:** pick a start and destination and get the least-effort route, compared with the most direct one.
- **Slope hazard layer:** terrain is coloured by steepness (caution and no-go zones), computed from NASA terrain models.
- **Route stats:** walking distance, total climb, average and steepest slope, plus an elevation profile.
- **Science targets:** pins for places worth visiting, such as Perseverance sample sites, each with the reason it matters.
- **Data and methods page:** every layer shows its NASA source, and every assumption is labelled.
- **Site comparison:** Jezero Crater is the full case study; other sites are compared where NASA data allows.

## The data map (`index.html`)

An ArcGIS Maps SDK for JavaScript map of Mars with real data layers, shown as a
**3D globe** or a **2D map** (same layers in both). Everything is in GCS Mars 2000
(ArcGIS wkid 104971). Click the map to read the elevation and slope at that point.

```sh
npm install
npm run dev     # http://localhost:5173 (data map), http://localhost:5173/classic.html (classic view)
```

| Layer | Source | Resolution | Kind |
|---|---|---|---|
| Viking color mosaic (MDIM 2.1) | USGS / NASA Ames, hosted by Esri | 232 m/px | data |
| CTX image mosaic | Murray Lab, Caltech (MRO CTX), hosted by Esri | ~5 m/px | data |
| SOLMAP model texture | `public/models/mars-8k.glb` | ~2.6 km/px | artistic |
| 3D ground | Esri MOLA + HRSC global DEM, with the Jezero DTM in its place | 200 m / 20 m | data |
| Jezero elevation | USGS Mars 2020 TRN CTX DTM (Fergason et al. 2020) | 20 m/px | data |
| Jezero slope hazard | Derived from that DTM (Horn method) | 20 m/px | derived |
| Perseverance traverse and stops | NASA/JPL Mars 2020 MMGIS, to sol 2022 | per drive | data |

**Assumption:** the slope classes (walkable < 15°, caution 15–25°, no-go ≥ 25°) are
placeholders, not a NASA standard. Change them in `SLOPE_CLASSES` in `src/map/layers.ts`.
A 20 m grid also hides steps and boulders smaller than 20 m.

### Code

- `src/map/layers.ts`: the layer catalog. **To add a layer, add an entry to `LAYERS`**
  with its title, group, source and a `create()` that returns an ArcGIS layer.
- `src/map/geojson.ts`: `marsGeoJSONLayer()` for GeoJSON in Mars lon/lat. Use it instead of
  ArcGIS's `GeoJSONLayer`, which assumes Earth (WGS84) coordinates.
- `src/map/JezeroElevationLayer.ts`: the 3D ground (global DEM + Jezero 20 m DTM, feathered
  over ~600 m at the DTM's edge).
- `src/map/UpsampledTileLayer.ts`, `src/map/ModelTextureLayer.ts`: custom tile layers.
- `src/map/mars.ts`: the Mars coordinate system, tiling scheme and known extents.
- In development, `window.solmap` holds the map, view and layers for the browser console.

### Rebuilding the Jezero data

`public/data/jezero/` is built by `scripts/build_jezero_layers.py` (Python 3, rasterio):

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/build_jezero_layers.py
```

It downloads the USGS DTM and the NASA rover GeoJSON (cached in `scripts/.cache/`) and writes:
- `ctx_dtm_20m.tif`, `ctx_slope_20m.tif`: Float32 GeoTIFFs in GCS Mars 2000, 512 px tiles with
  overviews, LERC-compressed with at most 1 cm (or 0.01°) error. The DTM's equirectangular
  projection (standard parallel 0°) converts to lon/lat by an exact rescale, so no value is
  resampled. The CRS is stored as an Esri WKT, the only non-EPSG form ArcGIS reads.
- `m20_traverse.geojson`, `m20_waypoints.geojson`: the rover data, trimmed to the fields used.

It checks the DTM against the published elevation of the Perseverance landing site
(−2569.9 m; the DTM gives −2567.2 m) and stops if they differ by more than 15 m.

## The classic 3D model view (`classic.html`)

The original Three.js / React Three Fiber Mars globe.
Click a site marker to fly there.
Each site has two views:

- **Top view**: straight down, north up. Drag to pan, scroll to zoom. Click to
  drive the Perseverance rover there; it leaves a track. It starts at the real
  landing site in Jezero (`roverStart` in `sites.ts`) and is drawn at a fixed
  screen size, not to scale. Hidden in the Front view.
- **Front view**: a square slice of terrain cut out at the site, drawn as an
  exploded block, one slab per layer with gaps between them, seen corner-on from
  low over the surface. Drag to turn around it, scroll to zoom. The layers icon
  toggles slabs; layers stack in the order of `INITIAL_LAYERS`
  (`src/mars/LayersPanel.tsx`). Current layers: **Surface height** (MOLA relief,
  fixed 10× vertical exaggeration), **Temperature (simulated)**, which is
  placeholder data, not a measurement, and **Slope** (derived from MOLA).

Color texture (`public/models/mars-8k.glb`, 8192 × 4096, re-encoded at JPEG quality 85): "Mars the Red Planet" by DURVESH123, CC Attribution, Sketchfab
(https://sketchfab.com/3d-models/mars-the-red-planet-free-7cf3b31ca60f45cc8e52f7fa863ad09a).
Elevation: MOLA (NASA), exaggerated for display.
Rover: "Perseverance Rover NASA 2020" by Jaydeep.Padwal, CC Attribution, Sketchfab
(https://sketchfab.com/3d-models/perseverance-rover-nasa-2020-9437aed282c7443b80a5ca6f961792d0).

### Adding a site

1. **Add the site** to `SITES` in `src/mars/sites.ts`:

   ```ts
   {
     id: 'valles-marineris',        // also the MOLA file name
     name: 'Valles Marineris',
     lat: -13.9,                    // planetocentric degrees
     lon: 300.8,                    // east longitude (-59.2 works too)
     altitude: 0.1,                 // camera distance from the site on arrival, in Mars radii
     patchSizeKm: 300,              // MOLA area around the site (Top view pan limit)
     sliceKm: 120,                  // width of the Front view block
     description: 'A canyon system about 4,000 km long and up to 7 km deep.',
   }
   ```

   A marker appears on the globe right away. To frame the whole patch on
   Top view, set `altitude` to about `patchSizeKm / 2800`.

2. **Build its MOLA grid** with the pipeline (Python 3, no extra packages):

   ```sh
   python3 scripts/build_mola_sites.py valles-marineris   # or no ids: rebuild all sites
   ```

   It reads the site from `src/mars/sites.ts`, downloads only the rows it needs
   from the MOLA MEGDR 128 px/degree (~463 m) topography tiles on the NASA PDS
   Geosciences Node, and writes:
   - `public/data/sites/{id}.bin`: Float32 little-endian, row-major, north row
     first, meters above the MOLA datum, no header. The window extends 25% past
     the patch edge so bilinear sampling never runs off it.
   - an entry in `public/data/manifest.json` with `width`, `height`,
     `minLat/maxLat/minLon/maxLon` (centers of the edge samples, east
     longitude), `minElevation`, `maxElevation`, `metersPerValue` (1) and `source`.

   Offline: download the needed `megt*.img` tiles from
   https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/
   and run with `--tiles <folder>`. A window must fit inside one tile
   (tiles are 44° × 90°); the script stops with a message if it doesn't.

   To add a check, put a point with a published elevation (e.g. a landing
   site) in `POINT_CHECKS` in the script.

Until a site has a grid, the site still works, but the Layers panel says the
MOLA data is missing.

### Adding a layer

1. Add `{ id, label, visible }` to `INITIAL_LAYERS` in `src/mars/LayersPanel.tsx`
   (its position sets where it sits in the stack).
2. Add a slab builder with the same id to `SLABS` in `src/mars/layerBlock.ts`.
   It gets the slice's MOLA elevation and slope on a 128 × 128 grid and returns
   a mesh, its height and a one-line detail for the label.

### Tuning

- Colors: `HEIGHT_RAMP` and `SLOPE_RAMP` in `src/mars/layerBlock.ts`.
- Vertical exaggeration: `VERTICAL_EXAGGERATION` in `src/mars/layerBlock.ts`.
- Slab thickness, gaps and lift: the constants at the top of `src/mars/layerBlock.ts`.
- Front view angle: `FRONT_TILT` in `src/mars/flyTo.ts` (90° = level with the ground).
- If the markers don't line up with features on a different texture, change
  `TEXTURE_LON_OFFSET_DEG` in `src/mars/geo.ts`.

## Team
Pari, Annalaya, Anna, Amira, Julia, Benonia
