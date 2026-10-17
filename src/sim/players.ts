import type { World } from './world';
import type { Player, PlayerInput } from './types';
import { BTN_HEAVY, BTN_PRIMARY } from './types';
import { stepMovement } from './movement';
import { castHeavy, castPrimary, castSignature, SPELL_TIMING } from './spells';
import { blast } from './combat';

const counterDelta = (a: number, b: number) => {
  const d = (a - b) & 255;
  return d > 0 && d < 128;
};

export function stepPlayers(w: World, dt: number): void {
  for (const p of w.players.values()) {
    const input = w.inputs.get(p.id)!;
    const prev = w.prevInputs.get(p.id)!;
    stepPlayer(w, p, input, prev, dt);
  }
  stepRevives(w, dt);
}

export function stepPlayer(w: World, p: Player, input: PlayerInput, prev: PlayerInput, dt: number): void {
  p.lastSeq = input.seq;
  p.castFlash = Math.max(0, p.castFlash - dt);
  p.hurtFlash = Math.max(0, p.hurtFlash - dt);
  p.iframes = Math.max(0, p.iframes - dt);
  for (const c of p.cd) {
    c.primary = Math.max(0, c.primary - dt);
    c.heavy = Math.max(0, c.heavy - dt);
    c.signature = Math.max(0, c.signature - dt);
  }
  if (p.state === 'downed') {
    p.bleedout -= dt;
    p.vel.x *= 0.8;
    p.vel.z *= 0.8;
    if (p.bleedout <= 0) {
      p.state = 'dead';
      p.hp = 0;
    }
    return;
  }
  if (p.state !== 'alive') return;

  const phaseAllowsCombat = w.run.phase === 'room' || w.run.phase === 'cleared';
  const res = stepMovement(p, input, prev, dt, w.colliders, p.stats.moveSpeed, p.stats.dashCharges);
  p.pitch = input.pitch;
  if (res.dashed) {
    p.iframes = Math.max(p.iframes, 0.22);
    if (res.blinkFrom) w.emit({ t: 'dash', pid: p.id, x: res.blinkFrom.x, y: p.pos.y, z: res.blinkFrom.z, blink: 1, x2: p.pos.x, z2: p.pos.z });
    else w.emit({ t: 'dash', pid: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  }
  if (res.jumped) w.emit({ t: 'jump', pid: p.id, n: res.jumped, rocket: res.rocket ? 1 : undefined });
  if (res.rocket && phaseAllowsCombat) blast(w, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, 3.2, 22, 'fire', p.id, { knock: 9, noSelf: true });
  if (res.fell) {
    w.emit({ t: 'fall', pid: p.id });
    damagePlayerRaw(w, p, p.maxHp * 0.1, 'stone');
  }

  // Gauntlet swap
  if (counterDelta(input.swap, prev.swap)) {
    p.active = p.active === 0 ? 1 : 0;
    p.charging = false;
    p.charge = 0;
    w.emit({ t: 'swap', pid: p.id, el: p.gauntlets[p.active] });
  }
  if (!phaseAllowsCombat) {
    p.charging = false;
    p.charge = 0;
    return;
  }

  const el = p.gauntlets[p.active];
  const cd = p.cd[p.active];
  const timing = SPELL_TIMING[el];

  // Heavy: hold to charge, release to fire
  const heavyHeld = (input.buttons & BTN_HEAVY) !== 0;
  if (heavyHeld && cd.heavy <= 0) {
    p.charging = true;
    p.charge = Math.min(1, p.charge + (dt / timing.chargeTime) * p.stats.chargeSpeed);
  } else if (p.charging) {
    if (p.charge >= 0.12) {
      castHeavy(w, p, el, input, p.charge);
      cd.heavy = timing.heavyCd;
      p.castFlash = 0.25;
    }
    p.charging = false;
    p.charge = 0;
  }

  // Primary: hold to auto-fire
  if ((input.buttons & BTN_PRIMARY) !== 0 && !p.charging && cd.primary <= 0) {
    castPrimary(w, p, el, input);
    cd.primary = timing.primaryCd;
    p.castFlash = 0.12;
  }

  // Signature
  if (counterDelta(input.sig, prev.sig) && cd.signature <= 0) {
    castSignature(w, p, el, input);
    cd.signature = timing.sigCd * p.stats.sigCooldown;
    p.castFlash = 0.35;
  }
}

function stepRevives(w: World, dt: number): void {
  for (const p of w.players.values()) {
    if (p.state !== 'downed') continue;
    let channel = 0;
    let by = '';
    for (const q of w.players.values()) {
      if (q === p || q.state !== 'alive') continue;
      const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
      if (d < 2.6 && Math.abs(q.pos.y - p.pos.y) < 2.2) {
        const sp = q.stats.reviveSpeed;
        if (sp > channel) {
          channel = sp;
          by = q.id;
        }
      }
    }
    if (channel > 0) {
      p.reviveProgress += (dt / REVIVE_TIME) * channel;
      if (p.reviveProgress >= 1) revive(w, p, by);
    } else p.reviveProgress = Math.max(0, p.reviveProgress - dt * 0.25);
  }
}

export const REVIVE_TIME = 2.6;
export const BLEEDOUT_TIME = 30;

export function revive(w: World, p: Player, by: string): void {
  p.state = 'alive';
  p.hp = p.maxHp * 0.4;
  p.reviveProgress = 0;
  p.iframes = 1.5;
  w.emit({ t: 'revive', pid: p.id, by });
}

export function damagePlayerRaw(w: World, p: Player, amt: number, el: Player['gauntlets'][0]): void {
  if (p.state !== 'alive') return;
  p.hp -= amt;
  p.hurtFlash = 0.3;
  w.emit({ t: 'hurt', pid: p.id, amt: Math.round(amt), el });
  if (p.hp <= 0) downPlayer(w, p);
}

/** Damage from enemy sources: respects dash i-frames and damage-taken stats. */
export function damagePlayer(w: World, p: Player, amt: number, el: Player['gauntlets'][0], knock?: { x: number; z: number; f: number }): boolean {
  if (p.state !== 'alive' || p.iframes > 0 || p.dashTime > 0) return false;
  const final = amt * p.stats.damageTaken * w.enemyDmgMul;
  p.iframes = 0.35;
  if (knock) {
    const l = Math.hypot(knock.x, knock.z) || 1;
    p.vel.x += (knock.x / l) * knock.f;
    p.vel.z += (knock.z / l) * knock.f;
    p.vel.y = Math.max(p.vel.y, knock.f * 0.35);
    p.grounded = false;
  }
  damagePlayerRaw(w, p, final, el);
  return true;
}

export function downPlayer(w: World, p: Player): void {
  p.hp = 0;
  p.downs++;
  p.charging = false;
  p.charge = 0;
  const others = [...w.players.values()].filter((q) => q !== p && q.state === 'alive');
  if (others.length === 0 && w.players.size === 1 && p.secondWind > 0) {
    // Solo second wind: self-revive with a shockwave
    p.secondWind--;
    p.hp = p.maxHp * 0.5;
    p.iframes = 2;
    w.emit({ t: 'revive', pid: p.id, by: p.id });
    blast(w, { ...p.pos }, 7, 30, 'gale', p.id, { knock: 14 });
    return;
  }
  p.state = 'downed';
  p.bleedout = BLEEDOUT_TIME;
  p.reviveProgress = 0;
  w.emit({ t: 'down', pid: p.id });
}
