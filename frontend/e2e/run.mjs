// FloodLens browser end-to-end journey (desktop + mobile) using the installed Google Chrome.
// Starts the TEST-ONLY fixture backend (real app code + real PostgreSQL, fixture external
// providers), builds the web app against it, serves it with `vite preview`, and drives Chrome.
//
// Usage (from frontend/):  npm run e2e
// Screenshots: e2e/screenshots/
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');
const backend = path.resolve(frontend, '..', 'backend');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });

const API = 'http://localhost:5099';
const WEB = 'http://localhost:4173';
const children = [];
const results = [];
let failed = false;

function start(cmd, args, cwd, env = {}) {
  const child = spawn([cmd, ...args].join(' '), { cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${cmd}] ${d}`));
  child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${cmd}] ${d}`));
  children.push(child);
  return child;
}

async function waitFor(url, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed = true;
    results.push(['FAIL', name, error.message]);
    console.log(`  ✖ ${name}\n      ${error.message.split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Frees a TCP port left occupied by a previous crashed run (Windows only). */
function freePort(port) {
  if (process.platform !== 'win32') return;
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
  const pids = new Set(
    out
      .split('\n')
      .filter((l) => l.includes(`:${port} `) && l.includes('LISTENING'))
      .map((l) => l.trim().split(/\s+/).pop()),
  );
  for (const pid of pids) if (pid && pid !== '0') spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
}

async function stopFixtureServer() {
  try {
    await fetch(`${API}/__test/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    await new Promise((r) => setTimeout(r, 2500)); // let PostgreSQL shut down cleanly
  } catch {
    /* already stopped */
  }
}

function cleanup() {
  for (const c of children) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
}
process.on('exit', cleanup);

async function main() {
  for (const port of [5099, 4173, 54332]) freePort(port);
  if (process.platform === 'win32') {
    // Orphaned workers of a crashed test database keep its port open; target only the throwaway .pge2e cluster.
    spawnSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { $_.CommandLine -like '*.pge2e*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { stdio: 'ignore' },
    );
  }
  console.log('Starting fixture backend…');
  start('npx', ['tsx', 'test/e2e-server.ts'], backend);
  console.log('Building web app against it…');
  const build = spawnSync('npm run build --workspace=@floodlens/web', {
    cwd: frontend,
    shell: true,
    env: { ...process.env, VITE_API_URL: API },
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`Build failed:\n${build.stdout}\n${build.stderr}`);
  start('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], path.join(frontend, 'apps', 'web'));
  await waitFor(`${API}/api/health`);
  await waitFor(WEB);

  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.E2E_HEADED });
  const consoleErrors = [];
  const watch = (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error' && !/tile\.openstreetmap|Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
  };

  // ---------------- Desktop journey ----------------
  console.log('\nDesktop (1366×860)');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, geolocation: { latitude: 28.6139, longitude: 77.209 }, permissions: [] });
  const page = await ctx.newPage();
  watch(page);
  const cards = page.locator('.fl-card');
  const pressed = (name) => page.getByRole('button', { name: new RegExp(`^${name}`) }).first();

  await step('1. Welcome page renders with disclaimer', async () => {
    await page.goto(WEB);
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert(await page.getByRole('button', { name: /Plan a Safer Route/ }).first().isVisible(), 'CTA missing');
    assert(/not guarantees of safety/.test(await page.textContent('body')), 'disclaimer missing');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '01-welcome.png'), fullPage: true });
  });

  await step('2. Plan a Safer Route opens the planner', async () => {
    await page.getByRole('button', { name: /Plan a Safer Route/ }).first().click();
    await page.waitForURL(/#plan$/);
    await page.locator('.fl-leaflet').waitFor();
    assert((await page.getByRole('combobox', { name: 'Start', exact: true }).inputValue()).includes('Connaught Place'), 'default origin missing');
  });

  await step('3. Destination autocomplete selects a place', async () => {
    await page.getByRole('combobox', { name: 'Destination', exact: true }).fill('Kashm');
    const option = page.getByRole('option', { name: /Kashmere Gate ISBT/ });
    await option.waitFor({ timeout: 10000 });
    await option.click();
    assert((await page.getByRole('combobox', { name: 'Destination', exact: true }).inputValue()).startsWith('Kashmere Gate ISBT'), 'destination not set');
  });

  await step('4. Routes calculated: 2 real candidates with score, level and reason', async () => {
    await cards.first().waitFor({ timeout: 20000 });
    assert((await cards.count()) === 2, `expected 2 cards, got ${await cards.count()}`);
    const text = await cards.first().textContent();
    assert(/\d+\/100/.test(text) && /(Low|Moderate|High) assessed risk/.test(text), 'risk score/level missing');
    assert(/Minto Bridge/.test(await cards.nth(0).textContent()), 'reason should name the hotspot on route A');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '02-routes.png') });
  });

  await step('5. Fastest / Balanced / Lower Risk switch the selected route', async () => {
    await pressed('Fastest').click();
    assert((await cards.nth(0).getAttribute('aria-pressed')) === 'true', 'Fastest should select A');
    await pressed('Lower Risk').click();
    assert((await cards.nth(1).getAttribute('aria-pressed')) === 'true', 'Lower Risk should select B');
    await pressed('Balanced').click();
    assert((await page.locator('.fl-card[aria-pressed="true"]').count()) === 1, 'exactly one selected');
  });

  await step('6. Selecting a card highlights its geometry on the map', async () => {
    await pressed('Fastest').click();
    await cards.nth(1).click();
    assert((await cards.nth(1).getAttribute('aria-pressed')) === 'true', 'card B not selected');
    const selectedPaths = await page.locator('path.leaflet-interactive[stroke="#1d4ed8"]').count();
    assert(selectedPaths === 1, `expected 1 highlighted route path, got ${selectedPaths}`);
    // Clicking the other route on the map selects it.
    const point = await page.evaluate(() => {
      const p = document.querySelector('path.leaflet-interactive[stroke="#7c8db5"]');
      if (!p) return null;
      const pt = p.getPointAtLength(p.getTotalLength() / 3);
      const m = p.getScreenCTM();
      return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
    });
    assert(point, 'unselected route not drawn');
    await page.mouse.click(point.x, point.y);
    assert((await cards.nth(0).getAttribute('aria-pressed')) === 'true', 'map click did not select route A');
  });


  await step('6b. Directions: turn-by-turn for the selected route, hotspot flagged, in-app Start', async () => {
    await pressed('Fastest').click();
    await page.getByRole('button', { name: /^Directions/ }).click();
    const view = page.locator('.fl-directions');
    await view.waitFor();
    const items = view.locator('.fl-steps li');
    assert((await items.count()) === 3, `expected 3 steps, got ${await items.count()}`);
    assert(/Head north on Minto Road/.test(await items.first().textContent()), 'first instruction wrong');
    assert(/Arrive at your destination on the left/.test(await items.last().textContent()), 'arrive instruction wrong');
    assert(/Historical hotspot: Minto Bridge Underpass/.test(await view.textContent()), 'hotspot not flagged on its step');
    assert(await view.getByRole('button', { name: /^Start$/ }).isVisible(), 'in-app Start missing');
    assert(await view.getByRole('button', { name: /^Simulate$/ }).isVisible(), 'Simulate missing');
    assert((await page.locator('a[href*="google.com/maps"]').count()) === 0, 'no Google Maps hand-off expected');
    await items.nth(1).getByRole('button').click();
    assert((await items.nth(1).getByRole('button').getAttribute('aria-current')) === 'step', 'step not focused');
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(shots, '02b-directions.png') });
    await view.getByRole('button', { name: /All routes/ }).click();
    await cards.first().waitFor();
  });

  await step('6c. Live navigation: follows GPS, advances turns, warns of hotspot, reroutes, arrives', async () => {
    const nctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, permissions: ['geolocation'], geolocation: { latitude: 28.6315, longitude: 77.2167, accuracy: 8 } });
    const n = await nctx.newPage();
    watch(n);
    try {
      await n.goto(WEB + '/#plan');
      await n.getByRole('combobox', { name: 'Destination', exact: true }).fill('Kashm');
      await n.getByRole('option', { name: /Kashmere Gate ISBT/ }).click();
      await n.locator('.fl-card').first().waitFor({ timeout: 20000 });
      await n.getByRole('button', { name: /^Fastest/ }).first().click();
      await n.locator('.fl-route-actions').getByRole('button', { name: /Start/ }).click();
      const banner = n.locator('.fl-nav-banner');
      await banner.getByText('Turn right onto Bhavbhuti Marg').waitFor({ timeout: 15000 });
      { const dist = await n.locator('.fl-nav-distance').textContent(); assert(/[0-9]/.test(dist), 'distance to next turn missing: ' + JSON.stringify(dist)); }
      assert(/Minto Bridge Underpass/.test(await n.locator('.fl-nav').textContent()), 'hotspot warning missing at start');
      assert(await n.locator('.fl-topbar').isHidden(), 'map should be full screen while navigating');
      assert((await n.locator('.fl-user-dot, .fl-user-arrow').count()) === 1, 'user position marker missing');
      // Follow mode zooms to street level on the first fix (guards a Leaflet zoom-animation race).
      await n.waitForFunction(() => [...document.querySelectorAll('img.leaflet-tile')].some((i) => Number(i.src.split('/').slice(-3)[0]) >= 16), null, { timeout: 5000 });
      await n.waitForTimeout(700);
      await n.screenshot({ path: path.join(shots, '09-navigation.png') });

      // Drive past the turn: the next instruction becomes the arrival.
      await nctx.setGeolocation({ latitude: 28.652, longitude: 77.2242, accuracy: 8 });
      await nctx.setGeolocation({ latitude: 28.6597, longitude: 77.2263, accuracy: 8 });
      await banner.getByText(/Arrive at your destination/).waitFor({ timeout: 10000 });
      assert((await n.locator('path[stroke="#94a3b8"]').count()) === 1, 'travelled part of the route not drawn');

      // Leave the route: two off-route fixes trigger a reroute request.
      await nctx.setGeolocation({ latitude: 28.62, longitude: 77.25, accuracy: 8 });
      await n.waitForTimeout(300);
      await nctx.setGeolocation({ latitude: 28.6201, longitude: 77.2502, accuracy: 8 });
      await n.locator('.fl-nav').getByText(/Route updated from your current position|Could not find a new route/).first().waitFor({ timeout: 10000 });

      // Reach the destination.
      await nctx.setGeolocation({ latitude: 28.6675, longitude: 77.2283, accuracy: 8 });
      await n.getByText('You have arrived').waitFor({ timeout: 15000 });
      await n.getByRole('button', { name: 'Done' }).click();
      await n.locator('.fl-card').first().waitFor();
      assert(await n.locator('.fl-topbar').isVisible(), 'planner not restored after navigation');

      // Simulation preview is labelled and moves along the route.
      await n.getByRole('button', { name: /^Directions/ }).click();
      await n.getByRole('button', { name: /^Simulate$/ }).click();
      await n.locator('.fl-nav-sim').waitFor({ timeout: 10000 });
      assert(/not your real location/.test(await n.locator('.fl-nav-sim').textContent()), 'simulation label missing');
      const before = await n.locator('.fl-nav-trip span').first().textContent();
      await n.waitForTimeout(3500);
      const after = await n.locator('.fl-nav-trip span').first().textContent();
      assert(before !== after, 'simulated position did not advance');
      await n.getByRole('button', { name: 'Exit' }).click();
      assert((await n.locator('.fl-nav').count()) === 0, 'navigation did not exit');
    } catch (err) {
      const banner = (await n.locator('.fl-nav-top').textContent().catch(() => 'none')) ?? '';
      throw new Error(`${err.message.split('\n')[0]} | banner: ${banner.replace(/\s+/g, ' ').slice(0, 160)}`);
    } finally {
      await nctx.close();
    }
  });

  await step('7. Default map is clean; Monsoon & Flood Risk opens overlays and panel', async () => {
    assert((await page.locator('.fl-alert-icon').count()) === 0, 'alerts visible before activation');
    assert((await page.locator('path[stroke="#c62828"]').count()) === 0, 'hotspots visible before activation');
    await page.getByRole('button', { name: /Monsoon & Flood Risk/ }).click();
    await page.getByRole('heading', { name: 'Monsoon & Flood Risk' }).waitFor();
    await page.locator('.fl-alert-icon').first().waitFor({ timeout: 15000 });
    assert((await page.locator('path[stroke="#c62828"]').count()) > 0, 'hotspots not drawn');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '03-flood-panel.png') });
  });

  await step('8. Layer toggles hide and show overlays', async () => {
    const hot = page.getByRole('checkbox', { name: /Historical hotspots/ });
    await hot.uncheck();
    assert((await page.locator('path[stroke="#c62828"]').count()) === 0, 'hotspots still drawn');
    await hot.check();
    assert((await page.locator('path[stroke="#c62828"]').count()) > 0, 'hotspots not redrawn');
  });

  await step('9. Official alert popup shows issuer, validity and source link', async () => {
    await page.locator('.fl-alert-icon').first().click();
    const popup = page.locator('.leaflet-popup-content');
    await popup.waitFor();
    const t = await popup.textContent();
    assert(/Official alert/.test(t) && /Valid/.test(t), 'alert details missing');
    assert((await popup.getByRole('link', { name: /CAP alert/ }).count()) === 1, 'source link missing');
    await page.keyboard.press('Escape');
    await page.locator('.leaflet-popup-close-button').click().catch(() => {});
  });

  await step('10. Rainfall chart, forecast labels and river data are shown', async () => {
    const panel = page.locator('.fl-panel');
    assert((await panel.locator('.fl-chart svg').count()) === 1, 'rainfall chart missing');
    const t = await panel.textContent();
    assert(/Estimated past/.test(t) && /Forecast/.test(t), 'past/forecast not distinguished');
    assert(/m³\/s/.test(t) && /not a gauge reading/.test(t), 'river caveat missing');
    await panel.getByRole('button', { name: 'Show table' }).click();
    assert((await panel.locator('.fl-table tbody tr').count()) > 0, 'table view empty');
  });

  await step('11. Community reports submit to PostgreSQL and form a corroborated cluster', async () => {
    const panel = page.locator('.fl-panel');
    for (let i = 0; i < 2; i++) {
      await panel.getByRole('button', { name: /Report waterlogging/ }).click().catch(() => {});
      await panel.getByRole('combobox', { name: 'Location', exact: true }).fill('Minto');
      await page.getByRole('option', { name: /Minto Road/ }).click();
      await panel.getByLabel('What did you see?').fill(`E2E test report ${i + 1}: water over the kerb`);
      await panel.getByRole('button', { name: 'Submit report' }).click();
      await panel.locator('.fl-success').waitFor({ timeout: 10000 });
    }
    await page.locator('.fl-cluster-icon').first().waitFor({ timeout: 10000 });
    assert((await page.locator('.fl-cluster-icon').first().textContent()).trim() === '2', 'cluster count should be 2');
    await page.locator('.fl-cluster-icon').first().click();
    const t = await page.locator('.leaflet-popup-content').textContent();
    assert(/Corroborated Community Reports/.test(t) && /unverified/i.test(t), 'cluster labelling wrong');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '04-report-cluster.png') });
  });

  await step('12. Recent routes persist across reload and can be cleared', async () => {
    await page.reload();
    const recent = page.locator('.fl-recent li');
    await recent.first().waitFor();
    assert(/Kashmere Gate/.test(await recent.first().textContent()), 'recent route missing after reload');
    await page.getByRole('button', { name: 'Clear history' }).click();
    await page.getByRole('button', { name: 'Clear all' }).click();
    assert((await recent.count()) === 0, 'history not cleared');
    const stored = await page.evaluate(() => localStorage.getItem('floodlens.recentRoutes.v1'));
    assert(stored === null, 'storage not cleared');
  });

  await step('13. Routing failure shows Retry, keeps inputs, and recovers', async () => {
    await fetch(`${API}/__test/routing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"fail":true}' });
    await page.getByRole('combobox', { name: 'Destination', exact: true }).fill('Kashm');
    await page.getByRole('option', { name: /Kashmere Gate ISBT/ }).click();
    await page.getByRole('button', { name: 'Walk' }).click();
    const err = page.locator('.fl-error-box');
    await err.waitFor({ timeout: 15000 });
    assert(/did not respond/.test(await err.textContent()), 'error text missing');
    assert((await cards.count()) === 0, 'a route is shown despite failure');
    assert((await page.getByRole('combobox', { name: 'Destination', exact: true }).inputValue()).startsWith('Kashmere'), 'destination lost');
    assert((await page.getByRole('button', { name: 'Walk' }).getAttribute('aria-pressed')) === 'true', 'travel mode lost');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '05-routing-error.png') });
    await fetch(`${API}/__test/routing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"fail":false}' });
    await err.getByRole('button', { name: 'Retry' }).click();
    await cards.first().waitFor({ timeout: 15000 });
    assert(/not validated for walking/.test(await page.textContent('.fl-sidebar')), 'walking limitation missing');
  });

  await step('Use My Location denied → manual fallback message', async () => {
    await page.getByRole('button', { name: /Use my location/ }).click();
    await page.getByText(/Location permission was denied|could not be determined/).waitFor({ timeout: 15000 });
  });

  await step('Keyboard: preference buttons are reachable and operable', async () => {
    await pressed('Fastest').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    assert((await pressed('Balanced').getAttribute('aria-pressed')) === 'true', 'keyboard activation failed');
  });

  await ctx.close();

  // ---------------- Mobile ----------------
  console.log('\nMobile (390×844)');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  watch(m);
  await step('Mobile: welcome and planner bottom sheet', async () => {
    await m.goto(WEB);
    await m.waitForTimeout(700);
    await m.screenshot({ path: path.join(shots, '06-mobile-welcome.png') });
    await m.getByRole('button', { name: /Plan a Safer Route/ }).first().tap();
    await m.getByRole('button', { name: /Hide route planner/ }).waitFor();
    await m.getByRole('combobox', { name: 'Destination', exact: true }).fill('Kashm');
    await m.getByRole('option', { name: /Kashmere Gate ISBT/ }).tap();
    await m.locator('.fl-card').first().waitFor({ timeout: 20000 });
    await m.waitForTimeout(700);
    await m.screenshot({ path: path.join(shots, '07-mobile-routes.png') });
    const vw = await m.evaluate(() => document.documentElement.scrollWidth);
    assert(vw <= 390, `horizontal overflow: ${vw}px`);
  });
  await step('Mobile: flood panel as bottom sheet, minimise keeps overlays', async () => {
    await m.getByRole('button', { name: /Monsoon & Flood Risk/ }).tap();
    await m.locator('.fl-panel').waitFor();
    await m.locator('.fl-alert-icon').first().waitFor({ timeout: 15000 });
    await m.waitForTimeout(700);
    await m.screenshot({ path: path.join(shots, '08-mobile-flood.png') });
    await m.getByRole('button', { name: /Minimise panel/ }).tap();
    assert((await m.locator('.fl-panel').count()) === 0, 'panel not minimised');
    assert((await m.locator('.fl-alert-icon').count()) > 0, 'overlays lost on minimise');
    await m.getByRole('button', { name: /Show flood panel/ }).tap();
    await m.getByRole('button', { name: /Close flood panel/ }).tap();
    assert((await m.locator('.fl-alert-icon').count()) === 0, 'overlays remain after close');
    assert((await m.locator('.fl-card').count()) > 0, 'route lost after closing panel');
  });
  await mctx.close();

  await step('PWA: manifest and service worker are served', async () => {
    const man = await (await fetch(`${WEB}/manifest.webmanifest`)).json();
    assert(man.icons.some((i) => i.sizes === '512x512'), 'manifest icons missing');
    const sw = await (await fetch(`${WEB}/sw.js`)).text();
    assert(/startsWith\('\/api'\)/.test(sw), 'SW must bypass API');
  });

  await step('No unexpected browser console errors', async () => {
    assert(consoleErrors.length === 0, consoleErrors.join(' | '));
  });

  await browser.close();
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length} passed, ${results.filter((r) => r[0] === 'FAIL').length} failed. Screenshots: ${shots}`);
}

main()
  .catch((error) => {
    failed = true;
    console.error(error);
  })
  .finally(async () => {
    await stopFixtureServer();
    cleanup();
    process.exit(failed ? 1 : 0);
  });
