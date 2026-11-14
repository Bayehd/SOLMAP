// Home page -> launch -> fly to Jezero -> rocket lands at the landing site.
import { useEffect, useMemo, useState } from 'react';
import { MapApp } from './map/MapApp';
import { Rocket } from './home/Rocket';
import './home/home.css';

// idle: on the pad · ignite: engine starts · launch: lifts off the home page
// waiting: off-screen while the camera flies · approach: repositioned above the site (no transition)
// descend: powered landing · landed: engine off · done: rocket faded out
type Phase = 'idle' | 'ignite' | 'launch' | 'waiting' | 'approach' | 'descend' | 'landed' | 'done';

const IGNITE_MS = 900;
const LAUNCH_MS = 1500;
const DESCEND_MS = 3200;
const LANDED_MS = 2600;

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
      descend: ['landed', DESCEND_MS],
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
          intro={
            instant
              ? undefined
              : { fly, onReady: () => setMapReady(true), onArrive: () => setPhase((p) => (p === 'waiting' ? 'approach' : p)) }
          }
        />
      )}

      {(phase === 'idle' || phase === 'ignite' || phase === 'launch' || phase === 'waiting') && (
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

      {phase !== 'done' && (
        <div className="rocket" data-phase={phase}>
          <Rocket />
          <div className="rocket-dust" />
        </div>
      )}
    </>
  );
}
