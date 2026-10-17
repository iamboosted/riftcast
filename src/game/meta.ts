import { load, save } from '../core/storage';
import type { Element } from '../sim/types';
import { BOONS } from '../data/boons';
import type { QualityName } from '../core/quality';

export interface MetaState {
  shards: number;
  gauntlets: Element[];
  boons: string[];
  loadout: [Element, Element];
  name: string;
  stats: { runs: number; wins: number; kills: number; combos: number; bestRoom: number; bossKills: number };
}

export interface SettingsState {
  quality: QualityName | 'auto';
  muted: boolean;
  volume: number;
  sensitivity: number;
  touchLook: number;
  invertY: boolean;
  aimAssist: boolean;
  perf: boolean;
}

export const GAUNTLET_COST = 30;
export const BOON_COST = 25;

const defaultMeta = (): MetaState => ({
  shards: 0,
  gauntlets: ['fire', 'frost', 'storm'],
  boons: [],
  loadout: ['fire', 'frost'],
  name: '',
  stats: { runs: 0, wins: 0, kills: 0, combos: 0, bestRoom: 0, bossKills: 0 },
});

export const defaultSettings = (): SettingsState => ({
  quality: 'auto',
  muted: false,
  volume: 0.8,
  sensitivity: 1,
  touchLook: 1,
  invertY: false,
  aimAssist: true,
  perf: false,
});

export class Meta {
  state: MetaState;
  settings: SettingsState;
  constructor() {
    this.state = load('meta', defaultMeta());
    this.state.stats = { ...defaultMeta().stats, ...(this.state.stats ?? {}) };
    if (!Array.isArray(this.state.gauntlets) || this.state.gauntlets.length < 2) this.state.gauntlets = defaultMeta().gauntlets;
    if (!this.state.name) this.state.name = randomName();
    this.settings = load('settings', defaultSettings());
  }
  persist(): void {
    save('meta', this.state);
    save('settings', this.settings);
  }
  lockedBoons(): string[] {
    return BOONS.filter((b) => b.locked && !this.state.boons.includes(b.id)).map((b) => b.id);
  }
  buyGauntlet(el: Element): boolean {
    if (this.state.gauntlets.includes(el) || this.state.shards < GAUNTLET_COST) return false;
    this.state.shards -= GAUNTLET_COST;
    this.state.gauntlets.push(el);
    this.persist();
    return true;
  }
  buyBoon(id: string): boolean {
    if (this.state.boons.includes(id) || this.state.shards < BOON_COST) return false;
    this.state.shards -= BOON_COST;
    this.state.boons.push(id);
    this.persist();
    return true;
  }
  recordRun(r: { won: boolean; room: number; kills: number; combos: number; shards: number; boss: boolean }): void {
    const s = this.state.stats;
    s.runs++;
    if (r.won) s.wins++;
    s.kills += r.kills;
    s.combos += r.combos;
    s.bestRoom = Math.max(s.bestRoom, r.room);
    if (r.boss) s.bossKills++;
    this.state.shards += Math.round(r.shards);
    this.persist();
  }
}

const A = ['Ember', 'Rime', 'Volt', 'Zephyr', 'Flint', 'Hex', 'Ash', 'Nova', 'Quill', 'Moss', 'Glint', 'Sable'];
const B = ['wright', 'caller', 'weaver', 'born', 'shard', 'mantle', 'spark', 'veil', 'thorn', 'drift'];
export function randomName(): string {
  return A[Math.floor(Math.random() * A.length)] + B[Math.floor(Math.random() * B.length)];
}
