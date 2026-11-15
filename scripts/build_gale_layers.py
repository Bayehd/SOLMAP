#!/usr/bin/env python3
"""Builds the Gale Crater (Curiosity) data layers in public/data/gale/ from official sources.

    python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
    .venv/bin/python scripts/build_gale_layers.py

Outputs (all in GCS Mars 2000 Sphere, the CRS of ArcGIS wkid 104971):
  gale_dem_20m.tif       Float32 elevation in meters, Cloud Optimized GeoTIFF
  gale_slope_20m.tif     Float32 slope in degrees, Cloud Optimized GeoTIFF
  msl_traverse.geojson   Curiosity drive path, one LineString per drive, in driving order
  msl_waypoints.geojson  Curiosity end-of-drive positions (sol, elevation)
  msl_environment.json   Measured radiation (RAD) and weather (REMS) on a sample of sols

Sources:
  DEM: USGS Astrogeology, MSL Gale merged DEM mosaic 1 m (HiRISE and CTX stereo, tied to MOLA),
       read remotely from its 16 m overview and averaged to 20 m, the same grid spacing as Jezero.
  Rover: NASA/JPL MSL MMGIS traverse and waypoint layers.
  RAD: NASA PDS PPI Node, MSL-M-RAD-3-RDR-V1.0. One file per sol; we read only the total dose of each
       observation (B: silicon detector, E: plastic scintillator, about tissue-equivalent), in µGy/h,
       weighted by the observation's duration.
  REMS: NASA PDS Atmospheres Node, msl_rems_bundle data_calibrated, the ENV (RNV) table of each sol:
       air temperature (boom 1, else boom 2), ground temperature, total UV (UV_ABC) and pressure. We read an even
       subset of rows (byte ranges of the fixed-width table), not the whole 17 MB file.
"""
import argparse
import bisect
import concurrent.futures as cf
import json
import math
import re
import shutil
import statistics
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine

from build_jezero_layers import GCS_MARS_2000_SPHERE, MARS_RADIUS_M, slope_degrees, write_cog  # noqa: F401

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'gale'
CACHE = ROOT / 'scripts' / '.cache' / 'gale'

DEM_URL = 'https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif'
TRAVERSE_URL = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json'
WAYPOINTS_URL = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json'
RAD = 'https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0'
REMS = 'https://atmos.nmsu.edu/PDS/data/PDS4/msl_rems_bundle/data_calibrated'

PIXEL_M = 20.0
SOL_STEP = 40  # one sol every SOL_STEP for RAD and REMS
REMS_ROWS = 240  # rows read per sol
UA = {'User-Agent': 'solmap-data-pipeline'}


def get(url: str, headers=None, timeout=300) -> bytes:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f'  downloading {url}')
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r, open(dest.with_suffix('.part'), 'wb') as f:
        shutil.copyfileobj(r, f)
    dest.with_suffix('.part').rename(dest)
    return dest


def ranges(url: str, spans: list[tuple[int, int]]) -> list[bytes]:
    """Read byte ranges [start, end] (inclusive) with multi-range requests, in the order given."""
    out: dict[tuple[int, int], bytes] = {}
    for i in range(0, len(spans), 80):
        chunk = spans[i:i + 80]
        body = get(url, {'Range': 'bytes=' + ','.join(f'{a}-{b}' for a, b in chunk)})
        if len(chunk) == 1:
            out[chunk[0]] = body
            continue
        for part in re.split(rb'\r?\n--[0-9A-Za-z]+(?:--)?\r?\n', b'\n' + body):
            m = re.search(rb'Content-range: bytes (\d+)-(\d+)/\d+\r?\n\r?\n', part, re.I)
            if m:
                out[(int(m[1]), int(m[2]))] = part[m.end():]
    return [out.get(s, b'') for s in spans]


# ---------- Terrain ----------

def build_rasters(waypoints) -> dict:
    with rasterio.open('/vsicurl/' + DEM_URL) as src:
        crs = src.crs.to_wkt()
        assert 'Equirectangular' in crs and src.crs.to_dict().get('lat_ts', 0) == 0, crs
        t = src.transform
        assert t.b == 0 and t.d == 0 and abs(t.a) == abs(t.e), t
        w, h = round(src.width * t.a / PIXEL_M), round(src.height * abs(t.e) / PIXEL_M)
        print(f'  reading {src.width}x{src.height} px of {t.a:g} m as {w}x{h} px of {PIXEL_M:g} m (remote overview)')
        z = src.read(1, out_shape=(h, w), resampling=Resampling.average, masked=True).filled(np.nan).astype('float64')
        z[(z < -1e30) | (z == src.nodata)] = np.nan
        sx, sy = src.width * t.a / w, src.height * t.e / h

    m_per_deg = MARS_RADIUS_M * math.pi / 180
    geo = Affine(sx / m_per_deg, 0, t.c / m_per_deg, 0, sy / m_per_deg, t.f / m_per_deg)
    lat_rows = geo.f + (np.arange(h) + 0.5) * geo.e
    ext = {'xmin': geo.c, 'xmax': geo.c + w * geo.a, 'ymin': geo.f + h * geo.e, 'ymax': geo.f}
    print('  extent lon {xmin:.5f}..{xmax:.5f}, lat {ymin:.5f}..{ymax:.5f}'.format(**ext))

    # Check against the rover's own elevations at a few stops (meters above the MOLA areoid).
    checks = [waypoints[0], waypoints[len(waypoints) // 2], waypoints[-1]]
    for p in checks:
        col, row = ~geo * (p['lon'], p['lat'])
        got = z[int(row), int(col)]
        print(f"  check sol {p['sol']}: DEM {got:.1f} m vs rover {p['elev_geoid']:.1f} m")
        if not abs(got - p['elev_geoid']) <= 25:
            raise SystemExit('Elevation check failed; georeferencing or datum is off.')

    slope = slope_degrees(z, lat_rows, PIXEL_M)
    print(f'  elevation {np.nanmin(z):.0f}..{np.nanmax(z):.0f} m; '
          f'slope median {np.nanmedian(slope):.1f} deg, 99th pct {np.nanpercentile(slope, 99):.1f} deg')
    OUT.mkdir(parents=True, exist_ok=True)
    write_cog(OUT / 'gale_dem_20m.tif', z, geo, 'Elevation (m), USGS MSL Gale merged DEM, averaged to 20 m')
    write_cog(OUT / 'gale_slope_20m.tif', slope, geo, 'Slope (degrees), Horn method on the 20 m Gale DEM')
    return {k: round(v, 6) for k, v in ext.items()}


# ---------- Rover ----------

def build_rover(traverse, waypoints) -> None:
    def rnd(c):
        return [round(c[0], 7), round(c[1], 7)]

    lines = []
    for f in traverse['features']:
        g = f['geometry']
        parts = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        for part in parts:
            pts = []
            for c in part:
                c = rnd(c)
                if not pts or pts[-1] != c:
                    pts.append(c)
            if len(pts) >= 2:
                lines.append({'type': 'Feature', 'properties': {}, 'geometry': {'type': 'LineString', 'coordinates': pts}})
    points = [{'type': 'Feature', 'properties': {'sol': p['sol'], 'elev': round(p['elev_geoid'], 1)},
               'geometry': {'type': 'Point', 'coordinates': [round(p['lon'], 7), round(p['lat'], 7)]}}
              for p in waypoints]
    for name, feats in [('msl_traverse.geojson', lines), ('msl_waypoints.geojson', points)]:
        path = OUT / name
        path.write_text(json.dumps({'type': 'FeatureCollection', 'name': name[:-8], 'features': feats}, separators=(',', ':')))
        print(f'  wrote {path.relative_to(ROOT)} ({len(feats)} features, {path.stat().st_size / 1e6:.2f} MB)')


# ---------- RAD ----------

def rad_files() -> dict[int, str]:
    """Sol -> RAD RDR data file path, from the archive index."""
    index = fetch(f'{RAD}/INDEX/INDEX.TAB', CACHE / 'rad_index.tab').read_text()
    files: dict[int, str] = {}
    for m in re.finditer(r'"(/DATA/SOL_[^"]+/RAD_RDR_\d{4}_\d{3}_\d\d_\d\d_(\d{4,5})_V\d\d)\.LBL"', index):
        files.setdefault(int(m[2]), m[1])  # first file of a sol
    return files


def rad_sol(sol: int, path: str):
    label = fetch(f'{RAD}{path}.LBL', CACHE / 'rad' / f'{sol}.lbl').read_text(errors='replace')
    ptr = lambda name: {int(m[1]): int(m[2]) for m in re.finditer(rf'\^OBS(\d+)_{name}\s*=\s*\(\s*"[^"]+"\s*,\s*(\d+)\s*<BYTES>\)', label)}
    l1, b, e = ptr('L1_TABLE'), ptr('TOT_DOSE_B_ELEMENT'), ptr('TOT_DOSE_E_ELEMENT')
    obs = sorted(set(l1) & set(b) & set(e))
    if not obs:
        return None
    spans = []
    for o in obs:  # offsets are 1-based
        spans += [(max(0, l1[o] - 800), l1[o] - 1), (b[o] - 1, b[o] + 14), (e[o] - 1, e[o] + 14)]
    parts = ranges(f'{RAD}{path}.TXT', spans)
    num = lambda s: float(s.split()[0]) if s.split() else math.nan
    rows = []
    for i in range(len(obs)):
        head, vb, ve = (p.decode(errors='replace') for p in parts[3 * i:3 * i + 3])
        d = re.findall(r'OBS_DURATION=(\d+)', head)
        t = re.findall(r'START_OBS_UTC="?(\d{4})-(\d{3}) (\d\d):(\d\d):(\d\d)', head)
        start = None
        if t:
            y, doy, hh, mm, ss = map(int, t[-1])
            start = ((y * 400 + doy) * 24 + hh) * 3600 + mm * 60 + ss  # only differences are used
        rows.append((float(d[-1]) if d else None, start, num(vb), num(ve)))
    # Early files have no OBS_DURATION: use the time to the next observation (at most an hour).
    for i, (dur, start, rb, re_) in enumerate(rows):
        if dur is None and start is not None and i + 1 < len(rows) and rows[i + 1][1] is not None:
            rows[i] = (min(3600.0, max(0.0, rows[i + 1][1] - start)), start, rb, re_)
    known = [r[0] for r in rows if r[0]]
    typical = statistics.median(known) if known else math.nan
    secs = sb = se = 0.0
    for dur, _, rb, re_ in rows:
        dur = dur if dur else typical
        if not (dur > 0 and rb > 0 and re_ > 0):
            continue
        secs += dur
        sb += rb * dur
        se += re_ * dur
    if secs < 6 * 3600:  # less than a quarter of the sol observed: skip
        return None
    return {'sol': sol, 'hours': round(secs / 3600, 1), 'doseB': round(sb / secs, 3), 'doseE': round(se / secs, 3)}


# ---------- REMS ----------

# Columns of the RNV table. Air: boom 1 (boom 2's sensor reads too cold at night), boom 2 where boom 1 has no value.
REMS_COLS = {'ground': 17, 'air': 27, 'air2': 34, 'uv': 44, 'pressure': 66}
REC = 659  # bytes per record of the RNV table (from its label)


def rems_sol(sol: int, folders: list[tuple[int, int, str]]):
    folder = next((f for a, z, f in folders if a <= sol <= z), None)
    if not folder:
        return None
    base = f'{REMS}/{folder}/SOL{sol:05d}/'
    try:
        listing = get(base, timeout=60).decode(errors='replace')
    except Exception:
        return None
    names = sorted(set(re.findall(r'RME_\d+RNV\d+_+P\d\.TAB', listing)))
    if not names:
        return None
    url = base + names[-1]
    xml = get(url[:-4] + '.xml', timeout=60).decode(errors='replace')
    n = int(re.search(r'<records>(\d+)</records>', xml)[1])
    if int(re.search(r'<record_length unit="byte">(\d+)', xml)[1]) != REC:
        raise SystemExit(f'REMS sol {sol}: record length changed')
    rows = sorted({int(i * (n - 1) / (REMS_ROWS - 1)) for i in range(REMS_ROWS)})
    vals = {k: [] for k in REMS_COLS if k != 'air2'}
    for part in ranges(url, [(r * REC, r * REC + REC - 1) for r in rows]):
        f = part.decode(errors='replace').split(',')
        if len(f) < 70:
            continue
        def val(i):
            try:
                v = float(f[i])
            except ValueError:
                return None
            return v if v > -900 else None
        for k in vals:
            v = val(REMS_COLS[k])
            if k == 'air' and v is None:
                v = val(REMS_COLS['air2'])
            if v is not None:
                vals[k].append(v)
    if len(vals['air']) < 50 or len(vals['pressure']) < 5:  # pressure is only logged on some rows
        return None
    q = lambda a, p: float(np.percentile(a, p))
    return {
        'sol': sol,
        'airMinC': round(q(vals['air'], 2) - 273.15, 1),
        'airMaxC': round(q(vals['air'], 98) - 273.15, 1),
        'rows': len(vals['air']),
        'groundMinC': round(q(vals['ground'], 2) - 273.15, 1) if vals['ground'] else None,
        'groundMaxC': round(q(vals['ground'], 98) - 273.15, 1) if vals['ground'] else None,
        'uvMaxW': round(q(vals['uv'], 98), 2) if vals['uv'] else None,
        'pressurePa': round(statistics.median(vals['pressure']), 1),
    }


def rems_folders() -> list[tuple[int, int, str]]:
    listing = get(REMS + '/', timeout=60).decode(errors='replace')
    return [(int(a), int(z), f'SOL_{a}_{z}') for a, z in sorted(set(re.findall(r'SOL_(\d{5})_(\d{5})/', listing)))]  # names keep their zero padding


def build_environment(waypoints) -> None:
    files = rad_files()
    sols = sorted(files)
    wanted = [s for s in range(sols[0], sols[-1] + 1, SOL_STEP)]
    picked = [min(sols, key=lambda s: abs(s - w)) for w in wanted]
    picked = sorted(set(picked))
    print(f'  RAD: {len(files)} sols archived ({sols[0]}..{sols[-1]}); reading {len(picked)}')
    folders = rems_folders()
    with cf.ThreadPoolExecutor(4) as pool:
        rad = [r for r in pool.map(lambda s: _safe(rad_sol, s, files[s]), picked) if r]
        rems = [r for r in pool.map(lambda s: _safe(rems_sol, s, folders), picked) if r]
    # Rover elevation on each sol: the last stop at or before it.
    wsol = [p['sol'] for p in waypoints]
    elev = lambda s: round(waypoints[max(0, bisect.bisect_right(wsol, s) - 1)]['elev_geoid'], 1)
    for r in rad + rems:
        r['elev'] = elev(r['sol'])
    print(f'  RAD: {len(rad)} sols with dose; REMS: {len(rems)} sols with weather')

    med = lambda a: round(statistics.median(a), 3)
    e = [r['doseE'] for r in rad]
    summary = {
        'rad': {'sols': len(rad), 'firstSol': rad[0]['sol'], 'lastSol': rad[-1]['sol'],
                'doseE_uGyPerH': {'median': med(e), 'min': min(e), 'max': max(e)},
                'doseB_uGyPerH': {'median': med([r['doseB'] for r in rad])}},
        'rems': {'sols': len(rems), 'firstSol': rems[0]['sol'], 'lastSol': rems[-1]['sol'],
                 **{k: {'median': med([r[k] for r in rems if r[k] is not None]),
                        'min': min(r[k] for r in rems if r[k] is not None),
                        'max': max(r[k] for r in rems if r[k] is not None)}
                    for k in ['airMinC', 'airMaxC', 'groundMinC', 'groundMaxC', 'uvMaxW', 'pressurePa']}},
    }
    print('  RAD tissue dose (E) median {median} µGy/h, range {min}..{max}'.format(**summary['rad']['doseE_uGyPerH']))
    out = {
        'about': 'Curiosity at Gale Crater, one sol every %d. RAD: duration-weighted mean total dose per sol (µGy/h). '
                 'REMS: from %d evenly spaced rows of the ENV table per sol (2nd/98th percentiles for min/max). '
                 'elev = rover elevation (m, MOLA areoid) on that sol.' % (SOL_STEP, REMS_ROWS),
        'sources': {'RAD': RAD, 'REMS': REMS},
        'summary': summary, 'rad': rad, 'rems': rems,
    }
    path = OUT / 'msl_environment.json'
    path.write_text(json.dumps(out, separators=(',', ':')))
    print(f'  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.0f} kB)')


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception as err:  # one bad sol must not stop the build
        print(f'  skipped sol {args[0]}: {err}')
        return None


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--only', choices=['rasters', 'rover', 'environment'])
    args = p.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    traverse = json.loads(fetch(TRAVERSE_URL, CACHE / 'MSL_traverse.json').read_text())
    waypoints = sorted((f['properties'] for f in json.loads(fetch(WAYPOINTS_URL, CACHE / 'MSL_waypoints.json').read_text())['features']),
                       key=lambda p: (p['sol'], p['dist_total_m']))
    if args.only in (None, 'rasters'):
        print('Rasters:')
        print('  GALE_DTM_EXTENT =', build_rasters(waypoints))
    if args.only in (None, 'rover'):
        print('Rover:')
        build_rover(traverse, waypoints)
    if args.only in (None, 'environment'):
        print('RAD and REMS:')
        build_environment(waypoints)
