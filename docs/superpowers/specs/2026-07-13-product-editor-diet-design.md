# Product Editor Diet — Design

**Date:** 2026-07-13
**Status:** Approved direction (John: "as simple as possible, hide words behind toggleables/revealers, animate, fix overlap"); edit-page shape = collapsed cards (John delegated, recommended option).
**Surfaces:** `NewProductFlow.tsx` (Details step) and `ProductEditor.tsx` (the Edit product screen), dashboard only.

## Problem

Both product surfaces read as walls of text.

- **Wizard Details step:** after an AI draft, up to 4+ green receipt chips stack above the canvas (crowding/overlapping the section below at common widths), and the Organize section renders open with its caption even though it is optional.
- **Edit product page:** every section renders fully expanded — basics, search listing (with live preview), images, options, variants table, per-variant stock-by-location tables, per-variant shipping blocks (weight/dims/handling/signature/restricted countries), collections. On a 3-variant product that is 5+ screens of form controls with no hierarchy. Merchants don't know where to look.

## Goals

- Anything optional or already-summarizable is hidden behind a one-line revealer that reads as plain English.
- Every expand/collapse animates (GSAP height reveal, `prefers-reduced-motion` respected via the repo's existing `reduced()` helper).
- No layout crowding/overlap in the Details step at ≥360px widths.
- Zero data-model or save-action changes — this is a reorganization of existing UI.

## Part 1 — Wizard Details step

1. **Receipt chips collapse.** The N green "what the AI changed" chips render as ONE compact chip: `✓ 4 changes`. Tap toggles the full chip list open/closed (animated). One chip (N=1) renders as itself, no collapse.
2. **Organize section collapses.** Renders as a single revealer row `Organize (optional)` with a live summary when content exists (e.g. `4 tags`); closed by default, opens animated. The caption line inside is deleted (the row label carries the meaning).
3. **Label diet.** `Weight (grams)` → `Weight (g)`. No other copy grows.
4. **Layout fix.** Audit the prompt bar + chip row stacking (z-index/margins) at 360/768/1280px; chips must never overlap the Sizes & colors card. Fix with normal flow spacing, not z-index hacks.

## Part 2 — Edit product page (collapsed cards)

**Header strip (always visible):** back link, `Save`, `Archive` (unchanged), plus the product's status pill.

**Essentials card (always open):** Title, Status, Description, Images. (Vendor/Tags move to Organize.)

**Collapsed section rows** — each is one line: chevron + name + live plain-English summary + optional warning tone. Tap expands (GSAP); multiple may be open; all closed by default. The existing section contents move inside unchanged (same inputs, same save wiring):

| Row | Summary examples | Contents (existing UI) |
|---|---|---|
| Variants | `3 sizes — all $129` / `4 variants — mixed prices` / `Single variant — $24` | Options editor + variants table (SKU/price/compare-at/cost/tracked) |
| Stock | `75 on hand · 1 location` / `Out of stock ⚠` | Stock-by-location tables + move stock/history |
| Shipping | `600 g · 40×35×8 cm` / `Missing weight ⚠` | Per-variant shipping blocks |
| Search listing | `Automatic` / `Custom address + title` | Handle, search title/description, preview |
| Organize | `2 tags · no collections` / `Nothing yet` | Vendor, tags, collections |

**Warning rows:** if a section's summary carries a warning (⚠ — currently only Shipping-incomplete and Out-of-stock qualify), that section row renders in the warning tone but still starts CLOSED; the summary text says what's wrong, which is the point of the summary. (Simplest consistent rule; no surprise auto-expansion.)

**Summary text = pure helpers** in a new `app/components/dashboard/screens/product-editor-summaries.ts` (`variantsSummary`, `stockSummary`, `shippingSummary`, `searchSummary`, `organizeSummary`) — unit-tested; the component only renders their output.

**Revealer primitive:** one shared `<Reveal>` component (chevron row + GSAP height tween + reduced-motion fallback) used by both Part 1 and Part 2 — added to `app/components/dashboard/ui.tsx` alongside the other primitives, styled with existing `cd-*` tokens.

## Non-goals

- No new fields, no removed capabilities, no save/action changes, no route changes.
- No tabs, no preview-first layout (considered, not chosen).
- No changes to the Products list, wizard steps other than Details, or the legacy embedded app.

## Testing

- Unit: the five summary helpers (all branches incl. warnings); Reveal open/close state.
- Full vitest suite + typecheck/lint/build (full suite — lesson from #448).
- Prod walk-through after deploy: Peak & Pine edit page (multi-variant + missing-dims warning summaries), wizard Details step chips/Organize collapse, overlap check at narrow width.

## Design-taste note for implementers

Apply the `design-taste-frontend` + `emil-design-eng` skills when styling the revealer rows and summaries: quiet rows, real hierarchy, no decoration for its own sake; summaries in sentence case; warnings use the existing warning tone token, not new colors.
