# Designer as the flagship first-build experience

**Date:** 2026-07-21
**Status:** Approved direction (John, 2026-07-21): all storefront-generation investment goes to the sparkle-gated designer (`app/lib/designer/*`, DesignerStudio). The classic/live builder pipeline (`app/lib/storefront-recipes/`, `storefront-command` routing, `storefront-compiler`) is out of scope and must not be modified by this work.
**Grounding:** two live prod walkthroughs on shop "Maple & Wick Candle Co." (3 real candle products), 2026-07-21. The classic builder installed a fabricated smart-home brand (ROOM/MODES). The designer, given the same first prompt, produced the real brand, real products, real prices, and obeyed follow-up edits in <20s. This spec closes the gaps between "clearly better" and "trustworthy end to end."

## Goal

A brand-new merchant who enables the designer and types one descriptive sentence gets, in one build: their real brand, their real products, no dead controls, no invented images or file paths, no promises the platform cannot keep, and a shopper journey that stays in their brand all the way through checkout. Follow-up edits keep working as they do today (that part already excels).

## Non-goals

- No changes to the classic builder, its recipes, routing, or compiler (owner: Eric).
- No new discounts/promotions subsystem; the fix for coupon claims is to stop making them (see D5).
- No payments enablement changes; fail-closed checkout behavior is correct and must be preserved exactly.
- No visual redesign of the designer's output style; doctrine (PR #612) stays the taste authority.

## Findings being addressed (from the 2026-07-21 designer walkthrough)

F1 sparkle-toggle race (P0), F2 dead header nav/hero CTAs (P1), F3 mismatched/fabricated imagery (P1), F4 classic-theme cart/checkout serving live (P0 product-level), F5 fabricated policy claims (P2), F6 unhonorable coupon codes (P2), F7 hardcoded fake checkout preview order (P2), F8 dead fabricated filter chips (P2), F9 no add-to-cart feedback (P3), F10 polish batch (P3).

## Design

### D1. Atomic engine routing (fixes F1)

Flipping the sparkle toggle must guarantee the very next Store visit — same session, no reload — mounts DesignerStudio and routes the next message to the designer pipeline. Today the toggle writes `composer_enabled` and a `DESIGNER_STATE_CACHE_KEY` write-through exists, yet ClassicStore still mounted and the merchant's flagship prompt died in the classic pipeline's rejection path (~20s, misleading "couldn't apply that request safely").

- Root-cause the stale mount: the Store screen's session screen-cache seed and the `designerEnabled` resolution on mount. The toggle's write-through must invalidate/refresh the Store screen-cache entry, and Store must re-resolve designer state from context at mount time rather than trusting a stale seed.
- Server-side belt-and-suspenders: if a store command arrives for a shop with `composer_enabled = true`, the command endpoint must route it to the designer pipeline (or reject with an explicit "reload to open the designer" message) — never silently run the classic pipeline for a designer-enabled shop.
- Acceptance: integration test — toggle on in Settings, navigate to Store without reload, assert designer dock mounts and the first message creates a `designer_chat` row. Manual CDP check on prod after deploy.

### D2. Link and CTA integrity contract (fixes F2, F8)

Three parts, in increasing strength:

1. **Prompt contract** (`engine.server.ts`): navigation must be real anchors (`<a href>`) to canonical storefront routes only — `/storefront`, `/storefront/collections/all`, `/storefront/products/<real-handle>`, `/storefront/cart`, `/storefront/search`. Buttons are for actions that have wired handlers (add to cart, drawer open). Forbid: `<button>` used for navigation, links to routes that don't exist, filter/sort chips that don't function (omit them instead), per-page divergence of nav labels.
2. **Shared shell**: the header/footer must be authored once and reused across all pages, so nav labels, cart affordance, and any threshold copy have a single source of truth. If the designer's document model is strictly per-page, add a shell document (or a post-generation normalizer that replaces each page's header/footer with the canonical one). Walkthrough evidence: every page authored its own header; "Cart" was a dead button on 3 of 4 pages while PDP had working but mis-targeted anchors.
3. **Deterministic post-build audit** (code, not model): parse every generated page before it can be saved/published; hard-fail (triggering the existing review/repair pass) on: any anchor to a non-canonical route, any navigation-shaped button with no wired handler, any `<img src>` outside the allowed asset registry (shared with D4), nav or threshold copy inconsistent across pages. This runs in the designer's own validation path and never touches the classic compiler.

Acceptance: audit unit tests over a corpus including the walkthrough's actual failure shapes; a rebuilt candle store publishes with zero dead controls (verified by the same CDP click-audit the walkthrough used).

### D3. Commerce continuity (fixes F4, F7, F9, plus checkout "Cart 0")

The single worst trust break: a shopper browses the designer-branded store, then `/storefront/cart` and `/storefront/checkout` serve whatever classic theme was last published (on this shop: the fabricated ROOM/MODES smart-home theme, "SECURE ROOM HANDOFF") around real line items.

- When a designer publication is live, the public serve path (shell-bypass in `app/lib/storefront/shell-bypass.ts` + `app/lib/designer/serve.server.ts`) must also serve the designer's cart and checkout documents, bound to real cart state. The designer already authors these pages; today they are preview-only.
- The designer checkout/cart documents must bind real data: real line items, real prices (walkthrough: preview hard-coded Cedar & Smoke at $28 when the real price is $24, and always showed all three products), real quantities, and a header cart count that reflects the actual cart (live checkout showed "Cart 0" with one item in the cart).
- Add-to-cart must produce visible feedback in the designer runtime: open the existing cart drawer (preferred, it already exists) or a toast, plus the count update.
- Payments stay fail-closed with the existing message, byte-for-byte.
- This is the riskiest phase (money path). It ships behind verification on the walkthrough shop before being called done, and the fail-closed test must be part of its gate.

Acceptance: shopper flow on the published walkthrough store: PDP → add to cart (drawer opens, count updates) → cart page in the merchant's brand with correct math → checkout page in the merchant's brand, correct items/prices, fail-closed payment message intact.

### D4. Imagery truthfulness and template adaptation (fixes F3; priority raised by John 2026-07-21)

**Intended architecture (John):** the designer starts from a template and builds from there. The template supplies layout quality — including a strong hero composition. The adaptation step must then make the template fully the merchant's: every template-specific image and copy block gets replaced with brand-appropriate content. A build that keeps the donor template's art (a pantry template's food photography on a candle store) is a failed adaptation, full stop.

- **Hero is mandatory**: a first build must ship with a real hero — a brand-appropriate generated image, one of the shop's own photos, or (only if no image is possible) a deliberate typographic/color hero. Never gray placeholder art in the hero or on product cards. This is the single biggest visual-quality gap vs the classic builder's templates.
- **Template art replacement is a contract**: when adapting a template, all donor imagery is either replaced with brand-appropriate imagery or removed; keeping mismatched donor art is an audit hard-fail (same mechanism as the registry check below).

- **Registry validation**: every `img src` in generated documents must resolve to a real asset the shop owns (store_asset rows, product media, designer-generated assets) or an approved neutral placeholder. Invented paths (walkthrough: `/storefront-recipes/candle-*.jpg`, 404) are an audit hard-fail (shared mechanism with D2.3).
- **Reuse before generate**: first builds must pull the shop's existing product photos and store assets into the layout before spending generation quota. Walkthrough shop had 3 real product photos in `store_asset` that went unused while cards showed placeholder art.
- **Mismatch rule**: template/doctrine art that contradicts the brand's category is worse than no art — extend the doctrine rule so mismatched subject-matter art (cooked-salmon dinner photo on a candle store) is dropped or replaced with neutral texture, never kept.
- **Reserved first-build budget**: the designer's first build gets its own image-generation allowance instead of sharing the classic pipeline's daily quota (walkthrough: classic build had already burned all 9 daily generations, so the designer build got zero). Scope: split or reserve within the existing ai-quota accounting; no new billing surface.

Acceptance: rebuilt candle store uses the 3 real product photos on their cards; zero 404 image requests; zero category-mismatched art.

### D5. No unhonorable claims (fixes F5, F6)

- Policy/spec copy (shipping thresholds, delivery times, returns windows, product attributes like burn hours or materials) may only be specific when derived from merchant-configured facts (shipping settings, product fields). Otherwise it stays generic ("Fast shipping", "Easy returns" — no numbers, no windows). Walkthrough: "$65" vs "$75" free-shipping thresholds on different pages, "40+ hour burn", "100% soy", "free 30-day returns" — all invented.
- Any threshold that does appear must come from the shared shell/single source (D2.2), killing cross-page inconsistency structurally.
- The coupon/discount widget must not emit a code the platform cannot redeem (there is no discounts feature). Change the widget contract: it renders only when a real, redeemable code is supplied — which today is never — and the doctrine's `WELCOME10` example is removed. When a discounts feature exists someday, the widget is already wired.
- The existing good behavior stays: the bot asking the merchant for real story details to replace generated brand copy was correct — keep it and extend the pattern to policies ("Tell me your actual shipping promise and I'll put it in").

Acceptance: prompt-rule tests + audit check for numeric policy claims without a configured source; no coupon markup in fresh builds.

### D6. Polish batch (fixes F10, plus dock honesty)

- HTML-entity decode in dock activity lines ("Maple &amp; Wick" → "Maple & Wick").
- Publish acknowledgment: server publish lands in ~6s; the UI must confirm within ~10s (poll publication status) instead of sitting in "Publishing…" for 2+ minutes.
- Site-wide accent swaps must sweep widget-owned elements too (leftover orange coupon CTA after a green swap).
- Preview/live parity for product card descriptions.

## Sequencing (each phase: own worktree branch, full gate, PR, live verification on the walkthrough shop)

- **Phase 1 — trust guardrails + routing (small, fast):** D1, D5, D6. No serving changes; lowest risk; kills the P0 race and the dishonest copy immediately.
- **Phase 2 — imagery + template adaptation:** D4. Raised ahead of the integrity contract on John's direction (2026-07-21): the first visual impression — hero image, no donor-template art, real product photos — is the gap merchants feel hardest vs the classic builder's templates. Registry validation lands here (the D2 audit later reuses it).
- **Phase 3 — integrity contract:** D2 (prompt contract, shared shell, deterministic audit).
- **Phase 4 — commerce continuity:** D3. Biggest and riskiest, last, with the fail-closed payment gate test and a full shopper-flow verification before it's called done.

Re-acceptance for the whole spec: rerun the complete candle-shop scenario on a fresh shop — sparkle on, one descriptive prompt, no reload tricks — and get a published store that passes every acceptance bullet above.

## Testing strategy

- Unit: audit rules (D2.3/D4), claims linter (D5), widget contract (D5), entity decode (D6).
- Integration: sparkle-toggle → designer mount + pipeline routing (D1); publish-ack polling (D6); serve path for designer cart/checkout with fail-closed payments (D3).
- Live verification per phase on the walkthrough shop via CDP (closed shadow root: use coordinate clicks + screenshots, per the established recipe).

## Ownership boundaries

Everything here lives in `app/lib/designer/*`, DesignerStudio client code, the designer's serve path (`serve.server.ts`, shell-bypass gate), and designer-owned tests. If any change appears to require touching `storefront-recipes/`, `storefront-command` intent/routing, or `storefront-compiler`, stop and re-scope — that is the classic pipeline.
