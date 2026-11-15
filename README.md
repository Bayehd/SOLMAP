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

An ArcGIS Maps SDK for JavaScript map of Mars with real data layers, shown on a 3D globe. The home
page has two landing areas: **Jezero Crater** (Perseverance) and **Gale Crater** (Curiosity). Each opens
the same app with the layers that site has data for, and three views of it: **3D** (tilted), **Side**
and **Top** (straight down). Everything is in GCS
Mars 2000 (ArcGIS wkid 104971). Click the map to read the elevation and slope at that point.

In the **Side** view, the site's terrain area (the 20 m DTM extent: ~30 km square at Jezero, 33 × 57 km
at Gale) is lifted off the ground and pulled apart into one slab per checked data layer: slope, minerals
and the rover layers from the ground up, with elevation on top in relief (2× at Jezero, about 1× at Gale,
where Mount Sharp already rises 4 km). The lowest checked layer is not lifted: it stays on the ground under
the stack. Every slab shows the base map with its
layer's data on top, as on the map, and is labelled. The rover is hidden in this view.

```sh
npm install
npm run dev     # http://localhost:5173
npm run build
```

| Layer | Source | Resolution | Kind |
|---|---|---|---|
| Viking color mosaic (MDIM 2.1) | USGS / NASA Ames, hosted by Esri | 232 m/px | data |
| CTX image mosaic (Mars color) | Murray Lab, Caltech (MRO CTX), colored with the Viking MDIM 2.1 mosaic, hosted by Esri | ~5 m/px | derived |
| SOLMAP model texture | `public/models/mars-8k.jpg` (artist texture, not NASA data) | ~2.6 km/px | artistic |
| 3D ground | NASA MGS MOLA global DEM (USGS/NASA, hosted by Esri), with the Jezero DTM in its place | 463 m / 20 m | data |
| Jezero elevation | USGS Mars 2020 TRN CTX DTM (Fergason et al. 2020) | 20 m/px | data |
| Jezero slope hazard | Derived from that DTM (Horn method) | 20 m/px | derived |
| Jezero minerals (off by default) | NASA MRO CRISM MTRDR summary parameters (PDS Geosciences Node), 4 observations from 2007 | 18 m/px, smoothed to ~90 m | derived |
| Perseverance traverse and stops | NASA/JPL Mars 2020 MMGIS, to sol 2022 | per drive | data |
| Perseverance samples collected | NASA Mars 2020 rock sample list, placed with the MMGIS rover positions | 28 sealed samples, to sol 1441 | data |
| Three Forks sample depot | NASA PDS Geosciences Node, Mars 2020 Three Forks depot bundle (sample tube locations) | 10 tubes, dropped sols 653–690 | data |
| Gale elevation | USGS Astrogeology MSL Gale merged DEM (HiRISE + CTX stereo, 1 m), read from its 16 m overview and averaged to 20 m | 20 m/px | data |
| Gale slope hazard | Derived from that DEM (Horn method) | 20 m/px | derived |
| Curiosity traverse and stops | NASA/JPL MSL MMGIS, to sol 5073 | per drive, 1,389 stops | data |
| Gale radiation (route planner) | NASA PDS PPI Node, MSL RAD RDR: total dose per observation, B (silicon) and E (tissue-equivalent) detectors | 1 sol every 40, sols 41–4841 | data |
| Gale weather (route planner) | NASA PDS Atmospheres Node, MSL REMS calibrated ENV tables: air (boom 1) and ground temperature, UV, pressure | 1 sol every 40, 240 rows per sol | data |

At Gale the rover is the same 3D model (Perseverance), standing in for Curiosity: Perseverance was built on
Curiosity's design, with the same size and six wheels. Gale has no mineral, sample or depot layer yet.

**Radiation at Gale is measured, not modelled:** the route planner shows the dose rate Curiosity's RAD
measured (tissue-equivalent detector, duration-weighted mean per sol, median 9.5 µGy/h ≈ 0.23 mGy per sol;
NASA's published value is 0.21 ± 0.04 mGy/day) and the dose on the walk at that rate. *Where* the dose is
higher along a route (sky openness, elevation) is still modelled, as at Jezero. RAD sits on the rover deck,
not in a suit, so the walk dose is indicative. The REMS block gives typical daily lows and highs of air and
ground temperature, midday UV and the seasonal pressure range. Jezero keeps the modelled radiation index:
Perseverance has no RAD.

**Assumption:** CTX is grayscale. To show it in Mars color, each pixel keeps the CTX brightness and is
tinted with a butterscotch tan like Perseverance's natural-color images (`MARS_TINT`), with 30 % of the
Viking MDIM 2.1 hue at that place mixed in (`MDIM_SHARE`, both in `src/map/MarsColorCtxLayer.ts`). The
Viking colors are enhanced (dark ground turns blue), so they are not used on their own.

**Assumption:** the slope classes (walkable < 15°, caution 15–25°, no-go ≥ 25°) are
placeholders, not a NASA standard. Change them in `SLOPE_CLASSES` in `src/map/layers.ts`.
A 20 m grid also hides steps and boulders smaller than 20 m.

**Assumption:** the mineral map uses fixed thresholds on CRISM summary parameters
(Viviano-Beck et al. 2014): Mg-carbonate (MIN2295_2480 and MIN2345_2537), Fe/Mg clay
(D2300 and BD1900R2), hydrated silica (MIN2250 and BD1900R2), olivine (OLINDEX3) and
pyroxene (HCPINDEX2). They flag roughly the strongest 1–3 % of pixels, so the map shows where
each mineral is likely, not a lab-grade identification. Uncolored ground means nothing was
detected or there is no CRISM coverage (about half of the 20 m area is covered). Change the
thresholds in `CLASSES` in `scripts/build_jezero_minerals.py` and rebuild.

**Assumption:** each sample point is the rover's parked position when the sample was sealed
(its last drive end before the sealing sol), so it marks the workspace, not the exact borehole
(a few meters off). Bell Island and Gallants have no sealing sol yet and are not shown. Update
`SAMPLES` in `scripts/build_jezero_layers.py` as NASA adds samples. Click a point to see its name.

**Assumption:** each depot point is the rover's position when it dropped that tube, as NASA's
PDS file gives it. The tube lies under the rover, within about a meter of the point.

### Code

- `src/map/sites.ts`: the landing areas (`SITES`): extent, landing point, data files and sources.
  **To add a site**, add an entry there and build its data like `scripts/build_gale_layers.py` does.
- `src/map/layers.ts`: the layer catalog. **To add a layer, add an entry to `layersFor()`**
  with its title, group, source and a `create()` that returns an ArcGIS layer. Ids are the same at
  every site (`elevation`, `traverse`, ...).
- `src/map/layerStack.ts`: the Side view stack. What each layer draws on its slab is in `SLABS`;
  spacing and texture size are the constants at the top.
- `src/map/geojson.ts`: `marsGeoJSONLayer()` for GeoJSON in Mars lon/lat. Use it instead of
  ArcGIS's `GeoJSONLayer`, which assumes Earth (WGS84) coordinates.
- `src/map/SiteElevationLayer.ts`: the 3D ground (global DEM + the site's 20 m DTM, feathered
  over ~600 m at the DTM's edge).
- `src/map/UpsampledTileLayer.ts`, `src/map/ModelTextureLayer.ts`: custom tile layers.
- `src/map/mars.ts`: the Mars coordinate system and tiling scheme.
- In development, `window.solmap` holds the map, view and layers for the browser console.

### Rebuilding the Jezero data

`public/data/jezero/` is built by `scripts/build_jezero_layers.py` (Python 3, rasterio):

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/build_jezero_layers.py
```

It downloads the USGS DTM, the NASA rover GeoJSON and the PDS depot table (cached in `scripts/.cache/`) and writes:
- `ctx_dtm_20m.tif`, `ctx_slope_20m.tif`: Float32 GeoTIFFs in GCS Mars 2000, 512 px tiles with
  overviews, LERC-compressed with at most 1 cm (or 0.01°) error. The DTM's equirectangular
  projection (standard parallel 0°) converts to lon/lat by an exact rescale, so no value is
  resampled. The CRS is stored as an Esri WKT, the only non-EPSG form ArcGIS reads.
- `m20_traverse.geojson`, `m20_waypoints.geojson`: the rover path and stops, geometry only.
- `m20_samples.geojson`: one point per sealed sample (number, name, type, sol sealed).
- `m20_depot.geojson`: one point per tube left at the Three Forks depot (name, sol dropped).

The mineral layer is built by a second script, after the first (it uses the DTM grid):

```sh
.venv/bin/python scripts/build_jezero_minerals.py
```

It finds the CRISM MTRDR observations over Jezero through the PDS ODE API, reads only the
needed summary-parameter bands with HTTP range requests (cached in `scripts/.cache/crism/`),
evens out offsets between overlapping observations, masks bad scan lines, applies a 5×5
median filter, and writes `crism_minerals_20m.tif`: a UInt8 class raster (0 = none,
1–5 = the classes above) on the DTM grid. Three 2011 observations with along-track striping
are left out.

`build_jezero_layers.py` checks the DTM against the published elevation of the Perseverance landing site
(−2569.9 m; the DTM gives −2567.2 m) and stops if they differ by more than 15 m.

### Rebuilding the Gale data

`public/data/gale/` is built by `scripts/build_gale_layers.py` (same venv; it reuses helpers from the
Jezero script):

```sh
.venv/bin/python scripts/build_gale_layers.py            # or --only rasters | rover | environment
```

- `gale_dem_20m.tif`, `gale_slope_20m.tif`: the USGS Gale DEM is 3.6 GB, so it is read remotely from its
  16 m overview (HTTP range requests through GDAL) and averaged to 20 m. The script checks it against the
  rover's own elevations at the first, middle and last stop (they agree within ~1 m) and stops if any
  differs by more than 25 m.
- `msl_traverse.geojson`, `msl_waypoints.geojson`: the Curiosity path (MultiLineStrings split into
  LineStrings, in driving order) and stops (sol, elevation).
- `msl_environment.json`: RAD and REMS on one sol every 40. RAD files are ~68 MB per sol: the script reads
  only each label (cached in `scripts/.cache/gale/`) and then the few bytes of each dose value with range
  requests. REMS tables are fixed-width, so it reads 240 evenly spaced rows per sol the same way.

## Credits

Mars color texture (`public/models/mars-8k.jpg`, 8192 × 4096, re-encoded at JPEG quality 85):
"Mars the Red Planet" by DURVESH123, CC Attribution, Sketchfab
(https://sketchfab.com/3d-models/mars-the-red-planet-free-7cf3b31ca60f45cc8e52f7fa863ad09a).
The data sources are listed in the table above.

## Team
Pari, Annalaya, Anna, Amira, Julia, Benonia
