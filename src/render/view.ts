import * as THREE from 'three/webgpu';
import { uniform, vec3, vec4, float, abs, dot, pow, normalView, positionViewDirection, mx_noise_float, positionWorld, time, mix } from './tsl';
import { Arena } from './arena';
import { buildEnemy, buildMage, enemyAccent, mat, type ActorRig } from './actors';
import { Fx } from '../vfx/fx';
import type { Session, ViewState } from '../net/session';
import type { Element, SimEvent, Zone } from '../sim/types';
import { ELEMENT_INFO } from '../data/elements';
import { ENEMIES } from '../data/enemies';
import { groundHeight, type Room } from '../sim/room';
import type { Gfx } from './gfx';
import type { CameraRig } from '../game/camera';
import { Rng } from '../sim/rng';
import { wallEnds } from '../sim/movement';
import { handOrigin } from '../sim/spells';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { V3 } from '../sim/vec';

type MageRig = ReturnType<typeof buildMage>;

interface EnemyVis {
  rig: ActorRig;
  dying: number;
  kind: string;
  seed: number;
  pos: V3;
  lastEl: Element | null;
  emitT: number;
}

interface Ghost {
  mesh: THREE.Mesh;
  t: number;
  life: number;
}

/** Turns replicated/authoritative state + sim events into the 3D scene. */
export class GameView {
  arena: Arena;
  fx: Fx;
  root = new THREE.Group();
  private players = new Map<string, { rig: MageRig; el: string; pos: V3; lastHover: number }>();
  private enemies = new Map<number, EnemyVis>();
  private walls = new Map<number, THREE.Mesh>();
  private pickups = new Map<number, THREE.Object3D>();
  private ghosts: Ghost[] = [];
  private ghostMat: THREE.MeshBasicNodeMaterial;
  private wallMat: THREE.MeshStandardNodeMaterial;
  private magmaMat: THREE.MeshStandardNodeMaterial;
  private roomSeed = -1;
  private tmp: V3 = { x: 0, y: 0, z: 0 };
  /** callbacks for UI */
  onCombo?: (name: string, pids: string[], x: number, y: number, z: number) => void;
  onDamageNumber?: (x: number, y: number, z: number, amt: number, el: Element, crit: boolean, toPlayer: boolean) => void;
  onBoss?: (name: string, phase: number) => void;
  onRoom?: (idx: number, kind: string) => void;
  onClear?: () => void;
  onPickup?: (pid: string, kind: string, value: string) => void;
  onPing?: (pid: string, kind: string, x: number, y: number, z: number) => void;
  onDown?: (pid: string) => void;
  onRevive?: (pid: string, by: string) => void;
  onSfx?: (ev: SimEvent) => void;
  room: Room | null = null;
  pingMarkers: { x: number; y: number; z: number; t: number; color: number; kind: string; pid: string }[] = [];

  constructor(private gfx: Gfx, private rig: CameraRig) {
    this.arena = new Arena(gfx.scene);
    this.fx = new Fx(gfx.renderer, gfx.isWebGPU, gfx.quality, {
      shake: (a) => rig.shake(a),
      flash: (c, a) => {
        gfx.u.flash.value.set(c);
        gfx.u.flashAmt.value = Math.max(gfx.u.flashAmt.value, a);
      },
      hitstop: (ms) => this.hitstop(ms),
      aberration: (a) => (gfx.u.ca.value = Math.max(gfx.u.ca.value, a)),
    });
    gfx.scene.add(this.root, this.fx.group);
    // ghost afterimage material: additive fresnel tinted per object
    const gm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const gu = uniform(new THREE.Vector4(1, 1, 1, 1)).onObjectUpdate(({ object }) => object.userData.ghost as THREE.Vector4);
    const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 1.5);
    gm.colorNode = vec4(vec3(gu.x, gu.y, gu.z).mul(fres.add(0.25)).mul(gu.w).mul(2), gu.w);
    this.ghostMat = gm;
    this.wallMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const wn = mx_noise_float(positionWorld.mul(1.3)).mul(0.5).add(0.5);
    this.wallMat.colorNode = mix(vec3(0.28, 0.2, 0.14), vec3(0.62, 0.46, 0.3), wn);
    this.wallMat.emissiveNode = vec3(0.9, 0.5, 0.2).mul(pow(wn, 6).mul(0.6));
    this.magmaMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
    const mn = mx_noise_float(positionWorld.mul(1.6).add(vec3(0, time.mul(0.6), 0))).mul(0.5).add(0.5);
    this.magmaMat.colorNode = mix(vec3(0.08, 0.03, 0.02), vec3(0.3, 0.08, 0.02), mn);
    this.magmaMat.emissiveNode = vec3(3.5, 1.1, 0.2).mul(pow(mn, 3).mul(1.6));
  }

  hitstopMs = 0;
  hitstop(ms: number) {
    this.hitstopMs = Math.max(this.hitstopMs, ms);
  }

  ground = (x: number, z: number, y: number) => {
    if (!this.room) return 0;
    const g = groundHeight(this.room, x, z, y);
    return g > -1e9 ? g : -50;
  };

  syncRoom(room: Room) {
    if (room.seed === this.roomSeed) return;
    this.roomSeed = room.seed;
    this.room = room;
    this.arena.build(room, this.gfx.quality);
    this.fx.ground = this.ground;
    for (const w of this.walls.values()) this.root.remove(w);
    this.walls.clear();
    for (const [, e] of this.enemies) this.root.remove(e.rig.root);
    this.enemies.clear();
  }

  /** Handle presentation for replicated events. */
  handleEvents(events: SimEvent[], s: ViewState, localId: string) {
    const fx = this.fx;
    for (const ev of events) {
      this.onSfx?.(ev);
      switch (ev.t) {
        case 'cast': {
          fx.castFlash(ev.el, ev.slot, ev.x, ev.y, ev.z, ev.dx, ev.dy, ev.dz, ev.c);
          if (ev.pid === localId && ev.slot !== 'primary') this.rig.fovKick = ev.slot === 'signature' ? 6 : 3;
          if (ev.pid === localId) this.rig.shake(ev.slot === 'primary' ? 0.03 : 0.15);
          break;
        }
        case 'proj':
          fx.spawnProjectile(ev.id, ev.el, ev.sp, ev.x, ev.y, ev.z, ev.vx, ev.vy, ev.vz, ev.g, ev.r, ev.team === 'enemy', ev.life);
          break;
        case 'projEnd':
          fx.endProjectile(ev.id, ev.x, ev.y, ev.z, ev.hit);
          break;
        case 'projBounce':
          fx.bounceProjectile(ev.id, ev.x, ev.y, ev.z, ev.vx, ev.vy, ev.vz);
          break;
        case 'hit':
          fx.hit(ev.el, ev.x, ev.y, ev.z, ev.amt, !!ev.crit);
          this.onDamageNumber?.(ev.x, ev.y + 0.6, ev.z, ev.amt, ev.el, !!ev.crit, false);
          break;
        case 'boom':
          fx.explosion(ev.el, ev.x, ev.y, ev.z, ev.r, !!ev.big);
          break;
        case 'nova':
          fx.nova(ev.el, ev.x, ev.y, ev.z, ev.r);
          break;
        case 'strike':
          fx.strike(ev.x, ev.y, ev.z, ev.r);
          break;
        case 'bolt':
          fx.bolt(ev.x, ev.y, ev.z, ev.x2, ev.y2, ev.z2, ev.el, ev.w ? 1.4 : 1, ev.w ? 0.35 : 0.22);
          break;
        case 'combo':
          fx.combo(ev.key, ev.x, ev.y, ev.z, ev.r);
          this.onCombo?.(ev.name, ev.pids, ev.x, ev.y, ev.z);
          break;
        case 'kill': {
          const v = this.enemies.get(ev.id);
          const def = ENEMIES[ev.kind];
          fx.death(ev.el, ev.x, ev.y, ev.z, enemyAccent(def?.faction ?? 'cinder'), def?.height ?? 1.5);
          if (v) v.dying = 0.001;
          if (def?.boss) {
            fx.combo('detonation', ev.x, ev.y + 2, ev.z, 8);
          }
          break;
        }
        case 'tele':
          fx.teleImpact(ev.shape, ev.x, this.ground(ev.x, ev.z, 50), ev.z, ev.el);
          break;
        case 'spawn':
          fx.spawnPortal(ev.x, this.ground(ev.x, ev.z, ev.y + 3), ev.z, enemyAccent(ev.faction));
          break;
        case 'dash': {
          const p = s.players.get(ev.pid);
          const col = p?.color ?? 0xffffff;
          fx.dashTrail(ev.x, ev.y, ev.z, col, !!ev.blink);
          if (ev.blink && ev.x2 !== undefined) fx.dashTrail(ev.x2, ev.y, ev.z2!, col, true);
          this.spawnGhosts(ev.pid, col, ev.blink ? 2 : 5);
          if (ev.pid === localId) this.rig.fovKick = 8;
          break;
        }
        case 'jump': {
          const p = s.players.get(ev.pid);
          if (p) {
            fx.jumpPuff(p.pos.x, p.pos.y, p.pos.z, ev.n, p.color);
            if (ev.rocket) fx.rocketBlast(p.pos.x, p.pos.y, p.pos.z);
          }
          break;
        }
        case 'hurt': {
          const p = s.players.get(ev.pid);
          if (p) {
            fx.burst(ev.el, p.pos.x, p.pos.y + 1, p.pos.z, 0.7);
            this.onDamageNumber?.(p.pos.x, p.pos.y + 2.2, p.pos.z, ev.amt, ev.el, false, true);
          }
          if (ev.pid === localId) {
            this.rig.shake(0.35);
            this.gfx.u.hurt.value = Math.min(1, this.gfx.u.hurt.value + 0.6);
          }
          break;
        }
        case 'down': {
          const p = s.players.get(ev.pid);
          if (p) fx.downed(p.pos.x, p.pos.y, p.pos.z);
          this.onDown?.(ev.pid);
          break;
        }
        case 'revive': {
          const p = s.players.get(ev.pid);
          if (p) fx.revive(p.pos.x, p.pos.y, p.pos.z, p.color);
          this.onRevive?.(ev.pid, ev.by);
          break;
        }
        case 'pickup':
          fx.pickup(ev.x, ev.y, ev.z, ev.kind === 'heal' ? 0x7dff8a : 0xb48cff);
          if (ev.kind === 'heal') fx.heal(ev.x, ev.y, ev.z);
          this.onPickup?.(ev.pid, ev.kind, ev.value);
          break;
        case 'boss':
          this.onBoss?.(ev.name, ev.phase);
          if (ev.phase > 1) {
            this.rig.shake(0.9);
            this.gfx.u.flash.value.set(0xff4020);
            this.gfx.u.flashAmt.value = 0.4;
          }
          break;
        case 'shatter':
          break;
        case 'room':
          this.onRoom?.(ev.idx, ev.kind);
          break;
        case 'clear':
          this.onClear?.();
          break;
        case 'swap': {
          const p = s.players.get(ev.pid);
          if (p) fx.burst(ev.el, ...this.handPos(p.id, p), 0.6);
          break;
        }
        case 'ping': {
          const p = s.players.get(ev.pid);
          const col = p?.color ?? 0xffffff;
          fx.ping(ev.x, ev.y, ev.z, col);
          this.pingMarkers.push({ x: ev.x, y: ev.y, z: ev.z, t: 0, color: col, kind: ev.kind, pid: ev.pid });
          if (this.pingMarkers.length > 8) this.pingMarkers.shift();
          this.onPing?.(ev.pid, ev.kind, ev.x, ev.y, ev.z);
          break;
        }
        case 'wallRise': {
          const z = s.zones.find((q) => q.id === ev.id);
          if (z) this.fx.burst('stone', z.pos.x, z.pos.y, z.pos.z, 2);
          this.rig.shake(0.25);
          break;
        }
      }
    }
  }

  private handPos(id: string, p: { pos: V3; yaw: number }): [number, number, number] {
    const v = this.players.get(id);
    const pos = v?.pos ?? p.pos;
    const o = handOrigin({ pos, yaw: p.yaw } as never);
    return [o.x, o.y, o.z];
  }

  private spawnGhosts(pid: string, color: number, n: number) {
    const v = this.players.get(pid);
    if (!v) return;
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const m = new THREE.Mesh(v.rig.body.geometry, this.ghostMat);
        m.position.copy(v.rig.root.position);
        m.rotation.copy(v.rig.root.rotation);
        m.userData.ghost = new THREE.Vector4(c.r, c.g, c.b, 0.8);
        this.root.add(m);
        this.ghosts.push({ mesh: m, t: 0, life: 0.35 });
      }, i * 35);
    }
  }

  frame(dt: number, session: Session) {
    const s = session.state;
    this.syncRoom(s.room);
    const t = s.time;
    this.arena.update(this.fx.time, s.run.phase === 'room' ? 0.3 + Math.min(1, s.enemies.length / 10) * 0.7 : 0.15);
    this.syncPlayers(dt, session);
    this.syncEnemies(dt, session);
    this.syncZones(dt, s.zones);
    this.syncPickups(dt, s);
    for (const tg of s.telegraphs) this.fx.telegraph(tg);
    // ping beacons
    for (let i = this.pingMarkers.length - 1; i >= 0; i--) {
      const pm = this.pingMarkers[i];
      pm.t += dt;
      if (pm.t > 5) this.pingMarkers.splice(i, 1);
      else {
        const c = new THREE.Color(pm.color);
        this.fx.cores.add(pm.x, pm.y + 2.5 + Math.sin(pm.t * 4) * 0.2, pm.z, 0.9, c, 2.5, 6);
        if (Math.random() < dt * 20) this.fx.add.emit({ x: pm.x, y: pm.y + 0.1, z: pm.z, count: 1, vy: 4, life: 0.6, size: 0.1, color: pm.color, intensity: 3, shape: 0 });
      }
    }
    // ghosts
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.t += dt;
      const k = g.t / g.life;
      (g.mesh.userData.ghost as THREE.Vector4).w = 0.8 * (1 - k);
      g.mesh.scale.setScalar(1 + k * 0.15);
      if (k >= 1) {
        this.root.remove(g.mesh);
        this.ghosts.splice(i, 1);
      }
    }
    void t;
  }

  private syncPlayers(dt: number, session: Session) {
    const s = session.state;
    for (const [id, v] of this.players) {
      if (!s.players.has(id)) {
        this.root.remove(v.rig.root);
        this.players.delete(id);
      }
    }
    for (const p of s.players.values()) {
      let v = this.players.get(p.id);
      if (!v) {
        const rig = buildMage(p.color, p.id.length * 31 + p.color);
        this.root.add(rig.root);
        v = { rig, el: '', pos: { ...p.pos }, lastHover: 0 };
        this.players.set(p.id, v);
      }
      session.renderPos('p', p.id, v.pos);
      const r = v.rig;
      const visible = p.state !== 'spectating' && p.state !== 'dead';
      r.root.visible = visible;
      if (!visible) continue;
      const el = p.gauntlets[p.active];
      const key = `${el}:${p.gauntlets[1 - p.active]}`;
      if (v.el !== key) {
        r.setElement(el, p.gauntlets[1 - p.active]);
        v.el = key;
      }
      r.root.position.set(v.pos.x, v.pos.y, v.pos.z);
      // facing: players face -Z at yaw 0
      r.root.rotation.y = p.yaw;
      const downed = p.state === 'downed';
      r.body.rotation.x = downed ? -1.2 : Math.max(-0.25, Math.min(0.25, -(p.vel.x * Math.sin(p.yaw) + p.vel.z * Math.cos(p.yaw)) * 0.02));
      r.body.position.y = downed ? 0.35 : Math.sin(this.fx.time * 3 + p.color) * 0.03 + (p.grounded ? 0 : 0.05);
      const fx4 = r.body.userData.fx as THREE.Vector4;
      fx4.x = p.hurtFlash > 0 ? p.hurtFlash * 2 : 0;
      fx4.z = 0;
      const charge = p.charging ? p.charge : 0;
      const hs = 1 + p.castFlash * 3 + charge * 1.6;
      r.handR.scale.setScalar(hs);
      r.handL.scale.setScalar(0.8);
      r.core.rotation.y += dt * 3;
      r.handR.rotation.y += dt * 5;
      r.handL.rotation.x += dt * 4;
      if (p.charging) {
        const hp = new THREE.Vector3();
        r.handR.getWorldPosition(hp);
        this.fx.charging(el, hp.x, hp.y, hp.z, p.charge, dt);
      } else if (Math.random() < dt * 8) {
        // idle gauntlet wisps in element language
        const hp = new THREE.Vector3();
        r.handR.getWorldPosition(hp);
        const c = ELEMENT_INFO[el];
        this.fx.add.emit({ x: hp.x, y: hp.y, z: hp.z, count: 1, spread: 0.6, vy: el === 'fire' ? 1 : el === 'stone' ? -1 : 0.3, life: 0.4, size: 0.08, sizeEnd: 0, color: c.core, colorEnd: c.main, intensity: 3, shape: el === 'fire' ? 2 : el === 'frost' ? 12 : el === 'storm' ? 1 : el === 'venom' ? 7 : 0, stretch: el === 'storm' ? 4 : 0 });
      }
      if (p.hovering) this.fx.hover(v.pos.x, v.pos.y, v.pos.z, p.color);
      if (downed) {
        // revive progress ring
        this.fx.decals.rune.set({ x: v.pos.x, y: v.pos.y, z: v.pos.z, sx: 2.6, sz: 2.6, rot: this.fx.time, d: [0.5, 0, 0.6 + p.reviveProgress * 1.4, 1], color: new THREE.Color(p.reviveProgress > 0 ? 0x7dff8a : 0xff3a4a) });
      }
      // player colour halo at feet
      this.fx.cores.add(v.pos.x, v.pos.y + 0.05, v.pos.z, 1.1, new THREE.Color(p.color), 0.25, 0);
    }
  }

  private syncEnemies(dt: number, session: Session) {
    const s = session.state;
    const seen = new Set<number>();
    for (const e of s.enemies) {
      seen.add(e.id);
      let v = this.enemies.get(e.id);
      const def = ENEMIES[e.kind];
      if (!v) {
        const rig = buildEnemy(def?.shape ?? 'brute', e.faction, e.seed, e.radius, e.height);
        if (e.elite && !e.boss) rig.root.scale.setScalar(1.0);
        this.root.add(rig.root);
        v = { rig, dying: 0, kind: e.kind, seed: e.seed, pos: { ...e.pos }, lastEl: null, emitT: 0 };
        this.enemies.set(e.id, v);
      }
      session.renderPos('e', e.id, v.pos);
      const r = v.rig;
      r.root.position.set(v.pos.x, v.pos.y, v.pos.z);
      r.root.rotation.y = e.yaw;
      const fx4 = r.body.userData.fx as THREE.Vector4;
      fx4.x = e.hitFlash;
      fx4.z = e.st.frozen > 0 ? 1 : Math.min(0.6, e.st.chill / 120);
      fx4.w = e.st.poison > 0 ? Math.min(1, e.st.poison / 4) : 0;
      // spawn: rise out of the rift
      const spawnK = e.spawnT > 0 ? Math.min(1, e.spawnT / 0.9) : 0;
      fx4.y = spawnK * 0.95;
      // animation
      const tt = this.fx.time + (e.seed % 100);
      const frozen = e.st.frozen > 0;
      const speedAnim = frozen ? 0 : 1;
      if (e.flying) r.body.position.y = Math.sin(tt * 3) * 0.15 * speedAnim;
      else r.body.position.y = Math.abs(Math.sin(tt * 6)) * 0.06 * speedAnim;
      const wind = e.state === 'windup' ? 1 : 0;
      r.body.scale.set(1 + wind * 0.08, 1 - wind * 0.06, 1 + wind * 0.08);
      for (const sp of r.spinners) sp.rotation.y += dt * (e.boss ? 0.8 : 2.5) * speedAnim;
      for (const w of r.wings) w.rotation.z = Math.sin(tt * 30) * 0.5 * (w.userData.side ?? 1) * speedAnim;
      for (const o of [...r.spinners, ...r.wings]) o.traverse((m) => m.userData.fx && (m.userData.fx as THREE.Vector4).copy(fx4));
      // windup glow
      if (e.state === 'windup' && Math.random() < dt * 30) {
        const acc = enemyAccent(e.faction);
        this.fx.add.emit({ x: v.pos.x, y: v.pos.y + e.height * 0.6, z: v.pos.z, count: 1, posSpread: e.radius * 1.4, spread: 1, life: 0.3, size: 0.2, sizeEnd: 0, color: 0xffffff, colorEnd: acc, intensity: 4, shape: 13 });
      }
      // status visuals
      v.emitT -= dt;
      if (v.emitT <= 0) {
        v.emitT = 0.05;
        const cx = v.pos.x,
          cy = v.pos.y + e.height * 0.5,
          cz = v.pos.z;
        if (e.st.burn > 0) this.fx.add.emit({ x: cx, y: cy, z: cz, count: 2, posSpread: e.radius, posSpreadY: e.height / (2 * e.radius), vy: 1.5, life: 0.45, size: 0.4, sizeEnd: 0.05, color: 0xffe08a, colorEnd: 0xb81e00, intensity: 3.5, gravity: -4, turb: 3, shape: 2 });
        if (e.st.poison > 0) this.fx.add.emit({ x: cx, y: cy, z: cz, count: 1, posSpread: e.radius, vy: -0.5, life: 0.6, size: 0.14, color: 0xc8ff6a, colorEnd: 0x7a2bd6, intensity: 2.5, gravity: 4, shape: 11 });
        if (e.st.shock > 0 && Math.random() < 0.5) this.fx.add.emit({ x: cx, y: cy, z: cz, count: 3, posSpread: e.radius, spread: 8, life: 0.1, size: 0.05, color: 0xffffff, colorEnd: 0xa77bff, intensity: 7, shape: 1, stretch: 8 });
        if (frozen && Math.random() < 0.4) this.fx.add.emit({ x: cx, y: cy, z: cz, count: 1, posSpread: e.radius * 1.1, life: 0.6, size: 0.15, color: 0xffffff, colorEnd: 0x6fd8ff, intensity: 3, shape: 6 });
        if (e.st.blind > 0 && Math.random() < 0.3) this.fx.add.emit({ x: cx, y: v.pos.y + e.height + 0.3, z: cz, count: 1, spread: 1, life: 0.6, size: 0.2, color: 0xffffff, colorEnd: 0xb0c0d0, intensity: 1.5, shape: 12, spin: 4 });
        if (e.boss && Math.random() < 0.8) {
          const acc = enemyAccent(e.kind === 'kiln' ? 'cinder' : 'glass');
          this.fx.add.emit({ x: cx, y: cy + 1, z: cz, count: 2, posSpread: e.radius * 1.3, spread: 1, vy: 2, life: 0.8, size: 0.4, sizeEnd: 0, color: e.kind === 'kiln' ? 0xffd08a : 0xd8c8ff, colorEnd: acc, intensity: 3, gravity: -1, turb: 3, shape: e.kind === 'kiln' ? 2 : 4 });
        }
      }
    }
    // dying: dissolve then remove
    for (const [id, v] of this.enemies) {
      if (seen.has(id)) continue;
      if (v.dying <= 0) v.dying = 0.001;
      v.dying += dt;
      const fx4 = v.rig.body.userData.fx as THREE.Vector4;
      fx4.y = Math.min(1, v.dying / 0.6);
      fx4.x = Math.max(0, 1 - v.dying * 4);
      for (const o of [...v.rig.spinners, ...v.rig.wings]) o.traverse((m) => m.userData.fx && (m.userData.fx as THREE.Vector4).copy(fx4));
      v.rig.root.position.y -= dt * 0.4;
      if (v.dying > 0.65) {
        this.root.remove(v.rig.root);
        this.enemies.delete(id);
      }
    }
  }

  private syncZones(dt: number, zones: Zone[]) {
    const ids = new Set<number>();
    for (const z of zones) {
      ids.add(z.id);
      this.fx.zone(z, dt);
      if (z.tag === 'wall' || z.tag === 'magmawall') {
        let m = this.walls.get(z.id);
        if (!m) {
          m = this.buildWall(z);
          this.root.add(m);
          this.walls.set(z.id, m);
          m.userData.rise = 0;
        }
        m.material = z.tag === 'magmawall' ? this.magmaMat : this.wallMat;
        m.userData.rise = Math.min(1, m.userData.rise + dt * 5);
        const sink = z.life < 0.5 ? z.life / 0.5 : 1;
        const k = Math.min(m.userData.rise, sink);
        m.position.set(z.pos.x, z.pos.y - (1 - k) * 2.8, z.pos.z);
        m.rotation.y = -z.angle;
      }
    }
    for (const [id, m] of this.walls) {
      if (!ids.has(id)) {
        this.fx.burst('stone', m.position.x, m.position.y + 1, m.position.z, 1.5);
        this.root.remove(m);
        this.walls.delete(id);
      }
    }
  }

  private buildWall(z: Zone): THREE.Mesh {
    const rng = new Rng(z.id * 977);
    const parts: THREE.BufferGeometry[] = [];
    const n = Math.ceil(z.len * 2 / 0.9);
    for (let i = 0; i < n; i++) {
      for (let row = 0; row < 3; row++) {
        const g = new THREE.DodecahedronGeometry(0.55 + rng.range(-0.05, 0.15), 0);
        g.applyMatrix4(mat(-z.len + (i + 0.5) * ((z.len * 2) / n) + rng.range(-0.1, 0.1), 0.45 + row * 0.85, rng.range(-0.15, 0.15), rng.range(0, 3), rng.range(0, 3), 0, 1, row === 2 ? 0.8 : 1, 0.75));
        parts.push(g.toNonIndexed());
      }
    }
    const geo = mergeGeometries(parts)!;
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, this.wallMat);
  }

  private syncPickups(dt: number, s: ViewState) {
    const ids = new Set<number>();
    for (const pk of s.pickups) {
      ids.add(pk.id);
      let o = this.pickups.get(pk.id);
      if (!o) {
        const col = pk.kind === 'heal' ? 0x7dff8a : 0xb48cff;
        const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.2 });
        const c = new THREE.Color(col);
        const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2);
        m.colorNode = vec3(c.r, c.g, c.b).mul(0.2);
        m.emissiveNode = vec3(c.r, c.g, c.b).mul(fres.mul(3).add(1));
        o = new THREE.Mesh(pk.kind === 'heal' ? new THREE.IcosahedronGeometry(0.3, 1) : new THREE.OctahedronGeometry(0.45, 0), m);
        this.root.add(o);
        this.pickups.set(pk.id, o);
      }
      o.position.set(pk.pos.x, pk.pos.y + 1 + Math.sin(this.fx.time * 2 + pk.id) * 0.2, pk.pos.z);
      o.rotation.y += dt * 2;
      if (pk.kind === 'rune') {
        this.fx.decals.rune.set({ x: pk.pos.x, y: pk.pos.y, z: pk.pos.z, sx: 1.3, sz: 1.3, rot: this.fx.time * 0.5, d: [0.5, 0, 1, pk.id], color: new THREE.Color(0xb48cff) });
        this.fx.cores.add(o.position.x, o.position.y, o.position.z, 1.6, new THREE.Color(0xb48cff), 0.8, 6);
      } else this.fx.cores.add(o.position.x, o.position.y, o.position.z, 1.0, new THREE.Color(0x7dff8a), 0.8, 0);
    }
    for (const [id, o] of this.pickups) {
      if (!ids.has(id)) {
        this.root.remove(o);
        this.pickups.delete(id);
      }
    }
  }

  playerRenderPos(id: string): V3 | null {
    return this.players.get(id)?.pos ?? null;
  }

  update(dt: number, camera: THREE.Camera) {
    this.fx.update(dt, camera);
  }
}

export { wallEnds };
