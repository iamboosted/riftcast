import { joinRoom, selfId } from 'trystero';
import type { Channel, Transport, TransportStats } from './transport';

const APP_ID = 'riftcast-iamboosted-v1';
const CHANNELS: Channel[] = ['hello', 'welcome', 'input', 'snap', 'ev', 'cmd', 'lobby', 'bye'];

/**
 * WebRTC P2P via Trystero (Nostr relays for signalling only; game data flows peer-to-peer).
 * Payloads are JSON strings so byte counts are measurable for the perf overlay.
 */
export class TrysteroTransport implements Transport {
  readonly selfId = selfId;
  stats: TransportStats = { bytesIn: 0, bytesOut: 0 };
  private room: ReturnType<typeof joinRoom>;
  private senders = new Map<Channel, (data: string, opts?: { target?: string | string[] }) => Promise<void>>();
  private handlers = new Map<Channel, ((d: any, from: string) => void)[]>();
  private joinCbs: ((id: string) => void)[] = [];
  private leaveCbs: ((id: string) => void)[] = [];
  private known = new Set<string>();
  private rtts = new Map<string, number>();
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(code: string) {
    this.room = joinRoom({ appId: APP_ID }, `room-${code}`);
    for (const ch of CHANNELS) {
      const action = this.room.makeAction<string>(ch);
      this.senders.set(ch, (d, o) => action.send(d, o));
      action.onMessage = (raw, ctx) => {
        if (typeof raw !== 'string' || raw.length > 400_000) return;
        this.stats.bytesIn += raw.length;
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
        for (const cb of this.handlers.get(ch) ?? []) cb(data, ctx.peerId);
      };
    }
    this.room.onPeerJoin = (id) => {
      this.known.add(id);
      for (const cb of this.joinCbs) cb(id);
    };
    this.room.onPeerLeave = (id) => {
      this.known.delete(id);
      for (const cb of this.leaveCbs) cb(id);
    };
    this.pingTimer = setInterval(() => {
      for (const p of this.known)
        this.room
          .ping(p)
          .then((ms) => this.rtts.set(p, ms))
          .catch(() => {});
    }, 2000);
  }

  send(channel: Channel, data: unknown, to?: string): void {
    const raw = JSON.stringify(data);
    const n = to ? 1 : this.known.size;
    this.stats.bytesOut += raw.length * n;
    if (n === 0) return;
    this.senders.get(channel)?.(raw, to ? { target: to } : undefined).catch(() => {});
  }
  on(channel: Channel, cb: (d: any, from: string) => void): void {
    const l = this.handlers.get(channel) ?? [];
    l.push(cb);
    this.handlers.set(channel, l);
  }
  onPeerJoin(cb: (id: string) => void): void {
    this.joinCbs.push(cb);
  }
  onPeerLeave(cb: (id: string) => void): void {
    this.leaveCbs.push(cb);
  }
  peers(): string[] {
    return [...this.known];
  }
  rtt(peer: string): number {
    return this.rtts.get(peer) ?? 0;
  }
  close(): void {
    clearInterval(this.pingTimer);
    this.room.leave().catch(() => {});
  }
}
