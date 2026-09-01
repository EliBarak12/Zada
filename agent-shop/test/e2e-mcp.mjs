// E2E: a real MCP client drives the shop over streamable HTTP against live
// Zara data — the exact path remote connectors (ChatGPT, Gemini CLI, Cursor)
// use. Starts its own server on a test port.
//
//   node test/e2e-mcp.mjs

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 4991;
const URL_ = `http://localhost:${PORT}/mcp`;

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

import fs from 'node:fs';
fs.rmSync('/tmp/zas-test-cart.json', { force: true });
fs.rmSync('/tmp/zas-test-signals.json', { force: true });
const server = spawn('node', ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), PRICE_DB: '/tmp/zas-test-prices.json', PROFILE_DB: '/tmp/zas-test-profile.json', CART_DB: '/tmp/zas-test-cart.json', SIGNALS_DB: '/tmp/zas-test-signals.json' },
  stdio: 'inherit',
});
await sleep(2000);

try {
  const client = new Client({ name: 'e2e-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  console.log('\n— MCP handshake');
  check('connected over streamable HTTP', true);

  const { tools } = await client.listTools();
  check('lists 14 tools', tools.length === 14, tools.map((t) => t.name).join(', '));
  check('every tool has a JSON schema', tools.every((t) => t.inputSchema?.type === 'object'));

  console.log('\n— search_products("men\'s pants")');
  const parse = (r) => JSON.parse(r.content[0].text);
  const search = parse(await client.callTool({ name: 'search_products', arguments: { query: "men's pants", limit: 8 } }));
  check('resolves MAN section', search.section === 'MAN');
  check('finds products', search.products.length > 0, `${search.products.length} of ${search.total}`);
  const p0 = search.products[0];
  check('products carry ids/names/prices', Boolean(p0.id && p0.name && p0.price));
  check('products carry image URLs', p0.images.length > 0 && p0.images[0].startsWith('https://static.zara.net'));

  console.log('\n— set_my_sizes / get_product');
  await client.callTool({ name: 'set_my_sizes', arguments: { tops: 'M', bottoms: '32', shoes: '43' } });
  const detail = parse(await client.callTool({ name: 'get_product', arguments: { product_id: p0.id } }));
  check('full detail has colors + sizes', detail.colorDetails.length > 0 && detail.colorDetails[0].sizes.length > 0);
  check('detail has gallery images', detail.images.length >= 3, `${detail.images.length} images`);
  check('detail links to zara.com', typeof detail.url === 'string' && detail.url.includes('zara.com'));

  console.log('\n— check_size_availability (saved profile)');
  const size = parse(await client.callTool({ name: 'check_size_availability', arguments: { product_id: p0.id } }));
  check('checks the saved size automatically', size.usingSavedProfile === true, `checked "${size.checked}" → ${size.inStockAnywhere ? 'in stock' : 'not in stock'}${size.matchType && size.matchType !== 'exact' ? ` (${size.matchType})` : ''}`);
  check('reports availability verdict', typeof size.inStockAnywhere === 'boolean');

  console.log('\n— check_price');
  const price = parse(await client.callTool({ name: 'check_price', arguments: { product_id: p0.id } }));
  check('price report has current price', price.current > 0, price.currentText);
  check('price report has a verdict', typeof price.verdict === 'string' && price.verdict.length > 10, price.verdict);

  console.log('\n— find_reviews');
  const reviews = parse(await client.callTool({ name: 'find_reviews', arguments: { product_id: p0.id } }));
  check('review search ran across sources', reviews.sources.length === 3, reviews.sources.map((s) => `${s.source}:${s.ok ? s.count : 'blocked'}`).join(' '));
  check('returns results or honest fallback links', reviews.results.length > 0 || reviews.searchLinks.length > 0, `${reviews.results.length} mentions`);
  check('steers the agent to its own native search', reviews.suggestedQueries?.length >= 3 && /web-search tool/.test(reviews.agentInstructions ?? ''), reviews.suggestedQueries?.[0]);

  console.log('\n— filter by anything');
  const sized = parse(await client.callTool({ name: 'search_products', arguments: { query: "men's pants", limit: 6, in_my_size_only: true } }));
  check('in-my-size search returns only items in stock in the profile size', sized.products.length > 0 && sized.products.every((p) => p.yourSize?.inStock === true), `${sized.products.length} items, e.g. ${sized.products[0]?.yourSize?.matched ?? '?'} (${sized.products[0]?.yourSize?.matchType ?? 'exact'})`);
  const filtered = parse(await client.callTool({ name: 'search_products', arguments: { query: "men's pants", limit: 10, max_price: 250, exclude_words: ['jogging'], sort: 'price_asc' } }));
  check('price cap + exclude words + sort respected', filtered.products.every((p) => p.price <= 25000 && !/jogging/i.test(p.name)) && filtered.products.every((p, i, a) => i === 0 || a[i - 1].price <= p.price), `${filtered.products.length} items, filters: ${filtered.appliedFilters.join(' · ')}`);

  console.log('\n— find_similar (lateral navigation)');
  const similar = parse(await client.callTool({ name: 'find_similar', arguments: { product_id: p0.id, limit: 6 } }));
  check('similar items found for the anchor', similar.products.length > 0, `${similar.products.length} similar to “${similar.anchor.name}”`);
  check('anchor excluded from its own results', similar.products.every((s) => s.id !== similar.anchor.id));

  console.log('\n— shopper signals: love → read back');
  const lovedRes = parse(await client.callTool({ name: 'love_item', arguments: { product_id: p0.id } }));
  check('love_item marks the product', lovedRes.ok === true && lovedRes.loved === true, lovedRes.product);
  check('love returns the item parameters', lovedRes.parameters?.styleWords?.length > 0 && 'price' in lovedRes.parameters, lovedRes.parameters?.styleWords?.join(', '));
  check('love steers the agent to suggest similar', /find_similar/.test(lovedRes.suggestion ?? ''));
  const signals = parse(await client.callTool({ name: 'get_shopper_signals', arguments: {} }));
  check('signals list the loved item', signals.loved.some((l) => l.productId === lovedRes.productId), `${signals.loved.length} loved`);
  check('signals derive taste themes', Array.isArray(signals.taste.themes), signals.taste.themes.slice(0, 3).map((t) => t.word).join(', '));
  check('signals steer the agent to personalize', /personalize|lingered/i.test(signals.agentInstructions ?? ''));

  console.log('\n— shopper signals: current location + journey');
  // The catalog may resolve a grid id to its master product id — compare
  // against the id the detail view actually opened with.
  const opened = parse(await client.callTool({ name: 'get_product', arguments: { product_id: p0.id } }));
  const sig2 = parse(await client.callTool({ name: 'get_shopper_signals', arguments: {} }));
  check(
    'current location is the open product',
    sig2.current?.view === 'product' && sig2.current.productId === opened.id && Number.isFinite(sig2.current.sinceSeconds),
    `${sig2.current?.view} · ${sig2.current?.name} (${sig2.current?.sinceSeconds}s, by ${sig2.current?.setBy})`,
  );
  const j = sig2.journey ?? [];
  check(
    'journey is an ordered, attributed trail',
    j.length >= 3 && j.every((s) => s.at && s.who && s.action) && j.every((s, i) => i === 0 || s.at >= j[i - 1].at),
    j.slice(-3).map((s) => `${s.who}: ${s.action}`).join(' → '),
  );
  check('journey records the love, attributed to the agent', j.some((s) => s.action === 'loved ♥' && s.productId === lovedRes.productId && s.who === 'agent'));

  console.log('\n— cart: add in my size → view → remove');
  const added = parse(await client.callTool({ name: 'add_to_cart', arguments: { product_id: p0.id } }));
  check('adds to bag in the saved size', added.ok === true && added.added?.size, `size ${added.added?.size}${added.note ? ` — ${added.note}` : ''}`);
  const bag = parse(await client.callTool({ name: 'view_cart', arguments: {} }));
  check('bag lists the item with live re-check', bag.count >= 1 && bag.items[0].availabilityNow !== undefined, `${bag.count} items, ${bag.subtotalText}`);
  check('bag links to zara.com for checkout', bag.items.every((i) => i.url?.includes('zara.com')));
  const removed = parse(await client.callTool({ name: 'remove_from_cart', arguments: { cart_id: bag.items[0].cartId } }));
  check('removes from bag', removed.ok === true && removed.removed === 1, `bag now ${removed.bag.count}`);
  const oos = parse(await client.callTool({ name: 'add_to_cart', arguments: { product_id: p0.id, size: 'NOSUCHSIZE' } }));
  check('structured failure on impossible size', oos.ok === false && typeof oos.code === 'string', oos.code);

  console.log('\n— sale hunt (on_sale_only)');
  const sale = parse(await client.callTool({ name: 'search_products', arguments: { query: 'man sale', section: 'MAN', limit: 10, on_sale_only: true } }));
  check('sale filter returns only reduced items (or none live)', sale.products.every((p) => p.onSale));

  await client.close();
} catch (err) {
  console.error('E2E fatal:', err);
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\nMCP E2E: ALL PASS' : `\nMCP E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
