/** Pure touch-control math: layout, hit testing and stick mapping. Unit tested; no DOM access. */

export type TouchButtonId = 'primary' | 'heavy' | 'signature' | 'dash' | 'jump' | 'swap' | 'ping';

export interface TouchButton {
  id: TouchButtonId;
  x: number;
  y: number;
  r: number;
}

export interface SafeArea {
  l: number;
  r: number;
  t: number;
  b: number;
}

export interface TouchLayout {
  w: number;
  h: number;
  scale: number;
  buttons: TouchButton[];
  stickRadius: number;
  /** x below which touches drive the move stick */
  moveZoneX: number;
  /** central rectangle kept clear for the action */
  center: { x0: number; y0: number; x1: number; y1: number };
}

export function computeLayout(w: number, h: number, safe: SafeArea = { l: 0, r: 0, t: 0, b: 0 }): TouchLayout {
  const s = Math.max(0.72, Math.min(1.35, Math.min(w, h) / 390));
  const px = w - safe.r - 92 * s;
  const py = h - safe.b - 84 * s;
  const rel = (id: TouchButtonId, dx: number, dy: number, r: number): TouchButton => ({ id, x: px + dx * s, y: py + dy * s, r: r * s });
  const buttons: TouchButton[] = [
    rel('primary', 0, 0, 50),
    rel('jump', -110, 30, 34),
    rel('heavy', -92, -76, 35),
    rel('signature', -14, -118, 33),
    rel('dash', 82, -100, 31),
    rel('swap', 78, -176, 23),
    rel('ping', 10, -196, 22),
  ];
  // keep everything on screen
  for (const b of buttons) {
    b.x = Math.min(w - safe.r - b.r - 4, Math.max(safe.l + b.r + 4, b.x));
    b.y = Math.min(h - safe.b - b.r - 4, Math.max(safe.t + b.r + 4, b.y));
  }
  return {
    w,
    h,
    scale: s,
    buttons,
    stickRadius: 62 * s,
    moveZoneX: w * 0.42,
    center: { x0: w * 0.3, y0: h * 0.2, x1: w * 0.68, y1: h * 0.7 },
  };
}

export function hitButton(layout: TouchLayout, x: number, y: number, slop = 1.18): TouchButtonId | null {
  let best: TouchButtonId | null = null;
  let bd = Infinity;
  for (const b of layout.buttons) {
    const d = Math.hypot(x - b.x, y - b.y);
    if (d < b.r * slop && d < bd) {
      bd = d;
      best = b.id;
    }
  }
  return best;
}

export function overlapsCenter(layout: TouchLayout): boolean {
  const c = layout.center;
  return layout.buttons.some((b) => b.x + b.r > c.x0 && b.x - b.r < c.x1 && b.y + b.r > c.y0 && b.y - b.r < c.y1);
}

/** Map a drag from (ox,oy) to (x,y) into a stick vector (y up positive), clamped to unit length with deadzone. */
export function stickVector(ox: number, oy: number, x: number, y: number, radius: number, deadzone = 0.12): { x: number; y: number; mag: number } {
  const dx = (x - ox) / radius,
    dy = -(y - oy) / radius;
  const m = Math.hypot(dx, dy);
  if (m < deadzone) return { x: 0, y: 0, mag: 0 };
  const cm = Math.min(1, m);
  const scaled = (cm - deadzone) / (1 - deadzone);
  return { x: (dx / m) * scaled, y: (dy / m) * scaled, mag: scaled };
}

/** Pixel drag -> camera radians. Sensitivity scales with layout so it feels the same across phones. */
export function lookFromDrag(dxPx: number, dyPx: number, sens: number, scale: number): { yaw: number; pitch: number } {
  const k = (0.0058 * sens) / scale;
  return { yaw: dxPx * k, pitch: dyPx * k * 0.8 };
}

/** When the aim stick is pushed to its rim, keep turning (radians/sec). */
export function rimTurnRate(stick: { x: number; mag: number }, sens: number): number {
  if (stick.mag < 0.85) return 0;
  return Math.sign(stick.x) * (stick.mag - 0.85) * 18 * sens;
}

/** Returns which zone a new touch belongs to. */
export function classifyTouch(layout: TouchLayout, x: number, y: number): TouchButtonId | 'move' | 'aim' {
  const b = hitButton(layout, x, y);
  if (b) return b;
  return x < layout.moveZoneX ? 'move' : 'aim';
}
