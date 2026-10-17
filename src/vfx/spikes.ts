import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, vec3, float, pow, abs, dot, normalView, positionViewDirection, positionLocal, smoothstep, mix, mx_noise_float, positionWorld } from '../render/tsl';

interface Spike {
  x: number;
  y: number;
  z: number;
  h: number;
  w: number;
  tilt: number;
  rot: number;
  t: number;
  life: number;
  grow: number;
}

/**
 * Instanced spikes that erupt from the ground: icy crystals (frost) or jagged rock (stone).
 * Grow fast, hold, then sink. One draw call per kind.
 */
export class Spikes {
  mesh: THREE.InstancedMesh;
  private list: Spike[] = [];
  private dummy = new THREE.Object3D();
  private glow: THREE.InstancedBufferAttribute;
  constructor(kind: 'ice' | 'rock', private max = 160) {
    const geo = kind === 'ice' ? new THREE.ConeGeometry(0.5, 1, 5, 1) : new THREE.ConeGeometry(0.6, 1, 4, 2);
    geo.translate(0, 0.5, 0);
    if (kind === 'rock') {
      const pa = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) pa.setXYZ(i, pa.getX(i) * (0.8 + Math.random() * 0.4), pa.getY(i), pa.getZ(i) * (0.8 + Math.random() * 0.4));
      geo.computeVertexNormals();
    }
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: kind === 'ice' ? 0.15 : 0.9, metalness: kind === 'ice' ? 0.1 : 0 });
    const g = instancedBufferAttribute(this.glow);
    const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2);
    if (kind === 'ice') {
      const inner = smoothstep(0.0, 1.0, positionLocal.y);
      m.colorNode = mix(vec3(0.35, 0.7, 1.0), vec3(0.9, 0.97, 1.0), inner).mul(0.45);
      m.emissiveNode = vec3(0.45, 0.85, 1.4).mul(fres.mul(2.2).add(0.25)).mul(g.add(0.3));
      m.transparent = true;
      m.opacity = 0.88;
    } else {
      const n = mx_noise_float(positionWorld.mul(2.2)).mul(0.5).add(0.5);
      m.colorNode = mix(vec3(0.22, 0.15, 0.1), vec3(0.55, 0.4, 0.27), n);
      m.emissiveNode = vec3(1.2, 0.6, 0.25).mul(smoothstep(0.75, 1.0, n).mul(g).mul(1.5));
    }
    this.mesh = new THREE.InstancedMesh(geo, m, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /** A ring/cluster of spikes around (x,z). */
  burst(x: number, y: number, z: number, radius: number, count: number, height: number, life = 2.5): void {
    for (let i = 0; i < count; i++) {
      if (this.list.length >= this.max) this.list.shift();
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const outward = r / Math.max(0.01, radius);
      this.list.push({
        x: x + Math.cos(a) * r,
        y,
        z: z + Math.sin(a) * r,
        h: height * (0.5 + Math.random() * 0.7) * (1.15 - outward * 0.5),
        w: 0.35 + Math.random() * 0.45,
        tilt: (0.15 + outward * 0.45) * (0.6 + Math.random() * 0.6),
        rot: a,
        t: -Math.random() * 0.12,
        life: life * (0.8 + Math.random() * 0.4),
        grow: 0.12,
      });
    }
  }

  /** A line of spikes from a to b (glacier lance, wall raise). */
  line(ax: number, az: number, bx: number, bz: number, y: number, count: number, height: number, life = 2.5): void {
    for (let i = 0; i < count; i++) {
      if (this.list.length >= this.max) this.list.shift();
      const k = i / Math.max(1, count - 1);
      const a = Math.atan2(bz - az, bx - ax) + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
      this.list.push({
        x: ax + (bx - ax) * k + (Math.random() - 0.5) * 0.6,
        y,
        z: az + (bz - az) * k + (Math.random() - 0.5) * 0.6,
        h: height * (0.6 + Math.random() * 0.6),
        w: 0.3 + Math.random() * 0.4,
        tilt: 0.25 + Math.random() * 0.3,
        rot: a,
        t: -k * 0.25,
        life,
        grow: 0.1,
      });
    }
  }

  update(dt: number): void {
    const ga = this.glow.array as Float32Array;
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      s.t += dt;
      if (s.t >= s.life) {
        this.list.splice(i, 1);
        continue;
      }
    }
    for (const s of this.list) {
      if (s.t < 0) continue;
      const g = Math.min(1, s.t / s.grow);
      const ease = 1 - Math.pow(1 - g, 3);
      const sink = s.t > s.life - 0.4 ? (s.life - s.t) / 0.4 : 1;
      const k = ease * sink;
      this.dummy.position.set(s.x, s.y - (1 - sink) * 0.3, s.z);
      this.dummy.rotation.set(Math.sin(s.rot) * s.tilt, 0, -Math.cos(s.rot) * s.tilt);
      this.dummy.scale.set(s.w * (0.4 + 0.6 * k), Math.max(0.01, s.h * k), s.w * (0.4 + 0.6 * k));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n, this.dummy.matrix);
      ga[n] = Math.max(0, 1 - s.t / 0.5) * 2;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glow.needsUpdate = true;
  }
}
