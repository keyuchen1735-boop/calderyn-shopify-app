# Ask Calderyn assistant — fast-follow actions (finish-out) plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Complete the assistant's action surface by adding the deferred fast-follow registry entries that are clean (no new transport, no paid-AI generation, not the Shopify-legacy surface): purchase-order drafts, queue rejection, ship-cost settings, storefront experiments, and location editing.

**Architecture:** Same central action-registry pattern already shipped in `app/lib/assistant/actions/` (PR #405). Each new capability is an `AssistantAction` entry calling the same `app/lib` server function the dashboard route uses. Two tiny server-fn extractions remove route-inline logic so the assistant and the route share one source of truth.

**Tech Stack:** TypeScript strict, Remix, `@anthropic-ai/sdk`, Supabase, Vitest.

## Global Constraints

- Worktree `c:\Users\famou\Desktop\calderyn-assistant-finish`, branch `feat/assistant-fastfollows` (off merged main, base 4d52be1b). All paths relative to it.
- TypeScript strict; no `any` without written justification; `npm run typecheck` (tsc --noEmit) authoritative.
- Shop id always from `ctx.shopId` (the session value), never from model input. Money in cents on the wire, dollars in merchant-facing copy.
- Every action calls the SAME server fn the mirroring dashboard route uses; do not duplicate validation that a shared fn already owns.
- Tier "execute" = reversible/low-blast runs immediately; "confirm" = live-facing/irreversible parks a pending action. New confirm-tier entries MUST have a `confirmSummary` (registry-invariants enforces).
- No browser-visible AI/provenance markers. No new deps.
- Test command: `npx vitest run <file>` from worktree root. Commit after each green task, subject prefix `assistant/<area>:`.
- Follow the existing domain modules as references: `app/lib/assistant/actions/campaign-actions.server.ts` (module shape, `str`/`posInt` helpers, receipt/throw-on-failure convention) and `catalog-actions.server.ts` (storefront + confirm-tier with confirmSummary). Their test files show the mocking style.

## Deliberately excluded (record, do not silently drop)

- `pick_discover_product` — `pickProduct` unconditionally calls `generateStore` (a paid AI generation); grouped with the generation tools the owner chose to skip.
- alert-path `adjust_price` — subsumed by the shipped `set_variant_price` (cap-bounded, owned catalog).
- `relocate_inventory` — subsumed by the shipped `create_transfer`.
- `discontinue_sku` — Shopify-legacy write surface; owner chose to skip.
- `generate_store`, `regenerate_creative`, `screen_creative` — paid-AI generation; owner chose to skip.
- Media upload/delete — needs a chat file channel; owner deferred.

---

### Task 1: Server-fn extractions + route refactors

Two dashboard routes do a write inline with no shared fn. Extract each so the assistant action and the route call one function (prevents drift; the reviewers repeatedly flagged route-inline logic the assistant would otherwise duplicate).

**Files:**
- Modify: `app/lib/ship-cost/inputs.server.ts` (add `setShipCostMode`)
- Modify: `app/routes/dashboard.api.ship-cost.tsx` (set_mode branch calls it)
- Create: `app/lib/catalog/locations.server.ts` (`updateLocationDetails`)
- Modify: `app/routes/dashboard.api.catalog.locations.$id.tsx` (PUT calls it)
- Test: `app/lib/ship-cost/__tests__/inputs.test.ts` (extend if exists, else create), `app/lib/catalog/__tests__/locations.test.ts`

**Interfaces produced:**
- `setShipCostMode(sb: SupabaseClient, shopId: string, mode: ShipCostMode): Promise<void>` where `ShipCostMode = "auto" | "force_measured" | "force_reconciled"`.
- `LocationPatch = { priority?: number; lat?: number | null; lng?: number | null; street1?: string; street2?: string; city?: string; region?: string; postal_code?: string; country?: string }` and `updateLocationDetails(sb: SupabaseClient, shopId: string, locationId: string, patch: LocationPatch): Promise<void>` (throws on Supabase error; shop-scoped `.eq("shop_id", shopId).eq("id", locationId)`).

- [ ] **Step 1: Write failing tests.** For `setShipCostMode`: mock supabase, assert it upserts `{ shop_id, ship_cost_mode: mode, updated_at }` into `shop_settings`. For `updateLocationDetails`: assert it updates `location_dim` filtered by both shop_id and id with exactly the passed patch, and throws when supabase returns an error.

- [ ] **Step 2: Run to verify FAIL.** `npx vitest run app/lib/ship-cost app/lib/catalog/__tests__/locations.test.ts`

- [ ] **Step 3: Implement.**
  - In `inputs.server.ts` add and export `setShipCostMode`, moving the exact upsert from the route's `set_mode` branch (`sb.from("shop_settings").upsert({ shop_id: shopId, ship_cost_mode: mode, updated_at: new Date().toISOString() })`). Export `ShipCostMode` (or reuse the route's `MODES` source of truth — if the route defines `MODES` inline, move it beside the fn and have the route import it).
  - Create `app/lib/catalog/locations.server.ts` with `LocationPatch` + `updateLocationDetails`, doing the same shop+id-scoped `location_dim` update the route does.
  - Refactor both routes to build their validated patch/mode exactly as now, then delegate the write to the new fn. Keep all route-level validation (field parsing, `empty_patch`, `invalid_mode`) in the route — only the write moves.

- [ ] **Step 4: Run to verify PASS**, and run the routes' existing tests if any (`npx vitest run app/lib/ship-cost app/lib/catalog app/routes/__tests__` — the ship-cost/location route tests, if present, must stay green). `npx tsc --noEmit` exit 0.

- [ ] **Step 5: Commit** — `assistant/prep: extract setShipCostMode + updateLocationDetails for shared reuse`

---

### Task 2: Alerts/queue domain — create_po_draft + reject_queue_action

**Files:**
- Create: `app/lib/assistant/actions/alerts-actions.server.ts`
- Modify: `app/lib/assistant/actions/registry.server.ts` (import + spread `ALERTS_ACTIONS`)
- Test: `app/lib/assistant/actions/__tests__/alerts-actions.test.ts`

**Consumes (verify each by reading the file):**
- `executeCreatePoDraft(opts)` — `app/lib/actions/po-action.server.ts:32`. `opts = { client, sb, shopId, shopDomain, alertId, idempotencyKey, quantity: string, unitCost: string, signal? }`. `client = calderynClient(ctx.shopId)` (has `.alerts.get` + `.actions.execute`; PO drafts need no Shopify admin). Returns `{ auditId, outcome, acknowledged }`. It self-validates (alert open, detector allows create_po_draft, quantity `/^\d+$/` >0 ≤1e6, unitCost finite ≥0 or blank, SKU present/not-discontinued) and throws CalderynError on each — let those propagate.
- `calderynClient(shopId).calibration.recordRejection(input)` — `app/lib/calderyn.server.ts:1455`. `input = { alertId, detectorId, actionKind, reason: RejectReason, note?, dollarImpactCents }`. `RejectReason = "too_aggressive"|"wrong_timing"|"not_enough_data"|"i_handle_this"|"other"`. detectorId/actionKind/dollarImpactCents are RE-DERIVED from the fetched alert, never from input (mirror the route).
- `recommendedAction(detectorId, { hasCampaign })` — `app/lib/labels`. `muteConfirmationMessage(detectorId, actionKind)` — `app/lib/calibration/mute-guard`.

**Produces `ALERTS_ACTIONS`:**
- `create_po_draft` (tier execute, undoable false): inputs `alert_id` (required), `quantity` (required positive integer), `unit_cost_cents?` (optional non-negative integer). Convert: `quantity → String(quantity)`, `unit_cost_cents → String(unit_cost_cents/100)` (the fn wants a dollar string; blank when omitted). run builds `calderynClient(ctx.shopId)`, calls executeCreatePoDraft with `shopDomain: ctx.shopId` (the assistant has no separate domain; the fn uses it only for logging/PO metadata), `idempotencyKey: ctx.idempotencyKey`, `signal: undefined`. On `outcome !== "succeeded"` throw. Receipt summary `Drafted a purchase order`, detail `{ audit_id }`, auditId from result.
- `reject_queue_action` (tier execute, undoable false): inputs `alert_id` (required), `reason` (required enum of the 5 values), `note?` (≤300), `confirm?` (boolean). run: `client = calderynClient(ctx.shopId)`; `alert = await client.alerts.get(alert_id)`; `detectorId = alert.detector_id`; `actionKind = recommendedAction(detectorId, { hasCampaign: Boolean(alert.campaign_id) })`; if no actionKind throw "no recommended action to reject". **Mute guard:** if `reason === "i_handle_this"` and `confirm !== true`, call `muteConfirmationMessage(detectorId, actionKind)`; if it returns a non-null warning, throw an Error carrying that warning (the model relays it; merchant re-asks with confirm). Else call `client.calibration.recordRejection({ alertId: alert_id, detectorId, actionKind, reason, note, dollarImpactCents: alert.dollar_impact })`. Receipt summary `Rejected the suggestion and recorded why`, undoable false.

- [ ] **Step 1: Write failing tests** — mock `~/lib/actions/po-action.server`, `~/lib/calderyn.server` (calderynClient returning `{ alerts: { get }, calibration: { recordRejection } }`), `~/lib/labels` (recommendedAction), `~/lib/calibration/mute-guard`, `~/lib/supabase.server`. Cover: create_po_draft passes idempotencyKey + stringified quantity/unitCost and throws on non-succeeded outcome; create_po_draft rejects a non-integer/`≤0` quantity in validate(); reject_queue_action re-derives detector/actionKind from the alert (asserts recordRejection called with the derived values, not body-supplied); reject_queue_action with reason `i_handle_this` and no confirm throws the mute warning (recordRejection NOT called); same with `confirm:true` proceeds; an invalid reason is rejected in validate().
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `alerts-actions.server.ts` (module shape per campaign-actions), register `...ALERTS_ACTIONS`.
- [ ] **Step 4: Run to verify PASS**; `npx tsc --noEmit` 0; `npx eslint app/lib/assistant/actions --ext .ts` clean.
- [ ] **Step 5: Commit** — `assistant/actions: alerts domain (create_po_draft + reject_queue_action)`

---

### Task 3: Ship-cost + location actions

**Files:**
- Modify: `app/lib/assistant/actions/ops-actions.server.ts` (add ship-cost entries)
- Modify: `app/lib/assistant/actions/catalog-actions.server.ts` (add `set_location_details`)
- Modify: `app/lib/assistant/actions/registry.server.ts` (no new import if added to existing arrays; verify the new entries are inside the exported arrays)
- Test: extend `app/lib/assistant/actions/__tests__/ops-actions.test.ts` and `catalog-actions.test.ts`

**Consumes:** `setShipCostMode` (Task 1), `saveTypedPeriodTotal(sb, shopId, { totalCents, carrier, periodStart, periodEnd, shopCountry: null })` and `setManualOverride(sb, shopId, { orderId, cents, shopCountry: null })` (`app/lib/ship-cost/inputs.server.ts:17/117`), `updateLocationDetails` (Task 1), `getSupabase`.

**Produces (all tier execute, undoable false):**
- `set_ship_cost_mode` (ops): input `mode` enum `["auto","force_measured","force_reconciled"]` → `setShipCostMode(getSupabase(), ctx.shopId, mode)`.
- `add_ship_cost_period` (ops): inputs `amount_cents` (required positive int), `period_start` (required non-empty string date), `period_end` (required), `carrier?` → `saveTypedPeriodTotal(getSupabase(), ctx.shopId, { totalCents: amount_cents, carrier: carrier ?? null, periodStart, periodEnd, shopCountry: null })`. (Amount already in cents from the tool; the route multiplies dollars×100 but the tool takes cents directly — pass through.)
- `set_order_ship_cost_override` (ops): inputs `order_id` (required), `amount_cents` (optional non-negative int; omit/null clears) → `setManualOverride(getSupabase(), ctx.shopId, { orderId, cents: amount_cents ?? null, shopCountry: null })`.
- `set_location_details` (catalog): inputs `location_id` (required) plus optional `priority` (int), `lat` (number|null), `lng` (number|null), `street1`,`street2`,`city`,`region`,`postal_code`,`country` (strings). validate: require location_id and at least one patch field (else "no fields to update"); build a `LocationPatch` from only the present fields → `updateLocationDetails(getSupabase(), ctx.shopId, location_id, patch)`. Receipt summary `Updated the location`.

Descriptions must tell the model: order ids come from order reads, location ids from catalog/locations reads, amounts are cents, periods are ISO dates.

- [ ] **Step 1: Write failing tests** — mock the ship-cost + locations server fns and supabase. Assert each action calls its fn with the mapped args; `add_ship_cost_period` rejects non-positive `amount_cents`; `set_order_ship_cost_override` with omitted amount passes `cents: null`; `set_location_details` rejects when no patch field present and builds a partial patch from only provided fields.
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement**, register into the existing `OPS_ACTIONS` / `CATALOG_ACTIONS` arrays.
- [ ] **Step 4: Run to verify PASS**; tsc 0; eslint clean.
- [ ] **Step 5: Commit** — `assistant/actions: ship-cost settings + location editing`

---

### Task 4: Storefront experiments

**Files:**
- Modify: `app/lib/assistant/actions/catalog-actions.server.ts` (storefront domain already lives here)
- Test: extend `app/lib/assistant/actions/__tests__/catalog-actions.test.ts`

**Consumes:** `startExperiment(shopId, { kind, name? })` and `decideExperiment(shopId, experimentId, decision)` — `app/lib/experiments/store-experiment.server.ts:201/482`. `kind ∈ "headline"|"vibe"`; `decision ∈ "ship"|"keep"|"stop"`. Only `ship` mutates the live store (publishes the challenger). Both throw CalderynError on demo shop / not-running / not-found — let propagate.

**Produces:**
- `start_experiment` (tier execute): inputs `kind` enum `["headline","vibe"]`, `name?` (≤80). run → `startExperiment(ctx.shopId, { kind, name })`. Summary `Started a {kind} experiment`.
- `decide_experiment` (tier execute): inputs `experiment_id` (required), `decision` enum `["keep","stop"]` ONLY (ship is a separate confirm tool so the live publish can't ride the execute path). run → `decideExperiment(ctx.shopId, experiment_id, decision)`. Summary `Closed the experiment ({decision})`.
- `ship_experiment` (tier confirm): input `experiment_id` (required). confirmSummary `Ship the winning variant — publishes it live to your storefront`. run → `decideExperiment(ctx.shopId, experiment_id, "ship")`. undoable false.

- [ ] **Step 1: Write failing tests** — mock `~/lib/experiments/store-experiment.server`. Assert start passes `{kind,name}`; decide_experiment rejects `decision:"ship"` in validate() (only keep/stop allowed); ship_experiment is tier confirm with a confirmSummary mentioning "live"/"publish" and its run calls decideExperiment with `"ship"`.
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement**, register into `CATALOG_ACTIONS`.
- [ ] **Step 4: Run to verify PASS**; tsc 0; eslint clean.
- [ ] **Step 5: Commit** — `assistant/actions: storefront experiments (start/decide/ship)`

---

### Task 5: Prompt touch-up, invariants, gate + review

**Files:**
- Modify: `app/lib/assistant/prompt.server.ts` (only if needed — see step 1)
- Verify: `app/lib/assistant/actions/__tests__/registry-invariants.test.ts` still passes (it counts dynamically, so new entries need no edit; but confirm ship_experiment's confirmSummary satisfies the confirm-tier invariant).

- [ ] **Step 1:** Read the current system prompt's "Taking actions" section. It already enumerates "campaigns, prices, stock, storefront, alerts, autopilot, settings" — confirm PO drafts, experiments, ship-cost, and location edits are covered by those umbrellas. If any new capability clearly falls outside the listed umbrellas, add it to the list in one phrase; otherwise leave the prompt unchanged and note why. Do NOT expand the prompt gratuitously.
- [ ] **Step 2:** `npx vitest run app/lib/assistant` — all pass, including registry-invariants (confirm-tier count now includes `ship_experiment`).
- [ ] **Step 3:** Full gate: `npm run typecheck` 0; `npm run lint` 0 (no new warnings on touched files); `npm run build` 0 (incl. verify-client-bundle); `npx vitest run` full suite. Paste results.
- [ ] **Step 4:** Commit any prompt change — `assistant/prompt: note new capabilities` (skip if unchanged).
- [ ] **Step 5:** Whole-branch review (handled by orchestrator).

## Verification note

No new DB migration (all consumed tables exist). No new env keys. Prod runtime blocker unchanged (Anthropic credits). Demo/showcase shops keep working via existing routing in the consumed executors.
