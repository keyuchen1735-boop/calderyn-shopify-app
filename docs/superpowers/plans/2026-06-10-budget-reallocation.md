# Budget Reallocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ad spend between integrations (e.g. $5/day from a Google Ads campaign to a Meta campaign) as one composite, audited, undoable `reallocate_budget` action — triggerable from the campaigns UI, the MCP assistant, and autopilot.

**Architecture:** New orchestrator `executeReallocation` mirrors `executeAction` (idempotency → ownership → adapter calls → ONE append-only `action_audit` row). Source budget is reduced first (fails safe); a permanent destination failure compensates by restoring the source. Transient destination failures park `retrying` with dest-side replay params so the existing single-adapter retry drain resumes them. Guardrails gain dual-campaign cooldown; a grade-driven suggestion helper is shared by the UI and autopilot.

**Tech Stack:** Remix (Vite) + TypeScript strict, Supabase (PostgREST), vitest with mocked supabase chains + mocked platform adapters, Polaris UI.

**Branch:** `feat/budget-reallocation` (already created; spec committed at `docs/superpowers/specs/2026-06-10-budget-reallocation-design.md`).

**Spec deviations decided during planning (surface, don't average — rule 7):**
1. The route returns `json()` + toast (not `redirect()`) after success — matching every existing intent in `app.campaigns._index.tsx`; idempotency keys already guard double-submit. Convention beats the CLAUDE.md redirect note here (rule 11).
2. Adding `reallocate_budget` to `DETECTOR_TO_ACTIONS.ad_tax_overload` (needed for the assistant's propose gate) ALSO surfaces a button on `app.alerts.$id.tsx`, which renders one button per allowed kind. That page gets a minimal special-case: the reallocate button navigates to `/app/campaigns` instead of opening the inline confirm (full alert-page execution is out of v1 scope).
3. Grade text in the modal's option labels appears only on the two suggested options (the loader doesn't grade every campaign — Meta live rows use external ids and a full grade join isn't worth it for v1).

---

## File map

| File | Change |
|---|---|
| `supabase/migrations/20260610120000_action_kind_reallocate_budget.sql` | Create — enum value |
| `app/lib/types.ts` | Modify — `ActionKind` + `"reallocate_budget"` |
| `app/lib/labels.ts` | Modify — `ACTION_LABELS`, `ACTION_VERBS`, `DETECTOR_TO_ACTIONS.ad_tax_overload` |
| `app/lib/assistant/tools.server.ts` | Modify — `propose_action` enum |
| `app/lib/actions/reallocate.server.ts` | Create — orchestrator |
| `app/lib/actions/__tests__/reallocate.test.ts` | Create |
| `app/lib/actions/retry.server.ts` | Modify — replay entry + compensator registry |
| `app/lib/actions/__tests__/retry.test.ts` | Modify — append describe block |
| `app/lib/actions/undo.server.ts` | Modify — reallocate branch |
| `app/lib/actions/__tests__/undo.test.ts` | Modify — append tests |
| `app/lib/actions/guardrails.ts` | Modify — `GuardedKind`, dest cooldown, cut% |
| `app/lib/actions/__tests__/guardrails.test.ts` | Modify — append tests |
| `app/lib/actions/guardrails.server.ts` | Modify — `destCampaignId`, `.or()` cooldown lookups |
| `app/lib/actions/__tests__/guardrails-server.test.ts` | Modify — chain `.or` stub + tests |
| `app/lib/actions/reallocation-suggest.server.ts` | Create — suggestion helper |
| `app/lib/actions/__tests__/reallocation-suggest.test.ts` | Create |
| `app/lib/actions/autopilot.server.ts` | Modify — reallocate-first for budget detectors |
| `app/lib/actions/__tests__/autopilot.test.ts` | Modify — mocks + tests |
| `app/routes/app.campaigns._index.tsx` | Modify — loader suggestion, `intent=reallocate`, `ReallocateBudgetModal`, triggers |
| `app/routes/__tests__/campaigns-action.test.ts` | Modify — reallocate action tests |
| `app/routes/app.alerts.$id.tsx` | Modify — reallocate button navigates to campaigns |

Run all tests with: `npm test` (vitest run). Single file: `npx vitest run app/lib/actions/__tests__/reallocate.test.ts`.

---

### Task 1: Enum migration + kind plumbing

**Files:**
- Create: `supabase/migrations/20260610120000_action_kind_reallocate_budget.sql`
- Modify: `app/lib/types.ts` (ActionKind union, ~line 5)
- Modify: `app/lib/labels.ts` (~lines 38–68)
- Modify: `app/lib/assistant/tools.server.ts` (~line 89 enum)

- [ ] **Step 1.1: Write the migration**

```sql
-- The reallocate_budget composite action (move N cents/day of budget from one
-- campaign to another, possibly cross-platform) needs its action_kind value.
-- NOTE: distinct from the existing reallocate_inventory (inventory-side).

alter type public.action_kind add value if not exists 'reallocate_budget';
```

- [ ] **Step 1.2: Add the kind to `ActionKind` in `app/lib/types.ts`**

```ts
export type ActionKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "reallocate_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "snooze_alert";
```

(Note: the current union in the file may lack `resume_campaign`; if so leave that as-is and ONLY insert `"reallocate_budget"` after `"reduce_campaign_budget"` — surgical change, rule 3.)

- [ ] **Step 1.3: Add label entries in `app/lib/labels.ts`**

In `ACTION_LABELS` add: `reallocate_budget: "Reallocate budget",`
In `ACTION_VERBS` add: `reallocate_budget: "Reallocated budget",`
Change `DETECTOR_TO_ACTIONS.ad_tax_overload` to:

```ts
  ad_tax_overload: ["reallocate_budget", "reduce_campaign_budget", "pause_campaign", "snooze_alert"],
```

- [ ] **Step 1.4: Add the kind to the `propose_action` enum in `app/lib/assistant/tools.server.ts`**

In the `action_kind` enum array (~line 89), insert `"reallocate_budget",` after `"reduce_campaign_budget",`.

- [ ] **Step 1.5: Typecheck + run the suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0 (the `Record<ActionKind, string>` maps force-verified the label entries). Tests all pass — `app.alerts.$id.tsx` may now render a reallocate button for ad_tax_overload alerts; that is addressed in Task 10. If any test asserts the exact ad_tax_overload action list, update its expectation to the new array.

- [ ] **Step 1.6: Commit**

```bash
git add supabase/migrations/20260610120000_action_kind_reallocate_budget.sql app/lib/types.ts app/lib/labels.ts app/lib/assistant/tools.server.ts
git commit -m "lib: add reallocate_budget action kind (enum migration + labels + propose gate)"
```

---

### Task 2: Orchestrator — happy path + validation

**Files:**
- Create: `app/lib/actions/reallocate.server.ts`
- Create: `app/lib/actions/__tests__/reallocate.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `app/lib/actions/__tests__/reallocate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeReallocation } from "../reallocate.server";
import { ActionError } from "../../ads/actions";
import type { SupabaseClient } from "@supabase/supabase-js";

const { adapters, actionAdapterForShop } = vi.hoisted(() => {
  const mk = (platform: string) => ({
    platform,
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    setDailyBudget: vi.fn(async () => {}),
    getState: vi.fn(),
  });
  const adapters = { google: mk("google"), meta: mk("meta") };
  const actionAdapterForShop = vi.fn(
    async (_shop: string, platform: string) =>
      adapters[platform as keyof typeof adapters] ?? null,
  );
  return { adapters, actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

const SHOP = "00000000-0000-0000-0000-000000000010";
const SRC_ID = "11111111-1111-1111-1111-111111111111";
const DST_ID = "22222222-2222-2222-2222-222222222222";

// Fake supabase mirroring execute.test.ts, with a QUEUE of campaign rows —
// the orchestrator loads source first, then dest.
function fakeSb(opts: {
  idempotent?: { audit_id: string };
  campaigns?: Array<Record<string, unknown> | null>;
  priorOutcome?: string;
}) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  const campQueue = [...(opts.campaigns ?? [])];
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: campQueue.shift() ?? null, error: null };
      if (table === "action_audit") return { data: { id: "aud1", outcome: opts.priorOutcome ?? "succeeded" }, error: null };
      return { data: null, error: null };
    });
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const SRC = { id: SRC_ID, shop_id: SHOP, external_id: "g-1", platform: "google", status: "active", daily_budget_cents: 2000 };
const DST = { id: DST_ID, shop_id: SHOP, external_id: "m-1", platform: "meta", status: "active", daily_budget_cents: 1000 };

const input = {
  alertId: null,
  sourceCampaignId: SRC_ID,
  destCampaignId: DST_ID,
  amountCents: 500,
  idempotencyKey: "rk1",
};

function auditRow(calls: { inserts: Array<{ table: string; rows: unknown }> }) {
  return calls.inserts.find((i) => i.table === "action_audit")?.rows as Record<string, unknown>;
}

describe("executeReallocation · happy path + validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reduces source then increases dest and writes ONE two-sided audit row", async () => {
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("succeeded");
    expect(adapters.google.setDailyBudget).toHaveBeenCalledWith("g-1", 1500);
    expect(adapters.meta.setDailyBudget).toHaveBeenCalledWith("m-1", 1500);
    // Ordering: source reduce strictly before dest increase (fails safe).
    expect(adapters.google.setDailyBudget.mock.invocationCallOrder[0]).toBeLessThan(
      adapters.meta.setDailyBudget.mock.invocationCallOrder[0],
    );
    const audit = auditRow(calls);
    expect(audit).toMatchObject({
      shop_id: SHOP,
      action_kind: "reallocate_budget",
      outcome: "succeeded",
      pre_state: { source: { daily_budget_cents: 2000 }, dest: { daily_budget_cents: 1000 } },
      post_state: { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
    });
    expect(audit.params).toMatchObject({
      campaign_id: SRC_ID, // source-side, so existing cooldown lookups match
      source_campaign_id: SRC_ID,
      source_external_id: "g-1",
      source_platform: "google",
      source_prev_budget_cents: 2000,
      source_new_budget_cents: 1500,
      dest_campaign_id: DST_ID,
      dest_external_id: "m-1",
      dest_platform: "meta",
      dest_new_budget_cents: 1500,
      amount_cents: 500,
      // Dest-side replay fields for the single-adapter retry drain:
      external_id: "m-1",
      platform: "meta",
      daily_budget_cents: 1500,
      step: "increase_dest",
    });
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("short-circuits on a used idempotency key and reports the REAL prior outcome", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaigns: [SRC, DST], priorOutcome: "retrying" });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("retrying");
    expect(adapters.google.setDailyBudget).not.toHaveBeenCalled();
    expect(adapters.meta.setDailyBudget).not.toHaveBeenCalled();
  });

  it("rejects a source campaign that does not belong to the shop", async () => {
    const { sb } = fakeSb({ campaigns: [null, DST] });
    await expect(executeReallocation(SHOP, input, sb)).rejects.toThrow(/not found|ownership/i);
  });

  it("rejects a dest campaign that does not belong to the shop", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, null] });
    await expect(executeReallocation(SHOP, input, sb)).rejects.toThrow(/not found|ownership/i);
  });

  it("rejects source === dest", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, SRC] });
    await expect(
      executeReallocation(SHOP, { ...input, destCampaignId: SRC_ID }, sb),
    ).rejects.toThrow(/different campaigns/i);
  });

  it("rejects a non-positive amount", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, DST] });
    await expect(executeReallocation(SHOP, { ...input, amountCents: 0 }, sb)).rejects.toThrow(/positive/i);
  });

  it("rejects when either campaign has no daily budget", async () => {
    const { sb } = fakeSb({ campaigns: [{ ...SRC, daily_budget_cents: null }, DST] });
    await expect(executeReallocation(SHOP, input, sb)).rejects.toThrow(/daily budget/i);
  });

  it("rejects an amount that would empty the source budget", async () => {
    const { sb } = fakeSb({ campaigns: [SRC, DST] });
    await expect(executeReallocation(SHOP, { ...input, amountCents: 2000 }, sb)).rejects.toThrow(/above zero/i);
  });

  it("records the actor on the audit row", async () => {
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    await executeReallocation(SHOP, { ...input, actor: "autopilot" }, sb);
    expect(auditRow(calls).actor_user_id).toBe("autopilot");
  });
});
```

- [ ] **Step 2.2: Run to verify failure**

Run: `npx vitest run app/lib/actions/__tests__/reallocate.test.ts`
Expected: FAIL — `Cannot find module '../reallocate.server'` (or equivalent).

- [ ] **Step 2.3: Implement the orchestrator**

Create `app/lib/actions/reallocate.server.ts`:

```ts
// Execute a budget reallocation: move N cents/day of daily budget from one
// campaign to another, possibly across platforms. Composite two-step action
// with ONE append-only action_audit row (one row per merchant intent).
// Ordering fails safe: the source is reduced FIRST, so any failure leaves the
// merchant under-spending, never over-spending. A permanent failure on the
// destination increase compensates by restoring the source budget (visibly);
// a transient destination failure parks `retrying` with DEST-side replay
// params so the single-adapter retry drain (retry.server.ts) can resume it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { isRetriableFailure } from "../ads/actions";
import { actionAdapterForShop } from "../ads/action-registry.server";
import type { ExecutedAudit } from "./execute.server";

export interface ReallocateInput {
  alertId: string | null;
  sourceCampaignId: string; // ad_campaign_dim uuid
  destCampaignId: string; // ad_campaign_dim uuid
  amountCents: number; // daily-budget cents moved source -> dest
  idempotencyKey: string;
  actor?: string;
}

interface CampaignRow {
  id: string;
  external_id: string;
  platform: string;
  status: string;
  daily_budget_cents: number | null;
}

async function loadOwnedCampaign(
  sb: SupabaseClient,
  shopId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id, shop_id, external_id, platform, status, daily_budget_cents")
    .eq("id", campaignId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  return (data as CampaignRow | null) ?? null;
}

export async function executeReallocation(
  shopId: string,
  input: ReallocateInput,
  sb: SupabaseClient,
): Promise<ExecutedAudit> {
  // 1. Idempotency — same contract as executeAction: a replayed key returns
  // the REAL prior outcome (may still be `retrying` or `failed`), never a
  // hardcoded success (rule 12).
  const { data: prior, error: pErr } = await sb
    .from("action_idempotency")
    .select("audit_id")
    .eq("shop_id", shopId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (pErr) throw pErr;
  if (prior?.audit_id) {
    const { data: prevAudit } = await sb
      .from("action_audit")
      .select("outcome")
      .eq("id", prior.audit_id)
      .maybeSingle();
    const priorOutcome = (prevAudit?.outcome as ExecutedAudit["outcome"]) ?? "succeeded";
    return { id: String(prior.audit_id), outcome: priorOutcome };
  }

  // 2. Validation + ownership. Failures THROW with no audit row — like the
  // executeAction ownership guard, nothing was attempted on any platform.
  if (input.sourceCampaignId === input.destCampaignId) {
    throw new Error("source and destination must be different campaigns");
  }
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    throw new Error("amount must be a positive number of cents");
  }
  const source = await loadOwnedCampaign(sb, shopId, input.sourceCampaignId);
  if (!source) {
    throw new Error(`campaign ${input.sourceCampaignId} not found for shop (ownership check failed)`);
  }
  const dest = await loadOwnedCampaign(sb, shopId, input.destCampaignId);
  if (!dest) {
    throw new Error(`campaign ${input.destCampaignId} not found for shop (ownership check failed)`);
  }
  if (source.daily_budget_cents == null || dest.daily_budget_cents == null) {
    throw new Error("both campaigns must have a daily budget");
  }
  if (input.amountCents >= source.daily_budget_cents) {
    throw new Error("amount must leave the source budget above zero (pause the campaign instead)");
  }

  const sourceNewCents = source.daily_budget_cents - input.amountCents;
  const destNewCents = dest.daily_budget_cents + input.amountCents;
  const preState = {
    source: { daily_budget_cents: source.daily_budget_cents },
    dest: { daily_budget_cents: dest.daily_budget_cents },
  };
  const postState = {
    source: { daily_budget_cents: sourceNewCents },
    dest: { daily_budget_cents: destNewCents },
  };

  // 3. Resolve BOTH adapters before touching either platform — a missing
  // integration on either side fails fast with zero side effects.
  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let step: "reduce_source" | "increase_dest" = "reduce_source";
  let compensation: "succeeded" | "failed" | undefined;

  const sourceAdapter = await actionAdapterForShop(shopId, source.platform as Platform);
  const destAdapter =
    dest.platform === source.platform
      ? sourceAdapter
      : await actionAdapterForShop(shopId, dest.platform as Platform);

  if (!sourceAdapter) {
    outcome = "failed";
    lastError = `${source.platform} not connected`;
  } else if (!destAdapter) {
    outcome = "failed";
    lastError = `${dest.platform} not connected`;
  } else {
    // 4a. Reduce source FIRST. Any failure here is terminal: nothing changed
    // on either platform, and the single-adapter retry drain can only resume
    // the dest step — so we fail visibly and let the merchant retry.
    try {
      await sourceAdapter.setDailyBudget(source.external_id, sourceNewCents);
      step = "increase_dest";
    } catch (err) {
      outcome = "failed";
      lastError = err instanceof Error ? err.message : String(err);
    }
    // 4b. Increase dest. Transient → park for the retry cron; permanent →
    // compensate by restoring the source budget, recording the result.
    if (outcome === "succeeded") {
      try {
        await destAdapter.setDailyBudget(dest.external_id, destNewCents);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (isRetriableFailure(err)) {
          outcome = "retrying";
        } else {
          outcome = "failed";
          try {
            await sourceAdapter.setDailyBudget(source.external_id, source.daily_budget_cents);
            compensation = "succeeded";
          } catch (cErr) {
            compensation = "failed";
            const cMsg = cErr instanceof Error ? cErr.message : String(cErr);
            lastError = `${lastError}; compensation failed: ${cMsg}`;
          }
        }
      }
    }
  }

  // 5. ONE append-only audit row + idempotency. Replay fields (external_id,
  // platform, daily_budget_cents) are DEST-side so the retry drain resumes
  // the increase step with its existing single-adapter shape.
  const params: Record<string, unknown> = {
    campaign_id: input.sourceCampaignId, // source side — existing cooldown lookups match it
    source_campaign_id: input.sourceCampaignId,
    source_external_id: source.external_id,
    source_platform: source.platform,
    source_prev_budget_cents: source.daily_budget_cents,
    source_new_budget_cents: sourceNewCents,
    dest_campaign_id: input.destCampaignId,
    dest_external_id: dest.external_id,
    dest_platform: dest.platform,
    dest_new_budget_cents: destNewCents,
    amount_cents: input.amountCents,
    external_id: dest.external_id,
    platform: dest.platform,
    daily_budget_cents: destNewCents,
    step,
  };
  if (compensation) params.compensation = compensation;

  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      alert_id: input.alertId,
      action_kind: "reallocate_budget",
      params,
      outcome,
      // A parked `retrying` row has already consumed its first attempt.
      attempts: outcome === "retrying" ? 1 : 0,
      pre_state: preState,
      post_state: outcome === "succeeded" ? postState : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  const auditId = String(ins.id);

  await sb
    .from("action_idempotency")
    .insert({ shop_id: shopId, idempotency_key: input.idempotencyKey, audit_id: auditId });

  return { id: auditId, outcome };
}
```

Also export `ExecutedAudit` from `app/lib/actions/execute.server.ts` if it is not already exported (it is — `export interface ExecutedAudit`).

- [ ] **Step 2.4: Run to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/reallocate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 2.5: Commit**

```bash
git add app/lib/actions/reallocate.server.ts app/lib/actions/__tests__/reallocate.test.ts
git commit -m "lib/actions: executeReallocation orchestrator — happy path + validation"
```

---

### Task 3: Orchestrator — failure paths + compensation

**Files:**
- Modify: `app/lib/actions/__tests__/reallocate.test.ts` (append describe block)
- Modify (only if a test exposes a gap): `app/lib/actions/reallocate.server.ts`

The implementation from Task 2 already contains the failure logic; this task locks it in with tests. TDD note: these tests were intentionally deferred so Task 2 stayed bite-sized — run them BEFORE assuming the logic is right.

- [ ] **Step 3.1: Append the failure-path tests**

Append to `app/lib/actions/__tests__/reallocate.test.ts`:

```ts
describe("executeReallocation · failure paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("source-step failure is TERMINAL failed (not parked), dest untouched", async () => {
    adapters.google.setDailyBudget.mockRejectedValueOnce(new Error("Google API 503"));
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    expect(adapters.meta.setDailyBudget).not.toHaveBeenCalled();
    const audit = auditRow(calls);
    expect(audit).toMatchObject({ outcome: "failed", post_state: null });
    expect((audit.params as Record<string, unknown>).step).toBe("reduce_source");
    expect(String(audit.last_error)).toMatch(/503/);
  });

  it("dest-step transient failure parks retrying with dest replay params; source NOT restored", async () => {
    adapters.meta.setDailyBudget.mockRejectedValueOnce(new Error("Meta API 503"));
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("retrying");
    // Source was reduced exactly once — no compensation for a parked retry.
    expect(adapters.google.setDailyBudget).toHaveBeenCalledTimes(1);
    const audit = auditRow(calls);
    expect(audit).toMatchObject({ outcome: "retrying", attempts: 1, post_state: null });
    expect(audit.params).toMatchObject({
      step: "increase_dest",
      external_id: "m-1",
      platform: "meta",
      daily_budget_cents: 1500,
    });
    expect((audit.params as Record<string, unknown>).compensation).toBeUndefined();
  });

  it("dest-step PERMANENT failure compensates: source restored, visibly recorded", async () => {
    adapters.meta.setDailyBudget.mockRejectedValueOnce(
      new ActionError("meta", "invalid budget param", { retriable: false }),
    );
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    // Source reduced (2000→1500), then restored (→2000).
    expect(adapters.google.setDailyBudget).toHaveBeenNthCalledWith(1, "g-1", 1500);
    expect(adapters.google.setDailyBudget).toHaveBeenNthCalledWith(2, "g-1", 2000);
    const audit = auditRow(calls);
    expect((audit.params as Record<string, unknown>).compensation).toBe("succeeded");
  });

  it("failed compensation is loudly visible (rule 12)", async () => {
    adapters.meta.setDailyBudget.mockRejectedValueOnce(
      new ActionError("meta", "invalid budget param", { retriable: false }),
    );
    adapters.google.setDailyBudget
      .mockResolvedValueOnce(undefined) // step 1 reduce succeeds
      .mockRejectedValueOnce(new Error("Google API down")); // compensation fails
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    const audit = auditRow(calls);
    expect((audit.params as Record<string, unknown>).compensation).toBe("failed");
    expect(String(audit.last_error)).toMatch(/compensation failed/i);
    expect(String(audit.last_error)).toMatch(/invalid budget param/i);
  });

  it("fails fast with ZERO platform calls when the source platform is not connected", async () => {
    actionAdapterForShop.mockResolvedValueOnce(null); // source resolve
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    expect(adapters.google.setDailyBudget).not.toHaveBeenCalled();
    expect(adapters.meta.setDailyBudget).not.toHaveBeenCalled();
    expect(String(auditRow(calls).last_error)).toMatch(/google not connected/i);
  });

  it("fails fast with ZERO platform calls when the dest platform is not connected", async () => {
    actionAdapterForShop
      .mockResolvedValueOnce(adapters.google) // source resolve
      .mockResolvedValueOnce(null); // dest resolve
    const { sb, calls } = fakeSb({ campaigns: [SRC, DST] });
    const res = await executeReallocation(SHOP, input, sb);
    expect(res.outcome).toBe("failed");
    expect(adapters.google.setDailyBudget).not.toHaveBeenCalled();
    expect(String(auditRow(calls).last_error)).toMatch(/meta not connected/i);
  });
});
```

- [ ] **Step 3.2: Run the file**

Run: `npx vitest run app/lib/actions/__tests__/reallocate.test.ts`
Expected: PASS (15 tests). If any failure-path test fails, fix `reallocate.server.ts` (the logic in Task 2 Step 2.3 is the reference) — do not weaken the test.

- [ ] **Step 3.3: Commit**

```bash
git add app/lib/actions/__tests__/reallocate.test.ts app/lib/actions/reallocate.server.ts
git commit -m "lib/actions: reallocation failure paths — terminal source fail, dest park, compensation"
```

---

### Task 4: Retry drain — replay entry + compensator

**Files:**
- Modify: `app/lib/actions/retry.server.ts`
- Modify: `app/lib/actions/__tests__/retry.test.ts` (append a describe block)

- [ ] **Step 4.1: Write the failing tests**

Append to `app/lib/actions/__tests__/retry.test.ts` (imports for `drainActionRetries`, `vi`, `ActionError`, `SupabaseClient` already exist at the top of the file — reuse them; add any that are missing):

```ts
describe("drainActionRetries · reallocate_budget", () => {
  const SHOP2 = "00000000-0000-0000-0000-000000000099";

  const reallocParams = {
    external_id: "m-1",
    platform: "meta",
    daily_budget_cents: 1500,
    source_external_id: "g-1",
    source_platform: "google",
    source_prev_budget_cents: 2000,
    source_new_budget_cents: 1500,
    step: "increase_dest",
  };

  function mkAdapter(platform: string) {
    return {
      platform,
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      setDailyBudget: vi.fn(async () => {}),
      getState: vi.fn(),
    };
  }

  function fakeDrainSb(row: Record<string, unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.lt = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.update = vi.fn((u: Record<string, unknown>) => {
        updates.push(u);
        return chain;
      });
      chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: [row], error: null });
      return chain;
    }
    return {
      sb: { from: vi.fn(() => builder()) } as unknown as SupabaseClient,
      updates,
    };
  }

  it("replays ONLY the dest increase and writes a two-sided post_state", async () => {
    const meta = mkAdapter("meta");
    const google = mkAdapter("google");
    const { sb, updates } = fakeDrainSb({
      id: "r1", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    const r = await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect(meta.setDailyBudget).toHaveBeenCalledWith("m-1", 1500);
    expect(google.setDailyBudget).not.toHaveBeenCalled();
    expect(r.succeeded).toBe(1);
    expect(updates[0]).toMatchObject({
      outcome: "succeeded",
      post_state: { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
    });
  });

  it("compensates (restores source) when the parked row fails TERMINALLY", async () => {
    const meta = mkAdapter("meta");
    meta.setDailyBudget.mockRejectedValue(new ActionError("meta", "invalid budget", { retriable: false }));
    const google = mkAdapter("google");
    const { sb, updates } = fakeDrainSb({
      id: "r2", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    const r = await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect(r.failed).toBe(1);
    expect(google.setDailyBudget).toHaveBeenCalledWith("g-1", 2000);
    expect(updates[0].outcome).toBe("failed");
    expect((updates[0].params as Record<string, unknown>).compensation).toBe("succeeded");
    expect(String(updates[0].last_error)).toMatch(/source budget restored/i);
  });

  it("records a FAILED compensation loudly (rule 12)", async () => {
    const meta = mkAdapter("meta");
    meta.setDailyBudget.mockRejectedValue(new ActionError("meta", "invalid budget", { retriable: false }));
    const google = mkAdapter("google");
    google.setDailyBudget.mockRejectedValue(new Error("Google down"));
    const { sb, updates } = fakeDrainSb({
      id: "r3", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect((updates[0].params as Record<string, unknown>).compensation).toBe("failed");
    expect(String(updates[0].last_error)).toMatch(/compensation failed/i);
  });

  it("does NOT compensate a still-transient failure (row re-parks)", async () => {
    const meta = mkAdapter("meta");
    meta.setDailyBudget.mockRejectedValue(new Error("Meta 503"));
    const google = mkAdapter("google");
    const { sb, updates } = fakeDrainSb({
      id: "r4", shop_id: SHOP2, action_kind: "reallocate_budget", attempts: 1,
      outcome: "retrying", completed_at: "2020-01-01T00:00:00Z", params: reallocParams,
    });
    const r = await drainActionRetries(sb, {
      resolveAdapter: async (_s, p) => (p === "meta" ? meta : google),
    });
    expect(r.retrying).toBe(1);
    expect(google.setDailyBudget).not.toHaveBeenCalled();
    expect(updates[0].outcome).toBe("retrying");
    expect(updates[0].params).toBeUndefined();
  });
});
```

If the existing file's imports lack `ActionError`, add it to the import from `"../../ads/actions"`.

- [ ] **Step 4.2: Run to verify failure**

Run: `npx vitest run app/lib/actions/__tests__/retry.test.ts`
Expected: the new describe block FAILS — no `reallocate_budget` replayer registered (rows are `skipped`, counts mismatch).

- [ ] **Step 4.3: Implement — registry entry, compensator registry, terminal hook**

In `app/lib/actions/retry.server.ts`:

(a) Extend `ReplayParams`:

```ts
/** The replay-relevant slice of an audit row's persisted `params`. */
export interface ReplayParams {
  external_id: string;
  platform: Platform;
  daily_budget_cents?: number | null;
  // reallocate_budget extras: dest-side replay is covered by the three fields
  // above (written dest-side at park time); these carry the source side for
  // post_state and terminal compensation.
  source_external_id?: string;
  source_platform?: Platform;
  source_prev_budget_cents?: number | null;
  source_new_budget_cents?: number | null;
}
```

(b) Add to `EXECUTOR_REGISTRY` (after `reduce_campaign_budget`):

```ts
  // Parked reallocations resume at the DEST-increase step only; the source
  // reduce already happened before the row was parked (reallocate.server.ts).
  reallocate_budget: async (adapter, p) => {
    await adapter.setDailyBudget(p.external_id, p.daily_budget_cents ?? 0);
    return {
      post_state: {
        source: { daily_budget_cents: p.source_new_budget_cents ?? null },
        dest: { daily_budget_cents: p.daily_budget_cents ?? null },
      },
    };
  },
```

(c) Add the compensator registry (below `EXECUTOR_REGISTRY`):

```ts
/**
 * Consulted ONLY on the terminal-failure path. A parked reallocation has
 * already reduced its source budget; if the dest increase fails for good,
 * restore the source rather than leaving the merchant silently under-spending.
 * The result is recorded on the row's params either way (rule 12).
 */
export type ActionCompensator = (
  resolveAdapter: (shopId: string, platform: Platform) => Promise<ActionAdapter | null>,
  shopId: string,
  params: ReplayParams,
) => Promise<{ compensation: "succeeded" | "failed"; note: string }>;

export const COMPENSATOR_REGISTRY: Record<string, ActionCompensator> = {
  reallocate_budget: async (resolveAdapter, shopId, p) => {
    try {
      if (!p.source_platform || !p.source_external_id) {
        throw new Error("missing source replay params");
      }
      const adapter = await resolveAdapter(shopId, p.source_platform);
      if (!adapter) throw new Error(`${p.source_platform} not connected`);
      await adapter.setDailyBudget(p.source_external_id, p.source_prev_budget_cents ?? 0);
      return { compensation: "succeeded", note: "source budget restored" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { compensation: "failed", note: `compensation failed: ${msg}` };
    }
  },
};
```

(d) In `drainActionRetries`, the failure branch of the update assembly currently reads:

```ts
      } else {
        update.outcome = terminal ? "failed" : "retrying";
        update.last_error = replayError;
      }
```

Replace with:

```ts
      } else {
        update.outcome = terminal ? "failed" : "retrying";
        update.last_error = replayError;
        if (terminal) {
          const compensate = COMPENSATOR_REGISTRY[raw.action_kind];
          if (compensate && raw.params) {
            const comp = await compensate(resolveAdapter, raw.shop_id, raw.params);
            update.params = { ...raw.params, compensation: comp.compensation };
            update.last_error = `${replayError}; ${comp.note}`;
          }
        }
      }
```

- [ ] **Step 4.4: Run to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/retry.test.ts`
Expected: PASS (all pre-existing tests plus the 4 new ones).

- [ ] **Step 4.5: Commit**

```bash
git add app/lib/actions/retry.server.ts app/lib/actions/__tests__/retry.test.ts
git commit -m "lib/actions: retry drain replays parked reallocations, compensates on terminal failure"
```

---

### Task 5: Undo — reallocate branch

**Files:**
- Modify: `app/lib/actions/undo.server.ts`
- Modify: `app/lib/actions/__tests__/undo.test.ts` (append tests)

- [ ] **Step 5.1: Write the failing tests**

Append to `app/lib/actions/__tests__/undo.test.ts`. The file already hoists an adapter mock for `../../ads/action-registry.server` in the execute.test.ts style — reuse its mocked `adapter`/`actionAdapterForShop` names (adjust ONLY the identifier names below if the file uses different ones; the assertions stay identical):

```ts
describe("undoAction · reallocate_budget", () => {
  const reallocAudit = {
    id: "audR",
    shop_id: SHOP,
    action_kind: "reallocate_budget",
    params: {
      source_campaign_id: "src-uuid",
      source_external_id: "g-1",
      source_platform: "google",
      dest_campaign_id: "dst-uuid",
      dest_external_id: "m-1",
      dest_platform: "meta",
      amount_cents: 500,
      external_id: "m-1",
      platform: "meta",
      daily_budget_cents: 1500,
    },
    pre_state: { source: { daily_budget_cents: 2000 }, dest: { daily_budget_cents: 1000 } },
    post_state: { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
  };

  function fakeUndoSb(orig: Record<string, unknown>) {
    const inserts: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: orig, error: null }));
      chain.insert = vi.fn((rows: Record<string, unknown>) => {
        inserts.push(rows);
        return chain;
      });
      chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
      return chain;
    }
    return { sb: { from: vi.fn(() => builder()) } as unknown as SupabaseClient, inserts };
  }

  it("restores BOTH budgets from pre_state, dest first (never over-spend mid-undo)", async () => {
    const { sb, inserts } = fakeUndoSb(reallocAudit);
    await undoAction(SHOP, "audR", sb);
    // dest back to 1000 BEFORE source back to 2000
    expect(adapter.setDailyBudget).toHaveBeenNthCalledWith(1, "m-1", 1000);
    expect(adapter.setDailyBudget).toHaveBeenNthCalledWith(2, "g-1", 2000);
    expect(inserts[0]).toMatchObject({
      action_kind: "reallocate_budget",
      undo_of: "audR",
      pre_state: reallocAudit.post_state,
      post_state: reallocAudit.pre_state,
      outcome: "succeeded",
    });
  });
});
```

- [ ] **Step 5.2: Run to verify failure**

Run: `npx vitest run app/lib/actions/__tests__/undo.test.ts`
Expected: FAIL — no `reallocate_budget` branch, `setDailyBudget` never called.

- [ ] **Step 5.3: Implement the branch**

In `app/lib/actions/undo.server.ts`, after the `reduce_campaign_budget` branch (line ~32), add:

```ts
  } else if (orig.action_kind === "reallocate_budget") {
    // Two-sided undo. `adapter` (resolved above from params.platform) IS the
    // dest adapter — replay params are written dest-side. Restore the dest
    // budget FIRST (reduce before increase: a mid-undo failure leaves the
    // merchant under-spending, never over-spending), then the source.
    const rp = (orig.params ?? {}) as {
      source_external_id?: string;
      source_platform?: string;
      dest_external_id?: string;
    };
    const rpre = (orig.pre_state ?? {}) as {
      source?: { daily_budget_cents?: number | null };
      dest?: { daily_budget_cents?: number | null };
    };
    if (rpre.dest?.daily_budget_cents != null) {
      await adapter.setDailyBudget(String(rp.dest_external_id ?? ""), rpre.dest.daily_budget_cents);
    }
    const srcPlatform = String(rp.source_platform ?? "") as Platform;
    const srcAdapter =
      srcPlatform === platform ? adapter : await actionAdapterForShop(shopId, srcPlatform);
    if (!srcAdapter) throw new Error(`${srcPlatform} not connected; cannot undo`);
    if (rpre.source?.daily_budget_cents != null) {
      await srcAdapter.setDailyBudget(String(rp.source_external_id ?? ""), rpre.source.daily_budget_cents);
    }
  }
```

(The existing single-campaign `pre`/`params` destructuring above the branch stays untouched — the reallocate branch reads its own shapes.)

- [ ] **Step 5.4: Run to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/undo.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Commit**

```bash
git add app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo.test.ts
git commit -m "lib/actions: undo restores both sides of a reallocation, dest first"
```

---

### Task 6: Guardrails — GuardedKind, dual cooldown, source cut cap

**Files:**
- Modify: `app/lib/actions/guardrails.ts`
- Modify: `app/lib/actions/guardrails.server.ts`
- Modify: `app/lib/actions/__tests__/guardrails.test.ts` (append)
- Modify: `app/lib/actions/__tests__/guardrails-server.test.ts` (chain `.or` stub + append)

- [ ] **Step 6.1: Write the failing pure-evaluator tests**

Append to `app/lib/actions/__tests__/guardrails.test.ts` (reuse the file's existing imports of `evaluateGuardrails` and types):

```ts
describe("evaluateGuardrails · reallocate_budget", () => {
  const cfg: AutopilotGuardrails = {
    enabled: true, dailyActionCap: 10, minSpendCents: 0, maxBudgetCutPct: 50,
    dollarCapCents: 100000, cooldownMinutes: 30, businessHoursOnly: false,
    businessHoursStartUtc: 0, businessHoursEndUtc: 0,
  };
  const base: GuardrailFacts = {
    kind: "reallocate_budget", dollarImpactCents: 500, campaignSpendCents: 50000,
    currentBudgetCents: 2000, newBudgetCents: 1500, todayAutopilotCount: 0,
    minutesSinceLastActionOnCampaign: null, minutesSinceLastActionOnDestCampaign: null,
    nowUtcHour: 12,
  };

  it("allows a valid reallocation", () => {
    expect(evaluateGuardrails(cfg, base)).toEqual({ allowed: true });
  });

  it("blocks when the DESTINATION campaign is in cooldown", () => {
    const r = evaluateGuardrails(cfg, { ...base, minutesSinceLastActionOnDestCampaign: 10 });
    expect(r).toEqual({ allowed: false, reason: "destination campaign in cooldown" });
  });

  it("blocks when the SOURCE campaign is in cooldown (existing rule still applies)", () => {
    const r = evaluateGuardrails(cfg, { ...base, minutesSinceLastActionOnCampaign: 10 });
    expect(r).toEqual({ allowed: false, reason: "campaign in cooldown" });
  });

  it("applies maxBudgetCutPct to the SOURCE cut of a reallocation", () => {
    // 1000 -> 400 is a 60% cut > 50% cap.
    const r = evaluateGuardrails(cfg, { ...base, currentBudgetCents: 1000, newBudgetCents: 400 });
    expect(r).toEqual({ allowed: false, reason: "budget cut exceeds max" });
  });

  it("dollar cap covers the amount", () => {
    const r = evaluateGuardrails(cfg, { ...base, dollarImpactCents: 200000 });
    expect(r).toEqual({ allowed: false, reason: "dollar impact exceeds cap" });
  });
});
```

- [ ] **Step 6.2: Run to verify failure**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts`
Expected: FAIL — TS error on `kind: "reallocate_budget"` / unknown fact field.

- [ ] **Step 6.3: Implement the pure changes**

In `app/lib/actions/guardrails.ts`:

(a) Below the import, define and use the widened kind:

```ts
import type { ExecutableKind } from "./execute.server";

/** Kinds the guardrail evaluator understands: the single-campaign executables
 * plus the composite reallocation (executed by reallocate.server.ts). */
export type GuardedKind = ExecutableKind | "reallocate_budget";
```

(b) In `GuardrailFacts`: change `kind: ExecutableKind;` to `kind: GuardedKind;` and add after `minutesSinceLastActionOnCampaign`:

```ts
  /** Reallocations cool down BOTH campaigns; null/absent for other kinds. */
  minutesSinceLastActionOnDestCampaign?: number | null;
```

(c) In `evaluateGuardrails`, after the existing cooldown check add:

```ts
  if (
    facts.minutesSinceLastActionOnDestCampaign != null &&
    facts.minutesSinceLastActionOnDestCampaign < cfg.cooldownMinutes
  ) {
    return { allowed: false, reason: "destination campaign in cooldown" };
  }
```

(d) Widen the cut-cap condition from `facts.kind === "reduce_campaign_budget" &&` to:

```ts
    (facts.kind === "reduce_campaign_budget" || facts.kind === "reallocate_budget") &&
```

- [ ] **Step 6.4: Run pure tests to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Write the failing server-wrapper tests**

In `app/lib/actions/__tests__/guardrails-server.test.ts`:

(a) In `fakeSb`'s `builder`, add one line beside the other chain stubs: `chain.or = vi.fn(() => chain);`
(b) Extend `fakeSb`'s options + `action_audit` answer to support per-call cooldown rows — replace the `action_audit` line inside `maybeSingle` with a queue:

```ts
// at the top of fakeSb, beside the other locals:
const cooldownQueue = [...(opts.lastActionAtIsoQueue ?? [opts.lastActionAtIso ?? null])];
// inside maybeSingle, replace the action_audit line with:
if (table === "action_audit") {
  const iso = cooldownQueue.length ? cooldownQueue.shift() : null;
  return { data: iso ? { created_at: iso } : null, error: null };
}
```

and add `lastActionAtIsoQueue?: Array<string | null>;` to the `opts` type.

(c) Append tests:

```ts
  it("blocks a reallocation whose DEST campaign is in cooldown", async () => {
    // Source lookup (first action_audit call) → null; dest lookup → recent.
    const sb = fakeSb({ todayCount: 0, lastActionAtIsoQueue: [null, "2026-06-06T15:50:00Z"] });
    const r = await checkGuardrails(SHOP, {
      kind: "reallocate_budget", campaignId: CAMP,
      destCampaignId: "22222222-2222-2222-2222-222222222222",
      dollarImpactCents: 500, campaignSpendCents: 50000,
      currentBudgetCents: 2000, newBudgetCents: 1500,
    }, sb);
    expect(r).toEqual({ allowed: false, reason: "destination campaign in cooldown" });
  });

  it("allows a reallocation when neither campaign is in cooldown", async () => {
    const sb = fakeSb({ todayCount: 0, lastActionAtIsoQueue: [null, null] });
    const r = await checkGuardrails(SHOP, {
      kind: "reallocate_budget", campaignId: CAMP,
      destCampaignId: "22222222-2222-2222-2222-222222222222",
      dollarImpactCents: 500, campaignSpendCents: 50000,
      currentBudgetCents: 2000, newBudgetCents: 1500,
    }, sb);
    expect(r).toEqual({ allowed: true });
  });
```

- [ ] **Step 6.6: Run to verify failure, then implement the server wrapper**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts` → new tests FAIL.

In `app/lib/actions/guardrails.server.ts`:

(a) Change the kind import/typing: replace `import type { ExecutableKind } from "./execute.server";` with importing `GuardedKind` from `./guardrails`, and in `CheckInput` change `kind: ExecutableKind;` to `kind: GuardedKind;` plus add:

```ts
  /** Set for reallocate_budget — enables the dest-side cooldown check. */
  destCampaignId?: string;
```

(b) Extract the cooldown lookup into a helper above `checkGuardrails` and match BOTH the source-side `campaign_id` and reallocation `dest_campaign_id` params keys (a campaign that last received budget via a reallocation is still "recently touched"):

```ts
async function minutesSinceLastAutopilotActionOn(
  sb: SupabaseClient,
  shopId: string,
  campaignId: string,
): Promise<number | null> {
  const { data: last } = await sb
    .from("action_audit")
    .select("created_at")
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .or(`params->>campaign_id.eq.${campaignId},params->>dest_campaign_id.eq.${campaignId}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return last?.created_at ? (Date.now() - Date.parse(String(last.created_at))) / 60000 : null;
}
```

(c) In `checkGuardrails`, replace the inline "Most recent autopilot action" block with:

```ts
  const minutesSince = await minutesSinceLastAutopilotActionOn(sb, shopId, input.campaignId);
  const minutesSinceDest = input.destCampaignId
    ? await minutesSinceLastAutopilotActionOn(sb, shopId, input.destCampaignId)
    : null;
```

and pass `minutesSinceLastActionOnDestCampaign: minutesSinceDest,` into `evaluateGuardrails`.

- [ ] **Step 6.7: Run both guardrail test files to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts app/lib/actions/__tests__/guardrails-server.test.ts`
Expected: PASS (including all pre-existing tests — the `.or()` change is invisible to them because the chain stub returns itself).

- [ ] **Step 6.8: Commit**

```bash
git add app/lib/actions/guardrails.ts app/lib/actions/guardrails.server.ts app/lib/actions/__tests__/guardrails.test.ts app/lib/actions/__tests__/guardrails-server.test.ts
git commit -m "lib/actions: guardrails learn reallocate_budget — dual cooldown + source cut cap"
```

---

### Task 7: Suggestion helper

**Files:**
- Create: `app/lib/actions/reallocation-suggest.server.ts`
- Create: `app/lib/actions/__tests__/reallocation-suggest.test.ts`

- [ ] **Step 7.1: Write the failing tests**

Create `app/lib/actions/__tests__/reallocation-suggest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { suggestReallocation } from "../reallocation-suggest.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(opts: {
  campaigns: Array<Record<string, unknown>>;
  grades: Array<Record<string, unknown>>;
}) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "ad_campaign_dim" ? opts.campaigns : opts.grades, error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const camp = (id: string, platform: string, budget: number) => ({
  id, external_id: `x-${id}`, platform, name: `Camp ${id}`, daily_budget_cents: budget,
});
// grade rows arrive ordered day_bucket DESC (the query orders them).
const grade = (campaignId: string, g: string, roas: number, day = "2026-06-09") => ({
  campaign_id: campaignId, grade: g, roas, day_bucket: day,
});

describe("suggestReallocation", () => {
  it("picks the worst-graded source and the best winning cross-platform dest", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000), camp("c", "meta", 3000)],
      grades: [grade("a", "poor", 0.4), grade("b", "winning", 3.2), grade("c", "winning", 4.1)],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest?.campaignId).toBe("c"); // higher ROAS wins the tie among winners
    expect(s.dest?.platform).toBe("meta");
  });

  it("returns dest null when no winning campaign exists on ANOTHER platform", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "google", 1000)],
      grades: [grade("a", "poor", 0.4), grade("b", "winning", 3.2)],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest).toBeNull();
  });

  it("never suggests draining a winning campaign as source", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [grade("a", "winning", 3.0), grade("b", "winning", 4.0)],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source).toBeNull();
    expect(s.dest).toBeNull();
  });

  it("pins the source when sourceCampaignId is given (autopilot path)", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [grade("a", "okay", 1.1), grade("b", "winning", 3.2)],
    });
    const s = await suggestReallocation(SHOP, sb, { sourceCampaignId: "a" });
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest?.campaignId).toBe("b");
  });

  it("excludes ungraded campaigns entirely", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [grade("a", "poor", 0.4)], // b has no grade
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest).toBeNull();
  });

  it("uses only the LATEST grade per campaign", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [
        grade("b", "winning", 3.2, "2026-06-09"), // latest first (desc order)
        grade("b", "poor", 0.2, "2026-06-01"),
        grade("a", "poor", 0.4, "2026-06-09"),
      ],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.dest?.campaignId).toBe("b");
  });
});
```

- [ ] **Step 7.2: Run to verify failure**

Run: `npx vitest run app/lib/actions/__tests__/reallocation-suggest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement**

Create `app/lib/actions/reallocation-suggest.server.ts`:

```ts
// Grade-driven source/destination suggestion for budget reallocation, shared
// by the campaigns UI loader and autopilot so both surfaces pick identically.
// Source: the worst-graded active daily-budgeted campaign (never a winner).
// Dest: the highest-ROAS `winning` campaign on a DIFFERENT platform, or null —
// callers fall back rather than force a bad pick.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";

export interface ReallocationCandidate {
  campaignId: string; // ad_campaign_dim uuid
  externalId: string;
  platform: Platform;
  name: string;
  dailyBudgetCents: number;
  grade: "winning" | "okay" | "poor";
  roas: number;
}

export interface ReallocationSuggestion {
  source: ReallocationCandidate | null;
  dest: ReallocationCandidate | null;
}

const GRADE_RANK: Record<string, number> = { poor: 0, okay: 1, winning: 2 };

interface CampaignRow {
  id: string;
  external_id: string;
  platform: string;
  name: string;
  daily_budget_cents: number | null;
}

interface GradeRow {
  campaign_id: string;
  grade: string;
  roas: number | string;
  day_bucket: string;
}

export async function suggestReallocation(
  shopId: string,
  sb: SupabaseClient,
  opts: { sourceCampaignId?: string } = {},
): Promise<ReallocationSuggestion> {
  const { data: campRows, error: cErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id, platform, name, daily_budget_cents")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .not("daily_budget_cents", "is", null);
  if (cErr) throw cErr;
  const campaigns = (campRows ?? []) as CampaignRow[];
  if (campaigns.length === 0) return { source: null, dest: null };

  const { data: gradeRows, error: gErr } = await sb
    .from("campaign_grade_fact")
    .select("campaign_id, grade, roas, day_bucket")
    .eq("shop_id", shopId)
    .order("day_bucket", { ascending: false });
  if (gErr) throw gErr;
  // Rows are day_bucket-desc, so the first row seen per campaign is its latest.
  const latest = new Map<string, GradeRow>();
  for (const g of (gradeRows ?? []) as GradeRow[]) {
    if (!latest.has(g.campaign_id)) latest.set(g.campaign_id, g);
  }

  const graded: ReallocationCandidate[] = [];
  for (const c of campaigns) {
    const g = latest.get(c.id);
    if (!g || c.daily_budget_cents == null || GRADE_RANK[g.grade] == null) continue;
    graded.push({
      campaignId: c.id,
      externalId: c.external_id,
      platform: c.platform as Platform,
      name: c.name,
      dailyBudgetCents: c.daily_budget_cents,
      grade: g.grade as ReallocationCandidate["grade"],
      roas: Number(g.roas),
    });
  }

  let source: ReallocationCandidate | null = null;
  if (opts.sourceCampaignId) {
    source = graded.find((c) => c.campaignId === opts.sourceCampaignId) ?? null;
  } else {
    // Worst grade first, lowest ROAS breaking ties; never drain a winner.
    const ranked = graded
      .slice()
      .sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || a.roas - b.roas);
    source = ranked.length > 0 && ranked[0].grade !== "winning" ? ranked[0] : null;
  }
  if (!source) return { source: null, dest: null };

  const src = source;
  const dest =
    graded
      .filter(
        (c) =>
          c.grade === "winning" &&
          c.platform !== src.platform &&
          c.campaignId !== src.campaignId,
      )
      .sort((a, b) => b.roas - a.roas)[0] ?? null;
  return { source, dest };
}
```

- [ ] **Step 7.4: Run to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/reallocation-suggest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7.5: Commit**

```bash
git add app/lib/actions/reallocation-suggest.server.ts app/lib/actions/__tests__/reallocation-suggest.test.ts
git commit -m "lib/actions: grade-driven reallocation suggestion helper"
```

---

### Task 8: Autopilot — reallocate before reduce

**Files:**
- Modify: `app/lib/actions/autopilot.server.ts`
- Modify: `app/lib/actions/__tests__/autopilot.test.ts`

- [ ] **Step 8.1: Write the failing tests**

In `app/lib/actions/__tests__/autopilot.test.ts`:

(a) Extend the hoisted mocks and module mocks:

```ts
const { checkGuardrails, executeAction, executeReallocation, suggestReallocation } = vi.hoisted(() => ({
  checkGuardrails: vi.fn(),
  executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
  executeReallocation: vi.fn(async () => ({ id: "aud2", outcome: "succeeded" })),
  suggestReallocation: vi.fn(async () => ({ source: null, dest: null })),
}));
vi.mock("../guardrails.server", () => ({ checkGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));
vi.mock("../reallocate.server", () => ({ executeReallocation }));
vi.mock("../reallocation-suggest.server", () => ({ suggestReallocation }));
```

(b) In `beforeEach`, after `vi.clearAllMocks()`, restore the safe defaults (clearAllMocks wipes `mockResolvedValue` queues set by individual tests but not implementations set in `vi.hoisted` — re-set explicitly to be deterministic):

```ts
  beforeEach(() => {
    vi.clearAllMocks();
    executeAction.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    executeReallocation.mockResolvedValue({ id: "aud2", outcome: "succeeded" });
    suggestReallocation.mockResolvedValue({ source: null, dest: null });
  });
```

(The existing "reduces budget for an ad_tax_overload alert" test keeps passing because the default suggestion has no dest → fallback to reduce.)

(c) Append tests:

```ts
  const destCandidate = {
    campaignId: "dest-uuid", externalId: "m-9", platform: "meta",
    name: "Winner", dailyBudgetCents: 4000, grade: "winning", roas: 4.2,
  };

  it("REALLOCATES the cut amount when a winning cross-platform dest exists", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    suggestReallocation.mockResolvedValue({ source: null, dest: destCandidate });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    const r = await runAutopilotForShop(SHOP, sb);
    // 50% default cut of 10000 → amount 5000 redirected, not shrunk.
    expect(executeReallocation).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        sourceCampaignId: "camp-uuid",
        destCampaignId: "dest-uuid",
        amountCents: 5000,
        actor: "autopilot",
        alertId: "al1",
        idempotencyKey: "autopilot:al1:reallocate_budget",
      }),
      sb,
    );
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(1);
  });

  it("passes destCampaignId into the guardrail check for reallocations", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    suggestReallocation.mockResolvedValue({ source: null, dest: destCandidate });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    expect(checkGuardrails).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        kind: "reallocate_budget",
        campaignId: "camp-uuid",
        destCampaignId: "dest-uuid",
        dollarImpactCents: 5000,
      }),
      sb,
    );
  });

  it("falls back to reduce_campaign_budget when no destination exists", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    suggestReallocation.mockResolvedValue({ source: null, dest: null });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 5000 }),
      sb,
    );
  });

  it("counts a guardrail-blocked reallocation as blocked (no fallback to reduce)", async () => {
    checkGuardrails.mockResolvedValue({ allowed: false, reason: "destination campaign in cooldown" });
    suggestReallocation.mockResolvedValue({ source: null, dest: destCandidate });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
  });
```

- [ ] **Step 8.2: Run to verify failure**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: the 4 new tests FAIL (`executeReallocation` never called / `destCampaignId` missing).

- [ ] **Step 8.3: Implement**

In `app/lib/actions/autopilot.server.ts`:

(a) Add imports:

```ts
import { executeReallocation } from "./reallocate.server";
import { suggestReallocation } from "./reallocation-suggest.server";
```

(b) Inside the candidate loop, after `newBudgetCents` is computed and BEFORE the existing `checkGuardrails` call, insert:

```ts
    // Budget detectors: prefer REDIRECTING the cut to a winning campaign on
    // another platform over shrinking total spend. Falls back to the plain
    // reduction below when no destination exists. A guardrail-blocked
    // reallocation does NOT fall through to reduce — same alert, same day,
    // one decision (counted as blocked).
    if (kind === "reduce_campaign_budget" && currentBudgetCents != null && newBudgetCents != null) {
      const amountCents = currentBudgetCents - newBudgetCents;
      if (amountCents > 0) {
        const { dest } = await suggestReallocation(shopId, sb, { sourceCampaignId: c.campaign_id });
        if (dest) {
          const verdict = await checkGuardrails(
            shopId,
            {
              kind: "reallocate_budget",
              campaignId: c.campaign_id,
              destCampaignId: dest.campaignId,
              dollarImpactCents: amountCents,
              campaignSpendCents: c.campaign_spend_cents,
              currentBudgetCents,
              newBudgetCents,
            },
            sb,
          );
          if (!verdict.allowed) {
            blocked += 1;
            continue;
          }
          await executeReallocation(
            shopId,
            {
              alertId: c.alert_id,
              sourceCampaignId: c.campaign_id,
              destCampaignId: dest.campaignId,
              amountCents,
              idempotencyKey: `autopilot:${c.alert_id}:reallocate_budget`,
              actor: "autopilot",
            },
            sb,
          );
          acted += 1;
          continue;
        }
      }
    }
```

- [ ] **Step 8.4: Run to verify pass**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: PASS (all pre-existing + 4 new).

- [ ] **Step 8.5: Commit**

```bash
git add app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/autopilot.test.ts
git commit -m "lib/actions: autopilot redirects budget cuts to winning campaigns when possible"
```

---

### Task 9: Route action — `intent=reallocate`

**Files:**
- Modify: `app/routes/app.campaigns._index.tsx` (action only — UI is Task 10)
- Modify: `app/routes/__tests__/campaigns-action.test.ts`

- [ ] **Step 9.1: Write the failing tests**

In `app/routes/__tests__/campaigns-action.test.ts`:

(a) Add to the hoisted spies object: `executeReallocationSpy: vi.fn(),` and `suggestSpy: vi.fn(async () => ({ source: null, dest: null })),`

(b) Add module mocks beside the existing ones:

```ts
vi.mock("~/lib/actions/reallocate.server", () => ({
  executeReallocation: (...a: unknown[]) => executeReallocationSpy(...a),
}));
vi.mock("~/lib/actions/reallocation-suggest.server", () => ({
  suggestReallocation: (...a: unknown[]) => suggestSpy(...a),
}));
```

(c) Append a request builder + tests:

```ts
function reallocRequest(over: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.set("intent", "reallocate");
  fd.set("campaignId", "google-uuid-1"); // non-Meta → already the dim uuid
  fd.set("campaignName", "Brand Search");
  fd.set("platform", "Google");
  fd.set("destCampaignId", "tiktok-uuid-2");
  fd.set("destName", "Spark Ads");
  fd.set("destPlatform", "TikTok");
  fd.set("amountCents", "500");
  fd.set("idempotencyKey", "kr1");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return new Request("http://test/app/campaigns", { method: "POST", body: fd });
}

describe("action · intent=reallocate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveShopIdSpy.mockResolvedValue("shop-uuid");
  });

  it("runs the reallocation through the orchestrator and reports success", async () => {
    executeReallocationSpy.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    const res = await action({ request: reallocRequest(), params: {}, context: {} } as ActionFunctionArgs);
    const body = await res.json();
    expect(executeReallocationSpy).toHaveBeenCalledWith(
      "shop-uuid",
      expect.objectContaining({
        sourceCampaignId: "google-uuid-1",
        destCampaignId: "tiktok-uuid-2",
        amountCents: 500,
        idempotencyKey: "kr1",
        alertId: null,
      }),
      expect.anything(),
    );
    expect(body.ok).toBe(true);
    expect(body.toast.message).toMatch(/\$5\.00.*Brand Search.*Spark Ads/);
  });

  it("rejects a non-positive amount with 400 and never calls the orchestrator", async () => {
    const res = await action({ request: reallocRequest({ amountCents: "0" }), params: {}, context: {} } as ActionFunctionArgs);
    expect(res.status).toBe(400);
    expect(executeReallocationSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing destination with 400", async () => {
    const res = await action({ request: reallocRequest({ destCampaignId: "" }), params: {}, context: {} } as ActionFunctionArgs);
    expect(res.status).toBe(400);
    expect(executeReallocationSpy).not.toHaveBeenCalled();
  });

  it("returns 202 (not success) when the dest increase is parked for retry", async () => {
    executeReallocationSpy.mockResolvedValue({ id: "aud1", outcome: "retrying" });
    const res = await action({ request: reallocRequest(), params: {}, context: {} } as ActionFunctionArgs);
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ACTION_RETRYING");
  });

  it("returns 502 when the reallocation failed", async () => {
    executeReallocationSpy.mockResolvedValue({ id: "aud1", outcome: "failed" });
    const res = await action({ request: reallocRequest(), params: {}, context: {} } as ActionFunctionArgs);
    expect(res.status).toBe(502);
  });

  it("requires Meta-listed campaigns to be ingested (409 when dim resolve fails)", async () => {
    resolveDimSpy.mockResolvedValue(null);
    const res = await action(
      { request: reallocRequest({ platform: "Meta", campaignId: "120" }), params: {}, context: {} } as ActionFunctionArgs,
    );
    expect(res.status).toBe(409);
    expect(executeReallocationSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 9.2: Run to verify failure**

Run: `npx vitest run app/routes/__tests__/campaigns-action.test.ts`
Expected: new describe FAILS (`Unknown intent: reallocate` → 400 instead of the asserted statuses).

- [ ] **Step 9.3: Implement the action branch**

In `app/routes/app.campaigns._index.tsx`:

(a) Add imports:

```ts
import { executeReallocation } from "~/lib/actions/reallocate.server";
```

(b) In the `action`, immediately AFTER the `idempotencyKey` is computed and BEFORE the `if (!campaignId)` check, insert the dedicated branch (it does not share the single-campaign switch):

```ts
  if (intent === "reallocate") {
    const destCampaignId = String(formData.get("destCampaignId") || "");
    const destPlatform = String(formData.get("destPlatform") || "");
    const destName = String(formData.get("destName") || "");
    const amountCents = Math.round(Number(formData.get("amountCents") || 0));
    // Validate at the boundary — never trust FormData shapes.
    if (!campaignId || !destCampaignId || !Number.isFinite(amountCents) || amountCents <= 0) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "source, destination and a positive amount are required" },
          toast: { message: "Invalid reallocation", isError: true },
        },
        { status: 400 },
      );
    }
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    // Meta rows post the live external id; resolve to the dim uuid. The
    // composite action has NO legacy direct-Meta fallback: both campaigns
    // must be ingested before budget can be moved between them.
    const sourceDim =
      platform === "Meta" ? await resolveCampaignDimId(sb, shopId, "meta", campaignId) : campaignId;
    const destDim =
      destPlatform === "Meta" ? await resolveCampaignDimId(sb, shopId, "meta", destCampaignId) : destCampaignId;
    if (!sourceDim || !destDim) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "NOT_INGESTED", message: "Both campaigns must finish syncing before budget can be reallocated" },
          toast: { message: "Campaigns still syncing — try again shortly", isError: true },
        },
        { status: 409 },
      );
    }
    try {
      const { outcome } = await executeReallocation(
        shopId,
        { alertId: null, sourceCampaignId: sourceDim, destCampaignId: destDim, amountCents, idempotencyKey },
        sb,
      );
      if (outcome === "failed") {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "ACTION_FAILED", message: `Could not reallocate budget from ${campaignName}` },
            toast: { message: `Could not reallocate budget from ${campaignName}`, isError: true },
          },
          { status: 502 },
        );
      }
      if (outcome === "retrying") {
        // Source budget IS reduced; the dest increase is parked for the retry
        // cron. Not a success yet (rule 12).
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "ACTION_RETRYING", message: `Source budget reduced; the increase on ${destName} is queued and will retry automatically` },
            toast: { message: `${destName}: increase queued, will retry automatically` },
          },
          { status: 202 },
        );
      }
      return json<ActionPayload>({
        ok: true,
        toast: { message: `Moved ${fmtMoney(amountCents)}/day from ${campaignName} to ${destName}` },
      });
    } catch (err) {
      const e = err as CalderynError;
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: e.code ?? "ACTION_FAILED", message: e.message },
          toast: { message: e.message, isError: true },
        },
        { status: e.status >= 400 && e.status < 600 ? e.status : 500 },
      );
    }
  }
```

(`fmtMoney`, `getSupabase`, `resolveShopId`, `resolveCampaignDimId` are already imported in this route.)

- [ ] **Step 9.4: Run to verify pass**

Run: `npx vitest run app/routes/__tests__/campaigns-action.test.ts`
Expected: PASS (pre-existing + 6 new).

- [ ] **Step 9.5: Commit**

```bash
git add app/routes/app.campaigns._index.tsx app/routes/__tests__/campaigns-action.test.ts
git commit -m "routes/app.campaigns._index: reallocate intent through the orchestrator"
```

---

### Task 10: UI — modal, loader suggestion, triggers, alert-page link

**Files:**
- Modify: `app/routes/app.campaigns._index.tsx`
- Modify: `app/routes/app.alerts.$id.tsx` (one button special-case)

UI is verified by typecheck + build + manual run (component render tests don't exist in this repo; don't invent a new harness — rule 11).

- [ ] **Step 10.1: Loader — suggestion prefill**

In `app/routes/app.campaigns._index.tsx`:

(a) Imports: add `Select` to the `@shopify/polaris` import list; add

```ts
import { suggestReallocation } from "~/lib/actions/reallocation-suggest.server";
```

(b) Types — add above `LoaderPayload`, and extend it:

```ts
type ReallocationPrefill = {
  sourceId: string | null; // id as used by the campaigns list (Meta = external id)
  destId: string | null;
  sourceGrade: string | null;
  destGrade: string | null;
};

type LoaderPayload = {
  campaigns: Campaign[];
  alerts: Alert[];
  reallocation: ReallocationPrefill | null;
  error: { code: string; message: string } | null;
};
```

(c) In the loader's `try`, after `alerts` is fetched and before the `return`, add:

```ts
    // Best-effort grade-driven prefill for the reallocate modal. Failure
    // degrades VISIBLY to "no suggestion" (no Suggested badges, defaults
    // unset) — the modal itself still works; this is advisory data, not a
    // swallowed mutation (rule 12).
    let reallocation: ReallocationPrefill | null = null;
    try {
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      const s = await suggestReallocation(shopId, sb);
      if (s.source && s.dest) {
        const matchId = (cand: { campaignId: string; externalId: string }) =>
          campaigns.find((c) => c.id === cand.campaignId || c.id === cand.externalId)?.id ?? null;
        reallocation = {
          sourceId: matchId(s.source),
          destId: matchId(s.dest),
          sourceGrade: s.source.grade,
          destGrade: s.dest.grade,
        };
      }
    } catch {
      reallocation = null;
    }
    return json<LoaderPayload>({ campaigns, alerts, reallocation, error: null });
```

and add `reallocation: null,` to the catch-path `json<LoaderPayload>` return.

- [ ] **Step 10.2: Component wiring**

(a) Extend the pending union:

```ts
type PendingAction =
  | { kind: "pause"; campaign: Campaign }
  | { kind: "resume"; campaign: Campaign }
  | { kind: "edit_budget"; campaign: Campaign }
  | { kind: "reallocate"; sourceId?: string };
```

(b) Destructure the new loader field: `const { campaigns, alerts, reallocation, error } = useLoaderData<typeof loader>();`

(c) Page header trigger — add to the `<Page>` props (next to `backAction`):

```tsx
      secondaryActions={[
        {
          content: "Reallocate budget",
          onAction: () => setPending({ kind: "reallocate" }),
          disabled:
            campaigns.filter((c) => c.status === "active" && c.daily_budget_cents > 0).length < 2,
        },
      ]}
```

(d) Per-row trigger — inside the row `ButtonGroup`, after the "Edit budget" button:

```tsx
        <Button
          variant="plain"
          disabled={c.status !== "active" || c.daily_budget_cents <= 0}
          onClick={() => setPending({ kind: "reallocate", sourceId: c.id })}
        >
          Reallocate
        </Button>
```

(e) Render the modal with the other `pending?.kind` blocks:

```tsx
      {pending?.kind === "reallocate" && (
        <ReallocateBudgetModal
          campaigns={campaigns}
          prefill={reallocation}
          initialSourceId={pending.sourceId}
          submitting={submitting}
          onClose={() => setPending(null)}
        />
      )}
```

- [ ] **Step 10.3: The modal component**

Add below `CampaignActionModal` in the same file:

```tsx
function ReallocateBudgetModal({
  campaigns,
  prefill,
  initialSourceId,
  submitting,
  onClose,
}: {
  campaigns: Campaign[];
  prefill: ReallocationPrefill | null;
  initialSourceId?: string;
  submitting: boolean;
  onClose: () => void;
}) {
  const eligible = campaigns.filter((c) => c.status === "active" && c.daily_budget_cents > 0);
  const startSource = initialSourceId ?? prefill?.sourceId ?? eligible[0]?.id ?? "";
  const [sourceId, setSourceId] = useState(startSource);
  const [destId, setDestId] = useState(() => {
    if (prefill?.destId && prefill.destId !== startSource) return prefill.destId;
    return eligible.find((c) => c.id !== startSource)?.id ?? "";
  });
  const [amount, setAmount] = useState("5");
  const [idempotencyKey] = useState(() => `realloc:${newIdempotencyKey()}`);

  const source = eligible.find((c) => c.id === sourceId);
  const dest = eligible.find((c) => c.id === destId);
  const amountCents = Math.round(Number(amount) * 100);
  const sameCampaign = Boolean(source && dest && source.id === dest.id);
  const amountInvalid = !Number.isFinite(amountCents) || amountCents <= 0;
  const exceedsSource = Boolean(source && !amountInvalid && amountCents >= source.daily_budget_cents);
  const valid = Boolean(source && dest && !sameCampaign && !amountInvalid && !exceedsSource);

  // Grade text is known only for the suggested pair (loader keeps the grade
  // join scoped to the suggestion — see plan deviation #3).
  const gradeFor = (id: string): string | null =>
    prefill?.sourceId === id
      ? prefill?.sourceGrade ?? null
      : prefill?.destId === id
        ? prefill?.destGrade ?? null
        : null;
  const optionGroups = (["Meta", "Google", "TikTok"] as const)
    .map((p) => ({
      title: p,
      options: eligible
        .filter((c) => c.platform === p)
        .map((c) => {
          const grade = gradeFor(c.id);
          return {
            value: c.id,
            label: `${c.name} · ${fmtMoney(c.daily_budget_cents)}/day${grade ? ` · ${grade}` : ""}`,
          };
        }),
    }))
    .filter((g) => g.options.length > 0);

  return (
    <Modal open title="Reallocate daily budget" onClose={onClose}>
      <Modal.Section>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="reallocate" />
          <input type="hidden" name="campaignId" value={source?.id ?? ""} />
          <input type="hidden" name="campaignName" value={source?.name ?? ""} />
          <input type="hidden" name="platform" value={source?.platform ?? ""} />
          <input type="hidden" name="destCampaignId" value={dest?.id ?? ""} />
          <input type="hidden" name="destName" value={dest?.name ?? ""} />
          <input type="hidden" name="destPlatform" value={dest?.platform ?? ""} />
          <input type="hidden" name="amountCents" value={String(amountInvalid ? 0 : amountCents)} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <BlockStack gap="300">
            <Select
              label="Move budget from"
              options={optionGroups}
              value={sourceId}
              onChange={setSourceId}
              helpText={
                prefill?.sourceId === sourceId ? "Suggested: lowest-graded campaign" : undefined
              }
            />
            <Select
              label="To"
              options={optionGroups}
              value={destId}
              onChange={setDestId}
              error={sameCampaign ? "Choose two different campaigns" : undefined}
              helpText={
                prefill?.destId === destId
                  ? "Suggested: best winning campaign on another platform"
                  : undefined
              }
            />
            <TextField
              label="Amount per day (USD)"
              type="number"
              prefix="$"
              value={amount}
              onChange={setAmount}
              autoComplete="off"
              error={
                amountInvalid
                  ? "Enter an amount above $0"
                  : exceedsSource
                    ? "Amount must leave the source budget above zero"
                    : undefined
              }
            />
            {source && dest && valid && (
              <Banner tone="info">
                {source.platform} · {source.name}: {fmtMoney(source.daily_budget_cents)} →{" "}
                {fmtMoney(source.daily_budget_cents - amountCents)}/day {" — "} {dest.platform} ·{" "}
                {dest.name}: {fmtMoney(dest.daily_budget_cents)} →{" "}
                {fmtMoney(dest.daily_budget_cents + amountCents)}/day
              </Banner>
            )}
            <Box>
              <ButtonGroup>
                <Button onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting || !valid}>
                  Move {fmtMoney(amountInvalid ? 0 : amountCents)}/day
                </Button>
              </ButtonGroup>
            </Box>
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}
```

- [ ] **Step 10.4: Alert-page special case**

In `app/routes/app.alerts.$id.tsx`, the action-button list renders one primary button per kind in `allowedActions` (~line 485). `reallocate_budget` must NOT open the inline confirm (the alert action handler has no reallocate execution path) — it navigates to the campaigns page instead. In the `.map()` over `allowedActions` where each kind renders `<Button variant="primary" onClick={() => setActionKind(kind)} fullWidth>{ACTION_LABELS[kind]}</Button>`, add a special case BEFORE that return:

```tsx
                      {kind === "reallocate_budget" ? (
                        <Button fullWidth onClick={() => navigate("/app/campaigns")}>
                          {ACTION_LABELS[kind]} →
                        </Button>
                      ) : (
                        <Button variant="primary" onClick={() => setActionKind(kind)} fullWidth>
                          {ACTION_LABELS[kind]}
                        </Button>
                      )}
```

(match the file's actual JSX structure when editing; `navigate` already exists in this route via `useEmbeddedNavigate`). Also defensively reject the kind in the route's action: where `allowed.includes(kind)` is checked (~line 159), add right after it:

```ts
    if (kind === "reallocate_budget") {
      // Executed from the campaigns page (needs source/dest/amount); the
      // alert page only deep-links there.
      return json({ ok: false, error: { code: "UNSUPPORTED_HERE", message: "Reallocate budget from the Campaigns page" } }, { status: 400 });
    }
```

(adapt the return shape to that action's existing error returns — read the surrounding code first, rule 8).

- [ ] **Step 10.5: Typecheck, full suite, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0. The `keyboard shortcut` handler in app.alerts.$id.tsx (`e.key === "e"` → `allowed[0]`) now points at `reallocate_budget` for ad_tax_overload alerts — verify `setActionKind("reallocate_budget")` has no inline modal mapped; if a generic confirm modal would open for it, reorder `DETECTOR_TO_ACTIONS.ad_tax_overload` to keep `reduce_campaign_budget` first and `reallocate_budget` second (UI-safe), since the assistant gate only needs MEMBERSHIP, not ordering. Surface whichever choice is made in the commit message.

- [ ] **Step 10.6: Manual verification (run skill / dev server)**

Run the app (`npm run dev` with the Shopify CLI tunnel or the project's usual run path) and verify:
1. Campaigns page header shows "Reallocate budget" (disabled with <2 eligible campaigns).
2. Modal opens pre-filled when a suggestion exists; "Suggested" help text shows.
3. Amount validation blocks 0, negatives, and >= source budget inline.
4. Submit shows the success toast and the two budgets change after revalidation.
5. An ad_tax_overload alert page shows "Reallocate budget →" navigating to campaigns.

- [ ] **Step 10.7: Commit**

```bash
git add app/routes/app.campaigns._index.tsx app/routes/app.alerts.$id.tsx
git commit -m "routes: reallocate-budget modal on campaigns + alert-page deep link"
```

---

### Task 11: Pre-commit gate (MANDATORY before PR)

Per project CLAUDE.md, in order, pasting each result:

- [ ] **Step 11.1:** `/code-review` on the working tree — resolve every blocker.
- [ ] **Step 11.2:** `git diff main --stat` review + `git diff main --check` clean; grep the branch diff for `console.log`, `.only(`, `TODO(me)`.
- [ ] **Step 11.3:** `npm run typecheck` → exit 0.
- [ ] **Step 11.4:** `npm run lint` → exit 0, no warnings on touched files.
- [ ] **Step 11.5:** `npm run build` → exit 0.
- [ ] **Step 11.6:** `npm test` → full suite green.
- [ ] **Step 11.7:** Migration check — the new migration is append-only SQL (`alter type ... add value if not exists`); `npx prisma validate` only if `prisma/schema.prisma` changed (it should NOT in this feature — the action tables live in Supabase).
- [ ] **Step 11.8:** Push branch + open PR (only on explicit request, per repo rules).

---

## Self-review notes (already applied)

- **Spec coverage:** migration (T1), orchestrator + compensation (T2–3), retry drain (T4), undo (T5), guardrails dual-cooldown + cut cap (T6), suggestion helper (T7), autopilot (T8), MCP gate (T1.4 — `tools.server.ts` enum + `DETECTOR_TO_ACTIONS` membership), route action (T9), UI modal/prefill/triggers (T10), tests throughout. Spec's "MCP propose_action accepts validated params (source/dest/amount)" is satisfied at MEMBERSHIP level v1: the assistant proposes the kind and deep-links to the campaigns page where params are chosen — full param threading through the assistant's propose/confirm flow is out of v1 scope (deviation #2).
- **Type consistency:** `executeReallocation(shopId, input, sb)` / `ReallocateInput` / `ExecutedAudit` consistent across T2, T8, T9. `GuardedKind` defined T6(a), consumed T6(server) + T8 via `checkGuardrails` input. `suggestReallocation(shopId, sb, opts?)` consistent across T7, T8, T10. Replay/compensation params (`source_*`, dest-side `external_id/platform/daily_budget_cents`, `step`, `compensation`) consistent across T2 params, T4 registry, T5 undo.
- **Known accepted risks:** carried from the spec (crash window between platform calls; source-step transient = terminal).
