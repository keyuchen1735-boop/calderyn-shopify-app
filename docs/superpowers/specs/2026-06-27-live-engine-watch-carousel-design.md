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
  ret: string[];   // reserved: no real customer/cohort source today → stays
                   // empty → row uses the aspect fallback. No fabricated names.
};
```

`WatchGroup` keys (`inv | ads | price | ret`) already exist in
`engine-events.ts`.

## Server build (`live-engine-page.server.ts`)

Inside `buildLiveEnginePageData`, add a `watchScan` section assembled via the
same best-effort `Promise.allSettled` pattern as the other sections (a failing
read degrades that one list to empty, never breaks the page):

| Group | Source | Notes |
|-------|--------|-------|
| `inv`   | `client.skus.list()` — **already fetched** by the loader | product `title`s, top ~8 (list is ordered by `on_hand` desc); dedup |
| `price` | same `client.skus.list()` result | ~8 product `title`s in a **different deterministic order** (e.g. by `velocity`/`ship_pnl_cents`) so it never mirrors `inv` |
| `ads`   | `client.campaigns.list()` — **one new bounded read** (`v_campaigns_flat`) | campaign `name`s, top ~8. (Reliable; `campaignGrades` is empty until the engine grades.) |
| `ret`   | none today | no customer/cohort source exists in the client; `ret` stays `[]` → row uses aspect fallback. No PII, no fabricated names. |

All reads go through the existing `calderynClient`. `inv`/`price` reuse data the
loader already loads (zero extra cost); `ads` adds one bounded read inside the
same `Promise.allSettled` batch. Each list capped at ~8 entries, trimmed/deduped
server-side. SKU titles are product-level (no variant), so e.g. "Summit Logo
Tee" — the design's "· M" variant suffix isn't available and is omitted.

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

## Embedded mirror (automatic — shared component)

The embedded surface (`app/components/calderyn/LiveEngineView.tsx`) imports and
renders the **same** `AutopilotHero` as the dashboard, and its route loader uses
the same `buildLiveEnginePageData`. So the carousel appears on both surfaces from
one implementation — no separate Polaris hero, no second animation to write.

Mirror work is just prop plumbing:
- `LiveEngineView` passes `watchScan={data.watchScan}` to `AutopilotHero`, the
  same way `Dashboard.tsx` does.
- Reduced-motion + iframe behavior already work because both share the hero.

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
- `app/components/calderyn/LiveEngineView.tsx` — pass `watchScan` prop (same
  shared `AutopilotHero`; this is the entire embedded mirror).
- Tests: server list-builder (sources + caps + empty fallback), reduced-motion
  guard, contract shape.

## Verification

- Seeded demo store (calderyn-review-store / calderyn-test): each row rolls real
  product/campaign/cohort names.
- Empty store: aspect fallback shows, no blanks.
- Reduced motion: static.
- Local gate green (typecheck / lint / build) before any commit.
