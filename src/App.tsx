// Home page: pick a landing area (Jezero Crater or Gale Crater) -> launch -> fly there -> the rover lands at
// the start of its traverse. From the map, "Go to Earth" sends the rocket to the Earth page; "Back to Mars"
// flies home again and the sky crane lowers the rover back at the same site.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MapApp } from './map/MapApp';
import { EarthApp } from './earth/EarthApp';
import { Rocket } from './home/Rocket';
import { Lander } from './home/Lander';
import type { RoverControl } from './map/rover';
import { SITES, formatLatLon, type SiteId } from './map/sites';
import { publicUrl } from './map/mars';
import './home/home.css';

// Rocket: idle (on the pad) · ignite · launch (boosters separate on the way up) · waiting (off-screen while the camera flies)
// landing: the sky crane brings the 3D rover down onto the site (timed by <Lander>)
// done: the rover stays on the terrain, just the map
type Phase = 'idle' | 'ignite' | 'launch' | 'waiting' | 'landing' | 'done';

// Trip between planets: ignite -> launch (Atlas V lifts off, black star curtain fades in)
// -> transit (planets swapped; the curtain stays until the new globe has loaded) -> none.
type World = 'mars' | 'earth';
type Trip = 'none' | 'ignite' | 'launch' | 'transit';
type Pad = { x: number; y: number };

const IGNITE_MS = 900;
const LAUNCH_MS = 2400;

const ROCKET_PHASES: Phase[] = ['idle', 'ignite', 'launch', 'waiting'];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [siteId, setSiteId] = useState<SiteId>('jezero'); // the landing area picked on the home page
  const site = SITES[siteId];
  const [mapMounted, setMapMounted] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [instant, setInstant] = useState(false); // reduced motion: straight to the map
  const roverControl = useRef<RoverControl | null>(null);
  const [world, setWorld] = useState<World>('mars');
  const [trip, setTrip] = useState<Trip>('none');
  const [pad, setPad] = useState<Pad | null>(null); // where the rocket stands when it leaves the Mars map
  const [earthReady, setEarthReady] = useState(false);
  const [fromEarth, setFromEarth] = useState(false); // coming back from Earth: no home page, just the landing
  const worldRef = useRef(world);
  worldRef.current = world;
  const instantRef = useRef(instant);
  instantRef.current = instant;

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

  // Trip timers: ignite -> launch -> transit.
  const enterTransit = () => {
    setTrip('transit');
    setEarthReady(false);
    if (worldRef.current === 'mars') {
      setWorld('earth');
      setMapMounted(false); // free the Mars globe while we are away
      setMapReady(false);
    } else {
      setWorld('mars');
      setMapMounted(true);
      setMapReady(false);
      setFromEarth(true);
      setPhase(instantRef.current ? 'done' : 'waiting'); // 'waiting' -> fly down, then the sky-crane landing as on the first visit
    }
  };
  useEffect(() => {
    const next: Partial<Record<Trip, [Trip, number]>> = { ignite: ['launch', IGNITE_MS], launch: ['transit', LAUNCH_MS] };
    const step = next[trip];
    if (!step) return;
    const t = setTimeout(() => (step[0] === 'transit' ? enterTransit() : setTrip(step[0])), step[1]);
    return () => clearTimeout(t);
  }, [trip]);

  // The trip ends when the planet we are heading to has loaded.
  useEffect(() => {
    if (trip !== 'transit') return;
    if (world === 'earth' && earthReady) setTrip('none');
    else if (world === 'mars' && !instant && mapReady) setTrip('none');
    else if (world === 'mars' && instant) {
      const t = setTimeout(() => setTrip('none'), 800);
      return () => clearTimeout(t);
    }
  }, [trip, world, earthReady, mapReady, instant]);

  useEffect(() => {
    if (phase === 'done') setFromEarth(false);
  }, [phase]);

  const startTrip = (p: Pad | null) => {
    setPad(p);
    if (reducedMotion()) enterTransit();
    else setTrip('ignite');
  };

  const launch = (id: SiteId) => {
    setSiteId(id);
    setMapMounted(true);
    if (reducedMotion()) {
      setInstant(true);
      setPhase('done');
    } else setPhase('ignite');
  };

  const tripFlying = trip === 'ignite' || trip === 'launch';
  const rocketPhase = tripFlying ? trip : phase;
  const rocketStyle = tripFlying && pad ? ({ '--rx': `${pad.x}px`, '--ry': `${pad.y}px`, '--h': 'min(46vh, 340px)' } as CSSProperties) : undefined;
  const showHome = !fromEarth && ROCKET_PHASES.includes(phase);
  const showRocket = tripFlying || showHome;
  const curtain = trip === 'launch' || trip === 'transit';

  const homeVisible = !instant && (phase === 'idle' || phase === 'ignite' || phase === 'launch' || (phase === 'waiting' && !mapReady));
  const fly = phase === 'waiting' && mapReady;

  const stars = useMemo(() => {
    // Star field as box-shadows, dense and bright enough to read like the space behind the globe.
    // "small" is a lot of faint 1px stars; "big" is a few brighter, larger stars that twinkle (see home.css).
    const make = (count: number, minAlpha: number, maxAlpha: number, spread: () => number) => {
      const s: string[] = [];
      for (let i = 0; i < count; i++) {
        const a = (minAlpha + Math.random() * (maxAlpha - minAlpha)).toFixed(2);
        s.push(`${(Math.random() * 100).toFixed(2)}vw ${(Math.random() * 100).toFixed(2)}vh 0 ${spread().toFixed(2)}px rgba(255,255,255,${a})`);
      }
      return s.join(',');
    };
    return {
      small: make(450, 0.3, 0.85, () => 0),
      big: make(70, 0.7, 1, () => 0.4 + Math.random() * 0.6),
    };
  }, []);

  return (
    <>
      {world === 'mars' && mapMounted && (
        <MapApp
          key={site.id}
          site={site}
          onTravel={startTrip}
          canTravel={phase === 'done' && trip === 'none'}
          showRover={instant || phase === 'landing' || phase === 'done'}
          roverControl={roverControl}
          intro={
            instant
              ? undefined
              : { fly, onReady: () => setMapReady(true), onArrive: () => setPhase((p) => (p === 'waiting' ? 'landing' : p)) }
          }
        />
      )}

      {world === 'earth' && <EarthApp onReady={() => setEarthReady(true)} onBack={() => startTrip(null)} canLeave={trip === 'none'} />}

      {showHome && (
        <div className="home" data-hidden={!homeVisible}>
          <div className="home-stars" style={{ boxShadow: stars.small }} />
          <div className="home-stars home-stars-big" style={{ boxShadow: stars.big }} />
          <img className="home-badge" src={publicUrl('home/solmap-badge.webp')} alt="SOLMAP · Project Red Horizon · Planetary mapping & navigation" />
          <main className="home-content">
            <h1 className="home-title">Choose your landing area</h1>
            <div className="home-sites">
              {Object.values(SITES).map((s) => (
                <button
                  key={s.id}
                  className="home-site"
                  onClick={() => launch(s.id)}
                  disabled={phase !== 'idle'}
                  data-launching={phase !== 'idle' && siteId === s.id}
                  title={`${s.rover} · ${formatLatLon(s.landing.lat, s.landing.lon)}`}
                >
                  <img className="home-site-img" src={publicUrl(`home/${s.id}.webp`)} alt="" />
                  <span className="home-site-name">{s.name}</span>
                </button>
              ))}
            </div>
          </main>
          <div className="home-pad" />
        </div>
      )}

      <div className="curtain" data-on={curtain}>
        <div className="home-stars" style={{ boxShadow: stars.small }} />
        <div className="home-stars home-stars-big" style={{ boxShadow: stars.big }} />
      </div>

      {showRocket && (
        <div className="rocket" data-phase={rocketPhase} style={rocketStyle}>
          <Rocket />
        </div>
      )}
      {phase === 'landing' && <Lander control={roverControl} onDone={() => setPhase('done')} />}
    </>
  );
}
