// Safest-route panel: pick two points on the map, see the route, its numbers and the assumptions behind it.
// At Gale it also shows what Curiosity measured there (RAD radiation, REMS weather), and the walk's dose at the RAD rate.
import { useEffect, useState } from 'react';
import { publicUrl } from '../map/mars';
import type { Site } from '../map/sites';
import { ASSUMPTIONS, LIMITS, WEIGHT_RANGES, type Weights } from './config';
import { OXYGEN, oxygenUse } from './oxygen';
import type { RoutePlanner } from './useRoutePlanner';
import type { RouteResult } from './planner';

const weightLabels = (site: Site, measured: boolean): Record<keyof Weights, [string, string]> => ({
  slope: ['Avoid steep ground', 'Extra cost as slopes approach the no-go limit'],
  roughness: ['Avoid rough ground', 'Local variation of slope in the 20 m terrain model'],
  radio: ['Stay in radio line of sight', 'Geometry to a hypothetical base antenna, not a link budget'],
  radiation: [
    'Avoid higher exposure',
    measured
      ? 'Where it is higher: MODELLED sky-view and elevation index. How much: measured by RAD at Gale'
      : `MODELLED sky-view and elevation index, not measured at ${site.short}`,
  ],
  science: ['Pass science targets', site.files.samples ? 'CRISM mineral detections and Perseverance sample sites' : 'No mineral or sample data at this site yet'],
});

/** msl_environment.json (scripts/build_gale_layers.py): what Curiosity measured at Gale on a sample of sols. */
type Range = { median: number; min: number; max: number };
export type Environment = {
  summary: {
    rad: { sols: number; firstSol: number; lastSol: number; doseE_uGyPerH: Range };
    rems: { sols: number; firstSol: number; lastSol: number; airMinC: Range; airMaxC: Range; groundMinC: Range; groundMaxC: Range; uvMaxW: Range; pressurePa: Range };
  };
  rad: { sol: number; doseE: number; elev: number }[];
};

function useEnvironment(site: Site) {
  const [env, setEnv] = useState<Environment | null>(null);
  useEffect(() => {
    setEnv(null);
    if (!site.files.environment) return;
    let live = true;
    fetch(publicUrl(site.files.environment))
      .then((r) => (r.ok ? r.json() : null))
      .then((e) => live && setEnv(e))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [site]);
  return env;
}

const fmtDose = (uGy: number) => (uGy >= 1000 ? `${(uGy / 1000).toFixed(2)} mGy` : `${uGy.toFixed(uGy < 10 ? 1 : 0)} µGy`);
const fmtC = (r: Range) => `${Math.round(r.median)} °C`;

/** RAD dose rate per sol: a small line chart, falling as the Sun gets more active. */
function DoseChart({ env }: { env: Environment }) {
  const W = 280, H = 64;
  const pts = env.rad;
  const s0 = pts[0].sol, s1 = pts[pts.length - 1].sol;
  const lo = Math.min(...pts.map((p) => p.doseE)), hi = Math.max(...pts.map((p) => p.doseE));
  const x = (s: number) => ((s - s0) / (s1 - s0 || 1)) * W;
  const y = (v: number) => H - 13 - ((v - lo) / (hi - lo || 1)) * (H - 24); // room for the labels above and below
  return (
    <svg className="rp-profile" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="RAD dose rate per sol">
      <polyline points={pts.map((p) => `${x(p.sol).toFixed(1)},${y(p.doseE).toFixed(1)}`).join(' ')} fill="none" stroke="#ffd166" strokeWidth="1.6" />
      <text x="2" y="9" className="rp-svgtext">{hi.toFixed(1)} µGy/h</text>
      <text x="2" y={H - 2} className="rp-svgtext">{lo.toFixed(1)} µGy/h</text>
      <text x={W - 2} y={H - 2} className="rp-svgtext" textAnchor="end">sol {s0}–{s1}</text>
    </svg>
  );
}

/** What Curiosity measured at the site. */
function Measured({ env, site }: { env: Environment; site: Site }) {
  const { rad, rems } = env.summary;
  const d = rad.doseE_uGyPerH;
  return (
    <details className="rp-assume" open>
      <summary>Measured at {site.short} by {site.rover}</summary>
      <dl className="rp-measured small">
        <dt>Radiation (RAD)</dt>
        <dd>
          {d.median.toFixed(1)} µGy/h ({((d.median * 24.66) / 1000).toFixed(2)} mGy per sol), tissue-equivalent detector. Ranged {d.min.toFixed(1)}–{d.max.toFixed(1)} over sols {rad.firstSol}–{rad.lastSol}.
        </dd>
        <dt>Air (REMS)</dt>
        <dd>{fmtC(rems.airMinC)} at night to {fmtC(rems.airMaxC)} by day</dd>
        <dt>Ground (REMS)</dt>
        <dd>{fmtC(rems.groundMinC)} to {fmtC(rems.groundMaxC)}</dd>
        <dt>Pressure (REMS)</dt>
        <dd>{Math.round(rems.pressurePa.median)} Pa ({Math.round(rems.pressurePa.min)}–{Math.round(rems.pressurePa.max)} with the seasons; Earth: 101,325 Pa)</dd>
        <dt>UV at midday (REMS)</dt>
        <dd>{rems.uvMaxW.median.toFixed(1)} W/m² (UVA+B+C)</dd>
      </dl>
      <DoseChart env={env} />
      <p className="muted small">
        Medians over {rad.sols} sols (RAD) and {rems.sols} sols (REMS), one every 40 sols. Daily lows and highs per sol; the dose falls as the Sun gets more active (solar maximum 2024–25) and rises during solar storms.
      </p>
    </details>
  );
}

const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtMin = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);
const fmtDeg = (d: number) => (Number.isNaN(d) ? '–' : `${d.toFixed(1)}°`);

function Profile({ route }: { route: RouteResult }) {
  const { distM, z, slope } = route.profile;
  const W = 280, H = 70;
  const total = distM[distM.length - 1] || 1;
  let lo = Infinity, hi = -Infinity;
  for (const v of z) if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!(hi > lo)) hi = lo + 1;
  const x = (d: number) => (d / total) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * (H - 6) - 3;
  const pts = z.map((v, i) => (Number.isNaN(v) ? null : `${x(distM[i]).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  return (
    <svg className="rp-profile" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Elevation profile of the safest route">
      {z.map((_, i) => {
        if (i === 0) return null;
        const s = slope[i];
        if (!(Number.isNaN(s) || s >= LIMITS.cautionDeg)) return null;
        return <rect key={i} x={x(distM[i - 1])} y={0} width={Math.max(1, x(distM[i]) - x(distM[i - 1]))} height={H} fill={Number.isNaN(s) || s >= LIMITS.nogoDeg ? '#e5484d55' : '#f5a62355'} />;
      })}
      <polyline points={pts} fill="none" stroke="#3cdcff" strokeWidth="1.6" />
      <text x="2" y="10" className="rp-svgtext">{Math.round(hi)} m</text>
      <text x="2" y={H - 2} className="rp-svgtext">{Math.round(lo)} m</text>
    </svg>
  );
}

function Stats({ safest, direct, env }: { safest: RouteResult | null; direct: RouteResult; env: Environment | null }) {
  const rows: [string, (r: RouteResult) => string][] = [
    ['Distance', (r) => fmtKm(r.stats.distanceM)],
    ['Walking time*', (r) => fmtMin(r.stats.timeMin)],
    ['Climb / descent', (r) => `+${Math.round(r.stats.climbM)} / −${Math.round(r.stats.descentM)} m`],
    ['Average / steepest slope', (r) => `${fmtDeg(r.stats.avgSlopeDeg)} / ${fmtDeg(r.stats.maxSlopeDeg)}`],
    [`On ${LIMITS.cautionDeg}°+ slopes`, (r) => fmtKm(r.stats.cautionM)],
    [`On ${LIMITS.nogoDeg}°+ or no data`, (r) => fmtKm(r.stats.nogoM)],
    ['Radio line of sight', (r) => (r.stats.losPct === null ? 'unknown' : `${Math.round(r.stats.losPct)}%`)],
    ['Oxygen used (of 1 tank)', (r) => `${Math.round(oxygenUse(r.stats).pct)}%`],
    ['Tanks needed', (r) => String(oxygenUse(r.stats).tanks)],
    ['Radiation index (modelled)', (r) => (r.stats.radiation === null ? 'unknown' : r.stats.radiation.toFixed(2))],
  ];
  // Dose on the walk at the rate RAD measured (median sol; the range is RAD's lowest and highest sampled sols).
  const rate = env?.summary.rad.doseE_uGyPerH;
  if (rate)
    rows.push([
      'Dose on the walk (RAD rate)',
      (r) => `${fmtDose((r.stats.timeMin / 60) * rate.median)} (${fmtDose((r.stats.timeMin / 60) * rate.min)}–${fmtDose((r.stats.timeMin / 60) * rate.max)})`,
    ]);
  return (
    <table className="rp-table">
      <thead>
        <tr><th /><th><span className="rp-key rp-key-safe" />Safest</th><th><span className="rp-key rp-key-direct" />Direct</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, f]) => (
          <tr key={label}><td>{label}</td><td>{safest ? f(safest) : '–'}</td><td>{f(direct)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** The safest-route panel; it opens from the Route button next to ▶. */
export function RoutePanel({ planner, site, open }: { planner: RoutePlanner; site: Site; open: boolean }) {
  const env = useEnvironment(site);
  const labels = weightLabels(site, !!env);
  const { picking, setPicking, start, end, weights, setWeights, plan, status, notice, clear } = planner;
  const fmtPt = (p: { lon: number; lat: number } | null) => (p ? `${p.lat.toFixed(4)}° N, ${p.lon.toFixed(4)}° E` : 'not set');
  const sci = plan?.safest?.stats;

  if (!open) return null;
  return (
    <div className="route-panel panel" data-open={open} id="route-panel">
      <h2 className="rp-title">Safest route</h2>
      {open && (
        <div className="rp-body">
          <p className="muted small">Pick a start and an end point inside the {site.short} area. The route avoids slopes of {LIMITS.nogoDeg}° or more and ground with no data.</p>
          <div className="rp-points">
            <button className="btn" aria-pressed={picking === 'start'} onClick={() => setPicking(picking === 'start' ? null : 'start')}>
              {picking === 'start' ? 'Click the map…' : 'Set start'}
            </button>
            <span className="small">{fmtPt(start)}</span>
            <button className="btn" aria-pressed={picking === 'end'} onClick={() => setPicking(picking === 'end' ? null : 'end')}>
              {picking === 'end' ? 'Click the map…' : 'Set end'}
            </button>
            <span className="small">{fmtPt(end)}</span>
          </div>
          {(start || end) && <button className="btn rp-clear" onClick={clear}>Clear</button>}
          {notice && <p className="rp-warn small">{notice}</p>}
          {status.kind === 'working' && <p className="muted small">Working out the route…</p>}
          {status.kind === 'error' && <p className="rp-warn small">Could not plan the route: {status.message}</p>}
          {plan?.reason && <p className="rp-warn small">{plan.reason}</p>}

          {plan && (
            <>
              <Stats safest={plan.safest} direct={plan.direct} env={env} />
              <p className="muted small">*Walking time is an estimate at {ASSUMPTIONS.walkSpeedKmh} km/h on flat ground, slowed by slope.</p>
              {plan.safest && (
                <>
                  <h3>Elevation profile (safest)</h3>
                  <Profile route={plan.safest} />
                  <p className="muted small">Orange bands: {LIMITS.cautionDeg}°+ caution. Red: {LIMITS.nogoDeg}°+ or no data.</p>
                  {sci && (sci.samplesNear.length > 0 || sci.mineralCells > 0) && (
                    <p className="small">
                      Science on the way: {sci.samplesNear.length ? `samples ${sci.samplesNear.join(', ')}` : 'no sample sites'}
                      {sci.mineralCells > 0 ? `; ${sci.mineralCells} cells with CRISM mineral detections` : ''}.
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {env && <Measured env={env} site={site} />}

          <details className="rp-assume">
            <summary>What matters to you</summary>
            <div className="rp-sliders">
              {(Object.keys(WEIGHT_RANGES) as (keyof Weights)[]).map((k) => (
                <label key={k} className="rp-slider" title={labels[k][1]}>
                  <span>{labels[k][0]}</span>
                  <input
                    type="range" min={0} max={WEIGHT_RANGES[k].max} step={WEIGHT_RANGES[k].step}
                    value={weights[k]} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          </details>

          <details className="rp-assume">
            <summary>Assumptions and limits</summary>
            <ul className="small">
              <li>Terrain: 20 m {site.id === 'gale' ? 'HiRISE + CTX DEM (USGS, averaged from 1 m)' : 'CTX DTM'}. Boulders, steps and cliffs smaller than 20 m are invisible, so this is planning guidance, not a safe-to-walk guarantee.</li>
              <li>Slope bands ({LIMITS.cautionDeg}° caution, {LIMITS.nogoDeg}° no-go) are our assumptions, not NASA standards. Slope adds cost above {ASSUMPTIONS.comfortSlopeDeg}°.</li>
              <li>Effort: Minetti et al. 2002 walking-energy curve measured on Earth, applied to Mars terrain. No suit, load or gravity model.</li>
              <li>Oxygen: O₂ used (%) = distance (m) × {OXYGEN.perMetre} + climb (m) × {OXYGEN.perClimbMetre} + time (min) × {OXYGEN.perMinute}, as a share of one tank. One tank lasts {OXYGEN.tankHours} h; tanks needed is rounded up and never less than walking time ÷ {OXYGEN.tankHours} h. These coefficients are our assumption, not NASA suit data, and there is no reserve margin.</li>
              <li>Radio: straight-line geometry to a hypothetical {ASSUMPTIONS.baseAntennaM} m antenna at the landing site (walker antenna {ASSUMPTIONS.walkerAntennaM} m), with planetary curvature. No link budget, no orbiter pass schedule (see NASA Mars Relay Network).</li>
              {env ? (
                <li>
                  Radiation: the <b>dose rate is measured</b> (Curiosity's RAD, on the rover deck, tissue-equivalent detector), the dose on the walk is that rate times the walking time. <b>Where</b> along the route it is higher is still modelled (sky openness and elevation). RAD measures on the rover deck, not inside a suit, so treat the dose as indicative. Solar particle events are in the range, not in the median.
                </li>
              ) : (
                <li>Radiation is <b>modelled</b>, not measured: {site.rover} has no radiation data in this project, and RAD flew on Curiosity at Gale. The index only combines sky openness and elevation. Solar particle events are not modelled.</li>
              )}
              <li>
                {site.files.samples
                  ? <>Science bonus: CRISM mineral detections and Perseverance sample sites within {ASSUMPTIONS.scienceRadiusM} m.</>
                  : <>Science bonus: no mineral or sample layer at {site.short} yet, so it has no effect here.</>}{' '}
                Cells with no data are blocked, never treated as flat.
              </li>
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
