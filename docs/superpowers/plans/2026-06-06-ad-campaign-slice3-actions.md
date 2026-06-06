# Ad Campaign Integrations — Slice 3 (Actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one-click **pause** and **reduce-budget** actions actually execute against Meta, Google, and TikTok via a shared action adapter, with a real `action_audit` pre/post trail, campaign ownership + idempotency guards, and one-click undo.

**Architecture:** A platform-blind `ActionAdapter` contract (pause / resume / setDailyBudget / getState) with one implementation per platform, each resolving its own encrypted credentials from `integration_credentials` (decoupled from the OAuth/ingest code). A single `executeAction` orchestrator does the ownership check → idempotency check → read pre-state → call the adapter → write one append-only `action_audit` row. `undoAction` reverses from the recorded pre-state through the same adapter. The alerts + campaigns routes call the new orchestrator.

**Tech Stack:** TypeScript (strict, ES modules), `@supabase/supabase-js` (service role), Vitest, existing `action_audit`/`action_idempotency`/`undo_token` tables. Spec: `docs/superpowers/specs/2026-06-06-ad-campaign-integrations-design.md`.

---

## ⚠️ Parallel-work constraint (do not edit these)

A background agent is wiring OAuth in the same repo. **Slice 3 must NOT modify** any of:
`app/lib/meta/oauth.server.ts`, `app/lib/google/oauth.server.ts`, `app/lib/tiktok/oauth.server.ts`, `app/routes/auth.*.tsx`, `app/lib/google/client.server.ts`, and the `integrations.startOAuth` method in `app/lib/calderyn.server.ts`.

Slice 3 lives in **new files** plus the two UI routes (`app/routes/app.alerts.$id.tsx`, `app/routes/app.campaigns.tsx`), which the OAuth agent does not touch. Importing from any file is fine — only edits conflict. **Recommended:** execute this slice only after the OAuth branch is merged; then this constraint is moot.

## Scope

- Action kinds: **`pause_campaign`** and **`reduce_campaign_budget`** only (the two highest-value, lowest-risk). `exclude_geo`, `reallocate_inventory`, `create_po_draft` stay out of scope.
- All three platforms via the adapter. Google/TikTok action adapters are testable with fakes now; they execute against live accounts once OAuth has stored credentials (same no-op-until-connected pattern as ingestion).

## No migration needed

`action_audit`, `action_idempotency`, `undo_token` already exist (`tests/engine/schema/migrations/20260430000022_action_audit_and_undo.sql`) with RLS scoped by `current_shop_id()`. No schema change in this slice.

---

## File Structure

**New files:**
- `app/lib/ads/actions.ts` — `ActionAdapter`, `CampaignActionState`, `ActionError` types (pure contract).
- `app/lib/meta/actions.server.ts` — `metaActionAdapter` (uses `MetaClient`; reuses `setCampaignStatus`).
- `app/lib/google/actions.server.ts` — `googleActionAdapter` (Google Ads `campaign:mutate`).
- `app/lib/tiktok/actions.server.ts` — `tiktokActionAdapter` (TikTok `/campaign/update/` + status).
- `app/lib/ads/action-registry.server.ts` — `actionAdapterForShop(shopId, platform)`.
- `app/lib/actions/execute.server.ts` — `executeAction(shopId, input)` orchestrator.
- `app/lib/actions/undo.server.ts` — `undoAction(shopId, auditId)`.
- Test files mirror each under `__tests__/`.

**Modified files (UI routes only — not touched by the OAuth agent):**
- `app/routes/app.campaigns.tsx` — call `executeAction` instead of `calderynClient.actions.execute`.
- `app/routes/app.alerts.$id.tsx` — same.

---

## Task 1: Action adapter contract

**Files:**
- Create: `app/lib/ads/actions.ts`
- Test: `app/lib/ads/__tests__/actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/actions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ActionAdapter, CampaignActionState } from "../actions";
import { ActionError } from "../actions";

describe("action contract", () => {
  it("a fake adapter conforms and getState returns the documented shape", async () => {
    const state: CampaignActionState = { status: "active", dailyBudgetCents: 5000 };
    const adapter: ActionAdapter = {
      platform: "meta",
      pause: async () => {},
      resume: async () => {},
      setDailyBudget: async () => {},
      getState: async () => state,
    };
    expect(adapter.platform).toBe("meta");
    expect((await adapter.getState("c1")).dailyBudgetCents).toBe(5000);
  });

  it("ActionError carries a platform + message", () => {
    const e = new ActionError("meta", "boom");
    expect(e.platform).toBe("meta");
    expect(e.message).toContain("boom");
    expect(e).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/actions.test.ts`
Expected: FAIL — cannot find module `../actions`.

- [ ] **Step 3: Write the contract**

Create `app/lib/ads/actions.ts`:

```ts
// Platform-blind campaign action contract. One implementation per platform; the
// executor (app/lib/actions/execute.server.ts) dispatches to it without knowing
// which platform it is.

import type { Platform } from "./adapter";

export type { Platform };

export interface CampaignActionState {
  status: "active" | "paused";
  dailyBudgetCents: number | null;
}

/** Thrown by adapters on a platform API failure (surfaced into action_audit). */
export class ActionError extends Error {
  readonly platform: Platform;
  constructor(platform: Platform, message: string) {
    super(`[${platform}] ${message}`);
    this.name = "ActionError";
    this.platform = platform;
  }
}

export interface ActionAdapter {
  readonly platform: Platform;
  pause(externalId: string): Promise<void>;
  resume(externalId: string): Promise<void>;
  setDailyBudget(externalId: string, cents: number): Promise<void>;
  getState(externalId: string): Promise<CampaignActionState>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/actions.ts app/lib/ads/__tests__/actions.test.ts
git commit -m "app/lib/ads/actions: platform-blind campaign action contract"
```

---

## Task 2: Meta action adapter

**Files:**
- Create: `app/lib/meta/actions.server.ts`
- Test: `app/lib/meta/__tests__/actions.test.ts`

Reuses the existing `MetaClient` (`./campaigns.server`) + `setCampaignStatus`. Adds budget via `POST /{campaignId}` with `daily_budget` (Meta expects the budget in the account's minor units as a string).

- [ ] **Step 1: Write the failing test**

Create `app/lib/meta/__tests__/actions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeMetaActionAdapter } from "../actions.server";
import type { MetaClient } from "../campaigns.server";

function client(getBody: Record<string, unknown>): MetaClient {
  return {
    get: vi.fn(async () => getBody),
    post: vi.fn(async () => ({ success: true })),
  };
}

describe("metaActionAdapter", () => {
  it("pause posts status PAUSED", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).pause("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "PAUSED" });
  });

  it("resume posts status ACTIVE", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).resume("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "ACTIVE" });
  });

  it("setDailyBudget posts daily_budget in minor units as a string", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).setDailyBudget("c1", 5000);
    expect(c.post).toHaveBeenCalledWith("/c1", { daily_budget: "5000" });
  });

  it("getState maps effective_status + daily_budget", async () => {
    const c = client({ status: "PAUSED", daily_budget: "5000" });
    const s = await makeMetaActionAdapter(c).getState("c1");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/meta/__tests__/actions.test.ts`
Expected: FAIL — cannot find module `../actions.server`.

- [ ] **Step 3: Write the adapter**

Create `app/lib/meta/actions.server.ts`:

```ts
// Meta campaign actions over a MetaClient. pause/resume reuse setCampaignStatus;
// budget posts daily_budget (account minor units, as a string per the Graph API).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";
import { setCampaignStatus, type MetaClient, type MetaResponse } from "./campaigns.server";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function check(r: MetaResponse): MetaResponse {
  if (r.error) throw new ActionError("meta", r.error.message);
  return r;
}

export function makeMetaActionAdapter(client: MetaClient): ActionAdapter {
  return {
    platform: "meta",
    async pause(externalId) {
      await setCampaignStatus(client, externalId, "PAUSED");
    },
    async resume(externalId) {
      await setCampaignStatus(client, externalId, "ACTIVE");
    },
    async setDailyBudget(externalId, cents) {
      check(await client.post(`/${externalId}`, { daily_budget: String(cents) }));
    },
    async getState(externalId): Promise<CampaignActionState> {
      const body = check(await client.get(`/${externalId}`, { fields: "status,daily_budget" }));
      const raw = body as { status?: string; daily_budget?: string };
      return {
        status: (raw.status ?? "").toUpperCase() === "PAUSED" ? "paused" : "active",
        dailyBudgetCents: raw.daily_budget != null ? Number(raw.daily_budget) : null,
      };
    },
  };
}

/** Resolve a Meta action adapter for a shop, or null if not connected. */
export async function metaActionAdapterForShop(shopId: string): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const client: MetaClient = {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      return (await fetch(`${GRAPH_BASE}${path}?${qs}`).then((r) => r.json())) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      return (await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }).then((r) => r.json())) as MetaResponse;
    },
  };
  return makeMetaActionAdapter(client);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/meta/__tests__/actions.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/actions.server.ts app/lib/meta/__tests__/actions.test.ts
git commit -m "app/lib/meta/actions: pause/resume/budget/getState adapter"
```

---

## Task 3: Google action adapter

**Files:**
- Create: `app/lib/google/actions.server.ts`
- Test: `app/lib/google/__tests__/actions.test.ts`

Google Ads campaign mutate via `POST /customers/{cid}/campaigns:mutate`. pause/resume set `status` ENABLED/PAUSED; budget mutates the campaign budget resource. Money is **micros** (cents × 10_000). The adapter takes an injected `mutate` function for testability; the production resolver builds it from `integration_credentials` (kind `google_ads`) — independent of `client.server.ts`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/google/__tests__/actions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeGoogleActionAdapter } from "../actions.server";

describe("googleActionAdapter", () => {
  it("pause issues an updateMask status=PAUSED mutate on the campaign", async () => {
    const mutate = vi.fn(async () => ({}));
    await makeGoogleActionAdapter(mutate, "123").pause("777");
    expect(mutate).toHaveBeenCalledWith("campaigns", expect.objectContaining({
      update: expect.objectContaining({ resourceName: "customers/123/campaigns/777", status: "PAUSED" }),
      updateMask: "status",
    }));
  });

  it("setDailyBudget mutates the budget resource in micros", async () => {
    const mutate = vi.fn(async () => ({}));
    await makeGoogleActionAdapter(mutate, "123").setDailyBudget("777", 5000);
    // 5000 cents -> 50,000,000 micros
    expect(mutate).toHaveBeenCalledWith("campaignBudgets", expect.objectContaining({
      update: expect.objectContaining({ amountMicros: 50000000 }),
      updateMask: "amount_micros",
    }), "777");
  });

  it("getState reads status + budget via the injected reader", async () => {
    const mutate = vi.fn();
    const read = vi.fn(async () => ({ status: "PAUSED", amountMicros: 50000000 }));
    const s = await makeGoogleActionAdapter(mutate, "123", read).getState("777");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/google/__tests__/actions.test.ts`
Expected: FAIL — cannot find module `../actions.server`.

- [ ] **Step 3: Write the adapter**

Create `app/lib/google/actions.server.ts`:

```ts
// Google Ads campaign actions. Mutations go through an injected `mutate(resource,
// operation, campaignExternalId?)` fn so the logic is unit-testable; the resolver
// builds the real mutate against the Google Ads REST API using the shop's
// integration_credentials (kind google_ads). Money is micros (cents * 10_000).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";

type MutateFn = (resource: string, operation: Record<string, unknown>, campaignExternalId?: string) => Promise<unknown>;
type ReadFn = (campaignExternalId: string) => Promise<{ status?: string; amountMicros?: number }>;

const CENTS_TO_MICROS = 10_000;

export function makeGoogleActionAdapter(mutate: MutateFn, customerId: string, read?: ReadFn): ActionAdapter {
  const setStatus = (externalId: string, status: "ENABLED" | "PAUSED") =>
    mutate("campaigns", {
      update: { resourceName: `customers/${customerId}/campaigns/${externalId}`, status },
      updateMask: "status",
    });
  return {
    platform: "google",
    async pause(externalId) {
      await setStatus(externalId, "PAUSED");
    },
    async resume(externalId) {
      await setStatus(externalId, "ENABLED");
    },
    async setDailyBudget(externalId, cents) {
      await mutate(
        "campaignBudgets",
        { update: { amountMicros: cents * CENTS_TO_MICROS }, updateMask: "amount_micros" },
        externalId,
      );
    },
    async getState(externalId): Promise<CampaignActionState> {
      if (!read) throw new ActionError("google", "getState reader not configured");
      const r = await read(externalId);
      return {
        status: (r.status ?? "").toUpperCase() === "PAUSED" ? "paused" : "active",
        dailyBudgetCents: r.amountMicros != null ? Math.round(r.amountMicros / CENTS_TO_MICROS) : null,
      };
    },
  };
}

/** Resolve a Google action adapter for a shop, or null if not connected. */
export async function googleActionAdapterForShop(shopId: string): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "google_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
  const refreshToken = decrypt(data.access_token_encrypted as string);
  const customerId = String(data.external_account_id);

  const apiVersion = "v17";
  const base = `https://googleads.googleapis.com/${apiVersion}`;
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) throw new ActionError("google", "GOOGLE_ADS_DEVELOPER_TOKEN must be set");

  async function accessToken(): Promise<string> {
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new ActionError("google", "Google OAuth client env not set");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token",
      }).toString(),
    });
    const json = (await res.json()) as { access_token?: string; error_description?: string };
    if (!json.access_token) throw new ActionError("google", `token exchange failed: ${json.error_description ?? "no token"}`);
    return json.access_token;
  }

  const mutate: MutateFn = async (resource, operation) => {
    const token = await accessToken();
    const res = await fetch(`${base}/customers/${customerId}/${resource}:mutate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "developer-token": devToken, "content-type": "application/json" },
      body: JSON.stringify({ operations: [operation] }),
    });
    const json = (await res.json()) as { error?: { message?: string } };
    if (!res.ok || json.error) throw new ActionError("google", json.error?.message ?? `HTTP ${res.status}`);
    return json;
  };

  return makeGoogleActionAdapter(mutate, customerId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/google/__tests__/actions.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add app/lib/google/actions.server.ts app/lib/google/__tests__/actions.test.ts
git commit -m "app/lib/google/actions: campaign mutate adapter (status + budget)"
```

---

## Task 4: TikTok action adapter

**Files:**
- Create: `app/lib/tiktok/actions.server.ts`
- Test: `app/lib/tiktok/__tests__/actions.test.ts`

TikTok: status via `POST /campaign/status/update/` (operation_status ENABLE/DISABLE), budget via `POST /campaign/update/` (budget in major currency units). The adapter takes an injected `call(path, body)` fn for testability; the resolver builds it from `integration_credentials` (kind `tiktok_ads`).

- [ ] **Step 1: Write the failing test**

Create `app/lib/tiktok/__tests__/actions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeTikTokActionAdapter } from "../actions.server";

describe("tiktokActionAdapter", () => {
  it("pause posts operation_status DISABLE", async () => {
    const call = vi.fn(async () => ({ code: 0 }));
    await makeTikTokActionAdapter(call, "adv1").pause("c1");
    expect(call).toHaveBeenCalledWith("/campaign/status/update/", expect.objectContaining({
      advertiser_id: "adv1", campaign_ids: ["c1"], operation_status: "DISABLE",
    }));
  });

  it("resume posts operation_status ENABLE", async () => {
    const call = vi.fn(async () => ({ code: 0 }));
    await makeTikTokActionAdapter(call, "adv1").resume("c1");
    expect(call).toHaveBeenCalledWith("/campaign/status/update/", expect.objectContaining({ operation_status: "ENABLE" }));
  });

  it("setDailyBudget posts budget in major units (cents/100)", async () => {
    const call = vi.fn(async () => ({ code: 0 }));
    await makeTikTokActionAdapter(call, "adv1").setDailyBudget("c1", 5000);
    expect(call).toHaveBeenCalledWith("/campaign/update/", expect.objectContaining({
      advertiser_id: "adv1", campaign_id: "c1", budget: 50,
    }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/tiktok/__tests__/actions.test.ts`
Expected: FAIL — cannot find module `../actions.server`.

- [ ] **Step 3: Write the adapter**

Create `app/lib/tiktok/actions.server.ts`:

```ts
// TikTok campaign actions. Status via /campaign/status/update/, budget via
// /campaign/update/ (budget in major currency units). An injected `call(path,
// body)` fn keeps the logic testable; the resolver builds the real call against
// the TikTok Business API using integration_credentials (kind tiktok_ads).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";

type CallFn = (path: string, body: Record<string, unknown>) => Promise<{ code?: number; message?: string }>;

function check(r: { code?: number; message?: string }): void {
  if (r.code !== undefined && r.code !== 0) throw new ActionError("tiktok", r.message ?? `code ${r.code}`);
}

export function makeTikTokActionAdapter(call: CallFn, advertiserId: string): ActionAdapter {
  return {
    platform: "tiktok",
    async pause(externalId) {
      check(await call("/campaign/status/update/", {
        advertiser_id: advertiserId, campaign_ids: [externalId], operation_status: "DISABLE",
      }));
    },
    async resume(externalId) {
      check(await call("/campaign/status/update/", {
        advertiser_id: advertiserId, campaign_ids: [externalId], operation_status: "ENABLE",
      }));
    },
    async setDailyBudget(externalId, cents) {
      check(await call("/campaign/update/", {
        advertiser_id: advertiserId, campaign_id: externalId, budget: Math.round(cents) / 100,
      }));
    },
    async getState(): Promise<CampaignActionState> {
      // Slice 3 records pre-state from ad_campaign_dim (see executor); TikTok's
      // per-campaign read endpoint is not needed for the action path.
      throw new ActionError("tiktok", "getState not used for tiktok in Slice 3");
    },
  };
}

/** Resolve a TikTok action adapter for a shop, or null if not connected. */
export async function tiktokActionAdapterForShop(shopId: string): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "tiktok_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const advertiserId = String(data.external_account_id);
  const base = "https://business-api.tiktok.com/open_api/v1.3";

  const call: CallFn = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { code?: number; message?: string };
  };
  return makeTikTokActionAdapter(call, advertiserId);
}
```

Note: `getState` for Google/TikTok is not on the action hot path — the executor reads pre-state from `ad_campaign_dim` (already synced by Slice 1). Meta implements `getState` because its undo path historically read live status; the executor still prefers `ad_campaign_dim` for pre-state uniformly (Task 6).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/tiktok/__tests__/actions.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add app/lib/tiktok/actions.server.ts app/lib/tiktok/__tests__/actions.test.ts
git commit -m "app/lib/tiktok/actions: campaign status + budget adapter"
```

---

## Task 5: Action adapter registry

**Files:**
- Create: `app/lib/ads/action-registry.server.ts`
- Test: `app/lib/ads/__tests__/action-registry.test.ts`

`actionAdapterForShop(shopId, platform)` returns the platform's resolved adapter (or null). Thin dispatcher over the three resolvers.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/action-registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const meta = vi.fn(async () => ({ platform: "meta" }));
const google = vi.fn(async () => ({ platform: "google" }));
const tiktok = vi.fn(async () => null);

vi.mock("../../meta/actions.server", () => ({ metaActionAdapterForShop: meta }));
vi.mock("../../google/actions.server", () => ({ googleActionAdapterForShop: google }));
vi.mock("../../tiktok/actions.server", () => ({ tiktokActionAdapterForShop: tiktok }));

import { actionAdapterForShop } from "../action-registry.server";

describe("actionAdapterForShop", () => {
  it("dispatches to the platform resolver", async () => {
    expect(await actionAdapterForShop("s1", "meta")).toMatchObject({ platform: "meta" });
    expect(meta).toHaveBeenCalledWith("s1");
  });
  it("returns null when the platform has no connection", async () => {
    expect(await actionAdapterForShop("s1", "tiktok")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/action-registry.test.ts`
Expected: FAIL — cannot find module `../action-registry.server`.

- [ ] **Step 3: Write the registry**

Create `app/lib/ads/action-registry.server.ts`:

```ts
// Resolve the action adapter for a shop + platform. Thin dispatcher; keeps the
// executor platform-blind.

import type { Platform } from "./adapter";
import type { ActionAdapter } from "./actions";
import { metaActionAdapterForShop } from "../meta/actions.server";
import { googleActionAdapterForShop } from "../google/actions.server";
import { tiktokActionAdapterForShop } from "../tiktok/actions.server";

export function actionAdapterForShop(shopId: string, platform: Platform): Promise<ActionAdapter | null> {
  switch (platform) {
    case "meta":
      return metaActionAdapterForShop(shopId);
    case "google":
      return googleActionAdapterForShop(shopId);
    case "tiktok":
      return tiktokActionAdapterForShop(shopId);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/action-registry.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/action-registry.server.ts app/lib/ads/__tests__/action-registry.test.ts
git commit -m "app/lib/ads/action-registry: resolve action adapter per shop+platform"
```

---

## Task 6: Execute orchestrator (ownership + idempotency + audit)

**Files:**
- Create: `app/lib/actions/execute.server.ts`
- Test: `app/lib/actions/__tests__/execute.test.ts`

`executeAction(shopId, input)` where `input = { alertId, kind, campaignId, idempotencyKey, dailyBudgetCents? }`:
1. **Idempotency**: if `action_idempotency` has the key for this shop, return the existing audit (no double-call).
2. **Ownership + resolve**: load the campaign from `ad_campaign_dim` by `id` + `shop_id` (mismatch/missing → throw; this is the cross-tenant guard). Read `external_id`, `platform`, `status`, `daily_budget_cents` (pre-state).
3. Resolve the action adapter (`actionAdapterForShop`). Null → record a `failed` audit with `last_error` "platform not connected".
4. Call the adapter: `pause_campaign` → `adapter.pause(externalId)`; `reduce_campaign_budget` → `adapter.setDailyBudget(externalId, dailyBudgetCents)`.
5. Write ONE append-only `action_audit` row (outcome succeeded/failed, pre_state, post_state, external_call_id null) and the `action_idempotency` row.

- [ ] **Step 1: Write the failing test**

Create `app/lib/actions/__tests__/execute.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const adapter = { platform: "meta", pause: vi.fn(async () => {}), resume: vi.fn(), setDailyBudget: vi.fn(async () => {}), getState: vi.fn() };
const actionAdapterForShop = vi.fn(async () => adapter);
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

import { executeAction } from "../execute.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

// Fake supabase: campaign lookup, idempotency lookup, audit insert, idempotency insert.
function fakeSb(opts: { idempotent?: { audit_id: string }; campaign?: Record<string, unknown> | null }) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: opts.campaign ?? null, error: null };
      if (table === "v_audit_view" || table === "action_audit") return { data: { id: "aud1" }, error: null };
      return { data: null, error: null };
    });
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => { calls.inserts.push({ table, rows }); return chain; });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const campaign = { id: CAMP, shop_id: SHOP, external_id: "c1", platform: "meta", status: "active", daily_budget_cents: 5000 };

describe("executeAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a campaign that does not belong to the shop (ownership guard)", async () => {
    const { sb } = fakeSb({ campaign: null });
    await expect(executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb))
      .rejects.toThrow(/not found|ownership/i);
  });

  it("pauses via the adapter and writes a succeeded audit + idempotency", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb);
    expect(adapter.pause).toHaveBeenCalledWith("c1");
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP, action_kind: "pause_campaign", outcome: "succeeded",
      pre_state: { status: "active", daily_budget_cents: 5000 },
    });
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("reduce_campaign_budget calls setDailyBudget with the new cents", async () => {
    const { sb } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "k2", dailyBudgetCents: 2500 }, sb);
    expect(adapter.setDailyBudget).toHaveBeenCalledWith("c1", 2500);
  });

  it("short-circuits on a used idempotency key (no adapter call)", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb);
    expect(adapter.pause).not.toHaveBeenCalled();
  });

  it("records a failed audit when the platform is not connected", async () => {
    actionAdapterForShop.mockResolvedValueOnce(null);
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k3" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({ outcome: "failed" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/execute.test.ts`
Expected: FAIL — cannot find module `../execute.server`.

- [ ] **Step 3: Write the orchestrator**

Create `app/lib/actions/execute.server.ts`:

```ts
// Execute a campaign action: idempotency -> ownership/resolve -> adapter call ->
// one append-only action_audit row. Ownership: the campaign must belong to the
// acting shop (cross-tenant guard) before any platform API call. Pre-state is
// read from ad_campaign_dim (synced by ingestion), so undo has a true baseline.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";

export type ExecutableKind = "pause_campaign" | "reduce_campaign_budget";

export interface ExecuteInput {
  alertId: string | null;
  kind: ExecutableKind;
  campaignId: string; // ad_campaign_dim uuid
  idempotencyKey: string;
  dailyBudgetCents?: number;
}

export interface ExecutedAudit {
  id: string;
  outcome: "succeeded" | "failed";
}

export async function executeAction(
  shopId: string,
  input: ExecuteInput,
  sb: SupabaseClient,
): Promise<ExecutedAudit> {
  // 1. Idempotency.
  const { data: prior, error: pErr } = await sb
    .from("action_idempotency")
    .select("audit_id")
    .eq("shop_id", shopId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (pErr) throw pErr;
  if (prior?.audit_id) return { id: String(prior.audit_id), outcome: "succeeded" };

  // 2. Ownership + resolve campaign.
  const { data: camp, error: cErr } = await sb
    .from("ad_campaign_dim")
    .select("id, shop_id, external_id, platform, status, daily_budget_cents")
    .eq("id", input.campaignId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!camp) throw new Error(`campaign ${input.campaignId} not found for shop (ownership check failed)`);

  const externalId = String(camp.external_id);
  const platform = String(camp.platform) as Platform;
  const preState = { status: camp.status, daily_budget_cents: camp.daily_budget_cents };
  const postState =
    input.kind === "reduce_campaign_budget"
      ? { status: camp.status, daily_budget_cents: input.dailyBudgetCents ?? null }
      : { status: "paused", daily_budget_cents: camp.daily_budget_cents };

  // 3. Resolve adapter + 4. call platform.
  let outcome: "succeeded" | "failed" = "succeeded";
  let lastError: string | null = null;
  const adapter = await actionAdapterForShop(shopId, platform);
  if (!adapter) {
    outcome = "failed";
    lastError = `${platform} not connected`;
  } else {
    try {
      if (input.kind === "pause_campaign") {
        await adapter.pause(externalId);
      } else {
        await adapter.setDailyBudget(externalId, input.dailyBudgetCents ?? 0);
      }
    } catch (err) {
      outcome = "failed";
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // 5. One append-only audit row + idempotency.
  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      alert_id: input.alertId,
      action_kind: input.kind,
      params: { campaign_id: input.campaignId, external_id: externalId, platform, daily_budget_cents: input.dailyBudgetCents ?? null },
      outcome,
      pre_state: preState,
      post_state: outcome === "succeeded" ? postState : null,
      last_error: lastError,
      actor_user_id: "merchant",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  const auditId = String(ins.id);

  await sb.from("action_idempotency").insert({ shop_id: shopId, idempotency_key: input.idempotencyKey, audit_id: auditId });

  return { id: auditId, outcome };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/execute.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/execute.server.ts app/lib/actions/__tests__/execute.test.ts
git commit -m "app/lib/actions/execute: ownership + idempotency + adapter dispatch + audit"
```

---

## Task 7: Undo

**Files:**
- Create: `app/lib/actions/undo.server.ts`
- Test: `app/lib/actions/__tests__/undo.test.ts`

`undoAction(shopId, auditId)`: load the original audit (shop-scoped), reverse via the adapter from `pre_state` (pause→resume, budget→restore prior cents), write an append-only undo audit row (`undo_of` set, pre/post swapped).

- [ ] **Step 1: Write the failing test**

Create `app/lib/actions/__tests__/undo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const adapter = { platform: "meta", pause: vi.fn(), resume: vi.fn(async () => {}), setDailyBudget: vi.fn(async () => {}), getState: vi.fn() };
const actionAdapterForShop = vi.fn(async () => adapter);
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(original: Record<string, unknown> | null) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: table === "action_audit" ? original : null, error: null }));
    chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => { calls.inserts.push({ table, rows }); return chain; });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const pauseAudit = {
  id: "aud1", shop_id: SHOP, action_kind: "pause_campaign",
  params: { external_id: "c1", platform: "meta" },
  pre_state: { status: "active", daily_budget_cents: 5000 },
  post_state: { status: "paused", daily_budget_cents: 5000 },
};

describe("undoAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resumes a paused campaign and writes an undo audit", async () => {
    const { sb, calls } = fakeSb(pauseAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect((undo?.rows as Record<string, unknown>)).toMatchObject({ undo_of: "aud1", outcome: "succeeded" });
  });

  it("restores the prior budget on a budget-action undo", async () => {
    const budgetAudit = { ...pauseAudit, action_kind: "reduce_campaign_budget",
      pre_state: { status: "active", daily_budget_cents: 5000 },
      post_state: { status: "active", daily_budget_cents: 2500 } };
    const { sb } = fakeSb(budgetAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.setDailyBudget).toHaveBeenCalledWith("c1", 5000);
  });

  it("throws when the audit is not found for the shop", async () => {
    const { sb } = fakeSb(null);
    await expect(undoAction(SHOP, "missing", sb)).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/undo.test.ts`
Expected: FAIL — cannot find module `../undo.server`.

- [ ] **Step 3: Write undo**

Create `app/lib/actions/undo.server.ts`:

```ts
// Reverse a prior action from its recorded pre_state, through the same action
// adapter. Append-only: writes a new action_audit row with undo_of set and
// pre/post swapped. Shop-scoped load is the ownership guard.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";

export async function undoAction(shopId: string, auditId: string, sb: SupabaseClient): Promise<{ id: string }> {
  const { data: orig, error } = await sb
    .from("action_audit")
    .select("id, shop_id, action_kind, params, pre_state, post_state")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!orig) throw new Error(`audit ${auditId} not found for shop`);

  const params = (orig.params ?? {}) as { external_id?: string; platform?: string };
  const pre = (orig.pre_state ?? {}) as { status?: string; daily_budget_cents?: number | null };
  const externalId = String(params.external_id ?? "");
  const platform = String(params.platform ?? "") as Platform;

  const adapter = await actionAdapterForShop(shopId, platform);
  if (!adapter) throw new Error(`${platform} not connected; cannot undo`);

  if (orig.action_kind === "pause_campaign") {
    if (pre.status === "active") await adapter.resume(externalId);
    else await adapter.pause(externalId);
  } else if (orig.action_kind === "reduce_campaign_budget") {
    if (pre.daily_budget_cents != null) await adapter.setDailyBudget(externalId, pre.daily_budget_cents);
  }

  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      action_kind: orig.action_kind,
      params: orig.params,
      outcome: "succeeded",
      pre_state: orig.post_state,
      post_state: orig.pre_state,
      undo_of: orig.id,
      actor_user_id: "merchant",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  return { id: String(ins.id) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/undo.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo.test.ts
git commit -m "app/lib/actions/undo: reverse a prior action from pre_state"
```

---

## Task 8: Wire the routes to the orchestrator

**Files:**
- Modify: `app/routes/app.campaigns.tsx`
- Modify: `app/routes/app.alerts.$id.tsx`

Both routes currently call `calderynClient(session.shop).actions.execute(...)`. Switch the **pause** and **edit_budget/reduce_campaign_budget** intents to the new `executeAction`, resolving `shopId` via `resolveShopId(session.shop)`. Keep `snooze_alert` and any non-action intents on the existing client path. Undo buttons (audit page) switch to `undoAction`.

- [ ] **Step 1: Read both routes' `action` handlers** to learn the exact intent strings, how `campaignId`/`dailyBudgetCents`/`idempotencyKey` arrive in `formData`, and how results are returned to the UI (`json`/`redirect`).

- [ ] **Step 2: Wire `app.campaigns.tsx`**

Import at the top:
```ts
import { executeAction } from "~/lib/actions/execute.server";
import { resolveShopId } from "~/lib/supabase.server";
import { getSupabase } from "~/lib/supabase.server";
```
In the `action`, after computing `kind`/`params`/`idempotencyKey`, replace the `client.actions.execute(...)` call for the pause and edit_budget intents with:
```ts
const shopId = await resolveShopId(session.shop);
const result = await executeAction(shopId, {
  alertId: null,
  kind: kind === "reduce_campaign_budget" ? "reduce_campaign_budget" : "pause_campaign",
  campaignId,
  idempotencyKey,
  dailyBudgetCents: kind === "reduce_campaign_budget" ? Number(params.daily_budget_cents ?? 0) : undefined,
}, getSupabase());
```
Return the same JSON shape the UI expects (an `{ ok: result.outcome === "succeeded" }` or the existing toast contract — match what the component reads).

- [ ] **Step 3: Wire `app.alerts.$id.tsx`**

Same substitution for the pause/reduce-budget intents; pass `alertId: params.id ?? null`. Leave `snooze_alert` on the existing `client.actions.execute` path (snooze is not a platform action).

- [ ] **Step 4: Verify build + types + the route tests (if any)**

Run: `npm run typecheck && npm run lint && npx vitest run app/lib/actions app/lib/ads app/lib/meta app/lib/google app/lib/tiktok`
Expected: tsc 0, lint 0 errors, all suites green.

- [ ] **Step 5: Manual-contract note**

Add a one-line comment in each route where you wired `executeAction` noting that Google/TikTok execute live only once OAuth has stored credentials (adapter resolves null → a `failed` audit with a clear `last_error`, surfaced in the audit trail).

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.campaigns.tsx app/routes/app.alerts.$id.tsx
git commit -m "routes: execute pause/budget via the real action orchestrator"
```

---

## Task 9: Full gate + PR

- [ ] **Step 1: Full eval pipeline**

```bash
npm run typecheck
npm run lint
npm run build
npx vitest run
```
All green.

- [ ] **Step 2: `/code-review`** on the working tree; resolve blockers.

- [ ] **Step 3: Patch sanity** — `git diff --check`; no stray `console.log`/`.only`/`TODO(me)`.

- [ ] **Step 4: Push + update the PR** (`git push`). Add a Slice 3 summary comment to the PR.

---

## Self-Review Notes

- **Spec coverage (Slice 3 bullets):** pause + cut-budget across all 3 platforms via adapter → Tasks 1–5; `action_audit` pre/post + one-click undo → Tasks 6–8; ownership check before any API call → Task 6 (shop-scoped `ad_campaign_dim` load); idempotency key → Task 6; `action_audit` append-only → Tasks 6–7 (inserts only, undo is a new row, never an update).
- **Type consistency:** `ActionAdapter`/`CampaignActionState`/`ActionError` (Task 1) used in Tasks 2–7. `make<Platform>ActionAdapter` (Tasks 2–4) wrapped by `*ActionAdapterForShop` resolvers, dispatched by `actionAdapterForShop(shopId, platform)` (Task 5), called by `executeAction`/`undoAction` (Tasks 6–7). `ExecuteInput`/`ExecutableKind` (Task 6) used by the routes (Task 8).
- **Parallel-safety:** every new file is outside the OAuth agent's edit set; the only modified files are the two UI routes, which the OAuth agent does not touch. Importing `setCampaignStatus`/`crypto`/`supabase` is read-only (no conflict). **Execute this slice after merging the OAuth branch to remove even the runtime coupling for Google/TikTok credentials.**
- **Pre-state source:** the executor records pre-state from `ad_campaign_dim` (synced by Slice 1) rather than a live `getState`, so undo has a deterministic baseline and we avoid an extra API round-trip; Meta still implements `getState` for completeness, but it is not on the hot path.
- **No migration:** `action_audit`/`action_idempotency`/`undo_token` already exist with RLS.
