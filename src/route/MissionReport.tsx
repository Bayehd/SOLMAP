// Mission report shown on the Earth page: a transmission from Mars about one route.
// Uses the route walked in the route planner; with none chosen, the rover's own traverse.
import { useEffect, useMemo, useState } from 'react';
import { MINERAL_CLASSES } from '../map/layers';
import type { Site } from '../map/sites';
import { LIMITS, ASSUMPTIONS } from './config';
import { OXYGEN, oxygenUse } from './oxygen';
import { MINERAL_NEAR_M, type RouteResult } from './planner';
import { hazardStretches, pointLabel, steepestAtM, traverseSource, type ReportSource } from './report';
import './report.css';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP_S = 0.5; // seconds between sections appearing
/** Earth blue: the report's accent, where the Mars panels use Mars red. */
const EARTH_BLUE = '#1d4f8c';

const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtMin = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);

/** Counts up to the value, so the numbers seem to arrive with the transmission. */
function CountUp({ to, digits = 0, delay = 0, suffix = '' }: { to: number; digits?: number; delay?: number; suffix?: string }) {
  const [v, setV] = useState(reducedMotion() ? to : 0);
  useEffect(() => {
    if (reducedMotion()) { setV(to); return; }
    let raf = 0;
    const t0 = performance.now() + delay * 1000;
    const tick = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - t0) / 1100));
      setV(to * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, delay]);
  return <>{v.toFixed(digits)}{suffix}</>;
}

function MiniMap({ route, samples }: { route: RouteResult; samples: { lon: number; lat: number }[] }) {
  const W = 420, H = 190, P = 14;
  const lons = route.path.map((p) => p[0]), lats = route.path.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const x0 = Math.min(...lons), y0 = Math.min(...lats);
  const w = (Math.max(...lons) - x0) * kx || 1e-6, h = Math.max(...lats) - y0 || 1e-6;
  const k = Math.min((W - 2 * P) / w, (H - 2 * P) / h);
  const ox = (W - w * k) / 2, oy = (H - h * k) / 2;
  const px = ([lon, lat]: [number, number]) => [ox + (lon - x0) * kx * k, H - oy - (lat - y0) * k] as const;
  const pts = route.path.map((p) => px(p).map((n) => n.toFixed(1)).join(',')).join(' ');
  const a = px(route.path[0]), b = px(route.path[route.path.length - 1]);
  return (
    <svg className="mr-minimap" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Route map, north up">
      <polyline points={pts} fill="none" stroke={EARTH_BLUE} strokeWidth="2.4" strokeLinejoin="round" pathLength={1} className="mr-draw" />
      {samples.map((s, i) => { const [x, y] = px([s.lon, s.lat]); return <circle key={i} cx={x} cy={y} r="3" fill="#f5b841" stroke="#1d1a17" strokeWidth="0.8" />; })}
      <circle cx={a[0]} cy={a[1]} r="5" fill="#fff" stroke="#1d1a17" strokeWidth="1.5" />
      <circle cx={b[0]} cy={b[1]} r="5" fill={EARTH_BLUE} stroke="#fff" strokeWidth="1.5" />
      <text x={W - 6} y={H - 6} textAnchor="end" className="mr-svgtext">north up</text>
    </svg>
  );
}

function Profile({ route }: { route: RouteResult }) {
  const { distM, z } = route.profile;
  // Plot area inside the SVG, with room on the left and bottom for the axis labels.
  const W = 420, H = 110, L = 40, B = 14, T = 4, R = 4;
  const total = distM[distM.length - 1] || 1;
  let lo = Infinity, hi = -Infinity;
  for (const v of z) if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!(hi > lo)) hi = lo + 1;
  const x = (d: number) => L + (d / total) * (W - L - R);
  const y = (v: number) => H - B - ((v - lo) / (hi - lo)) * (H - B - T);
  const pts = z.map((v, i) => (Number.isNaN(v) ? null : `${x(distM[i]).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  return (
    <svg className="mr-profile" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Elevation profile of the route">
      <polyline points={pts} fill="none" stroke={EARTH_BLUE} strokeWidth="1.8" strokeLinejoin="round" pathLength={1} className="mr-draw" />
      <path d={`M${L},${T} V${H - B} H${W - R}`} fill="none" stroke="#000" strokeWidth="1" />
      <text x={L - 3} y={T + 7} textAnchor="end" className="mr-svgtext">{Math.round(hi)} m</text>
      <text x={L - 3} y={H - B} textAnchor="end" className="mr-svgtext">{Math.round(lo)} m</text>
      <text x={L} y={H - 2} className="mr-svgtext">0</text>
      <text x={W - R} y={H - 2} textAnchor="end" className="mr-svgtext">{fmtKm(total)}</text>
    </svg>
  );
}

export function MissionReport({ site, route, onClose }: { site: Site; route: RouteResult | null; onClose: () => void }) {
  const [source, setSource] = useState<ReportSource | null>(route ? { kind: 'safest', route, allSamples: [] } : null);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState(0);
  const [crew, setCrew] = useState('Cmdr. Amara Voss');
  const [mission, setMission] = useState('Mars Surface Expedition 1');

  // With no route chosen, describe the rover's own traverse.
  useEffect(() => {
    if (route) return;
    let live = true;
    traverseSource(site).then((s) => live && setSource(s)).catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [route, site]);

  const r = source?.route;
  const stats = r?.stats;
  const view = useMemo(() => {
    if (!r || !stats || !source) return null;
    const start = r.path[0], end = r.path[r.path.length - 1];
    const sLabel = pointLabel(site, start, source.allSamples), eLabel = pointLabel(site, end, source.allSamples);
    const stretches = hazardStretches(r);
    const hazardM = stats.cautionM + stats.nogoM;
    const ox = oxygenUse(stats);
    return { start, end, sLabel, eLabel, stretches, hazardM, ox, steepAt: steepestAtM(r) };
  }, [r, stats, source, site]);

  const isTraverse = source?.kind === 'traverse';
  const name = view ? `${view.sLabel ?? 'Start'} → ${view.eLabel ?? 'Destination'}` : '';
  const done = (view ? 8 : 0) * STEP_S + 1;
  const [received, setReceived] = useState(false);
  useEffect(() => {
    setReceived(false);
    if (!view) return;
    const t = setTimeout(() => setReceived(true), reducedMotion() ? 0 : done * 1000);
    return () => clearTimeout(t);
  }, [view, replay, done]);

  const minerals = stats ? MINERAL_CLASSES.map((c, i) => ({ ...c, m: stats.mineralM[i + 1] ?? 0 })).filter((c) => c.m > 0) : [];
  const section = (i: number) => ({ '--i': i, '--d': `${i * STEP_S}s` }) as React.CSSProperties;

  return (
    <aside className="mission-report" aria-label="Mission report">
      <header className="mr-head">
        <div className="mr-status" data-state={error ? 'error' : received ? 'done' : 'live'}>
          <span className="mr-dot" />
          {error ? 'Transmission failed' : received ? 'Transmission received' : view ? 'Receiving transmission…' : `Working out the ${site.rover} route…`}
        </div>
        <button className="mr-x" aria-label="Close report" onClick={onClose}>×</button>
      </header>

      {error && <p className="mr-warn">{error}</p>}

      {view && r && stats && source && (
        <div className="mr-body" key={replay}>
          <div className="mr-sec mr-top" style={section(0)}>
            <div className="mr-top-text">
              <h2 className="mr-title">Mission report</h2>
              <p className="mr-route">{name}</p>
              <p className="mr-muted">{isTraverse ? `${site.rover}'s own route, as driven` : 'Safest route, as planned in Solmap'} · {site.name}</p>
            </div>
            {/* Title block, like the corner box of a technical drawing. */}
            <div className="mr-crew">
              <label><span>Mission</span><input value={mission} onChange={(e) => setMission(e.target.value)} aria-label="Mission name" /></label>
              <label><span>Crew</span><input value={crew} onChange={(e) => setCrew(e.target.value)} aria-label="Crew member" /></label>
            </div>
          </div>

          <div className="mr-cols">
          <div className="mr-col">
          <div className="mr-sec mr-map-sec" style={section(2)}>
            <MiniMap route={r} samples={stats.samplesNearList} />
          </div>

          <div className="mr-sec mr-tiles" style={section(3)}>
            <div><span>Distance</span><b>{stats.distanceM >= 1000 ? <CountUp to={stats.distanceM / 1000} digits={2} delay={3 * STEP_S} suffix=" km" /> : <CountUp to={stats.distanceM} delay={3 * STEP_S} suffix=" m" />}</b></div>
            <div><span>Walking time</span><b>{fmtMin(stats.timeMin)}</b></div>
            <div><span>Climb / descent</span><b>+<CountUp to={stats.climbM} delay={3 * STEP_S} /> / −<CountUp to={stats.descentM} delay={3 * STEP_S} /> m</b></div>
            <div><span>Oxygen</span><b><CountUp to={view.ox.tanks} delay={3 * STEP_S} /> tank{view.ox.tanks === 1 ? '' : 's'}</b><i>{Math.round(view.ox.pct)}% of one</i></div>
          </div>

          </div>
          <div className="mr-col">
          <div className="mr-sec mr-prof-sec" style={section(4)}>
            <h3>Elevation</h3>
            <Profile route={r} />
          </div>

          <div className="mr-sec" style={section(5)}>
            <h3>Hazards</h3>
            {view.stretches.length === 0 ? (
              <p>No slopes of {LIMITS.cautionDeg}° or more on this route.</p>
            ) : (
              <>
                <p>
                  {fmtKm(view.hazardM)} on {LIMITS.cautionDeg}°+ slopes or ground with no data, in {view.stretches.length} stretch{view.stretches.length === 1 ? '' : 'es'}.
                  {view.steepAt !== null && <> Steepest: {stats.maxSlopeDeg.toFixed(1)}° at {fmtKm(view.steepAt)} from the start.</>}
                </p>
                <ul>
                  {view.stretches.slice(0, 3).map((h, i) => (
                    <li key={i}>
                      {fmtKm(h.fromM)}–{fmtKm(h.toM)}: {h.maxDeg === null ? 'no elevation data' : `up to ${h.maxDeg.toFixed(1)}°`}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {stats.losPct !== null && <p className="mr-muted">Radio line of sight to base: {Math.round(stats.losPct)}% of the route.</p>}
          </div>

          <details className="mr-sec mr-fold" style={section(6)}>
            <summary><h3>Minerals found</h3><span className="mr-count">{minerals.length}</span></summary>
            {!site.files.minerals ? (
              <p>No mineral map for {site.short} yet.</p>
            ) : minerals.length === 0 ? (
              <p>No CRISM mineral detections within {MINERAL_NEAR_M} m of this route.</p>
            ) : (
              <ul className="mr-minerals">
                {minerals.map((c) => (
                  <li key={c.label}><span className="mr-sw" style={{ background: `rgb(${c.color.join(',')})` }} />{c.label}<em>{fmtKm(c.m)} of the route</em></li>
                ))}
              </ul>
            )}
          </details>

          <details className="mr-sec mr-fold" style={section(7)}>
            <summary><h3>Samples found</h3><span className="mr-count">{stats.samplesNearList.length}</span></summary>
            {!site.files.samples ? (
              <p>No sample data for {site.short}.</p>
            ) : stats.samplesNearList.length === 0 ? (
              <p>No sample data along this route.</p>
            ) : (
              <ul>
                {stats.samplesNearList.map((s) => (
                  <li key={s.number}>{s.name}<em>{s.kind ? s.kind.toLowerCase() : 'sample'}{s.sol ? `, sealed sol ${s.sol}` : ''}</em></li>
                ))}
              </ul>
            )}
          </details>

          </div>
          </div>

          <p className="mr-sec mr-foot" style={section(8)}>
            Illustrative crew and mission. Terrain: 20 m model; slope bands ({LIMITS.cautionDeg}°/{LIMITS.nogoDeg}°), walking time at {ASSUMPTIONS.walkSpeedKmh} km/h and oxygen ({OXYGEN.tankHours} h tank) are our assumptions. Minerals: CRISM (NASA MRO), derived map, within {MINERAL_NEAR_M} m.
          </p>
          <div className="mr-actions">
            <button className="mr-btn" onClick={() => setReplay((n) => n + 1)}>Replay</button>
            <button className="mr-btn mr-btn-main" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </aside>
  );
}
