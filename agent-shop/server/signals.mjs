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

let seq = 0;
export function recordSignal(event) {
  const d = load();
  if (!seq) seq = d.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  d.events.push({ ts: new Date().toISOString(), seq: ++seq, ...event });
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
let lastLocChannel = null;
function pushLoc(channel, loc) {
  const sig = `${loc.view}|${loc.productId ?? ''}|${loc.query ?? ''}`;
  // Same place again: skip re-renders by the same actor (size check after
  // opening, etc.) and agent re-renders of where the human already is — but a
  // HUMAN arriving somewhere the agent showed them is a real move, keep it.
  if (sig === lastLocSig && (channel === lastLocChannel || channel !== 'web')) return;
  lastLocSig = sig;
  lastLocChannel = channel;
  recordSignal({ type: 'loc', channel, ...loc });
}

// Called from the activity bus for every emitted event with a rendered view.
export function recordLocation(e) {
  const v = e?.view;
  if (!v || v.navigate === false) return; // quiet lookups don't move the human
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

export function currentLocation() {
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

// One event → one human-readable step (shared by the journey and the inbox).
function stepFor(e, { withDwell = false } = {}) {
  const who = e.channel === 'web' ? 'human' : e.channel === 'shop' ? 'shop' : 'agent';
  const base = { at: e.ts, who };
  if (e.type === 'loc') {
    if (e.view === 'grid') return { ...base, action: 'viewed results', query: e.query ?? null };
    if (e.view === 'product') return { ...base, action: 'opened product', productId: e.productId, name: e.name };
    if (e.view === 'similar') return { ...base, action: 'explored similar items', name: e.name ?? null };
    if (e.view === 'bag') return { ...base, action: 'opened the bag' };
    if (e.view === 'home') return { ...base, action: 'went to the home page' };
    return null;
  }
  if (e.type === 'love') return { ...base, action: 'loved ♥', productId: e.productId, name: e.name };
  if (e.type === 'unlove') return { ...base, action: 'removed love', productId: e.productId, name: e.name };
  if (e.type === 'question') return { ...base, action: 'asked', question: e.question, productId: e.productId ?? null, name: e.name ?? null };
  if (e.type === 'answer') return { ...base, action: e.dismissed ? 'dismissed the question' : 'answered', choice: e.choice ?? e.text ?? null, question: e.question };
  if (e.type === 'agent_write') return { ...base, action: 'wrote a verdict on', productId: e.productId, name: e.name };
  if (e.type === 'bag_add') return { ...base, action: 'added to bag', productId: e.productId, name: e.name, size: e.size ?? null, color: e.color ?? null };
  if (e.type === 'bag_remove') return { ...base, action: 'removed from bag', productId: e.productId ?? null, name: e.name ?? null };
  if (e.type === 'nudge') return { ...base, action: 'offered a shortcut around', theme: e.theme };
  if (withDwell && e.type === 'dwell' && e.ms >= 5000) return { ...base, action: 'lingered', seconds: Math.round(e.ms / 1000), productId: e.productId, name: e.name };
  return null;
}

// The ordered trail: navigation (loc) plus loves and questions, attributed
// per actor. Dwell stays out (aggregated in focus); human searches surface as
// the grid they rendered, so agent and human searches read the same way.
function journeySteps(limit = 14) {
  const d = load();
  const steps = [];
  for (const e of d.events) { const s = stepFor(e); if (s) steps.push(s); }
  return steps.slice(-limit);
}

// ------------------------------------------------------------ agent inbox
// What the human (and the shop itself) did since this agent channel last
// called a tool. Rides along in every tool result as `shopper`, so the agent
// sees the human's moves without being told — the one event channel that
// works identically on every client, because it is just data in a result.
const cursors = {}; // channel -> last seq drained
export function drainInbox(channel, limit = 6) {
  const d = load();
  const last = d.events.length ? d.events[d.events.length - 1].seq ?? 0 : 0;
  const from = cursors[channel];
  cursors[channel] = last;
  const now = Date.now();
  // First contact: hand over the human's recent trail (last 10 minutes), so
  // the agent's very first result already knows what they have been doing.
  const firstContact = from == null;
  const cutoff = now - 10 * 60_000;
  const out = [];
  for (const e of d.events) {
    if (firstContact ? new Date(e.ts).getTime() < cutoff : (e.seq ?? 0) <= from) continue;
    if (!(e.channel === 'web' || e.channel === 'shop')) continue;
    const s = stepFor(e, { withDwell: true });
    if (s) out.push({ ...s, agoSeconds: Math.max(0, Math.round((now - new Date(e.ts).getTime()) / 1000)) });
  }
  return out.slice(-limit);
}

export function shopperContext(channel) {
  const since = drainInbox(channel);
  const ctx = { current: currentLocation(), sinceYourLastCall: since };
  if (since.length) ctx.hint = 'The human did this since your last call — acknowledge it in one sentence and build on it.';
  return ctx;
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
    if (!e.productId || ['question', 'answer', 'agent_write', 'loc'].includes(e.type)) continue;
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
    answers: human.filter((e) => e.type === 'answer' && !e.dismissed).slice(-5).map((e) => ({ at: e.ts, question: e.question, choice: e.choice ?? e.text ?? null, productId: e.productId ?? null })),
    taste: {
      themes,
      lovedPriceBand: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    },
    eventCount: human.length,
  };
}
