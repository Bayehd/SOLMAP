#!/usr/bin/env python3
"""Builds MEDA and communication layers in public/data/jezero/ for SOLMAP.

Run from the SOLMAP repository after its existing Jezero build script:

    .venv/bin/python scripts/build_jezero_safety_layers.py --start-sol 30 --end-sol 35 --coverage

Outputs (Mars 2000 Sphere; ArcGIS 104971 for GeoTIFF):
  meda_sol_summary.csv             MEDA weather summary per selected sol
  meda_weather.geojson             MEDA weather at Perseverance end-of-sol positions
  comm_base_waypoints.geojson      Geometric line-of-sight to hypothetical base antenna
  comm_base_coverage_200m.tif      Optional 0/1/NoData terrain-visibility raster
  comm_orbiter_geometry.geojson    Optional geometry-only orbiter snapshots (not contact schedules)
  safety_layer_metadata.json      Methods, caveats, provenance

Inputs (from existing SOLMAP pipeline):
  public/data/jezero/ctx_dtm_20m.tif  Existing CTX DTM; read-only, never rebuilt
  NASA/JPL Mars 2020 MMGIS waypoint feed (downloaded/cached automatically)
  NASA PDS Mars 2020 MEDA calibrated/derived per-sol CSV+XML files
  Optional user-provided Mars-fixed orbiter state vectors

IMPORTANT: Research visualization, NOT a mission-certified communications or EVA safety model.
MEDA is rover-local historical weather; orbital geometry does not prove that a relay is booked.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from statistics import median

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy
from rasterio.transform import Affine

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'jezero'
CACHE = ROOT / 'scripts' / '.cache' / 'meda'
MEDA_ROOT = 'https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda'
WAYPOINTS_URL = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json'
MARS_RADIUS_M = 3396190.0
MARS_GCS = ('GEOGCS["GCS_Mars_2000_Sphere",DATUM["D_Mars_2000_Sphere",'
            'SPHEROID["Mars_2000_Sphere_IAU_IAG",3396190.0,0.0]],'
            'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]')
NODATA = -32768.0
# This is an illustrative habitat / antenna site, NOT an actual communication station.
BASE_LANDING_LAT = 18.44462715
BASE_LANDING_LON = 77.45088572

# PDS4 filenames:  ..._CAL_ATS... or ..._DER_PS..., etc.
# For ATS choose one documented individual thermometer rather than pooling multiple detectors.
SENSORS = {
    'air_temp_C': ('calibrated', 'ATS', 'ATS_LOCAL_TEMP1', 'kelvin_to_c'),
    'pressure_Pa': ('derived', 'PS', 'PRESSURE', 'identity'),
    'wind_m_s': ('derived', 'WS', 'HORIZONTAL_WIND_SPEED', 'identity'),
    'humidity_native': ('derived', 'RHS', 'LOCAL_RELATIVE_HUMIDITY', 'identity'),
    'ground_temp_C': ('derived', 'TIRS', 'GROUND_TEMP', 'kelvin_to_c'),
}


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == 'a':
            d = dict(attrs)
            if 'href' in d:
                self.hrefs.append(d['href'])


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f'  downloading {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'solmap-meda-comms/1.0'})
    tmp = dest.with_suffix(dest.suffix + '.part')
    try:
        with urllib.request.urlopen(req, timeout=60) as response, tmp.open('wb') as f:
            shutil.copyfileobj(response, f)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return dest


def meda_sol_directory(sol: int, level: str) -> str:
    if sol < 90:
        low, high = 0, 89
    elif sol < 180:
        low, high = 90, 179
    else:
        low = 180 + (sol - 180) // 120 * 120
        high = low + 119
    return (f'{MEDA_ROOT}/data_{level}_env/'
            f'sol_{low:04d}_{high:04d}/sol_{sol:04d}/')


def sol_products(sol: int, level: str) -> dict[str, tuple[str, str]]:
    """Retrieve listing; choose newest file revision for each product type."""
    base = meda_sol_directory(sol, level)
    listing = CACHE / 'listings' / f'{level}_{sol:04d}.html'
    try:
        raw = fetch(base, listing).read_text(encoding='utf-8', errors='replace')
    except Exception as exc:
        print(f'  sol {sol}: no {level} directory ({exc})')
        return {}
    parser = Links()
    parser.feed(raw)
    result = {}
    for href in parser.hrefs:
        filename = urllib.parse.unquote(urllib.parse.urlsplit(href).path.split('/')[-1])
        m = re.search(r'_(CAL|DER)_(ATS|PS|WS|RHS|TIRS)_+P(\d+)\.CSV$', filename, re.I)
        if not m or (level == 'derived') != (m.group(1).upper() == 'DER'):
            continue
        instrument = m.group(2).upper()
        revision = int(m.group(3))
        old = result.get(instrument)
        if old is None or revision > old[0]:
            result[instrument] = (revision, filename)
    return {instrument: (urllib.parse.urljoin(base, name),
                         urllib.parse.urljoin(base, name[:-4] + '.xml'))
            for instrument, (_, name) in result.items()}


def pds_csv_column_names(label: Path) -> list[str]:
    """Read exact field names from PDS4 label; MEDA CSV files can be headerless."""
    tree = ET.parse(label)
    record = tree.find('.//{*}Table_Delimited/{*}Record_Delimited')
    if record is None:
        # Some PDS4 labels use an alternative table record declaration.
        record = tree.find('.//{*}Record_Delimited')
    if record is None:
        raise ValueError(f'No Record_Delimited in PDS XML: {label}')
    names = [f.findtext('{*}name') for f in record.findall('{*}Field_Delimited')]
    if not names or any(not n for n in names):
        raise ValueError(f'Missing field names in {label}')
    return [n.strip().upper() for n in names]


def product_values(csv_path: Path, label_path: Path, field: str,
                   filter_stationary: bool = False) -> list[float]:
    names = pds_csv_column_names(label_path)
    if field not in names:
        raise ValueError(f'{field} not in {csv_path.name}; found {names}')
    idx = names.index(field)
    still_idx = names.index('ROVER_STILL') if 'ROVER_STILL' in names else None
    values = []
    with csv_path.open(encoding='utf-8-sig', errors='replace', newline='') as f:
        for row in csv.reader(f):
            if not row or row[0].startswith('#') or row[0].strip().upper() == 'SCLK':
                continue
            if len(row) != len(names):
                continue
            if filter_stationary and still_idx is not None and row[still_idx].strip() != '1':
                continue
            try:
                v = float(row[idx])
            except (ValueError, IndexError):
                continue
            if not math.isfinite(v) or abs(v) > 1e5:
                continue
            # Broad physical sanity bounds, not astronaut safety thresholds.
            if field == 'PRESSURE' and not (0 < v < 5000):
                continue
            if field in ('ATS_LOCAL_TEMP1', 'GROUND_TEMP') and not (100 < v < 400):
                continue
            if field == 'HORIZONTAL_WIND_SPEED' and not (0 <= v < 200):
                continue
            if field == 'LOCAL_RELATIVE_HUMIDITY' and not (0 <= v <= 100):
                continue
            values.append(v)
    return values


def build_meda(start_sol: int, end_sol: int) -> list[dict]:
    observations = []
    for sol in range(start_sol, end_sol + 1):
        print(f'  MEDA sol {sol}')
        product_lists = {level: sol_products(sol, level) for level in ('calibrated', 'derived')}
        result = {'sol': sol, 'source': 'NASA PDS Mars 2020 MEDA',
                  'aggregation': 'median per sol; not a synchronous sensor snapshot'}
        sources = {}
        for key, (level, subtype, column, transform) in SENSORS.items():
            urls = product_lists[level].get(subtype)
            result[key] = None
            result[f'{key}_n'] = 0
            if not urls:
                continue
            csv_url, xml_url = urls
            store = CACHE / 'products' / f'sol_{sol:04d}'
            try:
                data = fetch(csv_url, store / csv_url.split('/')[-1])
                label = fetch(xml_url, store / xml_url.split('/')[-1])
                vals = product_values(data, label, column,
                                      filter_stationary=(subtype == 'WS'))
                if not vals:
                    continue
                v = median(vals)
                result[key] = round(v - 273.15 if transform == 'kelvin_to_c' else v, 5)
                result[f'{key}_n'] = len(vals)
                sources[key] = csv_url
            except Exception as exc:
                print(f'    {subtype} field {column}: skipped ({exc})')
        result['pds_files'] = sources
        if any(result[k] is not None for k in SENSORS):
            observations.append(result)
    return observations


def rover_waypoints() -> list[dict]:
    path = fetch(WAYPOINTS_URL, CACHE / 'M20_waypoints.json')
    js = json.loads(path.read_text(encoding='utf-8'))
    result = []
    for feature in js.get('features', []):
        props = feature.get('properties', {})
        try:
            sol = int(props['sol'])
            lon, lat = float(props['lon']), float(props['lat'])
        except (KeyError, ValueError, TypeError):
            continue
        if not (-90 <= lat <= 90):
            continue
        result.append({'sol': sol, 'lat': lat, 'lon': lon % 360})
    # Duplicate sols: use last end-of-drive entry as one approximate location.
    return list({p['sol']: p for p in result}.values())


def fc(features: list[dict], label: str) -> dict:
    return {'type': 'FeatureCollection', 'name': label,
            'features': features}


def point_feature(lon: float, lat: float, props: dict) -> dict:
    return {'type': 'Feature', 'geometry': {'type': 'Point',
            'coordinates': [round(lon, 7), round(lat, 7)]}, 'properties': props}


def save_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    print(f'  wrote {path.relative_to(ROOT)}')


def save_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    print(f'  wrote {path.relative_to(ROOT)}')


def great_circle_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a, b = math.radians(lat1), math.radians(lat2)
    da = b - a
    dl = math.radians((lon2 - lon1 + 180) % 360 - 180)
    h = math.sin(da / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dl / 2) ** 2
    return 2 * MARS_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def antenna_distance_m(lat1, lon1, height1, lat2, lon2, height2):
    arc = great_circle_distance_m(lat1, lon1, lat2, lon2)
    central = arc / MARS_RADIUS_M
    a, b = MARS_RADIUS_M + height1, MARS_RADIUS_M + height2
    return math.sqrt(max(0, a * a + b * b - 2 * a * b * math.cos(central)))


def terrain_los(dem, lat1, lon1, lat2, lon2, antenna1_m, antenna2_m,
                spacing_m=50.0) -> dict:
    """Ray/DTM intersection with spherical Mars curvature, no refraction.

    Elevations in DEM are referenced to Mars geoid; curvature correction uses
    the spherical 3396190-m radius. This is a local approximation (Jezero only).
    """
    d = great_circle_distance_m(lat1, lon1, lat2, lon2)
    if d > 100_000:
        return {'base_los': None, 'reason': 'range_exceeds_100km_model_limit',
                'distance_m': round(d, 1)}
    count = max(2, int(math.ceil(d / spacing_m)) + 1)
    fractions = np.linspace(0, 1, count)
    # Unwrap longitude across the 0/360 seam if necessary.
    delta_lon = (lon2 - lon1 + 180) % 360 - 180
    coords = [(lon1 + float(f) * delta_lon, lat1 + float(f) * (lat2 - lat1))
              for f in fractions]
    if dem is None:
        return {'base_los': None, 'reason': 'dem_unavailable', 'distance_m': round(d, 1)}
    sampled = list(dem.sample(coords, masked=True))
    z = []
    for item in sampled:
        value = item[0]
        if np.ma.is_masked(value) or not math.isfinite(float(value)) or float(value) == dem.nodata:
            return {'base_los': None, 'reason': 'dem_nodata_along_ray',
                    'distance_m': round(d, 1)}
        z.append(float(value))
    if not z:
        return {'base_los': None, 'reason': 'dem_unavailable', 'distance_m': round(d, 1)}
    source_alt = z[0] + antenna1_m
    target_alt = z[-1] + antenna2_m
    for i in range(1, count - 1):
        f = float(fractions[i])
        # Surface bulges above a straight sightline by s*(d-s)/(2R).
        curvature_bulge = (f * (1 - f) * d * d) / (2 * MARS_RADIUS_M)
        straight_alt = source_alt + (target_alt - source_alt) * f
        if z[i] + curvature_bulge > straight_alt:
            return {'base_los': False, 'reason': 'terrain_obstructed',
                    'distance_m': round(d, 1)}
    return {'base_los': True, 'reason': 'clear_geometric_line_of_sight',
            'distance_m': round(d, 1)}


def fspl_db(distance_m: float, frequency_mhz: float) -> float | None:
    if distance_m <= 0 or frequency_mhz <= 0:
        return None
    # 20log10(d_km)+20log10(f_MHz)+32.44, ideal unobstructed free space.
    return round(20 * math.log10(distance_m / 1000) +
                 20 * math.log10(frequency_mhz) + 32.44, 2)


def write_visibility_raster(dem, base_lat, base_lon, base_ant_m,
                            astronaut_ant_m, radius_km, pixel_m) -> None:
    if dem is None:
        print('  skipping coverage raster: no CTX DEM')
        return
    steps = int(math.ceil(2 * radius_km * 1000 / pixel_m))
    if steps > 300:
        raise ValueError('Coverage grid too large; increase --coverage-pixel-m')
    # Eqc longitude scaling cos(latitude) at the base. For this small Jezero grid
    # the change in that factor is negligible.
    deg_y = pixel_m / (MARS_RADIUS_M * math.pi / 180)
    deg_x = deg_y / math.cos(math.radians(base_lat))
    t = Affine(deg_x, 0, base_lon - steps * deg_x / 2,
               0, -deg_y, base_lat + steps * deg_y / 2)
    a = np.full((steps, steps), NODATA, dtype='float32')
    rmax = radius_km * 1000
    for row in range(steps):
        for col in range(steps):
            lon, lat = t * (col + 0.5, row + 0.5)
            if great_circle_distance_m(base_lat, base_lon, lat, lon) > rmax:
                continue
            stat = terrain_los(dem, base_lat, base_lon, lat, lon,
                               base_ant_m, astronaut_ant_m)
            if stat['base_los'] is not None:
                a[row, col] = 1.0 if stat['base_los'] else 0.0
    profile = dict(driver='GTiff', width=steps, height=steps, count=1,
                   dtype='float32', crs=MARS_GCS, transform=t, nodata=NODATA)
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / 'visibility.tif'
        with rasterio.open(src, 'w', **profile) as dst:
            dst.write(a, 1)
            dst.update_tags(1, DESCRIPTION='MODEL ONLY: base/astronaut geometric terrain visibility; 1=LOS, 0=blocked, NoData=unknown')
            if steps >= 32:
                dst.build_overviews([2, 4], Resampling.nearest)
        dst = OUT / f'comm_base_coverage_{int(pixel_m)}m.tif'
        rio_copy(src, dst, driver='GTiff', TILED='YES', BLOCKXSIZE=512,
                 BLOCKYSIZE=512, COPY_SRC_OVERVIEWS='YES', COMPRESS='LZW',
                 GEOTIFF_KEYS_FLAVOR='ESRI_PE')
    print(f'  wrote {dst.relative_to(ROOT)}')


def mars_unit(lat: float, lon: float):
    la, lo = math.radians(lat), math.radians(lon)
    return np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])


def build_relay_geometry(csv_path: Path, waypoint_by_sol: dict) -> None:
    """Optional spacecraft position samples in MARS-FIXED axes, same timestamp.

    Format: sol,utc,spacecraft,x_m,y_m,z_m. Ground endpoint approximated by
    end-of-drive rover position for that sol: NOT actual contact window prediction.
    """
    features = []
    with csv_path.open(newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            sol = int(row['sol'])
            wp = waypoint_by_sol.get(sol)
            if wp is None:
                continue
            sat = np.array([float(row[k]) for k in ('x_m', 'y_m', 'z_m')])
            if not np.isfinite(sat).all() or np.linalg.norm(sat) <= MARS_RADIUS_M:
                raise ValueError(f'Orbiter state vector invalid at sol {sol}; must be Mars-centred metres')
            up = mars_unit(wp['lat'], wp['lon'])
            ground = MARS_RADIUS_M * up
            sight = sat - ground
            elev = math.degrees(math.asin(float(np.dot(sight / np.linalg.norm(sight), up))))
            features.append(point_feature(wp['lon'], wp['lat'], {
                'sol': sol, 'utc': row['utc'], 'spacecraft': row['spacecraft'],
                'orbiter_elevation_deg': round(elev, 3),
                'geometric_above_horizon': elev > 0,
                'scheduled_relay': None,
                'signal_link_confirmed': None,
                'model': 'geometry only, approximate rover end-of-drive position',
            }))
    save_json(OUT / 'comm_orbiter_geometry.geojson', fc(features, 'Mars orbiter geometry samples'))


def build(args) -> None:
    if args.start_sol > args.end_sol or args.start_sol < 0 or args.end_sol - args.start_sol > 100:
        raise ValueError('Select a valid sol interval of at most 101 sols')
    OUT.mkdir(parents=True, exist_ok=True)
    print('Rover waypoints (NASA/JPL):')
    waypoints = rover_waypoints()
    by_sol = {p['sol']: p for p in waypoints}
    print(f'  {len(by_sol)} georeferenced rover sols')
    print('MEDA (NASA PDS):')
    observations = build_meda(args.start_sol, args.end_sol)
    if not observations:
        print('  No MEDA measurements downloaded. Inspect connection/sol range; output will contain no weather features.')
    columns = ['sol', *[key for key in SENSORS], *[f'{key}_n' for key in SENSORS]]
    save_csv(OUT / 'meda_sol_summary.csv', observations, columns)
    weather_points = []
    for obs in observations:
        wp = by_sol.get(obs['sol'])
        if wp is not None:
            props = dict(obs)
            props.update({'position_source': 'NASA/JPL end-of-drive waypoint, same sol',
                          'location_accuracy_note': 'MEDA observations can occur before rover drove to end-of-sol point'})
            weather_points.append(point_feature(wp['lon'], wp['lat'], props))
    save_json(OUT / 'meda_weather.geojson', fc(weather_points, 'MEDA historical observations'))

    dem_path = OUT / 'ctx_dtm_20m.tif'
    print('Communications:')
    if not dem_path.exists():
        print('  existing CTX DEM not found; ground line-of-sight stays unknown')
    dem = rasterio.open(dem_path) if dem_path.exists() else None
    try:
        comm_points = []
        for wp in waypoints:
            los = terrain_los(dem, args.base_lat, args.base_lon,
                              wp['lat'], wp['lon'], args.base_antenna_m,
                              args.astronaut_antenna_m)
            props = {'sol': wp['sol'], **los,
                     'base_lat': args.base_lat, 'base_lon': args.base_lon,
                     'base_station': 'hypothetical',
                     'antenna_m': args.base_antenna_m,
                     'person_antenna_m': args.astronaut_antenna_m,
                     'frequency_mhz': args.frequency_mhz,
                     'fspl_ideal_db': fspl_db(los['distance_m'], args.frequency_mhz),
                     'orbital_relay': 'not_evaluated',
                     'comms_safety_certified': False}
            comm_points.append(point_feature(wp['lon'], wp['lat'], props))
        save_json(OUT / 'comm_base_waypoints.geojson',
                  fc(comm_points, 'Hypothetical base terrain line-of-sight'))
        if args.coverage:
            print('  computing terrain-visibility coverage raster...')
            write_visibility_raster(dem, args.base_lat, args.base_lon,
                                    args.base_antenna_m, args.astronaut_antenna_m,
                                    args.coverage_radius_km, args.coverage_pixel_m)
    finally:
        if dem is not None:
            dem.close()
    if args.orbiter_states:
        build_relay_geometry(args.orbiter_states, by_sol)

    save_json(OUT / 'safety_layer_metadata.json', {
        'coordinate_reference': 'Mars 2000 Sphere (ArcGIS 104971), planetocentric lat, east lon',
        'meda_pds_archive': MEDA_ROOT,
        'meda_time_aggregation': 'median of available samples within one sol (not simultaneous)',
        'meda_units': {'air_temp_C': 'degrees Celsius', 'pressure_Pa': 'pascals',
                       'wind_m_s': 'm/s', 'humidity_native': 'source MEDA relative humidity scale',
                       'ground_temp_C': 'degrees Celsius'},
        'rover_waypoints': WAYPOINTS_URL,
        'weather_geolocation': 'end-of-drive waypoint for same sol; approximate, not exact measurement location',
        'communications': {
            'hypothetical_base': [args.base_lat, args.base_lon],
            'antenna_heights_m': [args.base_antenna_m, args.astronaut_antenna_m],
            'surface_radius_m': MARS_RADIUS_M,
            'method': 'geometric visibility sampled along DTM with spherical curvature; no refraction, diffraction, gain, link budget or scheduling',
            'dem_used': str(dem_path.relative_to(ROOT)) if dem_path.exists() else None,
            'orbiter_geometry': 'optional user-supplied Mars-fixed state vectors; does not establish pass or relay availability',
        },
        'notice': 'RESEARCH DEMONSTRATION ONLY. NOT REAL-TIME WEATHER, NOT CERTIFIED FOR EVA SAFETY OR RELAY COVERAGE.'
    })
    print('Finished.')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--start-sol', type=int, default=30)
    p.add_argument('--end-sol', type=int, default=35)
    p.add_argument('--base-lat', type=float, default=BASE_LANDING_LAT)
    p.add_argument('--base-lon', type=float, default=BASE_LANDING_LON)
    p.add_argument('--base-antenna-m', type=float, default=3.0)
    p.add_argument('--astronaut-antenna-m', type=float, default=2.0)
    p.add_argument('--frequency-mhz', type=float, default=400.0)
    p.add_argument('--coverage', action='store_true', help='Build a sampled ground-visibility raster')
    p.add_argument('--coverage-radius-km', type=float, default=3.0)
    p.add_argument('--coverage-pixel-m', type=float, default=200.0)
    p.add_argument('--orbiter-states', type=Path, help='Optional Mars-fixed spacecraft XYZ input CSV')
    args = p.parse_args()
    if args.base_antenna_m < 0 or args.astronaut_antenna_m < 0:
        p.error('antenna heights must be nonnegative')
    if args.coverage_radius_km <= 0 or args.coverage_pixel_m <= 0:
        p.error('coverage radius/pixel must be positive')
    build(args)
