// Questions the agent asks the human IN THE STORE (ask_shopper). The card
// renders over SSE; the human taps a choice; the tap resolves the agent's
// pending tool call (or is picked up later via get_answer). In-memory: a
// question that outlives the process is not worth answering.

import { randomUUID } from 'node:crypto';

const questions = new Map();
const TTL_MS = 15 * 60_000;

function gc() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, q] of questions) if (new Date(q.askedAt).getTime() < cutoff) questions.delete(id);
}

export function ask({ question, choices, allowFreeText = false, productId = null, productName = null, askedBy = 'agent' }) {
  gc();
  // One card at a time: a new question supersedes whatever was still pending.
  const replaced = [];
  for (const old of questions.values()) {
    if (old.answer) continue;
    old.answer = { replaced: true, at: new Date().toISOString() };
    for (const w of old.waiters.splice(0)) w(old.answer);
    replaced.push(old.id);
  }
  const q = {
    id: randomUUID().slice(0, 8),
    question, choices, allowFreeText, productId, productName, askedBy,
    askedAt: new Date().toISOString(),
    replacedQuestionIds: replaced,
    answer: null,
    waiters: [],
  };
  questions.set(q.id, q);
  return q;
}

export function getQuestion(id) {
  return questions.get(id) ?? null;
}

export function pendingQuestions() {
  gc();
  return [...questions.values()].filter((q) => !q.answer).map(publicView);
}

export function answerQuestion(id, { choice = null, text = null, dismissed = false } = {}) {
  const q = questions.get(id);
  if (!q) return null;
  if (q.answer) return q; // first answer wins
  if (choice != null && !q.choices.includes(choice)) {
    if (!q.allowFreeText) return null;
    text ??= choice; choice = null; // treat an off-list choice as free text
  }
  q.answer = { choice, text, dismissed, at: new Date().toISOString() };
  for (const w of q.waiters.splice(0)) w(q.answer);
  return q;
}

// Resolve with the answer, or null after ms.
export function waitForAnswer(id, ms) {
  const q = questions.get(id);
  if (!q) return Promise.resolve(null);
  if (q.answer) return Promise.resolve(q.answer);
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { q.waiters = q.waiters.filter((w) => w !== done); resolve(null); }, ms);
    const done = (a) => { clearTimeout(timer); resolve(a); };
    q.waiters.push(done);
  });
}

export function publicView(q) {
  const { waiters, ...rest } = q;
  return rest;
}
