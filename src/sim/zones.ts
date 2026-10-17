import type { World } from './world';
import type { Enemy, Zone } from './types';
import { findCombo } from './comboTable';
import { applyCombo } from './combos';
import { damageEnemy, uniq } from './combat';
import { isOnPlatforms, groundHeight } from './room';
import { wallEnds } from './movement';
import { segDist2D } from './vec';

const ROAMING = new Set(['vortex', 'firestorm', 'toxicstorm', 'blizzard', 'stormcell']);

function inZone(e: Enemy, z: Zone): boolean {
  if (z.tag === 'wall' || z.tag === 'magmawall') {
    const [x1, z1, x2, z2] = wallEnds({ x: z.pos.x, z: z.pos.z, angle: z.angle, len: z.len, thick: 0.6, h: 0 });
    return segDist2D(e.pos.x, e.pos.z, x1, z1, x2, z2)[0] < 1.2 + e.radius;
  }
  const tall = ROAMING.has(z.tag) || z.tag === 'venomcloud' || z.tag === 'steam';
  if (!tall && e.flying) return false;
  if (e.pos.y - z.pos.y > (tall ? 6 : 1.5)) return false;
  return Math.hypot(e.pos.x - z.pos.x, e.pos.z - z.pos.z) < z.radius + e.radius * 0.5;
}

export function stepZones(w: World, dt: number): void {
  for (const z of [...w.zones]) {
    if (!w.zones.includes(z)) continue;
    z.life -= dt;
    if (z.growth) z.radius = Math.min(z.radius + z.growth * dt, 11);

    if (ROAMING.has(z.tag)) moveRoaming(w, z, dt);

    // Periodic effects
    z.tickT -= dt;
    const tick = z.tickT <= 0;
    if (tick) z.tickT = 0.5;
    const src = z.contributors[0] ?? '';

    for (const e of [...w.enemies]) {
      if (e.spawnT > 0 || !inZone(e, z)) continue;
      switch (z.tag) {
        case 'vortex':
        case 'firestorm':
        case 'toxicstorm':
        case 'blizzard':
        case 'stormcell': {
          // pull toward the eye
          if (!e.boss) {
            const dx = z.pos.x - e.pos.x,
              dz = z.pos.z - e.pos.z;
            const d = Math.hypot(dx, dz) || 1;
            const pull = (e.elite ? 3 : 7) * dt;
            e.pos.x += (dx / d) * Math.min(pull, d);
            e.pos.z += (dz / d) * Math.min(pull, d);
          }
          if (tick) {
            const el = z.element;
            damageEnemy(w, e, z.dps * 0.5, el, src, { combo: z.tag !== 'vortex', noCrit: true, statusAmt: z.tag === 'blizzard' ? 2 : 1 });
          }
          break;
        }
        case 'frostpatch':
          e.st.chill = Math.min(99, e.st.chill + 22 * dt);
          break;
        case 'puddle':
          e.st.wet = Math.max(e.st.wet, 1.5);
          e.statusBy.wet = src;
          break;
        case 'steam':
          e.st.blind = Math.max(e.st.blind, 1.5);
          e.st.wet = Math.max(e.st.wet, 3);
          e.statusBy.wet = src;
          break;
        default:
          if (tick && z.dps > 0) damageEnemy(w, e, z.dps * 0.5, z.element, src, { noCrit: true, combo: z.tag === 'electrified' || z.tag === 'magmawall' });
      }
    }

    // Firestorms leave burning trails; thunderheads zap
    if (tick && z.tag === 'firestorm' && w.zoneCount('burning') < 16) {
      const gh = groundHeight(w.room, z.pos.x, z.pos.z, z.pos.y + 1);
      if (gh > -1e9) w.spawnZone({ tag: 'burning', element: 'fire', pos: { x: z.pos.x, y: gh, z: z.pos.z }, radius: 1.8, life: 3, dps: 8, contributors: z.contributors });
    }
    if (z.tag === 'stormcell') {
      z.angle -= dt;
      if (z.angle <= 0) {
        z.angle = 0.45;
        let best: Enemy | null = null;
        let bd = z.radius + 5;
        for (const e of w.enemies) {
          const d = Math.hypot(e.pos.x - z.pos.x, e.pos.z - z.pos.z);
          if (d < bd) {
            bd = d;
            best = e;
          }
        }
        if (best) {
          w.emit({ t: 'bolt', x: z.pos.x, y: z.pos.y + 4.5, z: z.pos.z, x2: best.pos.x, y2: best.pos.y + best.height * 0.5, z2: best.pos.z, el: 'storm' });
          damageEnemy(w, best, 22, 'storm', src, { combo: true });
        }
      }
    }

    if (z.life <= 0) {
      w.removeZone(z);
      // Melting frost leaves water behind (enables Chain Surge)
      if (z.tag === 'frostpatch' && w.zoneCount('puddle') < 16)
        w.spawnZone({ tag: 'puddle', element: 'frost', pos: z.pos, radius: z.radius * 1.05, life: 9, dps: 0, contributors: z.contributors });
      if (z.tag === 'magmawall') {
        w.emit({ t: 'boom', x: z.pos.x, y: z.pos.y + 1, z: z.pos.z, r: 5, el: 'fire', big: 1 });
      }
    }
  }
  zoneZoneReactions(w);
}

function moveRoaming(w: World, z: Zone, dt: number): void {
  // Roaming storms home in on the nearest enemy
  if (z.tag !== 'vortex') {
    let best: Enemy | null = null;
    let bd = 26;
    for (const e of w.enemies) {
      const d = Math.hypot(e.pos.x - z.pos.x, e.pos.z - z.pos.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    const sp = 4.2;
    if (best) {
      const dx = best.pos.x - z.pos.x,
        dz = best.pos.z - z.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      z.vel.x += ((dx / d) * sp - z.vel.x) * Math.min(1, dt * 1.2);
      z.vel.z += ((dz / d) * sp - z.vel.z) * Math.min(1, dt * 1.2);
    } else {
      z.vel.x *= 1 - dt;
      z.vel.z *= 1 - dt;
    }
  }
  const nx = z.pos.x + z.vel.x * dt,
    nz = z.pos.z + z.vel.z * dt;
  // Walls redirect wind
  for (const wz of w.zones) {
    if (wz.tag !== 'wall' && wz.tag !== 'magmawall') continue;
    const [x1, z1, x2, z2] = wallEnds({ x: wz.pos.x, z: wz.pos.z, angle: wz.angle, len: wz.len, thick: 0.6, h: 0 });
    if (segDist2D(nx, nz, x1, z1, x2, z2)[0] < 1.0) {
      const wnx = -Math.sin(wz.angle),
        wnz = Math.cos(wz.angle);
      const dot = z.vel.x * wnx + z.vel.z * wnz;
      z.vel.x -= 2 * dot * wnx;
      z.vel.z -= 2 * dot * wnz;
      return;
    }
  }
  if (!isOnPlatforms(w.room.platforms, nx, nz, 0.5)) {
    // bounce back toward the centre
    const d = Math.hypot(z.pos.x, z.pos.z) || 1;
    const sp = Math.hypot(z.vel.x, z.vel.z);
    z.vel.x = (-z.pos.x / d) * sp;
    z.vel.z = (-z.pos.z / d) * sp;
    return;
  }
  z.pos.x = nx;
  z.pos.z = nz;
  const gh = groundHeight(w.room, nx, nz, z.pos.y + 0.7);
  if (gh > -1e9) z.pos.y = gh;
}

function zoneZoneReactions(w: World): void {
  const zs = w.zones;
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      const a = zs[i],
        b = zs[j];
      if (!a || !b) continue;
      if (a.reacted.includes(b.id)) continue;
      if (a.tag === 'electrified' || b.tag === 'electrified') continue;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
      const reach = a.tag === 'wall' || b.tag === 'wall' ? 0 : a.radius + b.radius * 0.75;
      if (d > reach) continue;
      const m = findCombo({ kind: 'zone', element: a.element, tag: a.tag }, { kind: 'zone', element: b.element, tag: b.tag });
      a.reacted.push(b.id);
      b.reacted.push(a.id);
      if (!m || m.rule.silent) continue;
      const za = m.swapped ? b : a;
      const zb = m.swapped ? a : b;
      applyCombo(w, m, { pos: { x: (a.pos.x + b.pos.x) / 2, y: a.pos.y, z: (a.pos.z + b.pos.z) / 2 }, za, zb, contributors: uniq([...a.contributors, ...b.contributors]) });
      return; // zone list changed; continue next tick
    }
  }
}
