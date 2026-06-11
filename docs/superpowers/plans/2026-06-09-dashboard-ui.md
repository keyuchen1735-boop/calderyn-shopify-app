# Dashboard UI Implementation Plan

> Port the approved Apple-HIG "Calderyn DashV2" prototype into the Remix app at `/dashboard`, live-wired to the `/dashboard/api/*` backend. Built on branch `feat/dashboard-ui` (based on `feat/web-dashboard-backend`).

**Source of truth (prototype, READ THESE — do not render them):**
`C:\Users\famou\Downloads\calderyn-dashv2-handoff\calderyn-dashv2\project\` — `Calderyn Dashboard.html` (the `<style>` block + script order), `ui.jsx`, `icons.jsx`, `tweaks-panel.jsx`, `image-slot.js`, `data.js`, `app.jsx`, and `screen-*.jsx`. Recreate the visual output faithfully; convert structure to real ESM modules.

**Goal:** A standalone, gated, Apple-clean merchant dashboard SPA served at `calderyncompany.com/dashboard`, with the 7 data screens (Overview, Alerts, Campaigns, Analytics, Inventory, Action history, Settings) wired to the real backend, and Predictor + Ad Generator ported as the prototype's simulated screens (their backend is owned by another agent — leave a clean seam).

**Non-negotiables:** Apple-HIG look ported pixel-faithfully; WCAG AA; `prefers-reduced-motion` respected (already in the CSS); no Polaris/App Bridge on this route.

---

## Architecture

### Route + auth gate
- `app/routes/dashboard._index.tsx` — the SPA page. `loader`: resolve the dashboard session; **if none, `redirect("/dashboard/login")`** (HTML redirect, NOT the JSON 401 the API routes throw). Prefetch first-paint data server-side (overview + alerts + campaigns) via `calderynClient(session.shopDomain)` and return it; the client hydrates and then refetches/streams. Export `links` for the dashboard stylesheet(s). Render `<DashboardApp initial={data} />` (client component).
- This is a top-level route, so it renders inside `app/root.tsx` only — no Polaris shell.
- Note `v3_singleFetch` is on; loaders return plain objects.

### Auth helper
- Add `getSessionOrRedirect(request)` to `app/lib/dashboard/session.server.ts` (or a small wrapper in the route): like `requireDashboardSession` but throws `redirect("/dashboard/login")` instead of a 401 JSON, for HTML routes.

### CSS
- `app/styles/dashboard.css` — the entire `<style>` block from `Calderyn Dashboard.html` (lines 12-436), verbatim, including the `:root`/`.cd-root`/`.cd-dark` tokens and all `cd-*` classes and keyframes.
- `app/styles/dashboard-utils.css` — port `tw-lite.css` (the small Tailwind subset the screens use: `flex`, `items-*`, `justify-*`, `gap-*`, `grid`, `mb-*`, `ml-auto`, `relative`, `absolute`, `w-full`, `flex-1`, `text-center`, `tabular-nums`, `-rotate-90`, `-translate-x-1/2`, `fixed`, `z-50`, `overflow-visible`, `select-none`, etc.). Read `tw-lite.css` and include exactly the classes it defines.
- Both attached via the route's `links` export (`import dashCss from "~/styles/dashboard.css?url"`).

### ESM conversion (no more globals)
The prototype attaches everything to `window` and uses babel-in-browser. Convert to ESM modules under `app/components/dashboard/`:
- `icons.tsx` — the `cdIcon` factory + all `Icon*` + `CDIcon` + `CD_ICONS` + `CD_ACTION_ICON`. Export `CDIcon` and the maps. (Port `icons.jsx` verbatim; add types.)
- `ui.tsx` — all primitives from `ui.jsx`: `useCountUp`, `CountMoney`, `CountNum`, `Card`, `SectionTitle`, `SevBadge`, `Pill`, `GradePill`, `PlatformMark`, `Toggle`, `Segmented`, `Btn`, `Meter`, `Sparkline`, `AreaChart`, `RingGauge`, `ScoreBar`, `ToastHost`, `Placeholder`. They currently call `CD.money`/`CD.moneyK` — replace with imports from `format.ts` (below).
- `format.ts` — `money(cents)`, `moneyK(cents)` (verbatim from `data.js` top), plus label maps (`ACTION_LABELS`, `DETECTOR_TERMS`, `GROUP_LABELS`, `SEV_STYLE`). These are pure and shared.
- `tweaks-panel.tsx` — port `tweaks-panel.jsx` + the `useTweaks` hook (read the file; it persists to localStorage). Keep the floating panel.
- `image-slot.tsx` — port `image-slot.js` (drag-drop persistent image slots; used by predictor/generator). Persist to localStorage as the prototype does.
- `view-models.ts` — TypeScript types for the screen view-models (the `CD`-shaped objects: `CampaignVM`, `AlertVM`, `AuditVM`, `SkuVM`, `GuardrailVM`, `DailyRow`, `TopAd`). These mirror `data.js` shapes.

### Data layer (live wiring)
- `app/lib/dashboard/client.ts` — browser fetchers (same-origin `fetch`, cookie auto-sent) for each endpoint, each returning the **view-model** shape the screens expect:
  - `fetchOverview()` → `/dashboard/api/overview`
  - `fetchAlerts(filters?)` / `fetchAlert(id)` → `/dashboard/api/alerts[/:id]`
  - `fetchCampaigns()` / `fetchCampaign(id)` → `/dashboard/api/campaigns[/:id]`
  - `fetchSkus()` → `/dashboard/api/skus`
  - `fetchAudit()` → `/dashboard/api/audit`
  - `fetchGuardrails()` / `putGuardrails(patch)` → `/dashboard/api/guardrails`
  - `fetchIntegrations()` → `/dashboard/api/integrations`
  - `fetchAnalytics()` → `/dashboard/api/analytics` (NEW endpoint, see below)
  - `postCampaignAction(id, body)` → `/dashboard/api/campaigns/:id/action`
  - `postUndo(auditId)` → `/dashboard/api/audit/:id/undo`
  - `realtimeToken()` → `/dashboard/api/realtime-token`
  - All POST/PUT include header `{"Content-Type":"application/json","Origin":location.origin}` (the API's `requireSameOrigin` allows the apex + app origins) and `credentials:"same-origin"`.
  - Each fetcher maps the raw API JSON to the view-model via adapter functions (see Data Mapping). On non-2xx, throw a typed error the screens can show.

### Live engine (replaces the simulated feed)
The prototype fabricates orders/spend ticks. Real equivalent:
- **Activity feed**: subscribe to Supabase Realtime on `action_audit` + `alerts` using the token from `realtimeToken()` when `SUPABASE_JWT_SECRET` is configured; otherwise **poll** `/dashboard/api/audit` + `/dashboard/api/alerts` every ~15s and diff for new rows. New rows animate in via `.cd-feed-new`.
- **Count-up "today" numbers**: poll `/dashboard/api/overview` every ~15s; feed deltas into the existing `useCountUp`.
- The decorative order/spend ticks have no real source yet — drive the feed only from real audit/alert changes; keep the "Live sync" toggle + pulsing dot. Document this seam in `client.ts`.
- Wrap Realtime in a `useLiveFeed` hook in `app/components/dashboard/live.ts`. Realtime is additive; polling is the always-on fallback so the dashboard works before `SUPABASE_JWT_SECRET` is set.

### App shell
- `app/components/dashboard/DashboardApp.tsx` — port `app.jsx`: sidebar nav (the 9 `NAV_ITEMS`), client-side screen state (`useState` nav, default "dashboard"), tweaks panel, toast host, the `app` context object passed to screens. Replace the simulated `executeAction`/`undoAction`/`pushAdDraft` with calls to `client.ts` (optimistic update + reconcile), keep `toast`/`relTime`. Replace `CD.*` initial state with `initial` props from the loader, then refresh via fetchers.

### Screens (`app/components/dashboard/screens/*.tsx`)
Port each `screen-*.jsx` to a typed component consuming the `app` context. The 7 data screens read from the live fetchers (seeded by loader data); Predictor + Generator keep the simulated `scorecard`/`generator` constants (port them into `app/components/dashboard/demo.ts` and mark `// TODO(other-agent): replace with live predictor/generator API`).

---

## Backend addition: `/dashboard/api/analytics`

The Analytics + Campaigns screens need data the current routes don't expose: campaign grades (`grade`, `break_even_roas`), the 30-day ROAS series, and top ads. `calderynClient` already has the methods.

Add `app/routes/dashboard.api.analytics.tsx` (GET, session-gated, same pattern as Task 6):
```ts
return dashboardJson(async () => {
  const c = calderynClient(session.shopDomain);
  const [roasSeries, grades, topAds] = await Promise.all([
    c.analytics.dailyRoasSeries(30),
    c.analytics.campaignGrades(),
    c.analytics.topAdsByEngagement(30, 10),
  ]);
  return { roas_series: roasSeries, grades, top_ads: topAds };
});
```
Test mirrors `api-read-routes.test.ts` (guard propagation + shape). This is the only backend change in this plan.

---

## Data Mapping (API JSON → screen view-model)

| Screen field (prototype) | Source | Mapping / derivation |
|---|---|---|
| `campaign.{id,name,platform,status,daily_budget_cents,roas_7d,contribution_margin,spend_7d}` | `/campaigns` | direct (`Campaign` type matches) |
| `campaign.{grade,breakeven_roas}` | `/analytics` `grades[]` join on `campaign_id` | grade string + `break_even_roas`; default `grade:"okay"`, `breakeven_roas:0` if absent |
| `campaign.trend[]` | `/analytics` roas series is account-level, not per-campaign | v1: derive a 7-pt sparkline from `roas_7d` flat, or omit the sparkline if no per-campaign series. Prefer: show `roas_7d` number + grade; render sparkline only when a series exists. Document the gap. |
| `alert.{id,detector_id,severity,status,dollar_impact,claude_rank,created_at,title,narrative,campaign,sku,evidence}` | `/alerts` | direct (`Alert` type matches; `dollar_impact` already cents) |
| `alert.campaign_id` | NOT in API | derive: look up the campaign whose `name === alert.campaign` from the campaigns list; null if no match |
| `alert.actions[]` | NOT in API | derive from context: if `campaign_id` present → `["pause_campaign","reduce_campaign_budget","snooze_alert"]`; else `["snooze_alert"]`. (Only campaign actions have a live write path.) |
| `alert.recommended` / `rec_detail` | NOT in API | v1: `recommended = actions[0]` (or null); `rec_detail` = "" / omit. Mark seam for a future server-provided recommendation. |
| executing an alert action | `/campaigns/:id/action` | for `pause_campaign`→`{type:"pause_campaign"}`, `reduce_campaign_budget`→`{type:"reduce_campaign_budget", daily_budget_cents: round(daily*0.7)}`; `snooze_alert` is client-only (no API) → optimistic local resolve + toast. Requires `idempotency_key` (crypto.randomUUID()). |
| `audit[]` `{id,action_kind,verb,target,detail,dollar_impact_at_exec,outcome,actor,when,undo_eligible,pre,post}` | `/audit` (`AuditEntry`) | map: `verb` from `action_kind` label, `actor` from `actor`, `when` from `created_at` (relTime), `undo_eligible` direct, `pre/post` from `pre_state/post_state` (stringify key bits), `dollar_impact_at_exec` already cents |
| undo | `/audit/:id/undo` | direct |
| `sku.{id,title,sku,on_hand,days_of_cover,velocity,locations}` | `/skus` (`SKU`) | direct; `status` derive: `on_hand===0`→"stockout", `days_of_cover<10`→"risk", `days_of_cover<21`→"reorder", uneven `locations`→"misplaced" heuristic, else "healthy"; `category` may be absent → omit/derive |
| `guardrails.*` | `/guardrails` (`GuardrailConfig`) | direct (shape matches incl. `autopilot_*`, `business_hours`) |
| `today.{revenue_cents,spend_cents,orders}` | `/overview` | overview returns `roas_series`, counts, `open_alert_*`; map last series point for today's revenue/spend; orders may be absent → omit or 0 |
| `daily[]` (30-day spend/revenue) | `/analytics` `roas_series` (`DailyRoasRow{day,spend_cents,revenue_cents}`) | map to `{daysAgo,spend_cents,revenue_cents}` (index from end) |
| `topAds[]` | `/analytics` `top_ads` | direct (`TopAdRow`) |
| integrations (Settings connections) | `/integrations` | `Record<string,Integration>` → list of `{name,status,detail,logoCls}` |
| `scorecard`, `generator` | none (simulated) | port demo constants; mark TODO for the other agent |

Where a field is underivable (per-campaign trend, alert recommendation, orders count), render gracefully (hide the element / show the available number) and leave a `// TODO(api):` note — do NOT fabricate data on a "live" screen.

---

## File structure

```
app/routes/dashboard._index.tsx           # SPA page + loader (auth gate, first-paint prefetch)
app/routes/dashboard.api.analytics.tsx     # NEW backend endpoint
app/styles/dashboard.css                   # ported <style> block
app/styles/dashboard-utils.css             # ported tw-lite.css
app/lib/dashboard/client.ts                # browser fetchers + adapters → view-models
app/components/dashboard/
  DashboardApp.tsx  icons.tsx  ui.tsx  format.ts  tweaks-panel.tsx
  image-slot.tsx  live.ts  view-models.ts  demo.ts
  screens/{Dashboard,Alerts,Campaigns,Predictor,Generator,Analytics,Inventory,Audit,Settings}.tsx
app/lib/dashboard/session.server.ts        # +getSessionOrRedirect
```

---

## Tasks (each: implement → typecheck → (test where applicable) → commit)

1. **Foundation A — CSS + format + icons.** Port `dashboard.css`, `dashboard-utils.css`, `format.ts`, `icons.tsx`. Commit.
2. **Foundation B — UI primitives + charts.** Port `ui.tsx` (Card, badges, controls, Sparkline, AreaChart, RingGauge, ScoreBar, ToastHost, CountUp), `view-models.ts`, `tweaks-panel.tsx`, `image-slot.tsx`. Typecheck. Commit.
3. **Backend — `/dashboard/api/analytics`** + test (mirror `api-read-routes.test.ts`). Run test. Commit.
4. **Data client.** `client.ts` with all fetchers + adapters per the mapping table; `getSessionOrRedirect` in session.server.ts. Typecheck. Commit.
5. **Route + shell + live engine.** `dashboard._index.tsx` (loader auth-gate + prefetch + links), `DashboardApp.tsx`, `live.ts`. App must render Overview with loader data behind the gate. Typecheck + `npm run build`. Commit.
6. **Overview screen** (`screen-dashboard.jsx` → `Dashboard.tsx`) live-wired. Commit.
7. **Alerts** (list + detail + guardrailed actions) live-wired (action mapping above). Commit.
8. **Campaigns** (list + detail, pause/cut-budget) live-wired. Commit.
9. **Analytics** live-wired (`/analytics`). Commit.
10. **Inventory** live-wired (`/skus`, status derivation). Commit.
11. **Action history** + undo live-wired. Commit.
12. **Settings** (guardrails PUT + connections from `/integrations`) live-wired. Commit.
13. **Predictor + Generator** ported as simulated from `demo.ts`; entry points wired; `// TODO(other-agent)` seam. Commit.
14. **Verify:** `npm run typecheck`, `npm test` (full suite green), `npm run build` (production build succeeds). Final review. Commit any fixes.

## Out of scope
- Real Predictor/Generator backend (another agent).
- Deep-link URLs per screen (client-side nav is fine for v1; hash optional later).
- Mobile layout (desktop-first per prototype; responsive breakpoints already in CSS).
