// Owns the camera: globe orbit, fly-to animations, and the site's Top and Front views.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_POSE, FRONT_POLAR_ANGLE, createFlight, frontPose, topPose, type CameraPose, type Flight, type Focus } from './flyTo';
import { MARS_RADIUS_KM, directionToLocal, latLonToVec3, localToDirection, tangentFrame } from './geo';
import type { Site } from './sites';

export type View = 'globe' | 'flying' | 'top' | 'front';
export type FlightRequest = { to: Exclude<View, 'flying'>; id: number };

type Props = {
  view: View;
  site: Site | null;
  focus: Focus | null; // what the Front view frames (the layer block), when there is one
  flight: FlightRequest | null;
  onArrive(view: Exclude<View, 'flying'>): void;
};

const MIN_CLEARANCE = 0.05 / MARS_RADIUS_KM; // keep the camera 50 m above the globe
const VIEW_SWITCH_SECONDS = 1.2;

export function CameraRig({ view, site, focus, flight, onArrive }: Props) {
  const camera = useThree((s) => s.camera);
  const dom = useThree((s) => s.gl.domElement);
  const controls = useRef<OrbitControls | null>(null);
  const target = useRef(new THREE.Vector3()); // where the camera currently looks
  const active = useRef<{ flight: Flight; t: number; to: FlightRequest['to'] } | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const pose = useRef<CameraPose>({ position: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3() });

  // Start a flight when a new request arrives.
  useEffect(() => {
    if (!flight) return;
    let end = DEFAULT_POSE;
    if (site && flight.to === 'top') end = topPose(site);
    if (site && flight.to === 'front') end = frontPose(site, focusRef.current);
    const from = { position: camera.position.clone(), target: target.current.clone(), up: camera.up.clone() };
    // Switching between Top and Front at the same site is a short move, not a full fly-to.
    const nearby = flight.to !== 'globe' && from.target.distanceTo(end.target) < 0.1;
    const seconds = nearby ? VIEW_SWITCH_SECONDS : undefined;
    active.current = { flight: createFlight(from, end, seconds), t: 0, to: flight.to };
  }, [flight?.id]);

  // Controls for the current view. OrbitControls reads camera.up only when it is
  // created, so a new instance is made for each view; none exists during a flight.
  useEffect(() => {
    if (view === 'flying' || (view !== 'globe' && !site)) return;
    const start = view === 'globe' ? DEFAULT_POSE : view === 'top' ? topPose(site!) : frontPose(site!);
    camera.up.copy(start.up);
    const c = new OrbitControls(camera, dom);
    c.target.copy(target.current.lengthSq() ? target.current : start.target);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    if (view === 'globe') {
      c.enablePan = false;
      c.minDistance = 1.02;
      c.maxDistance = 8;
    } else if (view === 'top') {
      // A map: drag pans, scroll zooms, no rotation or tilt, north stays up.
      c.enableRotate = false;
      c.screenSpacePanning = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      c.minDistance = 0.005;
      c.maxDistance = site!.altitude * 2.5;
    } else {
      // Low, nearly parallel to the surface: drag turns around the block (and tilts a little), scroll zooms.
      c.enablePan = false;
      c.minPolarAngle = FRONT_POLAR_ANGLE - THREE.MathUtils.degToRad(10);
      c.maxPolarAngle = Math.min(FRONT_POLAR_ANGLE + THREE.MathUtils.degToRad(10), THREE.MathUtils.degToRad(88));
    }
    controls.current = c;
    return () => {
      c.dispose();
      controls.current = null;
    };
  }, [view, site, camera, dom]);

  useFrame((_, delta) => {
    const a = active.current;
    if (a) {
      a.t += delta;
      a.flight.poseAt(a.t, pose.current);
      camera.position.copy(pose.current.position);
      camera.up.copy(pose.current.up);
      camera.lookAt(pose.current.target);
      target.current.copy(pose.current.target);
      if (a.t >= a.flight.duration) {
        active.current = null;
        onArrive(a.to);
      }
      return;
    }

    const c = controls.current;
    if (!c) return;
    // Slow down drag and zoom close to the ground, like Google Earth.
    const ref = view === 'globe' ? 2 : view === 'front' && focusRef.current ? focusRef.current.radius * 3 : site!.altitude;
    const dist = view === 'globe' ? camera.position.length() - 1 : camera.position.distanceTo(c.target);
    const s = THREE.MathUtils.clamp(dist / ref, 0.05, 1);
    c.rotateSpeed = s * 0.6;
    c.zoomSpeed = s;

    if (view === 'top' && site) keepTargetOnSite(c, camera, site);
    if (view === 'front' && site) {
      // Keep looking at the block's middle; when layers are turned on or off the block changes
      // height, so move the camera with it to hold the framing.
      const fc = focusRef.current;
      const next = fc ? fc.center : latLonToVec3(site.lat, site.lon);
      camera.position.add(next.clone().sub(c.target));
      c.target.copy(next);
      c.minDistance = fc ? fc.radius * 1.2 : 0.005;
      c.maxDistance = fc ? fc.radius * 10 : site.altitude * 1.5;
    }
    c.update();
    if (view !== 'globe') keepAboveGlobe(camera);
    target.current.copy(c.target);
  });

  return null;
}

/** Top view: don't let panning leave the site's patch area. */
function keepTargetOnSite(c: OrbitControls, camera: THREE.Camera, site: Site) {
  const frame = tangentFrame(latLonToVec3(site.lat, site.lon));
  const local = directionToLocal(frame, c.target);
  if (!local) return;
  const lim = site.patchSizeKm / 2;
  const e = THREE.MathUtils.clamp(local.eastKm, -lim, lim);
  const n = THREE.MathUtils.clamp(local.northKm, -lim, lim);
  if (e === local.eastKm && n === local.northKm) return;
  const fixed = localToDirection(frame, e, n).multiplyScalar(c.target.length());
  camera.position.add(fixed.clone().sub(c.target));
  c.target.copy(fixed);
}

/** Never let the camera dip below the globe's surface. */
function keepAboveGlobe(camera: THREE.Camera) {
  if (camera.position.length() < 1 + MIN_CLEARANCE) camera.position.setLength(1 + MIN_CLEARANCE);
}
