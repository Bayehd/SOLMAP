// Small clickable markers with labels, shown only at globe scale on the side facing the camera.
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { latLonToVec3 } from './geo';
import type { Site } from './sites';

const HIDE_BELOW_ALTITUDE = 0.35; // hide markers when the camera is closer than this to the surface
const MARKER_RADIUS = 0.008;

type Props = { sites: Site[]; enabled: boolean; onSelect(site: Site): void };

export function SiteMarkers({ sites, enabled, onSelect }: Props) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const shownRef = useRef(shown);
  const groups = useRef<Record<string, THREE.Group | null>>({});
  const camDir = new THREE.Vector3();

  useFrame(({ camera }) => {
    const altitude = camera.position.length() - 1;
    camDir.copy(camera.position).normalize();
    const next: Record<string, boolean> = {};
    let changed = false;
    for (const site of sites) {
      const g = groups.current[site.id];
      if (!g) continue;
      const facing = g.position.clone().normalize().dot(camDir) > 0.2;
      const visible = enabled && facing && altitude > HIDE_BELOW_ALTITUDE;
      g.visible = visible;
      g.scale.setScalar(THREE.MathUtils.clamp(altitude / 2, 0.3, 1.5)); // roughly constant size on screen
      next[site.id] = visible;
      if (visible !== !!shownRef.current[site.id]) changed = true;
    }
    if (changed) {
      shownRef.current = next;
      setShown(next);
    }
  });

  const select = (site: Site) => {
    if (shownRef.current[site.id]) onSelect(site); // ignore clicks on hidden markers
  };

  return (
    <>
      {sites.map((site) => (
        <group
          key={site.id}
          ref={(g) => {
            groups.current[site.id] = g;
          }}
          position={latLonToVec3(site.lat, site.lon, 1.002)}
        >
          <mesh
            onClick={(e) => {
              if (e.delta > 4) return; // a drag, not a click
              e.stopPropagation();
              select(site);
            }}
            onPointerOver={() => shownRef.current[site.id] && (document.body.style.cursor = 'pointer')}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            <sphereGeometry args={[MARKER_RADIUS, 16, 8]} />
            <meshBasicMaterial color="#ffd166" />
          </mesh>
          {shown[site.id] && (
            <Html center position={[0, 0, 0]} style={{ pointerEvents: 'none' }}>
              <button className="site-label" style={{ pointerEvents: 'auto' }} onClick={() => select(site)}>
                {site.name}
              </button>
            </Html>
          )}
        </group>
      ))}
    </>
  );
}
