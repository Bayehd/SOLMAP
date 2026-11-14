// Draws the layer block. On each entry into the Front view the slabs start hidden inside
// the globe at the site, rise out through the footprint one after another (surface first)
// and settle into the stack; then the guides and labels appear.
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { easeInOutCubic } from './flyTo';
import type { LayerBlock } from './layerBlock';

const LABEL_GAP_PX = 28;
const DELAY = 0.5; // s, let the camera settle first
const STAGGER = 0.3; // s between slabs
const RISE = 1.3; // s per slab

export function LayerBlockView({ block, entryId }: { block: LayerBlock; entryId: number }) {
  const right = useRef(0); // screen x of the block's right edge
  const anim = useRef({ id: NaN, t: 0 });
  const [settled, setSettled] = useState(false);
  const v = new THREE.Vector3();
  const total = DELAY + STAGGER * (block.pieces.length - 1) + RISE;

  useFrame(({ camera, size }, delta) => {
    const a = anim.current;
    if (a.id !== entryId) {
      a.id = entryId;
      a.t = 0;
      setSettled(false);
    }
    const wasRunning = a.t < total;
    a.t = Math.min(total, a.t + delta);
    // Start low enough that the whole stack is inside the globe.
    const sink = block.stackTop * 1.02;
    block.pieces.forEach((p, i) => {
      const u = THREE.MathUtils.clamp((a.t - DELAY - STAGGER * i) / RISE, 0, 1);
      p.object.position.y = p.finalY - sink * (1 - easeInOutCubic(u));
    });
    block.guides.visible = a.t >= total;
    if (wasRunning && a.t >= total) setSettled(true);

    let max = -Infinity;
    for (const c of block.corners) max = Math.max(max, ((v.copy(c).project(camera).x + 1) / 2) * size.width);
    right.current = max;
  });

  return (
    <>
      <primitive object={block.group} />
      {settled &&
        block.slabs.map((s) => (
          <Html
            key={s.layerId}
            position={s.anchor}
            calculatePosition={(el, camera, size) => {
              const p = new THREE.Vector3().setFromMatrixPosition(el.matrixWorld).project(camera);
              return [right.current + LABEL_GAP_PX, ((1 - p.y) / 2) * size.height];
            }}
            style={{ pointerEvents: 'none' }}
          >
            <div className="slab-label">
              <span>{s.label}</span>
              <small>{s.detail}</small>
            </div>
          </Html>
        ))}
    </>
  );
}
