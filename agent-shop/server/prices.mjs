// Price memory. Every product that flows through any tool gets its price
// recorded, so over time the shop learns each item's history and can answer
// "was this ever cheaper?". Zara's own oldPrice field gives an immediate
// "reduced right now" signal even on first sight.

import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.PRICE_DB ?? path.join(process.cwd(), 'data', 'prices.json');

let db = null;
function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = {};
  }
  return db;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
  }, 250);
}

export function recordPrice(productId, price, oldPrice = null, name = null) {
  if (price == null) return;
  const d = load();
  const key = String(productId);
  const entry = (d[key] ??= { name, history: [] });
  if (name) entry.name = name;
  const last = entry.history.at(-1);
  const today = new Date().toISOString().slice(0, 10);
  if (!last || last.price !== price || last.oldPrice !== oldPrice) {
    entry.history.push({ date: today, price, oldPrice });
  } else {
    last.date = today; // refresh the observation date for an unchanged price
  }
  if (entry.history.length > 400) entry.history.splice(0, entry.history.length - 400);
  save();
}

export function priceReport(productId, currentPrice = null, currentOldPrice = null) {
  const d = load();
  const entry = d[String(productId)];
  const history = entry?.history ?? [];
  const prices = history.map((h) => h.price).concat(currentPrice != null ? [currentPrice] : []);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const firstSeen = history[0] ?? null;

  let verdict;
  if (currentOldPrice != null && currentPrice != null && currentPrice < currentOldPrice) {
    const pct = Math.round((1 - currentPrice / currentOldPrice) * 100);
    verdict = `Reduced right now: the retailer lists it ${pct}% below its previous price.`;
  } else if (currentPrice != null && min != null && currentPrice > min) {
    verdict = `It has been cheaper: the lowest we've tracked is ${min / 100} vs ${currentPrice / 100} today.`;
  } else if (currentPrice != null && history.length > 1) {
    verdict = 'This is the lowest price we have tracked for this item.';
  } else {
    verdict = 'No earlier price on record yet — tracking starts now; ask again after the next sale.';
  }

  return {
    tracked: history.length,
    firstSeen: firstSeen?.date ?? null,
    lowest: min,
    highest: max,
    history: history.slice(-30),
    verdict,
  };
}
