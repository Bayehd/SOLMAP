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

## The app

An ArcGIS Maps SDK for JavaScript map of Mars with real data layers, shown as a
**3D globe** or a **2D map** (same layers in both). Everything is in GCS Mars 2000
(ArcGIS wkid 104971). Click the map to read the elevation and slope at that point.

```sh
npm install
npm run dev     # http://localhost:5173
npm run build
```

| Layer | Source | Resolution | Kind |
|---|---|---|---|
| Viking color mosaic (MDIM 2.1) | USGS / NASA Ames, hosted by Esri | 232 m/px | data |
| CTX image mosaic | Murray Lab, Caltech (MRO CTX), hosted by Esri | ~5 m/px | data |
| SOLMAP model texture | `public/models/mars-8k.jpg` (artist texture, not NASA data) | ~2.6 km/px | artistic |
| 3D ground | NASA MGS MOLA global DEM (USGS/NASA, hosted by Esri), with the Jezero DTM in its place | 463 m / 20 m | data |
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
- `m20_traverse.geojson`, `m20_waypoints.geojson`: the rover path and stops, geometry only.

It checks the DTM against the published elevation of the Perseverance landing site
(−2569.9 m; the DTM gives −2567.2 m) and stops if they differ by more than 15 m.

## Credits

Mars color texture (`public/models/mars-8k.jpg`, 8192 × 4096, re-encoded at JPEG quality 85):
"Mars the Red Planet" by DURVESH123, CC Attribution, Sketchfab
(https://sketchfab.com/3d-models/mars-the-red-planet-free-7cf3b31ca60f45cc8e52f7fa863ad09a).
The data sources are listed in the table above.

## Team
Pari, Annalaya, Anna, Amira, Julia, Benonia
