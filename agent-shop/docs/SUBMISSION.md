# WebMCP Challenge — submission kit

Challenge: **webmcp.devpost.com** · Deadline: **Sep 3, 2026, 1:00 pm PDT**
(the Devpost page is authoritative — re-check the countdown there when submitting).
Winners: ~Sep 23 · 10 winners ($3,000 cash + partner credits each).

## Hard requirements → status

| Requirement (Devpost) | Status |
|---|---|
| Working live URL "judges can access using ChatGPT's in-app browser or Google Chrome with WebMCP enabled" | ✅ **https://tools-it.fly.dev/** (Fly.io, one always-on machine) |
| Public code repository with an open source license file visible in the About section | ✅ **https://github.com/EliBarak12/Zada** (public). `LICENSE` (MIT) is at the repo root — verify it shows in the About section, in an incognito window. |
| Text description (why WebMCP fits, UX improvement, human+agent together, implementation) | ✅ Draft below — paste into Devpost. |
| < 3-minute public YouTube video, clear demo, with audio, **no third-party trademarks** | ⬜ **Record needed** — script below. UI is branded "Zada"; avoid saying the retailer's name on mic. |
| Functional WebMCP tool registration code in the repo | ✅ `web/app.js` (`registerWebMCP()`): 14 tools on `document.modelContext` / `navigator.modelContext`, awaited `registerTool`, `provideContext` fallback, declarative `<form toolname>` search. |
| New project during the Submission Period | ✅ Built entirely during the submission period (opened Aug 25, 2026). |

Testing before submitting: latest ChatGPT desktop app → open https://tools-it.fly.dev/
in its browser → the hero badge should read "WebMCP: 14 tools registered in-page" →
ask ChatGPT to search. In Chrome: `chrome://flags/#enable-webmcp-testing` →
Enabled → relaunch.

## Devpost description (draft — edit voice to taste)

**Zada — the store that shops with you**

*Why WebMCP is the right fit.* Shopping is the worst case for today's
screenshot-and-click agents: infinite scroll, hover states, size charts, stock
that changes mid-session. WebMCP lets the storefront hand the agent the verbs
shopping actually has — search, open, check size, save sizes, reviews,
price, bag, checkout-handoff — as typed, validated page tools, while the human
keeps the pixels. Nothing to install, nothing to configure: open the page and
your agent already knows how to shop it.

*How it improves the experience.* Tell your agent "find men's pants under
250, tell me what's in my size, check reviews and whether prices dropped, and
put the best one in my bag." Every step renders live in a real storefront:
the grid fills, your size is flagged **YOURS** on the size chips (the shop
converts US↔EU↔alpha automatically — ask for a 32, it finds the EU 42),
review panels cite Reddit threads and YouTube try-ons, the price panel shows
the live markdown signal plus tracked history, and the bag flags items whose
price dropped since they were added.

*What people and agents can do together.* It's one shared session, not a
hand-off — in both directions. Every agent move renders in the storefront
itself — the header's status indicator attributes each call —
and everything stays clickable: the human can open a product
mid-search, pick a different color, add to the bag by hand; the agent sees the
same state. And the shop talks back: `get_shopper_signals` tells the agent what
the human opened, how long they lingered, what they searched and loved — so the
agent shops like someone who was watching. The boundary is deliberate: the
agent fills the bag, but checkout is human-gated — each bag line links straight
to the item on the retailer's site.

*Implementation.* One Node server, three surfaces, one tool layer:
(1) in-page WebMCP — 14 tools registered on `document.modelContext`
(navigator fallback, `provideContext` legacy fallback, plus a declarative
`<form toolname>` search); (2) the same tools as a remote MCP server
(streamable HTTP `/mcp`) for ChatGPT, Cursor, Gemini CLI — remote calls mirror
into the open tab over SSE, so the "watch your agent shop" experience survives
even for agents that don't speak WebMCP yet; (3) the human UI, which calls the
identical tool endpoints. Live data comes from a public high-street fashion
catalog (category tree → products → per-size stock; read-only, unaffiliated),
reviews from keyless Reddit-RSS/YouTube/Bing aggregation plus
`suggestedQueries` that steer the agent's own native web search, and a
price-history store that learns every time any tool touches a product. Two E2E
suites run against live data: a real MCP client over streamable HTTP and real
Chromium with a `modelContext` test double driving the page tools and
asserting the UI mirrors every call.

## 3-minute video script

| Time | Shot | Say |
|---|---|---|
| 0:00–0:15 | Storefront hero, badge "WebMCP: 14 tools registered in-page" | "This is Zada — a storefront that registers its own tools with the browser, so your AI agent can shop it *with* you. This is WebMCP." |
| 0:15–0:45 | ChatGPT in-app browser, prompt: *"search for men's pants under 250"* → grid fills, status dot lights up | "I ask in plain language. The agent calls the page's search tool — no clicking, no screenshots — and the shop renders what it found, live, with the agent indicator lit." |
| 0:45–1:15 | *"which of these come in my size?"* → product view, YOURS chip on EU 42 | "It knows my sizes — I saved them once. I wear a 32; this is European-sized, so the shop converts it and flags the EU 42 as mine, with live stock." |
| 1:15–1:45 | *"check reviews and whether the price dropped"* → review + price panels | "The catalog has no on-site reviews, so the shop aggregates Reddit and YouTube try-ons — and hands the agent tuned queries for its own web search. The price panel shows the live markdown signal plus the history the shop tracks itself." |
| 1:45–2:15 | *"add the best one to my bag in my size"* → confirmation → bag view | "Mutating tools get a confirmation — then the bag fills, in my size. If a price drops after adding, the bag flags it. Checkout stays human: every line links out to the retailer." |
| 2:15–2:45 | Human clicks around, lingers on a product, loves one → agent asked "what should I look at?" cites the signals | "And it works in reverse: the shop tells the agent what I lingered on and loved. One session, human and agent together." |
| 2:45–3:00 | Repo + architecture card | "One tool layer, three surfaces, tested end-to-end against live data. Open source — link below." |

## Submission checklist (in order)

1. ✅ Repo public: https://github.com/EliBarak12/Zada — verify LICENSE shows in the About section (check in an incognito window).
2. ✅ Deployed: https://tools-it.fly.dev/ (Fly.io, `--ha=false`, persistent volume).
3. ⬜ Smoke-test the URL in the ChatGPT desktop browser (badge + one agent search) and in Chrome with the WebMCP flag.
4. ⬜ Record the 3-minute video (script above), upload to YouTube as **public**. No third-party trademarks on screen or in audio.
5. ⬜ Register on webmcp.devpost.com ("Join Hackathon") with the Devpost account.
6. ⬜ Submit: live URL + repo URL + video URL + description (draft above), before **Sep 3, 1:00 pm PDT**.
