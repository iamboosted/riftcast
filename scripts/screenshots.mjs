// Automated visual + touch verification. Usage:
//   npm run build && npx vite preview --port 4173 &   (serves /riftcast/)
//   node scripts/screenshots.mjs [baseUrl]
// Uses the Playwright install on PATH (PW env var can point at the module). Chromium runs WebGPU on
// SwiftShader here, so frames are slow; ?slowgpu lets the sim catch up and viewports are kept small.
import { mkdirSync, writeFileSync } from 'node:fs';

const pwPath = process.env.PW ?? 'playwright';
const { chromium } = await import(pwPath);
const base = process.argv[2] ?? 'http://localhost:4173/riftcast/';
const outDir = 'screenshots';
mkdirSync(outDir, { recursive: true });
const presets = (process.env.PRESETS ?? 'low,medium,high,ultra').split(',');
const only = process.env.ONLY ?? 'gallery,combat,mobile';
const report = [];
const args = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args });

async function page(vp, mobile = false) {
  const ctx = await browser.newContext({
    viewport: vp,
    hasTouch: mobile,
    isMobile: mobile,
    deviceScaleFactor: 1,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : undefined,
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
  return { p, ctx, errors };
}

const waitFor = async (p, fn, timeout, arg) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await p.evaluate(fn, arg).catch(() => false)) return true;
    await p.waitForTimeout(1500);
  }
  return false;
};

for (const q of presets) {
  if (only.includes('gallery')) {
    const { p, ctx, errors } = await page({ width: 960, height: 540 });
    await p.goto(`${base}vfx-gallery/?quality=${q}&slowgpu`);
    await waitFor(p, () => !!window.__gallery, 60000);
    await p.evaluate(() => window.__gallery.focus(23, 15));
    await p.waitForTimeout(12000);
    // step at real-time resolution and land on the stations' key moments
    await p.evaluate(() => {
      window.__gallery.setMaxDt(1 / 30);
      window.__gallery.seek();
    });
    await p.waitForTimeout(9000);
    const stats = await p.evaluate(() => document.getElementById('g-stats')?.textContent ?? '');
    await p.screenshot({ path: `${outDir}/gallery-${q}.jpg`, type: 'jpeg', quality: 82, timeout: 300000 });
    report.push({ shot: `gallery-${q}`, stats, errors: errors.slice(0, 3) });
    await ctx.close();
  }
  if (only.includes('combat')) {
    const { p, ctx, errors } = await page({ width: 960, height: 540 });
    await p.goto(`${base}?autoplay&bot&slowgpu&quality=${q}`);
    await waitFor(p, () => window.__game?.session?.state.enemies.some((e) => e.spawnT <= 0), 150000);
    // stage a combat moment: face the nearest enemy from ~9 m, then cast at real-time step resolution
    await p.evaluate(() => {
      const g = window.__game;
      g.maxDt = 1 / 30;
      const s = g.session;
      const me = s.state.players.get(s.localId);
      const e = s.state.enemies.find((q) => q.spawnT <= 0);
      if (me && e) {
        const dx = me.pos.x - e.pos.x,
          dz = me.pos.z - e.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > 11) {
          me.pos.x = e.pos.x + (dx / d) * 9;
          me.pos.z = e.pos.z + (dz / d) * 9;
          me.pos.y = e.pos.y;
        }
      }
    });
    await p.waitForTimeout(4000);
    await p.evaluate(() => {
      const g = window.__game;
      // the bot casts its signature whenever demoT crosses a multiple of 9 s
      g.demoT = Math.ceil(g.demoT / 9) * 9 - 0.02;
    });
    await p.waitForTimeout(6000);
    const info = await p.evaluate(() => {
      const g = window.__game;
      return { webgpu: g.gfx.isWebGPU, particles: g.view.fx.particleCount, draws: g.gfx.drawCalls, enemies: g.session.state.enemies.length };
    });
    await p.screenshot({ path: `${outDir}/combat-${q}.jpg`, type: 'jpeg', quality: 82, timeout: 300000 });
    report.push({ shot: `combat-${q}`, ...info, errors: errors.slice(0, 3) });
    await ctx.close();
  }
}

if (only.includes('mobile')) {
  // iPhone 14/15 landscape CSS viewport with touch emulation
  const { p, ctx, errors } = await page({ width: 844, height: 390 }, true);
  const cdp = await ctx.newCDPSession(p);
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) });
  await p.goto(`${base}?slowgpu`);
  await waitFor(p, () => !!window.__game && window.__game.ui.current === 'title', 60000);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${outDir}/mobile-title.jpg`, type: 'jpeg', quality: 82, timeout: 300000 });
  // tap "Play Solo"
  const btn = await p.locator('[data-a="solo"]').boundingBox();
  await touch('touchStart', [[btn.x + btn.width / 2, btn.y + btn.height / 2]]);
  await touch('touchEnd', []);
  const playing = await waitFor(p, () => window.__game.mode === 'play' && window.__game.touch.active, 20000);
  await p.waitForTimeout(4000);
  const before = await p.evaluate(() => {
    const g = window.__game;
    const me = g.session.state.players.get(g.session.localId);
    return { x: me.pos.x, z: me.pos.z, yaw: g.rig.yaw, casts: 0 };
  });
  const layout = await p.evaluate(() => window.__game.touch.layout);
  const prim = layout.buttons.find((b) => b.id === 'primary');
  // count cast events from now on
  await p.evaluate(() => {
    const g = window.__game;
    g.__casts = 0;
    const orig = g.view.handleEvents.bind(g.view);
    g.view.handleEvents = (ev, s, id) => {
      for (const e of ev) if (e.t === 'cast' && e.pid === id) g.__casts++;
      return orig(ev, s, id);
    };
  });
  // left thumb: push stick up-right; right thumb: hold primary and drag to aim
  await touch('touchStart', [[120, 300], [prim.x, prim.y]]);
  const samples = [];
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [[120 + Math.min(40, i * 6), 300 - Math.min(55, i * 8)], [prim.x - i * 4, prim.y]]);
    await p.waitForTimeout(700);
    samples.push(
      await p.evaluate(() => {
        const g = window.__game;
        const me = g.session.state.players.get(g.session.localId);
        if (me) me.hp = me.maxHp; // keep the test mage alive while we drive the controls
        return { mx: g.controls.moveX, my: g.controls.moveY, prim: g.controls.primary };
      }),
    );
  }
  await p.screenshot({ path: `${outDir}/mobile-combat-touch.jpg`, type: 'jpeg', quality: 82, timeout: 300000 });
  const buttonsRendered = await p.evaluate(() => [...document.querySelectorAll('.tbtn')].filter((el) => el.getBoundingClientRect().width > 20).length);
  await touch('touchEnd', []);
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => {
    const g = window.__game;
    const me = g.session.state.players.get(g.session.localId);
    const tb = [...document.querySelectorAll('.tbtn')].map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: el.className, x: r.x, y: r.y, w: r.width, visible: r.width > 0 };
    });
    return { x: me.pos.x, z: me.pos.z, yaw: g.rig.yaw, casts: g.__casts, buttons: tb, touchVisible: g.touch.active };
  });
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  const result = {
    shot: 'mobile',
    playing,
    stickRead: samples.some((s) => s.my > 0.3),
    primaryHeld: samples.every((s) => s.prim),
    moved: +moved.toFixed(2),
    aimTurned: +(after.yaw - before.yaw).toFixed(3),
    casts: after.casts,
    buttonsRendered,
    errors: errors.slice(0, 3),
  };
  result.pass = result.playing && result.stickRead && result.primaryHeld && result.moved > 0.5 && Math.abs(result.aimTurned) > 0.01 && result.casts > 0 && result.buttonsRendered >= 7;
  report.push(result);
  await ctx.close();

  // the gallery on a phone (2-column layout, toolbar wraps, drag to pan)
  const m2 = await page({ width: 844, height: 390 }, true);
  await m2.p.goto(`${base}vfx-gallery/?slowgpu`);
  await waitFor(m2.p, () => !!window.__gallery, 60000);
  await m2.p.evaluate(() => window.__gallery.focus(19, 16));
  await m2.p.waitForTimeout(10000);
  await m2.p.evaluate(() => {
    window.__gallery.setMaxDt(1 / 30);
    window.__gallery.seek();
  });
  await m2.p.waitForTimeout(8000);
  await m2.p.screenshot({ path: `${outDir}/mobile-gallery.jpg`, type: 'jpeg', quality: 82, timeout: 300000 });
  report.push({ shot: 'mobile-gallery', errors: m2.errors.slice(0, 3) });
  await m2.ctx.close();
}

await browser.close();
// merge with an existing report so partial runs (ONLY=...) keep earlier results
let prev = [];
try {
  prev = JSON.parse((await import('node:fs')).readFileSync(`${outDir}/report.json`, 'utf8'));
} catch {}
const merged = [...prev.filter((r) => !report.some((n) => n.shot === r.shot)), ...report];
writeFileSync(`${outDir}/report.json`, JSON.stringify(merged, null, 2));
console.log(JSON.stringify(report, null, 2));
