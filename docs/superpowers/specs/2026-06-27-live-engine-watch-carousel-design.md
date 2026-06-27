# Live Engine — Watching-row scan carousel

**Date:** 2026-06-27
**Surface:** Calderyn dashboard webapp (primary) + embedded Shopify app (mirror)
**Worktree/branch:** `feat+live-engine-overview` / `freshdeploy`

## Problem

The Live Engine hero (`AutopilotHero`) was specced with a three-column engine
body — **Watching / scanning / Acting** — where each Watching rectangle
(Inventory / Ads / Pricing / Retention) showed a live vertical ticker of the
items currently being scanned (e.g. *Summit Logo Tee · M* rolling in Inventory).

The shipped build dropped the scanning element. Each Watching row now shows only
a static "All good" status plus an ambient shimmer sweep. The motion engine
still references a `[data-feed-strip]` element that the hero never renders — a
dead leftover of the cut feed.

This spec restores the per-rectangle scan ticker.

## Decisions (locked with user)

1. **Data = real, per category.** Names come from the merchant's own data, not a
   hardcoded list. Honors the loader's existing truthfulness policy.
2. **Surface = both.** Build + verify the rich version in the dashboard hero
   first, then mirror a lighter, iframe-safe version into the embedded hero.
3. **Motion = vertical roll / slot swap.** One name visible on a single line;
   every ~2.4s the current name rolls up and out while the next slides in from
   below. No change to row height. `prefers-reduced-motion` → static single name,
   no animation.
4. **Pricing** reuses product names (it genuinely price-scans all products), but
   pulled in a different order/slice than Inventory so the two rows never look
   like copies.

## Data contract

Add one field to `LiveEnginePageData` (`live-engine-types.ts`):

```ts
/** Real names currently being scanned, per Watching group. Bounded (~8 each).
 *  Empty when a category has no data yet — the row then shows a neutral
 *  "aspect" line instead of a blank ticker. Never fabricated. */
watchScan: {
  inv: string[];   // active product names
  ads: string[];   // active campaign names
  price: string[]; // product names (different slice/order than inv)
  ret: string[];   // customer-group labels, e.g. "Repeat buyers"
};
```

`WatchGroup` keys (`inv | ads | price | ret`) already exist in
`engine-events.ts`.

## Server build (`live-engine-page.server.ts`)

Inside `buildLiveEnginePageData`, add a `watchScan` section assembled via the
same best-effort `Promise.allSettled` pattern as the other sections (a failing
read degrades that one list to empty, never breaks the page):

| Group | Source | Query shape |
|-------|--------|-------------|
| `inv`   | products (`sku_dim`) | top ~8 active SKU display names by recent activity |
| `price` | products (`sku_dim`) | ~8 product names, different sort (e.g. by price/margin) so it differs from `inv` |
| `ads`   | campaigns | ~8 active campaign names |
| `ret`   | orders / customers | small set of **real** cohort labels that have members, e.g. "Repeat buyers", "First-time buyers (30d)", "At-risk customers", "VIP customers" — derived deterministically from order history. **No individual customer names/PII.** |

All reads go through the existing `calderynClient` (same client the loader
already uses). Each list capped at ~8 entries. Names trimmed/deduped server-side.

`EMPTY` constant gets `watchScan: { inv: [], ads: [], price: [], ret: [] }`.

### Aspect fallback (client-side, not fabricated data)

When a group's list is empty, the row shows a rotating neutral activity line
instead of a name. These describe what Calderyn is really doing, so they don't
violate truthfulness:

- inv → "Checking stock levels", "Stock vs forecast"
- ads → "Checking ROAS", "Budget pacing"
- price → "Checking margins", "Price vs market"
- ret → "Checking repeat orders", "Churn signals"

## Motion (`hero-motion.ts`)

- `HeroEngine` receives the four lists (via a `setScan(lists)` method + initial
  pass in `AutopilotHero`'s `useGSAP` setup, mirroring `setFlags`).
- A timer advances each row's index every ~2.4s and animates the name:
  current rolls up/out (`y: -100%`, fade), next enters from below
  (`y: 100%` → `0`), GSAP, short duration with the existing emphasis ease.
- **Pause/resume** with the existing flag + dock sequence machinery: the ticker
  stops while a row is flagged ("Needs you") or while `runDockSequence` /
  approve handoff runs, then resumes — same `stopWatch` / `resumeWatch` pattern,
  so it can never fight an in-flight animation.
- Replace the dead `[data-feed-strip]` reference with the real ticker element
  (or remove it and use a new `[data-watch-scan]` slot).
- `prefers-reduced-motion`: set the first name with no tween; no interval.

## Markup (`AutopilotHero.tsx`)

The Watching row already has a flexible middle slot currently holding the hidden
`[data-watch-sub]` (flag/dock text). Add the scan ticker in that same slot:

- A single-line, `overflow:hidden` container, one line tall (no height change).
- Shows the rolling name in the idle/"All good" state.
- Yields to `[data-watch-sub]` when the row is flagged or running an action
  (existing `setSub` already hides the strip — keep that handshake).

## Embedded mirror

The embedded hero is Polaris-composed with lighter motion and must degrade
gracefully in the iframe.

- Consume the same `watchScan` field (the contract is shared by both surfaces).
- Use a lighter vertical swap (CSS or minimal GSAP) — a simple cross-fade is an
  acceptable degrade. Same ~2.4s cadence, same reduced-motion behavior.
- Confirm the embedded hero component during implementation
  (`app/components/calderyn/LiveEngineHero.tsx` / `LiveEngineView.tsx`).

## Edge cases

- New / quiet store → all lists empty → every row shows the aspect fallback. No
  blanks, nothing fabricated.
- Long names → single-line ellipsis (rows already clip).
- One list shorter than others → each row cycles its own list independently.
- Reduced motion → static name, no movement, on both surfaces.
- A failing per-group read → that list empty → aspect fallback. Page unaffected.

## Out of scope

- No new third column. The ticker lives inside the existing Watching rows.
- No schema/migration (reads existing tables only).
- No change to the flag / approve-handoff animations beyond pause/resume hooks.

## Files

- `app/lib/calibration/live-engine-types.ts` — add `watchScan`.
- `app/lib/calibration/live-engine-page.server.ts` — build the four lists + `EMPTY`.
- `app/components/dashboard/hero/AutopilotHero.tsx` — ticker markup + pass lists.
- `app/components/dashboard/hero/hero-motion.ts` — roll animation + pause/resume.
- `app/components/dashboard/screens/Dashboard.tsx` — pass `watchScan` prop.
- Embedded hero (`app/components/calderyn/…`) — lighter mirror.
- Tests: server list-builder (sources + caps + empty fallback), reduced-motion
  guard, contract shape.

## Verification

- Seeded demo store (calderyn-review-store / calderyn-test): each row rolls real
  product/campaign/cohort names.
- Empty store: aspect fallback shows, no blanks.
- Reduced motion: static.
- Local gate green (typecheck / lint / build) before any commit.
