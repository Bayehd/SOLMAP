#!/usr/bin/env python3
"""Cut MOLA elevation windows for each site in src/mars/sites.ts.

Source: MGS MOLA MEGDR, 128 pixels/degree (~463 m/pixel) topography tiles
(MEGT*.IMG, signed 16-bit big-endian meters above the areoid) from the NASA PDS
Geosciences Node. Only the rows each window needs are downloaded (HTTP range
requests). To work offline, download the tiles yourself and pass --tiles DIR.

Writes, per site:
  public/data/sites/{id}.bin   Float32 little-endian, row-major, north row first, meters
  public/data/manifest.json    one entry per site (bounds are edge-sample centers)

Usage:
  python3 scripts/build_mola_sites.py               # all sites, download from PDS
  python3 scripts/build_mola_sites.py --tiles DIR   # read MEGT*.IMG files from DIR
  python3 scripts/build_mola_sites.py gale-crater   # only some sites
"""
import argparse
import json
import math
import re
import sys
import urllib.request
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITES_TS = ROOT / "src/mars/sites.ts"
OUT_DIR = ROOT / "public/data/sites"
MANIFEST = ROOT / "public/data/manifest.json"
PDS_BASE = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128"

RES = 128  # pixels per degree
TILE_W, TILE_H = 90 * RES, 44 * RES  # 11520 x 5632 samples, int16
ROW_BYTES = TILE_W * 2
MARS_RADIUS_KM = 3396.0
KM_PER_DEG = MARS_RADIUS_KM * math.pi / 180
MARGIN = 1.25  # window extends 25% past the patch edge, plus 2 pixels
DATASET_MAX_M = 21249  # highest MOLA value in the whole dataset (Olympus Mons), from the MEGT labels

# Latitude bands of the 128 px/deg tiles: (north edge, south edge, name part)
BANDS = [(88, 44, "88n"), (44, 0, "44n"), (0, -44, "00n"), (-44, -88, "44s")]


def read_sites():
    """Pull id, name, lat, lon and patchSizeKm out of each object in sites.ts."""
    text = SITES_TS.read_text()
    text = re.sub(r"\broverStart:\s*\{[^{}]*\},?", "", text)  # nested object; not needed here
    sites = []
    for block in re.findall(r"\{[^{}]*\bid:\s*'[^']+'[^{}]*\}", text):
        def field(name, pattern=r"(-?[\d.]+)"):
            m = re.search(rf"\b{name}:\s*{pattern}", block)
            if not m:
                sys.exit(f"Could not read '{name}' from a site in {SITES_TS}:\n{block}")
            return m.group(1)
        sites.append({
            "id": field("id", r"'([^']+)'"),
            "name": field("name", r"'([^']+)'"),
            "lat": float(field("lat")),
            "lon": float(field("lon")) % 360,
            "patchSizeKm": float(field("patchSizeKm")),
        })
    if not sites:
        sys.exit(f"No sites found in {SITES_TS}")
    return sites


def plan_window(site):
    """Rows/columns of the tile to cut, so the window covers the patch plus a margin."""
    half_km = site["patchSizeKm"] / 2 * MARGIN
    half_lat = half_km / KM_PER_DEG + 2 / RES
    north, south = site["lat"] + half_lat, site["lat"] - half_lat
    half_lon = half_lat / math.cos(math.radians(max(abs(north), abs(south))))
    west, east = site["lon"] - half_lon, site["lon"] + half_lon

    band = next((b for b in BANDS if b[1] <= site["lat"] < b[0]), None)
    tile_west = math.floor(site["lon"] / 90) * 90
    if band is None or north > band[0] or south < band[1] or west < tile_west or east > tile_west + 90:
        sys.exit(f"{site['name']}: window {south:.2f}..{north:.2f}N, {west:.2f}..{east:.2f}E crosses a tile edge; "
                 "this script only cuts from a single tile.")
    tile_north = band[0]
    # Row r has its center at tile_north - (r + 0.5) / RES (LINE_PROJECTION_OFFSET in the label).
    r0 = math.floor((tile_north - north) * RES)
    r1 = math.ceil((tile_north - south) * RES) - 1
    c0 = math.floor((west - tile_west) * RES)
    c1 = math.ceil((east - tile_west) * RES) - 1
    return {
        "tile": f"megt{band[2]}{tile_west:03d}hb.img",
        "r0": r0, "r1": r1, "c0": c0, "c1": c1,
        "maxLat": tile_north - (r0 + 0.5) / RES,
        "minLat": tile_north - (r1 + 0.5) / RES,
        "minLon": tile_west + (c0 + 0.5) / RES,
        "maxLon": tile_west + (c1 + 0.5) / RES,
    }


def read_rows(tile, r0, r1, tiles_dir):
    start, end = r0 * ROW_BYTES, (r1 + 1) * ROW_BYTES
    if tiles_dir:
        path = next((p for p in Path(tiles_dir).iterdir() if p.name.lower() == tile), None)
        if not path:
            sys.exit(f"{tile} not found in {tiles_dir}. Download it from {PDS_BASE}/{tile}")
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read(end - start)
    else:
        url = f"{PDS_BASE}/{tile}"
        print(f"  downloading {(end - start) / 1e6:.1f} MB of {tile} …", flush=True)
        req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end - 1}", "User-Agent": "mola-site-builder"})
        with urllib.request.urlopen(req, timeout=300) as res:
            if res.status != 206:
                sys.exit(f"{url}: expected a partial response (206), got {res.status}")
            data = res.read()
    if len(data) != end - start:
        sys.exit(f"{tile}: got {len(data)} bytes, expected {end - start}")
    return data


def build_site(site, tiles_dir):
    w = plan_window(site)
    raw = array("h")
    raw.frombytes(read_rows(w["tile"], w["r0"], w["r1"], tiles_dir))
    if sys.byteorder == "little":
        raw.byteswap()  # MOLA is MSB_INTEGER

    width, height = w["c1"] - w["c0"] + 1, w["r1"] - w["r0"] + 1
    out = array("f")
    for r in range(height):
        row = r * TILE_W
        out.fromlist(raw[row + w["c0"]: row + w["c1"] + 1].tolist())
    if sys.byteorder != "little":
        out.byteswap()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{site['id']}.bin").write_bytes(out.tobytes())

    lo, hi = min(out), max(out)
    k = out.index(hi)
    peak_lat = w["maxLat"] - (k // width) / RES
    peak_lon = w["minLon"] + (k % width) / RES
    entry = {
        "id": site["id"],
        "width": width,
        "height": height,
        "minLat": round(w["minLat"], 6),
        "maxLat": round(w["maxLat"], 6),
        "minLon": round(w["minLon"], 6),
        "maxLon": round(w["maxLon"], 6),
        "minElevation": lo,
        "maxElevation": hi,
        "metersPerValue": 1,
        "source": f"MGS MOLA MEGDR 128 px/deg topography ({w['tile'].upper()}), NASA PDS Geosciences Node",
    }
    return entry, out, (peak_lat, peak_lon)


def great_circle_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * MARS_RADIUS_KM * math.asin(min(1, math.sqrt(a)))


def sample(entry, data, lat, lon):
    """Bilinear elevation (m) at lat/lon, same convention as sampleGrid in src/mars/mola.ts."""
    w, h = entry["width"], entry["height"]
    fx = (lon % 360 - entry["minLon"]) / (entry["maxLon"] - entry["minLon"]) * (w - 1)
    fy = (entry["maxLat"] - lat) / (entry["maxLat"] - entry["minLat"]) * (h - 1)
    if not (0 <= fx <= w - 1 and 0 <= fy <= h - 1):
        return math.nan
    x0, y0 = min(int(fx), w - 2), min(int(fy), h - 2)
    tx, ty = fx - x0, fy - y0
    g = lambda x, y: data[y * w + x]
    top = g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx
    bottom = g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx
    return top * (1 - ty) + bottom * ty


# Published reference values used as checks: (label, lat, lon, expected m, tolerance m).
# Landing-site elevations check both the geolocation and the datum.
POINT_CHECKS = {
    "jezero-crater": [("Perseverance landing site", 18.4447, 77.4508, -2570, 50)],
    "gale-crater": [("Curiosity landing site", -4.5895, 137.4417, -4501, 50)],
}
# The highest value in the whole MOLA dataset is the summit of Olympus Mons
# (often quoted as 21.9 km; this gridded product peaks at 21,249 m).
MAX_CHECKS = {"olympus-mons": (DATASET_MAX_M, 1)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="site ids to build (default: all)")
    ap.add_argument("--tiles", help="directory with MEGT*.IMG tiles, instead of downloading")
    args = ap.parse_args()

    all_sites = read_sites()
    unknown = set(args.ids) - {s["id"] for s in all_sites}
    if unknown:
        sys.exit(f"Unknown site id(s): {', '.join(sorted(unknown))}. Known: {', '.join(s['id'] for s in all_sites)}")
    sites = [s for s in all_sites if not args.ids or s["id"] in args.ids]
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    manifest.setdefault("sites", {})
    failed = 0

    for site in sites:
        print(f"{site['name']} ({site['id']})")
        entry, data, (plat, plon) = build_site(site, args.tiles)
        manifest["sites"][site["id"]] = entry
        dist = great_circle_km(site["lat"], site["lon"], plat, plon)
        print(f"  grid {entry['width']}×{entry['height']}, {entry['minLat']:.3f}..{entry['maxLat']:.3f}N, "
              f"{entry['minLon']:.3f}..{entry['maxLon']:.3f}E")
        print(f"  elevation {entry['minElevation']:.0f} .. {entry['maxElevation']:.0f} m; "
              f"highest point at {plat:.3f}N {plon:.3f}E, {dist:.1f} km from the site coordinates")
        for label, lat, lon, expected, tol in POINT_CHECKS.get(site["id"], []):
            v = sample(entry, data, lat, lon)
            ok = abs(v - expected) <= tol
            failed += not ok
            print(f"  {'PASS' if ok else 'FAIL'} {label} ({lat}, {lon}): {v:.0f} m, published {expected} m ±{tol}")
        if site["id"] in MAX_CHECKS:
            expected, tol = MAX_CHECKS[site["id"]]
            ok = abs(entry["maxElevation"] - expected) <= tol
            failed += not ok
            print(f"  {'PASS' if ok else 'FAIL'} highest point {entry['maxElevation']:.0f} m, "
                  f"MOLA dataset maximum {expected} m")

    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {MANIFEST.relative_to(ROOT)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
