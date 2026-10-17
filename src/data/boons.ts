import type { Element, Stats } from '../sim/types';
import { ELEMENTS } from '../sim/types';

export type BoonScope = 'team' | 'personal';
export type StatKey = Exclude<keyof Stats, 'elemMul'> | `elem.${Element}`;

export interface BoonMod {
  stat: StatKey;
  /** add: summed per stack. mul: multiplied per stack. */
  op: 'add' | 'mul';
  value: number;
}

export interface BoonDef {
  id: string;
  name: string;
  desc: string;
  scope: BoonScope;
  rarity: 1 | 2 | 3;
  maxStacks: number;
  mods: BoonMod[];
  /** locked until bought with shards in meta progression */
  locked?: boolean;
  glyph: string;
}

export const BOONS: BoonDef[] = [
  { id: 'split', name: 'Prism Split', desc: 'Primary casts fire +2 extra projectiles.', scope: 'personal', rarity: 2, maxStacks: 2, glyph: '⫶', mods: [{ stat: 'extraProjectiles', op: 'add', value: 2 }] },
  { id: 'fracture', name: 'Fracture', desc: 'Projectiles split into 2 shards on hit.', scope: 'personal', rarity: 2, maxStacks: 2, glyph: '✶', mods: [{ stat: 'splitOnHit', op: 'add', value: 2 }] },
  { id: 'pierce', name: 'Needle Focus', desc: 'Projectiles pierce +1 enemy.', scope: 'personal', rarity: 1, maxStacks: 3, glyph: '➶', mods: [{ stat: 'pierce', op: 'add', value: 1 }] },
  { id: 'linger', name: 'Lingering Fields', desc: 'Your zones last 40% longer.', scope: 'team', rarity: 1, maxStacks: 3, glyph: '◌', mods: [{ stat: 'zoneDuration', op: 'mul', value: 1.4 }] },
  { id: 'sprawl', name: 'Sprawl', desc: 'Zones are 25% larger.', scope: 'team', rarity: 2, maxStacks: 3, glyph: '◎', mods: [{ stat: 'zoneRadius', op: 'mul', value: 1.25 }] },
  { id: 'cataclysm', name: 'Cataclysm', desc: 'Combos deal 50% more damage.', scope: 'team', rarity: 2, maxStacks: 3, glyph: '✸', mods: [{ stat: 'comboDamage', op: 'mul', value: 1.5 }] },
  { id: 'resonance', name: 'Resonance', desc: 'Combo blasts are 30% larger.', scope: 'team', rarity: 2, maxStacks: 2, glyph: '❂', mods: [{ stat: 'comboRadius', op: 'mul', value: 1.3 }] },
  { id: 'kinship', name: 'Kinship', desc: 'Combos heal every contributor for 8.', scope: 'team', rarity: 1, maxStacks: 3, glyph: '♥', mods: [{ stat: 'healOnCombo', op: 'add', value: 8 }] },
  { id: 'swift', name: 'Quickstep', desc: 'Move 12% faster.', scope: 'personal', rarity: 1, maxStacks: 3, glyph: '»', mods: [{ stat: 'moveSpeed', op: 'mul', value: 1.12 }] },
  { id: 'dash', name: 'Second Stride', desc: '+1 dash charge.', scope: 'personal', rarity: 2, maxStacks: 2, glyph: '⇉', mods: [{ stat: 'dashCharges', op: 'add', value: 1 }] },
  { id: 'echo', name: 'Echo Sigil', desc: 'Signature cooldown -20%.', scope: 'personal', rarity: 2, maxStacks: 3, glyph: '↻', mods: [{ stat: 'sigCooldown', op: 'mul', value: 0.8 }] },
  { id: 'overcharge', name: 'Overcharge', desc: 'Heavy spells charge 35% faster.', scope: 'personal', rarity: 1, maxStacks: 3, glyph: '⚡', mods: [{ stat: 'chargeSpeed', op: 'mul', value: 1.35 }] },
  { id: 'vigor', name: 'Vigor', desc: '+25 max health.', scope: 'personal', rarity: 1, maxStacks: 4, glyph: '✚', mods: [{ stat: 'maxHp', op: 'add', value: 25 }] },
  { id: 'keen', name: 'Keen Edge', desc: '+10% critical chance.', scope: 'personal', rarity: 1, maxStacks: 4, glyph: '✧', mods: [{ stat: 'critChance', op: 'add', value: 0.1 }] },
  { id: 'velocity', name: 'Velocity', desc: 'Projectiles fly 25% faster, +8% damage.', scope: 'personal', rarity: 1, maxStacks: 3, glyph: '➹', mods: [{ stat: 'projSpeed', op: 'mul', value: 1.25 }, { stat: 'dmgMul', op: 'mul', value: 1.08 }] },
  { id: 'arcing', name: 'Forked Arcs', desc: 'Chain effects jump +2 more times.', scope: 'personal', rarity: 2, maxStacks: 2, glyph: 'ϟ', mods: [{ stat: 'chainCount', op: 'add', value: 2 }] },
  { id: 'lifeline', name: 'Lifeline', desc: 'Revive allies 50% faster.', scope: 'team', rarity: 1, maxStacks: 2, glyph: '⚕', mods: [{ stat: 'reviveSpeed', op: 'mul', value: 1.5 }] },
  { id: 'bulwark', name: 'Stoneskin', desc: 'Take 15% less damage.', scope: 'team', rarity: 2, maxStacks: 2, glyph: '⛨', mods: [{ stat: 'damageTaken', op: 'mul', value: 0.85 }] },
  { id: 'potency', name: 'Potency', desc: 'Status effects 40% stronger.', scope: 'team', rarity: 1, maxStacks: 3, glyph: '☍', mods: [{ stat: 'statusPower', op: 'mul', value: 1.4 }] },
  { id: 'volatile', name: 'Volatile', desc: 'Slain enemies burst for 30 damage.', scope: 'team', rarity: 3, maxStacks: 2, glyph: '✺', mods: [{ stat: 'explodeOnKill', op: 'add', value: 30 }], locked: true },
  { id: 'glasscannon', name: 'Glass Cannon', desc: '+35% damage, take 20% more damage.', scope: 'personal', rarity: 3, maxStacks: 1, glyph: '⚔', mods: [{ stat: 'dmgMul', op: 'mul', value: 1.35 }, { stat: 'damageTaken', op: 'mul', value: 1.2 }], locked: true },
  { id: 'convergence', name: 'Convergence', desc: 'Combos deal +80% damage and are 20% larger.', scope: 'team', rarity: 3, maxStacks: 1, glyph: '⨁', mods: [{ stat: 'comboDamage', op: 'mul', value: 1.8 }, { stat: 'comboRadius', op: 'mul', value: 1.2 }], locked: true },
  ...ELEMENTS.map(
    (el): BoonDef => ({
      id: `attune_${el}`,
      name: `${el[0].toUpperCase()}${el.slice(1)} Attunement`,
      desc: `${el[0].toUpperCase()}${el.slice(1)} spells deal 25% more damage.`,
      scope: 'personal',
      rarity: 1,
      maxStacks: 3,
      glyph: '✦',
      mods: [{ stat: `elem.${el}` as StatKey, op: 'mul', value: 1.25 }],
    }),
  ),
];

export const BOON_BY_ID: Record<string, BoonDef> = Object.fromEntries(BOONS.map((b) => [b.id, b]));

export const baseStats = (): Stats => ({
  dmgMul: 1,
  elemMul: { fire: 1, frost: 1, storm: 1, gale: 1, stone: 1, venom: 1 },
  extraProjectiles: 0,
  splitOnHit: 0,
  pierce: 0,
  zoneDuration: 1,
  zoneRadius: 1,
  comboDamage: 1,
  comboRadius: 1,
  moveSpeed: 1,
  dashCharges: 1,
  sigCooldown: 1,
  chargeSpeed: 1,
  maxHp: 100,
  healOnCombo: 0,
  critChance: 0.05,
  projSpeed: 1,
  chainCount: 0,
  reviveSpeed: 1,
  damageTaken: 1,
  statusPower: 1,
  explodeOnKill: 0,
});

/** Caps keep stacked builds sane. */
const CAPS: Partial<Record<keyof Stats, [number, number]>> = {
  critChance: [0, 0.75],
  damageTaken: [0.4, 2],
  sigCooldown: [0.35, 1],
  extraProjectiles: [0, 6],
  dashCharges: [1, 3],
  moveSpeed: [0.5, 1.8],
};

/**
 * Fold a list of boon ids (duplicates = stacks) into Stats.
 * 'add' mods sum; 'mul' mods multiply. Stacks beyond maxStacks are ignored. Unknown ids are ignored.
 */
export function aggregateBoons(ids: readonly string[]): Stats {
  const s = baseStats();
  const counts = new Map<string, number>();
  for (const id of ids) {
    const def = BOON_BY_ID[id];
    if (!def) continue;
    const n = (counts.get(id) ?? 0) + 1;
    if (n > def.maxStacks) continue;
    counts.set(id, n);
    for (const m of def.mods) {
      if (m.stat.startsWith('elem.')) {
        const el = m.stat.slice(5) as Element;
        s.elemMul[el] = m.op === 'add' ? s.elemMul[el] + m.value : s.elemMul[el] * m.value;
      } else {
        const k = m.stat as Exclude<keyof Stats, 'elemMul'>;
        s[k] = m.op === 'add' ? s[k] + m.value : s[k] * m.value;
      }
    }
  }
  for (const [k, [lo, hi]] of Object.entries(CAPS) as [keyof Stats, [number, number]][]) {
    const v = s[k] as number;
    (s[k] as number) = Math.min(hi, Math.max(lo, v));
  }
  return s;
}

export function stackCount(ids: readonly string[], id: string): number {
  return ids.filter((x) => x === id).length;
}

/** Offer `n` boons of a scope, excluding maxed and locked ones (unless unlocked). Deterministic given rng. */
export function rollBoons(
  rng: { next(): number },
  scope: BoonScope,
  owned: readonly string[],
  unlocked: ReadonlySet<string>,
  n = 3,
): string[] {
  const pool = BOONS.filter(
    (b) => b.scope === scope && (!b.locked || unlocked.has(b.id)) && stackCount(owned, b.id) < b.maxStacks,
  );
  const out: string[] = [];
  const weights = pool.map((b) => (b.rarity === 1 ? 6 : b.rarity === 2 ? 3 : 1.4));
  while (out.length < n && pool.length) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= weights[i];
      if (r <= 0) break;
    }
    out.push(pool[i].id);
    pool.splice(i, 1);
    weights.splice(i, 1);
  }
  return out;
}
