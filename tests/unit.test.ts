import { describe, it, expect } from 'vitest';
import { COMBO_RULES, findCombo, matchPattern, validateRules, type Reagent } from '../src/sim/comboTable';
import { aggregateBoons, BOONS, rollBoons, stackCount } from '../src/data/boons';
import { generateRoom, groundHeight, isOnPlatforms, ROOM_SEQUENCE } from '../src/sim/room';
import { computeDamage } from '../src/sim/combat';
import { computeLayout, hitButton, overlapsCenter, stickVector, classifyTouch, lookFromDrag, rimTurnRate } from '../src/input/touchLayout';
import { generateLightning } from '../src/vfx/lightning';
import { inTelegraph } from '../src/sim/ai';
import { Rng } from '../src/sim/rng';
import { World } from '../src/sim/world';
import { sanitizeInput, validGauntlets } from '../src/net/host';
import { stepMovement, newMoveState, MOVE } from '../src/sim/movement';
import { emptyInput, SIM_DT, BTN_JUMP, type Telegraph } from '../src/sim/types';

const R = (kind: Reagent['kind'], element: Reagent['element'], tag: string): Reagent => ({ kind, element, tag });

describe('combo table', () => {
  it('is well formed', () => {
    expect(validateRules(COMBO_RULES)).toEqual([]);
    expect(COMBO_RULES.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves the required combos in either order', () => {
    const cases: [Reagent, Reagent, string][] = [
      [R('zone', 'gale', 'vortex'), R('projectile', 'fire', 'ember'), 'firestorm'],
      [R('projectile', 'fire', 'ember'), R('zone', 'gale', 'vortex'), 'firestorm'],
      [R('zone', 'gale', 'vortex'), R('zone', 'venom', 'venomcloud'), 'toxic_tempest'],
      [R('blast', 'fire', 'blast'), R('zone', 'venom', 'venomcloud'), 'detonation'],
      [R('projectile', 'storm', 'arc'), R('zone', 'frost', 'puddle'), 'chain_electrocution'],
      [R('projectile', 'storm', 'spear'), R('zone', 'frost', 'frostpatch'), 'chain_electrocution'],
      [R('projectile', 'stone', 'pebble'), R('status', 'frost', 'frozen'), 'shatter'],
      [R('projectile', 'fire', 'ember'), R('zone', 'frost', 'frostpatch'), 'steam'],
      [R('projectile', 'fire', 'ember'), R('status', 'frost', 'frozen'), 'steam_status'],
      [R('projectile', 'gale', 'gust'), R('zone', 'stone', 'wall'), 'wall_redirect'],
      [R('projectile', 'venom', 'glob'), R('zone', 'stone', 'wall'), 'wall_block'],
      [R('projectile', 'fire', 'ember'), R('zone', 'stone', 'wall'), 'magma_wall'],
      [R('projectile', 'storm', 'arc'), R('status', null, 'wet'), 'conduction'],
    ];
    for (const [a, b, id] of cases) expect(findCombo(a, b)?.rule.id, `${a.tag}+${b.tag}`).toBe(id);
  });

  it('reports which side matched which pattern', () => {
    const m = findCombo(R('projectile', 'fire', 'ember'), R('zone', 'gale', 'vortex'))!;
    expect(m.swapped).toBe(true);
    expect(m.a.tag).toBe('vortex');
  });

  it('returns null for non-interactions', () => {
    expect(findCombo(R('projectile', 'frost', 'shard'), R('zone', 'frost', 'frostpatch'))).toBeNull();
    expect(findCombo(R('projectile', 'fire', 'ember'), R('zone', 'fire', 'burning'))).toBeNull();
  });

  it('pattern matching supports arrays and any', () => {
    expect(matchPattern({ kind: ['zone', 'blast'], tag: 'any' }, R('blast', 'fire', 'x'))).toBe(true);
    expect(matchPattern({ element: ['frost'] }, R('zone', 'fire', 'x'))).toBe(false);
    expect(matchPattern({}, R('zone', null, 'x'))).toBe(true);
  });

  it('table order gives priority (gale reflects before generic wall block)', () => {
    const custom = [
      { id: 'a', name: 'A', a: { kind: 'projectile' }, b: { tag: 'wall' }, effect: { type: 'block' as const } },
      { id: 'b', name: 'B', a: { kind: 'projectile', element: 'gale' }, b: { tag: 'wall' }, effect: { type: 'reflect' as const } },
    ];
    expect(findCombo(R('projectile', 'gale', 'gust'), R('zone', 'stone', 'wall'), custom)!.rule.id).toBe('a');
  });

  it('combos credit every contributor end-to-end in the sim', () => {
    const w = new World(5);
    w.addPlayer({ id: 'a', name: 'A', gauntlets: ['venom', 'fire'] });
    w.addPlayer({ id: 'b', name: 'B', gauntlets: ['fire', 'frost'] });
    w.startRun();
    w.spawnZone({ tag: 'venomcloud', element: 'venom', pos: { x: 0, y: 0, z: 0 }, radius: 3, life: 5, dps: 5, contributors: ['a'] });
    w.spawnZone({ tag: 'burning', element: 'fire', pos: { x: 1, y: 0, z: 0 }, radius: 2, life: 5, dps: 5, contributors: ['b'] });
    w.step(SIM_DT);
    const ev = w.drainEvents().find((e) => e.t === 'combo');
    expect(ev && ev.t === 'combo' && ev.key).toBe('detonation');
    expect(ev && ev.t === 'combo' && ev.pids.sort()).toEqual(['a', 'b']);
    expect(w.zones.some((z) => z.tag === 'venomcloud')).toBe(false);
  });

  it('frost patches melt into puddles that Storm electrifies across the network', () => {
    const w = new World(6);
    w.addPlayer({ id: 'a', name: 'A', gauntlets: ['storm', 'frost'] });
    w.startRun();
    w.spawnZone({ tag: 'frostpatch', element: 'frost', pos: { x: 0, y: 0, z: 0 }, radius: 2, life: 0.05, dps: 0, contributors: ['a'] });
    w.step(SIM_DT);
    w.step(SIM_DT);
    expect(w.zones.some((z) => z.tag === 'puddle')).toBe(true);
    w.spawnZone({ tag: 'puddle', element: 'frost', pos: { x: 3.5, y: 0, z: 0 }, radius: 2, life: 9, dps: 0, contributors: ['a'] });
    w.spawnZone({ tag: 'stormcell', element: 'storm', pos: { x: 0, y: 0, z: 0 }, radius: 2, life: 3, dps: 0, contributors: ['a'] });
    w.step(SIM_DT);
    expect(w.zones.filter((z) => z.tag === 'electrified').length).toBe(2);
  });
});

describe('boon stacking', () => {
  it('add mods sum and mul mods multiply', () => {
    const s = aggregateBoons(['vigor', 'vigor', 'linger', 'linger', 'pierce']);
    expect(s.maxHp).toBe(150);
    expect(s.zoneDuration).toBeCloseTo(1.4 * 1.4);
    expect(s.pierce).toBe(1);
  });
  it('respects max stacks and ignores unknown ids', () => {
    const s = aggregateBoons(['glasscannon', 'glasscannon', 'nope']);
    expect(s.dmgMul).toBeCloseTo(1.35);
    expect(stackCount(['a', 'b', 'a'], 'a')).toBe(2);
  });
  it('applies global caps', () => {
    const s = aggregateBoons(Array(10).fill('keen'));
    expect(s.critChance).toBeLessThanOrEqual(0.75);
    const t = aggregateBoons(['bulwark', 'bulwark', 'bulwark']);
    expect(t.damageTaken).toBeGreaterThanOrEqual(0.4);
    expect(t.damageTaken).toBeCloseTo(0.85 * 0.85);
  });
  it('element attunement multiplies only its element', () => {
    const s = aggregateBoons(['attune_fire', 'attune_fire']);
    expect(s.elemMul.fire).toBeCloseTo(1.5625);
    expect(s.elemMul.frost).toBe(1);
  });
  it('rolls are deterministic, unique, and skip locked/maxed boons', () => {
    const a = rollBoons(new Rng(3), 'personal', [], new Set(), 3);
    const b = rollBoons(new Rng(3), 'personal', [], new Set(), 3);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    const locked = BOONS.filter((x) => x.locked).map((x) => x.id);
    for (let i = 0; i < 50; i++) for (const id of rollBoons(new Rng(i), 'team', [], new Set(), 3)) expect(locked).not.toContain(id);
    const maxed = Array(2).fill('split');
    for (let i = 0; i < 30; i++) expect(rollBoons(new Rng(i), 'personal', maxed, new Set(), 3)).not.toContain('split');
  });
});

describe('seeded room generation', () => {
  it('is deterministic for a seed and index', () => {
    const a = generateRoom(777, 3, 2);
    const b = generateRoom(777, 3, 2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(generateRoom(778, 3, 2))).not.toBe(JSON.stringify(a));
  });
  it('geometry is independent of player count (clients regenerate it)', () => {
    const a = generateRoom(42, 2, 1),
      b = generateRoom(42, 2, 4);
    expect(a.platforms).toEqual(b.platforms);
    expect(a.obstacles).toEqual(b.obstacles);
    expect(b.waves[0].enemies.length).toBeGreaterThan(a.waves[0].enemies.length);
  });
  it('follows the run sequence and ends with a boss', () => {
    for (let i = 0; i < ROOM_SEQUENCE.length; i++) expect(generateRoom(9, i, 1).kind).toBe(ROOM_SEQUENCE[i]);
    const boss = generateRoom(9, ROOM_SEQUENCE.length - 1, 1);
    expect(['kiln', 'prism']).toContain(boss.boss);
  });
  it('spawns are on solid ground and away from pillars', () => {
    for (let s = 0; s < 20; s++) {
      const r = generateRoom(s * 31, s % 6, 2);
      for (const p of [...r.spawns, ...r.playerSpawns]) {
        expect(isOnPlatforms(r.platforms, p.x, p.z)).toBe(true);
        expect(groundHeight(r, p.x, p.z, 1)).toBeGreaterThan(-1);
      }
      for (const p of r.playerSpawns) for (const o of r.obstacles) expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThan(o.r);
    }
  });
});

describe('damage math', () => {
  const base = { dmgMul: 1, elemMul: 1, comboMul: 1, wet: false, crit: false };
  it('applies resistances and weaknesses', () => {
    expect(computeDamage(100, 'fire', { fire: 0.4 }, base)).toBe(40);
    expect(computeDamage(100, 'frost', { frost: 1.5 }, base)).toBe(150);
    expect(computeDamage(100, 'gale', { fire: 0.4 }, base)).toBe(100);
  });
  it('multiplies boons, combos, wet storm and crits', () => {
    expect(computeDamage(10, 'storm', {}, { ...base, wet: true })).toBeCloseTo(14);
    expect(computeDamage(10, 'fire', {}, { ...base, wet: true })).toBe(10);
    expect(computeDamage(10, 'fire', {}, { ...base, crit: true, dmgMul: 1.5, elemMul: 2, comboMul: 1.5 })).toBeCloseTo(90);
  });
  it('never goes negative', () => {
    expect(computeDamage(-5, 'fire', {}, base)).toBe(0);
  });
});

describe('touch input mapping', () => {
  const phones = [
    [844, 390, { l: 47, r: 47, t: 0, b: 21 }],
    [932, 430, { l: 59, r: 59, t: 0, b: 21 }],
    [667, 375, { l: 0, r: 0, t: 0, b: 0 }],
    [1180, 820, { l: 0, r: 0, t: 24, b: 20 }],
  ] as const;
  it('keeps every button on-screen, inside safe areas, and off the centre', () => {
    for (const [w, h, safe] of phones) {
      const L = computeLayout(w, h, safe);
      expect(overlapsCenter(L)).toBe(false);
      for (const b of L.buttons) {
        expect(b.x - b.r).toBeGreaterThanOrEqual(safe.l);
        expect(b.x + b.r).toBeLessThanOrEqual(w - safe.r);
        expect(b.y + b.r).toBeLessThanOrEqual(h - safe.b);
        expect(b.r).toBeGreaterThanOrEqual(20); // thumb-sized
      }
    }
  });
  it('buttons do not overlap each other', () => {
    for (const [w, h, safe] of phones) {
      const L = computeLayout(w, h, safe);
      for (const a of L.buttons) for (const b of L.buttons) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r - 2);
    }
  });
  it('hit tests and classifies touches', () => {
    const L = computeLayout(844, 390);
    const p = L.buttons.find((b) => b.id === 'primary')!;
    expect(hitButton(L, p.x + p.r * 0.5, p.y)).toBe('primary');
    expect(classifyTouch(L, 80, 300)).toBe('move');
    expect(classifyTouch(L, 520, 120)).toBe('aim');
  });
  it('stick vector has deadzone, clamps, and points up for upward drags', () => {
    expect(stickVector(100, 100, 103, 100, 60)).toEqual({ x: 0, y: 0, mag: 0 });
    const v = stickVector(100, 100, 100, 0, 60);
    expect(v.y).toBeCloseTo(1);
    expect(v.mag).toBeLessThanOrEqual(1);
    const d = stickVector(0, 0, 30, 0, 60);
    expect(d.x).toBeGreaterThan(0.3);
    expect(d.x).toBeLessThan(0.6);
  });
  it('look drag scales with sensitivity and rim turning only near the edge', () => {
    const a = lookFromDrag(10, 0, 1, 1),
      b = lookFromDrag(10, 0, 2, 1);
    expect(b.yaw).toBeCloseTo(a.yaw * 2);
    expect(rimTurnRate({ x: 0.5, mag: 0.5 }, 1)).toBe(0);
    expect(rimTurnRate({ x: 1, mag: 1 }, 1)).toBeGreaterThan(0);
  });
});

describe('vfx + sim helpers', () => {
  it('lightning is deterministic, branches, and connects endpoints', () => {
    const a = generateLightning(0, 10, 0, 0, 0, 0, 7);
    const b = generateLightning(0, 10, 0, 0, 0, 0, 7);
    expect(a).toEqual(b);
    const main = a.paths[0];
    expect(main.slice(0, 3)).toEqual([0, 10, 0]);
    expect(main.slice(-3)).toEqual([0, 0, 0]);
    expect(main.length / 3).toBe(2 ** 5 + 1);
    expect(a.paths.length).toBeGreaterThan(1);
  });
  it('telegraph shapes test points correctly (and jumping clears lines)', () => {
    const base: Telegraph = { id: 1, shape: 'circle', x: 0, y: 0, z: 0, r: 3, r2: 0, angle: 0, len: 10, width: 2, t: 0, dur: 1, dmg: 1, element: 'fire', owner: 0, knock: 0 };
    expect(inTelegraph(base, 2, 0, 0)).toBe(true);
    expect(inTelegraph(base, 4, 0, 0)).toBe(false);
    const ring = { ...base, shape: 'ring' as const, r: 6, r2: 3 };
    expect(inTelegraph(ring, 1, 0, 0)).toBe(false);
    expect(inTelegraph(ring, 4.5, 0, 0)).toBe(true);
    expect(inTelegraph(ring, 4.5, 2, 0)).toBe(false);
    const line = { ...base, shape: 'line' as const, angle: 0 };
    expect(inTelegraph(line, 0, 0, 5)).toBe(true);
    expect(inTelegraph(line, 0, 0, -3)).toBe(false);
    expect(inTelegraph(line, 3, 0, 5)).toBe(false);
    const cone = { ...base, shape: 'cone' as const, r: 8, width: 0.5, angle: 0 };
    expect(inTelegraph(cone, 0, 0, 5)).toBe(true);
    expect(inTelegraph(cone, 5, 0, 0)).toBe(false);
  });
  it('sanitises hostile inputs', () => {
    const s = sanitizeInput({ mx: 50, mz: 50, ax: 1e9, sig: 900, buttons: 1e6, yaw: NaN } as never);
    expect(Math.hypot(s.mx, s.mz)).toBeCloseTo(1);
    expect(s.ax).toBe(500);
    expect(s.sig).toBeLessThan(256);
    expect(s.yaw).toBe(0);
    expect(validGauntlets(['fire', 'fire'])).toEqual(['fire', 'frost']);
  });
  it('movement: walking stops at the island rim, dashing off the edge falls', () => {
    const r = generateRoom(11, 0, 1);
    const run = (dash: boolean) => {
      const m = newMoveState(0, 0, 0);
      let prev = { jump: 0, dash: 0 };
      let minY = 0;
      for (let i = 0; i < 30 * 12; i++) {
        const inp = emptyInput();
        inp.mx = 1; // walk east forever
        if (dash && i > 30 * 6) inp.dash = Math.floor(i / 10) & 255;
        stepMovement(m, inp, prev, SIM_DT, { room: r, walls: [] });
        prev = { jump: inp.jump, dash: inp.dash };
        minY = Math.min(minY, m.pos.y);
      }
      return { m, minY };
    };
    const walk = run(false);
    expect(walk.minY).toBeGreaterThan(-0.01);
    expect(isOnPlatforms(r.platforms, walk.m.pos.x, walk.m.pos.z)).toBe(true);
    const dash = run(true);
    expect(dash.minY).toBeLessThan(-1);
  });

  it('movement: double jump reaches raised ledges, hover slows the fall', () => {
    const r = generateRoom(1, 0, 1);
    const m = newMoveState(0, 0, 0);
    let prev = { jump: 0, dash: 0 };
    let maxY = 0;
    for (let i = 0; i < 40; i++) {
      const inp = emptyInput();
      inp.jump = i >= 0 ? 1 : 0;
      if (i >= 12) inp.jump = 2;
      inp.buttons = i > 20 ? BTN_JUMP : 0;
      stepMovement(m, inp, prev, SIM_DT, { room: r, walls: [] });
      prev = { jump: inp.jump, dash: inp.dash };
      maxY = Math.max(maxY, m.pos.y);
      if (i > 25) expect(m.vel.y).toBeGreaterThanOrEqual(MOVE.hoverFall - 0.01);
    }
    expect(maxY).toBeGreaterThan(2.4);
  });
});
