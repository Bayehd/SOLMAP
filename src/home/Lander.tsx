// Mars 2020 entry, descent and landing, simplified: the descent stage flies the rover down under
// rocket power, lowers it on bridles (the "sky crane"), cuts them at touchdown and flies away.
// Side view in a 200×300 viewBox; the rover's wheels touch the ground at y = 280 (93.33%), which
// home.css anchors on the landing site. Parts move by CSS on the wrapper's data-phase.

const ENGINES = [43, 54, 146, 157]; // descent engines, in pairs at each end (4 of the 8 visible in side view)
const BRIDLES = [86, 100, 114];

export function Lander() {
  return (
    <svg className="lander-svg" viewBox="0 0 200 300" aria-hidden="true">
      <defs>
        <linearGradient id="ld-white" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#a9adb3" />
        </linearGradient>
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

      {/* Dust kicked up at touchdown */}
      <ellipse className="lander-dust" cx="100" cy="280" rx="80" ry="9" fill="url(#ld-dust)" />

      {/* Bridles: drawn full length (y 108 -> 228) and scaled from the top while the rover is reeled in. */}
      <g className="lander-bridles">
        {BRIDLES.map((x) => (
          <line key={x} x1={x} y1="108" x2={x} y2="228" stroke="#d9d4c8" strokeWidth="0.9" />
        ))}
      </g>

      {/* Rover (side view, facing left) */}
      <g className="lander-rover">
        {/* Rocker-bogie suspension and wheels */}
        <path d="M68 270 L84 250 L100 270 M84 250 L112 244 L132 270" fill="none" stroke="#9a9da2" strokeWidth="3" strokeLinejoin="round" />
        {[68, 100, 132].map((x) => (
          <g key={x}>
            <circle cx={x} cy="270" r="10" fill="#2b2b2e" stroke="#8d8f93" strokeWidth="1.6" />
            <circle cx={x} cy="270" r="3" fill="#b8bbc0" />
          </g>
        ))}
        {/* Chassis and deck */}
        <rect x="62" y="230" width="72" height="17" rx="2" fill="url(#ld-white)" />
        <rect x="64" y="226" width="66" height="5" rx="1" fill="#d6d8db" />
        <rect x="62" y="244" width="72" height="3" fill="#7f8389" />
        {/* High-gain antenna */}
        <ellipse cx="108" cy="225" rx="7" ry="2.4" fill="#9aa0a6" />
        {/* RTG power source at the back */}
        <g transform="rotate(-35 140 236)">
          <rect x="136" y="222" width="10" height="26" rx="3" fill="#3a3b3f" />
          {[226, 231, 236, 241].map((y) => (
            <rect key={y} x="133" y={y} width="16" height="1.4" fill="#55575c" />
          ))}
        </g>
        {/* Robotic arm, stowed at the front, with its turret */}
        <path d="M62 236 L54 236 L54 252 L60 255" fill="none" stroke="#b5b8bc" strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx="60" cy="255" r="3.6" fill="#8d9096" />
        {/* Remote-sensing mast: stowed flat during descent, raised after landing */}
        <g className="lander-mast">
          <rect x="70" y="186" width="4" height="42" fill="#cfd2d6" />
          <rect x="63" y="177" width="18" height="10" rx="2" fill="#e8eaed" />
          <rect x="65" y="180" width="5" height="3.4" rx="0.8" fill="#1c2430" />
          <rect x="72" y="180" width="5" height="3.4" rx="0.8" fill="#1c2430" />
        </g>
      </g>

      {/* Descent stage */}
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
    </svg>
  );
}
