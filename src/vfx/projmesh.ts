import * as THREE from 'three/webgpu';
import { vec3, float, pow, abs, dot, normalView, positionViewDirection, mx_noise_float, positionLocal, mix, smoothstep } from '../render/tsl';
import { jitterGeometry } from '../render/arena';
import { Rng } from '../sim/rng';

export interface ProjLike {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  spell: string;
  age: number;
  id: number;
}

/**
 * Solid silhouettes for physical projectiles: tumbling rocks and boulders (Stone), velocity-aligned ice
 * crystals (Frost). Two instanced draw calls rebuilt each frame from the visual projectile list.
 */
export class ProjMeshes {
  group = new THREE.Group();
  private rocks: THREE.InstancedMesh;
  private ice: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private dir = new THREE.Vector3();
  constructor(max = 128) {
    const rg = new THREE.DodecahedronGeometry(1, 1);
    jitterGeometry(rg, new Rng(5), 0.22);
    const rm = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const n = mx_noise_float(positionLocal.mul(3.0)).mul(0.5).add(0.5);
    rm.colorNode = mix(vec3(0.24, 0.17, 0.11), vec3(0.62, 0.46, 0.3), n);
    rm.emissiveNode = vec3(1.4, 0.7, 0.25).mul(smoothstep(0.78, 0.95, n));
    this.rocks = new THREE.InstancedMesh(rg, rm, max);
    const ig = new THREE.OctahedronGeometry(1, 0);
    ig.scale(0.35, 1, 0.35);
    const im = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.9 });
    const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2);
    im.colorNode = vec3(0.4, 0.75, 1.0).mul(0.4);
    im.emissiveNode = vec3(0.6, 1.0, 1.6).mul(fres.mul(2.5).add(0.6));
    this.ice = new THREE.InstancedMesh(ig, im, max);
    for (const m of [this.rocks, this.ice]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  update(list: Iterable<ProjLike>): void {
    let nr = 0,
      ni = 0;
    for (const p of list) {
      if (p.spell === 'pebble' || p.spell === 'boulder') {
        if (nr >= this.rocks.instanceMatrix.count) continue;
        const s = p.spell === 'boulder' ? p.r : 0.28;
        const roll = p.age * (p.spell === 'boulder' ? Math.hypot(p.vx, p.vz) / Math.max(0.3, p.r) : 14);
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.rotation.set(roll + p.id, Math.atan2(p.vx, p.vz), roll * 0.3);
        this.dummy.scale.setScalar(s);
        this.dummy.updateMatrix();
        this.rocks.setMatrixAt(nr++, this.dummy.matrix);
      } else if (p.spell === 'shard' || p.spell === 'lance') {
        if (ni >= this.ice.instanceMatrix.count) continue;
        this.dir.set(p.vx, p.vy, p.vz).normalize();
        this.q.setFromUnitVectors(this.up, this.dir);
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.quaternion.copy(this.q);
        const len = p.spell === 'lance' ? 1.6 : 0.42;
        this.dummy.scale.set(p.spell === 'lance' ? 0.9 : 0.5, len, p.spell === 'lance' ? 0.9 : 0.5);
        this.dummy.updateMatrix();
        this.dummy.rotation.set(0, 0, 0);
        this.ice.setMatrixAt(ni++, this.dummy.matrix);
      }
    }
    this.rocks.count = nr;
    this.ice.count = ni;
    this.rocks.instanceMatrix.needsUpdate = true;
    this.ice.instanceMatrix.needsUpdate = true;
  }
}
