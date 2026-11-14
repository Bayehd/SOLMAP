#!/usr/bin/env python3
"""Builds the Jezero data layers in public/data/jezero/ from official sources.

    python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
    .venv/bin/python scripts/build_jezero_layers.py

Outputs (all in GCS Mars 2000 Sphere, the CRS of ArcGIS wkid 104971):
  ctx_dtm_20m.tif      Float32 elevation in meters, Cloud Optimized GeoTIFF
  ctx_slope_20m.tif    Float32 slope in degrees, Cloud Optimized GeoTIFF
  m20_traverse.geojson Perseverance drive path
  m20_waypoints.geojson Perseverance end-of-drive positions

Sources:
  DTM: USGS Astrogeology, Mars 2020 Terrain Relative Navigation CTX DTM mosaic
       (Fergason et al. 2020), 20 m/pixel, elevations tied to MOLA.
  Rover: NASA/JPL Mars 2020 MMGIS traverse and waypoint layers.
"""
import argparse
import json
import math
import shutil
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy
from rasterio.transform import Affine

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'jezero'
CACHE = ROOT / 'scripts' / '.cache'

DTM_URL = ('https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/'
           'JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif')
TRAVERSE_URL = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json'
WAYPOINTS_URL = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json'

MARS_RADIUS_M = 3396190.0  # Mars 2000 IAU sphere, as in the DTM's CRS
NODATA = -32768.0
# Same definition as ArcGIS wkid 104971.
GCS_MARS_2000_SPHERE = (
    'GEOGCS["GCS_Mars_2000_Sphere",DATUM["D_Mars_2000_Sphere",'
    'SPHEROID["Mars_2000_Sphere_IAU_IAG",3396190.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]'
)
# Known points: (name, lat, lon, published elevation m, tolerance m).
# The Perseverance landing elevation is the first waypoint's elev_geoid.
POINT_CHECKS = [('Octavia E. Butler Landing', 18.44462715, 77.45088572, -2569.91, 15.0)]


def fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        print(f'  cached {dest.name}')
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f'  downloading {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'solmap-data-pipeline'})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest.with_suffix('.part'), 'wb') as f:
        shutil.copyfileobj(r, f)
    dest.with_suffix('.part').rename(dest)
    return dest


def slope_degrees(z: np.ndarray, lat_rows: np.ndarray, pixel_m: float) -> np.ndarray:
    """Horn slope in degrees. In an equirectangular grid with standard parallel 0,
    a pixel spans pixel_m north-south but only pixel_m * cos(lat) east-west on the ground."""
    p = np.pad(z, 1, mode='constant', constant_values=np.nan)
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    dx_m = (pixel_m * np.cos(np.radians(lat_rows)))[:, None]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx_m)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * pixel_m)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def write_cog(path: Path, data: np.ndarray, transform: Affine, description: str) -> None:
    arr = np.where(np.isfinite(data), data, NODATA).astype('float32')
    profile = dict(driver='GTiff', width=arr.shape[1], height=arr.shape[0], count=1, dtype='float32',
                   crs=GCS_MARS_2000_SPHERE, transform=transform, nodata=NODATA)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'src.tif'
        with rasterio.open(src, 'w', **profile) as dst:
            dst.write(arr, 1)
            valid = arr[arr != NODATA]
            # GDAL statistics tags: ArcGIS uses them to stretch color ramps.
            dst.update_tags(1, DESCRIPTION=description,
                            STATISTICS_MINIMUM=f'{valid.min():.3f}', STATISTICS_MAXIMUM=f'{valid.max():.3f}',
                            STATISTICS_MEAN=f'{valid.mean():.3f}', STATISTICS_STDDEV=f'{valid.std():.3f}')
            dst.build_overviews([2, 4, 8], Resampling.average)
        # Cloud-optimized layout (512 px tiles, overviews) written with the GTiff driver, because
        # only it can store the CRS as an Esri WKT ("ESRI PE String"): ArcGIS's GeoTIFF reader
        # accepts EPSG codes or Esri WKT, and Mars has no EPSG code.
        # Plain LERC (ArcGIS can't decode LERC_DEFLATE) keeps every value within MAX_Z_ERROR
        # (1 cm, or 0.01 deg of slope), far below the DTM's own vertical precision.
        rio_copy(src, path, driver='GTiff', TILED='YES', BLOCKXSIZE=512, BLOCKYSIZE=512,
                 COPY_SRC_OVERVIEWS='YES', COMPRESS='LERC', MAX_Z_ERROR=0.01,
                 GEOTIFF_KEYS_FLAVOR='ESRI_PE')
    print(f'  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.1f} MB)')


def build_rasters() -> None:
    dtm_path = fetch(DTM_URL, CACHE / 'jezero_ctx_dtm_20m_eqc.tif')
    with rasterio.open(dtm_path) as src:
        crs = src.crs.to_wkt()
        assert 'Equirectangular' in crs and src.crs.to_dict().get('lat_ts', 0) == 0, crs
        t = src.transform
        assert t.b == 0 and t.d == 0 and abs(t.a) == abs(t.e), t
        z = src.read(1, masked=True).filled(np.nan).astype('float64')
        z[z < -1e30] = np.nan

    # Equirectangular with standard parallel 0 and central meridian 0 is x = R*lon, y = R*lat,
    # so the grid converts to degrees exactly by rescaling: no resampling.
    m_per_deg = MARS_RADIUS_M * math.pi / 180
    geo = Affine(t.a / m_per_deg, 0, t.c / m_per_deg, 0, t.e / m_per_deg, t.f / m_per_deg)
    rows = np.arange(z.shape[0])
    lat_rows = geo.f + (rows + 0.5) * geo.e
    w, n = geo.c, geo.f
    e, s = w + z.shape[1] * geo.a, n + z.shape[0] * geo.e
    print(f'  extent lon {w:.5f}..{e:.5f}, lat {s:.5f}..{n:.5f}; {z.shape[1]}x{z.shape[0]} px of {t.a:g} m')

    for name, lat, lon, expected, tol in POINT_CHECKS:
        col, row = ~geo * (lon, lat)
        got = z[int(row), int(col)]
        status = 'ok' if abs(got - expected) <= tol else 'MISMATCH'
        print(f'  check {name}: {got:.1f} m vs published {expected:.1f} m -> {status}')
        if status != 'ok':
            raise SystemExit('Elevation check failed; georeferencing or datum is off.')

    slope = slope_degrees(z, lat_rows, abs(t.e))
    print(f'  elevation {np.nanmin(z):.0f}..{np.nanmax(z):.0f} m; '
          f'slope median {np.nanmedian(slope):.1f} deg, 99th pct {np.nanpercentile(slope, 99):.1f} deg')

    OUT.mkdir(parents=True, exist_ok=True)
    write_cog(OUT / 'ctx_dtm_20m.tif', z, geo, 'Elevation (m), USGS Mars 2020 CTX DTM 20 m')
    write_cog(OUT / 'ctx_slope_20m.tif', slope, geo, 'Slope (degrees), Horn method on USGS CTX DTM 20 m')


def build_rover() -> None:
    traverse = json.loads(fetch(TRAVERSE_URL, CACHE / 'M20_traverse.json').read_text())
    waypoints = json.loads(fetch(WAYPOINTS_URL, CACHE / 'M20_waypoints.json').read_text())

    def rnd(c):
        return [round(c[0], 7), round(c[1], 7)]

    lines = []
    for f in traverse['features']:
        pts = []
        for c in f['geometry']['coordinates']:
            c = rnd(c)
            if not pts or pts[-1] != c:
                pts.append(c)
        if len(pts) >= 2:
            p = f['properties']
            lines.append({'type': 'Feature', 'properties': {'sol': p.get('sol'), 'length_m': p.get('length')},
                          'geometry': {'type': 'LineString', 'coordinates': pts}})
    points = []
    for f in waypoints['features']:
        p = f['properties']
        points.append({'type': 'Feature',
                       'properties': {'sol': p.get('sol'), 'site': p.get('site'), 'drive': p.get('drive'),
                                      'elev_m': p.get('elev_geoid'), 'dist_total_m': p.get('dist_total_m')},
                       'geometry': {'type': 'Point', 'coordinates': [round(p['lon'], 7), round(p['lat'], 7)]}})
    last_sol = max(p['properties']['sol'] or 0 for p in points)

    for name, feats, label in [('m20_traverse.geojson', lines, traverse.get('name')),
                               ('m20_waypoints.geojson', points, waypoints.get('name'))]:
        path = OUT / name
        path.write_text(json.dumps({'type': 'FeatureCollection', 'name': label, 'features': feats},
                                   separators=(',', ':')))
        print(f'  wrote {path.relative_to(ROOT)} ({len(feats)} features, {path.stat().st_size / 1e6:.2f} MB)')
    print(f'  rover data runs to sol {last_sol}')


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    print('Rasters:')
    build_rasters()
    print('Rover:')
    build_rover()
