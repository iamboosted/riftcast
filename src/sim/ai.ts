import type { World } from './world';
import type { Element, Enemy, Player, Projectile, Telegraph, TelegraphShape } from './types';
import { ENEMIES, type AttackDef } from '../data/enemies';
import { damageEnemy } from './combat';
import { damagePlayer } from './players';
import { groundHeight, isOnPlatforms } from './room';
import { resolveCollisions } from './movement';
import { angleDiff } from './vec';
import { stepBoss } from './boss';

export function stepEnemies(w: World, dt: number): void {
  for (const e of [...w.enemies]) {
    if (!w.enemies.includes(e)) continue;
    e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
    if (e.spawnT > 0) {
      e.spawnT -= dt;
      if (e.spawnT <= 0) e.state = 'chase';
      continue;
    }
    if (stepStatuses(w, e, dt)) continue;
    applyKnock(w, e, dt);
    const disabled = e.st.frozen > 0 || e.st.shock > 0 || e.st.stagger > 0;
    if (disabled) continue;
    for (let i = 0; i < e.attackCds.length; i++) e.attackCds[i] -= dt;
    if (e.boss) {
      stepBoss(w, e, dt);
      continue;
    }
    stepGrunt(w, e, dt);
  }
}

/** Returns true if the enemy died from DoT. */
function stepStatuses(w: World, e: Enemy, dt: number): boolean {
  const s = e.st;
  s.chill = Math.max(0, s.chill - 9 * dt);
  s.frozen = Math.max(0, s.frozen - dt);
  s.shock = Math.max(0, s.shock - dt);
  s.wet = Math.max(0, s.wet - dt);
  s.blind = Math.max(0, s.blind - dt);
  s.stagger = Math.max(0, s.stagger - dt);
  if (s.burn > 0) s.burn = Math.max(0, s.burn - dt);
  else s.burnDps = 0;
  if (s.poisonT > 0) {
    s.poisonT -= dt;
    if (s.poisonT <= 0) s.poison = 0;
  }
  e.data.dotT = (e.data.dotT ?? 0.5) - dt;
  if (e.data.dotT <= 0) {
    e.data.dotT = 0.5;
    if (s.burn > 0 && s.burnDps > 0) damageEnemy(w, e, s.burnDps * 0.5, 'fire', e.statusBy.burn ?? '', { noStatus: true, noCrit: true });
    if (s.poison > 0 && e.hp > 0) damageEnemy(w, e, s.poison * 2.2 * 0.5, 'venom', e.statusBy.poison ?? '', { noStatus: true, noCrit: true });
  }
  return e.hp <= 0 || !w.enemies.includes(e);
}

function applyKnock(w: World, e: Enemy, dt: number): void {
  if (Math.abs(e.kx) + Math.abs(e.kz) > 0.05) {
    const nx = e.pos.x + e.kx * dt,
      nz = e.pos.z + e.kz * dt;
    // Knockback can push walkers off the edge into the void (a kill)
    e.pos.x = nx;
    e.pos.z = nz;
    const k = Math.exp(-5 * dt);
    e.kx *= k;
    e.kz *= k;
  }
  if (!e.flying) {
    const gh = groundHeight(w.room, e.pos.x, e.pos.z, e.pos.y + 0.6);
    if (e.ky > 0 || e.pos.y > gh + 0.01 || gh === -Infinity) {
      e.ky -= 26 * dt;
      e.pos.y += e.ky * dt;
      if (gh > -1e9 && e.pos.y <= gh) {
        e.pos.y = gh;
        e.ky = 0;
      }
      if (e.pos.y < -12) {
        damageEnemy(w, e, e.hp + 1, e.lastHitEl ?? 'gale', e.lastHitBy ?? '', { noStatus: true, noCrit: true });
      }
    }
  }
}

export function nearestPlayer(w: World, x: number, z: number): Player | null {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of w.players.values()) {
    if (p.state !== 'alive') continue;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

function stepGrunt(w: World, e: Enemy, dt: number): void {
  const def = ENEMIES[e.kind];
  e.stateT -= dt;
  e.data.retarget = (e.data.retarget ?? 0) - dt;
  if (e.st.blind > 0) e.target = null;
  else if (!e.target || e.data.retarget <= 0 || w.players.get(e.target)?.state !== 'alive') {
    e.target = nearestPlayer(w, e.pos.x, e.pos.z)?.id ?? null;
    e.data.retarget = 1.2;
  }
  const tgt = e.target ? w.players.get(e.target) : undefined;

  if (e.state === 'windup') {
    const atk = def.attacks[e.attackIdx];
    if (tgt && atk.at !== 'target' && e.stateT > atk.windup * 0.45) e.yaw = turnToward(e.yaw, Math.atan2(tgt.pos.x - e.pos.x, tgt.pos.z - e.pos.z), dt * 3);
    if (e.stateT <= 0) executeAttack(w, e, atk, tgt);
    return;
  }
  if (e.state === 'attack') {
    // charging dash in progress
    const sp = def.attacks[e.attackIdx].speed ?? 20;
    const dx = Math.sin(e.yaw) * sp * dt,
      dz = Math.cos(e.yaw) * sp * dt;
    e.pos.x += dx;
    e.pos.z += dz;
    if (e.stateT <= 0) {
      e.state = 'recover';
      e.stateT = def.attacks[e.attackIdx].recover;
    }
    return;
  }
  if (e.state === 'recover') {
    if (e.stateT <= 0) e.state = 'chase';
    moveEnemy(w, e, def.speed * 0.3, tgt, def.keepAway ?? 0, dt);
    return;
  }

  // chase
  let speed = def.speed * (1 - Math.min(e.st.chill, 100) / 250) * (e.affix === 'hasted' ? 1.4 : 1);
  if (!tgt) {
    // wander when blind or no target
    e.data.wander = (e.data.wander ?? 0) - dt;
    if (e.data.wander <= 0) {
      e.data.wander = 1.5;
      e.data.wx = e.pos.x + w.rng.range(-6, 6);
      e.data.wz = e.pos.z + w.rng.range(-6, 6);
    }
    speed *= 0.5;
    moveToward(w, e, e.data.wx, e.data.wz, speed, dt);
    return;
  }
  const dist = Math.hypot(tgt.pos.x - e.pos.x, tgt.pos.z - e.pos.z);
  for (let i = def.attacks.length - 1; i >= 0; i--) {
    const a = def.attacks[i];
    if (e.attackCds[i] > 0 || dist > a.range) continue;
    if (a.kind === 'summon' && w.enemies.length > 18) continue;
    startAttack(w, e, i, tgt);
    return;
  }
  moveEnemy(w, e, speed, tgt, def.keepAway ?? 0, dt);
}

function turnToward(yaw: number, target: number, rate: number): number {
  const d = angleDiff(yaw, target);
  return yaw + Math.max(-rate, Math.min(rate, d));
}

function moveEnemy(w: World, e: Enemy, speed: number, tgt: Player | undefined, keepAway: number, dt: number): void {
  if (!tgt) return;
  const dx = tgt.pos.x - e.pos.x,
    dz = tgt.pos.z - e.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  let mx = dx / d,
    mz = dz / d;
  if (keepAway > 0) {
    if (d < keepAway - 2) {
      mx = -mx;
      mz = -mz;
    } else if (d < keepAway + 2) {
      // strafe around the target
      const side = (e.seed & 1) === 0 ? 1 : -1;
      const ox = mx;
      mx = -mz * side;
      mz = ox * side;
      speed *= 0.5;
    }
  } else if (d < e.radius + 1.2) speed = 0;
  e.yaw = turnToward(e.yaw, Math.atan2(dx, dz), dt * 6);
  moveDir(w, e, mx, mz, speed, dt);
}

function moveToward(w: World, e: Enemy, x: number, z: number, speed: number, dt: number) {
  const dx = x - e.pos.x,
    dz = z - e.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.3) return;
  e.yaw = turnToward(e.yaw, Math.atan2(dx, dz), dt * 5);
  moveDir(w, e, dx / d, dz / d, speed, dt);
}

function moveDir(w: World, e: Enemy, mx: number, mz: number, speed: number, dt: number): void {
  // separation
  for (const o of w.enemies) {
    if (o === e) continue;
    const sx = e.pos.x - o.pos.x,
      sz = e.pos.z - o.pos.z;
    const sd = Math.hypot(sx, sz);
    const min = e.radius + o.radius + 0.3;
    if (sd < min && sd > 1e-4) {
      mx += (sx / sd) * (min - sd) * 1.5;
      mz += (sz / sd) * (min - sd) * 1.5;
    }
  }
  let l = Math.hypot(mx, mz);
  if (l > 1) {
    mx /= l;
    mz /= l;
  }
  // stuck recovery: sidestep along a perpendicular for a moment
  if ((e.data.detour ?? 0) > 0) {
    e.data.detour -= dt;
    const side = e.data.detourSide ?? 1;
    const ox = mx;
    mx = mx * 0.3 - mz * side;
    mz = mz * 0.3 + ox * side;
    l = Math.hypot(mx, mz) || 1;
    mx /= l;
    mz /= l;
  }
  const sx = e.pos.x,
    sz = e.pos.z;
  const nx = e.pos.x + mx * speed * dt,
    nz = e.pos.z + mz * speed * dt;
  if (e.flying) {
    e.pos.x = nx;
    e.pos.z = nz;
    const gh = Math.max(0, groundHeight(w.room, nx, nz, 50));
    const ty = gh + 2.2 + Math.sin(w.time * 2 + e.seed) * 0.3 + (e.elite ? 0.8 : 0);
    e.pos.y += (ty - e.pos.y) * Math.min(1, dt * 3);
  } else {
    if (isOnPlatforms(w.room.platforms, nx, nz, e.radius * 0.6)) {
      e.pos.x = nx;
      e.pos.z = nz;
    } else if (isOnPlatforms(w.room.platforms, nx, e.pos.z, e.radius * 0.6)) e.pos.x = nx;
    else if (isOnPlatforms(w.room.platforms, e.pos.x, nz, e.radius * 0.6)) e.pos.z = nz;
    const gh = groundHeight(w.room, e.pos.x, e.pos.z, e.pos.y + 0.6);
    if (gh > -1e9 && e.ky <= 0) e.pos.y = gh;
  }
  resolveCollisions(e, e.radius, w.colliders);
  if (!e.flying && speed > 0.5) {
    const moved = Math.hypot(e.pos.x - sx, e.pos.z - sz);
    const want = speed * dt;
    e.data.stuckT = moved < want * 0.3 ? (e.data.stuckT ?? 0) + dt : Math.max(0, (e.data.stuckT ?? 0) - dt);
    if (e.data.stuckT > 0.5 && !(e.data.detour > 0)) {
      e.data.detour = 0.9;
      e.data.detourSide = w.rng.chance(0.5) ? 1 : -1;
      e.data.stuckT = 0;
    }
  }
}

function startAttack(w: World, e: Enemy, idx: number, tgt: Player): void {
  const a = ENEMIES[e.kind].attacks[idx];
  e.attackIdx = idx;
  e.attackCds[idx] = a.cooldown * (0.85 + w.rng.next() * 0.3) * (e.affix === 'hasted' ? 0.7 : 1);
  e.state = 'windup';
  e.stateT = a.windup;
  e.yaw = Math.atan2(tgt.pos.x - e.pos.x, tgt.pos.z - e.pos.z);
  if (a.kind === 'tele' || a.kind === 'charge') {
    const n = a.count ?? 1;
    for (let i = 0; i < n; i++) {
      if (a.at === 'target') {
        const lead = i === 0 ? 0.35 : 0;
        const ox = i === 0 ? 0 : w.rng.range(-4, 4),
          oz = i === 0 ? 0 : w.rng.range(-4, 4);
        addTelegraph(w, e.id, a.shape ?? 'circle', tgt.pos.x + tgt.vel.x * lead + ox, tgt.pos.z + tgt.vel.z * lead + oz, tgt.pos.y, a, e.yaw);
      } else addTelegraph(w, e.id, a.shape ?? 'circle', e.pos.x, e.pos.z, e.flying ? Math.max(0, e.pos.y - 2.2) : e.pos.y, a, e.yaw);
    }
  }
}

export function addTelegraph(
  w: World,
  owner: number,
  shape: TelegraphShape,
  x: number,
  z: number,
  y: number,
  a: Pick<AttackDef, 'radius' | 'r2' | 'len' | 'width' | 'arc' | 'windup' | 'damage' | 'element' | 'knock'>,
  angle: number,
): Telegraph {
  const gh = groundHeight(w.room, x, z, y + 1.5);
  const t: Telegraph = {
    id: w.id(),
    shape,
    x,
    z,
    y: gh > -1e9 ? gh : y,
    r: a.radius ?? 2,
    r2: a.r2 ?? 0,
    angle,
    len: a.len ?? 0,
    width: a.width ?? 0,
    t: 0,
    dur: a.windup,
    dmg: a.damage,
    element: a.element,
    owner,
    knock: a.knock ?? 3,
  };
  if (shape === 'cone') t.width = a.arc ?? 0.5;
  w.telegraphs.push(t);
  return t;
}

function executeAttack(w: World, e: Enemy, a: AttackDef, tgt: Player | undefined): void {
  e.state = 'recover';
  e.stateT = a.recover;
  if (a.kind === 'shoot' && tgt) {
    const n = a.count ?? 1;
    const base = Math.atan2(tgt.pos.x - e.pos.x, tgt.pos.z - e.pos.z);
    const oy = e.pos.y + e.height * 0.6;
    for (let i = 0; i < n; i++) {
      const ang = base + (n === 1 ? 0 : (i / (n - 1) - 0.5) * (a.spread ?? 0.2) * (n - 1));
      const dy = (tgt.pos.y + 1 - oy) / Math.max(4, Math.hypot(tgt.pos.x - e.pos.x, tgt.pos.z - e.pos.z));
      spawnEnemyProjectile(w, e, ang, a.speed ?? 14, dy, a.damage, a.element);
    }
  } else if (a.kind === 'summon') {
    const n = a.count ?? 2;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + w.rng.next();
      const s = w.spawnEnemy(a.summon!, { x: e.pos.x + Math.cos(ang) * 3, y: 0, z: e.pos.z + Math.sin(ang) * 3 });
      s.spawnT = 0.6;
    }
  } else if (a.kind === 'charge') {
    e.state = 'attack';
    e.stateT = (a.len ?? 8) / (a.speed ?? 20);
  }
}

export function spawnEnemyProjectile(w: World, e: Enemy, yaw: number, speed: number, dy: number, dmg: number, el: Element, y?: number): Projectile {
  const pr: Projectile = {
    id: w.id(),
    team: 'enemy',
    owner: `e${e.id}`,
    element: el,
    spell: 'orb',
    pos: { x: e.pos.x + Math.sin(yaw) * e.radius, y: y ?? e.pos.y + e.height * 0.6, z: e.pos.z + Math.cos(yaw) * e.radius },
    vel: { x: Math.sin(yaw) * speed, y: dy * speed, z: Math.cos(yaw) * speed },
    gravity: 0,
    radius: 0.35,
    damage: dmg,
    life: 4,
    pierce: 0,
    hitIds: [],
    charge: 0,
    ck: '',
    bounces: 0,
    split: 0,
    data: 0,
  };
  w.projectiles.push(pr);
  w.emit({ t: 'proj', id: pr.id, el, sp: 'orb', x: pr.pos.x, y: pr.pos.y, z: pr.pos.z, vx: pr.vel.x, vy: pr.vel.y, vz: pr.vel.z, g: 0, r: pr.radius, team: 'enemy', ck: '', life: pr.life });
  return pr;
}

/** Point-in-telegraph test in XZ (unit tested). Players jumping high enough clear lines and rings. */
export function inTelegraph(t: Telegraph, x: number, y: number, z: number, pr = 0.4): boolean {
  const dx = x - t.x,
    dz = z - t.z;
  const d = Math.hypot(dx, dz);
  const dy = y - t.y;
  switch (t.shape) {
    case 'circle':
      return d < t.r + pr && dy < 3.5 && dy > -1.5;
    case 'ring':
      return d < t.r + pr && d > t.r2 - pr && dy < 1.1 && dy > -1.5;
    case 'line': {
      const fx = Math.sin(t.angle),
        fz = Math.cos(t.angle);
      const along = dx * fx + dz * fz;
      const perp = Math.abs(-dx * fz + dz * fx);
      return along > -pr && along < t.len + pr && perp < t.width / 2 + pr && dy < 1.3 && dy > -1.5;
    }
    case 'cone': {
      if (d > t.r + pr || dy > 3 || dy < -1.5) return false;
      const ang = Math.atan2(dx, dz);
      return Math.abs(angleDiff(t.angle, ang)) < t.width;
    }
  }
}

export function stepTelegraphs(w: World, dt: number): void {
  for (const t of [...w.telegraphs]) {
    t.t += dt;
    if (t.t < t.dur) continue;
    w.telegraphs.splice(w.telegraphs.indexOf(t), 1);
    w.emit({ t: 'tele', id: t.id, x: t.x, z: t.z, el: t.element, shape: t.shape });
    for (const p of w.players.values()) {
      if (p.state !== 'alive') continue;
      if (!inTelegraph(t, p.pos.x, p.pos.y, p.pos.z)) continue;
      const kx = t.shape === 'line' ? Math.sin(t.angle) : p.pos.x - t.x;
      const kz = t.shape === 'line' ? Math.cos(t.angle) : p.pos.z - t.z;
      damagePlayer(w, p, t.dmg, t.element, { x: kx || 0.01, z: kz, f: t.knock });
    }
    // charge attacks move the owner to the end of the line
  }
}
