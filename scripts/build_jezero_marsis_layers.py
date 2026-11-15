#!/usr/bin/env python3
"""Build MARSIS ground-track and radar observation layers for SOLMAP/ArcGIS.

Uses NASA PDS4 *Optimized MARSIS Radargram Data* geometry tables (real data),
with optional derived ionospheric delay fields.

    python scripts/build_jezero_marsis_layers.py
    python scripts/build_jezero_marsis_layers.py --orbit 01867 --all-mars
    python scripts/build_jezero_marsis_layers.py --with-ionosphere

Outputs under public/data/jezero/:
    marsis_tracks.geojson        Ground-track segments within the chosen area
    marsis_frames.geojson        Frame footprint points with metadata
    marsis_frames.csv            Same frame measurements for ArcGIS XY Table To Point
    marsis_mars2000_sphere.prj   Mars geographic coordinate system
    marsis_metadata.json        Provenance and limitations

Notes:
- MARSIS geometry frames are footprints of ORBITAL sounding, not drill holes,
  ice confirmations, underground-cavity detections, or a 3D ground-penetration map.
- --with-ionosphere contains correction-derived parameters, not tested radio
  coverage or astronaut communications quality.
- Mars coordinates are in east-positive degrees; output uses -180..180 lon.
- GeoJSON is for SOLMAP's Mars-aware mapping system. In ArcGIS Pro import the
  CSV with XY Table To Point and explicitly assign GCS Mars 2000 Sphere (104971).

Sources:
https://pds-geosciences.wustl.edu/mex/urn-nasa-pds-mex_marsis_optim/
https://oderest.rsl.wustl.edu/ODE_REST_V2.1.6.pdf
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'jezero'
CACHE = ROOT / 'scripts' / '.cache' / 'marsis'
PDS_BASE = 'https://pds-geosciences.wustl.edu/mex/urn-nasa-pds-mex_marsis_optim/'
ODE_ENDPOINT = 'https://oderest.rsl.wustl.edu/live2'
SOURCE_PAGE = 'https://pds-geosciences.wustl.edu/missions/mars_express/marsis.htm'

# A regional search box around Jezero Crater; change with --bbox west south east north.
DEFAULT_BBOX = (75.5, 16.5, 80.0, 21.0)

GCS_MARS_2000_SPHERE = (
    'GEOGCS["GCS_Mars_2000_Sphere",DATUM["D_Mars_2000_Sphere",'
    'SPHEROID["Mars_2000_Sphere_IAU_IAG",3396190.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]'
)


@dataclass(frozen=True)
class Frame:
    orbit: str
    number: int
    utc: str
    lat: float
    lon: float
    altitude_km: float | None
    solar_zenith_deg: float | None
    channel_1_mhz: float | None
    channel_2_mhz: float | None
    ion_delay_1_us: float | None = None
    ion_delay_2_us: float | None = None


def download(url: str, path: Path, timeout: int = 90) -> Path:
    if path.exists() and path.stat().st_size:
        print(f'  cached {path.name}')
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.part')
    print(f'  downloading {url}')
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'SOLMAP-MARSIS-data-builder/1.0'})
            with urllib.request.urlopen(req, timeout=timeout) as response, temp.open('wb') as f:
                shutil.copyfileobj(response, f)
            temp.replace(path)
            return path
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            temp.unlink(missing_ok=True)
            if attempt == 2:
                raise RuntimeError(f'Failed to download {url}: {error}') from error
            time.sleep(attempt + 1)
    raise AssertionError('unreachable')


def orbit_id(value: Any) -> str:
    token = str(value).strip()
    if not token.isdigit() or not (1 <= len(token) <= 5):
        raise ValueError(f'Invalid orbit {value!r}; expected a number like 01867')
    return f'{int(token):05d}'


def orbit_group(orbit: str) -> str:
    return f'{orbit[:3]}xx'


def archive_url(collection: str, orbit: str, suffix: str | None = None) -> str:
    directory = f'{PDS_BASE}{collection}/{orbit_group(orbit)}/o_{orbit}/'
    return directory + (f'o_{orbit}_{suffix}.tab' if suffix else '')


def finite_number(value: str, lo: float, hi: float) -> float | None:
    try:
        result = float(value.strip())
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) and lo <= result <= hi else None


def lon180(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def inside(lon: float, lat: float, bbox: tuple[float, float, float, float]) -> bool:
    west, south, east, north = bbox
    return south <= lat <= north and west <= lon <= east


def parse_geometry_text(text: str, orbit: str) -> list[Frame]:
    """PDS4 geometry tables are CSV with NO header; consult archive Table 3.

    Ignore ephemeris time and spacecraft Cartesian fields; missing/flagged
    numbers there may be enormous and are not needed for geographic plotting.
    """
    rows: list[Frame] = []
    seen: set[int] = set()
    for fields in csv.reader(io.StringIO(text)):
        if len(fields) < 9:
            continue
        try:
            number = int(fields[0].strip())
        except ValueError:
            continue
        latitude = finite_number(fields[3], -90, 90)
        longitude = finite_number(fields[4], -360, 720)
        if latitude is None or longitude is None or number in seen:
            continue
        seen.add(number)
        rows.append(Frame(
            orbit=orbit, number=number, utc=fields[2].strip(),
            lat=latitude, lon=lon180(longitude),
            altitude_km=finite_number(fields[5], 0, 100000),
            solar_zenith_deg=finite_number(fields[6], 0, 180),
            channel_1_mhz=finite_number(fields[7], 0, 50),
            channel_2_mhz=finite_number(fields[8], 0, 50),
        ))
    return sorted(rows, key=lambda f: f.number)


def parse_ionosphere_text(text: str) -> dict[int, tuple[float | None, float | None]]:
    """MARSIS ionosphere Table 2: 10th and 11th columns are delay (microseconds).

    These are ionospheric correction estimates; do not equate them with
    astronaut-ground radio-link delays or Earth-Mars light time.
    """
    result: dict[int, tuple[float | None, float | None]] = {}
    for fields in csv.reader(io.StringIO(text)):
        if len(fields) < 11:
            continue
        try:
            frame = int(fields[0].strip())
        except ValueError:
            continue
        result[frame] = (
            finite_number(fields[9], -100000, 100000),
            finite_number(fields[10], -100000, 100000),
        )
    return result


def match_orbit(value: Any) -> str | None:
    """Recognize PDS4 o_12345_geom product names/URLs, never random numbers."""
    if not isinstance(value, str):
        return None
    for pattern in [r'(?i)o[_-](\d{5})[_-]geom', r'(?i)o[_-](\d{5})',
                    r'(?i)(?:^|[/\\:_-])(\d{5})[_-]geom(?:\.|:|$)']:
        hit = re.search(pattern, value)
        if hit:
            return hit.group(1)
    return None


def collect_ode_products(payload: Any) -> list[dict[str, Any]]:
    """Accept ODE's ODEResults/Products/Product wrappers and minor API variations."""
    if isinstance(payload, dict) and 'ODEResults' in payload:
        payload = payload['ODEResults']
    if isinstance(payload, dict) and str(payload.get('Status', 'Success')).lower() == 'error':
        raise RuntimeError(f"ODE error: {payload.get('Error') or payload.get('error')}")
    if isinstance(payload, dict):
        payload = payload.get('Products', payload.get('products', payload))
    if isinstance(payload, dict):
        payload = payload.get('Product', payload.get('product', []))
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def find_orbits_from_ode(payload: Any) -> list[str]:
    products = collect_ode_products(payload)
    orbits: set[str] = set()
    for product in products:
        # Prefer product-specific fields. Fallback to embedded product file paths.
        matched_this_product = False
        for key in ['pdsid', 'PDSID', 'Product_lid', 'ProductLid', 'ProductURL',
                    'LabelFileName', 'product_lid']:
            found = match_orbit(product.get(key))
            if found:
                orbits.add(found)
                matched_this_product = True
        if not matched_this_product:
            for item in product.values():
                for entry in strings_below(item):
                    found = match_orbit(entry)
                    if found:
                        orbits.add(found)
    return sorted(orbits)


def strings_below(item: Any):
    if isinstance(item, str):
        yield item
    elif isinstance(item, dict):
        for val in item.values():
            yield from strings_below(val)
    elif isinstance(item, list):
        for val in item:
            yield from strings_below(val)


def ode_query(bbox: tuple[float, float, float, float], max_products: int = 100,
              max_pages: int = 4) -> tuple[list[str], str, int]:
    """Search ODE for GEOM products by geographic footprint/bounding box.

    ODE might return false positives from bounding-box intersections; we clip
    the actual frame coordinates after downloading each geometry table.
    """
    west, south, east, north = bbox
    if west < 0 or east > 360:
        raise ValueError('ODE location search expects 0..360 east longitude; Jezero defaults are valid')
    params = dict(query='product', target='mars', ihid='MEX', iid='MARSIS', pt='GEOM',
                  results='op', output='JSON', loc='b', westernlon=f'{west:g}',
                  easternlon=f'{east:g}', minlat=f'{south:g}', maxlat=f'{north:g}',
                  limit=str(max_products))
    all_orbits: set[str] = set()
    pages = 0
    for page in range(max_pages):
        params['offset'] = str(page * max_products)
        url = ODE_ENDPOINT + '?' + urllib.parse.urlencode(params)
        print(f'  searching ODE, page {page + 1}: {url}')
        req = urllib.request.Request(url, headers={'User-Agent': 'SOLMAP-MARSIS-data-builder/1.0',
                                                  'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=100) as r:
            payload = json.load(r)
        products = collect_ode_products(payload)
        pages += 1
        all_orbits.update(find_orbits_from_ode(payload))
        print(f'  ODE page returned {len(products)} products; identified {len(all_orbits)} orbit(s)')
        if len(products) < max_products:
            break
    return sorted(all_orbits), url, pages


def read_orbit(orbit: str, include_ionosphere: bool) -> list[Frame]:
    geometry_file = download(archive_url('geometry', orbit, 'geom'),
                             CACHE / orbit_group(orbit) / f'o_{orbit}_geom.tab')
    frames = parse_geometry_text(geometry_file.read_text(encoding='utf-8', errors='replace'), orbit)
    if include_ionosphere:
        ion_file = download(archive_url('ionosphere_data', orbit, 'ionosphere'),
                            CACHE / orbit_group(orbit) / f'o_{orbit}_ionosphere.tab')
        ion = parse_ionosphere_text(ion_file.read_text(encoding='utf-8', errors='replace'))
        from dataclasses import replace
        frames = [replace(f, ion_delay_1_us=ion.get(f.number, (None, None))[0],
                          ion_delay_2_us=ion.get(f.number, (None, None))[1]) for f in frames]
    return frames


def folder_url(collection: str, orbit: str) -> str:
    return archive_url(collection, orbit)


def frame_properties(f: Frame) -> dict[str, Any]:
    return {
        'orbit': f.orbit, 'frame': f.number, 'utc': f.utc,
        'latitude_deg': round(f.lat, 6), 'longitude_deg': round(f.lon, 6),
        'altitude_km': f.altitude_km, 'solar_zenith_deg': f.solar_zenith_deg,
        'channel_1_mhz': f.channel_1_mhz, 'channel_2_mhz': f.channel_2_mhz,
        'ion_delay_1_us': f.ion_delay_1_us, 'ion_delay_2_us': f.ion_delay_2_us,
        'geometry_table_url': archive_url('geometry', f.orbit, 'geom'),
        'radargram_browse_folder': folder_url('browse', f.orbit),
        'radargram_images_folder': folder_url('radargram_image', f.orbit),
        'interpretation': 'Orbital radar footprint, NOT confirmed subsurface ice or a hazard'
    }


def feature_collection(features: list[dict[str, Any]], layer_name: str) -> dict[str, Any]:
    return {
        'type': 'FeatureCollection', 'name': layer_name,
        'properties': {
            'planet': 'Mars',
            'coordinate_note': ('Mars east-positive longitude/planetocentric-style latitude. '
                                'Use GCS Mars 2000 Sphere in ArcGIS; do not treat as Earth WGS84.'),
            'scientific_caution': ('MARSIS radar footprint geometry only: NOT subsurface ice '
                                   'detections, radar coverage footprints, or communication coverage.'),
        },
        'features': features,
    }


def geojson_point(f: Frame) -> dict[str, Any]:
    return {
        'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(f.lon, 7), round(f.lat, 7)]},
        'properties': frame_properties(f),
    }


def make_tracks(frames_by_orbit: dict[str, list[Frame]], bbox, all_mars=False) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    for orbit, all_frames in frames_by_orbit.items():
        segments: list[list[Frame]] = []
        segment: list[Frame] = []
        for f in all_frames:
            selected = all_mars or inside(f.lon, f.lat, bbox)
            # Break tracks across skipped frames, gaps or longitude-wrap discontinuities.
            sequential = (segment and f.number - segment[-1].number <= 3
                          and abs(f.lon - segment[-1].lon) < 30)
            if selected:
                if segment and not sequential:
                    if len(segment) >= 2:
                        segments.append(segment)
                    segment = []
                segment.append(f)
            elif segment:
                if len(segment) >= 2:
                    segments.append(segment)
                segment = []
        if len(segment) >= 2:
            segments.append(segment)
        for i, run in enumerate(segments):
            features.append({
                'type': 'Feature',
                'geometry': {'type': 'LineString',
                             'coordinates': [[round(f.lon, 7), round(f.lat, 7)] for f in run]},
                'properties': {
                    'orbit': orbit, 'segment': i + 1, 'frame_start': run[0].number,
                    'frame_end': run[-1].number, 'start_utc': run[0].utc, 'end_utc': run[-1].utc,
                    'frame_count': len(run),
                    'radargram_browse_folder': folder_url('browse', orbit),
                    'geometry_table_url': archive_url('geometry', orbit, 'geom'),
                    'kind': 'Nadir track of Mars Express MARSIS sounding frames',
                },
            })
    return features


def dump_json(filename: str, data: dict[str, Any]) -> None:
    target = OUT / filename
    target.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'  wrote {target.relative_to(ROOT)} ({target.stat().st_size / 1024:.1f} KB)')


def output_layers(frames_by_orbit, bbox, all_mars, stride, ode_search_url, requested_orbits,
                  include_ionosphere, failures):
    OUT.mkdir(parents=True, exist_ok=True)
    selected: list[Frame] = []
    for frames in frames_by_orbit.values():
        selected.extend(f for f in frames if all_mars or inside(f.lon, f.lat, bbox))
    selected.sort(key=lambda f: (f.orbit, f.number))
    visible = [f for i, f in enumerate(selected) if i % stride == 0]
    tracks = make_tracks(frames_by_orbit, bbox, all_mars=all_mars)
    dump_json('marsis_frames.geojson', feature_collection([geojson_point(f) for f in visible], 'marsis_frames'))
    dump_json('marsis_tracks.geojson', feature_collection(tracks, 'marsis_tracks'))
    headers = [
        'orbit', 'frame', 'utc', 'latitude_deg', 'longitude_deg', 'altitude_km',
        'solar_zenith_deg', 'channel_1_mhz', 'channel_2_mhz',
        'ion_delay_1_us', 'ion_delay_2_us', 'geometry_table_url', 'radargram_browse_folder',
        'radargram_images_folder',
    ]
    csvfile = OUT / 'marsis_frames.csv'
    with csvfile.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for frame in selected:  # CSV preserves ALL frames; GeoJSON may be decimated
            props = frame_properties(frame)
            writer.writerow({h: props.get(h) for h in headers})
    print(f'  wrote {csvfile.relative_to(ROOT)} ({len(selected)} rows)')
    prj = OUT / 'marsis_mars2000_sphere.prj'
    prj.write_text(GCS_MARS_2000_SPHERE, encoding='utf-8')
    meta = {
        'dataset': 'Optimized MARSIS Radargram Data (U.S.) - PDS4',
        'bundle_lid': 'urn:nasa:pds:mex_marsis_optim',
        'source_page': SOURCE_PAGE, 'archive_root': PDS_BASE,
        'reference': 'https://doi.org/10.17189/wrxv-m053',
        'generated_utc': datetime.now(timezone.utc).isoformat(),
        'region_lonlat_box': None if all_mars else list(bbox),
        'orbits': requested_orbits, 'orbit_files_read': list(frames_by_orbit),
        'n_all_read': sum(len(frames) for frames in frames_by_orbit.values()),
        'n_in_region': len(selected), 'n_map_points': len(visible), 'n_track_segments': len(tracks),
        'downsample_every_n_for_geojson': stride,
        'ode_search_url': ode_search_url, 'failed_orbit_downloads': failures,
        'ionosphere_fields_included': include_ionosphere,
        'coordinate_system': 'Mars 2000 Sphere (ESRI:104971) for ArcGIS display',
        'source_geometry_note': 'Footprints on Mars reference ellipsoid; Mars sphere is an approximation',
        'interpretation_notes': [
            'These are radar observation ground tracks, not full radar footprint coverage widths.',
            'There are NO automatically inferred ice deposits, water reserves, subsurface caves, or route safety classifications.',
            'Radargrams and matched clutter simulations must be assessed before interpreting reflectors.',
            'Ionospheric delays are radar processing corrections, not an operational communications availability prediction.',
            'GeoJSON has Mars longitudes/latitudes; ensure your application does not reproject them as Earth positions.',
        ],
    }
    dump_json('marsis_metadata.json', meta)
    if not selected:
        print('\nNO MARSIS FRAMES within the requested region for these orbits.')
        print('  Try --bbox 70 12 85 25, or a different orbit, or --all-mars for validation.')
        print('  No observations are invented when the archive has none in the region.')
    return meta


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bbox', nargs=4, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'),
                        type=float, default=DEFAULT_BBOX, help='East-positive degrees; Jezero default')
    parser.add_argument('--orbit', action='append', default=[], help='Manually specify an orbit (repeatable), e.g. 01867')
    parser.add_argument('--all-mars', action='store_true', help='Write all frames of specified orbits, ignoring Jezero bbox')
    parser.add_argument('--no-discover', action='store_true', help='Skip ODE area search; requires --orbit')
    parser.add_argument('--ode-json', type=Path, help='Use previously saved ODE REST JSON instead of live discovery')
    parser.add_argument('--max-orbits', type=int, default=30, help='Maximum orbit tables to download')
    parser.add_argument('--frame-stride', type=int, default=4, help='Use one out of N frames for GeoJSON points (CSV preserves all)')
    parser.add_argument('--with-ionosphere', action='store_true', help='Join derived MARSIS radar ionospheric delays per frame')
    parser.add_argument('--fail-fast', action='store_true', help='Abort if any orbit geometry download fails')
    args = parser.parse_args(argv)
    bbox = tuple(args.bbox)
    if not (-180 <= bbox[0] < bbox[2] <= 360 and -90 <= bbox[1] < bbox[3] <= 90):
        parser.error('Invalid --bbox (west south east north; increasing longitude/latitude)')
    if args.max_orbits < 1 or args.frame_stride < 1:
        parser.error('--max-orbits and --frame-stride must be >= 1')
    if args.all_mars and not args.orbit and not args.ode_json:
        parser.error('--all-mars requires at least one --orbit (do not download entire archive)')
    if args.no_discover and not args.orbit and not args.ode_json:
        parser.error('Use --orbit when --no-discover is set')

    wanted = {orbit_id(o) for o in args.orbit}
    ode_url = None
    if args.ode_json:
        json_path = args.ode_json
        ode_results = json.loads(json_path.read_text(encoding='utf-8'))
        found = find_orbits_from_ode(ode_results)
        print(f'  ODE file identified {len(found)} orbit(s)')
        wanted.update(found)
        ode_url = str(json_path)
    elif not args.no_discover and not args.all_mars:
        try:
            print('MARSIS ODE search:')
            found, ode_url, pages = ode_query(bbox)
            wanted.update(found)
            if pages >= 4:
                print('  WARNING: ODE result search capped at 4 pages; results may be incomplete')
        except (RuntimeError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as e:
            print(f'  ODE discovery unavailable: {e}', file=sys.stderr)
            if not wanted:
                print('  Open ODE Mars Data Product Search and locate MARSIS GEOM orbit IDs;',
                      ' then rerun with --orbit 12345 --no-discover.', file=sys.stderr)
    orbits = sorted(wanted)
    if len(orbits) > args.max_orbits:
        print(f'  WARNING: limiting {len(orbits)} matching orbits to first {args.max_orbits}')
        orbits = orbits[:args.max_orbits]
    print(f'  selected orbits: {", ".join(orbits) or "NONE"}')
    all_frames: dict[str, list[Frame]] = {}
    failures: list[dict[str, str]] = []
    for orbit in orbits:
        try:
            frames = read_orbit(orbit, args.with_ionosphere)
            all_frames[orbit] = frames
            matches = len([f for f in frames if args.all_mars or inside(f.lon, f.lat, bbox)])
            print(f'  orbit {orbit}: {len(frames)} frames ({matches} matching requested area)')
        except (RuntimeError, UnicodeError, OSError) as e:
            failures.append({'orbit': orbit, 'error': str(e)})
            print(f'  WARNING orbit {orbit}: {e}', file=sys.stderr)
            if args.fail_fast:
                raise

    output_layers(all_frames, bbox, args.all_mars, args.frame_stride, ode_url,
                  orbits, args.with_ionosphere, failures)
    if not orbits:
        print('\nNo MARSIS orbits found. Outputs are empty, NOT synthetic.')
        return 2
    if not all_frames:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
