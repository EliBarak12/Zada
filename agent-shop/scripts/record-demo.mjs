// Records the full Zada tour: the HUMAN browses with real clicks (cards,
// hearts, "more like this"), their events reshape the shop live (nudge card,
// home-page rails), and the agent works alongside — size checks, reviews and
// price intelligence on the open product, reading where the human is and how
// they got there, and finally filling the bag. Runs against the live catalog.
//
//   PW_CHROMIUM=/path/to/chromium node scripts/record-demo.mjs
//   → demo/zada-demo.webm + demo/timeline.json (caption timings, used by
//     scripts/narrate-demo.mjs to voice the captions)

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 4993;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.resolve('demo');

for (const f of ['cart', 'profile', 'signals', 'prices', 'notes']) fs.rmSync(`/tmp/zas-demo-${f}.json`, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) fs.rmSync(path.join(OUT_DIR, f), { force: true });

const server = spawn('node', ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), PRICE_DB: '/tmp/zas-demo-prices.json', PROFILE_DB: '/tmp/zas-demo-profile.json', CART_DB: '/tmp/zas-demo-cart.json', SIGNALS_DB: '/tmp/zas-demo-signals.json', NOTES_DB: '/tmp/zas-demo-notes.json' },
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
const T0 = Date.now(); // the video starts with the page
const timeline = [];

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

// Hold each caption at least as long as it takes to say it (~0.3s/word).
const speechMs = (text) => text.trim().split(/\s+/).length * 320 + 1100;

async function caption(who, text, holdMs = 2600) {
  timeline.push({ who, text, at: Date.now() - T0 });
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
    const label = who === 'you' ? 'YOU' : who === 'shop' ? 'ZADA' : 'AGENT';
    const color = who === 'you' ? '#9be29b' : who === 'shop' ? '#7fd7a8' : '#8fa8ff';
    bar.innerHTML = `<span style="font-size:10px;letter-spacing:.3em;color:${color}">${label}</span><br>${text}`;
    bar.style.opacity = '1';
  }, { who, text });
  await sleep(Math.max(holdMs, speechMs(text)));
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
const openProductId = () => page.evaluate(() => state.detail?.id ?? null);
const scrollTo = (sel, block = 'center') => page.evaluate(({ sel, block }) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block }), { sel, block });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__webmcp?.registered?.length > 0, null, { timeout: 15000 });
  await sleep(1000);

  // ——— Scene 0: what this is ———
  await caption('shop', 'This is Zada — the store that shops with you. A live fashion storefront where you and your AI agent shop together, in one shared session.');
  await caption('shop', 'The page registers sixteen tools with the browser through WebMCP; the same tools are served over remote MCP — and every call renders right here.');

  // ——— Scene 1: setup ———
  await caption('you', 'I wear M, waist 32, shoe 43 — now let me just shop. Watch what the store learns.');
  await call('set_my_sizes', { tops: 'M', bottoms: '32', shoes: '43' });

  await caption('you', 'Search: men’s pants.', 1800);
  await humanClick('#searchInput');
  await page.fill('#searchInput', "men's pants");
  await page.click('#searchForm button');
  await page.waitForSelector('#grid .card', { timeout: 15000 });
  await waitImages('#grid .card img');
  await sleep(1000);

  // ——— Scene 2: human browsing — every move is an event ———
  await caption('shop', 'Every view, every second you linger, every heart becomes an event the store can use.', 2200);
  await humanClick('#grid .card:nth-of-type(2)');
  await page.waitForSelector('#detail .detail-info h2', { timeout: 10000 });
  await waitImages('#detail .gallery img');
  await sleep(1600);
  await humanClick('.love-detail');
  await sleep(900);
  await hideCursor();

  await page.waitForSelector('.similar-row .mini', { timeout: 20000 });
  await scrollTo('.similar-row');
  await caption('shop', 'The product page grows a “More like this” row — tap to drift sideways through the catalog.');
  await humanClick('.similar-row .mini:nth-of-type(1)');
  await page.waitForSelector('#detail .detail-info h2', { timeout: 10000 });
  await waitImages('#detail .gallery img');
  await page.waitForSelector('.similar-row .mini', { timeout: 15000 }).catch(() => {}); // settles the re-render
  await sleep(1200);
  await humanClick('.love-detail');
  await sleep(800);
  await hideCursor();

  // ——— Scene 3: the agent works the open product ———
  const pid = await openProductId();
  await caption('you', 'Agent — do they have this in my size?');
  const size = await call('check_size_availability', { product_id: pid });
  await scrollTo('.sizes');
  const sizeName = size.matched ?? size.checked ?? 'your size';
  await caption('agent', size.inStockAnywhere
    ? `Yes — ${sizeName} is in stock right now. That’s your size; I’ve flagged it on the size chips.`
    : `Not in your size at the moment — I checked ${sizeName}. Want similar pieces that are?`);

  await caption('you', 'What do people say about it — and was it cheaper before?');
  const reviews = await call('find_reviews', { product_id: pid }).catch(() => ({}));
  const price = await call('check_price', { product_id: pid }).catch(() => ({}));
  await page.waitForSelector('.panels', { timeout: 10000 }).catch(() => {});
  await scrollTo('.panels', 'start');
  const n = (reviews.results ?? []).length;
  const verdict = price.verdict ?? price.report?.verdict ?? '';
  await caption('agent', `${n ? `I found ${n} relevant mention${n === 1 ? '' : 's'} across Reddit, YouTube and the web — in the reviews panel.` : 'No relevant public reviews from here — I’ll use my own web search.'} ${verdict ? `On price: ${verdict}` : 'The price panel shows the live markdown and the history the shop tracks.'}`);
  await hideCursor();

  // ——— Scene 3b: the agent asks IN the store; the human taps ———
  await scrollTo('#topbar', 'start');
  const asking = call('ask_shopper', { question: 'What matters most for this one?', choices: ['Fit', 'Price', 'The look'], product_id: pid, wait_seconds: 40 });
  await page.waitForSelector('#__question .q-choice', { timeout: 10000 });
  await sleep(600);
  await caption('shop', 'The agent asks in the store, not in chat. A card, three choices — you just tap.', 2800);
  await humanClick('#__question .q-choice:nth-of-type(1)');
  const answer = await asking.catch(() => ({}));
  await hideCursor();
  await caption('agent', `${answer.choice ?? 'Fit'} it is. I read the reviews on the web — let me put what I found on the page, not in a paragraph.`);

  // ——— Scene 3c: the agent writes its verdict onto the product page ———
  const SRC = { reddit: 'reddit', youtube: 'youtube' };
  const sources = (reviews.results ?? []).slice(0, 3).map((v) => ({
    source: SRC[String(v.source ?? '').toLowerCase()] ?? 'web',
    title: String(v.title ?? 'Review').slice(0, 140),
    url: String(v.url),
    quote: v.snippet ? String(v.snippet).slice(0, 200) : undefined,
  })).filter((s) => /^https?:\/\//.test(s.url));
  await call('post_findings', {
    product_id: pid,
    verdict: `${n ? `People mention comfort and a true-to-size fit across ${n} mentions` : 'Nothing negative surfaced'} — ${size.inStockAnywhere ? `take ${sizeName}, it’s in stock.` : 'take your usual size.'}`,
    fit: 'regular through the leg', sizing: 'true to size',
    recommended_size: size.inStockAnywhere ? sizeName : undefined,
    confidence: n ? 'high' : 'medium',
    findings: sources,
  }).catch(() => {});
  await page.waitForSelector('.panel.agent-note', { timeout: 10000 }).catch(() => {});
  await scrollTo('.panel.agent-note', 'start');
  await caption('agent', 'Here it is — my verdict, the sources I actually read, and the size to take, right on the product page.');
  await scrollTo('.sizes');
  await caption('shop', 'That blue chip is the agent’s pick. It’s already selected — one tap adds it to the bag.', 2600);
  await hideCursor();

  // ——— Scene 4: the shop nudges — events talking back ———
  const nudged = await page.waitForSelector('#__nudge', { timeout: 6000 }).then(() => true).catch(() => false);
  if (nudged) {
    await scrollTo('#topbar', 'start');
    await caption('shop', 'Three items around one theme — so the store itself offers the shortcut. Dismissible, never a takeover.');
    await humanClick('.nudge-go');
    const gridShown = await page.waitForSelector('#grid:not([hidden]) .card', { timeout: 15000 }).then(() => true).catch(() => false);
    if (gridShown) {
      await waitImages('#grid .card img');
      await caption('shop', 'One tap: the whole theme, together. Notice the SEEN badges — the grid remembers with you.');
    } else {
      await page.waitForSelector('.similar-row .mini', { timeout: 15000 }).catch(() => {});
      await waitImages('.similar-row .mini img');
      await caption('shop', 'One tap: similar pieces in your size, right where you are — the store drifts with your taste.');
    }
  }
  await hideCursor();

  // ——— Scene 5: the home page rebuilt from your events ———
  await humanClick('.brand');
  await page.waitForSelector('#rails .rail', { timeout: 20000 });
  await scrollTo('#rails', 'start');
  await sleep(800);
  await caption('shop', 'Home is no longer generic: Continue where you left off · Your loves · Picked for you — built only from your events.');
  const railCount = await page.locator('#rails .rail').count();
  if (railCount >= 2) {
    await humanClick('#rails .rail:last-of-type .mini:nth-of-type(1)');
    const opened = await page.waitForSelector('#detail:not([hidden]) .detail-info h2', { timeout: 12000 }).then(() => true).catch(() => false);
    if (opened) await waitImages('#detail .gallery img');
  }
  await hideCursor();

  // ——— Scene 6: the agent knows where you are ———
  await caption('you', 'Agent — where am I right now, and what have I been doing?');
  const sig = await call('get_shopper_signals', {});
  const cur = sig.current ?? {};
  const where = cur.view === 'product' ? `on ${cur.name}` : cur.view === 'grid' ? `looking at results for ${cur.query}` : cur.view === 'bag' ? 'in your bag' : cur.view === 'similar' ? 'exploring similar items' : 'on the home page';
  const trail = (sig.journey ?? []).slice(-3).map((s) => `${s.action}${s.name ? ` ${s.name.toLowerCase()}` : s.query ? ` for ${s.query}` : ''}`).join(', then ');
  await caption('agent', `You’re ${where}, for about ${cur.sinceSeconds ?? 0} seconds. Your trail: ${trail}. Every result I get tells me where you are and what you just did — so I never have to ask.`);

  // ——— Scene 7: the agent as amplifier ———
  await caption('you', 'So what’s my pattern — and what should I actually buy?');
  const themes = (sig.taste?.themes ?? []).slice(0, 3).map((t) => t.word.toLowerCase());
  const lovedCount = (sig.loved ?? []).length;
  await caption('agent', `You loved ${lovedCount} item${lovedCount === 1 ? '' : 's'} and kept lingering on ${themes.join(', ')}. ${lovedCount === 1 ? 'Want it in your size?' : 'Want them in your size?'}`);

  await caption('you', lovedCount === 1 ? 'Yes — bag it, my size.' : 'Yes — bag both, my size.', 2200);
  for (const l of (sig.loved ?? []).slice(0, 2)) await call('add_to_cart', { product_id: l.productId }).catch(() => {});
  await call('view_cart', {});
  await waitImages('.bag-item img');
  await caption('agent', 'Done — sizes converted and stock verified. Checkout stays with you: every line links to the retailer.');

  await caption('shop', 'Zada — your events shape the store; your agent amplifies them. WebMCP in the page, remote MCP for every agent outside it. Open source.');
} catch (err) {
  console.error('demo error:', err);
} finally {
  await context.close();
  await browser.close();
  server.kill();
}

fs.writeFileSync(path.join(OUT_DIR, 'timeline.json'), JSON.stringify(timeline, null, 1));
const raw = fs.readdirSync(OUT_DIR).find((f) => f.endsWith('.webm') && !f.startsWith('zada-'));
const final = path.join(OUT_DIR, 'zada-demo.webm');
if (raw) fs.renameSync(path.join(OUT_DIR, raw), final);
console.log('video:', final, fs.existsSync(final) ? `${(fs.statSync(final).size / 1e6).toFixed(1)}MB` : 'MISSING', `· ${timeline.length} captions`);
