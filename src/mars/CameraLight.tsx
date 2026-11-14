// A key light that follows the camera, from its upper left, so whatever is in view is lit
// (and block sides get two-tone shading) regardless of where on Mars the site is.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

/** Where the key light comes from, in camera space: left, up, slightly behind. */
export const CAMERA_LIGHT_FROM = new THREE.Vector3(-0.6, 0.8, 0.5);
const FROM = CAMERA_LIGHT_FROM;

export function CameraLight({ intensity = 2.4 }: { intensity?: number }) {
  const light = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    const l = light.current;
    if (l) l.target.name = 'camera-light-target';
  }, []);
  useFrame(({ camera }) => {
    const l = light.current;
    if (!l) return;
    l.position.copy(FROM).applyQuaternion(camera.quaternion).add(camera.position);
    l.target.position.set(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
    l.target.updateMatrixWorld();
  });
  return <directionalLight ref={light} intensity={intensity} />;
}
