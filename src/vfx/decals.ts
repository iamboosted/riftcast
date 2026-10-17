import * as THREE from 'three/webgpu';
import {
  instancedBufferAttribute,
  vec2,
  vec3,
  vec4,
  float,
  uv,
  smoothstep,
  mix,
  sin,
  cos,
  atan,
  time,
  mx_worley_noise_float,
  mx_noise_float,
  mx_fractal_noise_float,
  abs,
  pow,
  clamp,
  step,
  fract,
  max,
  min,
  length,
} from '../render/tsl';

type Node = any;
export interface DecalInputs {
  /** -1..1 centred coords */
  p: Node;
  /** data: x=progress/age01, y=extra, z=intensity, w=seed */
  d: Node;
  c: Node;
}

export interface DecalInst {
  x: number;
  y: number;
  z: number;
  sx: number;
  sz: number;
  rot: number;
  d: [number, number, number, number];
  color: THREE.Color;
  /** transient decals age out */
  t?: number;
  life?: number;
  key?: number;
}

/**
 * Instanced ground decals with a procedural shader per layer. Persistent entries (zones, telegraphs) are
 * re-submitted each frame via set(); transient ones (scorch marks) age out automatically.
 */
export class DecalLayer {
  mesh: THREE.InstancedMesh;
  private data: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private frame: DecalInst[] = [];
  private transient: DecalInst[] = [];
  private dummy = new THREE.Object3D();
  constructor(
    shader: (i: DecalInputs) => { color: Node; alpha: Node },
    private max = 64,
    opts: { additive?: boolean; order?: number; anchor?: 'center' | 'start' } = {},
  ) {
    const g = new THREE.PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    if (opts.anchor === 'start') g.translate(0, 0, 1); // line telegraphs extend along +z from origin
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const p = uv().mul(2).sub(1);
    const out = shader({ p, d: instancedBufferAttribute(this.data), c: instancedBufferAttribute(this.col) });
    m.colorNode = opts.additive ? vec4(out.color.mul(out.alpha), out.alpha) : vec4(out.color, out.alpha);
    this.mesh = new THREE.InstancedMesh(g, m, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = opts.order ?? 5;
  }

  /** Submit a decal for this frame only. */
  set(i: DecalInst): void {
    if (this.frame.length < this.max) this.frame.push(i);
  }

  /** Add a decal that lives `life` seconds (d.x is driven as age01). */
  addTransient(i: DecalInst, life: number): void {
    i.t = 0;
    i.life = life;
    if (this.transient.length > this.max / 2) this.transient.shift();
    this.transient.push(i);
  }

  update(dt: number): void {
    for (let k = this.transient.length - 1; k >= 0; k--) {
      const tr = this.transient[k];
      tr.t! += dt;
      if (tr.t! >= tr.life!) this.transient.splice(k, 1);
      else {
        tr.d[0] = tr.t! / tr.life!;
        this.set(tr);
      }
    }
    const da = this.data.array as Float32Array,
      ca = this.col.array as Float32Array;
    this.frame.forEach((it, i) => {
      this.dummy.position.set(it.x, it.y + 0.04, it.z);
      this.dummy.rotation.set(0, it.rot, 0);
      this.dummy.scale.set(it.sx, 1, it.sz);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      da.set(it.d, i * 4);
      ca[i * 3] = it.color.r;
      ca[i * 3 + 1] = it.color.g;
      ca[i * 3 + 2] = it.color.b;
    });
    this.mesh.count = this.frame.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.data.needsUpdate = true;
    this.col.needsUpdate = true;
    this.frame.length = 0;
  }
}

const radialMask = (p: Node, seed: Node, jag = 0.12) => {
  const r = length(p);
  const a = atan(p.y, p.x);
  const edge = float(0.82).add(mx_noise_float(vec3(cos(a).mul(2), sin(a).mul(2), seed)).mul(jag));
  return { r, a, mask: smoothstep(edge, edge.sub(0.12), r) };
};

/** Scorch: charred blotch with glowing ember cracks that cool over its life. */
export const scorchShader = ({ p, d, c }: DecalInputs) => {
  const { r, mask } = radialMask(p, d.w, 0.2);
  const n = mx_fractal_noise_float(vec3(p.mul(3), d.w), 3, 2, 0.5).mul(0.5).add(0.5);
  const cracks = smoothstep(0.06, 0.0, abs(mx_noise_float(vec3(p.mul(5), d.w.add(3))).sub(0.0)));
  const heat = clamp(float(1).sub(d.x.mul(1.4)), 0, 1).mul(d.z);
  const ember = cracks.mul(heat).mul(smoothstep(0.9, 0.2, r));
  const flick = sin(time.mul(9).add(d.w.mul(10)).add(p.x.mul(7))).mul(0.25).add(0.85);
  const color = mix(vec3(0.02, 0.015, 0.012), vec3(c).mul(4).mul(flick), ember);
  const alpha = mask.mul(n.mul(0.5).add(0.5)).mul(float(1).sub(smoothstep(0.7, 1, d.x))).mul(0.85).add(ember.mul(mask));
  return { color, alpha: clamp(alpha, 0, 1) };
};

/** Frost: voronoi crystal plates with bright cyan seams and a glazed centre. */
export const frostShader = ({ p, d, c }: DecalInputs) => {
  const { r, mask } = radialMask(p, d.w, 0.25);
  const w = mx_worley_noise_float(vec3(p.mul(4.5), d.w));
  const seams = smoothstep(0.08, 0.0, w);
  const sparkle = step(0.985, fract(sin(p.x.mul(91.7).add(p.y.mul(47.3)).add(d.w).add(time.mul(0.6).floor())).mul(43758.5)));
  const appear = smoothstep(0.0, 0.08, d.y.add(0.0001)).mul(1);
  const fade = float(1).sub(smoothstep(0.75, 1.0, d.x));
  const color = mix(vec3(0.6, 0.78, 0.95).mul(0.4), vec3(c).mul(1.6), seams).add(vec3(1.2).mul(sparkle));
  const glaze = smoothstep(1.0, 0.0, r).mul(0.12);
  const alpha = mask.mul(seams.mul(0.75).add(0.35).add(glaze)).mul(fade).mul(appear);
  return { color, alpha: clamp(alpha, 0, 1) };
};

/** Ooze: bubbling venom pool, acid core with violet rim. */
export const oozeShader = ({ p, d, c }: DecalInputs) => {
  const { r, mask } = radialMask(p, d.w, 0.3);
  const w = mx_worley_noise_float(vec3(p.mul(3.2), d.w.add(time.mul(0.35))));
  const bubbles = smoothstep(0.12, 0.0, w);
  const rim = smoothstep(0.55, 0.85, r).mul(mask);
  const fade = float(1).sub(smoothstep(0.75, 1.0, d.x));
  const color = mix(vec3(c).mul(0.9), vec3(0.45, 0.12, 0.7), rim).add(vec3(c).mul(bubbles).mul(2.2));
  const alpha = mask.mul(0.82).mul(fade);
  return { color, alpha };
};

/** Water: dark puddle with ripple rings and sky glint. */
export const waterShader = ({ p, d, c }: DecalInputs) => {
  const { r, mask } = radialMask(p, d.w, 0.18);
  const rip = sin(r.mul(26).sub(time.mul(5)).add(d.w)).mul(0.5).add(0.5);
  const ripple = pow(rip, 8).mul(smoothstep(0.9, 0.2, r)).mul(0.6);
  const glint = smoothstep(0.6, 0.95, mx_noise_float(vec3(p.mul(2.5), time.mul(0.3).add(d.w)))).mul(0.5);
  const fade = float(1).sub(smoothstep(0.8, 1.0, d.x));
  const color = vec3(0.04, 0.08, 0.13).add(vec3(c).mul(ripple.add(glint)).mul(1.2));
  const alpha = mask.mul(0.78).mul(fade);
  return { color, alpha };
};

/** Electric surface: flickering arcs over a network (additive). */
export const electricShader = ({ p, d, c }: DecalInputs) => {
  const { mask } = radialMask(p, d.w, 0.18);
  const tq = time.mul(14).floor();
  const n1 = abs(mx_noise_float(vec3(p.mul(5), tq.mul(0.37).add(d.w))));
  const n2 = abs(mx_noise_float(vec3(p.mul(9), tq.mul(0.21).add(d.w.add(5)))));
  const arcs = smoothstep(0.06, 0.0, n1).add(smoothstep(0.04, 0.0, n2).mul(0.6));
  const fade = float(1).sub(smoothstep(0.7, 1.0, d.x));
  return { color: vec3(c).mul(5).add(vec3(2)), alpha: clamp(arcs.mul(mask).mul(fade).mul(d.z), 0, 1) };
};

/** Arcane rune circle (additive): pickups, casts, combo seals. */
export const runeShader = ({ p, d, c }: DecalInputs) => {
  const r = length(p);
  const a = atan(p.y, p.x);
  const ring1 = smoothstep(0.03, 0.0, abs(r.sub(0.9)));
  const ring2 = smoothstep(0.02, 0.0, abs(r.sub(0.72)));
  const ticks = step(0.8, fract(a.mul(12 / 6.2831).add(time.mul(0.3)))).mul(step(0.72, r)).mul(step(r, 0.9));
  const glyph = smoothstep(0.03, 0.0, abs(sin(a.mul(3).add(time.mul(-0.6))).mul(0.45).sub(r.sub(0.2)))).mul(step(r, 0.7));
  const fadeIn = smoothstep(0.0, 0.15, d.x).mul(float(1).sub(smoothstep(0.7, 1.0, d.x)));
  const alpha = clamp(ring1.add(ring2.mul(0.7)).add(ticks.mul(0.5)).add(glyph.mul(0.6)).mul(fadeIn).mul(d.z), 0, 1);
  return { color: vec3(c).mul(3), alpha };
};

/**
 * Radial telegraph (circle/ring/cone): faint fill, progress fill sweeping outward, hot edge.
 * d: x=progress, y=inner radius ratio (ring), z=cone half-angle (0 = full), w=seed
 */
export const teleRadialShader = ({ p, d, c }: DecalInputs) => {
  const r = length(p);
  const a = abs(atan(p.x, p.y));
  const inCone = select01(d.z, smoothstep(d.z.add(0.02), d.z, a));
  const inner = d.y;
  const body = smoothstep(1.0, 0.985, r).mul(smoothstep(inner.sub(0.01), inner, r)).mul(inCone);
  const edge = smoothstep(0.94, 0.985, r).mul(smoothstep(1.0, 0.985, r)).add(smoothstep(inner.add(0.04), inner, r).mul(step(0.01, inner))).mul(inCone);
  const prog = d.x;
  const fillR = mix(inner, float(1), prog);
  const fill = smoothstep(fillR, fillR.sub(0.02), r).mul(body);
  const front = smoothstep(0.035, 0.0, abs(r.sub(fillR))).mul(body);
  const pulse = sin(time.mul(18)).mul(0.15).add(0.85);
  const stripes = step(0.5, fract(p.x.add(p.y).mul(6).add(time.mul(1.5)))).mul(0.08);
  const warn = vec3(1.0, 0.18, 0.08);
  const color = mix(warn, vec3(c), 0.35).mul(fill.mul(0.6).add(0.4)).add(vec3(2.2, 0.6, 0.3).mul(edge.add(front)).mul(pulse));
  const alpha = clamp(body.mul(0.16).add(stripes.mul(body)).add(fill.mul(0.32)).add(edge.mul(0.9)).add(front.mul(0.9)), 0, 1);
  return { color, alpha };
};

/** Line telegraph: rectangle from origin along +z, progress fill from origin to tip. */
export const teleLineShader = ({ p, d, c }: DecalInputs) => {
  // p.x across (-1..1), p.y along: origin at uv.y=0 -> p.y = -1 ... tip p.y=1
  const along = p.y.mul(-0.5).add(0.5);
  const side = abs(p.x);
  const body = smoothstep(1.0, 0.94, side).mul(smoothstep(0.0, 0.02, along)).mul(smoothstep(1.0, 0.98, along));
  const edge = smoothstep(0.86, 0.95, side).mul(body);
  const fill = step(along, d.x).mul(body);
  const front = smoothstep(0.03, 0.0, abs(along.sub(d.x))).mul(body);
  const chevron = step(0.55, fract(along.mul(8).sub(side.mul(0.6)).sub(time.mul(2)))).mul(body).mul(0.1);
  const warn = vec3(1.0, 0.18, 0.08);
  const color = mix(warn, vec3(c), 0.35).mul(fill.mul(0.6).add(0.4)).add(vec3(2.2, 0.6, 0.3).mul(edge.add(front)));
  const alpha = clamp(body.mul(0.14).add(chevron).add(fill.mul(0.3)).add(edge.mul(0.85)).add(front), 0, 1);
  return { color, alpha };
};

// helper: if v<=0 -> 1 else m
function select01(v: Node, m: Node): Node {
  return mix(float(1), m, step(0.001, v));
}

export { vec2, max, min };
