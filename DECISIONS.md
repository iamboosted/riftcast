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

## Later calls (same day)
- **Pages deploys from `main`.** Pages was enabled while the repo was empty, so the `github-pages` environment only accepts `main`. Development happens on `master` and every push is mirrored to `main`. CI (tests, build, gitleaks) runs on both; the deploy job runs only on `main`.
- **Multiplayer transport: Trystero** (Nostr relays for signalling, then direct WebRTC data channels) rather than PeerJS. There's no broker to rely on, it has several public relay fallbacks, and the API is tiny. It sits behind the `Transport` interface (`src/net/transport.ts`), which also has a deterministic in-memory `LoopbackHub` (virtual clock, latency/jitter, loss on unreliable channels, per-link ordering on reliable ones) for tests. Payloads are JSON strings so the perf overlay can count bytes.
- **Netcode:** the host steps the World at 30 Hz and consumes one queued input per remote player per tick (with a 4-input jitter cap). It broadcasts SimEvents every tick and full snapshots at 15 Hz. Clients:
  - send their last 4 inputs every tick for redundancy;
  - predict their own movement with the same `stepMovement` the host runs, and reconcile on each snapshot's ack (replaying unacknowledged inputs, with the visual correction smoothed out);
  - interpolate everyone else 100 ms in the past;
  - regenerate room geometry locally from `(seed, index)`, since geometry is independent of player count (unit tested);
  - advance telegraph/zone timers between snapshots so wind-ups stay smooth.
- **Spell projectiles aren't predicted on clients.** A client sees its own projectile after ~RTT/2. Cast sound and muzzle flash still fire on the host event. This keeps damage and combos strictly host-authoritative. Predicted cosmetic projectiles are a listed next step.
- **Trust boundary:** the host sanitises every remote input (clamped move vector, aim within ±500 m, 8-bit counters). It validates gauntlets and ignores unknown commands. Clients only accept snapshots and events from the peer that welcomed them. There's an integration test for forged events, forged snapshots, fake damage commands and absurd inputs.
- **Drop-in:** players who join mid-run are `spectating` (their camera follows a living teammate) and spawn at the next room. Reward completion only waits for players who were offered rewards.
- **Bosses can't skip phases:** damage clamps HP just under the next threshold until the phase transition plays, followed by 1.8 s of invulnerability with a shockwave telegraph. Without this, burst combos could delete a boss through two phases at once.
- **Dynamic lights:** a fixed pool of point lights (2/4/6 by preset) flashes on explosions, novas, strikes and combos, and follows glowing heavy projectiles. The light count never changes, so there are no shader recompiles.
- **3D spikes:** instanced erupting cones (ice and rock materials) for Whiteout, frost patches, Glacier Lance paths, Shatter, Flash Freeze, Bulwark walls and boulder impacts. Frost and Stone get real silhouettes rather than only sprites.
- **Pings:** G / D-pad up / tap ping is contextual ("attack" when the crosshair is on an enemy, otherwise "here"). H / D-pad down = help, C / D-pad left = combo. On touch, long-press ping opens a 4-way wheel. Markers are 3D beacons plus screen-space labels that clamp to the screen edge.
- **The touch HUD moves to the top-left** so both bottom corners stay free for thumbs. Safe-area insets are measured from a probe element, since `env()` can't be read back from CSS variables.
- **Shader warm-up:** after the title appears, one of every actor and element material is built off-screen and passed to `renderer.compileAsync`, so first casts don't hitch.
- **Test-only URL flags:** `?bot` (the local mage auto-fights and auto-picks boons), `?slowgpu` (lets the sim catch up with 0.5 s frames on software renderers), `?autoplay`, `?webgl`, `?quality=`.
- **Arena shader cost scales with quality:** Low drops two noise octaves on the sky, floor and rock shaders.
- **Elite affixes** add variety without new models. Elites always roll one; ordinary foes roll one 15% of the time from room 4.
  - *Shielded* absorbs 85% of incoming damage from a pool of 45% max HP, shown as a fresnel bubble that bursts when broken.
  - *Hasted* gets 1.4× speed and 0.7× attack cooldowns.
  - *Volatile* leaves a telegraphed 3.6 m death blast.
  - *Warded:X* takes 10% damage from element X, where X is never an element the faction already resists. That pushes swaps and combos.
  - Affixes replicate in snapshots and show in an aim readout (name, affix, HP and shield bars) above the crosshair.
- **Combo Codex + tips:** combos only matter if players find them. `combos.json` rules carry a `desc`, and the Codex screen (title and pause) renders straight from the table. Each of the first four rooms shows a tip matched to your two gauntlets.
- **Mage arms** are separate pivoted meshes sharing the body material and FX uniform. Casting snaps the right arm to the aim pitch; charging brings both hands forward. It's cheap procedural animation that reads at gameplay distance.
- **Client prediction covers charge and heavy release too.** The charge glow follows local input immediately, and the release flash is predicted, with the host's matching cast event suppressed (FIFO, 1 s window). Damage stays host-only.
- **Reduce flashes** (Settings) caps screen flash, chromatic aberration and camera trauma for photosensitive players.
- **Edge guard:** grounded walking can't step into the void. Only jumps, dashes and knockback in the air can. The guard lives in the shared `stepMovement`, so prediction matches the host.
