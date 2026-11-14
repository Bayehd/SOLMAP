// Sky-crane landing of the real 3D Perseverance model. The rover is flown down inside the 3D view
// (RoverControl); this full-screen overlay draws the descent stage, bridles and dust, re-positioned every
// frame from where the rover projects on screen, so the two stay together even if the camera moves.
//   descend: powered descent with the rover tucked under the stage
//   lower:   the stage hovers and lowers the rover on bridles to the ground
//   flyaway: bridles cut at touchdown, the stage climbs away; the rover stays on the terrain
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ROVER_WIDTH_PER_HEIGHT, type RoverControl } from '../map/rover';

const ENGINES = [43, 54, 146, 157]; // descent engines, in pairs at each end (4 of the 8 visible in side view)
const BRIDLES = [86, 100, 114]; // attach points under the stage (stage units)
// The stage is drawn in a 200-unit-wide box; its frame spans x 40-160 and its underside is at y = 108.
const STAGE_FRAME_UNITS = 120;
const STAGE_PER_ROVER_WIDTH = 1.45; // the descent stage is a bit wider than the rover

const DESCEND_MS = 3200;
const LOWER_MS = 2200;
const FLYAWAY_MS = 1800;
const HOVER = 1.7; // rover altitude, in rover heights, where the stage stops and starts lowering
const TUCK_GAP = 0.04; // gap between rover top and stage while tucked, in rover heights

type Phase = 'descend' | 'lower' | 'flyaway';

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Lowest altitude at which the stage is above the top of the screen, so the descent starts off-screen. */
function startAltitude(c: RoverControl) {
  const h = c.heightM();
  for (let a = 2 * h; a < 200 * h; a *= 1.3) {
    const p = c.toScreen(a + h * 1.6);
    if (!p || p.y < -60) return a;
  }
  return 20 * h;
}

export function Lander({ control, onDone }: { control: RefObject<RoverControl | null>; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('descend');
  const stageRef = useRef<SVGGElement>(null);
  const bridleRefs = useRef<(SVGLineElement | null)[]>([]);
  const dustRef = useRef<SVGEllipseElement>(null);
  const startRef = useRef(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Lift the rover off the ground before the layer is shown (layout effects run before MapApp's effects).
  useLayoutEffect(() => {
    const c = control.current;
    if (c) c.setAltitude((startRef.current = startAltitude(c)));
  }, [control]);

  useEffect(() => {
    const c = control.current;
    if (!c) {
      onDoneRef.current();
      return;
    }
    const a0 = startRef.current;
    let raf = 0;
    let current: Phase = 'descend';
    const t0 = performance.now();

    const frame = (now: number) => {
      const t = now - t0;
      const h = c.heightM();
      const mpp = c.metersPerPx();
      const hover = HOVER * h;

      let altitude: number; // rover base above ground
      let stageAlt: number; // stage underside above ground
      let next: Phase;
      if (t < DESCEND_MS) {
        next = 'descend';
        altitude = a0 + (hover - a0) * easeOutCubic(t / DESCEND_MS);
        stageAlt = altitude + h * (1 + TUCK_GAP);
      } else if (t < DESCEND_MS + LOWER_MS) {
        next = 'lower';
        altitude = hover * (1 - easeInOut((t - DESCEND_MS) / LOWER_MS));
        stageAlt = hover + h * (1 + TUCK_GAP);
      } else {
        next = 'flyaway';
        altitude = 0;
        stageAlt = hover + h * (1 + TUCK_GAP);
      }
      c.setAltitude(altitude);
      if (next !== current) setPhase((current = next));

      const stage = c.toScreen(stageAlt);
      const top = c.toScreen(altitude + h);
      const ground = c.toScreen(0);
      if (stage && top && mpp) {
        const roverWidthPx = (h * ROVER_WIDTH_PER_HEIGHT) / mpp;
        const s = (roverWidthPx * STAGE_PER_ROVER_WIDTH) / STAGE_FRAME_UNITS;
        stageRef.current?.setAttribute('transform', `translate(${stage.x} ${stage.y}) scale(${s}) translate(-100 -108)`);
        BRIDLES.forEach((bx, i) => {
          const line = bridleRefs.current[i];
          if (!line) return;
          const dx = (bx - 100) * s;
          line.setAttribute('x1', String(stage.x + dx));
          line.setAttribute('y1', String(stage.y));
          line.setAttribute('x2', String(top.x + dx * 0.7));
          line.setAttribute('y2', String(top.y));
        });
        if (ground && dustRef.current) {
          dustRef.current.setAttribute('cx', String(ground.x));
          dustRef.current.setAttribute('cy', String(ground.y));
          dustRef.current.setAttribute('rx', String(roverWidthPx * 1.3));
          dustRef.current.setAttribute('ry', String(roverWidthPx * 0.22));
        }
      }

      if (t < DESCEND_MS + LOWER_MS + FLYAWAY_MS) raf = requestAnimationFrame(frame);
      else onDoneRef.current();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [control]);

  return (
    <svg className="skycrane" data-phase={phase} aria-hidden="true">
      <defs>
        <linearGradient id="ld-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c3c6ca" />
          <stop offset="1" stopColor="#5d6066" />
        </linearGradient>
        <radialGradient id="ld-tank" cx="0.35" cy="0.35">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#8d9298" />
        </radialGradient>
        <linearGradient id="ld-gold" x1="0" x2="1">
          <stop offset="0" stopColor="#8a6514" />
          <stop offset="0.45" stopColor="#e6c35c" />
          <stop offset="1" stopColor="#7a5810" />
        </linearGradient>
        <linearGradient id="ld-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.25" stopColor="#ffe9b0" />
          <stop offset="0.7" stopColor="#ff9a3c" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff5a1f" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="ld-dust">
          <stop offset="0" stopColor="#d6a078" stopOpacity="0.85" />
          <stop offset="1" stopColor="#b47850" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse ref={dustRef} className="lander-dust" fill="url(#ld-dust)" />

      <g className="lander-bridles">
        {BRIDLES.map((x, i) => (
          <line key={x} ref={(el) => void (bridleRefs.current[i] = el)} stroke="#e4ded2" strokeWidth="1.2" />
        ))}
      </g>

      {/* Descent stage, in stage units; the outer transform places and scales it every frame. */}
      <g ref={stageRef}>
        <g className="lander-stage">
          <g className="lander-flame">
            {ENGINES.map((x) => (
              <path key={x} transform={`rotate(${x < 100 ? 22 : -22} ${x} 108)`} d={`M${x - 3.5} 115 Q${x - 6} 138 ${x} 168 Q${x + 6} 138 ${x + 3.5} 115 Z`} fill="url(#ld-flame)" />
            ))}
          </g>
          {ENGINES.map((x) => (
            <path key={x} transform={`rotate(${x < 100 ? 22 : -22} ${x} 108)`} d={`M${x - 2.5} 104 L${x + 2.5} 104 L${x + 4} 115 L${x - 4} 115 Z`} fill="url(#ld-metal)" />
          ))}
          {/* Struts, frame, propellant tanks and the central avionics box */}
          <path d="M44 100 L72 80 M156 100 L128 80" stroke="#7f8389" strokeWidth="2" />
          <circle cx="70" cy="88" r="11" fill="url(#ld-tank)" />
          <circle cx="130" cy="88" r="11" fill="url(#ld-tank)" />
          <rect x="86" y="80" width="28" height="18" rx="1.5" fill="url(#ld-gold)" />
          <rect x="40" y="97" width="120" height="11" rx="2" fill="url(#ld-metal)" />
          <rect x="40" y="97" width="120" height="2" fill="#e3e5e8" />
        </g>
      </g>
    </svg>
  );
}
