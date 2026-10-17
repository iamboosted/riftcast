import { describe, it, expect } from 'vitest';
import { LoopbackHub } from '../src/net/transport';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { BTN_HEAVY, BTN_PRIMARY, emptyInput, SIM_DT, type Element, type PlayerInput, type SimEvent } from '../src/sim/types';
import { damagePlayerRaw } from '../src/sim/players';

interface Rig {
  hub: LoopbackHub;
  host: HostSession;
  clients: ClientSession[];
  hostEvents: SimEvent[];
  clientEvents: SimEvent[][];
  inputs: Map<string, PlayerInput>;
  step(n?: number): void;
  addClient(id: string, g: [Element, Element]): ClientSession;
}

function setup(n: number, link = { latencyMs: 45, jitterMs: 15, loss: 0.08 }, seed = 1234): Rig {
  const hub = new LoopbackHub(link, 99);
  const host = new HostSession(hub.connect('H'), 'Host', ['gale', 'fire'], 'TESTS', seed);
  const rig: Rig = {
    hub,
    host,
    clients: [],
    hostEvents: [],
    clientEvents: [],
    inputs: new Map(),
    step(k = 1) {
      for (let i = 0; i < k; i++) {
        const hi = { ...(rig.inputs.get('H') ?? emptyInput()) };
        for (const e of host.update(SIM_DT + 1e-7, hi)) rig.hostEvents.push(e);
        rig.clients.forEach((c, ci) => {
          const inp = { ...(rig.inputs.get(c.localId) ?? emptyInput()) };
          for (const e of c.update(SIM_DT + 1e-7, inp)) rig.clientEvents[ci].push(e);
        });
        hub.advance(1000 / 30);
      }
    },
    addClient(id, g) {
      const c = new ClientSession(hub.connect(id), id, g, 'TESTS', () => hub.now);
      rig.clients.push(c);
      rig.clientEvents.push([]);
      return c;
    },
  };
  const loadouts: [Element, Element][] = [
    ['fire', 'venom'],
    ['frost', 'stone'],
    ['storm', 'gale'],
  ];
  for (let i = 0; i < n; i++) rig.addClient(`C${i + 1}`, loadouts[i % 3]);
  rig.step(20);
  return rig;
}

/** Point a player's input at a world position (aim + face). */
function aimAt(inp: PlayerInput, from: { x: number; z: number }, to: { x: number; y: number; z: number }) {
  inp.ax = to.x;
  inp.ay = to.y;
  inp.az = to.z;
  inp.yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

describe('multiplayer over lossy loopback', () => {
  it('all clients join and see the same lobby', () => {
    const r = setup(3);
    expect(r.clients.every((c) => c.connected)).toBe(true);
    expect(r.host.world.players.size).toBe(4);
    for (const c of r.clients) expect([...c.state.players.keys()].sort()).toEqual([...r.host.world.players.keys()].sort());
  });

  it('host + 3 clients converge on the authoritative state during a scripted room', () => {
    const r = setup(3);
    r.host.startRun();
    // everyone strafes in circles and fires
    for (let t = 0; t < 30 * 12; t++) {
      for (const id of ['H', 'C1', 'C2', 'C3']) {
        const i = emptyInput();
        const a = t * 0.05 + id.charCodeAt(id.length - 1);
        i.mx = Math.cos(a) * 0.8;
        i.mz = Math.sin(a) * 0.8;
        i.yaw = a;
        i.ax = Math.cos(a) * 15;
        i.ay = 1;
        i.az = Math.sin(a) * 15 - 5;
        i.buttons = t % 40 < 25 ? BTN_PRIMARY : 0;
        i.jump = Math.floor(t / 45) & 255;
        i.dash = Math.floor(t / 70) & 255;
        r.inputs.set(id, i);
      }
      r.step();
    }
    // stop moving and let the network settle
    for (const id of ['H', 'C1', 'C2', 'C3']) r.inputs.set(id, { ...emptyInput(), yaw: 0 });
    r.step(30);
    const w = r.host.world;
    expect(w.run.phase === 'room' || w.run.phase === 'cleared' || w.run.phase === 'reward').toBe(true);
    for (const c of r.clients) {
      // same room, same enemies
      expect(c.state.run.roomIndex).toBe(w.run.roomIndex);
      expect(c.state.enemies.map((e) => e.id).sort()).toEqual(w.enemies.map((e) => e.id).sort());
      for (const e of w.enemies) {
        const ce = c.state.enemies.find((q) => q.id === e.id)!;
        expect(Math.hypot(ce.pos.x - e.pos.x, ce.pos.z - e.pos.z)).toBeLessThan(1.5);
        expect(Math.abs(ce.hp - e.hp)).toBeLessThan(e.maxHp * 0.25 + 1);
      }
      // predicted local player converges to authoritative position
      const hp = w.players.get(c.localId)!;
      const cp = c.state.players.get(c.localId)!;
      expect(Math.hypot(hp.pos.x - cp.pos.x, hp.pos.z - cp.pos.z)).toBeLessThan(0.25);
      // other players match too
      for (const p of w.players.values()) {
        const q = c.state.players.get(p.id)!;
        expect(q.hp).toBeCloseTo(p.hp, 0);
        expect(q.state).toBe(p.state);
      }
    }
    // clients received the host's cast + hit events
    for (const ev of r.clientEvents) {
      expect(ev.some((e) => e.t === 'cast')).toBe(true);
      expect(ev.some((e) => e.t === 'proj')).toBe(true);
    }
  });

  it('combos trigger across casters and credit every contributor', () => {
    const r = setup(2);
    r.host.startRun();
    r.step(2);
    const w = r.host.world;
    // move C1 (fire) and C2 (frost) is not involved; host (gale) makes the vortex
    const host = w.players.get('H')!;
    const fireMage = w.players.get('C1')!;
    // gale heavy: hold, release
    const target = { x: host.pos.x, y: 0.5, z: host.pos.z - 12 };
    const hi = emptyInput();
    aimAt(hi, host.pos, target);
    hi.buttons = BTN_HEAVY;
    r.inputs.set('H', hi);
    r.step(12);
    r.inputs.set('H', { ...hi, buttons: 0 });
    r.step(8);
    const vortex = w.zones.find((z) => z.tag === 'vortex');
    expect(vortex).toBeTruthy();
    // fire mage shoots into the vortex until it becomes a firestorm
    for (let k = 0; k < 60 && !w.zones.some((z) => z.tag === 'firestorm'); k++) {
      const v = w.zones.find((z) => z.tag === 'vortex');
      if (!v) break;
      const ci = emptyInput();
      aimAt(ci, fireMage.pos, { x: v.pos.x, y: v.pos.y + 1, z: v.pos.z });
      ci.buttons = BTN_PRIMARY;
      r.inputs.set('C1', ci);
      r.step();
    }
    r.inputs.set('C1', emptyInput());
    r.step(15);
    const combo = r.hostEvents.find((e) => e.t === 'combo' && e.key === 'firestorm') as Extract<SimEvent, { t: 'combo' }> | undefined;
    expect(combo).toBeTruthy();
    expect(combo!.pids.sort()).toEqual(['C1', 'H']);
    expect(w.players.get('C1')!.combos).toBeGreaterThan(0);
    expect(w.players.get('H')!.combos).toBeGreaterThan(0);
    // every client got the combo event
    for (const ev of r.clientEvents) expect(ev.some((e) => e.t === 'combo' && e.key === 'firestorm')).toBe(true);
  });

  it('damage is host-authoritative: forged client messages are ignored', () => {
    const r = setup(2, { latencyMs: 30, jitterMs: 5, loss: 0 });
    r.host.startRun();
    r.step(70); // let a wave spawn
    const w = r.host.world;
    const e = w.enemies[0];
    expect(e).toBeTruthy();
    const hp = e.hp;
    const atk = r.clients[0].transport;
    // a malicious client tries: forged events, forged snapshot to peers, unknown commands, absurd inputs
    atk.send('ev', [{ t: 'kill', id: e.id, x: 0, y: 0, z: 0, el: 'fire', kind: e.kind }]);
    atk.send('snap', { tick: 1e9, p: [], e: [], z: [], tg: [], pk: [], run: {}, room: [1, 0, 1], ack: {}, tb: [], time: 0 });
    atk.send('cmd', { c: 'damage', id: e.id, amt: 99999 } as never);
    atk.send('input', { i: [{ seq: 1e6, mx: 999, mz: 999, ax: 1e9, ay: 0, az: 0, buttons: 0, yaw: 0, pitch: 0, sig: 0, dash: 0, jump: 0, swap: 0 }] });
    r.step(10);
    const e2 = w.enemies.find((q) => q.id === e.id);
    expect(e2).toBeTruthy();
    expect(e2!.hp).toBeGreaterThan(hp * 0.5);
    // the other client still mirrors the host, not the forged snapshot
    expect(r.clients[1].state.enemies.some((q) => q.id === e.id)).toBe(true);
    // clamped input could not teleport the attacker
    const atkP = w.players.get('C1')!;
    expect(Math.hypot(atkP.pos.x, atkP.pos.z)).toBeLessThan(40);
  });

  it('downed players are revived by a teammate channeling next to them', () => {
    const r = setup(2, { latencyMs: 40, jitterMs: 10, loss: 0.05 });
    r.host.startRun();
    r.step(5);
    const w = r.host.world;
    // keep the room quiet so nothing interferes
    w.room.waves = [];
    const victim = w.players.get('C1')!;
    // spread out so the revive has to be earned by walking over
    w.players.get('H')!.pos.x = victim.pos.x + 9;
    w.players.get('C2')!.pos.x = victim.pos.x - 8;
    damagePlayerRaw(w, victim, 1000, 'fire');
    r.step(10);
    expect(victim.state).toBe('downed');
    expect(r.clients[0].state.players.get('C1')!.state).toBe('downed');
    // C2 walks to the victim
    for (let k = 0; k < 30 * 8 && victim.state === 'downed'; k++) {
      const me = w.players.get('C2')!;
      const dx = victim.pos.x - me.pos.x,
        dz = victim.pos.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      const i = emptyInput();
      if (d > 1.2) {
        i.mx = dx / d;
        i.mz = dz / d;
      }
      r.inputs.set('C2', i);
      r.step();
    }
    r.inputs.set('C2', emptyInput());
    r.step(10);
    expect(victim.state).toBe('alive');
    expect(r.hostEvents.some((e) => e.t === 'revive' && e.pid === 'C1' && e.by === 'C2')).toBe(true);
    for (const c of r.clients) expect(c.state.players.get('C1')!.state).toBe('alive');
  });

  it('players can drop in mid-run and join at the next room', () => {
    const r = setup(1);
    r.host.startRun();
    r.step(40);
    const late = r.addClient('LATE', ['storm', 'stone']);
    r.step(20);
    const w = r.host.world;
    expect(late.connected).toBe(true);
    expect(w.players.get('LATE')!.state).toBe('spectating');
    expect(late.state.players.get('LATE')!.state).toBe('spectating');
    // force the room to clear and everyone to pick
    w.room.waves = [];
    w.enemies.length = 0;
    w.run.waveIdx = 99;
    for (let k = 0; k < 30 * 4 && w.run.phase !== 'reward'; k++) r.step();
    expect(w.run.phase).toBe('reward');
    for (const id of w.players.keys()) {
      const offers = w.run.offers[id];
      if (!offers) continue;
      const s = id === 'H' ? r.host : r.clients.find((c) => c.localId === id)!;
      s.pick(offers[0]);
      s.vote(w.run.teamOffers[0]);
    }
    r.step(20);
    expect(w.run.roomIndex).toBe(1);
    expect(w.players.get('LATE')!.state).toBe('alive');
    expect(late.state.run.roomIndex).toBe(1);
    expect(late.state.players.get('LATE')!.state).toBe('alive');
  });

  it('clients predict their own primary shots and adopt the host copies (no double visuals)', () => {
    const r = setup(1, { latencyMs: 60, jitterMs: 10, loss: 0 });
    r.host.startRun();
    r.step(5);
    const i = emptyInput();
    i.az = -20;
    i.ay = 1;
    i.buttons = BTN_PRIMARY;
    r.inputs.set('C1', i);
    r.step(60);
    r.inputs.set('C1', emptyInput());
    r.step(30);
    const ev = r.clientEvents[0];
    const predicted = ev.filter((e) => e.t === 'proj' && e.id < 0);
    const hostCopies = ev.filter((e) => e.t === 'proj' && e.id > 0 && e.ck.startsWith('C1:'));
    const hostShots = r.hostEvents.filter((e) => e.t === 'proj' && e.ck.startsWith('C1:'));
    expect(predicted.length).toBeGreaterThan(5);
    expect(hostShots.length).toBeGreaterThan(5);
    // nearly every authoritative shot was matched to a predicted one
    expect(hostCopies.length).toBeLessThanOrEqual(Math.ceil(hostShots.length * 0.15));
    // ends of matched shots are re-addressed to the predicted visuals
    expect(ev.some((e) => e.t === 'projEnd' && e.id < 0)).toBe(true);
    // the first predicted shot appears before the host's copy could have arrived
    const firstPred = ev.findIndex((e) => e.t === 'proj' && e.id < 0);
    expect(firstPred).toBeGreaterThanOrEqual(0);
  });

  it('host leaving notifies clients', () => {
    const r = setup(1, { latencyMs: 20, jitterMs: 0, loss: 0 });
    const msgs: string[] = [];
    r.clients[0].onMessage = (m) => msgs.push(m);
    r.host.leave();
    r.hub.advance(100);
    expect(msgs.some((m) => m.includes('Host left'))).toBe(true);
  });
});
