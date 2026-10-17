import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, viewportSharedTexture, screenUV, uv, vec2, vec3, vec4, float, smoothstep, mx_noise_float, time, length } from '../render/tsl';

interface Haze {
  x: number;
  y: number;
  z: number;
  size: number;
  strength: number;
  t: number;
  life: number;
  key?: number;
}

/**
 * Heat-haze / shockwave refraction: billboards that resample the framebuffer with a noisy offset.
 * High/Ultra presets only (one framebuffer copy per frame).
 */
export class Distortion {
  mesh: THREE.Sprite;
  private attr: THREE.InstancedBufferAttribute;
  private list: Haze[] = [];
  private frame: Haze[] = [];
  constructor(private max = 48) {
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const a2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.attr2 = a2;
    const p = instancedBufferAttribute(this.attr);
    const q = instancedBufferAttribute(a2);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    m.positionNode = p.xyz;
    m.scaleNode = vec2(p.w, p.w);
    const c = uv().sub(0.5).mul(2);
    const r = length(c);
    const mask = smoothstep(1.0, 0.2, r).mul(q.x);
    const n = vec2(mx_noise_float(vec3(c.mul(3), time.mul(2.5).add(q.y))), mx_noise_float(vec3(c.mul(3).add(7), time.mul(2.5).add(q.y))));
    // ring mode (q.z > 0): refract along a moving ring front
    const ringF = smoothstep(0.15, 0.0, r.sub(q.z).abs()).mul(q.z.greaterThan(0).select(float(1), float(0)));
    const off = n.mul(0.012).mul(mask).add(c.mul(ringF).mul(0.03).mul(q.x));
    const col = viewportSharedTexture(screenUV.add(off));
    m.colorNode = vec4(col.rgb, mask.add(ringF).clamp(0, 1));
    this.mesh = new THREE.Sprite(m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }
  private attr2: THREE.InstancedBufferAttribute;

  /** transient haze (explosions) */
  burst(x: number, y: number, z: number, size: number, strength = 1, life = 0.6): void {
    if (this.list.length >= this.max / 2) this.list.shift();
    this.list.push({ x, y, z, size, strength, t: 0, life });
  }

  /** persistent haze for this frame (burning zones) */
  set(x: number, y: number, z: number, size: number, strength = 0.7): void {
    if (this.frame.length < this.max / 2) this.frame.push({ x, y, z, size, strength, t: 0, life: 1 });
  }

  update(dt: number): void {
    const a = this.attr.array as Float32Array,
      b = this.attr2.array as Float32Array;
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const h = this.list[i];
      h.t += dt;
      if (h.t >= h.life) {
        this.list.splice(i, 1);
        continue;
      }
    }
    const all = [...this.list, ...this.frame];
    for (const h of all) {
      if (n >= this.max) break;
      const k = h.t / h.life;
      a.set([h.x, h.y, h.z, h.size * (h.life < 1 ? 0.6 + k : 1)], n * 4);
      b.set([h.strength * (1 - k), (n * 3.7) % 10, h.life < 1 ? k * 0.9 : 0, 0], n * 4);
      n++;
    }
    this.frame.length = 0;
    this.mesh.count = n;
    this.attr.needsUpdate = true;
    this.attr2.needsUpdate = true;
  }
}
