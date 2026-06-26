# Handoff — Outcome-Gated Autonomy, Phase 1

**Branch:** `feat/outcome-gated-autonomy` (built 2026-06-26, not merged)
**Spec:** `docs/superpowers/specs/2026-06-26-outcome-gated-autonomy-design.md`
**Plan:** `docs/superpowers/plans/2026-06-26-outcome-gated-autonomy.md` (Tasks 1–12 = Phase 1, done; Tasks 13–21 = Phase 2, not started)

## What's done (gate green, final review APPROVE WITH MINOR)

Trust to act autonomously now requires BOTH merchant approvals AND net-positive measured dollar
outcomes; auto-demotes on a measured loss or an autopilot undo; per-kind confirmation windows
(3d pause/cut, 7d others); two-bar progress on both surfaces. Scoped to `pause_campaign` +
`reduce_campaign_budget` (the kinds the engine reward kernel already grades).

Verified here: `typecheck` 0, `lint` 0 errors, `build` + client-bundle verifier 0,
`vitest` 2579 pass, `pytest tests/engine/moat` 64 pass.

## MUST DO before merging to main (main auto-deploys to prod)

The new code SELECTs new columns. If it reaches prod before the columns exist, those reads ERROR.
**Apply these two migrations to the database first:**

1. `supabase/migrations/20260626120000_pair_calibration_outcomes.sql`
   (adds `pair_calibration.net_positive_outcomes`, `last_outcome_sign`;
    `action_audit.reward_signal`, `reward_window_closed_at`; + a partial index)
2. `supabase/migrations/20260626120100_calibration_record_undo_fn.sql`
   (the `calibration_record_undo` RPC)

Both are additive and safe. Apply via the Supabase MCP / dashboard / CLI, then merge.

## Deferred verification (need a database; couldn't run in the build session)

- Engine DB-integration tests: `TEST_DATABASE_URL=<local pg> pytest tests/engine` (the moat
  unit tests already pass; the skipped 32 are the DB-backed ones).
- Behavioral check on `calderyn-review-store`: seed `pair_calibration` for a pause pair with
  enough approvals but `net_positive_outcomes = 0` → confirm NOT graduated; seed 3 positive
  closed-window `action_audit` rewards + run `cron.calibration-recompute` → flips graduated;
  seed a negative latest reward → demotes next recompute.
- `/code-review` on the diff (the final whole-branch subagent review was clean: 0 Critical/Important).

## Known minor follow-ups (non-blocking)

- `discontinue_sku` is in `GRADUATABLE_V1` but has no outcome signal until Phase 2, so it now
  stays in "ask" mode (a safe tightening — it can't meet the outcome bar yet). Phase 2 Task 16
  builds its scoring.
- `HAS_UNDO_BRANCH` still has 3 drifting copies; Phase 2 Task 13 unifies them into one module.
- A few internal test comments use em dashes (cosmetic, not browser-visible).

## Phase 2 (not started)

Tasks 13–21 in the plan: SKU-scoped reward path (resume/discontinue/price/inventory), the
`adjust_price`/`reallocate_inventory` bounded-magnitude guardrail fields, then flip the
graduatable set 3→7. Task 16 (SKU/inventory outcome metric) has a data-availability spike as
its first step — do not skip it.
