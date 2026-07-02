# Analytics Live View — Design

**Date:** 2026-07-02
**Owner:** Eric
**Status:** Approved design, pending implementation plan
**Relation to platform pivot:** Last-minute addition to the MVP scope of
`2026-06-27-calderyn-platform-pivot-design.md`. Depends on the owned SSR
storefront (`storefront.*` routes), the owned checkout core
(`orders`/`order_line`/`cart`/`checkout_session`), and the dashboard shell
(Analytics screen, `dashboard.api.realtime-token`). Post-cutover value: the
tab is empty until a merchant runs on the owned storefront — that is by
design ("the entire idea is to compete with Shopify, complete cutovers").

## What it is

A **Live** subtab inside the dashboard's Analytics screen showing the owned
storefront's activity right now: visitors on the site, today's total sales,
sessions, orders, a customer-behavior funnel (cart → checkout → purchased),
sessions by location, new vs returning customers, and today's sales by
product. Functional equivalent of Shopify's Live View, built entirely on
first-party data.

## Decisions (settled during brainstorming)

1. **Data source: owned storefront only.** No Shopify web-pixel extension,
   no Shopify-mirror blending. All eight tiles read owned-storefront and
   owned-order data exclusively.
2. **Surface: dashboard only.** Explicit single-sided ship. The embedded
   Shopify admin gets nothing — its merchants are pre-cutover and would see
   an empty tab. TODO recorded below under Parity.
3. **Behavior tile: Shopify-style funnel** — sessions with a cart → sessions
   that reached checkout → sessions that purchased (today).
4. **Refresh model: approach C** — 60s polling plus a Supabase Realtime
   "order ping" that triggers an immediate refetch on new orders.
5. **Front-end visuals are out of scope.** Claude Design owns the styling
   via the design-handoff process. This spec ships the data layer plus a
   functionally complete, visually plain subtab. The snapshot DTO below is
   the design handoff contract.

## Event capture

**Cookies** (set/refreshed by the storefront root loader; httpOnly,
SameSite=Lax):

- `cal_vid` — visitor UUID, 1-year expiry.
- `cal_sid` — session UUID, rolling 30-minute inactivity expiry (Shopify's
  session definition).
- A session is **returning** if `cal_vid` already existed when the session
  started; stored as a boolean on each event row.

**Events** (emitted server-side from storefront loaders/actions — the
storefront is SSR, so no client tracking script exists or is needed):

| Event | Emitted from |
|---|---|
| `page_view` | storefront page loaders (path + product_id when applicable) |
| `cart_add` | cart action |
| `checkout_start` | checkout loader |
| `checkout_complete` | owned-checkout completion path, alongside the existing `CHECKOUT_COMPLETED` ingest emit |

- Money never lives on these events; sales figures aggregate the owned
  `orders` / `order_line` tables.
- **Fire-and-forget:** event-insert failures log server-side and never block
  a storefront render.
- **Bot filtering:** obvious bots filtered by user-agent regex at emit time;
  the UA itself is never stored. Known ceiling: naive regex now, proper bot
  scoring later if numbers skew.
- **Geo:** captured at SSR time from Vercel request headers
  (`x-vercel-ip-country`, `x-vercel-ip-city`). No geo-IP dependency. Null in
  dev → rendered as "Unknown".

## Data model

One new table, `storefront_event`, in a new supabase migration:

```
id            uuid pk
shop_id       (shop-scoped, RLS like existing warehouse tables)
session_id    uuid        -- cal_sid
visitor_id    uuid        -- cal_vid
is_returning  boolean
type          text        -- page_view | cart_add | checkout_start | checkout_complete
path          text
product_id    text null
country       text null
city          text null
created_at    timestamptz
```

- **No PII**: no IP, no user agent, no email — same discipline as the owned
  ingest's `assertNoPii`.
- **Retention:** nightly purge of rows older than 30 days via the existing
  cron discipline. This table feeds a live view, not the warehouse.
- The same migration adds `orders` INSERT to the realtime publication with a
  shop-scoped RLS policy, following `20260609140000_dashboard_realtime.sql`.

## Aggregation & API

One new endpoint: **`dashboard.api.analytics.live`** (loader-only,
`requireDashboardSession`, shaped DTO — no raw rows). Single round trip:

```ts
{
  generated_at: string,
  visitors_now: number,            // distinct session_id with an event in the last 5 min
  sessions_today: number,          // distinct session_id since store-tz midnight
  total_sales_today_cents: number, // owned orders paid today
  currency: string,
  orders_today: number,
  funnel: { cart_sessions: number, checkout_sessions: number, purchased_sessions: number },
  by_location: Array<{ country: string, sessions: number }>,  // top 8, rest folded into "Other"
  new_vs_returning: { new: number, returning: number },       // sessions today
  top_products: Array<{ product_id: string, title: string, sales_cents: number, units: number }> // top 5 today
}
```

- All "today" windows use the store-timezone convention from
  `app/lib/dashboard/business-hours.ts`.
- Visitor/session/funnel/location tiles aggregate `storefront_event`; money
  and product tiles aggregate owned `orders` + `order_line` joined to
  `sku_dim` for titles.
- Plain SQL aggregates — no materialized views or rollup tables at pilot
  scale. Known ceiling: revisit if a shop passes ~100k events/day.
- Funnel and session counts are **distinct sessions**, never raw event
  counts.

## Refresh model

- Poll every **60s** while the Live subtab is visible; pause entirely when
  `document.visibilityState` is hidden or the user switches subtabs.
- **Order ping:** subscribe via the existing `dashboard.api.realtime-token`
  client pattern to postgres_changes INSERT on `orders`. The payload is
  ignored — it only triggers an immediate refetch, so no aggregation logic
  ever lives client-side.
- Realtime unavailable (token route 503s): the tab silently stays on the
  60s poll. Degraded, not broken.

## UI wiring (code side only)

- `app/components/dashboard/screens/Analytics.tsx`: screen-level `Segmented`
  subtab **Performance | Live**; the existing 7d/14d/30d range control
  applies to Performance only.
- New `app/components/dashboard/screens/AnalyticsLive.tsx`: renders the
  snapshot DTO with existing cd-* primitives (`Card`, stat rows,
  `Placeholder`) — functionally complete, visually plain.
- New hook `useLiveAnalytics()` owns fetch + 60s visibility-gated interval +
  order-ping subscription. The component stays dumb.
- Live view model added to `app/components/dashboard/view-models.ts`
  alongside the existing `*VM` types.
- Sessions by location renders as a ranked bar list, not a map — a map
  library is a new top-level dependency, deferred post-MVP.

## Error handling

- Emit path: log-and-continue; never block a buyer-facing render.
- Endpoint: standard `jsonError` handling; UI uses the existing error
  `Placeholder` pattern.
- All-zero snapshot is a valid state (cold start / no traffic), not an
  error.

## Testing (behavior, not coverage)

- Session/visitor cookie logic: 30-minute rolling expiry; new-vs-returning
  determination.
- PII guard on the new event emitter (forbidden keys rejected).
- Aggregate correctness: funnel counts distinct sessions, not events;
  5-minute `visitors_now` window; store-tz "today" boundary.
- Bot-filter regex.
- DTO shape on the endpoint.

## Parity

Explicit single-sided ship (dashboard only), per owner decision 2026-07-02.
TODO: if a pre-cutover merchant surface ever needs live analytics, that is a
separate feature (Shopify web-pixel extension) — not a mirror of this one.

## Out of scope

- Shopify-storefront visitor tracking (web pixel extension).
- Map rendering for locations.
- Live activity feed / event ticker.
- Rollup tables or materialized views.
- Embedded-admin (Polaris) mirror.
- Final visual design (Claude Design, via handoff).
