/* Zada — client.
 *
 * One render path: every tool execution (agent via /mcp, agent via WebMCP,
 * or a human click) runs on the server and is broadcast over SSE; this file
 * listens and renders. Humans and agents therefore always see the same shop.
 *
 * WebMCP: on load the page registers every shop tool with the browser's
 * model-context API (document.modelContext, previously navigator.modelContext,
 * Chrome 149+ origin trial / chrome://flags/#enable-webmcp-testing), so
 * WebMCP-capable agents (Gemini in Chrome, MCP-B/WebMCP extension, inspector
 * extensions) can drive the shop in-page.
 */

'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  lastGrid: null,          // last grid view payload
  detail: null,            // currently open product detail
  panels: {},              // productId -> { reviews, price, sizeCheck }
  profile: {},
};

// Product photos load through our /img relay (CSP/proxy-safe, no hotlinking).
const img = (u) => (u ? `/img?u=${encodeURIComponent(u)}` : '');

state.loved = new Set();
state.viewed = new Set();

/* Dwell telemetry: how long the human actually looks at a product view.
 * Flushed to /api/signals whenever the view changes — the agent reads it
 * back through get_shopper_signals. */
let dwell = null; // { productId, name, since }
function flushDwell() {
  if (!dwell) return;
  const ms = Date.now() - dwell.since;
  const body = JSON.stringify({ type: 'dwell', productId: dwell.productId, name: dwell.name, ms });
  try {
    navigator.sendBeacon?.('/api/signals', new Blob([body], { type: 'application/json' })) ||
      fetch('/api/signals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
  } catch { /* telemetry is best-effort */ }
  dwell = null;
}
function trackView(productId, name) {
  flushDwell();
  dwell = { productId, name, since: Date.now() };
}

/* Client-only navigation (back to results, logo → home) never reaches the
 * server's tool layer — beacon it so the agent's `current` location is honest. */
function navSignal(where, query = null) {
  fetch('/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'nav', where, query }),
    keepalive: true,
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDwell(); });
window.addEventListener('beforeunload', flushDwell);

function heartBtn(id, cls = 'love') {
  const on = state.loved.has(id);
  return `<button class="${cls}${on ? ' on' : ''}" data-love="${id}" title="${on ? 'Loved — click to remove' : 'Love it'}" aria-label="love">${on ? '♥' : '♡'}</button>`;
}
function patchHearts() {
  for (const b of document.querySelectorAll('[data-love]')) {
    const on = state.loved.has(Number(b.dataset.love));
    b.classList.toggle('on', on);
    b.textContent = on ? '♥' : '♡';
  }
}

/* ------------------------------------------- event-driven navigation bits */

function miniCard(p) {
  const image = p.image ?? p.images?.[0] ?? '';
  return `
    <div class="mini" data-id="${p.productId ?? p.id}" role="button" tabindex="0" title="${esc(p.name)}">
      <img loading="lazy" src="${esc(img(image))}" alt="${esc(p.name)}"/>
      <div class="mini-name">${esc(p.name)}</div>
      ${p.priceText ? `<div class="mini-price">${esc(p.priceText)}</div>` : ''}
    </div>`;
}

function rail(title, items, note = '') {
  if (!items?.length) return '';
  return `
    <div class="rail">
      <div class="rail-title">${esc(title)}${note ? ` <span>${esc(note)}</span>` : ''}</div>
      <div class="rail-row">${items.map(miniCard).join('')}</div>
    </div>`;
}

async function renderHeroRails() {
  try {
    const x = await (await fetch('/api/experience')).json();
    for (const id of x.viewedIds ?? []) state.viewed.add(id);
    $('#rails').innerHTML =
      rail('Continue where you left off', x.recent) +
      rail('Your loves ♥', x.loved) +
      rail('Picked for you', x.forYou?.products, x.forYou?.basis?.length ? `from what you gravitate to: ${x.forYou.basis.join(', ')}` : '');
  } catch { /* rails are best-effort */ }
}

function showNudge(n) {
  document.getElementById('__nudge')?.remove();
  const el = document.createElement('div');
  el.id = '__nudge';
  el.className = 'nudge';
  if (document.getElementById('__question')) el.classList.add('below');
  const similarMode = n.mode === 'similar';
  el.innerHTML = similarMode
    ? `<span>You loved <b>${esc(n.theme)}</b> ♥ — want to see similar pieces${Object.keys(state.profile).length ? ', in your size' : ''}?</span>
       <button class="nudge-go">SHOW SIMILAR</button>
       <button class="nudge-x" aria-label="dismiss">✕</button>`
    : `<span>You keep coming back to <b>${esc(n.theme)}</b> — want to see them all together, with your size checked?</span>
       <button class="nudge-go">SHOW ME</button>
       <button class="nudge-x" aria-label="dismiss">✕</button>`;
  document.body.appendChild(el);
  el.querySelector('.nudge-go').addEventListener('click', () => {
    el.remove();
    if (similarMode) {
      callTool('find_similar', { product_id: n.productId, in_my_size_only: Object.keys(state.profile).length > 0 }, 'web').catch(() => {});
    } else {
      callTool('search_products', { query: n.query }, 'web').catch(() => {});
    }
  });
  el.querySelector('.nudge-x').addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), 25_000);
}

/* The agent asks IN the store (ask_shopper): a card with choices; the tap
 * resolves the agent's pending tool call through /api/answers. Persistent —
 * no auto-dismiss — until answered or closed. */
function showQuestion(q) {
  document.getElementById('__question')?.remove();
  document.getElementById('__nudge')?.remove();
  const el = document.createElement('div');
  el.id = '__question';
  el.className = 'nudge question';
  el.dataset.qid = q.id;
  el.innerHTML = `
    <div class="q-body">
      <span class="q-who">Your agent asks${q.productName ? ` · ${esc(q.productName)}` : ''}</span>
      <span class="q-text">${esc(q.question)}</span>
      <div class="q-choices">
        ${(q.choices ?? []).map((c) => `<button class="nudge-go q-choice" data-choice="${esc(c)}">${esc(c)}</button>`).join('')}
        ${q.allowFreeText ? `<input class="q-free" placeholder="or type…" maxlength="200" aria-label="Type an answer" />` : ''}
      </div>
    </div>
    <button class="nudge-x" aria-label="dismiss">✕</button>`;
  document.body.appendChild(el);
  const send = (body) => {
    el.classList.add('sent');
    fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: q.id, ...body }) })
      .catch(() => {})
      .finally(() => { el.remove(); if (!body.dismissed) flash(`Sent to your agent: ${body.choice ?? body.text}`); });
  };
  for (const b of el.querySelectorAll('.q-choice')) b.addEventListener('click', () => send({ choice: b.dataset.choice }));
  el.querySelector('.q-free')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.value.trim()) send({ text: ev.target.value.trim() });
  });
  el.querySelector('.nudge-x').addEventListener('click', () => send({ dismissed: true }));
}

document.addEventListener('click', (ev) => {
  const mini = ev.target.closest('.mini[data-id]');
  if (mini) callTool('get_product', { product_id: Number(mini.dataset.id) }, 'web').catch(() => {});
});

/* ------------------------------------------------------------- tool calls */

async function callTool(name, args, channel = 'web') {
  const res = await fetch(`/api/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-channel': channel },
    body: JSON.stringify(args ?? {}),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `tool ${name} failed`);
  return body.result;
}

/* ------------------------------------------------------------------ flash */

/* Quiet error surface (the storefront itself is the activity mirror). */
function flash(message) {
  document.getElementById('__flash')?.remove();
  const el = document.createElement('div');
  el.id = '__flash';
  el.className = 'nudge';
  el.innerHTML = `<span>${esc(message)}</span><button class="nudge-x" aria-label="dismiss">✕</button>`;
  document.body.appendChild(el);
  el.querySelector('.nudge-x').addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), 8000);
}

/* A quiet agent action with no visual footprint here (a lookup on another
 * product, an item added to the bag): one line, optional action, gone in 8s. */
function notice(text, action) {
  document.getElementById('__notice')?.remove();
  const el = document.createElement('div');
  el.id = '__notice';
  el.className = 'nudge notice';
  if (document.getElementById('__question')) el.classList.add('below');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="nudge-go">${esc(action.label)}</button>` : ''}<button class="nudge-x" aria-label="dismiss">✕</button>`;
  document.body.appendChild(el);
  el.querySelector('.nudge-go')?.addEventListener('click', () => { el.remove(); action.run(); });
  el.querySelector('.nudge-x').addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), 8000);
}

/* Bring a freshly rendered agent panel into view and flash it. */
function reveal(sel) {
  setTimeout(() => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('agent-flash');
  }, 120);
}

let statusTimer = null;
function markAgentActive(channel) {
  if (channel === 'web' || channel === 'shop') return; // humans and the shop itself are not "the agent"
  const el = $('#agentStatus');
  el.dataset.state = 'active';
  $('#agentStatusText').textContent = channel === 'webmcp' ? 'agent acting (in-page)' : 'agent acting (remote MCP)';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.dataset.state = 'recent';
    $('#agentStatusText').textContent = 'agent connected';
  }, 3000);
}

/* -------------------------------------------------------------- renderers */

function money(cents, currency) {
  if (cents == null) return '';
  const sym = { ILS: '₪', USD: '$', EUR: '€' }[currency] ?? '';
  return sym + (cents / 100).toFixed(2).replace(/\.00$/, '');
}

function show(el) {
  for (const id of ['hero', 'grid', 'detail']) $('#' + id).hidden = id !== el;
  if (el === 'hero') $('#hero').hidden = false;
  state.lastView = el;
}

function renderGrid(view) {
  flushDwell();
  state.lastGrid = view;
  const grid = $('#grid');
  const cur = view.currency;
  const head = `
    <div class="grid-head" style="grid-column:1/-1;background:#fff">
      <h2>${esc(view.query ?? 'Products')}</h2>
      <span class="meta">${esc(view.section ?? '')} · ${view.products.length} of ${view.total ?? view.products.length} items
      ${view.matchedCategories?.length ? ' · ' + esc(view.matchedCategories.map((c) => c.name).join(', ')) : ''}
      ${view.appliedFilters?.length ? ' · <b>filters: ' + esc(view.appliedFilters.join(' · ')) + '</b>' : ''}</span>
      ${view.requery ? `<button id="mySizeToggle" class="chip${view.requery.in_my_size_only ? ' on' : ''}">${view.requery.in_my_size_only ? '✓ ONLY MY SIZE' : 'ONLY MY SIZE'}</button>` : ''}
    </div>`;
  const cards = view.products
    .map(
      (p) => `
    <article class="card agent-flash" data-id="${p.id}" tabindex="0" role="button"
      aria-label="${esc(p.name)}, ${esc(money(p.price, cur))}${p.onSale ? ', on sale' : ''}">
      ${p.onSale ? `<span class="sale-flag">−${p.discountPct}%</span>` : ''}
      ${state.viewed.has(p.id) ? `<span class="seen-flag">SEEN</span>` : ''}
      ${p.yourSize?.inStock ? `<span class="size-flag" title="${esc(p.yourSize.matched ?? p.yourSize.size)} in live stock">YOUR SIZE ✓</span>` : ''}
      ${heartBtn(p.id)}
      <div class="ph"><img loading="lazy" src="${esc(img(p.images[0]))}" alt="${esc(p.name)}"
        onmouseover="this.dataset.a||((this.dataset.a=1),this.dataset.o=this.src,${p.images[1] ? `this.src='${esc(img(p.images[1]))}'` : ''})"
        onmouseout="if(this.dataset.o){this.src=this.dataset.o;delete this.dataset.a}" /></div>
      <div class="info">
        <div class="name">${esc(p.name)}</div>
        <div class="price">
          ${p.oldPrice ? `<span class="old">${esc(money(p.oldPrice, cur))}</span>` : ''}
          <span class="now${p.onSale ? ' sale' : ''}">${esc(money(p.price, cur))}</span>
        </div>
        ${p.colors?.length > 1 ? `<div class="swatches">${p.colors.slice(0, 6).map((c) => `<i style="background:${esc(c.hex ?? '#eee')}" title="${esc(c.name)}"></i>`).join('')}</div>` : ''}
      </div>
    </article>`,
    )
    .join('');
  grid.innerHTML = head + cards;
  show('grid');
  $('#mySizeToggle')?.addEventListener('click', () => {
    const r = view.requery;
    callTool('search_products', { query: r.query, section: r.section || undefined, in_my_size_only: !r.in_my_size_only }, 'web')
      .catch((err) => flash(`Filter failed: ${err.message}`));
  });
}

function sparkline(history, currency) {
  if (!history || history.length < 2) return '';
  const prices = history.map((h) => h.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const W = 300, H = 54, pad = 4;
  const x = (i) => pad + (i * (W - 2 * pad)) / (history.length - 1);
  const y = (p) => (max === min ? H / 2 : pad + ((max - p) * (H - 2 * pad)) / (max - min));
  const pts = prices.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="price history">
    <polyline points="${pts}" fill="none" stroke="#111" stroke-width="1.5"/>
    <text x="${pad}" y="10" font-size="9" fill="#767676">${esc(money(max, currency))}</text>
    <text x="${pad}" y="${H - 2}" font-size="9" fill="#767676">${esc(money(min, currency))}</text>
  </svg>`;
}

function renderPanels(productId) {
  const p = state.panels[productId] ?? {};
  let html = '';
  if (p.note) {
    const n = p.note;
    const facts = [
      n.fit && `Fit · ${n.fit}`,
      n.quality && `Quality · ${n.quality}`,
      n.sizing && `Sizing · ${n.sizing}`,
      n.recommendedSize && `Take ${n.recommendedSize}`,
    ].filter(Boolean);
    const who = n.by === 'webmcp' ? 'in-page agent' : n.by === 'mcp' ? 'remote agent' : 'your agent';
    const srcs = n.findings ?? [];
    html += `
      <div class="panel agent-note">
        <h3>Your agent found</h3>
        <div class="subtitle">${esc(who)} · ${srcs.length} source${srcs.length === 1 ? '' : 's'}${n.confidence ? ` · ${esc(n.confidence)} confidence` : ''}</div>
        <div class="price-verdict${n.confidence === 'high' ? ' good' : ''}">${esc(n.verdict)}</div>
        ${facts.length ? `<div class="note-facts">${facts.map(esc).join(' · ')}</div>` : ''}
        ${srcs.map((f) => `
          <div class="review">
            <span class="src">${esc(f.source)}</span>
            <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.title)}</a>
            ${f.quote ? `<div class="snip">“${esc(f.quote)}”</div>` : ''}
          </div>`).join('')}
      </div>`;
  }
  if (p.price) {
    const r = p.price.report ?? p.price;
    const good = r.onSale || /lowest/i.test(r.verdict ?? '');
    html += `
      <div class="panel">
        <h3>Price intelligence</h3>
        <div class="subtitle">Live price, the retailer's own markdown signal, and the history this shop has tracked.</div>
        <div class="price-verdict${good ? ' good' : ''}">${esc(r.verdict ?? '')}</div>
        <div class="price-stats">
          <div><b>${esc(money(r.current, r.currency))}</b><span>now</span></div>
          ${r.listedOldPrice ? `<div><b>${esc(money(r.listedOldPrice, r.currency))}</b><span>before</span></div>` : ''}
          ${r.lowest ? `<div><b>${esc(money(r.lowest, r.currency))}</b><span>lowest tracked</span></div>` : ''}
          ${r.highest ? `<div><b>${esc(money(r.highest, r.currency))}</b><span>highest tracked</span></div>` : ''}
        </div>
        ${sparkline(r.history, r.currency)}
      </div>`;
  }
  if (p.reviews) {
    const r = p.reviews;
    html += `
      <div class="panel">
        <h3>What people say</h3>
        <div class="subtitle">${esc(r.note ?? '')}</div>
        ${(r.results ?? [])
          .slice(0, 8)
          .map(
            (v) => `
          <div class="review">
            <span class="src">${esc(v.source)}</span>
            <a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a>
            <div class="snip">${esc(v.snippet ?? '')}</div>
          </div>`,
          )
          .join('')}
        ${!(r.results ?? []).length && r.searchLinks ? `<div class="subtitle">Open a live search: ${r.searchLinks.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">[${i + 1}]</a>`).join(' ')}</div>` : ''}
      </div>`;
  }
  return html ? `<div class="panels">${html}</div>` : '';
}

function renderDetail(product, { colorIndex = product.selectedColorIndex ?? 0 } = {}) {
  if (dwell?.productId !== product.id) trackView(product.id, product.name);
  state.detail = product;
  const cur = state.lastGrid?.currency ?? 'ILS';
  const colors = product.colorDetails ?? [];
  const color = colors[colorIndex] ?? colors[0] ?? { images: product.images, sizes: [] };
  const imgs = (color.images?.length ? color.images : product.images) ?? [];
  const sizeCheck = state.panels[product.id]?.sizeCheck;
  // What the agent wrote onto this product (live event, or persisted on the product).
  const note = state.panels[product.id]?.note ?? product.agentFindings ?? null;
  if (note) (state.panels[product.id] ??= {}).note = note;
  const agentPick = note?.recommendedSize ? String(note.recommendedSize).toLowerCase() : null;
  let selectedSize = null;
  $('#detail').innerHTML = `
    <div class="detail-top agent-flash">
      <div class="gallery">${imgs.slice(0, 6).map((u) => `<img src="${esc(img(u))}" alt="${esc(product.name)}" loading="lazy"/>`).join('')}</div>
      <div class="detail-info">
        <button class="back" id="backBtn">← BACK TO RESULTS</button>
        <h2>${esc(product.name)} ${heartBtn(product.id, 'love love-detail')}</h2>
        <div class="ref">${esc(product.reference ?? '')} · ${esc(product.family ?? '')} · ${esc(product.section ?? '')}</div>
        <div class="price">
          ${product.oldPrice ? `<span class="old">${esc(money(product.oldPrice, cur))}</span>` : ''}
          <span class="now${product.onSale ? ' sale' : ''}">${esc(money(product.price, cur))}</span>
        </div>
        ${product.onSale ? `<div class="discount-note">REDUCED −${product.discountPct}%</div>` : ''}
        <div class="desc">${esc(product.description ?? color.description ?? '')}</div>
        ${colors.length > 1 ? `
          <div class="block-label">Colours</div>
          <div class="colors">${colors.map((c, i) => `
            <button class="cbtn${i === colorIndex ? ' on' : ''}" data-ci="${i}">
              <i style="background:${esc(c.hex ?? '#eee')}"></i>${esc(c.name ?? '')}
            </button>`).join('')}</div>` : ''}
        <div class="block-label">Sizes ${sizeCheck ? `· checked “${esc(sizeCheck.checked)}”` : ''}</div>
        <div class="sizes">${(color.sizes ?? [])
          .map((s) => {
            const buyable = s.availability === 'in_stock' || s.availability === 'low_on_stock';
            const picked = agentPick && buyable && String(s.name).toLowerCase() === agentPick;
            if (picked) selectedSize = s.name;
            return `<span class="size${s.isYourSize ? ' yours' : ''}${buyable ? ' selectable' : ''}${picked ? ' agent-pick selected' : ''}" data-size="${esc(s.name)}" data-a="${esc(s.availability)}" title="${picked ? 'Your agent recommends this size' : esc(s.availability)}">${esc(s.name)}</span>`;
          })
          .join('')}</div>
        <div class="size-legend">black border — in stock · orange — low stock · struck — unavailable · click a size to pick it</div>
        ${selectedSize && agentPick ? `<div class="agent-pick-note">Your agent’s pick · ${esc(selectedSize)}${note?.sizing ? ` · ${esc(note.sizing)}` : ''}</div>` : ''}
        <button class="addbag" id="addBagBtn">ADD TO BAG</button>
        ${product.url ? `<a class="zara-link" href="${esc(product.url)}" target="_blank" rel="noopener noreferrer">VIEW ON THE RETAILER'S SITE</a>` : ''}
      </div>
    </div>
    ${state.panels[product.id]?.similar?.length ? `
      <div class="similar-row">
        <div class="rail-title">More like this</div>
        <div class="rail-row">${state.panels[product.id].similar.map(miniCard).join('')}</div>
      </div>` : ''}
    ${renderPanels(product.id)}`;
  show('detail');
  $('#backBtn')?.addEventListener('click', () => {
    if (state.lastGrid) {
      renderGrid(state.lastGrid);
      navSignal('grid', state.lastGrid.query ?? null);
    } else {
      show('hero');
      navSignal('home');
    }
  });
  for (const btn of document.querySelectorAll('.cbtn')) {
    btn.addEventListener('click', () => renderDetail(product, { colorIndex: Number(btn.dataset.ci) }));
  }
  for (const chip of document.querySelectorAll('.size.selectable')) {
    chip.addEventListener('click', () => {
      const on = chip.classList.contains('selected');
      document.querySelectorAll('.size.selected').forEach((c) => c.classList.remove('selected'));
      if (!on) chip.classList.add('selected');
      selectedSize = on ? null : chip.dataset.size;
    });
  }
  // Lazily fetch "more like this" once per product; re-render when it lands.
  const panel = (state.panels[product.id] ??= {});
  if (!panel.similar && !panel.similarLoading) {
    panel.similarLoading = true;
    fetch(`/api/similar/${product.id}`)
      .then((r) => r.json())
      .then((s) => {
        panel.similar = s.products ?? [];
        if (state.detail?.id === product.id && panel.similar.length) renderDetail(product, { colorIndex });
      })
      .catch(() => {});
  }
  $('#addBagBtn')?.addEventListener('click', () => {
    const args = { product_id: product.id };
    if (selectedSize) args.size = selectedSize;
    if (color.name) args.color = color.name;
    callTool('add_to_cart', args, 'web')
      .then((r) => {
        if (r?.ok === false) flash(r.message ?? 'Could not add to bag');
      })
      .catch((err) => flash(`Add to bag failed: ${err.message}`));
  });
}

function renderCart(view) {
  flushDwell();
  const cur = view.currency ?? 'ILS';
  $('#bagCount').textContent = view.count ?? 0;
  const items = view.items ?? [];
  // KEEP SHOPPING goes back to where the human was, not to some grid.
  if (!state.inBag) state.bagReturn = state.lastView === 'detail' && state.detail ? 'detail' : state.lastGrid ? 'grid' : 'hero';
  state.inBag = true;
  $('#detail').innerHTML = `
    <div class="bag-wrap agent-flash">
      <button class="back" id="backBtn">← KEEP SHOPPING</button>
      <h2>YOUR BAG</h2>
      <div class="bag-sub">${items.length ? `${view.count} item${view.count > 1 ? 's' : ''} — checkout happens on the retailer's site, item by item` : ''}</div>
      ${items.length ? items.map((i) => `
        <div class="bag-item" data-cartid="${esc(i.cartId)}">
          <img src="${esc(img(i.image))}" alt="${esc(i.name)}" data-pid="${i.productId}" title="Open product"/>
          <div class="bi-main">
            <div class="bi-name">${esc(i.name)}</div>
            <div class="bi-meta">${esc(i.color ?? '')} · size ${esc(i.size)}${i.quantity > 1 ? ` · ×${i.quantity}` : ''}${i.matchType && i.matchType !== 'exact' ? ` · <span title="${esc(i.matchType)}">≈ your ${esc(i.sizeRequested)}</span>` : ''}${i.addedBy ? ` · <span class="bi-by${i.addedBy === 'agent' ? ' agent' : ''}">added by ${i.addedBy === 'agent' ? 'your agent' : 'you'}</span>` : ''}</div>
            <div class="bi-flags">
              ${i.priceDropped ? `<span class="drop">▼ PRICE DROPPED SINCE ADDED</span>` : ''}
              ${i.availabilityNow === 'out_of_stock' ? `<span class="oos">NOW OUT OF STOCK</span>` : ''}
              ${i.availabilityNow === 'low_on_stock' ? `<span class="oos">LOW STOCK</span>` : ''}
            </div>
          </div>
          <div class="bi-price">
            ${i.priceDropped ? `<span class="was">${esc(money(i.priceAtAdd, cur))}</span>` : ''}
            ${esc(money((i.priceNow ?? i.priceAtAdd), cur))}
          </div>
          <div class="bi-actions">
            ${i.url ? `<a class="zlink" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">BUY AT THE RETAILER</a>` : ''}
            <button class="rm" data-cartid="${esc(i.cartId)}">REMOVE</button>
          </div>
        </div>`).join('')
      : `<div class="bag-empty">Your bag is empty — ask your agent to fill it: “add the first one in my size”.</div>`}
      ${items.length ? `
        <div class="bag-total"><span>SUBTOTAL</span><b>${esc(view.subtotalText ?? money(view.subtotal, cur))}</b></div>
        <div class="bag-note">The agent fills the bag; buying stays with you. Each line links straight to the item on the retailer's site.</div>` : ''}
    </div>`;
  show('detail');
  $('#backBtn')?.addEventListener('click', () => {
    state.inBag = false;
    if (state.bagReturn === 'detail' && state.detail) {
      renderDetail(state.detail);
    } else if (state.lastGrid) {
      renderGrid(state.lastGrid);
      navSignal('grid', state.lastGrid.query ?? null);
    } else {
      show('hero');
      navSignal('home');
    }
  });
  for (const btn of document.querySelectorAll('.bag-item .rm')) {
    btn.addEventListener('click', () => callTool('remove_from_cart', { cart_id: btn.dataset.cartid }, 'web').catch(() => {}));
  }
  for (const im of document.querySelectorAll('.bag-item img[data-pid]')) {
    im.addEventListener('click', () => callTool('get_product', { product_id: Number(im.dataset.pid) }, 'web').catch(() => {}));
  }
}

function renderProfile(profile) {
  state.profile = profile ?? {};
  const parts = Object.entries(state.profile).map(([k, v]) => `${k[0].toUpperCase()}:${v}`);
  $('#sizeChipVal').textContent = parts.length ? parts.join(' ') : 'none';
}

/* ------------------------------------------------------------- SSE mirror */

function handleEvent(e) {
  if (e.phase === 'start') return;
  if (e.phase === 'error' && e.summary && e.channel !== 'web') flash(e.summary);
  markAgentActive(e.channel ?? 'mcp');
  const v = e.view;
  if (!v) return;
  switch (v.kind) {
    case 'grid':
      renderGrid(v);
      break;
    case 'detail':
      (state.panels[v.product.id] ??= {});
      state.viewed.add(v.product.id);
      renderDetail(v.product);
      break;
    case 'size':
      (state.panels[v.product.id] ??= {}).sizeCheck = v.match;
      if (v.navigate === false) { // agent checked a product the human isn't looking at
        notice(`Your agent checked size ${v.match?.checked ?? ''} on ${v.product.name}: ${v.match?.inStockAnywhere ? 'in stock' : 'not in stock'}`, { label: 'OPEN', run: () => callTool('get_product', { product_id: v.product.id }, 'web').catch(() => {}) });
        break;
      }
      renderDetail(v.product);
      reveal('.sizes');
      break;
    case 'reviews': {
      if (v.productId) {
        (state.panels[v.productId] ??= {}).reviews = v;
        if (state.detail?.id === v.productId) { renderDetail(state.detail); reveal('.panels'); }
        else if (v.navigate === false) notice(`Your agent found ${v.results?.length ?? 0} reviews for ${v.productName}`, { label: 'OPEN', run: () => callTool('get_product', { product_id: v.productId }, 'web').catch(() => {}) });
        else callTool('get_product', { product_id: v.productId }, e.channel === 'web' ? 'web' : e.channel).catch(() => {});
      } else if (state.detail) {
        (state.panels[state.detail.id] ??= {}).reviews = v;
        renderDetail(state.detail);
        reveal('.panels');
      }
      break;
    }
    case 'price':
      (state.panels[v.product.id] ??= {}).price = { report: v.report };
      if (state.detail?.id === v.product.id) { renderDetail(state.detail); reveal('.panels'); }
      else if (v.navigate === false) notice(`Your agent checked the price of ${v.product.name}: ${v.report?.verdict ?? v.product.priceText}`, { label: 'OPEN', run: () => callTool('get_product', { product_id: v.product.id }, 'web').catch(() => {}) });
      else { renderDetail(v.product); reveal('.panels'); }
      break;
    case 'profile':
      renderProfile(v.profile);
      break;
    case 'cart':
      $('#bagCount').textContent = v.count ?? 0;
      if (v.navigate === false && v.added) { // add-to-bag never yanks the human away
        $('#bagChip').classList.add('pop');
        setTimeout(() => $('#bagChip').classList.remove('pop'), 400);
        notice(`${v.added.addedBy === 'agent' ? 'Your agent added' : 'Added'} ${v.added.name} · ${v.added.size}${v.added.color ? ` · ${v.added.color}` : ''} to your bag`, { label: 'VIEW BAG', run: () => callTool('view_cart', {}, 'web').catch(() => {}) });
        break;
      }
      renderCart(v);
      break;
    case 'similar': {
      (state.panels[v.productId] ??= {}).similar = v.products ?? [];
      if (state.detail?.id === v.productId) { renderDetail(state.detail); reveal('.similar-row'); }
      else if (v.products?.length) renderGrid({ kind: 'grid', query: `similar to ${v.anchorName}`, section: '', products: v.products, total: v.products.length, currency: state.lastGrid?.currency ?? 'ILS' });
      break;
    }
    case 'nudge':
      showNudge(v);
      break;
    case 'question':
      showQuestion(v);
      break;
    case 'answered': {
      const el = document.getElementById('__question');
      if (el && el.dataset.qid === v.id) el.remove();
      break;
    }
    case 'agent_note': {
      (state.panels[v.productId] ??= {}).note = v.note;
      const alias = e.args?.product_id;
      if (alias && alias !== v.productId) (state.panels[alias] ??= {}).note = v.note;
      if (state.detail?.id === v.productId || state.detail?.id === alias) { renderDetail(state.detail); reveal('.panel.agent-note'); }
      else if (v.navigate === false) notice(`Your agent wrote its verdict on ${v.productName}`, { label: 'OPEN', run: () => callTool('get_product', { product_id: v.productId }, 'web').catch(() => {}) });
      else callTool('get_product', { product_id: v.productId }, e.channel === 'web' ? 'web' : e.channel).catch(() => {});
      break;
    }
    case 'love': {
      state.loved = new Set(v.lovedIds ?? []);
      // Zara sometimes resolves a grid id to its master product id — mirror
      // the loved state onto the id the click actually carried.
      const alias = e.args?.product_id;
      if (alias && v.loved) state.loved.add(alias);
      patchHearts();
      break;
    }
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    const st = $('#agentStatus');
    if (st.dataset.state === 'offline') { st.dataset.state = 'idle'; $('#agentStatusText').textContent = 'agent idle'; }
  };
  es.onmessage = (m) => {
    try { handleEvent(JSON.parse(m.data)); } catch { /* ignore */ }
  };
  es.onerror = () => {
    es.close();
    $('#agentStatus').dataset.state = 'offline';
    $('#agentStatusText').textContent = 'reconnecting…';
    setTimeout(connectSSE, 2500);
  };
}

/* ----------------------------------------------- events wired to the mirror
 * Note: view events fired by *this* page's own clicks also arrive via SSE —
 * that single path keeps agent and human actions perfectly consistent. */

/* ---------------------------------------------------------------- WebMCP */

async function registerWebMCP() {
  const badge = $('#webmcpBadge');
  const mc = document.modelContext ?? navigator.modelContext ?? null;
  if (!mc) {
    badge.textContent = 'WebMCP: not available in this browser (agents can still connect via /mcp)';
    badge.dataset.on = 'false';
    window.__webmcp = { available: false, registered: [] };
    return;
  }
  const { tools } = await (await fetch('/api/tools')).json();
  const registered = [];
  for (const t of tools) {
    const descriptor = {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly },
      async execute(args) {
        const result = await callTool(t.name, args, 'webmcp');
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    };
    try {
      if (typeof mc.registerTool === 'function') {
        // Spec: registerTool returns a Promise (rejects with NotAllowedError
        // when the `tools` Permissions Policy blocks this origin).
        await mc.registerTool(descriptor);
      } else if (typeof mc.provideContext === 'function') continue; // batched below
      registered.push(t.name);
    } catch (err) {
      console.warn('WebMCP registerTool failed for', t.name, err);
    }
  }
  // Older builds only expose provideContext({tools}) — batch-register there.
  if (!registered.length && typeof mc.provideContext === 'function') {
    const batch = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      async execute(args) {
        const result = await callTool(t.name, args, 'webmcp');
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    }));
    try {
      mc.provideContext({ tools: batch });
      registered.push(...tools.map((t) => t.name));
    } catch (err) {
      console.warn('WebMCP provideContext failed', err);
    }
  }
  badge.textContent = registered.length
    ? `WebMCP: ${registered.length} tools registered in-page`
    : 'WebMCP: API present but registration failed';
  badge.dataset.on = registered.length ? 'true' : 'false';
  window.__webmcp = { available: true, registered };
}

/* ------------------------------------------------------------------ wiring */

$('#searchForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q.length < 2) return;
  callTool('search_products', { query: q }, 'web').catch((err) => flash(`Search failed: ${err.message}`));
});

document.addEventListener('click', (ev) => {
  const heart = ev.target.closest('[data-love]');
  if (heart) {
    ev.stopPropagation();
    const id = Number(heart.dataset.love);
    const love = !state.loved.has(id);
    // Optimistic: the heart fills the instant you tap; the server confirms
    // over SSE (and we roll back if the call fails).
    if (love) state.loved.add(id); else state.loved.delete(id);
    patchHearts();
    heart.classList.add('pop');
    setTimeout(() => heart.classList.remove('pop'), 300);
    callTool('love_item', { product_id: id, love }, 'web').catch(() => {
      if (love) state.loved.delete(id); else state.loved.add(id);
      patchHearts();
    });
    return;
  }
  const card = ev.target.closest('.card');
  if (card) callTool('get_product', { product_id: Number(card.dataset.id) }, 'web').catch(() => {});
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.classList?.contains('card')) ev.target.click();
});

$('#brand').addEventListener('click', () => { flushDwell(); show('hero'); renderHeroRails(); navSignal('home'); });

$('#sizeChip').addEventListener('click', () => {
  $('#szTops').value = state.profile.tops ?? '';
  $('#szBottoms').value = state.profile.bottoms ?? '';
  $('#szShoes').value = state.profile.shoes ?? '';
  $('#sizeDialogBackdrop').hidden = false;
});
$('#szCancel').addEventListener('click', () => ($('#sizeDialogBackdrop').hidden = true));
$('#szSave').addEventListener('click', async () => {
  const args = {};
  if ($('#szTops').value.trim()) args.tops = $('#szTops').value.trim();
  if ($('#szBottoms').value.trim()) args.bottoms = $('#szBottoms').value.trim();
  if ($('#szShoes').value.trim()) args.shoes = $('#szShoes').value.trim();
  $('#sizeDialogBackdrop').hidden = true;
  await callTool('set_my_sizes', args, 'web').catch(() => {});
});
$('#bagChip').addEventListener('click', () => callTool('view_cart', {}, 'web').catch(() => {}));

/* -------------------------------------------------------------------- boot */

$('#mcpUrl').textContent = `${location.origin}/mcp`;
connectSSE();
registerWebMCP();
fetch('/api/profile').then((r) => r.json()).then((p) => renderProfile(p.profile)).catch(() => {});
fetch('/api/cart').then((r) => r.json()).then((c) => ($('#bagCount').textContent = c.count ?? 0)).catch(() => {});
fetch('/api/loved').then((r) => r.json()).then((l) => { state.loved = new Set(l.ids ?? []); patchHearts(); }).catch(() => {});
renderHeroRails();
