/*
 * Mars the Red Planet by DURVESH123, CC Attribution, Sketchfab. https://sketchfab.com/3d-models/mars-the-red-planet-free-7cf3b31ca60f45cc8e52f7fa863ad09a
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loads a GLB and returns only its color texture. The model's geometry is
 * disposed, and its scene and animations are never added to the app's scene.
 */
export async function loadMarsColorMap(url: string): Promise<THREE.Texture> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const maps: THREE.Texture[] = [];

  gltf.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (map && !maps.includes(map)) maps.push(map);
    }
    obj.geometry.dispose();
  });

  maps.forEach((t, i) => {
    const img = t.image as { width?: number; height?: number } | undefined;
    console.log(`[loadMarsColorMap] map ${i}: name="${t.name}" size=${img?.width}x${img?.height}`);
  });

  const colorMap = maps[0];
  if (!colorMap) throw new Error(`No material.map found in ${url}`);

  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.anisotropy = 8;
  // No vertical flip needed: this model's image is stored south-up, and glTF's
  // flipY = false then puts north at the top of a THREE.SphereGeometry.
  // Longitude: the image's left edge is 180°W (see TEXTURE_LON_OFFSET_DEG in geo.ts).

  return colorMap;
}

export const MARS_GLB_URL = '/models/mars-8k.glb';
let shared: Promise<THREE.Texture> | null = null;

/** The globe's color map, loaded once and shared (the globe and the Front view's surface slab use it). */
export function getMarsColorMap(): Promise<THREE.Texture> {
  shared ??= loadMarsColorMap(MARS_GLB_URL);
  return shared;
}
