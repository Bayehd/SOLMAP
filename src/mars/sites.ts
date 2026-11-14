// Preset sites. To add one, see README, "Adding a site".
export type Site = {
  id: string; // also the MOLA grid name: public/data/sites/{id}.bin
  name: string;
  lat: number; // planetocentric, degrees
  lon: number; // east longitude, degrees
  altitude: number; // top-view camera height above the site (1 = Mars radius ≈ 3396 km)
  patchSizeKm: number; // width of the MOLA area around the site (Top view pan limit, grid window)
  sliceKm: number; // width of the square slice shown as layers in the Front view (≤ patchSizeKm)
  roverStart?: { lat: number; lon: number }; // where the rover starts in the Top view (default: site center)
  description: string;
};

export const SITES: Site[] = [
  {
    id: 'olympus-mons',
    name: 'Olympus Mons',
    lat: 18.65,
    lon: 226.2,
    altitude: 0.15,
    patchSizeKm: 300,
    sliceKm: 220,
    description: 'The tallest volcano in the Solar System: about 21.9 km high and 600 km across.',
  },
  {
    id: 'jezero-crater',
    name: 'Jezero Crater',
    lat: 18.38,
    lon: 77.58,
    altitude: 0.045,
    patchSizeKm: 120,
    sliceKm: 110,
    roverStart: { lat: 18.4447, lon: 77.4508 }, // Octavia E. Butler Landing, Feb 2021
    description: 'A 45 km crater with an ancient river delta. Perseverance rover landing site (2021).',
  },
  {
    id: 'gale-crater',
    name: 'Gale Crater',
    lat: -5.4,
    lon: 137.8,
    altitude: 0.1,
    patchSizeKm: 260,
    sliceKm: 240,
    description: 'A 154 km crater around the 5 km high Mount Sharp. Curiosity rover landing site (2012).',
  },
];
