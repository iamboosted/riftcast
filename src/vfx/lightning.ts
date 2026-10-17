import { Rng } from '../sim/rng';

export interface LightningOpts {
  /** recursion depth of midpoint displacement (segments = 2^depth) */
  depth?: number;
  /** displacement as a fraction of segment length */
  jag?: number;
  /** chance per main-path vertex to sprout a branch */
  branchChance?: number;
  /** max branch generations */
  branchDepth?: number;
  branchLength?: number;
}

export interface Bolt {
  /** polylines; [0] is the main channel. Each = flat xyz array. */
  paths: number[][];
  /** width multiplier per path (branches are thinner) */
  widths: number[];
}

/**
 * Branching lightning via recursive midpoint displacement + forked branches.
 * Deterministic for a given seed.
 */
export function generateLightning(ax: number, ay: number, az: number, bx: number, by: number, bz: number, seed: number, o: LightningOpts = {}): Bolt {
  const rng = new Rng(seed);
  const depth = o.depth ?? 5;
  const jag = o.jag ?? 0.32;
  const out: Bolt = { paths: [], widths: [] };
  const main = displace([ax, ay, az, bx, by, bz], depth, jag, rng);
  out.paths.push(main);
  out.widths.push(1);
  sprout(out, main, rng, o.branchChance ?? 0.22, o.branchDepth ?? 2, o.branchLength ?? 0.45, depth - 1, jag, 0.55);
  return out;
}

function sprout(out: Bolt, path: number[], rng: Rng, chance: number, gens: number, lenFrac: number, depth: number, jag: number, width: number) {
  if (gens <= 0) return;
  const n = path.length / 3;
  const total = Math.hypot(path[path.length - 3] - path[0], path[path.length - 2] - path[1], path[path.length - 1] - path[2]);
  for (let i = 1; i < n - 1; i++) {
    if (!rng.chance(chance)) continue;
    const x = path[i * 3],
      y = path[i * 3 + 1],
      z = path[i * 3 + 2];
    // branch direction = local tangent rotated randomly
    const tx = path[(i + 1) * 3] - x,
      ty = path[(i + 1) * 3 + 1] - y,
      tz = path[(i + 1) * 3 + 2] - z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const len = total * lenFrac * rng.range(0.4, 1);
    const ex = x + (tx / tl) * len + rng.range(-1, 1) * len * 0.7;
    const ey = y + (ty / tl) * len + rng.range(-1, 0.3) * len * 0.5;
    const ez = z + (tz / tl) * len + rng.range(-1, 1) * len * 0.7;
    const br = displace([x, y, z, ex, ey, ez], Math.max(2, depth), jag, rng);
    out.paths.push(br);
    out.widths.push(width);
    sprout(out, br, rng, chance * 0.6, gens - 1, lenFrac * 0.6, depth - 1, jag, width * 0.6);
  }
}

function displace(seg: number[], depth: number, jag: number, rng: Rng): number[] {
  let pts = seg;
  for (let d = 0; d < depth; d++) {
    const next: number[] = [];
    const n = pts.length / 3;
    for (let i = 0; i < n - 1; i++) {
      const x0 = pts[i * 3],
        y0 = pts[i * 3 + 1],
        z0 = pts[i * 3 + 2];
      const x1 = pts[(i + 1) * 3],
        y1 = pts[(i + 1) * 3 + 1],
        z1 = pts[(i + 1) * 3 + 2];
      const l = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      const amt = l * jag;
      next.push(x0, y0, z0);
      next.push((x0 + x1) / 2 + rng.range(-amt, amt), (y0 + y1) / 2 + rng.range(-amt, amt), (z0 + z1) / 2 + rng.range(-amt, amt));
    }
    next.push(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}
