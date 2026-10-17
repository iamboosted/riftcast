import { ELEMENT_INFO } from '../data/elements';
import { BOONS, BOON_BY_ID } from '../data/boons';
import { ELEMENTS, type Element, type Player } from '../sim/types';
import type { Meta } from '../game/meta';
import { BOON_COST, GAUNTLET_COST } from '../game/meta';
import type { LobbyPeer, NetStats, ViewState } from '../net/session';
import { SPELL_TIMING } from '../sim/spells';
import { ENEMIES } from '../data/enemies';
import { QUALITY_ORDER, QUALITY } from '../core/quality';
import { ROOM_SEQUENCE } from '../sim/room';
import { AFFIX_INFO } from '../sim/affixes';
import { COMBO_RULES } from '../sim/comboTable';

export interface UiActions {
  playSolo(): void;
  host(): void;
  join(code: string): void;
  startRun(): void;
  setReady(r: boolean): void;
  setLoadout(g: [Element, Element]): void;
  pick(choice: string): void;
  vote(choice: string): void;
  resume(): void;
  pause(): void;
  leave(): void;
  share(): void;
  settingsChanged(): void;
  ping(kind: string): void;
  fullscreen(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

function elChip(el: Element, small = false): string {
  const i = ELEMENT_INFO[el];
  return `<span class="elchip${small ? ' sm' : ''}" style="--c:${i.css}">${i.glyph}<b>${i.name}</b></span>`;
}

export class Ui {
  root: HTMLElement;
  private screen: HTMLDivElement;
  private hud: HTMLDivElement;
  private dmgLayer: HTMLDivElement;
  private callouts: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private perfEl: HTMLDivElement;
  private crosshair: HTMLDivElement;
  current = '';
  private lastHud = '';
  private dmgPool: HTMLDivElement[] = [];
  private dmgActive: { el: HTMLDivElement; x: number; y: number; z: number; t: number }[] = [];
  project: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean } = () => ({ x: 0, y: 0, visible: false });
  private rewardKey = '';
  private lobbyKey = '';

  constructor(private meta: Meta, private actions: UiActions) {
    this.root = document.getElementById('ui')!;
    this.hud = this.div('hud');
    this.dmgLayer = this.div('dmg-layer');
    this.callouts = this.div('callouts');
    this.crosshair = this.div('crosshair');
    this.crosshair.innerHTML = '<i></i><i></i><i></i><i></i><b></b>';
    this.screen = this.div('screen');
    this.toastEl = this.div('toast');
    this.perfEl = this.div('perf');
    this.root.addEventListener('click', (e) => this.onClick(e));
    for (let i = 0; i < 40; i++) {
      const d = document.createElement('div');
      d.className = 'dmg';
      d.style.display = 'none';
      this.dmgLayer.appendChild(d);
      this.dmgPool.push(d);
    }
  }

  private div(cls: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    this.root.appendChild(d);
    return d;
  }

  private onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!t) return;
    const a = t.dataset.a!;
    const v = t.dataset.v ?? '';
    const A = this.actions;
    switch (a) {
      case 'solo':
        A.playSolo();
        break;
      case 'host':
        A.host();
        break;
      case 'join-screen':
        this.show('join');
        break;
      case 'join': {
        const inp = this.screen.querySelector('input') as HTMLInputElement;
        A.join((inp?.value ?? '').trim().toUpperCase());
        break;
      }
      case 'title':
        this.show('title');
        break;
      case 'loadout':
        this.backTo = this.current === 'lobby' ? 'lobby' : 'title';
        this.show('loadout');
        break;
      case 'back':
        this.show(this.backTo);
        break;
      case 'unlocks':
        this.show('unlocks');
        break;
      case 'codex':
        this.backTo = this.current === 'pause' ? 'pause' : 'title';
        this.show('codex');
        break;
      case 'settings':
        this.show('settings');
        break;
      case 'gauntlet': {
        const el = v as Element;
        const lo = [...this.meta.state.loadout] as [Element, Element];
        if (lo.includes(el)) break;
        lo[1] = lo[0];
        lo[0] = el;
        this.meta.state.loadout = lo;
        this.meta.persist();
        A.setLoadout(lo);
        this.refresh();
        break;
      }
      case 'buy-g':
        if (this.meta.buyGauntlet(v as Element)) this.toast(`${ELEMENT_INFO[v as Element].gauntlet} unlocked!`);
        this.refresh();
        break;
      case 'buy-b':
        if (this.meta.buyBoon(v)) this.toast(`${BOON_BY_ID[v].name} unlocked!`);
        this.refresh();
        break;
      case 'start':
        A.startRun();
        break;
      case 'ready':
        A.setReady(v === '1');
        break;
      case 'pick':
        A.pick(v);
        break;
      case 'vote':
        A.vote(v);
        break;
      case 'resume':
        A.resume();
        break;
      case 'pause':
        A.pause();
        break;
      case 'leave':
        A.leave();
        break;
      case 'share':
        A.share();
        break;
      case 'fs':
        A.fullscreen();
        break;
      case 'ping':
        A.ping(v);
        break;
      case 'set': {
        const s = this.meta.settings as unknown as Record<string, unknown>;
        const [k, val] = v.split(':');
        if (val === 'toggle') s[k] = !s[k];
        else if (k === 'quality') s[k] = val;
        else s[k] = Math.round(Math.max(0.3, Math.min(3, (s[k] as number) + parseFloat(val))) * 10) / 10;
        this.meta.persist();
        A.settingsChanged();
        this.refresh();
        break;
      }
      case 'name': {
        const n = prompt('Your name', this.meta.state.name);
        if (n) {
          this.meta.state.name = n.slice(0, 16);
          this.meta.persist();
          this.refresh();
        }
        break;
      }
    }
  }

  private screenArgs: unknown = null;
  private backTo = 'title';
  show(name: string, args?: unknown) {
    this.current = name;
    this.screenArgs = args ?? null;
    this.rewardKey = '';
    this.lobbyKey = '';
    this.refresh();
  }

  refresh() {
    const n = this.current;
    const m = this.meta.state;
    this.screen.className = `screen s-${n}`;
    this.hud.style.display = n === 'hud' || n === 'reward' ? 'block' : 'none';
    this.crosshair.style.display = n === 'hud' ? 'block' : 'none';
    switch (n) {
      case 'title':
        this.screen.innerHTML = `
        <div class="title-wrap">
          <div class="logo"><span>RIFT</span><span>CAST</span></div>
          <div class="byline">an <b>iAmBoosted</b> game</div>
          <div class="tag">Co-op elemental spellcraft · 1–4 mages · combine elements, break the rift</div>
          <div class="menu">
            <button class="btn primary" data-a="solo">▶ Play Solo</button>
            <button class="btn" data-a="host">✦ Host Co-op</button>
            <button class="btn" data-a="join-screen">⇢ Join with Code</button>
            <div class="row">
              <button class="btn sm" data-a="loadout">Gauntlets</button>
              <button class="btn sm" data-a="unlocks">Unlocks <em>${m.shards}◈</em></button>
              <button class="btn sm" data-a="settings">Settings</button>
              <button class="btn sm" data-a="codex">Codex</button>
            </div>
            <div class="row">
              <a class="btn sm ghost" href="./vfx-gallery/">VFX Gallery</a>
              <button class="btn sm ghost" data-a="name">Name: ${esc(m.name)}</button>
            </div>
          </div>
          <div class="loadout-mini">${m.loadout.map((e) => elChip(e)).join('')}</div>
          <a class="credit" href="https://github.com/iamboosted" target="_blank" rel="noopener">github.com/iamboosted</a>
        </div>`;
        break;
      case 'join':
        this.screen.innerHTML = `<div class="panel"><h2>Join a Rift</h2>
          <p>Enter the 5-letter room code your friend shared.</p>
          <input class="code" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCDE" value="${esc((this.screenArgs as string) ?? '')}"/>
          <div class="row"><button class="btn primary" data-a="join">Join</button><button class="btn" data-a="title">Back</button></div></div>`;
        break;
      case 'loadout':
        this.screen.innerHTML = `<div class="panel wide"><h2>Choose 2 Gauntlets</h2><p>Tap to equip (newest becomes primary). Swap between them mid-fight.</p>
          <div class="grid3">${ELEMENTS.map((el) => {
            const i = ELEMENT_INFO[el];
            const owned = m.gauntlets.includes(el);
            const eq = m.loadout.indexOf(el);
            return `<button class="card el ${eq >= 0 ? 'on' : ''} ${owned ? '' : 'locked'}" style="--c:${i.css}" ${owned ? `data-a="gauntlet" data-v="${el}"` : ''}>
              <div class="glyph">${i.glyph}</div><h3>${i.gauntlet}</h3><div class="sub">${i.name} · ${i.motto}</div>
              <ul><li><b>${i.spells.primary}</b> ${i.spellDesc.primary}</li><li><b>${i.spells.heavy}</b> ${i.spellDesc.heavy}</li><li><b>${i.spells.signature}</b> ${i.spellDesc.signature}</li></ul>
              ${owned ? (eq >= 0 ? `<div class="badge">${eq === 0 ? 'PRIMARY' : 'SECOND'}</div>` : '') : `<div class="badge lock">LOCKED · ${GAUNTLET_COST}◈</div>`}
            </button>`;
          }).join('')}</div>
          <div class="row"><button class="btn" data-a="back">Done</button></div></div>`;
        break;
      case 'unlocks': {
        const lockedG = ELEMENTS.filter((e) => !m.gauntlets.includes(e));
        const lockedB = BOONS.filter((b) => b.locked);
        this.screen.innerHTML = `<div class="panel wide"><h2>Unlocks <em>${m.shards}◈ shards</em></h2>
          <p>Earn shards from every run. Clearing rooms, elites and bosses pays more.</p>
          <h4>Gauntlets</h4><div class="grid3">${lockedG.length ? lockedG.map((el) => `<button class="card el locked" style="--c:${ELEMENT_INFO[el].css}" data-a="buy-g" data-v="${el}"><div class="glyph">${ELEMENT_INFO[el].glyph}</div><h3>${ELEMENT_INFO[el].gauntlet}</h3><div class="badge ${m.shards >= GAUNTLET_COST ? '' : 'lock'}">Unlock · ${GAUNTLET_COST}◈</div></button>`).join('') : '<p>All gauntlets unlocked.</p>'}</div>
          <h4>Rare Boons</h4><div class="grid3">${lockedB.map((b) => {
            const own = m.boons.includes(b.id);
            return `<button class="card boon ${own ? 'on' : 'locked'}" ${own ? '' : `data-a="buy-b" data-v="${b.id}"`}><div class="glyph">${b.glyph}</div><h3>${b.name}</h3><div class="sub">${b.desc}</div><div class="badge ${own ? '' : 'lock'}">${own ? 'OWNED' : `Unlock · ${BOON_COST}◈`}</div></button>`;
          }).join('')}</div>
          <h4>Record</h4><p class="stats">Runs ${m.stats.runs} · Wins ${m.stats.wins} · Best room ${m.stats.bestRoom} · Kills ${m.stats.kills} · Combos ${m.stats.combos} · Bosses ${m.stats.bossKills}</p>
          <div class="row"><button class="btn" data-a="title">Back</button></div></div>`;
        break;
      }
      case 'settings':
      case 'pause': {
        const s = this.meta.settings;
        const tog = (k: string, label: string, on: boolean) => `<button class="btn sm ${on ? 'on' : ''}" data-a="set" data-v="${k}:toggle">${label}: ${on ? 'On' : 'Off'}</button>`;
        this.screen.innerHTML = `<div class="panel"><h2>${n === 'pause' ? 'Paused' : 'Settings'}</h2>
          <h4>Graphics</h4><div class="row wrap">${['auto', ...QUALITY_ORDER].map((q) => `<button class="btn sm ${s.quality === q ? 'on' : ''}" data-a="set" data-v="quality:${q}">${q === 'auto' ? 'Auto' : QUALITY[q as keyof typeof QUALITY].label}</button>`).join('')}</div>
          <h4>Audio</h4><div class="row wrap">${tog('muted', 'Mute', s.muted)}<button class="btn sm" data-a="set" data-v="volume:-0.1">Vol −</button><span class="val">${Math.round(s.volume * 100)}%</span><button class="btn sm" data-a="set" data-v="volume:0.1">Vol +</button></div>
          <h4>Controls</h4><div class="row wrap"><button class="btn sm" data-a="set" data-v="sensitivity:-0.1">Mouse/Pad −</button><span class="val">${s.sensitivity.toFixed(1)}</span><button class="btn sm" data-a="set" data-v="sensitivity:0.1">+</button>
          <button class="btn sm" data-a="set" data-v="touchLook:-0.1">Touch aim −</button><span class="val">${s.touchLook.toFixed(1)}</span><button class="btn sm" data-a="set" data-v="touchLook:0.1">+</button></div>
          <div class="row wrap">${tog('invertY', 'Invert Y', s.invertY)}${tog('aimAssist', 'Aim assist', s.aimAssist)}${tog('perf', 'Perf overlay', s.perf)}${tog('reduceFlashes', 'Reduce flashes', s.reduceFlashes)}<button class="btn sm" data-a="fs">Fullscreen</button></div>
          <div class="row">${n === 'pause' ? '<button class="btn primary" data-a="resume">Resume</button><button class="btn" data-a="codex">Codex</button><button class="btn danger" data-a="leave">Leave Run</button>' : '<button class="btn" data-a="title">Back</button>'}</div>
          ${n === 'pause' ? '<p class="hint">Desktop: WASD move · Mouse aim · LMB cast · RMB charge · Q signature · Shift dash · Space jump/hover · R swap · G ping (H help, C combo) · M mute · F3 perf</p>' : ''}
          </div>`;
        break;
      }
      case 'hud':
        this.screen.innerHTML = `<button class="pausebtn" data-a="pause" aria-label="Pause">❚❚</button>`;
        break;
      case 'codex': {
        const rules = COMBO_RULES.filter((r) => r.desc);
        const icon = (r: (typeof rules)[number]) => {
          const els = [r.a.element, r.b.element, r.effect.element].flat().filter((e): e is string => typeof e === 'string' && e in ELEMENT_INFO) as Element[];
          return [...new Set(els)].map((e) => `<span style="color:${ELEMENT_INFO[e].css}">${ELEMENT_INFO[e].glyph}</span>`).join('');
        };
        this.screen.innerHTML = `<div class="panel wide"><h2>Combo Codex</h2>
          <p>Elements react through the world, no matter who cast them. Every mage involved gets the credit.</p>
          <div class="codex">${rules.map((r) => `<div class="cx ${r.silent ? 'silent' : ''}"><b>${icon(r)} ${esc(r.name || 'Interaction')}</b><span>${esc(r.desc!)}</span></div>`).join('')}</div>
          <h4>Statuses</h4><p>Burn (DoT) · Chill → Frozen at full · Shock (micro-stun) · Wet (+40% Storm) · Poison (stacking DoT) · Blind (wanders, can't attack) · Stagger (interrupts wind-ups)</p>
          <h4>Elite affixes</h4><p>${Object.values(AFFIX_INFO).map((a) => `<b>${a.name}</b>: ${a.desc}`).join(' · ')}</p>
          <div class="row"><button class="btn" data-a="back">Back</button></div></div>`;
        break;
      }
      case 'reward':
      case 'lobby':
      case 'end':
        // filled by update functions
        break;
      default:
        this.screen.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------- lobby
  lobby(code: string | null, peers: LobbyPeer[], isHost: boolean, localId: string, waitingMsg = '') {
    if (this.current !== 'lobby') return;
    const key = JSON.stringify([code, peers, isHost, waitingMsg]);
    if (key === this.lobbyKey) return;
    this.lobbyKey = key;
    const me = peers.find((p) => p.id === localId);
    const allReady = peers.length > 0 && peers.every((p) => p.ready || p.id === localId);
    this.screen.innerHTML = `<div class="panel wide"><h2>Rift Lobby</h2>
      ${code ? `<div class="roomcode"><span>Room code</span><b>${code}</b><button class="btn sm" data-a="share">Share Link</button></div>` : ''}
      ${waitingMsg ? `<p class="hint">${esc(waitingMsg)}</p>` : ''}
      <div class="peers">${peers.map((p) => `<div class="peer" style="--c:${hex(p.color)}"><i></i><b>${esc(p.name)}${p.id === localId ? ' (you)' : ''}</b>${p.gauntlets.map((g) => elChip(g, true)).join('')}<span class="${p.ready ? 'ok' : ''}">${p.ready ? 'READY' : '…'}</span></div>`).join('')}</div>
      <p>Pick gauntlets, then ready up. ${peers.length < 4 ? 'Friends can drop in between rooms, too.' : ''}</p>
      <div class="row">
        <button class="btn sm" data-a="loadout">Gauntlets</button>
        ${isHost ? `<button class="btn primary ${allReady ? '' : 'dim'}" data-a="start">Start Run${allReady ? '' : ' (not all ready)'}</button>` : `<button class="btn primary" data-a="ready" data-v="${me?.ready ? '0' : '1'}">${me?.ready ? 'Unready' : 'Ready'}</button>`}
        <button class="btn" data-a="leave">Leave</button>
      </div></div>`;
  }

  // ---------------------------------------------------------------- HUD
  private targetEl: HTMLDivElement | null = null;
  updateHud(s: ViewState, localId: string, extra: { aimTarget: boolean; device: string; net: NetStats | null; bossName: string; target?: { name: string; affix: string; hp: number; shield: number; elite: boolean } | null }) {
    const p = s.players.get(localId);
    if (!p) return;
    const el = p.gauntlets[p.active];
    const el2 = p.gauntlets[1 - p.active];
    const t = SPELL_TIMING[el];
    const cd = p.cd[p.active];
    const sigMax = t.sigCd * p.stats.sigCooldown;
    const boss = s.enemies.find((e) => e.boss);
    const team = [...s.players.values()].filter((q) => q.id !== localId);
    const roomKind = ROOM_SEQUENCE[Math.min(s.run.roomIndex, ROOM_SEQUENCE.length - 1)] ?? 'combat';
    const hpPct = Math.max(0, (p.hp / p.maxHp) * 100);
    const parts = [
      `<div class="hud-top"><div class="roomtag">${s.run.phase === 'lobby' ? 'Lobby' : `Room ${s.run.roomIndex + 1}/${s.run.totalRooms} · ${roomKind.toUpperCase()}`}${s.run.phase === 'room' && roomKind !== 'boss' ? ` · Wave ${Math.min(s.run.waveIdx, s.room.waves.length)}/${s.room.waves.length}` : ''}</div>`,
      team.length ? `<div class="team">${team.map((q) => this.teamRow(q)).join('')}</div>` : '',
      `</div>`,
      boss ? `<div class="bossbar"><b>${esc(extra.bossName || ENEMIES[boss.kind].name)}</b><span class="ph">PHASE ${boss.phase}</span><div class="bar"><i style="width:${(boss.hp / boss.maxHp) * 100}%"></i></div></div>` : '',
      `<div class="hud-bottom">
        <div class="vitals">
          <div class="hpbar ${hpPct < 30 ? 'low' : ''}"><i style="width:${hpPct}%"></i><span>${Math.ceil(p.hp)} / ${p.maxHp}</span></div>
          <div class="pips">${Array.from({ length: p.stats.dashCharges }, (_, i) => `<i class="${i < p.dashCharges ? 'on' : ''}"></i>`).join('')}${p.rune !== 'none' ? `<span class="rune">${p.rune.toUpperCase()} RUNE</span>` : ''}${p.secondWind > 0 && s.players.size === 1 ? '<span class="rune sw">♥ 2ND WIND</span>' : ''}</div>
        </div>
        <div class="gaunt">
          <div class="slot active" style="--c:${ELEMENT_INFO[el].css}"><div class="g">${ELEMENT_INFO[el].glyph}</div><div class="nm">${ELEMENT_INFO[el].name}</div>
            <div class="abil"><span class="${cd.heavy > 0 ? 'cd' : ''}">${ELEMENT_INFO[el].spells.heavy}</span><span class="${cd.signature > 0 ? 'cd' : ''}">${ELEMENT_INFO[el].spells.signature}${cd.signature > 0 ? ` ${Math.ceil(cd.signature)}s` : ''}</span></div>
            <div class="sigbar"><i style="width:${(1 - cd.signature / sigMax) * 100}%"></i></div>
            ${p.charging ? `<div class="charge"><i style="width:${p.charge * 100}%"></i></div>` : ''}
          </div>
          <div class="slot" style="--c:${ELEMENT_INFO[el2].css}"><div class="g">${ELEMENT_INFO[el2].glyph}</div><div class="nm">${ELEMENT_INFO[el2].name}</div><div class="swaphint">${extra.device === 'touch' ? '⇄' : extra.device === 'pad' ? 'LB' : 'R'}</div></div>
        </div>
      </div>`,
      p.state === 'downed' ? `<div class="downed">DOWNED · ${team.some((q) => q.state === 'alive') ? `ally can revive · ${Math.ceil(p.bleedout)}s` : 'no allies standing'}<div class="bar"><i style="width:${p.reviveProgress * 100}%"></i></div></div>` : '',
      p.state === 'spectating' ? `<div class="downed spec">Joining next room…</div>` : '',
      p.state === 'dead' ? `<div class="downed">You fell. You'll return next room.</div>` : '',
    ];
    const html = parts.join('');
    if (html !== this.lastHud) {
      this.hud.innerHTML = html;
      this.lastHud = html;
    }
    this.crosshair.classList.toggle('target', extra.aimTarget);
    if (!this.targetEl) {
      this.targetEl = document.createElement('div');
      this.targetEl.className = 'aimtarget';
      this.crosshair.appendChild(this.targetEl);
    }
    const tg = extra.target;
    if (tg) {
      const aff = tg.affix ? (tg.affix.startsWith('ward:') ? `Warded vs ${ELEMENT_INFO[tg.affix.slice(5) as Element].name}` : AFFIX_INFO[tg.affix]?.name ?? '') : '';
      const html = `<b class="${tg.elite ? 'el' : ''}">${esc(tg.name)}</b>${aff ? `<em>${aff}</em>` : ''}<div class="tb"><i style="width:${Math.max(0, tg.hp * 100)}%"></i>${tg.shield > 0 ? `<s style="width:${Math.min(100, tg.shield * 100)}%"></s>` : ''}</div>`;
      if (this.targetEl.innerHTML !== html) this.targetEl.innerHTML = html;
      this.targetEl.style.display = 'block';
    } else this.targetEl.style.display = 'none';
    this.crosshair.style.setProperty('--c', ELEMENT_INFO[el].css);
  }

  private teamRow(q: Player): string {
    const pct = Math.max(0, (q.hp / q.maxHp) * 100);
    const st = q.state === 'downed' ? 'DOWN' : q.state === 'dead' ? 'OUT' : q.state === 'spectating' ? 'JOINING' : '';
    return `<div class="tm" style="--c:${hex(q.color)}"><b>${esc(q.name)}</b>${elChip(q.gauntlets[q.active], true)}<div class="bar ${st ? 'st' : ''}"><i style="width:${pct}%"></i></div>${st ? `<em>${st}</em>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- rewards
  reward(s: ViewState, localId: string) {
    if (this.current !== 'reward') return;
    const offers = s.run.offers[localId] ?? [];
    const picked = s.run.picks[localId];
    const voted = s.run.votes[localId];
    const tally: Record<string, number> = {};
    for (const v of Object.values(s.run.votes)) tally[v] = (tally[v] ?? 0) + 1;
    const waiting = [...s.players.values()].filter((p) => !s.run.picks[p.id] || (s.run.teamOffers.length && !s.run.votes[p.id])).map((p) => p.name);
    const key = JSON.stringify([offers, picked, voted, tally, waiting, s.run.teamOffers]);
    if (key === this.rewardKey) return;
    this.rewardKey = key;
    const card = (id: string, kind: 'pick' | 'vote', chosen: boolean) => {
      if (id.startsWith('gauntlet:')) {
        const el = id.slice(9) as Element;
        const i = ELEMENT_INFO[el];
        return `<button class="card el ${chosen ? 'on' : ''}" style="--c:${i.css}" data-a="${kind}" data-v="${id}"><div class="glyph">${i.glyph}</div><h3>${i.gauntlet}</h3><div class="sub">Gauntlet find — replaces your off-hand gauntlet.</div><div class="badge">NEW GAUNTLET</div></button>`;
      }
      const b = BOON_BY_ID[id];
      if (!b) return '';
      return `<button class="card boon r${b.rarity} ${chosen ? 'on' : ''}" data-a="${kind}" data-v="${id}"><div class="glyph">${b.glyph}</div><h3>${b.name}</h3><div class="sub">${b.desc}</div>${kind === 'vote' ? `<div class="badge">${tally[id] ?? 0} vote${(tally[id] ?? 0) === 1 ? '' : 's'}</div>` : ''}</button>`;
    };
    this.screen.innerHTML = `<div class="panel wide reward"><h2>Room Cleared</h2>
      <h4>Your boon ${picked ? '✓' : ''}</h4><div class="grid3">${offers.map((o) => card(o, 'pick', picked === o)).join('')}</div>
      ${s.run.teamOffers.length ? `<h4>Team boon — vote ${voted ? '✓' : ''}</h4><div class="grid3">${s.run.teamOffers.map((o) => card(o, 'vote', voted === o)).join('')}</div>` : ''}
      ${waiting.length ? `<p class="hint">Waiting for: ${waiting.map(esc).join(', ')}</p>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------- end
  end(won: boolean, s: ViewState, shards: number) {
    const ps = [...s.players.values()];
    this.screen.innerHTML = `<div class="panel wide end ${won ? 'win' : 'lose'}"><h2>${won ? 'The Rift Is Sealed' : 'The Rift Claims You'}</h2>
      <p>Reached room ${s.run.roomIndex + 1} of ${s.run.totalRooms}. +${Math.round(shards)}◈ shards</p>
      <table><tr><th>Mage</th><th>Damage</th><th>Kills</th><th>Combos</th><th>Downs</th></tr>
      ${ps.map((p) => `<tr style="--c:${hex(p.color)}"><td><b>${esc(p.name)}</b></td><td>${Math.round(p.dmgDealt)}</td><td>${p.kills}</td><td>${p.combos}</td><td>${p.downs}</td></tr>`).join('')}</table>
      <div class="row"><button class="btn primary" data-a="leave">Continue</button></div></div>`;
    this.current = 'end';
    this.hud.style.display = 'none';
    this.crosshair.style.display = 'none';
  }

  // ---------------------------------------------------------------- juice
  combo(name: string, names: { name: string; color: number }[]) {
    const d = document.createElement('div');
    d.className = 'combo';
    d.innerHTML = `<small>COMBO!</small><b>${esc(name)}</b><div class="by">${names.map((n) => `<i style="--c:${hex(n.color)}">${esc(n.name)}</i>`).join('<span>+</span>')}</div>`;
    this.callouts.appendChild(d);
    while (this.callouts.children.length > 3) this.callouts.firstChild?.remove();
    setTimeout(() => d.remove(), 2200);
  }

  banner(text: string, sub = '', cls = '') {
    const d = document.createElement('div');
    d.className = `banner ${cls}`;
    d.innerHTML = `<b>${esc(text)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`;
    this.callouts.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
  }

  damage(x: number, y: number, z: number, amt: number, color: string, crit: boolean, toPlayer: boolean) {
    const el = this.dmgPool.find((d) => d.style.display === 'none');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = `${amt}${crit ? '!' : ''}`;
    el.className = `dmg${crit ? ' crit' : ''}${toPlayer ? ' hurt' : ''}`;
    el.style.color = toPlayer ? '#ff4a5a' : color;
    this.dmgActive.push({ el, x: x + (Math.random() - 0.5) * 0.6, y, z: z + (Math.random() - 0.5) * 0.6, t: 0 });
  }

  frame(dt: number) {
    for (let i = this.dmgActive.length - 1; i >= 0; i--) {
      const d = this.dmgActive[i];
      d.t += dt;
      const p = this.project(d.x, d.y + d.t * 1.4, d.z);
      if (d.t > 0.9 || !p.visible) {
        d.el.style.display = 'none';
        this.dmgActive.splice(i, 1);
        continue;
      }
      const s = d.t < 0.1 ? 0.6 + d.t * 6 : 1.2 - d.t * 0.3;
      d.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%) scale(${s})`;
      d.el.style.opacity = `${Math.min(1, (0.9 - d.t) * 3)}`;
    }
  }

  private pingEls: HTMLDivElement[] = [];
  pings(list: { x: number; y: number; z: number; t: number; color: number; kind: string; name: string }[]) {
    while (this.pingEls.length < list.length) {
      const d = document.createElement('div');
      d.className = 'pinglabel';
      this.dmgLayer.appendChild(d);
      this.pingEls.push(d);
    }
    const icon: Record<string, string> = { here: '◎ HERE', attack: '⚔ ATTACK', help: '✚ HELP', combo: '✸ COMBO!' };
    const W = window.innerWidth,
      H = window.innerHeight;
    this.pingEls.forEach((el, i) => {
      const m = list[i];
      if (!m) {
        el.style.display = 'none';
        return;
      }
      const p = this.project(m.x, m.y + 3.2, m.z);
      let x = p.x,
        y = p.y;
      const off = !p.visible || x < 20 || x > W - 20 || y < 20 || y > H - 20;
      if (!p.visible) {
        x = W - x;
        y = H - 30;
      }
      x = Math.max(40, Math.min(W - 40, x));
      y = Math.max(40, Math.min(H - 40, y));
      el.style.display = 'block';
      el.className = `pinglabel k-${m.kind}${off ? ' off' : ''}`;
      el.style.setProperty('--c', hex(m.color));
      el.innerHTML = `<b>${icon[m.kind] ?? '◎'}</b><small>${esc(m.name)}</small>`;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      el.style.opacity = `${Math.min(1, (5 - m.t) * 1.5)}`;
    });
  }

  perf(text: string | null) {
    this.perfEl.style.display = text ? 'block' : 'none';
    if (text) this.perfEl.textContent = text;
  }
}
