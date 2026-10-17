import * as THREE from 'three/webgpu';
import type { Room } from '../sim/room';

export interface AimTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
}

/**
 * Third-person over-the-shoulder rig. Owns yaw/pitch; produces the aim ray through screen centre with
 * optional aim assist (cone snap toward the best enemy).
 */
export class CameraRig {
  yaw = 0;
  pitch = -0.12;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  trauma = 0;
  private shakeT = 0;
  fovKick = 0;
  /** shoulder offset (right) */
  shoulder = 0.95;
  distance = 4.6;
  constructor(public camera: THREE.PerspectiveCamera) {}

  applyLook(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch = Math.max(-1.15, Math.min(0.75, this.pitch - dy));
  }

  shake(a: number): void {
    this.trauma = Math.min(1, this.trauma + a);
  }

  update(tx: number, ty: number, tz: number, dt: number, room: Room | null): void {
    const cy = Math.cos(this.yaw),
      sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch),
      sp = Math.sin(this.pitch);
    const fwd = new THREE.Vector3(-sy * cp, sp, -cy * cp);
    const right = new THREE.Vector3(cy, 0, -sy);
    const pivot = new THREE.Vector3(tx, ty + 1.75, tz).addScaledVector(right, this.shoulder);
    let dist = this.distance;
    // keep the camera out of pillars
    if (room) {
      for (const o of room.obstacles) {
        for (let s = 0.5; s <= dist; s += 0.5) {
          const px = pivot.x - fwd.x * s,
            pz = pivot.z - fwd.z * s;
          if (Math.hypot(px - o.x, pz - o.z) < o.r + 0.3 && pivot.y - fwd.y * s < o.h) {
            dist = Math.max(1.2, s - 0.4);
            break;
          }
        }
      }
    }
    const desired = pivot.clone().addScaledVector(fwd, -dist);
    if (desired.y < ty + 0.3) desired.y = ty + 0.3;
    this.pos.lerp(desired, 1 - Math.exp(-dt * 30));
    if (this.pos.distanceTo(desired) > 6) this.pos.copy(desired);
    this.look.copy(pivot).addScaledVector(fwd, 10);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    // trauma shake
    this.shakeT += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    if (s > 0.001) {
      const t = this.shakeT * 30;
      this.camera.rotation.z += Math.sin(t * 1.3) * 0.03 * s;
      this.camera.position.x += (Math.sin(t * 2.1) + Math.sin(t * 3.7) * 0.5) * 0.18 * s;
      this.camera.position.y += (Math.sin(t * 2.7) + Math.sin(t * 1.9) * 0.5) * 0.18 * s;
    }
    this.fovKick *= Math.exp(-dt * 6);
    const fov = 70 + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * World-space aim point. Ray from the camera through screen centre hits enemies, then platform tops,
   * then falls back to a far point. With assist, snaps to the enemy nearest the crosshair within `coneDeg`.
   */
  aim(room: Room | null, targets: AimTarget[], coneDeg: number, playerPos: THREE.Vector3): { x: number; y: number; z: number; target: number } {
    const o = this.camera.position;
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    // ray-sphere enemies
    let best = Infinity;
    let hit: { x: number; y: number; z: number; target: number } | null = null;
    for (const t of targets) {
      const ox = t.x - o.x,
        oy = t.y - o.y,
        oz = t.z - o.z;
      const tca = ox * d.x + oy * d.y + oz * d.z;
      if (tca < 0) continue;
      const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
      if (d2 < t.r * t.r && tca < best) {
        best = tca;
        hit = { x: t.x, y: t.y, z: t.z, target: t.id };
      }
    }
    // aim assist: closest angle within cone (only enemies in front of the player)
    if (!hit && coneDeg > 0) {
      const cone = (coneDeg * Math.PI) / 180;
      let bestScore = Infinity;
      for (const t of targets) {
        const vx = t.x - o.x,
          vy = t.y - o.y,
          vz = t.z - o.z;
        const l = Math.hypot(vx, vy, vz);
        if (l > 45 || l < 1) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, (vx * d.x + vy * d.y + vz * d.z) / l)));
        if (ang > cone + Math.atan(t.r / l)) continue;
        const score = ang + l * 0.002;
        if (score < bestScore) {
          bestScore = score;
          hit = { x: t.x, y: t.y, z: t.z, target: t.id };
        }
      }
    }
    if (hit) return hit;
    // platform tops / pillars
    if (room) {
      let tBest = 80;
      for (const p of room.platforms) {
        if (Math.abs(d.y) < 1e-4) continue;
        const t = (p.top - o.y) / d.y;
        if (t <= 0 || t > tBest) continue;
        const x = o.x + d.x * t,
          z = o.z + d.z * t;
        if (Math.hypot(x - p.x, z - p.z) < p.r) tBest = t;
      }
      for (const ob of room.obstacles) {
        // ray-cylinder (2D)
        const fx = o.x - ob.x,
          fz = o.z - ob.z;
        const a = d.x * d.x + d.z * d.z,
          b = 2 * (fx * d.x + fz * d.z),
          c = fx * fx + fz * fz - ob.r * ob.r;
        const disc = b * b - 4 * a * c;
        if (disc < 0 || a < 1e-6) continue;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t > 0 && t < tBest && o.y + d.y * t < ob.h) tBest = t;
      }
      const pt = { x: o.x + d.x * tBest, y: o.y + d.y * tBest, z: o.z + d.z * tBest, target: -1 };
      // don't let the aim point sit behind the player (camera-shoulder parallax)
      const behind = (pt.x - playerPos.x) * d.x + (pt.z - playerPos.z) * d.z;
      if (behind < 1.5) return { x: o.x + d.x * 30, y: o.y + d.y * 30, z: o.z + d.z * 30, target: -1 };
      return pt;
    }
    return { x: o.x + d.x * 40, y: o.y + d.y * 40, z: o.z + d.z * 40, target: -1 };
  }
}
