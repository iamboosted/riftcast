import type { Element, SimEvent } from '../sim/types';
import type { ViewState } from '../net/session';
import type { SettingsState } from '../game/meta';

type Pos = { x: number; y: number; z: number };

/**
 * Fully procedural WebAudio: every sound is synthesised from oscillators + noise at runtime.
 * Unlocks on first user gesture (iOS requirement).
 */
export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private last = new Map<string, number>();
  private voices = 0;
  private volume = 0.8;
  private ambient: { pad: GainNode; pulse: GainNode; oscs: OscillatorNode[]; filter: BiquadFilterNode } | null = null;
  private pulseT = 0;
  private intensity = 0;
  private listener: Pos = { x: 0, y: 0, z: 0 };
  unlocked = false;

  unlock(settings?: SettingsState): void {
    if (settings) this.volume = settings.muted ? 0 : settings.volume;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.build();
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      // iOS: play a silent buffer inside the gesture
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
      this.unlocked = true;
    } catch {
      /* audio unavailable */
    }
  }

  private build(): void {
    const c = this.ctx!;
    this.master = c.createGain();
    this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
    this.sfx = c.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = c.createGain();
    this.music.gain.value = 0.32;
    this.music.connect(this.master);
    // generated impulse response
    const len = Math.floor(c.sampleRate * 2.2);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
    }
    this.reverb = c.createConvolver();
    this.reverb.buffer = ir;
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(this.reverb).connect(this.master);
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.startAmbient();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- primitives
  private out(pos?: Pos, gain = 1, rev = 0.25): AudioNode | null {
    const c = this.ctx;
    if (!c || c.state !== 'running') return null;
    if (this.voices > 40) return null;
    const g = c.createGain();
    let vol = gain;
    let pan = 0;
    if (pos) {
      const dx = pos.x - this.listener.x,
        dz = pos.z - this.listener.z;
      const d = Math.hypot(dx, pos.y - this.listener.y, dz);
      vol *= 1 / (1 + d * 0.06);
      pan = Math.max(-0.8, Math.min(0.8, this.panOf(pos)));
    }
    g.gain.value = vol;
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.sfx);
      if (rev > 0) {
        const s = c.createGain();
        s.gain.value = rev;
        p.connect(s).connect(this.reverbSend);
      }
    } else g.connect(this.sfx);
    this.voices++;
    setTimeout(() => this.voices--, 1500);
    return g;
  }

  panOf: (p: Pos) => number = () => 0;

  private env(g: GainNode, t: number, a: number, peak: number, dec: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }

  private tone(dst: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, peak = 0.4, attack = 0.005, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    this.env(g, t, attack, peak, dur);
    o.connect(g).connect(dst);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  private noise(dst: AudioNode, type: BiquadFilterType, f0: number, f1: number, q: number, dur: number, peak = 0.4, attack = 0.005, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    this.env(g, t, attack, peak, dur);
    s.connect(f).connect(g).connect(dst);
    s.start(t, Math.random() * 1.5);
    s.stop(t + attack + dur + 0.05);
  }

  private fm(dst: AudioNode, carrier: number, ratio: number, index: number, dur: number, peak = 0.3, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const m = c.createOscillator();
    const mg = c.createGain();
    o.frequency.value = carrier;
    m.frequency.value = carrier * ratio;
    mg.gain.setValueAtTime(carrier * index, t);
    mg.gain.exponentialRampToValueAtTime(1, t + dur);
    m.connect(mg).connect(o.frequency);
    const g = c.createGain();
    this.env(g, t, 0.003, peak, dur);
    o.connect(g).connect(dst);
    o.start(t);
    m.start(t);
    o.stop(t + dur + 0.05);
    m.stop(t + dur + 0.05);
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    const l = this.last.get(key) ?? 0;
    if (now - l < ms) return false;
    this.last.set(key, now);
    return true;
  }

  // ---------------------------------------------------------------- element voices
  cast(el: Element, slot: string, pos: Pos, local: boolean) {
    if (!this.throttle(`cast-${el}-${slot}-${local}`, slot === 'primary' ? 55 : 30)) return;
    const big = slot === 'primary' ? 0.5 : slot === 'heavy' ? 0.85 : 1;
    const o = this.out(local ? undefined : pos, (local ? 0.8 : 0.5) * big, slot === 'primary' ? 0.1 : 0.35);
    if (!o) return;
    const j = 0.92 + Math.random() * 0.16;
    switch (el) {
      case 'fire':
        this.noise(o, 'bandpass', 1500 * j, 380, 1.2, 0.18 + big * 0.12, 0.6);
        this.tone(o, 'sine', 150 * j, 55, 0.14 + big * 0.1, 0.5);
        if (slot !== 'primary') this.noise(o, 'lowpass', 600, 120, 0.7, 0.5, 0.4, 0.02);
        break;
      case 'frost':
        this.fm(o, 1320 * j, 2.76, 2.5, 0.35 + big * 0.2, 0.22);
        this.noise(o, 'highpass', 7000, 4000, 0.7, 0.08, 0.25);
        if (slot !== 'primary') this.fm(o, 990 * j, 3.5, 3, 0.7, 0.18, 0.04);
        break;
      case 'storm':
        this.tone(o, 'sawtooth', 2200 * j, 140, 0.1 + big * 0.1, 0.22);
        this.noise(o, 'highpass', 3000, 1500, 0.8, 0.12, 0.35);
        if (slot !== 'primary') this.tone(o, 'square', 90, 40, 0.3, 0.2, 0.002, 0.02);
        break;
      case 'gale':
        this.noise(o, 'bandpass', 450 * j, 2600, 2.2, 0.16 + big * 0.2, 0.55, 0.03);
        this.noise(o, 'bandpass', 2600, 700, 3, 0.2 + big * 0.1, 0.3, 0.02, 0.1);
        break;
      case 'stone':
        this.tone(o, 'sine', 110 * j, 42, 0.2 + big * 0.15, 0.7);
        this.noise(o, 'lowpass', 900, 200, 0.8, 0.14 + big * 0.1, 0.5);
        break;
      case 'venom':
        this.tone(o, 'sine', 230 * j, 560, 0.1, 0.45);
        for (let i = 0; i < (slot === 'primary' ? 1 : 3); i++) this.tone(o, 'sine', 400 + Math.random() * 400, 900 + Math.random() * 500, 0.05, 0.18, 0.003, 0.05 + i * 0.05);
        break;
    }
  }

  impact(el: Element, pos: Pos, size: number) {
    if (!this.throttle(`imp-${el}`, 45)) return;
    const o = this.out(pos, Math.min(1, 0.35 + size * 0.25), 0.3);
    if (!o) return;
    switch (el) {
      case 'fire':
        this.noise(o, 'lowpass', 1400, 200, 0.7, 0.25 + size * 0.15, 0.55);
        this.tone(o, 'sine', 90, 35, 0.25 + size * 0.1, 0.5 * size);
        for (let i = 0; i < 4; i++) this.noise(o, 'highpass', 2500, 2000, 1, 0.02, 0.2, 0.001, 0.03 + Math.random() * 0.2);
        break;
      case 'frost':
        for (let i = 0; i < 4; i++) this.tone(o, 'sine', 2000 + Math.random() * 3500, 1500, 0.08 + Math.random() * 0.1, 0.12, 0.002, Math.random() * 0.06);
        this.noise(o, 'highpass', 5000, 3000, 0.8, 0.15, 0.3);
        break;
      case 'storm':
        this.noise(o, 'highpass', 2500, 800, 0.7, 0.08, 0.5);
        this.noise(o, 'lowpass', 500, 80, 0.7, 0.3 + size * 0.3, 0.45, 0.01, 0.02);
        break;
      case 'gale':
        this.noise(o, 'bandpass', 1800, 400, 2, 0.22, 0.4);
        break;
      case 'stone':
        this.tone(o, 'sine', 80, 35, 0.25, 0.6);
        this.noise(o, 'lowpass', 1600, 250, 0.9, 0.22, 0.6);
        for (let i = 0; i < 5; i++) this.noise(o, 'bandpass', 900 + Math.random() * 1500, 600, 4, 0.03, 0.3, 0.001, Math.random() * 0.2);
        break;
      case 'venom':
        this.noise(o, 'bandpass', 700, 300, 2, 0.2, 0.5);
        this.tone(o, 'sine', 300, 120, 0.15, 0.4);
        break;
    }
  }

  thunder(pos: Pos, big = 1) {
    if (!this.throttle('thunder', 70)) return;
    const o = this.out(pos, 0.9 * big, 0.6);
    if (!o) return;
    this.noise(o, 'highpass', 4000, 1200, 0.7, 0.06, 0.8);
    this.noise(o, 'lowpass', 700, 60, 0.7, 1.3, 0.75, 0.01, 0.03);
    this.tone(o, 'sine', 70, 30, 0.6, 0.5, 0.01, 0.03);
  }

  combo(name: string) {
    if (!this.ctx || !this.throttle('combo', 200)) return;
    const o = this.out(undefined, 1, 0.7);
    if (!o) return;
    // reverse swell into a boom + bright chord
    const c = this.ctx;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(3000, t + 0.18);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.17);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    s.connect(f).connect(g).connect(o);
    s.start(t);
    s.stop(t + 0.3);
    this.tone(o, 'sine', 70, 28, 0.9, 0.9, 0.005, 0.17);
    this.noise(o, 'lowpass', 2500, 100, 0.7, 0.8, 0.6, 0.005, 0.17);
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const roots = [220, 246.9, 261.6, 293.7, 329.6];
    const root = roots[h % roots.length];
    const chord = [1, 1.25, 1.5, 2];
    chord.forEach((m, i) => this.fm(o, root * m * 2, 2, 1.2, 1.1, 0.12, 0.2 + i * 0.05));
  }

  ui(kind: 'click' | 'pickup' | 'revive' | 'down' | 'hurt' | 'dash' | 'jump' | 'swap' | 'ping') {
    if (!this.throttle(`ui-${kind}`, 50)) return;
    const o = this.out(undefined, 0.5, 0.15);
    if (!o) return;
    switch (kind) {
      case 'click':
        this.tone(o, 'sine', 1200, 900, 0.05, 0.2);
        break;
      case 'pickup':
        [0, 0.06, 0.12].forEach((d, i) => this.fm(o, 880 * [1, 1.25, 1.5][i], 2, 0.8, 0.25, 0.18, d));
        break;
      case 'revive':
        [0, 0.08, 0.16, 0.24].forEach((d, i) => this.fm(o, 523 * [1, 1.25, 1.5, 2][i], 1, 0.6, 0.5, 0.2, d));
        break;
      case 'down':
        this.tone(o, 'triangle', 440, 110, 0.8, 0.35);
        break;
      case 'hurt':
        this.tone(o, 'sawtooth', 160, 70, 0.15, 0.3);
        this.noise(o, 'lowpass', 900, 200, 0.7, 0.12, 0.35);
        break;
      case 'dash':
        this.noise(o, 'bandpass', 900, 3000, 1.5, 0.14, 0.35);
        break;
      case 'jump':
        this.tone(o, 'sine', 300, 600, 0.08, 0.12);
        break;
      case 'swap':
        this.fm(o, 660, 1.5, 1.5, 0.15, 0.15);
        break;
      case 'ping':
        this.fm(o, 1046, 2, 1, 0.3, 0.25);
        this.fm(o, 1568, 2, 1, 0.3, 0.2, 0.09);
        break;
    }
  }

  death(faction: string, pos: Pos) {
    if (!this.throttle('death', 60)) return;
    const o = this.out(pos, 0.5, 0.3);
    if (!o) return;
    if (faction === 'glass') for (let i = 0; i < 5; i++) this.tone(o, 'sine', 2500 + Math.random() * 3000, 1800, 0.1, 0.12, 0.002, Math.random() * 0.08);
    else if (faction === 'mire') {
      this.noise(o, 'bandpass', 500, 200, 3, 0.3, 0.5);
      this.tone(o, 'sine', 180, 70, 0.25, 0.4);
    } else {
      this.noise(o, 'lowpass', 1200, 150, 0.8, 0.4, 0.5);
      this.tone(o, 'sine', 100, 40, 0.3, 0.4);
    }
  }

  telegraph(pos: Pos) {
    if (!this.throttle('tele', 70)) return;
    const o = this.out(pos, 0.45, 0.3);
    if (!o) return;
    this.tone(o, 'sine', 120, 45, 0.25, 0.5);
    this.noise(o, 'lowpass', 600, 120, 0.7, 0.2, 0.35);
  }

  room(kind: string) {
    const o = this.out(undefined, 0.6, 0.8);
    if (!o) return;
    const base = kind === 'boss' ? 55 : 82.4;
    [1, 1.5, 2].forEach((m, i) => this.tone(o, 'sawtooth', base * m, base * m * 0.99, 1.6, 0.08, 0.4, i * 0.05));
    this.tone(o, 'sine', base, base, 1.8, 0.3, 0.3);
  }

  clear() {
    const o = this.out(undefined, 0.6, 0.6);
    if (!o) return;
    [523, 659, 784, 1046].forEach((f, i) => this.fm(o, f, 2, 0.7, 0.6, 0.18, i * 0.09));
  }

  boss(phase: number) {
    const o = this.out(undefined, 0.9, 0.8);
    if (!o) return;
    this.tone(o, 'sawtooth', 55 * phase, 40, 1.8, 0.3, 0.05);
    this.noise(o, 'lowpass', 400, 50, 0.7, 1.5, 0.5);
  }

  end(won: boolean) {
    const o = this.out(undefined, 0.7, 0.8);
    if (!o) return;
    const notes = won ? [523, 659, 784, 1046, 1318] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.fm(o, f, won ? 2 : 1.5, 0.8, 0.9, 0.2, i * 0.16));
  }

  // ---------------------------------------------------------------- ambient bed
  private startAmbient() {
    const c = this.ctx!;
    const pad = c.createGain();
    pad.gain.value = 0.0;
    pad.gain.setTargetAtTime(0.5, c.currentTime, 2);
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    filter.Q.value = 0.7;
    const lfo = c.createOscillator();
    const lfoG = c.createGain();
    lfo.frequency.value = 0.07;
    lfoG.gain.value = 350;
    lfo.connect(lfoG).connect(filter.frequency);
    lfo.start();
    const oscs: OscillatorNode[] = [];
    for (const [f, d] of [
      [55, 0],
      [82.4, 4],
      [110, -5],
      [164.8, 7],
    ]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      const g = c.createGain();
      g.gain.value = 0.08;
      o.connect(g).connect(filter);
      o.start();
      oscs.push(o);
    }
    // wind layer
    const wn = c.createBufferSource();
    wn.buffer = this.noiseBuf;
    wn.loop = true;
    const wf = c.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 500;
    wf.Q.value = 0.6;
    const wg = c.createGain();
    wg.gain.value = 0.05;
    wn.connect(wf).connect(wg).connect(pad);
    wn.start();
    filter.connect(pad).connect(this.music);
    const rs = c.createGain();
    rs.gain.value = 0.5;
    pad.connect(rs).connect(this.reverbSend);
    const pulse = c.createGain();
    pulse.gain.value = 0;
    pulse.connect(this.music);
    this.ambient = { pad, pulse, oscs, filter };
  }

  /** Per-frame: combat intensity drives a pulsing low drum layer. */
  update(dt: number, s: ViewState, playing: boolean) {
    if (!this.ctx || !this.ambient || this.ctx.state !== 'running') return;
    const target = playing && s.run.phase === 'room' ? Math.min(1, 0.25 + s.enemies.length / 10 + (s.enemies.some((e) => e.boss) ? 0.5 : 0)) : 0;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 1.5);
    this.pulseT -= dt;
    if (this.intensity > 0.05 && this.pulseT <= 0) {
      const bpm = 96 + this.intensity * 40;
      this.pulseT = 60 / bpm;
      const c = this.ctx;
      const t = c.currentTime;
      const o = c.createOscillator();
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5 * this.intensity, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + 0.3);
    }
  }

  /** Map sim events to sounds. */
  event(ev: SimEvent, localId: string, listener: Pos) {
    this.listener = listener;
    switch (ev.t) {
      case 'cast':
        this.cast(ev.el, ev.slot, ev, ev.pid === localId);
        break;
      case 'projEnd':
        break;
      case 'hit':
        if (this.throttle('hit', 35)) this.impact(ev.el, ev, ev.crit ? 1 : 0.4);
        break;
      case 'boom':
        this.impact(ev.el, ev, ev.big ? 2 : 1.2);
        break;
      case 'nova':
        this.impact(ev.el, ev, 1.6);
        break;
      case 'strike':
        this.thunder(ev);
        break;
      case 'bolt':
        if (this.throttle('bolt', 60)) this.impact('storm', ev, 0.6);
        break;
      case 'kill':
        this.death(ev.kind === 'shardling' || ev.kind === 'weaver' || ev.kind === 'queen' || ev.kind === 'prism' ? 'glass' : ev.kind === 'sludge' || ev.kind === 'lobber' || ev.kind === 'titan' ? 'mire' : 'cinder', ev);
        break;
      case 'tele':
        this.telegraph({ x: ev.x, y: 0, z: ev.z });
        break;
      case 'down':
        this.ui('down');
        break;
      case 'revive':
        this.ui('revive');
        break;
      case 'pickup':
        this.ui('pickup');
        break;
      case 'hurt':
        if (ev.pid === localId) this.ui('hurt');
        break;
      case 'dash':
        if (ev.pid === localId) this.ui('dash');
        break;
      case 'jump':
        if (ev.pid === localId) this.ui('jump');
        break;
      case 'swap':
        if (ev.pid === localId) this.ui('swap');
        break;
      case 'ping':
        this.ui('ping');
        break;
      case 'shatter':
        this.impact('frost', ev, 2);
        break;
      case 'wallRise':
        this.impact('stone', listener, 1.5);
        break;
    }
  }
}
