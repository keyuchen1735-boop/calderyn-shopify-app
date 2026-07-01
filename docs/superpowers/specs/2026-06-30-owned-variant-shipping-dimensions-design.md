# Owned-variant shipping dimensions — design

**Date:** 2026-06-30
**Platform-pivot step:** MVP build order **Step 3 tail — `#5-shipping`** (rate-critical shipping attributes on the owned variant). John's lane (owned catalog).
**Branch / worktree:** `feat/variant-shipping-attrs` / `../calderyn-variant-shipping` (off `origin/main` @ `66d8979`).
**Parent spec:** `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` (§ Step 3, § conflict B, § "shipping data is product data").

---

## Purpose

Give each owned variant real package **dimensions** so Calderyn's already-live shipping quote engine produces an accurate rate instead of an estimate. Today the engine (`app/lib/shipping/`) collapses a cart into a parcel and flags every quote **`lowConfidence`** because the only shipping datum on `variant_dim` is `grams` (weight) — there are no length/width/height. This is the thin, rate-critical accuracy win: weight + dimensions are what a carrier needs for a real domestic parcel rate.

## Scope

**In (John, owned-catalog domain):**
- Add package dimensions to `variant_dim`: `length_mm`, `width_mm`, `height_mm` (metric integers, matching the existing `grams`).
- Make weight + dimensions editable in the dashboard product editor (`ProductEditor`) — today the owned editor does not even surface `grams`.
- Validate the fields at the catalog write boundary: **format-strict** (any provided value is a positive integer within a sane range) + **presence-soft** (a shippable variant may still save with blanks; incompleteness is surfaced as a warning, not a hard block).
- Expose weight + dimensions in the catalog read DTO (`getProduct`) and a shipping-facing read helper that converts metric → the engine's units (inches/ounces), so the quote engine can consume real values.

**Out (deferred / other owner):**
- The quote engine itself and parcel assembly (`app/lib/shipping/*`, `app/lib/commerce/quote.server.ts`) — **Eric's**. This design *feeds* it; the final "engine reads the new fields" wire is one small change in Eric's line-building path (see § Integration seam).
- **Origin** — already shop-level via Eric's `getShopOrigin` (`commerce/origin.server.ts`); NOT a per-variant field.
- **Country restrictions, HS code, hazmat, temperature, freight/customs** — `#5-shipping-advanced` / `#6.8`, later tiers.

## Decisions (locked)

1. **Storage: metric integers.** `length_mm` / `width_mm` / `height_mm` as `integer` columns on `variant_dim`, consistent with the existing `grams`. Conversion to inches/ounces happens at the read boundary that feeds the engine, not in storage.
2. **Validation: format-strict, presence-soft.** When a value is provided it must be an integer `> 0` and `<=` a sane ceiling (per-axis `<= 3000` mm ≈ 3 m; `grams <= 2_000_000` ≈ 2 t) — a fat-finger guard, rejected at the write boundary. A `requires_shipping` variant with any missing weight/dimension still saves, but the editor shows an "incomplete shipping data → rates are estimated" warning. (The engine's existing `lowConfidence` flag already reflects this at quote time.)
3. **Restrictions deferred** — this feature is the dimensions accuracy win only.

## Architecture

```
ProductEditor (dashboard)                 catalog.server.ts (write)              variant_dim
  weight + L/W/H inputs   ──ProductInput──▶  validate (format-strict) ──────────▶  grams,
  "incomplete" warning                       + persist on variant                  length_mm,
                                                                                    width_mm,
                                                                                    height_mm
                                             getProduct / shipping read DTO
  Eric's quote engine  ◀──in/oz via convert──  (mm→in, g→oz at the boundary)
```

Data model change is additive and small: four nullable integer columns on `variant_dim` (`grams` already exists; add `length_mm`, `width_mm`, `height_mm`). No new table (weight + `requires_shipping` already live on `variant_dim`; a child table would add a join for no benefit — YAGNI).

## Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/<ts>_variant_dimensions.sql` | add `length_mm`/`width_mm`/`height_mm` int columns to `variant_dim` |
| Input type | `app/lib/catalog/types.ts` + the `VariantDraft` type in `app/lib/dashboard/client` | add optional `grams`, `lengthMm`, `widthMm`, `heightMm` |
| Validation | `app/lib/catalog/shipping-dims.ts` (new) | `validateVariantDims(draft) → { ok } \| { error }` (format-strict) + `isShippingComplete(variant) → boolean` |
| Write path | `app/lib/catalog/catalog.server.ts` (`writeProductChildren` insert + `updateProduct` `fields`) | persist the four columns; call the validator before write (throw on format error) |
| Read DTO | `app/lib/catalog/catalog.server.ts` (`getProduct`) | select + return weight + dims so the editor round-trips and the engine can read |
| Shipping read helper | `app/lib/catalog/shipping-dims.ts` | `toParcelDims(variant) → { lengthIn, widthIn, heightIn, weightOz }` (metric→imperial) for the engine |
| Editor UI | `app/components/dashboard/screens/ProductEditor.tsx` | weight + L/W/H inputs per variant + the incomplete-shipping warning |

## Validation rules (format-strict)

- Each of `grams`, `length_mm`, `width_mm`, `height_mm`, when present, must be an integer `> 0`.
- Ceilings (fat-finger guard): each dimension `<= 3000` mm; `grams <= 2_000_000`.
- A non-integer, zero, negative, or over-ceiling value is a write-time error (the action surfaces it; the variant is not saved). Mirrors the existing cross-tenant/precondition guards in `catalog.server.ts` — fail visibly, do not coerce.
- Presence is NOT required: `isShippingComplete` returns false for a `requires_shipping` variant missing any of the four, and the editor renders a warning, but the save proceeds.

## Integration seam (John → Eric, contract #4)

The quote engine's `ShippingQuoteLine` carries `weightOz` + `lengthIn/widthIn/heightIn` and `assembleParcels` sets `lowConfidence` when any is null. Today nothing populates those from `variant_dim`. This design exposes `toParcelDims(variant)` (metric→imperial) as the read contract; wiring Eric's line-builder to call it (replacing the estimate) is a one-function change in his commerce path. This spec **does not** modify the engine — it delivers the data + the converter and leaves a clearly-marked TODO/hand-off so the accuracy win lands when Eric flips the read. (If the line-builder is trivially reachable and John-safe, the wire can be included; default is to hand it off to avoid editing Eric's live quote path.)

## Testing

Vitest:
- `validateVariantDims`: accepts valid metric integers; rejects zero/negative/non-integer/over-ceiling with a field-named error.
- `isShippingComplete`: false when any of weight/dims missing on a `requires_shipping` variant; true when all present; true (n/a) when `requires_shipping` is false.
- `toParcelDims`: mm→in and g→oz conversion correct (e.g. 25.4 mm → 1 in; 28.35 g → ~1 oz), rounding rule explicit; returns nulls passthrough when a field is absent.
- `catalog.server.ts` create/update: the four columns persist on insert and on by-id update; a format-invalid dimension throws before write (no partial save); existing variant-by-id reconciliation + cross-tenant scoping unchanged.
- `getProduct`: returns the weight + dims so the editor round-trips.

## Out of scope / deferred

- Country restrictions, HS code, hazmat, temperature, freight, customs (`#5-shipping-advanced`, `#6.8`).
- The engine-side consumption wire (Eric's `ShippingQuoteLine` builder) — handed off via `toParcelDims`.
- Multi-parcel / freight packing (engine v2, already out of the engine's own v1 scope).

## Housekeeping

- **Dashboard parity:** the owned catalog editor is a **dashboard-only** surface (the embedded Polaris app operates on Shopify's own product data, not the owned catalog), so there is no embedded mirror to update — parity is satisfied by shipping the dashboard editor itself.
- Migration numbering sequences after the latest (`20260630170000_owned_event_ingest.sql`, the ingest spine).
- Pre-commit gate (CLAUDE.md) applies before any commit.
