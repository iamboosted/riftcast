import '../style.css';
import './gallery.css';
import * as THREE from 'three/webgpu';
import { Gfx } from '../render/gfx';
import { GameView } from '../render/view';
import type { CameraRig } from '../game/camera';
import { installMobileGuards } from '../core/mobile';
import { buildStations, enemyFromKind, type Category, type Station, type StationCtx } from './stations';
import type { Session, ViewState } from '../net/session';
import type { Element, Enemy, Player, SimEvent, Telegraph, Zone } from '../sim/types';
import { World } from '../sim/world';
import type { Room } from '../sim/room';
import { ELEMENT_INFO } from '../data/elements';
import { QUALITY_ORDER, type QualityName } from '../core/quality';
import { GameAudio } from '../audio/audio';
import type { V3 } from '../sim/vec';

installMobileGuards();

interface Live {
  st: Station;
  i: number;
  x: number;
  z: number;
  pid: string;
  t: number;
  zones: Zone[];
  dummies: Map<string, Enemy>;
  label: HTMLDivElement;
  active: boolean;
}

const COLS_DESKTOP = 4;
const DX = 22,
  DZ = 19;

async function main() {
  const gfx = new Gfx();
  const params = new URLSearchParams(location.search);
  const q = params.get('quality') as QualityName | null;
  await gfx.init(document.getElementById('c') as HTMLCanvasElement, q ?? undefined);
  const shake = { trauma: 0, fovKick: 0, shake(a: number) { this.trauma = Math.min(1, this.trauma + a); } };
  const view = new GameView(gfx, shake as unknown as CameraRig);
  const audio = new GameAudio();
  let sound = false;

  const stations = buildStations();
  const cols = window.innerWidth < 700 ? 2 : COLS_DESKTOP;
  const rows = Math.ceil(stations.length / cols);
  const offX = ((cols - 1) * DX) / 2,
    offZ = ((rows - 1) * DZ) / 2;

  // a single huge flat island holding every station
  const room: Room = {
    seed: 4242,
    index: 0,
    kind: 'combat',
    faction: 'cinder',
    boss: null,
    theme: Number(params.get('theme') ?? 0),
    platforms: [{ x: 0, y: 0, z: 0, r: Math.max(offZ, offX) + 30, top: 0, seed: 7 } as never],
    obstacles: [],
    spawns: [],
    playerSpawns: [],
    waves: [],
    runes: [],
    bound: Math.max(offZ, offX) + 30,
  };
  const w = new World(1);
  const players = new Map<string, Player>();
  const state: ViewState = { room, run: { ...w.run, phase: 'room', roomIndex: 0 }, players, enemies: [], zones: [], telegraphs: [], pickups: [], teamBoons: [], time: 0 };
  const session = {
    isHost: true,
    localId: 'viewer',
    roomCode: null,
    state,
    paused: false,
    update: () => [],
    renderPos: (kind: 'p' | 'e', id: string | number, out: V3) => {
      const src = kind === 'p' ? players.get(id as string)?.pos : state.enemies.find((e) => e.id === id)?.pos;
      if (src) Object.assign(out, src);
      return out;
    },
  } as unknown as Session;

  let nextId = 1000;
  const ui = document.getElementById('ui')!;
  const labelLayer = document.createElement('div');
  labelLayer.className = 'g-labels';
  ui.appendChild(labelLayer);

  const live: Live[] = stations.map((st, i) => {
    const x = (i % cols) * DX - offX,
      z = Math.floor(i / cols) * DZ - offZ;
    const pid = `g${i}`;
    const casts = st.cat === 'spell' || st.cat === 'combo' || st.name.startsWith('Dash') || st.name.startsWith('Revive');
    if (casts) {
      const p = w.addPlayer({ id: pid, name: st.name, gauntlets: [st.el ?? 'fire', st.el === 'gale' ? 'fire' : 'gale'], colorIdx: i % 4 });
      p.pos = { x: x - 4.6, y: 0, z };
      p.yaw = -Math.PI / 2;
      p.state = 'alive';
      players.set(pid, p);
    }
    const label = document.createElement('div');
    label.className = `g-label c-${st.cat}`;
    const c = st.el ? ELEMENT_INFO[st.el].css : '#d8c8ff';
    label.innerHTML = `<b style="color:${c}">${st.el ? ELEMENT_INFO[st.el].glyph + ' ' : ''}${st.name}</b><small>${st.sub}</small>`;
    labelLayer.appendChild(label);
    const L: Live = { st, i, x, z, pid, t: 0, zones: [], dummies: new Map(), label, active: false };
    label.addEventListener('click', () => focus(L, 20));
    return L;
  });

  const projTimers: { at: number; fn: () => void }[] = [];
  let clock = 0;

  const ctxFor = (L: Live): StationCtx => ({
    x: L.x,
    z: L.z,
    pid: L.pid,
    id: () => nextId++,
    emit: (e: SimEvent) => pending.push(e),
    zone: (tag, el, dx, dz, r, life, opts = {}) => {
      const zone: Zone = { id: nextId++, tag, element: el, pos: { x: L.x + dx, y: 0, z: L.z + dz }, vel: { x: 0, y: 0, z: 0 }, radius: r, life, maxLife: life, dps: 0, contributors: [L.pid], angle: 0, len: 0, reacted: [], tickT: 0, growth: 0, ...opts } as Zone;
      L.zones.push(zone);
      state.zones.push(zone);
      return zone;
    },
    clearZones: () => {
      state.zones = state.zones.filter((z) => !L.zones.includes(z));
      L.zones = [];
    },
    tele: (shape, dx, dz, o) => {
      const t: Telegraph = { id: nextId++, shape, x: L.x + dx, y: 0, z: L.z + dz, r: 2, r2: 0, angle: 0, len: 0, width: 0, t: 0, dur: 1, dmg: 0, element: 'fire', owner: 0, knock: 0, ...o };
      state.telegraphs.push(t);
      return t;
    },
    shoot: (el, spell, from, to, speed, o = {}) => {
      const id = nextId++;
      const fx = L.x + from[0],
        fy = from[1],
        fz = L.z + from[2];
      const tx = L.x + to[0],
        ty = to[1],
        tz = L.z + to[2];
      const dxz = Math.hypot(tx - fx, tz - fz);
      const T = Math.max(0.05, Math.hypot(tx - fx, ty - fy, tz - fz) / speed);
      const g = o.g ?? 0;
      const vx = (tx - fx) / T,
        vz = (tz - fz) / T,
        vy = (ty - fy + 0.5 * g * T * T) / T;
      void dxz;
      pending.push({ t: 'proj', id, el, sp: spell, x: fx, y: fy, z: fz, vx, vy, vz, g, r: o.r ?? 0.3, team: o.enemy ? 'enemy' : 'player', ck: '', life: T + 1 });
      projTimers.push({
        at: clock + T,
        fn: () => {
          pending.push({ t: 'projEnd', id, x: tx, y: ty, z: tz, hit: 1 });
          for (const d of L.dummies.values()) if (Math.hypot(d.pos.x - tx, d.pos.z - tz) < 2) d.hitFlash = 1;
          o.boom?.();
        },
      });
    },
    dummy: (dx, dz, kind = 'husk') => {
      const key = `${dx},${dz}`;
      let d = L.dummies.get(key);
      if (!d) {
        d = enemyFromKind(kind, nextId++, L.x + dx, L.z + dz);
        L.dummies.set(key, d);
        state.enemies.push(d);
      }
      return d;
    },
    charge: (el: Element, on: boolean, c = 0) => {
      const p = players.get(L.pid);
      if (!p) return;
      p.gauntlets[0] = el;
      p.charging = on;
      p.charge = c;
    },
  });

  const ctxs = live.map(ctxFor);
  live.forEach((L, i) => L.st.setup?.(ctxs[i]));
  let pending: SimEvent[] = [];

  // ---------------------------------------------------------------- camera
  const cam = gfx.camera;
  let tx = live[0].x,
    tz = live[0].z,
    dist = cols === 2 ? 22 : 24;
  let goalX = tx,
    goalZ = tz,
    goalD = dist;
  function focus(L: Live, d: number) {
    goalX = L.x;
    goalZ = L.z;
    goalD = d;
  }
  const canvas = gfx.canvas;
  let drag: { x: number; y: number; id: number } | null = null;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    audio.unlock();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const k = (dist / window.innerHeight) * 1.4;
    goalX -= (e.clientX - drag.x) * k;
    goalZ -= (e.clientY - drag.y) * k;
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('wheel', (e) => (goalD = Math.max(10, Math.min(110, goalD * (1 + Math.sign(e.deltaY) * 0.12)))), { passive: true });
  window.addEventListener('keydown', (e) => {
    const s = 6;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') goalZ -= s;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') goalZ += s;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') goalX -= s;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') goalX += s;
    if (e.code === 'Space') toggleSlow();
  });

  // ---------------------------------------------------------------- toolbar
  const bar = document.createElement('div');
  bar.className = 'g-bar screen-ish';
  const cats: [Category | 'all', string][] = [
    ['spell', 'Spells'],
    ['combo', 'Combos'],
    ['impact', 'Impacts'],
    ['misc', 'Misc'],
  ];
  bar.innerHTML = `<div class="g-title"><b>RIFTCAST</b> VFX Gallery <small>an iAmBoosted game</small></div>
    <div class="g-row">${cats.map(([c, n]) => `<button class="btn sm" data-cat="${c}">${n}</button>`).join('')}
    <button class="btn sm" data-z="out">−</button><button class="btn sm" data-z="in">+</button>
    <button class="btn sm" id="g-slow">Slow-mo: Off</button>
    <button class="btn sm" id="g-snd">Sound: Off</button>
    <select id="g-q" class="btn sm">${QUALITY_ORDER.map((n) => `<option value="${n}" ${n === gfx.quality.name ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <a class="btn sm ghost" href="../">Play ▶</a></div>
    <div class="g-stats" id="g-stats"></div>`;
  ui.appendChild(bar);
  let timeScale = 1;
  const slowBtn = bar.querySelector('#g-slow') as HTMLButtonElement;
  function toggleSlow() {
    timeScale = timeScale === 1 ? 0.25 : 1;
    slowBtn.textContent = `Slow-mo: ${timeScale === 1 ? 'Off' : '¼×'}`;
    slowBtn.classList.toggle('on', timeScale !== 1);
  }
  slowBtn.addEventListener('click', toggleSlow);
  const sndBtn = bar.querySelector('#g-snd') as HTMLButtonElement;
  sndBtn.addEventListener('click', () => {
    sound = !sound;
    audio.unlock();
    audio.setVolume(sound ? 0.7 : 0);
    sndBtn.textContent = `Sound: ${sound ? 'On' : 'Off'}`;
  });
  audio.setVolume(0);
  (bar.querySelector('#g-q') as HTMLSelectElement).addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    location.search = `?quality=${v}`;
  });
  bar.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = (b as HTMLElement).dataset.cat as Category;
      const L = live.find((s) => s.st.cat === c);
      if (L) focus(L, goalD);
    }),
  );
  bar.querySelectorAll('[data-z]').forEach((b) =>
    b.addEventListener('click', () => {
      goalD = Math.max(10, Math.min(110, goalD * ((b as HTMLElement).dataset.z === 'in' ? 0.75 : 1.33)));
    }),
  );
  view.onSfx = (ev) => sound && audio.event(ev, '', cam.position);
  view.onCombo = (name, _p, x, y, z) => floatText(name, x, y + 3, z);
  const stats = bar.querySelector('#g-stats') as HTMLDivElement;

  const floats: { el: HTMLDivElement; x: number; y: number; z: number; t: number }[] = [];
  function floatText(text: string, x: number, y: number, z: number) {
    const d = document.createElement('div');
    d.className = 'g-float';
    d.textContent = text;
    labelLayer.appendChild(d);
    floats.push({ el: d, x, y, z, t: 0 });
  }

  document.getElementById('boot')?.remove();
  let last = performance.now();
  let fpsAcc = 0,
    fpsN = 0,
    fps = 0;
  const v = new THREE.Vector3();

  gfx.renderer.setAnimationLoop(() => {
    const now = performance.now();
    const raw = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAcc += raw;
    fpsN++;
    if (fpsAcc > 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
      gfx.adaptResolution(1000 / fps);
    }
    let dt = raw * timeScale;
    if (view.hitstopMs > 0) {
      view.hitstopMs -= raw * 1000;
      dt *= 0.1;
    }
    clock += dt;
    state.time += dt;
    // camera
    const k = 1 - Math.exp(-raw * 6);
    tx += (goalX - tx) * k;
    tz += (goalZ - tz) * k;
    dist += (goalD - dist) * k;
    cam.position.set(tx, dist * 0.72, tz + dist * 0.62);
    cam.lookAt(tx, 0, tz - 1);
    shake.trauma = Math.max(0, shake.trauma - raw * 1.6);
    const s = shake.trauma * shake.trauma;
    if (s > 0) {
      cam.position.x += Math.sin(now * 0.05) * 0.25 * s;
      cam.position.y += Math.sin(now * 0.07) * 0.25 * s;
    }
    // stations
    const reach = dist * 1.25 + 14;
    let activeCount = 0;
    live.forEach((L, i) => {
      L.active = Math.hypot(L.x - tx, L.z - tz) < reach;
      if (!L.active) return;
      activeCount++;
      const prev = L.t;
      L.t += dt;
      const p = L.st.period;
      const a = prev % p,
        b = L.t % p;
      for (const [at, fn] of L.st.script) {
        const hit = b >= a ? at > a && at <= b : at > a || at <= b;
        if (hit) fn(ctxs[i]);
      }
      L.st.tick?.(ctxs[i], b, dt);
    });
    for (let i = projTimers.length - 1; i >= 0; i--)
      if (projTimers[i].at <= clock) {
        const t = projTimers.splice(i, 1)[0];
        t.fn();
      }
    // zones / telegraphs / dummies
    for (const z of state.zones) {
      z.life -= dt;
      z.pos.x += z.vel.x * dt;
      z.pos.z += z.vel.z * dt;
      if (z.growth) z.radius = Math.min(9, z.radius + z.growth * dt);
    }
    state.zones = state.zones.filter((z) => z.life > 0);
    for (const L of live) L.zones = L.zones.filter((z) => z.life > 0);
    for (const t of state.telegraphs) t.t += dt;
    for (const t of state.telegraphs.filter((q) => q.t >= q.dur)) pending.push({ t: 'tele', id: t.id, x: t.x, z: t.z, el: t.element, shape: t.shape });
    state.telegraphs = state.telegraphs.filter((t) => t.t < t.dur);
    for (const e of state.enemies) {
      e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
      e.spawnT = Math.max(0, e.spawnT - dt);
      if (e.st.frozen > 0 && e.kind !== 'kiln') e.st.frozen = Math.max(0.01, e.st.frozen);
    }
    // kills remove the dummy briefly
    const evs = pending;
    pending = [];
    for (const ev of evs)
      if (ev.t === 'kill') {
        state.enemies = state.enemies.filter((e) => e.id !== ev.id);
        for (const L of live) for (const [k2, d] of L.dummies) if (d.id === ev.id) L.dummies.delete(k2);
      }
    view.handleEvents(evs, state, 'viewer');
    view.frame(dt, session);
    view.update(dt, cam);
    const u = gfx.u;
    u.flashAmt.value *= Math.exp(-raw * 9);
    u.ca.value *= Math.exp(-raw * 5);
    gfx.render();

    // labels
    const W = window.innerWidth,
      Hh = window.innerHeight;
    for (const L of live) {
      v.set(L.x, 0, L.z + 5.5).project(cam);
      const vis = v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
      L.label.style.display = vis ? 'block' : 'none';
      if (vis) L.label.style.transform = `translate(${(v.x * 0.5 + 0.5) * W}px, ${(-v.y * 0.5 + 0.5) * Hh}px) translate(-50%, 0)`;
      L.label.classList.toggle('dim', !L.active);
    }
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += raw;
      v.set(f.x, f.y + f.t * 1.5, f.z).project(cam);
      f.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * W}px, ${(-v.y * 0.5 + 0.5) * Hh}px) translate(-50%,-50%) scale(${1 + Math.max(0, 0.3 - f.t)})`;
      f.el.style.opacity = `${Math.max(0, 1.4 - f.t)}`;
      if (f.t > 1.4) {
        f.el.remove();
        floats.splice(i, 1);
      }
    }
    stats.textContent = `${fps.toFixed(0)} fps · ${gfx.isWebGPU ? 'WebGPU' : 'WebGL2'} · ${gfx.quality.label} · particles ${view.fx.particleCount.toLocaleString()} (${view.fx.add.gpu ? 'GPU compute' : 'CPU'}) · draws ${gfx.drawCalls} · ${activeCount}/${live.length} stations live`;
  });
  (window as unknown as { __gallery: unknown }).__gallery = { gfx, view, live, focus: (i: number, d = 20) => focus(live[i], d), setSlow: (s: number) => (timeScale = s) };
}

main().catch((e) => {
  console.error(e);
  const b = document.getElementById('boot');
  if (b) b.innerHTML = `<b>Gallery failed to start</b><small>${String(e?.message ?? e)}</small>`;
});
