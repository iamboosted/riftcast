import * as THREE from 'three/webgpu';
import {
  attribute,
  vec3,
  vec4,
  float,
  uniform,
  mix,
  smoothstep,
  time,
  positionLocal,
  normalView,
  positionViewDirection,
  dot,
  abs,
  pow,
  sin,
  mx_noise_float,
  clamp,
  step,
  positionGeometry,
} from './tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../sim/rng';
import { ELEMENT_INFO } from '../data/elements';
import type { Element } from '../sim/types';
import { FACTIONS } from '../data/enemies';

/** Collects primitives with per-vertex color + glow and merges them into one draw call. */
class Builder {
  parts: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, color: number | THREE.Color, glow: number, m: THREE.Matrix4): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    const n = g.getAttribute('position').count;
    const c = new THREE.Color(color as THREE.ColorRepresentation);
    const ca = new Float32Array(n * 3);
    const ga = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ca[i * 3] = c.r;
      ca[i * 3 + 1] = c.g;
      ca[i * 3 + 2] = c.b;
      ga[i] = glow;
    }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(ga, 1));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'glow'].includes(k)) g.deleteAttribute(k);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.parts.push(g);
    return this;
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    g.computeBoundingSphere();
    return g;
  }
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const S = new THREE.Vector3();
const P = new THREE.Vector3();
export function mat(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return M.compose(P.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz)).clone();
}

function lumpy(geo: THREE.BufferGeometry, rng: Rng, amt: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pa = g.getAttribute('position') as THREE.BufferAttribute;
  const off = new Map<string, number>();
  for (let i = 0; i < pa.count; i++) {
    const k = `${pa.getX(i).toFixed(2)},${pa.getY(i).toFixed(2)},${pa.getZ(i).toFixed(2)}`;
    let o = off.get(k);
    if (o === undefined) {
      o = 1 + rng.range(-amt, amt);
      off.set(k, o);
    }
    pa.setXYZ(i, pa.getX(i) * o, pa.getY(i) * o, pa.getZ(i) * o);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Shared actor material: vertex colours, glow attribute for emissive parts, per-object FX
 * uniform (x = hit flash, y = dissolve, z = frozen, w = poison) for hits/death/status tints.
 */
export function actorMaterial(accent: THREE.Color, opts: { crystal?: boolean } = {}): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: opts.crystal ? 0.25 : 0.7, metalness: opts.crystal ? 0.2 : 0.05 });
  const fx = uniform(new THREE.Vector4(0, 0, 0, 0)).onObjectUpdate(({ object }) => (object.userData.fx as THREE.Vector4) ?? new THREE.Vector4(0, 0, 0, 0));
  const glow = attribute('glow', 'float');
  const vc = attribute('color', 'vec3');
  const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5);
  const pulse = sin(time.mul(4).add(positionLocal.y.mul(3))).mul(0.25).add(0.85);
  let base: any = vc;
  // frozen: icy tint; poison: sickly tint
  base = mix(base, vec3(0.65, 0.9, 1.1), fx.z.mul(0.7));
  base = mix(base, vec3(0.45, 0.9, 0.2), fx.w.mul(0.35));
  m.colorNode = base;
  const accentV = vec3(accent.r, accent.g, accent.b);
  let em: any = vc.mul(glow).mul(pulse).mul(2.2);
  em = em.add(accentV.mul(fres).mul(opts.crystal ? 1.4 : 0.55));
  em = em.add(vec3(1.6, 1.5, 1.4).mul(fx.x));
  em = em.add(vec3(0.4, 0.9, 1.4).mul(fx.z).mul(fres.add(0.25)));
  // dissolve with glowing edge
  const n = mx_noise_float(positionGeometry.mul(3.1)).mul(0.5).add(0.5);
  const edge = smoothstep(fx.y.sub(0.12), fx.y, n).sub(step(fx.y.add(0.001), n).mul(0));
  em = em.add(accentV.mul(4).mul(clamp(edge.mul(step(0.001, fx.y)), 0, 1)));
  m.emissiveNode = em;
  m.opacityNode = step(fx.y, n);
  m.alphaTest = 0.5;
  return m;
}

const matCache = new Map<string, THREE.MeshStandardNodeMaterial>();
function sharedMat(key: string, accent: number, crystal = false) {
  let m = matCache.get(key);
  if (!m) {
    m = actorMaterial(new THREE.Color(accent), { crystal });
    matCache.set(key, m);
  }
  return m;
}

export interface ActorRig {
  root: THREE.Group;
  body: THREE.Mesh;
  /** extra animated parts (rings, wings, plates) */
  spinners: THREE.Object3D[];
  wings: THREE.Object3D[];
  height: number;
}

/** Enemy silhouettes by archetype. Deterministic per seed so all peers see the same creature. */
export function buildEnemy(shape: string, faction: string, seed: number, radius: number, height: number): ActorRig {
  const rng = new Rng(seed);
  const b = new Builder();
  const root = new THREE.Group();
  const spinners: THREE.Object3D[] = [];
  const wings: THREE.Object3D[] = [];
  const fd = faction in FACTIONS ? FACTIONS[faction as keyof typeof FACTIONS] : null;
  const accent = fd?.accent ?? (shape === 'kiln' ? 0xff6a1a : 0xb48cff);
  const base = fd?.color ?? 0x222222;
  const dark = new THREE.Color(base).multiplyScalar(0.7);
  const sph = (d = 1) => new THREE.IcosahedronGeometry(1, d);
  const crystal = faction === 'glass' || shape === 'prism';

  switch (shape) {
    case 'brute': {
      b.add(lumpy(sph(1), rng, 0.15), base, 0, mat(0, 1.0, 0, 0.3, 0, 0, 0.75, 0.8, 0.6));
      b.add(lumpy(sph(1), rng, 0.12), dark, 0, mat(0, 1.65, 0.25, 0, 0, 0, 0.32));
      b.add(sph(0), accent, 1.6, mat(0.12, 1.7, 0.52, 0, 0, 0, 0.07));
      b.add(sph(0), accent, 1.6, mat(-0.12, 1.7, 0.52, 0, 0, 0, 0.07));
      for (const s of [-1, 1]) {
        b.add(new THREE.CylinderGeometry(0.22, 0.32, 1.1, 6), base, 0, mat(s * 0.78, 1.0, 0.15, 0.3, 0, s * 0.25));
        b.add(lumpy(sph(0), rng, 0.2), dark, 0, mat(s * 0.9, 0.42, 0.35, 0, 0, 0, 0.36));
        b.add(new THREE.CylinderGeometry(0.18, 0.15, 0.6, 5), dark, 0, mat(s * 0.3, 0.3, 0, 0, 0, 0));
      }
      // molten cracks
      for (let i = 0; i < 5; i++) b.add(new THREE.BoxGeometry(0.05, rng.range(0.3, 0.6), 0.05), accent, 2.2, mat(rng.range(-0.4, 0.4), rng.range(0.8, 1.3), 0.55, 0, 0, rng.range(-0.6, 0.6)));
      break;
    }
    case 'spitter': {
      b.add(new THREE.CylinderGeometry(0.22, 0.38, 1.0, 7), base, 0, mat(0, 0.6, 0));
      b.add(lumpy(sph(1), rng, 0.1), accent, 1.2, mat(0, 1.05, -0.35, 0, 0, 0, 0.45, 0.5, 0.45));
      b.add(new THREE.CylinderGeometry(0.1, 0.16, 0.6, 6), base, 0, mat(0, 1.35, 0.15, 0.6, 0, 0));
      b.add(sph(1), dark, 0, mat(0, 1.6, 0.35, 0, 0, 0, 0.22));
      b.add(new THREE.ConeGeometry(0.1, 0.25, 6), accent, 2, mat(0, 1.6, 0.6, Math.PI / 2, 0, 0));
      break;
    }
    case 'warden': {
      b.add(lumpy(sph(1), rng, 0.1), base, 0, mat(0, 1.9, 0, 0, 0, 0, 1.2, 1.3, 1.0));
      b.add(sph(1), accent, 2.4, mat(0, 2.0, 0.75, 0, 0, 0, 0.42));
      b.add(new THREE.TorusGeometry(0.55, 0.12, 6, 12), dark, 0, mat(0, 2.0, 0.78));
      b.add(lumpy(sph(1), rng, 0.1), dark, 0, mat(0, 3.15, 0.2, 0, 0, 0, 0.45));
      for (const s of [-1, 1]) {
        b.add(new THREE.ConeGeometry(0.14, 0.9, 5), dark, 0, mat(s * 0.35, 3.6, 0.1, -0.3, 0, -s * 0.6));
        b.add(new THREE.CylinderGeometry(0.35, 0.45, 1.6, 7), base, 0, mat(s * 1.35, 1.8, 0.2, 0.2, 0, s * 0.3));
        b.add(new THREE.BoxGeometry(0.8, 0.7, 0.8), dark, 0, mat(s * 1.55, 0.85, 0.35));
        b.add(new THREE.CylinderGeometry(0.3, 0.35, 1.0, 6), dark, 0, mat(s * 0.5, 0.5, 0));
      }
      break;
    }
    case 'shardling': {
      b.add(new THREE.OctahedronGeometry(1, 0), base, 0.35, mat(0, 0, 0, Math.PI / 2, 0, 0, 0.3, 0.75, 0.3));
      b.add(new THREE.ConeGeometry(0.12, 0.5, 4), accent, 1.5, mat(0, 0, 0.7, Math.PI / 2, 0, 0));
      for (const s of [-1, 1]) {
        const wg = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.1, 3).rotateZ(Math.PI / 2).translate(0.55 * s, 0, 0), sharedMat('glass-wing', accent, true));
        wg.userData.side = s;
        (wg as any).userData.fx = new THREE.Vector4(0, 0, 0, 0);
        wings.push(wg);
      }
      break;
    }
    case 'weaver': {
      b.add(new THREE.OctahedronGeometry(1, 0), base, 0.5, mat(0, 0, 0, 0, 0, 0, 0.45, 0.8, 0.45));
      b.add(sph(1), accent, 2.2, mat(0, 0, 0, 0, 0, 0, 0.2));
      const ring = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const sh = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), sharedMat('glass-wing', accent, true));
        sh.position.set(Math.cos(a) * 0.9, 0, Math.sin(a) * 0.9);
        sh.scale.set(1, 2, 1);
        (sh as any).userData.fx = new THREE.Vector4(0, 0, 0, 0);
        ring.add(sh);
      }
      spinners.push(ring);
      break;
    }
    case 'queen': {
      b.add(new THREE.OctahedronGeometry(1, 0), base, 0.35, mat(0, 0, 0, 0, 0, 0, 0.8, 1.2, 0.8));
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        b.add(new THREE.ConeGeometry(0.12, 0.8, 4), accent, 1.2, mat(Math.cos(a) * 0.45, 1.2, Math.sin(a) * 0.45, Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4));
      }
      b.add(sph(1), accent, 2.5, mat(0, 0.1, 0.55, 0, 0, 0, 0.22));
      for (const s of [-1, 1]) {
        for (let k = 0; k < 2; k++) {
          const wg = new THREE.Mesh(new THREE.ConeGeometry(0.5 - k * 0.15, 2.2 - k * 0.6, 3).rotateZ(Math.PI / 2).translate(1.1 * s, k * -0.5, 0), sharedMat('glass-wing', accent, true));
          wg.userData.side = s;
          (wg as any).userData.fx = new THREE.Vector4(0, 0, 0, 0);
          wings.push(wg);
        }
      }
      break;
    }
    case 'sludge': {
      b.add(lumpy(sph(2), rng, 0.12), base, 0.05, mat(0, 0.55, 0, 0, 0, 0, 0.85, 0.65, 0.85));
      for (let i = 0; i < 4; i++) {
        const a = rng.range(0, Math.PI * 2);
        b.add(new THREE.CylinderGeometry(0.05, 0.08, 0.6, 5), 0xd8d2b8, 0, mat(Math.cos(a) * 0.5, 0.95, Math.sin(a) * 0.5, rng.range(-0.8, 0.8), 0, rng.range(-0.8, 0.8)));
      }
      b.add(sph(0), accent, 2.2, mat(0.2, 0.85, 0.6, 0, 0, 0, 0.09));
      b.add(sph(0), accent, 2.2, mat(-0.2, 0.85, 0.6, 0, 0, 0, 0.09));
      for (let i = 0; i < 5; i++) b.add(sph(0), accent, 0.9, mat(rng.range(-0.6, 0.6), rng.range(0.3, 0.9), rng.range(-0.6, 0.6), 0, 0, 0, rng.range(0.06, 0.13)));
      break;
    }
    case 'lobber': {
      b.add(lumpy(sph(1), rng, 0.12), base, 0, mat(0, 0.5, 0, 0, 0, 0, 0.6, 0.5, 0.6));
      b.add(new THREE.CylinderGeometry(0.18, 0.25, 0.8, 7), dark, 0, mat(0, 1.1, 0));
      b.add(new THREE.SphereGeometry(0.75, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0x5a2a6a, 0.25, mat(0, 1.45, 0, 0, 0, 0, 1, 0.7, 1));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.add(sph(0), accent, 2.0, mat(Math.cos(a) * 0.55, 1.6, Math.sin(a) * 0.55, 0, 0, 0, 0.1));
      }
      break;
    }
    case 'titan': {
      b.add(lumpy(sph(2), rng, 0.1), base, 0.05, mat(0, 1.8, 0, 0, 0, 0, 1.4, 1.5, 1.2));
      b.add(lumpy(sph(1), rng, 0.15), dark, 0, mat(0, 3.2, 0.3, 0, 0, 0, 0.6));
      b.add(sph(0), accent, 2.4, mat(0.25, 3.3, 0.85, 0, 0, 0, 0.12));
      b.add(sph(0), accent, 2.4, mat(-0.25, 3.3, 0.85, 0, 0, 0, 0.12));
      for (const s of [-1, 1]) {
        b.add(lumpy(sph(1), rng, 0.15), base, 0, mat(s * 1.6, 1.3, 0.3, 0, 0, 0, 0.55, 1.1, 0.55));
        b.add(lumpy(sph(1), rng, 0.2), dark, 0, mat(s * 1.7, 0.35, 0.5, 0, 0, 0, 0.6));
      }
      for (let i = 0; i < 9; i++) {
        const a = rng.range(0, Math.PI * 2);
        b.add(new THREE.ConeGeometry(0.12, 0.8, 5), 0x3a6a2a, 0.3, mat(Math.cos(a) * 1.0, rng.range(2.2, 3.0), Math.sin(a) * 0.9, Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6));
      }
      break;
    }
    case 'kiln': {
      b.add(lumpy(sph(2), rng, 0.06), 0xff7a2a, 2.6, mat(0, 3.2, 0, 0, 0, 0, 1.6));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        b.add(new THREE.CylinderGeometry(0.4, 0.7, 3.4, 6), 0x1c1414, 0, mat(Math.cos(a) * 1.6, 1.2, Math.sin(a) * 1.6, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35));
      }
      b.add(new THREE.TorusGeometry(1.75, 0.18, 6, 24), 0x2a1a14, 0, mat(0, 3.2, 0, Math.PI / 2, 0, 0));
      const plates = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const pm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 0.3), sharedMat('boss-obsidian', 0xff6a1a));
        pm.position.set(Math.cos(a) * 3.0, 3.2, Math.sin(a) * 3.0);
        pm.lookAt(0, 3.2, 0);
        (pm as any).userData.fx = new THREE.Vector4(0, 0, 0, 0);
        plates.add(pm);
      }
      spinners.push(plates);
      break;
    }
    case 'prism': {
      b.add(new THREE.OctahedronGeometry(1, 0), 0xb8d8ff, 0.6, mat(0, 0, 0, 0, 0, 0, 1.3, 2.4, 1.3));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.add(new THREE.OctahedronGeometry(0.5, 0), 0xd8c8ff, 0.4, mat(Math.cos(a) * 1.1, rng.range(-1, 1), Math.sin(a) * 1.1, 0, 0, 0, 0.6, 1.6, 0.6));
      }
      b.add(sph(1), 0xa77bff, 3, mat(0, 0, 0, 0, 0, 0, 0.6));
      for (let k = 0; k < 2; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6 + k * 0.7, 0.07, 6, 48), sharedMat('boss-prism', 0xa77bff, true));
        ring.rotation.x = Math.PI / 2 + (k ? 0.5 : -0.4);
        (ring as any).userData.fx = new THREE.Vector4(0, 0, 0, 0);
        const g = new THREE.Group();
        g.add(ring);
        spinners.push(g);
      }
      break;
    }
    default:
      b.add(sph(1), base, 0, mat(0, height / 2, 0, 0, 0, 0, radius));
  }

  const geo = b.build();
  const body = new THREE.Mesh(geo, sharedMat(`${faction}-${crystal ? 'c' : 'b'}`, accent, crystal));
  body.userData.fx = new THREE.Vector4(0, 0, 0, 0);
  // flyers are modelled around their centre
  const s = shape === 'shardling' || shape === 'weaver' || shape === 'queen' || shape === 'prism' ? 1 : 1;
  body.scale.setScalar(s);
  root.add(body);
  for (const sp of spinners) root.add(sp);
  for (const w of wings) root.add(w);
  return { root, body, spinners, wings, height };
}

/** Player mage: hooded robe, glowing gauntlets coloured by the active element. */
export function buildMage(
  color: number,
  seed: number,
): ActorRig & { handL: THREE.Mesh; handR: THREE.Mesh; armL: THREE.Group; armR: THREE.Group; core: THREE.Mesh; setElement(el: Element, el2: Element): void } {
  const rng = new Rng(seed);
  const b = new Builder();
  const robe = new THREE.Color(0x1b1a2a);
  const trim = new THREE.Color(color);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(0.48 - t * 0.26 + Math.sin(t * 3) * 0.04, t * 1.3));
  }
  b.add(new THREE.LatheGeometry(pts, 14), robe, 0, mat(0, 0, 0));
  b.add(new THREE.TorusGeometry(0.47, 0.04, 5, 16), trim, 1.4, mat(0, 0.05, 0, Math.PI / 2, 0, 0));
  b.add(new THREE.TorusGeometry(0.26, 0.035, 5, 14), trim, 1.2, mat(0, 1.05, 0, Math.PI / 2, 0, 0));
  // shoulders + hood
  b.add(new THREE.IcosahedronGeometry(0.3, 1), robe, 0, mat(0, 1.32, 0, 0, 0, 0, 1.3, 0.7, 1));
  b.add(new THREE.ConeGeometry(0.27, 0.6, 10), robe, 0, mat(0, 1.75, 0.04, -0.15, 0, 0));
  b.add(new THREE.SphereGeometry(0.19, 10, 8), 0x050508, 0, mat(0, 1.58, -0.06));
  b.add(new THREE.SphereGeometry(0.035, 6, 4), trim, 3.0, mat(0.07, 1.6, -0.22));
  b.add(new THREE.SphereGeometry(0.035, 6, 4), trim, 3.0, mat(-0.07, 1.6, -0.22));
  // belt + rune sash
  b.add(new THREE.TorusGeometry(0.36, 0.05, 5, 14), 0x2c2436, 0, mat(0, 0.72, 0, Math.PI / 2, 0, 0));
  b.add(new THREE.BoxGeometry(0.1, 0.5, 0.02), trim, 0.8, mat(0.12 + rng.range(-0.02, 0.02), 0.45, -0.39, -0.15, 0, 0));
  const geo = b.build();
  // arms: separate pivoted sleeves so casting can raise them toward the aim
  const ab = new Builder();
  ab.add(new THREE.CylinderGeometry(0.08, 0.11, 0.5, 6), robe, 0, mat(0, 0, -0.25, Math.PI / 2, 0, 0));
  ab.add(new THREE.TorusGeometry(0.075, 0.025, 4, 10), trim, 1.3, mat(0, 0, -0.48));
  const armGeo = ab.build();
  const body = new THREE.Mesh(geo, sharedMat(`mage-${color}`, color));
  body.userData.fx = new THREE.Vector4(0, 0, 0, 0);
  const root = new THREE.Group();
  root.add(body);
  const handMat = (el: Element) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.3 });
    const info = ELEMENT_INFO[el];
    const c = new THREE.Color(info.main);
    const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 1.5);
    m.colorNode = vec3(c.r, c.g, c.b).mul(0.2);
    m.emissiveNode = vec3(c.r, c.g, c.b).mul(fres.mul(3).add(1.3));
    return m;
  };
  const handGeo = new THREE.IcosahedronGeometry(0.13, 0);
  const handR = new THREE.Mesh(handGeo, handMat('fire'));
  const handL = new THREE.Mesh(handGeo, handMat('frost'));
  const armR = new THREE.Group(),
    armL = new THREE.Group();
  armR.position.set(0.36, 1.3, -0.02);
  armL.position.set(-0.36, 1.3, -0.02);
  for (const a of [armR, armL]) {
    const m = new THREE.Mesh(armGeo, body.material);
    m.userData.fx = body.userData.fx;
    a.add(m);
    a.rotation.x = -1.1;
    root.add(a);
  }
  handR.position.set(0, 0, -0.58);
  handL.position.set(0, 0, -0.58);
  armR.add(handR);
  armL.add(handL);
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), handMat('fire'));
  core.position.set(0, 1.25, 0.32);
  root.add(core);
  const mats = new Map<Element, THREE.MeshStandardNodeMaterial>();
  const getMat = (el: Element) => {
    let m = mats.get(el);
    if (!m) mats.set(el, (m = handMat(el)));
    return m;
  };
  return {
    root,
    body,
    spinners: [],
    wings: [],
    height: 1.9,
    handL,
    handR,
    armL,
    armR,
    core,
    setElement(el: Element, el2: Element) {
      handR.material = getMat(el);
      core.material = getMat(el);
      handL.material = getMat(el2);
    },
  };
}

export const enemyAccent = (faction: string) => (faction in FACTIONS ? FACTIONS[faction as keyof typeof FACTIONS].accent : 0xff6a1a);
export { vec4 };
