# Slice C — Warm-up / recommend-to-enable

Date: 2026-06-26
Status: Approved for build (TDD). Parent design: `docs/superpowers/specs/2026-06-26-autopilot-trust-ux-design.md` (Slice C section).

## Goal (plain)

When a merchant turns shop autopilot ON, **nothing fires on day one**. The three
"no-brainer" actions show up as **suggestions** in the Action Queue. Once the
merchant has approved a feature enough times (a track record), Calderyn
**recommends** turning it on, and the merchant opts in **per feature**. This
applies to **every** autopilot feature: graduation now means "unlocked", not
"running". A feature acts on its own only after the merchant explicitly enables it.

This is the conservative direction (fewer autonomous actions). It touches the
calibration safety model, so it ships with TDD and keeps every existing invariant.

## Model: two flags, one chokepoint

`pair_calibration` gains one column:

- `graduated` (exists) — **unlocked**: the pair earned the safety bars. Day-one
  `true` for the 3 no-brainers (short-circuit in `graduationVerdict`). Set by the
  nightly recompute + provisioning seed. **Unchanged.**
- `autonomy_enabled` (NEW, `boolean not null default false`) — the merchant's
  explicit per-feature on-switch. Autopilot acts only when a pair is
  `graduated AND autonomy_enabled`.

**Single money-path chokepoint:** the live `isGraduated()` check
(`app/lib/calibration/graduation.server.ts`) becomes
`verdict.graduated && autonomy_enabled`. All four autonomous execution sites in
`app/lib/actions/autopilot.server.ts` (lines ~220, ~457, ~828, ~1008) call
`isGraduated`, so they inherit the gate with no per-site code.

`graduationVerdict` (the pure fn in `graduation.ts`) is **NOT** changed — it stays
"unlocked" and keeps the existing `merchant_disabled` gate. It is also called from
non-autonomous contexts (approval `justGraduated` detection, nightly cache) where
"is this unlocked?" is the correct question regardless of the on-switch.

## Lifecycle

```
graduated=true, autonomy_enabled=false   → does NOT fire; engine still flags it →
                                            shows as a SUGGESTION in the queue
   │  merchant approves the suggestion (clean_approvals reaches the track-record bar)
   ▼
RECOMMENDED  → Live Engine shows "Ready to turn on" on that feature
   │  merchant flips the per-feature toggle → autonomy_enabled=true
   ▼
RUNNING  → graduated AND enabled → Calderyn acts on its own
   │  merchant flips it off → autonomy_enabled=false
   ▼
back to suggestions (re-suggestable later; no cooldown in v1 — accepted simplification)
```

Learned (non-no-brainer) pairs ride the same rails: they reach `graduated=true`
only after earning approvals+outcomes, then sit unlocked-but-off and get the same
"Ready to turn on" prompt. The queue's existing graduation moment becomes that
per-feature opt-in (its toggle already calls `setFeatureAutonomy`).

## Changes

1. **Migration** (`supabase/migrations/<ts>_pair_calibration_autonomy_enabled.sql`):
   `alter table public.pair_calibration add column autonomy_enabled boolean not null default false;`
   Existing rows backfill to `false` (the opt-in reset — prod shops are test-only).

2. **Gate** (`graduation.server.ts` `isGraduated`): add `autonomy_enabled` to the
   `select`; return `verdict.graduated && Boolean(row.autonomy_enabled)`.
   Fail-safe behavior (false on any read error) is preserved.

3. **Queue** (`queue.server.ts` `buildActionQueue`): rename the `graduatedPairs`
   param to `autonomyPairs` (semantic: pairs that are graduated **AND** enabled =
   actually running). Drop an alert only when its pair is in `autonomyPairs`
   (unless it is an over-cap alert — Slice A exception preserved). Graduated-but-off
   pairs stay as suggestions. Stays a pure function. The `queue.list` facade
   (`calderyn.server.ts`) computes `autonomyPairs` from `pair_calibration` where
   `graduated=true AND autonomy_enabled=true`; over-cap computation unchanged.

4. **Toggle** (`live-engine.server.ts` `setPairAutonomy`): set
   `autonomy_enabled = enabled` only. Remove the old `merchant_disabled` write and
   the no-brainer `graduated: enabled` hack. Off = `autonomy_enabled=false`,
   nothing muted (so it can be re-recommended). Client method signature
   (`setFeatureAutonomy(detectorId, actionKind, enabled)`) and both toggle routes
   are unchanged.

5. **Live Engine surface** (`live-engine.server.ts` + the page builder + both
   FeatureRows):
   - `LiveEngineFeature.enabled` now reflects `autonomy_enabled` (was `!merchant_disabled`).
   - Add `LiveEngineFeature.recommended: boolean`, computed purely in
     `aggregateLiveEngine`:
     `graduated && !autonomy_enabled && !merchant_disabled && clean_approvals >= MIN_APPROVALS[actionTier(actionKind)]`.
     (For the 3 no-brainers that bar is 3; for learned pairs it is already met at
     graduation, so the formula is uniform.)
   - `PairRow` + the `liveEngineSummary` select gain `autonomy_enabled`.
   - Thread `recommended` through `LiveEngineFeatureVM` (`live-engine-page.server.ts`).
   - Render a "Ready to turn on" chip on both FeatureRows: embedded
     `app/routes/app.engine.tsx` (Polaris / inline SVG) and dashboard
     `app/components/dashboard/screens/LiveEngine.tsx` (Lucide via `CDIcon`).

6. **Seeds/provisioning:** no change. `seedShippedAutopilotFeatures`
   (`supabase.server.ts`) and the autounlock migration omit the new column, so the
   `default false` governs new + existing rows.

## Tests (TDD)

New / updated:
- `graduation.server.test.ts`: a no-brainer with all gates passing returns
  `isGraduated=false` when `autonomy_enabled=false` (the opt-in default invariant),
  and `true` when `autonomy_enabled=true`. Existing passing fixtures gain
  `autonomy_enabled: true`.
- `queue.test.ts`: a graduated-but-not-enabled pair's alert is **kept** as a
  suggestion; a graduated-AND-enabled pair's alert is **dropped**; over-cap
  exception still keeps an enabled-pair alert.
- `live-engine.test.ts`: `setPairAutonomy` writes `autonomy_enabled` (not
  `merchant_disabled`); `aggregateLiveEngine` sets `enabled` from `autonomy_enabled`
  and computes `recommended` correctly (track-record met vs not, muted excluded,
  already-enabled excluded); `liveEngineSummary` selects `autonomy_enabled`.

Unchanged (must stay green — graduationVerdict is untouched):
`graduation.test.ts`, `graduation-outcomes.test.ts`, the `graduationVerdict`
portions of `task8-invariants.test.ts`, `recompute*.test.ts`, `approval.test.ts`,
`api-write-routes.test.ts`.

## Parity

Both surfaces share `app/lib/calibration` + `queue.list` + the page builder + the
toggle routes, so the gate/queue/toggle/`recommended` logic mirrors automatically.
Only the two FeatureRow components need the chip added in their own primitives.

## Out of scope (follow-ups)

- Cooldown before re-recommending a feature the merchant turned off.
- Slice B (auto-resume on stockout-clear) — separate, cross-stack effort.
