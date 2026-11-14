#!/usr/bin/env python3
"""Builds the Jezero mineral map, public/data/jezero/crism_minerals_20m.tif, from NASA CRISM data.

    .venv/bin/python scripts/build_jezero_minerals.py

Source: MRO CRISM map-projected targeted reduced data records (MTRDR, PDS volume MROCR_4001,
NASA PDS Geosciences Node), summary-parameter cubes (*_su*_mtr3.img). Steps:

1. Find the full-resolution (FRT, 18 m) MTRDR observations over the Jezero DTM area (PDS ODE).
2. Download only the summary parameters used below (HTTP range requests; cached in
   scripts/.cache/crism/), mask bad scan lines, and smooth each with a 5x5 median (~90 m) to
   suppress pixel noise and bad scan lines.
3. Mosaic each parameter onto the 20 m Jezero DTM grid (nearest pixel), so the result lines up
   with ctx_dtm_20m.tif. Observations differ in calibration and atmosphere, so before adding an
   observation its median offset against the mosaic, over their overlap, is subtracted.
   Without this, fixed thresholds leave hard seams at observation edges.
4. Classify every pixel into one mineral class (CLASSES).

Output: UInt8 GeoTIFF in GCS Mars 2000 Sphere. 0 = no detection or no CRISM coverage
(NoData, transparent); 1..N = the classes in CLASSES, in order. The classes and colors are
mirrored in src/map/layers.ts (MINERAL_CLASSES); keep the two in sync.
"""
import json
import math
import re
import tempfile
import urllib.request
import warnings
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'jezero' / 'crism_minerals_20m.tif'
DTM = ROOT / 'public' / 'data' / 'jezero' / 'ctx_dtm_20m.tif'
CACHE = ROOT / 'scripts' / '.cache' / 'crism'
ODE = 'https://oderest.rsl.wustl.edu/live2/'

# Mineral classes, highest priority first: a pixel that passes several tests gets the first.
# Parameters are CRISM summary parameters (Viviano-Beck et al. 2014, JGR 119,
# doi:10.1002/2014JE004627), after the offset matching in step 3 (relative to REFERENCE).
# ASSUMPTION: no official threshold exists. These flag roughly the strongest 1-3 % of each
# parameter in this mosaic, chosen so that known Jezero units appear (marginal carbonates on
# the inner western rim, Fe/Mg clays in the delta, olivine on the floor). Treat the map as
# indicative: the CRISM team validates detections with ratioed spectra, which this does not do.
CLASSES = [
    ('Mg-carbonate', lambda p: (p['MIN2295_2480'] > 0.002) & (p['MIN2345_2537'] > 0.002)),
    ('Fe/Mg-clay (smectite)', lambda p: (p['D2300'] > 0.010) & (p['BD1900R2'] > 0.004)),
    ('Hydrated silica', lambda p: (p['MIN2250'] > 0.004) & (p['BD1900R2'] > 0.004)),
    ('Olivine', lambda p: p['OLINDEX3'] > 0.105),
    ('Pyroxene', lambda p: p['HCPINDEX2'] > 0.003),
]
PARAMS = sorted({'MIN2295_2480', 'MIN2345_2537', 'D2300', 'BD1900R2', 'MIN2250', 'OLINDEX3', 'HCPINDEX2'})
# Observations left out, with the reason. The 2011 ones show strong along-track striping that
# would turn into false detections.
EXCLUDE = {
    'frt0001ecba': 'along-track striping',
    'frt0001fb74': 'along-track striping',
    'frt00021da6': 'along-track striping',
}
# The observation the others are matched to: FRT00005C5E covers the delta and crater floor.
REFERENCE = 'frt00005c5e'
# Overlap (grid pixels) needed to estimate an observation's offset; less, and it is skipped.
MIN_OVERLAP = 2000
GCS_MARS_2000_SPHERE = (
    'GEOGCS["GCS_Mars_2000_Sphere",DATUM["D_Mars_2000_Sphere",'
    'SPHEROID["Mars_2000_Sphere_IAU_IAG",3396190.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]'
)


def get(url: str, byte_range=None) -> bytes:
    headers = {'User-Agent': 'solmap-data-pipeline'}
    if byte_range:
        headers['Range'] = f'bytes={byte_range[0]}-{byte_range[1]}'
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=300) as r:
        return r.read()


def observations(bounds):
    """Full-resolution (FRT) MTRDR observations intersecting bounds, as (id, summary-parameter header URL)."""
    w, s, e, n = bounds
    q = (f'{ODE}?query=product&results=f&output=JSON&target=mars&ihid=MRO&iid=CRISM&pt=MTRDR'
         f'&westernlon={w}&easternlon={e}&minlat={s}&maxlat={n}&limit=100')
    products = json.loads(get(q))['ODEResults']['Products']['Product']
    products = products if isinstance(products, list) else [products]
    obs = []
    for p in products:
        files = p['Product_files']['Product_file']
        files = files if isinstance(files, list) else [files]
        for f in files:
            name = f['FileName'].lower()  # e.g. frt00005c5e_07_su166j_mtr3.hdr
            if re.search(r'_su\w*_mtr3\.hdr$', name) and name.startswith('frt'):
                obs.append((name.split('_')[0], f['URL']))
    for o in sorted({o for o, _ in obs} & EXCLUDE.keys()):
        print(f'  skipping {o}: {EXCLUDE[o]}')
    return sorted({(o, u) for o, u in obs if o not in EXCLUDE})


def median_filter(a: np.ndarray, size: int = 5) -> np.ndarray:
    """NaN-aware median over size x size windows. 5x5 also removes bad scan lines up to 2 px
    wide, which run diagonally in the map-projected data."""
    h = size // 2
    p = np.pad(a, h, mode='edge')
    stack = np.stack([p[i:i + a.shape[0], j:j + a.shape[1]] for i in range(size) for j in range(size)])
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)  # all-NaN windows stay NaN
        return np.nanmedian(stack, axis=0)


def load_observation(obs_id: str, hdr_url: str):
    """Smoothed summary parameters and georeferencing of one observation."""
    cache = CACHE / obs_id
    cache.mkdir(parents=True, exist_ok=True)
    hdr_path = cache / 'su.hdr'
    if not hdr_path.exists():
        hdr_path.write_bytes(get(hdr_url))
    hdr = hdr_path.read_text()
    ns = int(re.search(r'samples\s*=\s*(\d+)', hdr).group(1))
    nl = int(re.search(r'lines\s*=\s*(\d+)', hdr).group(1))
    assert re.search(r'interleave\s*=\s*bsq', hdr) and re.search(r'data type\s*=\s*4', hdr), 'expected BSQ float32'
    assert re.search(r'byte order\s*=\s*0', hdr), 'expected little-endian'
    ignore = float(re.search(r'data ignore value\s*=\s*([\d.eE+-]+)', hdr).group(1))
    names = [b.strip() for b in re.search(r'band names\s*=\s*\{(.*?)\}', hdr, re.S).group(1).split(',')]

    # map info = {name, ref_x, ref_y, easting, northing, dx, dy, ...}; projection info = {17, R, lat_ts, lon0, ...}
    mi = [v.strip() for v in re.search(r'map info\s*=\s*\{(.*?)\}', hdr, re.S).group(1).split(',')]
    ref_x, ref_y, x0, y0, dx, dy = (float(v) for v in mi[1:7])
    pi = [v.strip() for v in re.search(r'projection info\s*=\s*\{(.*?)\}', hdr, re.S).group(1).split(',')]
    assert pi[0] == '17', f'expected equirectangular (ENVI 17), got {pi[0]}'
    radius, lat_ts, lon0 = float(pi[1]), float(pi[2]), float(pi[3])
    assert lon0 == 0.0, lon0

    img_url = re.sub(r'\.hdr$', '.img', hdr_url, flags=re.I)
    band_bytes = ns * nl * 4
    params = {}
    for name in PARAMS:
        path = cache / f'{name}.f32'
        if not path.exists():
            i = names.index(name)
            path.write_bytes(get(img_url, (i * band_bytes, (i + 1) * band_bytes - 1)))
        a = np.frombuffer(path.read_bytes(), '<f4').reshape(nl, ns).astype('float64')
        a[(a >= ignore - 1) | ~np.isfinite(a)] = np.nan
        params[name] = a
    # Mask bad scan lines: thin, nearly horizontal streaks (slanted by the map projection).
    # A pixel is bad if it differs strongly from the median of the 4 pixels above and 4 below
    # it in any parameter; the mask is then grown by 1 px vertically.
    bad = np.zeros((nl, ns), bool)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        for a in params.values():
            pad = np.pad(a, ((4, 4), (0, 0)), mode='edge')
            v = a - np.nanmedian(np.stack([pad[i:i + nl] for i in range(9) if i != 4]), axis=0)
            bad |= np.abs(v) > 8 * np.nanmedian(np.abs(v))
    bad[1:] |= bad[:-1].copy()
    bad[:-1] |= bad[1:].copy()
    print(f'    {obs_id}: masked {bad.mean():.1%} of pixels as bad scan lines')
    for name in params:
        params[name][bad] = np.nan
        params[name] = median_filter(params[name])

    # Equirectangular with standard parallel lat_ts: x = R*cos(lat_ts)*lon, y = R*lat (radians),
    # so pixel -> lon/lat is an exact rescale. ENVI's reference pixel (1,1) is the upper-left
    # corner of the first pixel.
    deg = 180 / math.pi
    kx = radius * math.cos(math.radians(lat_ts))
    x_ul, y_ul = x0 - (ref_x - 1) * dx, y0 + (ref_y - 1) * dy
    geo = dict(lon0=x_ul / kx * deg, lat0=y_ul / radius * deg, dlon=dx / kx * deg, dlat=dy / radius * deg, ns=ns, nl=nl)
    return params, geo


def main() -> None:
    with rasterio.open(DTM) as dtm:
        grid_t, width, height = dtm.transform, dtm.width, dtm.height
        bounds = (dtm.bounds.left, dtm.bounds.bottom, dtm.bounds.right, dtm.bounds.top)
    obs = observations(bounds)
    print(f'  {len(obs)} CRISM FRT observations over Jezero: {", ".join(o for o, _ in obs)}')

    cols, rows = np.meshgrid(np.arange(width), np.arange(height))
    lon = grid_t.c + (cols + 0.5) * grid_t.a
    lat = grid_t.f + (rows + 0.5) * grid_t.e

    # Sample every observation onto the grid.
    sampled = {}
    for obs_id, hdr_url in obs:
        params, g = load_observation(obs_id, hdr_url)
        c = np.floor((lon - g['lon0']) / g['dlon']).astype(int)
        r = np.floor((g['lat0'] - lat) / g['dlat']).astype(int)
        inside = (c >= 0) & (c < g['ns']) & (r >= 0) & (r < g['nl'])
        grid = {}
        for name, a in params.items():
            v = np.full((height, width), np.nan)
            v[inside] = a[r[inside], c[inside]]
            grid[name] = v
        sampled[obs_id] = grid

    # Mosaic, starting from the reference and adding the observation with the most overlap next.
    mosaic = {k: v.copy() for k, v in sampled.pop(REFERENCE).items()}
    covered = np.all([np.isfinite(v) for v in mosaic.values()], axis=0)
    while sampled:
        valid = {o: np.all([np.isfinite(v) for v in g.values()], axis=0) for o, g in sampled.items()}
        obs_id = max(sampled, key=lambda o: (valid[o] & covered).sum())
        g, ok = sampled.pop(obs_id), valid[obs_id]
        overlap = ok & covered
        if overlap.sum() < MIN_OVERLAP:
            print(f'    {obs_id}: only {overlap.sum()} px overlap, skipped')
            continue
        offsets = {k: float(np.median(g[k][overlap] - mosaic[k][overlap])) for k in PARAMS}
        new = ok & ~covered
        for k in PARAMS:
            mosaic[k][new] = g[k][new] - offsets[k]
        covered |= new
        print(f'    {obs_id}: +{new.mean():.0%} of grid, offsets ' + ', '.join(f'{k} {v:+.4f}' for k, v in offsets.items()))

    out = np.zeros((height, width), np.uint8)
    with np.errstate(invalid='ignore'):
        for i, (_, test) in reversed(list(enumerate(CLASSES))):  # lower priority first, overwritten by higher
            out[test(mosaic) & covered] = i + 1
    print(f'  CRISM covers {covered.mean():.0%} of the Jezero grid')
    for k, (name, _) in enumerate(CLASSES, 1):
        print(f'    {name}: {(out == k).sum() / covered.sum():.1%} of covered pixels')

    profile = dict(driver='GTiff', width=width, height=height, count=1, dtype='uint8',
                   crs=GCS_MARS_2000_SPHERE, transform=grid_t, nodata=0)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'src.tif'
        with rasterio.open(src, 'w', **profile) as dst:
            dst.write(out, 1)
            dst.update_tags(1, DESCRIPTION='Mineral class from MRO CRISM MTRDR summary parameters: '
                            + '; '.join(f'{i}={n}' for i, (n, _) in enumerate(CLASSES, 1)))
            dst.build_overviews([2, 4, 8], Resampling.mode)
        # Same layout as the DTM (see build_jezero_layers.py): tiled, overviews, Esri WKT CRS.
        rio_copy(src, OUT, driver='GTiff', TILED='YES', BLOCKXSIZE=512, BLOCKYSIZE=512,
                 COPY_SRC_OVERVIEWS='YES', COMPRESS='DEFLATE', GEOTIFF_KEYS_FLAVOR='ESRI_PE')
    print(f'  wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)')


if __name__ == '__main__':
    main()
