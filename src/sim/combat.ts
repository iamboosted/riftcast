import type { World } from './world';
import type { Element, Enemy } from './types';
import { ENEMIES } from '../data/enemies';
import { findCombo, type Reagent } from './comboTable';
import { applyCombo } from './combos';
import { V3 } from './vec';

export interface DamageOpts {
  /** reagent kind this damage came from; enables status-combo checks */
  via?: 'projectile' | 'blast';
  /** spell/tag for the reagent */
  tag?: string;
  combo?: boolean;
  noCrit?: boolean;
  statusAmt?: number;
  knock?: { x: number; z: number; f: number; lift?: number };
  /** skip status application (DoT ticks) */
  noStatus?: boolean;
  contributors?: string[];
}

/** Pure damage math (unit tested). */
export function computeDamage(
  base: number,
  el: Element,
  resist: Partial<Record<Element, number>>,
  mods: { dmgMul: number; elemMul: number; comboMul: number; wet: boolean; crit: boolean },
): number {
  let d = base * (resist[el] ?? 1) * mods.dmgMul * mods.elemMul * mods.comboMul;
  if (mods.wet && el === 'storm') d *= 1.4;
  if (mods.crit) d *= 2;
  return Math.max(0, d);
}

const STATUS_COMBO_TAGS = ['frozen', 'wet'] as const;

export function damageEnemy(w: World, e: Enemy, base: number, el: Element, src: string, o: DamageOpts = {}): number {
  if (e.hp <= 0) return 0;
  const p = w.players.get(src);
  const stats = p?.stats;
  // Status-driven combos (Shatter, Steam, Conduction) take priority and consume the status.
  if (o.via && !o.combo) {
    for (const st of STATUS_COMBO_TAGS) {
      const active = st === 'frozen' ? e.st.frozen > 0 : e.st.wet > 0;
      if (!active) continue;
      const a: Reagent = { kind: o.via, element: el, tag: o.tag ?? o.via };
      const b: Reagent = { kind: 'status', element: st === 'frozen' ? 'frost' : null, tag: st };
      const m = findCombo(a, b);
      if (m) {
        const by = e.statusBy[st];
        applyCombo(w, m, { pos: { ...e.pos }, enemy: e, contributors: uniq([src, by ?? src]) });
        break;
      }
    }
  }
  if (e.hp <= 0) return 0;
  if (e.boss && (e.data.inv ?? 0) > 0) return 0;
  const crit = !o.noCrit && !!stats && w.rng.next() < stats.critChance;
  const comboMul = o.combo ? w.teamStats.comboDamage : 1;
  const amt = computeDamage(base, el, ENEMIES[e.kind]?.resist ?? {}, {
    dmgMul: stats?.dmgMul ?? 1,
    elemMul: stats?.elemMul[el] ?? 1,
    comboMul,
    wet: e.st.wet > 0,
    crit,
  });
  e.hp -= amt;
  // bosses can't skip phases: clamp just below the next threshold until the transition plays
  if (e.boss && e.phase < 3) {
    const floor = (e.phase === 1 ? 0.66 : 0.33) * e.maxHp - 1;
    if (e.hp < floor) e.hp = floor;
  }
  e.hitFlash = 1;
  e.lastHitEl = el;
  if (src) e.lastHitBy = src;
  if (p) p.dmgDealt += amt;
  w.emit({ t: 'hit', id: e.id, x: e.pos.x, y: e.pos.y + e.height * 0.6, z: e.pos.z, amt: Math.round(amt), el, crit: crit ? 1 : 0 });
  if (!o.noStatus) applyStatus(w, e, el, src, (o.statusAmt ?? 1) * (stats?.statusPower ?? w.teamStats.statusPower));
  if (o.knock && !e.boss) {
    const l = Math.hypot(o.knock.x, o.knock.z) || 1;
    const f = o.knock.f * (e.elite ? 0.35 : 1);
    e.kx += (o.knock.x / l) * f;
    e.kz += (o.knock.z / l) * f;
    if (o.knock.lift && !e.elite) e.ky = Math.max(e.ky, o.knock.lift);
  }
  if (e.hp <= 0) killEnemy(w, e);
  return amt;
}

export function applyStatus(w: World, e: Enemy, el: Element, src: string, power: number): void {
  const st = e.st;
  switch (el) {
    case 'fire':
      st.burn = 3;
      st.burnDps = Math.max(st.burnDps, 6 * power);
      e.statusBy.burn = src;
      if (st.chill > 0) st.chill = Math.max(0, st.chill - 30);
      break;
    case 'frost':
      if (st.frozen > 0) break;
      st.chill += 16 * power * (e.boss ? 0.25 : e.elite ? 0.5 : 1);
      if (st.chill >= 100) {
        st.chill = 0;
        st.frozen = e.boss ? 1 : e.elite ? 1.6 : 2.4;
        e.statusBy.frozen = src;
        if (e.state === 'windup') cancelAttack(w, e);
      }
      break;
    case 'storm':
      st.shock = Math.max(st.shock, 0.3);
      e.statusBy.shock = src;
      break;
    case 'stone':
      st.stagger = 0.35;
      if (e.state === 'windup' && !e.elite && !e.boss) cancelAttack(w, e);
      break;
    case 'venom':
      st.poison = Math.min(10, st.poison + 1 * power);
      st.poisonT = 4;
      e.statusBy.poison = src;
      break;
    case 'gale':
      break;
  }
}

export function cancelAttack(w: World, e: Enemy): void {
  w.telegraphs = w.telegraphs.filter((t) => t.owner !== e.id);
  e.state = 'recover';
  e.stateT = 0.5;
}

export function killEnemy(w: World, e: Enemy): void {
  const i = w.enemies.indexOf(e);
  if (i < 0) return;
  w.enemies.splice(i, 1);
  cancelAttack(w, e);
  w.emit({ t: 'kill', id: e.id, x: e.pos.x, y: e.pos.y, z: e.pos.z, el: e.lastHitEl, kind: e.kind });
  const killer = e.lastHitBy ? w.players.get(e.lastHitBy) : undefined;
  if (killer) killer.kills++;
  w.run.shardsEarned += e.boss ? 25 : e.elite ? 3 : 0.5;
  if (!e.boss && w.rng.chance(e.elite ? 1 : 0.07)) {
    w.pickups.push({ id: w.id(), kind: 'heal', value: '18', pos: { x: e.pos.x, y: e.flying ? e.pos.y - 2.2 : e.pos.y, z: e.pos.z }, t: 0 });
  }
  const boom = w.teamStats.explodeOnKill;
  if (boom > 0) blast(w, { ...e.pos }, 3, boom, e.lastHitEl ?? 'fire', e.lastHitBy ?? '', { small: true, noCombo: true });
}

export interface BlastOpts {
  skip?: number;
  knock?: number;
  lift?: number;
  noSelf?: boolean;
  small?: boolean;
  statusAmt?: number;
  combo?: boolean;
  noCombo?: boolean;
  contributors?: string[];
  depth?: number;
}

/** Area damage + zone interactions (a fire blast inside a venom cloud detonates it, etc). */
export function blast(w: World, c: V3, r: number, dmg: number, el: Element, src: string, o: BlastOpts = {}): void {
  for (const e of [...w.enemies]) {
    if (e.id === o.skip) continue;
    const dx = e.pos.x - c.x,
      dz = e.pos.z - c.z;
    const dy = e.pos.y + e.height * 0.5 - c.y;
    const d = Math.hypot(dx, dz);
    if (d > r + e.radius || Math.abs(dy) > r + e.height) continue;
    const fall = o.small ? 1 : 1 - 0.4 * Math.min(1, d / (r + e.radius));
    damageEnemy(w, e, dmg * fall, el, src, {
      via: o.noCombo ? undefined : 'blast',
      tag: 'blast',
      combo: o.combo,
      statusAmt: o.statusAmt,
      knock: o.knock ? { x: dx || 0.01, z: dz, f: o.knock, lift: o.lift } : undefined,
    });
  }
  if (o.noCombo || (o.depth ?? 0) > 3) return;
  // Blast vs zones
  const reagent: Reagent = { kind: 'blast', element: el, tag: 'blast' };
  for (const z of [...w.zones]) {
    if (!w.zones.includes(z)) continue;
    const d = Math.hypot(z.pos.x - c.x, z.pos.z - c.z);
    if (d > r + z.radius * 0.8) continue;
    const m = findCombo(reagent, { kind: 'zone', element: z.element, tag: z.tag });
    if (!m || m.rule.silent) continue;
    applyCombo(w, m, { pos: { ...z.pos }, zone: z, contributors: uniq([src, ...(o.contributors ?? []), ...z.contributors]), depth: (o.depth ?? 0) + 1 });
  }
}

/** Sky lightning strike: emits a strike event and an electric blast. */
export function strike(w: World, at: V3, r: number, dmg: number, src: string): void {
  w.emit({ t: 'strike', x: at.x, y: at.y, z: at.z, r, el: 'storm' });
  blast(w, at, r, dmg, 'storm', src, {});
}

/** Chain lightning hopping between nearest enemies not yet hit. */
export function chainLightning(w: World, from: Enemy, dmg: number, jumps: number, range: number, src: string, combo = false, wetOnly = false): number {
  const hit = new Set<number>([from.id]);
  let cur = from;
  let n = 0;
  for (let j = 0; j < jumps; j++) {
    let best: Enemy | null = null;
    let bd = range;
    for (const e of w.enemies) {
      if (hit.has(e.id)) continue;
      if (wetOnly && e.st.wet <= 0) continue;
      const d = Math.hypot(e.pos.x - cur.pos.x, e.pos.z - cur.pos.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (!best) break;
    hit.add(best.id);
    w.emit({
      t: 'bolt',
      x: cur.pos.x,
      y: cur.pos.y + cur.height * 0.6,
      z: cur.pos.z,
      x2: best.pos.x,
      y2: best.pos.y + best.height * 0.6,
      z2: best.pos.z,
      el: 'storm',
    });
    damageEnemy(w, best, dmg, 'storm', src, { combo, noCrit: combo });
    cur = best;
    n++;
  }
  return n;
}

export const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];
