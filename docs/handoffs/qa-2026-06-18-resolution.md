# QA handoff 2026-06-18 — resolution

Branch `worktree-fix+qa-handoff` (off `origin/main`). Every code item below shipped
as its own commit with the full pre-commit gate green (typecheck → vitest → build →
lint: 0 errors). Lint shows 10 pre-existing warnings, none in this work.

## Code fixes (done)

| Item | Fix | Key files |
|---|---|---|
| P0-1 | Blocked/failed actions no longer report success on the dashboard | `meta/actions.server.ts` (permanent-error classification), `action-outcome.ts`, `DashboardApp.tsx` |
| P0-2 | Reallocate no longer fails on malformed GIDs | `seed/dataset.ts` (valid GIDs), `shopify/inventory.server.ts` (GID guard) |
| P1-3 | One margin-adjusted ROAS via shared `trueRoas()` | `screens/Campaigns.tsx` |
| P1-4 | "Recovered across N actions" counts only money-recovering actions | `recovered.ts` |
| P1-5 | One 30-day window label for `dollar_impact` | `impact-window.ts`, dashboard screens, `calderyn/index.tsx` |
| P1-6 | "No data" vs "Poor" grade for zero-revenue rows | `campaign-grade.ts`, both surfaces |
| P1-7 | Consistent 30-day at-risk window label | `Alerts.tsx`, `calderyn/index.tsx` |
| P1-8 | Per-action dollar cap compared in matching units (was 100× too lenient) | `alert-action.server.ts`, `app.alerts.$id.tsx` |
| P2-9 | No "All clear" during cold load | `screens/Dashboard.tsx` |
| P2-10 | One plain detector label + matching nav, no snake_case | `labels.ts`, `format.ts`, screens, `app.tsx` |
| P2-11 | "Sold out" not "may sell out" at 0 stock | `labels.ts` `alertDetectorLabel`, both surfaces |
| P2-12 | Friendly errors + no raw UUIDs in action history | `friendly-error.ts`, `adaptAudit`, `Audit.tsx` |
| P2-13 | "Needs attention" ranks by urgency, drops zero-velocity noise | `client.ts` (`sortSkusByUrgency`, misplaced gate), `Inventory.tsx` |
| P2-14 | Recommended action fits the alert (no Pause without a campaign) | `labels.ts` `recommendedAction`, `app._index.tsx` |
| P2-15 | Meaningful copy for empty cover / ship-P&L cells | `Inventory.tsx`, `ship-pnl-cell.tsx` |
| P2-16 | "Stale" badge on campaigns from a disconnected source | `integration-status.ts`, `Campaigns.tsx` |

## Non-code items

- **P2-17 (alert sync) — verified, no code change.** Both surfaces read the same
  persisted Supabase alert store (`v_alerts_view`) with the same `status === "open"`
  filter; resolving persists via `acknowledgeAlert`, so the other surface reflects it
  on its next load/refresh — which is the stated acceptance ("after refresh"). The
  dashboard also polls live.
- **P2-18 (app listing copy) — Partner Dashboard task.** The App Store description is
  not in the repo (no `description` field in `shopify.app.*.toml`); it lives in the
  Shopify Partner Dashboard listing. Suggested copy: *"Calderyn watches your ad spend
  and inventory together — catching money leaks across Meta, Google, and TikTok ads
  and your Shopify stock before they compound. Plain-language alerts, one-click fixes,
  true (margin-adjusted) ROAS, reorder timing, and an AI creative pre-screen."*
- **Test-data hygiene — prod review-store cleanup.** The junk campaigns ("[BRAND NEW
  … HK Army …]", "CALDERYN LIVE TEST", "Smoke Test Product") are rows in the prod
  review store, not in the seed (the seed generates clean names). Clean them in the
  review store before App Store review.

## Cross-repo / engine follow-ups (cannot be fixed from this repo)

The data API (`get_shop_stats`, `list_campaign_grades`, `get_guardrails`) is served by
the external engine/MCP, not this repo. These need engine-side work:

- **P1-3/P1-4/P1-7:** the data-API blended ROAS (1.46×), `recovered_7d` (65 actions),
  and open-alert count (22 vs the UIs' 23) come from the engine's own windows/queries.
- **P1-6:** the grading job writes `revenue_cents: 0` for campaigns with real ROAS
  (attribution drop) — the display now shows "No data", but the writer should fix the
  revenue join and reconcile grade ROAS with the campaigns endpoint.
- **P1-8:** the live guardrail `dollar_cap_cents` is a $10M no-cap sentinel (stored
  data); re-set the prod `guardrail_config` to a real preset ($100/$250/$500). The
  code default is already $1,000.
- **P0-2:** seeded synthetic inventory items aren't real Shopify objects, so reallocate
  on the review store still fails at the live API ("not found") — re-seed with real
  ingested data for true end-to-end reallocate.
- **P2-12:** resolving an audit-row UUID to the actual campaign/SKU name (vs hiding it)
  needs a name lookup in the audit feed.
- **P2-11:** stale `evidence.stock` and the `scaling_sku_fulfillment_risk` ↔
  `sku_stockout_vs_spend` overlap are detector-side.
