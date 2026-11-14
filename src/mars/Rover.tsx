/*
 * Perseverance Rover NASA 2020 by Jaydeep.Padwal, CC Attribution, Sketchfab.
 * https://sketchfab.com/3d-models/perseverance-rover-nasa-2020-9437aed282c7443b80a5ca6f961792d0
 *
 * The rover for the Top view. It is drawn at a constant size on screen (a 3 m
 * rover would be invisible from 100 km up), drives to a picked point, and
 * leaves a track behind it. To sit convincingly on the ground it casts a soft
 * shadow away from the light, tilts with the MOLA slope under it (amplified a
 * little so it shows), and rocks slightly while driving.
 */
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CAMERA_LIGHT_FROM } from './CameraLight';
import { easeInOutCubic } from './flyTo';
import { directionToLocal, latLonToVec3, localToDirection, tangentFrame, vec3ToLatLon, type TangentFrame } from './geo';
import { sampleGrid, type MolaGrid } from './mola';
import type { Site } from './sites';

export const ROVER_URL = '/models/perseverance.glb';
const MODEL_LENGTH_M = 4.11; // model units are meters; forward is +Z, up is +Y, wheels at y = 0
const SCREEN_LENGTH_PX = 44;
const TILT_GAIN = 3; // terrain tilt amplification (real slopes are a few degrees)
const MAX_TILT = THREE.MathUtils.degToRad(14);
const ROCK = THREE.MathUtils.degToRad(1.5); // body rocking while driving
const SHADOW_OFFSET = 0.35; // in rover lengths, away from the light
const LIFT = 1e-5; // just above the globe
const TURN_SHARE = 0.35; // part of each drive spent turning toward the target
const MAX_TRACK_POINTS = 4000;

export type RoverTarget = { point: THREE.Vector3; id: number };
type Drive = { e0: number; n0: number; e1: number; n1: number; h0: number; h1: number; t: number; duration: number };

type Props = { site: Site; grid: MolaGrid | null; visible: boolean; target: RoverTarget | null };

export function Rover({ site, grid, visible, target }: Props) {
  const { scene } = useGLTF(ROVER_URL);
  const model = useMemo(() => scene.clone(true), [scene]);
  const frame = useMemo(() => tangentFrame(latLonToVec3(site.lat, site.lon)), [site]);
  const group = useRef<THREE.Group>(null);
  const shadow = useMemo(() => makeShadow(), []);
  useEffect(() => () => {
    shadow.geometry.dispose();
    (shadow.material as THREE.MeshBasicMaterial).map?.dispose();
    (shadow.material as THREE.Material).dispose();
  }, [shadow]);
  const state = useRef({ e: 0, n: 0, heading: 0, drive: null as Drive | null, lastTrackKm: 0, odometerKm: 0 });
  const track = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACK_POINTS * 3), 3));
    geo.setDrawRange(0, 0);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#ffd166' }));
  }, []);
  useEffect(() => () => {
    track.geometry.dispose();
    (track.material as THREE.Material).dispose();
  }, [track]);

  // Start position for this site, and a fresh track.
  useEffect(() => {
    const start = site.roverStart
      ? directionToLocal(frame, latLonToVec3(site.roverStart.lat, site.roverStart.lon)) ?? { eastKm: 0, northKm: 0 }
      : { eastKm: 0, northKm: 0 };
    state.current = { e: start.eastKm, n: start.northKm, heading: 0, drive: null, lastTrackKm: 0, odometerKm: 0 };
    track.geometry.setDrawRange(0, 0);
    addTrackPoint(track, frame, start.eastKm, start.northKm);
  }, [site, frame, track]);

  // Drive to each newly picked point (kept inside the site's area).
  useEffect(() => {
    if (!target) return;
    const local = directionToLocal(frame, target.point);
    if (!local) return;
    const lim = site.patchSizeKm / 2;
    const e1 = THREE.MathUtils.clamp(local.eastKm, -lim, lim);
    const n1 = THREE.MathUtils.clamp(local.northKm, -lim, lim);
    const s = state.current;
    const dist = Math.hypot(e1 - s.e, n1 - s.n);
    if (dist < site.patchSizeKm * 1e-4) return;
    const h1 = Math.atan2(e1 - s.e, n1 - s.n); // clockwise from north
    s.drive = {
      e0: s.e, n0: s.n, e1, n1,
      h0: s.heading,
      h1: s.heading + Math.atan2(Math.sin(h1 - s.heading), Math.cos(h1 - s.heading)), // shortest turn
      t: 0,
      duration: THREE.MathUtils.clamp(0.8 + (dist / site.patchSizeKm) * 6, 1, 4),
    };
  }, [target?.id]);

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), dir = new THREE.Vector3(), up = new THREE.Vector3();
  const basis = new THREE.Matrix4(), light = new THREE.Vector3(), rock = new THREE.Quaternion();
  const flatFwd = new THREE.Vector3(), flatRight = new THREE.Vector3();
  useFrame(({ camera, size }, delta) => {
    const g = group.current;
    if (!g) return;
    const s = state.current;
    const d = s.drive;
    if (d) {
      d.t = Math.min(d.duration, d.t + delta);
      const u = d.t / d.duration;
      s.heading = d.h0 + (d.h1 - d.h0) * easeInOutCubic(Math.min(1, u / TURN_SHARE));
      const m = easeInOutCubic(Math.max(0, (u - TURN_SHARE * 0.5) / (1 - TURN_SHARE * 0.5)));
      const e = d.e0 + (d.e1 - d.e0) * m, n = d.n0 + (d.n1 - d.n0) * m;
      s.odometerKm += Math.hypot(e - s.e, n - s.n);
      s.e = e;
      s.n = n;
      if (Math.hypot(s.e - d.e0, s.n - d.n0) - s.lastTrackKm > site.patchSizeKm / 400 || d.t >= d.duration) {
        addTrackPoint(track, frame, s.e, s.n);
        s.lastTrackKm = Math.hypot(s.e - d.e0, s.n - d.n0);
      }
      if (d.t >= d.duration) {
        s.drive = null;
        s.lastTrackKm = 0;
      }
    }

    // Stand on the ground: up follows the (amplified) MOLA slope, forward follows the heading.
    localToDirection(frame, s.e, s.n, dir);
    const f = tangentFrame(dir);
    const [dzEast, dzNorth] = grid ? terrainGradient(grid, f) : [0, 0];
    up.copy(f.up).addScaledVector(f.east, -dzEast * TILT_GAIN).addScaledVector(f.north, -dzNorth * TILT_GAIN).normalize();
    if (up.angleTo(f.up) > MAX_TILT) up.copy(f.up).lerp(up, MAX_TILT / up.angleTo(f.up)).normalize();
    fwd.copy(f.north).multiplyScalar(Math.cos(s.heading)).addScaledVector(f.east, Math.sin(s.heading));
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    right.crossVectors(up, fwd); // model +X
    g.quaternion.setFromRotationMatrix(basis.makeBasis(right, up, fwd));
    if (s.drive) {
      // Rock gently over the bumps while driving.
      const phase = (s.odometerKm / site.patchSizeKm) * 120;
      g.quaternion.multiply(rock.setFromEuler(new THREE.Euler(Math.sin(phase) * ROCK, 0, Math.sin(phase * 0.7 + 1) * ROCK)));
    }
    g.position.copy(dir).multiplyScalar(1 + LIFT);

    // Constant size on screen.
    const cam = camera as THREE.PerspectiveCamera;
    const worldPerPx = (2 * camera.position.distanceTo(g.position) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / size.height;
    const scale = (SCREEN_LENGTH_PX * worldPerPx) / MODEL_LENGTH_M;
    g.scale.setScalar(scale);

    // Soft shadow on the ground, pushed away from the camera-following key light.
    const lengthWorld = MODEL_LENGTH_M * scale;
    light.copy(CAMERA_LIGHT_FROM).applyQuaternion(camera.quaternion);
    light.addScaledVector(f.up, -light.dot(f.up)); // along the ground
    if (light.lengthSq() > 1e-12) light.normalize();
    shadow.position.copy(dir).multiplyScalar(1 + LIFT * 0.5).addScaledVector(light, -SHADOW_OFFSET * lengthWorld);
    flatFwd.copy(f.north).multiplyScalar(Math.cos(s.heading)).addScaledVector(f.east, Math.sin(s.heading));
    shadow.quaternion.setFromRotationMatrix(basis.makeBasis(flatRight.crossVectors(f.up, flatFwd), f.up, flatFwd));
    shadow.scale.set(lengthWorld * 0.8, 1, lengthWorld * 1.15);
  });

  return (
    <group visible={visible}>
      <primitive object={shadow} />
      <group ref={group}>
        <primitive object={model} />
      </group>
      <primitive object={track} />
    </group>
  );
}

/** MOLA surface gradient (rise per meter, east and north) under a point, from ±250 m differences. */
function terrainGradient(grid: MolaGrid, f: TangentFrame): [number, number] {
  const stepKm = 0.25;
  const at = (eKm: number, nKm: number) => {
    const { lat, lon } = vec3ToLatLon(localToDirection(f, eKm, nKm));
    return sampleGrid(grid, lat, lon);
  };
  const dzE = (at(stepKm, 0) - at(-stepKm, 0)) / (2 * stepKm * 1000);
  const dzN = (at(0, stepKm) - at(0, -stepKm)) / (2 * stepKm * 1000);
  return Number.isFinite(dzE + dzN) ? [dzE, dzN] : [0, 0];
}

/** A flat, soft, dark ellipse lying in the local ground plane (x/z), y up. */
function makeShadow(): THREE.Mesh {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.6)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}

function addTrackPoint(track: THREE.Line, frame: TangentFrame, eastKm: number, northKm: number) {
  const geo = track.geometry;
  const count = geo.drawRange.count;
  if (count >= MAX_TRACK_POINTS) return;
  const p = localToDirection(frame, eastKm, northKm).multiplyScalar(1 + LIFT * 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  pos.setXYZ(count, p.x, p.y, p.z);
  pos.needsUpdate = true;
  geo.setDrawRange(0, count + 1);
  geo.computeBoundingSphere();
}
