import * as THREE from 'three/webgpu';

const cache = new Map<number, THREE.Color>();
/** Shared, never-mutated colours for per-frame paths (avoids GC churn on mobile). */
export function cc(hex: number): THREE.Color {
  let c = cache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    cache.set(hex, c);
  }
  return c;
}
