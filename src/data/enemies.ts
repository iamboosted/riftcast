import type { Element, Faction, TelegraphShape } from '../sim/types';

export interface AttackDef {
  /** telegraphed ground attack, ranged projectile volley, or summon */
  kind: 'tele' | 'shoot' | 'summon' | 'charge';
  shape?: TelegraphShape;
  /** distance at which the enemy starts this attack */
  range: number;
  windup: number;
  recover: number;
  cooldown: number;
  damage: number;
  radius?: number;
  r2?: number;
  len?: number;
  width?: number;
  /** cone half-angle in radians */
  arc?: number;
  /** where the telegraph is placed: on self, or at the target */
  at?: 'self' | 'target';
  count?: number;
  speed?: number;
  spread?: number;
  element: Element;
  summon?: string;
  knock?: number;
}

export interface EnemyDef {
  key: string;
  name: string;
  faction: Faction;
  hp: number;
  speed: number;
  radius: number;
  height: number;
  flying?: boolean;
  /** damage multiplier taken per element (1 = neutral) */
  resist: Partial<Record<Element, number>>;
  attacks: AttackDef[];
  elite?: boolean;
  boss?: boolean;
  /** silhouette archetype used by the procedural mesh builder */
  shape: 'brute' | 'spitter' | 'warden' | 'shardling' | 'weaver' | 'queen' | 'sludge' | 'lobber' | 'titan' | 'kiln' | 'prism';
  /** preferred distance from target (ranged units hang back) */
  keepAway?: number;
  score: number;
}

export interface FactionDef {
  id: Faction;
  name: string;
  desc: string;
  weak: Element[];
  resists: Element[];
  color: number;
  accent: number;
  grunts: string[];
  ranged: string[];
  elites: string[];
}

export const FACTIONS: Record<Exclude<Faction, 'boss'>, FactionDef> = {
  cinder: {
    id: 'cinder',
    name: 'Cinderborn',
    desc: 'Kiln-fired husks of slag and ember.',
    weak: ['frost', 'gale'],
    resists: ['fire'],
    color: 0x2a1a14,
    accent: 0xff5a1a,
    grunts: ['husk'],
    ranged: ['spitter'],
    elites: ['warden'],
  },
  glass: {
    id: 'glass',
    name: 'Glasswing Swarm',
    desc: 'Singing crystal predators that dive in flocks.',
    weak: ['stone', 'storm'],
    resists: ['frost'],
    color: 0x9fdcff,
    accent: 0xb6f2ff,
    grunts: ['shardling'],
    ranged: ['weaver'],
    elites: ['queen'],
  },
  mire: {
    id: 'mire',
    name: 'Mirehollow',
    desc: 'Bog-spawned ooze wrapped around old bones.',
    weak: ['storm', 'fire'],
    resists: ['venom'],
    color: 0x1f3a24,
    accent: 0xb7ff4a,
    grunts: ['sludge'],
    ranged: ['lobber'],
    elites: ['titan'],
  },
};

export const ENEMIES: Record<string, EnemyDef> = {
  // ---- Cinderborn ----
  husk: {
    key: 'husk', name: 'Slag Husk', faction: 'cinder', hp: 70, speed: 4.2, radius: 0.7, height: 1.9, shape: 'brute', score: 10,
    resist: { fire: 0.4, frost: 1.5, gale: 1.3 },
    attacks: [{ kind: 'tele', shape: 'circle', at: 'self', range: 2.6, windup: 0.75, recover: 0.6, cooldown: 1.6, damage: 14, radius: 2.4, element: 'fire', knock: 5 }],
  },
  spitter: {
    key: 'spitter', name: 'Ember Spitter', faction: 'cinder', hp: 48, speed: 3.4, radius: 0.6, height: 1.6, shape: 'spitter', keepAway: 11, score: 12,
    resist: { fire: 0.4, frost: 1.5, gale: 1.3 },
    attacks: [{ kind: 'tele', shape: 'circle', at: 'target', range: 17, windup: 1.1, recover: 0.8, cooldown: 2.6, damage: 13, radius: 2.2, element: 'fire' }],
  },
  warden: {
    key: 'warden', name: 'Kiln Warden', faction: 'cinder', hp: 420, speed: 3.1, radius: 1.3, height: 3.4, shape: 'warden', elite: true, score: 60,
    resist: { fire: 0.4, frost: 1.4, gale: 1.2 },
    attacks: [
      { kind: 'tele', shape: 'ring', at: 'self', range: 6, windup: 1.0, recover: 0.8, cooldown: 3.5, damage: 22, radius: 7, r2: 3.2, element: 'fire', knock: 8 },
      { kind: 'tele', shape: 'line', at: 'self', range: 14, windup: 0.9, recover: 0.7, cooldown: 3, damage: 20, len: 16, width: 2.6, element: 'fire' },
      { kind: 'tele', shape: 'circle', at: 'self', range: 3.2, windup: 0.7, recover: 0.5, cooldown: 2, damage: 18, radius: 3.4, element: 'fire', knock: 6 },
    ],
  },
  // ---- Glasswing ----
  shardling: {
    key: 'shardling', name: 'Shardling', faction: 'glass', hp: 34, speed: 6.8, radius: 0.5, height: 0.8, flying: true, shape: 'shardling', score: 8,
    resist: { frost: 0.4, stone: 1.6, storm: 1.3 },
    attacks: [{ kind: 'charge', shape: 'line', at: 'self', range: 9, windup: 0.6, recover: 0.7, cooldown: 2.2, damage: 11, len: 9, width: 1.4, element: 'frost', speed: 22 }],
  },
  weaver: {
    key: 'weaver', name: 'Prism Weaver', faction: 'glass', hp: 55, speed: 3.6, radius: 0.7, height: 1.4, flying: true, shape: 'weaver', keepAway: 12, score: 12,
    resist: { frost: 0.4, stone: 1.6, storm: 1.3 },
    attacks: [{ kind: 'shoot', range: 18, windup: 0.8, recover: 0.6, cooldown: 2.4, damage: 9, count: 3, speed: 15, spread: 0.18, element: 'frost' }],
  },
  queen: {
    key: 'queen', name: 'Facet Queen', faction: 'glass', hp: 380, speed: 3.8, radius: 1.3, height: 2.2, flying: true, shape: 'queen', elite: true, keepAway: 7, score: 60,
    resist: { frost: 0.4, stone: 1.5, storm: 1.25 },
    attacks: [
      { kind: 'tele', shape: 'cone', at: 'self', range: 9, windup: 0.9, recover: 0.6, cooldown: 3, damage: 20, radius: 11, arc: 0.55, element: 'frost' },
      { kind: 'summon', range: 30, windup: 1.0, recover: 0.6, cooldown: 9, damage: 0, count: 3, summon: 'shardling', element: 'frost' },
      { kind: 'shoot', range: 18, windup: 0.7, recover: 0.5, cooldown: 2.6, damage: 8, count: 7, speed: 14, spread: 0.32, element: 'frost' },
    ],
  },
  // ---- Mirehollow ----
  sludge: {
    key: 'sludge', name: 'Sludgeling', faction: 'mire', hp: 85, speed: 3.0, radius: 0.8, height: 1.3, shape: 'sludge', score: 10,
    resist: { venom: 0.4, storm: 1.5, fire: 1.25 },
    attacks: [{ kind: 'tele', shape: 'cone', at: 'self', range: 3.5, windup: 0.8, recover: 0.7, cooldown: 1.8, damage: 15, radius: 4, arc: 0.7, element: 'venom' }],
  },
  lobber: {
    key: 'lobber', name: 'Spore Lobber', faction: 'mire', hp: 50, speed: 2.8, radius: 0.7, height: 1.7, shape: 'lobber', keepAway: 12, score: 12,
    resist: { venom: 0.4, storm: 1.5, fire: 1.25 },
    attacks: [{ kind: 'tele', shape: 'circle', at: 'target', range: 17, windup: 1.2, recover: 0.8, cooldown: 3, damage: 12, radius: 2.8, element: 'venom' }],
  },
  titan: {
    key: 'titan', name: 'Bog Titan', faction: 'mire', hp: 520, speed: 2.5, radius: 1.5, height: 3.6, shape: 'titan', elite: true, score: 60,
    resist: { venom: 0.4, storm: 1.4, fire: 1.2 },
    attacks: [
      { kind: 'tele', shape: 'circle', at: 'self', range: 4, windup: 1.0, recover: 0.8, cooldown: 2.6, damage: 24, radius: 4.5, element: 'venom', knock: 8 },
      { kind: 'tele', shape: 'circle', at: 'target', range: 16, windup: 1.2, recover: 0.6, cooldown: 3.5, damage: 16, radius: 3, count: 3, element: 'venom' },
      { kind: 'summon', range: 30, windup: 1.0, recover: 0.6, cooldown: 10, damage: 0, count: 2, summon: 'sludge', element: 'venom' },
    ],
  },
  // ---- Bosses (patterns driven by sim/boss.ts) ----
  kiln: {
    key: 'kiln', name: 'Ignavar, the Kiln Heart', faction: 'boss', hp: 2600, speed: 2.2, radius: 2.4, height: 5.5, shape: 'kiln', boss: true, score: 300,
    resist: { fire: 0.3, frost: 1.3, gale: 1.1 },
    attacks: [],
  },
  prism: {
    key: 'prism', name: 'Sylvara, the Hollow Prism', faction: 'boss', hp: 2300, speed: 3.2, radius: 2.0, height: 5, flying: true, shape: 'prism', boss: true, score: 300,
    resist: { frost: 0.4, stone: 1.35, storm: 1.15 },
    attacks: [],
  },
};

export const BOSS_KEYS = ['kiln', 'prism'] as const;
