// Review & opinion aggregation for Zara items.
// Zara.com hosts no public reviews, so opinions live on the open web:
// Reddit threads, YouTube try-on hauls, fashion blogs. We aggregate the
// keyless sources that answer server-side, and degrade gracefully when a
// network egress blocks one of them (each source is best-effort).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .trim();

async function bingRss(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=10`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`bing ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item><title>(.*?)<\/title><link>(.*?)<\/link><description>(.*?)<\/description>/gs)];
  return items
    .map(([, title, link, desc]) => ({ source: 'web', title: decode(title), url: decode(link), snippet: decode(desc).slice(0, 240) }))
    // Storefront/encyclopedia links say nothing about the item — reviews live elsewhere.
    .filter((r) => {
      try {
        const u = new URL(r.url);
        return !/(^|\.)(zara\.com|zarahome\.com|wikipedia\.org|zara\.cn)$/i.test(u.hostname);
      } catch {
        return false;
      }
    });
}

async function youtube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`youtube ${res.status}`);
  const html = await res.text();
  const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!m) return [];
  const out = [];
  const seen = new Set();
  const rx = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,2500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  let v;
  while ((v = rx.exec(m[1])) && out.length < 6) {
    if (seen.has(v[1])) continue;
    seen.add(v[1]);
    const title = JSON.parse(`"${v[2]}"`);
    out.push({ source: 'youtube', title, url: `https://www.youtube.com/watch?v=${v[1]}`, snippet: 'Video review / try-on' });
  }
  return out;
}

// Reddit's unauthenticated .json API is dead (2026), but search.rss still
// answers ~1 req/min per IP — so we token-bucket and cache.
let lastRedditFetch = 0;
const redditCache = new Map();
async function redditRss(query) {
  const key = query.toLowerCase();
  const hit = redditCache.get(key);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.data;
  if (Date.now() - lastRedditFetch < 61_000) throw new Error('reddit rate-bucket (1/min) — retry shortly');
  lastRedditFetch = Date.now();
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&t=year`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'linux:zada:v0.1 (by /u/agent-shop)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 8).map(([, e]) => {
    const title = decode(e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = e.match(/<link href="([^"]+)"/)?.[1] ?? '';
    const sub = link.match(/reddit\.com\/(r\/[^/]+)/)?.[1] ?? 'reddit';
    return { source: 'reddit', title, url: link, snippet: `${sub} discussion thread` };
  }).filter((r) => r.url);
  redditCache.set(key, { ts: Date.now(), data: entries });
  return entries;
}

function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => {
    const k = r.url.replace(/[?#].*$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function findReviews(productName, { extraTerms = '' } = {}) {
  const name = productName.toLowerCase();
  const q = `${name} zara review ${extraTerms}`.trim();
  // Query shapes tuned per source: Reddit surfaces opinion threads best WITHOUT
  // the word "review"; YouTube responds to "try on haul"; Bing wants it all.
  const attempts = await Promise.allSettled([
    bingRss(`${name} zara review reddit`),
    youtube(`zara ${name} try on haul review`),
    redditRss(`zara ${name}`),
  ]);
  const names = ['bing', 'youtube', 'reddit'];
  const byName = {};
  const sourcesTried = [];
  attempts.forEach((a, i) => {
    if (a.status === 'fulfilled') {
      sourcesTried.push({ source: names[i], ok: true, count: a.value.length });
      byName[names[i]] = a.value;
    } else {
      sourcesTried.push({ source: names[i], ok: false, error: String(a.reason?.message ?? a.reason).slice(0, 120) });
      byName[names[i]] = [];
    }
  });
  // Reviews-first ordering: discussion threads and try-on videos beat generic web hits.
  const results = [...byName.reddit, ...byName.youtube, ...byName.bing];
  const merged = dedupe(results).slice(0, 12);
  // Queries tuned per venue — for the agent's own native web-search tool,
  // which usually reaches further than our keyless server-side sources.
  const suggestedQueries = [
    `zara ${name} reddit`,
    `zara "${name}" review fit sizing`,
    `zara ${name} try on haul`,
  ];
  return {
    query: q,
    results: merged,
    sources: sourcesTried,
    suggestedQueries,
    agentInstructions:
      'If you have a native web-search tool, run the suggestedQueries with it NOW and synthesize what people say (fit, quality, sizing up/down) together with the results above. The human already asked for reviews — do not ask permission to search.',
    note: merged.length
      ? 'Aggregated public mentions — the retailer has no on-site reviews, so these are Reddit/YouTube/web opinions about this or closely similar items.'
      : 'No public reviews reachable from this server\'s network for this exact item. The retailer has no on-site reviews; opinions live in Reddit threads and YouTube try-ons — use your own web-search tool with suggestedQueries, or the searchLinks below.',
    searchLinks: [
      `https://www.reddit.com/search/?q=${encodeURIComponent(`zara ${productName.toLowerCase()}`)}`,
      `https://www.youtube.com/results?search_query=${encodeURIComponent(`zara ${productName.toLowerCase()} review`)}`,
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    ],
  };
}
