import fs from 'node:fs';
import path from 'node:path';
// Zara storefront data client.
// Uses the same public JSON endpoints the zara.com web app calls (?ajax=true),
// which respond to plain HTTPS requests carrying ordinary browser headers.
// No login, no cookies, read-only.

const STORE = process.env.ZARA_STORE ?? 'il';
const LANG = process.env.ZARA_LANG ?? 'en';
const BASE = `https://www.zara.com/${STORE}/${LANG}`;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function getJson(url, { fast403 = false } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  // Akamai occasionally rejects a cold first request — retry briefly.
  // fast403: for endpoints Akamai blocks deterministically (products-details),
  // a 403 exits immediately so the HTML-page fallback can take over.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const err = new Error(`Zara responded ${res.status} for ${url}`);
        err.status = res.status;
        if (res.status === 403 && fast403) err.noRetry = true;
        throw err;
      }
      const data = await res.json();
      cache.set(url, { ts: Date.now(), data });
      return data;
    } catch (err) {
      lastErr = err;
      if (err.noRetry) break;
    }
  }
  throw lastErr;
}

// -------------------------------------------- product-page HTML fallback
// Akamai blocks /products-details for server-side callers (deterministic
// 403), while the product HTML pages stay reachable behind a bm-verify
// interstitial. We follow the interstitial once, keep the cookies, and read
// the same product object from window.zara.viewPayload embedded in the page.

// productId -> product page URL, recorded on search. Persisted, so a restart
// (Fly redeploy, crash) never strands a product behind "run search first".
const URLS_FILE = process.env.PRODUCT_URLS_DB ?? path.join(process.cwd(), 'data', 'product-urls.json');
function loadUrlMap() {
  try { return Object.entries(JSON.parse(fs.readFileSync(URLS_FILE, 'utf8'))).map(([k, v]) => [Number(k), v]); } catch { return []; }
}
const urlById = new Map(loadUrlMap());
let urlSaveTimer = null;
function setUrl(id, url) {
  if (!id || !url || urlById.get(id) === url) return;
  urlById.set(id, url);
  clearTimeout(urlSaveTimer);
  urlSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(URLS_FILE), { recursive: true });
      fs.writeFileSync(URLS_FILE, JSON.stringify(Object.fromEntries(urlById)));
    } catch { /* best effort */ }
  }, 500);
}

// Colourways of one product share a model key (the first two reference
// segments) — the identity that groups variant ids across tools.
export function modelKey(ref) {
  const m = String(ref ?? '').split('/').slice(0, 2).join('/');
  return m || null;
}

let pageCookies = '';
function collectCookies(res) {
  const setc = res.headers.getSetCookie?.() ?? [];
  if (!setc.length) return;
  const jar = new Map(pageCookies.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
  for (const c of setc) {
    const kv = c.split(';')[0];
    if (kv.includes('=')) jar.set(kv.split('=')[0], kv);
  }
  pageCookies = [...jar.values()].join('; ');
}

export function extractViewPayload(html) {
  const m = html.match(/window\.zara\.viewPayload\s*=\s*(\{.*?\});?\s*<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function fetchProductPage(url) {
  const headers = () => ({ ...HEADERS, Accept: 'text/html,application/xhtml+xml', ...(pageCookies ? { Cookie: pageCookies } : {}) });
  let res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  collectCookies(res);
  let html = await res.text();
  // bm-verify interstitial: a tiny page whose meta refresh carries the token.
  const verify = html.length < 20_000 && html.match(/URL='([^']*bm-verify[^']*)'/);
  if (verify) {
    const next = verify[1].startsWith('http') ? verify[1] : `https://www.zara.com${verify[1]}`;
    res = await fetch(next, { headers: headers(), signal: AbortSignal.timeout(30_000) });
    collectCookies(res);
    html = await res.text();
  }
  if (res.status === 410) throw new Error('Product page gone (410) — item no longer sold');
  if (!res.ok && res.status !== 200) throw new Error(`Product page responded ${res.status}`);
  return html;
}

async function detailFromPage(productId) {
  const key = `page:${productId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  const url = urlById.get(Number(productId));
  if (!url) {
    throw new Error(`No page URL known for product ${productId} — run search_products first so the product is seen once.`);
  }
  // A stale Akamai cookie in the jar can poison every page fetch for the
  // life of the process (Zara then serves challenges the handshake can't
  // pass). If the first attempt fails, drop the jar and redo the
  // bm-verify handshake from scratch once.
  let product = null;
  let lastErr = null;
  for (const freshJar of [false, true]) {
    if (freshJar) pageCookies = '';
    try {
      const html = await fetchProductPage(url);
      product = extractViewPayload(html)?.product;
      if (product?.name) break;
      product = null;
      lastErr = new Error(`Could not read product data from the page for ${productId}`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!product?.name) throw lastErr;
  cache.set(key, { ts: Date.now(), data: product });
  // The page product carries its own (master) id — alias it to the same URL
  // and cache entry so follow-up calls on that id resolve too.
  if (product.id && product.id !== Number(productId)) {
    setUrl(product.id, url);
    cache.set(`page:${product.id}`, { ts: Date.now(), data: product });
  }
  for (const c of product.detail?.colors ?? []) if (c.productId) setUrl(c.productId, url);
  return product;
}

export function currency() {
  return STORE === 'il' ? 'ILS' : STORE === 'us' ? 'USD' : 'EUR';
}

export function formatPrice(cents) {
  if (cents == null) return null;
  const sym = { ILS: '₪', USD: '$', EUR: '€' }[currency()] ?? '';
  return `${sym}${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------- categories

let catTree = null;
export async function categories() {
  if (!catTree) {
    const d = await getJson(`${BASE}/categories?ajax=true`);
    catTree = d.categories;
  }
  return catTree;
}

function flatten(cats, section = null, path = [], out = []) {
  for (const c of cats ?? []) {
    const sec = c.sectionName || section;
    const name = (c.name || '').trim();
    const key = c.key || '';
    if (name && !key.includes('DIVIDER')) {
      out.push({ id: c.id, name, section: sec, path: [...path, name].join(' > '), redirect: c.redirectCategoryId });
      flatten(c.subcategories, sec, [...path, name], out);
    } else {
      flatten(c.subcategories, sec, path, out);
    }
  }
  return out;
}

export async function flatCategories(section) {
  const flat = flatten(await categories());
  return section ? flat.filter((c) => c.section === section) : flat;
}

// ------------------------------------------------------------------ products

function collectProducts(categoryJson) {
  const out = [];
  for (const pg of categoryJson.productGroups ?? []) {
    for (const el of pg.elements ?? []) {
      for (const cc of el.commercialComponents ?? []) {
        if (cc.type === 'Product' && cc.name) out.push(cc);
      }
    }
  }
  return out;
}

export async function categoryProducts(categoryId) {
  const d = await getJson(`${BASE}/category/${categoryId}/products?ajax=true`);
  return collectProducts(d);
}

function imageUrls(color, width = 750) {
  const urls = [];
  for (const m of color?.xmedia ?? []) {
    const u = m?.extraInfo?.deliveryUrl || (m?.path && m?.name ? `https://static.zara.net${m.path}/${m.name}.jpg?ts=${m.timestamp ?? ''}` : null);
    if (u && m.type === 'image') urls.push(`${u}${u.includes('?') ? '&' : '?'}w=${width}`);
  }
  return urls;
}

export function productUrl(p) {
  const seo = p.seo ?? {};
  if (seo.keyword && seo.seoProductId) return `${BASE}/${seo.keyword}-p${seo.seoProductId}.html`;
  const ref = (p.detail?.reference || p.reference || '').split('-')[0];
  return ref ? `${BASE}/-P${ref}.html` : null;
}

export function summarize(p, { imageWidth = 750, maxImages = 6 } = {}) {
  const colors = p.detail?.colors ?? [];
  const first = colors[0] ?? {};
  const price = p.price ?? first.price ?? null;
  const oldPrice = p.oldPrice ?? null;
  // Remember every product's page URL — it's the way back to full details
  // when Akamai blocks the JSON endpoint (see detailFromPage).
  const pageUrl = productUrl(p);
  if (pageUrl) {
    setUrl(p.id, pageUrl);
    for (const c of colors) if (c.productId) setUrl(c.productId, pageUrl);
  }
  return {
    id: p.id,
    name: p.name,
    reference: p.detail?.displayReference || p.detail?.reference || p.reference || null,
    model: modelKey(p.detail?.displayReference || p.detail?.reference || p.reference),
    section: p.sectionName ?? null,
    family: p.familyName ?? null,
    price,
    priceText: formatPrice(price),
    oldPrice,
    oldPriceText: formatPrice(oldPrice),
    onSale: oldPrice != null && price != null && price < oldPrice,
    discountPct: oldPrice && price ? Math.round((1 - price / oldPrice) * 100) : null,
    colors: colors.map((c) => ({ id: c.id, name: c.name, hex: c.hexCode ?? null })),
    images: imageUrls(first, imageWidth).slice(0, maxImages),
    url: productUrl(p),
  };
}

// ------------------------------------------------------------------- search

// Category the query into Zara's tree, then keyword-filter product names.
const SYNONYMS = {
  pants: 'trousers', pant: 'trousers', slacks: 'trousers', chinos: 'trousers',
  jean: 'jeans', denim: 'jeans',
  sneakers: 'trainers', sneaker: 'trainers', shoes: 'shoes', shoe: 'shoes',
  tshirt: 't-shirts', 'tee': 't-shirts', tshirts: 't-shirts', 't-shirt': 't-shirts',
  hoodie: 'hoodies', sweatshirt: 'sweatshirts', jumper: 'sweaters', sweater: 'sweaters', knit: 'sweaters',
  coat: 'jackets', jacket: 'jackets', blazer: 'blazers', suit: 'suits', shirt: 'shirts',
  shorts: 'shorts', polo: 'polo shirts', overshirt: 'overshirts', bag: 'bags', backpack: 'backpacks',
};

const SECTION_WORDS = {
  MAN: ['man', 'men', "men's", 'mens', 'male', 'guy'],
  WOMAN: ['woman', 'women', "women's", 'womens', 'female', 'lady', 'ladies'],
  KID: ['kid', 'kids', 'child', 'children', 'boy', 'boys', 'girl', 'girls', 'baby'],
};

const STOPWORDS = new Set(['s', 'a', 'an', 'the', 'for', 'in', 'of', 'and', 'or', 'with', 'me', 'my', 'some']);

function parseQuery(query, sectionHint) {
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  let section = sectionHint ?? null;
  const rest = [];
  for (const w of words) {
    const sec = Object.entries(SECTION_WORDS).find(([, ws]) => ws.includes(w));
    if (sec && !sectionHint) section = sec[0];
    else if (!STOPWORDS.has(w) && w.length >= 2) rest.push(SYNONYMS[w] ?? w);
  }
  return { section: section ?? 'MAN', terms: rest };
}

function scoreCategory(cat, terms) {
  const name = cat.name.toLowerCase();
  const words = name.split(/[^a-z-]+/);
  let s = 0;
  for (const t of terms) {
    const variants = [t, t.endsWith('s') ? t.slice(0, -1) : `${t}s`];
    if (variants.includes(name)) s += 5;
    else if (variants.some((v) => words.includes(v))) s += 3;
    else if (t.length >= 4 && name.includes(t)) s += 2;
  }
  // prefer shallow product categories over promos
  if (/view all|best sellers|collection/i.test(cat.name)) s -= 1;
  return s;
}

const pathDepth = (c) => (c.path.match(/>/g) ?? []).length;

// Category nodes that are not product listings (editorial, help, campaigns).
const NON_PRODUCT = /GIFT CARD|STORES|DOWNLOAD|NEWSLETTER|CONTACT|PRESS|COMPANY|OFFICES|HELP|JOIN LIFE|ABOUT|EDITORIAL|STORE LOCATOR|PROCESS|POSTURES|INFO/i;

export async function searchProducts(query, { section, limit = 24 } = {}) {
  const { section: sec, terms } = parseQuery(query, section);
  const all = await flatCategories(sec);
  const listing = all.filter((c) => !NON_PRODUCT.test(c.path));
  const cats = listing.length ? listing : all;

  const seenCat = new Set();
  const ranked = cats
    .map((c) => ({ c, s: scoreCategory(c, terms) }))
    .filter((x) => x.s > 0 && !seenCat.has(x.c.id) && seenCat.add(x.c.id))
    // Same-name categories exist all over the tree (promo subtrees carry tiny
    // TROUSERS nodes); the shallowest path is the canonical, largest one.
    .sort((a, b) => b.s - a.s || pathDepth(a.c) - pathDepth(b.c))
    .filter((x, i, arr) => arr.findIndex((y) => y.c.name === x.c.name) === i)
    .slice(0, 3);

  // Fall back to the section's big collection categories when nothing matches.
  const fallback = cats.filter((c) => /COLLECTION|VIEW ALL/i.test(c.name)).slice(0, 2);
  const chosen = ranked.length ? ranked.map((x) => x.c) : fallback;

  const seen = new Set();
  const pool = [];
  for (const cat of chosen) {
    try {
      for (const p of await categoryProducts(cat.id)) {
        if (!seen.has(p.id)) { seen.add(p.id); pool.push({ p, cat }); }
      }
    } catch { /* category may 404 seasonally; skip */ }
    if (pool.length > 800) break;
  }

  // Rank inside the pool by product-name term hits; the final query term is
  // usually the head noun ("linen BLAZER"), so it weighs more.
  const scored = pool.map(({ p, cat }) => {
    const name = (p.name || '').toLowerCase();
    let s = 0;
    terms.forEach((t, i) => {
      const variants = [t, t.endsWith('s') ? t.slice(0, -1) : `${t}s`];
      if (variants.some((v) => name.includes(v))) s += i === terms.length - 1 ? 3 : 2;
    });
    return { p, cat, s };
  });
  const anyHits = scored.some((x) => x.s > 0);
  const picked = (anyHits ? scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s) : scored).slice(0, limit);

  return {
    query, section: sec, terms,
    matchedCategories: chosen.map((c) => ({ id: c.id, name: c.name, path: c.path })),
    total: anyHits ? scored.filter((x) => x.s > 0).length : scored.length,
    products: picked.map(({ p }) => summarize(p)),
  };
}

// ------------------------------------------------------------------- detail

export async function productDetails(productIds) {
  const ids = [productIds].flat();
  // Batch calls need REPEATED productIds params — comma-joined ids return [].
  const qs = ids.map((id) => `productIds=${id}`).join('&');
  try {
    const d = await getJson(`${BASE}/products-details?${qs}&ajax=true`, { fast403: true });
    return Array.isArray(d) ? d : [d];
  } catch (err) {
    if (err.status !== 403) throw err;
    // Endpoint blocked — fall back to the product HTML pages. The first
    // fetch does the bm-verify handshake and warms the cookie jar; the rest
    // run in small parallel batches on the warm cookies.
    const out = new Array(ids.length).fill(null);
    const grab = async (i) => {
      try { out[i] = await detailFromPage(ids[i]); } catch (e) {
        console.warn(`[zara] page fallback failed for ${ids[i]}: ${e.message}`);
      }
    };
    await grab(0);
    const BATCH = 4;
    for (let i = 1; i < ids.length; i += BATCH) {
      await Promise.all(ids.slice(i, i + BATCH).map((_, j) => grab(i + j)));
    }
    if (ids.length === 1 && !out[0]) throw new Error(`Product details unavailable for ${ids[0]} — the JSON endpoint is blocked and no page fallback succeeded. Run search_products first so the product's page URL is known.`);
    return out;
  }
}

export async function extraDetail(productId) {
  try {
    return await getJson(`${BASE}/product/${productId}/extra-detail?ajax=true`);
  } catch {
    return null;
  }
}

// Lateral navigation: items like this one, from the live catalog. Derives a
// query from the product's own name (minus filler) and searches its section.
const NAME_FILLER = new Set(['WITH', 'AND', 'THE', 'IN', 'OF', 'ZW', 'COLLECTION', 'LIMITED', 'EDITION']);

export async function similarProducts(productId, { limit = 8 } = {}) {
  const [p] = await productDetails(productId);
  if (!p?.name) return { anchor: null, products: [] };
  const terms = String(p.name).toUpperCase().split(/[^A-Z-]+/)
    .filter((w) => w.length >= 3 && !NAME_FILLER.has(w))
    .slice(-4); // trailing words carry the garment type
  const res = await searchProducts(terms.join(' ').toLowerCase(), {
    section: p.sectionName ?? undefined,
    limit: limit * 2 + 6,
  });
  // "More like this" means other products — never the anchor's own colourways,
  // and one card per model rather than a colour picker.
  const anchorModel = modelKey(p.detail?.displayReference || p.detail?.reference || p.reference);
  const anchorIds = new Set([p.id, Number(productId), ...(p.detail?.colors ?? []).map((c) => c.productId).filter(Boolean)]);
  const seen = new Set();
  const products = res.products.filter((x) => {
    if (anchorIds.has(x.id)) return false;
    const m = x.model ?? modelKey(x.reference);
    if (anchorModel && m === anchorModel) return false;
    if (m && seen.has(m)) return false;
    if (m) seen.add(m);
    return true;
  }).slice(0, limit);
  return { anchor: { id: p.id, name: p.name }, products };
}

export function detailView(p) {
  const base = summarize(p, { maxImages: 12 });
  const colors = (p.detail?.colors ?? []).map((c) => ({
    id: c.id,
    productId: c.productId ?? null, // the colourway's own id (what search rows carry)
    name: c.name,
    hex: c.hexCode ?? null,
    price: c.price ?? null,
    priceText: formatPrice(c.price),
    description: c.description ?? null,
    images: imageUrls(c, 750),
    sizes: (c.sizes ?? []).map((s) => ({
      name: s.name,
      // in_stock | low_on_stock | out_of_stock | coming_soon (some stores send it uppercase)
      availability: String(s.availability ?? 'unknown').toLowerCase(),
      price: s.price ?? null,
      sku: s.sku,
    })),
  }));
  return { ...base, description: colors[0]?.description ?? null, colorDetails: colors };
}
