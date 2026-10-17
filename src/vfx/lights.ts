import * as THREE from 'three/webgpu';

interface Flash {
  light: THREE.PointLight;
  t: number;
  life: number;
  peak: number;
  follow: (() => THREE.Vector3 | null) | null;
}

/**
 * Fixed pool of point lights for explosions and glowing projectiles. The light count never changes
 * (unused lights sit at intensity 0), so the scene's shaders are compiled once.
 */
export class LightPool {
  group = new THREE.Group();
  private pool: Flash[] = [];
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.position.set(0, -500, 0);
      this.group.add(l);
      this.pool.push({ light: l, t: 1, life: 1, peak: 0, follow: null });
    }
  }

  flash(x: number, y: number, z: number, color: number, intensity: number, radius: number, life = 0.35, follow: Flash['follow'] = null): void {
    if (!this.pool.length) return;
    // reuse the weakest/oldest slot
    let best = this.pool[0];
    let bs = Infinity;
    for (const f of this.pool) {
      const remain = f.t >= f.life ? -1 : f.peak * (1 - f.t / f.life);
      if (remain < bs) {
        bs = remain;
        best = f;
      }
    }
    if (bs > intensity) return;
    best.light.position.set(x, y, z);
    best.light.color.set(color);
    best.light.distance = radius;
    best.t = 0;
    best.life = life;
    best.peak = intensity;
    best.follow = follow;
  }

  update(dt: number): void {
    for (const f of this.pool) {
      if (f.t >= f.life) {
        f.light.intensity = 0;
        continue;
      }
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      f.light.intensity = f.peak * (f.follow ? 1 : (1 - k) * (1 - k));
      if (f.follow) {
        const p = f.follow();
        if (p) f.light.position.copy(p);
        else f.t = f.life;
      }
    }
  }
}
