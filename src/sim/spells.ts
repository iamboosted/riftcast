import type { World } from './world';
import type { Element, Enemy, Player, PlayerInput, Projectile, SpellSlot } from './types';
import { groundHeight } from './room';
import { blast, chainLightning, damageEnemy, strike } from './combat';
import { V3 } from './vec';

export const SPELL_TIMING: Record<Element, { primaryCd: number; heavyCd: number; chargeTime: number; sigCd: number }> = {
  fire: { primaryCd: 0.17, heavyCd: 0.7, chargeTime: 1.0, sigCd: 9 },
  frost: { primaryCd: 0.34, heavyCd: 0.8, chargeTime: 0.9, sigCd: 10 },
  storm: { primaryCd: 0.21, heavyCd: 0.8, chargeTime: 1.0, sigCd: 11 },
  gale: { primaryCd: 0.22, heavyCd: 1.0, chargeTime: 0.8, sigCd: 8 },
  stone: { primaryCd: 0.3, heavyCd: 0.9, chargeTime: 1.1, sigCd: 10 },
  venom: { primaryCd: 0.3, heavyCd: 0.8, chargeTime: 0.9, sigCd: 12 },
};

export function handOrigin(p: Player): V3 {
  const rx = Math.cos(p.yaw),
    rz = -Math.sin(p.yaw);
  const fx = -Math.sin(p.yaw),
    fz = -Math.cos(p.yaw);
  return { x: p.pos.x + rx * 0.42 + fx * 0.4, y: p.pos.y + 1.35, z: p.pos.z + rz * 0.42 + fz * 0.4 };
}

export function aimDir(p: Player, input: PlayerInput, origin: V3): V3 {
  let dx = input.ax - origin.x,
    dy = input.ay - origin.y,
    dz = input.az - origin.z;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1.5 || !isFinite(l)) {
    const cp = Math.cos(input.pitch);
    dx = -Math.sin(input.yaw) * cp;
    dy = Math.sin(input.pitch);
    dz = -Math.cos(input.yaw) * cp;
    return { x: dx, y: dy, z: dz };
  }
  return { x: dx / l, y: dy / l, z: dz / l };
}

const rotY = (d: V3, a: number): V3 => {
  const c = Math.cos(a),
    s = Math.sin(a);
  return { x: d.x * c + d.z * s, y: d.y, z: -d.x * s + d.z * c };
};

interface ProjOpts {
  spell: string;
  speed: number;
  radius: number;
  damage: number;
  life: number;
  gravity?: number;
  pierce?: number;
  charge?: number;
  split?: number;
  idx?: number;
  data?: number;
}

export function spawnPlayerProjectile(w: World, p: Player, el: Element, origin: V3, dir: V3, o: ProjOpts): Projectile {
  const speed = o.speed * p.stats.projSpeed;
  const pr: Projectile = {
    id: w.id(),
    team: 'player',
    owner: p.id,
    element: el,
    spell: o.spell,
    pos: { ...origin },
    vel: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed },
    gravity: o.gravity ?? 0,
    radius: o.radius,
    damage: o.damage,
    life: o.life,
    pierce: (o.pierce ?? 0) + p.stats.pierce,
    hitIds: [],
    charge: o.charge ?? 0,
    ck: `${p.id}:${p.castSeq}:${o.idx ?? 0}`,
    bounces: 0,
    split: o.split ?? p.stats.splitOnHit,
    data: o.data ?? 0,
  };
  w.projectiles.push(pr);
  emitProj(w, pr);
  return pr;
}

export function emitProj(w: World, pr: Projectile): void {
  w.emit({
    t: 'proj',
    id: pr.id,
    el: pr.element,
    sp: pr.spell,
    x: pr.pos.x,
    y: pr.pos.y,
    z: pr.pos.z,
    vx: pr.vel.x,
    vy: pr.vel.y,
    vz: pr.vel.z,
    g: pr.gravity,
    r: pr.radius,
    team: pr.team,
    ck: pr.ck,
    life: pr.life,
  });
}

function castEvent(w: World, p: Player, el: Element, slot: SpellSlot, o: V3, d: V3, c = 0) {
  w.emit({ t: 'cast', pid: p.id, el, slot, x: o.x, y: o.y, z: o.z, dx: d.x, dy: d.y, dz: d.z, c });
}

/** Fan of projectiles: base count + boon extras, spread evenly. */
function fan(w: World, p: Player, el: Element, origin: V3, dir: V3, base: number, spread: number, o: ProjOpts) {
  const n = base + p.stats.extraProjectiles;
  for (let i = 0; i < n; i++) {
    const a = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * (n - 1);
    spawnPlayerProjectile(w, p, el, origin, rotY(dir, a), { ...o, idx: i });
  }
}

export function castPrimary(w: World, p: Player, el: Element, input: PlayerInput): void {
  p.castSeq++;
  const o = handOrigin(p);
  const d = aimDir(p, input, o);
  castEvent(w, p, el, 'primary', o, d);
  switch (el) {
    case 'fire':
      fan(w, p, el, o, d, 1, 0.09, { spell: 'ember', speed: 38, radius: 0.3, damage: 9, life: 1.2 });
      break;
    case 'frost':
      fan(w, p, el, o, d, 3, 0.1, { spell: 'shard', speed: 44, radius: 0.22, damage: 6, life: 0.9 });
      break;
    case 'storm':
      fan(w, p, el, o, d, 1, 0.08, { spell: 'arc', speed: 85, radius: 0.28, damage: 8, life: 0.45 });
      break;
    case 'gale':
      fan(w, p, el, o, d, 1, 0.12, { spell: 'gust', speed: 40, radius: 0.5, damage: 6, life: 0.8, pierce: 1 });
      break;
    case 'stone':
      fan(w, p, el, o, { ...d, y: d.y + 0.05 }, 2, 0.05, { spell: 'pebble', speed: 33, radius: 0.32, damage: 10, life: 1.4, gravity: 6 });
      break;
    case 'venom':
      fan(w, p, el, o, { ...d, y: d.y + 0.12 }, 1, 0.1, { spell: 'glob', speed: 27, radius: 0.32, damage: 8, life: 2, gravity: 16 });
      break;
  }
}

export function castHeavy(w: World, p: Player, el: Element, input: PlayerInput, c: number): void {
  p.castSeq++;
  const o = handOrigin(p);
  const d = aimDir(p, input, o);
  castEvent(w, p, el, 'heavy', o, d, c);
  switch (el) {
    case 'fire':
      spawnPlayerProjectile(w, p, el, o, d, { spell: 'sunorb', speed: 24, radius: 0.45 + 0.5 * c, damage: 25 + 45 * c, life: 2, charge: c });
      break;
    case 'frost':
      spawnPlayerProjectile(w, p, el, o, d, { spell: 'lance', speed: 46, radius: 0.42, damage: 30 + 50 * c, life: 0.9, pierce: 99, charge: c });
      break;
    case 'storm':
      spawnPlayerProjectile(w, p, el, o, d, { spell: 'spear', speed: 54, radius: 0.36, damage: 20 + 30 * c, life: 1.2, charge: c });
      break;
    case 'gale': {
      const hl = Math.hypot(d.x, d.z) || 1;
      const gh = groundHeight(w.room, p.pos.x, p.pos.z, p.pos.y + 0.5);
      const sp = 5 + 3 * c;
      const z = w.spawnZone({
        tag: 'vortex',
        element: 'gale',
        pos: { x: o.x + (d.x / hl) * 1.5, y: gh > -1e9 ? gh : p.pos.y, z: o.z + (d.z / hl) * 1.5 },
        radius: (2.2 + 1.3 * c) * p.stats.zoneRadius,
        life: (4 + 2 * c) * p.stats.zoneDuration,
        dps: 8,
        contributors: [p.id],
      });
      z.vel = { x: (d.x / hl) * sp, y: 0, z: (d.z / hl) * sp };
      break;
    }
    case 'stone':
      spawnPlayerProjectile(w, p, el, o, { ...d, y: Math.max(d.y, -0.2) + 0.1 }, {
        spell: 'boulder',
        speed: 16 + 6 * c,
        radius: 0.7 + 0.6 * c,
        damage: 40 + 60 * c,
        life: 3,
        gravity: 20,
        pierce: 3,
        charge: c,
      });
      break;
    case 'venom':
      spawnPlayerProjectile(w, p, el, o, { ...d, y: d.y + 0.2 }, { spell: 'flask', speed: 18 + 8 * c, radius: 0.35, damage: 12, life: 3, gravity: 18, charge: c });
      break;
  }
}

/** Ground point under the aim, clamped to maxDist from the player. */
function aimGround(w: World, p: Player, input: PlayerInput, maxDist: number, minDist = 0): V3 {
  let dx = input.ax - p.pos.x,
    dz = input.az - p.pos.z;
  let l = Math.hypot(dx, dz);
  if (l < 0.01) {
    dx = -Math.sin(p.yaw);
    dz = -Math.cos(p.yaw);
    l = 1;
  }
  const dist = Math.min(maxDist, Math.max(minDist, l));
  const x = p.pos.x + (dx / l) * dist,
    z = p.pos.z + (dz / l) * dist;
  const gh = groundHeight(w.room, x, z, p.pos.y + 3);
  return { x, y: gh > -1e9 ? gh : p.pos.y, z };
}

export function castSignature(w: World, p: Player, el: Element, input: PlayerInput): void {
  p.castSeq++;
  const o = handOrigin(p);
  const d = aimDir(p, input, o);
  castEvent(w, p, el, 'signature', o, d);
  const zr = p.stats.zoneRadius,
    zd = p.stats.zoneDuration;
  switch (el) {
    case 'fire': {
      const c = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      w.emit({ t: 'nova', x: c.x, y: c.y, z: c.z, r: 8, el });
      blast(w, c, 8, 40, 'fire', p.id, { knock: 10, noSelf: true });
      w.spawnZone({ tag: 'burning', element: 'fire', pos: c, radius: 4 * zr, life: 3.5 * zd, dps: 12, contributors: [p.id] });
      break;
    }
    case 'frost': {
      const g = aimGround(w, p, input, 18);
      w.emit({ t: 'nova', x: g.x, y: g.y, z: g.z, r: 5.5 * zr, el });
      blast(w, g, 5.5 * zr, 22, 'frost', p.id, { statusAmt: 6 });
      w.spawnZone({ tag: 'frostpatch', element: 'frost', pos: g, radius: 5.5 * zr, life: 7 * zd, dps: 0, contributors: [p.id] });
      break;
    }
    case 'storm': {
      const g = aimGround(w, p, input, 20);
      for (let i = 0; i < 7; i++) {
        w.later(i * 0.17, () => {
          const a = w.rng.range(0, Math.PI * 2),
            r = i === 0 ? 0 : w.rng.range(1, 6);
          const x = g.x + Math.cos(a) * r,
            z = g.z + Math.sin(a) * r;
          const gh = groundHeight(w.room, x, z, g.y + 3);
          strike(w, { x, y: gh > -1e9 ? gh : g.y, z }, 2.4, 30, p.id);
        });
      }
      break;
    }
    case 'gale': {
      p.vel.y = 15;
      p.grounded = false;
      p.jumpsUsed = 1;
      p.lastJump = 0;
      w.emit({ t: 'nova', x: p.pos.x, y: p.pos.y, z: p.pos.z, r: 6, el });
      blast(w, { ...p.pos }, 6, 15, 'gale', p.id, { knock: 14, lift: 8, noSelf: true });
      break;
    }
    case 'stone': {
      const g = aimGround(w, p, input, 14, 4);
      const ang = Math.atan2(d.z, d.x) + Math.PI / 2;
      w.spawnZone({ tag: 'wall', element: 'stone', pos: g, radius: 4.5, life: 10 * zd, dps: 0, contributors: [p.id], angle: ang, len: 4.5 });
      blast(w, g, 3.5, 20, 'stone', p.id, { knock: 8 });
      break;
    }
    case 'venom': {
      const c = { ...p.pos };
      w.spawnZone({ tag: 'venomcloud', element: 'venom', pos: c, radius: 5.5 * zr, life: 5.5 * zd, dps: 10, contributors: [p.id] });
      for (const e of w.enemies) {
        if (Math.hypot(e.pos.x - c.x, e.pos.z - c.z) < 6.5) {
          e.st.poison = Math.min(10, e.st.poison + 3);
          e.st.poisonT = 5;
          e.statusBy.poison = p.id;
        }
      }
      w.emit({ t: 'nova', x: c.x, y: c.y, z: c.z, r: 6, el });
      break;
    }
  }
}

/** Projectile impact behaviour by spell id. `enemy` is set for direct hits. */
export function projectileImpact(w: World, pr: Projectile, enemy: Enemy | null): void {
  const owner = w.players.get(pr.owner);
  const zr = owner?.stats.zoneRadius ?? 1,
    zd = owner?.stats.zoneDuration ?? 1;
  const pos = { ...pr.pos };
  const gh = groundHeight(w.room, pos.x, pos.z, pos.y + 1);
  const ground = { x: pos.x, y: gh > -1e9 ? gh : pos.y, z: pos.z };
  const c = pr.charge;
  switch (pr.spell) {
    case 'ember':
      blast(w, pos, 1.3, 4, 'fire', pr.owner, { skip: enemy?.id, small: true });
      break;
    case 'sunorb':
      blast(w, pos, 2.6 + 2 * c, 20 + 30 * c, 'fire', pr.owner, { skip: enemy?.id, knock: 6 });
      w.emit({ t: 'boom', x: pos.x, y: pos.y, z: pos.z, r: 2.6 + 2 * c, el: 'fire', big: c > 0.6 ? 1 : undefined });
      if (pos.y - ground.y < 3) w.spawnZone({ tag: 'burning', element: 'fire', pos: ground, radius: (2 + 1.5 * c) * zr, life: 4 * zd, dps: 10, contributors: [pr.owner] });
      break;
    case 'spear':
      strike(w, ground, 2.5 + 1.5 * c, 30 + 60 * c, pr.owner);
      break;
    case 'glob':
      if (pos.y - ground.y < 1.5 && w.zoneCount('venompool') < 14)
        w.spawnZone({ tag: 'venompool', element: 'venom', pos: ground, radius: 1.5 * zr, life: 3.5 * zd, dps: 4, contributors: [pr.owner] });
      break;
    case 'flask':
      w.emit({ t: 'boom', x: pos.x, y: pos.y, z: pos.z, r: 2.5, el: 'venom' });
      blast(w, pos, 2.5, pr.damage, 'venom', pr.owner, { skip: enemy?.id });
      w.spawnZone({ tag: 'venomcloud', element: 'venom', pos: ground, radius: (3 + 1.5 * c) * zr, life: 6 * zd, dps: 7, contributors: [pr.owner] });
      break;
    case 'boulder':
      w.emit({ t: 'boom', x: pos.x, y: pos.y, z: pos.z, r: 2.5, el: 'stone' });
      blast(w, pos, 2.5, 15, 'stone', pr.owner, { skip: enemy?.id, knock: 6 });
      break;
    case 'lance':
      w.emit({ t: 'boom', x: pos.x, y: pos.y, z: pos.z, r: 1.8, el: 'frost' });
      break;
    case 'arc':
      if (enemy) chainLightning(w, enemy, pr.damage * 0.6, 1 + (owner?.stats.chainCount ?? 0), 6.5, pr.owner);
      break;
  }
}

/** Per-tick behaviour for special projectiles (lance paves frost; boulder rolls). */
export function projectileTick(w: World, pr: Projectile, dt: number): void {
  if (pr.spell === 'lance') {
    pr.data += Math.hypot(pr.vel.x, pr.vel.z) * dt;
    if (pr.data > 3) {
      pr.data = 0;
      const gh = groundHeight(w.room, pr.pos.x, pr.pos.z, pr.pos.y + 0.5);
      const owner = w.players.get(pr.owner);
      if (gh > -1e9 && pr.pos.y - gh < 3.5 && w.zoneCount('frostpatch') < 18)
        w.spawnZone({
          tag: 'frostpatch',
          element: 'frost',
          pos: { x: pr.pos.x, y: gh, z: pr.pos.z },
          radius: 1.7 * (owner?.stats.zoneRadius ?? 1),
          life: 6 * (owner?.stats.zoneDuration ?? 1),
          dps: 0,
          contributors: [pr.owner],
        });
    }
  }
}

export { damageEnemy };
