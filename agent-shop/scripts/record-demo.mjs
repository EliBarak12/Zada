// Records the full demo video of the event-driven shopping experience:
// the HUMAN browses with real clicks (cards, hearts, "more like this"),
// their events reshape the shop live (nudge card, home-page rails), and the
// agent appears as an amplifier at the end — reading the signals and filling
// the bag. Runs against the live catalog.
//
//   PW_CHROMIUM=/path/to/chromium node scripts/record-demo.mjs
//   → demo/zada-demo.webm

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 4993;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.resolve('demo');

for (const f of ['cart', 'profile', 'signals', 'prices']) fs.rmSync(`/tmp/zas-demo-${f}.json`, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) fs.rmSync(path.join(OUT_DIR, f), { force: true });

const server = spawn('node', ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), PRICE_DB: '/tmp/zas-demo-prices.json', PROFILE_DB: '/tmp/zas-demo-profile.json', CART_DB: '/tmp/zas-demo-cart.json', SIGNALS_DB: '/tmp/zas-demo-signals.json' },
  stdio: 'ignore',
});
await sleep(2500);

const launchOpts = {};
if (process.env.PW_CHROMIUM) launchOpts.executablePath = process.env.PW_CHROMIUM;
if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' };
const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

await page.addInitScript(() => {
  const tools = new Map();
  const mc = {
    async registerTool(d) { tools.set(d.name, d); },
    _tools: tools,
    async _call(name, args) {
      const t = tools.get(name);
      if (!t) throw new Error(`tool not registered: ${name}`);
      return t.execute(args ?? {});
    },
  };
  Object.defineProperty(document, 'modelContext', { value: mc });
  Object.defineProperty(navigator, 'modelContext', { value: mc });
});

const call = (name, args) =>
  page.evaluate(async ({ name, args }) => {
    const r = await document.modelContext._call(name, args);
    return JSON.parse(r.content[0].text);
  }, { name, args });

async function caption(who, text, holdMs = 2600) {
  await page.evaluate(({ who, text }) => {
    let bar = document.getElementById('__cap');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__cap';
      bar.style.cssText =
        'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9999;' +
        'max-width:860px;padding:14px 26px;font:14px/1.5 "Helvetica Neue",Arial,sans-serif;' +
        'letter-spacing:.04em;color:#fff;background:rgba(17,17,17,.92);box-shadow:0 4px 24px rgba(0,0,0,.25);' +
        'transition:opacity .3s;text-align:center;pointer-events:none';
      document.body.appendChild(bar);
    }
    const label = who === 'you' ? 'YOU' : who === 'shop' ? 'THE SHOP' : 'AGENT';
    const color = who === 'you' ? '#9be29b' : who === 'shop' ? '#7fd7a8' : '#8fa8ff';
    bar.innerHTML = `<span style="font-size:10px;letter-spacing:.3em;color:${color}">${label}</span><br>${text}`;
    bar.style.opacity = '1';
  }, { who, text });
  await sleep(holdMs);
}

async function humanClick(selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no element for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 200);
  await page.evaluate(({ x, y }) => {
    let dot = document.getElementById('__cursor');
    if (!dot) {
      dot = document.createElement('div');
      dot.id = '__cursor';
      dot.style.cssText =
        'position:fixed;width:22px;height:22px;border-radius:50%;z-index:9998;pointer-events:none;' +
        'border:2px solid #0a5c36;background:rgba(10,92,54,.18);transform:translate(-50%,-50%);transition:left .5s ease,top .5s ease';
      document.body.appendChild(dot);
    }
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    dot.style.opacity = '1';
  }, { x, y });
  await sleep(650);
  await page.mouse.click(x, y);
}
const hideCursor = () => page.evaluate(() => { const d = document.getElementById('__cursor'); if (d) d.style.opacity = '0'; });

async function waitImages(sel, ms = 8000) {
  await page.waitForFunction((s) => {
    const imgs = [...document.querySelectorAll(s)].slice(0, 6);
    return imgs.length && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, sel, { timeout: ms }).catch(() => {});
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__webmcp?.registered?.length > 0, null, { timeout: 15000 });
  await sleep(1200);

  // ——— Scene 1: setup ———
  await caption('you', '“I wear M, waist 32, shoe 43 — now let me just shop. Watch what the store learns.”', 3200);
  await call('set_my_sizes', { tops: 'M', bottoms: '32', shoes: '43' });

  await caption('you', '“Search: men’s pants.”', 1800);
  await humanClick('#searchInput');
  await page.fill('#searchInput', "men's pants");
  await page.click('#searchForm button');
  await page.waitForSelector('#grid .card', { timeout: 15000 });
  await waitImages('#grid .card img');
  await sleep(1200);

  // ——— Scene 2: human browsing — every move is an event ———
  await caption('shop', 'Every view, every second you linger, every ♥ becomes an event the store can use.', 3000);
  await humanClick('#grid .card:nth-of-type(2)');
  await page.waitForSelector('#detail .detail-info h2', { timeout: 10000 });
  await waitImages('#detail .gallery img');
  await sleep(2000);
  await humanClick('.love-detail');
  await sleep(900);
  await hideCursor();

  // "More like this" grows in from the event — lateral navigation, no search.
  await page.waitForSelector('.similar-row .mini', { timeout: 20000 });
  await page.evaluate(() => document.querySelector('.similar-row')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await caption('shop', 'The product page grows a “More like this” row — tap to drift sideways through the catalog.', 3200);
  await humanClick('.similar-row .mini:nth-of-type(1)');
  await page.waitForSelector('#detail .detail-info h2', { timeout: 10000 });
  await waitImages('#detail .gallery img');
  await sleep(2200);
  await humanClick('.love-detail');
  await sleep(800);
  await page.waitForSelector('.similar-row .mini', { timeout: 20000 }).catch(() => {});
  await humanClick('.similar-row .mini:nth-of-type(2)').catch(() => {});
  await page.waitForSelector('#detail .detail-info h2', { timeout: 10000 });
  await sleep(1800);
  await hideCursor();

  // ——— Scene 3: the shop nudges — events talking back ———
  const nudged = await page.waitForSelector('#__nudge', { timeout: 12000 }).then(() => true).catch(() => false);
  if (nudged) {
    await caption('shop', 'Three items around one theme — so the store itself offers the shortcut. Dismissible, never a takeover.', 3600);
    await humanClick('.nudge-go');
    // A search-mode nudge opens a grid; a similar-mode nudge lands on the
    // anchor product with a fresh "more like this" row.
    const gridShown = await page.waitForSelector('#grid:not([hidden]) .card', { timeout: 15000 }).then(() => true).catch(() => false);
    if (gridShown) {
      await waitImages('#grid .card img');
      await caption('shop', 'One tap: the whole theme, together. Notice the SEEN badges — the grid remembers with you.', 3400);
    } else {
      await page.waitForSelector('.similar-row .mini', { timeout: 15000 }).catch(() => {});
      await waitImages('.similar-row .mini img');
      await caption('shop', 'One tap: similar pieces in your size, right where you are — the store drifts with your taste.', 3400);
    }
  }
  await hideCursor();

  // ——— Scene 4: the home page rebuilt from your events ———
  await humanClick('.brand');
  await page.waitForSelector('#rails .rail', { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#rails')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await sleep(1000);
  await caption('shop', 'Home is no longer generic: Continue where you left off · Your loves · Picked for you — built only from your events.', 4200);
  const hasForYou = await page.locator('#rails .rail').count();
  if (hasForYou >= 2) {
    await humanClick('#rails .rail:last-of-type .mini:nth-of-type(1)');
    const opened = await page.waitForSelector('#detail:not([hidden]) .detail-info h2', { timeout: 12000 }).then(() => true).catch(() => false);
    if (opened) {
      await waitImages('#detail .gallery img');
      await caption('shop', 'Picked for you → straight into the product, size chips and all.', 3000);
    }
  }
  await hideCursor();

  // ——— Scene 5: the agent as amplifier ———
  await caption('you', '“Agent — you saw all of that. What’s my pattern, and what should I actually buy?”', 3200);
  const sig = await call('get_shopper_signals', {});
  const themes = sig.taste.themes.slice(0, 3).map((t) => t.word.toLowerCase());
  await caption('agent', `You loved ${sig.loved.length} items and kept lingering on ${themes.join(', ')}. Your two loves are the strongest — want them in your size?`, 4000);

  await caption('you', '“Yes — bag both, my size.”', 2200);
  for (const l of sig.loved.slice(0, 2)) await call('add_to_cart', { product_id: l.productId });
  await call('view_cart', {});
  await waitImages('.bag-item img');
  await caption('agent', 'Done — sizes converted and stock verified. Checkout stays with you: every line links to the retailer.', 3800);

  await caption('shop', 'Zada — the store that shops with you: your events shape it; your agent amplifies them. WebMCP in-page + remote MCP at /mcp.', 4200);
} catch (err) {
  console.error('demo error:', err);
} finally {
  await context.close();
  await browser.close();
  server.kill();
}

const raw = fs.readdirSync(OUT_DIR).find((f) => f.endsWith('.webm') && !f.startsWith('zada-'));
const final = path.join(OUT_DIR, 'zada-demo.webm');
if (raw) fs.renameSync(path.join(OUT_DIR, raw), final);
console.log('video:', final, fs.existsSync(final) ? `${(fs.statSync(final).size / 1e6).toFixed(1)}MB` : 'MISSING');
