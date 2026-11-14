// The Mars globe with the color map from the GLB. onPick reports clicks (not drags) on the surface.
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { getMarsColorMap } from './loadMarsColorMap';

export function MarsGlobe({ onPick }: { onPick?: (point: THREE.Vector3) => void }) {
  const [map, setMap] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMarsColorMap().then((t) => !cancelled && setMap(t));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!map) return null;
  return (
    <mesh
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (!onPick || e.delta > 4) return; // a drag, not a click
        e.stopPropagation();
        onPick(e.point.clone());
      }}
      onPointerOver={() => onPick && (document.body.style.cursor = 'crosshair')}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      <sphereGeometry args={[1, 256, 128]} />
      <meshStandardMaterial map={map} roughness={0.9} metalness={0} />
    </mesh>
  );
}
