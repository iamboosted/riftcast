import * as THREE from 'three/webgpu';
import { attribute, vec4, vec3, float, smoothstep, abs, mx_noise_float, time, vec2, mix, pow, uv, sin } from '../render/tsl';

/**
 * Camera-facing triangle strips rebuilt every frame from polylines. Used for ribbon trails, lightning and
 * wind streaks. One draw call for everything; additive HDR.
 */
export class StripRenderer {
  mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private uvs: Float32Array;
  private kind: Float32Array;
  private vcount = 0;
  private icount = 0;
  private geo: THREE.BufferGeometry;
  private cam = new THREE.Vector3();
  readonly maxVerts: number;

  constructor(maxVerts = 24000) {
    this.maxVerts = maxVerts;
    this.pos = new Float32Array(maxVerts * 3);
    this.col = new Float32Array(maxVerts * 4);
    this.uvs = new Float32Array(maxVerts * 2);
    this.kind = new Float32Array(maxVerts);
    const geo = new THREE.BufferGeometry();
    const mk = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('position', mk(this.pos, 3));
    geo.setAttribute('scol', mk(this.col, 4));
    geo.setAttribute('uv', mk(this.uvs, 2));
    geo.setAttribute('skind', mk(this.kind, 1));
    const idx = new Uint32Array((maxVerts / 2) * 6);
    // quads between consecutive vertex pairs; degenerate joins are skipped by building per-strip
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = geo;
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const c = attribute('scol', 'vec4');
    const k = attribute('skind', 'float');
    const u = uv();
    // across profile: hot core, soft halo
    const across = abs(u.y.sub(0.5)).mul(2);
    const core = pow(float(1).sub(across), 3.0);
    const halo = smoothstep(1.0, 0.0, across).mul(0.35);
    // ribbons: scrolling noise breakup along length
    const n = mx_noise_float(vec3(u.x.mul(6).sub(time.mul(3)), u.y.mul(2), k.mul(13))).mul(0.5).add(0.5);
    const isRibbon = float(1).sub(smoothstep(0.5, 1.5, k));
    const breakup = mix(float(1), n.mul(1.3).add(0.2), isRibbon.mul(0.7));
    // kind 2 = wind streak: flickering dashes
    const isWind = smoothstep(1.5, 2.5, k);
    const dash = mix(float(1), sin(u.x.mul(18).sub(time.mul(12))).mul(0.5).add(0.5), isWind);
    const a = c.w.mul(core.add(halo)).mul(breakup).mul(dash);
    m.colorNode = vec4(c.xyz.mul(a).mul(mix(float(1), float(1.6), core)), a);
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    void vec2;
  }

  begin(camera: THREE.Camera): void {
    this.vcount = 0;
    this.icount = 0;
    this.cam.setFromMatrixPosition(camera.matrixWorld);
  }

  /**
   * Add a polyline. pts = [x,y,z,...]; width(t), color/alpha per point via callbacks (t in 0..1 along).
   */
  add(pts: ArrayLike<number>, n: number, width: (t: number) => number, color: (t: number, out: number[]) => void, kind = 0): void {
    if (n < 2 || this.vcount + n * 2 > this.maxVerts) return;
    const base = this.vcount;
    const idx = this.geo.index!.array as Uint32Array;
    const out = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1),
        i1 = Math.min(n - 1, i + 1);
      const tx = pts[i1 * 3] - pts[i0 * 3],
        ty = pts[i1 * 3 + 1] - pts[i0 * 3 + 1],
        tz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
      const px = pts[i * 3],
        py = pts[i * 3 + 1],
        pz = pts[i * 3 + 2];
      const vx = this.cam.x - px,
        vy = this.cam.y - py,
        vz = this.cam.z - pz;
      // side = normalize(cross(tangent, view))
      let sx = ty * vz - tz * vy,
        sy = tz * vx - tx * vz,
        sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const t = i / (n - 1);
      const w = width(t) * 0.5;
      sx = (sx / sl) * w;
      sy = (sy / sl) * w;
      sz = (sz / sl) * w;
      const v = this.vcount;
      this.pos[v * 3] = px + sx;
      this.pos[v * 3 + 1] = py + sy;
      this.pos[v * 3 + 2] = pz + sz;
      this.pos[v * 3 + 3] = px - sx;
      this.pos[v * 3 + 4] = py - sy;
      this.pos[v * 3 + 5] = pz - sz;
      color(t, out);
      for (let k = 0; k < 2; k++) {
        this.col[(v + k) * 4] = out[0];
        this.col[(v + k) * 4 + 1] = out[1];
        this.col[(v + k) * 4 + 2] = out[2];
        this.col[(v + k) * 4 + 3] = out[3];
        this.kind[v + k] = kind;
      }
      this.uvs[v * 2] = t;
      this.uvs[v * 2 + 1] = 0;
      this.uvs[v * 2 + 2] = t;
      this.uvs[v * 2 + 3] = 1;
      this.vcount += 2;
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      idx[this.icount++] = a;
      idx[this.icount++] = a + 1;
      idx[this.icount++] = a + 2;
      idx[this.icount++] = a + 1;
      idx[this.icount++] = a + 3;
      idx[this.icount++] = a + 2;
    }
  }

  end(): void {
    const g = this.geo;
    for (const name of ['position', 'scol', 'uv', 'skind']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.vcount * a.itemSize);
      a.needsUpdate = true;
    }
    const ia = g.index!;
    ia.clearUpdateRanges();
    ia.addUpdateRange(0, this.icount);
    ia.needsUpdate = true;
    g.setDrawRange(0, this.icount);
    this.mesh.visible = this.icount > 0;
  }

  get vertices(): number {
    return this.vcount;
  }
}

/** A position history that renders as a fading ribbon. */
export class Trail {
  pts: number[] = [];
  times: number[] = [];
  alive = true;
  constructor(
    public color: number,
    public color2: number,
    public width: number,
    public life: number,
    public intensity = 2,
    public kind = 0,
  ) {}
  push(x: number, y: number, z: number, t: number): void {
    const n = this.times.length;
    if (n > 0) {
      const lx = this.pts[(n - 1) * 3],
        ly = this.pts[(n - 1) * 3 + 1],
        lz = this.pts[(n - 1) * 3 + 2];
      if (Math.hypot(x - lx, y - ly, z - lz) < 0.12 && n > 1) {
        this.pts[(n - 1) * 3] = x;
        this.pts[(n - 1) * 3 + 1] = y;
        this.pts[(n - 1) * 3 + 2] = z;
        this.times[n - 1] = t;
        return;
      }
    }
    this.pts.push(x, y, z);
    this.times.push(t);
    if (this.times.length > 40) {
      this.times.shift();
      this.pts.splice(0, 3);
    }
  }
  prune(t: number): void {
    while (this.times.length && t - this.times[0] > this.life) {
      this.times.shift();
      this.pts.splice(0, 3);
    }
  }
  get empty(): boolean {
    return this.times.length < 2;
  }
}

const tc1 = new THREE.Color();
const tc2 = new THREE.Color();
export function drawTrail(sr: StripRenderer, tr: Trail, now: number): void {
  tr.prune(now);
  const n = tr.times.length;
  if (n < 2) return;
  tc1.set(tr.color);
  tc2.set(tr.color2);
  sr.add(
    tr.pts,
    n,
    (t) => tr.width * (0.15 + 0.85 * t),
    (t, out) => {
      out[0] = (tc2.r + (tc1.r - tc2.r) * t) * tr.intensity;
      out[1] = (tc2.g + (tc1.g - tc2.g) * t) * tr.intensity;
      out[2] = (tc2.b + (tc1.b - tc2.b) * t) * tr.intensity;
      out[3] = t * t;
    },
    tr.kind,
  );
}
