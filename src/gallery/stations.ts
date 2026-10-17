import type { Element, Enemy, SimEvent, Telegraph, Zone, ZoneTag } from '../sim/types';
import { ELEMENT_INFO } from '../data/elements';
import { ENEMIES } from '../data/enemies';

export type Category = 'spell' | 'combo' | 'impact' | 'misc';

export interface StationCtx {
  /** station origin */
  x: number;
  z: number;
  emit(e: SimEvent): void;
  zone(tag: ZoneTag, el: Element, dx: number, dz: number, r: number, life: number, opts?: Partial<Zone>): Zone;
  clearZones(): void;
  tele(shape: Telegraph['shape'], dx: number, dz: number, opts: Partial<Telegraph>): Telegraph;
  /** fire a projectile from (dx,dy,dz) to target offset; ends automatically on arrival */
  shoot(el: Element, spell: string, from: [number, number, number], to: [number, number, number], speed: number, opts?: { g?: number; r?: number; enemy?: boolean; boom?: () => void }): void;
  dummy(dx: number, dz: number, kind?: string): Enemy;
  charge(el: Element, on: boolean, c?: number): void;
  id(): number;
  pid: string;
}

export interface Station {
  name: string;
  sub: string;
  cat: Category;
  el: Element | null;
  period: number;
  /** [time within loop, action] */
  script: [number, (c: StationCtx) => void][];
  /** per-frame hook (charge glow etc) */
  tick?: (c: StationCtx, t: number, dt: number) => void;
  setup?: (c: StationCtx) => void;
}

const H = 1.35; // hand height

function castEv(c: StationCtx, el: Element, slot: 'primary' | 'heavy' | 'signature', dx = 1, ch = 0): SimEvent {
  return { t: 'cast', pid: c.pid, el, slot, x: c.x - 4, y: H, z: c.z, dx, dy: 0, dz: 0, c: ch };
}

const primaryShots: Record<Element, (c: StationCtx) => void> = {
  fire: (c) => {
    c.emit(castEv(c, 'fire', 'primary'));
    c.shoot('fire', 'ember', [-4, H, 0], [4, 1.2, 0], 38);
  },
  frost: (c) => {
    c.emit(castEv(c, 'frost', 'primary'));
    for (const s of [-0.9, 0, 0.9]) c.shoot('frost', 'shard', [-4, H, 0], [4, 1.2, s], 44);
  },
  storm: (c) => {
    c.emit(castEv(c, 'storm', 'primary'));
    c.shoot('storm', 'arc', [-4, H, 0], [4, 1.2, 0], 85, {
      boom: () => c.emit({ t: 'bolt', x: c.x + 4, y: 1.2, z: c.z, x2: c.x + 6, y2: 1, z2: c.z + 3, el: 'storm' }),
    });
  },
  gale: (c) => {
    c.emit(castEv(c, 'gale', 'primary'));
    c.shoot('gale', 'gust', [-4, H, 0], [4, 1.2, 0], 40);
  },
  stone: (c) => {
    c.emit(castEv(c, 'stone', 'primary'));
    c.shoot('stone', 'pebble', [-4, H, -0.2], [4, 1, -0.2], 33, { g: 6 });
    c.shoot('stone', 'pebble', [-4, H, 0.2], [4, 1, 0.3], 33, { g: 6 });
  },
  venom: (c) => {
    c.emit(castEv(c, 'venom', 'primary'));
    c.shoot('venom', 'glob', [-4, H, 0], [3.5, 0, 0], 20, { g: 16, boom: () => c.zone('venompool', 'venom', 3.5, 0, 1.5, 2.5) });
  },
};

const heavy: Record<Element, (c: StationCtx) => void> = {
  fire: (c) => {
    c.emit(castEv(c, 'fire', 'heavy', 1, 1));
    c.shoot('fire', 'sunorb', [-4, H, 0], [4, 1, 0], 24, {
      r: 0.95,
      boom: () => {
        c.emit({ t: 'boom', x: c.x + 4, y: 1, z: c.z, r: 4.6, el: 'fire', big: 1 });
        c.zone('burning', 'fire', 4, 0, 3.5, 3);
      },
    });
  },
  frost: (c) => {
    c.emit(castEv(c, 'frost', 'heavy', 1, 1));
    c.shoot('frost', 'lance', [-4, H, 0], [6, 1, 0], 46, { r: 0.42, boom: () => c.emit({ t: 'boom', x: c.x + 6, y: 1, z: c.z, r: 1.8, el: 'frost' }) });
    for (let i = 0; i < 3; i++) c.zone('frostpatch', 'frost', -1 + i * 3, 0, 1.7, 3);
  },
  storm: (c) => {
    c.emit(castEv(c, 'storm', 'heavy', 1, 1));
    c.shoot('storm', 'spear', [-4, H, 0], [4, 0, 0], 54, { boom: () => c.emit({ t: 'strike', x: c.x + 4, y: 0, z: c.z, r: 4, el: 'storm' }) });
  },
  gale: (c) => {
    c.emit(castEv(c, 'gale', 'heavy', 1, 1));
    const z = c.zone('vortex', 'gale', -3, 0, 3.4, 3.2);
    z.vel = { x: 2.5, y: 0, z: 0 };
  },
  stone: (c) => {
    c.emit(castEv(c, 'stone', 'heavy', 1, 1));
    c.shoot('stone', 'boulder', [-4, 1.3, 0], [5, 1.3, 0], 18, { r: 1.3, g: 20, boom: () => c.emit({ t: 'boom', x: c.x + 5, y: 1, z: c.z, r: 2.5, el: 'stone' }) });
  },
  venom: (c) => {
    c.emit(castEv(c, 'venom', 'heavy', 1, 1));
    c.shoot('venom', 'flask', [-4, H, 0], [3, 0, 0], 16, {
      g: 18,
      boom: () => {
        c.emit({ t: 'boom', x: c.x + 3, y: 0.5, z: c.z, r: 2.5, el: 'venom' });
        c.zone('venomcloud', 'venom', 3, 0, 4.5, 3.5);
      },
    });
  },
};

const signature: Record<Element, (c: StationCtx) => void> = {
  fire: (c) => {
    c.emit(castEv(c, 'fire', 'signature'));
    c.emit({ t: 'nova', x: c.x, y: 0, z: c.z, r: 8, el: 'fire' });
    c.zone('burning', 'fire', 0, 0, 4, 3);
  },
  frost: (c) => {
    c.emit(castEv(c, 'frost', 'signature'));
    c.emit({ t: 'nova', x: c.x + 2, y: 0, z: c.z, r: 5.5, el: 'frost' });
    c.zone('frostpatch', 'frost', 2, 0, 5.5, 3.5);
  },
  storm: (c) => c.emit(castEv(c, 'storm', 'signature')),
  gale: (c) => {
    c.emit(castEv(c, 'gale', 'signature'));
    c.emit({ t: 'nova', x: c.x, y: 0, z: c.z, r: 6, el: 'gale' });
    c.emit({ t: 'jump', pid: c.pid, n: 2 });
  },
  stone: (c) => {
    c.emit(castEv(c, 'stone', 'signature'));
    const z = c.zone('wall', 'stone', 2, 0, 4.5, 3.5, { angle: Math.PI / 2, len: 4.5 });
    c.emit({ t: 'wallRise', id: z.id });
    c.emit({ t: 'boom', x: c.x + 2, y: 0.5, z: c.z, r: 3.5, el: 'stone' });
  },
  venom: (c) => {
    c.emit(castEv(c, 'venom', 'signature'));
    c.zone('venomcloud', 'venom', 0, 0, 5.5, 3.5);
    c.emit({ t: 'nova', x: c.x, y: 0, z: c.z, r: 6, el: 'venom' });
  },
};

const ELS: Element[] = ['fire', 'frost', 'storm', 'gale', 'stone', 'venom'];

export function buildStations(): Station[] {
  const out: Station[] = [];
  for (const el of ELS) {
    const info = ELEMENT_INFO[el];
    const rate = { fire: 0.18, frost: 0.34, storm: 0.22, gale: 0.24, stone: 0.3, venom: 0.3 }[el];
    const prim: Station['script'] = [];
    for (let t = 0; t < 2.4; t += rate) prim.push([t, primaryShots[el]]);
    out.push({ name: info.spells.primary, sub: `${info.name} · primary`, cat: 'spell', el, period: 3.2, script: prim, setup: (c) => c.dummy(4.5, 0) });
    out.push({
      name: info.spells.heavy,
      sub: `${info.name} · charged heavy`,
      cat: 'spell',
      el,
      period: 4.6,
      script: [
        [0, (c) => c.charge(el, true)],
        [1.1, (c) => (c.charge(el, false), heavy[el](c))],
      ],
      tick: (c, t) => t < 1.1 && c.charge(el, true, t / 1.1),
      setup: (c) => c.dummy(5, 0),
    });
    const sig: Station['script'] = [[0.2, signature[el]]];
    if (el === 'storm')
      for (let i = 0; i < 7; i++)
        sig.push([0.3 + i * 0.17, (c) => {
          const a = Math.random() * 6.28,
            r = i ? 1 + Math.random() * 5 : 0;
          c.emit({ t: 'strike', x: c.x + 2 + Math.cos(a) * r, y: 0, z: c.z + Math.sin(a) * r, r: 2.4, el: 'storm' });
        }]);
    out.push({ name: info.spells.signature, sub: `${info.name} · signature`, cat: 'spell', el, period: 4.2, script: sig });
  }

  // ---- combos
  const combo = (name: string, sub: string, el: Element, period: number, script: Station['script'], setup?: Station['setup']): Station => ({ name, sub, cat: 'combo', el, period, script, setup });
  const fire = (c: StationCtx, key: string, name: string, r = 4) => c.emit({ t: 'combo', key, name, x: c.x, y: 0.5, z: c.z, r, pids: [c.pid] });
  out.push(
    combo('Firestorm', 'Gale vortex + Fire', 'fire', 5.5, [
      [0, (c) => (c.clearZones(), heavy.gale(c))],
      [0.9, (c) => primaryShots.fire(c)],
      [1.1, (c) => {
        fire(c, 'firestorm', 'FIRESTORM');
        const v = c.zone('firestorm', 'fire', 0, 0, 4.4, 4);
        v.vel = { x: 0.8, y: 0, z: 0 };
      }],
    ]),
    combo('Toxic Tempest', 'Gale vortex + Venom', 'venom', 5.5, [
      [0, (c) => (c.clearZones(), heavy.gale(c))],
      [0.9, (c) => primaryShots.venom(c)],
      [1.2, (c) => {
        fire(c, 'toxic_tempest', 'TOXIC TEMPEST');
        c.zone('toxicstorm', 'venom', 0, 0, 5, 4, { growth: 0.8 });
      }],
    ]),
    combo('Blizzard', 'Gale vortex + Frost', 'frost', 5.5, [
      [0, (c) => (c.clearZones(), heavy.gale(c))],
      [0.9, (c) => primaryShots.frost(c)],
      [1.1, (c) => (fire(c, 'blizzard', 'BLIZZARD'), c.zone('blizzard', 'frost', 0, 0, 4.6, 4))],
    ]),
    combo('Thunderhead', 'Gale vortex + Storm', 'storm', 5.5, [
      [0, (c) => (c.clearZones(), heavy.gale(c))],
      [0.9, (c) => primaryShots.storm(c)],
      [1.0, (c) => (fire(c, 'thunderhead', 'THUNDERHEAD'), c.zone('stormcell', 'storm', 0, 0, 4.2, 4))],
    ]),
    combo('Detonation', 'Fire + Venom cloud', 'fire', 4.5, [
      [0, (c) => (c.clearZones(), c.zone('venomcloud', 'venom', 2, 0, 4.5, 1.6))],
      [1.0, (c) => primaryShots.fire(c)],
      [1.25, (c) => (c.clearZones(), fire(c, 'detonation', 'DETONATION', 6.5))],
    ], (c) => c.dummy(3, 1)),
    combo('Chain Surge', 'Storm + water network', 'storm', 4.5, [
      [0, (c) => {
        c.clearZones();
        for (let i = 0; i < 4; i++) c.zone('puddle', 'frost', -3 + i * 3.4, (i % 2) * 1.5 - 0.7, 2, 4.4);
      }],
      [1.0, (c) => primaryShots.storm(c)],
      [1.2, (c) => {
        fire(c, 'chain_electrocution', 'CHAIN SURGE');
        for (let i = 0; i < 4; i++) {
          c.zone('electrified', 'storm', -3 + i * 3.4, (i % 2) * 1.5 - 0.7, 2, 3);
          if (i) c.emit({ t: 'bolt', x: c.x - 3 + (i - 1) * 3.4, y: 0.2, z: c.z + ((i - 1) % 2) * 1.5 - 0.7, x2: c.x - 3 + i * 3.4, y2: 0.2, z2: c.z + (i % 2) * 1.5 - 0.7, el: 'storm', w: 1 });
        }
      }],
    ]),
    combo('Shatter', 'Stone + frozen foe', 'stone', 3.6, [
      [0, (c) => {
        const d = c.dummy(3.5, 0);
        d.st.frozen = 2;
        c.emit({ t: 'nova', x: c.x + 3.5, y: 0, z: c.z, r: 2.5, el: 'frost' });
      }],
      [1.2, (c) => primaryShots.stone(c)],
      [1.45, (c) => {
        c.emit({ t: 'shatter', x: c.x + 3.5, y: 1, z: c.z });
        c.emit({ t: 'combo', key: 'shatter', name: 'SHATTER', x: c.x + 3.5, y: 1, z: c.z, r: 4, pids: [c.pid] });
        c.dummy(3.5, 0).st.frozen = 0;
      }],
    ]),
    combo('Steam Burst', 'Fire + Frost', 'frost', 5, [
      [0, (c) => (c.clearZones(), c.zone('frostpatch', 'frost', 2, 0, 3.5, 1.4))],
      [1.0, (c) => primaryShots.fire(c)],
      [1.2, (c) => (c.clearZones(), fire(c, 'steam', 'STEAM BURST', 4), c.zone('steam', 'frost', 2, 0, 5, 3.5))],
    ], (c) => c.dummy(3, 1.5)),
    combo('Flash Freeze', 'Frost + puddle', 'frost', 4, [
      [0, (c) => (c.clearZones(), c.zone('puddle', 'frost', 2, 0, 3, 1.3))],
      [0.9, (c) => primaryShots.frost(c)],
      [1.1, (c) => (c.clearZones(), fire(c, 'flash_freeze', 'FLASH FREEZE', 3.5), c.zone('frostpatch', 'frost', 2, 0, 3.6, 2.6))],
    ]),
    combo('Magma Wall', 'Fire + stone wall', 'fire', 5, [
      [0, (c) => {
        c.clearZones();
        const z = c.zone('wall', 'stone', 2, 0, 4.5, 4.8, { angle: Math.PI / 2, len: 4.5 });
        c.emit({ t: 'wallRise', id: z.id });
      }],
      [1.2, (c) => primaryShots.fire(c)],
      [1.35, (c) => {
        const w = c.zone('magmawall', 'fire', 2, 0, 4.5, 3.4, { angle: Math.PI / 2, len: 4.5 });
        void w;
        fire(c, 'magma_wall', 'MAGMA WALL');
      }],
    ]),
    combo('Wind Redirect', 'Gale gust off a wall', 'gale', 3.5, [
      [0, (c) => {
        c.clearZones();
        c.zone('wall', 'stone', 3, 0, 4.5, 3.4, { angle: Math.PI / 2, len: 3 });
      }],
      [0.6, (c) => {
        c.emit(castEv(c, 'gale', 'primary'));
        c.shoot('gale', 'gust', [-4, H, 0], [2.4, H, 0], 30, {
          boom: () => {
            c.emit({ t: 'projBounce', id: -1, x: c.x + 2.4, y: H, z: c.z, vx: -10, vy: 0, vz: 20, });
            c.shoot('gale', 'gust', [2.4, H, 0], [-2, H, 6], 30);
          },
        });
      }],
    ]),
    combo('Conduction', 'Storm + wet foes', 'storm', 3.8, [
      [0, (c) => {
        for (const [dx, dz] of [[3, 0], [5, 3], [6, -2.5]]) c.dummy(dx, dz).st.wet = 3;
      }],
      [1.0, (c) => primaryShots.storm(c)],
      [1.12, (c) => {
        fire(c, 'conduction', 'CONDUCTION');
        c.emit({ t: 'bolt', x: c.x + 3, y: 1, z: c.z, x2: c.x + 5, y2: 1, z2: c.z + 3, el: 'storm' });
        c.emit({ t: 'bolt', x: c.x + 5, y: 1, z: c.z + 3, x2: c.x + 6, y2: 1, z2: c.z - 2.5, el: 'storm' });
      }],
    ]),
  );

  // ---- impacts
  for (const el of ELS) {
    out.push({
      name: `${ELEMENT_INFO[el].name} impact`,
      sub: 'hit / crit / explosion',
      cat: 'impact',
      el,
      period: 2.4,
      script: [
        [0.1, (c) => c.emit({ t: 'hit', id: 0, x: c.x - 2, y: 1.2, z: c.z, amt: 12, el, crit: 0 })],
        [0.6, (c) => c.emit({ t: 'hit', id: 0, x: c.x, y: 1.2, z: c.z, amt: 45, el, crit: 1 })],
        [1.2, (c) => c.emit({ t: 'boom', x: c.x + 2, y: 0.8, z: c.z, r: 3, el })],
      ],
    });
  }

  // ---- misc: telegraphs, movement, deaths
  out.push({
    name: 'Telegraphs',
    sub: 'circle · ring · line · cone',
    cat: 'misc',
    el: null,
    period: 2.2,
    script: [
      [0, (c) => {
        c.tele('circle', -4, -2, { r: 2.5, dur: 1.6, element: 'fire' });
        c.tele('ring', 3, -2, { r: 3.5, r2: 1.8, dur: 1.6, element: 'storm' });
        c.tele('line', -6, 3, { len: 9, width: 2, angle: Math.PI / 2, dur: 1.6, element: 'frost' });
        c.tele('cone', 4, 4, { r: 4.5, width: 0.5, angle: Math.PI, dur: 1.6, element: 'venom' });
      }],
    ],
  });
  out.push({
    name: 'Dash & Blink',
    sub: 'afterimages · rune blink',
    cat: 'misc',
    el: null,
    period: 2.5,
    script: [
      [0.2, (c) => c.emit({ t: 'dash', pid: c.pid, x: c.x - 3, y: 0, z: c.z })],
      [1.2, (c) => c.emit({ t: 'dash', pid: c.pid, x: c.x - 3, y: 0, z: c.z, blink: 1, x2: c.x + 3, z2: c.z })],
      [1.8, (c) => c.emit({ t: 'jump', pid: c.pid, n: 2, rocket: 1 })],
    ],
  });
  out.push({
    name: 'Rift Spawn & Death',
    sub: 'enemy portal · dissolve',
    cat: 'misc',
    el: null,
    period: 3,
    script: [
      [0.1, (c) => {
        const d = c.dummy(0, 0, ['husk', 'shardling', 'sludge'][Math.floor(Math.random() * 3)]);
        d.spawnT = 0.9;
        c.emit({ t: 'spawn', id: d.id, x: c.x, y: 0, z: c.z, faction: d.faction });
      }],
      [2.0, (c) => {
        const d = c.dummy(0, 0);
        c.emit({ t: 'kill', id: d.id, x: c.x, y: 0, z: c.z, el: 'fire', kind: d.kind });
      }],
    ],
  });
  out.push({
    name: 'Revive · Down · Ping',
    sub: 'co-op feedback',
    cat: 'misc',
    el: null,
    period: 3,
    script: [
      [0.1, (c) => c.emit({ t: 'down', pid: c.pid })],
      [1.2, (c) => c.emit({ t: 'revive', pid: c.pid, by: c.pid })],
      [2.0, (c) => c.emit({ t: 'ping', pid: c.pid, kind: 'here', x: c.x + 3, y: 0, z: c.z })],
    ],
  });
  out.push({
    name: 'Elite Affixes',
    sub: 'shielded · hasted · volatile · warded',
    cat: 'misc',
    el: null,
    period: 3,
    script: [
      [0.3, (c) => {
        const d = c.dummy(-4, -1.5, 'warden');
        d.shield = d.shield > 0 ? 0 : d.maxHp * 0.4;
      }],
    ],
    setup: (c) => {
      const a = c.dummy(-4, -1.5, 'warden');
      a.affix = 'shielded';
      a.shield = a.maxHp * 0.4;
      c.dummy(0, 2, 'husk').affix = 'hasted';
      c.dummy(3, -2, 'sludge').affix = 'volatile';
      c.dummy(5, 2, 'spitter').affix = 'ward:frost';
    },
  });
  out.push({
    name: 'Boss: Ignavar',
    sub: 'Kiln Heart · phase aura',
    cat: 'misc',
    el: 'fire',
    period: 4,
    script: [[0.2, (c) => c.tele('circle', 0, 0, { r: 7, dur: 1.3, element: 'fire' })]],
    setup: (c) => c.dummy(0, 0, 'kiln'),
  });
  out.push({
    name: 'Boss: Sylvara',
    sub: 'Hollow Prism · beams',
    cat: 'misc',
    el: 'frost',
    period: 3.5,
    script: [
      [0.2, (c) => {
        for (let i = 0; i < 5; i++) c.tele('line', 0, 0, { len: 8, width: 1.6, angle: (i / 5) * Math.PI * 2, dur: 1.4, element: 'storm' });
      }],
    ],
    setup: (c) => {
      const d = c.dummy(0, 0, 'prism');
      d.pos.y = 3.2;
    },
  });
  return out;
}

export function enemyFromKind(kind: string, id: number, x: number, z: number): Enemy {
  const def = ENEMIES[kind];
  return {
    id,
    kind,
    faction: def.faction,
    pos: { x, y: def.flying ? 2.2 : 0, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: -Math.PI / 2,
    hp: def.hp,
    maxHp: def.hp,
    radius: def.radius,
    height: def.height,
    flying: !!def.flying,
    state: 'chase',
    stateT: 0,
    attackIdx: 0,
    attackCds: [],
    target: null,
    st: { burn: 0, burnDps: 0, chill: 0, frozen: 0, shock: 0, wet: 0, poison: 0, poisonT: 0, blind: 0, stagger: 0 },
    elite: !!def.elite,
    boss: !!def.boss,
    phase: 1,
    hitFlash: 0,
    lastHitEl: null,
    lastHitBy: null,
    seed: id * 131,
    dmgMul: 1,
    data: {},
    spawnT: 0,
    statusBy: {},
    kx: 0,
    kz: 0,
    ky: 0,
    affix: '',
    shield: 0,
  };
}
