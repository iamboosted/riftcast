import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { BTN_HEAVY, BTN_PRIMARY, emptyInput, SIM_DT, type Element, type SimEvent } from '../src/sim/types';
import { ROOM_SEQUENCE } from '../src/sim/room';
import { hash2 } from '../src/sim/rng';

/** A strong bot that aims at the nearest enemy, cycles all spells and picks boons. */
function botRun(seed: number, gauntlets: [Element, Element], maxSeconds = 900) {
  const w = new World(seed);
  w.addPlayer({ id: 'bot', name: 'Bot', gauntlets });
  w.startRun();
  const seen = new Set<string>();
  const kinds = new Set<string>();
  let t = 0;
  let maxBossPhase = 0;
  for (; t < maxSeconds * 30; t++) {
    const p = w.players.get('bot')!;
    // god-mode tuning so the test is about code paths, not balance
    p.stats.dmgMul = 6;
    p.hp = p.maxHp;
    if (p.state === 'downed') p.state = 'alive';
    const inp = emptyInput();
    inp.seq = t;
    let best = null as (typeof w.enemies)[number] | null;
    let bd = Infinity;
    for (const e of w.enemies) {
      kinds.add(e.kind);
      if (e.boss) maxBossPhase = Math.max(maxBossPhase, e.phase);
      if (e.spawnT > 0) continue;
      const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (best) {
      inp.ax = best.pos.x;
      inp.ay = best.pos.y + best.height * 0.5;
      inp.az = best.pos.z;
      inp.yaw = Math.atan2(-(best.pos.x - p.pos.x), -(best.pos.z - p.pos.z));
      if (bd > 9) {
        inp.mx = (best.pos.x - p.pos.x) / bd;
        inp.mz = (best.pos.z - p.pos.z) / bd;
      }
      const cyc = t % 90;
      inp.buttons = cyc < 55 ? BTN_PRIMARY : cyc < 80 ? BTN_HEAVY : 0;
      inp.sig = Math.floor(t / 150) & 255;
      inp.swap = Math.floor(t / 300) & 255;
      inp.dash = Math.floor(t / 100) & 255;
    }
    w.setInput('bot', inp);
    w.step(SIM_DT);
    for (const e of w.drainEvents()) seen.add(e.t === 'combo' ? `combo:${e.key}` : e.t);
    if (w.run.phase === 'reward') {
      w.pick('bot', w.run.offers['bot'][0]);
      w.vote('bot', w.run.teamOffers[0]);
    }
    if (w.run.phase === 'victory' || w.run.phase === 'defeat') break;
  }
  return { w, seen, kinds, t, maxBossPhase };
}

describe('full runs', () => {
  // pick seeds that land on each boss
  const seedFor = (boss: number) => {
    for (let s = 1; s < 500; s++) if (hash2(s, 99) % 2 === boss) return s;
    return 1;
  };
  for (const [boss, g] of [
    [0, ['fire', 'gale']],
    [1, ['storm', 'venom']],
  ] as [number, [Element, Element]][]) {
    it(`clears all ${ROOM_SEQUENCE.length} rooms and defeats boss #${boss} through 3 phases`, () => {
      const r = botRun(seedFor(boss), g);
      expect(r.w.run.phase).toBe('victory');
      expect(r.w.run.roomIndex).toBe(ROOM_SEQUENCE.length - 1);
      expect(r.maxBossPhase).toBe(3);
      expect(r.seen.has('tele')).toBe(true);
      expect(r.seen.has('boss')).toBe(true);
      expect(r.w.players.get('bot')!.boons.length).toBe(ROOM_SEQUENCE.length - 1);
      expect(r.w.teamBoons.length).toBe(ROOM_SEQUENCE.length - 1);
    }, 60000);
  }
});

describe('content coverage', () => {
  it('every gauntlet slot casts without errors and produces events', () => {
    const els: Element[] = ['fire', 'frost', 'storm', 'gale', 'stone', 'venom'];
    for (const el of els) {
      const w = new World(3);
      w.addPlayer({ id: 'p', name: 'P', gauntlets: [el, el === 'fire' ? 'frost' : 'fire'] });
      w.startRun();
      const evs: SimEvent[] = [];
      for (let t = 0; t < 30 * 4; t++) {
        const i = emptyInput();
        i.az = -12;
        i.ay = 0.5;
        i.buttons = t < 30 ? BTN_PRIMARY : t < 60 ? BTN_HEAVY : 0;
        i.sig = t > 80 ? 1 : 0;
        w.setInput('p', i);
        w.step(SIM_DT);
        evs.push(...w.drainEvents());
      }
      const slots = new Set(evs.filter((e) => e.t === 'cast').map((e) => (e as Extract<SimEvent, { t: 'cast' }>).slot));
      expect([...slots].sort(), el).toEqual(['heavy', 'primary', 'signature']);
    }
  });
});
