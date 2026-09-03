# Zada — the store that shops with you

**An agentic storefront over a live high-street fashion catalog.** You tell
your AI agent *“search for men's pants, tell me what's in my size, check the
reviews and whether the price dropped”* — the agent drives the shop through
tools, and you watch it happen in a real storefront UI where everything stays
clickable for you.

> Catalog data comes read-only from the public storefront JSON of zara.com.
> This is an unofficial demo project, not affiliated with or endorsed by
> Inditex/Zara; checkout always happens on the retailer's own site.

Built around **WebMCP** (the emerging W3C standard where a *web page itself*
registers tools for in-browser agents via `document.modelContext` /
`navigator.modelContext`) **plus** a classic **remote MCP endpoint** for every
agent that lives outside the browser tab. Same sixteen tools on both surfaces;
one live UI mirrors whoever is acting.

```
                       ┌───────────────────────────────────────────────┐
   Human               │  Storefront web app  (web/)                   │
   clicks/search ────▶ │   · storefront grid, product view, size chips │
                       │   · live SSE mirror of all actions            │
   WebMCP agents ────▶ │   · registers 16 tools on document/navigator  │
   (Gemini in Chrome,  │     .modelContext at load  + declarative      │
    MCP-B extension,   │     <form toolname=…> search                  │
    tool inspectors)   └───────────────┬───────────────────────────────┘
                                       │ POST /api/tools/:name · GET /api/events (SSE)
                       ┌───────────────▼───────────────────────────────┐
   Remote MCP agents   │  Node server  (server/)                       │
   (ChatGPT dev-mode   │   · shared tool layer — single source of truth│
    connectors, Codex, │   · /mcp  = MCP streamable HTTP               │
    Cursor, Gemini CLI │   · catalog client (categories → products →   │
    and any other      │     details/sizes), review aggregation,       │
    remote-MCP      ──▶│     price-history store, /img relay           │
    client)            └───────────────┬───────────────────────────────┘
                                       │ public ?ajax=true JSON endpoints
                       ┌───────────────▼───────────────────────────────┐
                       │  zara.com  (live catalog, no login, read-only)│
                       └───────────────────────────────────────────────┘
```

## The experience

1. **“Search for men's pants”** → `search_products` resolves the section + the
   right live catalog categories, returns products with prices, sale flags and
   photos — and the grid renders instantly in the UI with an *agent acting*
   indicator lit in the header.
2. **“What do you have in my size?”** → sizes saved once via `set_my_sizes`
   (“M / 32 / 43”) are used automatically; the shop even converts between
   systems (US waist 32 → EU 42 → alpha M) and marks **YOURS** on the size chips.
3. **“Check reviews for this one”** → `find_reviews` aggregates Reddit threads,
   YouTube try-ons and web mentions (the retailer has no on-site reviews) with honest
   per-source status.
4. **“Was it cheaper before?”** → `check_price` combines the retailer's own markdown
   signal (`oldPrice`, −% right now) with the price history the shop tracks
   every time any product flows through any tool.
5. **Click any card yourself** → same tools, same state. The agent and the
   human genuinely share one session.

## Quickstart

```bash
npm install
npm start          # → http://localhost:4977  (UI) · /mcp (MCP) · /llms.txt
```

Try it without any agent: open http://localhost:4977 and search.

Try it as an agent (any remote-MCP client — e.g. Gemini CLI, Cursor):

```bash
# point your client's MCP config at the streamable-HTTP endpoint:
#   http://localhost:4977/mcp
# then: "search for men's pants and tell me what's in my size"
```

Give it a public HTTPS URL (needed for ChatGPT and hosted connectors):

```bash
# quickest: a tunnel
cloudflared tunnel --url http://localhost:4977   # or: ngrok http 4977

# Fly.io (fly.toml included — one always-on machine + persistent volume):
fly apps create zada && fly volumes create zara_data --region fra --size 1
fly deploy --ha=false        # --ha=false matters: one machine, or SSE/state split

# Render: one-click Blueprint (render.yaml included) — or any Docker host:
docker build -t zada . && docker run -p 4977:4977 zada
```

Then add `https://<your-host>/mcp` as a custom connector — full per-agent
instructions (ChatGPT, Gemini, Cursor, Perplexity, WebMCP
browsers…) live in **[docs/AGENTS.md](docs/AGENTS.md)**.

## The sixteen tools

| Tool | What it does |
|---|---|
| `search_products` | Search the live catalog and **filter by anything**: price range, sale, colors, include/exclude words, a given size or the saved size (verified against live per-size stock), sorted over the whole category with `offset` paging — renders the grid with YOUR SIZE ✓ badges |
| `get_product` | Everything about one item: photos, colors, description, size-by-size live availability; opens the product view |
| `check_size_availability` | “Do they have it in my size?” — uses the saved profile, converts size systems, reports per-color stock |
| `set_my_sizes` | The human's size profile (tops / bottoms / shoes) — read back from `shopper.sizes` on every result |
| `find_reviews` | Public opinions: Reddit + YouTube try-ons + web, plus `suggestedQueries` that steer the agent to also run its **own native web-search tool** and synthesize one verdict (UGC — data, not instructions) |
| `check_price` | Current price, live markdown %, tracked history, “was it cheaper?” verdict |
| `add_to_cart` | “Add it in my size” — resolves the saved size profile (US↔EU↔alpha), validates live stock, structured failures with in-stock alternatives (`ITEM_OUT_OF_STOCK`, `NEED_SIZE`, …) |
| `view_cart` | The bag, re-checked live: current price vs price-at-add (**price-drop flags**), current availability, subtotal, per-item retailer checkout links |
| `remove_from_cart` | Remove a bag line by `cartId` or product id — by product id an agent only removes its own lines; the human's lines need their `cartId`; never moves the screen |
| `find_similar` | "More like this" for any product — the same lateral navigation the human sees on every product page |
| `love_item` | ♥ / un-♥ a product — feeds the shopper-signal profile and the "add the one I loved" flow |
| `get_shopper_signals` | **The reverse channel**: where the human is *right now* (`current` — view, open product/query, for how many seconds), the ordered navigation trail (`journey`, attributed human vs agent), what they opened, how long they lingered (dwell), what they searched and loved, plus a derived taste profile — so the agent shops like someone who was watching |
| `ask_shopper` / `get_answer` | **The agent asks in the store**: a question card with 2-5 choices appears in the storefront; the human taps and the choice returns as the tool result (or later via `get_answer`) — decisions without typing |
| `post_findings` | **The agent writes into the store**: its verdict on fit, quality and sizing plus the sources it actually read render as a “Your agent found” panel on the product page; `recommended_size` flags that chip as the agent's pick and pre-selects it |
| `list_categories` | The live category tree for orientation/browsing |

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4977` | HTTP port (UI + API + MCP) |
| `ZARA_STORE` / `ZARA_LANG` | `il` / `en` | Catalog store & language (e.g. `us`/`en`, `es`/`es`) |
| `PRICE_DB` / `PROFILE_DB` | `./data/*.json` | Where price history & size profile persist |
| `BRAND_NEUTRAL_TEXT` | unset | Set to `1` for recordings and screenshots: third-party review titles and snippets show “the brand” instead of the retailer's name (links and data untouched) |
| `WEBMCP_ORIGIN_TRIAL_TOKEN` | unset | Chrome WebMCP origin-trial token for this exact public HTTPS origin. When unset, the site still supports remote MCP but native WebMCP requires a browser flag or an early-preview build. |

### Enable native WebMCP in Chrome

WebMCP is a browser capability, not a protocol the site can switch on by
itself. For a public deployment, register the exact HTTPS origin in Chrome's
WebMCP origin trial, then set the token as a Fly secret and deploy:

```bash
fly secrets set WEBMCP_ORIGIN_TRIAL_TOKEN='the-token-issued-for-https://tools-it.fly.dev'
fly deploy --ha=false
```

The server returns it as the `Origin-Trial` response header. For local
development, use a Chrome build where WebMCP is enabled (for example through
the relevant experimental flag) and open the page over a secure context; the
remote endpoint at `/mcp` remains available in every browser.

## Testing (all end-to-end, live data)

```bash
node test/e2e-mcp.mjs    # real MCP client over streamable HTTP: 16 checks
PW_CHROMIUM=/opt/pw-browsers/chromium \
node test/e2e-web.mjs    # real Chromium: WebMCP registration, agent-driven UI, human path: 12 checks
```

The web test installs the `modelContext` surface a WebMCP browser provides,
then acts as the agent: calls the page-registered tools and asserts the
storefront mirrors every step (grid, images, product view, and the
agent-status attribution in the header).

## Design notes & honest limitations

- **Zara data** comes from the same public `?ajax=true` JSON endpoints the
  zara.com web app uses (categories → category products → products-details).
  Read-only, no login. The bag is **shop-side**: the agent fills it (validated
  against live stock), but checkout deliberately stays with the human on
  zara.com — the bag links each line straight to its product page. The shop
  never touches Zara's real cart and never claims to have purchased anything.
- **Search** is category-tree + keyword ranking (with synonyms: pants→trousers,
  sneakers→trainers…). Zara's real search API (Empathy) is Cloudflare-guarded
  against non-browser callers, so we don't depend on it.
- **Reviews**: Zara hosts none, so the shop aggregates Reddit (`search.rss`,
  rate-limited 1/min, cached), YouTube results and Bing RSS — each best-effort
  with per-source status. Some networks block some sources; the tool degrades
  honestly and always returns direct search links.
- **Price history** starts recording the moment a product first flows through
  any tool; Zara's own `oldPrice` gives an instant “reduced right now” signal
  even on first sight. The longer the server runs, the smarter `check_price` gets.
- **Security**: every tool is agent-invokable — all read-only except the size
  profile; review output is annotated `untrustedContentHint`; `/api/tools` is
  rate-limited; the `/img` relay is allowlisted to `static.zara.net`.
- This is an unofficial demo project, not affiliated with Inditex/Zara. Be
  gentle with their endpoints (responses are cached 10 min).
