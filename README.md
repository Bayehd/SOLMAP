# SOLMAP

A Three.js / React Three Fiber Mars globe (started as the Nasa Challenge project).
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

```sh
npm install
npm run dev     # http://localhost:5173
npm run build
```

Color texture (`public/models/mars-8k.glb`, 8192 × 4096, re-encoded at JPEG quality 85): "Mars the Red Planet" by DURVESH123, CC Attribution, Sketchfab
(https://sketchfab.com/3d-models/mars-the-red-planet-free-7cf3b31ca60f45cc8e52f7fa863ad09a).
Elevation: MOLA (NASA), exaggerated for display.
Rover: "Perseverance Rover NASA 2020" by Jaydeep.Padwal, CC Attribution, Sketchfab
(https://sketchfab.com/3d-models/perseverance-rover-nasa-2020-9437aed282c7443b80a5ca6f961792d0).

## Adding a site

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

## Adding a layer

1. Add `{ id, label, visible }` to `INITIAL_LAYERS` in `src/mars/LayersPanel.tsx`
   (its position sets where it sits in the stack).
2. Add a slab builder with the same id to `SLABS` in `src/mars/layerBlock.ts`.
   It gets the slice's MOLA elevation and slope on a 128 × 128 grid and returns
   a mesh, its height and a one-line detail for the label.

## Tuning

- Colors: `HEIGHT_RAMP` and `SLOPE_RAMP` in `src/mars/layerBlock.ts`.
- Vertical exaggeration: `VERTICAL_EXAGGERATION` in `src/mars/layerBlock.ts`.
- Slab thickness, gaps and lift: the constants at the top of `src/mars/layerBlock.ts`.
- Front view angle: `FRONT_TILT` in `src/mars/flyTo.ts` (90° = level with the ground).
- If the markers don't line up with features on a different texture, change
  `TEXTURE_LON_OFFSET_DEG` in `src/mars/geo.ts`.
