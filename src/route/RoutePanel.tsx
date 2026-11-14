// Safest-route panel: pick two points on the map, see the route, its numbers and the assumptions behind it.
import { useState } from 'react';
import { ASSUMPTIONS, LIMITS, WEIGHT_RANGES, type Weights } from './config';
import type { RoutePlanner } from './useRoutePlanner';
import type { RouteResult } from './planner';

const WEIGHT_LABELS: Record<keyof Weights, [string, string]> = {
  slope: ['Avoid steep ground', 'Extra cost as slopes approach the no-go limit'],
  roughness: ['Avoid rough ground', 'Local variation of slope in the 20 m terrain model'],
  radio: ['Stay in radio line of sight', 'Geometry to a hypothetical base antenna, not a link budget'],
  radiation: ['Avoid higher exposure', 'MODELLED sky-view and elevation index, not measured at Jezero'],
  science: ['Pass science targets', 'CRISM mineral detections and Perseverance sample sites'],
};

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

function Stats({ safest, direct }: { safest: RouteResult | null; direct: RouteResult }) {
  const rows: [string, (r: RouteResult) => string][] = [
    ['Distance', (r) => fmtKm(r.stats.distanceM)],
    ['Walking time*', (r) => fmtMin(r.stats.timeMin)],
    ['Climb / descent', (r) => `+${Math.round(r.stats.climbM)} / −${Math.round(r.stats.descentM)} m`],
    ['Average / steepest slope', (r) => `${fmtDeg(r.stats.avgSlopeDeg)} / ${fmtDeg(r.stats.maxSlopeDeg)}`],
    [`On ${LIMITS.cautionDeg}°+ slopes`, (r) => fmtKm(r.stats.cautionM)],
    [`On ${LIMITS.nogoDeg}°+ or no data`, (r) => fmtKm(r.stats.nogoM)],
    ['Radio line of sight', (r) => (r.stats.losPct === null ? 'unknown' : `${Math.round(r.stats.losPct)}%`)],
    ['Radiation index (modelled)', (r) => (r.stats.radiation === null ? 'unknown' : r.stats.radiation.toFixed(2))],
  ];
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

export function RoutePanel({ planner }: { planner: RoutePlanner }) {
  const [open, setOpen] = useState(false);
  const { picking, setPicking, start, end, weights, setWeights, plan, status, notice, clear } = planner;
  const fmtPt = (p: { lon: number; lat: number } | null) => (p ? `${p.lat.toFixed(4)}° N, ${p.lon.toFixed(4)}° E` : 'not set');
  const sci = plan?.safest?.stats;

  return (
    <div className="route-panel panel" data-open={open}>
      <button className="panel-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Safest route</button>
      {open && (
        <div className="rp-body">
          <p className="muted small">Pick a start and an end point inside the Jezero area. The route avoids slopes of {LIMITS.nogoDeg}° or more and ground with no data.</p>
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
              <Stats safest={plan.safest} direct={plan.direct} />
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

          <details className="rp-assume">
            <summary>What matters to you</summary>
            <div className="rp-sliders">
              {(Object.keys(WEIGHT_RANGES) as (keyof Weights)[]).map((k) => (
                <label key={k} className="rp-slider" title={WEIGHT_LABELS[k][1]}>
                  <span>{WEIGHT_LABELS[k][0]}</span>
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
              <li>Terrain: 20 m CTX DTM. Boulders, steps and cliffs smaller than 20 m are invisible, so this is planning guidance, not a safe-to-walk guarantee.</li>
              <li>Slope bands ({LIMITS.cautionDeg}° caution, {LIMITS.nogoDeg}° no-go) are our assumptions, not NASA standards. Slope adds cost above {ASSUMPTIONS.comfortSlopeDeg}°.</li>
              <li>Effort: Minetti et al. 2002 walking-energy curve measured on Earth, applied to Mars terrain. No suit, load or gravity model.</li>
              <li>Radio: straight-line geometry to a hypothetical {ASSUMPTIONS.baseAntennaM} m antenna at the landing site (walker antenna {ASSUMPTIONS.walkerAntennaM} m), with planetary curvature. No link budget, no orbiter pass schedule (see NASA Mars Relay Network).</li>
              <li>Radiation is <b>modelled</b>, not measured: Perseverance has no radiation data in this project, and RAD flew on Curiosity at Gale. The index only combines sky openness and elevation. Solar particle events are not modelled.</li>
              <li>Science bonus: CRISM mineral detections and Perseverance sample sites within {ASSUMPTIONS.scienceRadiusM} m. Cells with no data are blocked, never treated as flat.</li>
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
