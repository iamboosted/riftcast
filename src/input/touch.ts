import type { ControlState, Settings } from './controls';
import { classifyTouch, computeLayout, lookFromDrag, rimTurnRate, stickVector, type TouchButtonId, type TouchLayout } from './touchLayout';
import { ELEMENT_INFO } from '../data/elements';
import type { Element } from '../sim/types';

interface Track {
  kind: TouchButtonId | 'move' | 'aim';
  ox: number;
  oy: number;
  lx: number;
  ly: number;
  x: number;
  y: number;
}

const LABELS: Record<TouchButtonId, string> = {
  primary: '✦',
  heavy: '◉',
  signature: '✸',
  dash: '»',
  jump: '⤒',
  swap: '⇄',
  ping: '!',
};

/**
 * Twin-stick + button touch controls. Left half: floating move stick. Right half: aim stick
 * (drag to aim; rim push keeps turning). Primary/heavy buttons also aim while dragged.
 */
export class TouchControls {
  root: HTMLDivElement;
  layout!: TouchLayout;
  private tracks = new Map<number, Track>();
  private btnEls = new Map<TouchButtonId, HTMLDivElement>();
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private aimBase: HTMLDivElement;
  private aimKnob: HTMLDivElement;
  private cdEls = new Map<TouchButtonId, HTMLDivElement>();
  active = false;
  aimRate = 0;
  private aimStick = { x: 0, y: 0, mag: 0 };

  constructor(private parent: HTMLElement, private c: ControlState, private settings: Settings) {
    this.root = document.createElement('div');
    this.root.className = 'touch-root';
    parent.appendChild(this.root);
    const mk = (cls: string) => {
      const d = document.createElement('div');
      d.className = cls;
      this.root.appendChild(d);
      return d;
    };
    this.stickBase = mk('tstick-base');
    this.stickKnob = mk('tstick-knob');
    this.aimBase = mk('tstick-base aim');
    this.aimKnob = mk('tstick-knob aim');
    for (const id of Object.keys(LABELS) as TouchButtonId[]) {
      const b = mk(`tbtn tbtn-${id}`);
      b.innerHTML = `<span>${LABELS[id]}</span>`;
      const cd = document.createElement('div');
      cd.className = 'tbtn-cd';
      b.appendChild(cd);
      this.cdEls.set(id, cd);
      this.btnEls.set(id, b);
    }
    this.relayout();
    window.addEventListener('resize', () => this.relayout());
    window.addEventListener('orientationchange', () => setTimeout(() => this.relayout(), 250));
    const opts = { passive: false } as AddEventListenerOptions;
    this.root.addEventListener('pointerdown', (e) => this.down(e), opts);
    this.root.addEventListener('pointermove', (e) => this.move(e), opts);
    this.root.addEventListener('pointerup', (e) => this.up(e), opts);
    this.root.addEventListener('pointercancel', (e) => this.up(e), opts);
    this.root.addEventListener('lostpointercapture', (e) => this.up(e), opts);
    this.setVisible(false);
  }

  safeArea() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => parseFloat(cs.getPropertyValue(n)) || 0;
    return { l: v('--sal'), r: v('--sar'), t: v('--sat'), b: v('--sab') };
  }

  relayout(): void {
    this.layout = computeLayout(window.innerWidth, window.innerHeight, this.safeArea());
    for (const b of this.layout.buttons) {
      const el = this.btnEls.get(b.id)!;
      el.style.left = `${b.x - b.r}px`;
      el.style.top = `${b.y - b.r}px`;
      el.style.width = el.style.height = `${b.r * 2}px`;
      el.style.fontSize = `${b.r * 0.8}px`;
    }
    const sr = this.layout.stickRadius;
    for (const el of [this.stickBase, this.aimBase]) el.style.width = el.style.height = `${sr * 2}px`;
    for (const el of [this.stickKnob, this.aimKnob]) el.style.width = el.style.height = `${sr * 0.9}px`;
    this.placeStickIdle();
  }

  private placeStickIdle(): void {
    const sr = this.layout.stickRadius;
    const sa = this.safeArea();
    const ox = sa.l + sr + 40 * this.layout.scale,
      oy = this.layout.h - sa.b - sr - 30 * this.layout.scale;
    this.drawStick(this.stickBase, this.stickKnob, ox, oy, ox, oy, false);
    this.aimBase.style.opacity = '0';
    this.aimKnob.style.opacity = '0';
  }

  private drawStick(base: HTMLDivElement, knob: HTMLDivElement, ox: number, oy: number, x: number, y: number, on: boolean) {
    const sr = this.layout.stickRadius;
    const dx = x - ox,
      dy = y - oy;
    const m = Math.hypot(dx, dy);
    const k = m > sr ? sr / m : 1;
    base.style.transform = `translate(${ox - sr}px, ${oy - sr}px)`;
    knob.style.transform = `translate(${ox + dx * k - sr * 0.45}px, ${oy + dy * k - sr * 0.45}px)`;
    base.style.opacity = on ? '0.55' : '0.28';
    knob.style.opacity = on ? '0.9' : '0.4';
  }

  setVisible(v: boolean): void {
    this.active = v;
    this.root.style.display = v ? 'block' : 'none';
    if (!v) {
      this.tracks.clear();
      this.release();
    }
  }

  private release(): void {
    this.c.moveX = this.c.moveY = 0;
    this.c.primary = this.c.heavy = this.c.jumpHeld = false;
    this.aimRate = 0;
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    this.c.device = 'touch';
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const kind = classifyTouch(this.layout, e.clientX, e.clientY);
    if (kind === 'move' && [...this.tracks.values()].some((t) => t.kind === 'move')) return;
    if (kind === 'aim' && [...this.tracks.values()].some((t) => t.kind === 'aim')) return;
    const t: Track = { kind, ox: e.clientX, oy: e.clientY, lx: e.clientX, ly: e.clientY, x: e.clientX, y: e.clientY };
    this.tracks.set(e.pointerId, t);
    switch (kind) {
      case 'primary':
        this.c.primary = true;
        break;
      case 'heavy':
        this.c.heavy = true;
        break;
      case 'jump':
        this.c.jump++;
        this.c.jumpHeld = true;
        break;
      case 'dash':
        this.c.dash++;
        break;
      case 'signature':
        this.c.sig++;
        break;
      case 'swap':
        this.c.swap++;
        break;
      case 'ping':
        this.c.ping++;
        break;
    }
    if (kind !== 'move' && kind !== 'aim') this.btnEls.get(kind)?.classList.add('on');
    if (kind === 'move') this.drawStick(this.stickBase, this.stickKnob, t.ox, t.oy, t.x, t.y, true);
    if (kind === 'aim') this.drawStick(this.aimBase, this.aimKnob, t.ox, t.oy, t.x, t.y, true);
  }

  private move(e: PointerEvent): void {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    t.x = e.clientX;
    t.y = e.clientY;
    const ddx = t.x - t.lx,
      ddy = t.y - t.ly;
    t.lx = t.x;
    t.ly = t.y;
    if (t.kind === 'move') {
      const v = stickVector(t.ox, t.oy, t.x, t.y, this.layout.stickRadius);
      this.c.moveX = v.x;
      this.c.moveY = v.y;
      this.drawStick(this.stickBase, this.stickKnob, t.ox, t.oy, t.x, t.y, true);
    } else if (t.kind === 'aim' || t.kind === 'primary' || t.kind === 'heavy') {
      const l = lookFromDrag(ddx, ddy, this.settings.touchLook, this.layout.scale);
      this.c.lookDX += l.yaw;
      this.c.lookDY += l.pitch * (this.settings.invertY ? -1 : 1);
      if (t.kind === 'aim') {
        this.aimStick = stickVector(t.ox, t.oy, t.x, t.y, this.layout.stickRadius * 1.3, 0.05);
        this.aimRate = rimTurnRate(this.aimStick, this.settings.touchLook);
        this.drawStick(this.aimBase, this.aimKnob, t.ox, t.oy, t.x, t.y, true);
      }
    }
  }

  private up(e: PointerEvent): void {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    this.tracks.delete(e.pointerId);
    switch (t.kind) {
      case 'move':
        this.c.moveX = this.c.moveY = 0;
        this.placeStickIdle();
        break;
      case 'aim':
        this.aimRate = 0;
        this.aimBase.style.opacity = '0';
        this.aimKnob.style.opacity = '0';
        break;
      case 'primary':
        this.c.primary = false;
        break;
      case 'heavy':
        this.c.heavy = false;
        break;
      case 'jump':
        this.c.jumpHeld = false;
        break;
    }
    if (t.kind !== 'move' && t.kind !== 'aim') this.btnEls.get(t.kind)?.classList.remove('on');
  }

  update(dt: number): void {
    if (this.aimRate) this.c.lookDX += this.aimRate * dt;
  }

  /** Show cooldown sweeps + element color on buttons. */
  setHud(el: Element, cds: { primary: number; heavy: number; signature: number }, sigMax: number, charge: number, dashReady: boolean): void {
    const color = ELEMENT_INFO[el].css;
    this.root.style.setProperty('--el', color);
    const sig = this.cdEls.get('signature')!;
    const f = sigMax > 0 ? Math.min(1, cds.signature / sigMax) : 0;
    sig.style.background = f > 0 ? `conic-gradient(rgba(0,0,0,0.6) ${f * 360}deg, transparent 0)` : 'none';
    const hv = this.cdEls.get('heavy')!;
    hv.style.background = charge > 0 ? `conic-gradient(${color} ${charge * 360}deg, transparent 0)` : 'none';
    hv.style.opacity = charge > 0 ? '0.55' : '1';
    this.btnEls.get('dash')!.style.opacity = dashReady ? '1' : '0.45';
  }
}
