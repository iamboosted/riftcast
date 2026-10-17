import type { V3 } from './vec';

export type Element = 'fire' | 'frost' | 'storm' | 'gale' | 'stone' | 'venom';
export const ELEMENTS: readonly Element[] = ['fire', 'frost', 'storm', 'gale', 'stone', 'venom'];
export type SpellSlot = 'primary' | 'heavy' | 'signature';
export type Team = 'player' | 'enemy';
export type Rune = 'none' | 'blink' | 'glide' | 'rocket';

export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;

/** Buttons held this tick. Edge-triggered actions use monotonically increasing counters (robust to packet loss). */
export const BTN_PRIMARY = 1;
export const BTN_HEAVY = 2;
export const BTN_JUMP = 4;

export interface PlayerInput {
  seq: number;
  /** World-space desired move direction (already rotated by camera), magnitude 0..1. */
  mx: number;
  mz: number;
  yaw: number;
  pitch: number;
  /** World-space point the player is aiming at (aim assist already applied client-side). */
  ax: number;
  ay: number;
  az: number;
  buttons: number;
  /** Edge counters (mod 256). */
  sig: number;
  dash: number;
  jump: number;
  swap: number;
}

export const emptyInput = (): PlayerInput => ({
  seq: 0,
  mx: 0,
  mz: 0,
  yaw: 0,
  pitch: 0,
  ax: 0,
  ay: 0,
  az: -10,
  buttons: 0,
  sig: 0,
  dash: 0,
  jump: 0,
  swap: 0,
});

export type PlayerState = 'alive' | 'downed' | 'dead' | 'spectating';

/** The subset of player state used by movement (shared by host sim and client prediction). */
export interface MoveState {
  pos: V3;
  vel: V3;
  yaw: number;
  grounded: boolean;
  jumpsUsed: number;
  hoverFuel: number;
  hovering: boolean;
  dashTime: number;
  dashCd: number;
  dashCharges: number;
  dashDirX: number;
  dashDirZ: number;
  lastJump: number;
  lastDash: number;
  safeX: number;
  safeZ: number;
  safeY: number;
  rune: Rune;
  /** set while airborne after a rocket jump */
  rocket: boolean;
}

export interface Stats {
  dmgMul: number;
  elemMul: Record<Element, number>;
  extraProjectiles: number;
  splitOnHit: number;
  pierce: number;
  zoneDuration: number;
  zoneRadius: number;
  comboDamage: number;
  comboRadius: number;
  moveSpeed: number;
  dashCharges: number;
  sigCooldown: number;
  chargeSpeed: number;
  maxHp: number;
  healOnCombo: number;
  critChance: number;
  projSpeed: number;
  chainCount: number;
  reviveSpeed: number;
  damageTaken: number;
  statusPower: number;
  explodeOnKill: number;
}

export interface Player extends MoveState {
  id: string;
  name: string;
  color: number;
  pitch: number;
  hp: number;
  maxHp: number;
  state: PlayerState;
  gauntlets: [Element, Element];
  active: 0 | 1;
  cd: { primary: number; heavy: number; signature: number }[];
  charge: number;
  charging: boolean;
  lastSig: number;
  lastSwap: number;
  lastSeq: number;
  iframes: number;
  bleedout: number;
  reviveProgress: number;
  secondWind: number;
  boons: string[];
  stats: Stats;
  castSeq: number;
  /** Per-run stats */
  dmgDealt: number;
  kills: number;
  combos: number;
  downs: number;
  lastHitBy: number;
  ready: boolean;
  /** recently cast flash (presentation) */
  castFlash: number;
  hurtFlash: number;
}

export type Faction = 'cinder' | 'glass' | 'mire' | 'boss';

export type EnemyState = 'idle' | 'chase' | 'windup' | 'attack' | 'recover' | 'stunned' | 'spawning' | 'dying';

export interface Statuses {
  burn: number; // seconds remaining
  burnDps: number;
  chill: number; // 0..100
  frozen: number; // seconds
  shock: number;
  wet: number;
  poison: number; // stacks
  poisonT: number;
  blind: number;
  stagger: number;
}

export interface Enemy {
  id: number;
  kind: string;
  faction: Faction;
  pos: V3;
  vel: V3;
  yaw: number;
  hp: number;
  maxHp: number;
  radius: number;
  height: number;
  flying: boolean;
  state: EnemyState;
  stateT: number;
  attackIdx: number;
  attackCds: number[];
  target: string | null;
  st: Statuses;
  elite: boolean;
  boss: boolean;
  phase: number;
  hitFlash: number;
  lastHitEl: Element | null;
  /** who has damaged this enemy recently (for kill credit) */
  lastHitBy: string | null;
  seed: number;
  dmgMul: number;
  /** generic per-enemy scratch values for bosses */
  data: Record<string, number>;
  spawnT: number;
  /** who applied combo-relevant statuses (for combo credit) */
  statusBy: Partial<Record<'frozen' | 'wet' | 'burn' | 'poison' | 'shock', string>>;
  /** knockback velocity applied over a few ticks */
  kx: number;
  kz: number;
  ky: number;
}

export interface Projectile {
  id: number;
  team: Team;
  owner: string; // player id or 'e<id>'
  element: Element;
  spell: string;
  pos: V3;
  vel: V3;
  gravity: number;
  radius: number;
  damage: number;
  life: number;
  pierce: number;
  hitIds: number[];
  charge: number;
  /** cast key for client-side matching */
  ck: string;
  bounces: number;
  split: number;
  data: number;
}

export type ZoneTag =
  | 'burning'
  | 'frostpatch'
  | 'puddle'
  | 'venompool'
  | 'venomcloud'
  | 'vortex'
  | 'firestorm'
  | 'toxicstorm'
  | 'blizzard'
  | 'stormcell'
  | 'steam'
  | 'wall'
  | 'magmawall'
  | 'electrified'
  | 'shards';

export interface Zone {
  id: number;
  tag: ZoneTag;
  element: Element;
  pos: V3;
  vel: V3;
  radius: number;
  life: number;
  maxLife: number;
  dps: number;
  contributors: string[];
  /** wall segment: from pos along angle, half-length = len */
  angle: number;
  len: number;
  /** zone ids already reacted with (prevents repeated triggering) */
  reacted: number[];
  tickT: number;
  growth: number;
}

export type TelegraphShape = 'circle' | 'line' | 'cone' | 'ring';

export interface Telegraph {
  id: number;
  shape: TelegraphShape;
  x: number;
  z: number;
  y: number;
  r: number;
  r2: number;
  angle: number;
  len: number;
  width: number;
  t: number;
  dur: number;
  dmg: number;
  element: Element;
  owner: number;
  knock: number;
}

export type PickupKind = 'rune' | 'heal' | 'gauntlet' | 'shard';
export interface Pickup {
  id: number;
  kind: PickupKind;
  value: string;
  pos: V3;
  t: number;
}

export type RunPhase = 'lobby' | 'room' | 'cleared' | 'reward' | 'victory' | 'defeat';

/** Events emitted by the authoritative sim; consumed by presentation (VFX/audio/UI) and replicated to clients. */
export type SimEvent =
  | { t: 'cast'; pid: string; el: Element; slot: SpellSlot; x: number; y: number; z: number; dx: number; dy: number; dz: number; c: number }
  | { t: 'proj'; id: number; el: Element; sp: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; g: number; r: number; team: Team; ck: string; life: number }
  | { t: 'projEnd'; id: number; x: number; y: number; z: number; hit: 0 | 1 | 2 }
  | { t: 'projBounce'; id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { t: 'hit'; id: number; x: number; y: number; z: number; amt: number; el: Element; crit: 0 | 1; pl?: 1 }
  | { t: 'boom'; x: number; y: number; z: number; r: number; el: Element; big?: 1 }
  | { t: 'nova'; x: number; y: number; z: number; r: number; el: Element }
  | { t: 'bolt'; x: number; y: number; z: number; x2: number; y2: number; z2: number; el: Element; w?: number }
  | { t: 'strike'; x: number; y: number; z: number; r: number; el: Element }
  | { t: 'combo'; key: string; name: string; x: number; y: number; z: number; r: number; pids: string[] }
  | { t: 'kill'; id: number; x: number; y: number; z: number; el: Element | null; kind: string }
  | { t: 'tele'; id: number; x: number; z: number; el: Element; shape: TelegraphShape }
  | { t: 'down'; pid: string }
  | { t: 'revive'; pid: string; by: string }
  | { t: 'dash'; pid: string; x: number; y: number; z: number; blink?: 1; x2?: number; z2?: number }
  | { t: 'jump'; pid: string; n: number; rocket?: 1 }
  | { t: 'hurt'; pid: string; amt: number; el: Element }
  | { t: 'swap'; pid: string; el: Element }
  | { t: 'pickup'; pid: string; kind: PickupKind; value: string; x: number; y: number; z: number }
  | { t: 'boss'; id: number; phase: number; name: string }
  | { t: 'spawn'; id: number; x: number; y: number; z: number; faction: Faction }
  | { t: 'shatter'; x: number; y: number; z: number }
  | { t: 'room'; idx: number; kind: string }
  | { t: 'clear' }
  | { t: 'wallRise'; id: number }
  | { t: 'fall'; pid: string }
  | { t: 'ping'; pid: string; kind: PingKind; x: number; y: number; z: number };

export type PingKind = 'here' | 'attack' | 'help' | 'combo';
