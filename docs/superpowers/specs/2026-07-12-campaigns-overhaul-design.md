# Campaigns Overhaul — Design

**Date:** 2026-07-12
**Status:** Approved by John (conversation), pending spec review
**Surfaces:** Native dashboard only (`app/routes/dashboard.*`, `app/components/dashboard/`). No changes to the legacy embedded app.
**Related:** `docs/handoffs/campaigns-moby-triplewhale-parity.md` (June 16 competitive spec — its dashboard-parity rule is retired; everything here is dashboard-only). `docs/superpowers/specs/2026-07-12-guided-journey-onboarding-design.md` covers store setup and explicitly excludes ad campaigns; this spec picks up where it ends.

## Problem

The Campaigns section works for a merchant who already runs ads, but:

1. A new user with no campaigns — possibly no ad account at all — gets a dead end: an empty state that links to Settings and nothing more. The "New campaign" screen creates a local draft that can't do anything.
2. Everyday controls are missing: no budget editing, no duplicating a winner, no quick pause from the list.
3. Calderyn's real advantages (profit data, peer benchmarks, weather signals, creative AI) are not surfaced where campaign decisions happen.

## Goals

- A first-time user goes from "never ran an ad" to a real, paused Meta campaign without leaving Calderyn — skippable at every step for people who know what they're doing.
- A regular user can do their weekly campaign chores (pause, budget, duplicate) in one or two clicks.
- The section beats Shopify's marketing area on both ease and capability, without clutter (progressive disclosure; one decision at a time; plain language — per the UX rules in the parity handoff).

## Non-goals

- Google/TikTok API writes (their wizard path ends with a written plan + launch instructions).
- Multi-touch attribution / MMM (stretch, out of scope).
- Any changes to `app/routes/app.*`.

## Safety decisions (locked)

- **Everything Calderyn creates on Meta is created PAUSED.** The user flips it on explicitly from Calderyn.
- Daily budget clamped **$5–$200** client- and server-side for wizard-created campaigns.
- Partial-failure rollback: if ad set / creative / ad creation fails after the campaign exists, delete the campaign (cascades on Meta) so no junk is left behind.
- Idempotent create: the wizard run and created Meta ids are persisted; re-submitting the same run cannot duplicate.
- All mutations go through the existing action orchestrator pattern (ownership check, audit row, undo where reversible). No direct Meta calls from routes.

---

## Phase 1 — first-campaign wizard + everyday controls + polish

### 1a. First-campaign wizard (Meta)

**Entry points:**
- Campaigns screen with zero campaigns and zero drafts → wizard replaces the empty state (with an "I know what I'm doing — skip" link that reveals the plain list + connect button).
- The "New campaign" button → same wizard for everyone (replaces the current name+platform draft screen and its fake empty-stat grid).

**Steps:**

1. **Platform + account.** Meta is the featured path. Not connected: two branches — "I have an ad account" → existing OAuth (`startIntegrationConnect`, scopes already include `ads_management`); "I don't" → a short in-app walkthrough for creating a free Meta Business account + ad account (external links, 3 plain steps), then connect. After connect the wizard verifies and reports in plain language anything missing: `ads_management` scope (`hasAdsManagementScope`), a Facebook Page (`/act_X/promote_pages`, same call `resolvePageId` uses), and a funding source (`/act_X?fields=funding_source_details`; if the field is unavailable, show a "make sure billing is set up" link to Meta billing settings instead of blocking).
2. **Product + budget.** Pick a product from the catalog (image, name, price). Daily budget input with plain guidance ("most stores start at $10–20/day"), clamped $5–$200. Destination URL defaults to the product's storefront page.
3. **Calderyn writes the ad.** Generate 2–3 creative variants (headline, primary text, CTA; image = the product image) via the existing screener generator (`screener/generate.server.ts`) with a new "from product" entry point (feed it the product listing instead of an existing ad's creative). User picks one and can edit any field.
4. **Review + create.** One-screen summary: product, budget/day, audience (broad, shop country — Advantage+ defaults), the chosen creative, and "nothing spends until you turn it on." Button: **Create on Meta (paused)**.
5. **Turn on.** The new campaign appears in the list (inserted into local state immediately, reconciled by the next sync) with a prominent "Turn on" affordance → existing `resume_campaign` executor.

**Google/TikTok path:** steps 2–3 are identical; step 4 produces a written campaign plan (settings to enter + the generated creative) with per-platform launch instructions. No dead-end drafts: existing `campaign_drafts` rows render with a "Continue setup" action that reopens the wizard prefilled with the draft's name/platform, plus a delete action. The wizard replaces draft creation, so no new dead-end rows are ever created.

**Server work:**
- `app/lib/meta/campaign-create.server.ts` — new. `createFirstCampaign(conn, input)`: `POST /act_X/campaigns` (objective `OUTCOME_SALES`, `special_ad_categories: []`, status `PAUSED`) → `POST /act_X/adsets` (daily_budget, billing `IMPRESSIONS`, optimization `OFFSITE_CONVERSIONS` when a pixel/dataset exists, else `LINK_CLICKS`; broad targeting, shop country; status `PAUSED`) → creative + ad via the existing `createPausedAd` building blocks. Reuses `MetaClient`, `withRetry`, permanent-error codes, throttle — same conventions as `ad-create.server.ts`.
- `app/routes/dashboard.api.campaigns.first-run.tsx` — POST (create) + GET (verify/preflight status). `requireDashboardSession` + `requireSameOrigin`. Validates body at the boundary; clamps budget server-side.
- Persistence: a `campaign_wizard_runs` table (shop-scoped, RLS, SQL migration): run id, input snapshot, created Meta ids (campaign/adset/creative/ad), status (`creating | created | rolled_back | failed`). Serves idempotency + rollback bookkeeping + "resume where I left off."

### 1b. Everyday controls

- **Quick actions on list rows** (hover / overflow menu): pause/resume (existing executors), edit budget, duplicate.
- **Edit budget:** small modal, current value prefilled, plain projection line. New `update_campaign_budget` ExecutableKind through the orchestrator + guardrails (arbitrary target value; existing kinds only reduce/increase by suggestion). Meta-only until Google/TikTok write paths exist — controls hidden per platform, same pattern as the Meta-only creative tools.
- **Duplicate:** Meta `POST /{campaign_id}/copies` (deep copy, created paused, "(copy)" suffix). New executor kind `duplicate_campaign`, undo = delete the copy.

### 1c. Performance history chart

Campaign detail gets a simple spend + ROAS line over the last 30/90 days. The series already exists server-side (`get_roas_series` feeds the assistant/MCP); expose it on the campaign detail payload and render with the existing sparkline/chart primitives. No new ingestion.

### 1d. Polish pass (rides along)

- Land the in-flight Campaigns WIP already carried into this branch: platform marks on rows, the account summary strip (live count / $-per-day / losing-money badge, with the paused-budget and zero-spend fixes), Meta-only gating of creative tools + honest per-platform empty copy (`campaign-creative-status.ts` + tests).
- Remove the fake empty-stat/chart grid from campaign creation (replaced by the wizard).
- List/detail tidy: consistent spacing, mobile behavior (Pan primitive where the table is wide), empty/learning states in one friendly line each.
- Screen-cache: any new screen state plugs into seed + write-through + `WARM_TARGETS`.

---

## Phase 2 — insight layer

- **Creative fatigue watch.** New detector (`creative_fatigue`) in the detect pipeline comparing a live ad's rolling CTR/ROAS trend against its own baseline (data via the existing ad-scorecard/top-ads ingestion). Alert copy in plain language ("this ad's results dropped ~40% in 2 weeks"), one-click "Generate a fresh variant" → existing generator → push as paused draft ad (existing `createPausedAd`). Approval-gated like every action.
- **Profit per campaign.** Attribute owned-storefront orders to campaigns via UTM (wizard-created ads set UTMs on the destination URL), join contribution margin the breakeven logic already uses → "made you $X after costs" on list + detail. Shopify-imported and Meta-attributed numbers stay clearly labeled as estimates.
- **Peer comparison.** One line on campaign detail ("ROAS in the top 25% for stores your size") reusing the PeerBenchmarks data path.

## Phase 3 — automation layer

- **Plain-English automation rules.** User types a rule; Claude parses it into a structured, validated rule (metric, threshold, window, action) stored in an `automation_rules` table; a cron evaluates rules and queues proposed actions into the existing alerts/approval inbox. Guardrails and dollar caps apply. Rules are always approval-gated to start; "auto-run" is a later opt-in.
- **Weather tie-in.** Surface the existing weather-reallocation suggestions on the relevant campaign rows/detail instead of only in their current home.

Phases 2 and 3 get their own implementation plans when we reach them; this spec fixes their shape so Phase 1 doesn't paint us into a corner (UTMs from day one, wizard table reusable as automation bookkeeping precedent).

---

## Error handling

- Every Meta error surfaces to the user in plain language with the raw reason preserved in the audit/logs (no swallowed payloads).
- Wizard preflight failures (missing Page, no funding) are actionable messages with links, never dead ends.
- Rollback failures (couldn't delete after partial create) mark the wizard run `failed` with the orphan ids recorded and tell the user exactly what exists on Meta.

## Testing

- Unit: `campaign-create.server.ts` with a fake `MetaClient` (repo convention — mirrors `ad-create` and `campaigns` tests): happy path, each failure point + rollback, idempotent re-submit, budget clamp.
- Unit: wizard preflight logic, `update_campaign_budget` + `duplicate_campaign` executors (orchestrator contract: idempotency, audit, undo).
- Existing `campaign-creative-status` tests ride along.
- Manual e2e: one real run against John's Meta ad account — $5/day budget, created paused, verified in Ads Manager, then deleted. No campaign is ever turned on during testing.

## Rollout

- Branch `feat/campaigns-overhaul` in its own worktree (`../calderyn-campaigns-overhaul`), already carrying the in-flight Campaigns WIP.
- Phase 1 ships as 2–3 PRs: (1) polish + everyday controls, (2) wizard UI + preflight, (3) Meta create + turn-on. Each through the standard pre-commit gate.
