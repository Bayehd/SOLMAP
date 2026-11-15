// Oxygen use on a route, from the team's formula:
//   O2 used (%) = D x 0.004 + E_up x 0.025 + T x 0.0018
// D = walking distance in metres, E_up = total climb in metres, T = walking time in minutes.
// One tank lasts 7 hours. These coefficients are our assumption, not NASA suit data.

export const OXYGEN = {
  perMetre: 0.004, // % of a tank per metre walked
  perClimbMetre: 0.025, // % of a tank per metre climbed
  perMinute: 0.0018, // % of a tank per minute
  tankHours: 7, // hours one tank lasts
};

export interface OxygenUse {
  pct: number; // % of ONE tank used by the formula (can be over 100)
  tanks: number; // whole tanks needed
}

export function oxygenUse(s: { distanceM: number; climbM: number; timeMin: number }): OxygenUse {
  const pct = s.distanceM * OXYGEN.perMetre + s.climbM * OXYGEN.perClimbMetre + s.timeMin * OXYGEN.perMinute;
  // Also never plan for less than the time rule: a tank lasts 7 h whatever the formula says.
  const byTime = s.timeMin / 60 / OXYGEN.tankHours;
  const tanks = Math.max(1, Math.ceil(Math.max(pct / 100, byTime) - 1e-9));
  return { pct, tanks };
}
