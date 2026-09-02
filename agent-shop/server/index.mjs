// Zada — one process, three surfaces:
//   GET  /            the storefront web app (registers WebMCP page tools)
//   POST /api/tools/:name + GET /api/events   tool execution + live SSE mirror
//   ALL  /mcp         remote MCP endpoint (streamable HTTP)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, executeTool, onActivity, maybeNudge } from './tools.mjs';
import { cartSummary } from './cart.mjs';
import { recordSignal, recordNav, lovedItems, recentlyViewed, pickedForYou } from './signals.mjs';
import { similarProducts } from './zara.mjs';
import { handleMcpRequest } from './mcp.mjs';
import { zodToJsonSchema } from './zod-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4977);
const WEBMCP_ORIGIN_TRIAL_TOKEN = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN?.trim();

const app = express();
app.use(express.json({ limit: '2mb' }));

// The page and the MCP endpoint may be served from different origins in
// hosted setups; keep the API permissive — it is read-only shop data.
app.use((req, res, next) => {
  // Chrome's WebMCP origin trial wants origin-keyed agent clustering.
  res.setHeader('Origin-Agent-Cluster', '?1');
  // The token is issued for this exact HTTPS origin by Chrome's origin-trial
  // dashboard. Without it (or Chrome's experimental flag), modelContext is
  // unavailable and the page falls back to remote MCP.
  if (WEBMCP_ORIGIN_TRIAL_TOKEN) {
    res.setHeader('Origin-Trial', WEBMCP_ORIGIN_TRIAL_TOKEN);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------------- MCP
app.all('/mcp', (req, res) => {
  handleMcpRequest(req, res).catch((err) => {
    console.error('MCP error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err.message) }, id: null });
  });
});

// ----------------------------------------------------------------- tool API
app.get('/api/tools', (_req, res) => {
  res.json({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      readOnly: t.readOnly,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  });
});

// Every tool is agent-invokable, so keep an abuse ceiling: 90 calls/min/IP.
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { count: 0, reset: now + 60_000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 60_000; }
  b.count++;
  buckets.set(ip, b);
  return b.count > 90;
}

app.post('/api/tools/:name', async (req, res) => {
  if (rateLimited(req.ip ?? 'unknown')) {
    return res.status(429).json({ ok: false, error: 'Rate limit: max 90 tool calls per minute.' });
  }
  try {
    const result = await executeTool(req.params.name, req.body ?? {}, req.get('x-channel') ?? 'web');
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message) });
  }
});

// --------------------------------------------------------- live activity SSE
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: {}\n\n`);
  const off = onActivity((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => { off(); clearInterval(ping); });
});

// Image relay: the UI loads product photos through us so it works behind
// strict CSPs/proxies and never hotlinks the CDN from the user's browser.
// Allowlisted to Zara's static hosts only.
app.get('/img', async (req, res) => {
  try {
    const u = new URL(String(req.query.u ?? ''));
    if (!/^static\.zara\.(net|cn)$/.test(u.hostname) || u.protocol !== 'https:') {
      return res.status(400).send('only static.zara.net images');
    }
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// Quiet bag-count read for page boot (no activity event, unlike view_cart).
app.get('/api/cart', (_req, res) => {
  const s = cartSummary();
  res.json({ count: s.count, subtotal: s.subtotal });
});

// Shopper telemetry from the page: dwell time on a product view, plus the
// client-only navigation moves (back to results, logo → home) the tool layer
// never sees — these keep the agent's `current` location honest.
app.post('/api/signals', (req, res) => {
  const { type, productId, name, ms, where, query } = req.body ?? {};
  if (type === 'dwell' && productId && Number.isFinite(ms) && ms > 500 && ms < 30 * 60_000) {
    recordSignal({ type: 'dwell', channel: 'web', productId, name: name ?? null, ms: Math.round(ms) });
    maybeNudge();
  } else if (type === 'nav' && ['home', 'grid'].includes(where)) {
    recordNav(where, typeof query === 'string' ? query.slice(0, 120) : null);
  }
  res.json({ ok: true });
});
app.get('/api/loved', (_req, res) => {
  res.json({ ids: lovedItems().map((l) => l.productId) });
});

// One quiet call powering the event-driven navigation: hero rails (continue
// where you left off, loves, picked-for-you) and the SEEN badges in the grid.
app.get('/api/experience', async (_req, res) => {
  const recent = recentlyViewed(6);
  res.json({
    recent,
    loved: lovedItems().slice(-8).reverse(),
    forYou: await pickedForYou(8),
    viewedIds: recent.map((r) => r.productId),
  });
});

// Quiet "more like this" for product pages (the agent-facing version is the
// find_similar tool, which also narrates to the feed).
app.get('/api/similar/:id', async (req, res) => {
  try {
    res.json(await similarProducts(Number(req.params.id), { limit: 8 }));
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'zada' }));

// ---------------------------------------------------------------- web app
app.use(express.static(path.join(__dirname, '..', 'web')));

app.listen(PORT, () => {
  console.log(`Zada
  storefront  http://localhost:${PORT}/
  MCP (HTTP)  http://localhost:${PORT}/mcp
  activity    http://localhost:${PORT}/api/events`);
});
