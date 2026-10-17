import type { World, RunInfo } from '../sim/world';
import type { Element, Enemy, Pickup, Player, PlayerInput, Telegraph, Zone } from '../sim/types';

export const PROTOCOL_VERSION = 1;

export interface Hello {
  v: number;
  name: string;
  g: [Element, Element];
}

export interface Welcome {
  v: number;
  host: string;
  you: string;
  full?: boolean;
}

/** Client -> host: last few inputs (redundancy against loss). */
export interface InputMsg {
  i: PlayerInput[];
}

export type Cmd =
  | { c: 'pick'; v: string }
  | { c: 'vote'; v: string }
  | { c: 'ready'; v: boolean }
  | { c: 'loadout'; v: [Element, Element] }
  | { c: 'ping'; k: string; x: number; y: number; z: number };

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Player state sent in full (only up to 4 players). Stats are recomputed client-side from boons. */
export type PlayerSnap = Omit<Player, 'stats'>;

export interface Snapshot {
  tick: number;
  time: number;
  ack: Record<string, number>;
  room: [number, number, number];
  run: Omit<RunInfo, 'unlockedBoons'>;
  tb: string[];
  p: PlayerSnap[];
  e: (string | number)[][];
  z: (string | number | string[])[][];
  tg: (string | number)[][];
  pk: (string | number)[][];
}

export function encodeSnapshot(w: World, roomPlayers: number): Snapshot {
  const ack: Record<string, number> = {};
  const p: PlayerSnap[] = [];
  for (const pl of w.players.values()) {
    ack[pl.id] = pl.lastSeq;
    const { stats: _s, ...rest } = pl;
    p.push({
      ...rest,
      pos: { x: r2(pl.pos.x), y: r2(pl.pos.y), z: r2(pl.pos.z) },
      vel: { x: r2(pl.vel.x), y: r2(pl.vel.y), z: r2(pl.vel.z) },
      dmgDealt: Math.round(pl.dmgDealt),
    });
  }
  const { unlockedBoons: _u, ...run } = w.run;
  return {
    tick: w.tick,
    time: r2(w.time),
    ack,
    room: [w.run.seed, Math.max(0, w.run.roomIndex), roomPlayers],
    run,
    tb: w.teamBoons,
    p,
    e: w.enemies.map(encodeEnemy),
    z: w.zones.map(encodeZone),
    tg: w.telegraphs.map((t) => [t.id, t.shape, r2(t.x), r2(t.y), r2(t.z), r2(t.r), r2(t.r2), r2(t.angle), r2(t.len), r2(t.width), r2(t.t), r2(t.dur), t.element]),
    pk: w.pickups.map((k) => [k.id, k.kind, k.value, r2(k.pos.x), r2(k.pos.y), r2(k.pos.z)]),
  };
}

function encodeEnemy(e: Enemy): (string | number)[] {
  const s = e.st;
  return [
    e.id, e.kind, e.faction, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r2(e.yaw), Math.round(e.hp), Math.round(e.maxHp), e.state,
    (e.elite ? 1 : 0) | (e.boss ? 2 : 0) | (e.flying ? 4 : 0), r1(s.burn), r1(s.chill), r1(s.frozen), r1(s.poison), r1(s.shock), r1(s.wet), r1(s.blind),
    r1(e.hitFlash), r2(e.spawnT), e.seed, e.phase, e.radius, e.height,
  ];
}

function encodeZone(z: Zone): (string | number | string[])[] {
  return [z.id, z.tag, z.element, r2(z.pos.x), r2(z.pos.y), r2(z.pos.z), r2(z.radius), r2(z.life), r2(z.maxLife), r2(z.angle), r2(z.len), z.contributors];
}

export function decodeEnemy(a: (string | number)[], prev?: Enemy): Enemy {
  const n = (i: number) => a[i] as number;
  const flags = n(10);
  const e: Enemy = prev ?? ({
    st: { burn: 0, burnDps: 0, chill: 0, frozen: 0, shock: 0, wet: 0, poison: 0, poisonT: 0, blind: 0, stagger: 0 },
    vel: { x: 0, y: 0, z: 0 },
    pos: { x: 0, y: 0, z: 0 },
    attackIdx: 0,
    attackCds: [],
    target: null,
    stateT: 0,
    lastHitEl: null,
    lastHitBy: null,
    dmgMul: 1,
    data: {},
    statusBy: {},
    kx: 0,
    kz: 0,
    ky: 0,
  } as unknown as Enemy);
  e.id = n(0);
  e.kind = a[1] as string;
  e.faction = a[2] as Enemy['faction'];
  e.pos.x = n(3);
  e.pos.y = n(4);
  e.pos.z = n(5);
  e.yaw = n(6);
  e.hp = n(7);
  e.maxHp = n(8);
  e.state = a[9] as Enemy['state'];
  e.elite = !!(flags & 1);
  e.boss = !!(flags & 2);
  e.flying = !!(flags & 4);
  e.st.burn = n(11);
  e.st.chill = n(12);
  e.st.frozen = n(13);
  e.st.poison = n(14);
  e.st.shock = n(15);
  e.st.wet = n(16);
  e.st.blind = n(17);
  e.hitFlash = n(18);
  e.spawnT = n(19);
  e.seed = n(20);
  e.phase = n(21);
  e.radius = n(22);
  e.height = n(23);
  return e;
}

export function decodeZone(a: (string | number | string[])[], prev?: Zone): Zone {
  const n = (i: number) => a[i] as number;
  const z: Zone = prev ?? ({ vel: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 }, reacted: [], tickT: 0, growth: 0, dps: 0 } as unknown as Zone);
  z.id = n(0);
  z.tag = a[1] as Zone['tag'];
  z.element = a[2] as Element;
  z.pos.x = n(3);
  z.pos.y = n(4);
  z.pos.z = n(5);
  z.radius = n(6);
  z.life = n(7);
  z.maxLife = n(8);
  z.angle = n(9);
  z.len = n(10);
  z.contributors = a[11] as string[];
  return z;
}

export function decodeTelegraph(a: (string | number)[]): Telegraph {
  const n = (i: number) => a[i] as number;
  return { id: n(0), shape: a[1] as Telegraph['shape'], x: n(2), y: n(3), z: n(4), r: n(5), r2: n(6), angle: n(7), len: n(8), width: n(9), t: n(10), dur: n(11), element: a[12] as Element, dmg: 0, owner: 0, knock: 0 };
}

export function decodePickup(a: (string | number)[]): Pickup {
  return { id: a[0] as number, kind: a[1] as Pickup['kind'], value: a[2] as string, pos: { x: a[3] as number, y: a[4] as number, z: a[5] as number }, t: 0 };
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function makeRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  return s;
}
