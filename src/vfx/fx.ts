import * as THREE from 'three/webgpu';
import { cc } from './colors';
import { instancedBufferAttribute, vec2, vec4, texture, uv, float } from '../render/tsl';
import { ParticleSystem, type Emit } from './particles';
import { SHAPE } from './atlas';
import { particleAtlas } from './atlas';
import { StripRenderer, Trail, drawTrail } from './strips';
import { generateLightning, type Bolt } from './lightning';
import { Shockwaves } from './rings';
import { DecalLayer, scorchShader, frostShader, oozeShader, waterShader, electricShader, runeShader, teleRadialShader, teleLineShader } from './decals';
import { Distortion } from './distort';
import { LightPool } from './lights';
import { Spikes } from './spikes';
import { ProjMeshes } from './projmesh';
import type { QualityPreset } from '../core/quality';
import type { Element, Telegraph, Zone } from '../sim/types';
import { ELEMENT_INFO } from '../data/elements';

export interface Juice {
  shake(amount: number): void;
  flash(color: number, amount: number): void;
  hitstop(ms: number): void;
  aberration(amount: number): void;
}

export interface GroundFn {
  (x: number, z: number, y: number): number;
}

interface ProjVis {
  id: number;
  el: Element;
  spell: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  g: number;
  r: number;
  enemy: boolean;
  trail: Trail | null;
  trail2: Trail | null;
  emitT: number;
  age: number;
  life: number;
  sx: number;
  sy: number;
  sz: number;
}

interface BoltVis {
  a: [number, number, number];
  b: [number, number, number];
  t: number;
  life: number;
  bolt: Bolt;
  regen: number;
  color: number;
  width: number;
  seed: number;
}

const C = (el: Element) => ELEMENT_INFO[el];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Instanced glowing billboards for projectile heads, orbs and floating motes. */
class Cores {
  mesh: THREE.Sprite;
  private a: THREE.InstancedBufferAttribute;
  private b: THREE.InstancedBufferAttribute;
  private n = 0;
  constructor(private max = 512) {
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pa = instancedBufferAttribute(this.a);
    const pb = instancedBufferAttribute(this.b);
    m.positionNode = pa.xyz;
    m.scaleNode = vec2(pa.w, pa.w);
    // shape 0 (glow) or 6 (flare) from atlas, chosen by pb.w
    const cell = pb.w;
    const cx = cell.mod(4);
    const cy = float(3).sub(cell.div(4).floor());
    const t = texture(particleAtlas(), uv().add(vec2(cx, cy)).div(4));
    m.colorNode = vec4(pb.xyz.mul(t.a), t.a);
    this.mesh = new THREE.Sprite(m);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 24;
  }
  begin() {
    this.n = 0;
  }
  add(x: number, y: number, z: number, size: number, color: THREE.Color, intensity: number, shape = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    const A = this.a.array as Float32Array,
      B = this.b.array as Float32Array;
    A[i * 4] = x;
    A[i * 4 + 1] = y;
    A[i * 4 + 2] = z;
    A[i * 4 + 3] = size;
    B[i * 4] = color.r * intensity;
    B[i * 4 + 1] = color.g * intensity;
    B[i * 4 + 2] = color.b * intensity;
    B[i * 4 + 3] = shape;
  }
  end() {
    this.mesh.count = this.n;
    this.a.clearUpdateRanges();
    this.a.addUpdateRange(0, this.n * 4);
    this.b.clearUpdateRanges();
    this.b.addUpdateRange(0, this.n * 4);
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
  }
}

const tmpCol = new THREE.Color();
const tmpCol2 = new THREE.Color();

export class Fx {
  group = new THREE.Group();
  add: ParticleSystem;
  blend: ParticleSystem;
  strips = new StripRenderer();
  rings = new Shockwaves();
  cores = new Cores();
  distort: Distortion | null = null;
  lights: LightPool;
  ice = new Spikes('ice');
  rock = new Spikes('rock');
  projMeshes = new ProjMeshes();
  private seenZones = new Set<number>();
  decals: Record<'scorch' | 'frost' | 'ooze' | 'water' | 'electric' | 'rune' | 'teleR' | 'teleL', DecalLayer>;
  trails: Trail[] = [];
  projs = new Map<number, ProjVis>();
  bolts: BoltVis[] = [];
  time = 0;
  density = 1;
  ground: GroundFn = () => 0;
  private camera: THREE.Camera | null = null;
  private juice: Juice;

  constructor(renderer: THREE.WebGPURenderer, gpu: boolean, private q: QualityPreset, juice?: Juice) {
    this.juice = juice ?? { shake() {}, flash() {}, hitstop() {}, aberration() {} };
    this.density = q.density;
    const capA = gpu ? q.gpuParticles : q.cpuParticles;
    this.add = new ParticleSystem(renderer, { gpu, capacity: capA, additive: true, soft: q.softParticles });
    this.blend = new ParticleSystem(renderer, { gpu, capacity: Math.floor(capA / 2), additive: false, soft: q.softParticles });
    this.decals = {
      scorch: new DecalLayer(scorchShader, 64, { order: 4 }),
      water: new DecalLayer(waterShader, 48, { order: 4 }),
      ooze: new DecalLayer(oozeShader, 48, { order: 5 }),
      frost: new DecalLayer(frostShader, 48, { order: 6 }),
      electric: new DecalLayer(electricShader, 48, { additive: true, order: 7 }),
      rune: new DecalLayer(runeShader, 32, { additive: true, order: 8 }),
      teleR: new DecalLayer(teleRadialShader, 96, { order: 9 }),
      teleL: new DecalLayer(teleLineShader, 64, { order: 9, anchor: 'start' }),
    };
    for (const d of Object.values(this.decals)) this.group.add(d.mesh);
    this.group.add(this.blend.mesh, this.add.mesh, this.strips.mesh, this.rings.group, this.cores.mesh);
    this.lights = new LightPool(q.name === 'low' ? 2 : q.name === 'medium' ? 4 : 6);
    this.group.add(this.lights.group, this.ice.mesh, this.rock.mesh, this.projMeshes.group);
    if (q.distortion) {
      this.distort = new Distortion();
      this.group.add(this.distort.mesh);
    }
  }

  setJuice(j: Juice) {
    this.juice = j;
  }

  get particleCount(): number {
    return this.add.alive + this.blend.alive;
  }

  private e(sys: 'add' | 'blend', p: Emit) {
    p.count = Math.max(1, Math.round(p.count * this.density));
    (sys === 'add' ? this.add : this.blend).emit(p);
  }

  // ============================================================ element languages
  /** Small burst in an element's signature motion. */
  burst(el: Element, x: number, y: number, z: number, scale = 1, dir?: [number, number, number]) {
    const c = C(el);
    const s = scale;
    const fy = this.ground(x, z, y + 1);
    const dvx = dir ? dir[0] * 4 * s : 0,
      dvy = dir ? dir[1] * 4 * s : 0,
      dvz = dir ? dir[2] * 4 * s : 0;
    switch (el) {
      case 'fire':
        this.e('add', { x, y, z, count: 22 * s, spread: 6 * s, vx: dvx, vy: dvy + 1.5, vz: dvz, life: 0.5, lifeVar: 0.4, size: 0.5 * s, sizeEnd: 0.1, color: c.core, colorEnd: c.dark, intensity: 4, intensityEnd: 1.5, gravity: -3, drag: 2.5, turb: 4, shape: SHAPE.flame, spin: 3 });
        this.e('add', { x, y, z, count: 14 * s, spread: 9 * s, vx: dvx, vy: dvy + 2, vz: dvz, life: 0.7, lifeVar: 0.5, size: 0.09, color: 0xffe0a0, colorEnd: c.main, intensity: 6, gravity: 5, drag: 1.2, shape: SHAPE.spark, stretch: 6, floorY: fy, bounce: 0.4 });
        this.e('blend', { x, y: y + 0.3, z, count: 6 * s, spread: 1.2, vy: 1.6, life: 1.2, lifeVar: 0.3, size: 0.6 * s, sizeEnd: 1.6 * s, color: 0x2a1a14, colorEnd: 0x15100e, alpha: 0.55, gravity: -1.2, drag: 1, turb: 2, shape: SHAPE.smoke, spin: 1 });
        break;
      case 'frost':
        this.e('add', { x, y, z, count: 16 * s, spread: 10 * s, vx: dvx, vy: dvy + 1, vz: dvz, life: 0.55, lifeVar: 0.3, size: 0.32 * s, sizeEnd: 0.05, color: c.core, colorEnd: c.main, intensity: 3.5, gravity: 9, drag: 2, shape: SHAPE.shard, stretch: 3, floorY: fy, bounce: 0.25 });
        this.e('add', { x, y, z, count: 10 * s, spread: 3, life: 1.1, lifeVar: 0.5, size: 0.14, sizeEnd: 0.0, color: 0xffffff, colorEnd: c.main, intensity: 4, gravity: 0.6, drag: 1.5, turb: 1, shape: SHAPE.flake, spin: 2 });
        this.e('add', { x, y, z, count: 2, life: 0.18, size: 1.8 * s, sizeEnd: 0.4, color: c.core, colorEnd: c.main, intensity: 3, shape: SHAPE.flare });
        break;
      case 'storm':
        this.e('add', { x, y, z, count: 26 * s, spread: 16 * s, vx: dvx, vy: dvy, vz: dvz, life: 0.22, lifeVar: 0.5, size: 0.08, color: 0xffffff, colorEnd: c.main, intensity: 7, drag: 4, gravity: 3, shape: SHAPE.spark, stretch: 10 });
        this.e('add', { x, y, z, count: 4 * s, spread: 0.5, life: 0.12, lifeVar: 0.4, size: 1.2 * s, sizeEnd: 1.6 * s, color: c.core, colorEnd: c.main, intensity: 4, shape: SHAPE.zap, spin: 20 });
        this.e('add', { x, y, z, count: 1, life: 0.12, size: 2.6 * s, sizeEnd: 0.5, color: 0xffffff, colorEnd: c.main, intensity: 3, shape: SHAPE.flare });
        break;
      case 'gale':
        this.e('add', { x, y, z, count: 14 * s, spread: 7 * s, mode: 1, vx: dvx, vy: dvy, vz: dvz, life: 0.5, lifeVar: 0.3, size: 0.9 * s, sizeEnd: 1.4 * s, color: c.core, colorEnd: c.main, intensity: 1.6, alpha: 0.7, drag: 3, turb: 6, shape: SHAPE.wisp, spin: 8 });
        this.e('add', { x, y, z, count: 10 * s, spread: 8, life: 0.35, size: 0.06, color: 0xffffff, colorEnd: c.main, intensity: 3, drag: 3, shape: SHAPE.spark, stretch: 6 });
        break;
      case 'stone':
        this.e('blend', { x, y, z, count: 14 * s, spread: 8 * s, vx: dvx, vy: dvy + 4, vz: dvz, life: 1.0, lifeVar: 0.4, size: 0.22 * s, sizeVar: 0.5, color: 0x9a7a5a, colorEnd: 0x6a5240, gravity: 22, drag: 0.6, shape: SHAPE.rock, spin: 8, floorY: fy + 0.08, bounce: 0.35 });
        this.e('blend', { x, y, z, count: 8 * s, spread: 2.5, mode: 2, life: 1.2, lifeVar: 0.4, size: 0.7 * s, sizeEnd: 2.2 * s, color: 0xb0a088, colorEnd: 0x7a6a58, alpha: 0.42, drag: 2, gravity: -0.3, turb: 1, shape: SHAPE.smoke, spin: 1 });
        this.e('add', { x, y, z, count: 8 * s, spread: 7, life: 0.3, size: 0.07, color: c.core, colorEnd: c.main, intensity: 4, gravity: 10, shape: SHAPE.spark, stretch: 4 });
        break;
      case 'venom':
        this.e('add', { x, y, z, count: 16 * s, spread: 6 * s, vx: dvx, vy: dvy + 3, vz: dvz, life: 0.8, lifeVar: 0.4, size: 0.25 * s, sizeEnd: 0.1, color: c.core, colorEnd: c.main, intensity: 2.5, gravity: 14, drag: 1, shape: SHAPE.blob, floorY: fy, bounce: 0.1 });
        this.e('add', { x, y, z, count: 8 * s, spread: 1.5, mode: 2, life: 1.0, lifeVar: 0.4, size: 0.18, sizeEnd: 0.32, color: c.main, colorEnd: c.dark, intensity: 2, gravity: -1.5, turb: 2, shape: SHAPE.bubble });
        this.e('blend', { x, y, z, count: 5 * s, spread: 1.2, life: 1.3, size: 0.8 * s, sizeEnd: 2 * s, color: 0x3a6a1a, colorEnd: 0x2a1a3a, alpha: 0.45, drag: 1.5, gravity: -0.4, turb: 1.5, shape: SHAPE.smoke, spin: 1 });
        break;
    }
  }

  /** Muzzle flash at the hand when casting. */
  castFlash(el: Element, slot: string, x: number, y: number, z: number, dx: number, dy: number, dz: number, charge = 0) {
    const c = C(el);
    const big = slot === 'primary' ? 0.45 : slot === 'heavy' ? 0.8 + charge * 0.6 : 1.2;
    this.e('add', { x, y, z, count: 1, life: 0.09, size: 1.2 * big, sizeEnd: 0.3, color: c.core, colorEnd: c.main, intensity: 4, shape: SHAPE.flare });
    this.burst(el, x + dx * 0.3, y + dy * 0.3, z + dz * 0.3, big * 0.45, [dx, dy, dz]);
    if (slot !== 'primary') {
      this.rings.ring(x, y - 1.3, z, 2.2 * big, c.main, { life: 0.35, intensity: 2.5 });
      this.decals.rune.addTransient({ x, y: y - 1.34, z, sx: 1.6 * big, sz: 1.6 * big, rot: Math.random() * 6, d: [0, 0, 1, Math.random() * 10], color: cc(c.main) }, 0.7);
    }
  }

  /** Continuous charge-up glow while heavy is held (called per frame). */
  charging(el: Element, x: number, y: number, z: number, charge: number, dt: number) {
    const c = C(el);
    tmpCol.set(c.main);
    this.cores.add(x, y, z, 0.35 + charge * 0.9, tmpCol, 2 + charge * 4, 0);
    if (Math.random() < dt * (20 + charge * 50)) {
      // particles spiral inward to the hand
      const a = rnd(0, Math.PI * 2),
        r = 1.2 + charge;
      const px = x + Math.cos(a) * r,
        pz = z + Math.sin(a) * r,
        py = y + rnd(-0.6, 0.6);
      this.e('add', { x: px, y: py, z: pz, count: 1, vx: (x - px) * 3, vy: (y - py) * 3, vz: (z - pz) * 3, life: 0.3, size: 0.08, color: c.core, colorEnd: c.main, intensity: 4, shape: el === 'storm' ? SHAPE.spark : el === 'frost' ? SHAPE.shard : SHAPE.ember, stretch: 4 });
    }
  }

  // ============================================================ projectiles
  spawnProjectile(id: number, el: Element, spell: string, x: number, y: number, z: number, vx: number, vy: number, vz: number, g: number, r: number, enemy: boolean, life: number) {
    const c = C(el);
    let trail: Trail | null = null,
      trail2: Trail | null = null;
    const tw: Record<string, number> = { ember: 0.32, shard: 0.16, arc: 0.22, gust: 0.9, pebble: 0.2, glob: 0.25, sunorb: 0.9, lance: 0.5, spear: 0.4, boulder: 0.8, flask: 0.3, orb: 0.4 };
    if (this.trails.length < this.q.trails) {
      trail = new Trail(c.core, c.main, (tw[spell] ?? 0.3) * (spell === 'sunorb' ? 0.6 + r : 1), spell === 'gust' ? 0.18 : spell === 'arc' ? 0.08 : 0.22, el === 'stone' ? 1.2 : 2.6, el === 'gale' ? 2 : 0);
      this.trails.push(trail);
      if (spell === 'sunorb' || spell === 'lance' || spell === 'spear' || enemy) {
        trail2 = new Trail(0xffffff, c.main, (tw[spell] ?? 0.3) * 0.35, 0.12, 4);
        this.trails.push(trail2);
      }
    }
    const pv: ProjVis = { id, el, spell, x, y, z, vx, vy, vz, g, r, enemy, trail, trail2, emitT: 0, age: 0, life: life + 0.3, sx: x, sy: y, sz: z };
    this.projs.set(id, pv);
    if (spell === 'sunorb' || spell === 'spear' || spell === 'lance' || spell === 'flask') {
      const tmp = new THREE.Vector3();
      this.lights.flash(x, y, z, c.main, spell === 'sunorb' ? 30 + r * 30 : 14, 9, 99, () => (this.projs.has(id) ? tmp.set(pv.x, pv.y, pv.z) : null));
    }
  }

  bounceProjectile(id: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const p = this.projs.get(id);
    if (!p) return;
    Object.assign(p, { x, y, z, vx, vy, vz });
    this.burst('gale', x, y, z, 0.6);
    this.rings.ring(x, y, z, 1.5, ELEMENT_INFO.gale.main, { life: 0.3, tilt: Math.PI / 2 });
  }

  endProjectile(id: number, x: number, y: number, z: number, hit: number) {
    const p = this.projs.get(id);
    if (!p) return;
    this.projs.delete(id);
    if (p.trail) p.trail.alive = false;
    if (p.trail2) p.trail2.alive = false;
    const big = p.spell === 'sunorb' || p.spell === 'boulder' || p.spell === 'flask' || p.spell === 'spear' ? 1.4 : p.spell === 'lance' ? 1 : 0.6;
    this.burst(p.el, x, y, z, big);
    if (hit === 2 && (p.spell === 'ember' || p.spell === 'pebble')) {
      const gy = this.ground(x, z, y + 0.5);
      if (Math.abs(gy - y) < 0.6) this.scorchMark(p.el, x, gy, z, 0.6);
    }
    if (p.enemy) this.rings.ring(x, y, z, 1.4, C(p.el).main, { life: 0.25 });
    if (p.spell === 'arc' && Math.hypot(x - p.sx, z - p.sz) > 1) this.bolt(p.sx, p.sy, p.sz, x, y, z, 'storm', 0.55, 0.12);
    if (p.spell === 'lance') this.ice.line(p.sx, p.sz, x, z, this.ground(x, z, y + 1), 10, 1.6, 2.2);
    if (p.spell === 'boulder') this.rock.burst(x, this.ground(x, z, y + 1), z, 1.6, 6, 0.9, 1.6);
  }

  private updateProjectiles(dt: number) {
    for (const p of this.projs.values()) {
      p.age += dt;
      p.vy -= p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.spell === 'boulder') {
        const gy = this.ground(p.x, p.z, p.y + 0.5);
        if (p.y - p.r < gy) {
          p.y = gy + p.r;
          if (p.vy < 0) p.vy = 0;
        }
      }
      if (p.age > p.life) {
        this.endProjectile(p.id, p.x, p.y, p.z, 0);
        continue;
      }
      const c = C(p.el);
      p.trail?.push(p.x, p.y, p.z, this.time);
      p.trail2?.push(p.x, p.y, p.z, this.time);
      // head
      tmpCol.set(p.enemy ? c.main : c.core);
      const headSize: Record<string, number> = { ember: 0.7, shard: 0.35, arc: 0.6, gust: 0.9, pebble: 0.35, glob: 0.55, sunorb: 1.6 + p.r * 2, lance: 0.9, spear: 0.9, boulder: 0.6, flask: 0.6, orb: 1.1 };
      if (p.spell !== 'pebble' && p.spell !== 'boulder') this.cores.add(p.x, p.y, p.z, headSize[p.spell] ?? 0.6, tmpCol, p.enemy ? 3 : p.spell === 'shard' ? 1.2 : 2.5, p.spell === 'arc' || p.spell === 'spear' ? 6 : 0);
      if (p.spell === 'sunorb') {
        tmpCol2.set(c.main);
        this.cores.add(p.x, p.y, p.z, 2.6 + p.r * 3, tmpCol2, 1.0, 0);
      }
      p.emitT -= dt;
      if (p.emitT <= 0) {
        p.emitT = 1 / 60;
        this.projTrailParticles(p);
      }
    }
  }

  private projTrailParticles(p: ProjVis) {
    const c = C(p.el);
    const { x, y, z } = p;
    const back = 0.15;
    const bvx = -p.vx * back,
      bvy = -p.vy * back,
      bvz = -p.vz * back;
    switch (p.el) {
      case 'fire':
        this.e('add', { x, y, z, count: p.spell === 'sunorb' ? 6 : 2, posSpread: p.spell === 'sunorb' ? 0.5 + p.r : 0.1, vx: bvx, vy: bvy + 1, vz: bvz, spread: 1.5, life: 0.35, lifeVar: 0.3, size: p.spell === 'sunorb' ? 0.9 : 0.35, sizeEnd: 0.05, color: c.core, colorEnd: c.dark, intensity: 4, intensityEnd: 1.2, gravity: -4, turb: 4, shape: SHAPE.flame, spin: 4 });
        if (Math.random() < 0.4) this.e('add', { x, y, z, count: 1, spread: 3, vy: 1, life: 0.6, size: 0.06, color: 0xffd08a, colorEnd: c.main, intensity: 5, gravity: -2, turb: 6, shape: SHAPE.ember });
        break;
      case 'frost':
        this.e('add', { x, y, z, count: 1, spread: 0.6, vx: bvx, vy: bvy, vz: bvz, life: 0.5, size: 0.12, sizeEnd: 0, color: 0xffffff, colorEnd: c.main, intensity: 3, gravity: 2, shape: SHAPE.flake, spin: 3 });
        if (p.spell === 'lance') this.e('add', { x, y, z, count: 3, spread: 2, posSpread: 0.3, life: 0.6, size: 0.25, sizeEnd: 0.0, color: c.core, colorEnd: c.main, intensity: 3, gravity: 6, shape: SHAPE.shard, stretch: 2 });
        break;
      case 'storm':
        this.e('add', { x, y, z, count: 2, spread: 7, life: 0.12, size: 0.05, color: 0xffffff, colorEnd: c.main, intensity: 6, shape: SHAPE.spark, stretch: 8 });
        if (Math.random() < 0.3) this.e('add', { x, y, z, count: 1, life: 0.06, size: 0.9, color: c.core, colorEnd: c.main, intensity: 3, shape: SHAPE.zap, spin: 30 });
        break;
      case 'gale':
        this.e('add', { x, y, z, count: 2, spread: 2, posSpread: 0.3, vx: bvx, vy: bvy, vz: bvz, life: 0.35, size: 0.5, sizeEnd: 0.9, color: c.core, colorEnd: c.main, intensity: 1.3, alpha: 0.6, turb: 8, shape: SHAPE.wisp, spin: 10 });
        break;
      case 'stone':
        if (p.spell === 'boulder') {
          const gy = this.ground(x, z, y + 0.5);
          this.e('blend', { x, y: gy + 0.1, z, count: 3, spread: 2, mode: 2, posSpread: p.r, life: 0.9, size: 0.5, sizeEnd: 1.4, color: 0x8a7258, colorEnd: 0x5a4a3a, alpha: 0.45, drag: 2, shape: SHAPE.smoke });
          this.e('blend', { x, y: gy + 0.1, z, count: 1, spread: 4, vy: 3, life: 0.6, size: 0.15, color: 0x9a7a5a, gravity: 18, shape: SHAPE.rock, spin: 6, floorY: gy, bounce: 0.3 });
        } else this.e('blend', { x, y, z, count: 1, spread: 0.3, life: 0.4, size: 0.18, sizeEnd: 0.5, color: 0x8a7258, alpha: 0.35, shape: SHAPE.smoke });
        break;
      case 'venom':
        this.e('add', { x, y, z, count: 1, spread: 0.5, vx: bvx * 0.3, vy: bvy * 0.3, vz: bvz * 0.3, life: 0.6, size: 0.15, sizeEnd: 0.05, color: c.core, colorEnd: c.main, intensity: 2.5, gravity: 10, shape: SHAPE.blob });
        if (Math.random() < 0.3) this.e('add', { x, y, z, count: 1, spread: 0.6, life: 0.7, size: 0.1, sizeEnd: 0.2, color: c.main, colorEnd: c.dark, intensity: 2, gravity: -1, shape: SHAPE.bubble });
        break;
    }
  }

  // ============================================================ big hits
  explosion(el: Element, x: number, y: number, z: number, r: number, big = false) {
    const c = C(el);
    const s = Math.max(0.6, r / 2.2);
    this.burst(el, x, y, z, s * 1.4);
    this.rings.ring(x, this.ground(x, z, y + 1), z, r * 1.25, c.main, { life: 0.45, intensity: 3.5, thick: 0.22 });
    if (big) {
      this.rings.dome(x, y, z, r * 1.1, c.main, { life: 0.5, intensity: 2.5 });
      this.juice.shake(0.55);
      this.juice.aberration(0.6);
      this.juice.hitstop(55);
    } else this.juice.shake(0.2 * s);
    this.distort?.burst(x, y + 0.5, z, r * 2.6, 1.2, 0.5);
    this.lights.flash(x, y + 1, z, c.main, big ? 90 : 35, r * 5, big ? 0.6 : 0.35);
    if (el === 'frost') this.ice.burst(x, this.ground(x, z, y + 1), z, r * 0.7, Math.round(6 + r * 2), 1.4, 1.8);
    if (el === 'stone') this.rock.burst(x, this.ground(x, z, y + 1), z, r * 0.6, Math.round(4 + r * 1.5), 1.2, 1.6);
    this.e('add', { x, y, z, count: 1, life: 0.2, size: r * 3.2, sizeEnd: r * 1.2, color: c.core, colorEnd: c.main, intensity: 3, shape: SHAPE.glow });
    if (el === 'fire') {
      this.e('add', { x, y, z, count: 40 * s, spread: 11 * s, mode: 2, life: 0.8, lifeVar: 0.4, size: 1.1 * s, sizeEnd: 0.2, color: c.core, colorEnd: c.dark, intensity: 5, intensityEnd: 1.2, gravity: -5, drag: 3, turb: 5, shape: SHAPE.flame, spin: 4 });
      this.e('blend', { x, y: y + r * 0.3, z, count: 14 * s, spread: 3, mode: 2, posSpread: r * 0.5, life: 2.2, lifeVar: 0.3, size: 1.2 * s, sizeEnd: 3.5 * s, color: 0x2a1c16, colorEnd: 0x120e0c, alpha: 0.6, gravity: -1.6, drag: 1.2, turb: 2, shape: SHAPE.smoke, spin: 0.6 });
      this.scorchMark('fire', x, this.ground(x, z, y + 1), z, r * 0.9);
    }
    if (el === 'venom') this.e('add', { x, y, z, count: 26 * s, spread: 9 * s, life: 0.9, size: 0.3, sizeEnd: 0.1, color: c.core, colorEnd: c.dark, intensity: 3, gravity: 12, shape: SHAPE.blob, floorY: this.ground(x, z, y + 1) });
    if (el === 'stone') this.e('blend', { x, y, z, count: 26 * s, spread: 10 * s, vy: 5, life: 1.3, size: 0.3, sizeVar: 0.6, color: 0xa08060, colorEnd: 0x6a5240, gravity: 24, shape: SHAPE.rock, spin: 10, floorY: this.ground(x, z, y + 1) + 0.08, bounce: 0.4 });
    if (el === 'frost') this.e('add', { x, y, z, count: 30 * s, spread: 13 * s, life: 0.8, size: 0.45, sizeEnd: 0.05, color: c.core, colorEnd: c.main, intensity: 4, gravity: 10, shape: SHAPE.shard, stretch: 3, floorY: this.ground(x, z, y + 1) });
  }

  scorchMark(el: Element, x: number, y: number, z: number, r: number) {
    const layer = el === 'frost' ? this.decals.frost : el === 'venom' ? this.decals.ooze : this.decals.scorch;
    layer.addTransient({ x, y, z, sx: r, sz: r, rot: Math.random() * 6, d: [0, 0, 1, Math.random() * 100], color: cc(C(el).main) }, el === 'fire' ? 7 : 4);
  }

  nova(el: Element, x: number, y: number, z: number, r: number) {
    const c = C(el);
    const gy = this.ground(x, z, y + 1);
    this.rings.ring(x, gy, z, r, c.main, { life: 0.55, intensity: 4, thick: 0.3 });
    this.rings.ring(x, gy, z, r * 0.7, c.core, { life: 0.4, intensity: 3, thick: 0.15 });
    this.distort?.burst(x, gy + 1, z, r * 2.5, 1.0, 0.55);
    this.decals.rune.addTransient({ x, y: gy, z, sx: r * 0.8, sz: r * 0.8, rot: 0, d: [0, 0, 1.5, Math.random() * 10], color: cc(c.main) }, 1.0);
    this.juice.shake(0.35);
    this.lights.flash(x, gy + 2.5, z, c.main, el === 'frost' ? 18 : 60, r * 3, 0.5);
    if (el === 'frost') this.ice.burst(x, gy, z, r * 0.85, 34, 2.4, 3);
    switch (el) {
      case 'fire':
        this.e('add', { x, y: gy + 0.4, z, count: 160, spread: r * 2.4, mode: 1, life: 0.55, lifeVar: 0.25, size: 1.2, sizeEnd: 0.3, color: c.core, colorEnd: c.dark, intensity: 5, drag: 2.5, gravity: -6, turb: 3, shape: SHAPE.flame, spin: 4 });
        this.e('add', { x, y: gy + 0.3, z, count: 60, spread: r * 2.8, mode: 1, life: 0.7, size: 0.1, color: 0xffe0a0, colorEnd: c.main, intensity: 6, drag: 2, gravity: 3, shape: SHAPE.spark, stretch: 6 });
        this.scorchMark('fire', x, gy, z, r * 0.7);
        break;
      case 'frost':
        this.e('add', { x, y: gy + 0.3, z, count: 120, spread: 2, posSpread: r, mode: 3, life: 1.2, lifeVar: 0.4, size: 0.45, sizeEnd: 0.0, color: c.core, colorEnd: c.main, intensity: 2.2, gravity: -2, turb: 1.5, shape: SHAPE.shard, spin: 2 });
        this.e('add', { x, y: gy + 4, z, count: 110, spread: 1.5, posSpread: r, mode: 3, vy: -3, life: 1.6, size: 0.16, color: 0xffffff, colorEnd: c.main, intensity: 1.8, gravity: 2, turb: 2, shape: SHAPE.flake, spin: 2, floorY: gy });
        this.e('add', { x, y: gy + 1, z, count: 1, life: 0.22, size: r * 2.6, sizeEnd: r, color: c.core, colorEnd: c.main, intensity: 1.3, shape: SHAPE.glow });
        this.juice.flash(0x9fe8ff, 0.15);
        break;
      case 'gale':
        this.e('add', { x, y: gy + 0.5, z, count: 80, spread: r * 2.6, mode: 1, life: 0.55, size: 1.6, sizeEnd: 2.4, color: c.core, colorEnd: c.main, intensity: 1.5, alpha: 0.6, drag: 3, turb: 6, shape: SHAPE.wisp, spin: 8 });
        this.e('add', { x, y: gy, z, count: 40, spread: 12, mode: 2, life: 0.6, size: 0.08, color: 0xffffff, colorEnd: c.main, intensity: 3, drag: 2, shape: SHAPE.spark, stretch: 8 });
        this.rings.ring(x, gy + 1.2, z, r * 0.6, c.main, { life: 0.4, intensity: 2.5, thick: 0.1 });
        break;
      case 'venom':
        this.e('blend', { x, y: gy + 0.4, z, count: 60, spread: r * 1.2, mode: 1, life: 1.6, size: 1.5, sizeEnd: 3.5, color: 0x5aa02a, colorEnd: 0x3a1a4a, alpha: 0.5, drag: 2, turb: 2, gravity: -0.3, shape: SHAPE.smoke, spin: 1 });
        this.e('add', { x, y: gy + 0.4, z, count: 40, spread: r * 1.5, mode: 1, life: 1, size: 0.25, color: c.core, colorEnd: c.main, intensity: 2.5, drag: 2, shape: SHAPE.bubble });
        break;
      default:
        this.burst(el, x, gy + 0.5, z, 2);
    }
  }

  /** Sky lightning strike: a branching bolt from the clouds + ground burst. */
  strike(x: number, y: number, z: number, r: number) {
    const c = C('storm');
    this.bolt(x + rnd(-2, 2), y + 26, z + rnd(-2, 2), x, y, z, 'storm', 2.4, 0.32);
    this.bolt(x + rnd(-3, 3), y + 20, z + rnd(-3, 3), x, y, z, 'storm', 1.2, 0.22);
    this.explosion('storm', x, y + 0.3, z, r, false);
    this.e('add', { x, y: y + 0.2, z, count: 1, life: 0.15, size: r * 5, sizeEnd: r * 2, color: 0xffffff, colorEnd: c.main, intensity: 3, shape: SHAPE.glow });
    this.decals.electric.addTransient({ x, y, z, sx: r * 1.3, sz: r * 1.3, rot: Math.random() * 6, d: [0, 0, 1.4, Math.random() * 10], color: cc(c.main) }, 0.6);
    this.scorchMark('storm', x, y, z, r * 0.7);
    this.juice.flash(0xd8c8ff, 0.18);
    this.juice.shake(0.4);
    this.lights.flash(x, y + 3, z, 0xd8c8ff, 140, 22, 0.3);
  }

  /** Branching lightning between two points. */
  bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, el: Element = 'storm', width = 1, life = 0.25) {
    const seed = (Math.random() * 1e6) | 0;
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    this.bolts.push({
      a: [ax, ay, az],
      b: [bx, by, bz],
      t: 0,
      life,
      bolt: generateLightning(ax, ay, az, bx, by, bz, seed, { depth: len > 12 ? 6 : 5, branchChance: len > 8 ? 0.25 : 0.12 }),
      regen: 0.05,
      color: C(el).main,
      width,
      seed,
    });
    this.e('add', { x: bx, y: by, z: bz, count: 10, spread: 9, life: 0.2, size: 0.06, color: 0xffffff, colorEnd: C(el).main, intensity: 6, drag: 3, shape: SHAPE.spark, stretch: 8 });
  }

  hit(el: Element, x: number, y: number, z: number, amt: number, crit: boolean) {
    const s = Math.min(1.2, 0.35 + amt / 60) * (crit ? 1.4 : 1);
    this.burst(el, x, y, z, s);
    if (crit) {
      this.e('add', { x, y, z, count: 1, life: 0.15, size: 2.2, sizeEnd: 0.6, color: 0xffffff, colorEnd: C(el).main, intensity: 3, shape: SHAPE.flare });
    }
  }

  death(el: Element | null, x: number, y: number, z: number, accent: number, size: number) {
    const e2 = el ?? 'fire';
    this.burst(e2, x, y + size * 0.5, z, 1.3);
    this.e('add', { x, y: y + size * 0.5, z, count: 40, spread: 4, posSpread: size * 0.5, mode: 2, life: 1.1, lifeVar: 0.4, size: 0.18, sizeEnd: 0, color: accent, colorEnd: accent, intensity: 3, gravity: -2, turb: 3, shape: SHAPE.ember });
    this.e('blend', { x, y: y + size * 0.4, z, count: 10, spread: 1.5, posSpread: size * 0.4, life: 1.6, size: 1, sizeEnd: 2.4, color: 0x2a2030, colorEnd: 0x101014, alpha: 0.5, gravity: -0.8, turb: 1.5, shape: SHAPE.smoke, spin: 1 });
    this.rings.ring(x, this.ground(x, z, y + 1), z, size * 1.8, accent, { life: 0.4, intensity: 2 });
  }

  spawnPortal(x: number, y: number, z: number, accent: number) {
    this.decals.rune.addTransient({ x, y, z, sx: 1.6, sz: 1.6, rot: 0, d: [0, 0, 1.6, Math.random() * 10], color: cc(accent) }, 1.2);
    this.e('add', { x, y, z, count: 40, spread: 1, posSpread: 1.2, mode: 3, vy: 3, life: 0.9, size: 0.12, color: accent, colorEnd: 0x4a2a8a, intensity: 3.5, turb: 2, shape: SHAPE.ember });
    this.rings.ring(x, y, z, 2.2, accent, { life: 0.6, intensity: 2.5, r0: 2.2 * 0.9 });
  }

  dashTrail(x: number, y: number, z: number, color: number, blink: boolean) {
    this.e('add', { x, y: y + 0.9, z, count: blink ? 40 : 14, spread: blink ? 4 : 2, posSpread: 0.5, posSpreadY: 1.6, life: 0.45, size: 0.25, sizeEnd: 0.0, color, colorEnd: 0x6a4aff, intensity: 3, drag: 3, turb: 3, shape: blink ? SHAPE.flare : SHAPE.glow });
    if (blink) this.rings.ring(x, y + 0.05, z, 1.6, color, { life: 0.3 });
  }

  jumpPuff(x: number, y: number, z: number, n: number, color: number) {
    this.rings.ring(x, y + 0.05, z, n === 2 ? 1.6 : 1.1, n === 2 ? color : 0xbbbbcc, { life: 0.3, intensity: n === 2 ? 2.5 : 0.8 });
    if (n === 2) this.e('add', { x, y, z, count: 16, spread: 4, mode: 1, life: 0.35, size: 0.12, color, colorEnd: 0x6a4aff, intensity: 3, drag: 4, shape: SHAPE.glow });
    else this.e('blend', { x, y: y + 0.1, z, count: 6, spread: 2, mode: 1, life: 0.5, size: 0.3, sizeEnd: 0.8, color: 0x8a8090, alpha: 0.35, drag: 3, shape: SHAPE.smoke });
  }

  rocketBlast(x: number, y: number, z: number) {
    this.explosion('fire', x, y, z, 2.4, false);
    this.e('add', { x, y, z, count: 30, spread: 3, vy: -8, life: 0.5, size: 0.6, sizeEnd: 0.1, color: 0xffe08a, colorEnd: 0xb81e00, intensity: 4, turb: 3, shape: SHAPE.flame });
  }

  hover(x: number, y: number, z: number, color: number) {
    if (Math.random() < 0.5) this.e('add', { x, y: y + 0.05, z, count: 1, spread: 0.6, posSpread: 0.35, mode: 3, vy: -2.5, life: 0.35, size: 0.18, sizeEnd: 0.4, color, colorEnd: 0x3a2a8a, intensity: 2.2, shape: SHAPE.ring, alpha: 0.7 });
  }

  heal(x: number, y: number, z: number) {
    this.e('add', { x, y: y + 0.6, z, count: 18, spread: 1, posSpread: 0.6, mode: 2, vy: 2, life: 0.9, size: 0.22, color: 0x7dff8a, colorEnd: 0x2aff9a, intensity: 3, shape: SHAPE.plus });
  }

  revive(x: number, y: number, z: number, color: number) {
    this.rings.dome(x, y + 0.5, z, 3, color, { life: 0.6, intensity: 2.5 });
    this.e('add', { x, y: y + 0.4, z, count: 60, spread: 2, posSpread: 1.2, mode: 3, vy: 6, life: 1.1, size: 0.15, color: 0xffffff, colorEnd: color, intensity: 4, drag: 1, turb: 2, shape: SHAPE.ember });
    this.juice.flash(0xffffff, 0.12);
  }

  downed(x: number, y: number, z: number) {
    this.rings.ring(x, y + 0.05, z, 2.5, 0xff2a3a, { life: 0.6, intensity: 3 });
    this.e('add', { x, y: y + 0.5, z, count: 30, spread: 3, life: 0.6, size: 0.2, color: 0xff3a4a, colorEnd: 0x5a0010, intensity: 3, gravity: 6, shape: SHAPE.glow });
  }

  ping(x: number, y: number, z: number, color: number) {
    this.rings.ring(x, y + 0.05, z, 2.4, color, { life: 0.8, intensity: 3, r0: 0.2 });
    this.rings.ring(x, y + 0.05, z, 1.4, color, { life: 0.6, intensity: 3, r0: 0.2 });
    this.e('add', { x, y: y + 0.2, z, count: 24, spread: 0.5, vy: 6, life: 0.8, size: 0.16, color, colorEnd: color, intensity: 4, drag: 2, shape: SHAPE.flare });
  }

  pickup(x: number, y: number, z: number, color: number) {
    this.rings.dome(x, y + 0.5, z, 1.8, color, { life: 0.4 });
    this.e('add', { x, y: y + 0.5, z, count: 40, spread: 5, life: 0.6, size: 0.12, color: 0xffffff, colorEnd: color, intensity: 4, drag: 3, shape: SHAPE.flare });
  }

  // ============================================================ combos
  /** Unique, screen-shaking set-piece per combo. */
  combo(key: string, x: number, y: number, z: number, r: number) {
    const gy = this.ground(x, z, y + 1);
    this.lights.flash(x, gy + 2, z, key.includes('storm') || key === 'chain_electrocution' || key === 'conduction' || key === 'thunderhead' ? 0xc8b0ff : key.includes('steam') || key === 'shatter' || key === 'blizzard' || key === 'flash_freeze' ? 0xbff4ff : key === 'toxic_tempest' ? 0x9cff3a : 0xffa040, 160, r * 5, 0.8);
    this.juice.hitstop(90);
    this.juice.aberration(1);
    this.juice.shake(0.8);
    switch (key) {
      case 'detonation': {
        const c = C('fire');
        this.juice.flash(0xffa040, 0.45);
        this.explosion('fire', x, y, z, r, true);
        this.explosion('venom', x, y + 0.6, z, r * 0.7, false);
        this.e('add', { x, y: gy + 0.5, z, count: 220, spread: r * 4, mode: 1, life: 0.6, size: 1.6, sizeEnd: 0.3, color: c.core, colorEnd: 0x7a2bd6, intensity: 5, drag: 3, gravity: -3, turb: 4, shape: SHAPE.flame, spin: 4 });
        this.e('add', { x, y, z, count: 80, spread: r * 3, mode: 2, life: 1.2, size: 0.12, color: 0xffe080, colorEnd: 0x9cff3a, intensity: 6, gravity: 8, shape: SHAPE.spark, stretch: 6, floorY: gy, bounce: 0.3 });
        this.e('blend', { x, y: y + 1, z, count: 30, spread: 4, mode: 2, posSpread: r * 0.6, life: 3, size: 2.5, sizeEnd: 6, color: 0x2a1c16, colorEnd: 0x0e0a0a, alpha: 0.6, gravity: -2, drag: 1, turb: 2, shape: SHAPE.smoke, spin: 0.5 });
        this.rings.ring(x, gy, z, r * 2.2, c.main, { life: 0.8, intensity: 4, thick: 0.3 });
        this.rings.dome(x, y, z, r * 1.6, 0xffa040, { life: 0.7, intensity: 3 });
        this.distort?.burst(x, y + 1, z, r * 5, 1.5, 0.8);
        break;
      }
      case 'firestorm':
      case 'toxic_tempest':
      case 'blizzard':
      case 'thunderhead': {
        const el: Element = key === 'firestorm' ? 'fire' : key === 'toxic_tempest' ? 'venom' : key === 'blizzard' ? 'frost' : 'storm';
        const c = C(el);
        this.juice.flash(c.main, 0.3);
        for (let i = 0; i < 3; i++) this.rings.ring(x, gy + 0.3 + i * 1.5, z, r * (1.2 + i * 0.3), c.main, { life: 0.6 + i * 0.1, intensity: 3, thick: 0.12 });
        this.e('add', { x, y: gy + 0.5, z, count: 160, spread: r * 2.5, mode: 1, vy: 6, life: 0.9, size: 0.8, sizeEnd: 0.2, color: c.core, colorEnd: c.main, intensity: 4, drag: 2, turb: 6, shape: el === 'fire' ? SHAPE.flame : el === 'frost' ? SHAPE.shard : el === 'storm' ? SHAPE.spark : SHAPE.bubble, stretch: el === 'storm' ? 6 : 0, spin: 5 });
        this.e('add', { x, y: gy + 0.5, z, count: 60, spread: 6, mode: 1, vy: 10, life: 0.8, size: 1.4, sizeEnd: 2.4, color: ELEMENT_INFO.gale.core, colorEnd: c.main, intensity: 1.6, alpha: 0.6, turb: 8, shape: SHAPE.wisp, spin: 9 });
        if (el === 'storm') for (let i = 0; i < 4; i++) this.bolt(x + rnd(-r, r), gy + 12, z + rnd(-r, r), x + rnd(-r, r), gy, z + rnd(-r, r), 'storm', 1.5, 0.3);
        break;
      }
      case 'chain_electrocution':
      case 'conduction': {
        const c = C('storm');
        this.juice.flash(0xc8b0ff, 0.35);
        this.rings.ring(x, gy, z, r * 1.5, c.main, { life: 0.5, intensity: 4 });
        this.e('add', { x, y: gy + 0.2, z, count: 120, spread: 14, mode: 1, life: 0.3, size: 0.08, color: 0xffffff, colorEnd: c.main, intensity: 8, drag: 3, shape: SHAPE.spark, stretch: 10 });
        this.e('add', { x, y: gy + 0.3, z, count: 30, posSpread: r, mode: 3, life: 0.2, lifeVar: 0.5, size: 1.4, color: c.core, colorEnd: c.main, intensity: 4, shape: SHAPE.zap, spin: 30 });
        this.bolt(x, gy + 14, z, x, gy, z, 'storm', 2, 0.35);
        break;
      }
      case 'steam':
      case 'steam_status': {
        this.juice.flash(0xffffff, 0.22);
        this.e('blend', { x, y: gy + 0.5, z, count: 60, spread: 5, mode: 2, posSpread: r * 0.7, life: 2.4, lifeVar: 0.3, size: 2, sizeEnd: 5, color: 0xeef6ff, colorEnd: 0xb0c0d0, alpha: 0.55, drag: 2, gravity: -1.2, turb: 2, shape: SHAPE.smoke, spin: 0.6 });
        this.e('add', { x, y: gy + 0.5, z, count: 60, spread: 9, mode: 2, life: 0.5, size: 0.3, color: 0xffffff, colorEnd: 0x9fe8ff, intensity: 2.5, drag: 3, shape: SHAPE.glow });
        this.rings.ring(x, gy, z, r * 1.4, 0xffffff, { life: 0.5, intensity: 2.5 });
        this.distort?.burst(x, gy + 1.2, z, r * 3, 1.2, 0.9);
        break;
      }
      case 'shatter': {
        const c = C('frost');
        this.juice.flash(0xbff4ff, 0.3);
        this.e('add', { x, y, z, count: 90, spread: 18, life: 0.9, size: 0.55, sizeEnd: 0.05, color: 0xffffff, colorEnd: c.main, intensity: 5, gravity: 14, drag: 1, shape: SHAPE.shard, stretch: 3, floorY: gy, bounce: 0.35 });
        this.e('add', { x, y, z, count: 40, spread: 12, life: 0.5, size: 0.2, color: 0xffffff, colorEnd: c.dark, intensity: 5, shape: SHAPE.chip, spin: 20, gravity: 10, floorY: gy });
        this.e('add', { x, y, z, count: 1, life: 0.2, size: 7, sizeEnd: 2, color: 0xffffff, colorEnd: c.main, intensity: 3, shape: SHAPE.flare });
        this.rings.ring(x, gy, z, r * 1.3, c.main, { life: 0.4, intensity: 4 });
        this.rings.ring(x, y, z, r, 0xffffff, { life: 0.3, intensity: 3, tilt: Math.PI / 2 });
        this.scorchMark('frost', x, gy, z, r * 0.8);
        this.ice.burst(x, gy, z, r * 0.6, 18, 1.8, 1.6);
        break;
      }
      case 'flash_freeze': {
        const c = C('frost');
        this.juice.flash(0xbff4ff, 0.3);
        this.e('add', { x, y: gy + 0.2, z, count: 120, spread: 1, posSpread: r, mode: 3, vy: 3, life: 1, size: 0.35, sizeEnd: 0, color: 0xffffff, colorEnd: c.main, intensity: 4, gravity: 3, shape: SHAPE.shard, spin: 3 });
        this.ice.burst(x, gy, z, r * 0.9, 26, 1.6, 3.5);
        this.rings.ring(x, gy, z, r * 1.3, c.main, { life: 0.5, intensity: 4 });
        break;
      }
      case 'magma_wall': {
        const c = C('fire');
        this.juice.flash(0xff7a2a, 0.3);
        this.e('add', { x, y: gy + 1, z, count: 120, spread: 8, mode: 2, posSpread: 3, life: 1, size: 0.6, sizeEnd: 0.1, color: c.core, colorEnd: c.dark, intensity: 5, gravity: 9, shape: SHAPE.blob, floorY: gy, bounce: 0.2 });
        this.rings.ring(x, gy, z, 6, c.main, { life: 0.5, intensity: 3 });
        break;
      }
      default:
        this.explosion('fire', x, y, z, r, true);
    }
  }

  // ============================================================ zones (called every frame per zone)
  zone(z: Zone, dt: number) {
    if (!this.seenZones.has(z.id)) {
      this.seenZones.add(z.id);
      if (this.seenZones.size > 600) this.seenZones = new Set([...this.seenZones].slice(-300));
      const gy = z.pos.y;
      if (z.tag === 'frostpatch') this.ice.burst(z.pos.x, gy, z.pos.z, z.radius * 0.8, Math.round(4 + z.radius * 3), 1.1, Math.min(4, z.life));
      if (z.tag === 'wall') {
        const dx = Math.cos(z.angle) * z.len,
          dz = Math.sin(z.angle) * z.len;
        this.rock.line(z.pos.x - dx, z.pos.z - dz, z.pos.x + dx, z.pos.z + dz, gy, 12, 1.6, 1.4);
      }
    }
    if ((z.tag === 'firestorm' || z.tag === 'burning' || z.tag === 'magmawall' || z.tag === 'stormcell' || z.tag === 'electrified') && Math.random() < dt * (z.tag === 'burning' ? 3 : 8)) {
      const col = z.tag === 'stormcell' || z.tag === 'electrified' ? 0xb48cff : 0xff7a2a;
      this.lights.flash(z.pos.x, z.pos.y + 1.2, z.pos.z, col, z.tag === 'burning' ? 12 : 30, z.radius * 3, 0.25);
    }
    const k = Math.min(1, dt * 60) * this.density;
    const el = z.element;
    const c = C(el);
    const { x, y } = z.pos;
    const zz = z.pos.z;
    const r = z.radius;
    const lifeK = Math.max(0, Math.min(1, z.life / Math.max(0.01, z.maxLife)));
    const age01 = 1 - lifeK;
    const col = cc(c.main);
    const chance = (n: number) => Math.random() < n * k;
    switch (z.tag) {
      case 'burning':
        this.decals.scorch.set({ x, y, z: zz, sx: r, sz: r, rot: z.id, d: [age01 * 0.6, 0, 1, z.id], color: col });
        if (chance(0.9)) this.e('add', { x, y: y + 0.1, z: zz, count: 2, posSpread: r * 0.85, mode: 3, vy: 1.5, spread: 0.8, life: 0.6, lifeVar: 0.4, size: 0.55, sizeEnd: 0.1, color: c.core, colorEnd: c.dark, intensity: 3.5, intensityEnd: 1, gravity: -4, turb: 4, shape: SHAPE.flame, spin: 3 });
        if (chance(0.25)) this.e('add', { x, y: y + 0.2, z: zz, count: 1, posSpread: r * 0.8, mode: 3, vy: 2, spread: 1, life: 1.4, size: 0.05, color: 0xffd08a, colorEnd: c.main, intensity: 6, gravity: -1.5, turb: 6, shape: SHAPE.ember });
        this.distort?.set(x, y + 1, zz, r * 2.2, 0.6);
        break;
      case 'frostpatch':
        this.decals.frost.set({ x, y, z: zz, sx: r, sz: r, rot: z.id, d: [age01, Math.min(1, (z.maxLife - z.life) * 3), 1, z.id], color: col });
        if (chance(0.3)) this.e('add', { x, y: y + 0.2, z: zz, count: 1, posSpread: r * 0.8, mode: 3, vy: 0.4, life: 1.2, size: 0.12, color: 0xffffff, colorEnd: c.main, intensity: 3, shape: SHAPE.flare, spin: 1 });
        if (chance(0.25)) this.e('add', { x, y: y + 2, z: zz, count: 1, posSpread: r * 0.8, mode: 3, vy: -1, life: 1.4, size: 0.1, color: 0xffffff, colorEnd: c.main, intensity: 2.5, gravity: 0.5, turb: 1, shape: SHAPE.flake, spin: 2, floorY: y });
        break;
      case 'puddle':
        this.decals.water.set({ x, y, z: zz, sx: r, sz: r, rot: z.id, d: [age01, 0, 1, z.id], color: cc(0x6fb8ff) });
        break;
      case 'venompool':
        this.decals.ooze.set({ x, y, z: zz, sx: r, sz: r, rot: z.id, d: [age01, 0, 1, z.id], color: col });
        if (chance(0.15)) this.e('add', { x, y: y + 0.05, z: zz, count: 1, posSpread: r * 0.7, mode: 3, vy: 0.6, life: 0.8, size: 0.14, sizeEnd: 0.28, color: c.main, colorEnd: c.dark, intensity: 2, shape: SHAPE.bubble });
        break;
      case 'venomcloud':
        this.decals.ooze.set({ x, y, z: zz, sx: r * 0.8, sz: r * 0.8, rot: z.id, d: [age01, 0, 0.7, z.id], color: col });
        if (chance(0.7)) this.e('blend', { x, y: y + 0.6, z: zz, count: 1, posSpread: r * 0.85, posSpreadY: 0.35, spread: 0.4, life: 2.2, lifeVar: 0.3, size: 1.6, sizeEnd: 3.2, color: 0x6ad02a, colorEnd: 0x4a1a6a, alpha: 0.42, turb: 1.2, drag: 1, shape: SHAPE.smoke, spin: 0.6 });
        if (chance(0.35)) this.e('add', { x, y: y + 0.5, z: zz, count: 1, posSpread: r * 0.8, posSpreadY: 0.5, life: 1.5, size: 0.12, sizeEnd: 0.25, color: c.core, colorEnd: c.main, intensity: 2.5, turb: 2, gravity: -0.3, shape: SHAPE.bubble });
        break;
      case 'steam':
        if (chance(0.8)) this.e('blend', { x, y: y + 0.6, z: zz, count: 1, posSpread: r * 0.85, posSpreadY: 0.5, spread: 0.6, life: 2.2, lifeVar: 0.3, size: 1.8, sizeEnd: 4, color: 0xf0f6ff, colorEnd: 0xb8c4d4, alpha: 0.38 * Math.min(1, lifeK * 3), gravity: -0.8, turb: 1.4, drag: 1, shape: SHAPE.smoke, spin: 0.5 });
        break;
      case 'electrified':
        this.decals.electric.set({ x, y, z: zz, sx: r, sz: r, rot: z.id, d: [age01, 0, 1.2, z.id], color: col });
        if (chance(0.6)) this.e('add', { x, y: y + 0.1, z: zz, count: 2, posSpread: r * 0.9, mode: 3, spread: 6, life: 0.15, size: 0.06, color: 0xffffff, colorEnd: c.main, intensity: 7, shape: SHAPE.spark, stretch: 8 });
        if (chance(0.06)) {
          const a = Math.random() * 6.28,
            q = Math.random() * r;
          this.bolt(x, y + 0.2, zz, x + Math.cos(a) * q, y + 0.1, zz + Math.sin(a) * q, 'storm', 0.5, 0.12);
        }
        break;
      case 'vortex':
      case 'firestorm':
      case 'toxicstorm':
      case 'blizzard':
      case 'stormcell':
        this.vortexFrame(z, k);
        break;
      case 'wall':
      case 'magmawall':
        if (z.tag === 'magmawall' && chance(0.6)) {
          const t = Math.random() * 2 - 1;
          this.e('add', { x: x + Math.cos(z.angle) * z.len * t, y: y + Math.random() * 2.4, z: zz + Math.sin(z.angle) * z.len * t, count: 1, spread: 0.6, vy: 1.2, life: 0.8, size: 0.4, sizeEnd: 0.1, color: 0xffd08a, colorEnd: 0xb81e00, intensity: 4, gravity: -2, turb: 3, shape: SHAPE.flame });
        }
        break;
    }
  }

  private vortexFrame(z: Zone, k: number) {
    const gale = ELEMENT_INFO.gale;
    const tag = z.tag;
    const el: Element = tag === 'vortex' ? 'gale' : z.element;
    const c = C(el);
    const { x, y } = z.pos;
    const zz = z.pos.z;
    const r = z.radius;
    const H = tag === 'vortex' ? 4 : 7;
    const chance = (n: number) => Math.random() < n * k;
    // swirling ribbons: spiral wisps orbiting upward. Velocity tangential = swirl.
    const arms = tag === 'vortex' ? 3 : 5;
    for (let i = 0; i < arms; i++) {
      if (!chance(0.9)) continue;
      const h = Math.random();
      const a = this.time * 5 + i * ((Math.PI * 2) / arms) + h * 4;
      const rr = r * (0.25 + 0.75 * h);
      const px = x + Math.cos(a) * rr,
        pz = zz + Math.sin(a) * rr,
        py = y + h * H;
      const sw = 9 + r * 2;
      const tvx = -Math.sin(a) * sw,
        tvz = Math.cos(a) * sw;
      const shape = tag === 'firestorm' ? SHAPE.flame : tag === 'blizzard' ? SHAPE.flake : tag === 'toxicstorm' ? SHAPE.bubble : tag === 'stormcell' ? SHAPE.spark : SHAPE.wisp;
      this.e('add', {
        x: px,
        y: py,
        z: pz,
        count: tag === 'vortex' ? 1 : 2,
        vx: tvx,
        vy: 3,
        vz: tvz,
        life: 0.35,
        size: tag === 'vortex' ? 0.9 : tag === 'firestorm' ? 0.9 : 0.35,
        sizeEnd: tag === 'vortex' ? 1.2 : 0.15,
        color: tag === 'vortex' ? gale.core : c.core,
        colorEnd: tag === 'vortex' ? gale.main : c.main,
        intensity: tag === 'vortex' ? 1.3 : 3.5,
        alpha: tag === 'vortex' ? 0.6 : 1,
        drag: 1,
        shape,
        stretch: tag === 'stormcell' ? 6 : 0,
        spin: 6,
      });
    }
    // base dust ring
    if (chance(0.5)) this.e('blend', { x, y: y + 0.2, z: zz, count: 1, spread: 4, mode: 1, posSpread: r * 0.9, life: 0.7, size: 0.8, sizeEnd: 1.8, color: tag === 'toxicstorm' ? 0x5a9a2a : tag === 'blizzard' ? 0xd8eeff : tag === 'firestorm' ? 0x3a2418 : 0x9aa8a0, alpha: 0.35, drag: 2, turb: 4, shape: SHAPE.smoke, spin: 2 });
    if (tag === 'toxicstorm' && chance(0.6)) this.e('blend', { x, y: y + 1, z: zz, count: 1, posSpread: r, posSpreadY: 0.6, spread: 2, life: 2, size: 2, sizeEnd: 4, color: 0x6ad02a, colorEnd: 0x3a1a5a, alpha: 0.35, turb: 3, shape: SHAPE.smoke, spin: 1 });
    if (tag === 'firestorm') this.distort?.set(x, y + 2, zz, r * 2.5, 0.8);
    if (tag === 'stormcell' && chance(0.08)) this.bolt(x, y + H, zz, x + rnd(-r, r), y, zz + rnd(-r, r), 'storm', 0.8, 0.15);
    // core column glow
    tmpCol.set(tag === 'vortex' ? gale.main : c.main);
    for (let i = 0; i < 3; i++) this.cores.add(x, y + 0.6 + i * (H / 3), zz, r * 0.9, tmpCol, tag === 'vortex' ? 0.12 : 0.35, 0);
    // swirl ribbons via strips
    const pts: number[] = [];
    for (let s = 0; s < 3; s++) {
      pts.length = 0;
      for (let i = 0; i < 14; i++) {
        const h = i / 13;
        const a = this.time * 6 + s * 2.1 + h * 7;
        const rr = r * (0.3 + 0.7 * h);
        pts.push(x + Math.cos(a) * rr, y + 0.2 + h * H, zz + Math.sin(a) * rr);
      }
      tmpCol2.set(tag === 'vortex' ? gale.core : c.core);
      const inten = tag === 'vortex' ? 0.7 : 1.6;
      this.strips.add(pts, 14, (t) => 0.25 + t * 0.4, (t, o) => {
        o[0] = tmpCol2.r * inten;
        o[1] = tmpCol2.g * inten;
        o[2] = tmpCol2.b * inten;
        o[3] = Math.sin(t * Math.PI) * 0.7;
      }, 2);
    }
  }

  telegraph(t: Telegraph) {
    const prog = Math.min(1, t.t / t.dur);
    const col = cc(C(t.element).main);
    switch (t.shape) {
      case 'circle':
        this.decals.teleR.set({ x: t.x, y: t.y, z: t.z, sx: t.r, sz: t.r, rot: 0, d: [prog, 0, 0, t.id], color: col });
        break;
      case 'ring':
        this.decals.teleR.set({ x: t.x, y: t.y, z: t.z, sx: t.r, sz: t.r, rot: 0, d: [prog, t.r2 / t.r, 0, t.id], color: col });
        break;
      case 'cone':
        this.decals.teleR.set({ x: t.x, y: t.y, z: t.z, sx: t.r, sz: t.r, rot: t.angle + Math.PI, d: [prog, 0, t.width, t.id], color: col });
        break;
      case 'line':
        this.decals.teleL.set({ x: t.x, y: t.y, z: t.z, sx: t.width / 2, sz: t.len / 2, rot: t.angle, d: [prog, 0, 1, t.id], color: col });
        break;
    }
  }

  /** Telegraph resolves: impact flash along the shape. */
  teleImpact(shape: string, x: number, y: number, z: number, el: Element) {
    const c = C(el);
    if (shape === 'circle') {
      this.burst(el, x, y + 0.3, z, 1.1);
      this.rings.ring(x, y, z, 2.8, c.main, { life: 0.35, intensity: 3 });
    } else this.rings.ring(x, y, z, 3.5, c.main, { life: 0.3, intensity: 2 });
    this.juice.shake(0.15);
  }

  // ============================================================ frame
  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    this.camera = camera;
    this.cores.begin();
    this.strips.begin(camera);
    this.updateProjectiles(dt);
    // trails
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const tr = this.trails[i];
      drawTrail(this.strips, tr, this.time);
      if (!tr.alive && tr.empty) this.trails.splice(i, 1);
    }
    // bolts
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      b.regen -= dt;
      if (b.t >= b.life) {
        this.bolts.splice(i, 1);
        continue;
      }
      if (b.regen <= 0) {
        b.regen = 0.05;
        b.seed++;
        b.bolt = generateLightning(...b.a, ...b.b, b.seed, { depth: 5, branchChance: 0.2 });
      }
      const fade = 1 - b.t / b.life;
      const flick = 0.6 + Math.random() * 0.6;
      tmpCol.set(b.color);
      b.bolt.paths.forEach((path, pi) => {
        const w = b.bolt.widths[pi] * b.width;
        this.strips.add(path, path.length / 3, () => 0.35 * w, (_t, o) => {
          o[0] = (0.6 + tmpCol.r) * 3 * flick;
          o[1] = (0.6 + tmpCol.g) * 3 * flick;
          o[2] = (0.6 + tmpCol.b) * 3 * flick;
          o[3] = fade;
        }, 1);
      });
    }
    this.projMeshes.update(this.projs.values());
    this.cores.end();
    this.strips.end();
    this.add.update(dt);
    this.blend.update(dt);
    this.rings.update(dt);
    this.lights.update(dt);
    this.ice.update(dt);
    this.rock.update(dt);
    for (const d of Object.values(this.decals)) d.update(dt);
    this.distort?.update(dt);
  }
}
