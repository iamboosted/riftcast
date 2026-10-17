import type { MoveState, PlayerInput } from './types';
import { BTN_HEAVY, BTN_JUMP } from './types';
import { groundHeight, isOnPlatforms, type Room } from './room';
import { segDist2D } from './vec';

export const MOVE = {
  speed: 7.6,
  accelGround: 80,
  accelAir: 34,
  gravity: 26,
  jumpV: 9.2,
  doubleJumpV: 8.6,
  rocketV: 16,
  hoverFall: -1.1,
  glideFall: -0.65,
  hoverFuel: 1.1,
  glideFuel: 4.5,
  dashSpeed: 27,
  dashTime: 0.17,
  dashCd: 0.85,
  blinkDist: 7.5,
  radius: 0.45,
  chargeSlow: 0.62,
  fallY: -14,
};

export interface WallSeg {
  x: number;
  z: number;
  angle: number;
  len: number;
  thick: number;
  h: number;
}

export interface Colliders {
  room: Room;
  walls: readonly WallSeg[];
}

export interface MoveResult {
  jumped: number;
  dashed: boolean;
  blinkFrom: { x: number; z: number } | null;
  fell: boolean;
  rocket: boolean;
}

export const wallEnds = (w: WallSeg): [number, number, number, number] => {
  const dx = Math.cos(w.angle) * w.len,
    dz = Math.sin(w.angle) * w.len;
  return [w.x - dx, w.z - dz, w.x + dx, w.z + dz];
};

/** Push a circle out of pillars, raised-ledge sides and stone walls. */
export function resolveCollisions(m: { pos: { x: number; y: number; z: number } }, radius: number, col: Colliders): void {
  const p = m.pos;
  for (const o of col.room.obstacles) {
    const dx = p.x - o.x,
      dz = p.z - o.z;
    const d = Math.hypot(dx, dz);
    const min = o.r + radius;
    if (d < min && p.y < o.h) {
      const k = d > 1e-5 ? (min - d) / d : 0;
      p.x += dx * k;
      p.z += dz * k;
    }
  }
  for (const pl of col.room.platforms) {
    if (pl.top <= 0 || p.y >= pl.top - 0.55) continue;
    const dx = p.x - pl.x,
      dz = p.z - pl.z;
    const d = Math.hypot(dx, dz);
    const min = pl.r + radius;
    if (d < min) {
      const k = d > 1e-5 ? (min - d) / d : 0;
      p.x += dx * k;
      p.z += dz * k;
    }
  }
  for (const w of col.walls) {
    if (p.y > w.h) continue;
    const [ax, az, bx, bz] = wallEnds(w);
    const [d, t] = segDist2D(p.x, p.z, ax, az, bx, bz);
    const min = w.thick + radius;
    if (d < min) {
      const cx = ax + (bx - ax) * t,
        cz = az + (bz - az) * t;
      let nx = p.x - cx,
        nz = p.z - cz;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-5) {
        nx = -Math.sin(w.angle);
        nz = Math.cos(w.angle);
      } else {
        nx /= nl;
        nz /= nl;
      }
      p.x = cx + nx * min;
      p.z = cz + nz * min;
    }
  }
}

/**
 * Deterministic movement step shared by the host simulation and client-side prediction.
 * Mutates `m`. `speedMul` folds in boons; `maxDash` is the dash charge cap.
 */
export function stepMovement(
  m: MoveState,
  input: PlayerInput,
  prev: { jump: number; dash: number },
  dt: number,
  col: Colliders,
  speedMul = 1,
  maxDash = 1,
): MoveResult {
  const res: MoveResult = { jumped: 0, dashed: false, blinkFrom: null, fell: false, rocket: false };
  m.yaw = input.yaw;
  const jumpPressed = ((input.jump - prev.jump) & 255) > 0 && ((input.jump - prev.jump) & 255) < 128;
  const dashPressed = ((input.dash - prev.dash) & 255) > 0 && ((input.dash - prev.dash) & 255) < 128;
  const jumpHeld = (input.buttons & BTN_JUMP) !== 0;
  const charging = (input.buttons & BTN_HEAVY) !== 0;

  // Dash recharge
  if (m.dashCharges < maxDash) {
    m.dashCd -= dt;
    if (m.dashCd <= 0) {
      m.dashCharges++;
      m.dashCd = m.dashCharges < maxDash ? MOVE.dashCd : 0;
    }
  }
  if (m.dashCharges > maxDash) m.dashCharges = maxDash;

  let mx = input.mx,
    mz = input.mz;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }

  if (dashPressed && m.dashCharges > 0 && m.dashTime <= 0) {
    m.dashCharges--;
    if (m.dashCd <= 0) m.dashCd = MOVE.dashCd;
    let dx = mx,
      dz = mz;
    if (Math.hypot(dx, dz) < 0.2) {
      dx = -Math.sin(m.yaw);
      dz = -Math.cos(m.yaw);
    }
    const dl = Math.hypot(dx, dz) || 1;
    m.dashDirX = dx / dl;
    m.dashDirZ = dz / dl;
    res.dashed = true;
    if (m.rune === 'blink') {
      res.blinkFrom = { x: m.pos.x, z: m.pos.z };
      // Step forward in increments so we never blink into the void
      let bx = m.pos.x,
        bz = m.pos.z;
      for (let s = 1; s <= 10; s++) {
        const tx = m.pos.x + m.dashDirX * MOVE.blinkDist * (s / 10);
        const tz = m.pos.z + m.dashDirZ * MOVE.blinkDist * (s / 10);
        if (!isOnPlatforms(col.room.platforms, tx, tz, 0.6)) break;
        bx = tx;
        bz = tz;
      }
      m.pos.x = bx;
      m.pos.z = bz;
      m.dashTime = 0.06;
    } else {
      m.dashTime = MOVE.dashTime;
    }
  }

  if (m.dashTime > 0) {
    m.dashTime -= dt;
    const sp = m.rune === 'blink' ? 6 : MOVE.dashSpeed;
    m.vel.x = m.dashDirX * sp;
    m.vel.z = m.dashDirZ * sp;
    m.vel.y = Math.max(m.vel.y, 0) * 0.5;
    if (m.dashTime <= 0) {
      m.vel.x *= 0.35;
      m.vel.z *= 0.35;
    }
  } else {
    const speed = MOVE.speed * speedMul * (charging ? MOVE.chargeSlow : 1) * (m.rune === 'glide' && m.hovering ? 1.3 : 1);
    const tx = mx * speed,
      tz = mz * speed;
    const accel = m.grounded ? MOVE.accelGround : MOVE.accelAir;
    const ddx = tx - m.vel.x,
      ddz = tz - m.vel.z;
    const dl = Math.hypot(ddx, ddz);
    const maxStep = accel * dt;
    if (dl <= maxStep) {
      m.vel.x = tx;
      m.vel.z = tz;
    } else {
      m.vel.x += (ddx / dl) * maxStep;
      m.vel.z += (ddz / dl) * maxStep;
    }
  }

  // Jumping
  if (jumpPressed) {
    if (m.grounded) {
      m.vel.y = MOVE.jumpV;
      m.jumpsUsed = 1;
      m.grounded = false;
      res.jumped = 1;
      m.lastJump = 0;
    } else if (m.jumpsUsed < 2) {
      if (m.rune === 'rocket') {
        m.vel.y = MOVE.rocketV;
        m.rocket = true;
        res.rocket = true;
      } else m.vel.y = MOVE.doubleJumpV;
      m.jumpsUsed = 2;
      res.jumped = 2;
      m.lastJump = 0;
    }
  }
  m.lastJump += dt;

  // Gravity + hover
  if (m.dashTime <= 0) m.vel.y -= MOVE.gravity * dt;
  m.hovering = false;
  if (!m.grounded && jumpHeld && m.vel.y < 0 && m.lastJump > 0.18 && m.hoverFuel > 0) {
    const fall = m.rune === 'glide' ? MOVE.glideFall : MOVE.hoverFall;
    if (m.vel.y < fall) m.vel.y = fall;
    m.hoverFuel -= dt;
    m.hovering = true;
  }

  m.pos.x += m.vel.x * dt;
  m.pos.y += m.vel.y * dt;
  m.pos.z += m.vel.z * dt;

  resolveCollisions(m, MOVE.radius, col);

  const gh = groundHeight(col.room, m.pos.x, m.pos.z, m.pos.y - m.vel.y * dt);
  if (m.pos.y <= gh && m.vel.y <= 0) {
    m.pos.y = gh;
    m.vel.y = 0;
    m.grounded = true;
    m.jumpsUsed = 0;
    m.rocket = false;
    m.hoverFuel = m.rune === 'glide' ? MOVE.glideFuel : MOVE.hoverFuel;
    if (isOnPlatforms(col.room.platforms, m.pos.x, m.pos.z, 1.2)) {
      m.safeX = m.pos.x;
      m.safeZ = m.pos.z;
      m.safeY = gh;
    }
  } else if (m.pos.y > gh + 0.05) {
    if (m.grounded && m.vel.y <= 0 && m.pos.y - gh < 0.35) {
      // stick to ground when walking down small steps
      m.pos.y = gh;
    } else {
      if (m.grounded) m.jumpsUsed = Math.max(m.jumpsUsed, 1);
      m.grounded = false;
    }
  }

  if (m.pos.y < MOVE.fallY) {
    m.pos.x = m.safeX;
    m.pos.y = m.safeY + 0.5;
    m.pos.z = m.safeZ;
    m.vel.x = m.vel.y = m.vel.z = 0;
    res.fell = true;
  }
  return res;
}

export function newMoveState(x: number, y: number, z: number): MoveState {
  return {
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    grounded: true,
    jumpsUsed: 0,
    hoverFuel: MOVE.hoverFuel,
    hovering: false,
    dashTime: 0,
    dashCd: 0,
    dashCharges: 1,
    dashDirX: 0,
    dashDirZ: -1,
    lastJump: 1,
    lastDash: 0,
    safeX: x,
    safeZ: z,
    safeY: y,
    rune: 'none',
    rocket: false,
  };
}

export function copyMoveState(dst: MoveState, src: MoveState): void {
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.vel.x = src.vel.x;
  dst.vel.y = src.vel.y;
  dst.vel.z = src.vel.z;
  dst.yaw = src.yaw;
  dst.grounded = src.grounded;
  dst.jumpsUsed = src.jumpsUsed;
  dst.hoverFuel = src.hoverFuel;
  dst.hovering = src.hovering;
  dst.dashTime = src.dashTime;
  dst.dashCd = src.dashCd;
  dst.dashCharges = src.dashCharges;
  dst.dashDirX = src.dashDirX;
  dst.dashDirZ = src.dashDirZ;
  dst.lastJump = src.lastJump;
  dst.lastDash = src.lastDash;
  dst.safeX = src.safeX;
  dst.safeZ = src.safeZ;
  dst.safeY = src.safeY;
  dst.rune = src.rune;
  dst.rocket = src.rocket;
}
