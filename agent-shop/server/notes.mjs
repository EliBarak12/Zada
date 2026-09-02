// Agent notes — what the agent writes INTO the store. Today: review verdicts
// (post_findings) keyed by product id, so a verdict survives reloads and
// shows up again whenever the product view renders.

import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.NOTES_DB ?? path.join(process.cwd(), 'data', 'notes.json');

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = { findings: {} }; }
  db.findings ??= {};
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

export function saveFindings(productId, note) {
  const d = load();
  d.findings[String(productId)] = note;
  save();
  return note;
}

export function findingsFor(productId) {
  return load().findings[String(productId)] ?? null;
}
