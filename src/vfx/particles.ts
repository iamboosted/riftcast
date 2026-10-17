import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Break,
  Return,
  instancedArray,
  instancedBufferAttribute,
  instanceIndex,
  uniform,
  uniformArray,
  float,
  int,
  vec2,
  vec3,
  vec4,
  hash,
  sqrt,
  cos,
  sin,
  abs,
  mix,
  smoothstep,
  clamp,
  floor,
  fract,
  mod,
  max,
  length,
  normalize,
  atan,
  texture,
  uv,
  cameraViewMatrix,
  step,
  select,
  viewportLinearDepth,
  linearDepth,
  saturate,
} from '../render/tsl';
import { particleAtlas } from './atlas';

export const MAX_CMDS = 96;
const CMD_VEC4 = 8;
export const MAX_SPAWN = 8192;

/** One emission request. All fields besides position/count/life/size/color/shape are optional. */
export interface Emit {
  x: number;
  y: number;
  z: number;
  count: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** random speed added in the mode's direction set */
  spread?: number;
  /** 0 sphere, 1 ring (xz, outward), 2 upward hemisphere, 3 flat disc */
  mode?: 0 | 1 | 2 | 3;
  posSpread?: number;
  /** vertical scale for the position spread ellipsoid */
  posSpreadY?: number;
  life: number;
  lifeVar?: number;
  size: number;
  sizeEnd?: number;
  sizeVar?: number;
  color: number;
  colorEnd?: number;
  /** HDR multiplier for start colour (bloom) */
  intensity?: number;
  intensityEnd?: number;
  alpha?: number;
  gravity?: number;
  drag?: number;
  turb?: number;
  shape: number;
  /** velocity stretch factor (sparks) */
  stretch?: number;
  floorY?: number;
  bounce?: number;
  spin?: number;
}

const tmpC = new THREE.Color();
const tmpC2 = new THREE.Color();

/** Analytic divergence-free "curl" field (curl of a sinusoidal vector potential). Same maths on CPU and GPU. */
export function curlCPU(x: number, y: number, z: number, t: number, out: number[]): void {
  const a = 6 * Math.cos(1.7 * 0 + 0); // placeholder to keep constants aligned with GPU (optimised away)
  void a;
  out[0] = 2.7 * Math.cos(2.7 * y + t * 0.9) - 2.3 * Math.cos(2.3 * z + t * 1.1) + 0.5 * (1.3 * Math.cos(1.3 * y * 2.1 - t) - 1.1 * Math.cos(1.1 * z * 2.3 + t * 0.6));
  out[1] = 2.1 * Math.cos(2.1 * z + t * 0.7) - 1.9 * Math.cos(1.9 * x + t * 1.3) + 0.5 * (1.7 * Math.cos(1.7 * z * 1.9 + t * 0.8) - 1.2 * Math.cos(1.2 * x * 2.2 - t * 0.5));
  out[2] = 1.5 * Math.cos(1.5 * x + t * 1.2) - 1.7 * Math.cos(1.7 * y + t) + 0.5 * (1.4 * Math.cos(1.4 * x * 2.4 + t * 0.9) - 1.6 * Math.cos(1.6 * y * 1.8 - t * 0.7));
  out[0] *= 0.35;
  out[1] *= 0.35;
  out[2] *= 0.35;
}

const curlGPU = Fn(([p, t]: any[]) => {
  const x = p.x,
    y = p.y,
    z = p.z;
  const cx = float(2.7).mul(cos(y.mul(2.7).add(t.mul(0.9)))).sub(float(2.3).mul(cos(z.mul(2.3).add(t.mul(1.1)))))
    .add(float(0.5).mul(float(1.3).mul(cos(y.mul(1.3 * 2.1).sub(t))).sub(float(1.1).mul(cos(z.mul(1.1 * 2.3).add(t.mul(0.6)))))));
  const cy = float(2.1).mul(cos(z.mul(2.1).add(t.mul(0.7)))).sub(float(1.9).mul(cos(x.mul(1.9).add(t.mul(1.3)))))
    .add(float(0.5).mul(float(1.7).mul(cos(z.mul(1.7 * 1.9).add(t.mul(0.8)))).sub(float(1.2).mul(cos(x.mul(1.2 * 2.2).sub(t.mul(0.5)))))));
  const cz = float(1.5).mul(cos(x.mul(1.5).add(t.mul(1.2)))).sub(float(1.7).mul(cos(y.mul(1.7).add(t))))
    .add(float(0.5).mul(float(1.4).mul(cos(x.mul(1.4 * 2.4).add(t.mul(0.9)))).sub(float(1.6).mul(cos(y.mul(1.6 * 1.8).sub(t.mul(0.7)))))));
  return vec3(cx, cy, cz).mul(0.35);
});

export interface ParticleStats {
  alive: number;
  capacity: number;
  spawnedThisFrame: number;
}

/**
 * Pooled particle system. On WebGPU: spawn + update run as TSL compute kernels over storage buffers;
 * the CPU only uploads a small command list each frame. On WebGL2: identical maths in JS on a compact pool.
 */
export class ParticleSystem {
  readonly gpu: boolean;
  readonly capacity: number;
  mesh: THREE.Sprite;
  private queue: Emit[] = [];
  private renderer: THREE.WebGPURenderer;
  private ringHead = 0;
  private time = 0;
  /** estimate of live particles on the GPU path (ring buffer: lifetimes tracked on CPU) */
  private liveRing: Float32Array;
  attractors: THREE.Vector4[] = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  spawnedThisFrame = 0;

  // GPU
  private cmds!: THREE.Vector4[];
  private uCmds: any;
  private uTotal = uniform(0);
  private uStart = uniform(0);
  private uSeed = uniform(0);
  private uDt = uniform(0);
  private uTime = uniform(0);
  private uAttr: any;
  private spawnKernel: any;
  private updateKernel: any;

  // CPU
  private cpu!: {
    pos: Float32Array;
    vel: Float32Array;
    age: Float32Array;
    life: Float32Array;
    c0: Float32Array;
    c1: Float32Array;
    s0: Float32Array;
    s1: Float32Array;
    phys: Float32Array; // gravity, drag, turb, floorY, bounce, spin, alpha, shape, stretch, rot
    count: number;
    attrs: THREE.InstancedBufferAttribute[];
  };

  constructor(renderer: THREE.WebGPURenderer, opts: { gpu: boolean; capacity: number; additive: boolean; soft?: boolean }) {
    this.renderer = renderer;
    this.gpu = opts.gpu;
    this.capacity = opts.capacity;
    this.liveRing = new Float32Array(this.gpu ? 512 : 1);
    const mat = this.gpu ? this.buildGPU(opts) : this.buildCPU(opts);
    this.mesh = new THREE.Sprite(mat);
    this.mesh.count = this.gpu ? this.capacity : 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.additive ? 20 : 10;
  }

  emit(e: Emit): void {
    if (e.count <= 0) return;
    this.queue.push(e);
  }

  get pending(): number {
    return this.queue.length;
  }

  // ---------------------------------------------------------------- GPU
  private buildGPU(opts: { capacity: number; additive: boolean; soft?: boolean }): THREE.SpriteNodeMaterial {
    const N = opts.capacity;
    const A = instancedArray(N, 'vec4'); // pos, age
    const B = instancedArray(N, 'vec4'); // vel, life
    const C = instancedArray(N, 'vec4'); // colour start, size start
    const D = instancedArray(N, 'vec4'); // colour end, size end
    const E = instancedArray(N, 'vec4'); // gravity, drag, turb, shape+stretch
    const F = instancedArray(N, 'vec4'); // floorY, bounce, spin, alpha
    // start dead
    const bArr = (B.value as THREE.StorageInstancedBufferAttribute).array as Float32Array;
    const aArr = (A.value as THREE.StorageInstancedBufferAttribute).array as Float32Array;
    for (let i = 0; i < N; i++) {
      aArr[i * 4 + 3] = 1;
      bArr[i * 4 + 3] = 0;
    }
    this.cmds = Array.from({ length: MAX_CMDS * CMD_VEC4 }, () => new THREE.Vector4());
    this.uCmds = uniformArray(this.cmds, 'vec4');
    this.uAttr = uniformArray(this.attractors, 'vec4');
    const cmds = this.uCmds;
    const uTotal = this.uTotal,
      uStart = this.uStart,
      uSeed = this.uSeed,
      uDt = this.uDt,
      uTime = this.uTime,
      uAttr = this.uAttr;

    this.spawnKernel = Fn(() => {
      const i = float(instanceIndex);
      If(i.greaterThanEqual(uTotal), () => {
        Return();
      });
      const k = int(0).toVar();
      Loop(MAX_CMDS, ({ i: j }: any) => {
        If(i.lessThan(cmds.element(j.mul(CMD_VEC4)).w), () => {
          k.assign(j);
          Break();
        });
      });
      const base = k.mul(CMD_VEC4);
      const c0 = cmds.element(base);
      const c1 = cmds.element(base.add(1));
      const c2 = cmds.element(base.add(2));
      const c3 = cmds.element(base.add(3));
      const c4 = cmds.element(base.add(4));
      const c5 = cmds.element(base.add(5));
      const c6 = cmds.element(base.add(6));
      const c7 = cmds.element(base.add(7));
      const idx = int(mod(uStart.add(i), float(N)));
      const s = i.mul(1.618).add(uSeed);
      const r1 = hash(s),
        r2 = hash(s.add(17.31)),
        r3 = hash(s.add(5.77)),
        r4 = hash(s.add(91.3)),
        r5 = hash(s.add(33.1)),
        r6 = hash(s.add(61.9)),
        r7 = hash(s.add(12.4));
      const th = r1.mul(Math.PI * 2);
      const zz = r2.mul(2).sub(1);
      const rr = sqrt(max(float(0), float(1).sub(zz.mul(zz))));
      const sphere = vec3(rr.mul(cos(th)), zz, rr.mul(sin(th)));
      const ring = vec3(cos(th), r2.sub(0.5).mul(0.15), sin(th));
      const mode = c7.x;
      const isRing = step(0.5, mode).mul(step(mode, 1.5));
      const isUp = step(1.5, mode).mul(step(mode, 2.5));
      const isDisc = step(2.5, mode);
      const hemi = vec3(sphere.x, abs(sphere.y), sphere.z);
      const dirV = mix(mix(sphere, ring, isRing), hemi, isUp);
      const ringPos = vec3(cos(th), 0, sin(th));
      const radial = r3.pow(1 / 3);
      const sphPos = sphere.mul(radial).mul(vec3(1, c6.y, 1));
      const discPos = ringPos.mul(sqrt(r3));
      const posOff = mix(mix(sphPos, ringPos, isRing), discPos, isDisc).mul(c6.x);
      const pos = c0.xyz.add(posOff);
      const vel = c1.xyz.add(dirV.mul(c1.w).mul(r4.mul(0.6).add(0.4)));
      const life = c4.x.mul(float(1).add(r5.mul(2).sub(1).mul(c4.y)));
      const sz = float(1).add(r6.mul(2).sub(1).mul(c7.y));
      A.element(idx).assign(vec4(pos, 0));
      B.element(idx).assign(vec4(vel, max(life, 0.02)));
      C.element(idx).assign(vec4(c2.xyz, c2.w.mul(sz)));
      D.element(idx).assign(vec4(c3.xyz, c3.w.mul(sz)));
      E.element(idx).assign(vec4(c4.z, c4.w, c5.x, c5.y));
      F.element(idx).assign(vec4(c5.z, c5.w, c6.z.mul(r7.mul(2).sub(1)), c6.w));
    })().compute(MAX_SPAWN);

    this.updateKernel = Fn(() => {
      const a = A.element(instanceIndex);
      const b = B.element(instanceIndex);
      If(a.w.greaterThanEqual(b.w), () => {
        Return();
      });
      const e = E.element(instanceIndex);
      const f = F.element(instanceIndex);
      const vel = b.xyz.toVar();
      const pos = a.xyz.toVar();
      vel.assign(vel.sub(vec3(0, e.x.mul(uDt), 0)));
      vel.assign(vel.mul(max(float(0), float(1).sub(e.y.mul(uDt)))));
      If(e.z.greaterThan(0), () => {
        vel.assign(vel.add(curlGPU(pos.mul(0.35), uTime).mul(e.z.mul(uDt))));
      });
      Loop(4, ({ i }: any) => {
        const at = uAttr.element(i);
        If(abs(at.w).greaterThan(0.001), () => {
          const d = at.xyz.sub(pos);
          const dl = length(d);
          If(dl.lessThan(14), () => {
            vel.assign(vel.add(d.div(max(dl, 0.3)).mul(at.w.mul(uDt)).div(dl.mul(0.12).add(1))));
          });
        });
      });
      pos.assign(pos.add(vel.mul(uDt)));
      If(pos.y.lessThan(f.x), () => {
        pos.assign(vec3(pos.x, f.x, pos.z));
        vel.assign(vec3(vel.x.mul(0.6), abs(vel.y).mul(f.y), vel.z.mul(0.6)));
      });
      A.element(instanceIndex).assign(vec4(pos, a.w.add(uDt)));
      B.element(instanceIndex).assign(vec4(vel, b.w));
    })().compute(N);

    // ---- render material
    const aA = A.toAttribute();
    const bA = B.toAttribute();
    const cA = C.toAttribute();
    const dA = D.toAttribute();
    const eA = E.toAttribute();
    const fA = F.toAttribute();
    const t = clamp(aA.w.div(bA.w), 0, 1);
    const alive = step(aA.w, bA.w);
    const size = mix(cA.w, dA.w, t).mul(alive);
    const col = mix(cA.xyz, dA.xyz, t);
    const fade = smoothstep(0, 0.06, t).mul(float(1).sub(smoothstep(0.5, 1, t))).mul(fA.w);
    const shape = floor(eA.w);
    const stretch = fract(eA.w).mul(100);
    return this.spriteMaterial(opts, aA.xyz, bA.xyz, size, col, fade, shape, stretch, fA.z.mul(aA.w));
  }

  /** Common sprite material: atlas lookup, velocity-stretched sparks, HDR colour. */
  private spriteMaterial(opts: { additive: boolean; soft?: boolean }, pos: any, vel: any, size: any, col: any, alpha: any, shape: any, stretch: any, rot: any): THREE.SpriteNodeMaterial {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: true });
    m.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.positionNode = pos;
    const vView = cameraViewMatrix.mul(vec4(vel, 0)).xy;
    const sp = length(vView);
    const stretched = step(0.01, stretch);
    const ang = select(stretched.greaterThan(0.5), atan(vView.y, vView.x), rot);
    m.rotationNode = ang;
    m.scaleNode = vec2(size.mul(float(1).add(sp.mul(stretch).mul(0.06))), size);
    const cellX = mod(shape, 4);
    const cellY = float(3).sub(floor(shape.div(4)));
    const atlasUV = uv().add(vec2(cellX, cellY)).div(4);
    const tex = texture(particleAtlas(), atlasUV);
    let a: any = tex.a.mul(alpha);
    if (opts.soft) {
      const softF = saturate(viewportLinearDepth.sub(linearDepth()).mul(240));
      a = a.mul(softF);
    }
    if (opts.additive) {
      m.colorNode = vec4(col.mul(tex.rgb).mul(a), a);
    } else {
      // sphere-impostor shading: treat the sprite as a lit hemisphere so smoke/dust/rocks read as volumes
      const c = uv().mul(2).sub(1);
      const nz = sqrt(max(float(0), float(1).sub(c.dot(c))));
      const lambert = clamp(vec3(c.x, c.y, nz).dot(vec3(0.35, 0.75, 0.56)), 0, 1);
      const rim = float(1).sub(nz).mul(0.25);
      m.colorNode = vec4(col.mul(tex.rgb).mul(lambert.mul(0.75).add(0.45).add(rim)), a);
    }
    return m;
  }

  // ---------------------------------------------------------------- CPU
  private buildCPU(opts: { capacity: number; additive: boolean; soft?: boolean }): THREE.SpriteNodeMaterial {
    const N = opts.capacity;
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const attrs = [mk(), mk(), mk(), mk()];
    this.cpu = {
      pos: new Float32Array(N * 3),
      vel: new Float32Array(N * 3),
      age: new Float32Array(N),
      life: new Float32Array(N),
      c0: new Float32Array(N * 3),
      c1: new Float32Array(N * 3),
      s0: new Float32Array(N),
      s1: new Float32Array(N),
      phys: new Float32Array(N * 10),
      count: 0,
      attrs,
    };
    const p0 = instancedBufferAttribute(attrs[0]); // pos, size
    const p1 = instancedBufferAttribute(attrs[1]); // vel, stretch
    const p2 = instancedBufferAttribute(attrs[2]); // rgb, alpha
    const p3 = instancedBufferAttribute(attrs[3]); // shape, rot
    return this.spriteMaterial(opts, p0.xyz, p1.xyz, p0.w, p2.xyz, p2.w, p3.x, p1.w, p3.y);
  }

  private spawnCPU(e: Emit, n: number): void {
    const c = this.cpu;
    const N = this.capacity;
    tmpC.set(e.color).multiplyScalar(e.intensity ?? 1);
    tmpC2.set(e.colorEnd ?? e.color).multiplyScalar(e.intensityEnd ?? e.intensity ?? 1);
    const mode = e.mode ?? 0;
    for (let k = 0; k < n; k++) {
      let i: number;
      if (c.count < N) i = c.count++;
      else i = Math.floor(Math.random() * N); // pool full: recycle a random slot
      const th = Math.random() * Math.PI * 2;
      const zz = Math.random() * 2 - 1;
      const rr = Math.sqrt(Math.max(0, 1 - zz * zz));
      let dx = rr * Math.cos(th),
        dy = zz,
        dz = rr * Math.sin(th);
      let px: number, py: number, pz: number;
      const ps = e.posSpread ?? 0;
      const r3 = Math.random();
      if (mode === 1) {
        dx = Math.cos(th);
        dz = Math.sin(th);
        dy = (Math.random() - 0.5) * 0.15;
        px = dx * ps;
        py = 0;
        pz = dz * ps;
      } else if (mode === 3) {
        const q = Math.sqrt(r3) * ps;
        px = Math.cos(th) * q;
        py = 0;
        pz = Math.sin(th) * q;
      } else {
        if (mode === 2) dy = Math.abs(dy);
        const q = Math.cbrt(r3) * ps;
        px = rr * Math.cos(th) * q;
        py = zz * q * (e.posSpreadY ?? 1);
        pz = rr * Math.sin(th) * q;
      }
      const spd = (e.spread ?? 0) * (Math.random() * 0.6 + 0.4);
      c.pos[i * 3] = e.x + px;
      c.pos[i * 3 + 1] = e.y + py;
      c.pos[i * 3 + 2] = e.z + pz;
      c.vel[i * 3] = (e.vx ?? 0) + dx * spd;
      c.vel[i * 3 + 1] = (e.vy ?? 0) + dy * spd;
      c.vel[i * 3 + 2] = (e.vz ?? 0) + dz * spd;
      c.age[i] = 0;
      c.life[i] = Math.max(0.02, e.life * (1 + (Math.random() * 2 - 1) * (e.lifeVar ?? 0)));
      const sv = 1 + (Math.random() * 2 - 1) * (e.sizeVar ?? 0);
      c.s0[i] = e.size * sv;
      c.s1[i] = (e.sizeEnd ?? e.size) * sv;
      c.c0[i * 3] = tmpC.r;
      c.c0[i * 3 + 1] = tmpC.g;
      c.c0[i * 3 + 2] = tmpC.b;
      c.c1[i * 3] = tmpC2.r;
      c.c1[i * 3 + 1] = tmpC2.g;
      c.c1[i * 3 + 2] = tmpC2.b;
      const ph = i * 10;
      c.phys[ph] = e.gravity ?? 0;
      c.phys[ph + 1] = e.drag ?? 0;
      c.phys[ph + 2] = e.turb ?? 0;
      c.phys[ph + 3] = e.floorY ?? -1e4;
      c.phys[ph + 4] = e.bounce ?? 0.3;
      c.phys[ph + 5] = (e.spin ?? 0) * (Math.random() * 2 - 1);
      c.phys[ph + 6] = e.alpha ?? 1;
      c.phys[ph + 7] = e.shape;
      c.phys[ph + 8] = e.stretch ?? 0;
      c.phys[ph + 9] = Math.random() * 6.28;
    }
  }

  private updateCPU(dt: number): void {
    const c = this.cpu;
    const curl = [0, 0, 0];
    const at = this.attractors;
    const [a0, a1, a2, a3] = c.attrs.map((a) => a.array as Float32Array);
    let n = c.count;
    for (let i = 0; i < n; i++) {
      c.age[i] += dt;
      if (c.age[i] >= c.life[i]) {
        // swap-remove
        n--;
        if (i !== n) this.moveCPU(n, i);
        i--;
        continue;
      }
      const ph = i * 10;
      const i3 = i * 3;
      let vx = c.vel[i3],
        vy = c.vel[i3 + 1],
        vz = c.vel[i3 + 2];
      let px = c.pos[i3],
        py = c.pos[i3 + 1],
        pz = c.pos[i3 + 2];
      vy -= c.phys[ph] * dt;
      const dr = Math.max(0, 1 - c.phys[ph + 1] * dt);
      vx *= dr;
      vy *= dr;
      vz *= dr;
      const tb = c.phys[ph + 2];
      if (tb > 0) {
        curlCPU(px * 0.35, py * 0.35, pz * 0.35, this.time, curl);
        vx += curl[0] * tb * dt;
        vy += curl[1] * tb * dt;
        vz += curl[2] * tb * dt;
      }
      for (let k = 0; k < 4; k++) {
        const A = at[k];
        if (Math.abs(A.w) < 0.001) continue;
        const dx = A.x - px,
          dy = A.y - py,
          dz = A.z - pz;
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 14) {
          const f = (A.w * dt) / Math.max(dl, 0.3) / (dl * 0.12 + 1);
          vx += dx * f;
          vy += dy * f;
          vz += dz * f;
        }
      }
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      if (py < c.phys[ph + 3]) {
        py = c.phys[ph + 3];
        vy = Math.abs(vy) * c.phys[ph + 4];
        vx *= 0.6;
        vz *= 0.6;
      }
      c.vel[i3] = vx;
      c.vel[i3 + 1] = vy;
      c.vel[i3 + 2] = vz;
      c.pos[i3] = px;
      c.pos[i3 + 1] = py;
      c.pos[i3 + 2] = pz;
      // pack render data
      const t = c.age[i] / c.life[i];
      const fade = Math.min(1, t / 0.06) * (1 - smooth(0.5, 1, t)) * c.phys[ph + 6];
      const o = i * 4;
      a0[o] = px;
      a0[o + 1] = py;
      a0[o + 2] = pz;
      a0[o + 3] = c.s0[i] + (c.s1[i] - c.s0[i]) * t;
      a1[o] = vx;
      a1[o + 1] = vy;
      a1[o + 2] = vz;
      a1[o + 3] = c.phys[ph + 8];
      a2[o] = c.c0[i3] + (c.c1[i3] - c.c0[i3]) * t;
      a2[o + 1] = c.c0[i3 + 1] + (c.c1[i3 + 1] - c.c0[i3 + 1]) * t;
      a2[o + 2] = c.c0[i3 + 2] + (c.c1[i3 + 2] - c.c0[i3 + 2]) * t;
      a2[o + 3] = fade;
      a3[o] = c.phys[ph + 7];
      a3[o + 1] = c.phys[ph + 9] + c.phys[ph + 5] * c.age[i];
    }
    c.count = n;
    for (const a of c.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
    this.mesh.count = n;
  }

  private moveCPU(from: number, to: number): void {
    const c = this.cpu;
    c.pos.copyWithin(to * 3, from * 3, from * 3 + 3);
    c.vel.copyWithin(to * 3, from * 3, from * 3 + 3);
    c.c0.copyWithin(to * 3, from * 3, from * 3 + 3);
    c.c1.copyWithin(to * 3, from * 3, from * 3 + 3);
    c.phys.copyWithin(to * 10, from * 10, from * 10 + 10);
    c.age[to] = c.age[from];
    c.life[to] = c.life[from];
    c.s0[to] = c.s0[from];
    c.s1[to] = c.s1[from];
  }

  // ---------------------------------------------------------------- frame
  update(dt: number): void {
    this.time += dt;
    this.spawnedThisFrame = 0;
    if (this.gpu) this.updateGPU(dt);
    else {
      for (const e of this.queue) {
        this.spawnCPU(e, e.count);
        this.spawnedThisFrame += e.count;
      }
      this.queue.length = 0;
      this.updateCPU(dt);
    }
  }

  private updateGPU(dt: number): void {
    // decay live-estimate ring (per 1/16s bucket)
    let total = 0;
    let ci = 0;
    const cmds = this.cmds;
    while (this.queue.length && ci < MAX_CMDS) {
      const e = this.queue[0];
      const n = Math.min(e.count, MAX_SPAWN - total);
      if (n <= 0) break;
      total += n;
      this.packCmd(ci, e, total);
      ci++;
      if (n < e.count) e.count -= n;
      else this.queue.shift();
      this.trackLive(n, e.life);
    }
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
    // terminate list
    for (let k = ci; k < MAX_CMDS; k++) cmds[k * CMD_VEC4].w = -1;
    this.uDt.value = dt;
    this.uTime.value = this.time;
    if (total > 0) {
      this.uTotal.value = total;
      this.uStart.value = this.ringHead;
      this.uSeed.value = (Math.random() * 1000) | 0;
      this.ringHead = (this.ringHead + total) % this.capacity;
      this.renderer.compute(this.spawnKernel);
      this.spawnedThisFrame = total;
    }
    this.renderer.compute(this.updateKernel);
    this.liveTick(dt);
  }

  private packCmd(ci: number, e: Emit, cumEnd: number): void {
    const b = ci * CMD_VEC4;
    const c = this.cmds;
    tmpC.set(e.color).multiplyScalar(e.intensity ?? 1);
    tmpC2.set(e.colorEnd ?? e.color).multiplyScalar(e.intensityEnd ?? e.intensity ?? 1);
    c[b].set(e.x, e.y, e.z, cumEnd);
    c[b + 1].set(e.vx ?? 0, e.vy ?? 0, e.vz ?? 0, e.spread ?? 0);
    c[b + 2].set(tmpC.r, tmpC.g, tmpC.b, e.size);
    c[b + 3].set(tmpC2.r, tmpC2.g, tmpC2.b, e.sizeEnd ?? e.size);
    c[b + 4].set(e.life, e.lifeVar ?? 0, e.gravity ?? 0, e.drag ?? 0);
    c[b + 5].set(e.turb ?? 0, e.shape + Math.min(0.99, (e.stretch ?? 0) / 100), e.floorY ?? -1e4, e.bounce ?? 0.3);
    c[b + 6].set(e.posSpread ?? 0, e.posSpreadY ?? 1, e.spin ?? 0, e.alpha ?? 1);
    c[b + 7].set(e.mode ?? 0, e.sizeVar ?? 0, 0, 0);
  }

  // live estimate for the GPU ring: buckets of expiring counts over the next 8s
  private liveT = 0;
  private trackLive(n: number, life: number): void {
    const bucket = Math.min(this.liveRing.length - 1, Math.max(0, Math.floor(life * 16)));
    this.liveRing[(Math.floor(this.liveT * 16) + bucket) % this.liveRing.length] += n;
  }
  private liveTick(dt: number): void {
    const prev = Math.floor(this.liveT * 16);
    this.liveT += dt;
    const now = Math.floor(this.liveT * 16);
    for (let k = prev; k < now; k++) this.liveRing[k % this.liveRing.length] = 0;
  }

  get alive(): number {
    if (!this.gpu) return this.cpu.count;
    let s = 0;
    for (let i = 0; i < this.liveRing.length; i++) s += this.liveRing[i];
    return Math.min(this.capacity, s);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function smooth(a: number, b: number, t: number): number {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
