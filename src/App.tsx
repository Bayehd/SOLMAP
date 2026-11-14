// Home page -> launch -> fly to Jezero -> rocket lands at the landing site.
import { useEffect, useMemo, useState } from 'react';
import { MapApp } from './map/MapApp';
import { Rocket } from './home/Rocket';
import { Lander } from './home/Lander';
import './home/home.css';

// Rocket: idle (on the pad) · ignite · launch (boosters separate on the way up) · waiting (off-screen while the camera flies)
// Lander: approach (placed above the site, no transition) · descend (powered descent, rover tucked in)
//         · lower (sky crane lowers the rover) · flyaway (bridles cut, descent stage leaves) · landed (rover raises its mast)
// done: everything gone, just the map
type Phase = 'idle' | 'ignite' | 'launch' | 'waiting' | 'approach' | 'descend' | 'lower' | 'flyaway' | 'landed' | 'done';

const IGNITE_MS = 900;
const LAUNCH_MS = 2400;
const DESCEND_MS = 3000;
const LOWER_MS = 1800;
const FLYAWAY_MS = 1600;
const LANDED_MS = 3200;

const ROCKET_PHASES: Phase[] = ['idle', 'ignite', 'launch', 'waiting'];
const LANDER_PHASES: Phase[] = ['approach', 'descend', 'lower', 'flyaway', 'landed'];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mapMounted, setMapMounted] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [instant, setInstant] = useState(false); // reduced motion: straight to the map

  // Phase timers.
  useEffect(() => {
    const next: Partial<Record<Phase, [Phase, number]>> = {
      ignite: ['launch', IGNITE_MS],
      launch: ['waiting', LAUNCH_MS],
      descend: ['lower', DESCEND_MS],
      lower: ['flyaway', LOWER_MS],
      flyaway: ['landed', FLYAWAY_MS],
      landed: ['done', LANDED_MS],
    };
    const step = next[phase];
    if (!step) return;
    const t = setTimeout(() => setPhase(step[0]), step[1]);
    return () => clearTimeout(t);
  }, [phase]);

  // approach -> descend on the next frame, so the jump to the top of the screen isn't animated.
  useEffect(() => {
    if (phase !== 'approach') return;
    let r2 = 0;
    const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => setPhase('descend'))));
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [phase]);

  const launch = () => {
    setMapMounted(true);
    if (reducedMotion()) {
      setInstant(true);
      setPhase('done');
    } else setPhase('ignite');
  };

  const homeVisible = !instant && (phase === 'idle' || phase === 'ignite' || phase === 'launch' || (phase === 'waiting' && !mapReady));
  const fly = phase === 'waiting' && mapReady;

  const stars = useMemo(() => {
    // Sparse, dim stars as one box-shadow so the page stays black.
    const s: string[] = [];
    for (let i = 0; i < 140; i++) {
      const a = (0.15 + Math.random() * 0.45).toFixed(2);
      s.push(`${(Math.random() * 100).toFixed(2)}vw ${(Math.random() * 100).toFixed(2)}vh 0 ${Math.random() < 0.1 ? 0.6 : 0}px rgba(255,255,255,${a})`);
    }
    return s.join(',');
  }, []);

  return (
    <>
      {mapMounted && (
        <MapApp
          showRover={instant || phase === 'landed' || phase === 'done'}
          intro={
            instant
              ? undefined
              : { fly, onReady: () => setMapReady(true), onArrive: () => setPhase((p) => (p === 'waiting' ? 'approach' : p)) }
          }
        />
      )}

      {ROCKET_PHASES.includes(phase) && (
        <div className="home" data-hidden={!homeVisible}>
          <div className="home-stars" style={{ boxShadow: stars }} />
          <main className="home-content">
            <p className="home-kicker">SOLMAP · Mars</p>
            <h1 className="home-title">Choose your landing area</h1>
            <button className="home-site" onClick={launch} disabled={phase !== 'idle'}>
              <span className="home-site-name">Jezero Crater</span>
              <span className="home-site-meta">Landing area · 18.44° N, 77.45° E</span>
              <span className="home-site-go" aria-hidden="true">
                {phase === 'idle' ? 'Launch →' : 'Launching…'}
              </span>
            </button>
          </main>
          <div className="home-pad" />
        </div>
      )}

      {ROCKET_PHASES.includes(phase) && (
        <div className="rocket" data-phase={phase}>
          <Rocket />
        </div>
      )}
      {LANDER_PHASES.includes(phase) && (
        <div className="lander" data-phase={phase}>
          <Lander />
        </div>
      )}
    </>
  );
}
