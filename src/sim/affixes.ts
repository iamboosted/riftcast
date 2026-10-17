import type { Element, Enemy } from './types';

export const AFFIX_INFO: Record<string, { name: string; desc: string }> = {
  shielded: { name: 'Shielded', desc: 'A shield absorbs damage until broken.' },
  hasted: { name: 'Hasted', desc: 'Moves and attacks faster.' },
  volatile: { name: 'Volatile', desc: 'Detonates when slain. Get clear!' },
  ward: { name: 'Warded', desc: 'Nearly immune to one element.' },
};

export function applyAffix(e: Enemy, affix: string): void {
  e.affix = affix;
  if (affix === 'shielded') e.shield = e.maxHp * 0.45;
}

export const wardElement = (e: Enemy): Element | null => (e.affix.startsWith('ward:') ? (e.affix.slice(5) as Element) : null);

/** Damage after affixes (shield absorb, wards). Mutates the shield. Unit tested. */
export function affixDamage(e: Enemy, amt: number, el: Element): number {
  if (wardElement(e) === el) amt *= 0.1;
  if (e.shield > 0) {
    const absorbed = Math.min(e.shield, amt * 0.85);
    e.shield -= absorbed;
    amt -= absorbed;
  }
  return amt;
}
