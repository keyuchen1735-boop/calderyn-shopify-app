# Campaigns Scale-Up — Plan 2: UI (settings plumbing + Polaris extension + dashboard mirror) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Plan 1** (`...-1-backend.md`) being merged: this plan assumes `increase_campaign_budget` (ExecutableKind/ActionKind), `campaign_scaling_opportunity` (DetectorId + detector + alert), the two `guardrail_config` columns, and the labels already exist.

**Goal:** Let merchants see and approve a one-click "Scale budget" suggestion on winning campaigns, and expose the two new autopilot caps — on both the Shopify Polaris extension and the separate dashboard.

**Architecture:** Both surfaces read the open `campaign_scaling_opportunity` alert as the single source of truth (so the suggestion shown matches what autopilot would do) and approve by calling the shared `executeAction("increase_campaign_budget")` orchestrator. The new guardrail caps are threaded through the shared `GuardrailConfig` type → `rowToGuardrails`/`update` (extension) and `GuardrailVM`/`PATCHABLE_KEYS` (dashboard).

**Tech Stack:** TypeScript, Remix, Shopify Polaris (extension), the dashboard's own React/CSS primitives, Supabase, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-campaigns-scale-up-design.md` (§4.5, §4.6).

**Key facts (verified):**
- Extension alerts: `client.alerts.list(filters, signal): Promise<Alert[]>` reads `v_alerts_view` and maps via `rowToAlert` (`calderyn.server.ts:277`). The extension `Alert` DTO (`types.ts:31`) exposes `campaign` (name) and `evidence` but **not** `campaign_id` — Task 4 adds it.
- Dashboard alerts: `app.alerts` is `AlertVM[]`, which already has `campaign_id`, `status`, `detector_id`, `dollar_impact` (`view-models.ts`); `CampaignDetail` already filters `app.alerts` by `campaign_id` (`Campaigns.tsx:241`).
- Guardrail config plumbing: `GuardrailConfig` type (`types.ts:164`), DB→VM read `rowToGuardrails` (`calderyn.server.ts:198`), VM→DB write `update` (`calderyn.server.ts:910`), dashboard patch validation `validateGuardrailPatch` (`guardrails-validation.ts`), dashboard whitelist `PATCHABLE_KEYS` (`dashboard.api.guardrails.tsx`), dashboard `GuardrailVM` (`view-models.ts:117`).
- Manual scale step uses the same configured percentage as autopilot: `autopilot_max_budget_increase_pct` (default 20).

---

## File Structure

**Modify (shared config plumbing):**
- `app/lib/types.ts` — `GuardrailConfig`: add the two caps.
- `app/lib/calderyn.server.ts` — `rowToGuardrails` (read) + `update` (write): map the two caps.
- `app/lib/dashboard/guardrails-validation.ts` — validate the two caps.
- `app/components/dashboard/view-models.ts` — `GuardrailVM`: add the two caps; the `Alert` DTO is in the extension only.
- `app/routes/dashboard.api.guardrails.tsx` — `PATCHABLE_KEYS`: add the two.

**Modify (extension UI):**
- `app/routes/app.settings.tsx` — `GuardrailsCard` + action handler: two new fields.
- `app/lib/types.ts` + `app/lib/calderyn.server.ts` (`rowToAlert`) — add `campaign_id` to the `Alert` DTO.
- `app/routes/app.campaigns._index.tsx` — loader (scale-suggestion map), `RowActions` (Scale item), badge, `ScaleBudgetModal`, `action` (intent `scale`), `PendingAction` type.

**Modify (dashboard UI):**
- `app/lib/dashboard/client.ts` — `CampaignActionInput.type` already `string`; no type change, but allow the new kind in callers.
- `app/routes/dashboard.api.campaigns.$id.action.tsx` — `KINDS`: add `increase_campaign_budget`.
- `app/components/dashboard/screens/Campaigns.tsx` — scale badge on `CampaignRow`, "Scale budget" button on `CampaignDetail`, `run` supports the new kind.
- the dashboard Settings screen component — two new fields (located in Task 8).

---

## Task 1: Thread the two caps through `GuardrailConfig` (read + write) (TDD)

**Files:**
- Test: `app/lib/dashboard/__tests__/guardrails-validation.test.ts`
- Modify: `app/lib/types.ts:164-175`, `app/lib/calderyn.server.ts:198-221` (read), `:910-935` (write), `app/lib/dashboard/guardrails-validation.ts`

- [ ] **Step 1: Write the failing validation tests**

In `app/lib/dashboard/__tests__/guardrails-validation.test.ts`, add cases mirroring the existing `autopilot_max_budget_cut_pct` ones:

```typescript
  it("rejects an out-of-range increase pct", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: 999 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: -1 })).not.toBeNull();
  });
  it("accepts a valid increase pct and a null ceiling", () => {
    expect(validateGuardrailPatch({ autopilot_max_budget_increase_pct: 20, autopilot_max_daily_budget_cents: null })).toBeNull();
  });
  it("rejects a negative daily ceiling", () => {
    expect(validateGuardrailPatch({ autopilot_max_daily_budget_cents: -100 })).not.toBeNull();
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run app/lib/dashboard/__tests__/guardrails-validation.test.ts`
Expected: FAIL — `autopilot_max_budget_increase_pct`/`autopilot_max_daily_budget_cents` are not on `Partial<GuardrailConfig>` (type error), and even cast through, validation doesn't reject them.

- [ ] **Step 3: Add to `GuardrailConfig`** (`types.ts:164`)

```typescript
export interface GuardrailConfig {
  daily_action_budget_cents: number;
  daily_action_budget_used_cents: number;
  dollar_cap_cents: number;
  cooldown_minutes: number;
  business_hours: { start: string; end: string; tz: string };
  in_business_hours: boolean;
  autopilot_enabled: boolean;
  autopilot_daily_action_cap: number;
  autopilot_min_spend_cents: number;
  autopilot_max_budget_cut_pct: number;
  autopilot_max_budget_increase_pct: number;
  /** Hard per-campaign daily-budget ceiling for autopilot scale-ups; null = none. */
  autopilot_max_daily_budget_cents: number | null;
}
```

- [ ] **Step 4: Map on read** (`calderyn.server.ts:219`, inside `rowToGuardrails`, after `autopilot_max_budget_cut_pct`)

```typescript
    autopilot_max_budget_cut_pct: Number(r.autopilot_max_budget_cut_pct ?? 50),
    autopilot_max_budget_increase_pct: Number(r.autopilot_max_budget_increase_pct ?? 20),
    autopilot_max_daily_budget_cents:
      r.autopilot_max_daily_budget_cents == null ? null : Number(r.autopilot_max_daily_budget_cents),
```

- [ ] **Step 5: Map on write** (`calderyn.server.ts:927`, inside `update`, after the cut-pct line)

```typescript
          if (patch.autopilot_max_budget_cut_pct !== undefined) updates.autopilot_max_budget_cut_pct = patch.autopilot_max_budget_cut_pct;
          if (patch.autopilot_max_budget_increase_pct !== undefined) updates.autopilot_max_budget_increase_pct = patch.autopilot_max_budget_increase_pct;
          // null is a meaningful value here (clear the ceiling), so test for `undefined`.
          if (patch.autopilot_max_daily_budget_cents !== undefined) updates.autopilot_max_daily_budget_cents = patch.autopilot_max_daily_budget_cents;
```

- [ ] **Step 6: Validate the patch** (`guardrails-validation.ts`, after the `autopilot_max_budget_cut_pct` block)

```typescript
  if ("autopilot_max_budget_increase_pct" in patch) {
    const v = patch.autopilot_max_budget_increase_pct;
    if (!isFiniteNum(v) || v < 0 || v > 100) return "invalid_autopilot_max_budget_increase_pct";
  }

  if ("autopilot_max_daily_budget_cents" in patch) {
    const v = patch.autopilot_max_daily_budget_cents;
    // null = "no ceiling" is valid; otherwise a non-negative finite number.
    if (v !== null && (!isFiniteNum(v) || v < 0)) return "invalid_autopilot_max_daily_budget_cents";
  }
```

- [ ] **Step 7: Run, verify pass**

Run: `npx vitest run app/lib/dashboard/__tests__/guardrails-validation.test.ts && npm run typecheck`
Expected: tests PASS; typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/lib/dashboard/guardrails-validation.ts app/lib/dashboard/__tests__/guardrails-validation.test.ts
git commit -m "guardrails: thread budget-increase caps through GuardrailConfig read/write/validation"
```

---

## Task 2: Dashboard GuardrailVM + PATCHABLE_KEYS

**Files:**
- Modify: `app/components/dashboard/view-models.ts:117-129` (`GuardrailVM`) + wherever `GuardrailVM` is built
- Modify: `app/routes/dashboard.api.guardrails.tsx` (`PATCHABLE_KEYS`)

- [ ] **Step 1: Add the two fields to `GuardrailVM`** (`view-models.ts:127`)

```typescript
  autopilot_min_spend_cents: number;
  autopilot_max_budget_cut_pct: number;
  autopilot_max_budget_increase_pct: number;
  autopilot_max_daily_budget_cents: number | null;
```

- [ ] **Step 2: Populate them in the VM builder**

Find where `GuardrailVM` is constructed from the guardrail row/config: `npx grep -rn "autopilot_max_budget_cut_pct:" app/components/dashboard app/lib/dashboard`. In that builder (the same place the other `autopilot_*` fields are set), add:

```typescript
  autopilot_max_budget_increase_pct: Number(src.autopilot_max_budget_increase_pct ?? 20),
  autopilot_max_daily_budget_cents:
    src.autopilot_max_daily_budget_cents == null ? null : Number(src.autopilot_max_daily_budget_cents),
```

(Use the builder's actual source variable name in place of `src`.) If the dashboard consumes `GuardrailConfig` directly (no separate builder), the Task 1 read mapping already covers it — in that case only the `GuardrailVM` interface needs the fields.

- [ ] **Step 3: Whitelist the keys for PATCH** (`dashboard.api.guardrails.tsx`, `PATCHABLE_KEYS`)

```typescript
const PATCHABLE_KEYS: (keyof GuardrailConfig)[] = [
  "daily_action_budget_cents",
  "dollar_cap_cents",
  "cooldown_minutes",
  "business_hours",
  "autopilot_enabled",
  "autopilot_daily_action_cap",
  "autopilot_min_spend_cents",
  "autopilot_max_budget_cut_pct",
  "autopilot_max_budget_increase_pct",
  "autopilot_max_daily_budget_cents",
];
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add app/components/dashboard/view-models.ts app/routes/dashboard.api.guardrails.tsx
git commit -m "dashboard: expose budget-increase caps in GuardrailVM + PATCHABLE_KEYS"
```

---

## Task 3: Extension settings — two new autopilot fields

**Files:**
- Modify: `app/routes/app.settings.tsx` — `GuardrailsCard` (state + hidden inputs + fields) and the `update_guardrails` action handler

- [ ] **Step 1: Add state + sync** in `GuardrailsCard` (after `autopilotMaxBudgetCutPct`)

```typescript
  const [autopilotMaxBudgetIncreasePct, setAutopilotMaxBudgetIncreasePct] = useState(
    String(guardrails.autopilot_max_budget_increase_pct),
  );
  const [autopilotMaxDailyBudget, setAutopilotMaxDailyBudget] = useState(
    guardrails.autopilot_max_daily_budget_cents == null
      ? ""
      : String(Math.round(guardrails.autopilot_max_daily_budget_cents / 100)),
  );
```

And in the `useEffect([guardrails])` resync block:

```typescript
    setAutopilotMaxBudgetIncreasePct(String(guardrails.autopilot_max_budget_increase_pct));
    setAutopilotMaxDailyBudget(
      guardrails.autopilot_max_daily_budget_cents == null
        ? ""
        : String(Math.round(guardrails.autopilot_max_daily_budget_cents / 100)),
    );
```

- [ ] **Step 2: Add hidden inputs** (next to the `autopilot_max_budget_cut_pct` hidden input)

```typescript
        <input
          type="hidden"
          name="autopilot_max_budget_increase_pct"
          value={String(Math.max(0, Number(autopilotMaxBudgetIncreasePct)))}
        />
        {/* Empty string => clear the ceiling (no limit). Non-empty => dollars. */}
        <input
          type="hidden"
          name="autopilot_max_daily_budget"
          value={autopilotMaxDailyBudget.trim()}
        />
```

- [ ] **Step 3: Add the fields** to the "Autopilot limits" `FormLayout` (after the cut-% field)

```typescript
                      <FormLayout.Group>
                        <TextField
                          label="Most Calderyn can raise a winning campaign's budget at once (%)"
                          type="number"
                          value={autopilotMaxBudgetIncreasePct}
                          autoComplete="off"
                          onChange={setAutopilotMaxBudgetIncreasePct}
                          helpText="Budget scale-ups will not add more than this percentage in a single step."
                        />
                        <TextField
                          label="Never let a campaign's daily budget exceed (USD, optional)"
                          type="number"
                          value={autopilotMaxDailyBudget}
                          autoComplete="off"
                          onChange={setAutopilotMaxDailyBudget}
                          helpText="Leave blank for no ceiling. Autopilot will not scale a budget above this."
                        />
                      </FormLayout.Group>
```

- [ ] **Step 4: Parse them in the action handler** (`app.settings.tsx`, inside `if (intent === "update_guardrails")`, after the cut-pct `setIfPresent`)

```typescript
      setIfPresent("autopilot_max_budget_increase_pct", (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
      });
      // Empty input clears the ceiling (null); a number is stored as cents.
      {
        const raw = formData.get("autopilot_max_daily_budget");
        if (raw !== null) {
          const s = String(raw).trim();
          if (s === "") {
            patch.autopilot_max_daily_budget_cents = null;
          } else {
            const n = Number(s);
            if (Number.isFinite(n)) patch.autopilot_max_daily_budget_cents = Math.max(0, Math.round(n * 100));
          }
        }
      }
```

> `setIfPresent` can't express "null is valid", so the ceiling is handled inline. `patch` is the `Partial<GuardrailConfig>` already declared at the top of this block.

- [ ] **Step 5: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.settings.tsx
git commit -m "app/settings: expose autopilot budget-increase % + daily ceiling"
```

---

## Task 4: Extension campaigns — Scale suggestion, action, badge, modal (TDD where pure)

**Files:**
- Modify: `app/lib/types.ts` (`Alert` DTO: add `campaign_id`) + `app/lib/calderyn.server.ts` (`rowToAlert`: populate it)
- Modify: `app/routes/app.campaigns._index.tsx` — loader, `PendingAction`, `RowActions`, badge, `ScaleBudgetModal`, `action`

- [ ] **Step 1: Add `campaign_id` to the extension `Alert` DTO** (`types.ts:31`)

```typescript
export interface Alert {
  id: string;
  detector_id: DetectorId;
  severity: Severity;
  status: AlertStatus;
  dollar_impact: number;
  claude_rank: number;
  created_at: string;
  title: string;
  narrative: string;
  campaign: string | null;
  /** ad_campaign_dim uuid (from entity_ref), for matching alerts to rows. */
  campaign_id: string | null;
  sku: string | null;
  evidence: Record<string, any>;
}
```

- [ ] **Step 2: Populate it in `rowToAlert`**

Find `rowToAlert` in `calderyn.server.ts` (`npx grep -n "function rowToAlert" app/lib/calderyn.server.ts`). `v_alerts_view` exposes the campaign id the dashboard's `AlertVM.campaign_id` already uses — add the same field to the mapped object, e.g.:

```typescript
    campaign_id: (r.campaign_id as string | null) ?? null,
```

If the view column is named differently (e.g. it lives in `entity_ref`), mirror however `AlertVM.campaign_id` is sourced for the dashboard (the dashboard already resolves it — match that exact expression). Verify:

Run: `npx grep -rn "campaign_id" app/lib/dashboard/view-models* app/lib/calderyn.server.ts`
Expected: shows where `campaign_id` is read for alerts; reuse that expression.

- [ ] **Step 3: Loader — fetch open scale alerts and build the suggestion prefill**

In `app.campaigns._index.tsx`, alongside the existing `reallocation` prefill block, add (uses the configured increase pct to compute the proposed new budget):

```typescript
    // Scale suggestions: open campaign_scaling_opportunity alerts, matched to
    // the campaign rows. Single source of truth = the alert (so the merchant
    // sees what autopilot would do). Degrades visibly to "no badge" on failure.
    let scaleSuggestions: ScalePrefill[] = [];
    try {
      const [openScaleAlerts, gr] = await Promise.all([
        client.alerts.list({ status: "open", detector: "campaign_scaling_opportunity" }, request.signal),
        client.guardrails.get(request.signal),
      ]);
      const pct = gr.autopilot_max_budget_increase_pct || 20;
      scaleSuggestions = openScaleAlerts
        .map((a) => {
          const row = campaigns.find((c) => c.id === a.campaign_id);
          if (!row || row.status !== "active" || row.daily_budget_cents <= 0) return null;
          return {
            campaignId: row.id,
            alertId: a.id,
            projectedUpside: a.dollar_impact,
            newBudgetCents: Math.round(row.daily_budget_cents * (1 + pct / 100)),
            pct,
          } satisfies ScalePrefill;
        })
        .filter((s): s is ScalePrefill => s !== null);
    } catch {
      scaleSuggestions = [];
    }
```

Add `scaleSuggestions` to the `LoaderPayload` type and the `json<LoaderPayload>({ ... })` returns (both the success and the catch path — `scaleSuggestions: []` in the error return). Add the type near `ReallocationPrefill`:

```typescript
type ScalePrefill = {
  campaignId: string; // id as used by the campaigns list (Meta = external id)
  alertId: string;
  projectedUpside: number; // dollars, from the alert
  newBudgetCents: number;
  pct: number;
};
```

> Matching by `a.campaign_id === c.id` works for Google/TikTok (row id is the dim uuid). For live-Meta rows (row id is the external id), also match the dim id the way the reallocation prefill does — reuse the existing `resolveCampaignDimId`/`matchId` approach if Meta is live-connected. If matching a Meta row is not resolvable in the loader, the badge simply doesn't show for that row (acceptable; the action still works from the row's own data).

- [ ] **Step 4: Extend `PendingAction`** with a scale variant

Find the `PendingAction` union (used by `setPending`) and add:

```typescript
  | { kind: "scale"; campaign: Campaign; suggestion: ScalePrefill }
```

- [ ] **Step 5: Add the "Scale budget" row action** in `RowActions`

`RowActions` needs to know if a scale suggestion exists for this campaign. Pass `scaleSuggestion: ScalePrefill | null` as a prop (looked up by the parent: `scaleSuggestions.find((s) => s.campaignId === c.id) ?? null`). Add the menu item after "Reallocate budget":

```typescript
          {
            content: "Scale budget",
            disabled: !scaleSuggestion || c.status !== "active" || c.daily_budget_cents <= 0,
            onAction: () => {
              close();
              if (scaleSuggestion) setPending({ kind: "scale", campaign: c, suggestion: scaleSuggestion });
            },
          },
```

- [ ] **Step 6: Add the "Suggested: scale" badge** in the row rendering

Where the row renders status/grade (mirror how the reallocate suggestion is signalled), show a Polaris `Badge` when a scale suggestion exists for the row:

```typescript
{scaleSuggestion ? <Badge tone="success">Suggested: scale</Badge> : null}
```

(Place it in the same cell/stack the row uses for status badges; `import { Badge } from "@shopify/polaris"` if not already imported.)

- [ ] **Step 7: Add `ScaleBudgetModal`** (mirror `ReallocateBudgetModal`, but single-campaign, one decision/one button)

```typescript
function ScaleBudgetModal({
  campaign,
  suggestion,
  submitting,
  onClose,
}: {
  campaign: Campaign;
  suggestion: ScalePrefill;
  submitting: boolean;
  onClose: () => void;
}) {
  const [idempotencyKey] = useState(() => `scale:${newIdempotencyKey()}`);
  return (
    <Modal open title="Scale this winning campaign" onClose={onClose}>
      <Modal.Section>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="scale" />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input type="hidden" name="campaignName" value={campaign.name} />
          <input type="hidden" name="platform" value={campaign.platform} />
          <input type="hidden" name="dailyBudgetCents" value={String(suggestion.newBudgetCents)} />
          <input type="hidden" name="alertId" value={suggestion.alertId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <BlockStack gap="300">
            <Text as="p">
              {campaign.platform} · {campaign.name} is winning. Raise its daily budget{" "}
              {suggestion.pct}% ({fmtMoney(campaign.daily_budget_cents)} →{" "}
              {fmtMoney(suggestion.newBudgetCents)}/day) for about{" "}
              <Text as="span" fontWeight="bold">{fmtMoney(Math.round(suggestion.projectedUpside * 100))}/mo</Text>{" "}
              more projected margin.
            </Text>
            <Box>
              <ButtonGroup>
                <Button onClick={onClose} disabled={submitting}>Cancel</Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting}>
                  Scale budget
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

> `fmtMoney` takes cents in this file; `projectedUpside` is dollars, so pass `Math.round(projectedUpside * 100)`. Render `<ScaleBudgetModal>` from the same place the other modals are conditionally rendered (`pending?.kind === "scale"`).

- [ ] **Step 8: Handle `intent === "scale"` in the route `action`**

Add a branch mirroring the orchestrated pause/edit_budget path (resolve Meta external→dim id, call `executeAction` with the new kind). Place it near the other intents:

```typescript
  if (intent === "scale") {
    const newCents = Math.round(Number(formData.get("dailyBudgetCents") || 0));
    const alertId = String(formData.get("alertId") || "") || null;
    if (!campaignId || !Number.isFinite(newCents) || newCents <= 0) {
      return json<ActionPayload>(
        { ok: false, error: { code: "INVALID_REQUEST", message: "campaign and a positive new budget are required" }, toast: { message: "Invalid scale request", isError: true } },
        { status: 400 },
      );
    }
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    const dimId = platform === "Meta" ? await resolveCampaignDimId(sb, shopId, "meta", campaignId) : campaignId;
    if (!dimId) {
      return json<ActionPayload>(
        { ok: false, error: { code: "NOT_INGESTED", message: "This campaign is still syncing — try again shortly" }, toast: { message: "Campaign still syncing", isError: true } },
        { status: 409 },
      );
    }
    try {
      const { outcome } = await executeAction(
        shopId,
        { alertId, kind: "increase_campaign_budget", campaignId: dimId, idempotencyKey, dailyBudgetCents: newCents },
        sb,
      );
      if (outcome === "failed") {
        return json<ActionPayload>(
          { ok: false, error: { code: "ACTION_FAILED", message: `Could not scale ${campaignName}` }, toast: { message: `Could not scale ${campaignName}`, isError: true } },
          { status: 502 },
        );
      }
      if (outcome === "retrying") {
        return json<ActionPayload>(
          { ok: false, error: { code: "ACTION_RETRYING", message: `Couldn't reach the ad platform — scaling ${campaignName} is queued and will retry` }, toast: { message: `${campaignName}: queued, will retry automatically` } },
          { status: 202 },
        );
      }
      return json<ActionPayload>({ ok: true, toast: { message: `Scaled ${campaignName} to ${fmtMoneyDec(newCents)}/day` } });
    } catch (err) {
      const e = err as CalderynError;
      return json<ActionPayload>(
        { ok: false, error: { code: e.code ?? "ACTION_FAILED", message: e.message }, toast: { message: e.message, isError: true } },
        { status: e.status >= 400 && e.status < 600 ? e.status : 500 },
      );
    }
  }
```

> Place this branch BEFORE the generic `if (!campaignId)`/`switch (intent)` block so it short-circuits cleanly (mirrors how `intent === "reallocate"` is handled first).

- [ ] **Step 9: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all exit 0. Fix any unused-import or `Badge`/`Text` import nits flagged by lint.

- [ ] **Step 10: Commit**

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/routes/app.campaigns._index.tsx
git commit -m "app/campaigns: one-click Scale suggestion (badge + modal) driven by the open alert"
```

---

## Task 5: Dashboard campaigns — scale badge, button, action route kind

**Files:**
- Modify: `app/routes/dashboard.api.campaigns.$id.action.tsx` (`KINDS`)
- Modify: `app/components/dashboard/screens/Campaigns.tsx` (`CampaignRow`, `CampaignDetail`, `run`)

- [ ] **Step 1: Allow the new kind in the dashboard action route**

`dashboard.api.campaigns.$id.action.tsx`:

```typescript
const KINDS: ExecutableKind[] = [
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
];
```

> The body's budget validation already requires a positive `daily_budget_cents` only for `reduce_campaign_budget`. Add `increase_campaign_budget` to that same guard so a scale request also requires a positive target:

```typescript
  if (
    (kind === "reduce_campaign_budget" || kind === "increase_campaign_budget") &&
    (!Number.isFinite(dailyBudgetCents) || (dailyBudgetCents as number) <= 0)
  ) {
    return jsonError(422, "invalid_daily_budget_cents");
  }
```

- [ ] **Step 2: Extend the dashboard `run` helper** (`Campaigns.tsx`, `CampaignDetail`)

```typescript
  const run = async (
    type: "pause_campaign" | "resume_campaign" | "reduce_campaign_budget" | "increase_campaign_budget",
    successText: string,
    nextStatus: string,
    dailyBudgetCents?: number,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, {
        type,
        ...(type === "reduce_campaign_budget"
          ? { dailyBudgetCents: Math.round(c.daily_budget_cents * 0.7) }
          : type === "increase_campaign_budget"
            ? { dailyBudgetCents: dailyBudgetCents ?? Math.round(c.daily_budget_cents * 1.2) }
            : {}),
      });
      setStatus(nextStatus);
      app.refresh();
      app.toast(successText, type === "pause_campaign" ? "pause" : type === "resume_campaign" ? "play" : "reduce");
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Action failed — please try again.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 3: Add the "Scale budget" button** to `CampaignDetail`'s header, shown only when an open scale alert exists for the campaign

Just before the header action buttons, derive the scale alert (the dashboard already filters `app.alerts` elsewhere):

```typescript
  const scaleAlert = app.alerts.find(
    (a) => a.campaign_id === c.id && a.status === "open" && a.detector_id === "campaign_scaling_opportunity",
  );
  const scalePct = app.guardrails?.autopilot_max_budget_increase_pct ?? 20;
  const scaleTarget = Math.round(c.daily_budget_cents * (1 + scalePct / 100));
```

Then in the button row (after the "Cut budget 30%" `<Btn>`), when not paused and a scale alert exists:

```typescript
          {!paused && scaleAlert && (
            <Btn
              icon="play"
              disabled={busy}
              onClick={() =>
                run(
                  "increase_campaign_budget",
                  `Budget scaled +${scalePct}% — logged to action history.`,
                  status,
                  scaleTarget,
                )
              }
            >
              Scale +{scalePct}%
            </Btn>
          )}
```

> Confirm `app.guardrails` is available in this screen's context; if the screen doesn't already receive guardrails, fall back to `20` (the default) rather than threading new context — the autopilot cap still enforces the real value server-side.

- [ ] **Step 4: Add the "Suggested: scale" badge** to `CampaignRow`

`CampaignRow` currently receives only `c` + `onClick`. Pass a `scaleSuggested: boolean` prop (computed by the list parent: `app.alerts.some((a) => a.campaign_id === c.id && a.status === "open" && a.detector_id === "campaign_scaling_opportunity")`). Render next to the grade pill:

```typescript
          {c.status === "paused" ? <Pill icon="pause">Paused</Pill> : <GradePill grade={c.grade} />}
          {scaleSuggested && <Pill icon="play">Scale</Pill>}
```

(Use the dashboard's existing `Pill` component + an icon already in the `CDIcon` registry; if `play` isn't registered, use an existing one like `arrowUp`/`trendingUp` per `app/components/dashboard/icons.tsx`.)

- [ ] **Step 5: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.campaigns.$id.action.tsx app/components/dashboard/screens/Campaigns.tsx
git commit -m "dashboard/campaigns: Scale button + badge for winning campaigns"
```

---

## Task 6: Dashboard settings — two new fields

**Files:**
- Modify: the dashboard Settings screen component (locate in Step 1)

- [ ] **Step 1: Locate the dashboard guardrails/settings screen**

Run: `npx grep -rln "autopilot_max_budget_cut_pct" app/components/dashboard/screens`
Expected: the Settings/Guardrails screen component that renders the autopilot cut-% input. Open it.

- [ ] **Step 2: Add two inputs mirroring the cut-% one**

In that component, next to the existing `autopilot_max_budget_cut_pct` field, add (using the dashboard's own input primitives + its PATCH call to `dashboard.api.guardrails`):

- "Most Calderyn can raise a winning campaign's budget at once (%)" → patches `autopilot_max_budget_increase_pct` (integer, 0–100).
- "Never let a daily budget exceed (USD, optional)" → patches `autopilot_max_daily_budget_cents` (empty input ⇒ `null`; a number ⇒ dollars×100). 

Follow the exact state/patch idiom the cut-% field uses in that component (it already calls the guardrails PATCH endpoint, which now whitelists both keys from Task 2).

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens
git commit -m "dashboard/settings: edit autopilot budget-increase % + daily ceiling"
```

---

## Plan 2 Self-Review checklist (run before handing off)

- [ ] Spec coverage (§4.5/§4.6): extension scale action+badge+modal (Task 4), extension settings caps (Task 3), dashboard scale button+badge (Task 5), dashboard settings caps (Task 6), shared config plumbing (Tasks 1/2). Both surfaces read the open alert as the suggestion source.
- [ ] No placeholders: every code step has real code. The three "locate" steps (Task 2 VM builder, Task 4 `rowToAlert`/`campaign_id`, Task 6 dashboard settings screen) each name the exact grep, the exact field, and the exact expression to add — they resolve a known file whose precise line wasn't captured, not undefined behaviour.
- [ ] Type consistency: `increase_campaign_budget` used identically across the action route `KINDS`, `executeCampaignAction`, the extension `action` intent, and `run`; `campaign_scaling_opportunity` filtered identically on both surfaces; `autopilot_max_budget_increase_pct`/`autopilot_max_daily_budget_cents` named identically in `GuardrailConfig`, `GuardrailVM`, validation, `PATCHABLE_KEYS`, and both settings forms.
- [ ] Final full gate per CLAUDE.md: `/code-review`, `git diff --check`, typecheck, lint (`--max-warnings=0` on new code), build, then the dashboard-parity sanity check (both surfaces show + act on a scale suggestion).

**Manual verification (after both plans land):** seed a `winning` campaign grade, run the engine once to emit a `campaign_scaling_opportunity` alert, confirm the badge + one-click scale appears on both surfaces and that approving it writes an undoable `increase_campaign_budget` audit row; enable autopilot and confirm a winner is scaled within the configured cap while a money-loser is still paused first.
```
