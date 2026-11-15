#!/usr/bin/env python3
"""Builds public/data/jezero/m20_weather.json: the weather Perseverance's MEDA measured at Jezero.

    python3 scripts/build_jezero_weather.py

Source (NASA only): NASA PDS Atmospheres Node, Mars 2020 MEDA bundle (mars2020_meda), one folder per sol:
  air      calibrated ATS: ATS_LOCAL_TEMP1-3, the three air temperature sensors on the mast booms (K)
  ground   calibrated TIRS: GROUND_TEMP, ground brightness temperature (K)
  pressure derived PS: PRESSURE (Pa)
  wind     derived WS: HORIZONTAL_WIND_SPEED (m/s), only while the rover stands still (ROVER_STILL = 1)

Same method as REMS at Gale (scripts/build_gale_layers.py), so the two sites compare:
  - One sol every SOL_STEP (the nearest archived sol).
  - Each file is a few MB at 1 row per second, so only SLICES short byte ranges spread over the file are read.
  - Daily low and high = 2nd and 98th percentile of the sol's readings (robust to single spikes).
  - The summary gives the median over the sols, and the lowest and highest sol.
"""
from __future__ import annotations

import json
import re
import statistics
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'jezero' / 'm20_weather.json'
CACHE = ROOT / 'scripts' / '.cache' / 'meda_weather'

MEDA = 'https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda'
SOL_STEP = 40
SLICES = 240  # byte ranges read per file
SLICE_BYTES = 400  # a few rows each; only whole rows are kept
BATCH = 60  # ranges per request (servers cap multipart ranges)

# product: (level, file type, columns, valid range)
PRODUCTS = {
    'air': ('calibrated', 'ATS', ['ATS_LOCAL_TEMP1', 'ATS_LOCAL_TEMP2', 'ATS_LOCAL_TEMP3'], (120, 320)),
    'ground': ('calibrated', 'TIRS', ['GROUND_TEMP'], (120, 330)),
    'pressure': ('derived', 'PS', ['PRESSURE'], (300, 1500)),
    'wind': ('derived', 'WS', ['HORIZONTAL_WIND_SPEED'], (0, 60)),
}


def get(url: str, ranges: list[tuple[int, int]] | None = None, method: str = 'GET') -> tuple[bytes, dict]:
    req = urllib.request.Request(url, method=method, headers={'User-Agent': 'solmap-build'})
    if ranges:
        req.add_header('Range', 'bytes=' + ','.join(f'{a}-{b}' for a, b in ranges))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read(), dict(r.headers)
        except Exception:
            if attempt == 3:
                raise
    raise RuntimeError


def parts(body: bytes, headers: dict) -> list[bytes]:
    """Data of each part of a 206 response, single or multipart."""
    ctype = headers.get('Content-Type', '')
    if 'multipart/byteranges' not in ctype:
        return [body]
    boundary = ctype.split('boundary=')[1].strip('"').encode()
    out = []
    for chunk in body.split(b'--' + boundary):
        head, sep, data = chunk.partition(b'\r\n\r\n')
        m = re.search(rb'(?i:Content-Range): bytes (\d+)-(\d+)', head)
        if sep and m:
            out.append(data[: int(m.group(2)) - int(m.group(1)) + 1])
    return out


def folders(level: str) -> list[tuple[int, int, str]]:
    html = get(f'{MEDA}/data_{level}_env/')[0].decode(errors='replace')
    return [(int(a), int(b), f'sol_{a}_{b}') for a, b in sorted(set(re.findall(r'sol_(\d{4})_(\d{4})/', html)))]


def sol_files(sol: int, level: str, folder_list) -> dict[str, str]:
    """{file type: URL of its newest revision} for one sol."""
    folder = next((f for a, b, f in folder_list if a <= sol <= b), None)
    if not folder:
        return {}
    base = f'{MEDA}/data_{level}_env/{folder}/sol_{sol:04d}/'
    try:
        html = get(base)[0].decode(errors='replace')
    except Exception:
        return {}
    newest: dict[str, tuple[int, str]] = {}
    for name in set(re.findall(r'WE__\d{4}_+(?:CAL|DER)_([A-Z]+)_+P(\d+)\.CSV', html)):
        kind, rev = name
        if kind not in newest or int(rev) > newest[kind][0]:
            newest[kind] = (int(rev), '')
    for full in set(re.findall(r'WE__\d{4}_+(?:CAL|DER)_[A-Z]+_+P\d+\.CSV', html)):
        kind, rev = re.search(r'_(?:CAL|DER)_([A-Z]+)_+P(\d+)\.CSV', full).groups()
        if newest[kind][0] == int(rev):
            newest[kind] = (int(rev), base + full)
    return {k: url for k, (_, url) in newest.items()}


def sample(url: str, columns: list[str], valid: tuple[float, float], still_only: bool) -> list[float]:
    """Values of `columns` (the median across them per row) from SLICES rows spread over the file."""
    head, h = get(url, [(0, 2000)])
    size = int(h['Content-Range'].split('/')[1])
    header = head.decode(errors='replace').splitlines()[0].split(',')
    idx = [header.index(c) for c in columns]
    still = header.index('ROVER_STILL') if still_only else None
    step = size // SLICES
    spans = [(k * step, min(size - 1, k * step + SLICE_BYTES)) for k in range(1, SLICES)]
    values = []
    for i in range(0, len(spans), BATCH):
        for data in parts(*get(url, spans[i: i + BATCH])):
            lines = data.decode(errors='replace').split('\n')[1:-1]  # the first and last lines are cut
            for line in lines:
                row = line.strip().split(',')
                if len(row) != len(header):
                    continue
                if still is not None and row[still].strip() != '1':
                    continue
                vals = []
                for j in idx:
                    try:
                        v = float(row[j])
                    except ValueError:
                        continue
                    if valid[0] <= v <= valid[1]:
                        vals.append(v)
                if vals:
                    values.append(statistics.median(vals))
    return values


def sol_weather(sol: int, folder_lists) -> dict | None:
    cache = CACHE / f'sol_{sol:04d}.json'
    if cache.exists():
        return json.loads(cache.read_text()) or None
    files = {level: sol_files(sol, level, folder_lists[level]) for level in ('calibrated', 'derived')}
    vals = {}
    for key, (level, kind, cols, valid) in PRODUCTS.items():
        url = files[level].get(kind)
        try:
            vals[key] = sample(url, cols, valid, key == 'wind') if url else []
        except Exception as e:  # noqa: BLE001 - the sol just lacks this sensor
            print(f'  sol {sol} {kind}: {e}')
            vals[key] = []
    q = lambda a, p: round(float(np.percentile(a, p)), 1)
    c = lambda a, p: round(float(np.percentile(a, p)) - 273.15, 1)
    result = None
    if len(vals['air']) >= 50:
        result = {
            'sol': sol,
            'airMinC': c(vals['air'], 2),
            'airMaxC': c(vals['air'], 98),
            'groundMinC': c(vals['ground'], 2) if len(vals['ground']) >= 50 else None,
            'groundMaxC': c(vals['ground'], 98) if len(vals['ground']) >= 50 else None,
            'pressurePa': round(statistics.median(vals['pressure']), 1) if len(vals['pressure']) >= 20 else None,
            'windMs': q(vals['wind'], 50) if len(vals['wind']) >= 20 else None,
            'windMaxMs': q(vals['wind'], 98) if len(vals['wind']) >= 20 else None,
        }
    CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(result))
    return result


def main() -> None:
    folder_lists = {level: folders(level) for level in ('calibrated', 'derived')}
    last = folder_lists['calibrated'][-1][1]
    wanted = list(range(SOL_STEP // 2, last + 1, SOL_STEP))
    print(f'MEDA: sols 0-{last}; reading {len(wanted)} sols')

    def nearest(s):
        # The planned sol, or the next one or two if MEDA has no air data that sol.
        for t in (s, s + 1, s - 1, s + 2, s - 2):
            r = sol_weather(t, folder_lists)
            if r:
                return r
        return None

    with ThreadPoolExecutor(6) as pool:
        rows = [r for r in pool.map(nearest, wanted) if r]
    print(f'{len(rows)} sols with weather')

    def stat(k):
        a = [r[k] for r in rows if r[k] is not None]
        return {'median': round(statistics.median(a), 1), 'min': min(a), 'max': max(a), 'sols': len(a)}

    keys = ['airMinC', 'airMaxC', 'groundMinC', 'groundMaxC', 'pressurePa', 'windMs', 'windMaxMs']
    out = {
        'about': f'Perseverance at Jezero Crater, one sol every {SOL_STEP}. MEDA: {SLICES} slices of each file per sol; '
                 'daily low/high = 2nd/98th percentile; air = median of the 3 mast-boom ATS sensors; '
                 'wind only while the rover stood still.',
        'sources': {'MEDA': MEDA},
        'summary': {'weather': {'instrument': 'MEDA', 'sols': len(rows), 'firstSol': rows[0]['sol'], 'lastSol': rows[-1]['sol'],
                                **{k: stat(k) for k in keys}}},
        'weather': rows,
    }
    OUT.write_text(json.dumps(out, separators=(',', ':')))
    s = out['summary']['weather']
    print(f"wrote {OUT.relative_to(ROOT)}: air {s['airMinC']['median']} to {s['airMaxC']['median']} C, "
          f"ground {s['groundMinC']['median']} to {s['groundMaxC']['median']} C, {s['pressurePa']['median']} Pa, "
          f"wind {s['windMs']['median']} m/s")


if __name__ == '__main__':
    main()
