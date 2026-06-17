# F1 — Scale-up automation (budget increases on winning campaigns)

- **Date:** 2026-06-16
- **Status:** Design — approved, ready for implementation plan
- **Branch / worktree:** `feat/campaigns-scale-up` / `../calderyn-campaigns-scale-up`
- **Source:** Campaigns Moby / Triple Whale parity handoff (2026-06-16), feature **F1**
- **Scope decision:** **Full F1** — manual (approval-gated) scale *and* autopilot auto-scaling, including a new Python detector.

---

## 1. Problem & goal

Autopilot today only ever **cuts, pauses, or reallocates** budget — it never grows a winner. We grade every campaign (`winning | okay | poor`) but take no action to scale the winners. Moby/Triple Whale's headline behaviour is "scale winning campaigns automatically." This feature adds the offensive half of the loop: detect margin-positive winners and (a) surface a one-click "scale" suggestion to the merchant, and (b) let autopilot raise their budgets autonomously within guardrails.

Everything stays **approval-gated by default** and **guardrailed**; autopilot scaling is opt-in via the existing `autopilot_enabled` switch plus the new caps below.

## 2. What already exists (verified during discovery)

These findings shaped the design and **correct several assumptions in the handoff**:

| Handoff assumed | Verified reality | Consequence |
|---|---|---|
| Detectors live in TS (`cron.detect.tsx`) | Campaign detectors are **Python** in `engine/calderyn_engine/detectors/`; the TS `cron.detect.tsx` only runs `free_shipping_leakage`. Grading lives in `engine/calderyn_engine/grade.py` + `campaign_grade_repo.py`. | The scale detector is **Python**, alongside `campaign_below_breakeven` etc. |
| Meta-only write path; flag if Google/TikTok missing | **All three** platforms expose `setDailyBudget(externalId, cents)` — `app/lib/{meta,google,tiktok}/actions.server.ts`. It is exactly what `reduce_campaign_budget` already calls. | `increase_campaign_budget` is **cross-platform for free** — no new adapter code. |
| Grades are A/B | Grades are `winning | okay | poor` (`grade.py`). `winning` ⇔ `roas ≥ 1.2 × break_even_roas`, where `break_even_roas = 1 / margin`. | "Winner" = `grade = 'winning'`. Margin-positive is already implied — **no separate margin guard needed**. |
| Need a per-campaign ROAS target | **No target column exists.** Breakeven is derived per campaign from contribution margin. | Reuse the existing grade; do not invent a target. |
| Add `increase_campaign_budget` mirroring `reduce_` | Confirmed: `executeAction` in `app/lib/actions/execute.server.ts` already does idempotency + ownership + audit + undo + optimistic mirror, and the budget path is symmetric. | The new executable is a small, mechanical addition. |

Other relevant facts:

- **Alert shape** (`alerts` table): `dollar_impact numeric(12,2)`, `entity_ref jsonb` (e.g. `{campaign_id, platform}`), upsert keyed on `(shop_id, detector_id, entity_ref, day_bucket)` via `engine/calderyn_engine/alerts_repo.py`.
- **Autopilot** (`app/lib/actions/autopilot.server.ts`): iterates `v_autopilot_candidates` (open alerts joined to campaign + 7d spend + current budget), **sorted by `dollar_impact` DESC**, maps detector → action via `PAUSE_DETECTORS` / `BUDGET_DETECTORS`, and runs `executeAction` after `evaluateGuardrails`.
- **Guardrails** (`app/lib/actions/guardrails.ts`, `guardrail_config` table): `evaluateGuardrails` already checks enabled, daily action cap, min spend, cut %, dollar-impact cap, cooldown, business hours. `GuardedKind = ExecutableKind | "reallocate_budget"`. The cut-% check is the template for an increase-% check.
- **Per-action dollar cap** (`app/lib/actions/alert-action.server.ts`): all non-snooze actions are blocked if `alert.dollar_impact > dollar_impact_cap_without_2fa`. This applies to scale alerts unchanged.
- **No proposed-actions queue table** — proposals live in `assistant_messages.drafted_action`. Irrelevant to F1 (F1 uses the live alert + `executeAction`). The `action_audit` table is the execution/idempotency/undo store.
- **UI suggestion precedent**: the campaigns table's "reallocate" prefill is computed by `suggestReallocation` and rendered via `ReallocationPrefill` (`app/routes/app.campaigns._index.tsx`). The dashboard mirror is `app/components/dashboard/screens/Campaigns.tsx` + `executeCampaignAction` in `app/lib/dashboard/client.ts` + `CampaignVM`/`GuardrailVM` in `view-models.ts`.

## 3. Architecture & data flow

```
Python engine (cron.engine.run)
  campaign_grade_fact ──► detector: campaign_scaling_opportunity
                            fires when grade = 'winning'   (margin-positive already guaranteed)
                            dollar_impact = estimate_scale_upside(...)
                                 │ upsert alert (entity_ref = {campaign_id, platform})
                                 ▼
                          alerts ──► v_autopilot_candidates  (ranked by dollar_impact DESC)
                                 │
                ┌────────────────┴───────────────────────────┐
        autopilot (cron.autopilot)                       UI surfaces (extension + dashboard)
   SCALE_DETECTORS → increase_campaign_budget        "Suggested: scale" badge from the open alert
   new_budget = round(cur × (1 + max_inc%/100))      one-sentence + one Approve button:
              capped at max_daily_budget_cents          "+20% → +$X/mo margin   [Approve]"
        │                                                        │
        ▼                                                        ▼
   evaluateGuardrails ── pass ──► executeAction("increase_campaign_budget", dailyBudgetCents)
        │                              → adapter.setDailyBudget (Meta / Google / TikTok ✓)
        │                              → audit row + undo + optimistic ad_campaign_dim mirror
        └── blocked ──► logged (visible), counts toward daily action cap
```

**Single source of truth:** the `campaign_scaling_opportunity` alert. Both autopilot and the UI badge read from it (UI via the existing per-campaign alert join; autopilot via `v_autopilot_candidates`). No second winner-detection code path.

## 4. Components

### 4.1 Python engine — `engine/calderyn_engine/`

**Detector — `detectors/campaign_scaling_opportunity.py`** (new)
- `DETECTOR_ID = "campaign_scaling_opportunity"`.
- Reads the latest `campaign_grade_fact` per active campaign (same source the other campaign detectors use). Fires for `grade == 'winning'`.
- Skips campaigns with insufficient data: no current `daily_budget_cents`, status not active, or already at/above the configured daily ceiling (so we don't emit dead suggestions). Document the exact guards.
- `severity`: `medium` by default, `high` when projected upside is large (mirror the breakeven detector's tiered severity).
- Emits one `DetectionResult` per winner: `entity_ref = {campaign_id, platform}`, `dollar_impact = estimate_scale_upside(...)`, `evidence = {grade, roas, margin, current_budget_cents, step_pct}`.
- Registered in `detectors/__init__.py`.

**Estimator — `estimators/scale_upside.py`** (new)
- `estimate_scale_upside(current_daily_cents, roas, margin, increase_pct, horizon_days=30) -> Decimal`.
- Definition (documented as "projected, assumes performance holds at current ROAS"):
  `incremental_daily = current_daily_cents * increase_pct/100`
  `net_per_dollar = roas * margin - 1`  (≥ 0.2 for a winner, since winning ⇒ roas ≥ 1.2/margin)
  `dollar_impact = incremental_daily/100 * horizon_days * max(net_per_dollar, 0)`
- Returned in **dollars**, 30-day horizon (matches the "+$X/mo" UX framing). **Units are authoritative:** `alerts.dollar_impact` is in *dollars* — see the comment at `app/lib/actions/execute.server.ts:68-69` ("column unit: dollars, matching alerts.dollar_impact"). Autopilot converts dollars→cents only at the guardrail boundary (`autopilot.server.ts:155` `Math.round(dollar_impact * 100)`), and `guardrails.server.ts:72` does the same for the cap. The estimator therefore emits dollars exactly like `estimate_below_breakeven_loss` does; do **not** emit cents.
- Pure function, unit-tested.

> The `increase_pct` the detector uses for the estimate is the shop's `autopilot_max_budget_increase_pct` (default 20). The detector reads it from `guardrail_config` (or accepts it as a parameter from the engine runner — match how other detectors receive shop config).

### 4.2 TS orchestrator — `app/lib/`

**`actions/execute.server.ts`**
- Add `"increase_campaign_budget"` to `ExecutableKind`.
- Validate `dailyBudgetCents` is present, positive, **and strictly greater than the current budget** (reject otherwise — direction guard).
- Post-state, audit params (old + new budget), optimistic mirror, idempotency, ownership, undo: **all reused unchanged**. Undo restores the prior budget (reversible). No adapter changes — `setDailyBudget` already serves both directions.
- Optional: add a named `setCampaignDailyBudget` export to `app/lib/meta/campaigns.server.ts` for symmetry with `setCampaignStatus` (cosmetic; the adapter already calls the budget POST inline).

**`actions/autopilot.server.ts`**
- `SCALE_DETECTORS = new Set(["campaign_scaling_opportunity"])`.
- For a scale candidate: `target = round(current_daily_cents * (1 + max_increase_pct/100))`, then `target = min(target, max_daily_budget_cents)` if a ceiling is set. If `target <= current` (already capped), skip with a logged reason.
- Run `evaluateGuardrails`, then `executeAction({ kind: "increase_campaign_budget", dailyBudgetCents: target, ... })`.
- **Ordering:** defensive actions (pause/reduce/reallocate) are processed before scale actions within a run, so a money-loser is never starved of the daily action cap by an offensive scale. (Implementation: partition candidates, or process `SCALE_DETECTORS` after the others.) Documented as a deliberate v1 choice.

### 4.3 Guardrails — `app/lib/actions/guardrails.ts` + migration

**New `guardrail_config` columns** (new migration, additive, `not null`/nullable as noted):
- `autopilot_max_budget_increase_pct int not null default 20` — max % a single autopilot scale may add.
- `autopilot_max_daily_budget_cents int` (**nullable**, default `NULL` = no ceiling) — hard per-campaign daily-budget ceiling autopilot will not exceed.

**`guardrails.ts`**
- Add `"increase_campaign_budget"` to `GuardedKind` (via adding it to `ExecutableKind`).
- Extend `AutopilotGuardrails` with `maxBudgetIncreasePct: number` and `maxDailyBudgetCents: number | null`.
- New check in `evaluateGuardrails`, mirroring the cut-% check: for `increase_campaign_budget`, reject if `increasePct = (newBudgetCents/currentBudgetCents - 1) * 100 > maxBudgetIncreasePct`, or if `maxDailyBudgetCents != null && newBudgetCents > maxDailyBudgetCents`.
- Existing checks (enabled, daily cap, min spend, cooldown, business hours, `dollar_impact_cap_without_2fa`) apply unchanged.
- `guardrails.server.ts`: SELECT + map the two new columns.

### 4.4 Type & label wiring

- `app/lib/types.ts`: add `"increase_campaign_budget"` to `ActionKind`, `"campaign_scaling_opportunity"` to `DetectorId`.
- `app/lib/labels.ts`:
  - `ACTION_LABELS` / `ACTION_VERBS` for `increase_campaign_budget` (plain language, e.g. label "Scale budget", verb "Scaled budget"; jargon-free per the terminology rule).
  - `DETECTOR_LABELS` / `DETECTOR_TERMS` for `campaign_scaling_opportunity` (e.g. "Winning campaign you can scale").
  - `DETECTOR_TO_ACTIONS: campaign_scaling_opportunity → ["increase_campaign_budget", "snooze_alert"]`.

### 4.5 UI — extension (Polaris)

`app/routes/app.campaigns._index.tsx`
- Loader: surface the open `campaign_scaling_opportunity` alert per campaign (the badge/prefill source). Prefer reading the alert over recomputing, so UI and autopilot agree.
- Row action **"Scale budget"** + a **"Suggested: scale"** badge on winners with an open scale alert, mirroring the reallocate prefill pattern.
- Approve modal: **one sentence + one primary button** — e.g. *"Scale this winner +20% → +$X/mo projected margin."* `[Scale budget]`. The `+$X` is the alert's `dollar_impact`. Submitting posts `increase_campaign_budget` with `dailyBudgetCents = round(current * (1 + pct/100))`.
- Disable the action when not active / no budget / already at ceiling. Friendly empty state when there's no winner to scale.

`app/routes/app.settings.tsx`
- Expose the two new caps in `GuardrailsCard` with safe defaults (a merchant can ignore them). New `TextField`s + `setIfPresent` handlers, sent via `client.guardrails.update`.

### 4.6 UI — dashboard mirror (non-Polaris) — MANDATORY parity

- `app/lib/dashboard/client.ts`: allow `"increase_campaign_budget"` in `CampaignActionInput.type` / `executeCampaignAction`.
- `app/routes/dashboard.api.campaigns.$id.action.tsx`: add the kind to the accepted `KINDS`.
- `app/components/dashboard/view-models.ts`: extend `GuardrailVM` with the two new caps; ensure `CampaignVM` can express "scale suggested" (reuse `grade`/an alert flag).
- `app/components/dashboard/screens/Campaigns.tsx`: "Suggested: scale" badge on `CampaignRow` for winners with an open scale alert; a **"Scale budget"** button on `CampaignDetail` calling `run("increase_campaign_budget", …, status)` with the target budget.
- `app/routes/dashboard.api.guardrails.tsx`: add the two new caps to `PATCHABLE_KEYS`.

> Mirror the **contract**, not the Polaris JSX. Both surfaces are fed by the shared engine (detector/alert) + orchestrator (`executeAction`) + guardrails.

## 5. Data contract summary

- **New `guardrail_config` columns:** `autopilot_max_budget_increase_pct` (int, default 20), `autopilot_max_daily_budget_cents` (int, nullable).
- **New alert detector_id:** `campaign_scaling_opportunity`, `entity_ref = {campaign_id, platform}`, `dollar_impact` = 30-day projected incremental margin (dollars).
- **New action kind / executable:** `increase_campaign_budget`, input `{ campaignId, dailyBudgetCents, idempotencyKey, alertId?, actor?, triggerReason? }` — same `ExecuteInput` shape as `reduce_campaign_budget`.
- **Audit:** one `action_audit` row per scale, `pre_state`/`post_state` capture old/new budget; undoable.

## 6. Testing

- **Python** (`engine/.../__tests__` or the project's pytest layout): `estimate_scale_upside` (math + the winner floor of ≥0.2/$); `campaign_scaling_opportunity` detector threshold (fires on `winning`, skips non-winners / no-budget / at-ceiling / insufficient data).
- **TS (pure):** `evaluateGuardrails` increase-% and daily-ceiling rejection paths; autopilot target-budget math (cap + ceiling + skip-when-capped).
- Regression: existing autopilot defensive behaviour unchanged; `executeAction` reduce path untouched.

## 7. Acceptance criteria

1. Autopilot raises budget **only** on `grade='winning'` campaigns, never exceeding `autopilot_max_budget_increase_pct` or `autopilot_max_daily_budget_cents`; blocked actions are logged visibly and count toward the daily cap.
2. Every increase produces an `action_audit` row and is undoable (restores prior budget).
3. A merchant sees a single plain-language suggestion with a dollar figure and one Approve button on both surfaces; a non-technical merchant can act in <10s.
4. The scale opportunity appears in the alerts inbox (it is a real alert) and is ranked by `dollar_impact`.
5. Defensive autopilot actions are processed before offensive scale actions in a run.
6. Works for Meta, Google, and TikTok (all expose `setDailyBudget`).
7. Pre-commit gate green (typecheck, lint `--max-warnings=0` on new code, build, `prisma validate`/migration diff if schema touched). New Supabase objects: new migration, `security_invoker` where a view is added/changed, explicit `.limit()`.

## 8. Risks / decisions the implementation plan must resolve

- **`v_autopilot_candidates` filter:** verify whether the view restricts to specific `detector_id`s. If so, its migration must be extended to include `campaign_scaling_opportunity` (additive migration, `security_invoker`). If it already passes all open alerts, no change.
- **Mixed ranking semantics:** scale alerts carry *projected upside*; cut/pause alerts carry *realized loss*. They share one `dollar_impact`-sorted queue. v1 accepts this but processes defensive actions first (§4.2). Revisit if scaling crowds out loss-prevention.
- **Daily ceiling default:** shipped **nullable / no ceiling** so existing shops aren't unexpectedly blocked; merchants opt in. Confirm this is acceptable vs. a conservative non-null default.
- **Detector config plumbing:** confirm how the Python engine passes per-shop `guardrail_config` (the increase %) to detectors, matching existing detectors' config access.
- **`dollar_impact_cap_without_2fa` interaction:** large winners may produce a projected impact above the cap, gating the scale behind 2FA. This is intended (big-money actions need a human), but call it out in the UI copy so it isn't a silent dead button.

## 9. Out of scope (separate features in the handoff)

F2 (live creative fatigue), F3 (NL automation builder), F4 (ad-set/ad/bid/create/duplicate), F5 (cross-channel measured ROAS). Each is its own worktree + spec.
