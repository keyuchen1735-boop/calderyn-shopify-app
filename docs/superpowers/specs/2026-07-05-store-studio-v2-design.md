# Store Studio v2 — integration design (2026-07-05)

The design prototype (`design/store-builder.html`, untracked reference copy in this worktree) becomes the real
Store screen: first-run welcome, chat-driven agentic building, premium generated designs, page/device preview,
markup-to-chat, one-at-a-time A/B testing on the live storefront, and honest import/empty-catalog gating.
Everything below is a decided contract, not an option list. Branch: `feat/store-studio-v2`.

## Fixes to shipped defects (in scope, load-bearing)

1. **Auto-build vs import race**: `Store.tsx` fires `runBuild("")` on first mount even while the OAuth-triggered
   12-month import is still `pulling`, so a fresh Shopify connect generates from an empty catalog (skipLlm
   fallback), writes a `store_generation` row, and the one-shot auto-build never re-fires. v2 removes the
   auto-build effect entirely; the welcome flow owns first-build ordering (import completes → then build).
2. **Storefront URL lie**: `StudioState.storefrontPath` is hardcoded `/storefront`, which on
   app.calderyncompany.com resolves to the demo fixture shop. v2 adds `orgSlug` and `storefrontUrl`
   (`https://{org_slug}.calderyncompany.com/storefront` when org_slug exists, else `/storefront` for
   domain-keyed Shopify tenants and dev) to StudioState; the URL pill shows and opens the real tenant URL.
3. **Unthrottled paid endpoint**: `dashboard.builder.generate.tsx` (orphaned legacy route) gets the same
   `rateLimit("storegen:{shopId}", 5, 60_000)` + 4000-char brief cap as the API route. Not deleted (its
   sibling preview.tsx is the only imagery-enhance UI).
4. **Stale migration comment**: `store_generation.status` 'failed' comment says "reserved" — corrected in the
   new migration file (comment-only, no constraint change).

## Non-goals (explicit)

- No changes to the FROZEN block contract (`types.ts`). Richer look comes from vibe CSS packs + composition,
  not new block shapes. New block types are allowed by the registry seam but v1 does not add any.
- Experiments run on the **home page only** in v1. PDP/collection legacy-JSX fallback stays untouched.
- No cart-page preview tab (cart is hardcoded JSX, not doc-backed): preview pages are Home / Product / Collection.
- No un-publish/history system. Champion preservation for A/B lives on the experiment row (see below).
- Embedded-admin parity: exempt — the store builder is a dashboard-only surface by prior decision (builder
  spec retired the embedded admin for this feature). Record this in the PR body.

## D1 — Vibe system (the design-quality backbone)

- `store_settings` gains `vibe text NOT NULL DEFAULT 'minimal' CHECK (vibe IN ('minimal','bold','warm'))`.
- `StoreSettings`/`StudioSettings` gain `vibe`. `getStoreSettings`/`saveStoreSettings` pass it through.
- The storefront layout route (`storefront.tsx`) and the preview route stamp `data-vibe={vibe}` on the
  `.cd-store` root alongside the existing inline palette.
- `storefront.css` gains three complete vibe packs styling every existing block + chrome:
  - `minimal` (default): refined current look — tightened type scale, hover states, spacing rhythm.
  - `bold`: full-bleed dark hero band (hero + first button render inside a dark section), oversized clamp()
    display type, high-contrast product cards.
  - `warm`: cream background, serif display headings (Georgia stack), soft radii, warm shadows.
  All three must look intentionally designed on: home (hero, button, richText, productGrid, collectionList),
  collection (hero, collectionGrid), PDP (gallery, price, variantPicker, addToCart), cart/checkout chrome.
  Mobile ≤700px must hold up for all three. No JS, CSS only, keyed off `[data-vibe]`.
- New API action `{action:"vibe", vibe}` → `{vibe}` (validated against the 3 values); client `setStudioVibe`.

## D2 — Generator quality upgrade (`app/lib/storegen/`)

- Brand stage prompt v2: output gains `"vibe": "minimal"|"bold"|"warm"` and palette must be chosen FROM a
  curated set of 12 named palettes embedded in the prompt (prevents ugly free-hex output; parser falls back
  to nearest curated palette on junk). Brand stage persists vibe via saveStoreSettings.
- Page stage prompt v2 per page, with one few-shot example of an excellent home composition. Composition
  guidance: home = hero → button (CTA, href `/storefront`) → productGrid (collection-sourced when collections
  exist, heading is benefit-led not "Products") → richText story band (2 sentences, sensory, no
  "Welcome to our store" clichés) → collectionList (when ≥2 collections) → closing button. Copy rules:
  specific to the catalog's actual nouns, ≤ existing COPY_BOUNDS, no exclamation marks, no emoji.
- Model: `storegenModel()` = `process.env.STOREGEN_MODEL || digestModel()`. Existing budget/fallback flow
  unchanged. (Credits are currently exhausted; nothing may break when every call fails — that path is the
  first-class one today.)
- `fallbackDoc` v2: signature gains an optional `FallbackContext { products: {title}[]; collections: {handle,title}[]; vibe }`
  (internal seam, not frozen). Deterministic copy is templated from real catalog nouns (top product titles,
  collection names) with per-vibe copy voices, so the no-credits experience still reads designed. Composition
  mirrors the guidance above (hero + CTA button + grid + story + collections when available).
- `generateStore` passes the context through; statuses/audit/budget semantics unchanged.

## D3 — StudioState v2 (browser-safe DTO extensions; additive only)

```ts
interface StudioState {
  // existing fields unchanged, plus:
  settings: StudioSettings & { vibe: "minimal" | "bold" | "warm" };
  orgSlug: string | null;
  storefrontUrl: string;          // absolute tenant URL when org_slug exists, else "/storefront"
  experiment: StudioExperiment | null;  // the running or most recent experiment
}
interface StudioExperiment {
  id: string; name: string; why: string; pageKey: "home";
  state: "running" | "decided_ship" | "decided_keep" | "stopped";
  startedAt: string; decidedAt: string | null;
  report: { aSessions: number; bSessions: number; aConversions: number; bConversions: number;
            lift: number | null; confidence: number | null } | null;
}
```

## D4 — A/B experiments (one at a time, home page, server-truth conversions)

Migration `store_experiment`:
```sql
create table public.store_experiment (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  page_key text not null default 'home' check (page_key = 'home'),
  name text not null, why text not null default '',
  variant_doc jsonb not null,          -- full challenger BlockDocument (champion stays in page_document.published_json)
  variant_settings jsonb,              -- optional {vibe, palettePrimary} overrides for arm B
  state text not null default 'running' check (state in ('running','decided_ship','decided_keep','stopped')),
  decision_note text,
  started_at timestamptz not null default now(),
  decided_at timestamptz, created_at timestamptz not null default now()
);
create unique index store_experiment_one_running on public.store_experiment(shop_id) where state = 'running';
-- + Step-10 RLS: enable, shop-scope policy on current_shop_id(), revoke anon/authenticated.
```
`storefront_event` gains nullable `experiment_id uuid` + `variant_key text` (no CHECK change; exposure rides
existing `page_view` rows). Index `(shop_id, experiment_id, created_at desc) where experiment_id is not null`.

Lib `app/lib/experiments/store-experiment.server.ts`:
- `assignArm(visitorId, experimentId): "a"|"b"` — deterministic FNV-1a/sha256 hash, 50/50; no cookie, no table.
- `getRunningExperiment(shopId)` (60s in-process cache keyed shopId, mirroring the slug cache pattern).
- `startExperiment(shopId, spec)` — 409 CalderynError `experiment_running` if one is running; requires a
  published home doc (422 `nothing_published` otherwise); builds `variant_doc` server-side from the spec kind:
  - `headline`: clone published home doc, patch hero headline/subhead (bounded by COPY_BOUNDS);
  - `vibe`: variant_settings `{vibe}`;
  - suggestions come from a deterministic library keyed off current state (never fake-AI).
- `experimentReport(shopId, experiment)` — distinct-session exposure counts from `storefront_event`
  (readPaged pattern, 50k cap) split by variant_key; conversions = paid/fulfilled/refunded orders since
  started_at whose `attribution.experiment_id` matches, split by `attribution.variant_key`
  (union checkout_complete exposure sessions as fallback, live-analytics style); two-proportion z-test →
  confidence (0-99, null under 30 sessions/arm); lift = (rB - rA)/rA, null when rA = 0.
- `decideExperiment(shopId, id, decision: "ship"|"keep"|"stop")` — ship: apply variant (headline patch →
  saveDraft + validateDocument + publishDoc; vibe → saveStoreSettings), state `decided_ship`; keep/stop: state
  only. All transitions guarded `.eq("state","running")`.

Storefront serving (`storefront._index.tsx` only):
- Loader: after resolving shop + visitor session, `getRunningExperiment`; arm B swaps the published doc for
  `variant_doc`; exposure = pass `{experimentId, variantKey}` through `trackStorefrontEvent` opts (new
  optional fields, written to the new columns). Bots/demo shops: existing screens already skip; assignment
  simply isn't recorded for them. A `variant_settings` vibe override applies at the LAYOUT root chrome
  (`storefront.tsx`, its own arm-b lookup) on every storefront page for arm-b, not just home — DOC swaps
  remain home-only.
- Checkout action: read running experiment + assignArm(visitor.visitorId) and stamp
  `{ experiment_id, variant_key }` into the existing attribution object next to `live_session_id`.

API actions on `/dashboard/api/store`: `experiment-start {name?, kind:"headline"|"vibe"}` (server picks the
concrete challenger from the deterministic library; rate-limit storegen-style 10/min), `experiment-decide
{id, decision}`, and GET now embeds `experiment` with a fresh report. Client fns in `store-client.ts`.

## D5 — Studio API v2 (`dashboard.api.store.tsx` action union)

Existing: `save-hero | accent | generate | publish`. Added: `vibe | experiment-start | experiment-decide`.
All follow route conventions exactly (requireSameOrigin first, requireDashboardSession, method check, JSON
parse, inline validation, dashboardJson). `publish` v2: before publishing each page, if
`validateDocument(...).missingFunctional` is non-empty for pdp, inject the missing functional blocks from
registry defaults (same injection as the generator) so a published PDP can never lack the buy path.

## D6 — Store screen v2 (pixel-faithful port of the prototype)

`Store.tsx` is rewritten (helper components may live in `app/components/dashboard/store/` if the file gets
large; screen registration/nav/cache keys unchanged). Layout = prototype exactly:

- **Rail (340px)**: "Build with Calderyn" header (CDIcon brand mark), chat thread, composer (textarea +
  paperclip attach reusing `addProductFromImage` + send). Chat is client-orchestrated and HONEST:
  - deterministic intents (vibe words / accent colors / `headline to "..."` / announcement→tagline) call the
    real APIs (`vibe`, `accent`, `save-hero`) and reply factually;
  - free-form or "rebuild" → real `generate` (working-steps card mirrors the real await; on receipt status
    `failed` the reply says the AI designer was unreachable and a starter layout was used — same honest copy
    as today);
  - "optimize/test" intents → `experiment-start`; test-decided prompts arrive via polling state.
  - Undo chips: client keeps the previous {vibe, accent, hero} snapshot and calls the real setters to revert.
- **Top bar** (uniform 32px pills, exactly the prototype system): URL pill (real `storefrontUrl`, opens new
  tab) · Draft/Live badge (hasPublished) · test pill (running experiment: name + confidence; click → popover
  with per-arm bars from `experiment.report`, Ship/Keep buttons when confidence ≥ 95, Stop early otherwise) ·
  page dropdown (custom GSAP menu: Home page / Product page / Collection — drives iframe `?page=`) ·
  Desktop/Mobile segment (client-side frame max-width 396px clamp) · Mark up quiet pill · Publish primary.
- **Canvas**: existing sandboxed iframe (`/dashboard/store/preview?page={page}&v={n}`), device clamp wrapper,
  markup overlay (strokes + note box → sends a chat message with the note; section attribution comes from
  the page currently previewed — copy references the page, not DOM hit-testing, since the iframe is opaque).
  A scaled-down live thumbnail in chat is OUT (iframe cannot be cloned); the markup message shows the stroke
  overlay on a neutral page snapshot card instead — visually close to the prototype's chat card.
- **Welcome overlay** (first run only; trigger `!hasDraft && !hasPublished && !generation`):
  1. Cursive "Welcome" (Great Vibes via self-hosted @font-face added to dashboard fonts, or CSS cursive
     fallback — NO external font CDN in the dashboard bundle; verify-client-bundle must stay green) traced
     with GSAP stroke-dashoffset, dead-center → rises → copy/buttons cascade. prefers-reduced-motion: static.
  2. Branch by real signals:
     - import running (`fetchImportStatus` in progress) → live import steps with real counts; on done → build.
     - `app.shopDomain === null && productCount === 0 && draftProductCount === 0` → empty branch:
       [Connect Shopify] (→ `/dashboard/login`) · [Add my first product] (one-line input → `saveProduct`
       draft with parsed price → build).
     - else → [Let's build my store] · [How should it look?] (3 vibe cards + Surprise me → sets vibe then build).
  3. Build = real `generateStudioStore(briefFromVibe)` with the working-steps card; finish → overlay dissolves,
     first-run greeting chips ("Make it bolder" / "Warmer" / "Looks good, publish it").
- **First publish celebration**: confetti from the badge (GSAP), "Your store is live at {storefrontUrl}"
  chat card with [Open my store] + [Connect payouts] (→ navigate to payments screen) when !checkoutReady.
- GSAP patterns identical to prototype (autoAlpha, transform aliases, reduced-motion guards); gsap is already
  a dependency and must stay in ssr.noExternal.
- Session-cache seed/write-through + aliveRef + WARM_TARGETS entry (already registered) preserved.

## D7 — CSS (dashboard.css)

The `---- store studio ----` section (~1726-1795) is replaced with the prototype's component system translated
to dashboard tokens (they are the same palette by construction): uniform 32px pill controls, rail/composer/
bubbles/work-card, exp pill/popover, page-pick menu, welcome overlay, vibe cards, markup note. Both themes via
tokens only; never inline `--accent`. Old class names that Store.tsx no longer renders are removed with it.

## Slices and ownership (no shared files across parallel slices)

- **S1 contracts+server** (first, alone): migrations (vibe, store_experiment, storefront_event cols, comment
  fix), studio-types.ts, studio.server.ts (state v2 incl. orgSlug/storefrontUrl/experiment report join),
  experiments lib, dashboard.api.store.tsx, store-client.ts, events.server.ts opts, builder.generate rate
  limit. Tests colocated per repo convention.
- **S2 generator+storefront-design** (parallel after S1): storegen prompts/fallback/model/vibe, storefront.css
  vibe packs + polish, storefront.tsx + dashboard.store.preview.tsx vibe stamping.
- **S3 experiments-serving** (parallel after S1): storefront._index.tsx arm serving + exposure,
  storefront.checkout.tsx attribution stamp.
- **S4 studio-ui** (parallel after S1): Store.tsx + components + store-logic.ts + dashboard.css studio section
  + icons additions + font.
- Then: adversarial review workflow → fix → full gate → e2e browser verification → commit.

## Acceptance (verified end-to-end before commit)

- Fresh shop, no catalog, no Shopify: welcome → add-first-product → build (fallback path, key exhausted) →
  preview shows a designed store in the chosen vibe → publish → tenant storefront serves it; add to cart,
  checkout reachable (Stripe test), no dead buttons on any published page.
- Shopify connect path: OAuth → land on Store with welcome showing live import progress → build fires only
  after `done` → no premature store_generation row.
- Experiment: start headline test → storefront serves A/B deterministically by cd_vid → exposure rows +
  attribution stamped → report numbers move → decide ship → published home updated, champion retained.
- Both themes, both devices, reduced motion, demo shop (no writes, no 500s), typecheck/lint/build/test green.
