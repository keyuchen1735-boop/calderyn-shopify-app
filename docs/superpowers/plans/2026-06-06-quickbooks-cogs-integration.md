# QuickBooks → COGS Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant connect QuickBooks Online so Calderyn pulls each product's purchase cost (by SKU) into `cogs_fact`, feeding the existing margin / break-even grading and `cogs_drift` detector.

**Architecture:** Read-only "pull" integration that clones the existing Google Ads integration shape. OAuth connect (`startOAuth('quickbooks')` → `/auth/quickbooks` callback) stores the rotating QBO **refresh token** (encrypted) in `integration_credentials.access_token_encrypted` — the same column and `encrypt()`/`decrypt()` path Google uses, so **no schema migration is needed**. A daily cron (`/cron.ingest-quickbooks`) exchanges the refresh token for a short-lived access token (persisting the rotated refresh token back), queries Inventory items, matches `Item.Sku → sku_dim.sku`, and time-versions costs into `cogs_fact(source='quickbooks')`.

**Tech Stack:** TypeScript (strict, no `any`), Remix loaders, `@supabase/supabase-js` (service role), Node `crypto`, Vitest. QuickBooks Online OAuth2 + Accounting API v3.

**Spec:** `docs/superpowers/specs/2026-06-06-quickbooks-cogs-integration-design.md`

**Conventions to follow (read before starting):**
- OAuth helper pattern: `app/lib/google/oauth.server.ts` (pure, injected `TokenFetcher`).
- Runtime client + refresh: `app/lib/google/client.server.ts`.
- OAuth callback: `app/routes/auth.google.$.tsx`.
- Cron shape + auth guard: `app/routes/cron.ingest-ads.tsx`, `app/lib/cron-auth.server.ts`.
- Crypto: `app/lib/crypto.server.ts` (`encrypt`/`decrypt`, text format `iv:tag:data`).
- Test fakes: `app/lib/ads/__tests__/registry.test.ts` (`sbReturning`), `app/lib/meta/__tests__/oauth.test.ts`.
- No `any`. Raw API payloads use precise optional-property casts (see `google/client.server.ts:60`).

**Run from repo root.** Tests: `npx vitest run <path>`. Gate: `npm run typecheck`, `npm run lint`, `npm run build`.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/lib/quickbooks/oauth.server.ts` (new) | Pure OAuth helpers: `buildAuthUrl`, `exchangeCodeForToken`, `refreshAccessToken`. |
| `app/lib/quickbooks/ingest.server.ts` (new) | Pure transforms (`parseInventoryItems`, `reconcileCost`) + orchestrator (`syncQuickbooksCogs`). |
| `app/lib/quickbooks/client.server.ts` (new) | `qboApiBase`, `quickbooksClientForShop` — load creds, refresh+persist token, run Items query. |
| `app/routes/auth.quickbooks.$.tsx` (new) | OAuth callback: consume state nonce → exchange code → store creds → mark connected. |
| `app/routes/cron.ingest-quickbooks.tsx` (new) | Daily cron: per connected shop, run `syncQuickbooksCogs`; DLQ + status bookkeeping. |
| `app/lib/calderyn.server.ts` (modify) | Add `quickbooks` branch to `integrations.startOAuth`. |
| `.env.example` (modify) | Document `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV`. |

Tests live in `app/lib/quickbooks/__tests__/` and `app/routes/__tests__/`.

---

## Task 1: OAuth helpers

**Files:**
- Create: `app/lib/quickbooks/oauth.server.ts`
- Test: `app/lib/quickbooks/__tests__/oauth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/quickbooks/__tests__/oauth.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForToken, refreshAccessToken } from "../oauth.server";

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scope, state, response_type", () => {
    const url = buildAuthUrl({ clientId: "cid", redirectUri: "https://x/auth/quickbooks", state: "st" });
    expect(url).toContain("https://appcenter.intuit.com/connect/oauth2?");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fquickbooks");
    expect(url).toContain("scope=com.intuit.quickbooks.accounting");
    expect(url).toContain("state=st");
    expect(url).toContain("response_type=code");
  });
});

describe("exchangeCodeForToken", () => {
  it("parses tokens and sends Basic auth + authorization_code grant", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const res = await exchangeCodeForToken(fetcher, {
      clientId: "cid", clientSecret: "sec", redirectUri: "https://x/auth/quickbooks", code: "abc",
    });
    expect(res).toEqual({ accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000 });
    const [, init] = fetcher.mock.calls[0];
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("cid:sec").toString("base64"));
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code=abc");
  });

  it("throws on an OAuth error", async () => {
    const fetcher = vi.fn().mockResolvedValue({ error: "invalid_grant", error_description: "bad code" });
    await expect(
      exchangeCodeForToken(fetcher, { clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }),
    ).rejects.toThrow(/bad code/);
  });
});

describe("refreshAccessToken", () => {
  it("returns the ROTATED refresh token and uses refresh_token grant", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc2", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const res = await refreshAccessToken(fetcher, { clientId: "c", clientSecret: "s", refreshToken: "ref1" });
    expect(res.accessToken).toBe("acc2");
    expect(res.refreshToken).toBe("ref2");
    const [, init] = fetcher.mock.calls[0];
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=ref1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/quickbooks/__tests__/oauth.test.ts`
Expected: FAIL — cannot resolve `../oauth.server`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/quickbooks/oauth.server.ts`:

```ts
// QuickBooks Online OAuth 2.0 (authorization-code grant).
//
// Mirrors app/lib/google/oauth.server.ts: pure helpers with an injected fetcher
// so URL building and token parsing are unit-testable without network.
//
// QBO access tokens are short-lived (~1h). The refresh token (~100d) ROTATES on
// every exchange — callers MUST persist the returned refresh_token each time, or
// the next refresh fails. See app/lib/quickbooks/client.server.ts.

const AUTH_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type QboTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

// Injected so tests supply fakes; the real caller POSTs to the token endpoint.
export type TokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<QboTokenResponse>;

export type ParsedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  refreshExpiresInSec: number;
};

function basicAuth(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function parseTokens(res: QboTokenResponse): ParsedTokens {
  if (res.error || !res.access_token) {
    throw new Error(
      `QuickBooks OAuth error: ${res.error_description ?? res.error ?? "no access_token returned"}`,
    );
  }
  if (!res.refresh_token) {
    throw new Error("QuickBooks OAuth returned no refresh_token");
  }
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresInSec: res.expires_in ?? 0,
    refreshExpiresInSec: res.x_refresh_token_expires_in ?? 0,
  };
}

async function postToken(
  fetcher: TokenFetcher,
  clientId: string,
  clientSecret: string,
  body: string,
): Promise<ParsedTokens> {
  const res = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(clientId, clientSecret),
    },
    body,
  });
  return parseTokens(res);
}

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<ParsedTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  }).toString();
  return postToken(fetcher, opts.clientId, opts.clientSecret, body);
}

export async function refreshAccessToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<ParsedTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  }).toString();
  return postToken(fetcher, opts.clientId, opts.clientSecret, body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/quickbooks/__tests__/oauth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/quickbooks/oauth.server.ts app/lib/quickbooks/__tests__/oauth.test.ts
git commit -m "lib/quickbooks/oauth: QBO OAuth2 helpers (auth URL, code+refresh exchange)"
```

---

## Task 2: Pure ingest transforms (`parseInventoryItems`, `reconcileCost`)

**Files:**
- Create: `app/lib/quickbooks/ingest.server.ts`
- Test: `app/lib/quickbooks/__tests__/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/quickbooks/__tests__/ingest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseInventoryItems, reconcileCost } from "../ingest.server";

describe("parseInventoryItems", () => {
  it("keeps inventory items with a SKU and positive cost, converting to cents", () => {
    const json = {
      QueryResponse: {
        Item: [
          { Id: "1", Sku: "MUG", PurchaseCost: 8, Type: "Inventory" },
          { Id: "2", Sku: "  TEE  ", PurchaseCost: 3.5, Type: "Inventory" },
        ],
      },
    };
    expect(parseInventoryItems(json)).toEqual([
      { id: "1", sku: "MUG", unitCostCents: 800 },
      { id: "2", sku: "TEE", unitCostCents: 350 },
    ]);
  });

  it("skips items with no SKU, zero/absent cost, or no id", () => {
    const json = {
      QueryResponse: {
        Item: [
          { Id: "1", PurchaseCost: 8 },                       // no Sku
          { Id: "2", Sku: "X", PurchaseCost: 0 },              // zero cost
          { Id: "3", Sku: "Y" },                               // absent cost
          { Sku: "Z", PurchaseCost: 5 },                       // no id
        ],
      },
    };
    expect(parseInventoryItems(json)).toEqual([]);
  });

  it("returns [] when the response shape is empty/unexpected", () => {
    expect(parseInventoryItems({})).toEqual([]);
    expect(parseInventoryItems({ QueryResponse: {} })).toEqual([]);
  });
});

describe("reconcileCost", () => {
  it("inserts when there is no open row", () => {
    expect(reconcileCost(null, 800)).toEqual({ kind: "insert" });
  });
  it("no-ops when the open cost is unchanged", () => {
    expect(reconcileCost({ id: "a", unit_cost_cents: 800 }, 800)).toEqual({ kind: "noop" });
  });
  it("closes the old row and inserts when the cost changed", () => {
    expect(reconcileCost({ id: "a", unit_cost_cents: 800 }, 900)).toEqual({
      kind: "update_then_insert",
      closeId: "a",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/quickbooks/__tests__/ingest.test.ts`
Expected: FAIL — cannot resolve `../ingest.server`.

- [ ] **Step 3: Write the implementation** (pure parts only; orchestrator added in Task 4)

Create `app/lib/quickbooks/ingest.server.ts`:

```ts
// QuickBooks → COGS ingestion.
//
// Pure transforms (parseInventoryItems, reconcileCost) are unit-tested without
// a DB. The orchestrator syncQuickbooksCogs (added below) wires them to Supabase.

export type QboItemCost = { id: string; sku: string; unitCostCents: number };

// Loose shape of the QBO Item query payload (raw-API-payload exception to
// no-`any`: precise optionals, never `any`).
type RawItem = { Id?: string; Sku?: string; PurchaseCost?: number; Type?: string };
type ItemsQueryResponse = { QueryResponse?: { Item?: RawItem[] } };

/** Extract inventory item costs, dropping anything without a SKU + positive cost. */
export function parseInventoryItems(json: unknown): QboItemCost[] {
  const items = (json as ItemsQueryResponse)?.QueryResponse?.Item ?? [];
  const out: QboItemCost[] = [];
  for (const it of items) {
    const sku = (it.Sku ?? "").trim();
    const cost = typeof it.PurchaseCost === "number" ? it.PurchaseCost : 0;
    if (!it.Id || !sku || cost <= 0) continue;
    out.push({ id: String(it.Id), sku, unitCostCents: Math.round(cost * 100) });
  }
  return out;
}

export type CostAction =
  | { kind: "noop" }
  | { kind: "insert" }
  | { kind: "update_then_insert"; closeId: string };

/** Decide how to fold an incoming cost into the current open cogs_fact row. */
export function reconcileCost(
  existingOpen: { id: string; unit_cost_cents: number } | null,
  incomingCents: number,
): CostAction {
  if (!existingOpen) return { kind: "insert" };
  if (existingOpen.unit_cost_cents === incomingCents) return { kind: "noop" };
  return { kind: "update_then_insert", closeId: existingOpen.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/quickbooks/__tests__/ingest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/quickbooks/ingest.server.ts app/lib/quickbooks/__tests__/ingest.test.ts
git commit -m "lib/quickbooks/ingest: pure item-cost parse + cogs reconcile"
```

---

## Task 3: QBO client (`qboApiBase`, `quickbooksClientForShop`)

**Files:**
- Create: `app/lib/quickbooks/client.server.ts`
- Test: `app/lib/quickbooks/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/quickbooks/__tests__/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { qboApiBase, quickbooksClientForShop } from "../client.server";
import { encrypt, decrypt } from "../../crypto.server";

// 32-byte key as 64 hex chars, required by crypto.server.
process.env.INTEGRATION_ENCRYPTION_KEY = "11".repeat(32);
process.env.QBO_CLIENT_ID = "cid";
process.env.QBO_CLIENT_SECRET = "sec";
process.env.QBO_ENV = "sandbox";

describe("qboApiBase", () => {
  it("selects production vs sandbox base", () => {
    expect(qboApiBase("production")).toBe("https://quickbooks.api.intuit.com");
    expect(qboApiBase("sandbox")).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(qboApiBase(undefined)).toBe("https://sandbox-quickbooks.api.intuit.com");
  });
});

// Minimal Supabase fake: records the update() patch and returns one credential row.
function fakeSb(credRow: Record<string, unknown> | null) {
  const updatePatch: { value: Record<string, unknown> | null } = { value: null };
  const credChain = {
    select: vi.fn(() => credChain),
    eq: vi.fn(() => credChain),
    maybeSingle: vi.fn(async () => ({ data: credRow, error: null })),
    update: vi.fn((patch: Record<string, unknown>) => {
      updatePatch.value = patch;
      return { eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) };
    }),
  };
  const sb = { from: vi.fn(() => credChain) } as unknown as SupabaseClient;
  return { sb, updatePatch };
}

describe("quickbooksClientForShop", () => {
  it("returns null when there is no credential row", async () => {
    const { sb } = fakeSb(null);
    expect(await quickbooksClientForShop("s1", { sb })).toBeNull();
  });

  it("refreshes, persists the ROTATED refresh token, and exposes a working queryItems", async () => {
    const { sb, updatePatch } = fakeSb({
      access_token_encrypted: encrypt("ref1"),
      external_account_id: "realm-9",
    });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const httpFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ QueryResponse: { Item: [{ Id: "1", Sku: "MUG", PurchaseCost: 8 }] } }),
    });

    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    expect(conn).not.toBeNull();
    expect(conn!.realmId).toBe("realm-9");

    // Rotated refresh token persisted (encrypted).
    expect(updatePatch.value).not.toBeNull();
    expect(decrypt(updatePatch.value!.access_token_encrypted as string)).toBe("ref2");

    const items = await conn!.client.queryItems();
    expect(items).toEqual({ QueryResponse: { Item: [{ Id: "1", Sku: "MUG", PurchaseCost: 8 }] } });
    const calledUrl = httpFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v3/company/realm-9/query");
    expect((httpFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer acc");
  });

  it("throws when the QBO query returns a non-ok status", async () => {
    const { sb } = fakeSb({ access_token_encrypted: encrypt("ref1"), external_account_id: "realm-9" });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const httpFetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ Fault: { Error: [{ Message: "AuthenticationFailed" }] } }),
    });
    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    await expect(conn!.client.queryItems()).rejects.toThrow(/AuthenticationFailed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/quickbooks/__tests__/client.test.ts`
Expected: FAIL — cannot resolve `../client.server`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/quickbooks/client.server.ts`:

```ts
// QuickBooks Online API client (clone of app/lib/google/client.server.ts).
//
// Loads the shop's stored QBO refresh token, exchanges it for a short-lived
// access token, PERSISTS the rotated refresh token back (QBO invalidates the old
// one on each exchange), then runs the Inventory items query. Returns null when
// there is no usable credential row — never a fake token.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import { encrypt, decrypt } from "../crypto.server";
import { refreshAccessToken, type QboTokenResponse, type TokenFetcher } from "./oauth.server";

const PROD_BASE = "https://quickbooks.api.intuit.com";
const SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";

// Inventory items only — the cost source. MAXRESULTS 1000 covers typical SMB
// catalogs in one page; pagination is a follow-up if a shop exceeds it.
const ITEMS_QUERY =
  "SELECT Id, Name, Sku, PurchaseCost, Type FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000";

export function qboApiBase(env: string | undefined): string {
  return env === "production" ? PROD_BASE : SANDBOX_BASE;
}

export type QboClient = { queryItems(): Promise<unknown> };
export type QboConnection = { client: QboClient; realmId: string };

type CredentialRow = { access_token_encrypted: string | null; external_account_id: string | null };
type QboFaultBody = { Fault?: { Error?: Array<{ Message?: string }> } };

const realTokenFetcher: TokenFetcher = async (url, init) =>
  (await fetch(url, init)).json() as Promise<QboTokenResponse>;

export async function quickbooksClientForShop(
  shopId: string,
  deps: { sb?: SupabaseClient; fetcher?: TokenFetcher; httpFetch?: typeof fetch } = {},
): Promise<QboConnection | null> {
  const sb = deps.sb ?? getSupabase();
  const fetcher = deps.fetcher ?? realTokenFetcher;
  const httpFetch = deps.httpFetch ?? fetch;

  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set");
  }

  const { data, error } = await sb
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "quickbooks")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as CredentialRow;
  if (!row.access_token_encrypted || !row.external_account_id) return null;

  const storedRefresh = decrypt(row.access_token_encrypted);
  const tok = await refreshAccessToken(fetcher, { clientId, clientSecret, refreshToken: storedRefresh });

  // Persist the rotated refresh token immediately — the old one is now dead.
  const now = new Date().toISOString();
  const refreshExpiresAt = tok.refreshExpiresInSec
    ? new Date(Date.now() + tok.refreshExpiresInSec * 1000).toISOString()
    : null;
  const upd = await sb
    .from("integration_credentials")
    .update({
      access_token_encrypted: encrypt(tok.refreshToken),
      token_expires_at: refreshExpiresAt,
      updated_at: now,
    })
    .eq("shop_id", shopId)
    .eq("kind", "quickbooks");
  if (upd.error) throw upd.error;

  const base = qboApiBase(process.env.QBO_ENV);
  const realmId = row.external_account_id;
  const client: QboClient = {
    async queryItems(): Promise<unknown> {
      const u = `${base}/v3/company/${realmId}/query?query=${encodeURIComponent(ITEMS_QUERY)}&minorversion=65`;
      const res = await httpFetch(u, {
        headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" },
      });
      const json = (await res.json()) as unknown;
      if (!res.ok) {
        const msg = (json as QboFaultBody)?.Fault?.Error?.[0]?.Message;
        throw new Error(`QuickBooks API error: ${msg ?? `HTTP ${res.status}`}`);
      }
      return json;
    },
  };
  return { client, realmId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/quickbooks/__tests__/client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/quickbooks/client.server.ts app/lib/quickbooks/__tests__/client.test.ts
git commit -m "lib/quickbooks/client: refresh+persist token, Items query"
```

---

## Task 4: Sync orchestrator (`syncQuickbooksCogs`)

**Files:**
- Modify: `app/lib/quickbooks/ingest.server.ts` (append orchestrator)
- Test: `app/lib/quickbooks/__tests__/sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/quickbooks/__tests__/sync.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncQuickbooksCogs } from "../ingest.server";
import type { QboConnection } from "../client.server";

// Scripted Supabase fake. Tracks inserts/updates per table and serves canned
// reads for sku_dim (one .eq) and cogs_fact (.eq.eq.is.maybeSingle).
function makeSb(opts: {
  skuRows: Array<{ id: string; sku: string }>;
  openCostBySku: Record<string, { id: string; unit_cost_cents: number } | null>;
}) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {};
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  let currentSkuId = "";

  const sb = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.insert = (rows: Record<string, unknown>) => {
        (inserts[table] ??= []).push(rows);
        return Promise.resolve({ error: null });
      };
      chain.update = (patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.then = (r: (v: { error: null }) => unknown) => r({ error: null });
        return u;
      };
      chain.select = () => chain;
      chain.is = () => chain;
      chain.eq = (col: string, val: string) => {
        if (table === "cogs_fact" && col === "sku_id") currentSkuId = val;
        return chain;
      };
      chain.maybeSingle = () => {
        // only cogs_fact reaches maybeSingle here
        const skuRow = opts.skuRows.find((r) => r.id === currentSkuId);
        const open = skuRow ? opts.openCostBySku[skuRow.sku] ?? null : null;
        return Promise.resolve({ data: open, error: null });
      };
      // awaiting the sku_dim select chain resolves the rows
      chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: table === "sku_dim" ? opts.skuRows : [], error: null });
      return chain;
    },
  } as unknown as SupabaseClient;

  return { sb, inserts, updates };
}

function conn(items: unknown): QboConnection {
  return { realmId: "r", client: { queryItems: vi.fn(async () => items) } };
}

const itemsPayload = (rows: Array<{ Id: string; Sku: string; PurchaseCost: number }>) => ({
  QueryResponse: { Item: rows.map((r) => ({ ...r, Type: "Inventory" })) },
});

describe("syncQuickbooksCogs", () => {
  it("inserts a new cogs_fact for a matched SKU and archives the raw payload", async () => {
    const { sb, inserts } = makeSb({ skuRows: [{ id: "sku-1", sku: "MUG" }], openCostBySku: {} });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "MUG", PurchaseCost: 8 }])), sb);
    expect(counts).toMatchObject({ matched: 1, inserted: 1, unchanged: 0, updated: 0, skippedNoMatch: 0 });
    expect(inserts["raw_quickbooks_poll"]).toHaveLength(1);
    expect(inserts["cogs_fact"][0]).toMatchObject({
      shop_id: "shop-1", sku_id: "sku-1", unit_cost_cents: 800, source: "quickbooks", source_ref: "1",
    });
  });

  it("no-ops when the open cost is unchanged", async () => {
    const { sb, inserts } = makeSb({
      skuRows: [{ id: "sku-1", sku: "MUG" }],
      openCostBySku: { MUG: { id: "old", unit_cost_cents: 800 } },
    });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "MUG", PurchaseCost: 8 }])), sb);
    expect(counts).toMatchObject({ matched: 1, inserted: 0, unchanged: 1, updated: 0 });
    expect(inserts["cogs_fact"]).toBeUndefined();
  });

  it("closes the old row and inserts a new one when the cost changes", async () => {
    const { sb, inserts, updates } = makeSb({
      skuRows: [{ id: "sku-1", sku: "MUG" }],
      openCostBySku: { MUG: { id: "old", unit_cost_cents: 800 } },
    });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "MUG", PurchaseCost: 9 }])), sb);
    expect(counts).toMatchObject({ matched: 1, updated: 1, inserted: 0 });
    expect(updates.some((u) => u.table === "cogs_fact" && u.patch.effective_to)).toBe(true);
    expect(inserts["cogs_fact"][0]).toMatchObject({ unit_cost_cents: 900 });
  });

  it("counts items whose SKU has no sku_dim match as skippedNoMatch", async () => {
    const { sb, inserts } = makeSb({ skuRows: [], openCostBySku: {} });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "GHOST", PurchaseCost: 8 }])), sb);
    expect(counts).toMatchObject({ matched: 0, skippedNoMatch: 1, inserted: 0 });
    expect(inserts["cogs_fact"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/quickbooks/__tests__/sync.test.ts`
Expected: FAIL — `syncQuickbooksCogs` not exported.

- [ ] **Step 3: Write the implementation** (append to `app/lib/quickbooks/ingest.server.ts`)

Add these imports at the top of the file (below the existing header comment):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QboConnection } from "./client.server";
```

Append at the end of the file:

```ts
export interface QbSyncCounts {
  matched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedNoMatch: number;
}

/**
 * Pull current inventory item costs from QuickBooks and time-version them into
 * cogs_fact(source='quickbooks') for one shop. Idempotent: unchanged costs are
 * no-ops; a changed cost closes the prior open row and opens a new one.
 */
export async function syncQuickbooksCogs(
  shopId: string,
  conn: QboConnection,
  sb: SupabaseClient,
): Promise<QbSyncCounts> {
  const raw = await conn.client.queryItems();
  const rawIns = await sb
    .from("raw_quickbooks_poll")
    .insert({ shop_id: shopId, poll_kind: "items", payload: raw as object, polled_at: new Date().toISOString() });
  if (rawIns.error) throw rawIns.error;

  const items = parseInventoryItems(raw);

  const { data: skuRows, error: skuErr } = await sb.from("sku_dim").select("id, sku").eq("shop_id", shopId);
  if (skuErr) throw skuErr;
  const skuToId = new Map<string, string>();
  for (const r of (skuRows ?? []) as Array<{ id: string; sku: string | null }>) {
    if (r.sku) skuToId.set(r.sku, r.id);
  }

  const counts: QbSyncCounts = { matched: 0, inserted: 0, updated: 0, unchanged: 0, skippedNoMatch: 0 };
  const now = new Date().toISOString();

  for (const item of items) {
    const skuId = skuToId.get(item.sku);
    if (!skuId) {
      counts.skippedNoMatch++;
      continue;
    }
    counts.matched++;

    const { data: openRow, error: openErr } = await sb
      .from("cogs_fact")
      .select("id, unit_cost_cents")
      .eq("sku_id", skuId)
      .eq("source", "quickbooks")
      .is("effective_to", null)
      .maybeSingle();
    if (openErr) throw openErr;

    const action = reconcileCost(
      (openRow as { id: string; unit_cost_cents: number } | null) ?? null,
      item.unitCostCents,
    );
    if (action.kind === "noop") {
      counts.unchanged++;
      continue;
    }
    if (action.kind === "update_then_insert") {
      const close = await sb.from("cogs_fact").update({ effective_to: now }).eq("id", action.closeId);
      if (close.error) throw close.error;
      counts.updated++;
    } else {
      counts.inserted++;
    }
    const ins = await sb.from("cogs_fact").insert({
      shop_id: shopId,
      sku_id: skuId,
      unit_cost_cents: item.unitCostCents,
      effective_from: now,
      source: "quickbooks",
      source_ref: item.id,
    });
    if (ins.error) throw ins.error;
  }
  return counts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/quickbooks/__tests__/sync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/quickbooks/ingest.server.ts app/lib/quickbooks/__tests__/sync.test.ts
git commit -m "lib/quickbooks/ingest: syncQuickbooksCogs orchestrator (raw archive + cogs upsert)"
```

---

## Task 5: Wire `startOAuth('quickbooks')`

**Files:**
- Modify: `app/lib/calderyn.server.ts` (import + new branch in `integrations.startOAuth`)
- Test: `app/lib/quickbooks/__tests__/oauth.test.ts` already covers `buildAuthUrl`; no new unit test (branch is exercised at runtime + typecheck). Manual verification in Step 4.

- [ ] **Step 1: Add the import**

In `app/lib/calderyn.server.ts`, after line 17 (`import { buildAuthUrl as buildTikTokAuthUrl } from "./tiktok/oauth.server";`), add:

```ts
import { buildAuthUrl as buildQuickbooksAuthUrl } from "./quickbooks/oauth.server";
```

- [ ] **Step 2: Add the branch**

In `integrations.startOAuth`, immediately BEFORE the final `throw new CalderynError({ code: "OAUTH_NOT_WIRED", ... })` (currently at `app/lib/calderyn.server.ts:685`), insert:

```ts
        if (provider === "quickbooks") {
          const clientId = process.env.QBO_CLIENT_ID;
          const clientSecret = process.env.QBO_CLIENT_SECRET;
          const appUrl = process.env.SHOPIFY_APP_URL;
          if (!clientId || !clientSecret || !appUrl) {
            throw new CalderynError({
              code: "QUICKBOOKS_NOT_CONFIGURED",
              status: 500,
              message:
                "QuickBooks OAuth is not configured (QBO_CLIENT_ID/QBO_CLIENT_SECRET/SHOPIFY_APP_URL).",
            });
          }
          const redirectUri = `${appUrl}/auth/quickbooks`;
          // Same single-use nonce pattern as Meta/Google; consumed once at /auth/quickbooks.
          const shopId = await shopIdP;
          const state = await createOAuthState(supabase, shopId);
          return { redirectUrl: buildQuickbooksAuthUrl({ clientId, redirectUri, state }) };
        }
```

(`clientSecret` is read here only to fail fast with a clear error if the app is
half-configured — it is not placed in the URL.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Run the quickbooks lib tests (regression)**

Run: `npx vitest run app/lib/quickbooks`
Expected: PASS (all tasks 1–4 still green).

- [ ] **Step 5: Commit**

```bash
git add app/lib/calderyn.server.ts
git commit -m "lib/calderyn: wire startOAuth('quickbooks') to QBO consent URL"
```

---

## Task 6: OAuth callback route `/auth/quickbooks`

**Files:**
- Create: `app/routes/auth.quickbooks.$.tsx`
- Test: `app/routes/__tests__/auth-quickbooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/routes/__tests__/auth-quickbooks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock collaborators so the loader can run without network/db.
const consumeOAuthState = vi.fn();
const exchangeCodeForToken = vi.fn();
const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("~/lib/meta/oauth-state.server", () => ({ consumeOAuthState: (...a: unknown[]) => consumeOAuthState(...a) }));
vi.mock("~/lib/quickbooks/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => {
        upsertCalls.push({ table, row });
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));
vi.mock("~/lib/crypto.server", () => ({ encrypt: (s: string) => `enc(${s})` }));

import { loader } from "../auth.quickbooks.$";

beforeEach(() => {
  upsertCalls.length = 0;
  consumeOAuthState.mockReset();
  exchangeCodeForToken.mockReset();
  process.env.QBO_CLIENT_ID = "cid";
  process.env.QBO_CLIENT_SECRET = "sec";
  process.env.SHOPIFY_APP_URL = "https://app.example";
});

function req(qs: string) {
  return { request: new Request(`https://app.example/auth/quickbooks?${qs}`) } as Parameters<typeof loader>[0];
}

describe("auth.quickbooks loader", () => {
  it("rejects an invalid/expired state nonce", async () => {
    consumeOAuthState.mockResolvedValue(null);
    await expect(loader(req("code=abc&state=bad&realmId=9"))).rejects.toMatchObject({ status: 400 });
  });

  it("stores the encrypted refresh token + realmId and redirects to settings", async () => {
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000,
    });
    const res = await loader(req("code=abc&state=ok&realmId=realm-9"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/settings?quickbooks=connected");

    const cred = upsertCalls.find((c) => c.table === "integration_credentials")!;
    expect(cred.row).toMatchObject({
      shop_id: "shop-1", kind: "quickbooks", access_token_encrypted: "enc(ref)", external_account_id: "realm-9",
    });
    const integ = upsertCalls.find((c) => c.table === "shop_integrations")!;
    expect(integ.row).toMatchObject({ shop_id: "shop-1", kind: "quickbooks", sync_status: "ready" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/auth-quickbooks.test.ts`
Expected: FAIL — cannot resolve `../auth.quickbooks.$`.

- [ ] **Step 3: Write the implementation**

Create `app/routes/auth.quickbooks.$.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { exchangeCodeForToken } from "~/lib/quickbooks/oauth.server";
import { consumeOAuthState } from "~/lib/meta/oauth-state.server";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";

// QuickBooks Online OAuth callback. Mirrors app/routes/auth.google.$.tsx:
//   1. consume the single-use `state` nonce (CSRF + resolves the shop),
//   2. exchange the code for { access, refresh } tokens,
//   3. store the ENCRYPTED refresh token in integration_credentials
//      (access_token_encrypted column, Google precedent) + realmId, and
//   4. upsert shop_integrations(kind='quickbooks', sync_status='ready') so
//      cron.ingest-quickbooks picks the shop up on its next tick.
//
// No authenticate.admin: the redirect arrives from Intuit's domain without the
// embedded session, so the single-use nonce is the authenticator.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const oauthError = url.searchParams.get("error");
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (oauthError) {
    return redirect(`/app/settings?quickbooks=error&reason=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state || !realmId || !clientId || !clientSecret || !appUrl) {
    throw new Response("Missing OAuth parameters", { status: 400 });
  }

  const sb = getSupabase();
  const shopId = await consumeOAuthState(sb, state);
  if (!shopId) throw new Response("Invalid or expired OAuth state", { status: 400 });

  const fetcher = async (
    u: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
  ) => (await fetch(u, init)).json();

  const tok = await exchangeCodeForToken(fetcher, {
    clientId,
    clientSecret,
    redirectUri: `${appUrl}/auth/quickbooks`,
    code,
  });

  const now = new Date().toISOString();
  const refreshExpiresAt = tok.refreshExpiresInSec
    ? new Date(Date.now() + tok.refreshExpiresInSec * 1000).toISOString()
    : null;

  // Store the rotating REFRESH token (encrypted) in access_token_encrypted —
  // same column/path Google uses. The access token is re-derived each cron run.
  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "quickbooks",
      access_token_encrypted: encrypt(tok.refreshToken),
      token_expires_at: refreshExpiresAt,
      external_account_id: realmId,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "quickbooks",
      sync_status: "ready",
      external_account_id: realmId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  return redirect("/app/settings?quickbooks=connected");
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/auth-quickbooks.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/routes/auth.quickbooks.$.tsx app/routes/__tests__/auth-quickbooks.test.ts
git commit -m "routes/auth.quickbooks: QBO OAuth callback stores refresh token + realmId"
```

---

## Task 7: Daily cron `/cron.ingest-quickbooks`

**Files:**
- Create: `app/routes/cron.ingest-quickbooks.tsx`
- Test: `app/routes/__tests__/cron.ingest-quickbooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/routes/__tests__/cron.ingest-quickbooks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const listShopIntegrations = vi.fn();
const quickbooksClientForShop = vi.fn();
const syncQuickbooksCogs = vi.fn();
const statusPatches: Array<{ patch: Record<string, unknown> }> = [];
const dlqInserts: Array<Record<string, unknown>> = [];

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "shop_integrations") {
        return {
          select: () => ({ in: () => ({ in: async () => ({ data: listShopIntegrations(), error: null }) }) }),
          update: (patch: Record<string, unknown>) => {
            statusPatches.push({ patch });
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      if (table === "ingestion_dlq") {
        return { insert: (row: Record<string, unknown>) => { dlqInserts.push(row); return Promise.resolve({ error: null }); } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock("~/lib/quickbooks/client.server", () => ({
  quickbooksClientForShop: (...a: unknown[]) => quickbooksClientForShop(...a),
}));
vi.mock("~/lib/quickbooks/ingest.server", () => ({
  syncQuickbooksCogs: (...a: unknown[]) => syncQuickbooksCogs(...a),
}));

import { loader } from "../cron.ingest-quickbooks";

beforeEach(() => {
  statusPatches.length = 0;
  dlqInserts.length = 0;
  listShopIntegrations.mockReset();
  quickbooksClientForShop.mockReset();
  syncQuickbooksCogs.mockReset();
  process.env.CRON_SECRET = "s3cret";
});

function req(auth?: string) {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return { request: new Request("https://app.example/cron.ingest-quickbooks", { headers }) } as Parameters<typeof loader>[0];
}

describe("cron.ingest-quickbooks", () => {
  it("rejects without the cron bearer", async () => {
    const res = await loader(req());
    expect(res.status).toBe(401);
  });

  it("syncs each connected shop and reports counts", async () => {
    listShopIntegrations.mockReturnValue([{ shop_id: "shop-1" }]);
    quickbooksClientForShop.mockResolvedValue({ realmId: "r", client: { queryItems: vi.fn() } });
    syncQuickbooksCogs.mockResolvedValue({ matched: 2, inserted: 1, updated: 1, unchanged: 0, skippedNoMatch: 0 });

    const res = await loader(req("Bearer s3cret"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.synced).toContainEqual(expect.objectContaining({ shopId: "shop-1", inserted: 1, updated: 1 }));
    expect(statusPatches.some((p) => p.patch.sync_status === "live")).toBe(true);
    expect(dlqInserts).toHaveLength(0);
  });

  it("records a DLQ row + error status when a shop sync throws", async () => {
    listShopIntegrations.mockReturnValue([{ shop_id: "shop-1" }]);
    quickbooksClientForShop.mockResolvedValue({ realmId: "r", client: { queryItems: vi.fn() } });
    syncQuickbooksCogs.mockRejectedValue(new Error("boom"));

    const res = await loader(req("Bearer s3cret"));
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(dlqInserts[0]).toMatchObject({ shop_id: "shop-1", connector: "quickbooks" });
    expect(statusPatches.some((p) => p.patch.sync_status === "error")).toBe(true);
  });

  it("skips shops with no usable credential (client is null)", async () => {
    listShopIntegrations.mockReturnValue([{ shop_id: "shop-1" }]);
    quickbooksClientForShop.mockResolvedValue(null);
    const res = await loader(req("Bearer s3cret"));
    const body = await res.json();
    expect(body.skipped).toContain("shop-1");
    expect(syncQuickbooksCogs).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.ingest-quickbooks.test.ts`
Expected: FAIL — cannot resolve `../cron.ingest-quickbooks`.

- [ ] **Step 3: Write the implementation**

Create `app/routes/cron.ingest-quickbooks.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { quickbooksClientForShop } from "~/lib/quickbooks/client.server";
import { syncQuickbooksCogs, type QbSyncCounts } from "~/lib/quickbooks/ingest.server";

async function setSync(shopId: string, patch: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("shop_integrations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("kind", "quickbooks");
}

async function toDlq(shopId: string, err: unknown): Promise<void> {
  const sb = getSupabase();
  const message = err instanceof Error ? err.message : String(err);
  const errorKind = /auth|token|401/i.test(message) ? "auth_expired" : "unknown";
  await sb.from("ingestion_dlq").insert({
    shop_id: shopId,
    connector: "quickbooks",
    job_kind: "items_poll",
    attempts: 1,
    error_kind: errorKind,
    error_message: message.slice(0, 500),
    payload: {},
  });
}

interface Summary {
  synced: Array<{ shopId: string } & QbSyncCounts>;
  skipped: string[];
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .in("kind", ["quickbooks"])
    .in("sync_status", ["ready", "live"]);
  if (error) throw error;

  const summary: Summary = { synced: [], skipped: [], errors: [] };

  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    const shopId = String(row.shop_id);
    try {
      const conn = await quickbooksClientForShop(shopId);
      if (!conn) {
        summary.skipped.push(shopId);
        continue;
      }
      const counts = await syncQuickbooksCogs(shopId, conn, sb);
      await setSync(shopId, { sync_status: "live", sync_error: null, last_sync_at: new Date().toISOString() });
      summary.synced.push({ shopId, ...counts });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSync(shopId, { sync_status: "error", sync_error: message.slice(0, 500) });
      await toDlq(shopId, err);
      summary.errors.push(`${shopId}: ${message}`);
      console.error(`[cron.ingest-quickbooks] sync failed for ${shopId}`, err);
    }
  }

  return json(summary);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/cron.ingest-quickbooks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.ingest-quickbooks.tsx app/routes/__tests__/cron.ingest-quickbooks.test.ts
git commit -m "routes/cron.ingest-quickbooks: daily COGS sync per connected shop + DLQ"
```

---

## Task 8: Document env vars + schedule the cron

**Files:**
- Modify: `.env.example`
- Modify: `vercel.json` (only if it defines a `crons` array — see Step 2)

- [ ] **Step 1: Add env keys to `.env.example`**

Append to `.env.example` (match the file's existing formatting/comment style):

```
# QuickBooks Online (COGS integration). Secrets live in .env.local, never here.
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
# sandbox | production — selects the QBO API base host
QBO_ENV=sandbox
```

- [ ] **Step 2: Register the daily cron (Vercel)**

Check whether `vercel.json` exists at the repo root and contains a `"crons"` array (the ad cron `/cron.ingest-ads` is the reference).

Run: `node -e "try{const c=require('./vercel.json');console.log(JSON.stringify(c.crons||'NONE'))}catch(e){console.log('NO vercel.json')}"`

- If a `crons` array exists, add an entry mirroring the ads cron's cadence:

```json
{ "path": "/cron.ingest-quickbooks", "schedule": "0 5 * * *" }
```

- If there is no `vercel.json` / `crons` array, the project schedules crons elsewhere (e.g. dashboard). Do **not** invent a config file — note in the commit message that the cron must be registered wherever `/cron.ingest-ads` is registered, and skip the file edit.

- [ ] **Step 3: Typecheck + full quickbooks/route test sweep**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npx vitest run app/lib/quickbooks app/routes/__tests__/auth-quickbooks.test.ts app/routes/__tests__/cron.ingest-quickbooks.test.ts`
Expected: PASS (all).

- [ ] **Step 4: Commit**

```bash
git add .env.example vercel.json
git commit -m "config/quickbooks: document QBO_* env vars + schedule daily COGS cron"
```

(If `vercel.json` was not changed, `git add` it harmlessly skips — only `.env.example` is committed.)

---

## Task 9: Pre-commit gate (MANDATORY — CLAUDE.md)

**No code changes — verification only. Paste real output; do not assert success without evidence.**

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: all suites PASS (including the 5 new quickbooks/route test files).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Lint (no warnings on touched files)**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Remix + Vite build completes, exit 0.

- [ ] **Step 5: Patch sanity**

Run: `git diff --stat main...HEAD` and `git diff --check main...HEAD`
Expected: clean; no stray `console.log` (the single `console.error` in the cron is intentional, matching `cron.ingest-ads.tsx`), no `.only`, no `TODO(me)`, no commented-out blocks.

- [ ] **Step 6: `/code-review`**

Run the `/code-review` slash command on the working tree / branch. Resolve every blocker; downgrade any nit explicitly with a one-line justification.

- [ ] **Step 7: Run graphify update**

Run: `graphify update .`
(Keeps the knowledge graph current after the new modules — AST-only, no API cost.)

---

## Manual verification (post-merge, needs real QBO sandbox)

Not part of the automated gate; do once credentials exist:

1. Set `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` in `.env.local`, `QBO_ENV=sandbox`.
2. In Settings, click **Connect QuickBooks** → complete Intuit sandbox consent → expect redirect to `/app/settings?quickbooks=connected` and the card showing **Connected**.
3. Hit `/cron.ingest-quickbooks` with the `Bearer $CRON_SECRET` header → expect a JSON summary with non-zero `matched`/`inserted` for SKUs that exist in both QuickBooks and `sku_dim`.
4. Confirm a `cogs_fact` row with `source='quickbooks'` exists for a matched SKU (Supabase MCP query).
5. Re-run the cron → expect `unchanged` to rise and no new `cogs_fact` rows (idempotent).

---

## Self-Review

**Spec coverage:**
- §4 components → Tasks 1 (oauth), 3 (client), 2+4 (ingest), 6 (callback), 7 (cron), 5 (startOAuth). ✓
- §5 data flow (connect → store refresh in access_token_encrypted → daily refresh+persist → query → match → cogs_fact time-versioning) → Tasks 6, 3, 4. ✓
- §6 no schema change → honored; no migration task exists. ✓
- §7 error handling: auth_expired vs unknown DLQ classification → Task 7 `toDlq`; skip-no-match counted → Task 4; non-ok API throws → Task 3. ✓
- §8 testing: oauth rotation, ingest parse/reconcile/orchestrator, cron → Tasks 1,2,3,4,7. ✓
- §2 success criteria 1–6 → Tasks 4 (cogs_fact shape, idempotent, history), 6 (Connected status), 7 (DLQ, skip counts). ✓
- §3 non-goals (no push, no currency conversion) → nothing in plan builds them. ✓

**Placeholder scan:** none — every code/test step contains complete content.

**Type consistency:** `ParsedTokens` (Task 1) consumed by `client.server.ts` (Task 3) and `auth.quickbooks.$.tsx` (Task 6) via the `{ accessToken, refreshToken, expiresInSec, refreshExpiresInSec }` shape. `QboConnection` (Task 3) consumed by `syncQuickbooksCogs` (Task 4) and the cron (Task 7). `QbSyncCounts` (Task 4) consumed by the cron summary (Task 7). `parseInventoryItems`/`reconcileCost` (Task 2) consumed by Task 4. Consistent. ✓
