import { World, type RunInfo } from '../sim/world';
import type { Element, Enemy, Pickup, Player, PlayerInput, PingKind, SimEvent, Telegraph, Zone } from '../sim/types';
import { SIM_DT } from '../sim/types';
import type { Room } from '../sim/room';
import type { V3 } from '../sim/vec';

export interface NetStats {
  peers: number;
  rttMs: number;
  inKbps: number;
  outKbps: number;
  snapshotsPerSec: number;
  pendingInputs: number;
}

/** What the presentation layer reads, identical for host (real world) and client (replicated mirror). */
export interface ViewState {
  room: Room;
  run: RunInfo;
  players: Map<string, Player>;
  enemies: Enemy[];
  zones: Zone[];
  telegraphs: Telegraph[];
  pickups: Pickup[];
  teamBoons: string[];
  time: number;
}

export interface LobbyPeer {
  id: string;
  name: string;
  ready: boolean;
  gauntlets: [Element, Element];
  color: number;
}

export interface Session {
  readonly isHost: boolean;
  readonly localId: string;
  readonly roomCode: string | null;
  readonly state: ViewState;
  /** advance; returns presentation events since last call */
  update(dt: number, input: PlayerInput): SimEvent[];
  /** smoothed render position for a player or enemy */
  renderPos(kind: 'p' | 'e', id: string | number, out: V3): V3;
  startRun(): void;
  pick(choice: string): void;
  vote(choice: string): void;
  setLoadout(g: [Element, Element]): void;
  setReady(ready: boolean): void;
  ping(kind: PingKind, x: number, y: number, z: number): void;
  lobby(): LobbyPeer[];
  netStats(): NetStats | null;
  /** host paused the sim (solo only) */
  paused: boolean;
  /** hit-stop (solo only freezes the sim) */
  freeze(ms: number): void;
  leave(): void;
  onMessage?: (msg: string) => void;
}

/**
 * Solo / host-local session: owns the authoritative World and steps it at a fixed 30 Hz.
 * Remote hosting extends this with a transport (see HostSession).
 */
export class LocalSession implements Session {
  readonly isHost = true;
  readonly localId: string;
  roomCode: string | null = null;
  world: World;
  paused = false;
  protected acc = 0;
  protected prevP = new Map<string, V3>();
  protected prevE = new Map<number, V3>();
  protected events: SimEvent[] = [];
  protected freezeT = 0;
  protected seq = 0;
  onMessage?: (msg: string) => void;

  constructor(localId: string, name: string, gauntlets: [Element, Element], seed = (Math.random() * 2 ** 31) | 0, unlockedBoons: string[] = []) {
    this.localId = localId;
    this.world = new World(seed, unlockedBoons);
    this.world.addPlayer({ id: localId, name, gauntlets, colorIdx: 0 });
  }

  get state(): ViewState {
    return this.world;
  }

  update(dt: number, input: PlayerInput): SimEvent[] {
    if (this.paused) return [];
    if (this.freezeT > 0 && this.allowFreeze()) {
      this.freezeT -= dt * 1000;
      return [];
    }
    this.acc += Math.min(dt, 0.5);
    while (this.acc >= SIM_DT) {
      this.acc -= SIM_DT;
      this.snapshotPrev();
      input.seq = ++this.seq;
      this.world.setInput(this.localId, { ...input });
      this.beforeStep();
      this.world.step(SIM_DT);
      const ev = this.world.drainEvents();
      this.afterStep(ev);
      for (const e of ev) this.events.push(e);
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  /** hooks for HostSession */
  protected beforeStep(): void {}
  protected afterStep(_ev: SimEvent[]): void {}
  protected allowFreeze(): boolean {
    return true;
  }

  protected snapshotPrev(): void {
    for (const p of this.world.players.values()) {
      const v = this.prevP.get(p.id);
      if (v) {
        v.x = p.pos.x;
        v.y = p.pos.y;
        v.z = p.pos.z;
      } else this.prevP.set(p.id, { ...p.pos });
    }
    for (const e of this.world.enemies) {
      const v = this.prevE.get(e.id);
      if (v) {
        v.x = e.pos.x;
        v.y = e.pos.y;
        v.z = e.pos.z;
      } else this.prevE.set(e.id, { ...e.pos });
    }
  }

  renderPos(kind: 'p' | 'e', id: string | number, out: V3): V3 {
    const a = this.acc / SIM_DT;
    const cur = kind === 'p' ? this.world.players.get(id as string)?.pos : this.world.enemyById(id as number)?.pos;
    if (!cur) return out;
    const prev = kind === 'p' ? this.prevP.get(id as string) : this.prevE.get(id as number);
    if (!prev || Math.hypot(cur.x - prev.x, cur.z - prev.z) > 4) {
      out.x = cur.x;
      out.y = cur.y;
      out.z = cur.z;
      return out;
    }
    out.x = prev.x + (cur.x - prev.x) * a;
    out.y = prev.y + (cur.y - prev.y) * a;
    out.z = prev.z + (cur.z - prev.z) * a;
    return out;
  }

  startRun(): void {
    this.world.startRun();
  }
  pick(choice: string): void {
    this.world.pick(this.localId, choice);
  }
  vote(choice: string): void {
    this.world.vote(this.localId, choice);
  }
  setLoadout(g: [Element, Element]): void {
    const p = this.world.players.get(this.localId);
    if (p) p.gauntlets = [...g] as [Element, Element];
  }
  setReady(ready: boolean): void {
    const p = this.world.players.get(this.localId);
    if (p) p.ready = ready;
  }
  ping(kind: PingKind, x: number, y: number, z: number): void {
    this.events.push({ t: 'ping', pid: this.localId, kind, x, y, z });
  }
  lobby(): LobbyPeer[] {
    return [...this.world.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready, gauntlets: p.gauntlets, color: p.color }));
  }
  netStats(): NetStats | null {
    return null;
  }
  freeze(ms: number): void {
    this.freezeT = Math.max(this.freezeT, ms);
  }
  leave(): void {}
}
