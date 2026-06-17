# Refresh-on-focus — design

**Date:** 2026-06-17
**Branch:** `feat/refresh-on-focus` (worktree)
**Surfaces:** embedded Shopify app (`app/routes/app.*`) **and** the dashboard webapp (`app/routes/dashboard.*` → `DashboardApp`)

## Problem

When a merchant tabs away from a surface and comes back, they can be staring at
stale data without realizing it. Browsers throttle or freeze background timers,
so even the dashboard's existing 15s "Live sync" poll can leave the screen
minutes out of date on return. The embedded Shopify app has no live updating at
all — its data only changes on navigation or a manual reload.

We want the behavior every modern dashboard has: **the moment you look at the
tab again, new data quietly appears in place** — no full page reload, no scroll
jump, no lost work. (Reference behavior: returning to Expo's dashboard and a new
item has popped in.)

## Non-goals

- **Not** a full-page (F5) reload on either surface. Updates land in place via
  the existing in-place mechanisms (Remix `revalidate`, dashboard `refresh`).
- **Not** a new realtime/push transport. This is purely a *trigger*: nudge the
  already-existing refetch the instant the tab becomes visible.
- **No** new polling loop. On the dashboard, focus only makes the *next* check
  immediate; it does not run a second poller alongside `useLiveFeed`.
- **No** visual chrome (no "Refreshing…" toast). Existing loading cues suffice.

## Cost / API impact (verified)

A focus-triggered refresh **re-reads data the surfaces already serve** — it does
**not** touch any metered/paid API:

- Embedded app loaders and `/dashboard/api/*` endpoints read from Supabase
  Postgres. A grep of the `app.*.tsx` route loaders found no Anthropic, Meta, or
  Google-ads calls — those run only in background engine jobs, never on a page
  load/refresh.
- A 10s **cooldown** caps frequency, so rapid tab-flicking cannot spam requests.
- On the dashboard, "respect the toggle" means **zero** extra activity when Live
  sync is off.

Worst case the volume is comparable to the dashboard's existing 15s poll, just
better-timed (fires on return instead of up to 15s later).

## Architecture

One shared, pure-logic core plus a thin React hook; two thin call sites. This
mirrors the repo's established split — `pollLiveTick` (pure, unit-tested) wrapped
by `useLiveFeed` (thin, untested DOM/effect glue).

```
app/lib/use-refresh-on-focus.ts
  ├─ createFocusRefresher({ now, minIntervalMs, onRefresh })   ← PURE — unit-tested
  │     .handleVisible():
  │         if (now() - lastFire) >= minIntervalMs:
  │             lastFire = now(); onRefresh()
  │         else: skip
  │     (lastFire starts at -Infinity so the first call always fires)
  │
  └─ useRefreshOnFocus(onRefresh, { enabled?, minIntervalMs = 10_000 })  ← thin hook
        • when enabled === false: attach nothing (no-op)
        • else: on mount, attach listeners for:
            - document 'visibilitychange'  → if document.visibilityState === 'visible', handleVisible()
            - window   'focus'             → handleVisible()
        • keep latest onRefresh in a ref so the effect doesn't re-bind per render
        • cleanup removes both listeners on unmount / when enabled flips off
```

### Components

| Unit | Purpose | Depends on | Tested? |
|---|---|---|---|
| `createFocusRefresher` | Decide fire-vs-skip via injected clock + cooldown; own `lastFire` | nothing (pure) | **Yes** (node) |
| `useRefreshOnFocus` | Wire DOM events → `handleVisible`; honor `enabled` | React, `document`, `window`, `createFocusRefresher` | No (thin glue) |

### Call sites

| Surface | File | Wiring | Enabled |
|---|---|---|---|
| Embedded app | `app/routes/app.tsx` | `const { revalidate } = useRevalidator(); useRefreshOnFocus(revalidate);` | always |
| Dashboard | `app/components/dashboard/DashboardApp.tsx` | `useRefreshOnFocus(refresh, { enabled: liveOn });` | gated on `liveOn` |

`app.tsx` is the embedded shell wrapping `<Outlet/>`, so `revalidate()` re-runs
whichever child route loader is currently mounted — i.e. the screen the merchant
is actually looking at. `refresh` and `liveOn` already exist in `DashboardApp`.

## Data flow

```
tab becomes visible / window focused
        │
        ▼
useRefreshOnFocus listener fires
        │  (visibilitychange checks visibilityState === 'visible')
        ▼
createFocusRefresher.handleVisible()
        │
   cooldown elapsed? ──no──▶ skip (do nothing)
        │ yes
        ▼
   onRefresh()
        ├─ embedded app:  revalidate()  → Remix re-runs loaders → in-place re-render
        └─ dashboard:     refresh()     → load() refetches /dashboard/api/* → setState → in-place re-render
```

In-place: neither path reloads the document. Component state, scroll position,
and any open panels are preserved.

## Error handling

`onRefresh` owns its own failures. Both real callbacks already do this today:

- `revalidate()` — Remix surfaces loader errors through the route's existing
  error boundary; the hook does not wrap it.
- dashboard `refresh()` — already catches and shows a toast on failure
  (`DashboardApiError` → `toast(..., "critical")`).

The hook therefore calls `onRefresh()` without its own try/catch. Both real
callbacks are effectively fire-and-forget (`revalidate` is void; `refresh`
catches internally), so an unhandled throw is not a concern in practice. The
pure core does not await `onRefresh`.

## Edge cases

- **First visible after mount:** fires (lastFire = -Infinity).
- **Rapid flick within cooldown:** second+ calls skip until 10s elapse.
- **`enabled` flips on (dashboard Live sync turned back on):** listeners
  (re)attach; the next return fires normally.
- **`enabled` flips off:** listeners detach; returns do nothing.
- **Both events fire close together** (e.g. focus + visibilitychange on the same
  return): the cooldown collapses them into a single refresh.
- **SSR / no `document`:** the hook's effect only runs client-side (React
  `useEffect`), so server render never touches `document`/`window`.

## Testing (TDD target)

Pure unit tests for `createFocusRefresher` in `app/lib/__tests__/` (node env,
`.test.ts`, injected clock — no jsdom, consistent with `vitest.config.ts`):

1. fires `onRefresh` on the first `handleVisible()`
2. **skips** a second `handleVisible()` inside the cooldown window
3. fires again once `now` advances past `minIntervalMs`
4. each fire resets the cooldown from that fire's timestamp

The `useRefreshOnFocus` hook itself is thin DOM glue and is not unit-tested, same
as `useLiveFeed`. (`enabled` is a hook concern; the pure core is always armed.)

## Pre-commit gate (per CLAUDE.md)

Major commit (new `app/lib/` module + edits to `app.tsx` shell). Before
commit/PR: `/code-review`, patch sanity, then `npm run typecheck` → `npm run
lint` (`--max-warnings=0` on new files) → `npm run build` → `npm run test`, all
green with evidence pasted. No Prisma/GraphQL changes, so those steps are N/A.

## Dashboard parity

Both surfaces are in this one repo, so the shared hook satisfies the mandatory
extension⇄dashboard parity rule in a single change — no separate dashboard
re-implementation needed. Both call sites ship together in this branch.
