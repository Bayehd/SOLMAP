// A compact launcher drawn in SVG: shaded cylindrical body, nose cone, fins, engine bell,
// fold-out landing legs and an animated exhaust plume. The ground-contact point is at y = 210
// of the 60×300 viewBox (70% of the height); home.css anchors the rocket by that point.
export function Rocket() {
  return (
    <svg className="rocket-svg" viewBox="0 0 60 300" aria-hidden="true">
      <defs>
        {/* Horizontal shading so the body reads as a lit cylinder. */}
        <linearGradient id="rk-body" x1="0" x2="1">
          <stop offset="0" stopColor="#7d838a" />
          <stop offset="0.32" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#dfe2e6" />
          <stop offset="1" stopColor="#5f646b" />
        </linearGradient>
        <linearGradient id="rk-dark" x1="0" x2="1">
          <stop offset="0" stopColor="#15171a" />
          <stop offset="0.35" stopColor="#4a4f56" />
          <stop offset="1" stopColor="#0d0e10" />
        </linearGradient>
        <linearGradient id="rk-metal" x1="0" x2="1">
          <stop offset="0" stopColor="#3a3330" />
          <stop offset="0.4" stopColor="#9a8f86" />
          <stop offset="1" stopColor="#2a2523" />
        </linearGradient>
        <linearGradient id="rk-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.15" stopColor="#fff3c4" />
          <stop offset="0.45" stopColor="#ffb347" />
          <stop offset="0.8" stopColor="#ff5a1f" stopOpacity="0.6" />
          <stop offset="1" stopColor="#ff3d00" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="rk-glow">
          <stop offset="0" stopColor="#ffcf7a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff6a00" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Exhaust (behind everything so the bell overlaps it). */}
      <g className="rocket-flame">
        <ellipse cx="30" cy="236" rx="22" ry="34" fill="url(#rk-glow)" />
        <path d="M21 206 Q18 240 30 292 Q42 240 39 206 Z" fill="url(#rk-flame)" />
        <path d="M25 206 Q24 226 30 252 Q36 226 35 206 Z" fill="#fffbe8" opacity="0.9" />
      </g>

      {/* Landing legs: pivot at the top, fold flat against the body. */}
      <g className="rocket-leg rocket-leg-l">
        <path d="M17 158 L15.5 158 L13.5 214 L16 214 Z" fill="url(#rk-dark)" />
        <rect x="10" y="212.5" width="8" height="2.5" rx="1" fill="#1d1f22" />
      </g>
      <g className="rocket-leg rocket-leg-r">
        <path d="M43 158 L44.5 158 L46.5 214 L44 214 Z" fill="url(#rk-dark)" />
        <rect x="42" y="212.5" width="8" height="2.5" rx="1" fill="#1d1f22" />
      </g>

      {/* Engine bell */}
      <path d="M24 192 L36 192 L39.5 208 L20.5 208 Z" fill="url(#rk-metal)" />
      <rect x="20.5" y="206.5" width="19" height="2" rx="0.8" fill="#1b1716" />

      {/* Fins */}
      <path d="M18 156 L7 190 L7 197 L18 190 Z" fill="url(#rk-dark)" />
      <path d="M42 156 L53 190 L53 197 L42 190 Z" fill="url(#rk-dark)" />

      {/* Body + nose cone */}
      <path d="M18 56 Q19 22 30 4 Q41 22 42 56 Z" fill="url(#rk-body)" />
      <rect x="18" y="56" width="24" height="137" fill="url(#rk-body)" />
      {/* Fairing seam, interstage and base bands */}
      <rect x="18" y="56" width="24" height="1.2" fill="#9aa0a6" />
      <rect x="18" y="116" width="24" height="9" fill="url(#rk-dark)" />
      <rect x="18" y="186" width="24" height="7" fill="url(#rk-dark)" />
      {/* Grid fins at the top of the first stage */}
      <rect x="15" y="127" width="3" height="6" fill="#2b2e33" />
      <rect x="42" y="127" width="3" height="6" fill="#2b2e33" />
      {/* Porthole and vertical lettering stripe */}
      <circle cx="30" cy="76" r="4.2" fill="#1a2330" stroke="#8a9098" strokeWidth="1.2" />
      <circle cx="28.6" cy="74.6" r="1.2" fill="#9fc3e6" opacity="0.8" />
      <rect x="28.7" y="138" width="2.6" height="40" rx="1" fill="#c0392b" opacity="0.85" />
    </svg>
  );
}
