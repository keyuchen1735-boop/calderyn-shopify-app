# Calderyn Calibration Slice 5: Graduation + Gated Autonomy + Rule Enforcement

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
>
> **MONEY-CRITICAL.** This is the only slice where money moves without a per-action click. It does NOT introduce autonomy from scratch — autopilot already runs in prod for `autopilot_enabled` shops. This slice **gates that existing autonomy behind earned calibration** and wires in the 10 safety invariants. Net effect: autopilot becomes MORE conservative (it acts only on graduated, rule-compliant pairs). Every task ends green; the autonomy-execution tasks get opus review.

**Goal:** Autopilot acts unattended ONLY on (detector, action) pairs the merchant has trained to graduation, within all guardrails + learned rules, with a 48h undo + a notification. Off by default; merchant opts in.

**Founder decisions (binding):**
- **Graduatable set v1:** `pause_campaign` + `reduce_campaign_budget` (reversible campaign) + the no-brainer pairs (which are `pause_campaign`, shadow-gated, with the out-of-stock precondition allowlist). NOT `increase_campaign_budget` (no undo branch, spec I7), NOT inventory/irreversible.
- **Activation:** OFF by default; explicit merchant opt-in via `autopilot_enabled`. (No auto-enable.)
- **Gate everything, re-earn trust:** once this ships, autopilot acts ONLY on graduated pairs. Existing autopilot shops start conservative and re-earn trust through approvals. No history backfill.

**Architecture:** A pure `graduationVerdict()` decides whether a pair may act unattended (all gates from spec I3/I7 + the v1 set). The nightly recompute caches `pair_calibration.graduated`; `runAutopilotForShop` calls a live `isGraduated` check before every execute and skips non-graduated pairs. `checkGuardrails` gains `forceBypassOff` (I1) + a daily-aggregate-dollar ceiling (I2). A freshness/precondition re-check (I4) + the stockout allowlist (I10) run at exec time. Learned rules (Slice 3) are now ENFORCED. Autonomous actions get a 48h undo (I7) + a notification, and graduated pairs leave the queue (I5). A per-shop advisory lock (I6) + outcome-idempotent budget writes (I5) close the concurrency holes.

**Tech Stack:** Remix + TS (strict), Supabase, Vitest. Builds on Slices 0-3.

## Global Constraints (the 10 safety invariants — every autonomous execute must satisfy ALL)

- **I1 Guardrail veto absolute, bypass forced OFF.** Every calibration auto-execute calls `checkGuardrails(..., {forceBypassOff:true})`; `dollar_impact_cap_without_2fa` applies unconditionally. The learning loop may only TIGHTEN `guardrail_config` (already true; no loosening path here).
- **I2 Daily aggregate dollar ceiling + finite count.** Enforce the existing `daily_action_budget_cents` (sum of today's autonomous impact + this <= ceiling) in `evaluateGuardrails`. A NULL `autopilot_daily_action_cap` is treated as 5, not unlimited, for autonomous actions.
- **I3 Graduation = evidence not belief.** `graduated` requires: `last_conf >= graduation_threshold` AND `clean_approvals >= K` (K=3 for the reversible v1 set; this K IS the mandatory shadow gate — the first 3 real instances must have been queued + approved) AND `consecutive_undos = 0` AND not on probation AND not `merchant_disabled` AND kind ∈ v1 graduatable set AND has executor AND has undo branch.
- **I4 Freshness + live precondition re-check.** Decision facts <= T_fresh (stock <= 60 min, spend <= 24h); the executor re-reads live entity state and ABORTS (records `skipped: precondition_stale`) if the precondition no longer holds (campaign already paused/ended, ROAS now above breakeven, live budget already <= target).
- **I5 Idempotent on outcome + no double-actor.** Budget mutations target an absolute value re-derived from live budget and no-op if already there; a graduated pair is NEVER shown in the queue (so merchant-approve and autopilot can't both fire).
- **I6 Single-writer concurrency.** A per-shop advisory lock wraps each autopilot tick; alpha/beta via atomic DB increments (already true); `shops.calibration_pct` written only by the recompute (already true).
- **I7 Reversibility matches real undo + 48h window + notify.** A kind may graduate only if it has a working `undoAction` branch (pause/reduce qualify; increase does NOT). Autonomous actions get a 48h undo window (vs 24h approved) AND a notification at execution.
- **I8 No-brainer mute-resistance + floor.** Muting/reject-spamming a no-brainer downgrades it to "always ask" (queue), NEVER silent — the underlying alert always still fires. A per-pair confidence floor prevents permanent self-disabling.
- **I9 RLS + privilege.** (Already satisfied by Slices 0/3; no new tables here. Any new SQL fn is service_role-only.)
- **I10 Flagship precondition allowlist.** `(sku_stockout_vs_spend, pause_campaign)` auto-fires only when: `inventory_policy=deny`, tracking ON, ALL sellable variants out at ALL serving locations, fresh live re-check passes, campaign still actively spending. Otherwise it queues.
- **Off by default, opt-in.** Autonomy requires `autopilot_enabled=true` (merchant-set). No code path enables it automatically.
- **Pre-commit gate per task; FULL suite before any task touching autopilot/guardrails. The autonomy-execution tasks (2,4,5,6,7) get opus review.**

---

## File Structure

- Create `app/lib/calibration/graduation.ts` — pure `graduationVerdict(pair, ctx)` (the I3/I7 gates + v1 set).
- Create `app/lib/calibration/graduation.server.ts` — `isGraduated(shopId, detector, kind, sb)` live check (reads pair_calibration + active calibration_rule: probation/mute) + a recompute-side `recomputeGraduation`.
- Modify `app/lib/calibration/recompute.server.ts` — also write `pair_calibration.graduated` (+ last_conf) per the verdict.
- Modify `app/lib/actions/guardrails.ts` + `guardrails.server.ts` — `forceBypassOff` (I1); daily-aggregate-dollar fact+ceiling (I2); null-cap→5 for autonomous.
- Modify `app/lib/actions/autopilot.server.ts` — graduation gate before execute (I3); call guardrails with forceBypassOff (I1); freshness/precondition re-check (I4) incl. the stockout allowlist (I10); rule enforcement (dollar_cap clamp/skip, min_spend, blackout) (Slice 3 rules); per-shop advisory lock (I6); pass 48h window + actor for autonomous (I7).
- Create `app/lib/calibration/preconditions.server.ts` — `stockoutPauseAllowed(shopId, alert, sb)` (I10) + a generic `preconditionFresh(...)` (I4).
- Modify `app/lib/actions/undo.server.ts` (or execute path) — autonomous actions stamp a 48h undo eligibility (vs 24h); `v_audit_view.undo_eligible` honors per-actor window (needs a migration to the view OR a column).
- Create autonomous-action notification hook (reuse the existing digest/email path; minimal).
- Modify `app/lib/calibration/queue.server.ts` — exclude graduated pairs from the queue (I5).
- Modify `app/lib/actions/rule-enforce.server.ts` (new) — load active calibration_rule for a (shop,detector,action) and apply: muted_pair veto, pair_dollar_cap clamp, pair_min_spend floor, pair_blackout_hours veto, pair_probation_until block.

---

## Task 1: Pure graduation verdict + live `isGraduated`

**Files:** Create `app/lib/calibration/graduation.ts` (pure) + `graduation.server.ts` + tests.

**Interfaces:**
- `GRADUATABLE_V1: ReadonlySet<ActionKind> = {pause_campaign, reduce_campaign_budget}`
- `MIN_APPROVALS = { reversible: 3, hard_to_reverse: 10, irreversible: 25 }`
- `graduationVerdict(input: { actionKind: ActionKind; lastConf: number; gradThreshold: number; cleanApprovals: number; consecutiveUndos: number; merchantDisabled: boolean; onProbation: boolean; hasUndoBranch: boolean }): { graduated: boolean; reason: string }`
- `isGraduated(shopId, detectorId, actionKind, sb): Promise<boolean>` — loads pair_calibration row + checks active probation/mute rules, computes verdict live.

- [ ] **Step 1: Failing tests** for `graduationVerdict`: graduates a reversible pair only when ALL hold (kind in v1 set, conf>=threshold, clean_approvals>=3, consecutive_undos=0, not merchant_disabled, not on probation, has undo branch); each missing condition → not graduated with the right reason. `increase_campaign_budget` never graduates (not in v1 set / no undo branch). `reallocate_inventory` never graduates (not in v1 set).
- [ ] **Step 2: RED.**
- [ ] **Step 3:** Implement `graduation.ts` (pure boolean AND of the gates; v1-set membership first). Implement `graduation.server.ts` `isGraduated` (read pair_calibration by PK; read active calibration_rule for probation_until>now → onProbation, muted_pair → merchantDisabled OR true; `hasUndoBranch` from a set mirroring GATEWAY_UNDO_KINDS minus non-reversible; compute verdict). Pure module imports types/labels only.
- [ ] **Step 4: GREEN. Typecheck/lint. Commit.**

## Task 2 (opus review): Graduation gate in autopilot + cache in recompute

**Files:** Modify `autopilot.server.ts` (insert the gate at the documented point, after kind derivation ~line 168, before guardrails) + `recompute.server.ts` (write `graduated`).

- [ ] **Step 1:** In `runAutopilotForShop`, after `kind` is derived and before the guardrail check, add: `if (!(await isGraduated(shopId, c.detector_id, kind, sb))) { decide(c, kind, "skipped", "pair not graduated"); continue; }`. This is the load-bearing gate: a non-graduated pair NEVER auto-executes.
- [ ] **Step 2:** In `recompute.server.ts`, after computing each pair's conf, also compute + persist `pair_calibration.graduated` via `graduationVerdict` (so the cached flag stays fresh nightly; the live `isGraduated` is the authoritative gate at exec time).
- [ ] **Step 3:** Tests: an autopilot run with a non-graduated candidate records `skipped: pair not graduated` and does NOT call executeAction; a graduated candidate proceeds to the guardrail check. (Mock isGraduated.) Confirm via test that the DEFAULT state (no pair graduated) means autopilot executes nothing — the "gate everything" decision.
- [ ] **Step 4:** Gate + FULL suite + opus review. Commit.

## Task 3 (opus review): Guardrail hardening — I1 bypass-off + I2 daily-dollar

**Files:** `guardrails.ts` + `guardrails.server.ts` + tests.

- [ ] **Step 1:** `evaluateGuardrails`: add fact `todayAutopilotDollarsCents` + config `dailyActionBudgetCents`; after the per-action dollar cap, add `if (facts.todayAutopilotDollarsCents + facts.dollarImpactCents > cfg.dailyActionBudgetCents) return {allowed:false, reason:"daily dollar ceiling"}`. Treat a null `dailyActionCap` as 5 when the action is autonomous.
- [ ] **Step 2:** `checkGuardrails`: add `opts?: { forceBypassOff?: boolean }`; after mapping config, `if (opts?.forceBypassOff) config.bypassGuardrails = false`. Load `daily_action_budget` (dollars→cents) into `dailyActionBudgetCents`; sum today's autonomous `dollar_impact_at_exec` into `todayAutopilotDollarsCents`.
- [ ] **Step 3:** Tests: bypass=true in DB but forceBypassOff → the per-action cap STILL blocks an over-cap action; daily-dollar ceiling blocks once today's sum + this exceeds it; null count cap → treated as 5 for autonomous.
- [ ] **Step 4:** Update the autopilot call sites to pass `{forceBypassOff:true}`. Gate + FULL suite + opus review. Commit.

## Task 4 (opus review): Freshness re-check (I4) + stockout allowlist (I10)

**Files:** Create `preconditions.server.ts` + wire into `autopilot.server.ts` (before execute, after the graduation + guardrail pass).

- [ ] **Step 1:** `preconditionFresh(candidate, sb)`: re-read live campaign state; abort (return false + reason) if the campaign is not active, ROAS no longer below breakeven (for pause), or live budget already <= target (for reduce). Stock facts must be <= 60 min old; spend <= 24h.
- [ ] **Step 2:** `stockoutPauseAllowed(shopId, alert, sb)` (I10): true ONLY if `inventory_policy='deny'`, inventory tracking on, ALL sellable variants out at ALL locations serving the campaign geo, AND a fresh live stock re-check confirms still-out, AND the campaign is still spending. Otherwise false → the action stays in the queue (decide `skipped: precondition_not_met`).
- [ ] **Step 3:** Wire: in the autopilot loop, after graduation+guardrails, call the precondition check for the kind; on fail, `decide(..., "skipped", reason)` and continue (NEVER execute).
- [ ] **Step 4:** Tests: stockout-pause blocked when inventory_policy=continue / tracking off / a sellable variant in stock / another location covers / restocked since alert; allowed only when all hold. preconditionFresh aborts a stale pause. Gate + FULL suite + opus review. Commit.

## Task 5 (opus review): Enforce the learned rules (Slice 3 rules become live)

**Files:** Create `rule-enforce.server.ts` + wire into `autopilot.server.ts` (and the graduation gate where relevant).

- [ ] **Step 1:** `loadPairRules(shopId, detector, action, sb)` → active calibration_rule rows. `applyRulesToCandidate(rules, candidate, nowUtc)` returns `{veto?: string; cappedDollarCents?: number; sizedBudgetCents?: number}`:
  - `muted_pair` → veto "merchant handles this".
  - `pair_blackout_hours` → veto if current UTC hour ∈ hours.
  - `pair_min_spend` → veto if campaign spend < cents.
  - `pair_dollar_cap` → if action impact > cap, either downsize (for reduce, clamp the cut) or veto (if can't downsize).
  - `pair_probation_until` (> now) → already blocks graduation in isGraduated; also a belt-and-suspenders veto here.
- [ ] **Step 2:** Wire into the autopilot loop BEFORE execute: apply rules; on veto `decide(..., "skipped", reason)` + continue; on cap, adjust the action size.
- [ ] **Step 3:** Tests for each rule kind's effect on a candidate. Gate + FULL suite + opus review. Commit.

## Task 6 (opus review): 48h autonomous undo (I7) + notification + queue excludes graduated (I5)

**Files:** undo/exec path (a migration to make undo window per-actor, or stamp an `undo_expires_at`), a notification hook, `queue.server.ts`.

- [ ] **Step 1:** Autonomous actions (actor='autopilot') get a 48h undo window vs 24h for merchant. Implement by stamping `action_audit.undo_expires_at` at insert (actor-dependent) and having `v_audit_view.undo_eligible` + `undoAction`'s window check honor it (migration to the view + undo.server.ts). Keep 24h for merchant actions.
- [ ] **Step 2:** On each autonomous execute, fire a notification (reuse the existing email/digest path; minimal: enqueue or send "Calderyn paused Campaign X — undo within 48h"). Never block the action.
- [ ] **Step 3:** `buildActionQueue` / `queue.list`: exclude pairs where `graduated=true` (graduated pairs auto-run; they must NOT also appear as proposals — I5 no-double-actor). 
- [ ] **Step 4:** Tests: an autopilot action's undo is eligible at 36h, ineligible at 49h; a merchant action ineligible at 25h; graduated pairs absent from the queue; notification fired on autonomous execute. Gate + FULL suite + opus review. Commit.

## Task 7 (opus review): Concurrency lock (I6) + outcome-idempotent budget (I5)

**Files:** `autopilot.server.ts` / `cron.autopilot.tsx` + execute path.

- [ ] **Step 1:** Wrap each per-shop autopilot tick in a Postgres advisory lock (`pg_try_advisory_lock(hashtextextended(shop_id))` via an RPC, or a `shop_id`-scoped "run in progress" row with TTL); skip the tick if the lock is held (prevents overlapping ticks double-acting + over-cap).
- [ ] **Step 2:** Budget mutations (`reduce_campaign_budget`) re-derive the target from LIVE current budget at the platform call and no-op if live <= target (so a replay/overlap can't double-cut). Confirm `reallocate`'s existing stale-guard pattern is matched.
- [ ] **Step 3:** Tests: a second concurrent tick for the same shop is skipped; a reduce that would double-cut is a no-op the second time. Gate + FULL suite + opus review. Commit.

## Task 8: No-brainer mute-resistance + confidence floor (I8) + opt-in default

**Files:** `feedback.ts`/`reject.server.ts` (no-brainer handling) + `graduation`/queue.

- [ ] **Step 1:** Muting or reject-spamming a NO_BRAINER pair downgrades it to "always ask" (it can't graduate) but the ALERT still fires and the proposal still appears in the queue (mute does NOT remove a no-brainer from the queue, unlike a normal pair). A per-pair confidence floor (e.g. historical never driven below a small epsilon for no-brainers) prevents permanent self-disabling.
- [ ] **Step 2:** Confirm/encode: autonomy strictly requires `autopilot_enabled=true` (no auto-enable anywhere); a fresh shop has zero graduated pairs (autopilot no-ops). Add a test asserting a default shop executes nothing autonomously.
- [ ] **Step 3:** Tests for the no-brainer floor + mute-still-fires-alert. Gate + FULL suite. Commit.

## Task 9: Whole-slice verification + final review

- [ ] **Step 1:** Full gate green.
- [ ] **Step 2:** Adversarial sanity via diff + a live check: with a fresh/un-graduated shop, autopilot executes NOTHING (the "gate everything" guarantee); a graduated reversible pair executes only within guardrails (bypass-off), preconditions, and rules, with a 48h undo + notification, and is absent from the queue. Confirm no path lets `increase_campaign_budget` or inventory graduate. Re-run `get_advisors` (0 RLS errors).
- [ ] **Step 3:** Final whole-slice review (opus) over the slice range, explicitly checking all 10 invariants are enforced in code.

## Self-Review

- **Spec coverage:** graduation (spec §3) → Tasks 1,2; I1-I10 → Tasks 2-7; rule enforcement (§7, Slice-3 rules) → Task 5; no-brainer protection (I8) → Task 8; off-by-default opt-in → Task 8.
- **Decisions baked in:** v1 graduatable set = pause + reduce only (Task 1 `GRADUATABLE_V1`); gate-everything (Task 2 default = nothing graduated); opt-in (Task 8). increase_budget + inventory CANNOT graduate (Task 1 + I7).
- **Deferred:** peer-prior in the queue/scorer (peers still empty); wrong_timing blackout-histogram emission (Slice 3 deferred — but blackout ENFORCEMENT lands here in Task 5 once rules exist); pair_mu_override sizing (optional refinement).
- **Risk note:** Tasks 2,4,5,6,7 modify the live money path; each gets opus review + the FULL suite. The whole slice is behind `autopilot_enabled` (off by default), so even a latent bug cannot act on a shop that hasn't opted in.
