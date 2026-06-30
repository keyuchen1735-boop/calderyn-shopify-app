# Shipping-as-Product-Data (#5-shipping / #6.1)

**Date:** 2026-06-29
**Status:** Design approved (brainstorm). Ready for spec review → implementation plan.
**Parent:** [Calderyn Platform Pivot — Build Map](./2026-06-27-calderyn-platform-pivot-design.md), features `#5-shipping` + `#6.1`. Depends on Slice 1 (owned catalog / `variant_dim`) + Slice 2 (owned `location_dim`). John's track (catalog data) — it **feeds Eric's already-merged quote engine** (`app/lib/ship-cost/`, PR #218).

---

## Goal

Store the **rate-critical shipping attributes** on the owned catalog — per-variant size + weight, per-location ship-from address, and basic delivery rules — so Eric's quote engine can compute a **real** shipping rate at checkout. Today the catalog has only `grams` (weight); without dimensions and an origin address the quote engine (built, merged) can't return a correct rate. This fills exactly the inputs that engine reads.

Done when a merchant can enter a product's size + a location's ship-from address, a **physical product is blocked from going live without weight + dimensions**, and Eric's quote engine receives a valid parcel + origin and returns a real rate.

---

## The contract we must feed (read from Eric's merged `rate-quote.ts`)

His engine's `RateRequest` = `origin: Address` + `destination: Address` (from checkout) + `parcels: Parcel[]`, where:
- `Address = { name?, company?, street1, street2?, city, state, zip, country (ISO-2), phone? }`
- `Parcel = { lengthIn, widthIn, heightIn, weightOz }`

So our catalog must be able to produce, per variant, a **Parcel** (dims + weight), and per location, an **origin Address**. That is the entire data requirement.

---

## Decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Scope | **Full rate-critical set** (the "B" option): per-variant size + weight, per-location ship-from address, **restricted (don't-ship-to) countries**, **handling days**, **signature-required**, `requires_shipping` flag |
| Storage | A new **`variant_shipping`** record (1:1 with `variant_dim`) groups the shipping fields; `location_dim` extended with the full ship-from address |
| Units | Store canonical metric (**grams, mm**); the seam helper converts to Eric's `weightOz` / inches in one place |
| Validation | A **physical** variant can't be set `active` without weight > 0 AND all three dimensions; a non-physical (`requires_shipping=false`) variant skips the check |
| Seam to Eric | Two small read helpers produce his exact `Parcel` / `Address` shapes, so his checkout never touches our tables |
| Deferred | hazmat, freight/oversized, customs/HS codes, temperature, multi-parcel packing → the separate `#5-shipping-advanced` step |

---

## Data model

- **`variant_shipping`** (1:1 with `variant_dim`): `variant_id → variant_dim` (pk/unique), `shop_id`, `weight_grams int` (canonical; backfilled from `variant_dim.grams`), `length_mm int`, `width_mm int`, `height_mm int`, `requires_shipping bool not null default true`, `restricted_countries text[] not null default '{}'` (ISO-2 deny list), `handling_days int not null default 0`, `signature_required bool not null default false`. DB CHECK as backstop (`weight_grams >= 0`); the real validation is at the action boundary.
- **`location_dim`** ADD ship-from address: `street1 text`, `street2 text`, `postal_code text`, plus the existing `city` / `region` (state) / `country`. (Slice 2 already added `lat`/`lng`; this completes a full postal `Address`.)

`variant_dim.grams` stays (the engine's analytics still read it); `variant_shipping.weight_grams` is the authoritative, validated canonical weight, seeded from `grams`.

---

## Validation (the "required + validated at write" part)

At the catalog editor's action boundary (Slice 1 B1's `validateProductInput` / the variant write):
- If `requires_shipping = true`: reject saving the variant as `active` unless `weight_grams > 0` AND `length_mm`, `width_mm`, `height_mm` are all > 0. (A draft may be incomplete; going **live** requires complete shipping data.)
- `restricted_countries` entries must be valid ISO-2 codes.
- `requires_shipping = false` (digital/service): skip all physical checks.
- Fail **visibly** (rule 12) — a missing dimension is a clear error, never a silent zero that becomes a wrong charge.

---

## The seam to Eric (the doorway)

A small `app/lib/shipping/parcel.server.ts` exposing read helpers that return Eric's **exact** types (imported from `~/lib/ship-cost/adapters/rate-quote`):
- `buildParcel(variantId): Promise<Parcel>` — reads `variant_shipping`, converts grams→oz (`* 0.0352739619`) and mm→inches (`/ 25.4`), returns `{ lengthIn, widthIn, heightIn, weightOz }`.
- `originAddress(locationId): Promise<Address>` — reads `location_dim`, returns `{ street1, street2?, city, state: region, zip: postal_code, country }`.
- `canShipTo(variantId, destCountryIso2): Promise<boolean>` — false if the country is in `restricted_countries`, so checkout/the quote can suppress an un-shippable destination.

Eric's checkout assembles the request itself: `getRates({ origin: originAddress(loc), destination: buyerAddr, parcels: [buildParcel(variant)] })`. We own the data + the doorway; he owns the call. (If he'd rather read the tables directly, the doorway is optional — but it keeps the halves decoupled.)

`handling_days` is exposed for the delivery-date window (his engine combines carrier transit days + our handling days); `signature_required` is carried through for the service options.

---

## Merchant UI

- **Product editor (Slice 1):** a **"Shipping" section** per variant — size (L×W×H) + weight, `requires_shipping` toggle, handling days, signature, restricted-countries multiselect. The save is blocked per the validation above (with a clear message naming the missing field).
- **Location settings (Slice 2):** add the **ship-from address** fields (street, city, state, zip, country) next to the priority + coordinates already there.

---

## Out of scope (deferred → `#5-shipping-advanced`, step 11)

- Hazmat / dangerous goods, temperature/cold-chain.
- Freight / oversized / LTL (class codes, pallets).
- Customs: HS codes, country-of-origin, declared value, duties.
- Multi-parcel packing (the engine reads `parcels[0]` for now anyway).
- Carrier-account / negotiated-rate config (Eric's adapter concern).

---

## Success criteria

1. A merchant enters a variant's L×W×H + weight and a location's ship-from address; both persist.
2. A physical variant cannot be saved `active` without weight + all three dimensions; a digital one can.
3. `buildParcel(variant)` returns Eric's `Parcel` shape with correct unit conversions; `originAddress(location)` returns his `Address` shape.
4. `canShipTo` returns false for a restricted destination.
5. Eric's merged quote engine, fed `buildParcel` + `originAddress`, returns a real rate (vs the weight-only guess it can do today).

---

## Risks

- **Backfill gap:** `grams` is null for many existing variants; flipping `weight_grams` to required-for-active needs a merchant fill-in flow (the validation surfaces it) so quotes never silently use a missing weight.
- **Unit conversion is the one error-prone spot** — isolate it in `buildParcel` and unit-test the g→oz / mm→in math, or every quote is subtly wrong.
- **Contract drift with Eric:** the helpers must keep matching `rate-quote.ts`'s `Address`/`Parcel`; import his types directly (don't re-declare) so a change there is a compile error here, not a silent mismatch.
- **Address completeness:** an origin missing zip/country makes the quote fail; validate the location address before it's usable as an origin (or the quote falls back).

---

## Next step

User reviews this spec → `writing-plans`. Single plan: `variant_shipping` migration + `location_dim` address columns, the validation in the catalog write path, the seam helpers (with the unit-conversion unit test), and the editor + location-settings UI fields. Build in an isolated worktree (`feat/shipping-product-data`) off `origin/main`.
