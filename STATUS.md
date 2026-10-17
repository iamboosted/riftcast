# Riftcast — Status

**Live:** https://iamboosted.github.io/riftcast/  ·  **VFX gallery:** https://iamboosted.github.io/riftcast/vfx-gallery/

Deployed by GitHub Actions from `main` (mirrored from `master`). Every push runs gitleaks, the test suite and a production build before deploying. The deploy job's success is the deploy confirmation: this sandbox's network policy blocks `*.github.io`, so I couldn't load the live page from here.

## What works

**Core loop (solo and co-op)**
- Title → (solo | host | join by code or link) → 7-room run (combat, combat, elite, combat, combat, elite, boss) → victory or defeat → shards → unlocks.
- Reward screen after every room: pick 1 of 3 personal boons (sometimes a gauntlet find) and vote on 1 of 3 team boons.
- Meta progression in localStorage (try/catch everywhere): shards, gauntlet unlocks (Fire/Frost/Storm start unlocked), rare-boon unlocks and run records.

**Combat**
- 6 gauntlets × (primary / charged heavy / signature) = 18 spells. You equip two and swap mid-fight.
- 14 data-driven interactions in `src/data/combos.json`:
  - Gale vortex + Fire/Venom/Frost/Storm → Firestorm, Toxic Tempest, Blizzard, Thunderhead
  - Fire + venom → Detonation, which chains between clouds
  - Storm + water/frost → Chain Surge across the puddle network
  - Stone + frozen → Shatter
  - Fire + frost → Steam Burst (blinds)
  - Frost + puddle → Flash Freeze
  - Storm + wet → Conduction
  - Walls block projectiles, reflect Gale, and turn to Magma Walls when hit with Fire
- Combos credit every contributor, show a big COMBO callout with their names, and trigger hit-stop, CA and a stinger.

**Movement**
- Fast strafing, double jump, hover, dash with i-frames and afterimages.
- Rune pickups: Blink (dash teleports), Glide (long hover), Rocket (double jump blasts).
- Edge guard: walking never carries you off an island; jumping or dashing off still does.

**Enemies**
- 3 factions × 3 archetypes with procedural silhouettes and per-faction weaknesses/resistances: Cinderborn, Glasswing Swarm, Mirehollow.
- Telegraphed circle/ring/line/cone ground decals that fill toward impact. Jumping clears rings and lines.

**Bosses**
- *Ignavar, the Kiln Heart* and *Sylvara, the Hollow Prism*, each with 3 phases.
- Phase gating: bursts can't skip phases. Each transition plays an invulnerable shockwave.

**Down / revive**
- 30 s bleed-out. Standing next to a downed ally auto-channels the revive (works with no extra button on touch).
- Solo gets one Second Wind per run and scaled enemy HP/damage.

**VFX pipeline**
- **Particles:** TSL compute (spawn kernel + update kernel over storage buffers) with an identical CPU path on WebGL2. Curl-style turbulence, 4 attractors, floor bounce, colour/size over life, velocity-stretched sparks, soft particles on High+.
- **Shader toolkit:**
  - Fresnel rims and noise-threshold dissolve with a glowing edge
  - Scrolling-noise ribbons
  - Branching lightning (recursive midpoint displacement + forks)
  - Instanced shockwave rings and domes
  - Heat-distortion billboards
  - Procedural decals: scorch with cooling embers, voronoi frost, bubbling ooze, rippling water, electric arcs, rune circles, telegraphs
  - Erupting instanced ice/rock spikes
  - Solid projectile meshes (rocks, rolling boulder, ice crystals, gale crescents)
  - Pooled dynamic point lights
- **Post:** HDR bloom, chromatic aberration spiking on big hits, trauma camera shake, hit-stop, screen flashes, hurt vignette, desaturate while downed.
- **Quality presets:** Low/Med/High/Ultra with auto-detect (mobile → Low) and dynamic resolution (0.6–1.0×) to hold 60 fps.
- **`/vfx-gallery`:** 42 looping stations (18 spells, 12 combos, 6 impacts, 6 misc incl. telegraphs, dash/blink, spawn/death, co-op feedback, both bosses). It has slow-mo, particle/draw/fps readout, a quality switch, category jumps, drag-to-pan and ± zoom, and a 2-column layout on phones.

**Audio:** fully procedural WebAudio:
- Per-element cast/impact voices
- Thunder, combo stingers, UI cues
- Ambient drone + wind bed, plus a combat pulse that follows intensity
- Unlocks on first tap (iOS). Mute is in Settings or on M.

**Multiplayer**
- Trystero WebRTC behind a `Transport` interface; host-authoritative.
- Clients predict movement (with reconciliation) and primary shots (adopted by host copies); everyone else interpolates 100 ms behind.
- Room code + share link (native share sheet when available), ready-up lobby, drop-in between rooms (late joiners spectate a teammate).
- Quick-chat pings (here/attack/help/combo) with 3D beacons and edge-clamped labels; long-press ping wheel on touch.

**Controls**
- Mouse/keyboard with pointer lock (losing the lock pauses), plus gamepad.
- Full touch: twin sticks, hold-to-autofire, hold-to-charge, drag-to-aim on cast buttons, aim assist, all buttons thumb-sized off-centre and safe-area aware.
- Tap menus everywhere.
- iOS hardening: no pinch/double-tap zoom, rubber-band or selection; portrait rotate prompt; PWA manifest (fullscreen, landscape).

**Perf overlay** (Settings or F3): fps, backend, preset + DPR, particles (GPU/CPU), draw calls, enemies/zones/projectiles, net peers/RTT/kbps/snapshot rate/pending inputs.

## Tests (`npm test`, 42 passing)

- **Multiplayer integration** (`tests/net.test.ts`): host + 3 clients on the lossy loopback (45 ms ± 15 ms, 8% loss on unreliable channels).
  - Convergent state through a scripted room (enemies, HP, positions; predicted local player within 0.25 m)
  - Cross-caster Firestorm credited to both casters and seen by every client
  - Host damage authority vs forged events, snapshots, commands and absurd inputs
  - Downed → walk over → channel revive
  - Mid-run drop-in joining at the next room
  - Prediction adoption with no doubled projectiles
  - Host-leave notice
- **Unit** (`tests/unit.test.ts`): combo table shape, resolution and priority; end-to-end combo credit; melt → puddle → electrify chain; boon stacking (sum/multiply, caps, max stacks, deterministic rolls); seeded room determinism; geometry independent of player count; damage math; touch layout (4 phone sizes: on-screen, safe areas, no overlap, centre clear), stick mapping, look/rim turn; lightning determinism; telegraph shapes; input sanitising; movement (ledges, hover, edge guard).
- **Full runs** (`tests/run.test.ts`): a boosted bot clears all 7 rooms and both bosses through 3 phases; every gauntlet casts all 3 slots.

## Screenshots (Playwright + Chromium, WebGPU on SwiftShader)

`node scripts/screenshots.mjs` (after `npm run build && npx vite preview --port 4173`) writes to `screenshots/`:
- `gallery-{low,medium,high,ultra}.jpg`: gallery stations frozen on their key moments
- `combat-{low,medium,high,ultra}.jpg`: a staged combat moment with the bot mage casting
- `mobile-title.jpg`, `mobile-combat-touch.jpg`: iPhone-landscape viewport (844×390) with touch emulation

The mobile pass taps *Play Solo*, then drives the left stick and holds the primary button while dragging to aim. It asserts that the stick moved the mage, the aim turned, casts fired and all 7 touch buttons rendered. Results are in `screenshots/report.json`.

**Latest run:** all 8 preset shots + 3 mobile shots captured with **zero page errors** on WebGPU (compute particles active at every preset). Mobile touch run: `pass: true`:
- *Play Solo* reached via tap
- Left stick read (moveY > 0.3) and moved the mage 32 m
- Primary held for the whole drag; drag-on-primary turned the aim 0.28 rad
- 136 casts fired; 7/7 touch buttons rendered
- The WebGL2 fallback (`?webgl`, CPU particles) was also rendered and checked during development.

## Perf numbers

There's no physical GPU in this environment; Chromium renders WebGPU through SwiftShader on the CPU, so fps here (0.2–4) says nothing about real devices. What I could measure:

| Measure | Result |
|---|---|
| CPU per frame (JS, all systems, ~5 enemies, High) | ~4.8 ms: view sync 2.7, render submit 1.1, particle command packing 0.5, HUD 0.06 |
| Host sim tick (4 players, 12–24 enemies, zones, spells firing) | 0.73 ms avg |
| Snapshot (4 players, 14 enemies, 8 zones) | 2.6 KB → ~320 kbit/s per client at 15 Hz (meta only on change) |
| Draw calls in combat | ~50–80 (particles 2, all decals 8, rings 2, strips 1, cores 1, spikes 2, projectile meshes 3) |
| Particle pools | GPU 16k / 32k / 64k / 131k (Low → Ultra); CPU fallback 4k / 8k / 12k / 16k |

**Expected on real hardware.** Untested:
- A mid laptop at Medium: comfortably 60 fps. GPU cost is dominated by the noise-heavy floor/sky shaders and bloom at half resolution.
- A recent iPhone: auto-picks Low (DPR ≤ 1, fewer noise octaves, 2 lights, 0.3× bloom), and dynamic resolution backs off further if frames exceed 19.5 ms.

## What's rough

- **Never run on a real iPhone or a real GPU.** Touch was verified only in Chromium's iPhone emulation, and 60 fps is a design target, not a measurement.
- **Co-op over the real internet is untested.** Relays and NAT traversal can't be reached from this sandbox. All netcode logic is covered on the loopback transport, but strict NATs without TURN may fail to connect.
- **Balance is first-pass.** Numbers were set by reasoning, not playtesting. The bot clears runs only with a damage boost.
- **Animation is minimal:** bobbing, leaning, wing flaps and spinning parts, with no limb animation.
- **Only the primary attack is predicted** on clients. Heavies and signatures appear after RTT/2.
- **Enemy navigation is steering-only:** no pathfinding around ledges or walls.
- **Audio has never been heard.** Everything is synthesised, and levels were set by reasoning.
- **The gallery's showroom floor is a flat plain**, and stations very close together can bleed into each other's frame.

## Weakest VFX (my honest ranking)

1. **Steam Burst / venom clouds:** smoke is still sprite-based. Sphere-impostor shading gives it volume, but without soft depth on Low/Med it can read as stacked cards.
2. **Venom pools:** now glossy wobbling glob/flask meshes in flight, but the ground pools are still a simple bubbling decal.
3. **Shockwave domes:** fresnel shells read better than before but can still look like a translucent disc from above.
4. **Stone dust:** the brownish alpha puffs are muddy against stone floors.
5. **Telegraph decals on raised ledges** are drawn at the ledge height only; shapes overlapping a ledge edge don't drape.

## Top 5 next steps

1. **Real-device pass:** profile on an iPhone (Safari 26 WebGPU) and a mid laptop, then tune the presets, particle budgets and floor/sky shader cost from real numbers.
2. **Netcode feel:** predict heavy/signature casts, add lag-compensated hit checks for fast projectiles, add host migration/reconnect, and add an optional TURN config for strict NATs.
3. **Animation:** procedural limbs (IK arms for casting, gait for walkers), hit reactions and death poses.
4. **Content depth:** elite modifiers, a third faction boss, more boons with build-defining synergies, room events (rift surges, treasure rooms) and a run map with branching.
5. **Smoke/volumetrics upgrade:** lit, depth-faded volumetric puffs (sphere-impostor normals) for steam/venom/dust, and draped telegraphs via projected decals.
