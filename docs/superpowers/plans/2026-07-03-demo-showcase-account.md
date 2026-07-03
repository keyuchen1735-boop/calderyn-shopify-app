# Demo Showcase Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared demo login (john@calderyncompany.com) backed by a fully seeded, resettable "Peak & Pine Outfitters" first-party shop with a live storefront, so any founder can screen-share a complete Calderyn session.

**Architecture:** Reuse the existing deterministic seed (`app/lib/seed/dataset.ts` + `writer.ts`) and the `promote_shop_from_mirror` RPC; add a pure "showcase layer" generator (owned orders/buyers, alerts+evidence, calibration baseline, branding) and a `resetDemoShowcase()` orchestrator called by both a one-time setup script and a demo_mode-gated dashboard API route with a Settings button.

**Tech Stack:** Remix resource routes, supabase-js service client, vitest, vite-node scripts.

## Global Constraints

- TypeScript strict; no `any` without justification; `tsc --noEmit` authoritative.
- Dashboard surface only (no `app/routes/app.*` changes) — dashboard-only by design, embedded has no first-party login.
- No browser-visible provenance/dev markers; `npm run build` runs `scripts/verify-client-bundle.mjs`.
- Secrets → `.env.local` only (`DEMO_ACCOUNT_PASSWORD`).
- No new dependencies.
- Pre-commit gate before commit: `/code-review`, `git diff --check`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

### Task 1: Worktree

- [ ] `git worktree add ../calderyn-demo-showcase -b feat/demo-showcase origin/main` and work there. Copy `.env.local` reference NOT needed (scripts source it from repo root path at run time; run setup script from main checkout after merge, or pass env explicitly).

### Task 2: Enrich `SkuRow` so promoted variants are sellable

**Files:** Modify `app/lib/seed/types.ts`, `app/lib/seed/dataset.ts`; Test `app/lib/seed/__tests__/dataset.test.ts` (extend existing).

**Produces:** `SkuRow` gains `retail_price_cents: number`, `product_status: "active"`, `inventory_policy: "deny"`, `inventory_tracked: true`, `grams: number`. Generator fills them from each `ProductSpec` (`priceCents`, weight heuristic by category).

- [ ] Failing test: every generated sku has `retail_price_cents === listPriceCentsBySkuId[id]`, `product_status === "active"`, `inventory_tracked === true`.
- [ ] Implement; run `npx vitest run app/lib/seed` → PASS. Existing writer needs no change (inserts whole row objects).
- [ ] Commit `seed: carry retail price + status on sku_dim rows so promote yields sellable variants`.

### Task 3: Pure showcase-layer generator

**Files:** Create `app/lib/demo/showcase-seed.ts`, `app/lib/demo/__tests__/showcase-seed.test.ts`.

**Interfaces — Produces:**
```ts
export interface ShowcaseLayer {
  buyers: Record<string, unknown>[];            // buyer_dim
  buyerAddresses: Record<string, unknown>[];    // buyer_address
  ownedOrders: Record<string, unknown>[];       // orders (state 'paid')
  ownedOrderLines: Record<string, unknown>[];   // order_line
  orderTransitions: Record<string, unknown>[];  // order_state_transition
  alerts: Record<string, unknown>[];            // alerts (status 'open')
  alertContexts: Record<string, unknown>[];     // alert_context
  pairCalibration: Record<string, unknown>[];   // pair_calibration
  auditRows: Record<string, unknown>[];         // action_audit (historical, succeeded)
  storeSettings: Record<string, unknown>;       // store_settings upsert
  variantShipping: Record<string, unknown>[];   // variant_shipping (per variant)
  guardrailPatch: Record<string, unknown>;      // guardrail_config update (autopilot_enabled:false …)
  shopPatch: Record<string, unknown>;           // shops update (calibration_pct baseline …)
}
export function generateShowcaseLayer(cfg: { shopId: string; today: string; dataset: SeedDataset; rngSeed?: number }): ShowcaseLayer;
```

Content rules:
- ~28 buyers, name pool + `@example.com`-style emails; each owned order links `buyer_id`, `variant_id` from `dataset.skus` (ids preserved by promote), `unit_price_cents` = list price; states `paid` with matching `order_state_transition` rows; created over last 45 days.
- Alerts: one per scenario ref (stockout hero tee, margin duffel, returns windbreaker, negative-econ bottle, regional poles, reorder hoodie, fulfillment-risk pack, wrong-location shell) + 1–2 campaign-level (roas). `entity_ref`/`evidence` shapes copied from real prod rows per detector (captured as fixtures during implementation — step below).
- pair_calibration: 2 pairs `graduated:true, autonomy_enabled:true`; 2 pairs alpha within 2 approvals of `graduation_threshold`; rest early. `shopPatch.calibration_pct = 31`.
- audit history: 6 rows over past week, mix autopilot/merchant actors, `outcome:'succeeded'`, linked to resolved alerts (also emitted, status `resolved`).

- [ ] Capture evidence fixtures: query prod `alert_context.evidence` + `alerts.entity_ref` for one row per detector_id on the existing demo shops; encode in `showcase-seed.ts` as templates with ids swapped to dataset scenario ids.
- [ ] Failing tests: determinism (same cfg → same output), FK integrity (order lines→seeded variants & orders; alerts→context 1:1; audit→alert ids exist), graduated-pair count === 2, all owned orders within 45d of `today`.
- [ ] Implement; `npx vitest run app/lib/demo` → PASS. Commit `demo: pure showcase layer generator (owned orders, alerts, calibration baseline)`.

### Task 4: Reset orchestrator

**Files:** Create `app/lib/demo/reset.server.ts`, `app/lib/demo/__tests__/reset.server.test.ts`.

**Interfaces — Produces:**
```ts
export const SHOWCASE_WIPE_ORDER: readonly string[]; // extended child→parent list (spec §wipe surface)
export interface ResetSummary { wiped: string[]; inserted: Record<string, number>; }
export async function resetDemoShowcase(shopId: string, sb: SupabaseLike): Promise<ResetSummary>;
```

Flow: read `shops.demo_mode` → throw `CalderynError("not_demo_shop")` unless true → delete pass over `SHOWCASE_WIPE_ORDER` → `writeSeedDataset(generateSeedDataset(...))` → `sb.rpc("promote_shop_from_mirror", { p_shop_id })` → insert showcase layer (500-row batches, parents→children: buyers → orders → lines/transitions; alerts → contexts; etc.) → upsert store_settings → update guardrail_config + shops. Abort on first error.

- [ ] Failing tests w/ in-memory fake client (pattern: `app/lib/seed/__tests__` + `app/lib/buyer/account.server.test.ts`): refuses non-demo shop before any delete; wipe hits every extended table child-before-parent; happy path returns summary incl. showcase tables.
- [ ] Implement; `npx vitest run app/lib/demo` → PASS. Commit `demo: resetDemoShowcase orchestrator with demo_mode hard gate`.

### Task 5: API route

**Files:** Create `app/routes/dashboard.api.demo-reset.tsx`; Test `app/lib/dashboard/__tests__/api-write-routes.test.ts` (extend — it already covers demo_mode-adjacent routes).

```tsx
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  await rateLimit(`demo-reset:${session.shopId}`, 1, 60);
  return dashboardJson(async () => {
    const summary = await resetDemoShowcase(session.shopId, getSupabase());
    return { ok: true, summary };
  });
}
```

- [ ] Test: 405 on GET, `not_demo_shop` mapping (422/409 per CalderynError), success returns summary. `npx vitest run app/lib/dashboard` → PASS. Commit.

### Task 6: Settings card + context threading

**Files:** Modify `app/routes/dashboard.$.tsx:60-69` (select `demo_mode`, return `demoMode`), `app/components/dashboard/DashboardApp.tsx:182` (accept + expose via ctx), `app/components/dashboard/context.ts` (add `demoMode: boolean`), `app/lib/dashboard/client.ts` (add `resetDemoData()` → `apiSend("/dashboard/api/demo-reset", "POST")`), `app/components/dashboard/screens/Settings.tsx` (Demo card).

Settings card (General tab, after Learned rules fold, only when `app.demoMode`): title "Demo store", description "Wipes this demo store and reseeds it to the opening scene — fresh queue, baseline calibration, autopilot off."; button "Reset demo data" with two-step confirm (arm → confirm within 5s, matching existing destructive-control tone), busy state, success toast `Demo reset — N tables reseeded`, then `app.refresh()`.

- [ ] Extend `app/routes/__tests__/dashboard-index-loader.test.ts` for `demoMode` in loader payload (true/false).
- [ ] Implement; screens test suites still green: `npx vitest run app/components/dashboard app/routes` → PASS. Commit.

### Task 7: Setup script

**Files:** Create `scripts/setup-demo-account.ts` (vite-node, same invocation banner as seed-demo.ts).

Idempotent: find-or-create user (`createUser` from `app/lib/auth/users.server`, password from `DEMO_ACCOUNT_PASSWORD` env — required, script refuses to run without it) → `markEmailVerified` → find-or-create shop by `org_slug='peakandpine'` (create via `provisionOwnedShop("Peak & Pine Outfitters")` then update org_slug) → `linkMembership(owner)` (ignore unique-violation) → update shops `{demo_mode:true, org_mode:'live', onboarding_step:'complete', onboarding_completed_at:now}` → `resetDemoShowcase(shopId, sb)` → print login/storefront URLs + summary.

- [ ] Typecheck-only for the script (covered by `npm run typecheck`); logic already unit-tested in Task 4. Commit.

### Task 8: Gate + commit

- [ ] `/code-review` on the working tree; resolve blockers.
- [ ] `git diff --check`; scan diff for stray console.log/TODO(me)/provenance.
- [ ] `npm run typecheck` → 0; `npm run lint` → 0; `npm run build` → 0. Paste outputs.
- [ ] Commit remaining changes; merge feat/demo-showcase → main locally per repo convention (no push without ask).

### Task 9: Provision + live verification (prod — testing-on-prod is this repo's norm)

- [ ] Add `DEMO_ACCOUNT_PASSWORD` to `.env.local`.
- [ ] Run setup script (from worktree with repo-root `.env.local` sourced). Verify pepper parity: `curl -i https://app.calderyncompany.com/dashboard/signin` login POST → 302 + `__Host-calderyn_dash` cookie. If mismatch: `vercel env pull` to compare `PASSWORD_PEPPER` and re-hash.
- [ ] `vercel domains add peakandpine.calderyncompany.com` (project shopify-app). Curl storefront → 200 with Peak & Pine products.
- [ ] Authenticated-session smoke via curl: `/dashboard/api/queue` non-empty; approve one → calibration delta visible via `/dashboard/api/calibration`; toggle autopilot on via guardrails API; POST `/dashboard/api/autopilot` → audit rows appear; POST `/dashboard/api/demo-reset` → summary; queue full again, autopilot off.
- [ ] (Stretch) Product photos: generate 12 via Higgsfield, upload to media bucket, extend showcase layer `product_media` rows with `external_url`/storage paths; reset re-links only.

## Self-review

Spec coverage: login (T7), seeded shop + storefront (T2/T4/T9), queue approve/deny (T3 alerts+evidence), calibration rise (T3 baseline + near-graduation pairs), autopilot demo (T3 graduated pairs + guardrailPatch off), create product (owned editor already exists; reset wipes via product_dim), customers (T3 buyers/orders), reset button (T5/T6), gating (T4 hard gate + T5 route gate). Types consistent: `ShowcaseLayer`, `resetDemoShowcase`, `ResetSummary`, `demoMode` used identically across tasks. No placeholders — evidence fixtures are an explicit capture step, not a TBD.
