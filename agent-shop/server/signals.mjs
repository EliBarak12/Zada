// Shopper signals — the reverse channel. The UI streams what the HUMAN does
// (searches, product views, dwell time, loves) into this store, and the agent
// reads it through get_shopper_signals to see what the human focuses on and
// loves, and to personalize without being told.

import fs from 'node:fs';
import path from 'node:path';
import { searchProducts } from './zara.mjs';

const FILE = process.env.SIGNALS_DB ?? path.join(process.cwd(), 'data', 'signals.json');
const MAX_EVENTS = 500;

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = { events: [], loved: {} }; }
  db.events ??= [];
  db.loved ??= {};
  return db;
}
let t = null;
function save() {
  clearTimeout(t);
  t = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
  }, 200);
}

export function recordSignal(event) {
  const d = load();
  d.events.push({ ts: new Date().toISOString(), ...event });
  if (d.events.length > MAX_EVENTS) d.events.splice(0, d.events.length - MAX_EVENTS);
  save();
}

export function setLoved(product, loved, channel = 'web') {
  const d = load();
  const key = String(product.productId);
  if (loved) d.loved[key] = { ...product, lovedAt: new Date().toISOString() };
  else delete d.loved[key];
  recordSignal({ type: loved ? 'love' : 'unlove', channel, ...product });
  return Object.values(d.loved);
}

// ------------------------------------------------------- current location
// The open tab renders every view any channel produces, so the activity bus
// IS the tab's location. `loc` events remember it; consecutive duplicates are
// skipped so sinceSeconds measures arrival, not the last re-render.

let lastLocSig = null;
function pushLoc(channel, loc) {
  const sig = `${loc.view}|${loc.productId ?? ''}|${loc.query ?? ''}`;
  if (sig === lastLocSig) return;
  lastLocSig = sig;
  recordSignal({ type: 'loc', channel, ...loc });
}

// Called from the activity bus for every emitted event with a rendered view.
export function recordLocation(e) {
  const v = e?.view;
  if (!v) return;
  switch (v.kind) {
    case 'grid':
      return pushLoc(e.channel, { view: 'grid', query: v.query ?? null });
    case 'detail':
    case 'size':
    case 'price':
      if (v.product?.id) return pushLoc(e.channel, { view: 'product', productId: v.product.id, name: v.product.name ?? null });
      return;
    case 'similar':
      return pushLoc(e.channel, { view: 'similar', productId: v.productId ?? null, name: v.anchorName ?? null });
    case 'cart':
      return pushLoc(e.channel, { view: 'bag' });
  }
}

// Client-only navigation (back to results, logo → home) beacons in via
// /api/signals — those moves never reach the tool layer.
export function recordNav(view, query = null) {
  if (!['home', 'grid'].includes(view)) return;
  pushLoc('web', { view, query });
}

function currentLocation() {
  const d = load();
  for (let i = d.events.length - 1; i >= 0; i--) {
    const e = d.events[i];
    if (e.type !== 'loc') continue;
    return {
      view: e.view,
      productId: e.productId ?? null,
      name: e.name ?? null,
      query: e.query ?? null,
      setBy: e.channel === 'web' ? 'human' : e.channel === 'shop' ? 'shop' : 'agent',
      sinceSeconds: Math.max(0, Math.round((Date.now() - new Date(e.ts).getTime()) / 1000)),
    };
  }
  return { view: 'home', productId: null, name: null, query: null, setBy: null, sinceSeconds: null };
}

// The ordered trail: navigation (loc) plus loves, attributed per actor.
// Dwell stays out (aggregated in focus); human searches surface as the grid
// they rendered, so agent and human searches read the same way.
function journeySteps(limit = 14) {
  const d = load();
  const steps = [];
  for (const e of d.events) {
    const who = e.channel === 'web' ? 'human' : e.channel === 'shop' ? 'shop' : 'agent';
    if (e.type === 'loc') {
      if (e.view === 'grid') steps.push({ at: e.ts, who, action: 'viewed results', query: e.query ?? null });
      else if (e.view === 'product') steps.push({ at: e.ts, who, action: 'opened product', productId: e.productId, name: e.name });
      else if (e.view === 'similar') steps.push({ at: e.ts, who, action: 'explored similar items', name: e.name ?? null });
      else if (e.view === 'bag') steps.push({ at: e.ts, who, action: 'opened the bag' });
      else if (e.view === 'home') steps.push({ at: e.ts, who, action: 'went to the home page' });
    } else if (e.type === 'love') steps.push({ at: e.ts, who, action: 'loved ♥', productId: e.productId, name: e.name });
    else if (e.type === 'unlove') steps.push({ at: e.ts, who, action: 'removed love', productId: e.productId, name: e.name });
  }
  return steps.slice(-limit);
}

export function lovedItems() {
  return Object.values(load().loved);
}

const STOP = new Set(['WITH', 'AND', 'THE', 'FIT']);

// ---------------------------------------------------- experience navigation

export function recentlyViewed(limit = 6) {
  const d = load();
  const seen = new Set();
  const out = [];
  for (let i = d.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = d.events[i];
    if (e.type === 'view' && e.productId && e.name && !seen.has(e.productId)) {
      seen.add(e.productId);
      out.push({ productId: e.productId, name: e.name, priceText: e.priceText ?? null, image: e.image ?? null, at: e.ts });
    }
  }
  return out;
}

function majoritySection() {
  const d = load();
  const counts = {};
  for (const e of d.events) if (e.section) counts[e.section] = (counts[e.section] ?? 0) + 1;
  for (const l of Object.values(d.loved)) if (l.section) counts[l.section] = (counts[l.section] ?? 0) + 2;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'MAN';
}

// "Picked for you": a live search built from the taste the events revealed.
export async function pickedForYou(limit = 8) {
  const s = shopperSummary();
  const themes = s.taste.themes.filter((t) => t.word.length > 3).slice(0, 3).map((t) => t.word.toLowerCase());
  if (!themes.length) return { basis: [], products: [] };
  try {
    const res = await searchProducts(themes.join(' '), { section: majoritySection(), limit: limit + 6 });
    const known = new Set([...s.loved.map((l) => l.productId), ...s.focus.map((f) => f.productId)]);
    return { basis: themes, products: res.products.filter((p) => !known.has(p.id)).slice(0, limit) };
  } catch {
    return { basis: themes, products: [] };
  }
}

// Nudges: when the human's last minutes revolve around one theme, the shop
// itself offers the navigation shortcut. Cooldown keeps it rare.
const nudgeSentAt = {};
export function detectNudge() {
  const d = load();
  const cutoff = Date.now() - 15 * 60_000;
  const byWord = {};
  for (const e of d.events) {
    if (new Date(e.ts).getTime() < cutoff) continue;
    if (!['view', 'dwell', 'love'].includes(e.type) || !e.name) continue;
    for (const w of String(e.name).toUpperCase().split(/[^A-Z-]+/)) {
      if (w.length > 3 && !STOP.has(w)) (byWord[w] ??= new Set()).add(e.productId);
    }
  }
  for (const [w, ids] of Object.entries(byWord).sort((a, b) => b[1].size - a[1].size)) {
    if (ids.size >= 3 && (!nudgeSentAt[w] || Date.now() - nudgeSentAt[w] > 30 * 60_000)) {
      nudgeSentAt[w] = Date.now();
      return { theme: w.toLowerCase(), distinctProducts: ids.size, query: w.toLowerCase() };
    }
  }
  return null;
}

export function shopperSummary() {
  const d = load();
  const human = d.events.filter((e) => e.channel === 'web' || e.type === 'dwell' || e.type === 'love' || e.type === 'unlove');
  const loved = lovedItems();

  // Focus: dwell per product + view counts.
  const focus = {};
  for (const e of human) {
    if (!e.productId) continue;
    const f = (focus[e.productId] ??= { productId: e.productId, name: e.name ?? null, views: 0, dwellMs: 0, lastSeen: e.ts });
    if (e.name) f.name = e.name;
    if (e.type === 'view') f.views++;
    if (e.type === 'dwell') f.dwellMs += e.ms ?? 0;
    f.lastSeen = e.ts;
  }
  const topFocus = Object.values(focus)
    .sort((a, b) => b.dwellMs - a.dwellMs || b.views - a.views)
    .slice(0, 8)
    .map((f) => ({ ...f, dwellSeconds: Math.round(f.dwellMs / 1000) }));

  // Taste: word frequencies + price band across loved (weighted) and viewed items.
  const words = {};
  const prices = [];
  const weigh = (name, w) => {
    for (const raw of String(name ?? '').toUpperCase().split(/[^A-Z]+/)) {
      if (raw.length >= 3 && !STOP.has(raw)) words[raw] = (words[raw] ?? 0) + w;
    }
  };
  for (const l of loved) { weigh(l.name, 3); if (l.price) prices.push(l.price); }
  for (const f of topFocus) weigh(f.name, 1);
  const themes = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w, n]) => ({ word: w, weight: n }));

  return {
    current: currentLocation(),
    journey: journeySteps(),
    loved: loved.map((l) => ({ productId: l.productId, name: l.name, price: l.price, priceText: l.priceText, family: l.family ?? null, color: l.color ?? null, lovedAt: l.lovedAt })),
    focus: topFocus,
    recentSearches: human.filter((e) => e.type === 'search').slice(-6).map((e) => e.query),
    taste: {
      themes,
      lovedPriceBand: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    },
    eventCount: human.length,
  };
}
