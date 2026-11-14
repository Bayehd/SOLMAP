// Camera flights between two poses, e.g. from the globe view to a site.
import * as THREE from 'three';
import { latLonToVec3, tangentFrame } from './geo';
import type { Site } from './sites';

export type CameraPose = { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 };

export const FLY_DURATION = 2.5; // seconds
const FRONT_TILT = THREE.MathUtils.degToRad(72); // front view: angle off vertical, like map navigation

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export const DEFAULT_POSE: CameraPose = {
  position: new THREE.Vector3(0, 0, 3),
  target: new THREE.Vector3(0, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
};

/** Top view: straight above the site, looking down, north at the top of the screen. */
export function topPose(site: Site, surfaceRadius = 1): CameraPose {
  const f = tangentFrame(latLonToVec3(site.lat, site.lon));
  const target = f.up.clone().multiplyScalar(surfaceRadius);
  return { position: target.clone().addScaledVector(f.up, site.altitude), target, up: f.north.clone() };
}

export type Focus = { center: THREE.Vector3; radius: number };

/**
 * Front view: low and to the south-west, corner-on to the layer block, looking
 * almost parallel to the surface. Frames `focus` (the block) when given.
 */
export function frontPose(site: Site, focus?: Focus | null): CameraPose {
  const f = tangentFrame(latLonToVec3(site.lat, site.lon));
  const target = focus ? focus.center.clone() : f.up.clone();
  const distance = focus ? focus.radius * FRONT_FIT : site.altitude * 0.6;
  const southWest = f.north.clone().add(f.east).multiplyScalar(-Math.SQRT1_2);
  const back = f.up.clone().multiplyScalar(Math.cos(FRONT_TILT)).addScaledVector(southWest, Math.sin(FRONT_TILT));
  return { position: target.clone().addScaledVector(back, distance), target, up: f.up };
}

/** Camera distance in block radii: room for the block plus its labels. */
export const FRONT_FIT = 3.4;

export const FRONT_POLAR_ANGLE = FRONT_TILT;

export type Flight = { duration: number; poseAt(seconds: number, out: CameraPose): void };

/**
 * Swings the camera's direction around the planet while its height above the
 * surface changes geometrically (e.g. 2 → 0.02 units), so the zoom feels even.
 */
export function createFlight(from: CameraPose, to: CameraPose, duration = FLY_DURATION): Flight {
  const dir0 = from.position.clone().normalize();
  const dir1 = to.position.clone().normalize();
  const alt0 = Math.max(1e-6, from.position.length() - 1);
  const alt1 = Math.max(1e-6, to.position.length() - 1);
  const turn = new THREE.Quaternion().setFromUnitVectors(dir0, dir1);
  const q = new THREE.Quaternion();
  const view = new THREE.Vector3();

  return {
    duration,
    poseAt(seconds, out) {
      const e = easeInOutCubic(THREE.MathUtils.clamp(seconds / duration, 0, 1));
      q.identity().slerp(turn, e);
      out.position.copy(dir0).applyQuaternion(q).multiplyScalar(1 + alt0 * (alt1 / alt0) ** e);
      out.target.lerpVectors(from.target, to.target, e);
      // Blend the up vector, then keep it perpendicular to the view direction.
      view.subVectors(out.target, out.position).normalize();
      out.up.lerpVectors(from.up, to.up, e);
      out.up.addScaledVector(view, -out.up.dot(view));
      if (out.up.lengthSq() < 1e-8) out.up.copy(to.up);
      out.up.normalize();
    },
  };
}
