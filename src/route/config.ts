// Route planner settings. Everything here is an ASSUMPTION of ours, not a NASA value.
// The planner shows these on screen (Assumptions card) so nobody mistakes them for mission limits.

export type Weights = {
  slope: number; // extra cost on steep ground (0 = ignore, up to the no-go limit which is always blocked)
  roughness: number; // extra cost on bumpy ground (local variation of slope)
  radio: number; // extra cost where the walker has no radio line of sight to the base antenna
  radiation: number; // extra cost where the modelled radiation exposure is higher
  science: number; // discount near mineral detections and Perseverance sample sites
};

export const DEFAULT_WEIGHTS: Weights = { slope: 3, roughness: 1, radio: 0.5, radiation: 0.3, science: 0 };

/** Slider ranges for the panel. */
export const WEIGHT_RANGES: Record<keyof Weights, { max: number; step: number }> = {
  slope: { max: 6, step: 0.5 },
  roughness: { max: 3, step: 0.25 },
  radio: { max: 2, step: 0.25 },
  radiation: { max: 2, step: 0.1 },
  science: { max: 0.6, step: 0.05 },
};

export const ASSUMPTIONS = {
  /** Slope above which extra cost starts to rise (below it, slope adds no cost). */
  comfortSlopeDeg: 10,
  /** Flat-ground walking speed in a suit. Effort scales it down on slopes. */
  walkSpeedKmh: 3,
  /** A hypothetical base antenna stands at the site's landing point (as in scripts/build_jezero_safety_layers.py). */
  baseAntennaM: 3,
  walkerAntennaM: 2,
  /** Relative increase of galactic cosmic ray dose per km of elevation (less air overhead). MODELLED. */
  radiationPerKm: 0.05,
  /** How far terrain around a point blocks the sky for the radiation model. */
  skyHorizonM: 1500,
  /** A sample site counts as "visited" if the route passes this close. */
  scienceRadiusM: 150,
  /** Margin around the two points (and the base) when reading the terrain. */
  windowMarginM: 1500,
  /** Target cell size, and the largest window side in cells (coarser cells beyond that). */
  cellM: 20,
  maxSideCells: 1100,
};

/** Hazard bands, as reviewed by the team: caution from 16°, no-go from 20°. The Hazards layer (SLOPE_CLASSES in
 * map/layers.ts) uses the same bands. Our assumption, not a NASA standard. */
export const LIMITS = { cautionDeg: 16, nogoDeg: 20 };
