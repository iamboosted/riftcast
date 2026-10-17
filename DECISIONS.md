# Design decisions

A running log of design calls, with the reasoning behind each.

## Stack and deploy
- **Vite 8 + TypeScript + three r186 (`three/webgpu`, `three/tsl`) + Vitest.** `WebGPURenderer` falls back to WebGL2 by itself; `?webgl` forces the fallback for testing.
- **Vite `base` = `/riftcast/`** (overridable with `BASE_PATH`) for the GitHub Pages project subpath.
- **The VFX gallery is a second Vite entry at `/vfx-gallery/`**, so it's a real path on Pages (no SPA 404 tricks).
- **CI** (`.github/workflows/ci.yml`): a gitleaks scan of the full history, then `npm test` + `npm run build` on every push. Pages deploys only from `master`, after both pass. Gitleaks runs from the pinned release binary rather than the marketplace action, which needs a license key for org accounts.
- **Icons** are drawn by `scripts/gen-icons.mjs` (a tiny PNG encoder) before each build, and the SVG icon is hand-written markup. No binary assets live in the repo. Manifest icons have to be URLs, so they can't be generated in the page at runtime.
- **The TSL typings shim (`src/render/tsl.ts`)** re-exports `three/tsl` as `any`. @types/three's node types reject valid shader graphs (e.g. `uniform(Color)` used as vec3), and fighting them costs more than it protects. Everything outside shader code stays strictly typed.
- **The texture-view swizzle shim (`gfx.ts`):** r186 always sends `swizzle: 'rgba'`, and some shipping Chromium builds implement an older draft and throw on it. Since 'rgba' is the identity, the shim strips it.

## Simulation
- **The sim is pure TypeScript** (`src/sim`) with no three.js dependency, running at a fixed 30 Hz with deterministic seeded RNG (mulberry32). That lets the host + 3 clients integration tests run headless in Vitest.
- **The world is the authority on everything:** enemies, damage, zones, combos, loot, rewards. Presentation only consumes state and `SimEvent`s.
- **Edge actions** (dash, jump, signature, swap) are sent as monotonically increasing 8-bit counters instead of "pressed" booleans, so a dropped input packet can't eat a press.
- **Arenas are a union of circular platforms** (main island + lobes + raised ledges reachable by double jump), plus pillars. Collision is simple circle/segment math. Off-edge means void: you respawn at the last safe spot for 10% HP. Enemies knocked off die (a Gale reward).
- **Yaw conventions:** players face −Z at yaw 0 (camera-style), enemies face +Z (`atan2(dx,dz)`). Both map straight onto `rotation.y`.
- **Status effects:** burn (DoT), chill → frozen at 100, shock (micro-stun), wet (+40% storm damage), poison (stacking DoT), blind (wander, no attacks), stagger (interrupts non-elite windups).
- **Combos are data** (`src/data/combos.json`): ordered rules matching reagents `{kind: projectile|zone|status|blast, element, tag}` in either order, with effect types `transform | explode | spawn | electrify | shatter | chain | reflect | block`. The resolver (`comboTable.ts`) is a pure function and unit tested.
- **Combo credit:** every zone tracks its contributors, and statuses track who applied them (`statusBy`). A combo credits the union of everyone involved, increments their combo stat, and triggers team heal-on-combo boons.
- **Detonations chain:** a combo explosion is itself a fire blast, so it can set off neighbouring venom clouds (recursion capped at depth 4).
- **Frost patches melt into water puddles** when they expire, which sets up Storm's Chain Surge. Fire on frost makes Steam, which blinds and wets.
- **Stone walls** are zones with a segment collider. They block every projectile except arcing shots above wall height. Gale projectiles and vortices reflect off them, and fire turns them into damaging Magma Walls.
- **Difficulty scaling:** enemy HP ×(1 + 0.5·(players−1)) × (1 + 0.11·depth), with solo getting −15% HP and −20% damage. Solo also gets one **Second Wind** self-revive per run.
- **Downed/revive:** at 0 HP you're downed with a 30 s bleed-out. Revive needs no button press: an ally standing within 2.6 m channels it automatically over 2.6 s, which works on touch without an extra button. Players who die or bleed out return at the next room with 35% HP. If everyone is down, the run is lost.
- **Run structure:** 7 rooms: combat, combat, elite, combat, combat, elite, boss. Each run picks one of two bosses by seed. After every room, each player picks 1 of 3 personal boons (sometimes one slot is a gauntlet find that replaces your off-hand gauntlet) and votes on 1 of 3 team boons (majority wins, ties go to offer order).
- **Boon stacking:** `add` mods sum and `mul` mods multiply, with a per-boon stack cap and global caps (crit ≤ 75%, damage taken ≥ 40%, …).

## Visuals
- **One shared particle system per blend mode** (additive + alpha) rather than per-emitter meshes: two draw calls for all particles. On WebGPU, spawn and update run as TSL compute kernels over storage buffers. The CPU uploads only a small command list per frame (≤96 commands × 8 vec4), and a spawn kernel scatters them into a ring buffer. On WebGL2 the identical maths runs in JS on a compact pool (swap-remove), uploading 4 vec4 per live particle.
- **Turbulence** is an analytic divergence-free field (the curl of a sinusoidal vector potential, two octaves). It's cheap, identical on CPU and GPU, and looks like curl noise.
- **The particle sprite atlas** (4×4 shapes: glow, spark, flame, smoke, shard, ring, flare, bubble, rock, wisp, zap, blob, flake, ember, chip, plus) is drawn with Canvas2D at boot.
- **Each element has its own visual language:** Fire rises and flickers (negative gravity, curl turbulence, flame/ember shapes, smoke). Frost bursts sharp and falls (shards, flakes, high drag, gravity). Storm is instant and jagged (short-lived stretched sparks, zap sprites, branching bolts). Gale swirls (ring emission, wisps, tangential velocity, dashed ribbons). Stone is heavy (alpha-blended rock chunks with floor bounce, dust). Venom bubbles and drips (blobs, bubbles, slow green/violet clouds).
- **Ribbons and lightning share one camera-facing strip renderer** (one draw call). Lightning is recursive midpoint displacement plus forked branches, regenerated every 50 ms for flicker.
- **Decals** are instanced ground quads with procedural TSL shaders: scorch with cooling ember cracks, voronoi frost, bubbling ooze, rippling water, flickering electric arcs, rune circles, and the telegraph decals (fill progress plus a hot edge). Zones re-submit their decals every frame, while impacts add transient ones.
- **Post:** HDR scene pass → bloom → a custom composite pass that does chromatic aberration (radial R/B offsets, spiked on big hits), a full-screen flash, a red hurt vignette, desaturation while downed, and a saturation grade. Camera shake is trauma-based. Hit-stop slows presentation to 8% and freezes the sim in solo only; in co-op it's presentation-only so the host never stalls.
- **Heat distortion** samples `viewportSharedTexture` with noisy offsets on billboards. It's High/Ultra only because it costs a framebuffer copy.
- **Quality presets** (Low/Med/High/Ultra) scale particle pools, DPR cap, bloom resolution, distortion, soft particles and decor density. Mobile auto-selects **Low** (DPR ≤ 1). A dynamic-resolution loop nudges the pixel ratio between 0.6× and 1× to hold 60 fps.
- **Actors** are procedural primitive kits merged into one geometry per actor, with per-vertex colour and a `glow` attribute. Per-object uniforms (`onObjectUpdate`) drive hit flash, the death dissolve (noise threshold with a glowing edge), and frozen/poison tints, so materials are shared by faction.

## Audio
- **All WebAudio, no samples.** Oscillators, filtered noise, FM bells, a generated reverb impulse, and a compressor on the master bus. Each element has a cast and impact signature: fire crackle+thump, frost FM glass, storm saw-zap+thunder, gale band-swept whoosh, stone sub-thud+grit, venom pitch-bend bloops. Combo stingers are a reverse swell, a boom, and a chord chosen by hashing the combo name. The ambient bed is a detuned-saw drone with LFO filter and wind, plus a combat pulse whose tempo and level follow enemy count.
- **iOS unlock:** the AudioContext is created and resumed inside the first pointer/touch/key handler, and a silent buffer is played in that same gesture.

## Input
- **Touch:** a floating move stick on the left 42%. The right side is an aim stick: drag maps 1:1 to camera rotation, and pushing to the rim keeps turning. The cast buttons (primary/heavy) also aim while held and dragged, so a single thumb can fire and steer. The button layout is computed by a pure function (`touchLayout.ts`), unit tested to keep the central action area clear and every button on-screen inside the safe-area insets.
- **Aim assist:** the cast direction snaps to the enemy nearest the crosshair inside a cone: 11° touch, 7° pad, 1.5° mouse. It can be turned off in Settings.
