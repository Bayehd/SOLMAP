#!/usr/bin/env python3
"""Builds public/data/gale/msl_rad.geojson: the radiation dose Curiosity's RAD measured at each place it stopped.

    python3 scripts/build_gale_rad.py

Sources (NASA only):
  Dose: NASA PDS PPI Node, MSL Radiation Assessment Detector RDR (MSL-M-RAD-3-RDR-V1.0), one file per sol.
        Each observation (about every 30 min) holds the dosimetry Total Dose B (silicon detector) and
        Total Dose E (plastic scintillator, closer to human tissue) in microGray per hour.
  Positions: NASA/JPL MSL MMGIS waypoint layer (Curiosity's end-of-drive positions with the sol).

Cleaning:
  - Each sol file is about 20 MB, so the script reads only the dose values: it fetches a few slices of each label
    (spread over the sol), takes the byte offsets of the dose values listed there and fetches just those bytes.
  - Values that are not positive or above 1000 microGray/hour (fill values, glitches) are dropped.
  - A sol's dose is the median of its observations (robust to single spikes), times 24 for a per-day rate.
  - Each stop gets the mean of the sols between arriving there and the next drive. Stops RAD didn't cover are left out.
"""
from __future__ import annotations

import json
import re
import statistics
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'gale' / 'msl_rad.geojson'
CACHE = ROOT / 'scripts' / '.cache' / 'rad'

RDR = 'https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA/'
WAYPOINTS_URL = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json'

LABEL_SLICES = 6  # label slices read per sol, spread over the day
SLICE_BYTES = 12000  # one observation's label block is about 9 KB, so each slice holds at least one dose pointer
MAX_UGY_H = 1000.0
POINTER = re.compile(r'\^OBS\d+_TOT_DOSE_([BE])_ELEMENT\s*=\s*\(\s*"[^"]+"\s*,\s*(\d+)\s*<BYTES>\)')


def get(url: str, ranges: list[tuple[int, int]] | None = None) -> tuple[bytes, dict]:
    req = urllib.request.Request(url, headers={'User-Agent': 'solmap-build'})
    if ranges:
        req.add_header('Range', 'bytes=' + ','.join(f'{a}-{b}' for a, b in ranges))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(), dict(r.headers)
        except Exception:
            if attempt == 3:
                raise
    raise RuntimeError


def parts(body: bytes, headers: dict) -> list[tuple[int, bytes]]:
    """(start byte, data) of each part of a 206 response, single or multipart."""
    ctype = headers.get('Content-Type', '')
    if 'multipart/byteranges' not in ctype:
        m = re.match(r'bytes (\d+)-', headers.get('Content-Range', ''))
        return [(int(m.group(1)) if m else 0, body)]
    boundary = ctype.split('boundary=')[1].strip('"').encode()
    out = []
    for chunk in body.split(b'--' + boundary):
        head, sep, data = chunk.partition(b'\r\n\r\n')
        m = re.search(rb'(?i:Content-Range): bytes (\d+)-(\d+)', head)
        if sep and m:
            out.append((int(m.group(1)), data[: int(m.group(2)) - int(m.group(1)) + 1]))
    return out


def list_sols() -> dict[int, str]:
    html = get(RDR)[0].decode()
    sols = {}
    for d in sorted(set(re.findall(r'href="(SOL_\d+_\d+/)"', html))):
        for name in set(re.findall(r'(RAD_RDR_\d{4}_\d{3}_\d\d_\d\d_(\d+)_V\d+)\.LBL', get(RDR + d)[0].decode())):
            sols[int(name[1])] = RDR + d + name[0]  # a later version of the same sol replaces an earlier one
    return sols


def sol_dose(sol: int, base: str) -> dict | None:
    cache = CACHE / f'sol_{sol:05d}.json'
    if cache.exists():
        return json.loads(cache.read_text())
    body, h = get(base + '.LBL', [(0, SLICE_BYTES - 1)])
    size = int(h['Content-Range'].split('/')[1])
    step = size // LABEL_SLICES
    text = body.decode('latin-1')
    more = [(k * step, k * step + SLICE_BYTES - 1) for k in range(1, LABEL_SLICES)]
    for _, data in parts(*get(base + '.LBL', more)):
        text += '\n' + data.decode('latin-1')
    pointers = sorted({(kind, int(off)) for kind, off in POINTER.findall(text)}, key=lambda p: p[1])
    values: dict[str, list[float]] = {'B': [], 'E': []}
    if pointers:
        offsets = {off - 1: kind for kind, off in pointers}  # PDS byte offsets are 1-based
        for start, data in parts(*get(base + '.TXT', [(o, o + 15) for o in offsets])):
            kind = offsets.get(start)
            m = re.match(rb'\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)', data)
            if kind and m:
                v = float(m.group(1))
                if 0 < v <= MAX_UGY_H:
                    values[kind].append(v)
    result = {k: (round(statistics.median(v) * 24, 1) if v else None) for k, v in values.items()}
    result['n'] = len(values['B'])
    CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(result))
    return result


def main() -> None:
    sols = list_sols()
    print(f'RAD RDR: {len(sols)} sols, {min(sols)}-{max(sols)}')
    done = 0

    def work(item):
        nonlocal done
        sol, base = item
        try:
            r = sol_dose(sol, base)
        except Exception as e:  # noqa: BLE001 - keep going; the sol is just missing
            print(f'  sol {sol}: {e}', file=sys.stderr)
            r = None
        done += 1
        if done % 250 == 0:
            print(f'  {done}/{len(sols)}')
        return sol, r

    with ThreadPoolExecutor(16) as pool:
        daily = {s: r for s, r in pool.map(work, sorted(sols.items())) if r and r['B'] is not None}
    print(f'{len(daily)} sols with dose values')

    wps = sorted(json.loads(get(WAYPOINTS_URL)[0])['features'], key=lambda f: (f['properties']['sol'], f['properties']['drive']))
    features = []
    for i, f in enumerate(wps):
        p = f['properties']
        end = wps[i + 1]['properties']['sol'] if i + 1 < len(wps) else max(sols) + 1
        here = [daily[s] for s in range(p['sol'], end) if s in daily]
        if not here:
            continue
        e = [d['E'] for d in here if d['E'] is not None]
        features.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [round(p['lon'], 6), round(p['lat'], 6)]},
            'properties': {
                'sol_start': p['sol'],
                'sol_end': end - 1,
                'sols_measured': len(here),
                'dose_si': round(statistics.fmean(d['B'] for d in here), 1),
                'dose_plastic': round(statistics.fmean(e), 1) if e else None,
                'elevation_m': round(p['elev_geoid'], 1),
            },
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': features}, separators=(',', ':')))
    ds = [f['properties']['dose_si'] for f in features]
    print(f'wrote {OUT.relative_to(ROOT)}: {len(features)} stops, {min(ds)}-{max(ds)} microGray/day (silicon)')


if __name__ == '__main__':
    main()
