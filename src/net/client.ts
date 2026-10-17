import type { LobbyPeer, NetStats, Session, ViewState } from './session';
import type { Transport } from './transport';
import { decodeEnemy, decodePickup, decodeTelegraph, decodeZone, PROTOCOL_VERSION, type Cmd, type Snapshot, type Welcome } from './protocol';
import type { Element, Enemy, MoveState, Player, PlayerInput, PingKind, SimEvent, Zone } from '../sim/types';
import { SIM_DT } from '../sim/types';
import { generateRoom, type Room } from '../sim/room';
import { copyMoveState, newMoveState, stepMovement, type Colliders } from '../sim/movement';
import { aggregateBoons, baseStats } from '../data/boons';
import type { V3 } from '../sim/vec';
import type { RunInfo, World } from '../sim/world';
import { castPrimary, SPELL_TIMING } from '../sim/spells';
import { BTN_HEAVY, BTN_PRIMARY } from '../sim/types';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const INTERP_DELAY_MS = 100;

/**
 * Client session: predicts the local player's movement, reconciles against host snapshots,
 * interpolates everyone else ~100 ms in the past, and plays host events as they arrive.
 */
export class ClientSession implements Session {
  readonly isHost = false;
  readonly localId: string;
  roomCode: string | null;
  paused = false;
  hostId: string | null = null;
  state: ViewState;
  onMessage?: (msg: string) => void;
  connected = false;
  private pending: PlayerInput[] = [];
  private seq = 0;
  private acc = 0;
  private pred: MoveState | null = null;
  private predPrev: V3 = { x: 0, y: 0, z: 0 };
  private predPrevInput: { jump: number; dash: number } = { jump: 0, dash: 0 };
  private ackInput: { jump: number; dash: number } = { jump: 0, dash: 0 };
  private corr: V3 = { x: 0, y: 0, z: 0 };
  private interp = new Map<string, Sample[]>();
  private events: SimEvent[] = [];
  private roomKey = '';
  private colliders: Colliders;
  private snaps = 0;
  private stats = { t: 0, bin: 0, bout: 0, snaps: 0, inK: 0, outK: 0, sps: 0 };
  lastSnapTick = -1;
  /** client-side predicted primary shots (cosmetic) awaiting the host's authoritative copy */
  private predicted: { id: number; spell: string; t: number }[] = [];
  private predCast: number[] = [];
  private idMap = new Map<number, number>();
  private predId = -1;
  private predCd = 0;
  private clock = 0;
  predictShots = true;

  constructor(
    public transport: Transport,
    private name: string,
    private gauntlets: [Element, Element],
    code: string | null,
    private now: () => number = () => performance.now(),
  ) {
    this.localId = transport.selfId;
    this.roomCode = code;
    const room = generateRoom(1, 0, 1);
    this.state = {
      room,
      run: { seed: 1, roomIndex: -1, phase: 'lobby', phaseT: 0, waveIdx: 0, waveDelay: 0, offers: {}, teamOffers: [], picks: {}, votes: {}, totalRooms: 7, bossId: 0, shardsEarned: 0, unlockedBoons: [] },
      players: new Map(),
      enemies: [],
      zones: [],
      telegraphs: [],
      pickups: [],
      teamBoons: [],
      time: 0,
    };
    this.colliders = { room, walls: [] };
    const t = transport;
    t.on('welcome', (w: Welcome, from) => this.onWelcome(w, from));
    t.on('snap', (s: Snapshot, from) => from === this.hostId && this.onSnap(s));
    t.on('ev', (ev: SimEvent[], from) => {
      if (from !== this.hostId || !Array.isArray(ev)) return;
      for (const e of ev) {
        const out = this.reconcileEvent(e);
        if (out) this.events.push(out);
      }
    });
    t.onPeerJoin(() => this.sayHello());
    t.onPeerLeave((id) => {
      if (id === this.hostId) {
        this.connected = false;
        this.onMessage?.('Host left the rift');
      }
    });
    this.sayHello();
  }

  sayHello(): void {
    if (this.connected) return;
    this.transport.send('hello', { v: PROTOCOL_VERSION, name: this.name, g: this.gauntlets });
  }

  private onWelcome(w: Welcome, from: string): void {
    if (w.you !== this.localId) return;
    if (w.full) {
      this.onMessage?.('That rift is full (4 mages max)');
      return;
    }
    this.hostId = from;
    this.connected = true;
  }

  /** Swap host events for our own predicted shots onto the visuals we already spawned. */
  private reconcileEvent(e: SimEvent): SimEvent | null {
    if (e.t === 'cast' && e.pid === this.localId && e.slot === 'primary' && this.predCast.length) {
      this.predCast.shift();
      return null;
    }
    if (e.t === 'proj' && e.ck.startsWith(`${this.localId}:`)) {
      const i = this.predicted.findIndex((q) => q.spell === e.sp);
      if (i >= 0) {
        this.idMap.set(e.id, this.predicted[i].id);
        this.predicted.splice(i, 1);
        return null;
      }
    }
    if ((e.t === 'projEnd' || e.t === 'projBounce') && this.idMap.has(e.id)) {
      const id = this.idMap.get(e.id)!;
      if (e.t === 'projEnd') this.idMap.delete(e.id);
      return { ...e, id };
    }
    return e;
  }

  private predictCast(me: Player, inp: PlayerInput): void {
    this.predCd = Math.max(0, this.predCd - SIM_DT);
    const phaseOk = this.state.run.phase === 'room' || this.state.run.phase === 'cleared';
    if (!this.predictShots || !phaseOk || me.state !== 'alive') return;
    if ((inp.buttons & BTN_PRIMARY) === 0 || (inp.buttons & BTN_HEAVY) !== 0 || this.predCd > 0) return;
    const el = me.gauntlets[me.active];
    this.predCd = SPELL_TIMING[el].primaryCd;
    const fake = {
      id: () => this.predId--,
      projectiles: [] as unknown[],
      emit: (ev: SimEvent) => {
        if (ev.t === 'proj') this.predicted.push({ id: ev.id, spell: ev.sp, t: this.clock });
        if (ev.t === 'cast') this.predCast.push(this.clock);
        this.events.push(ev);
      },
    };
    const shooter = { ...me, pos: { ...me.pos }, yaw: inp.yaw, castSeq: 0 } as Player;
    castPrimary(fake as unknown as World, shooter, el, inp);
    // forget predictions the host never confirmed (cooldown mismatch, death, ...)
    while (this.predicted.length && this.clock - this.predicted[0].t > 1) this.predicted.shift();
    while (this.predCast.length && this.clock - this.predCast[0] > 1) this.predCast.shift();
  }

  // ---------------------------------------------------------------- snapshots
  private onSnap(s: Snapshot): void {
    if (s.tick <= this.lastSnapTick) return; // out of order / duplicate
    this.lastSnapTick = s.tick;
    this.snaps++;
    const st = this.state;
    const t = this.now();
    const key = `${s.room[0]}:${s.room[1]}`;
    if (key !== this.roomKey) {
      this.roomKey = key;
      st.room = generateRoom(s.room[0], s.room[1], s.room[2]);
      this.interp.clear();
      this.pred = null;
    }
    st.run = { ...(s.run as RunInfo), unlockedBoons: [] };
    st.teamBoons = s.tb;
    st.time = s.time;

    // players
    const seen = new Set<string>();
    for (const ps of s.p) {
      seen.add(ps.id);
      let p = st.players.get(ps.id);
      if (!p) {
        p = { ...(ps as Player), pos: { ...ps.pos }, vel: { ...ps.vel }, stats: baseStats() };
        st.players.set(ps.id, p);
      }
      const local = ps.id === this.localId;
      const keepPos = local && this.pred ? { ...p.pos } : null;
      Object.assign(p, ps, { pos: { ...ps.pos }, vel: { ...ps.vel } });
      p.stats = aggregateBoons([...ps.boons, ...s.tb]);
      if (local) this.reconcile(p, s.ack[this.localId] ?? 0, keepPos);
      else this.pushSample(`p:${ps.id}`, t, ps.pos, ps.yaw);
    }
    for (const id of [...st.players.keys()]) if (!seen.has(id)) st.players.delete(id);

    // enemies
    const byId = new Map<number, Enemy>(st.enemies.map((e) => [e.id, e]));
    st.enemies = s.e.map((a) => {
      const e = decodeEnemy(a, byId.get(a[0] as number));
      this.pushSample(`e:${e.id}`, t, e.pos, e.yaw);
      return e;
    });
    const zById = new Map<number, Zone>(st.zones.map((z) => [z.id, z]));
    st.zones = s.z.map((a) => decodeZone(a, zById.get(a[0] as number)));
    st.telegraphs = s.tg.map(decodeTelegraph);
    st.pickups = s.pk.map(decodePickup);
    this.colliders = {
      room: st.room,
      walls: st.zones.filter((z) => z.tag === 'wall' || z.tag === 'magmawall').map((z) => ({ x: z.pos.x, z: z.pos.z, angle: z.angle, len: z.len, thick: 0.6, h: z.pos.y + 2.6 })),
    };
    // forget interpolation for vanished entities
    if (this.interp.size > 80) for (const k of [...this.interp.keys()]) if (k.startsWith('e:') && !byId.has(+k.slice(2)) && !st.enemies.some((e) => `e:${e.id}` === k)) this.interp.delete(k);
  }

  /** Server-authoritative state for us + replay of not-yet-acknowledged inputs. */
  private reconcile(p: Player, ack: number, renderedBefore: V3 | null): void {
    if (!this.pred) {
      this.pred = newMoveState(p.pos.x, p.pos.y, p.pos.z);
      copyMoveState(this.pred, p);
      this.predPrev = { ...p.pos };
    }
    const before = renderedBefore ?? { ...this.pred.pos };
    copyMoveState(this.pred, p);
    // the server state is "after input #ack"; counters for edge detection resume from that input
    const acked = this.pending.find((i) => i.seq === ack);
    if (acked) this.ackInput = { jump: acked.jump, dash: acked.dash };
    this.pending = this.pending.filter((i) => i.seq > ack);
    let prev = this.ackInput;
    if (p.state === 'alive')
      for (const inp of this.pending) {
        stepMovement(this.pred, inp, prev, SIM_DT, this.colliders, p.stats.moveSpeed, p.stats.dashCharges);
        prev = { jump: inp.jump, dash: inp.dash };
      }
    this.predPrevInput = prev;
    // visual smoothing of the correction
    const dx = before.x - this.pred.pos.x,
      dy = before.y - this.pred.pos.y,
      dz = before.z - this.pred.pos.z;
    if (Math.hypot(dx, dy, dz) < 4) {
      this.corr.x += dx;
      this.corr.y += dy;
      this.corr.z += dz;
    } else this.corr = { x: 0, y: 0, z: 0 };
    p.pos = { ...this.pred.pos };
  }

  private pushSample(key: string, t: number, pos: V3, yaw: number): void {
    let l = this.interp.get(key);
    if (!l) this.interp.set(key, (l = []));
    l.push({ t, x: pos.x, y: pos.y, z: pos.z, yaw });
    if (l.length > 12) l.shift();
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number, input: PlayerInput): SimEvent[] {
    this.acc += Math.min(dt, 0.1);
    const me = this.state.players.get(this.localId);
    while (this.acc >= SIM_DT) {
      this.acc -= SIM_DT;
      const inp = { ...input, seq: ++this.seq };
      this.pending.push(inp);
      if (this.pending.length > 90) this.pending.shift();
      if (this.connected) this.transport.send('input', { i: this.pending.slice(-4) }, this.hostId!);
      if (this.pred && me && me.state === 'alive') {
        this.predPrev = { ...this.pred.pos };
        stepMovement(this.pred, inp, this.predPrevInput, SIM_DT, this.colliders, me.stats.moveSpeed, me.stats.dashCharges);
        this.predPrevInput = { jump: inp.jump, dash: inp.dash };
        me.pos = { ...this.pred.pos };
        me.vel = { ...this.pred.vel };
        me.yaw = this.pred.yaw;
        me.hovering = this.pred.hovering;
        me.grounded = this.pred.grounded;
        me.dashCharges = this.pred.dashCharges;
      }
      this.clock += SIM_DT;
      if (me) this.predictCast(me, inp);
      // advance client-side timers between snapshots for smooth telegraphs/zones
      for (const tg of this.state.telegraphs) tg.t = Math.min(tg.dur, tg.t + SIM_DT);
      for (const z of this.state.zones) z.life = Math.max(0, z.life - SIM_DT);
    }
    const k = Math.exp(-dt * 12);
    this.corr.x *= k;
    this.corr.y *= k;
    this.corr.z *= k;
    const st = this.stats;
    st.t += dt;
    if (st.t >= 1) {
      st.inK = ((this.transport.stats.bytesIn - st.bin) * 8) / 1000 / st.t;
      st.outK = ((this.transport.stats.bytesOut - st.bout) * 8) / 1000 / st.t;
      st.sps = (this.snaps - st.snaps) / st.t;
      st.bin = this.transport.stats.bytesIn;
      st.bout = this.transport.stats.bytesOut;
      st.snaps = this.snaps;
      st.t = 0;
      if (!this.connected) this.sayHello();
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  renderPos(kind: 'p' | 'e', id: string | number, out: V3): V3 {
    if (kind === 'p' && id === this.localId && this.pred) {
      const a = this.acc / SIM_DT;
      out.x = this.predPrev.x + (this.pred.pos.x - this.predPrev.x) * a + this.corr.x;
      out.y = this.predPrev.y + (this.pred.pos.y - this.predPrev.y) * a + this.corr.y;
      out.z = this.predPrev.z + (this.pred.pos.z - this.predPrev.z) * a + this.corr.z;
      return out;
    }
    const l = this.interp.get(`${kind}:${id}`);
    if (!l || l.length === 0) return out;
    const rt = this.now() - INTERP_DELAY_MS;
    let i = l.length - 1;
    while (i > 0 && l[i - 1].t > rt) i--;
    const b = l[i];
    const a = i > 0 ? l[i - 1] : b;
    if (rt >= b.t || a === b) {
      out.x = b.x;
      out.y = b.y;
      out.z = b.z;
      return out;
    }
    const f = Math.max(0, Math.min(1, (rt - a.t) / Math.max(1, b.t - a.t)));
    out.x = a.x + (b.x - a.x) * f;
    out.y = a.y + (b.y - a.y) * f;
    out.z = a.z + (b.z - a.z) * f;
    return out;
  }

  private cmd(c: Cmd): void {
    if (this.hostId) this.transport.send('cmd', c, this.hostId);
  }
  startRun(): void {}
  pick(choice: string): void {
    this.cmd({ c: 'pick', v: choice });
  }
  vote(choice: string): void {
    this.cmd({ c: 'vote', v: choice });
  }
  setLoadout(g: [Element, Element]): void {
    this.gauntlets = g;
    this.cmd({ c: 'loadout', v: g });
  }
  setReady(ready: boolean): void {
    this.cmd({ c: 'ready', v: ready });
  }
  ping(kind: PingKind, x: number, y: number, z: number): void {
    this.cmd({ c: 'ping', k: kind, x, y, z });
  }
  lobby(): LobbyPeer[] {
    return [...this.state.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready || p.id === this.hostId, gauntlets: p.gauntlets, color: p.color }));
  }
  netStats(): NetStats {
    return {
      peers: this.transport.peers().length,
      rttMs: this.hostId ? this.transport.rtt(this.hostId) : 0,
      inKbps: this.stats.inK,
      outKbps: this.stats.outK,
      snapshotsPerSec: this.stats.sps,
      pendingInputs: this.pending.length,
    };
  }
  freeze(): void {}
  leave(): void {
    this.transport.send('bye', {});
    this.transport.close();
  }
  get room(): Room {
    return this.state.room;
  }
}
