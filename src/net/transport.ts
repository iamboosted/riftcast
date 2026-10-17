/**
 * Minimal message transport. Implementations: LoopbackHub (tests, in-memory with latency/jitter/loss)
 * and TrysteroTransport (WebRTC P2P with public signalling, no server of ours).
 */
export type Channel = 'hello' | 'welcome' | 'input' | 'snap' | 'ev' | 'cmd' | 'lobby' | 'bye';

/** Unreliable channels may be dropped by lossy links (state is re-sent continuously). */
export const UNRELIABLE: ReadonlySet<Channel> = new Set(['input', 'snap']);

export interface TransportStats {
  bytesIn: number;
  bytesOut: number;
}

export interface Transport {
  readonly selfId: string;
  send(channel: Channel, data: unknown, to?: string): void;
  on(channel: Channel, cb: (data: any, from: string) => void): void;
  onPeerJoin(cb: (id: string) => void): void;
  onPeerLeave(cb: (id: string) => void): void;
  peers(): string[];
  close(): void;
  stats: TransportStats;
  /** round-trip estimate to a peer in ms (if measurable) */
  rtt(peer: string): number;
}

export interface LinkOpts {
  latencyMs: number;
  jitterMs: number;
  /** 0..1 drop probability for unreliable channels */
  loss: number;
}

interface Pending {
  at: number;
  seq: number;
  to: LoopbackTransport;
  from: string;
  channel: Channel;
  data: string;
}

/**
 * Deterministic in-memory network. Time is virtual: call advance(ms) to deliver due messages.
 * Reliable channels keep per-link ordering; unreliable ones can be dropped.
 */
export class LoopbackHub {
  now = 0;
  private queue: Pending[] = [];
  private seq = 0;
  nodes = new Map<string, LoopbackTransport>();
  private rand: () => number;
  /** last scheduled delivery time per (from->to) for reliable ordering */
  private lastAt = new Map<string, number>();

  constructor(public link: LinkOpts = { latencyMs: 40, jitterMs: 10, loss: 0 }, seed = 1) {
    let s = seed >>> 0 || 1;
    this.rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  connect(id: string): LoopbackTransport {
    const t = new LoopbackTransport(id, this);
    for (const other of this.nodes.values()) {
      other._join(id);
      t._join(other.selfId);
    }
    this.nodes.set(id, t);
    return t;
  }

  disconnect(id: string): void {
    const t = this.nodes.get(id);
    if (!t) return;
    this.nodes.delete(id);
    this.queue = this.queue.filter((p) => p.to !== t && p.from !== id);
    for (const other of this.nodes.values()) other._leave(id);
  }

  _post(from: string, to: string, channel: Channel, data: unknown): void {
    const dst = this.nodes.get(to);
    if (!dst) return;
    const unreliable = UNRELIABLE.has(channel);
    if (unreliable && this.rand() < this.link.loss) return;
    let at = this.now + this.link.latencyMs + (this.rand() * 2 - 1) * this.link.jitterMs;
    const key = `${from}>${to}`;
    if (!unreliable) {
      at = Math.max(at, this.lastAt.get(key) ?? 0);
      this.lastAt.set(key, at);
    }
    // serialise to catch non-JSON payloads and measure bytes like a real link
    this.queue.push({ at, seq: this.seq++, to: dst, from, channel, data: JSON.stringify(data) });
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let best: Pending | null = null;
      for (const p of this.queue) if (p.at <= end && (!best || p.at < best.at || (p.at === best.at && p.seq < best.seq))) best = p;
      if (!best) break;
      this.queue.splice(this.queue.indexOf(best), 1);
      this.now = Math.max(this.now, best.at);
      best.to._deliver(best.channel, best.data, best.from);
    }
    this.now = end;
  }
}

export class LoopbackTransport implements Transport {
  stats: TransportStats = { bytesIn: 0, bytesOut: 0 };
  private handlers = new Map<Channel, ((d: any, from: string) => void)[]>();
  private joinCbs: ((id: string) => void)[] = [];
  private leaveCbs: ((id: string) => void)[] = [];
  private known = new Set<string>();
  constructor(
    public readonly selfId: string,
    private hub: LoopbackHub,
  ) {}
  send(channel: Channel, data: unknown, to?: string): void {
    const targets = to ? [to] : [...this.known];
    const size = JSON.stringify(data).length;
    for (const t of targets) {
      this.stats.bytesOut += size;
      this.hub._post(this.selfId, t, channel, data);
    }
  }
  on(channel: Channel, cb: (d: any, from: string) => void): void {
    const l = this.handlers.get(channel) ?? [];
    l.push(cb);
    this.handlers.set(channel, l);
  }
  onPeerJoin(cb: (id: string) => void): void {
    this.joinCbs.push(cb);
    for (const k of this.known) cb(k);
  }
  onPeerLeave(cb: (id: string) => void): void {
    this.leaveCbs.push(cb);
  }
  peers(): string[] {
    return [...this.known];
  }
  close(): void {
    this.hub.disconnect(this.selfId);
  }
  rtt(): number {
    return this.hub.link.latencyMs * 2;
  }
  _deliver(channel: Channel, raw: string, from: string): void {
    this.stats.bytesIn += raw.length;
    const data = JSON.parse(raw);
    for (const cb of this.handlers.get(channel) ?? []) cb(data, from);
  }
  _join(id: string): void {
    this.known.add(id);
    for (const cb of this.joinCbs) cb(id);
  }
  _leave(id: string): void {
    this.known.delete(id);
    for (const cb of this.leaveCbs) cb(id);
  }
}
