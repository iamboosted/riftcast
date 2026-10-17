import table from '../data/combos.json';
import type { Element, ZoneTag } from './types';

export type ReagentKind = 'projectile' | 'zone' | 'status' | 'blast';

/** Anything that can take part in an elemental interaction. */
export interface Reagent {
  kind: ReagentKind;
  element: Element | null;
  /** zone tag, status name, spell id (projectiles) or 'blast' */
  tag: string;
}

type OneOrMany = string | string[];
export interface Pattern {
  kind?: OneOrMany;
  element?: OneOrMany;
  tag?: OneOrMany;
}

export interface ComboEffect {
  type: 'reflect' | 'block' | 'transform' | 'explode' | 'spawn' | 'electrify' | 'shatter' | 'chain';
  into?: ZoneTag;
  zone?: ZoneTag;
  element?: Element;
  dps?: number;
  damage?: number;
  damageMul?: number;
  radius?: number;
  radiusMul?: number;
  minRadius?: number;
  lifeAdd?: number;
  life?: number;
  growth?: number;
  duration?: number;
  jumps?: number;
  consume?: boolean;
  freeze?: boolean;
}

export interface ComboRule {
  id: string;
  name: string;
  silent?: boolean;
  a: Pattern;
  b: Pattern;
  effect: ComboEffect;
}

export interface ComboMatch {
  rule: ComboRule;
  /** reagent matched by pattern a */
  a: Reagent;
  /** reagent matched by pattern b */
  b: Reagent;
  swapped: boolean;
}

export const COMBO_RULES: ComboRule[] = (table as { rules: ComboRule[] }).rules;

const has = (p: OneOrMany | undefined, v: string | null): boolean => {
  if (p === undefined) return true;
  if (Array.isArray(p)) return p.includes('any') || (v !== null && p.includes(v));
  return p === 'any' || p === v;
};

export function matchPattern(p: Pattern, r: Reagent): boolean {
  return has(p.kind, r.kind) && has(p.element, r.element) && has(p.tag, r.tag);
}

/** Resolve the first rule (in table order) matching the pair in either order. */
export function findCombo(x: Reagent, y: Reagent, rules: ComboRule[] = COMBO_RULES): ComboMatch | null {
  for (const rule of rules) {
    if (matchPattern(rule.a, x) && matchPattern(rule.b, y)) return { rule, a: x, b: y, swapped: false };
    if (matchPattern(rule.a, y) && matchPattern(rule.b, x)) return { rule, a: y, b: x, swapped: true };
  }
  return null;
}

/** Validates the table shape; used by tests and at boot in dev. */
export function validateRules(rules: ComboRule[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const types = ['reflect', 'block', 'transform', 'explode', 'spawn', 'electrify', 'shatter', 'chain'];
  for (const r of rules) {
    if (!r.id) errs.push('rule missing id');
    if (ids.has(r.id)) errs.push(`duplicate id ${r.id}`);
    ids.add(r.id);
    if (!r.a || !r.b) errs.push(`${r.id}: missing pattern`);
    if (!r.effect || !types.includes(r.effect.type)) errs.push(`${r.id}: bad effect type`);
    if ((r.effect?.type === 'transform') && !r.effect.into) errs.push(`${r.id}: transform needs into`);
    if ((r.effect?.type === 'spawn') && !r.effect.zone) errs.push(`${r.id}: spawn needs zone`);
    if (!r.silent && !r.name) errs.push(`${r.id}: non-silent rule needs a name`);
  }
  return errs;
}
