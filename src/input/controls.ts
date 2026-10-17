/**
 * Unified control state from keyboard/mouse, gamepad and touch.
 * Edge actions are counters so the network layer can't miss a press.
 */
export interface ControlState {
  moveX: number; // strafe right +
  moveY: number; // forward +
  /** accumulated look deltas in radians since last consume */
  lookDX: number;
  lookDY: number;
  primary: boolean;
  heavy: boolean;
  jumpHeld: boolean;
  sig: number;
  dash: number;
  jump: number;
  swap: number;
  ping: number;
  pause: number;
  /** which device last produced input: affects aim assist + UI */
  device: 'kbm' | 'pad' | 'touch';
}

export const newControls = (): ControlState => ({
  moveX: 0,
  moveY: 0,
  lookDX: 0,
  lookDY: 0,
  primary: false,
  heavy: false,
  jumpHeld: false,
  sig: 0,
  dash: 0,
  jump: 0,
  swap: 0,
  ping: 0,
  pause: 0,
  device: 'kbm',
});

export interface Settings {
  sensitivity: number;
  invertY: boolean;
  aimAssist: boolean;
  touchLook: number;
}

export class KeyboardMouse {
  keys = new Set<string>();
  mouseL = false;
  mouseR = false;
  locked = false;
  enabled = true;
  constructor(private el: HTMLElement, private c: ControlState, private settings: Settings) {
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseL = this.mouseR = false;
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.c.device = 'kbm';
      if (!this.locked && e.button === 0) {
        this.requestLock();
        return;
      }
      if (e.button === 0) this.mouseL = true;
      if (e.button === 2) this.mouseR = true;
      if (e.button === 1) this.c.ping++;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.mouseL = this.mouseR = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const s = 0.0022 * this.settings.sensitivity;
      this.c.lookDX += e.movementX * s;
      this.c.lookDY += e.movementY * s * (this.settings.invertY ? -1 : 1);
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.locked && Math.abs(e.deltaY) > 20) this.c.swap++;
      },
      { passive: true },
    );
  }

  requestLock(): void {
    try {
      const r = this.el.requestPointerLock?.() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const k = e.code;
    if (down && !this.keys.has(k)) {
      this.c.device = 'kbm';
      if (k === 'Space') this.c.jump++;
      if (k === 'ShiftLeft' || k === 'ShiftRight') this.c.dash++;
      if (k === 'KeyQ' || k === 'KeyE') this.c.sig++;
      if (k === 'KeyR' || k === 'Tab') this.c.swap++;
      if (k === 'KeyG' || k === 'KeyZ') this.c.ping++;
      if (k === 'Escape' || k === 'KeyP') this.c.pause++;
    }
    if (k === 'Tab' || k === 'Space') e.preventDefault();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
  }

  update(): void {
    if (this.c.device !== 'kbm') return;
    const k = this.keys;
    this.c.moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.c.moveY = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.c.primary = this.mouseL || k.has('KeyJ');
    this.c.heavy = this.mouseR || k.has('KeyK') || k.has('KeyF');
    this.c.jumpHeld = k.has('Space');
  }
}

/** Standard-mapping gamepad. */
export class Gamepads {
  private prev: boolean[] = [];
  constructor(private c: ControlState, private settings: Settings) {}
  update(dt: number): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) return;
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const lx = dz(gp.axes[0] ?? 0),
      ly = dz(gp.axes[1] ?? 0),
      rx = dz(gp.axes[2] ?? 0),
      ry = dz(gp.axes[3] ?? 0);
    const b = (i: number) => !!gp.buttons[i]?.pressed;
    const any = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0 || gp.buttons.some((x) => x.pressed);
    if (any) this.c.device = 'pad';
    if (this.c.device !== 'pad') return;
    this.c.moveX = lx;
    this.c.moveY = -ly;
    const rate = 3.2 * this.settings.sensitivity;
    const curve = (v: number) => Math.sign(v) * v * v;
    this.c.lookDX += curve(rx) * rate * dt;
    this.c.lookDY += curve(ry) * rate * 0.7 * dt * (this.settings.invertY ? -1 : 1);
    this.c.primary = b(7) || (gp.buttons[7]?.value ?? 0) > 0.3;
    this.c.heavy = b(6) || (gp.buttons[6]?.value ?? 0) > 0.3;
    this.c.jumpHeld = b(0);
    const edge = (i: number) => b(i) && !this.prev[i];
    if (edge(0)) this.c.jump++;
    if (edge(1) || edge(10)) this.c.dash++;
    if (edge(5) || edge(2)) this.c.sig++;
    if (edge(4) || edge(3)) this.c.swap++;
    if (edge(12) || edge(11)) this.c.ping++;
    if (edge(9)) this.c.pause++;
    this.prev = gp.buttons.map((x) => x.pressed);
  }
}
