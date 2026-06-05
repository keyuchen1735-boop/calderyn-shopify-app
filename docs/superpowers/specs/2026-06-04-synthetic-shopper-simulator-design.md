# Synthetic Shopper Simulator — Design

**Date:** 2026-06-04
**Status:** Approved (design); pending implementation plan
**Route:** `/app/simulator`
**Owner:** John Duncan

## Summary

A new embedded-admin feature that runs a population of LLM-driven shopper personas
through the merchant's live store and reports a **funnel-first conversion teardown**
("290 of 470 shoppers abandoned at the shipping-cost reveal") — *before* the merchant
spends a dollar on ads.

The merchant moves a slider (10–1,000 shoppers) and clicks **Run**. ~30s later they see
where simulated shoppers fall out of the funnel, why, and what to fix.

## Goals

- Give ad-spending stores with no analyst a cheap, instant read on storefront friction.
- Population-scale numbers ("X of 1,000") that *feel* statistical, without a per-run API bill that scales with the slider.
- Reuse Calderyn's existing patterns: Polaris UI, Supabase persistence, the assistant's Anthropic client, async cron-style processing.

## Non-goals (v1)

- Real Playwright browser checkout (computed checkout only).
- Editable / user-authored personas.
- Multi-product or per-collection targeting (whole-store path only).
- Feeding findings into Alerts or the Assistant.
- A/B comparing two runs.

These are explicit future steps; the data model should not preclude them.

## Key decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Data source | **Live storefront pages** | Most realistic — personas react to the real store. |
| Funnel method | **Fetch pages + computed checkout** | Guests can't reach Shopify's shipping step without a live cart/session; compute it from real shipping rates. |
| Engine | **Two-tier Monte Carlo** | Claude builds a behavior model from ~8 deep persona sims; slider samples up to 1,000 virtual shoppers from it. Fixed LLM cost, instant slider. |
| Personas | **Store-tailored, Claude-generated** | ~8 archetypes fleshed out per store's vertical. |
| Results layout | **Funnel-first** | Drop-off chart is the hero; findings + per-persona table below. |
| Run model | **Async (queued → process → poll)** | Mirrors existing `cron.ingest` / `cron.detect`; avoids serverless timeouts. |

## Architecture

### Two-tier engine

```
Real pages ─► Claude builds behavior model ─► stored model (DB) ─► slider samples N
 (fetch)        (~1–3 calls, ~30s, per Run)                        (instant, in-browser)
```

- **Tier 1 — Claude simulation (runs only on Run):**
  - Fetch real page content: home, top-velocity product page (reuse tracked SKUs to pick it), cart.
  - Pull live shipping rates via Admin GraphQL `deliveryProfiles` to construct the computed checkout/shipping step.
  - One structured Claude call (the existing assistant Anthropic client) that:
    1. generates ~8 store-tailored shopper archetypes, and
    2. simulates each one walking the funnel, returning per-stage **drop probability** + **reason**, plus aggregated **findings** and **suggested fixes**.
  - Output is a JSON **behavior model** persisted to the run row.

- **Tier 2 — Monte Carlo sampling (runs on every slider change, client-side):**
  - Given the stored behavior model and N (slider), sample N virtual shoppers stage-by-stage using the per-stage probabilities, weighted across archetypes.
  - Produces the funnel counts and per-finding shopper counts shown in the UI.
  - Pure arithmetic in the browser → instant, free, no server round-trip. Use a fixed seed for reproducibility within a run.

### Funnel stages

`Landed → Viewed product → Added to cart → Started checkout → Shipping reveal → Bought`

The behavior model stores a transition probability (and reason) into each stage, per archetype.

## Data model

New Supabase table **`simulation_run`**:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `shop_id` | fk → shops | scoped like every other table |
| `status` | text | `queued` \| `running` \| `done` \| `error` |
| `target` | text | `"whole_store"` for v1 (forward-compatible with product/collection ids) |
| `requested_n` | int | slider value at run time (default 1,000) |
| `model` | jsonb | the Tier-1 behavior model: archetypes, per-stage probs+reasons, findings, fixes |
| `error` | text | populated on `status='error'` |
| `created_at` | timestamptz | |
| `completed_at` | timestamptz | |

A read view (e.g. `v_simulation_runs`) follows the existing `v_*_view` convention; the route never selects raw rows directly where a view is the norm.

DTOs shaped in `app/lib/simulator/` — never leak raw rows to the client (per CLAUDE.md).

## Code layout

```
app/lib/simulator/
  types.ts                  # BehaviorModel, Archetype, FunnelStage, Finding, SimulationRun DTOs
  fetch-pages.server.ts     # fetch home/product/cart, HTML→text; pull shipping rates (Admin GraphQL)
  simulate.server.ts        # build the Claude prompt, call Anthropic, parse → BehaviorModel
  sample.ts                 # Monte Carlo: (model, N, seed) → funnel counts + finding counts  [isomorphic, unit-tested]
  runs.server.ts            # CRUD against simulation_run / v_simulation_runs
  __tests__/                # sample.test.ts (deterministic), simulate parse tests

app/routes/
  app.simulator.tsx         # route: loader (latest run + history), action (enqueue run), client slider re-sample
  cron.simulate.tsx         # async processor: pick up queued runs, do Tier-1, write model, set done/error
```

- `sample.ts` is intentionally framework-free and runs both server- and client-side, so it can be unit-tested deterministically and also drive the live slider.
- Anthropic access goes through the existing `app/lib/assistant/anthropic.server.ts` client (no new SDK dependency).

## Data flow (a run)

1. Merchant sets slider, clicks **Run** → `action` inserts a `simulation_run` row (`status='queued'`, `requested_n`) and returns.
2. Action fire-and-forgets a trigger to `cron.simulate` (matching the existing ingest/detect async trigger pattern).
3. `cron.simulate` fetches pages + shipping rates, calls Claude, writes `model`, sets `status='done'` (or `error`).
4. The route polls (loader revalidation) until `status` leaves `queued`/`running`.
5. On `done`, the client computes the funnel for the current slider value via `sample.ts` and renders. Dragging the slider recomputes instantly with no server call.

## UI (funnel-first)

Polaris primitives, consistent with the dashboard. Single `Page`:

- **Controls row:** shopper slider (10–1,000) · target picker (only "Whole store" in v1) · **Run new simulation** button. Caption clarifies "drag = instant re-sample, no new run."
- **Run status line:** "Last run · 8 personas · 2m ago" or a progress indicator while `queued`/`running`.
- **Biggest-leak callout:** critical-tone banner naming the single largest drop.
- **Funnel hero:** horizontal bars per stage with absolute counts and deltas; the worst leak rendered in critical tone.
- **Friction findings:** ranked list (severity-colored), each with affected personas and a one-line suggested fix.
- **Per-persona table:** archetype · dropped-at stage · short reason.

## Error handling

- Every loader/action calls `authenticate.admin(request)` before data access.
- Page fetch failures (storefront unreachable, password-protected dev store) → run ends `error` with a human message; UI shows a Polaris `Banner`, not a crash.
- Missing `ANTHROPIC_API_KEY` → `error` status with a clear "AI key not configured" message (same key as the assistant).
- Claude returns malformed JSON → parse guarded; run `error`, surfaced, retryable.
- Admin GraphQL `deliveryProfiles` errors checked (no swallowed `userErrors`); if shipping rates are unavailable, fall back to a clearly-labeled estimated shipping step rather than failing the whole run.

## Testing

- **`sample.test.ts`** — deterministic Monte Carlo: same model + N + seed ⇒ same counts; probabilities respected at large N; edge N (10, 1,000).
- **simulate parse tests** — a recorded Claude response parses into a valid `BehaviorModel`; malformed payloads rejected cleanly.
- **fetch-pages** — HTML→text extraction on a fixture; Admin GraphQL error path handled.
- Follows the repo's existing `__tests__` colocated convention.

## Guardrails / rollout

- Requires `ANTHROPIC_API_KEY` in Vercel (shared with the in-app assistant — still pending).
- Per-run LLM cost is fixed (~1–3 calls) regardless of slider, by design.
- Schema change goes through `prisma migrate dev` / Supabase migration; new GraphQL for `deliveryProfiles` runs through `graphql-codegen`.
- Pre-commit gate (CLAUDE.md): `/code-review`, typecheck, lint, build, prisma validate, codegen — all green before commit.

## Open follow-ups (post-v1)

- Real Playwright checkout walkthrough (swap in behind the same `BehaviorModel` interface).
- Per-product / per-collection targeting.
- Editable personas.
- Feed findings into Alerts and let the Assistant explain a teardown.
- Run-over-run comparison.
