import type { World } from './world';
import type { Projectile } from './types';
import { groundHeight } from './room';
import { findCombo, type Reagent } from './comboTable';
import { applyCombo } from './combos';
import { damageEnemy, uniq } from './combat';
import { projectileImpact, projectileTick, emitProj } from './spells';
import { damagePlayer } from './players';
import { wallEnds } from './movement';
import { segDist2D } from './vec';

/** Distance from point to segment in 3D. */
function segPointDist(ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number): number {
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + abx * t - px, ay + aby * t - py, az + abz * t - pz);
}

export function endProjectile(w: World, pr: Projectile, hit: 0 | 1 | 2): void {
  const i = w.projectiles.indexOf(pr);
  if (i >= 0) w.projectiles.splice(i, 1);
  w.emit({ t: 'projEnd', id: pr.id, x: pr.pos.x, y: pr.pos.y, z: pr.pos.z, hit });
}

export function stepProjectiles(w: World, dt: number): void {
  for (const pr of [...w.projectiles]) {
    if (!w.projectiles.includes(pr)) continue;
    pr.life -= dt;
    const ax = pr.pos.x,
      ay = pr.pos.y,
      az = pr.pos.z;
    pr.vel.y -= pr.gravity * dt;
    pr.pos.x += pr.vel.x * dt;
    pr.pos.y += pr.vel.y * dt;
    pr.pos.z += pr.vel.z * dt;
    projectileTick(w, pr, dt);

    // Boulders roll along the ground instead of exploding on contact
    const gh = groundHeight(w.room, pr.pos.x, pr.pos.z, ay + 0.5);
    if (pr.spell === 'boulder' && gh > -1e9 && pr.pos.y - pr.radius < gh) {
      pr.pos.y = gh + pr.radius;
      if (pr.vel.y < 0) pr.vel.y = pr.bounces++ < 1 ? -pr.vel.y * 0.3 : 0;
    }

    if (pr.team === 'player') {
      if (hitEnemies(w, pr, ax, ay, az)) continue;
    } else if (hitPlayers(w, pr, ax, ay, az)) continue;

    if (!w.projectiles.includes(pr)) continue;
    if (collideWalls(w, pr, ax, az)) continue;
    if (!w.projectiles.includes(pr)) continue;
    if (pr.team === 'player' && zoneReactions(w, pr)) continue;

    // Pillars
    let blocked = false;
    for (const o of w.room.obstacles) {
      if (pr.pos.y > o.h) continue;
      if (Math.hypot(pr.pos.x - o.x, pr.pos.z - o.z) < o.r + pr.radius * 0.5) {
        blocked = true;
        break;
      }
    }
    // Raised ledge sides
    if (!blocked)
      for (const p of w.room.platforms) {
        if (p.top <= 0 || pr.pos.y > p.top - 0.1) continue;
        if (Math.hypot(pr.pos.x - p.x, pr.pos.z - p.z) < p.r - 0.2) {
          blocked = true;
          break;
        }
      }
    const ground = pr.spell !== 'boulder' && gh > -1e9 && pr.pos.y < gh + 0.05;
    if (blocked || ground || pr.life <= 0 || pr.pos.y < -20) {
      if (pr.team === 'player') projectileImpact(w, pr, null);
      endProjectile(w, pr, blocked || ground ? 2 : 0);
    }
  }
}

function hitEnemies(w: World, pr: Projectile, ax: number, ay: number, az: number): boolean {
  for (const e of [...w.enemies]) {
    if (pr.hitIds.includes(e.id) || e.spawnT > 0) continue;
    const cy = e.pos.y + e.height * 0.5;
    const rad = e.radius + pr.radius;
    // treat enemy as a vertical capsule: test at center height with generous vertical extent
    const d = segPointDist(ax, ay, az, pr.pos.x, pr.pos.y, pr.pos.z, e.pos.x, Math.min(Math.max(pr.pos.y, e.pos.y + 0.3), e.pos.y + e.height), e.pos.z);
    if (d > rad && Math.abs(pr.pos.y - cy) > e.height * 0.5 + pr.radius) continue;
    if (d > rad) continue;
    pr.hitIds.push(e.id);
    const owner = w.players.get(pr.owner);
    const kn = pr.spell === 'gust' ? 7 : pr.spell === 'boulder' ? 9 : pr.spell === 'pebble' ? 1.5 : 0;
    damageEnemy(w, e, pr.damage, pr.element, pr.owner, {
      via: 'projectile',
      tag: pr.spell,
      knock: kn ? { x: pr.vel.x, z: pr.vel.z, f: kn } : undefined,
      statusAmt: pr.spell === 'lance' ? 2.5 : 1,
    });
    // Fracture boon: split into shards on hit
    if (pr.split > 0 && owner && pr.data >= 0 && pr.spell !== 'boulder') {
      for (let i = 0; i < pr.split; i++) {
        const a = (i / pr.split) * Math.PI * 2 + w.rng.range(0, 1);
        const sp = Math.hypot(pr.vel.x, pr.vel.z) * 0.7;
        const child: Projectile = {
          ...pr,
          id: w.id(),
          pos: { ...pr.pos },
          vel: { x: Math.cos(a) * sp, y: 0, z: Math.sin(a) * sp },
          damage: pr.damage * 0.4,
          life: 0.35,
          pierce: 0,
          hitIds: [e.id],
          split: 0,
          data: -1,
          ck: '',
          gravity: 0,
        };
        w.projectiles.push(child);
        emitProj(w, child);
      }
    }
    pr.pierce--;
    if (pr.pierce < 0) {
      projectileImpact(w, pr, e);
      endProjectile(w, pr, 1);
      return true;
    }
    if (!w.projectiles.includes(pr)) return true;
  }
  return false;
}

function hitPlayers(w: World, pr: Projectile, ax: number, ay: number, az: number): boolean {
  for (const p of w.players.values()) {
    if (p.state !== 'alive') continue;
    const d = segPointDist(ax, ay, az, pr.pos.x, pr.pos.y, pr.pos.z, p.pos.x, p.pos.y + 0.9, p.pos.z);
    if (d < 0.6 + pr.radius) {
      if (damagePlayer(w, p, pr.damage, pr.element, { x: pr.vel.x, z: pr.vel.z, f: 3 })) {
        endProjectile(w, pr, 1);
        return true;
      }
    }
  }
  return false;
}

function collideWalls(w: World, pr: Projectile, ax: number, az: number): boolean {
  for (const z of w.zones) {
    if (z.tag !== 'wall' && z.tag !== 'magmawall') continue;
    if (pr.pos.y > z.pos.y + 2.6) continue; // arcing shots sail over
    const [x1, z1, x2, z2] = wallEnds({ x: z.pos.x, z: z.pos.z, angle: z.angle, len: z.len, thick: 0.6, h: 0 });
    const [d] = segDist2D(pr.pos.x, pr.pos.z, x1, z1, x2, z2);
    if (d > 0.6 + pr.radius) continue;
    if (pr.team === 'enemy') {
      endProjectile(w, pr, 2);
      return true;
    }
    const m = findCombo({ kind: 'projectile', element: pr.element, tag: pr.spell }, { kind: 'zone', element: z.element, tag: z.tag });
    if (m?.rule.effect.type === 'reflect') {
      // reflect velocity about wall normal
      const nx = -Math.sin(z.angle),
        nz = Math.cos(z.angle);
      const side = (ax - z.pos.x) * nx + (az - z.pos.z) * nz >= 0 ? 1 : -1;
      const dot = pr.vel.x * nx + pr.vel.z * nz;
      pr.vel.x -= 2 * dot * nx;
      pr.vel.z -= 2 * dot * nz;
      pr.pos.x = ax + nx * side * 0.05;
      pr.pos.z = az + nz * side * 0.05;
      pr.life += 0.3;
      pr.hitIds = [];
      pr.damage *= 1.25;
      w.emit({ t: 'projBounce', id: pr.id, x: pr.pos.x, y: pr.pos.y, z: pr.pos.z, vx: pr.vel.x, vy: pr.vel.y, vz: pr.vel.z });
      return false;
    }
    if (m) {
      applyCombo(w, m, { pos: { ...pr.pos }, zone: z, projectile: pr, contributors: uniq([pr.owner, ...z.contributors]) });
    }
    projectileImpact(w, pr, null);
    endProjectile(w, pr, 2);
    return true;
  }
  return false;
}

function zoneReactions(w: World, pr: Projectile): boolean {
  const reagent: Reagent = { kind: 'projectile', element: pr.element, tag: pr.spell };
  for (const z of [...w.zones]) {
    if (z.tag === 'wall' || z.tag === 'magmawall') continue;
    if (pr.hitIds.includes(-z.id)) continue;
    const dy = pr.pos.y - z.pos.y;
    const h = z.tag === 'vortex' || z.tag.endsWith('storm') || z.tag === 'blizzard' || z.tag === 'stormcell' || z.tag === 'venomcloud' || z.tag === 'steam' ? 5 : 1.6;
    if (dy < -0.5 || dy > h) continue;
    if (Math.hypot(pr.pos.x - z.pos.x, pr.pos.z - z.pos.z) > z.radius + pr.radius) continue;
    pr.hitIds.push(-z.id);
    const m = findCombo(reagent, { kind: 'zone', element: z.element, tag: z.tag });
    if (!m || m.rule.silent) continue;
    applyCombo(w, m, { pos: { ...pr.pos }, zone: z, projectile: pr, contributors: uniq([pr.owner, ...z.contributors]) });
    endProjectile(w, pr, 1);
    return true;
  }
  return false;
}
