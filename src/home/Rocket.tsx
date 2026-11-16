// An Atlas V 541, the launcher of NASA's Curiosity and Perseverance Mars rovers, drawn in SVG:
// white 5 m payload fairing, Centaur upper stage, orange-tan foam-insulated core booster,
// solid rocket boosters, and an animated exhaust plume per nozzle.
// The ground-contact point is at y = 700 of the 100×800 viewBox (87.5%); home.css anchors the rocket by it.

import { publicUrl } from '../map/mars';

const SRB_X = [16.4, 83.6]; // centres of the two visible solid rocket boosters

export function Rocket() {
  return (
    <svg className="rocket-svg" viewBox="0 0 100 800" aria-hidden="true">
      <defs>
        {/* Horizontal shading per shape, so every cylinder reads as lit from the left. */}
        <linearGradient id="rk-white" x1="0" x2="1">
          <stop offset="0" stopColor="#9a9ea4" />
          <stop offset="0.3" stopColor="#ffffff" />
          <stop offset="0.62" stopColor="#e6e8eb" />
          <stop offset="1" stopColor="#80858c" />
        </linearGradient>
        <linearGradient id="rk-tan" x1="0" x2="1">
          <stop offset="0" stopColor="#7a5c48" />
          <stop offset="0.3" stopColor="#d8b8a0" />
          <stop offset="0.62" stopColor="#c09a80" />
          <stop offset="1" stopColor="#6a4e3d" />
        </linearGradient>
        <linearGradient id="rk-metal" x1="0" x2="1">
          <stop offset="0" stopColor="#55575b" />
          <stop offset="0.35" stopColor="#d4d6d9" />
          <stop offset="1" stopColor="#3e4044" />
        </linearGradient>
        <linearGradient id="rk-tray" x1="0" x2="1">
          <stop offset="0" stopColor="#6b4a2a" />
          <stop offset="0.5" stopColor="#b98a52" />
          <stop offset="1" stopColor="#5a3d22" />
        </linearGradient>
        <linearGradient id="rk-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.12" stopColor="#fff3c4" />
          <stop offset="0.45" stopColor="#ffb347" />
          <stop offset="0.8" stopColor="#ff5a1f" stopOpacity="0.6" />
          <stop offset="1" stopColor="#ff3d00" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="rk-glow">
          <stop offset="0" stopColor="#ffcf7a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff6a00" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Exhaust (behind the nozzles). Solids burn brighter and longer than the core engine. */}
      <g className="rocket-flame">
        <ellipse cx="50" cy="735" rx="58" ry="55" fill="url(#rk-glow)" />
        <path d="M43 700 Q39 735 50 778 Q61 735 57 700 Z" fill="url(#rk-flame)" />
        <path d="M46.5 700 Q45.5 716 50 734 Q54.5 716 53.5 700 Z" fill="#fffbe8" opacity="0.9" />
      </g>

      {/* Core booster: tan foam insulation with weld seams and the cable tray. */}
      <rect x="28" y="347" width="44" height="296" fill="url(#rk-tan)" />
      {[420, 500, 560, 610].map((y) => (
        <rect key={y} x="28" y={y} width="44" height="0.6" fill="#6a4e3d" opacity="0.45" />
      ))}
      <rect x="30.5" y="560" width="3.2" height="78" rx="1" fill="url(#rk-tray)" />
      {/* Aft skirt and the core engine nozzle */}
      <path d="M28 641 L72 641 L70 683 L30 683 Z" fill="url(#rk-white)" />
      <rect x="28" y="641" width="44" height="1.4" fill="#4a3a30" />
      <path d="M40 646 L50 672 L60 646" fill="none" stroke="#9b7d63" strokeWidth="1.6" />
      <path d="M44 683 L56 683 L59.5 700 L40.5 700 Z" fill="url(#rk-metal)" />

      {/* Solid rocket boosters, with their own plumes and struts to the core; they separate in flight. */}
      {SRB_X.map((x) => (
        <g key={x} className={`rocket-srb rocket-srb-${x < 50 ? 'l' : 'r'}`}>
          <g className="rocket-flame">
            <path d={`M${x - 6} 700 Q${x - 10} 745 ${x} 800 Q${x + 10} 745 ${x + 6} 700 Z`} fill="url(#rk-flame)" />
            <path d={`M${x - 3} 700 Q${x - 4} 722 ${x} 745 Q${x + 4} 722 ${x + 3} 700 Z`} fill="#fffbe8" opacity="0.9" />
          </g>
          <path d={`M${x - 10} 508 C${x - 10} 494 ${x - 5} 484 ${x} 482 C${x + 5} 484 ${x + 10} 494 ${x + 10} 508 Z`} fill="url(#rk-white)" />
          <rect x={x - 10} y="508" width="20" height="175" fill="url(#rk-white)" />
          <rect x={x - 10} y="508" width="20" height="0.6" fill="#8a8f96" />
          <path d={`M${x - 4} 683 L${x + 4} 683 L${x + 6.5} 700 L${x - 6.5} 700 Z`} fill="url(#rk-metal)" />
          {[530, 668].map((y) => (
            <rect key={y} x={x < 50 ? x + 10 : 72} y={y} width={x < 50 ? 28 - x - 10 : x - 10 - 72} height="2.4" fill="#5c5f64" />
          ))}
        </g>
      ))}

      {/* Centaur upper stage (white) with the black interstage ring below it */}
      <rect x="28" y="296" width="44" height="49" fill="url(#rk-white)" />
      <rect x="28" y="343" width="44" height="4" fill="#26211e" />
      <rect x="28" y="341.5" width="44" height="0.6" fill="#6b6f75" />

      {/* Payload fairing: ogive nose, cylinder, boattail */}
      <path d="M18 118 C18 72 36 34 47.5 21.5 Q50 18.5 52.5 21.5 C64 34 82 72 82 118 Z" fill="url(#rk-white)" />
      <rect x="18" y="117.5" width="64" height="150" fill="url(#rk-white)" />
      <path d="M18 267 L82 267 L72 297 L28 297 Z" fill="url(#rk-white)" />
      {/* Panel seams */}
      {[118, 182, 238, 267].map((y) => (
        <rect key={y} x="18" y={y} width="64" height="0.5" fill="#9ea3aa" opacity="0.7" />
      ))}
      {/* Access doors */}
      <rect x="45" y="184" width="7" height="5" rx="1.6" fill="none" stroke="#b3b8be" strokeWidth="0.6" />
      <rect x="62" y="202" width="7" height="5" rx="1.6" fill="none" stroke="#b3b8be" strokeWidth="0.6" />
      {/* Vent-hole rows */}
      {[229, 250].map((y) =>
        [21, 24, 27, 30, 33, 36, 39, 61, 64, 67, 70, 73, 76, 79].map((x) =>
          y === 250 && x > 26 && x < 70 ? null : <rect key={`${x}-${y}`} x={x} y={y} width="0.9" height="2.2" fill="#2a2d31" />,
        ),
      )}
      {/* SOLMAP mission badge, painted on the fairing where the NASA insignia was */}
      <image href={publicUrl('home/solmap-badge.webp')} x="19.8" y="194.5" width="30" height="30" preserveAspectRatio="xMidYMid meet" />
    </svg>
  );
}
