import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { BTN_PRIMARY, emptyInput, SIM_DT } from '../src/sim/types';

describe('sim smoke', () => {
  it('runs a room with a bot shooting enemies', () => {
    const w = new World(1234);
    w.addPlayer({ id: 'a', name: 'A', gauntlets: ['fire', 'frost'] });
    w.startRun();
    const kinds = new Map<string, number>();
    let seq = 0;
    for (let i = 0; i < 30 * 90; i++) {
      const p = w.players.get('a')!;
      const e = w.enemies.find((x) => x.spawnT <= 0);
      const inp = emptyInput();
      inp.seq = ++seq;
      if (e) {
        inp.ax = e.pos.x; inp.ay = e.pos.y + 1; inp.az = e.pos.z;
        inp.yaw = Math.atan2(-(e.pos.x - p.pos.x), -(e.pos.z - p.pos.z));
        inp.buttons = BTN_PRIMARY;
        if (i % 90 === 0) inp.sig = (i / 90) & 255;
      }
      w.setInput('a', inp);
      w.step(SIM_DT);
      for (const ev of w.drainEvents()) kinds.set(ev.t, (kinds.get(ev.t) ?? 0) + 1);
      if (w.run.phase === 'reward') w.pick('a', w.run.offers['a'][0]), w.vote('a', w.run.teamOffers[0]);
    }
    console.log(Object.fromEntries(kinds), w.run.phase, w.run.roomIndex, w.players.get('a')!.hp);
    expect(kinds.get('hit')).toBeGreaterThan(10);
    expect(kinds.get('kill')).toBeGreaterThan(3);
  });
});
