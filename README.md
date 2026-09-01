# ZADA

**The store that shops with you.**

A live fashion storefront where people and AI agents shop together in one
shared session. The human keeps the real store — the browse grid, product
pages, loves ♥, the bag — while the agent works inside the same page through
**WebMCP** tools registered on `document.modelContext`, or from outside the
tab through the same tools on a **remote MCP** endpoint (`/mcp`).

→ Full docs, quickstart, the 14 tools and the architecture:
**[`agent-shop/`](agent-shop/)** — the service directory. The `Dockerfile`
and `fly.toml` at this root deploy it as one always-on machine.

Built for the WebMCP Challenge. Unofficial demo project: catalog data is read,
read-only, from a public high-street fashion catalog; not affiliated with or
endorsed by the retailer, and checkout always hands off to the retailer's own
site. MIT-licensed.
