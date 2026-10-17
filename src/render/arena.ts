import * as THREE from 'three/webgpu';
import {
  positionWorld,
  positionLocal,
  normalWorld,
  vec3,
  float,
  mix,
  smoothstep,
  uniform,
  time,
  mx_worley_noise_float,
  mx_noise_float,
  mx_fractal_noise_float,
  abs,
  sin,
  max,
  pow,
  normalize,
  clamp,
  fract,
  floor,
  dot,
  hash,
  vec2,
  step,
  Fn,
} from './tsl';
import type { Room } from '../sim/room';
import { Rng } from '../sim/rng';
import type { QualityPreset } from '../core/quality';

export interface Theme {
  skyTop: number;
  skyHorizon: number;
  skyLow: number;
  accent: number;
  stone: number;
  stoneDark: number;
  fog: number;
  sun: number;
}

export const THEMES: Theme[] = [
  { skyTop: 0x07041a, skyHorizon: 0x3c1c66, skyLow: 0x120826, accent: 0xb48cff, stone: 0x6a6280, stoneDark: 0x2a2436, fog: 0x1c1030, sun: 0xd9c8ff },
  { skyTop: 0x0e0408, skyHorizon: 0x7a2c14, skyLow: 0x1e0806, accent: 0xff8a3a, stone: 0x7a6a60, stoneDark: 0x30241e, fog: 0x2a120c, sun: 0xffd2a8 },
  { skyTop: 0x020c16, skyHorizon: 0x0f5262, skyLow: 0x041820, accent: 0x4affd9, stone: 0x5d7276, stoneDark: 0x1c282c, fog: 0x0a2228, sun: 0xc8fff4 },
  { skyTop: 0x0c0c1c, skyHorizon: 0x7a5630, skyLow: 0x1a1210, accent: 0xffd36a, stone: 0x7e7666, stoneDark: 0x2e2a24, fog: 0x241c14, sun: 0xfff0c8 },
];

const col = (hex: number) => new THREE.Color(hex);

/** Builds the floating-ruin arena for a room: platforms, pillars, debris, sky, lights. Everything procedural. */
export class Arena {
  group = new THREE.Group();
  sky: THREE.Mesh;
  theme: Theme = THEMES[0];
  uAccent = uniform(new THREE.Color(0xb48cff));
  uStone = uniform(new THREE.Color(0x6a6280));
  uStoneDark = uniform(new THREE.Color(0x2a2436));
  uSkyTop = uniform(new THREE.Color(0x07041a));
  uSkyHorizon = uniform(new THREE.Color(0x3c1c66));
  uSkyLow = uniform(new THREE.Color(0x120826));
  uPulse = uniform(0);
  floorMat: THREE.MeshStandardNodeMaterial;
  rockMat: THREE.MeshStandardNodeMaterial;
  pillarMat: THREE.MeshStandardNodeMaterial;
  hemi = new THREE.HemisphereLight(0x8890ff, 0x201018, 1.3);
  sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private debris: THREE.InstancedMesh | null = null;
  private debrisData: { x: number; y: number; z: number; s: number; sp: number; ph: number; rx: number; ry: number }[] = [];
  private dummy = new THREE.Object3D();

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    scene.add(this.hemi);
    this.sun.position.set(-30, 50, 20);
    scene.add(this.sun);
    scene.fog = new THREE.FogExp2(0x1c1030, 0.009);

    // --- Sky: gradient + nebula + stars + rift band ---
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const dir = normalize(positionLocal);
    const h = dir.y;
    const base = mix(mix(vec3(this.uSkyLow), vec3(this.uSkyHorizon), smoothstep(-0.35, 0.05, h)), vec3(this.uSkyTop), smoothstep(0.05, 0.75, h));
    const neb = mx_fractal_noise_float(dir.mul(2.2).add(vec3(0, time.mul(0.004), 0)), 4, 2.0, 0.5);
    const neb2 = mx_fractal_noise_float(dir.mul(5.0).add(vec3(3.1, 0, time.mul(0.006))), 3, 2.0, 0.5);
    const nebMask = smoothstep(0.0, 0.6, neb).mul(smoothstep(-0.2, 0.3, h));
    const nebCol = mix(vec3(this.uAccent).mul(0.55), vec3(this.uSkyHorizon).mul(1.6), neb2.mul(0.5).add(0.5));
    // stars: hashed cells on a cube-ish projection
    const cell = floor(dir.mul(160));
    const rnd = hash(dot(cell, vec3(12.9898, 78.233, 37.719)));
    const twinkle = sin(time.mul(2).add(rnd.mul(40))).mul(0.5).add(0.5);
    const starMask = step(0.9965, rnd).mul(smoothstep(-0.05, 0.25, h)).mul(twinkle.mul(0.7).add(0.3));
    // rift band: a glowing tear across the sky
    const band = abs(dir.y.sub(dir.x.mul(0.35)).sub(0.32).add(mx_noise_float(dir.mul(3)).mul(0.04)));
    const rift = smoothstep(0.05, 0.0, band).mul(smoothstep(-0.6, 0.6, dir.z)).mul(1.8);
    skyMat.colorNode = base.add(nebCol.mul(nebMask).mul(0.9)).add(vec3(starMask.mul(2.2))).add(vec3(this.uAccent).mul(rift));
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // --- Floor: worley flagstones with glowing rune seams ---
    this.floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.05 });
    const p = positionWorld.xz;
    const cellN = mx_worley_noise_float(p.mul(0.32));
    const edge = smoothstep(0.02, 0.09, cellN);
    const grain = mx_fractal_noise_float(vec3(p.mul(1.7), 0), 3, 2, 0.5).mul(0.5).add(0.5);
    const tint = mx_noise_float(vec3(p.mul(0.06), 1)).mul(0.5).add(0.5);
    const stone = mix(vec3(this.uStoneDark), vec3(this.uStone), grain.mul(0.6).add(tint.mul(0.4)));
    this.floorMat.colorNode = stone.mul(mix(float(0.35), float(1), edge));
    // rune glow in seams, pulsing outward in rings
    const r = p.length();
    const wave = sin(r.mul(0.5).sub(time.mul(1.4))).mul(0.5).add(0.5);
    const seam = float(1).sub(edge);
    const runeMask = seam.mul(smoothstep(0.55, 1.0, mx_noise_float(vec3(p.mul(0.15), 7)).mul(0.5).add(0.5)).mul(1.4).add(0.12));
    this.floorMat.emissiveNode = vec3(this.uAccent).mul(runeMask.mul(wave.mul(0.8).add(0.3)).mul(this.uPulse.mul(1.2).add(0.9)));
    this.floorMat.roughnessNode = mix(float(0.95), float(0.55), seam);

    // --- Undersides & pillars: rocky, with faint veins ---
    this.rockMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    const pr = positionWorld;
    const rn = mx_fractal_noise_float(pr.mul(0.45), 4, 2, 0.5).mul(0.5).add(0.5);
    const strata = sin(pr.y.mul(3.0).add(rn.mul(4))).mul(0.5).add(0.5);
    this.rockMat.colorNode = mix(vec3(this.uStoneDark).mul(0.6), vec3(this.uStone).mul(0.85), rn.mul(0.7).add(strata.mul(0.3)));
    const vein = smoothstep(0.035, 0.0, abs(mx_noise_float(pr.mul(0.6)).sub(0.1)));
    const depthFade = smoothstep(-2.0, -14.0, pr.y);
    this.rockMat.emissiveNode = vec3(this.uAccent).mul(vein.mul(depthFade.mul(1.6).add(0.15)));

    this.pillarMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.05 });
    const pn = mx_fractal_noise_float(pr.mul(vec3(1.2, 0.4, 1.2)), 3, 2, 0.5).mul(0.5).add(0.5);
    this.pillarMat.colorNode = mix(vec3(this.uStoneDark), vec3(this.uStone), pn);
    const band2 = smoothstep(0.92, 1.0, sin(pr.y.mul(2.2)).mul(0.5).add(0.5)).mul(smoothstep(0.2, 0.6, fract(pr.y.mul(0.13))));
    this.pillarMat.emissiveNode = vec3(this.uAccent).mul(band2.mul(sin(time.mul(2).add(pr.y)).mul(0.4).add(1.1)));
  }

  build(room: Room, q: QualityPreset): void {
    this.clear();
    const th = THEMES[room.theme % THEMES.length];
    this.theme = th;
    this.uAccent.value.set(th.accent);
    this.uStone.value.set(th.stone);
    this.uStoneDark.value.set(th.stoneDark);
    this.uSkyTop.value.set(th.skyTop);
    this.uSkyHorizon.value.set(th.skyHorizon);
    this.uSkyLow.value.set(th.skyLow);
    (this.scene.fog as THREE.FogExp2).color.set(th.fog);
    this.hemi.color.set(th.sun).lerp(col(th.accent), 0.25);
    this.hemi.groundColor.set(th.stoneDark);
    this.sun.color.set(th.sun);

    const rng = new Rng(room.seed ^ 0xabc);
    for (const p of room.platforms) this.group.add(this.buildPlatform(p.x, p.z, p.r, p.top, p.seed));
    for (const o of room.obstacles) this.group.add(this.buildPillar(o.x, o.z, o.r, o.h, o.kind, o.seed));

    // Floating debris ring (instanced)
    const n = Math.floor(70 * q.decorDensity);
    const geo = new THREE.IcosahedronGeometry(1, 0);
    jitterGeometry(geo, rng, 0.25);
    this.debris = new THREE.InstancedMesh(geo, this.rockMat, n);
    this.debrisData = [];
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = room.bound + rng.range(6, 60);
      this.debrisData.push({ x: Math.cos(a) * d, y: rng.range(-30, 18), z: Math.sin(a) * d, s: rng.range(0.4, 3.2) * (d > room.bound + 30 ? 2 : 1), sp: rng.range(0.2, 0.7), ph: rng.range(0, 6), rx: rng.range(-0.3, 0.3), ry: rng.range(-0.3, 0.3) });
    }
    this.debris.frustumCulled = false;
    this.group.add(this.debris);

    // Distant islands
    const far = Math.floor(7 * q.decorDensity) + 3;
    for (let i = 0; i < far; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(110, 220);
      const isl = this.buildPlatform(Math.cos(a) * d, Math.sin(a) * d, rng.range(8, 22), rng.range(-40, 25), rng.int(0, 1e6), true);
      this.group.add(isl);
    }
    this.update(0, 0);
  }

  private buildPlatform(x: number, z: number, r: number, top: number, seed: number, far = false): THREE.Group {
    const g = new THREE.Group();
    const rng = new Rng(seed);
    const seg = far ? 18 : Math.max(28, Math.floor(r * 3.2));
    const edgeR: number[] = [];
    const ph1 = rng.range(0, 6),
      ph2 = rng.range(0, 6);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      edgeR.push(r * (1.04 + 0.05 * Math.sin(a * 3 + ph1) + 0.035 * Math.sin(a * 7 + ph2) + rng.range(-0.02, 0.02)));
    }
    // Top: concentric rings fan
    const rings = far ? 2 : 4;
    const pos: number[] = [];
    const idx: number[] = [];
    pos.push(0, 0, 0);
    for (let ri = 1; ri <= rings; ri++) {
      const t = ri / rings;
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const rr = edgeR[i] * t;
        pos.push(Math.cos(a) * rr, ri === rings ? -0.05 : 0, Math.sin(a) * rr);
      }
    }
    for (let i = 0; i < seg; i++) idx.push(0, 1 + ((i + 1) % seg), 1 + i);
    for (let ri = 1; ri < rings; ri++) {
      const o0 = 1 + (ri - 1) * seg,
        o1 = 1 + ri * seg;
      for (let i = 0; i < seg; i++) {
        const i1 = (i + 1) % seg;
        idx.push(o0 + i, o0 + i1, o1 + i, o0 + i1, o1 + i1, o1 + i);
      }
    }
    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    topGeo.setIndex(idx);
    topGeo.computeVertexNormals();
    const topMesh = new THREE.Mesh(topGeo, far ? this.rockMat : this.floorMat);
    topMesh.position.set(x, top, z);
    topMesh.receiveShadow = true;
    g.add(topMesh);

    // Underside: tapering rocky cone with noisy layers
    const layers = far ? 5 : 8;
    const depth = (top > 0.5 ? top + 3 : r * 0.9 + 6) * rng.range(0.9, 1.3);
    const up: number[] = [];
    const ui: number[] = [];
    for (let l = 0; l <= layers; l++) {
      const t = l / layers;
      const y = l === 0 ? -0.05 : l === 1 ? -0.6 : -t * depth;
      const shrink = l <= 1 ? 1.0 - l * 0.02 : Math.pow(1 - t, 1.35) * 0.95 + 0.05;
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const n = l <= 1 ? 1 : 1 + rng.range(-0.18, 0.18);
        const rr = edgeR[i] * shrink * n;
        up.push(Math.cos(a) * rr, y + (l > 1 ? rng.range(-0.4, 0.4) : 0), Math.sin(a) * rr);
      }
    }
    up.push(0, -depth - rng.range(1, 4), 0);
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < seg; i++) {
        const i1 = (i + 1) % seg;
        const a = l * seg + i,
          b = l * seg + i1,
          c = (l + 1) * seg + i,
          d = (l + 1) * seg + i1;
        ui.push(a, b, c, b, d, c);
      }
    }
    const tip = (layers + 1) * seg;
    for (let i = 0; i < seg; i++) ui.push(layers * seg + i, layers * seg + ((i + 1) % seg), tip);
    let underGeo = new THREE.BufferGeometry();
    underGeo.setAttribute('position', new THREE.Float32BufferAttribute(up, 3));
    underGeo.setIndex(ui);
    underGeo = underGeo.toNonIndexed();
    underGeo.computeVertexNormals();
    const under = new THREE.Mesh(underGeo, this.rockMat);
    under.position.set(x, top, z);
    g.add(under);

    if (!far) {
      // Rim stones along edge
      const stones = Math.floor(seg * 0.35);
      const sg = new THREE.DodecahedronGeometry(1, 0);
      const inst = new THREE.InstancedMesh(sg, this.pillarMat, stones);
      for (let i = 0; i < stones; i++) {
        const k = Math.floor(rng.range(0, seg));
        const a = (k / seg) * Math.PI * 2;
        const rr = edgeR[k] * 0.97;
        const s = rng.range(0.25, 0.6);
        this.dummy.position.set(x + Math.cos(a) * rr, top + s * 0.3, z + Math.sin(a) * rr);
        this.dummy.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
        this.dummy.scale.set(s * rng.range(0.8, 1.6), s, s);
        this.dummy.updateMatrix();
        inst.setMatrixAt(i, this.dummy.matrix);
      }
      g.add(inst);
    }
    return g;
  }

  private buildPillar(x: number, z: number, r: number, h: number, kind: string, seed: number): THREE.Group {
    const g = new THREE.Group();
    const rng = new Rng(seed);
    if (kind === 'obelisk') {
      const geo = new THREE.CylinderGeometry(r * 0.35, r * 0.75, h, 4, 6);
      jitterGeometry(geo, rng, 0.04);
      const m = new THREE.Mesh(geo, this.pillarMat);
      m.position.set(x, h / 2, z);
      m.rotation.y = rng.range(0, Math.PI);
      g.add(m);
      const crys = new THREE.Mesh(new THREE.OctahedronGeometry(r * 0.45, 0), crystalMaterial(this.uAccent));
      crys.position.set(x, h + 1.2, z);
      crys.userData.spin = rng.range(0.5, 1.2);
      crys.userData.baseY = h + 1.2;
      g.add(crys);
      g.userData.crystal = crys;
    } else {
      const hh = kind === 'broken' ? h * 0.55 : h;
      const geo = new THREE.CylinderGeometry(r * 0.85, r, hh, 10, Math.max(4, Math.floor(hh)));
      // fluting + noise
      const pa = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) {
        const px = pa.getX(i),
          pz = pa.getZ(i),
          py = pa.getY(i);
        const a = Math.atan2(pz, px);
        const f = 1 + 0.06 * Math.cos(a * 10) + rng.range(-0.03, 0.03);
        let topBreak = 1;
        if (kind === 'broken' && py > hh / 2 - 0.6) topBreak = 1 + rng.range(-0.25, 0.1);
        pa.setXYZ(i, px * f, py * (py > 0 ? topBreak : 1), pz * f);
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, this.pillarMat);
      m.position.set(x, hh / 2, z);
      g.add(m);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.3, r * 1.45, 0.5, 10), this.pillarMat);
      base.position.set(x, 0.25, z);
      g.add(base);
      if (kind === 'pillar') {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.35, r * 1.05, 0.45, 10), this.pillarMat);
        cap.position.set(x, hh + 0.2, z);
        g.add(cap);
      } else {
        // fallen chunk
        const ch = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.85, h * 0.3, 10), this.pillarMat);
        const a = rng.range(0, Math.PI * 2);
        ch.position.set(x + Math.cos(a) * (r + 1.2), r * 0.8, z + Math.sin(a) * (r + 1.2));
        ch.rotation.set(Math.PI / 2, 0, a);
        g.add(ch);
      }
    }
    return g;
  }

  update(t: number, pulse: number): void {
    this.uPulse.value = pulse;
    if (this.debris) {
      for (let i = 0; i < this.debrisData.length; i++) {
        const d = this.debrisData[i];
        this.dummy.position.set(d.x, d.y + Math.sin(t * d.sp + d.ph) * 1.2, d.z);
        this.dummy.rotation.set(t * d.rx + d.ph, t * d.ry, 0);
        this.dummy.scale.setScalar(d.s);
        this.dummy.updateMatrix();
        this.debris.setMatrixAt(i, this.dummy.matrix);
      }
      this.debris.instanceMatrix.needsUpdate = true;
    }
    for (const c of this.group.children) {
      const crys = c.userData.crystal as THREE.Mesh | undefined;
      if (crys) {
        crys.rotation.y = t * crys.userData.spin;
        crys.position.y = crys.userData.baseY + Math.sin(t * 1.5 + crys.userData.spin * 5) * 0.25;
      }
    }
  }

  clear(): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    this.debris = null;
  }
}

export function jitterGeometry(geo: THREE.BufferGeometry, rng: Rng, amt: number): void {
  const pa = geo.getAttribute('position') as THREE.BufferAttribute;
  const map = new Map<string, [number, number, number]>();
  for (let i = 0; i < pa.count; i++) {
    const k = `${pa.getX(i).toFixed(3)},${pa.getY(i).toFixed(3)},${pa.getZ(i).toFixed(3)}`;
    let o = map.get(k);
    if (!o) {
      o = [rng.range(-amt, amt), rng.range(-amt, amt), rng.range(-amt, amt)];
      map.set(k, o);
    }
    pa.setXYZ(i, pa.getX(i) * (1 + o[0]), pa.getY(i) * (1 + o[1]), pa.getZ(i) * (1 + o[2]));
  }
  geo.computeVertexNormals();
}

export function crystalMaterial(accent: ReturnType<typeof uniform>): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.1 });
  const fres = pow(float(1).sub(clamp(dot(normalWorld, normalize(vec3(0.3, 1, 0.2))), 0, 1)), 2);
  m.colorNode = vec3(accent).mul(0.3);
  m.emissiveNode = vec3(accent).mul(fres.mul(2).add(1.2));
  return m;
}

export { Fn, vec2, max };
