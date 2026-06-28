# Design Handoff — Calderyn Post-Login Dashboard

**For:** Product Design
**Date:** 2026-06-28
**Owner:** Eric
**Status:** Brief for design exploration (not a final IA mandate — see "What we want from design")

---

## 0. The one-paragraph ask

Calderyn is pivoting from a Shopify add-on into a **direct Shopify competitor**: a platform that **owns** the store (catalog, inventory, orders, customers, checkout, payments, storefront) **and** runs Calderyn's existing autopilot + multi-platform **ad/growth brain** on top of it. We need a design for the **merchant admin dashboard the user sees after login**. Use the competitor **Amboras** ("the store builder that runs itself") as the reference for *what a modern AI-native commerce admin looks like* — then beat it with the things Amboras doesn't have: a real **autonomous growth engine** (ads + experimentation + earned autonomy), not just an autonomous store builder.

**Two reference bundles ship with this doc:**
- `docs/design/amboras-reference/TEARDOWN.md` — full Amboras competitor teardown.
- `docs/design/amboras-reference/shots/` + `pages/` — 14 annotated screenshots + 26 crawled marketing pages (raw evidence).
- The product spec this dashboard must cover: `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` (35-feature catalog + 12-step MVP build order).

> **Honesty note on the crawl:** Amboras's *logged-in* dashboard is behind Google OAuth and we could not crawl it directly. The teardown + implied IA are reconstructed from their (detailed) public marketing, leaked screenshot alt-text, and changelog. Treat the Amboras IA in §2 as "high-confidence inference," not screenshots of their live admin.

---

## 1. Positioning: how we differ from Amboras (this should drive the design)

| | **Amboras** | **Calderyn** |
|---|---|---|
| One-liner | "The store builder that **runs itself**" | "The store that **runs and grows itself**" |
| Core loop | Generate a store → AI operates it (CRO, copy, images) | Own the store → autonomous **growth brain** drives ads, creative, pricing, inventory, experiments — *earning* autonomy over time |
| Killer strength | Build-by-prompt; conversion-tested defaults | **Native paid-ads + growth optimization** (campaigns, ROAS, creative gen, experimentation) |
| Autonomy model | Propose-approve + opt-in "scoped autonomy" | **Graduated, calibrated, per-action trust ladder** (Beta-confidence, 7-gate graduation, undo-required, guardrails) — more sophisticated, more legible |
| **Their biggest gap** | **No native ad buying / campaign management / ROAS / ad-creative generation at all** | This is our home turf — design should lead with it |

**The design thesis:** Amboras feels like a **warm, calm editorial workspace** ("watch your store breathe"). Calderyn should feel like **mission control for an autonomous operator that grows your revenue** — alive, precise, evidence-dense, and genuinely *good to watch* working. We don't out-cozy them; we out-*operate* them.

**Three things to steal from Amboras (they're right about these):**
1. **AI pinned at the top of the sidebar as a first-class surface** + a **page-scoped chat** on every screen (expert in that screen's job). We already have a floating "Ask Calderyn" — promote and split it.
2. **A color-coded "to-do / waiting-on-you" punch list** on the home screen.
3. **Per-nav-item activity dots** showing where the agent is currently working.

**One thing to reject:** Amboras fakes liveness in places (placeholder screenshots, and our own current "Generator" uses a `setTimeout` fake). **Hard rule below (§7): every "live"/"autonomous" surface must bind to real state.**

---

## 2. Amboras admin IA (the reference — condensed)

Reconstructed left-sidebar (full detail in TEARDOWN.md §4):

```
[ AI / Assistant ]   ← pinned top, cross-platform operator
Dashboard/Home       ← KPI tiles + embedded live storefront preview + docked AI chat + to-do punch list
Orders · Products · Collections · Customers
Analytics            ← live funnel, geo map, realtime event ticker, cohorts
Store/Storefront     ← Designer, Themes, source editing
SEO · Reviews · Promotions · Email · A/B Experiments · Discover(plugins)
Settings → Integrations · Domains · Payments · Regions · Shipping · Team
```
- **Global chrome:** "Book a call" + "Request a feature" buttons, in-chat prompt library (31 prompts), per-tab activity dots, live build-status.
- **Mobile:** bottom nav + floating chat + **draggable chat sheet with snap points**.
- **Visual:** warm/earthy (cream, champagne, **deep teal** accent), serif display + sans body, framed UI screenshots with soft shadows, marketing alternates cream + dark editorial.

See screenshots: `shots/www_amboras_com_what_is_amboras.png` (admin hero: sidebar + storefront preview + chat), `…_analytics.png`, `…_ai_seo.png`, `…_ab_testing.png`.

---

## 3. What Calderyn has TODAY (design's starting point)

The standalone dashboard already ships (React SPA, **not** Shopify Polaris — its own `cd-*` design system). This is what we evolve, **not** a greenfield.

**Current sidebar (8 items):** Overview · Alerts · Campaigns · Creative Predictor *(being removed)* · Analytics · Inventory · Action history · Settings. **Hidden:** Generator (inner flow), Labs.

**Current design system (`cd-*`):**
- Cool/premium-tech: near-black accent `#1A1A1C`, **glassmorphism** (`--glass: 0.72`), `--radius: 14px`, density + type-scale tokens.
- **Light default + persisted night mode.** Hexagon logo mark.
- **Lucide** icons via a `CDIcon` registry (dashboard convention — *not* Polaris; Polaris is only for the embedded app, which is being retired).
- Sidebar rail on desktop → **bottom tab bar** on phones (4 primary: Overview/Alerts/Campaigns/Inventory + "More" sheet).
- Floating **"Ask Calderyn"** assistant panel + "Report a bug" launcher. Toast host. **Live Engine** feed embedded in the Overview hero; autopilot auto-runs on load and streams a real-time feed.
- Integrations footer: *Shopify · Meta · Google · TikTok · QuickBooks.*

**Implication:** we already have the bones Amboras markets (live feed, autopilot, assistant, action history/audit). We're ahead on the *growth brain*; we're behind on *owned-commerce surfaces* (no Orders/Products-as-SoT/Customers/Storefront/Checkout screens yet — those are the pivot).

---

## 4. The feature set to design for ("our sick features")

Grouped by the job-to-be-done. Each maps to the pivot spec; **MVP** = in the 12-step build order, **Later** = fast-follow/Tier 3. Design the MVP surfaces first; design Later surfaces as "coming soon" states where they'd live.

### A. THE GROWTH BRAIN — our wedge (Amboras has none of this)
- **Live Engine / Mission Control (home).** The autonomous operator, live. Real-time feed of what the agent is scanning/deciding/executing, $ impact, recovered $. *(exists — elevate it.)* **MVP.**
- **Autopilot & the trust ladder.** The earned-autonomy model: per-action Beta-confidence, recommend→auto-execute graduation, NO_BRAINER actions, guardrails (caps/cooldowns/$ ceilings/business hours), **undo on everything**, calibration dial. This is *more sophisticated than Amboras's "scoped autonomy"* — make it **legible and trustworthy**, not a black box. **MVP (ads) → grows per-kind.**
- **Campaigns (ads).** Meta/Google/TikTok campaign management, grading, ROAS, budget actions. **MVP.**
- **Creative Hub.** Generate → **pre-screen** (vision scorecard) → push-to-Meta-as-draft. *(Replaces the old Generator/Predictor `setTimeout` flow with real state.)* **MVP-adjacent.**
- **Experiments — the elimination bracket** (signature surface, see §6). generate → pre-screen → live Thompson-bandit → auto-promote, drawn as a single-elimination tournament bound to **real** experiment state. **Later (ad side first)** — but design now; it's the showpiece.
- **Agentic Channel (buy-in-chat).** Connected external AI assistants (ChatGPT/Claude/etc.) browsing the catalog, getting accurate live quotes, placing orders. Merchant surface: connected clients, quotes issued, orders, spend guardrails. **MVP (Step 8b).**
- **Analytics.** ROAS, P&L, SKU economics — and post-pivot, **deterministic** attribution (we know which ad made which sale, server-side). **MVP.**
- **Peer Benchmarks / Moat.** Cross-merchant percentiles. *(exists.)* **Later.**

### B. RUN THE STORE — commerce parity (catch up to Amboras)
- **Orders** — owned order state machine (cart→paid→fulfilled/refunded), order management. **MVP.**
- **Products / Catalog** — owned product/variant SoT (price, status, media, options, collections), **shipping-as-product-data** (weight/dims/origin/restrictions, required + validated). **MVP (core fields).**
- **Inventory** — authoritative decrementable ledger (on-hand/reserved/available), oversell guard, reservations, multi-location. *(screen exists as a mirror — upgrade to the ledger view.)* **MVP.**
- **Customers** — guest buyer records, addresses, consent (PII in a separate RLS store). **MVP (guest) → accounts Later.**
- **Shipping & Delivery** — the quote engine surface, carrier rates, delivery-promise, and (Later) the **carrier scorecard** (delivery performance as a first-class signal). **MVP (rates) → scorecard Later.**
- **Payments** — Stripe connection, transaction ledger, payouts. **MVP.**

### C. BUILD THE STORE
- **Storefront** — thin SSR storefront settings (fixed templates + brand kit), domain routing. **MVP (thin).**
- **Store Builder** — page/section/block visual editor + generated imagery (Higgsfield). **Later** (design a placeholder home for it).

### D. CROSS-CUTTING
- **AI Assistant** — promote to a pinned top-of-rail operator **+ page-scoped chat** on each screen (steal from Amboras). *(floating panel exists.)* **MVP evolution.**
- **Alerts** — detector alerts with one-click/advisory remediation. *(exists.)* **MVP.**
- **Action history (Audit)** — append-only, every staff + agent action with actor/diff/undo. *(exists — Amboras markets this; we already have it.)* **MVP.**
- **Settings** — integrations, domains, payments, regions, shipping, **team/RBAC + 2FA**, guardrail config, MCP guide. **MVP.**

---

## 5. Proposed IA (a starting proposal — design should pressure-test it)

Moving from 8 flat items to **grouped nav**, with the AI operator pinned on top (Amboras pattern) and commerce surfaces added. **Greyed = Later/coming-soon.**

```
┌─────────────────────────┐
│  ◆ Calderyn   store.url  │
│                         │
│  ✦ Ask Calderyn         │  ← pinned operator (cross-surface)
│                         │
│  GROW                   │
│   ⊙ Mission Control     │  (Overview + Live Engine)
│   ⚡ Autopilot           │  (trust ladder + action queue)   ← promoted from hero
│   📣 Campaigns          │
│   ✨ Creative Hub       │  (generate → pre-screen → push)
│   🏆 Experiments        │  (the elimination bracket)        ·later (ad side first)
│   💬 Agentic Channel    │  (buy-in-chat)
│   📊 Analytics          │
│   📈 Peer Benchmarks    │  ·later
│                         │
│  RUN                    │
│   🧾 Orders             │
│   📦 Products           │
│   🗃 Inventory          │
│   👤 Customers          │
│   🚚 Shipping           │
│   💳 Payments           │
│                         │
│  BUILD                  │
│   🛍 Storefront         │
│   🧱 Store Builder      │  ·later
│                         │
│   🔔 Alerts   ⏱ History │
│   ⚙ Settings            │
│   ☾ Night mode          │
└─────────────────────────┘
```

**Notes / decisions for design:**
- **GROW on top, RUN below.** This is the strategic statement: Calderyn leads with growth (our edge), commerce is table-stakes underneath. (Amboras would put RUN on top.) *Open question — see §10.*
- **Mission Control** = today's Overview hero, but the Live Engine becomes the centerpiece, not a card.
- **Autopilot** gets its own screen (today it's only a hero widget + toasts) — the trust ladder deserves a real surface.
- **Alerts** keeps its open-count badge; **History** = Action history (audit).
- Mobile: keep the bottom-tab + "More" sheet pattern; consider Amboras's **draggable chat sheet with snap points** for the assistant.
- Per-item **activity dots** when the agent is acting on that surface (steal from Amboras).

---

## 6. Signature surfaces to nail (the showpieces)

These three are where we win the demo. Spend the most design love here.

### 6a. Mission Control (home) — "your store, running itself, live"
The first thing the merchant sees. Must answer "what is the agent doing for me right now, and what made me money?"
```
┌──────────────────────────────────────────────────────────────┐
│  Good morning.  Calderyn recovered $1,240 this week.   [Live●] │
│  ┌───────────┬───────────┬───────────┬───────────┐            │
│  │ Revenue   │ ROAS      │ Recovered │ Autonomy  │  KPI tiles │
│  │ $42.1k ▲  │ 3.8x ▲    │ $1,240    │ ●●●○ L3   │            │
│  └───────────┴───────────┴───────────┴───────────┘            │
│  ┌────────────── LIVE ENGINE FEED ──────────────┐ ┌─ TO-DO ─┐ │
│  │ 12:04 ⚡ Paused "Cold Audience 3" — losing $8/d│ │● 2 need │ │
│  │ 12:01 🔎 Scanned 38 campaigns, 412 SKUs       │ │  you    │ │
│  │ 11:58 ✨ Pushed 3 creative variants (draft)   │ │○ 1 in   │ │
│  │ 11:50 ↩ Undo available: budget cut on "Retgt" │ │  progress│ │
│  └───────────────────────────────────────────────┘ └─────────┘ │
└──────────────────────────────────────────────────────────────┘
```
- Borrow Amboras's **color-coded punch list** (done / in-progress / **waiting on you**).
- The **Autonomy level** tile (L0–L4) is uniquely Calderyn — it visualizes *earned trust*. Clicking it → Autopilot screen.
- Honest-UI: the feed is real events (we already stream them), not a scripted demo.

### 6b. The elimination bracket (Experiments) — the watchable one
Single-elimination, one-sided tournament: many generated variants on the left collapse round-by-round to **one champion** on the right. Each round is a **real engine stage**:
```
 variants (fan-out)   pre-screen        live bandit       champion
  V1┐
    ├S1┐
  V2┘  │
       ├F1┐
  V3┐  │  │
    ├S2┘  ├──►  ★ WINNER (auto-promoted)
  V4┘     │
  V5┐     │
    ├S3┐  │
  V6┘  ├F2┘
  V7┐  │
    ├S4┘
  V8┘
```
- Round 0 = every generated variant. Pruning rounds = vision pre-screen eliminations (cheap, no traffic). Semifinal/final = **live Thompson-bandit** on real conversions. Champion = auto-promoted via the trust ladder.
- **Must live-update from real experiment state** (pre-screen scores + bandit traffic landing), **not** a timed animation. This is a hard rule (it replaces today's fake `setTimeout` Generator).
- Same component serves **ad** experiments (first) and **store-UI** experiments (later) — only the "competitors" differ.
- Amboras's equivalent is a static "lab notebook" (beta). A live, watchable bracket is a genuine demo-winner.

### 6c. Autopilot & the trust ladder — make autonomy legible
Visualize *why* the agent is/ isn't allowed to act on its own, per action kind:
- A ladder/graduation view: each action kind (pause campaign, cut budget, adjust price, reorder…) at a trust level (recommend-only → auto with confirm → NO_BRAINER), with the Beta-confidence that earned it, recent clean-approvals, and the guardrails capping it.
- The action **queue** (what's proposed, awaiting approval) + **history** (what ran, with undo).
- This is the trust story Amboras gestures at ("you decide where the threshold sits") but doesn't really show. We can.

---

## 7. Hard rules (non-negotiable for any "live"/"autonomous" surface)

1. **No success theater.** Every animated/"live"/"autonomous" element binds to **real state**. No `setTimeout` fakes, no bracket that "finalizes on a winner" that wasn't tested, no progress bar that isn't measuring something. (This is both a product-integrity rule and a source-hygiene rule in the repo.)
2. **Fail visibly.** Surface skipped actions, failed runs, retrying states, undo availability — never render a phantom success.
3. **Browser-source hygiene.** No comments/strings/markers implying AI-generation, prototype origin, or dev tooling in anything that ships to the browser. (Design copy is fine; just no provenance leakage in delivered assets.)
4. **Icons = Lucide via `CDIcon`** on the dashboard (not Polaris, not hand-drawn SVGs). New icon = one line in the registry.

---

## 8. Design-system direction

We have `cd-*` (cool, glass, near-black, light+night). Amboras is warm/earthy. **Recommended direction: lean into the contrast — Calderyn = "live mission control," cool and precise, with *motion and aliveness* as the signature** (the feed, the bracket, the autonomy meter), rather than copying Amboras's editorial warmth. Specifically, for design to decide:

- **Palette:** keep the cool near-black + glass base, but introduce **1–2 vivid accent(s)** for "agent activity" / live states (Amboras owns deep-teal-on-cream; we should own something distinctly *energetic* against dark — pick a signature). Define semantic colors for: scanning, deciding, executing, needs-you, recovered-$, undo.
- **Motion language:** define how "the agent is working" reads (pulse on activity dots, feed insertion, bracket advancement). Restrained, real, never gratuitous.
- **Density:** evidence-dense but scannable — this is an operator console, not a marketing page. Respect existing density/type-scale tokens.
- **Light + dark parity** (we ship both).
- **Typography:** Amboras uses serif display for warmth; consider whether Calderyn wants a confident technical sans throughout, or one expressive display face for the "alive" headline moments.

---

## 9. Cross-surface requirements

- **Dashboard parity (mandatory).** Calderyn ships on two surfaces that share the same product brain: this standalone dashboard *and* a separate already-built dashboard repo on its own stack. Any new surface must be designed so it can be **mirrored** there (match the data contract/behavior, not the exact components). Flag anything that can only land on one side.
- **Mobile.** Sidebar → bottom tab bar + "More" sheet (exists). Assistant → draggable sheet w/ snap points (new, from Amboras).
- **Accessibility.** Keyboard nav, focus states, color-contrast in both themes, the autonomy/bracket states must be legible without color alone.
- **Empty / cold-start / low-traffic states.** Many surfaces (experiments, analytics, autonomy) are weak with no data — design the **cold-start** state deliberately (the pre-screen/simulator is what fills the gap before real traffic exists).

---

## 10. What we want from design + open questions

**Deliverables (in priority order):**
1. **Nav/IA system** — validated grouped sidebar + mobile, with the AI operator + page-scoped chat pattern.
2. **Mission Control** home (§6a) — the hero surface.
3. **The elimination bracket** (§6b) — the showpiece; ad-experiment version first.
4. **Autopilot / trust-ladder** screen (§6c).
5. **Commerce surfaces** (Orders, Products, Inventory-as-ledger, Customers, Shipping, Payments) — can reuse a shared table/detail pattern.
6. **Design-system spec** — palette + motion + the "agent activity" semantic system (§8).
7. **Component library** — KPI tile, live-feed row, action card (with undo), autonomy meter, activity dot, page-scoped chat dock, bracket node.

**Open questions for design to weigh in on:**
- **GROW-over-RUN nav order** — does leading with growth (our differentiation) confuse merchants who expect Orders/Products on top? Or does it correctly signal what Calderyn *is*?
- **One operator vs. per-page chats** — adopt Amboras's "big AI page + small page-scoped chats," or keep a single floating assistant that's context-aware?
- **Warm vs. cool** — do we deliberately counter-position against Amboras's warmth (cool mission-control), or is warmth actually more inviting for SMB merchants? (Recommendation: cool + alive, but worth a quick exploration of both.)
- **How much autonomy to surface by default** — the trust ladder is powerful but can read as complex. How prominent on day one vs. progressively disclosed?

---

## Appendix — artifact index
- `docs/design/amboras-reference/TEARDOWN.md` — full competitor teardown.
- `docs/design/amboras-reference/shots/*.png` — 14 screenshots (homepage, what-is-amboras admin hero, agentic, analytics, ai-seo `/admin/seo`, ab-testing, ai-emails, integrations, pricing, reviews, examples, changelog, migrate, about).
- `docs/design/amboras-reference/pages/*.md` — 26 crawled marketing pages (raw).
- `docs/design/amboras-reference/manifest.json` — crawl manifest.
- `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` — the product spec (35 features, 12-step MVP build order, autonomy end-state, agentic commerce, experimentation bracket).
