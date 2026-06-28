# Amboras — Competitor Teardown (reference for design handoff)

**Source:** crawl of `www.amboras.com` (26 public pages) on 2026-06-28 via crawl4ai (rendered, screenshots + markdown). The logged-in dashboard (`admin.amboras.com/home`) is behind Google OAuth and was **not** reachable without a session — this teardown is built from the public marketing surface, which is detailed and shows product/admin screenshots. Full page captures are in `./pages/`; screenshots in `./shots/`.

Amboras is a YC-backed (3-person) "AI-native ecommerce platform" — a full Shopify replacement where an AI agent builds and runs the store. Direct competitor to Calderyn.

> **Caveat the whole way down:** the marketing is more mature than the product. The flagship "runs itself" capabilities (autonomous CRO, generative A/B, agentic analytics) are explicitly beta/early-access; several spec'd images are unshipped placeholders; pricing/packaging is internally contradictory across pages.

---

## 1. Positioning & taglines

- **Master line** (page title sitewide): **"Amboras. The store builder that runs itself."**
- **Homepage hero:** **"World's first AI-native ecommerce platform."** CTAs "Start for free" / "Book a call."
- **Footer signature:** **"E-commerce, version two."**
- **`/what-is-amboras`:** "The first AI-native shop system." — *"Not only a website builder… we host your domain, storefront, and the backend that runs your products, orders, customers, and inventory — and an AI assistant lives inside every page."*
- **`/what-is-agentic-ecommerce`:** **"The store runs itself."** — *"Other platforms give you a dashboard and a plugin marketplace. Amboras gives you one operator with seventy-four real tools. Type a sentence. Watch your store change."*
- Recurring: "The merchant talks. Amboras does." · "Talk to your store. Watch it change." · **"Stop running the store. Start directing it."**
- Social proof: **5000+ stores made · YC P26 · 250+ shop apps replaced.**
- 3-era narrative: "Days of dragging" (2010–2023) → "A sentence becomes a store" (now) → "stores that run themselves" (next / beta).

**Emotional promise:** relief from operational drudgery + democratization. Enemy = the assemble-it-yourself stack ("Most shop platforms hand you an empty store and say 'good luck.'"). Conversion-tested defaults that normally need "a CRO consultant and a design agency" ship by default and improve on their own.

---

## 2. Complete feature inventory (their words)

**Store building & design:** AI store editing by prompt (no theme editor; edits inherit brand tokens, preview live); **AI Store Designer** (named surface, remembers work); theme gallery + template carousel; storefront source editing ("AI reads/edits your actual storefront files, compiles, screenshots, shows the diff"); storefront exportable as a **Next.js** project; custom CSS/HTML blocks; brand kit (logo gen, palette, slogan); **AI image enhancing (gpt-image-2)**; mockup generator.

**Catalog/backend:** products, variants (≤3 options, unlimited variants), real-time inventory by location/variant, low-stock alerts, oversell protection, **AI-suggested re-order points**, orders, customers, returns; product-from-a-sentence-or-photo (<2 min); backorders, custom metadata, digital products, bundles, BOGO; **native subscriptions** (dunning + self-service portal); **B2B/wholesale** (customer pricing, net terms, gated catalogs); CSV import (Shopify/Woo/BigCommerce/Magento; AI tidies titles/alt text).

**Promotions:** codes, automatic discounts, BOGO, free-shipping thresholds, bundles, variant-level + per-region rules ("3 promotions with 1 prompt").

**Checkout & payments:** **One-Click Checkout** (Stripe + PayPal day one, Apple/Google Pay, address autofill); payments via **Stripe Connect** under the hood (merchant never sets up Stripe, daily payouts to own bank); **125+ payment methods** (count stated inconsistently); checkout "rebuilt around trust" → **+20% paid conversion**; guest default; **PCI DSS L1**; no added transaction fee.

**AI SEO (`/admin/seo`):** auto meta/JSON-LD schema (Product/Offer/AggregateRating/Breadcrumb)/alt/internal links, validated against Google Rich Results on save; **Search Console integration** (impressions/clicks back, keyword tracking + 28-day sparkline; rewrites copy when a query stalls on page 2); auto sitemaps/robots/**301 on handle change**; SSR; **GEO / AI-search optimization**. SEO command center tab: keyword tracker, pages-needing-attention (R/A/G), rewrites timeline, 90-day impressions-vs-clicks chart.

**AI Emails:** 10 transactional templates on Medusa events via **Resend** (DKIM/SPF/DMARC, 98% deliverability, 3× retry, 100% audit-logged); override via **MJML + Handlebars**; per-send log; plus marketing campaigns/flows (welcome, win-back, browse-abandon, post-purchase) sent from own domain.

**Reviews:** ratings + **photo/video reviews, customer Q&A, AI-summarized highlights**; **7 drop-in components** (Liquid / React / web components) + "compose your own component" via prompt; **fake-review filter** → moderation queue; **auto-Q&A** mined from review corpus; review email automations.

**Analytics:** **first-party, no pixels/cookies/SDK**, sub-50ms on the store's own Postgres (events from **Medusa**); real-time tiles (Sessions, CVR, AOV, Visitors-now), **live geo map**, **realtime event ticker**, **conversion funnel** recomputing live, **industry percentile comparison** (you vs median vs top decile); cohorts gated to Grow.

**Domain/infra/i18n:** custom domain in-admin, auto SSL/DNS/CDN, **multi-region/multi-currency** (auto-convert at visitor location), **multi-language** (AI translations editable per-string), auto tax.

**Shipping & fulfillment:** rates by zone/weight/value or **live carrier rate-shopping**; label printing (bulk); DDP/DAP duties; many carriers; **returns portal** (self-service, auto labels); 3PL; local delivery (radius/slots/route optimization/SMS); multi-location pickup.

**Migration:** Shopify/Woo/BigCommerce/Magento/Squarespace; moves products, customers, orders/refunds, **301s + sitemaps + schema**, gift cards, discounts, store credits; "<48 hours," free on paid plans.

**Team/governance:** Admin/Member roles, per-store permissions, RBAC, **2FA (TOTP + WebAuthn)**, **audit log** ("every staff and AI action logged with actor, timestamp, diff").

**Plugins/Discover:** **Discover** section (plugins + features, live previews, one-click install, "ask the AI to install"); native mini-plugins: Workflow Automation, Blog engine, Engraving, Exit Intent, Contact Form, Product Reviews, Tidio.

---

## 3. The agent / autonomy model (most important for our differentiation)

**Named agent:** the **"AI Business Assistant"** — *"Acts, not just answers."*

**Topology (mirror-worthy):** *"A dedicated AI page sits at the top of your sidebar — it can do anything across the platform. On every other page (Orders, Products, Customers, Analytics) a smaller AI chat is already expert in just that page."* One persistent session, follows you between pages, voice or type. Page-scoped: refund on Orders, copy+images on Products, explain-a-CVR-drop on Analytics.

**Tooling marketed by count:** **74 tools across 8 surfaces** (catalog/inventory, categories/collections, promotions, email, storefront source, launch/infra…). Real tool names leaked: `enhance-image`, `create-product`, `manage-collection-products`, `create-promotion`, `list_reviews`. "We add new tools weekly."

**Trust / control framing:**
- Default = **propose-then-approve**.
- **Scoped autonomy** is opt-in: *"grant scoped autonomy — e.g. 'refund any order under $30 with a complaint about damage' — when you trust it… you decide where the autonomy threshold sits."*
- Rails: risky actions need confirmation; build steps run in a verified sandbox; **AI screenshots its own work and shows the diff; you can roll back any change.**
- Grounding: *"Every AI action is grounded in the actual database… cites the records it used and links to them."*
- Models: "a mix of frontier models including Anthropic Claude and OpenAI GPT, routed per task"; zero-data-retention.
- Agent UX: queue/stack follow-up prompts; pause/resume/cancel builds (survive deploys); AI lints its own code; knows which admin page you're on; references live storefront screenshots.

**Autonomous CRO engine (beta, hand-picked onboarding):** Detection (deterministic 24/7 funnels/anomalies/segments, **ClickHouse · detectors · rollups**, significance + causal guards) → Synthesis (*"The LLM sits at the very end as a synthesizer… It never reads raw event tables"* — produces a ranked hypothesis + proposed test + expected lift) → Cross-store learning (peer percentiles, growing outcome library) → Ship winners ("A/B/n today, bandits tomorrow," auto-promote with significance gates, starting PDP + homepage hero).

> **Design-philosophy alignment:** their engine keeps the **LLM as last-mile synthesizer only, with deterministic detection** — the same principle as Calderyn's contract. They are a credible competitor on agent *discipline*, not just hype.

---

## 4. Implied admin information architecture

Reconstructed left-sidebar nav (from copy + leaked alt-text; SEO page references literal route `/admin/seo` with a "left rail" and "deep teal" highlighted item):

- **AI / Assistant** (pinned at top — the cross-platform operator)
- **Dashboard / Home** — KPI tiles + **embedded live storefront preview iframe** + docked AI chat + a **color-coded to-do punch list** (done / in progress / waiting on you)
- **Orders** · **Products/Catalog** · **Collections** · **Customers**
- **Analytics** (funnel, geo, event ticker, cohorts)
- **Store/Storefront** (Designer, Themes, source editing; deployment banner)
- **SEO** (`/admin/seo`) · **Reviews** (moderation) · **Promotions** · **Email** · **A/B / Experiments** ("lab notebook") · **Discover** (plugins)
- **Settings** → Integrations, Domains, Payment methods/Stripe onboarding, Regions, Shipping (guided), Team/Members

**Global chrome:** "Book a Call" + "Request a feature" buttons; in-chat **prompt library** (31 curated prompts); pinned to-do panel above chat; **per-tab activity dots** color-coded by status; live build-status indicator. **Mobile:** bottom nav + floating chat button + **draggable chat sheet with snap points**.

---

## 5. Integrations

`/apps-and-integrations` headlines **"163 available"** (changelog says "150"; count inconsistent). Largely an aspirational "connect your existing tools" list — many are *Shopify* apps, with "Don't see yours? We'll wire it up in 24–48 hours." Native/Amboras-built flagged: Contact Form, Workflow Automation, Blog, Engraving, Exit Intent, Product Reviews (Tidio = connect account). Categories cover: Marketing/Email (Klaviyo, Mailchimp, HubSpot, Zapier…), SMS (Postscript, Attentive…), Ads/pixels (Meta Pixel+CAPI, TikTok Pixel+CAPI — **pixels only, no buying**), Analytics (GA4, Triple Whale, Northbeam, Segment…), Support (Gorgias, Intercom, Zendesk…), Sales channels (Google/TikTok Shop/Amazon/eBay/Etsy/Walmart…), Shipping (ShipStation, ShipBob, Shippo, EasyPost, AfterShip…), Inventory/Ops (Cin7, Katana, QuickBooks Commerce, Linnworks…), Loyalty (Smile.io, LoyaltyLion, Yotpo…), SEO (Ahrefs, Semrush, Moz…), Subscriptions (Recharge, Bold, Loop…), Upsell (ReConvert, AfterSell…), Page builders (PageFly, Shogun, Replo…), Accounting/Tax (QuickBooks, Xero, Avalara, TaxJar…), Fraud (Signifyd, Riskified, Forter…), Localization (Weglot, GTranslate…), Reputation (Trustpilot, Birdeye…), regional payments (Razorpay, Airwallex).

---

## 6. Pricing & packaging

⚠️ **Internally contradictory — three different tier schemes appear.** Pricing page (CAD): **Basic CA$69 / Grow CA$149 (most popular) / Advanced CA$566 / Enterprise custom.** Grow gates **autonomous A/B/n**, advanced analytics, multi-currency/language. Advanced adds white-label + **custom AI fine-tuning on brand voice**. Enterprise adds **custom agentic analytics** + custom attribution. But the same page's FAQ names "Launch and Grow"; the changelog says "Launch $19 / Grow $49"; the `/faq` lists Starter/Studio/Team/Plus. Trial policy flip-flops ("30-day" → "No more trial"). Consistent promises: no added transaction fee, free migration, **30-day launch guarantee**, cancel anytime, 90-day data retention.

---

## 7. Changelog roadmap signals (Apr→Jun)

Heaviest recent investment: **payments + internationalization** (Razorpay/UPI, Skydropx MX, Apple Pay 2-click, redesigned Stripe Connect, multi-region, currency conversion). **Agent robustness** (queue prompts, pause/resume/cancel builds surviving SIGTERM, AI lints own code, knows current page, live screenshots). **A/B testing = brand-new** ("first pass of native experiments," May 14). **Team multiplayer = recent** (May 28). Imaging (gpt-image-2, logo gen, mockups). "Warm, earthy admin redesign," mobile admin shell, Discover, persistent chat, 31-prompt library.

---

## 8. Visual / brand / tone

- **Design language:** "**Warm, earthy admin redesign — a calmer color palette.**" Cream/champagne/peach/oat backgrounds, **deep teal** accent (SEO), warm earth-tone themes, generous whitespace, editorial calm. **Serif display headlines** + clean sans body. Framed UI screenshots ("16:11 desktop frame, soft drop shadow"). Marketing pages alternate cream and **dark editorial** sections.
- **Voice:** terse, confident, second-person, fragments with *italic emphasis on the payoff word* ("The store **runs itself**"). Anaphora ("Type a sentence. Watch your store change."). **Per-page metaphor themes:** Emails = postal world; A/B = science lab ("lab notebook," "AI lab partner"); Analytics = vintage instruments ("watch your store breathe").
- **Example-brand taste:** 18 demo brands lean premium/editorial DTC (heritage boxing leather, soy candles, quiet-luxury apparel, haute-horlogerie). Positions itself as **taste-maker, not generic template**.
- **Stack tells:** Medusa, Postgres, ClickHouse, Resend, Stripe Connect, Next.js, gpt-image-2, Claude/GPT, Supabase storage, MJML/Handlebars, cal.com.

---

## 9. Differentiators they lean on

1. **"AI is the interface, not a plugin."** (sharpest wedge vs Shopify+AI-app)
2. **All-in-one kills the app stack** ("250+ apps replaced," "$0 vs $500/mo app spend").
3. **One operator, 74 tools, 8 surfaces** (quantified agency).
4. **Self-tuning / autonomous CRO** ("a storefront that tests itself, forever").
5. **Speed** (sentence→store <2 min).
6. **First-party owned data** ("no Pixel tax").
7. **Conversion-first opinionated defaults.**
8. **Operator-founded, YC-backed.**
9. **Free, SEO-preserving migration + 30-day launch guarantee.**

---

## 10. Gaps / weaknesses → where Calderyn wins

- **NO native paid-ads management.** Amboras only *connects pixels* (Meta/TikTok CAPI) for attribution — **no ad buying, campaign management, ROAS/spend optimization, ad-creative generation, or ad grading.** This is Calderyn's core strength and is **completely uncontested.**
- **Flagship "runs itself" is not GA** — generative A/B "first pass," autonomous CRO/agentic analytics/bandits all beta/"tomorrow." Marketing sells era-3; product is era-2.
- **Pricing/packaging is a mess** (3 contradictory schemes) — easy to out-execute with clarity.
- **Integrations largely aspirational** (Shopify apps + "we'll wire it up").
- **Tiny team (3) vs huge surface** — maintenance/execution risk → "depth over breadth" counter.
- **No third-party dev ecosystem / public API / true headless** — closed, opinionated; lock-in concern.
- **Thin:** POS/in-person, native loyalty (punts to Smile.io), real helpdesk, detailed B2B.
- **Maturity tells:** placeholder images with art-direction alt-text still shipping; Status page down; `/checkout-and-payment` 404s; YC batch cited 3 ways; heavy compliance claims (SOC 2 / PCI L1) for a seed-stage co.
