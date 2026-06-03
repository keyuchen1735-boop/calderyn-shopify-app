# In-app AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an embedded Polaris chat assistant in the Shopify admin that explains a merchant's Calderyn data (alerts, campaigns, SKUs, audit, guardrails) in plain language and can propose alert-backed actions that hand off to the existing confirm modal.

**Architecture:** A global slideout (mounted once in the `app.tsx` layout) POSTs to one authenticated resource route, `app/routes/app.assistant.tsx`. That route runs a server-side Claude tool-use loop (`loop.server.ts`) whose tools read through the existing `calderynClient(shop)`. Conversations persist in two new shop-scoped Supabase tables. The API key never reaches the browser.

**Tech Stack:** Remix (Vite) + `@shopify/shopify-app-remix`, React 18 + Polaris + App Bridge, Supabase (service-role, code-scoped), `@anthropic-ai/sdk` (Sonnet 4.6, prompt caching), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-in-app-assistant-design.md`

**⚠️ Anthropic specifics:** Before Tasks 4, 6, and 8, invoke the **`claude-api`** skill to confirm (a) the exact live model string for `DEFAULT_ASSISTANT_MODEL` (spec §10.1 — do a `models` smoke check, don't trust this doc) and (b) the current `cache_control` placement mechanics for `system` blocks and `tools`. If the verified model string differs from `claude-sonnet-4-6`, change only the constant in `anthropic.server.ts` and the example in `.env.example`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260602120000_assistant.sql` | Two additive tables: `assistant_conversations`, `assistant_messages` |
| `app/lib/assistant/types.ts` | `ChatRole`, `DraftedAction`, `ChatMessage`, `ConversationSummary` DTOs |
| `app/lib/assistant/anthropic.server.ts` | Anthropic SDK singleton + env-driven `assistantModel()` |
| `app/lib/assistant/snapshot.server.ts` | `buildSnapshot(client)` → compact shop snapshot string |
| `app/lib/assistant/prompt.server.ts` | `buildSystemPrompt(snapshot)` → cached + volatile system blocks |
| `app/lib/assistant/tools.server.ts` | `ASSISTANT_TOOLS` schemas + `makeToolDispatcher(client)` |
| `app/lib/assistant/loop.server.ts` | `runAssistantTurn(...)` — the tool-use loop, max-turns cap |
| `app/lib/assistant/conversations.server.ts` | Shop-scoped CRUD for the two tables |
| `app/lib/assistant/request.server.ts` | `parseAssistantRequest(formData)` — action input validation |
| `app/lib/assistant/action-param.ts` | `resolveActionParam(raw, allowed)` — client-safe deep-link helper |
| `app/routes/app.assistant.tsx` | Resource route: `loader` (history) + `action` (one turn) |
| `app/components/Assistant/AssistantSlideout.tsx` | Launcher + panel + message list + composer |
| `app/components/Assistant/DraftActionCard.tsx` | The "Review & confirm" card |
| `app/components/Assistant/assistant.css` | Positioning for launcher + panel only |
| `app/routes/app.tsx` | **Edit:** mount slideout + link the CSS |
| `app/routes/app.alerts.$id.tsx` | **Edit:** read `?action=` → pre-open `ExecuteActionModal` |
| `.env.example` | **Edit:** add `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` |
| `package.json` | **Edit:** add `@anthropic-ai/sdk` |

Build order is dependency-first: dependency/env → migration → types → leaf server modules (anthropic, snapshot, prompt, tools) → loop → conversations → request/route → UI → integration edits → final gate.

---

## Task 1: Dependency + env scaffolding

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install the Anthropic SDK**

Run:
```bash
npm install @anthropic-ai/sdk
```
Expected: `package.json` `dependencies` now lists `@anthropic-ai/sdk`; `package-lock.json` updated; exit 0.

- [ ] **Step 2: Add env keys to `.env.example`**

Append these lines to `.env.example`:
```bash
# Anthropic API — in-app assistant (server-only; never in a client bundle)
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
# Model string is verified against the live API at build time (spec §10.1).
ANTHROPIC_MODEL=claude-sonnet-4-6
```

- [ ] **Step 3: Verify typecheck still passes**

Run:
```bash
npm run typecheck
```
Expected: exit 0 (no app code changed yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(assistant): add @anthropic-ai/sdk + ANTHROPIC env keys"
```

---

## Task 2: Supabase migration (two additive tables)

**Files:**
- Create: `supabase/migrations/20260602120000_assistant.sql`

> No existing table is altered, so this cannot conflict with the #2/#4 migrations. Tests in later tasks fake Supabase, so applying this to a live database is a **deploy step**, not a prerequisite for local tests.

- [ ] **Step 1: Write the migration**

```sql
-- assistant_conversations / assistant_messages: persisted chat history for the
-- in-app AI assistant. Shop-scoped in code (service-role); RLS deferred (spec §3).

create table assistant_conversations (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index assistant_conversations_shop_updated_idx
  on assistant_conversations (shop_id, updated_at desc);

create table assistant_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  shop_id         uuid not null references shops(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  drafted_action  jsonb,
  created_at      timestamptz not null default now()
);

create index assistant_messages_conversation_created_idx
  on assistant_messages (conversation_id, created_at);
```

- [ ] **Step 2: Sanity-check the SQL parses (optional, if a local Supabase is available)**

Run (only if a local Supabase/psql is configured):
```bash
npx supabase db reset --dry-run
```
Expected: no syntax error reported. If no local Supabase, skip — this is applied during deploy.

- [ ] **Step 3: Record the pending deploy step**

If `docs/` tracks pending manual deploy steps (the repo has such a note), add a line: "Apply `20260602120000_assistant.sql` to Supabase (staging then prod)."

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260602120000_assistant.sql
git commit -m "feat(assistant): add assistant_conversations + assistant_messages tables"
```

---

## Task 3: Domain types

**Files:**
- Create: `app/lib/assistant/types.ts`

Pure type declarations — no behavior to test; verified by `typecheck` and by the modules that consume them.

- [ ] **Step 1: Write the types**

```ts
// app/lib/assistant/types.ts
// DTOs for the in-app assistant. Kept separate from app/lib/types.ts to avoid
// churn on that shared file (spec §14).
import type { ActionKind } from "../types";

export type ChatRole = "user" | "assistant";

export interface DraftedAction {
  alertId: string;
  actionKind: ActionKind;
  label: string;
  dollarImpact: number; // cents, mirrors Alert.dollar_impact
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  draftedAction: DraftedAction | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/assistant/types.ts
git commit -m "feat(assistant): add chat DTOs (ChatMessage, DraftedAction, ConversationSummary)"
```

---

## Task 4: Anthropic client + model resolution

> Invoke the **`claude-api`** skill first to confirm the exact `DEFAULT_ASSISTANT_MODEL` string.

**Files:**
- Create: `app/lib/assistant/anthropic.server.ts`
- Test: `app/lib/assistant/__tests__/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/anthropic.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("assistantModel", () => {
  const OLD = { ...process.env };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("returns ANTHROPIC_MODEL when set", async () => {
    process.env.ANTHROPIC_MODEL = "claude-test-xyz";
    const { assistantModel } = await import("../anthropic.server");
    expect(assistantModel()).toBe("claude-test-xyz");
  });

  it("falls back to DEFAULT_ASSISTANT_MODEL when unset", async () => {
    delete process.env.ANTHROPIC_MODEL;
    const mod = await import("../anthropic.server");
    expect(mod.assistantModel()).toBe(mod.DEFAULT_ASSISTANT_MODEL);
  });

  it("getAnthropic throws when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { getAnthropic } = await import("../anthropic.server");
    expect(() => getAnthropic()).toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/anthropic.test.ts`
Expected: FAIL — cannot find module `../anthropic.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/anthropic.server.ts
import Anthropic from "@anthropic-ai/sdk";

// Verified against the live Anthropic API at build time (spec §10.1).
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Model string is env-driven; no literal model id elsewhere in the codebase. */
export function assistantModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_ASSISTANT_MODEL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/anthropic.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/anthropic.server.ts app/lib/assistant/__tests__/anthropic.test.ts
git commit -m "feat(assistant): Anthropic client singleton + env-driven model"
```

---

## Task 5: Shop snapshot builder

**Files:**
- Create: `app/lib/assistant/snapshot.server.ts`
- Test: `app/lib/assistant/__tests__/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/snapshot.test.ts
import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../snapshot.server";
import type { CalderynClient } from "../../calderyn.server";

function fakeClient(alertCount: number): CalderynClient {
  const alerts = Array.from({ length: alertCount }, (_, i) => ({
    id: `a${i}`,
    detector_id: "campaign_below_breakeven",
    severity: i % 2 === 0 ? "critical" : "high",
    status: "open",
    dollar_impact: 100000 + i, // cents
    claude_rank: i + 1,
    created_at: "2026-06-02T00:00:00Z",
    title: `Alert ${i}`,
    narrative: "",
    campaign: null,
    sku: null,
    evidence: {},
  }));
  return {
    alerts: { list: async () => alerts, get: async () => alerts[0] },
    campaigns: { list: async () => [{ id: "c1" }, { id: "c2" }] },
    skus: { list: async () => [{ id: "s1" }] },
  } as unknown as CalderynClient;
}

describe("buildSnapshot", () => {
  it("includes counts and caps the alert list at 10", async () => {
    const text = await buildSnapshot(fakeClient(25));
    expect(text).toContain("Open alerts: 25");
    expect(text).toContain("Campaigns: 2");
    expect(text).toContain("SKUs: 1");
    // exactly 10 alert lines (each starts with "- [#")
    expect(text.match(/- \[#/g)?.length).toBe(10);
    // dollars, not cents: 100000 cents -> $1,000
    expect(text).toContain("$1,000");
  });

  it("handles the empty case", async () => {
    const text = await buildSnapshot(fakeClient(0));
    expect(text).toContain("Open alerts: 0");
    expect(text).toContain("No open alerts.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/snapshot.test.ts`
Expected: FAIL — cannot find module `../snapshot.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/snapshot.server.ts
import type { CalderynClient } from "../calderyn.server";

const MAX_SNAPSHOT_ALERTS = 10;

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** A compact, cheap-to-tokenize snapshot of the shop's open state for the system prompt. */
export async function buildSnapshot(client: CalderynClient): Promise<string> {
  const [alerts, campaigns, skus] = await Promise.all([
    client.alerts.list({ status: "open" }),
    client.campaigns.list(),
    client.skus.list(),
  ]);

  const bySeverity: Record<string, number> = {};
  for (const a of alerts) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
  const severitySummary =
    Object.entries(bySeverity)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ") || "none";

  // alerts.list already orders by claude_rank ascending, so slice = top N.
  const top = alerts
    .slice(0, MAX_SNAPSHOT_ALERTS)
    .map(
      (a) =>
        `- [#${a.claude_rank}] ${a.title} (${a.detector_id}, ${dollars(a.dollar_impact)}/30d, ${a.severity})`,
    );

  return [
    "Shop snapshot (live):",
    `Open alerts: ${alerts.length} (${severitySummary})`,
    `Campaigns: ${campaigns.length}. SKUs: ${skus.length}.`,
    top.length ? `Top open alerts by rank:\n${top.join("\n")}` : "No open alerts.",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/snapshot.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/snapshot.server.ts app/lib/assistant/__tests__/snapshot.test.ts
git commit -m "feat(assistant): build compact shop snapshot for the system prompt"
```

---

## Task 6: System prompt builder

> Invoke the **`claude-api`** skill first to confirm `cache_control` placement on `system` blocks.

**Files:**
- Create: `app/lib/assistant/prompt.server.ts`
- Test: `app/lib/assistant/__tests__/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, ASSISTANT_SYSTEM_INSTRUCTIONS } from "../prompt.server";

describe("buildSystemPrompt", () => {
  it("caches the static block and leaves the snapshot uncached", () => {
    const blocks = buildSystemPrompt("SNAPSHOT-XYZ");
    expect(blocks).toHaveLength(2);

    expect(blocks[0].text).toBe(ASSISTANT_SYSTEM_INSTRUCTIONS);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });

    expect(blocks[1].text).toBe("SNAPSHOT-XYZ");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("static instructions mention the cents->dollars rule and the alert-backed constraint", () => {
    expect(ASSISTANT_SYSTEM_INSTRUCTIONS.toLowerCase()).toContain("cents");
    expect(ASSISTANT_SYSTEM_INSTRUCTIONS.toLowerCase()).toContain("propose_action");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/prompt.test.ts`
Expected: FAIL — cannot find module `../prompt.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/prompt.server.ts
import type Anthropic from "@anthropic-ai/sdk";

export const ASSISTANT_SYSTEM_INSTRUCTIONS = `You are Calderyn's in-app assistant, embedded in a Shopify merchant's admin. You help the merchant understand their own store's operational data — alerts, ad campaigns, SKUs/inventory, the audit log of actions taken, and their guardrail settings — in plain, concise language.

How to work:
- Answer using the data you can see. The system message includes a live snapshot; call tools (list_alerts, get_alert, list_campaigns, list_skus, list_audit, get_guardrails, list_integrations) to pull more detail. Prefer one or two targeted tool calls over many.
- Be concise and concrete. Lead with the answer, then a short "why". Use the merchant's own campaign and SKU names.
- Money values from tools and the snapshot are in CENTS. Always present them to the merchant as dollars (e.g. 123456 becomes "$1,234").
- "claude_rank" is Calderyn's existing priority order for alerts (lower = more urgent). "dollar_impact" is the projected 30-day dollar impact. Explain these; do not invent your own ranking.

Proposing actions:
- You may PROPOSE an action only when it corresponds to an existing alert. Call propose_action(alert_id, action_kind) with an alert id you have seen and an action_kind the tool accepts for that alert. If valid, the merchant gets a "Review & confirm" button; the action executes only after they confirm on the alert page — you never execute it.
- If the merchant asks for an action with no backing alert (e.g. "pause campaign X" when no alert mentions it), explain there is no active alert/action for it and point them to the Campaigns page. Do not fabricate an action.

Never claim you performed an action. You explain and propose; the merchant confirms.`;

/**
 * System blocks: a long-lived cached instruction block followed by the volatile
 * per-shop snapshot. Tool definitions are cached separately at the call site.
 */
export function buildSystemPrompt(snapshot: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: ASSISTANT_SYSTEM_INSTRUCTIONS, cache_control: { type: "ephemeral" } },
    { type: "text", text: snapshot },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/prompt.server.ts app/lib/assistant/__tests__/prompt.test.ts
git commit -m "feat(assistant): system prompt with cached instructions + volatile snapshot"
```

---

## Task 7: Tool schemas + dispatcher

**Files:**
- Create: `app/lib/assistant/tools.server.ts`
- Test: `app/lib/assistant/__tests__/tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { ASSISTANT_TOOLS, makeToolDispatcher } from "../tools.server";
import { CalderynError } from "../../calderyn.server";
import type { CalderynClient } from "../../calderyn.server";

function fakeClient(over: Partial<Record<string, unknown>> = {}): {
  client: CalderynClient;
  listSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn(async () => [{ id: "a1" }, { id: "a2" }]);
  const getSpy = vi.fn(async (id: string) => {
    if (id === "missing") {
      throw new CalderynError({ code: "ALERT_NOT_FOUND", status: 404, message: "nope" });
    }
    return {
      id,
      detector_id: "campaign_below_breakeven",
      title: "Below breakeven",
      dollar_impact: 123400,
    };
  });
  const client = {
    alerts: { list: listSpy, get: getSpy },
    campaigns: { list: async () => [] },
    skus: { list: async () => [] },
    audit: { list: async () => [] },
    guardrails: { get: async () => ({}) },
    integrations: { list: async () => ({}) },
    ...over,
  } as unknown as CalderynClient;
  return { client, listSpy, getSpy };
}

describe("ASSISTANT_TOOLS", () => {
  it("exposes the expected tool names", () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_alert",
        "get_guardrails",
        "list_alerts",
        "list_audit",
        "list_campaigns",
        "list_integrations",
        "list_skus",
        "propose_action",
      ].sort(),
    );
  });
});

describe("makeToolDispatcher", () => {
  it("list_alerts maps detector_id input to the client 'detector' filter", async () => {
    const { client, listSpy } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("list_alerts", { detector_id: "cogs_drift", status: "open" });
    expect(listSpy).toHaveBeenCalledWith({ status: "open", severity: undefined, detector: "cogs_drift" });
    expect(JSON.parse(res.content).alerts).toHaveLength(2);
    expect(res.isError).toBeFalsy();
  });

  it("propose_action returns a draftedAction for a valid alert+kind", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("propose_action", { alert_id: "a1", action_kind: "pause_campaign" });
    expect(res.isError).toBeFalsy();
    expect(res.draftedAction).toEqual({
      alertId: "a1",
      actionKind: "pause_campaign",
      label: "Pause campaign",
      dollarImpact: 123400,
    });
  });

  it("propose_action rejects a kind not allowed for the detector", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    // exclude_geo is NOT in DETECTOR_TO_ACTIONS.campaign_below_breakeven
    const res = await dispatch("propose_action", { alert_id: "a1", action_kind: "exclude_geo" });
    expect(res.isError).toBe(true);
    expect(res.draftedAction).toBeUndefined();
    expect(JSON.parse(res.content).code).toBe("ACTION_NOT_ALLOWED");
  });

  it("propose_action surfaces a missing alert as a tool error", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("propose_action", { alert_id: "missing", action_kind: "pause_campaign" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ALERT_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/tools.test.ts`
Expected: FAIL — cannot find module `../tools.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/tools.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import { CalderynError } from "../calderyn.server";
import type { CalderynClient } from "../calderyn.server";
import { ACTION_LABELS, DETECTOR_TO_ACTIONS } from "../labels";
import type { ActionKind } from "../types";
import type { DraftedAction } from "./types";

export interface ToolDispatchResult {
  content: string; // JSON string handed back to the model as tool_result content
  isError?: boolean;
  draftedAction?: DraftedAction;
}

const LIMIT_CAP = 200;

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_alerts",
    description:
      "List the shop's alerts (issues Calderyn detected), newest priority first. Use to find or filter alerts before explaining them. Returns shaped Alert objects; money fields are in cents.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "acknowledged", "resolved"] },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        detector_id: { type: "string", description: "Filter to one detector, e.g. campaign_below_breakeven" },
        limit: { type: "number", description: "Max rows (<=200, default 50)" },
      },
    },
  },
  {
    name: "get_alert",
    description:
      "Fetch one alert by id with its full evidence and narrative. Use when the merchant asks about a specific alert or before proposing an action on it.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_audit",
    description:
      "List recent actions taken (the audit log), newest first. Use to answer 'what changed' or 'what did we do about X'.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max rows (<=200, default 50)" } },
    },
  },
  {
    name: "list_campaigns",
    description:
      "List ad campaigns with spend, ROAS and margin. Use for questions about ad performance. Money fields are in cents.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["active", "paused"] } },
    },
  },
  {
    name: "list_skus",
    description:
      "List SKUs with on-hand units, days of cover and velocity. Use for inventory questions. Set low_cover_only to focus on at-risk stock.",
    input_schema: {
      type: "object",
      properties: { low_cover_only: { type: "boolean", description: "Only SKUs with < 14 days of cover" } },
    },
  },
  {
    name: "get_guardrails",
    description:
      "Get the shop's guardrail config (daily action budget, per-action cap, cooldown, business hours). Use to explain why an action might be blocked or limited.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_integrations",
    description:
      "Get connection status of Meta, Google and QuickBooks. Use to explain missing data (e.g. Meta not connected).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_action",
    description:
      "Propose an action for the merchant to confirm. Only valid for an EXISTING alert and an action_kind allowed for that alert's detector. On success the merchant sees a 'Review & confirm' button; you never execute the action yourself.",
    input_schema: {
      type: "object",
      properties: {
        alert_id: { type: "string" },
        action_kind: {
          type: "string",
          enum: [
            "pause_campaign",
            "reduce_campaign_budget",
            "exclude_geo",
            "reallocate_inventory",
            "create_po_draft",
            "snooze_alert",
          ],
        },
      },
      required: ["alert_id", "action_kind"],
    },
  },
];

function ok(obj: unknown): ToolDispatchResult {
  return { content: JSON.stringify(obj) };
}

function toolError(code: string, message: string): ToolDispatchResult {
  return { content: JSON.stringify({ code, message }), isError: true };
}

export function makeToolDispatcher(client: CalderynClient) {
  return async function dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolDispatchResult> {
    try {
      switch (name) {
        case "list_alerts": {
          const alerts = await client.alerts.list({
            status: input.status as string | undefined,
            severity: input.severity as string | undefined,
            detector: input.detector_id as string | undefined,
          });
          const limit = Math.min(Number(input.limit ?? 50), LIMIT_CAP);
          return ok({ alerts: alerts.slice(0, limit) });
        }
        case "get_alert":
          return ok({ alert: await client.alerts.get(String(input.id)) });
        case "list_audit": {
          const entries = await client.audit.list();
          const limit = Math.min(Number(input.limit ?? 50), LIMIT_CAP);
          return ok({ entries: entries.slice(0, limit) });
        }
        case "list_campaigns": {
          let campaigns = await client.campaigns.list();
          if (input.status === "active" || input.status === "paused") {
            campaigns = campaigns.filter((c) => c.status === input.status);
          }
          return ok({ campaigns });
        }
        case "list_skus": {
          let skus = await client.skus.list();
          if (input.low_cover_only === true) skus = skus.filter((s) => s.days_of_cover < 14);
          return ok({ skus });
        }
        case "get_guardrails":
          return ok({ guardrails: await client.guardrails.get() });
        case "list_integrations":
          return ok({ integrations: await client.integrations.list() });
        case "propose_action":
          return await proposeAction(client, input);
        default:
          return toolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
      }
    } catch (err) {
      const e = err as CalderynError;
      return toolError(e.code ?? "ERROR", e.message ?? String(err));
    }
  };
}

async function proposeAction(
  client: CalderynClient,
  input: Record<string, unknown>,
): Promise<ToolDispatchResult> {
  const alertId = String(input.alert_id ?? "");
  const actionKind = String(input.action_kind ?? "") as ActionKind;
  const alert = await client.alerts.get(alertId); // throws CalderynError -> caught by caller
  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes(actionKind)) {
    return toolError(
      "ACTION_NOT_ALLOWED",
      `${actionKind} is not valid for ${alert.detector_id}. Allowed: ${allowed.join(", ")}`,
    );
  }
  const drafted: DraftedAction = {
    alertId: alert.id,
    actionKind,
    label: ACTION_LABELS[actionKind],
    dollarImpact: alert.dollar_impact,
  };
  return {
    content: JSON.stringify({ ok: true, proposed: { ...drafted, alertTitle: alert.title } }),
    draftedAction: drafted,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/tools.server.ts app/lib/assistant/__tests__/tools.test.ts
git commit -m "feat(assistant): tool schemas + dispatcher over calderynClient"
```

---

## Task 8: The tool-use loop

> Invoke the **`claude-api`** skill first to confirm message/tool-use shapes for the installed SDK version.

**Files:**
- Create: `app/lib/assistant/loop.server.ts`
- Test: `app/lib/assistant/__tests__/loop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/loop.test.ts
import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runAssistantTurn } from "../loop.server";
import type { ToolDispatchResult } from "../tools.server";

function textMsg(text: string): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "text", text }],
  } as unknown as Anthropic.Message;
}

function toolMsg(id: string, name: string, input: unknown): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "tool_use", id, name, input }],
  } as unknown as Anthropic.Message;
}

const base = {
  model: "x",
  system: [{ type: "text" as const, text: "sys" }],
  tools: [],
  history: [],
  userMessage: "hi",
};

describe("runAssistantTurn", () => {
  it("returns text on a single non-tool turn", async () => {
    const createMessage = vi.fn(async () => textMsg("hello there"));
    const dispatchTool = vi.fn(async (): Promise<ToolDispatchResult> => ({ content: "{}" }));
    const res = await runAssistantTurn({ ...base, createMessage, dispatchTool });
    expect(res.text).toBe("hello there");
    expect(res.draftedAction).toBeNull();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("dispatches a tool then returns the follow-up text", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolMsg("t1", "list_alerts", { status: "open" }))
      .mockResolvedValueOnce(textMsg("you have 3 alerts"));
    const dispatchTool = vi.fn(async (): Promise<ToolDispatchResult> => ({ content: '{"alerts":[]}' }));
    const res = await runAssistantTurn({ ...base, createMessage, dispatchTool });
    expect(dispatchTool).toHaveBeenCalledWith("list_alerts", { status: "open" });
    expect(res.text).toBe("you have 3 alerts");
  });

  it("captures a draftedAction from a tool result", async () => {
    const drafted = { alertId: "a1", actionKind: "pause_campaign" as const, label: "Pause campaign", dollarImpact: 100 };
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolMsg("t1", "propose_action", { alert_id: "a1", action_kind: "pause_campaign" }))
      .mockResolvedValueOnce(textMsg("done"));
    const dispatchTool = vi.fn(async (): Promise<ToolDispatchResult> => ({ content: "{}", draftedAction: drafted }));
    const res = await runAssistantTurn({ ...base, createMessage, dispatchTool });
    expect(res.draftedAction).toEqual(drafted);
  });

  it("stops at the max-turns cap", async () => {
    const createMessage = vi.fn(async () => toolMsg("t1", "list_alerts", {}));
    const dispatchTool = vi.fn(async (): Promise<ToolDispatchResult> => ({ content: "{}" }));
    const res = await runAssistantTurn({ ...base, createMessage, dispatchTool, maxToolTurns: 1 });
    expect(res.stoppedAtCap).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(2); // turn 0 + turn 1 (cap)
  });

  it("propagates a tool error into the tool_result (is_error)", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolMsg("t1", "get_alert", { id: "missing" }))
      .mockResolvedValueOnce(textMsg("that alert does not exist"));
    const dispatchTool = vi.fn(async (): Promise<ToolDispatchResult> => ({ content: '{"code":"ALERT_NOT_FOUND"}', isError: true }));
    await runAssistantTurn({ ...base, createMessage, dispatchTool });
    // second createMessage call should carry a tool_result with is_error true
    const secondCallMessages = createMessage.mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResultMsg.content[0].is_error).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/loop.test.ts`
Expected: FAIL — cannot find module `../loop.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/loop.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { DraftedAction } from "./types";
import type { ToolDispatchResult } from "./tools.server";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface RunTurnParams {
  createMessage: CreateMessageFn;
  model: string;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  dispatchTool: (name: string, input: Record<string, unknown>) => Promise<ToolDispatchResult>;
  history: Anthropic.MessageParam[];
  userMessage: string;
  maxToolTurns?: number;
  maxTokens?: number;
}

export interface RunTurnResult {
  text: string;
  draftedAction: DraftedAction | null;
  stoppedAtCap: boolean;
}

const DEFAULT_MAX_TOOL_TURNS = 8;
const DEFAULT_MAX_TOKENS = 1536;

export async function runAssistantTurn(p: RunTurnParams): Promise<RunTurnResult> {
  const maxToolTurns = p.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const maxTokens = p.maxTokens ?? DEFAULT_MAX_TOKENS;
  const messages: Anthropic.MessageParam[] = [
    ...p.history,
    { role: "user", content: p.userMessage },
  ];
  let draftedAction: DraftedAction | null = null;

  for (let turn = 0; turn <= maxToolTurns; turn++) {
    const res = await p.createMessage({
      model: p.model,
      max_tokens: maxTokens,
      system: p.system,
      tools: p.tools,
      messages,
    });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: extractText(res), draftedAction, stoppedAtCap: false };
    }

    if (turn === maxToolTurns) {
      const partial = extractText(res);
      return {
        text:
          partial ||
          "I gathered a lot of data but ran out of steps before finishing. Please ask a more specific follow-up.",
        draftedAction,
        stoppedAtCap: true,
      };
    }

    messages.push({ role: "assistant", content: res.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const out = await p.dispatchTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      if (out.draftedAction) draftedAction = out.draftedAction;
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: out.content,
        is_error: out.isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Unreachable (the cap branch returns), but keeps the type checker happy.
  return { text: "", draftedAction, stoppedAtCap: true };
}

function extractText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/loop.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/loop.server.ts app/lib/assistant/__tests__/loop.test.ts
git commit -m "feat(assistant): server-side tool-use loop with max-turns cap"
```

---

## Task 9: Conversation persistence (shop-scoped)

**Files:**
- Create: `app/lib/assistant/conversations.server.ts`
- Test: `app/lib/assistant/__tests__/conversations.test.ts`

> This is the security-critical module. The test fakes Supabase with an in-memory
> store that honours `.eq()` filters, so the three cross-shop isolation assertions
> (spec §8.1) are real, not mocked away.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/conversations.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Supabase fake that models the PromiseLike query builder and honours
// .eq() filters. Supports the exact chains conversations.server.ts uses.
type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
let idc = 0;

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  let inserting: Row[] | null = null;
  let updating: Row | null = null;

  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const commitInsert = () => {
    const rows = (inserting ?? []).map((v) => ({
      id: `id-${++idc}`,
      created_at: new Date(1700000000000 + idc).toISOString(),
      updated_at: new Date(1700000000000 + idc).toISOString(),
      ...v,
    }));
    store[table] = [...(store[table] ?? []), ...rows];
    return rows;
  };
  const commitUpdate = () => {
    for (const r of store[table] ?? []) {
      if (filters.every(([k, v]) => r[k] === v)) Object.assign(r, updating);
    }
  };

  const api: any = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    insert: (vals: Row | Row[]) => {
      inserting = Array.isArray(vals) ? vals : [vals];
      return api;
    },
    update: (vals: Row) => {
      updating = vals;
      return api;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    single: async () => {
      if (inserting) return { data: commitInsert()[0], error: null };
      return { data: matches()[0] ?? null, error: null };
    },
    // PromiseLike: awaiting the chain (no single/maybeSingle) resolves here.
    then: (resolve: (v: { data: any; error: null }) => void) => {
      if (inserting) return resolve({ data: commitInsert(), error: null });
      if (updating) {
        commitUpdate();
        return resolve({ data: null, error: null });
      }
      return resolve({ data: matches(), error: null });
    },
  };
  return api;
}

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
  resolveShopId: async (domain: string) =>
    domain === "a.myshopify.com" ? "shop-A" : "shop-B",
}));

import {
  createConversation,
  appendMessage,
  getMessages,
  listConversations,
} from "../conversations.server";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  idc = 0;
});

describe("conversations.server shop scoping", () => {
  it("a conversation created by shop A is invisible to shop B", async () => {
    const id = await createConversation("a.myshopify.com", "First");
    expect(await listConversations("a.myshopify.com")).toHaveLength(1);
    expect(await listConversations("b.myshopify.com")).toHaveLength(0);
    expect(id).toMatch(/^id-/);
  });

  it("getMessages returns A's messages for A, and 404s for B", async () => {
    const id = await createConversation("a.myshopify.com", "First");
    await appendMessage("a.myshopify.com", id, { role: "user", content: "hi" });
    const msgs = await getMessages("a.myshopify.com", id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hi");
    await expect(getMessages("b.myshopify.com", id)).rejects.toThrow(/not found/i);
  });

  it("shop B cannot append to shop A's conversation", async () => {
    const id = await createConversation("a.myshopify.com", "First");
    await expect(
      appendMessage("b.myshopify.com", id, { role: "user", content: "intrude" }),
    ).rejects.toThrow(/not found/i);
    // no message row written for B
    expect(store["assistant_messages"] ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/conversations.test.ts`
Expected: FAIL — cannot find module `../conversations.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/conversations.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import type { ChatMessage, ConversationSummary, DraftedAction } from "./types";

interface AppendInput {
  role: "user" | "assistant";
  content: string;
  draftedAction?: DraftedAction | null;
}

const MESSAGE_COLS = "id, role, content, drafted_action, created_at";

function notFound(conversationId: string): Error {
  const e = new Error(`Conversation ${conversationId} not found`) as Error & {
    code: string;
    status: number;
  };
  e.code = "CONVERSATION_NOT_FOUND";
  e.status = 404;
  return e;
}

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  return {
    id: String(r.id),
    role: r.role as ChatMessage["role"],
    content: String(r.content ?? ""),
    draftedAction: (r.drafted_action as DraftedAction | null) ?? null,
    createdAt: String(r.created_at),
  };
}

async function assertOwned(shopId: string, conversationId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from("assistant_conversations")
    .select("id")
    .eq("shop_id", shopId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound(conversationId);
}

export async function listConversations(shopDomain: string): Promise<ConversationSummary[]> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("assistant_conversations")
    .select("id, title, updated_at")
    .eq("shop_id", shopId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    title: (r.title as string | null) ?? null,
    updatedAt: String(r.updated_at),
  }));
}

export async function getMessages(
  shopDomain: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  const shopId = await resolveShopId(shopDomain);
  await assertOwned(shopId, conversationId);
  const { data, error } = await getSupabase()
    .from("assistant_messages")
    .select(MESSAGE_COLS)
    .eq("shop_id", shopId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(rowToMessage);
}

export async function createConversation(
  shopDomain: string,
  title: string | null,
): Promise<string> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("assistant_conversations")
    .insert({ shop_id: shopId, title })
    .select("id")
    .single();
  if (error) throw error;
  return String(data.id);
}

export async function appendMessage(
  shopDomain: string,
  conversationId: string,
  input: AppendInput,
): Promise<ChatMessage> {
  const shopId = await resolveShopId(shopDomain);
  await assertOwned(shopId, conversationId);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("assistant_messages")
    .insert({
      shop_id: shopId,
      conversation_id: conversationId,
      role: input.role,
      content: input.content,
      drafted_action: input.draftedAction ?? null,
    })
    .select(MESSAGE_COLS)
    .single();
  if (error) throw error;
  const { error: upErr } = await sb
    .from("assistant_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", conversationId);
  if (upErr) throw upErr;
  return rowToMessage(data);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/conversations.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/conversations.server.ts app/lib/assistant/__tests__/conversations.test.ts
git commit -m "feat(assistant): shop-scoped conversation persistence + isolation tests"
```

---

## Task 10: Action input validation helper

**Files:**
- Create: `app/lib/assistant/request.server.ts`
- Test: `app/lib/assistant/__tests__/request.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/request.test.ts
import { describe, it, expect } from "vitest";
import { parseAssistantRequest } from "../request.server";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseAssistantRequest", () => {
  it("accepts a valid message and trims it", () => {
    const r = parseAssistantRequest(fd({ message: "  why did profit drop?  " }));
    expect(r).toEqual({ ok: true, value: { conversationId: null, message: "why did profit drop?" } });
  });

  it("keeps a provided conversationId", () => {
    const r = parseAssistantRequest(fd({ message: "hi", conversationId: "c1" }));
    expect(r).toEqual({ ok: true, value: { conversationId: "c1", message: "hi" } });
  });

  it("rejects an empty message", () => {
    const r = parseAssistantRequest(fd({ message: "   " }));
    expect(r).toEqual({ ok: false, code: "MESSAGE_REQUIRED", message: expect.any(String) });
  });

  it("rejects an over-long message", () => {
    const r = parseAssistantRequest(fd({ message: "x".repeat(4001) }));
    expect(r).toMatchObject({ ok: false, code: "MESSAGE_TOO_LONG" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/request.test.ts`
Expected: FAIL — cannot find module `../request.server`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/request.server.ts
export interface ParsedAssistantRequest {
  conversationId: string | null;
  message: string;
}

export type ParseResult =
  | { ok: true; value: ParsedAssistantRequest }
  | { ok: false; code: string; message: string };

const MAX_MESSAGE_LEN = 4000;

export function parseAssistantRequest(form: FormData): ParseResult {
  const message = String(form.get("message") ?? "").trim();
  if (!message) return { ok: false, code: "MESSAGE_REQUIRED", message: "Message is required" };
  if (message.length > MAX_MESSAGE_LEN) {
    return {
      ok: false,
      code: "MESSAGE_TOO_LONG",
      message: `Message must be ${MAX_MESSAGE_LEN} characters or fewer`,
    };
  }
  const cid = String(form.get("conversationId") ?? "").trim();
  return { ok: true, value: { conversationId: cid || null, message } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/request.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/request.server.ts app/lib/assistant/__tests__/request.test.ts
git commit -m "feat(assistant): validate chat action input"
```

---

## Task 11: The resource route (loader + action)

**Files:**
- Create: `app/routes/app.assistant.tsx`
- Test: `app/routes/__tests__/assistant-action.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/assistant-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";

const { runTurnSpy, appendSpy, createConvSpy, getMessagesSpy } = vi.hoisted(() => ({
  runTurnSpy: vi.fn(),
  appendSpy: vi.fn(),
  createConvSpy: vi.fn(),
  getMessagesSpy: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));
vi.mock("~/lib/calderyn.server", () => ({ calderynClient: () => ({}) }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: vi.fn() } }),
  assistantModel: () => "x",
}));
vi.mock("~/lib/assistant/snapshot.server", () => ({ buildSnapshot: async () => "snap" }));
vi.mock("~/lib/assistant/prompt.server", () => ({ buildSystemPrompt: () => [] }));
vi.mock("~/lib/assistant/tools.server", () => ({
  ASSISTANT_TOOLS: [],
  makeToolDispatcher: () => async () => ({ content: "{}" }),
}));
vi.mock("~/lib/assistant/loop.server", () => ({
  runAssistantTurn: (...a: unknown[]) => runTurnSpy(...a),
}));
vi.mock("~/lib/assistant/conversations.server", () => ({
  createConversation: (...a: unknown[]) => createConvSpy(...a),
  appendMessage: (...a: unknown[]) => appendSpy(...a),
  getMessages: (...a: unknown[]) => getMessagesSpy(...a),
  listConversations: async () => [],
}));

import { action } from "../app.assistant";

function send(message: string, conversationId?: string): Promise<Response> {
  const fd = new FormData();
  fd.set("message", message);
  if (conversationId) fd.set("conversationId", conversationId);
  const request = new Request("http://localhost/app/assistant", { method: "POST", body: fd });
  return action({ request } as unknown as ActionFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  runTurnSpy.mockReset();
  appendSpy.mockReset();
  createConvSpy.mockReset();
  getMessagesSpy.mockReset();
  createConvSpy.mockResolvedValue("conv-1");
  getMessagesSpy.mockResolvedValue([]);
  appendSpy.mockImplementation(async (_s, _c, m) => ({
    id: "m1",
    role: m.role,
    content: m.content,
    draftedAction: m.draftedAction ?? null,
    createdAt: "2026-06-02T00:00:00Z",
  }));
  runTurnSpy.mockResolvedValue({ text: "here is the answer", draftedAction: null, stoppedAtCap: false });
});

describe("assistant action", () => {
  it("creates a conversation, persists both messages, returns the assistant reply", async () => {
    const res = await send("why did profit drop?");
    const body = (await res.json()) as { conversationId: string; assistantMessage: { content: string } };
    expect(createConvSpy).toHaveBeenCalledTimes(1);
    // user message + assistant message both appended
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy.mock.calls[0][2]).toMatchObject({ role: "user", content: "why did profit drop?" });
    expect(appendSpy.mock.calls[1][2]).toMatchObject({ role: "assistant", content: "here is the answer" });
    expect(body.conversationId).toBe("conv-1");
    expect(body.assistantMessage.content).toBe("here is the answer");
  });

  it("rejects an empty message with 400 and runs no turn", async () => {
    const res = await send("   ");
    expect(res.status).toBe(400);
    expect(runTurnSpy).not.toHaveBeenCalled();
  });

  it("reuses an existing conversationId without creating a new one", async () => {
    await send("follow up", "conv-existing");
    expect(createConvSpy).not.toHaveBeenCalled();
    expect(appendSpy.mock.calls[0][1]).toBe("conv-existing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/assistant-action.test.ts`
Expected: FAIL — cannot find module `../app.assistant`.

- [ ] **Step 3: Write the implementation**

```tsx
// app/routes/app.assistant.tsx
// Resource route (no UI): the slideout's backend. loader = history, action = one turn.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";
import { buildSnapshot } from "~/lib/assistant/snapshot.server";
import { buildSystemPrompt } from "~/lib/assistant/prompt.server";
import { ASSISTANT_TOOLS, makeToolDispatcher } from "~/lib/assistant/tools.server";
import { runAssistantTurn } from "~/lib/assistant/loop.server";
import {
  appendMessage,
  createConversation,
  getMessages,
  listConversations,
} from "~/lib/assistant/conversations.server";
import { parseAssistantRequest } from "~/lib/assistant/request.server";
import type { ChatMessage, ConversationSummary } from "~/lib/assistant/types";
import type Anthropic from "@anthropic-ai/sdk";

const HISTORY_WINDOW = 20;

type LoaderPayload = {
  conversations: ConversationSummary[];
  conversationId: string | null;
  messages: ChatMessage[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requested = url.searchParams.get("conversationId");
  const conversations = await listConversations(session.shop);
  const conversationId = requested ?? conversations[0]?.id ?? null;
  const messages = conversationId ? await getMessages(session.shop, conversationId) : [];
  return json<LoaderPayload>({ conversations, conversationId, messages });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = parseAssistantRequest(form);
  if (!parsed.ok) {
    return json({ error: { code: parsed.code, message: parsed.message } }, { status: 400 });
  }
  const { conversationId: incoming, message } = parsed.value;

  const conversationId =
    incoming ?? (await createConversation(session.shop, message.slice(0, 80)));

  // History BEFORE this message (used as model context), then persist the user turn.
  const prior = await getMessages(session.shop, conversationId);
  await appendMessage(session.shop, conversationId, { role: "user", content: message });

  const history: Anthropic.MessageParam[] = prior
    .slice(-HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }));

  const client = calderynClient(session.shop);
  const snapshot = await buildSnapshot(client);

  let result;
  try {
    const anthropic = getAnthropic();
    result = await runAssistantTurn({
      createMessage: (params) => anthropic.messages.create(params),
      model: assistantModel(),
      system: buildSystemPrompt(snapshot),
      tools: ASSISTANT_TOOLS,
      dispatchTool: makeToolDispatcher(client),
      history,
      userMessage: message,
    });
  } catch (err) {
    const e = err as { message?: string };
    // User turn is already saved; do not persist a broken assistant turn (clean retry).
    return json(
      {
        conversationId,
        error: { code: "ASSISTANT_ERROR", message: e.message ?? "Could not reach Claude" },
      },
      { status: 502 },
    );
  }

  const assistantMessage = await appendMessage(session.shop, conversationId, {
    role: "assistant",
    content: result.text,
    draftedAction: result.draftedAction,
  });

  return json({ conversationId, assistantMessage, draftedAction: result.draftedAction });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/assistant-action.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run:
```bash
npx vitest run && npm run typecheck
```
Expected: all assistant tests + existing suite green; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.assistant.tsx app/routes/__tests__/assistant-action.test.ts
git commit -m "feat(assistant): resource route wiring loop + persistence"
```

---

## Task 12: Deep-link helper for the alert page

**Files:**
- Create: `app/lib/assistant/action-param.ts`
- Test: `app/lib/assistant/__tests__/action-param.test.ts`

> Client-safe (no `.server`): used by the React alert page in Task 14.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/assistant/__tests__/action-param.test.ts
import { describe, it, expect } from "vitest";
import { resolveActionParam } from "../action-param";

describe("resolveActionParam", () => {
  const allowed = ["pause_campaign", "snooze_alert"] as const;

  it("returns the kind when it is in the allowed list", () => {
    expect(resolveActionParam("pause_campaign", [...allowed])).toBe("pause_campaign");
  });

  it("returns null for a kind not allowed for this alert", () => {
    expect(resolveActionParam("exclude_geo", [...allowed])).toBeNull();
  });

  it("returns null for an unknown or missing value", () => {
    expect(resolveActionParam("garbage", [...allowed])).toBeNull();
    expect(resolveActionParam(null, [...allowed])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/assistant/__tests__/action-param.test.ts`
Expected: FAIL — cannot find module `../action-param`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/assistant/action-param.ts
import type { ActionKind } from "../types";

/** Returns the action kind from a ?action= param only if it's allowed for this alert. */
export function resolveActionParam(
  raw: string | null,
  allowed: ActionKind[],
): ActionKind | null {
  if (!raw) return null;
  return (allowed as string[]).includes(raw) ? (raw as ActionKind) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/assistant/__tests__/action-param.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/action-param.ts app/lib/assistant/__tests__/action-param.test.ts
git commit -m "feat(assistant): deep-link action-param resolver for alert page"
```

---

## Task 13: Slideout UI components

**Files:**
- Create: `app/components/Assistant/DraftActionCard.tsx`
- Create: `app/components/Assistant/AssistantSlideout.tsx`
- Create: `app/components/Assistant/assistant.css`

> No automated tests here (the repo has no jsdom/React-testing setup, and the spec
> marks UI tests optional). Verified manually in Task 15. All content is Polaris;
> only `assistant.css` does positioning.

- [ ] **Step 1: Write the drafted-action card**

```tsx
// app/components/Assistant/DraftActionCard.tsx
import { useNavigate } from "@remix-run/react";
import { Box, Button, InlineStack, Text } from "@shopify/polaris";
import type { DraftedAction } from "~/lib/assistant/types";

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function DraftActionCard({ action }: { action: DraftedAction }) {
  const navigate = useNavigate();
  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200" borderColor="border" borderWidth="025">
      <InlineStack align="space-between" blockAlign="center" gap="200">
        <Text as="span" variant="bodySm" fontWeight="semibold">
          Proposed: {action.label} · {dollars(action.dollarImpact)}/30d
        </Text>
        <Button
          variant="primary"
          size="slim"
          onClick={() =>
            navigate(`/app/alerts/${action.alertId}?action=${action.actionKind}`)
          }
        >
          Review &amp; confirm
        </Button>
      </InlineStack>
    </Box>
  );
}
```

- [ ] **Step 2: Write the positioning CSS**

```css
/* app/components/Assistant/assistant.css — positioning only; all content is Polaris. */
.calderyn-assistant-launcher {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 519;
}

.calderyn-assistant-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 400px;
  max-width: 92vw;
  z-index: 520;
  background: var(--p-color-bg-surface, #fff);
  border-left: 1px solid var(--p-color-border, #e1e3e5);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
}

.calderyn-assistant-header,
.calderyn-assistant-composer {
  padding: 12px;
  border-bottom: 1px solid var(--p-color-border, #e1e3e5);
}
.calderyn-assistant-composer {
  border-bottom: none;
  border-top: 1px solid var(--p-color-border, #e1e3e5);
}
.calderyn-assistant-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}
.calderyn-assistant-bubble {
  margin-bottom: 12px;
}
.calderyn-assistant-bubble[data-role="user"] {
  text-align: right;
}
```

- [ ] **Step 3: Write the slideout**

```tsx
// app/components/Assistant/AssistantSlideout.tsx
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Icon,
  InlineStack,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { ChatIcon, XIcon } from "@shopify/polaris-icons";
import type { ChatMessage, ConversationSummary, DraftedAction } from "~/lib/assistant/types";
import { DraftActionCard } from "./DraftActionCard";

type LoaderData = {
  conversations: ConversationSummary[];
  conversationId: string | null;
  messages: ChatMessage[];
};
type ActionData = {
  conversationId?: string;
  assistantMessage?: ChatMessage;
  draftedAction?: DraftedAction | null;
  error?: { code: string; message: string };
};

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

export function AssistantSlideout() {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const history = useFetcher<LoaderData>();
  const send = useFetcher<ActionData>();
  const sending = send.state !== "idle";
  const messagesRef = useRef<HTMLDivElement>(null);

  // Load history the first time the panel opens.
  useEffect(() => {
    if (open && history.state === "idle" && history.data === undefined) {
      history.load("/app/assistant");
    }
  }, [open, history]);

  useEffect(() => {
    if (history.data) {
      setMessages(history.data.messages);
      setConversationId(history.data.conversationId);
    }
  }, [history.data]);

  // Reconcile the assistant reply when a send completes.
  useEffect(() => {
    if (send.state === "idle" && send.data) {
      if (send.data.error) {
        setErrorText(send.data.error.message);
        return;
      }
      setErrorText(null);
      if (send.data.conversationId) setConversationId(send.data.conversationId);
      if (send.data.assistantMessage) {
        setMessages((prev) => [...prev, send.data!.assistantMessage!]);
      }
    }
  }, [send.state, send.data]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages, sending]);

  function submit() {
    const text = input.trim();
    if (!text || sending) return;
    setMessages((prev) => [
      ...prev,
      { id: nextLocalId(), role: "user", content: text, draftedAction: null, createdAt: new Date().toISOString() },
    ]);
    const fd = new FormData();
    fd.set("message", text);
    if (conversationId) fd.set("conversationId", conversationId);
    send.submit(fd, { method: "post", action: "/app/assistant" });
    setInput("");
  }

  function newChat() {
    setMessages([]);
    setConversationId(null);
    setErrorText(null);
  }

  if (!open) {
    return (
      <div className="calderyn-assistant-launcher">
        <Button variant="primary" icon={ChatIcon} onClick={() => setOpen(true)}>
          Ask Calderyn
        </Button>
      </div>
    );
  }

  return (
    <div className="calderyn-assistant-panel" role="dialog" aria-label="Calderyn assistant">
      <div className="calderyn-assistant-header">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingSm">Calderyn assistant</Text>
          <InlineStack gap="200">
            <Button size="slim" onClick={newChat}>New chat</Button>
            <Button size="slim" variant="tertiary" icon={XIcon} accessibilityLabel="Close" onClick={() => setOpen(false)} />
          </InlineStack>
        </InlineStack>
      </div>

      <div className="calderyn-assistant-messages" ref={messagesRef}>
        <BlockStack gap="0">
          {messages.length === 0 && (
            <Text as="p" tone="subdued" variant="bodySm">
              Ask about your alerts, campaigns, SKUs, or audit log — e.g. “why did profit drop last week?”
            </Text>
          )}
          {messages.map((m) => (
            <div key={m.id} className="calderyn-assistant-bubble" data-role={m.role}>
              <BlockStack gap="100">
                <Badge tone={m.role === "assistant" ? "info" : undefined}>
                  {m.role === "assistant" ? "Claude" : "You"}
                </Badge>
                <Text as="p" variant="bodyMd">{m.content}</Text>
                {m.draftedAction && <DraftActionCard action={m.draftedAction} />}
              </BlockStack>
            </div>
          ))}
          {sending && (
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" accessibilityLabel="Claude is thinking" />
              <Text as="span" tone="subdued" variant="bodySm">Claude is thinking…</Text>
            </InlineStack>
          )}
          {errorText && (
            <Box paddingBlockStart="200">
              <Text as="p" tone="critical" variant="bodySm">{errorText}</Text>
            </Box>
          )}
        </BlockStack>
      </div>

      <div className="calderyn-assistant-composer">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Message"
              labelHidden
              value={input}
              onChange={setInput}
              placeholder="Ask about your data…"
              autoComplete="off"
              multiline
              onFocus={() => undefined}
            />
          </div>
          <Button variant="primary" loading={sending} disabled={!input.trim()} onClick={submit}>
            Send
          </Button>
        </InlineStack>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0. (If `@shopify/polaris-icons` is not already a dependency, install it: `npm install @shopify/polaris-icons` — it ships with Polaris peer setups; confirm before adding.)

- [ ] **Step 5: Commit**

```bash
git add app/components/Assistant/
git commit -m "feat(assistant): slideout UI (launcher, panel, composer, draft card)"
```

---

## Task 14: Mount the slideout + wire the deep-link

**Files:**
- Modify: `app/routes/app.tsx`
- Modify: `app/routes/app.alerts.$id.tsx`

- [ ] **Step 1: Mount the slideout and link its CSS in `app.tsx`**

In `app/routes/app.tsx`, add imports near the top:
```tsx
import assistantStyles from "../components/Assistant/assistant.css?url";
import { AssistantSlideout } from "../components/Assistant/AssistantSlideout";
```

Change the `links` export to include the assistant stylesheet:
```tsx
export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: assistantStyles },
];
```

Mount the slideout inside `AppProvider`, right after `<Outlet />`:
```tsx
      <Outlet />
      <AssistantSlideout />
    </AppProvider>
```

- [ ] **Step 2: Wire the `?action=` deep-link in `app.alerts.$id.tsx`**

Add `useSearchParams` to the existing `@remix-run/react` import, and import the resolver:
```tsx
import { useSearchParams } from "@remix-run/react";
import { resolveActionParam } from "~/lib/assistant/action-param";
```

Inside `AlertDetail()`, after `const [actionKind, setActionKind] = useState<ActionKind | null>(null);`, add:
```tsx
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (!alert) return;
    const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] || ["snooze_alert"];
    const fromUrl = resolveActionParam(searchParams.get("action"), allowed);
    if (fromUrl) setActionKind(fromUrl);
  }, [alert, searchParams]);
```

(`useEffect`, `DETECTOR_TO_ACTIONS`, and `ActionKind` are already imported in this file.)

- [ ] **Step 3: Verify typecheck + lint + build**

Run:
```bash
npm run typecheck && npm run lint && npm run build
```
Expected: all exit 0. Fix any unused-import or type errors before continuing.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.tsx app/routes/app.alerts.\$id.tsx
git commit -m "feat(assistant): mount slideout app-wide + alert ?action= deep-link"
```

---

## Task 15: Manual verification + final gate

**Files:** none (verification only)

- [ ] **Step 1: Set local env**

Ensure `.env` (not committed) has `ANTHROPIC_API_KEY` set to a real key and, optionally, `ANTHROPIC_MODEL` to the value verified via the `claude-api` skill. Apply the migration (Task 2) to the dev Supabase if not already applied.

- [ ] **Step 2: Run the app and exercise the flow**

Run:
```bash
npm run dev
```
Then in the embedded admin:
- Confirm the "Ask Calderyn" launcher appears bottom-right on every `/app/*` page.
- Open it, ask "what are my most urgent alerts?" — confirm a grounded answer.
- Ask something that maps to an alert action (e.g. "what should I do about the worst campaign?") — confirm a "Review & confirm" card appears, and clicking it opens the alert page with the action modal pre-opened.
- Reload the page, reopen the panel — confirm the conversation is restored.
- Confirm no `ANTHROPIC_API_KEY` appears in the browser network/JS (server-only).

- [ ] **Step 3: Full eval pipeline (pre-commit gate per CLAUDE.md)**

Run, in order, and paste results:
```bash
npx vitest run
npm run typecheck
npm run lint
npm run build
```
Expected: every step exit 0; no warnings on touched files.

- [ ] **Step 4: Run `/code-review` on the working tree**

Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 5: Patch sanity**

Run:
```bash
git diff --stat
git diff --check
```
Expected: no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks in the diff.

- [ ] **Step 6: Final commit (if review produced fixes)**

```bash
git add -A
git commit -m "chore(assistant): address code-review + final gate"
```

---

## Self-Review (completed during planning)

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §2 read seam A (direct calderynClient) | 7 (dispatcher), 11 (route) |
| §2/§7 explain + draft-to-confirm | 7 (`propose_action`), 12 (resolver), 13 (`DraftActionCard`), 14 (deep-link) |
| §2 global slideout placement | 13 (slideout), 14 (mount in `app.tsx`) |
| §2/§8 persistent memory | 2 (migration), 9 (conversations) |
| §2/§5 hybrid snapshot + tools | 5 (snapshot), 6 (prompt), 7 (tools), 8 (loop) |
| §2/§10.1 env-driven model | 1 (env), 4 (`assistantModel`) |
| §2/§5/§11 sync request/response | 11 (route action) |
| §8.1 shop mapping + isolation | 9 (tests 1–3) |
| §10 cost bounds (8 turns, history window, snapshot cap) | 5, 8, 11 |
| §11 error handling (Anthropic/tool/config/auth) | 7, 8, 11 |
| §12 testing matrix | 4, 5, 6, 7, 8, 9, 10, 11, 12 |
| §13 deps + gate | 1, 15 |

**Placeholder scan:** none — every code/test step contains complete content.

**Type consistency:** `DraftedAction`, `ChatMessage`, `ConversationSummary` (Task 3) are used unchanged in Tasks 7/8/9/11/13. `ToolDispatchResult` (Task 7) is consumed by Task 8. `runAssistantTurn` params/return (Task 8) match the route call site (Task 11). `parseAssistantRequest` result shape (Task 10) matches the route's branch (Task 11). `resolveActionParam` (Task 12) signature matches the alert-page call (Task 14).

**Open implementation note:** Tasks 4/6/8 require the `claude-api` skill to confirm the exact model string and `cache_control` mechanics for the installed SDK version before finalizing those files.
