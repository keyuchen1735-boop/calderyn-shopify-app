# Calderyn Calibration Slice 3: Reject + Reason Taxonomy + Learned Rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the training loop: a merchant can REJECT a queued proposal with a reason, Calderyn records it as a deterministic learning signal (lowers that pair's confidence + writes a merchant rule), tells the merchant in plain words what it learned, and a "Learned rules" view lets the merchant see and undo what it learned. Reject executes NOTHING.

**Architecture:** Reject is pure bookkeeping + deterministic adjustment. A new `action_feedback` ledger records every reject; a new `calibration_rule` store holds the merchant-specific rules each reason produces; an atomic SQL fn applies the Beta `beta` bump + graduation-threshold delta + mute flag to `pair_calibration`. The reason→effect mapping and the plain-language reflection are pure, fully-tested functions. The Action Queue then excludes already-rejected alerts and muted pairs. All deterministic — no LLM.

**Tech Stack:** Remix + TS (strict), Supabase, Vitest, Polaris (embedded) + cd-*/CDIcon (dashboard). Builds on Slices 0-2 (on this branch): `pair_calibration`, `confidence.ts` (`pairConfidence`), `recordApproval`, the Action Queue + `queue.list` facade.

## Global Constraints

- **Reject executes NOTHING.** It only writes `action_feedback`, adjusts `pair_calibration` (beta/threshold/mute), upserts `calibration_rule`, and returns a reflection string. No executor, no platform call. (Money-risk here is near-zero; the correctness risk is "the agent learns the right thing" — cover it with tests.)
- **Deterministic, no LLM.** The reason→effect map and the reflection text are fixed functions of `(reason, detector, action)` + the optional free-text note (stored verbatim, never parsed/rendered as HTML, never fed to a model).
- **Reason taxonomy (exact set):** `too_aggressive | wrong_timing | not_enough_data | i_handle_this | other`.
- **Per-reason deterministic effects** (Beta `beta +=`, graduation-threshold delta, mute, rule written):
  | reason | beta += | grad_threshold += | mute | calibration_rule written |
  |---|---|---|---|---|
  | too_aggressive | 0.5 | +5 (cap 99) | no | `pair_dollar_cap` = min(existing, round(0.75 * alert dollar_impact)), floor 1 cent |
  | wrong_timing | 0.5 | 0 | no | none in this slice (timing-gating is Slice 5; record reason + reflect only) |
  | not_enough_data | 1.0 | +2 | no | `pair_probation_until` = now + 14 days |
  | i_handle_this | 0.0 (NO beta change) | 0 | yes (`merchant_disabled=true`) | `muted_pair` |
  | other | 1.0 | 0 | no | none (note stored in action_feedback) |
- **`i_handle_this` writes NO Beta change** (it is a scope signal, not a quality signal) — protects future peer baselines. Enforce + test.
- **Mute ≠ silence the alert.** Muting a pair removes it from the QUEUE (no proposal) but the underlying alert still fires on the Alerts page. (No-brainer floor protection / "are you sure" interstitial is Slice 5; for Slice 3, mute simply de-proposes.)
- **The confidence formula stays single-source** (`confidence.ts`). Reject lowers confidence purely by raising `beta` (consumed by `historical`); do not add a second confidence path.
- **`calibration_rule` is append-only-ish:** new rules supersede old via an `active` flag (set `active=false` on undo / supersede); never hard-delete. RLS forced, shop-scoped.
- **Queue resolution:** after a reject, the queue must not immediately re-propose the same alert — `queue.list` excludes alerts that already have a reject in `action_feedback`, and excludes muted pairs.
- **Parity MANDATORY:** reject picker + reflection + Learned-rules view mirrored on the dashboard (cd-*/CDIcon), same contract.
- **Pre-commit gate per task:** typecheck 0, lint 0 (errors + warnings on touched files), build 0, relevant vitest green; full suite before any task that touches shared files.
- **Worktree:** continue on `worktree-feat+calibration-foundation`.

---

## File Structure

- Create `supabase/migrations/20260621120000_action_feedback.sql` — `action_feedback` table + RLS.
- Create `supabase/migrations/20260621120100_calibration_rule.sql` — `calibration_rule` table + RLS.
- Create `supabase/migrations/20260621120200_calibration_record_rejection_fn.sql` — atomic beta/threshold/mute SQL fn (service_role-only).
- Mirror all three under `tests/engine/schema/migrations/`.
- Create `app/lib/calibration/feedback.ts` — pure `RejectReason`, `rejectEffect`, `reflection`.
- Create `app/lib/calibration/reject.server.ts` — `recordRejection(...)` orchestrator.
- Modify `app/lib/types.ts` — `RejectReason`, `LearnedRule` DTOs.
- Modify `app/lib/calibration/queue.server.ts` + `app/lib/calderyn.server.ts` — queue excludes rejected/muted; add `calibration.recordRejection`, `calibration.learnedRules`, `calibration.undoRule` facade methods.
- Modify `app/routes/app.queue.tsx` — reject reason picker + action handler (intent=reject) + show reflection; a Learned-rules section.
- Create `app/routes/dashboard.api.queue.reject.tsx` (or extend an existing dashboard action route) — dashboard reject.
- Modify dashboard: `screens/ActionQueue.tsx` (reject picker), a Learned-rules screen/section, `client.ts` (`rejectProposal`, `fetchLearnedRules`, `undoRule`), `view-models.ts`, `context.ts`, `DashboardApp.tsx`.

---

## Task 1: Migrations — `action_feedback`, `calibration_rule`, rejection SQL fn

**Files:** the three `supabase/migrations/*` above + their `tests/engine/schema/migrations/` mirrors.

**Interfaces produced:**
- `public.action_feedback(id uuid pk default gen_random_uuid(), shop_id uuid not null refs shops on delete cascade, alert_id uuid, detector_id text not null, action_kind public.action_kind not null, decision text not null check (decision in ('approve','reject')), reject_reason text check (reject_reason in ('too_aggressive','wrong_timing','not_enough_data','i_handle_this','other')), note text, applied_rule jsonb, created_at timestamptz not null default now())` + index `(shop_id, alert_id)` + RLS scoped to `current_shop_id()`.
- `public.calibration_rule(id uuid pk default gen_random_uuid(), shop_id uuid not null refs shops on delete cascade, detector_id text not null, action_kind public.action_kind not null, rule_kind text not null check (rule_kind in ('muted_pair','pair_dollar_cap','pair_min_spend','pair_blackout_hours','pair_probation_until','pair_mu_override')), rule_value jsonb not null default '{}', active boolean not null default true, source text, superseded_by uuid, created_at timestamptz not null default now())` + index `(shop_id, active)` + RLS scoped.
- `public.calibration_record_rejection(p_shop_id uuid, p_detector_id text, p_action_kind public.action_kind, p_beta_delta numeric, p_grad_delta int, p_mute boolean) returns void` — SECURITY DEFINER, `search_path=''`, service_role-only. Upsert: insert (beta=p_beta_delta, graduation_threshold=75+p_grad_delta capped 99, merchant_disabled=p_mute, consecutive_clean_approvals=0) ON CONFLICT update beta=beta+p_beta_delta, graduation_threshold=LEAST(99, graduation_threshold+p_grad_delta), merchant_disabled=(merchant_disabled OR p_mute), consecutive_clean_approvals=0, updated_at=now().

- [ ] **Step 1: Write the three migrations** (mirror the existing RLS + SECURITY DEFINER patterns: `enable`+`force row level security`, policy `using (shop_id = public.current_shop_id()) with check (...)`; the fn copies the `calibration_record_approval` revoke/grant block exactly — `revoke all from public; revoke execute from anon, authenticated; grant execute to service_role`). Use exact DDL from the Interfaces block.

- [ ] **Step 2: Apply all three via supabase MCP `apply_migration`** (load `select:mcp__supabase__apply_migration,mcp__supabase__execute_sql,mcp__supabase__get_advisors`; project `ajgrmnvzxfxxlwrxcgnu`).

- [ ] **Step 3: Verify** — `execute_sql`: both tables `rowsecurity=true`; `pg_class.relforcerowsecurity=true` for both; policy predicates `(shop_id = current_shop_id())`; `routine_privileges` for `calibration_record_rejection` shows only postgres/service_role. Then `get_advisors` (security) → 0 ERRORs on the new objects.

- [ ] **Step 4: Mirror** the three files byte-for-byte under `tests/engine/schema/migrations/`.

- [ ] **Step 5: Commit** — `git add supabase/migrations tests/engine/schema/migrations && git commit -m "supabase/migrations: action_feedback + calibration_rule tables + record_rejection fn (RLS, service_role)"`

---

## Task 2: Pure reject taxonomy + reflection

**Files:** Create `app/lib/calibration/feedback.ts`; test `app/lib/calibration/__tests__/feedback.test.ts`. Modify `app/lib/types.ts` (`RejectReason`).

**Interfaces produced:**
- `export type RejectReason = "too_aggressive" | "wrong_timing" | "not_enough_data" | "i_handle_this" | "other";`
- `export interface RejectEffect { betaDelta: number; gradDelta: number; mute: boolean; ruleKind: "pair_dollar_cap" | "pair_probation_until" | "muted_pair" | null; }`
- `export function rejectEffect(reason: RejectReason): RejectEffect`
- `export function reflection(reason: RejectReason, detectorId: string, actionKind: ActionKind): string` — plain-language, uses `DETECTOR_LABELS`/`ACTION_VERBS`; NO em dashes.

- [ ] **Step 1: Write failing tests**:

```ts
import { describe, it, expect } from "vitest";
import { rejectEffect, reflection } from "../feedback";

describe("rejectEffect", () => {
  it("too_aggressive: beta 0.5, grad +5, dollar cap, no mute", () => {
    expect(rejectEffect("too_aggressive")).toEqual({ betaDelta: 0.5, gradDelta: 5, mute: false, ruleKind: "pair_dollar_cap" });
  });
  it("i_handle_this: NO beta change, mutes, muted_pair rule", () => {
    expect(rejectEffect("i_handle_this")).toEqual({ betaDelta: 0, gradDelta: 0, mute: true, ruleKind: "muted_pair" });
  });
  it("not_enough_data: beta 1, grad +2, probation rule", () => {
    expect(rejectEffect("not_enough_data")).toEqual({ betaDelta: 1, gradDelta: 2, mute: false, ruleKind: "pair_probation_until" });
  });
  it("wrong_timing: beta 0.5, no rule this slice", () => {
    expect(rejectEffect("wrong_timing")).toEqual({ betaDelta: 0.5, gradDelta: 0, mute: false, ruleKind: null });
  });
  it("other: beta 1, no rule", () => {
    expect(rejectEffect("other")).toEqual({ betaDelta: 1, gradDelta: 0, mute: false, ruleKind: null });
  });
});

describe("reflection", () => {
  it("renders plain language per reason with the pair labels and no em dash", () => {
    const r = reflection("i_handle_this", "sku_stockout_vs_spend", "pause_campaign");
    expect(r.length).toBeGreaterThan(0);
    expect(r).not.toContain("—"); // em dash
    expect(r.toLowerCase()).toContain("leave");
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `feedback.ts`** with the table from Global Constraints. `reflection` switches on reason and interpolates `DETECTOR_LABELS[detectorId]` + `ACTION_VERBS[actionKind]` into fixed sentences (e.g. i_handle_this → `"Got it. I'll leave ${verb} on ${label} to you. Hand it back any time from Learned rules."`). Add `RejectReason` to `types.ts` and re-export from feedback.

- [ ] **Step 4: Run → PASS. Typecheck. Commit** — `git commit -m "lib/calibration: pure reject taxonomy + plain-language reflection"`

---

## Task 3: `recordRejection` orchestrator + facade

**Files:** Create `app/lib/calibration/reject.server.ts`; test it; modify `app/lib/calderyn.server.ts` (facade) + `app/lib/types.ts` (`LearnedRule`).

**Interfaces produced:**
- `recordRejection(shopId, input: { alertId: string | null; detectorId: string; actionKind: ActionKind; reason: RejectReason; note?: string; dollarImpactCents: number }, sb): Promise<{ reflection: string }>`
- Facade: `client.calibration.recordRejection(input)`, `client.calibration.learnedRules(): Promise<LearnedRule[]>`, `client.calibration.undoRule(ruleId): Promise<void>`.
- `LearnedRule { id, detector_id, action_kind, rule_kind, summary, created_at }` (summary = plain-language render).

- [ ] **Step 1: Failing test** for `recordRejection`: asserts it (a) inserts an `action_feedback` row (decision='reject', the reason, note, applied_rule frozen), (b) calls `calibration_record_rejection` rpc with the effect's betaDelta/gradDelta/mute, (c) upserts the right `calibration_rule` for reasons that produce one (muted_pair / pair_probation_until / pair_dollar_cap with value derived from dollarImpactCents), (d) returns the reflection string, (e) for `i_handle_this` the rpc betaDelta is 0. Stub `sb` with `from().insert()`, `rpc()`, `from().upsert()/insert()`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `reject.server.ts`:** compute `eff = rejectEffect(reason)`; build `applied_rule` jsonb (the concrete rule value, e.g. `{cents: Math.max(1, Math.round(0.75*dollarImpactCents))}` for pair_dollar_cap, `{until: <iso +14d>}` for probation, `{}` for muted_pair); insert action_feedback; `sb.rpc("calibration_record_rejection", {p_shop_id, p_detector_id, p_action_kind, p_beta_delta: eff.betaDelta, p_grad_delta: eff.gradDelta, p_mute: eff.mute})`; if `eff.ruleKind` insert a `calibration_rule` row (active=true, source=`reason`, rule_value=applied_rule) — for pair_dollar_cap, supersede any existing active pair_dollar_cap for that pair (set old `active=false`, `superseded_by`); return `{ reflection: reflection(reason, detectorId, actionKind) }`. Wrap the non-critical writes so a failure is logged but the merchant still gets the reflection (reject is pure UX bookkeeping). Add the 3 facade methods (mirror existing namespace patterns; `learnedRules` = select active calibration_rule for shop mapped to `LearnedRule` via a `ruleSummary(rule)` plain-language renderer; `undoRule` = set `active=false` scoped to shop+id, logged to action history if cheap, else just the flag).

- [ ] **Step 4: Run → PASS. Typecheck + lint. Commit** — `git commit -m "lib/calibration: recordRejection orchestrator + learnedRules/undoRule facade"`

---

## Task 4: Queue excludes rejected + muted

**Files:** Modify `app/lib/calibration/queue.server.ts` (`buildActionQueue` gains a `rejectedAlertIds: Set<string>` + `mutedPairs: Set<string>` param) and `app/lib/calderyn.server.ts` (`queue.list` loads recent reject feedback + active muted_pair rules and passes them in). Test `queue.test.ts` (extend).

- [ ] **Step 1: Failing tests:** `buildActionQueue` drops an alert whose id is in `rejectedAlertIds`; drops a proposal whose `${detector}:${action}` is in `mutedPairs`; keeps others.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the two filters in `buildActionQueue`; in `queue.list`, query `action_feedback` (decision='reject') alert_ids for the shop + `calibration_rule` where `active and rule_kind='muted_pair'` → build the sets → pass through. Keep shop-scoped.
- [ ] **Step 4: PASS. Typecheck. Commit** — `git commit -m "lib/calibration: queue excludes rejected alerts + muted pairs"`

---

## Task 5: Embedded reject UI + Learned rules

**Files:** Modify `app/routes/app.queue.tsx` (add a Reject control per row → reason picker → POST `intent=reject` to the queue route's `action`; show the returned reflection as a toast/banner; add a "Learned rules" section listing `client.calibration.learnedRules()` with an Undo button → POST `intent=undo-rule`). Test the queue action (reject calls recordRejection; undo calls undoRule).

- [ ] **Step 1:** Add an `action()` to `app.queue.tsx` handling `intent=reject` (validate `reason` ∈ taxonomy + `alertId/kind/detectorId` from the form, BUT re-derive detector/kind from the trusted alert via `client.alerts.get(alertId)` — do not trust the form for detector/kind/impact; pull `dollar_impact` from the alert) → `client.calibration.recordRejection(...)` → return `{ reflection }`. And `intent=undo-rule` → `client.calibration.undoRule(ruleId)`.
- [ ] **Step 2:** Loader also returns `learnedRules`. UI: each queue row gets Approve (existing) + a Reject button opening a Polaris reason picker (`Select`/`ChoiceList` of the 5 reasons + optional note `TextField`); on submit show the reflection. A "What Calderyn has learned" card lists each rule's `summary` with an Undo button. Empty states for both.
- [ ] **Step 3:** Validation at the action boundary (reason must be one of the 5; reject never executes). Tests: reject intent → recordRejection called with re-derived detector/kind; bad reason → 400; undo intent → undoRule called.
- [ ] **Step 4:** Gate (typecheck/lint/build + the queue tests + FULL suite). Commit — `git commit -m "routes/app.queue: reject reason picker + reflection + Learned rules (embedded)"`

---

## Task 6: Dashboard reject + Learned rules (parity)

**Files:** dashboard reject API route (mirror the embedded action; re-derive detector/kind from the trusted alert), `screens/ActionQueue.tsx` (reject picker + reflection toast), a Learned-rules screen or section, `client.ts` (`rejectProposal`, `fetchLearnedRules`, `undoRule`), `view-models.ts` (`LearnedRuleVM`), `context.ts` + `DashboardApp.tsx` (wire). Patch DashboardCtx fixtures.

- [ ] **Step 1:** Dashboard reject API route: auth (session shop), validate reason, re-derive detector/kind/impact from trusted alert, `calderynClient(shop).calibration.recordRejection(...)`, return `{ reflection }`. Undo + learnedRules routes likewise (or one `dashboard.api.calibration.rules` route with GET list + POST undo).
- [ ] **Step 2:** ActionQueue screen: add Reject (cd-* reason picker — a small menu/segmented control of the 5 reasons + note) calling the new client method; show the reflection (toast). Learned-rules view (cd-row list + Undo).
- [ ] **Step 3:** Register any new screen/ctx field; patch fixtures; `fetchLearnedRules`/`rejectProposal`/`undoRule` in client.ts; `LearnedRuleVM`.
- [ ] **Step 4:** Gate (typecheck/lint/build + FULL suite). Commit — `git commit -m "dashboard: reject reason picker + reflection + Learned rules (parity)"`

---

## Task 7: Whole-slice verification + final review

- [ ] **Step 1:** Full gate green (typecheck/lint/build/test).
- [ ] **Step 2:** Sanity via diff: reject NEVER calls an executor; `i_handle_this` produces NO beta change (grep the rpc args / unit test); muted pairs leave the alert firing (only de-proposed); detector/kind always re-derived from the trusted alert, never the form; RLS forced on both new tables (advisor 0 errors).
- [ ] **Step 3:** Final whole-slice review (opus) over the slice range.

## Self-Review

- **Spec coverage:** reject taxonomy + deterministic effects (spec §5/§7) → Tasks 2-3; calibration_rule + action_feedback store (§8) → Task 1; reflections (§5) → Task 2; queue resolution + mute (§5/§8) → Task 4; Learned-rules view + undo (§7) → Tasks 5-6; parity (§10) → Task 6.
- **Deferred (by design, noted):** wrong_timing blackout-hours histogram + pair_mu_override (Slice 5, where timing/sizing gate autopilot); no-brainer mute-resistance + "are you sure" interstitial (Slice 5, I8); rule enforcement in autopilot (Slice 5). Slice 3 records + reflects + de-proposes; it does not yet gate autonomy (there is none yet).
- **Type consistency:** `RejectReason` (5 values) identical Tasks 2-6; `recordRejection(shopId, {alertId, detectorId, actionKind, reason, note, dollarImpactCents}, sb)` identical Tasks 3,5,6; `LearnedRule {id, detector_id, action_kind, rule_kind, summary, created_at}` identical Tasks 3,5,6.
- **Placeholder scan:** none.
