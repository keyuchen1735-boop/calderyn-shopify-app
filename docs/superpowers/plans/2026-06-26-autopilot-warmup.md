# Autopilot Warm-up / Recommend-to-Enable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** No autopilot feature acts on its own until the merchant explicitly enables it; until then the engine still flags it as a queue suggestion, and once it has a track record Calderyn recommends turning it on.

**Architecture:** Add `pair_calibration.autonomy_enabled` (default false). The live `isGraduated()` check becomes the single money-path chokepoint (`verdict.graduated && autonomy_enabled`). The pure `graduationVerdict()` is unchanged ("unlocked"). The queue keeps graduated-but-off pairs as suggestions; the per-feature toggle flips `autonomy_enabled`; the Live Engine surfaces a "Ready to turn on" recommendation. Both surfaces share `app/lib/calibration` + the page builder, so parity is mostly automatic.

**Tech Stack:** Remix, TypeScript (strict), Supabase (raw SQL migrations), Vitest, Polaris (embedded) + Lucide/CDIcon (dashboard).

## Global Constraints

- TypeScript only, `tsc --noEmit` authoritative; no `any`.
- DB changes via a new `supabase/migrations/` file; never edit existing migrations.
- No browser-visible AI/provenance markers; keep comments technical/product-neutral.
- No em dashes in generated copy/prose.
- Pre-commit gate before any merge: `/code-review`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx prisma validate` (schema unchanged here — Prisma is only session storage, so N/A unless `schema.prisma` changes), full `npm run test`.
- Conservative direction: when in doubt, the safe state is "does NOT act autonomously".

---

### Task 1: Migration — add `autonomy_enabled`

**Files:**
- Create: `supabase/migrations/20260626XXXXXX_pair_calibration_autonomy_enabled.sql`

**Interfaces:**
- Produces: `pair_calibration.autonomy_enabled boolean not null default false`.

- [ ] **Step 1:** Write the migration:

```sql
-- Per-feature autopilot on-switch. Graduation only UNLOCKS a (detector, action)
-- pair; it acts autonomously only after the merchant explicitly enables it here.
-- Defaults false so nothing fires on day one and existing rows reset to opt-in.
alter table public.pair_calibration
  add column if not exists autonomy_enabled boolean not null default false;
```

- [ ] **Step 2:** `npx prisma validate` is N/A (Prisma schema untouched). Confirm SQL parses by eye; it is applied to prod later via the supabase MCP after the gate is green.
- [ ] **Step 3:** Commit: `feat(migration): add pair_calibration.autonomy_enabled (per-feature autopilot opt-in)`

---

### Task 2: Gate `isGraduated` on `autonomy_enabled` (chokepoint)

**Files:**
- Modify: `app/lib/calibration/graduation.server.ts` (`isGraduated` select + return)
- Test: `app/lib/calibration/__tests__/graduation.server.test.ts`

**Interfaces:**
- Consumes: `pair_calibration.autonomy_enabled`.
- Produces: `isGraduated()` returns true only when `graduationVerdict.graduated && autonomy_enabled`. Used by all 4 autopilot execution sites unchanged.

- [ ] **Step 1 (RED):** In `graduation.server.test.ts`, add `autonomy_enabled: true` to `PASSING_ROW` (keeps existing happy-path/blocking tests valid), then add a new describe:

```ts
describe("isGraduated — per-feature autonomy opt-in (Slice C)", () => {
  it("returns false when autonomy_enabled is false even if all gates pass", async () => {
    const { sb } = makeStub({ pairRow: { ...PASSING_ROW, autonomy_enabled: false }, rules: [] });
    expect(await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb)).toBe(false);
  });
  it("returns true when autonomy_enabled is true and gates pass (no-brainer)", async () => {
    const { sb } = makeStub({ pairRow: { ...PASSING_ROW, autonomy_enabled: true }, rules: [] });
    expect(await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb)).toBe(true);
  });
  it("treats a missing autonomy_enabled column as not-enabled (fail-safe)", async () => {
    const row = { ...PASSING_ROW }; delete (row as Record<string, unknown>).autonomy_enabled;
    const { sb } = makeStub({ pairRow: row, rules: [] });
    expect(await isGraduated("shop-1", "campaign_below_breakeven", "pause_campaign", sb)).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run app/lib/calibration/__tests__/graduation.server.test.ts` — expect the new "false when autonomy_enabled is false" + "missing column" tests to FAIL (current code ignores the flag), happy path passes.
- [ ] **Step 3 (GREEN):** In `isGraduated`, add `autonomy_enabled` to the `.select(...)` string, and change the return:

```ts
// select: "..., merchant_disabled, autonomy_enabled, net_positive_outcomes, last_outcome_sign"
const verdict = graduationVerdict({ /* unchanged */ });
// Slice C: graduation only UNLOCKS a pair; it acts autonomously only after the
// merchant explicitly enables this feature. Default-false column => fail-safe off.
return verdict.graduated && Boolean(row.autonomy_enabled);
```

- [ ] **Step 4:** Re-run the file — all pass.
- [ ] **Step 5:** Commit: `feat(calibration): gate isGraduated on per-feature autonomy_enabled`

---

### Task 3: Queue keeps graduated-but-off pairs as suggestions

**Files:**
- Modify: `app/lib/calibration/queue.server.ts` (rename param `graduatedPairs`→`autonomyPairs`, update comments; `inventoryOverCapAlertIds` param rename)
- Modify: `app/lib/calderyn.server.ts` (`queue.list` facade: select `autonomy_enabled`, compute the running set)
- Test: `app/lib/calibration/__tests__/queue.test.ts`

**Interfaces:**
- Consumes: `pair_calibration` rows with `graduated` + `autonomy_enabled`.
- Produces: `buildActionQueue(..., autonomyPairs, overCapAlertIds)` drops an alert only when its pair is **running** (graduated AND enabled), except over-cap.

Note: the pure function's behavior is unchanged (drop pairs in the set, except over-cap). Only the **meaning** of the set changes (running, not merely graduated), which the facade computes. The rename makes the intent explicit.

- [ ] **Step 1 (RED):** Update `queue.test.ts`: rename the I5 describe block's intent to "running (graduated AND enabled) pairs", keep existing drop assertions (a pair in the set is dropped), and add the new suggestion-keeping test that documents the facade semantics at the pure level:

```ts
it("keeps a graduated-but-NOT-enabled pair as a suggestion (warm-up)", () => {
  // The facade only puts graduated AND autonomy_enabled pairs in autonomyPairs.
  // A graduated-but-off pair is therefore absent from the set => kept as a suggestion.
  const autonomyPairs = new Set<string>(); // graduated, but autonomy_enabled=false => not running
  const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set(), autonomyPairs);
  expect(q).toHaveLength(1);
});
```

- [ ] **Step 2:** Run `npx vitest run app/lib/calibration/__tests__/queue.test.ts` — new test passes immediately (pure behavior already supports it); this task is mostly the facade + rename. Verify nothing regressed.
- [ ] **Step 3 (impl):** In `queue.server.ts`, rename the param `graduatedPairs` → `autonomyPairs` in both `buildActionQueue` and `inventoryOverCapAlertIds`; update the local `const isGraduated =` to `const isAutonomy =` and the comments to say "graduated AND merchant-enabled pairs run via autopilot; drop them — except over-cap". Behavior identical.
- [ ] **Step 4 (facade):** In `calderyn.server.ts` `queue.list`, change the graduated query to also select `autonomy_enabled` and filter to enabled:

```ts
// Pairs actually RUNNING autonomously = graduated AND merchant-enabled. Only these
// are dropped from the queue (no double actor). Graduated-but-off pairs stay as
// suggestions so the merchant can build a track record (Slice C warm-up).
supabase
  .from("pair_calibration")
  .select("detector_id, action_kind")
  .eq("shop_id", shopId)
  .eq("graduated", true)
  .eq("autonomy_enabled", true),
```

Rename the local `graduatedPairs` → `autonomyPairs`; pass it to `inventoryOverCapAlertIds` and `buildActionQueue`.

- [ ] **Step 5:** Run the queue test file + `npm run typecheck`. All pass.
- [ ] **Step 6:** Commit: `feat(queue): keep graduated-but-not-enabled pairs as suggestions`

---

### Task 4: `setPairAutonomy` flips `autonomy_enabled`

**Files:**
- Modify: `app/lib/calibration/live-engine.server.ts` (`setPairAutonomy`)
- Test: `app/lib/calibration/__tests__/live-engine.test.ts`

**Interfaces:**
- Produces: `setPairAutonomy(shop, detector, action, enabled, sb)` writes `{ autonomy_enabled: enabled }`. Client method `setFeatureAutonomy(detector, action, enabled)` signature unchanged.

- [ ] **Step 1 (RED):** Replace the two `setPairAutonomy` tests:

```ts
describe("setPairAutonomy", () => {
  it("enabling sets autonomy_enabled=true", async () => {
    const cap: { payload?: Record<string, unknown> } = {};
    const r = await setPairAutonomy("shop-1", "campaign_below_breakeven", "pause_campaign", true, mockSb(cap));
    expect(r.ok).toBe(true);
    expect(cap.payload?.autonomy_enabled).toBe(true);
  });
  it("disabling sets autonomy_enabled=false and does not mute the pair", async () => {
    const cap: { payload?: Record<string, unknown> } = {};
    const r = await setPairAutonomy("shop-1", "campaign_below_breakeven", "pause_campaign", false, mockSb(cap));
    expect(r.ok).toBe(true);
    expect(cap.payload?.autonomy_enabled).toBe(false);
    expect(cap.payload?.merchant_disabled).toBeUndefined();
    expect(cap.payload?.graduated).toBeUndefined();
  });
});
```

- [ ] **Step 2:** Run the file — new tests FAIL (current code writes merchant_disabled/graduated).
- [ ] **Step 3 (GREEN):** Rewrite `setPairAutonomy` body:

```ts
const { error } = await sb
  .from("pair_calibration")
  .update({ autonomy_enabled: enabled, updated_at: new Date().toISOString() })
  .eq("shop_id", shopId)
  .eq("detector_id", detectorId)
  .eq("action_kind", actionKind);
return { ok: !error };
```

Drop the `NO_BRAINER`/`shipped` branch and its now-unused import if nothing else uses it (it does — keep the import; only remove the `shipped` local + graduated write). Update the function doc comment to describe `autonomy_enabled`.

- [ ] **Step 4:** Run the file — pass.
- [ ] **Step 5:** Commit: `feat(calibration): toggle flips autonomy_enabled (re-suggestable when off)`

---

### Task 5: Live Engine `enabled` from `autonomy_enabled` + `recommended`

**Files:**
- Modify: `app/lib/calibration/live-engine.server.ts` (`PairRow`, `LiveEngineFeature`, `aggregateLiveEngine`, `liveEngineSummary` select)
- Test: `app/lib/calibration/__tests__/live-engine.test.ts`

**Interfaces:**
- Produces: `LiveEngineFeature.enabled = autonomy_enabled`; new `LiveEngineFeature.recommended: boolean` = `graduated && !autonomy_enabled && !merchant_disabled && cleanApprovals >= MIN_APPROVALS[actionTier(action)]`.

- [ ] **Step 1 (RED):** Update existing `aggregateLiveEngine` fixtures so `enabled` derives from `autonomy_enabled`: add `autonomy_enabled: true` to pairs that expect `enabled:true` (the "aggregates ..." test's f1; the "graduated pairs that have not acted" pair; the sort/name tests). For f2 (expects enabled:false) leave `autonomy_enabled` absent. Add new `recommended` tests:

```ts
it("recommends a graduated, not-enabled, not-muted pair with a track record", () => {
  const out = aggregateLiveEngine(
    [{ detector_id: "campaign_below_breakeven", action_kind: "pause_campaign",
       graduated: true, autonomy_enabled: false, merchant_disabled: false, clean_approvals: 3 }],
    [], NOW);
  expect(out.features[0].enabled).toBe(false);
  expect(out.features[0].recommended).toBe(true);
});
it("does NOT recommend before the track-record bar", () => {
  const out = aggregateLiveEngine(
    [{ detector_id: "campaign_below_breakeven", action_kind: "pause_campaign",
       graduated: true, autonomy_enabled: false, merchant_disabled: false, clean_approvals: 2 }],
    [], NOW);
  expect(out.features[0].recommended).toBe(false);
});
it("does NOT recommend an already-enabled pair", () => {
  const out = aggregateLiveEngine(
    [{ detector_id: "campaign_below_breakeven", action_kind: "pause_campaign",
       graduated: true, autonomy_enabled: true, merchant_disabled: false, clean_approvals: 9 }],
    [], NOW);
  expect(out.features[0].recommended).toBe(false);
});
it("does NOT recommend a muted pair", () => {
  const out = aggregateLiveEngine(
    [{ detector_id: "campaign_below_breakeven", action_kind: "pause_campaign",
       graduated: true, autonomy_enabled: false, merchant_disabled: true, clean_approvals: 9 }],
    [], NOW);
  expect(out.features[0].recommended).toBe(false);
});
```

- [ ] **Step 2:** Run the file — new tests + adjusted `enabled` assertions FAIL.
- [ ] **Step 3 (GREEN):** In `live-engine.server.ts`:
  - Import `MIN_APPROVALS` from `./graduation` and `actionTier` from `./confidence` (NO_BRAINER already imported).
  - `PairRow`: add `autonomy_enabled?: boolean | null; clean_approvals?: number | null;` (clean_approvals already present), keep `graduated`, `merchant_disabled`.
  - `LiveEngineFeature`: add `recommended: boolean;`.
  - In `aggregateLiveEngine` feature map: `enabled: Boolean(p.autonomy_enabled)`, and:

```ts
const tier = actionTier(actionKind);
const recommended =
  Boolean(p.graduated) &&
  !Boolean(p.autonomy_enabled) &&
  !Boolean(p.merchant_disabled) &&
  Number(p.clean_approvals ?? 0) >= MIN_APPROVALS[tier];
```

  - `liveEngineSummary` select: add `autonomy_enabled` (and `graduated` already selected) to the `pair_calibration` `.select(...)`.

- [ ] **Step 4:** Run the file — pass.
- [ ] **Step 5:** Commit: `feat(live-engine): enabled reflects autonomy_enabled; add recommended`

---

### Task 6: Thread `recommended` to the VM + render "Ready to turn on" chip (both surfaces)

**Files:**
- Modify: `app/lib/calibration/live-engine-types.ts` (`LiveEngineFeatureVM.recommended`)
- Modify: `app/lib/calibration/live-engine-page.server.ts` (map `recommended`)
- Modify: `app/routes/app.engine.tsx` (embedded FeatureRow chip)
- Modify: `app/components/dashboard/screens/LiveEngine.tsx` (dashboard FeatureRow chip)
- Modify: `app/components/calderyn/calderyn.css` (`.engx-feat-recommend`)
- Modify: `app/styles/dashboard.css` (`.cd-le-feat-recommend`)

**Interfaces:**
- Consumes: `LiveEngineFeature.recommended`.
- Produces: `LiveEngineFeatureVM.recommended: boolean`.

- [ ] **Step 1:** `live-engine-types.ts`: add `recommended: boolean;` to `LiveEngineFeatureVM` (after `proven`).
- [ ] **Step 2:** `live-engine-page.server.ts`: in the features map add `recommended: f.recommended,` to the returned object.
- [ ] **Step 3 (embedded):** In `app.engine.tsx` FeatureRow namerow, show a recommend chip when off-and-recommended, and suppress the progress text then:

```tsx
{active ? (
  <span className="engx-feat-active"><span className="engx-live-dot engx-live-dot--sm" />ACTIVE</span>
) : f.recommended && !on ? (
  <span className="engx-feat-recommend">Ready to turn on</span>
) : null}
```
and change the progress guard to `{!f.proven && !f.recommended && (...)}`.

- [ ] **Step 4 (dashboard):** Mirror in `LiveEngine.tsx` FeatureRow with `cd-le-feat-recommend` and the same `!f.proven && !f.recommended` guard.
- [ ] **Step 5 (CSS):** Add to `calderyn.css`:

```css
.engx-feat-recommend { display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 8px; border-radius: 6px; background: #fff4e0; font-size: 10px; font-weight: 700; color: #9a6a00; }
```
and to `dashboard.css` (use existing vars; fall back to amber if no amber var):

```css
.cd-le-feat-recommend { display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 8px; border-radius: 6px; background: var(--amber-bg, #fff4e0); color: var(--amber, #9a6a00); font-size: 10px; font-weight: 700; }
```

- [ ] **Step 6:** `npm run typecheck` + `npm run lint` on touched files. Commit: `feat(live-engine): "Ready to turn on" recommendation chip (both surfaces)`

---

### Task 7: Full gate + verification

- [ ] **Step 1:** `npm run typecheck` → 0
- [ ] **Step 2:** `npm run lint` → 0 (no warnings on touched files)
- [ ] **Step 3:** `npm run test` → all green (calibration + dashboard write-routes + everything)
- [ ] **Step 4:** `npm run build` → 0 (includes verify-client-bundle)
- [ ] **Step 5:** `/code-review` on the working tree; resolve blockers.
- [ ] **Step 6:** Commit any review fixes; present results to the user; then apply the migration to prod Supabase (`ajgrmnvzxfxxlwrxcgnu`) via supabase MCP.

## Self-Review

- Spec coverage: migration (T1), chokepoint gate (T2), queue suggestions (T3), toggle (T4), enabled+recommended (T5), UI both surfaces (T6), seeds = no change (covered by column default, no task needed), gate (T7). ✓
- `graduationVerdict` and its tests (`graduation.test.ts`, `graduation-outcomes.test.ts`, `task8-invariants.test.ts` graduationVerdict parts) are intentionally untouched. ✓
- Type consistency: `recommended` is `boolean` in `LiveEngineFeature`, `LiveEngineFeatureVM`; `autonomyPairs` is `Set<string>` everywhere. ✓
- Parity: shared layer mirrors automatically; only the two FeatureRows + 2 CSS files are surface-specific. ✓
