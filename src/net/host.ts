import { LocalSession, type NetStats } from './session';
import type { Transport } from './transport';
import { encodeSnapshot, PROTOCOL_VERSION, type Cmd, type Hello, type InputMsg } from './protocol';
import type { Element, PlayerInput, PingKind, SimEvent } from '../sim/types';
import { emptyInput } from '../sim/types';

const MAX_PLAYERS = 4;
const SNAP_EVERY = 2; // 15 Hz at a 30 Hz sim

/**
 * Host-authoritative session: the local World is the truth. Remote players' inputs are queued and
 * applied one per tick; state snapshots (15 Hz) and sim events (every tick) are broadcast.
 */
export class HostSession extends LocalSession {
  private queues = new Map<string, PlayerInput[]>();
  private lastQueued = new Map<string, number>();
  private outEvents: SimEvent[] = [];
  private snapCount = 0;
  private statWindow = { t: 0, bin: 0, bout: 0, snaps: 0, inK: 0, outK: 0, sps: 0 };

  constructor(
    public transport: Transport,
    name: string,
    gauntlets: [Element, Element],
    code: string,
    seed?: number,
    unlocked: string[] = [],
  ) {
    super(transport.selfId, name, gauntlets, seed, unlocked);
    this.roomCode = code;
    const t = transport;
    t.on('hello', (h: Hello, from) => this.onHello(h, from));
    t.on('input', (m: InputMsg, from) => this.onInput(m, from));
    t.on('cmd', (c: Cmd, from) => this.onCmd(c, from));
    t.on('bye', (_d, from) => this.dropPeer(from));
    t.onPeerLeave((id) => this.dropPeer(id));
  }

  private onHello(h: Hello, from: string): void {
    const w = this.world;
    if (w.players.has(from)) {
      this.transport.send('welcome', { v: PROTOCOL_VERSION, host: this.localId, you: from }, from);
      return;
    }
    if (h?.v !== PROTOCOL_VERSION || w.players.size >= MAX_PLAYERS) {
      this.transport.send('welcome', { v: PROTOCOL_VERSION, host: this.localId, you: from, full: true }, from);
      return;
    }
    const used = new Set([...w.players.values()].map((p) => p.color));
    let colorIdx = 0;
    while (colorIdx < 4 && used.has([0x5ad1ff, 0xff6ad5, 0xffd34a, 0x7dff8a][colorIdx])) colorIdx++;
    const name = String(h.name ?? 'Mage').slice(0, 16);
    const g = validGauntlets(h.g);
    w.addPlayer({ id: from, name, gauntlets: g, colorIdx });
    this.queues.set(from, []);
    this.transport.send('welcome', { v: PROTOCOL_VERSION, host: this.localId, you: from }, from);
    this.onMessage?.(`${name} ${w.run.phase === 'lobby' ? 'joined' : 'will drop in next room'}`);
    this.sendSnapshot();
  }

  private onInput(m: InputMsg, from: string): void {
    const q = this.queues.get(from);
    if (!q || !Array.isArray(m?.i)) return;
    let last = this.lastQueued.get(from) ?? 0;
    for (const inp of m.i) {
      if (typeof inp?.seq !== 'number' || inp.seq <= last) continue;
      q.push(sanitizeInput(inp));
      last = inp.seq;
    }
    this.lastQueued.set(from, last);
  }

  private onCmd(c: Cmd, from: string): void {
    const w = this.world;
    const p = w.players.get(from);
    if (!p || !c) return;
    switch (c.c) {
      case 'pick':
        w.pick(from, String(c.v));
        break;
      case 'vote':
        w.vote(from, String(c.v));
        break;
      case 'ready':
        p.ready = !!c.v;
        break;
      case 'loadout':
        if (w.run.phase === 'lobby') p.gauntlets = validGauntlets(c.v);
        break;
      case 'ping':
        if ([c.x, c.y, c.z].every((v) => typeof v === 'number' && isFinite(v)))
          w.emit({ t: 'ping', pid: from, kind: (['here', 'attack', 'help', 'combo'].includes(c.k) ? c.k : 'here') as PingKind, x: c.x, y: c.y, z: c.z });
        break;
    }
  }

  private dropPeer(id: string): void {
    if (!this.world.players.has(id) || id === this.localId) return;
    const name = this.world.players.get(id)!.name;
    this.world.removePlayer(id);
    this.queues.delete(id);
    this.onMessage?.(`${name} left`);
  }

  protected beforeStep(): void {
    for (const [id, q] of this.queues) {
      // keep the jitter buffer short: if far behind, skip ahead (counters are absolute, nothing is lost)
      while (q.length > 4) q.shift();
      const next = q.shift();
      if (next) this.world.setInput(id, next);
    }
  }

  protected afterStep(ev: SimEvent[]): void {
    for (const e of ev) this.outEvents.push(e);
    if (this.outEvents.length) {
      this.transport.send('ev', this.outEvents);
      this.outEvents = [];
    }
    if (this.world.tick % SNAP_EVERY === 0) this.sendSnapshot();
  }

  private sendSnapshot(): void {
    if (this.transport.peers().length === 0) return;
    this.transport.send('snap', encodeSnapshot(this.world, this.world.activePlayerCount()));
    this.snapCount++;
  }

  /** Co-op never freezes the authoritative sim for hit-stop. */
  protected allowFreeze(): boolean {
    return this.world.players.size <= 1;
  }

  update(dt: number, input: PlayerInput): SimEvent[] {
    // paused only applies to solo
    if (this.world.players.size > 1) this.paused = false;
    const out = super.update(dt, input);
    const sw = this.statWindow;
    sw.t += dt;
    if (sw.t >= 1) {
      sw.inK = ((this.transport.stats.bytesIn - sw.bin) * 8) / 1000 / sw.t;
      sw.outK = ((this.transport.stats.bytesOut - sw.bout) * 8) / 1000 / sw.t;
      sw.sps = (this.snapCount - sw.snaps) / sw.t;
      sw.bin = this.transport.stats.bytesIn;
      sw.bout = this.transport.stats.bytesOut;
      sw.snaps = this.snapCount;
      sw.t = 0;
    }
    return out;
  }

  ping(kind: PingKind, x: number, y: number, z: number): void {
    this.world.emit({ t: 'ping', pid: this.localId, kind, x, y, z });
  }

  startRun(): void {
    if (this.world.run.phase !== 'lobby') return;
    super.startRun();
    this.sendSnapshot();
  }

  netStats(): NetStats {
    const peers = this.transport.peers();
    const rtts = peers.map((p) => this.transport.rtt(p)).filter((v) => v > 0);
    let pend = 0;
    for (const q of this.queues.values()) pend += q.length;
    return {
      peers: peers.length,
      rttMs: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0,
      inKbps: this.statWindow.inK,
      outKbps: this.statWindow.outK,
      snapshotsPerSec: this.statWindow.sps,
      pendingInputs: pend,
    };
  }

  leave(): void {
    this.transport.send('bye', {});
    this.transport.close();
  }
}

const ALL: Element[] = ['fire', 'frost', 'storm', 'gale', 'stone', 'venom'];
export function validGauntlets(g: unknown): [Element, Element] {
  if (Array.isArray(g) && g.length === 2 && ALL.includes(g[0]) && ALL.includes(g[1]) && g[0] !== g[1]) return [g[0], g[1]];
  return ['fire', 'frost'];
}

/** Never trust a remote input object: clamp and coerce every field. */
export function sanitizeInput(i: Partial<PlayerInput>): PlayerInput {
  const o = emptyInput();
  const num = (v: unknown, lim = 1e4) => (typeof v === 'number' && isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);
  o.seq = num(i.seq, 1e12);
  const mx = num(i.mx, 1),
    mz = num(i.mz, 1);
  const l = Math.hypot(mx, mz);
  o.mx = l > 1 ? mx / l : mx;
  o.mz = l > 1 ? mz / l : mz;
  o.yaw = num(i.yaw, 1e3);
  o.pitch = num(i.pitch, 2);
  o.ax = num(i.ax, 500);
  o.ay = num(i.ay, 500);
  o.az = num(i.az, 500);
  o.buttons = num(i.buttons, 7) | 0;
  o.sig = num(i.sig, 255) & 255;
  o.dash = num(i.dash, 255) & 255;
  o.jump = num(i.jump, 255) & 255;
  o.swap = num(i.swap, 255) & 255;
  return o;
}
