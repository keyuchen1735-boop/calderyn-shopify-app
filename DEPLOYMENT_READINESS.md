# Deployment Readiness — calderyn

**Snapshot date:** 2026-06-06 · **Branch:** `main` @ `0ab312d` · **Target:** Calderyn-SHOPIFY (Supabase `ajgrmnvzxfxxlwrxcgnu`, us-west-2, PG17) + Vercel prod

This file marks the verified state of the codebase and what remains **before pointing it at real client data**. Findings below are from direct inspection this session, not assertion.

---

## Current state — verified green

Eval pipeline run this session (all from a clean `main`):

| Gate | Result |
|------|--------|
| `npm run typecheck` (`tsc --noEmit`) | ✅ exit 0 |
| `npm run lint` | ✅ no errors (deprecation notice only on `@remix-run/eslint-config`) |
| `npm test` (vitest) | ✅ 137 passed / 33 files |
| `npm run build` (Remix+Vite) | ✅ built; benign dynamic-import chunk warning on `shopify.server.ts` |

**Working tree:** only untracked tooling dirs (`.codegraph/`, `.playwright-mcp/`, `graphify-out/`) and machine-local `.claude/settings.local.json`, `.vercel/remix-build-result.json`. No app code uncommitted.

**Wired & functional:**
- 5 cron routes match `vercel.json` crons: `/cron/ingest` (*/30), `/cron/detect` (15,45), `/cron/google` (hourly), `/cron/gdpr` (04:00), `/cron/action-retry` (*/15).
- Webhooks: app/uninstalled, GDPR (3 mandatory topics), orders/create, products/update, inventory_levels/update.
- **Primary action-execution path is real** — `app/lib/calderyn.server.ts` calls `setCampaignStatus` (live Meta mutation) and writes `action_audit`; merchant confirm (campaigns) and `audit.undo` both execute for real.
- Assistant `propose_action` correctly **proposes only** — never self-executes (shows merchant "Review & confirm").
- Security migrations applied: RLS lockdowns, `security_invoker` views, anon RPC EXECUTE revoked, header hardening, constant-time bearer compare.

**Review bugs from the Google/GDPR/action-retry slice — confirmed fixed in code:**
- searchStream now checks `!res.ok` / HTTP status before parse (`google/client.server.ts:129`).
- OAuth token exchange memoized per sync (`tokenPromise ??=`, `client.server.ts:110`) — no longer 4×/sync.
- `unitsToCents` is NaN-safe (`google/transform.ts:39-45`).
- GDPR sweep refactored to single `shops` DELETE CASCADE (was non-atomic per-table loop).

---

## Before real client data — open items

### 🔴 Blockers (must resolve)

1. **Production schema drift — repo is BEHIND prod.**
   Production has **49 applied migrations**, latest `20260606233241_attribution` and `20260606224610_tiktok_platform` (both 2026-06-06). The repo's `supabase/migrations/` has **13 files**, latest `20260605120000_alerts_view_resolve_entity_names` (06-05). Prod contains `tiktok_platform` + `attribution` migrations **not present in the repo**.
   → Reconcile before any deploy: pull prod migrations into the repo (or confirm they were applied out-of-band and back-fill the files). Shipping repo state risks a `migrate diff` mismatch and an inaccurate schema source of truth. **Run `supabase migrate diff --exit-code` against prod and resolve to zero.**

2. ~~**Action-retry replays nothing — `EXECUTOR_REGISTRY` is intentionally empty.**~~ **✅ RESOLVED 2026-06-09.**
   End-to-end auto-recovery is now wired (TDD, 20 unit tests):
   - `executeAction` (`execute.server.ts`) classifies a transient platform failure as `retrying` (attempts=1) instead of terminal `failed`, so it enters the queue; known-permanent errors (`ActionError` with `retriable:false`) and "not connected" still fail fast.
   - `EXECUTOR_REGISTRY` (`retry.server.ts`) is populated for the three executable campaign kinds (`pause_campaign`, `resume_campaign`, `reduce_campaign_budget`). The drain re-resolves the per-shop adapter, replays the action, and bookkeeps: success → `succeeded`; transient fail below cap → bump `attempts`, stay `retrying`; fail at `MAX_ATTEMPTS` → terminal `failed`. Non-campaign kinds (e.g. `snooze_alert`) are skipped untouched.
   - Merchant-facing routes (`campaigns._index`, `alerts.$id`) report `retrying` honestly ("queued, will retry automatically") rather than as success or failure.
   - Classification is default-transient (rule 5): adapters MAY set `ActionError.retriable=false` for known-permanent errors; none do yet, so a genuinely permanent platform error simply exhausts 5 attempts (~20 min) before terminally failing. Follow-up: have the Meta adapter set `retriable` from the Graph error code to fail permanent errors faster.

### 🟠 Should resolve

3. **`ad_spend_fact` upsert key is cross-shop-collision-prone.**
   Upsert uses `onConflict: "campaign_id,day"` (`google/ingest.server.ts:162`), matching the current unique index. If two shops share an external `campaign_id`, one shop's spend overwrites the other's. Confirm `campaign_id` is globally unique in practice, or widen the constraint+onConflict to `(shop_id, campaign_id, day)`.

4. **Action execution is Meta-only.**
   `setCampaignStatus` covers Meta. Google is ingestion-only (read); TikTok appears in prod schema (`tiktok_platform`) but no execution path was found in the repo. Confirm scope: are real clients expected to act on Google/TikTok campaigns at launch?

5. **`raw_google_poll` has RLS enabled with zero policies.**
   Harmless today (cron uses service-role, which bypasses RLS; no table forces RLS), but it's an incomplete-security smell. Either add the shop-scoped policy to match `raw_shopify_webhook`, or drop RLS on the table for honesty.

### 🟡 Verify / hygiene (per repo pre-commit gate)

6. **Run `/code-review` on the working tree** — CLAUDE.md mandates it for major commits; not yet run this session.
7. **`graphql-codegen`** — re-run if any `.graphql`/Admin query changed since last commit; commit regenerated types.
8. **Env parity** — prod `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set in Vercel (14d ago). Diff Vercel prod env against `.env.example` for any key added since (per "update `.env.example` when adding a key").
9. **GDPR purge-list transparency** — sweep relies on CASCADE; 10 shop-scoped tables (incl. `assistant_messages`, `mcp_tokens` — customer PII) aren't in the explicit list. A future FK change from CASCADE→RESTRICT would silently leave PII. Add a migration guard or list all tables for auditor transparency.

---

## Go-live checklist

- [ ] Reconcile migration drift; `supabase migrate diff` against prod = 0 (#1)
- [x] Action-retry auto-recovery wired end-to-end (#2) — 2026-06-09
- [ ] Confirm/fix `ad_spend_fact` conflict key (#3)
- [ ] Confirm launch action scope (Meta vs Google/TikTok) (#4)
- [ ] Resolve `raw_google_poll` RLS (#5)
- [ ] `/code-review` clean (#6)
- [ ] `graphql-codegen` current (#7)
- [ ] Vercel prod env ↔ `.env.example` parity (#8)
- [ ] Verify GDPR webhooks against a real uninstall in a sandbox shop
- [ ] Smoke-test one full cron cycle with a real (test) client store before opening to production traffic
