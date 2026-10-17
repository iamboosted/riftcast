import type { Element } from '../sim/types';

export interface ElementInfo {
  id: Element;
  name: string;
  gauntlet: string;
  /** bright core, main, dark — hex */
  core: number;
  main: number;
  dark: number;
  /** CSS color for UI */
  css: string;
  glyph: string;
  motto: string;
  spells: { primary: string; heavy: string; signature: string };
  spellDesc: { primary: string; heavy: string; signature: string };
}

export const ELEMENT_INFO: Record<Element, ElementInfo> = {
  fire: {
    id: 'fire',
    name: 'Fire',
    gauntlet: 'Cinderheart',
    core: 0xffe08a,
    main: 0xff6a1a,
    dark: 0xb81e00,
    css: '#ff7a2a',
    glyph: '▲',
    motto: 'Rising embers, roaring bursts.',
    spells: { primary: 'Ember Bolt', heavy: 'Sunburst Orb', signature: 'Inferno Nova' },
    spellDesc: {
      primary: 'Rapid fire bolts that ignite.',
      heavy: 'Charge a sun orb; leaves burning ground.',
      signature: 'Expanding ring of flame around you.',
    },
  },
  frost: {
    id: 'frost',
    name: 'Frost',
    gauntlet: 'Rimeglass',
    core: 0xeefcff,
    main: 0x6fd8ff,
    dark: 0x2a6bff,
    css: '#7fdcff',
    glyph: '◆',
    motto: 'Sharp crystals, frozen stillness.',
    spells: { primary: 'Shard Volley', heavy: 'Glacier Lance', signature: 'Whiteout' },
    spellDesc: {
      primary: 'Fan of ice shards that chill.',
      heavy: 'Piercing lance that paves frost.',
      signature: 'Flash-freeze a wide area.',
    },
  },
  storm: {
    id: 'storm',
    name: 'Storm',
    gauntlet: 'Voltspire',
    core: 0xf6f2ff,
    main: 0xa77bff,
    dark: 0x4b2bff,
    css: '#b48cff',
    glyph: 'ϟ',
    motto: 'Jagged arcs, instant fury.',
    spells: { primary: 'Arc Bolt', heavy: 'Thunder Spear', signature: 'Tempest Call' },
    spellDesc: {
      primary: 'Lightning that chains between foes.',
      heavy: 'Spear that calls a sky strike.',
      signature: 'Rain lightning on the target zone.',
    },
  },
  gale: {
    id: 'gale',
    name: 'Gale',
    gauntlet: 'Skein of Winds',
    core: 0xf4fffa,
    main: 0x8ff5d0,
    dark: 0x2bb58e,
    css: '#8ff5d0',
    glyph: '≋',
    motto: 'Spiralling currents, relentless push.',
    spells: { primary: 'Razor Gust', heavy: 'Cyclone', signature: 'Updraft' },
    spellDesc: {
      primary: 'Crescent blades that shove.',
      heavy: 'Roaming vortex that pulls foes.',
      signature: 'Launch skyward, blast foes away.',
    },
  },
  stone: {
    id: 'stone',
    name: 'Stone',
    gauntlet: 'Bedrock Fist',
    core: 0xffe2b0,
    main: 0xd08a48,
    dark: 0x6b4426,
    css: '#d9955a',
    glyph: '■',
    motto: 'Heavy chunks, unbreakable walls.',
    spells: { primary: 'Pebble Barrage', heavy: 'Boulder', signature: 'Bulwark' },
    spellDesc: {
      primary: 'Heavy stones that stagger.',
      heavy: 'Rolling boulder that crushes.',
      signature: 'Raise a wall that blocks shots.',
    },
  },
  venom: {
    id: 'venom',
    name: 'Venom',
    gauntlet: 'Mirefang',
    core: 0xf2ffb8,
    main: 0x9cff3a,
    dark: 0x7a2bd6,
    css: '#a8ff4a',
    glyph: '●',
    motto: 'Bubbling ooze, creeping rot.',
    spells: { primary: 'Spit Glob', heavy: 'Plague Flask', signature: 'Miasma' },
    spellDesc: {
      primary: 'Arcing globs that pool.',
      heavy: 'Flask that bursts into a toxic cloud.',
      signature: 'Exhale a choking cloud around you.',
    },
  },
};

export const PLAYER_COLORS = [0x5ad1ff, 0xff6ad5, 0xffd34a, 0x7dff8a];
