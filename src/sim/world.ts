import { Rng } from './rng';
import type {
  Element,
  Enemy,
  Pickup,
  Player,
  PlayerInput,
  Projectile,
  RunPhase,
  SimEvent,
  Stats,
  Telegraph,
  Zone,
  ZoneTag,
} from './types';
import { SIM_DT, emptyInput } from './types';
import { generateRoom, type Room, ROOM_SEQUENCE, groundHeight } from './room';
import type { Colliders, WallSeg } from './movement';
import { newMoveState } from './movement';
import { aggregateBoons, baseStats, rollBoons } from '../data/boons';
import { ENEMIES } from '../data/enemies';
import { stepPlayers } from './players';
import { stepProjectiles } from './projectiles';
import { stepZones } from './zones';
import { stepEnemies, stepTelegraphs } from './ai';
import { ELEMENTS } from './types';
import { PLAYER_COLORS } from '../data/elements';
import { V3 } from './vec';

export interface RunInfo {
  seed: number;
  roomIndex: number;
  phase: RunPhase;
  phaseT: number;
  waveIdx: number;
  waveDelay: number;
  offers: Record<string, string[]>;
  teamOffers: string[];
  picks: Record<string, string>;
  votes: Record<string, string>;
  totalRooms: number;
  bossId: number;
  shardsEarned: number;
  unlockedBoons: string[];
}

export interface NewPlayerOpts {
  id: string;
  name: string;
  gauntlets: [Element, Element];
  colorIdx?: number;
}

/**
 * Host-authoritative game state. Pure TypeScript (no rendering) so it can run headless in tests.
 */
export class World {
  tick = 0;
  time = 0;
  rng: Rng;
  room!: Room;
  players = new Map<string, Player>();
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  zones: Zone[] = [];
  telegraphs: Telegraph[] = [];
  pickups: Pickup[] = [];
  events: SimEvent[] = [];
  nextId = 1;
  teamBoons: string[] = [];
  teamStats: Stats = baseStats();
  inputs = new Map<string, PlayerInput>();
  prevInputs = new Map<string, PlayerInput>();
  run: RunInfo;
  colliders!: Colliders;
  /** enemy damage + hp scaling */
  enemyHpMul = 1;
  enemyDmgMul = 1;
  /** combo debounce per key */
  comboCd = new Map<string, number>();
  /** if true, don't auto-advance from reward without picks (tests can override) */
  autoAdvance = true;
  /** host-only delayed actions (e.g. staggered lightning strikes) */
  scheduled: { t: number; fn: () => void }[] = [];

  constructor(seed: number, unlockedBoons: string[] = []) {
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.run = {
      seed,
      roomIndex: -1,
      phase: 'lobby',
      phaseT: 0,
      waveIdx: 0,
      waveDelay: 0,
      offers: {},
      teamOffers: [],
      picks: {},
      votes: {},
      totalRooms: ROOM_SEQUENCE.length,
      bossId: 0,
      shardsEarned: 0,
      unlockedBoons,
    };
    this.loadRoom(generateRoom(seed, 0, 1), true);
  }

  id(): number {
    return this.nextId++;
  }

  later(delay: number, fn: () => void): void {
    this.scheduled.push({ t: this.time + delay, fn });
  }

  emit(e: SimEvent): void {
    this.events.push(e);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------- players ----------
  addPlayer(o: NewPlayerOpts): Player {
    const spawn = this.room.playerSpawns[this.players.size % this.room.playerSpawns.length];
    const ms = newMoveState(spawn.x, spawn.y, spawn.z);
    const colorIdx = o.colorIdx ?? this.players.size;
    const p: Player = {
      ...ms,
      id: o.id,
      name: o.name,
      color: PLAYER_COLORS[colorIdx % PLAYER_COLORS.length],
      pitch: 0,
      hp: 100,
      maxHp: 100,
      state: this.run.phase === 'lobby' ? 'alive' : 'spectating',
      gauntlets: o.gauntlets,
      active: 0,
      cd: [
        { primary: 0, heavy: 0, signature: 0 },
        { primary: 0, heavy: 0, signature: 0 },
      ],
      charge: 0,
      charging: false,
      lastSig: 0,
      lastSwap: 0,
      lastSeq: 0,
      iframes: 0,
      bleedout: 0,
      reviveProgress: 0,
      secondWind: 1,
      boons: [],
      stats: baseStats(),
      castSeq: 0,
      dmgDealt: 0,
      kills: 0,
      combos: 0,
      downs: 0,
      lastHitBy: 0,
      ready: false,
      castFlash: 0,
      hurtFlash: 0,
    };
    this.players.set(p.id, p);
    this.inputs.set(p.id, emptyInput());
    this.prevInputs.set(p.id, emptyInput());
    this.refreshStats();
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.inputs.delete(id);
    this.prevInputs.delete(id);
    delete this.run.picks[id];
    delete this.run.votes[id];
    delete this.run.offers[id];
    this.refreshStats();
    if (this.run.phase === 'reward') this.checkRewardDone();
  }

  setInput(id: string, input: PlayerInput): void {
    if (this.players.has(id)) this.inputs.set(id, input);
  }

  refreshStats(): void {
    this.teamStats = aggregateBoons(this.teamBoons);
    for (const p of this.players.values()) {
      const s = aggregateBoons([...p.boons, ...this.teamBoons]);
      const hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 1;
      p.stats = s;
      p.maxHp = s.maxHp;
      p.hp = Math.min(p.maxHp, Math.max(p.hp, 0) === 0 && p.state !== 'alive' ? 0 : p.maxHp * hpFrac);
      if (p.dashCharges > s.dashCharges) p.dashCharges = s.dashCharges;
    }
    const n = Math.max(1, this.activePlayerCount());
    const depth = Math.max(0, this.run.roomIndex);
    this.enemyHpMul = (1 + 0.5 * (n - 1)) * (1 + 0.11 * depth) * (n === 1 ? 0.85 : 1);
    this.enemyDmgMul = (1 + 0.09 * depth) * (n === 1 ? 0.8 : 1);
  }

  activePlayerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.state !== 'spectating') n++;
    return n || this.players.size;
  }

  // ---------- rooms / run ----------
  loadRoom(room: Room, initial = false): void {
    this.room = room;
    this.enemies = [];
    this.projectiles = [];
    this.zones = [];
    this.telegraphs = [];
    this.pickups = [];
    this.scheduled = [];
    this.run.waveIdx = 0;
    this.run.waveDelay = 1.6;
    for (const r of room.runes) this.pickups.push({ id: this.id(), kind: 'rune', value: r.rune, pos: { x: r.x, y: groundHeight(room, r.x, r.z, 10), z: r.z }, t: 0 });
    this.rebuildColliders();
    if (!initial) {
      let i = 0;
      for (const p of this.players.values()) {
        const s = room.playerSpawns[i++ % room.playerSpawns.length];
        const ms = newMoveState(s.x, s.y, s.z);
        const keepRune = p.rune;
        Object.assign(p, ms);
        p.rune = keepRune;
        p.dashCharges = p.stats.dashCharges;
        if (p.state !== 'alive') {
          p.state = 'alive';
          p.hp = Math.max(1, p.maxHp * 0.35);
        }
        p.charging = false;
        p.charge = 0;
        p.reviveProgress = 0;
        p.ready = false;
        p.cd.forEach((c) => (c.signature = Math.min(c.signature, 2)));
      }
    }
  }

  startRun(): void {
    this.run.roomIndex = -1;
    this.run.shardsEarned = 0;
    this.teamBoons = [];
    for (const p of this.players.values()) {
      p.boons = [];
      p.secondWind = 1;
      p.dmgDealt = p.kills = p.combos = p.downs = 0;
      p.state = 'alive';
      p.rune = 'none';
    }
    this.refreshStats();
    for (const p of this.players.values()) p.hp = p.maxHp;
    this.nextRoom();
  }

  nextRoom(): void {
    const idx = this.run.roomIndex + 1;
    this.run.roomIndex = idx;
    this.refreshStats();
    const room = generateRoom(this.run.seed, idx, this.activePlayerCount());
    this.loadRoom(room);
    this.setPhase('room');
    this.run.offers = {};
    this.run.teamOffers = [];
    this.run.picks = {};
    this.run.votes = {};
    this.emit({ t: 'room', idx, kind: room.kind });
    if (room.kind === 'boss' && room.boss) {
      const b = this.spawnEnemy(room.boss, { x: 0, y: 0, z: -room.platforms[0].r * 0.4 });
      b.spawnT = 2.2;
      this.run.bossId = b.id;
      this.emit({ t: 'boss', id: b.id, phase: 1, name: ENEMIES[room.boss].name });
    }
  }

  setPhase(phase: RunPhase): void {
    this.run.phase = phase;
    this.run.phaseT = 0;
  }

  /** Called when room is cleared: roll reward offers. */
  openRewards(): void {
    const unlocked = new Set(this.run.unlockedBoons);
    const rng = new Rng(this.run.seed ^ (this.run.roomIndex * 7919 + 13));
    this.run.offers = {};
    for (const p of this.players.values()) {
      const offers = rollBoons(rng, 'personal', [...p.boons], unlocked, 3);
      // occasionally offer a gauntlet find instead of the third boon
      if (rng.chance(0.4)) {
        const other = ELEMENTS.filter((e) => !p.gauntlets.includes(e));
        offers[offers.length - 1] = `gauntlet:${rng.pick(other)}`;
      }
      this.run.offers[p.id] = offers;
      p.ready = false;
    }
    this.run.teamOffers = rollBoons(rng, 'team', this.teamBoons, unlocked, 3);
    this.run.picks = {};
    this.run.votes = {};
    this.setPhase('reward');
  }

  pick(pid: string, choice: string): boolean {
    if (this.run.phase !== 'reward') return false;
    const offers = this.run.offers[pid];
    if (!offers || !offers.includes(choice)) return false;
    this.run.picks[pid] = choice;
    this.checkRewardDone();
    return true;
  }

  vote(pid: string, choice: string): boolean {
    if (this.run.phase !== 'reward') return false;
    if (!this.run.teamOffers.includes(choice)) return false;
    this.run.votes[pid] = choice;
    this.checkRewardDone();
    return true;
  }

  checkRewardDone(): void {
    const ids = [...this.players.keys()].filter((id) => this.run.offers[id]);
    if (ids.length === 0) return;
    const done = ids.every((id) => this.run.picks[id] && (this.run.teamOffers.length === 0 || this.run.votes[id]));
    if (!done) return;
    for (const id of ids) {
      const p = this.players.get(id)!;
      const c = this.run.picks[id];
      if (c.startsWith('gauntlet:')) {
        const el = c.slice(9) as Element;
        p.gauntlets[p.active === 0 ? 1 : 0] = el;
      } else p.boons.push(c);
    }
    if (this.run.teamOffers.length) {
      const tally = new Map<string, number>();
      for (const v of Object.values(this.run.votes)) tally.set(v, (tally.get(v) ?? 0) + 1);
      let best = this.run.teamOffers[0];
      let bestN = -1;
      for (const o of this.run.teamOffers) {
        const n = tally.get(o) ?? 0;
        if (n > bestN) {
          best = o;
          bestN = n;
        }
      }
      this.teamBoons.push(best);
    }
    this.refreshStats();
    for (const p of this.players.values()) if (p.state === 'alive') p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25);
    if (this.autoAdvance) this.nextRoom();
  }

  // ---------- spawning ----------
  spawnEnemy(key: string, pos: V3, opts: { elite?: boolean } = {}): Enemy {
    const def = ENEMIES[key];
    const hp = def.hp * this.enemyHpMul * (def.boss ? 1 + 0.35 * (this.activePlayerCount() - 1) : 1);
    const gh = groundHeight(this.room, pos.x, pos.z, 50);
    const e: Enemy = {
      id: this.id(),
      kind: key,
      faction: def.faction,
      pos: { x: pos.x, y: def.flying ? (gh > -1e9 ? gh : 0) + 2.2 : gh > -1e9 ? gh : 0, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: Math.atan2(pos.x, pos.z),
      hp,
      maxHp: hp,
      radius: def.radius,
      height: def.height,
      flying: !!def.flying,
      state: 'spawning',
      stateT: 0,
      attackIdx: 0,
      attackCds: def.attacks.map((_, i) => 0.8 + i * 0.7 + this.rng.range(0, 1)),
      target: null,
      st: { burn: 0, burnDps: 0, chill: 0, frozen: 0, shock: 0, wet: 0, poison: 0, poisonT: 0, blind: 0, stagger: 0 },
      elite: !!def.elite || !!opts.elite,
      boss: !!def.boss,
      phase: 1,
      hitFlash: 0,
      lastHitEl: null,
      lastHitBy: null,
      seed: this.rng.int(0, 1e6),
      dmgMul: this.enemyDmgMul,
      data: {},
      spawnT: 0.9,
      statusBy: {},
      kx: 0,
      kz: 0,
      ky: 0,
    };
    this.enemies.push(e);
    this.emit({ t: 'spawn', id: e.id, x: e.pos.x, y: e.pos.y, z: e.pos.z, faction: e.faction });
    return e;
  }

  spawnZone(z: Omit<Zone, 'id' | 'reacted' | 'tickT' | 'vel' | 'growth' | 'angle' | 'len' | 'maxLife'> & Partial<Zone>): Zone {
    const zone: Zone = {
      id: this.id(),
      vel: { x: 0, y: 0, z: 0 },
      reacted: [],
      tickT: 0,
      growth: 0,
      angle: 0,
      len: 0,
      maxLife: z.life,
      ...z,
    } as Zone;
    this.zones.push(zone);
    if (zone.tag === 'wall') {
      this.rebuildColliders();
      this.emit({ t: 'wallRise', id: zone.id });
    }
    return zone;
  }

  removeZone(z: Zone): void {
    const i = this.zones.indexOf(z);
    if (i >= 0) this.zones.splice(i, 1);
    if (z.tag === 'wall' || z.tag === 'magmawall') this.rebuildColliders();
  }

  rebuildColliders(): void {
    const walls: WallSeg[] = this.zones
      .filter((z) => z.tag === 'wall' || z.tag === 'magmawall')
      .map((z) => ({ x: z.pos.x, z: z.pos.z, angle: z.angle, len: z.len, thick: 0.6, h: z.pos.y + 2.6 }));
    this.colliders = { room: this.room, walls };
  }

  zoneCount(tag: ZoneTag): number {
    return this.zones.filter((z) => z.tag === tag).length;
  }

  // ---------- main step ----------
  step(dt = SIM_DT): void {
    this.tick++;
    this.time += dt;
    this.run.phaseT += dt;
    for (const [k, v] of this.comboCd) {
      if (v - dt <= 0) this.comboCd.delete(k);
      else this.comboCd.set(k, v - dt);
    }
    if (this.scheduled.length) {
      const due = this.scheduled.filter((s) => s.t <= this.time);
      this.scheduled = this.scheduled.filter((s) => s.t > this.time);
      if (this.run.phase === 'room' || this.run.phase === 'cleared') for (const s of due) s.fn();
    }
    stepPlayers(this, dt);
    if (this.run.phase === 'room' || this.run.phase === 'cleared') {
      stepProjectiles(this, dt);
      stepZones(this, dt);
      stepEnemies(this, dt);
      stepTelegraphs(this, dt);
      this.stepPickups(dt);
      this.stepWaves(dt);
    } else if (this.run.phase === 'reward' || this.run.phase === 'lobby') {
      stepProjectiles(this, dt);
      stepZones(this, dt);
      this.stepPickups(dt);
    }
    for (const [id, inp] of this.inputs) {
      const prev = this.prevInputs.get(id)!;
      Object.assign(prev, inp);
    }
  }

  stepPickups(dt: number): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.t += dt;
      for (const p of this.players.values()) {
        if (p.state !== 'alive') continue;
        if (Math.hypot(p.pos.x - pk.pos.x, p.pos.z - pk.pos.z) < 1.4 && Math.abs(p.pos.y - pk.pos.y) < 2) {
          if (pk.kind === 'rune') p.rune = pk.value as Player['rune'];
          if (pk.kind === 'heal') p.hp = Math.min(p.maxHp, p.hp + 18);
          this.emit({ t: 'pickup', pid: p.id, kind: pk.kind, value: pk.value, x: pk.pos.x, y: pk.pos.y, z: pk.pos.z });
          this.pickups.splice(i, 1);
          break;
        }
      }
      if (pk.kind === 'heal' && pk.t > 20) this.pickups.splice(i, 1);
    }
  }

  stepWaves(dt: number): void {
    const run = this.run;
    if (run.phase === 'cleared') {
      if (run.phaseT > 2.2) {
        if (this.room.kind === 'boss' || run.roomIndex >= run.totalRooms - 1) {
          run.shardsEarned += 40;
          this.setPhase('victory');
        } else this.openRewards();
      }
      return;
    }
    if (run.phase !== 'room') return;
    // team wipe
    let alive = 0;
    for (const p of this.players.values()) if (p.state === 'alive') alive++;
    if (alive === 0 && this.players.size > 0) {
      this.setPhase('defeat');
      return;
    }
    const waves = this.room.waves;
    const living = this.enemies.length;
    if (this.room.kind === 'boss') {
      if (run.phaseT > 3 && living === 0) {
        this.setPhase('cleared');
        this.emit({ t: 'clear' });
      }
      return;
    }
    if (run.waveIdx < waves.length) {
      const threshold = run.waveIdx === 0 ? 0 : 2;
      if (living <= threshold) {
        run.waveDelay -= dt;
        if (run.waveDelay <= 0) {
          this.spawnWave(waves[run.waveIdx].enemies);
          run.waveIdx++;
          run.waveDelay = 1.2;
        }
      }
    } else if (living === 0) {
      run.shardsEarned += this.room.kind === 'elite' ? 8 : 4;
      this.setPhase('cleared');
      this.emit({ t: 'clear' });
    }
  }

  spawnWave(keys: string[]): void {
    const spawns = this.room.spawns;
    keys.forEach((k, i) => {
      const s = spawns[(i * 3 + this.run.waveIdx) % spawns.length];
      const jitter = { x: s.x + this.rng.range(-1.5, 1.5), y: 0, z: s.z + this.rng.range(-1.5, 1.5) };
      const e = this.spawnEnemy(k, jitter);
      e.spawnT = 0.9 + i * 0.12;
    });
  }

  alivePlayers(): Player[] {
    const out: Player[] = [];
    for (const p of this.players.values()) if (p.state === 'alive') out.push(p);
    return out;
  }

  enemyById(id: number): Enemy | undefined {
    return this.enemies.find((e) => e.id === id);
  }
}
