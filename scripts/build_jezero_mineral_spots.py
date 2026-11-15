#!/usr/bin/env python3
"""Builds the Jezero mineral spots, public/data/jezero/crism_mineral_spots.geojson, from the CRISM mineral map.

    .venv/bin/python scripts/build_jezero_mineral_spots.py

Input: public/data/jezero/crism_minerals_20m.tif (scripts/build_jezero_minerals.py) and the Perseverance
traverse (public/data/jezero/m20_traverse.geojson).

For each mineral class, the connected patches of that class in the map (4-connected pixels). The spots are the
largest patches near the rover's route, a few per class, spread apart, so they can be seen while riding the
route. Each spot is placed on the patch pixel nearest the route.

ASSUMPTION: the patches are only as good as the mineral map, which is indicative (orbital CRISM detections,
thresholds chosen by hand, no ratioed spectra): a spot means "CRISM sees this mineral here", not a ground truth.
"""
import json
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public' / 'data' / 'jezero'
MINERALS = DATA / 'crism_minerals_20m.tif'
TRAVERSE = DATA / 'm20_traverse.geojson'
OUT = DATA / 'crism_mineral_spots.geojson'

# Same order as CLASSES in build_jezero_minerals.py and MINERAL_CLASSES in src/map/layers.ts (value = index + 1).
NAMES = ['Mg-carbonate', 'Fe/Mg clay (smectite)', 'Hydrated silica', 'Olivine', 'Pyroxene']
MIN_PIXELS = 25  # 0.01 km² at 20 m: smaller patches are mostly noise
MAX_ROUTE_DIST_M = 1500  # only patches this close to the route
PER_CLASS = 3  # spots per mineral, at most
MIN_SPACING_M = 1200  # between spots of the same mineral
METERS_PER_DEGREE = 3396190 * np.pi / 180  # Mars 2000 sphere


def components(mask: np.ndarray) -> list[np.ndarray]:
    """Connected pieces of a boolean mask (4-connected), each as an array of (row, col)."""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]:
            continue
        seen[r0, c0] = True
        stack, pix = [(r0, c0)], []
        while stack:
            r, c = stack.pop()
            pix.append((r, c))
            for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < h and 0 <= cc < w and mask[rr, cc] and not seen[rr, cc]:
                    seen[rr, cc] = True
                    stack.append((rr, cc))
        out.append(np.array(pix))
    return out


def route_points() -> np.ndarray:
    g = json.loads(TRAVERSE.read_text())
    pts = []
    for f in g['features']:
        geom = f['geometry']
        lines = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
        for line in lines:
            pts.extend(line)
    return np.array(pts)[:, :2]


def main() -> None:
    with rasterio.open(MINERALS) as src:
        cls = src.read(1)
        t = src.transform
    route = route_points()[::3]  # every third vertex: still a few meters apart
    lat0 = route[:, 1].mean()
    mx = METERS_PER_DEGREE * np.cos(np.radians(lat0))
    rx, ry = route[:, 0] * mx, route[:, 1] * METERS_PER_DEGREE

    features = []
    for value, name in enumerate(NAMES, start=1):
        candidates = []
        for pix in components(cls == value):
            if len(pix) < MIN_PIXELS:
                continue
            lon = t.c + (pix[:, 1] + 0.5) * t.a
            lat = t.f + (pix[:, 0] + 0.5) * t.e
            # Nearest patch pixel to the route (checked on a subsample of big patches, then refined around it).
            step = max(1, len(pix) // 400)
            px, py = lon[::step] * mx, lat[::step] * METERS_PER_DEGREE
            d = np.hypot(px[:, None] - rx[None, :], py[:, None] - ry[None, :]).min(axis=1)
            k = int(d.argmin()) * step
            if d.min() > MAX_ROUTE_DIST_M:
                continue
            candidates.append({'lon': float(lon[k]), 'lat': float(lat[k]), 'px': len(pix), 'dist': float(d.min())})
        chosen = []
        for c in sorted(candidates, key=lambda c: -c['px']):
            if len(chosen) == PER_CLASS:
                break
            if any(np.hypot((c['lon'] - o['lon']) * mx, (c['lat'] - o['lat']) * METERS_PER_DEGREE) < MIN_SPACING_M for o in chosen):
                continue
            chosen.append(c)
        for c in chosen:
            features.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [round(c['lon'], 6), round(c['lat'], 6)]},
                'properties': {
                    'mineral': name,
                    'class': value,
                    'area_km2': round(c['px'] * abs(t.a * t.e) * mx * METERS_PER_DEGREE / 1e6, 3),
                    'route_dist_m': round(c['dist']),
                },
            })
        print(f'{name}: {len(candidates)} patches near the route, {len(chosen)} spots')
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'name': 'crism_mineral_spots', 'features': features}))
    print('wrote', OUT.relative_to(ROOT), len(features), 'spots')


if __name__ == '__main__':
    main()
