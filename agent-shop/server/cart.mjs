// The bag. The agent fills it (in the human's size, validated against live
// stock); checkout stays with the human on zara.com — deliberately. We never
// touch Zara's real cart (that would need their authenticated session).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.CART_DB ?? path.join(process.cwd(), 'data', 'cart.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; }
}
function save(cart) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cart, null, 2));
}

export function cartItems() {
  return load().items;
}

export function addItem(item) {
  const cart = load();
  const existing = cart.items.find(
    (i) => i.productId === item.productId && i.size === item.size && i.color === item.color,
  );
  if (existing) {
    existing.quantity = Math.min(existing.quantity + (item.quantity ?? 1), 9);
    save(cart);
    return existing;
  }
  const full = { cartId: crypto.randomUUID().slice(0, 8), addedAt: new Date().toISOString(), quantity: 1, ...item };
  cart.items.push(full);
  save(cart);
  return full;
}

// onlyAddedBy: when set (e.g. 'agent'), lines added by anyone else survive —
// an agent removing "by product" never deletes what the human put in.
export function removeItem({ cartId, productId, onlyAddedBy = null }) {
  const cart = load();
  const before = cart.items.length;
  cart.items = cart.items.filter((i) => {
    const hit = cartId ? i.cartId === cartId : i.productId === productId;
    if (!hit) return true;
    if (onlyAddedBy && i.addedBy !== onlyAddedBy) return true;
    return false;
  });
  save(cart);
  return before - cart.items.length;
}

export function cartSummary() {
  const items = cartItems();
  return {
    count: items.reduce((n, i) => n + i.quantity, 0),
    items,
    subtotal: items.reduce((n, i) => n + (i.priceAtAdd ?? 0) * i.quantity, 0),
  };
}
