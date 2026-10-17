import * as THREE from 'three/webgpu';
import { Gfx } from '../render/gfx';
import { GameView } from '../render/view';
import { CameraRig, type AimTarget } from './camera';
import { newControls, KeyboardMouse, Gamepads, type Settings } from '../input/controls';
import { TouchControls } from '../input/touch';
import { Meta } from './meta';
import { Ui } from '../ui/ui';
import { LocalSession, type Session } from '../net/session';
import { BTN_HEAVY, BTN_JUMP, BTN_PRIMARY, emptyInput, type Element, type PingKind, type SimEvent } from '../sim/types';
import { ELEMENT_INFO } from '../data/elements';
import { isMobile, type QualityName } from '../core/quality';
import { GameAudio } from '../audio/audio';
import { SPELL_TIMING } from '../sim/spells';

/** ?slowgpu lets the sim catch up on very slow (software) renderers used in automated screenshots. */
const MAX_DT_DEFAULT = new URLSearchParams(location.search).has('slowgpu') ? 0.5 : 0.1;

type Mode = 'menu' | 'lobby' | 'play' | 'end';

/** Top-level orchestrator: renderer, input, session (solo/host/client), view, UI, audio. */
export class Game {
  gfx = new Gfx();
  view!: GameView;
  rig!: CameraRig;
  meta = new Meta();
  ui!: Ui;
  controls = newControls();
  kbm!: KeyboardMouse;
  pads!: Gamepads;
  touch!: TouchControls;
  session: Session | null = null;
  audio = new GameAudio();
  mode: Mode = 'menu';
  private settings: Settings;
  private last = performance.now();
  private frameMs: number[] = [];
  private fpsT = 0;
  private fps = 0;
  private aimTarget = -1;
  private bossName = '';
  private demo: LocalSession | null = null;
  private endShown = false;
  private touchMode = isMobile() || (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  private netModule: typeof import('../net/netSession') | null = null;

  constructor() {
    const s = this.meta.settings;
    this.settings = { sensitivity: s.sensitivity, invertY: s.invertY, aimAssist: s.aimAssist, touchLook: s.touchLook };
  }

  async start(): Promise<void> {
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    const q = this.meta.settings.quality;
    await this.gfx.init(canvas, q === 'auto' ? undefined : (q as QualityName));
    this.rig = new CameraRig(this.gfx.camera);
    this.view = new GameView(this.gfx, this.rig);
    this.ui = new Ui(this.meta, {
      playSolo: () => this.playSolo(),
      host: () => this.host(),
      join: (code) => this.join(code),
      startRun: () => this.startRun(),
      setReady: (r) => this.session?.setReady(r),
      setLoadout: (g) => this.session?.setLoadout(g),
      pick: (c) => this.session?.pick(c),
      vote: (c) => this.session?.vote(c),
      resume: () => this.resume(),
      pause: () => this.pause(),
      leave: () => this.leave(),
      share: () => this.share(),
      settingsChanged: () => this.applySettings(),
      ping: (k) => this.doPing(k as PingKind),
      fullscreen: () => this.fullscreen(),
    });
    this.ui.project = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(this.gfx.camera);
      return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, visible: v.z < 1 && v.z > -1 };
    };
    const uiRoot = document.getElementById('ui')!;
    this.kbm = new KeyboardMouse(canvas, this.controls, this.settings);
    this.pads = new Gamepads(this.controls, this.settings);
    this.touch = new TouchControls(uiRoot, this.controls, this.settings);
    // Esc releases pointer lock without a key event reaching us: treat losing the lock as pause
    this.kbm.onUnlock = () => {
      if (this.mode === 'play' && this.ui.current === 'hud' && this.controls.device === 'kbm') this.pause();
    };
    this.wireView();
    this.applySettings();
    // first gesture unlocks WebAudio (iOS)
    const unlock = () => this.audio.unlock(this.meta.settings);
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener('touchend', unlock, { capture: true });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3' || e.code === 'Backquote') {
        e.preventDefault();
        this.meta.settings.perf = !this.meta.settings.perf;
        this.meta.persist();
      }
      if (e.code === 'KeyM' && !(e.target as HTMLElement)?.closest?.('input')) {
        this.meta.settings.muted = !this.meta.settings.muted;
        this.meta.persist();
        this.applySettings();
        this.ui.toast(this.meta.settings.muted ? 'Muted' : 'Sound on');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'play' && this.session && !this.session.roomCode) this.pause();
    });

    // attract mode behind the title
    this.startDemo();
    const params = new URLSearchParams(location.search);
    const code = params.get('room');
    if (code) this.ui.show('join', code.toUpperCase());
    else this.ui.show('title');
    if (params.has('autoplay')) this.playSolo();
    this.gfx.renderer.setAnimationLoop(() => this.frame());
    // compile every actor/element material in the background so first casts don't hitch
    setTimeout(() => this.warmup(), 300);
    (window as unknown as { __game: Game }).__game = this;
  }

  private async warmup() {
    const { buildEnemy, buildMage } = await import('../render/actors');
    const { ENEMIES } = await import('../data/enemies');
    const g = new THREE.Group();
    g.position.set(0, -200, 0);
    const els: Element[] = ['fire', 'frost', 'storm', 'gale', 'stone', 'venom'];
    els.forEach((el, i) => {
      const m = buildMage(0x5ad1ff, i);
      m.setElement(el, els[(i + 1) % 6]);
      g.add(m.root);
    });
    for (const [k, d] of Object.entries(ENEMIES)) g.add(buildEnemy(d.shape, d.faction, k.length, d.radius, d.height).root);
    this.gfx.scene.add(g);
    try {
      await this.gfx.renderer.compileAsync(this.gfx.scene, this.gfx.camera);
    } catch (e) {
      console.warn('warmup failed', e);
    }
    this.gfx.scene.remove(g);
  }

  private wireView() {
    const v = this.view;
    v.onCombo = (name, pids) => {
      const s = this.session?.state;
      const names = pids.map((id) => {
        const p = s?.players.get(id);
        return { name: p?.name ?? '?', color: p?.color ?? 0xffffff };
      });
      if (this.mode === 'play') this.ui.combo(name, names);
      this.audio.combo(name);
    };
    v.onDamageNumber = (x, y, z, amt, el, crit, toPlayer) => {
      if (this.mode === 'play') this.ui.damage(x, y, z, amt, ELEMENT_INFO[el].css, crit, toPlayer);
    };
    v.onBoss = (name, phase) => {
      this.bossName = name;
      if (this.mode === 'play') this.ui.banner(phase === 1 ? name : `PHASE ${phase}`, phase === 1 ? 'Boss' : 'The rift tears wider', 'boss');
      this.audio.boss(phase);
    };
    v.onRoom = (idx, kind) => {
      if (this.mode !== 'play') return;
      this.ui.banner(kind === 'boss' ? 'Boss Chamber' : kind === 'elite' ? 'Elite Chamber' : `Chamber ${idx + 1}`, kind === 'combat' ? 'Clear the rift-spawn' : kind === 'elite' ? 'Something larger stirs' : 'Face the warden of the rift');
      if (this.ui.current === 'reward') this.ui.show('hud');
      this.audio.room(kind);
      // rift travel: white-out flash + FOV punch into the new chamber
      this.gfx.u.flash.value.set(0xe8deff);
      this.gfx.u.flashAmt.value = 1.2;
      this.rig.fovKick = 14;
      this.rig.yaw = 0;
      this.rig.pitch = -0.12;
    };
    v.onClear = () => {
      if (this.mode === 'play') this.ui.banner('Chamber Cleared', 'Choose your boons', 'clear');
      this.audio.clear();
    };
    v.onPickup = (pid, kind, value) => {
      if (pid === this.session?.localId && this.mode === 'play') this.ui.toast(kind === 'rune' ? `${value.toUpperCase()} rune: ${value === 'blink' ? 'dash teleports' : value === 'glide' ? 'long hover glide' : 'double jump rockets'}` : '+18 health');
    };
    v.onPing = (pid) => {
      const p = this.session?.state.players.get(pid);
      if (p && pid !== this.session?.localId && this.mode === 'play') this.ui.toast(`${p.name} pinged`);
    };
    v.onDown = (pid) => {
      const p = this.session?.state.players.get(pid);
      if (p && this.mode === 'play' && this.session && this.session.state.players.size > 1) this.ui.toast(`${p.name} is down! Stand close to revive.`);
    };
    v.onSfx = (ev) => this.audio.event(ev, this.session?.localId ?? '', this.listenerPos());
  }

  private listenerPos() {
    return this.gfx.camera.position;
  }

  // ---------------------------------------------------------------- modes
  private startDemo() {
    this.demo = new LocalSession('demo', 'Demo', ['fire', 'gale'], 4242);
    this.demo.world.startRun();
    this.session = this.demo;
    this.mode = 'menu';
  }

  playSolo() {
    this.leaveSession();
    const lo = this.meta.state.loadout;
    const s = new LocalSession('me', this.meta.state.name, [lo[0], lo[1]], undefined, this.meta.state.boons);
    this.session = s;
    s.world.startRun();
    this.enterPlay();
  }

  private async loadNet() {
    if (!this.netModule) this.netModule = await import('../net/netSession');
    return this.netModule;
  }

  async host() {
    this.leaveSession();
    this.ui.toast('Opening a rift…');
    try {
      const net = await this.loadNet();
      const lo = this.meta.state.loadout;
      this.session = await net.createHost(this.meta.state.name, [lo[0], lo[1]], this.meta.state.boons);
      this.session.onMessage = (m) => this.ui.toast(m);
      this.mode = 'lobby';
      this.ui.show('lobby');
    } catch (e) {
      console.error(e);
      this.ui.toast('Could not open a rift (network blocked?)');
      this.backToTitle();
    }
  }

  async join(code: string) {
    if (!/^[A-Z]{5}$/.test(code)) {
      this.ui.toast('Room codes are 5 letters');
      return;
    }
    this.leaveSession();
    this.ui.toast(`Connecting to ${code}…`);
    try {
      const net = await this.loadNet();
      const lo = this.meta.state.loadout;
      this.session = await net.joinRoom(code, this.meta.state.name, [lo[0], lo[1]]);
      this.session.onMessage = (m) => {
        this.ui.toast(m);
        if (m.startsWith('Host left')) this.backToTitle();
      };
      this.mode = 'lobby';
      this.ui.show('lobby');
    } catch (e) {
      console.error(e);
      this.ui.toast(`Could not reach room ${code}`);
      this.backToTitle();
    }
  }

  startRun() {
    if (!this.session?.isHost) return;
    this.session.startRun();
  }

  private enterPlay() {
    this.mode = 'play';
    this.endShown = false;
    this.bossName = '';
    this.ui.show('hud');
    this.touch.setVisible(this.touchMode);
    document.body.classList.toggle('touch', this.touchMode);
    if (!this.touchMode) this.kbm.requestLock();
    this.rig.yaw = 0;
    this.rig.pitch = -0.12;
  }

  pause() {
    if (this.mode !== 'play') return;
    if (this.session && !this.session.roomCode) this.session.paused = true;
    this.ui.show('pause');
    this.touch.setVisible(false);
    document.exitPointerLock?.();
  }

  resume() {
    if (this.session) this.session.paused = false;
    this.ui.show('hud');
    this.touch.setVisible(this.touchMode);
    if (!this.touchMode) this.kbm.requestLock();
  }

  leave() {
    if (this.mode === 'play' && this.session && !this.endShown) this.recordRun(false);
    this.backToTitle();
  }

  private leaveSession() {
    if (this.session && this.session !== this.demo) this.session.leave();
    this.session = null;
  }

  private backToTitle() {
    this.leaveSession();
    this.touch.setVisible(false);
    document.exitPointerLock?.();
    this.startDemo();
    this.ui.show('title');
  }

  private recordRun(won: boolean) {
    const s = this.session;
    if (!s) return;
    const p = s.state.players.get(s.localId);
    this.meta.recordRun({ won, room: s.state.run.roomIndex + 1, kills: p?.kills ?? 0, combos: p?.combos ?? 0, shards: s.state.run.shardsEarned, boss: won });
  }

  share() {
    const code = this.session?.roomCode;
    if (!code) return;
    const url = `${location.origin}${location.pathname}?room=${code}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) nav.share({ title: 'Riftcast', text: `Join my rift: ${code}`, url }).catch(() => {});
    else {
      navigator.clipboard?.writeText(url).then(
        () => this.ui.toast('Link copied!'),
        () => this.ui.toast(url),
      );
    }
  }

  fullscreen() {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else el.webkitRequestFullscreen?.();
    } catch {
      /* iOS Safari: use Add to Home Screen for fullscreen */
    }
  }

  applySettings() {
    const s = this.meta.settings;
    this.settings.sensitivity = s.sensitivity;
    this.settings.invertY = s.invertY;
    this.settings.aimAssist = s.aimAssist;
    this.settings.touchLook = s.touchLook;
    this.audio.setVolume(s.muted ? 0 : s.volume);
    const want = s.quality === 'auto' ? null : (s.quality as QualityName);
    if (want && want !== this.gfx.quality.name) {
      this.gfx.setQuality(want);
      this.ui.toast(`Quality: ${want} (particle pools resize on reload)`);
    }
  }

  doPing(kind: PingKind = 'here') {
    if (!this.session || this.mode !== 'play') return;
    const p = this.session.state.players.get(this.session.localId);
    if (!p) return;
    const a = this.rig.aim(this.session.state.room, [], 0, new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z));
    const k: PingKind = kind === 'here' && this.aimTarget >= 0 ? 'attack' : kind;
    this.session.ping(k, a.x, a.y, a.z);
  }

  // ---------------------------------------------------------------- frame
  private prevPing = 0;
  private prevPause = 0;
  private frame() {
    const now = performance.now();
    const rawDt = Math.min(this.maxDt, (now - this.last) / 1000);
    this.last = now;
    this.frameMs.push(rawDt * 1000);
    if (this.frameMs.length > 60) this.frameMs.shift();
    this.fpsT += rawDt;
    if (this.fpsT > 0.5) {
      const avg = this.frameMs.reduce((a, b) => a + b, 0) / this.frameMs.length;
      this.fps = 1000 / avg;
      this.fpsT = 0;
      this.gfx.adaptResolution(avg);
    }
    const session = this.session;
    if (!session) {
      this.gfx.render();
      return;
    }
    const c = this.controls;
    this.kbm.enabled = this.mode === 'play' && this.ui.current === 'hud';
    this.kbm.update();
    this.pads.update(rawDt);
    if (this.touch.active) this.touch.update(rawDt);
    if (c.pause !== this.prevPause) {
      this.prevPause = c.pause;
      if (this.mode === 'play') {
        if (this.ui.current === 'pause') this.resume();
        else if (this.ui.current === 'hud') this.pause();
      }
    }

    const s = session.state;
    const local = s.players.get(session.localId);
    const isPlay = this.mode === 'play';

    // camera look
    if (isPlay && this.ui.current === 'hud') this.rig.applyLook(c.lookDX, c.lookDY);
    c.lookDX = c.lookDY = 0;

    // hit-stop: presentation slows; solo sim freezes
    let fxDt = rawDt;
    if (this.view.hitstopMs > 0) {
      session.freeze(this.view.hitstopMs);
      this.view.hitstopMs -= rawDt * 1000;
      fxDt = rawDt * 0.08;
    }

    // build input
    const input = emptyInput();
    let pp = new THREE.Vector3();
    if (local) {
      // spectators (late joiners, fallen players) follow a living teammate
      let follow = local;
      if (local.state === 'spectating' || local.state === 'dead') {
        for (const q of s.players.values()) if (q.state === 'alive') {
          follow = q;
          break;
        }
      }
      const lp = this.view.playerRenderPos(follow.id) ?? follow.pos;
      pp = new THREE.Vector3(lp.x, lp.y, lp.z);
    }
    if (isPlay && local) {
      const yaw = this.rig.yaw;
      const fx = -Math.sin(yaw),
        fz = -Math.cos(yaw);
      const rx = Math.cos(yaw),
        rz = -Math.sin(yaw);
      const active = this.ui.current === 'hud' || this.ui.current === 'reward';
      const mx = active ? c.moveX : 0,
        my = active ? c.moveY : 0;
      input.mx = rx * mx + fx * my;
      input.mz = rz * mx + fz * my;
      input.yaw = yaw;
      input.pitch = this.rig.pitch;
      const targets: AimTarget[] = s.enemies
        .filter((e) => e.spawnT <= 0)
        .map((e) => {
          const rp = session.renderPos('e', e.id, { x: e.pos.x, y: e.pos.y, z: e.pos.z });
          return { id: e.id, x: rp.x, y: rp.y + e.height * 0.55, z: rp.z, r: Math.max(0.7, e.radius * 1.15) };
        });
      const cone = !this.settings.aimAssist ? 0 : c.device === 'touch' ? 11 : c.device === 'pad' ? 7 : 1.5;
      const aim = this.rig.aim(s.room, targets, cone, pp);
      this.aimTarget = aim.target;
      input.ax = aim.x;
      input.ay = aim.y;
      input.az = aim.z;
      if (active && this.ui.current === 'hud') {
        input.buttons = (c.primary ? BTN_PRIMARY : 0) | (c.heavy ? BTN_HEAVY : 0) | (c.jumpHeld ? BTN_JUMP : 0);
      }
      input.sig = c.sig & 255;
      input.dash = c.dash & 255;
      input.jump = c.jump & 255;
      input.swap = c.swap & 255;
      if (c.ping !== this.prevPing) {
        this.prevPing = c.ping;
        this.doPing(c.pingKind ?? 'here');
      }
    } else if (this.mode === 'menu' && session === this.demo) {
      this.driveDemo(input, rawDt, this.demo, 'demo', true);
    }
    if (isPlay && this.bot && local) this.driveDemo(input, rawDt, session, session.localId, false);

    const events: SimEvent[] = session.update(rawDt, input);
    this.view.handleEvents(events, s, session.localId);
    this.view.frame(fxDt, session);

    // camera
    if (isPlay && local) {
      this.rig.update(pp.x, pp.y, pp.z, rawDt, s.room);
    } else if (this.mode === 'menu' || this.mode === 'lobby') {
      const t = now / 1000;
      const r = 26;
      this.gfx.camera.position.set(Math.cos(t * 0.07) * r, 9 + Math.sin(t * 0.13) * 2, Math.sin(t * 0.07) * r);
      this.gfx.camera.lookAt(0, 1.5, 0);
      this.rig.yaw = Math.atan2(this.gfx.camera.position.x, this.gfx.camera.position.z);
    }

    this.view.update(fxDt, this.gfx.camera);

    // post uniforms decay
    const u = this.gfx.u;
    u.flashAmt.value *= Math.exp(-rawDt * 9);
    u.ca.value *= Math.exp(-rawDt * 5);
    u.hurt.value *= Math.exp(-rawDt * 2.5);
    u.desat.value = local && local.state === 'downed' ? 0.75 : u.desat.value * Math.exp(-rawDt * 3);

    // ui
    if (isPlay && local) {
      this.ui.updateHud(s, session.localId, { aimTarget: this.aimTarget >= 0, device: c.device, net: session.netStats(), bossName: this.bossName });
      if (this.touch.active) {
        const el = local.gauntlets[local.active];
        this.touch.setHud(el, local.cd[local.active], SPELL_TIMING[el].sigCd * local.stats.sigCooldown, local.charging ? local.charge : 0, local.dashCharges > 0);
      }
      const phase = s.run.phase;
      if (phase === 'reward') {
        if (this.ui.current === 'hud') {
          this.ui.show('reward');
          this.touch.setVisible(false);
          document.exitPointerLock?.();
        }
        this.ui.reward(s, session.localId);
      } else if (this.ui.current === 'reward') {
        this.ui.show('hud');
        this.touch.setVisible(this.touchMode);
      }
      if ((phase === 'victory' || phase === 'defeat') && !this.endShown) {
        this.endShown = true;
        this.recordRun(phase === 'victory');
        setTimeout(() => {
          this.touch.setVisible(false);
          document.exitPointerLock?.();
          this.ui.end(phase === 'victory', s, s.run.shardsEarned);
          this.audio.end(phase === 'victory');
        }, 1600);
      }
    }
    if (this.mode === 'lobby') {
      this.ui.lobby(session.roomCode, session.lobby(), session.isHost, session.localId);
      if (s.run.phase !== 'lobby') this.enterPlay();
    }
    this.ui.frame(rawDt);
    this.ui.pings(isPlay ? this.view.pingMarkers.map((m) => ({ ...m, name: s.players.get(m.pid)?.name ?? '' })) : []);
    this.audio.update(rawDt, s, this.mode === 'play');

    this.gfx.render();

    if (this.meta.settings.perf) {
      const ns = session.netStats();
      this.ui.perf(
        `${this.fps.toFixed(0)} fps · ${this.gfx.isWebGPU ? 'WebGPU' : 'WebGL2'} · ${this.gfx.quality.label} @${this.gfx.renderer.getPixelRatio().toFixed(2)}x\n` +
          `particles ${this.view.fx.particleCount} (${this.view.fx.add.gpu ? 'GPU' : 'CPU'}) · draws ${this.gfx.drawCalls}\n` +
          `enemies ${s.enemies.length} · zones ${s.zones.length} · proj ${this.view.fx.projs.size}` +
          (ns ? `\nnet: ${ns.peers} peers · rtt ${ns.rttMs.toFixed(0)}ms · in ${ns.inKbps.toFixed(1)}kb/s out ${ns.outKbps.toFixed(1)}kb/s · ${ns.snapshotsPerSec.toFixed(0)} snap/s · pend ${ns.pendingInputs}` : ''),
      );
    } else this.ui.perf(null);
  }

  /** Title-screen attract mode: a bot mage casting through a live room. */
  private demoT = 0;
  private bot = new URLSearchParams(location.search).has('bot');
  /** frame-time cap; automation lowers it to step slowly on software renderers */
  maxDt = MAX_DT_DEFAULT;
  private driveDemo(input: ReturnType<typeof emptyInput>, dt: number, sess: Session, pid: string, invuln: boolean) {
    const s = sess.state;
    const p = s.players.get(pid);
    if (!p) return;
    this.demoT += dt;
    if (p.state !== 'alive' || s.run.phase === 'defeat' || s.run.phase === 'victory') {
      if (invuln && this.demoT > 4) {
        this.startDemo();
        this.demoT = 0;
      }
      return;
    }
    if (invuln) p.hp = p.maxHp; // invulnerable attract-mode mage
    let e = null as (typeof s.enemies)[number] | null;
    let bd = Infinity;
    for (const q of s.enemies) {
      if (q.spawnT > 0) continue;
      const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
      if (d < bd) {
        bd = d;
        e = q;
      }
    }
    if (s.run.phase === 'reward') {
      const o = s.run.offers[pid];
      if (o && !s.run.picks[pid]) sess.pick(o[0]);
      if (s.run.teamOffers.length && !s.run.votes[pid]) sess.vote(s.run.teamOffers[0]);
    }
    if (!e) return;
    const dx = e.pos.x - p.pos.x,
      dz = e.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    input.yaw = Math.atan2(-dx, -dz);
    if (!invuln) {
      this.rig.yaw = input.yaw;
      this.rig.pitch = -0.2;
    }
    input.ax = e.pos.x;
    input.ay = e.pos.y + e.height * 0.5;
    input.az = e.pos.z;
    const strafe = Math.sin(this.demoT * 0.7);
    input.mx = (-dz / d) * strafe * 0.6 + (d > 12 ? dx / d : d < 6 ? -dx / d : 0) * 0.7;
    input.mz = (dx / d) * strafe * 0.6 + (d > 12 ? dz / d : d < 6 ? -dz / d : 0) * 0.7;
    const cyc = this.demoT % 6;
    input.buttons = cyc < 3 ? BTN_PRIMARY : cyc < 4.2 ? BTN_HEAVY : 0;
    input.sig = Math.floor(this.demoT / 9) & 255;
    input.swap = Math.floor(this.demoT / 6) & 255;
    input.dash = Math.floor(this.demoT / 3.3) & 255;
    input.jump = Math.floor(this.demoT / 4.1) & 255;
  }
}

export type { Element };
