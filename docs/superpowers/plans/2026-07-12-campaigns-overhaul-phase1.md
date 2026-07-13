# Campaigns Overhaul Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first-campaign wizard (Meta create, paused), everyday campaign controls (edit budget, duplicate, quick pause), a per-campaign performance chart, and the Campaigns polish pass — per `docs/superpowers/specs/2026-07-12-campaigns-overhaul-design.md`.

**Architecture:** Dashboard-only (Remix + React 18, `cd-*` design system). All Meta writes go through the existing action orchestrator (`executeAction`) or a new wizard create module that follows `ad-create.server.ts` conventions (injected `MetaClient`, `withRetry`, permanent-error codes, rollback). New wizard state persists in a `campaign_wizard_runs` table (shop-scoped, RLS).

**Tech Stack:** TypeScript strict, Remix routes under `app/routes/dashboard.api.*`, Supabase Postgres (SQL migrations), vitest, existing `MetaClient` fake-injection test pattern.

## Global Constraints

- Everything created on Meta is created **PAUSED**. Turn-on is an explicit user action.
- Wizard daily budget clamped **500–20000 cents** ($5–$200) client- AND server-side.
- Every dashboard route: `requireDashboardSession(request)`; writes also `requireSameOrigin(request)`.
- No `any`. `tsc --noEmit` authoritative. Loaders read-only; mutations in actions; DTOs shaped (never raw rows).
- No direct Meta calls from routes — go through `executeAction` or the new `campaign-create.server.ts`.
- New tables: shop-scoped, RLS `for all using (shop_id = public.current_shop_id())`, `revoke all ... from anon, authenticated` (mirror `supabase/migrations/20260703010000_campaign_draft.sql`).
- Migration naming: `YYYYMMDDHHMMSS_snake_case.sql`.
- Browser-visible source hygiene rules from CLAUDE.md apply (no provenance comments).
- Pre-commit gate before each PR: `/code-review` → `npm run typecheck` → `npm run lint` → `npm run build`.
- Worktree: `c:\Users\famou\Desktop\calderyn-campaigns-overhaul`, branch `feat/campaigns-overhaul`. PR 2 and PR 3 branch off the previous PR's branch if unmerged (stacked) or off main once merged.

---

## PR 1 — polish + everyday controls

### Task 1: Land the carried-over Campaigns WIP (reconcile `PlatformMark`)

The worktree already contains uncommitted WIP: `app/components/dashboard/screens/Campaigns.tsx` (platform marks, account summary strip with paused-budget + zero-spend fixes, Meta-only creative gating), `app/components/dashboard/screens/campaign-creative-status.ts`, and its test. Main's `ui.tsx` now exports a shared `PlatformMark` (`app/components/dashboard/ui.tsx:222`, props `{ platform: Platform | string }` — icon-based); the WIP defines a duplicate local letter-chip version.

**Files:**
- Modify: `app/components/dashboard/screens/Campaigns.tsx`
- Test (existing): `app/components/dashboard/screens/__tests__/campaign-creative-status.test.ts`

**Interfaces:**
- Produces: committed baseline the rest of PR 1 builds on. `creativeEmptyText(platform, { loadError, data })` from `./campaign-creative-status`.

- [ ] **Step 1: Delete the local `PlatformMark` and use the shared one**

In `Campaigns.tsx`: remove the entire local `function PlatformMark(...)` (the ~28-line letter-chip block near the top, above `ScreenHeader`). Add `PlatformMark` to the existing `import { ... } from "../ui";` list. Remove `size={22}` / any `size` prop at the two call sites (row + summary strip) — the shared component takes only `platform`.

- [ ] **Step 2: Run the existing tests and typecheck**

Run: `npx vitest run app/components/dashboard/screens/__tests__/campaign-creative-status.test.ts` → 6 passed.
Run: `npm run typecheck` → exit 0. (If `Platform` type friction appears at the draft-row call site, pass `CAMPAIGN_DRAFT_PLATFORM_LABELS[d.platform]` which is already the `"Meta" | "Google" | "TikTok"` label.)

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/Campaigns.tsx app/components/dashboard/screens/campaign-creative-status.ts app/components/dashboard/screens/__tests__/campaign-creative-status.test.ts
git commit -m "dashboard/Campaigns: platform marks, account summary strip, Meta-only creative gating"
```

### Task 2: `update_campaign_budget` executor kind

Set a campaign's daily budget to an arbitrary user-chosen value (existing kinds only apply detector-suggested reduce/increase values).

**Files:**
- Modify: `app/lib/actions/execute.server.ts` (union at :19-27, validation at :220-228, no-op guard block at ~:296, `postState` computation, params in the audit tail)
- Modify: `app/routes/dashboard.api.campaigns.$id.action.tsx` (KINDS list, budget-cents validation at :82-87)
- Create: `app/lib/actions/__tests__/update-budget.test.ts`

**Interfaces:**
- Consumes: `executeAction(shopId, input: ExecuteInput, sb)` — `execute.server.ts:213`.
- Produces: `"update_campaign_budget"` in `ExecutableKind`; route accepts `{ type: "update_campaign_budget", idempotency_key, daily_budget_cents }`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/actions/__tests__/update-budget.test.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeAction } from "../execute.server";

// Validation throws before any Supabase/platform call, so an empty stub is safe.
const SB = {} as SupabaseClient;

describe("update_campaign_budget validation", () => {
  it("refuses a missing dailyBudgetCents", async () => {
    await expect(
      executeAction("shop-1", {
        alertId: null,
        kind: "update_campaign_budget",
        campaignId: "camp-1",
        idempotencyKey: "k1",
      }, SB),
    ).rejects.toThrow(/dailyBudgetCents/);
  });

  it("refuses a zero dailyBudgetCents", async () => {
    await expect(
      executeAction("shop-1", {
        alertId: null,
        kind: "update_campaign_budget",
        campaignId: "camp-1",
        idempotencyKey: "k1",
        dailyBudgetCents: 0,
      }, SB),
    ).rejects.toThrow(/dailyBudgetCents/);
  });
});
```

- [ ] **Step 2: Run it — must fail**

Run: `npx vitest run app/lib/actions/__tests__/update-budget.test.ts`
Expected: FAIL (TypeScript: `"update_campaign_budget"` not assignable to `ExecutableKind`; or validation not thrown).

- [ ] **Step 3: Implement**

In `execute.server.ts`:
1. Add `| "update_campaign_budget"` to `ExecutableKind`.
2. Extend the budget validation condition to include it:
```ts
if (
  (input.kind === "reduce_campaign_budget" ||
    input.kind === "increase_campaign_budget" ||
    input.kind === "update_campaign_budget") &&
  !input.dailyBudgetCents
) {
```
3. Add a replay-safe no-op guard right after the existing `reduce_campaign_budget` no-op block (same `insertAuditWithIdempotency` shape, `noop_reason: "already_at_target"`), triggered when `input.kind === "update_campaign_budget" && (camp.daily_budget_cents ?? 0) === input.dailyBudgetCents`.
4. The platform-call `else` branch already routes any other kind to `adapter.setDailyBudget(externalId, input.dailyBudgetCents ?? 0)` — verify `postState` for this kind carries `{ status: camp.status, daily_budget_cents: input.dailyBudgetCents }` (mirror how reduce/increase compute it; extend the same conditional).

In `dashboard.api.campaigns.$id.action.tsx`: add `"update_campaign_budget"` to the `KINDS` list and to the daily-budget-cents validation condition (`invalid_daily_budget_cents`).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run app/lib/actions/__tests__/update-budget.test.ts` → PASS.
Run: `npx vitest run app/routes/__tests__/dashboard-campaigns-action-calibration.test.ts` → still PASS (no regression).
Run: `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/execute.server.ts app/routes/dashboard.api.campaigns.\$id.action.tsx app/lib/actions/__tests__/update-budget.test.ts
git commit -m "actions: update_campaign_budget executor kind (arbitrary target through orchestrator)"
```

### Task 3: `duplicate_campaign` — Meta copy + executor + undo

**Files:**
- Modify: `app/lib/meta/campaigns.server.ts` (add `duplicateCampaign`)
- Create: `app/lib/meta/__tests__/duplicate-campaign.test.ts`
- Modify: `app/lib/actions/execute.server.ts` (union + a dedicated branch like `executePushCreativeDraft`)
- Modify: `app/lib/actions/undo.server.ts` (undo = delete the copy)
- Modify: `app/routes/dashboard.api.campaigns.$id.action.tsx` (KINDS + Meta-scope gate, same 403 `meta_scope_insufficient` pattern as `push_creative_draft` at :51-53)

**Interfaces:**
- Consumes: `MetaClient` (`campaigns.server.ts:23`), `metaWriteClientForShopId(shopId): Promise<MetaWriteConn | null>` (`ad-create.server.ts:117`), `insertAuditWithIdempotency` (`execute.server.ts:154`).
- Produces: `duplicateCampaign(client: MetaClient, campaignId: string): Promise<{ copiedCampaignId: string }>`; `"duplicate_campaign"` ExecutableKind; audit `post_state: { copied_campaign_external_id, copied_campaign_dim_id }`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/meta/__tests__/duplicate-campaign.test.ts
import { describe, expect, it } from "vitest";
import { duplicateCampaign } from "../campaigns.server";
import type { MetaClient, MetaResponse } from "../campaigns.server";

function fakeClient(post: (path: string, body: Record<string, string>) => MetaResponse): MetaClient {
  return {
    get: async () => ({} as MetaResponse),
    post: async (path, body) => post(path, body),
  };
}

describe("duplicateCampaign", () => {
  it("POSTs /{id}/copies with deep_copy + PAUSED and returns the copy id", async () => {
    const calls: Array<{ path: string; body: Record<string, string> }> = [];
    const client = fakeClient((path, body) => {
      calls.push({ path, body });
      return { copied_campaign_id: "238123" } as unknown as MetaResponse;
    });
    const res = await duplicateCampaign(client, "9001");
    expect(res).toEqual({ copiedCampaignId: "238123" });
    expect(calls[0].path).toBe("/9001/copies");
    expect(calls[0].body.deep_copy).toBe("true");
    expect(calls[0].body.status_option).toBe("PAUSED");
  });

  it("throws loudly when Meta returns an error payload", async () => {
    const client = fakeClient(() => ({ error: { message: "nope", code: 10 } } as unknown as MetaResponse));
    await expect(duplicateCampaign(client, "9001")).rejects.toThrow(/nope/);
  });

  it("throws when the response has no copied_campaign_id", async () => {
    const client = fakeClient(() => ({} as MetaResponse));
    await expect(duplicateCampaign(client, "9001")).rejects.toThrow(/copied_campaign_id/);
  });
});
```

- [ ] **Step 2: Run it — must fail**

Run: `npx vitest run app/lib/meta/__tests__/duplicate-campaign.test.ts`
Expected: FAIL — `duplicateCampaign` is not exported.

- [ ] **Step 3: Implement `duplicateCampaign`**

In `app/lib/meta/campaigns.server.ts` (follow the module's existing `check`/error style — see `setCampaignStatus` at :71):

```ts
/** Deep-copy a campaign on Meta. The copy (campaign + ad sets + ads) is created
 *  PAUSED so duplicating a winner never spends until the merchant turns it on. */
export async function duplicateCampaign(
  client: MetaClient,
  campaignId: string,
): Promise<{ copiedCampaignId: string }> {
  const body = check(
    await client.post(`/${campaignId}/copies`, {
      deep_copy: "true",
      status_option: "PAUSED",
      rename_options: JSON.stringify({ rename_suffix: " (copy)" }),
    }),
  ) as MetaResponse & { copied_campaign_id?: string };
  const copiedCampaignId = body.copied_campaign_id ? String(body.copied_campaign_id) : "";
  if (!copiedCampaignId) {
    throw new Error("Meta copy response had no copied_campaign_id");
  }
  return { copiedCampaignId };
}
```

(If `check` in that module is not shaped exactly like this, mirror how `setCampaignStatus` handles `MetaResponse.error` — throw with the error message.)

- [ ] **Step 4: Run test → PASS, then wire the executor**

Run: `npx vitest run app/lib/meta/__tests__/duplicate-campaign.test.ts` → PASS.

In `execute.server.ts`: add `| "duplicate_campaign"` to `ExecutableKind` and, mirroring the `push_creative_draft` early-routing (it branches before the campaign-mutation path since it creates a NEW object), add a `executeDuplicateCampaign` branch:
- Idempotency via `priorExecutionForKey` (already done at step 1 of `executeAction` — the branch goes after it).
- Ownership read of `ad_campaign_dim` (already done — reuse `camp`).
- Refuse non-Meta platforms: `if (platform !== "meta") throw new Error("duplicate_campaign is Meta-only today")`.
- `const conn = await (deps.resolveMetaWriteClient ?? metaWriteClientForShopId)(shopId)` — same injection seam `undoAction` uses (`undo.server.ts:74-83`); `if (!conn)` → outcome `failed`, `lastError = "meta not connected"`.
- `const { copiedCampaignId } = await duplicateCampaign(conn.client, externalId)` in try/catch with `isRetriableFailure` classification (same as the budget branch).
- On success, mirror-insert the copy into `ad_campaign_dim`: `{ shop_id: shopId, external_id: copiedCampaignId, platform: "meta", name: \`${camp.name ?? "Campaign"} (copy)\`, status: "paused", daily_budget_cents: camp.daily_budget_cents }` (add `name` to the ownership `select` if not present). Insert error: log, don't fail the action (same best-effort rule as the mirror update at :366-378). Capture the inserted row id as `copied_campaign_dim_id`.
- Audit via `insertAuditWithIdempotency` with `action_kind: "duplicate_campaign"`, `post_state: { copied_campaign_external_id: copiedCampaignId, copied_campaign_dim_id }`.

In `undo.server.ts`: add a `duplicate_campaign` case — undo deletes the copy: `client.post(\`/${copiedExternalId}\`, { status: "DELETED" })` via the resolved Meta write client (exact pattern of the existing `push_creative_draft` undo which deletes an ad), plus best-effort delete of the mirrored `ad_campaign_dim` row by id.

In `dashboard.api.campaigns.$id.action.tsx`: add `"duplicate_campaign"` to KINDS and to the `metaDraftPushEnabled` scope gate alongside `push_creative_draft`.

- [ ] **Step 5: Typecheck + full actions test sweep + commit**

Run: `npm run typecheck` → exit 0. `npx vitest run app/lib/actions app/lib/meta` → all pass.

```bash
git add app/lib/meta/campaigns.server.ts app/lib/meta/__tests__/duplicate-campaign.test.ts app/lib/actions/execute.server.ts app/lib/actions/undo.server.ts app/routes/dashboard.api.campaigns.\$id.action.tsx
git commit -m "actions: duplicate_campaign (Meta deep copy, created paused, undoable)"
```

### Task 4: List-row quick actions + Edit-budget modal

**Files:**
- Create: `app/components/dashboard/screens/EditBudgetModal.tsx`
- Modify: `app/components/dashboard/screens/Campaigns.tsx` (`CampaignRow`, `CampaignList`)

**Interfaces:**
- Consumes: `executeCampaignAction(campaignId, { type, dailyBudgetCents? })` (`app/lib/dashboard/client.ts:739`), `useModalChrome` (`app/components/dashboard/use-modal-chrome.ts:21`), `Btn`/`Card`/`Tooltip` from `../ui`, `money` from `../format`.
- Produces: `<EditBudgetModal c={CampaignVM} onClose={() => void} onSaved={(newCents: number) => void} />`.

- [ ] **Step 1: Build `EditBudgetModal`**

```tsx
// app/components/dashboard/screens/EditBudgetModal.tsx
import { useState } from "react";
import { Btn } from "../ui";
import { money } from "../format";
import { useModalChrome } from "../use-modal-chrome";
import { executeCampaignAction } from "~/lib/dashboard/client";
import type { CampaignVM } from "../view-models";

/** Set a campaign's daily budget to an exact value. Meta-only (the only
 *  platform with a budget write path); callers hide the entry point otherwise. */
export function EditBudgetModal({
  c,
  onClose,
  onSaved,
  toast,
}: {
  c: CampaignVM;
  onClose: () => void;
  onSaved: (newCents: number) => void;
  toast: (msg: string, icon: string, tone: string) => void;
}) {
  const [dollars, setDollars] = useState(
    c.daily_budget_cents > 0 ? (c.daily_budget_cents / 100).toFixed(2) : "",
  );
  const [busy, setBusy] = useState(false);
  const chrome = useModalChrome<HTMLDivElement>({ onClose });
  const cents = Math.round(Number(dollars) * 100);
  const valid = Number.isFinite(cents) && cents > 0;

  const save = async () => {
    if (!valid || busy || cents === c.daily_budget_cents) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, { type: "update_campaign_budget", dailyBudgetCents: cents });
      toast("Budget updated.", "check", "success");
      onSaved(cents);
      onClose();
    } catch {
      toast("Couldn't update the budget — try again.", "x", "critical");
      setBusy(false);
    }
  };

  return (
    <div className="cd-modal-backdrop" onClick={onClose}>
      <div
        ref={chrome.ref}
        onKeyDown={chrome.onKeyDown}
        className="cd-card cd-pad"
        role="dialog"
        aria-modal="true"
        aria-label="Edit daily budget"
        style={{ width: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cd-row-title" style={{ marginBottom: 4 }}>Daily budget</div>
        <div className="cd-caption" style={{ marginBottom: 12 }}>{c.name}</div>
        <input
          className="cd-input"
          inputMode="decimal"
          placeholder="e.g. 25"
          value={dollars}
          onChange={(e) => setDollars(e.target.value)}
        />
        {valid && (
          <div className="cd-caption" style={{ marginTop: 8 }}>
            About {money(cents * 30)} per month at this rate.
          </div>
        )}
        <div className="flex items-center" style={{ gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
          <Btn small onClick={onClose}>Cancel</Btn>
          <Btn small kind="primary" disabled={!valid || busy} onClick={save}>
            {busy ? "Saving…" : "Save budget"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
```

(Reuse the modal-backdrop class the existing modals use — check `PoModal.tsx` for the exact backdrop class name and copy it; if it's a different class than `cd-modal-backdrop`, use that one. Do not add new CSS.)

- [ ] **Step 2: Quick actions on `CampaignRow`**

In `Campaigns.tsx`, extend `CampaignRow` with an actions cell (the last grid column is currently an empty `<span />` in the header and `<div />` in rows). Meta-only controls gate on `c.platform === "Meta"`:

```tsx
function RowQuickActions({
  c,
  onEditBudget,
  onChanged,
  toast,
}: {
  c: CampaignVM;
  onEditBudget: () => void;
  onChanged: (patch: Partial<CampaignVM>) => void;
  toast: (msg: string, icon: string, tone: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const paused = c.status === "paused";
  const isMeta = c.platform === "Meta";

  const run = async (type: string, done: string, patch: Partial<CampaignVM>) => {
    if (busy) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, { type });
      toast(done, "check", "success");
      onChanged(patch);
    } catch {
      toast("Action failed — try again.", "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex items-center"
      style={{ gap: 6, justifyContent: "flex-end" }}
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip content={paused ? "Resume" : "Pause"}>
        <Btn
          small
          icon={paused ? "play" : "pause"}
          disabled={busy}
          onClick={() =>
            paused
              ? run("resume_campaign", "Campaign resumed.", { status: "active" })
              : run("pause_campaign", "Campaign paused.", { status: "paused" })
          }
        >
          {""}
        </Btn>
      </Tooltip>
      {isMeta && (
        <>
          <Tooltip content="Edit daily budget">
            <Btn small icon="pencil" disabled={busy} onClick={onEditBudget}>{""}</Btn>
          </Tooltip>
          <Tooltip content="Duplicate (created paused)">
            <Btn
              small
              icon="copy"
              disabled={busy}
              onClick={() => run("duplicate_campaign", "Copy created on Meta (paused).", {})}
            >
              {""}
            </Btn>
          </Tooltip>
        </>
      )}
    </div>
  );
}
```

`CampaignList` owns the state: `const [overrides, setOverrides] = useState<Record<string, Partial<CampaignVM>>>({})` merged over `joined` before filtering (`shown = joined.map(c => ({ ...c, ...overrides[c.id] }))`), plus `const [budgetFor, setBudgetFor] = useState<CampaignVM | null>(null)` rendering `<EditBudgetModal>` when set (its `onSaved` writes `{ daily_budget_cents: newCents }` into overrides). Icons: check `CD_ICONS` in `app/components/dashboard/icons.tsx` for `play`, `pause`, `pencil`, `copy` — add missing ones as one-line lucide imports per the registry convention. Duplicate success note: the copy appears in the list after the next sync; the toast says "created on Meta (paused)" so the user isn't confused by it not appearing instantly.

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → exit 0. `npx vitest run app/components/dashboard` → pass.
Manual: `npm run build` → exit 0 (catches client/server import mistakes).

```bash
git add app/components/dashboard/screens/EditBudgetModal.tsx app/components/dashboard/screens/Campaigns.tsx app/components/dashboard/icons.tsx
git commit -m "dashboard/Campaigns: row quick actions (pause/resume, edit budget, duplicate)"
```

### Task 5: Per-campaign performance chart

**Files:**
- Modify: `app/lib/calderyn.server.ts` (add `campaignRoasSeries` next to `dailyRoasSeries` at :938)
- Create: `app/routes/dashboard.api.campaigns.$id.series.tsx`
- Modify: `app/lib/dashboard/client.ts` (add `fetchCampaignSeries`)
- Modify: `app/components/dashboard/screens/Campaigns.tsx` (`CampaignDetail` renders the chart)
- Create: `app/lib/__tests__/campaign-series-shape.test.ts`

**Interfaces:**
- Consumes: `ad_spend_fact` columns `day, spend_cents, revenue_attrib_cents, campaign_id, shop_id` (verified via `v_campaigns_flat` migration), `DailyRoasRow` (`app/lib/types.ts:302`), `Sparkline` (`ui.tsx:404`, props `{ data: number[]; width?; height?; stroke?; refLine? }`), `apiGet` (`client.ts:114`).
- Produces: `campaignRoasSeries(campaignId: string, windowDays?: number): Promise<DailyRoasRow[]>` (method on the same client object as `dailyRoasSeries`); GET `/dashboard/api/campaigns/:id/series?days=90` → `{ series: DailyRoasRow[] }`; client `fetchCampaignSeries(id: string, days?: number): Promise<DailyRoasRow[]>`.

- [ ] **Step 1: Write the failing test (pure shaping)**

Extract the day-aggregation as a pure function so it's testable without Supabase (mirror how `dailyRoasSeries` aggregates; if its aggregation is inline, extract a shared pure helper `aggregateSpendRows(rows): DailyRoasRow[]` and reuse it in both):

```ts
// app/lib/__tests__/campaign-series-shape.test.ts
import { describe, expect, it } from "vitest";
import { aggregateSpendRows } from "../roas-series";

describe("aggregateSpendRows", () => {
  it("sums spend and revenue per day, ordered by day", () => {
    const rows = [
      { day: "2026-07-01", spend_cents: 100, revenue_attrib_cents: 300 },
      { day: "2026-07-01", spend_cents: 50, revenue_attrib_cents: 0 },
      { day: "2026-07-02", spend_cents: 200, revenue_attrib_cents: 800 },
    ];
    expect(aggregateSpendRows(rows)).toEqual([
      { day: "2026-07-01", spend_cents: 150, revenue_cents: 300 },
      { day: "2026-07-02", spend_cents: 200, revenue_cents: 800 },
    ]);
  });

  it("returns [] for no rows", () => {
    expect(aggregateSpendRows([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — must fail** (`app/lib/roas-series.ts` doesn't exist)

- [ ] **Step 3: Implement**

`app/lib/roas-series.ts` (pure, client-safe):

```ts
import type { DailyRoasRow } from "./types";

export interface SpendFactRow {
  day: string;
  spend_cents: number;
  revenue_attrib_cents: number;
}

export function aggregateSpendRows(rows: SpendFactRow[]): DailyRoasRow[] {
  const byDay = new Map<string, DailyRoasRow>();
  for (const r of rows) {
    const cur = byDay.get(r.day) ?? { day: r.day, spend_cents: 0, revenue_cents: 0 };
    cur.spend_cents += r.spend_cents ?? 0;
    cur.revenue_cents += r.revenue_attrib_cents ?? 0;
    byDay.set(r.day, cur);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
```

`calderyn.server.ts` — add beside `dailyRoasSeries` (same query shape, plus `.eq("campaign_id", campaignId)` and an explicit `.limit(400)` — PostgREST clamps at 1000):

```ts
async campaignRoasSeries(campaignId: string, windowDays = 90): Promise<DailyRoasRow[]> {
  const since = isoDaysAgo(windowDays); // reuse the same `since` computation dailyRoasSeries uses
  const { data, error } = await sb
    .from("ad_spend_fact")
    .select("day, spend_cents, revenue_attrib_cents")
    .eq("shop_id", shopId)
    .eq("campaign_id", campaignId)
    .gte("day", since)
    .order("day")
    .limit(400);
  if (error) throw error;
  return aggregateSpendRows((data ?? []) as SpendFactRow[]);
}
```

Route `app/routes/dashboard.api.campaigns.$id.series.tsx` (loader — read-only; mirror the loader/session/envelope pattern of `dashboard.api.campaigns.$id.tsx`):

```ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { clientForShop } from "~/lib/calderyn.server"; // use the same factory dashboard.api.analytics.tsx uses

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = params.id;
  if (!id) return jsonError(422, "missing_campaign_id");
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 90, 7), 180);
  return dashboardJson(async () => {
    const client = await clientForShop(session.shopId);
    return { series: await client.analytics.campaignRoasSeries(id, days) };
  });
}
```

(Adopt the exact client-construction call from `dashboard.api.analytics.tsx:12-18` — same object, same method placement.)

Client (`client.ts`):

```ts
export async function fetchCampaignSeries(id: string, days = 90): Promise<DailyRoasRow[]> {
  const res = await apiGet<{ series: DailyRoasRow[] }>(
    `/dashboard/api/campaigns/${encodeURIComponent(id)}/series?days=${days}`,
  );
  return res.series;
}
```

`CampaignDetail` (Campaigns.tsx): fetch on mount (same `useEffect`+`alive` pattern the screen already uses for `fetchAnalytics`), render a Card with two labeled `Sparkline`s (spend/day and ROAS/day where `roas = revenue/spend` guarding divide-by-zero, `refLine={c.breakeven_roas}` on the ROAS one), and a one-line friendly empty state ("No history yet — data appears after the first day of spend") when `series.length < 2`.

- [ ] **Step 4: Run tests + typecheck + commit**

`npx vitest run app/lib/__tests__/campaign-series-shape.test.ts` → PASS. `npm run typecheck` → 0.

```bash
git add app/lib/roas-series.ts app/lib/__tests__/campaign-series-shape.test.ts app/lib/calderyn.server.ts app/routes/dashboard.api.campaigns.\$id.series.tsx app/lib/dashboard/client.ts app/components/dashboard/screens/Campaigns.tsx
git commit -m "dashboard/Campaigns: per-campaign spend + ROAS history chart"
```

### Task 6: PR 1 gate + open PR

- [ ] Run the full pre-commit gate: `/code-review` on the branch diff; fix blockers. Then `npm run typecheck` → 0, `npm run lint` → 0 on touched files, `npm run build` → 0, `npx vitest run` → all pass.
- [ ] Push and open PR: title `dashboard/Campaigns: polish + everyday controls (overhaul phase 1, PR 1/3)`, body summarizes Tasks 1–5, links the spec, ends with the platform-pivot progress footer if applicable and the standard generated-with footer. Do NOT merge without John's go (repo CI is known-red on forks; local gate is authoritative).

---

## PR 2 — wizard UI + preflight (branch `feat/campaigns-wizard` off PR 1's branch)

### Task 7: `campaign_wizard_runs` migration

**Files:**
- Create: `supabase/migrations/<timestamp>_campaign_wizard_runs.sql` (timestamp = actual UTC now, `YYYYMMDDHHMMSS`)

**Interfaces:**
- Produces: table `campaign_wizard_runs(id uuid pk default gen_random_uuid(), shop_id uuid not null references shops(id) on delete cascade, status text not null check (status in ('creating','created','rolled_back','failed')), input jsonb not null, meta_campaign_id text, meta_adset_id text, meta_ad_id text, error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`.

- [ ] **Step 1: Write the migration** — copy the RLS/index/revoke pattern verbatim from `supabase/migrations/20260703010000_campaign_draft.sql` (shop-scope policy on `current_shop_id()`, `revoke all ... from anon, authenticated`, `create index campaign_wizard_runs_shop_idx on public.campaign_wizard_runs (shop_id, created_at desc)`).
- [ ] **Step 2: Apply to prod via the supabase MCP** (`apply_migration`) — this project has no staging; confirm with `list_migrations` that the version registered.
- [ ] **Step 3: Commit** — `git add supabase/migrations/*campaign_wizard_runs.sql && git commit -m "supabase: campaign_wizard_runs table (wizard idempotency + rollback bookkeeping)"`

### Task 8: Meta preflight (server + GET route)

**Files:**
- Create: `app/lib/meta/first-run.server.ts`
- Create: `app/lib/meta/__tests__/first-run-preflight.test.ts`
- Create: `app/routes/dashboard.api.campaigns.first-run.tsx` (GET loader; the POST action arrives in Task 12)
- Modify: `app/lib/dashboard/client.ts` (add `fetchFirstRunPreflight`)

**Interfaces:**
- Consumes: `metaWriteClientForShopId` (`ad-create.server.ts:117`), `metaDraftPushEnabled(sb, shopId)` (`ad-create.server.ts:148`), `MetaClient`.
- Produces:
```ts
export interface FirstRunPreflight {
  metaConnected: boolean;
  adsScope: boolean;
  pageOk: boolean;
  fundingOk: boolean | null; // null = Meta didn't tell us; UI shows a "check billing" link, never blocks
}
export async function firstRunPreflight(
  shopId: string,
  sb: SupabaseClient,
  deps?: { resolveConn?: (shopId: string) => Promise<MetaWriteConn | null> },
): Promise<FirstRunPreflight>
```
Client: `fetchFirstRunPreflight(): Promise<FirstRunPreflight>` → GET `/dashboard/api/campaigns/first-run`.

- [ ] **Step 1: Failing test** — fake `MetaWriteConn` whose `client.get` returns canned payloads:

```ts
// app/lib/meta/__tests__/first-run-preflight.test.ts
import { describe, expect, it } from "vitest";
import { firstRunPreflight } from "../first-run.server";
import type { MetaResponse } from "../campaigns.server";

const sbWithScopes = (scopes: string | null) =>
  ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: scopes === null ? null : { scopes }, error: null }),
          }),
        }),
      }),
    }),
  }) as never;

const conn = (pages: unknown[], funding?: unknown) => ({
  adAccountId: "act_1",
  client: {
    post: async () => ({} as MetaResponse),
    get: async (path: string) =>
      (path.includes("promote_pages")
        ? { data: pages }
        : { funding_source_details: funding }) as MetaResponse,
  },
});

describe("firstRunPreflight", () => {
  it("all green with scope + page + funding", async () => {
    const res = await firstRunPreflight("shop", sbWithScopes("ads_management,ads_read"), {
      resolveConn: async () => conn([{ id: "77" }], { id: "f1" }),
    });
    expect(res).toEqual({ metaConnected: true, adsScope: true, pageOk: true, fundingOk: true });
  });

  it("not connected: everything false, fundingOk null", async () => {
    const res = await firstRunPreflight("shop", sbWithScopes(null), { resolveConn: async () => null });
    expect(res).toEqual({ metaConnected: false, adsScope: false, pageOk: false, fundingOk: null });
  });

  it("funding lookup failure reports null (advisory), not false", async () => {
    const badFunding = conn([{ id: "77" }]);
    badFunding.client.get = async (path: string) =>
      (path.includes("promote_pages") ? { data: [{ id: "77" }] } : { error: { message: "denied" } }) as MetaResponse;
    const res = await firstRunPreflight("shop", sbWithScopes("ads_management"), {
      resolveConn: async () => badFunding,
    });
    expect(res.fundingOk).toBeNull();
    expect(res.pageOk).toBe(true);
  });
});
```

- [ ] **Step 2: Run — must fail** (module missing).
- [ ] **Step 3: Implement** `first-run.server.ts`: resolve conn (injected seam defaulting to `metaWriteClientForShopId`); `metaConnected = !!conn`; `adsScope` via the same `integration_credentials.scopes` read `metaDraftPushEnabled` does (reuse it, passing `sb`); `pageOk` = `GET /{adAccountId}/promote_pages?fields=id` has ≥1 row (errors → false); `fundingOk` = `GET /{adAccountId}?fields=funding_source_details` → `true` if present, `null` on error/absent field. Never throw for a red check — the shape IS the answer.
- [ ] **Step 4: GET loader** in `dashboard.api.campaigns.first-run.tsx`: `requireDashboardSession`, `dashboardJson(async () => firstRunPreflight(session.shopId, getSupabase()))`. Client helper `fetchFirstRunPreflight` via `apiGet`.
- [ ] **Step 5: Tests PASS + typecheck + commit** — `git commit -m "campaigns: first-run Meta preflight (scope, page, funding checks)"`

### Task 9: From-product creative generation endpoint

**Files:**
- Create: `app/lib/screener/product-creative.server.ts`
- Create: `app/lib/screener/__tests__/product-creative.test.ts`
- Create: `app/routes/dashboard.api.campaigns.first-run.creatives.tsx` (POST)
- Modify: `app/lib/dashboard/client.ts` (add `generateFirstRunCreatives`)

**Interfaces:**
- Consumes: `generateImprovements(args, deps)` (`generate.server.ts:37`), `pickGenerator(mode, deps)` (`pick-generator.server.ts:10`), `gateScoreDeps` (`score-one.server.ts` — mirror the dep wiring used by `dashboard.api.campaigns.$id.regenerate.tsx`), product detail via the same server path `dashboard.api.catalog.products.$id` uses, `getShopStorefrontOrigin(shopId)` (`app/lib/storefront/shop.server.ts:34`).
- Produces:
```ts
export function buildProductCreative(p: {
  title: string; description: string | null; imageUrl: string | null;
  productUrl: string; price: string | null;
}): CreativeInput
```
POST `/dashboard/api/campaigns/first-run/creatives` `{ productId }` → `{ available: boolean; variants: Array<{ headline: string; primaryText: string; cta: string; rationale: string }> }`. Client: `generateFirstRunCreatives(productId: string)`.

- [ ] **Step 1: Failing test for the pure builder**

```ts
// app/lib/screener/__tests__/product-creative.test.ts
import { describe, expect, it } from "vitest";
import { buildProductCreative } from "../product-creative.server";

describe("buildProductCreative", () => {
  it("shapes a complete CreativeInput from a product", () => {
    const c = buildProductCreative({
      title: "Peak Wool Beanie",
      description: "Warm merino beanie for cold trailheads.",
      imageUrl: "https://cdn.example.com/beanie.jpg",
      productUrl: "https://acme.calderyncompany.com/storefront/products/peak-wool-beanie",
      price: "$32",
    });
    expect(c.headline).toBe("Peak Wool Beanie");
    expect(c.primaryText).toContain("merino");
    expect(c.cta).toBe("SHOP_NOW");
    expect(c.destinationUrl).toContain("/storefront/products/peak-wool-beanie");
    expect(c.imageUrl).toBe("https://cdn.example.com/beanie.jpg");
    expect(c.audience).toBe("");
  });

  it("tolerates a missing description and image", () => {
    const c = buildProductCreative({ title: "T", description: null, imageUrl: null, productUrl: "https://x/p", price: null });
    expect(c.primaryText.length).toBeGreaterThan(0);
    expect(c.imageUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run — must fail.**
- [ ] **Step 3: Implement** — `buildProductCreative` returns `{ imageUrl, mediaKind: imageUrl ? "image" : null, headline: title (truncate 40 chars), primaryText: description first ~125 chars or "Now available at our store." + price mention when present, cta: "SHOP_NOW", destinationUrl: productUrl, audience: "" }`. The route action: `requireSameOrigin` + session; load the product server-side (same lib the catalog product-detail route uses — resolve title/description/primary image/handle); `productUrl = \`${await getShopStorefrontOrigin(shopId)}/storefront/products/${handle}\``; build the original; wire `generateImprovements({ original, originalScorecard, count: 3 }, deps)` with the SAME `pickGenerator("copy", ...)` + `gateScoreDeps` construction as `dashboard.api.campaigns.$id.regenerate.tsx` (open that file and copy its dep block verbatim); score the original first via the same `scoreOne`. If the generator is unavailable (no API key), return `{ available: false, variants: [] }` — the wizard falls back to manual copy editing with `buildProductCreative`'s defaults prefilled. Map variants to the wire DTO (never leak internal `Variant` verbatim: pick `headline/primaryText/cta` from `v.input`, plus `v.rationale`).
- [ ] **Step 4: Tests PASS + typecheck + commit** — `git commit -m "campaigns: from-product creative generation for the first-run wizard"`

### Task 10: Wizard UI

**Files:**
- Create: `app/components/dashboard/screens/CampaignWizard.tsx`
- Modify: `app/components/dashboard/screens/Campaigns.tsx` (entry points; delete `CampaignNew`; draft-row actions)

**Interfaces:**
- Consumes: `fetchFirstRunPreflight`, `generateFirstRunCreatives`, `startIntegrationConnect("meta")` (`client.ts:669`), `fetchProducts` (`client.ts:1239`), `createCampaignDraft` (drafts client), `Btn/Card/Placeholder/Segmented` from `../ui`, `DashboardCtx` (`app.navigate`, `app.toast`, `app.campaigns`).
- Produces: `<CampaignWizard app={DashboardCtx} prefill={{ name?: string; platform?: CampaignDraftPlatform } | null} onExit={() => void} />` — steps: `platform` → `product` → `creative` → `review`. In PR 2 the Meta review step's create button is disabled with copy "Creating on Meta arrives in the next update" ONLY if PR 3 isn't merged yet — implement the button wiring in Task 13 and keep this stub honest. Google/TikTok review step renders the written plan + launch instructions and a "Save as draft" (`createCampaignDraft`).

- [ ] **Step 1: Build the component.** Single-file, four step components + a header with step dots and a persistent "Skip — I know what I'm doing" link (calls `onExit`). Step contents:
  1. **Platform**: three `Card hover` tiles (Meta featured). Below, for Meta when preflight says `!metaConnected`: two buttons — "I have a Meta ad account" → `startIntegrationConnect("meta")` then `window.location.href = url`; "I don't have one yet" → expands a 3-item numbered list (create business portfolio at business.facebook.com → create ad account + add billing → come back and connect) with external links, then the same connect button. When connected: green check rows for scope/page/funding from preflight (funding `null` renders "Make sure billing is set up" with a link to `https://business.facebook.com/billing_hub/accounts`, advisory tone).
  2. **Product**: search + grid of `fetchProducts({ status: "active" })` (image, title, price); budget input with the plain-guidance line and client clamp 500–20000 cents inline error copy ("between $5 and $200 a day").
  3. **Creative**: call `generateFirstRunCreatives(productId)`; render up to 3 variant cards (headline/primaryText, radio-select) with every field editable in place; `available: false` → single prefilled editable card with a quiet note ("Wrote a starting point — edit anything").
  4. **Review**: summary rows (product, budget/day + monthly estimate, audience "Broad — {country}", creative preview) + the platform-appropriate finish (Meta: create button — Task 13; Google/TikTok: the plan as copyable text + "Save as draft").
  State: one `useReducer` with `{ step, platform, productId, budgetCents, creative, preflight }`. All fetches use the screen's existing `alive`-flag effect pattern.
- [ ] **Step 2: Wire entries.** In `Campaigns.tsx`: `nav.param === "new"` renders `<CampaignWizard app={app} prefill={null} onExit={() => app.navigate("campaigns")} />` (delete `CampaignNew` and its fake empty-stat grid entirely). Empty state (`shown.length === 0 && drafts.length === 0 && !app.loading`): render the wizard inline instead of `Placeholder`, with the skip link revealing the plain list+connect Placeholder (local `skipped` state). Draft rows get two small buttons (stop `onClick` propagation): "Continue setup" → `app.navigate("campaigns", "new")` with prefill carried via component state lifted in `Campaigns.tsx` (`const [draftPrefill, setDraftPrefill] = useState(...)`), and delete (DELETE via a new `deleteCampaignDraft(id)` client helper — add route support if `dashboard.api.campaign-drafts` lacks DELETE; follow its POST validation pattern).
- [ ] **Step 3: Verify** — `npm run typecheck` → 0; `npm run build` → 0; `npx vitest run app/components/dashboard` → pass. Manual walkthrough on localhost per `local-dashboard-dev-recipe` (steps 1–3 + Google/TikTok finish; Meta finish arrives Task 13).
- [ ] **Step 4: Commit** — `git commit -m "dashboard/Campaigns: first-campaign wizard (connect, product+budget, AI creative, review)"`

### Task 11: PR 2 gate + open PR

- [ ] Full gate (same commands as Task 6). PR title: `dashboard/Campaigns: first-campaign wizard UI + Meta preflight (overhaul phase 1, PR 2/3)`.

---

## PR 3 — Meta create + turn-on (branch `feat/campaigns-meta-create` off PR 2)

### Task 12: `createFirstCampaign` (Meta writes + rollback)

**Files:**
- Create: `app/lib/meta/campaign-create.server.ts`
- Create: `app/lib/meta/__tests__/campaign-create.test.ts`

**Interfaces:**
- Consumes: `MetaClient`, `MetaWriteConn`, `createPausedAd(client, { adAccountId, adSetId, creative })` (`ad-create.server.ts:60`), `withRetry`, the module-local `check` pattern (copy the retriable-aware `check` + `META_PERMANENT_CODES` block from `ad-create.server.ts:25-37` — repo convention is each write module keeps its own copy), `CreativeInput`.
- Produces:
```ts
export interface FirstCampaignInput {
  name: string;
  dailyBudgetCents: number;   // pre-clamped by the route; assert 500..20000 here too
  countryCode: string;        // e.g. "US"
  creative: CreativeInput;
}
export async function createFirstCampaign(
  conn: MetaWriteConn,
  input: FirstCampaignInput,
  retry?: RetryOptions,
): Promise<{ campaignId: string; adSetId: string; adId: string }>
```

- [ ] **Step 1: Failing tests** — fake `MetaClient` records posts; cover: (a) happy path posts `/act_1/campaigns` with `{ objective: "OUTCOME_SALES", status: "PAUSED", special_ad_categories: "[]" }`, then `/act_1/adsets` with `{ campaign_id, daily_budget: "1500", billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", status: "PAUSED" }` and `targeting` JSON containing `{"geo_locations":{"countries":["US"]}}`, then the creative+ad posts (via `createPausedAd` — assert the ad-set id flowed through), returning all three ids; (b) ad-set failure → campaign deleted (`POST /{campaignId}` `{ status: "DELETED" }`) and the error rethrown; (c) ad failure → campaign deleted, error rethrown; (d) budget outside 500–20000 throws before any post; (e) rollback-delete failure does not mask the original error (original message present, rollback failure logged). Write the test file completely (same fake-client style as `duplicate-campaign.test.ts` in Task 3).
- [ ] **Step 2: Run — must fail.**
- [ ] **Step 3: Implement** — three sequential `withRetry(check(post(...)))` calls; ids from `body.id`; wrap steps 2–3 in try/catch → rollback `POST /{campaignId} { status: "DELETED" }` inside its own try/catch (log rollback failure, rethrow the ORIGINAL error). Ad-set/campaign names: `input.name` and `` `${input.name} — Ad set` ``. `PAUSED` literals everywhere; assert the clamp at entry (`throw new Error("dailyBudgetCents out of range 500-20000")`).
- [ ] **Step 4: Tests PASS + typecheck + commit** — `git commit -m "meta: createFirstCampaign (campaign→adset→ad, all paused, rollback on partial failure)"`

### Task 13: First-run POST route (idempotent create + mirror + audit)

**Files:**
- Modify: `app/routes/dashboard.api.campaigns.first-run.tsx` (add the `action`)
- Create: `app/routes/__tests__/first-run-parse.test.ts`
- Modify: `app/lib/dashboard/client.ts` (add `createFirstCampaignRun`)

**Interfaces:**
- Consumes: `createFirstCampaign` (Task 12), `metaWriteClientForShopId`, `metaDraftPushEnabled`, `insertAuditWithIdempotency` (`execute.server.ts:154`), `campaign_wizard_runs` (Task 7), `shops.country` (fallback `"US"` when null), `getSupabase()`.
- Produces:
  - Exported pure parser (TDD target):
```ts
export type ParsedFirstRun =
  | { ok: true; runId: string; productId: string; budgetCents: number;
      creative: { headline: string; primaryText: string; cta: string; imageUrl: string | null; destinationUrl: string } }
  | { ok: false; error: { code: string; message: string } };
export function parseFirstRunBody(body: Record<string, unknown>): ParsedFirstRun
```
  - POST `/dashboard/api/campaigns/first-run` → `{ run_id, campaign_dim_id, status: "created" }`; replay with same `runId` returns the stored result (no second Meta create).
  - Client: `createFirstCampaignRun(input): Promise<{ runId: string; campaignDimId: string }>`.

- [ ] **Step 1: Failing parser tests** — valid body passes and clamps nothing (in-range); budget 400 or 25000 → `{ ok: false, error.code: "budget_out_of_range" }`; missing runId/productId/headline/destinationUrl → specific codes; non-string fields rejected. Write the full test file (5–6 cases, plain object in/out — same style as `parseRegenBody` tests if present, else the `parsePushDraftCreative` style).
- [ ] **Step 2: Run — must fail. Implement the parser** (trim strings, `MAX` name lengths sane: headline ≤ 40, primaryText ≤ 500).
- [ ] **Step 3: Implement the action.** Order: `requireSameOrigin` → session → method check → parse → scope gate (`metaDraftPushEnabled` else 403 `meta_scope_insufficient`) → **idempotency**: `select` `campaign_wizard_runs` by `(shop_id, id = runId)`; if `status = 'created'` return stored ids; if `creating` return 409 `run_in_progress`; else insert `{ id: runId, shop_id, status: 'creating', input }` (unique-violation on concurrent insert → 409) → resolve conn (`metaWriteClientForShopId`, null → 403 `meta_not_connected`) → read `shops.country` → `createFirstCampaign` → on success: update run row (`status 'created'`, meta ids), insert `ad_campaign_dim` mirror `{ shop_id, external_id: campaignId, platform: "meta", name, status: "paused", daily_budget_cents }` returning id, audit row via `insertAuditWithIdempotency(shopId, \`first_run:${runId}\`, { action_kind: "create_campaign_wizard", params: { run_id, product_id, budget_cents }, outcome: "succeeded", pre_state: null, post_state: { meta ids }, alert_id: null, last_error: null, actor_user_id: "merchant", trigger_reason: "first_campaign_wizard" }, sb)` → `dashboardJson` result. On `createFirstCampaign` throw: update run `status 'failed'` (or `'rolled_back'` — set from a flag the error carries; simplest: `'rolled_back'` since the module rolls back, `'failed'` when the rollback itself failed, detectable via a `RollbackFailedError` subclass thrown by Task 12 — add that subclass there carrying `orphanCampaignId`), then `jsonError(502, "meta_create_failed", message)`. Destination URL gets UTM params appended here (server-side, once): `utm_source=meta&utm_medium=paid&utm_campaign=${runId}`.
- [ ] **Step 4: Wire the wizard's Meta finish** (`CampaignWizard.tsx` review step): `runId = crypto.randomUUID()` held in wizard state (stable across retries); create button → `createFirstCampaignRun` → success screen: "Created on Meta — paused" card with the big **Turn on** button → `executeCampaignAction(campaignDimId, { type: "resume_campaign" })` → toast + `app.navigate("campaigns")`. Also a quiet "keep it paused for now" exit link.
- [ ] **Step 5: Tests + typecheck + build + commit** — `git commit -m "campaigns: first-run create route (idempotent, audited) + wizard turn-on"`

### Task 14: PR 3 gate + live e2e

- [ ] Full gate (Task 6 commands).
- [ ] **Live e2e against John's Meta ad account** (get his explicit go in-session first): run the wizard with a real product, budget $5/day → verify in Meta Ads Manager: campaign+adset+ad exist, ALL show OFF/PAUSED → verify replaying the POST with the same runId creates nothing new → delete the campaign in Ads Manager (or via a one-off `POST /{id} {status:"DELETED"}` script) → verify `campaign_wizard_runs` row and audit row exist. **Never click Turn on during the test.**
- [ ] Open PR: `dashboard/Campaigns: Meta campaign create + turn-on (overhaul phase 1, PR 3/3)`. Include the e2e evidence (screenshots/ids) in the PR body.

---

## Self-review notes (already applied)

- Spec §1a "resume where I left off" is satisfied by draft "Continue setup" + stable `runId` retry; no separate resume UI in Phase 1.
- Spec §1c chart: per-campaign series verified feasible (`ad_spend_fact.campaign_id` exists — see `v_campaigns_flat` migration `20260616120100`).
- `PlatformMark` name collision between the WIP and main's `ui.tsx` resolved in Task 1 (shared component wins).
- Zero-spend campaigns DO appear in `v_campaigns_flat` (left join from `ad_campaign_dim`) — the mirror insert in Task 13 makes the new campaign listable immediately.
- Screen-cache: Campaigns uses `app.campaigns` from the existing warm path; the wizard adds no new screen, so no new `WARM_TARGETS` entry is required.
