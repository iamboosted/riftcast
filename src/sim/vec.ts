export interface V3 {
  x: number;
  y: number;
  z: number;
}
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const vcopy = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const vset = (o: V3, x: number, y: number, z: number): V3 => ((o.x = x), (o.y = y), (o.z = z), o);
export const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vlen = (a: V3) => Math.hypot(a.x, a.y, a.z);
export const vdist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2D = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.z - b.z);
export const vnorm = (a: V3): V3 => {
  const l = vlen(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const angleDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
/** Yaw convention: yaw=0 faces -Z; direction = (-sin(yaw), 0, -cos(yaw)). */
export const yawDir = (yaw: number): V3 => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
export const dirYaw = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** Distance from point p to segment ab in XZ plane, returns [dist, t]. */
export function segDist2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number): [number, number] {
  const abx = bx - ax,
    abz = bz - az;
  const l2 = abx * abx + abz * abz || 1e-9;
  let t = ((px - ax) * abx + (pz - az) * abz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t,
    cz = az + abz * t;
  return [Math.hypot(px - cx, pz - cz), t];
}
export const round2 = (v: number) => Math.round(v * 100) / 100;
