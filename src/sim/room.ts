import { Rng, hash2 } from './rng';
import type { Faction } from './types';
import type { V3 } from './vec';
import { BOSS_KEYS, FACTIONS } from '../data/enemies';

export interface Platform {
  x: number;
  z: number;
  r: number;
  top: number;
  /** visual seed for edge noise */
  seed: number;
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
  h: number;
  kind: 'pillar' | 'broken' | 'obelisk';
  seed: number;
}

export type RoomKind = 'start' | 'combat' | 'elite' | 'boss';

export interface Wave {
  enemies: string[];
}

export interface Room {
  seed: number;
  index: number;
  kind: RoomKind;
  faction: Exclude<Faction, 'boss'>;
  boss: string | null;
  theme: number;
  platforms: Platform[];
  obstacles: Obstacle[];
  spawns: V3[];
  playerSpawns: V3[];
  waves: Wave[];
  /** rune pickups placed in the room */
  runes: { x: number; z: number; rune: string }[];
  bound: number;
}

export const ROOM_SEQUENCE: RoomKind[] = ['combat', 'combat', 'elite', 'combat', 'combat', 'elite', 'boss'];
export const THEMES = 4;

const FACTION_KEYS: Exclude<Faction, 'boss'>[] = ['cinder', 'glass', 'mire'];

/** Deterministic room generation from (runSeed, index). Pure data, no rendering. */
export function generateRoom(runSeed: number, index: number, playerCount: number): Room {
  const seed = hash2(runSeed, index + 1);
  const rng = new Rng(seed);
  const kind: RoomKind = ROOM_SEQUENCE[Math.min(index, ROOM_SEQUENCE.length - 1)];
  const faction = rng.pick(FACTION_KEYS);
  const theme = (hash2(runSeed, 77) + index) % THEMES;
  const platforms: Platform[] = [];
  const obstacles: Obstacle[] = [];

  const mainR = kind === 'boss' ? 25 : rng.range(16, 20);
  platforms.push({ x: 0, z: 0, r: mainR, top: 0, seed: rng.int(0, 1e6) });

  // Lobes extend the main island into an organic shape
  const lobes = kind === 'boss' ? 0 : rng.int(3, 5);
  const lobeAngle0 = rng.range(0, Math.PI * 2);
  for (let i = 0; i < lobes; i++) {
    const a = lobeAngle0 + (i / lobes) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const r = rng.range(6, 9.5);
    const d = mainR + r * rng.range(0.15, 0.45);
    platforms.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r, top: 0, seed: rng.int(0, 1e6) });
  }

  // Raised ledges: reachable with a double jump
  const ledges = kind === 'boss' ? 4 : rng.int(2, 3);
  for (let i = 0; i < ledges; i++) {
    const a = (kind === 'boss' ? i / ledges : rng.next()) * Math.PI * 2 + (kind === 'boss' ? Math.PI / 4 : 0);
    const d = kind === 'boss' ? mainR * 0.72 : rng.range(mainR * 0.45, mainR * 0.8);
    platforms.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: rng.range(3.2, 4.6), top: rng.range(1.7, 2.3), seed: rng.int(0, 1e6) });
  }

  // Pillars, avoiding the player spawn area (south) and ledges
  const pillarCount = kind === 'boss' ? 8 : rng.int(5, 9);
  let attempts = 0;
  while (obstacles.length < pillarCount && attempts++ < 200) {
    let x: number, z: number;
    if (kind === 'boss') {
      const a = (obstacles.length / pillarCount) * Math.PI * 2 + Math.PI / 8;
      x = Math.cos(a) * mainR * 0.9;
      z = Math.sin(a) * mainR * 0.9;
    } else {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(4, mainR + 3);
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
    }
    if (Math.hypot(x, z - mainR * 0.55) < 6) continue;
    if (!isOnPlatforms(platforms, x, z, 1.4)) continue;
    if (platforms.some((p) => p.top > 0 && Math.hypot(p.x - x, p.z - z) < p.r + 1.5)) continue;
    if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 4)) continue;
    const kindRoll = rng.next();
    obstacles.push({
      x,
      z,
      r: rng.range(0.7, 1.2),
      h: rng.range(3, 8),
      kind: kindRoll < 0.5 ? 'pillar' : kindRoll < 0.8 ? 'broken' : 'obelisk',
      seed: rng.int(0, 1e6),
    });
  }

  // Enemy spawn points around the far rim
  const spawns: V3[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10 - 0.5) * Math.PI * 1.7 + rng.range(-0.1, 0.1);
    const d = mainR * rng.range(0.6, 0.92);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    spawns.push({ x, y: 0, z });
  }
  const playerSpawns: V3[] = [0, 1, 2, 3].map((i) => ({ x: (i - 1.5) * 2.2, y: 0, z: mainR * 0.55 }));

  const waves = buildWaves(rng, kind, faction, index, playerCount);
  const boss = kind === 'boss' ? BOSS_KEYS[hash2(runSeed, 99) % BOSS_KEYS.length] : null;

  const runes: Room['runes'] = [];
  if (kind !== 'boss' && rng.chance(0.55)) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(5, mainR * 0.6);
    runes.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, rune: rng.pick(['blink', 'glide', 'rocket']) });
  }

  let bound = 0;
  for (const p of platforms) bound = Math.max(bound, Math.hypot(p.x, p.z) + p.r);

  return { seed, index, kind, faction, boss, theme, platforms, obstacles, spawns, playerSpawns, waves, runes, bound };
}

function buildWaves(rng: Rng, kind: RoomKind, faction: Exclude<Faction, 'boss'>, index: number, players: number): Wave[] {
  const f = FACTIONS[faction];
  const waves: Wave[] = [];
  if (kind === 'boss') return [{ enemies: [] }];
  const waveCount = kind === 'elite' ? 2 : 2 + (index >= 3 ? 1 : 0);
  const sizeBase = 4 + Math.floor(index * 0.8) + Math.round((players - 1) * 1.5);
  for (let w = 0; w < waveCount; w++) {
    const enemies: string[] = [];
    const n = sizeBase + w;
    for (let i = 0; i < n; i++) enemies.push(rng.chance(0.65) ? rng.pick(f.grunts) : rng.pick(f.ranged));
    if (kind === 'elite' && w === waveCount - 1) {
      enemies.push(rng.pick(f.elites));
      if (players >= 3) enemies.push(rng.pick(f.elites));
    }
    waves.push({ enemies });
  }
  return waves;
}

export function isOnPlatforms(platforms: readonly Platform[], x: number, z: number, margin = 0): boolean {
  for (const p of platforms) if (Math.hypot(x - p.x, z - p.z) < p.r - margin) return true;
  return false;
}

/** Highest platform top under (x,z) that is at or below y + step. -Infinity means void. */
export function groundHeight(room: Room, x: number, z: number, y: number, step = 0.6): number {
  let h = -Infinity;
  for (const p of room.platforms) {
    if (p.top > y + step) continue;
    const dx = x - p.x,
      dz = z - p.z;
    if (dx * dx + dz * dz < p.r * p.r && p.top > h) h = p.top;
  }
  return h;
}

/** Any platform top at (x,z), ignoring height. */
export function topAt(room: Room, x: number, z: number): number {
  let h = -Infinity;
  for (const p of room.platforms) {
    const dx = x - p.x,
      dz = z - p.z;
    if (dx * dx + dz * dz < p.r * p.r && p.top > h) h = p.top;
  }
  return h;
}
