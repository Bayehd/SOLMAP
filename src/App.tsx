// Home page -> launch -> fly to Jezero -> rocket lands at the landing site.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapApp } from './map/MapApp';
import { Rocket } from './home/Rocket';
import { Lander } from './home/Lander';
import type { RoverControl } from './map/rover';
import './home/home.css';

// Rocket: idle (on the pad) · ignite · launch (boosters separate on the way up) · waiting (off-screen while the camera flies)
// landing: the sky crane brings the 3D rover down onto Jezero (timed by <Lander>)
// done: the rover stays on the terrain, just the map
type Phase = 'idle' | 'ignite' | 'launch' | 'waiting' | 'landing' | 'done';

const IGNITE_MS = 900;
const LAUNCH_MS = 2400;

const ROCKET_PHASES: Phase[] = ['idle', 'ignite', 'launch', 'waiting'];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mapMounted, setMapMounted] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [instant, setInstant] = useState(false); // reduced motion: straight to the map
  const roverControl = useRef<RoverControl | null>(null);

  // Phase timers.
  useEffect(() => {
    const next: Partial<Record<Phase, [Phase, number]>> = {
      ignite: ['launch', IGNITE_MS],
      launch: ['waiting', LAUNCH_MS],
    };
    const step = next[phase];
    if (!step) return;
    const t = setTimeout(() => setPhase(step[0]), step[1]);
    return () => clearTimeout(t);
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
          showRover={instant || phase === 'landing' || phase === 'done'}
          roverControl={roverControl}
          intro={
            instant
              ? undefined
              : { fly, onReady: () => setMapReady(true), onArrive: () => setPhase((p) => (p === 'waiting' ? 'landing' : p)) }
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
      {phase === 'landing' && <Lander control={roverControl} onDone={() => setPhase('done')} />}
    </>
  );
}
