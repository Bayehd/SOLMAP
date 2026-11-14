// Mars coordinates for a globe of radius 1 (1 unit = Mars radius).
import * as THREE from 'three';

export const MARS_RADIUS_KM = 3396;
export const MARS_RADIUS_M = MARS_RADIUS_KM * 1000;

/**
 * Degrees to add to a true east longitude to match the color texture.
 * The texture's left edge is 180°W and longitude increases eastward; checked
 * by Olympus Mons appearing at u ≈ 0.128. Change this if you swap the texture.
 */
export const TEXTURE_LON_OFFSET_DEG = 0;

const D2R = Math.PI / 180;

/** Point on the globe for planetocentric latitude and east longitude (degrees). Matches THREE.SphereGeometry's UVs. */
export function latLonToVec3(latDeg: number, lonDeg: number, radius = 1, out = new THREE.Vector3()): THREE.Vector3 {
  const lat = latDeg * D2R;
  const phi = (lonDeg + TEXTURE_LON_OFFSET_DEG + 180) * D2R;
  return out.set(-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)).multiplyScalar(radius);
}

/** Inverse of latLonToVec3. Longitude is returned in [-180, 180). */
export function vec3ToLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  const lat = Math.asin(THREE.MathUtils.clamp(v.y / v.length(), -1, 1)) / D2R;
  const lon = Math.atan2(v.z, -v.x) / D2R - 180 - TEXTURE_LON_OFFSET_DEG;
  return { lat, lon: (((lon % 360) + 540) % 360) - 180 };
}

/** Local east / north / up unit vectors at a point on the globe. */
export type TangentFrame = { up: THREE.Vector3; east: THREE.Vector3; north: THREE.Vector3 };

export function tangentFrame(point: THREE.Vector3): TangentFrame {
  const up = point.clone().normalize();
  const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  return { up, east, north };
}

/** Unit direction of a point given in km east and north of the frame's origin (gnomonic projection). */
export function localToDirection(f: TangentFrame, eastKm: number, northKm: number, out = new THREE.Vector3()) {
  return out
    .copy(f.up)
    .addScaledVector(f.east, eastKm / MARS_RADIUS_KM)
    .addScaledVector(f.north, northKm / MARS_RADIUS_KM)
    .normalize();
}

/** Inverse of localToDirection. Returns null for directions on the far side. */
export function directionToLocal(f: TangentFrame, dir: THREE.Vector3): { eastKm: number; northKm: number } | null {
  const d = dir.dot(f.up) / dir.length();
  if (d <= 0) return null;
  const k = MARS_RADIUS_KM / (d * dir.length());
  return { eastKm: dir.dot(f.east) * k, northKm: dir.dot(f.north) * k };
}

/** Great-circle distance in km between two lat/lon points (degrees). */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
