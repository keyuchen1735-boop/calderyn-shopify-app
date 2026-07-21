# Designer flagship — Phase 2 implementation plan (D4: imagery + template adaptation)

**Spec:** docs/superpowers/specs/2026-07-21-designer-flagship-first-build-design.md, section D4.
**Grounding:** 2026-07-21 imagery recon (all file:line references verified against main that day).
**Scope boundary:** app/lib/designer/* and designer-owned call sites only. The image-quota RPC's counting semantics must NOT change. `applyAssetOverrides` gap-fill-only semantics must NOT invert (merchant `product_media` always wins).

## Step 1 — Registry validator (pure module, the D2.3/D4 shared mechanism)

New `app/lib/designer/image-registry.server.ts` (name flexible): a pure function that extracts every `src="..."` and CSS `url(...)` from a designer file set and validates each against the allowed set:
- placeholder vocabulary: `{{asset.<key>}}`, `{{product.image}}`, `{{store.logo}}`
- the donor template's REAL manifest paths only: derive from `templateId` + the recipe `AssetManifest` keys (`VERSIONED_ASSET_MANIFESTS_BY_TEMPLATE_ID`, registry.ts:67-79). For ritual-almanac the only legal literal is `/storefront-recipes/ritual-almanac/hero.webp`.
- `/storefront-fonts/` paths, `data:` URIs (the NEUTRAL_IMAGE), and nothing else.

Returns structured violations (path, file, reason: `invented-path` | `donor-art-on-first-build` | `foreign-template-path`). Donor-manifest paths are violations only when the build is a FIRST build (flag passed in); on edit turns they are legal (grandfathered — risk: over-restricting breaks legitimate edits to existing stores).

Wire-up:
- `saveDocuments` (engine.server.ts:136-170): run the validator; violations do NOT throw (a throw would brick mid-stream page saves and the resume path — recon risk 3). Route them into the existing rejected-edits/review retry loop (engine.server.ts:315-345 pattern) so the model fixes its own output.
- `publishDesignerSite` (publish.server.ts:31): hard gate — refuse to publish documents with `invented-path` or `foreign-template-path` violations; return a clear error the dock can show.

Tests: unit corpus reproducing all three walkthrough shapes (invented `/storefront-recipes/candle-*.jpg`, surviving donor `ritual-almanac/hero.webp` on a first build, `{{asset.hero}}` with no asset = legal), plus fonts/data:/placeholder positives.

## Step 2 — Mandatory hero (the whole gap is one empty-string branch)

In `designerFirstBuild` after the hero attempt (engine.server.ts:507-518): compute a guaranteed hero source in this order:
1. best existing ready image: first `product_media` image, else `store_asset` with `status='ready' AND url <> ''`, else store logo — persist into `designer_assets.hero` via `persistExternalImage` (zero quota);
2. else generated hero (existing `generateDesignerAsset` path);
3. else `heroMode: "typographic"`.

Then make `firstBuildInstruction`'s hero branch (engine.server.ts:438-441) ALWAYS emit an instruction — "use {{asset.hero}}", "use {{product.image}}", or "author a deliberate typographic/color hero (no image, no gray placeholder)" — never the current `""`.

Tests: each branch of the fallback chain; instruction text always non-empty; typographic instruction present when no imagery exists.

## Step 3 — Donor-art replacement contract (prompt side)

`engine.server.ts:53` currently licenses "template art under /storefront-recipes/" blanket — replace with: the explicit allowlist of THIS donor's real paths, plus the rule: on a first build, donor art must be replaced with a placeholder binding or removed; never re-captioned (the alt-text lie). Keep edit-turn phrasing permissive for already-saved donor art (shared SYSTEM_PROMPT serves both — condition the strict sentence on the first-build instruction block instead of the system prompt if cleaner). Extend `firstBuildInstruction` (engine.server.ts:432) to name donor imagery explicitly, not just copy/accent/category names.

Tests: prompt-content tests following the context.test.ts Peakwell pattern.

## Step 4 — Reserved first-build budget (limits override, not counting change)

Add optional `limits` override to `reserveImageGenSlots` (image-gen-limit.server.ts:106-118), threaded through `GeminiImageMeter` (gemini.server.ts:47-83) to the designer first-build call sites: `generateDesignerAsset` (imagery.server.ts:38-44) and the `generateMissingListingImages` call at engine.server.ts:467 when invoked from the designer. Pass `perShopDaily = imageGenLimits().perShopDaily + DESIGNER_FIRST_BUILD_RESERVE` (reserve = 4; env-tunable `DESIGNER_FIRST_BUILD_IMAGE_RESERVE`). Global daily cap unchanged. RPC untouched.

Tests: override plumbed (unit on reserveImageGenSlots args), designer call sites pass the reserve, non-designer sites unchanged.

## Step 5 — Bounded in-slot 429 retry (smallest safe version, else skip)

Investigate `generateGeminiImages` (gemini.server.ts:131-259): if a single bounded retry (one retry, ~2-4s jittered backoff) on provider 429 can happen INSIDE the already-reserved slot / already-counted event — i.e. zero additional ledger rows, zero counting changes — implement it. If the current structure counts per-attempt in a way that makes this non-trivial, SKIP and report; do not restructure the meter (recon risk 5: the anti-retry-storm design is deliberate).

## Step 5b — Carry-over from Phase 1 adversarial review (small, in-scope)

1. **Serve-time threshold gating**: the 3 existing designer publications still advertise fabricated free-shipping thresholds ($50 home vs $75 search on Peak & Pine — the exact walkthrough bug). Mirror the coupon-gating pattern: at widget expansion/serve, a `data-designer-free-shipping` threshold renders only when the number is backed by a supplied fact (today: never) — otherwise the meter degrades to generic copy or is omitted. Same honest-outcome rationale as coupons.
2. **Discover side door**: `sourcing/discover.server.ts:160` calls `runStoreCommand` server-side, bypassing the D1 route guard — a designer-enabled shop picking a sourced product gets a silent classic draft. Apply the same composer_enabled routing check at that call site (guard-level only, no classic logic changes; sanctioned by spec D1's exception).
3. **Publish poll cancel-on-unmount**: the Phase 1 poll can run ~3 min after navigation (harmless but sloppy); cancel it on unmount while touching the dock.

## Step 6 — Live verification (after ship)

On the walkthrough shop (maple-wick-candle-co-a8c86a): trigger a designer rebuild when quota allows. Acceptance: hero is real imagery or deliberate typographic (never gray), zero donor food art, zero 404 image requests, product cards show generated-or-real photos once quota permits. CDP protocol: closed shadow root — coordinate clicks + screenshots.

## Gate

Full designer suite + touched-area vitest, typecheck, lint, build (PowerShell only). One commit per step (1-5). No push without review.
