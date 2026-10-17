import type { World } from './world';
import type { Enemy, Projectile, Zone, ZoneTag } from './types';
import type { ComboMatch } from './comboTable';
import { blast, chainLightning, damageEnemy, uniq } from './combat';
import { V3 } from './vec';

export interface ComboCtx {
  pos: V3;
  /** the zone participating (when exactly one side is a zone) */
  zone?: Zone;
  /** zones for reagent a / b (zone-zone interactions) */
  za?: Zone;
  zb?: Zone;
  projectile?: Projectile;
  enemy?: Enemy;
  contributors: string[];
  depth?: number;
}

const ABSORBABLE: ZoneTag[] = ['burning', 'venompool', 'venomcloud', 'frostpatch', 'puddle', 'steam'];

/**
 * Apply a resolved combo. Returns true if the projectile (if any) should be consumed.
 */
export function applyCombo(w: World, m: ComboMatch, ctx: ComboCtx): boolean {
  const fx = m.rule.effect;
  let za = ctx.za,
    zb = ctx.zb;
  if (ctx.zone && !za && !zb) {
    if (m.a.kind === 'zone' && m.b.kind !== 'zone') za = ctx.zone;
    else zb = ctx.zone;
  }
  const contributors = uniq(ctx.contributors);
  const ts = w.teamStats;
  let pos = ctx.pos;
  let radius = 3;

  switch (fx.type) {
    case 'reflect':
    case 'block':
      return fx.type === 'block';
    case 'transform': {
      const target = m.a.kind === 'zone' ? za : zb;
      const other = target === za ? zb : za;
      if (!target) return true;
      target.tag = fx.into!;
      if (fx.element) target.element = fx.element;
      if (fx.dps !== undefined) target.dps = fx.dps;
      target.radius *= fx.radiusMul ?? 1;
      target.life += fx.lifeAdd ?? 0;
      target.maxLife = Math.max(target.maxLife, target.life);
      target.growth = fx.growth ?? 0;
      target.reacted = [];
      target.contributors = uniq([...target.contributors, ...contributors]);
      if (other && other !== target && ABSORBABLE.includes(other.tag)) w.removeZone(other);
      if (target.tag === 'magmawall') w.rebuildColliders();
      if (fx.freeze) {
        for (const e of w.enemies) {
          if (Math.hypot(e.pos.x - target.pos.x, e.pos.z - target.pos.z) < target.radius + e.radius && !e.flying) {
            e.st.frozen = e.boss ? 1 : 2.5;
            e.st.chill = 0;
            e.statusBy.frozen = contributors[0];
          }
        }
      }
      pos = { ...target.pos };
      radius = target.radius;
      break;
    }
    case 'explode': {
      const cloud = m.b.kind === 'zone' ? zb : za;
      const center = cloud ? { ...cloud.pos, y: cloud.pos.y + 1 } : ctx.pos;
      radius = Math.max(fx.minRadius ?? 3, (cloud?.radius ?? 3) * (fx.radiusMul ?? 1)) * ts.comboRadius;
      if (cloud) w.removeZone(cloud);
      w.emit({ t: 'boom', x: center.x, y: center.y, z: center.z, r: radius, el: fx.element ?? 'fire', big: 1 });
      blast(w, center, radius, fx.damage ?? 100, fx.element ?? 'fire', contributors[0] ?? '', {
        combo: true,
        knock: 12,
        lift: 6,
        contributors,
        depth: (ctx.depth ?? 0) + 1,
      });
      pos = center;
      break;
    }
    case 'spawn': {
      const src = m.b.kind === 'zone' ? zb : m.a.kind === 'zone' ? za : undefined;
      const center = src ? { ...src.pos } : { ...ctx.pos, y: ctx.enemy ? ctx.enemy.pos.y : ctx.pos.y };
      radius = Math.max(fx.minRadius ?? 3, (src?.radius ?? 0) * (fx.radiusMul ?? 1)) * ts.comboRadius;
      if (fx.consume && src) w.removeZone(src);
      if (ctx.enemy && m.b.kind === 'status') ctx.enemy.st.frozen = 0;
      if (ctx.enemy && m.a.kind === 'status') ctx.enemy.st.frozen = 0;
      w.spawnZone({ tag: fx.zone!, element: fx.element ?? 'frost', pos: center, radius, life: (fx.life ?? 5) * ts.zoneDuration, dps: 0, contributors });
      if (fx.damage) blast(w, center, radius, fx.damage, 'fire', contributors[0] ?? '', { combo: true, noCombo: true });
      for (const e of w.enemies) {
        if (Math.hypot(e.pos.x - center.x, e.pos.z - center.z) < radius + e.radius) {
          e.st.blind = 4;
          e.st.wet = 6;
          e.statusBy.wet = contributors[0];
        }
      }
      pos = center;
      break;
    }
    case 'electrify': {
      const start = m.b.kind === 'zone' ? zb : za;
      if (!start) return true;
      const net = connectedWater(w, start);
      const dur = fx.duration ?? 3;
      let prev: Zone | null = null;
      for (const z of net) {
        if (w.zones.some((q) => q.tag === 'electrified' && Math.hypot(q.pos.x - z.pos.x, q.pos.z - z.pos.z) < 0.5)) continue;
        w.spawnZone({ tag: 'electrified', element: 'storm', pos: { ...z.pos }, radius: z.radius, life: dur, dps: (fx.damage ?? 50) / dur, contributors });
        if (prev) w.emit({ t: 'bolt', x: prev.pos.x, y: prev.pos.y + 0.2, z: prev.pos.z, x2: z.pos.x, y2: z.pos.y + 0.2, z2: z.pos.z, el: 'storm', w: 1 });
        prev = z;
      }
      // Instant jolt to everyone standing in the network
      for (const e of [...w.enemies]) {
        if (e.flying) continue;
        if (net.some((z) => Math.hypot(e.pos.x - z.pos.x, e.pos.z - z.pos.z) < z.radius + e.radius)) {
          damageEnemy(w, e, (fx.damage ?? 50) * 0.6, 'storm', contributors[0] ?? '', { combo: true });
          e.st.shock = 1.2;
          e.st.wet = 5;
        }
      }
      radius = Math.max(...net.map((z) => z.radius), 2);
      pos = { ...start.pos };
      break;
    }
    case 'shatter': {
      const e = ctx.enemy;
      if (!e) return true;
      e.st.frozen = 0;
      e.st.chill = 0;
      radius = (fx.radius ?? 4) * ts.comboRadius;
      pos = { ...e.pos, y: e.pos.y + e.height * 0.5 };
      w.emit({ t: 'shatter', x: pos.x, y: pos.y, z: pos.z });
      damageEnemy(w, e, (fx.damage ?? 50) * (fx.damageMul ?? 1), 'stone', contributors[0] ?? '', { combo: true, noStatus: true });
      blast(w, pos, radius, (fx.damage ?? 50) * 0.6, 'frost', contributors[0] ?? '', { combo: true, noCombo: true, skip: e.id, knock: 6 });
      break;
    }
    case 'chain': {
      const e = ctx.enemy;
      if (!e) return true;
      e.st.wet = 0;
      const owner = w.players.get(contributors[0] ?? '');
      chainLightning(w, e, fx.damage ?? 40, (fx.jumps ?? 4) + (owner?.stats.chainCount ?? 0), fx.radius ?? 8, contributors[0] ?? '', true);
      damageEnemy(w, e, fx.damage ?? 40, 'storm', contributors[0] ?? '', { combo: true, noStatus: true });
      pos = { ...e.pos };
      radius = fx.radius ?? 8;
      break;
    }
  }

  if (!m.rule.silent) creditCombo(w, m.rule.id, m.rule.name, pos, radius, contributors);
  return true;
}

export function creditCombo(w: World, key: string, name: string, pos: V3, r: number, pids: string[]): void {
  const dk = `${key}:${Math.round(pos.x / 3)}:${Math.round(pos.z / 3)}`;
  const heal = w.teamStats.healOnCombo;
  for (const id of pids) {
    const p = w.players.get(id);
    if (!p) continue;
    p.combos++;
    if (heal > 0 && p.state === 'alive') p.hp = Math.min(p.maxHp, p.hp + heal);
  }
  if (w.comboCd.has(dk)) return;
  w.comboCd.set(dk, 0.5);
  w.emit({ t: 'combo', key, name, x: pos.x, y: pos.y, z: pos.z, r, pids });
}

function connectedWater(w: World, start: Zone): Zone[] {
  const water = w.zones.filter((z) => z.tag === 'puddle' || z.tag === 'frostpatch');
  const out: Zone[] = [start];
  const seen = new Set<number>([start.id]);
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    for (const b of water) {
      if (seen.has(b.id)) continue;
      if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < a.radius + b.radius + 1.2) {
        seen.add(b.id);
        out.push(b);
      }
    }
  }
  return out;
}
