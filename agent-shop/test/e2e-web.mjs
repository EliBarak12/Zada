// E2E: the WebMCP surface + the human-visible storefront, in a real Chromium.
//
// Chromium has no modelContext yet, so we install a capture shim *before* the
// page loads — exactly the surface a WebMCP browser exposes — then act as the
// agent: call the page-registered tools and assert the UI mirrors every step
// (grid renders, product view opens, the agent-status indicator attributes it).
//
//   node test/e2e-web.mjs

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 4992;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

import fs from 'node:fs';
fs.rmSync('/tmp/zas-web-cart.json', { force: true });
fs.rmSync('/tmp/zas-web-signals.json', { force: true });
fs.rmSync('/tmp/zas-web-notes.json', { force: true });
const server = spawn('node', ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), PRICE_DB: '/tmp/zas-web-prices.json', PROFILE_DB: '/tmp/zas-web-profile.json', CART_DB: '/tmp/zas-web-cart.json', SIGNALS_DB: '/tmp/zas-web-signals.json', NOTES_DB: '/tmp/zas-web-notes.json' },
  stdio: 'inherit',
});
await sleep(2000);

// In sandboxes with pre-provisioned browsers, PW_CHROMIUM points at the
// binary (e.g. /opt/pw-browsers/chromium); otherwise Playwright's own install.
// If egress goes through an agent proxy (HTTPS_PROXY + custom CA), pass it to
// Chromium too so external product images load inside the test browser.
const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' };
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({
  viewport: { width: 1440, height: 950 },
  ignoreHTTPSErrors: Boolean(process.env.HTTPS_PROXY), // agent-proxy CA isn't in Chromium's store
});

// The WebMCP surface a capable browser provides (spec: document.modelContext,
// formerly navigator.modelContext) — a registerTool capture shim.
await page.addInitScript(() => {
  const tools = new Map();
  const mc = {
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    _tools: tools,
    async _call(name, args) {
      const t = tools.get(name);
      if (!t) throw new Error(`tool not registered: ${name}`);
      return t.execute(args);
    },
  };
  Object.defineProperty(document, 'modelContext', { value: mc });
  Object.defineProperty(navigator, 'modelContext', { value: mc });
});

try {
  // Note: not 'networkidle' — the page keeps a live SSE stream open forever.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  console.log('\n— WebMCP registration');
  await page.waitForFunction(() => window.__webmcp?.registered?.length > 0, null, { timeout: 10000 });
  const reg = await page.evaluate(() => window.__webmcp);
  check('page detected modelContext', reg.available === true);
  check('registered all 16 tools in-page', reg.registered.length === 16, reg.registered.join(', '));
  const badge = await page.textContent('#webmcpBadge');
  check('UI badge confirms registration', /16 tools registered/.test(badge), badge.trim());

  console.log('\n— agent calls search via the page-registered WebMCP tool');
  const searchRes = await page.evaluate(async () => {
    const r = await document.modelContext._call('search_products', { query: "men's pants", limit: 8 });
    return JSON.parse(r.content[0].text);
  });
  check('tool returns live products', searchRes.products.length > 0, `${searchRes.products.length} products, section ${searchRes.section}`);

  await page.waitForSelector('#grid .card', { timeout: 8000 });
  const cards = await page.locator('#grid .card').count();
  check('storefront grid mirrors the agent search', cards > 0, `${cards} product cards`);
  const imgOk = await page.evaluate(async () => {
    const img = document.querySelector('#grid .card img');
    if (!img) return false;
    await img.decode().catch(() => {});
    return img.naturalWidth > 50;
  });
  check('real product images render', imgOk);
  await page.screenshot({ path: '/tmp/zas-grid.png' });

  console.log('\n— agent opens a product; UI follows');
  const pid = searchRes.products[0].id;
  await page.evaluate(async (id) => {
    await document.modelContext._call('get_product', { product_id: id });
  }, pid);
  await page.waitForSelector('#detail .detail-info h2', { timeout: 8000 });
  const title = await page.textContent('#detail .detail-info h2');
  check('full product view opened', title.trim().length > 3, title.trim());
  const sizes = await page.locator('#detail .size').count();
  check('size availability shown', sizes > 0, `${sizes} size chips`);
  await page.screenshot({ path: '/tmp/zas-detail.png' });

  console.log('\n— agent-status indicator attributed the agent');
  const status = await page.evaluate(() => ({
    state: document.querySelector('#agentStatus').dataset.state,
    text: document.querySelector('#agentStatusText').textContent,
  }));
  check('agent activity lit the status indicator', status.state === 'active' || status.state === 'recent', `${status.state} · ${status.text}`);
  // Attribution flashes as "agent acting (in-page)" for ~3s after each call —
  // fire a cheap read-only call and catch the flash.
  const sawInPage = await page
    .evaluate(() => document.modelContext._call('list_categories', { section: 'MAN' }))
    .then(() => page.waitForFunction(() => /in-page/.test(document.querySelector('#agentStatusText').textContent), null, { timeout: 3000 }))
    .then(() => true, () => false);
  check('status attributes actions to the in-page agent', sawInPage);

  console.log('\n— event-driven navigation: more-like-this + rails');
  await page.waitForSelector('.similar-row .mini', { timeout: 15000 });
  const simCount = await page.locator('.similar-row .mini').count();
  check('product page grows a "more like this" row', simCount > 0, `${simCount} similar items`);
  // Rails are built from HUMAN events — seed a web-channel view + love first.
  await page.evaluate(async (id) => {
    const post = (name, body) => fetch(`/api/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-channel': 'web' }, body: JSON.stringify(body) });
    await post('get_product', { product_id: id });
    await post('love_item', { product_id: id });
  }, pid);
  await page.click('#brand');
  await page.waitForSelector('#rails .rail', { timeout: 20000 });
  const railTitles = await page.locator('#rails .rail-title').allTextContents();
  check('hero shows event-driven rails', railTitles.length >= 1, railTitles.map((t) => t.trim().split('\n')[0]).join(' | '));

  console.log('\n— agent fills the bag; UI follows');
  await page.evaluate(async (id) => {
    await document.modelContext._call('set_my_sizes', { tops: 'M', bottoms: '32', shoes: '43' });
    await document.modelContext._call('add_to_cart', { product_id: id });
  }, pid);
  // Adding never yanks the human away: a notice appears, the view stays.
  await page.waitForSelector('#__notice', { timeout: 5000 });
  check('agent add-to-bag shows a notice instead of navigating', /added/i.test(await page.textContent('#__notice')) && (await page.locator('#detail:not([hidden]) .bag-item').count()) === 0);
  await page.evaluate(() => document.modelContext._call('view_cart', {}));
  await page.waitForSelector('.bag-item', { timeout: 8000 });
  check('bag lines say who added them', /added by your agent/i.test(await page.textContent('.bag-item')));
  const bagCount = await page.textContent('#bagCount');
  check('bag view opened with the item', (await page.locator('.bag-item').count()) === 1, `badge shows ${bagCount}`);
  check('bag badge updated', Number(bagCount) >= 1);
  await page.screenshot({ path: '/tmp/zas-bag.png' });
  await page.click('.bag-item .rm');
  await page.waitForSelector('.bag-empty', { timeout: 8000 });
  check('remove empties the bag in the UI', true);

  console.log('\n— human path still works (click a card)');
  await page.evaluate(() => {
    if (window.__lastGridBack) return;
  });
  await page.click('#backBtn');
  await page.waitForSelector('#grid .card');
  await page.locator('#grid .card').nth(1).click();
  await page.waitForSelector('#detail .detail-info h2', { timeout: 8000 });
  const humanTitle = await page.textContent('#detail .detail-info h2');
  check('human click opened a product view', humanTitle.trim().length > 3, humanTitle.trim());

  console.log('\n— agent can see where the human is right now');
  const sig = await page.evaluate(async () => {
    const r = await fetch('/api/tools/get_shopper_signals', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-channel': 'web' }, body: '{}' });
    return (await r.json()).result;
  });
  check('current location is the product the human opened, attributed to them', sig.current?.view === 'product' && sig.current?.setBy === 'human', `${sig.current?.view} · ${sig.current?.name} (${sig.current?.sinceSeconds}s)`);
  check('journey trail is recorded in order', Array.isArray(sig.journey) && sig.journey.length >= 3, sig.journey?.slice(-3).map((s) => `${s.who}: ${s.action}`).join(' → '));

  console.log('\n— the agent asks in the store; the human taps; the agent gets the answer');
  const asking = page.evaluate(async () => {
    const r = await document.modelContext._call('ask_shopper', { question: 'Fit or price?', choices: ['Fit', 'Price'], wait_seconds: 20 });
    return JSON.parse(r.content[0].text);
  });
  await page.waitForSelector('#__question .q-choice', { timeout: 8000 });
  await page.screenshot({ path: '/tmp/zas-question.png' });
  await page.click('#__question .q-choice:nth-of-type(2)');
  const answered = await asking;
  check('the tap resolves the agent’s pending ask_shopper call', answered.answered === true && answered.choice === 'Price', `${answered.choice} after ${answered.answeredAfterMs}ms`);
  await page.waitForFunction(() => !document.getElementById('__question'), null, { timeout: 3000 }).catch(() => {});
  check('question card leaves the screen after the tap', (await page.locator('#__question').count()) === 0);

  console.log('\n— the agent writes its verdict onto the product page');
  const openId = await page.evaluate(() => state.detail?.id ?? null);
  const firstSize = (await page.locator('#detail .size.selectable').first().textContent().catch(() => ''))?.trim() || null;
  await page.evaluate(async ({ id, size }) => {
    await document.modelContext._call('post_findings', { product_id: id, verdict: 'Runs slightly slim; take your usual size.', sizing: 'true to size', recommended_size: size ?? undefined, confidence: 'high', findings: [{ source: 'youtube', title: 'Try-on review', url: 'https://www.youtube.com/', quote: 'true to size' }] });
  }, { id: openId, size: firstSize });
  await page.waitForSelector('.panel.agent-note', { timeout: 8000 });
  check('“Your agent found” panel renders on the product page', /Runs slightly slim/.test(await page.textContent('.panel.agent-note')));
  if (firstSize) check('the recommended size chip is flagged AGENT: TAKE THIS and pre-selected', (await page.locator('.size.agent-pick.selected').count()) === 1, firstSize);
  await page.screenshot({ path: '/tmp/zas-findings.png' });
} catch (err) {
  console.error('WEB E2E fatal:', err);
  await page.screenshot({ path: '/tmp/zas-fail.png' }).catch(() => {});
  failures++;
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? '\nWEB E2E: ALL PASS' : `\nWEB E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
