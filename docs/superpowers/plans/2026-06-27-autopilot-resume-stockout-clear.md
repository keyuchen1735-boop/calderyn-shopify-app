# Plan: Autopilot trust UX Slice B — auto-resume on stockout-clear

Date: 2026-06-27
Spec: `docs/superpowers/specs/2026-06-26-autopilot-trust-ux-design.md` (Slice B)
Status: in build. Cross-stack (Python engine + this TS repo). Touches the
autonomous-money path (resuming a campaign restarts spend) — every step is
fail-safe and graduation-gated.

## Product decisions (confirmed with user 2026-06-27)

1. **Which campaigns** — resume ONLY campaigns Calderyn itself auto-paused for
   `sku_stockout_vs_spend`. Never a campaign the merchant paused, never one paused
   for another reason. (Safest; only un-does Calderyn's own stockout pause.)
2. **What counts as restocked** — stock must cover a BUFFER (>= `BUFFER_DAYS` of
   selling velocity, with a small absolute floor), not just 1 unit — so the
   campaign does not resume and immediately re-pause (no flip-flop).

## Mechanism already in place (do not rebuild)

- `resume_campaign` has a real executor (`adapter.resume`, `execute.server.ts`)
  and a working undo branch (status-flip restore, `undo.server.ts`), and is in
  `GRADUATABLE` + `HAS_EXECUTOR` + `HAS_UNDO_BRANCH`. It is currently DORMANT:
  no detector maps to it and no autopilot branch fires it.
- Slice C gate (`isGraduated` in `graduation.server.ts`) =
  `verdict.graduated && autonomy_enabled`. So a new `resume_campaign` pair is
  automatically suggestion-only until it earns graduation AND the merchant opts
  in. No re-wiring of the warm-up flow is needed.
- `v_autopilot_candidates` joins `ad_campaign_dim` on
  `alerts.entity_ref->>'campaign_id'` and gates on a `detector_id IN (...)`
  allow-list. So the new alert must carry `campaign_id` in `entity_ref` and the
  detector id must be added to that allow-list.

## The contract (engine ⇄ TS)

New detector id: **`sku_stockout_cleared`**.

- `entity_ref`: `{ "campaign_id": <uuid str>, "sku_id": <uuid str>, "sku": <code> }`
  (campaign_id REQUIRED so the candidate view resolves the campaign).
- `evidence`:
  - `stock_units` — current total on-hand across locations
  - `buffer_units` — the computed restock buffer it cleared
  - `velocity_units_per_day` — selling rate used for the buffer
  - `prepause_spend_7d_usd` — the campaign's representative pre-pause 7d spend
    (used by the autopilot guardrail so the min-spend gate is not defeated by the
    paused campaign's near-zero recent spend)
  - `sku_title`, `paused_at` (the stockout pause timestamp)
- `dollar_impact`: recovered profit estimate (velocity * unit_margin over a short
  horizon) — modest, informative; falls back to prepause spend lower bound.

## Engine work (Python — `engine/calderyn_engine/`)

New file `detectors/sku_stockout_cleared.py`, `@register("sku_stockout_cleared")`.

Fires one alert per (campaign, sku) where ALL hold:
1. There is a `pause_campaign` row in `action_audit` with `outcome='succeeded'`,
   `actor_user_id='autopilot'`, whose linked `alerts.detector_id =
   'sku_stockout_vs_spend'`. `params->>'campaign_id'` = the campaign; the alert's
   `entity_ref->>'sku_id'` = the SKU. (fork #1)
2. The campaign is STILL paused: `ad_campaign_dim.status` is an inactive value,
   AND there is no later `action_audit` row for that campaign after the stockout
   pause (so a merchant re-pause / takeover is never overridden). (fork #1)
3. The SKU is restocked above buffer: `sum(inventory_level_fact.available)` (latest
   per location, within the freshness window) `>= buffer_units`, where
   `buffer_units = max(MIN_RESTOCK_UNITS, ceil(velocity_units_per_day *
   BUFFER_DAYS))`. velocity from `sku_velocity` (window_days=1); if velocity is
   unknown, fall back to the velocity stored on the originating stockout alert's
   evidence, else `MIN_RESTOCK_UNITS`. (fork #2)

Constants (named, documented): `BUFFER_DAYS = 3`, `MIN_RESTOCK_UNITS = 5`.

Register the module import in `pipeline.py` so `@register` fires.
Tests mirror `engine/tests/` patterns (unit the pure buffer/eligibility helper;
integration with the pg pool fixture if a query test is warranted).

## Migration (this repo)

`supabase/migrations/<ts>_autopilot_candidates_resume.sql`: `create or replace
view public.v_autopilot_candidates` adding `'sku_stockout_cleared'` to the
`detector_id IN (...)` list — body otherwise verbatim from
`20260626220000_...`. Mirror into `tests/engine/schema/migrations/` so engine
tests see the same view. No `alerts.detector_id` constraint exists (text), so no
other DDL.

## TS labels / types (`app/lib/`)

- `types.ts`: add `sku_stockout_cleared` to `DetectorId`.
- `labels.ts` (TS will force the exhaustive Records):
  - `DETECTOR_LABELS`: "Back in stock — ads can resume"
  - `DETECTOR_TERMS`: "Stockout cleared"
  - `DETECTOR_TO_ACTIONS`: `["resume_campaign", "snooze_alert"]`
  - `FEATURE_LABELS["sku_stockout_cleared:resume_campaign"]`: "Resume ads when a
    sold-out product is back in stock"
  - `EVIDENCE_LABELS`: `stock_units`, `buffer_units`, `prepause_spend_7d_usd`,
    `paused_at` plain labels.
- `resume_campaign` is NOT added to `NO_BRAINER` (it must EARN graduation —
  spec: "only once the pair has earned trust").

## TS preconditions (`app/lib/calibration/preconditions.server.ts`)

- Extend `preconditionFresh` with a `resume_campaign` case: the campaign must be
  INACTIVE (currently paused) and facts fresh — the mirror of the pause case.
- New `stockoutClearedResumeAllowed` (mirror of `stockoutPauseAllowed`, I10):
  returns ok:true ONLY when, re-checked live: the alert carries campaign_id +
  sku_id; the campaign is currently paused; its most recent `action_audit` row is
  Calderyn's stockout `pause_campaign` (no later action); and the SKU's latest
  stock observation is fresh AND `>= buffer_units` carried in the alert evidence.
  Fail-safe: any missing datum or DB error → ok:false (skip → stays queued).

## TS autopilot branch (`app/lib/actions/autopilot.server.ts`)

- Add `const RESUME_DETECTORS = new Set(["sku_stockout_cleared"]);`
- After the `tryInventoryRelocation` / `tryRemediation` fall-through and the
  existing kind resolution, add `else if (RESUME_DETECTORS.has(c.detector_id))
  kind = "resume_campaign";`.
- Ordering: process loss-prevention (defensive pause/reduce/realloc) BEFORE
  resume, and resume before scale-ups — resume restarts spend, so it must never
  starve loss-prevention of the daily action cap. Make the ordering 3-tier:
  defensive (`!SCALE && !RESUME`), then resume, then scale.
- Gate identically to other autonomous kinds:
  - campaign_id present (resume needs a campaign).
  - `isGraduated(shop, detector, "resume_campaign", sb)` (graduated +
    autonomy_enabled). Not graduated → `decide skipped "pair not graduated"`.
  - `loadAndApplyRules` veto (merchant restrictions / business hours / mute).
  - `checkGuardrails({ kind: "resume_campaign", campaignId, dollarImpactCents,
    campaignSpendCents: max(liveSpend, prepauseSpendCents), ... }, { autonomous })`.
    Passing the pre-pause spend keeps the min-spend gate meaningful instead of
    false-blocking a paused campaign.
  - `preconditionFresh({ kind: "resume_campaign", ... })` AND
    `stockoutClearedResumeAllowed({...})` — both must pass.
  - `executeAction({ kind: "resume_campaign", campaignId, idempotencyKey:
    autopilot:{alert}:resume_campaign, actor: "autopilot", triggerReason })`.
  - notify on success (`Resumed campaign ...`).
- Flip-flop safety: once resumed the campaign is active → the detector's
  condition (still-paused) is false → it never re-fires. idempotencyKey prevents
  a double-resume within a run.

## Calibration surfacing + dashboard parity

- Queue: `recommendedAction("sku_stockout_cleared", {hasCampaign:true})` →
  `resume_campaign` (first real, campaign-applicable, not plan-only). Until the
  pair is graduated+enabled it surfaces as a SUGGESTION in `buildActionQueue` —
  VERIFY `QueueProposal`/`buildActionQueue` render `resume_campaign` (it may need
  a proposal label/path). Both surfaces use the `queue.list` facade, so parity is
  automatic if the proposal path supports the kind.
- Dashboard execution: VERIFY the dashboard queue/alert action endpoint can
  approve+execute `resume_campaign`. If a surface can't, ship the engine+autopilot
  side and leave an explicit TODO for that surface (never silently single-side).
- Autopilot engine path (the actual auto-resume) is shared by both surfaces (one
  `runAutopilotForShop`), so the autonomous behavior mirrors with no extra work.

## Safety invariants (verify all still hold + add new)

- `task8-invariants.test.ts`, `graduation*.test.ts` stay green (resume_campaign
  already graduatable; we add coverage, change no gate).
- New: autopilot resume only fires when graduated+enabled; blocked by guardrails;
  skipped when precondition fails (campaign not paused / not restocked / not
  Calderyn-paused); fail-safe on DB error.

## Build order (TDD each step)

1. Engine detector + tests.
2. View migration (+ engine test-schema mirror).
3. TS types + labels (+ label exhaustiveness test).
4. TS preconditions (resume case + stockoutClearedResumeAllowed) + tests.
5. TS autopilot resume branch + tests.
6. Invariants/graduation green + new resume coverage.
7. Verify queue surfacing + dashboard parity; TODO any unshippable surface.
8. Pre-commit gate (typecheck, lint, build, prisma validate, engine pytest,
   `/code-review`).
