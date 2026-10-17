import type { World } from './world';
import type { Enemy } from './types';
import { ENEMIES } from '../data/enemies';
import { addTelegraph, nearestPlayer, spawnEnemyProjectile } from './ai';
import { groundHeight } from './room';
import { resolveCollisions } from './movement';
import { angleDiff } from './vec';

type Pattern = (w: World, b: Enemy) => number; // returns recover time

const KILN_PHASES: string[][] = [
  ['slam', 'spokes', 'volley', 'slam', 'volley'],
  ['spokes2', 'summon', 'ring', 'volley', 'slam'],
  ['meteors', 'ring', 'spokes2', 'slam', 'meteors', 'volley'],
];
const PRISM_PHASES: string[][] = [
  ['beams', 'shardring', 'teleport', 'beams', 'cones'],
  ['beams5', 'cones', 'summon', 'shardring', 'teleport'],
  ['cage', 'shardring2', 'beams5', 'teleport', 'cones', 'shardring'],
];

const alivePlayers = (w: World) => [...w.players.values()].filter((p) => p.state === 'alive');

const PATTERNS: Record<string, Pattern> = {
  slam: (w, b) => {
    addTelegraph(w, b.id, 'circle', b.pos.x, b.pos.z, 0, { radius: 7.5, windup: 1.3, damage: 30, element: 'fire', knock: 13 }, 0);
    return 2.0;
  },
  spokes: (w, b) => {
    const off = w.rng.range(0, Math.PI);
    for (let i = 0; i < 6; i++) addTelegraph(w, b.id, 'line', b.pos.x, b.pos.z, 0, { len: 26, width: 2.6, windup: 1.4, damage: 26, element: 'fire', knock: 6 }, off + (i / 6) * Math.PI * 2);
    return 2.1;
  },
  spokes2: (w, b) => {
    const off = w.rng.range(0, Math.PI);
    for (let i = 0; i < 8; i++) addTelegraph(w, b.id, 'line', b.pos.x, b.pos.z, 0, { len: 26, width: 2.4, windup: 1.3, damage: 26, element: 'fire' }, off + (i / 8) * Math.PI * 2);
    for (let i = 0; i < 8; i++) addTelegraph(w, b.id, 'line', b.pos.x, b.pos.z, 0, { len: 26, width: 2.4, windup: 2.3, damage: 26, element: 'fire' }, off + ((i + 0.5) / 8) * Math.PI * 2);
    return 2.8;
  },
  volley: (w, b) => {
    for (const p of alivePlayers(w)) {
      addTelegraph(w, b.id, 'circle', p.pos.x + p.vel.x * 0.4, p.pos.z + p.vel.z * 0.4, p.pos.y, { radius: 2.8, windup: 1.1, damage: 22, element: b.kind === 'kiln' ? 'fire' : 'frost' }, 0);
      for (let i = 0; i < 2; i++)
        addTelegraph(w, b.id, 'circle', p.pos.x + w.rng.range(-5, 5), p.pos.z + w.rng.range(-5, 5), p.pos.y, { radius: 2.4, windup: 1.4, damage: 18, element: b.kind === 'kiln' ? 'fire' : 'frost' }, 0);
    }
    return 1.6;
  },
  ring: (w, b) => {
    addTelegraph(w, b.id, 'ring', b.pos.x, b.pos.z, 0, { radius: 15, r2: 6, windup: 1.4, damage: 28, element: 'fire', knock: 8 }, 0);
    addTelegraph(w, b.id, 'ring', b.pos.x, b.pos.z, 0, { radius: 26, r2: 16, windup: 2.3, damage: 28, element: 'fire', knock: 8 }, 0);
    return 2.6;
  },
  summon: (w, b) => {
    const key = b.kind === 'kiln' ? 'husk' : 'shardling';
    const n = 1 + Math.min(3, alivePlayers(w).length);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const s = w.spawnEnemy(key, { x: b.pos.x + Math.cos(a) * 6, y: 0, z: b.pos.z + Math.sin(a) * 6 });
      s.spawnT = 0.8;
    }
    return 1.6;
  },
  meteors: (w, b) => {
    const R = w.room.platforms[0].r * 0.9;
    for (let i = 0; i < 12; i++) {
      const a = w.rng.range(0, Math.PI * 2),
        r = Math.sqrt(w.rng.next()) * R;
      addTelegraph(w, b.id, 'circle', Math.cos(a) * r, Math.sin(a) * r, 0, { radius: 2.8, windup: 1.4 + i * 0.09, damage: 30, element: 'fire', knock: 6 }, 0);
    }
    for (const p of alivePlayers(w)) addTelegraph(w, b.id, 'circle', p.pos.x, p.pos.z, p.pos.y, { radius: 3, windup: 1.5, damage: 30, element: 'fire' }, 0);
    return 2.4;
  },
  beams: (w, b) => {
    for (const p of alivePlayers(w)) {
      const a = Math.atan2(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      addTelegraph(w, b.id, 'line', b.pos.x, b.pos.z, 0, { len: 34, width: 2.2, windup: 1.2, damage: 26, element: 'frost', knock: 5 }, a);
    }
    return 1.6;
  },
  beams5: (w, b) => {
    const off = b.data.spin = (b.data.spin ?? 0) + 0.45;
    for (let i = 0; i < 5; i++) addTelegraph(w, b.id, 'line', b.pos.x, b.pos.z, 0, { len: 34, width: 2.2, windup: 1.4, damage: 26, element: 'storm' }, off + (i / 5) * Math.PI * 2);
    for (let i = 0; i < 5; i++) addTelegraph(w, b.id, 'line', b.pos.x, b.pos.z, 0, { len: 34, width: 2.2, windup: 2.2, damage: 26, element: 'storm' }, off + 0.32 + (i / 5) * Math.PI * 2);
    return 2.5;
  },
  shardring: (w, b) => {
    const n = 20;
    const off = w.rng.next();
    for (let i = 0; i < n; i++) spawnEnemyProjectile(w, b, off + (i / n) * Math.PI * 2, 10, 0, 16, 'frost', groundHeight(w.room, b.pos.x, b.pos.z, 50) + 1.0);
    return 1.5;
  },
  shardring2: (w, b) => {
    PATTERNS.shardring(w, b);
    w.later(0.7, () => {
      if (w.enemies.includes(b)) PATTERNS.shardring(w, b);
    });
    return 2.2;
  },
  teleport: (w, b) => {
    const R = w.room.platforms[0].r * 0.6;
    const a = w.rng.range(0, Math.PI * 2);
    w.emit({ t: 'boom', x: b.pos.x, y: b.pos.y, z: b.pos.z, r: 3, el: 'frost' });
    b.pos.x = Math.cos(a) * R * w.rng.range(0.2, 1);
    b.pos.z = Math.sin(a) * R * w.rng.range(0.2, 1);
    w.emit({ t: 'boom', x: b.pos.x, y: b.pos.y, z: b.pos.z, r: 3, el: 'frost' });
    return 0.9;
  },
  cones: (w, b) => {
    for (const p of alivePlayers(w)) {
      const a = Math.atan2(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      addTelegraph(w, b.id, 'cone', b.pos.x, b.pos.z, 0, { radius: 17, arc: 0.42, windup: 1.3, damage: 26, element: 'frost' }, a);
    }
    return 1.8;
  },
  cage: (w, b) => {
    addTelegraph(w, b.id, 'ring', b.pos.x, b.pos.z, 0, { radius: 34, r2: 5.5, windup: 2.6, damage: 40, element: 'storm', knock: 10 }, 0);
    return 3.2;
  },
};

export function stepBoss(w: World, b: Enemy, dt: number): void {
  const def = ENEMIES[b.kind];
  const frac = b.hp / b.maxHp;
  const want = frac < 0.33 ? 3 : frac < 0.66 ? 2 : 1;
  if (want > b.phase) {
    b.phase = want;
    b.state = 'recover';
    b.stateT = 2.2;
    b.data.step = 0;
    w.telegraphs = w.telegraphs.filter((t) => t.owner !== b.id);
    w.emit({ t: 'boss', id: b.id, phase: b.phase, name: def.name });
    addTelegraph(w, b.id, 'circle', b.pos.x, b.pos.z, 0, { radius: 9, windup: 1.2, damage: 18, element: b.kind === 'kiln' ? 'fire' : 'storm', knock: 16 }, 0);
    return;
  }
  b.stateT -= dt;
  const tgt = nearestPlayer(w, b.pos.x, b.pos.z);
  // drift / walk
  if (tgt) {
    const dx = tgt.pos.x - b.pos.x,
      dz = tgt.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const ty = Math.atan2(dx, dz);
    b.yaw += Math.max(-dt * 1.5, Math.min(dt * 1.5, angleDiff(b.yaw, ty)));
    const keep = b.kind === 'prism' ? 9 : 4;
    const sp = (b.state === 'windup' ? 0.2 : 1) * def.speed * (b.phase === 3 ? 1.25 : 1);
    if (d > keep) {
      const nx = b.pos.x + (dx / d) * sp * dt,
        nz = b.pos.z + (dz / d) * sp * dt;
      if (Math.hypot(nx, nz) < w.room.platforms[0].r - 3) {
        b.pos.x = nx;
        b.pos.z = nz;
      }
    }
  }
  if (b.flying) {
    b.pos.y += (3.2 + Math.sin(w.time * 1.3) * 0.5 - b.pos.y) * Math.min(1, dt * 2);
  } else {
    const gh = groundHeight(w.room, b.pos.x, b.pos.z, b.pos.y + 0.6);
    if (gh > -1e9) b.pos.y = gh;
    resolveCollisions(b, b.radius, w.colliders);
  }
  if (b.stateT > 0) return;
  const list = (b.kind === 'kiln' ? KILN_PHASES : PRISM_PHASES)[b.phase - 1];
  const step = (b.data.step ?? 0) % list.length;
  b.data.step = step + 1;
  const pat = list[step];
  if (pat === 'summon' && w.enemies.length > 12) {
    b.stateT = 0.3;
    return;
  }
  b.state = 'windup';
  const rec = PATTERNS[pat](w, b);
  b.stateT = rec * (b.phase === 3 ? 0.78 : b.phase === 2 ? 0.9 : 1);
}
