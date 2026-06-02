# Meta Campaign Actions (Slice A — pause/resume) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant connects Meta via OAuth, sees their live Meta campaigns on the Campaigns page, and Pause/Resume makes a real Marketing API call that pauses/resumes the campaign, records true pre/post status in the audit log, and is reversible via Undo.

**Architecture:** Mirror the existing real-external-action seam (`app/lib/shopify/inventory.server.ts`). A Meta client module takes an injected HTTP client so request-shape and error handling are unit-tested with a fake. OAuth stores a long-lived token, encrypted (AES-256-GCM), in a new Supabase `integration_credentials` table. The Campaigns route live-fetches campaigns and the pause/resume branch calls the tested module — exactly how `reallocate_inventory` calls `inventoryAdjustQuantities`.

**Tech Stack:** Remix (Vite), `@shopify/shopify-app-remix`, `@supabase/supabase-js` (service role), Node `crypto`, Meta Graph API `v21.0`, Vitest, Supabase migrations.

**Spec:** `docs/superpowers/specs/2026-06-01-meta-campaign-actions-design.md`

**Confirmed facts:**
- The action framework is real: `actions.execute` (idempotent, writes `action_audit` + `action_idempotency`), `audit.undo`, in `app/lib/calderyn.server.ts`.
- `reallocate_inventory` already calls a real external API via `inventoryAdjustQuantities(admin, …)` and is wired in `app/routes/app.alerts.$id.tsx`.
- `integrations.startOAuth("meta")` currently throws `OAUTH_NOT_WIRED` (calderyn.server.ts ~L463); `integrations.list` already maps `meta_ads` → "connected" when `shop_integrations.sync_status` is `ready`/`ok`.
- `dollar_impact*` columns store dollars. Enums include `integration_kind = {shopify,meta_ads,google_ads,quickbooks}`.
- Meta App Review is NOT needed for development-mode access to the developer's own ad account.

---

## File Structure

**Create:**
- `supabase/migrations/<ts>_integration_credentials.sql` — encrypted-token table
- `app/lib/crypto.server.ts` — AES-256-GCM encrypt/decrypt
- `app/lib/meta/campaigns.server.ts` — `listCampaigns`, `setCampaignStatus` (injected client)
- `app/lib/meta/oauth.server.ts` — auth-URL builder, signed `state`, token exchange (injected fetcher)
- `app/lib/meta/client.server.ts` — build an authed Graph client for a shop (load + decrypt token)
- `app/routes/auth.meta.$.tsx` — OAuth callback
- `app/lib/__tests__/crypto.test.ts`
- `app/lib/meta/__tests__/campaigns.test.ts`
- `app/lib/meta/__tests__/oauth.test.ts`

**Modify:**
- `app/lib/calderyn.server.ts` — `integrations.startOAuth` returns the dialog URL; `actions.execute` accepts optional `preState`/`postState`; `audit.undo` re-calls Meta for ad-platform kinds
- `app/routes/app.campaigns.tsx` — loader live-fetches when Meta connected; pause/resume branch calls the Meta module
- `.env.example` — `META_APP_ID`, `META_APP_SECRET`, `INTEGRATION_ENCRYPTION_KEY`

---

## Task 1: Supabase migration — `integration_credentials`

**Note:** Supabase-managed table (not Prisma — `prisma/schema.prisma` only owns `shopify_sessions`). Apply via Supabase tooling. Same CLAUDE.md carve-out as the ingestion spec §10. **Apply (`supabase db push`) is deferred until credentials are available; the file is committed now.**

**Files:**
- Create: `supabase/migrations/<timestamp>_integration_credentials.sql`

- [ ] **Step 1: Create the migration file**

Name it `20260601010000_integration_credentials.sql`:

```sql
-- integration_credentials: encrypted long-lived OAuth tokens for ad-platform
-- integrations (Meta first). Secrets live here, separate from shop_integrations
-- metadata. Token is AES-256-GCM encrypted at rest (app/lib/crypto.server.ts).

create table if not exists public.integration_credentials (
  shop_id uuid not null references shops(id) on delete cascade,
  kind integration_kind not null,
  access_token_encrypted text not null,
  token_expires_at timestamptz,
  external_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind)
);
```

- [ ] **Step 2: Commit (apply deferred)**

```bash
git add supabase/migrations/20260601010000_integration_credentials.sql
git commit -m "feat(db): integration_credentials table for encrypted ad-platform tokens"
```

---

## Task 2: Crypto module (AES-256-GCM)

**Files:**
- Create: `app/lib/crypto.server.ts`
- Create: `app/lib/__tests__/crypto.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/lib/__tests__/crypto.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  // 32-byte key as 64 hex chars
  process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);
});

describe("crypto.server", () => {
  it("round-trips plaintext", async () => {
    const { encrypt, decrypt } = await import("../crypto.server");
    const secret = "EAALongLivedToken123";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces a different ciphertext each call (random IV)", async () => {
    const { encrypt } = await import("../crypto.server");
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("throws on a tampered ciphertext", async () => {
    const { encrypt, decrypt } = await import("../crypto.server");
    const ct = encrypt("secret");
    const tampered = ct.slice(0, -2) + (ct.endsWith("aa") ? "bb" : "aa");
    expect(() => decrypt(tampered)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test app/lib/__tests__/crypto.test.ts`
Expected: FAIL — cannot find module `../crypto.server`.

- [ ] **Step 3: Implement**

`app/lib/crypto.server.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getKey(): Buffer {
  const hex = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be 32 bytes as 64 hex chars");
  }
  return Buffer.from(hex, "hex");
}

// Format: ivHex:tagHex:dataHex
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), data.toString("hex")].join(":");
}

export function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test app/lib/__tests__/crypto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/crypto.server.ts app/lib/__tests__/crypto.test.ts
git commit -m "feat(crypto): AES-256-GCM encrypt/decrypt for integration tokens"
```

---

## Task 3: Meta campaigns client module

Injected client returns parsed Graph JSON; the module checks for a Graph `error`
field and throws (mirrors `inventoryAdjustQuantities` userErrors handling).

**Files:**
- Create: `app/lib/meta/campaigns.server.ts`
- Create: `app/lib/meta/__tests__/campaigns.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/lib/meta/__tests__/campaigns.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { listCampaigns, setCampaignStatus, type MetaClient } from "../campaigns.server";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

describe("listCampaigns", () => {
  it("requests the account campaigns and maps fields", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "120", name: "Prospecting", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "1500" },
        { id: "121", name: "Retarget", status: "PAUSED", effective_status: "PAUSED" },
      ],
    }));
    const client = fakeClient({ get });
    const rows = await listCampaigns(client, "act_99");
    expect(get).toHaveBeenCalledWith("/act_99/campaigns", {
      fields: "id,name,status,effective_status,daily_budget",
    });
    expect(rows).toEqual([
      { id: "120", name: "Prospecting", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 1500 },
      { id: "121", name: "Retarget", status: "PAUSED", effectiveStatus: "PAUSED", dailyBudgetCents: null },
    ]);
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ get: vi.fn(async () => ({ error: { message: "Invalid token", code: 190 } })) });
    await expect(listCampaigns(client, "act_99")).rejects.toThrow(/Invalid token/);
  });
});

describe("setCampaignStatus", () => {
  it("posts the status to the campaign", async () => {
    const post = vi.fn(async () => ({ success: true }));
    await setCampaignStatus(fakeClient({ post }), "120", "PAUSED");
    expect(post).toHaveBeenCalledWith("/120", { status: "PAUSED" });
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ post: vi.fn(async () => ({ error: { message: "Permission denied", code: 200 } })) });
    await expect(setCampaignStatus(client, "120", "ACTIVE")).rejects.toThrow(/Permission denied/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test app/lib/meta/__tests__/campaigns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/lib/meta/campaigns.server.ts`:

```ts
export type MetaResponse = {
  data?: unknown;
  success?: boolean;
  error?: { message: string; code?: number; type?: string; fbtrace_id?: string };
  [k: string]: unknown;
};

export type MetaClient = {
  get(path: string, params?: Record<string, string>): Promise<MetaResponse>;
  post(path: string, body: Record<string, string>): Promise<MetaResponse>;
};

export type MetaCampaign = {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudgetCents: number | null;
};

function check(r: MetaResponse): MetaResponse {
  if (r.error) {
    const code = r.error.code != null ? ` (code ${r.error.code})` : "";
    throw new Error(`Meta API error: ${r.error.message}${code}`);
  }
  return r;
}

type RawCampaign = {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
};

export async function listCampaigns(client: MetaClient, adAccountId: string): Promise<MetaCampaign[]> {
  const body = check(
    await client.get(`/${adAccountId}/campaigns`, {
      fields: "id,name,status,effective_status,daily_budget",
    }),
  );
  const data = (body.data as RawCampaign[]) ?? [];
  return data.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status ?? "UNKNOWN",
    effectiveStatus: c.effective_status ?? c.status ?? "UNKNOWN",
    dailyBudgetCents: c.daily_budget != null ? Number(c.daily_budget) : null,
  }));
}

export async function setCampaignStatus(
  client: MetaClient,
  campaignId: string,
  status: "PAUSED" | "ACTIVE",
): Promise<void> {
  check(await client.post(`/${campaignId}`, { status }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test app/lib/meta/__tests__/campaigns.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/campaigns.server.ts app/lib/meta/__tests__/campaigns.test.ts
git commit -m "feat(meta): campaigns client (list + setStatus) with Graph error handling"
```

---

## Task 4: Meta OAuth module

Pure helpers: build the dialog URL, sign/verify the `state` (carries `shop`,
HMAC-signed because the Meta callback has no Shopify session), and exchange the
auth code for a long-lived token via an injected fetcher.

**Files:**
- Create: `app/lib/meta/oauth.server.ts`
- Create: `app/lib/meta/__tests__/oauth.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/lib/meta/__tests__/oauth.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildAuthUrl, signState, verifyState, exchangeCodeForToken } from "../oauth.server";

const SECRET = "app-secret";

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scope, and state", () => {
    const url = buildAuthUrl({ appId: "111", redirectUri: "https://x/auth/meta", state: "st" });
    expect(url).toContain("https://www.facebook.com/v21.0/dialog/oauth?");
    expect(url).toContain("client_id=111");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fmeta");
    expect(url).toContain("scope=ads_management%2Cads_read");
    expect(url).toContain("state=st");
  });
});

describe("state sign/verify", () => {
  it("round-trips the shop and rejects tampering", () => {
    const st = signState("acme.myshopify.com", SECRET);
    expect(verifyState(st, SECRET)).toBe("acme.myshopify.com");
    expect(verifyState(st + "x", SECRET)).toBeNull();
    expect(verifyState(st, "wrong-secret")).toBeNull();
  });
});

describe("exchangeCodeForToken", () => {
  it("exchanges code then upgrades to a long-lived token", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ access_token: "short", expires_in: 3600 })
      .mockResolvedValueOnce({ access_token: "long", expires_in: 5184000 });
    const res = await exchangeCodeForToken(fetcher, {
      appId: "111",
      appSecret: SECRET,
      redirectUri: "https://x/auth/meta",
      code: "abc",
    });
    expect(res).toEqual({ accessToken: "long", expiresInSec: 5184000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toContain("/oauth/access_token?");
    expect(fetcher.mock.calls[0][0]).toContain("code=abc");
    expect(fetcher.mock.calls[1][0]).toContain("grant_type=fb_exchange_token");
    expect(fetcher.mock.calls[1][0]).toContain("fb_exchange_token=short");
  });

  it("throws on a Graph error during exchange", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ error: { message: "bad code", code: 100 } });
    await expect(
      exchangeCodeForToken(fetcher, { appId: "1", appSecret: SECRET, redirectUri: "r", code: "x" }),
    ).rejects.toThrow(/bad code/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test app/lib/meta/__tests__/oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/lib/meta/oauth.server.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_VERSION = "v21.0";
const SCOPE = "ads_management,ads_read";

export function buildAuthUrl(opts: { appId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.appId,
    redirect_uri: opts.redirectUri,
    scope: SCOPE,
    state: opts.state,
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${p.toString()}`;
}

// state = base64url(shop) + "." + HMAC-SHA256(base64url(shop), secret)
export function signState(shop: string, secret: string): string {
  const payload = Buffer.from(shop, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string, secret: string): string | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(payload, "base64url").toString("utf8");
}

export type GraphTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: { message: string; code?: number };
};
export type TokenFetcher = (url: string) => Promise<GraphTokenResponse>;

function checkToken(r: GraphTokenResponse): GraphTokenResponse {
  if (r.error) throw new Error(`Meta OAuth error: ${r.error.message}`);
  if (!r.access_token) throw new Error("Meta OAuth returned no access_token");
  return r;
}

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: { appId: string; appSecret: string; redirectUri: string; code: string },
): Promise<{ accessToken: string; expiresInSec: number }> {
  const base = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
  const shortUrl =
    `${base}?client_id=${encodeURIComponent(opts.appId)}` +
    `&redirect_uri=${encodeURIComponent(opts.redirectUri)}` +
    `&client_secret=${encodeURIComponent(opts.appSecret)}` +
    `&code=${encodeURIComponent(opts.code)}`;
  const short = checkToken(await fetcher(shortUrl));

  const longUrl =
    `${base}?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(opts.appId)}` +
    `&client_secret=${encodeURIComponent(opts.appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(short.access_token!)}`;
  const long = checkToken(await fetcher(longUrl));

  return { accessToken: long.access_token!, expiresInSec: long.expires_in ?? 0 };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test app/lib/meta/__tests__/oauth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/oauth.server.ts app/lib/meta/__tests__/oauth.test.ts
git commit -m "feat(meta): OAuth helpers (auth URL, signed state, token exchange)"
```

---

## Task 5: Meta Graph client builder

Loads the shop's encrypted credential, decrypts it, and returns a `MetaClient`
that wraps `fetch` against `graph.facebook.com`. IO orchestration over the tested
modules — verified by typecheck/build (matches how the repo treats wiring).

**Files:**
- Create: `app/lib/meta/client.server.ts`

- [ ] **Step 1: Implement**

`app/lib/meta/client.server.ts`:

```ts
import { getSupabase, resolveShopId } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { MetaClient, MetaResponse } from "./campaigns.server";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type MetaConnection = { client: MetaClient; adAccountId: string };

export async function metaClientForShop(shopDomain: string): Promise<MetaConnection | null> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const token = decrypt(data.access_token_encrypted as string);
  const adAccountId = (data.external_account_id as string | null) ?? "";

  const client: MetaClient = {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      const res = await fetch(`${GRAPH_BASE}${path}?${qs}`);
      return (await res.json()) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      return (await res.json()) as MetaResponse;
    },
  };
  return { client, adAccountId };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/meta/client.server.ts
git commit -m "feat(meta): Graph client builder (load + decrypt token, fetch wrapper)"
```

---

## Task 6: Wire `startOAuth` to return the dialog URL

**Files:**
- Modify: `app/lib/calderyn.server.ts`

- [ ] **Step 1: Replace the `meta` branch of `integrations.startOAuth`**

Add imports near the top of `calderyn.server.ts`:

```ts
import { buildAuthUrl, signState } from "./meta/oauth.server";
```

Replace the body of `startOAuth` so `meta` returns a redirect URL (keep the
`throw` for providers still unwired):

```ts
async startOAuth(provider: IntegrationProvider, _signal?: AbortSignal): Promise<{ redirectUrl: string }> {
  if (provider === "meta") {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const appUrl = process.env.SHOPIFY_APP_URL;
    if (!appId || !appSecret || !appUrl) {
      throw new CalderynError({
        code: "META_NOT_CONFIGURED",
        status: 500,
        message: "Meta OAuth is not configured (META_APP_ID/META_APP_SECRET/SHOPIFY_APP_URL).",
      });
    }
    const redirectUri = `${appUrl}/auth/meta`;
    const state = signState(shop, appSecret);
    return { redirectUrl: buildAuthUrl({ appId, redirectUri, state }) };
  }
  throw new CalderynError({
    code: "OAUTH_NOT_WIRED",
    status: 501,
    message: `${provider} OAuth is not yet wired.`,
  });
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/calderyn.server.ts
git commit -m "feat(meta): startOAuth(meta) returns the OAuth dialog URL"
```

---

## Task 7: OAuth callback route

Top-level redirect target (no Shopify embedded session) — recovers the shop from
the signed `state`, exchanges the code, stores the encrypted credential, marks
the integration ready.

**Files:**
- Create: `app/routes/auth.meta.$.tsx`

- [ ] **Step 1: Implement**

`app/routes/auth.meta.$.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { verifyState, exchangeCodeForToken } from "~/lib/meta/oauth.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";

const GRAPH_VERSION = "v21.0";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!code || !state || !appId || !appSecret || !appUrl) {
    throw new Response("Missing OAuth parameters", { status: 400 });
  }

  const shop = verifyState(state, appSecret);
  if (!shop) throw new Response("Invalid OAuth state", { status: 400 });

  const fetcher = async (u: string) => (await fetch(u)).json();
  const { accessToken, expiresInSec } = await exchangeCodeForToken(fetcher, {
    appId,
    appSecret,
    redirectUri: `${appUrl}/auth/meta`,
    code,
  });

  // Resolve the first ad account for this user.
  const accountsRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts?fields=account_id&access_token=${encodeURIComponent(accessToken)}`,
  );
  const accounts = (await accountsRes.json()) as {
    data?: Array<{ account_id?: string }>;
    error?: { message: string };
  };
  if (accounts.error) throw new Response(`Meta error: ${accounts.error.message}`, { status: 502 });
  const accountId = accounts.data?.[0]?.account_id;
  const adAccountId = accountId ? `act_${accountId}` : null;

  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const now = new Date().toISOString();
  const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "meta_ads",
      access_token_encrypted: encrypt(accessToken),
      token_expires_at: expiresAt,
      external_account_id: adAccountId,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "meta_ads",
      sync_status: "ready",
      external_account_id: adAccountId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  return redirect("/app/settings?meta=connected");
};
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/auth.meta.$.tsx
git commit -m "feat(meta): OAuth callback stores encrypted token + marks integration ready"
```

---

## Task 8: Campaigns page — live-fetch + pause/resume via Meta

`actions.execute` gains optional `preState`/`postState` so the audit row records
the true prior/new status (needed for real undo). The campaigns loader live-fetches
Meta campaigns when connected; the action's pause/resume branch calls the tested
Meta module before recording the audit.

**Files:**
- Modify: `app/lib/calderyn.server.ts` (execute opts + insert)
- Modify: `app/routes/app.campaigns.tsx` (loader + action)

- [ ] **Step 1: Extend `ExecuteActionOpts` and the insert in `actions.execute`**

In `calderyn.server.ts`, add to `ExecuteActionOpts`:

```ts
export type ExecuteActionOpts = {
  alertId: string | null;
  kind: ActionKind;
  params: Record<string, unknown>;
  idempotencyKey: string;
  preState?: unknown;
  postState?: unknown;
};
```

In the `actions.execute` insert, replace the `pre_state`/`post_state` fields:

```ts
              pre_state: opts.preState ?? null,
              post_state: opts.postState ?? opts.params,
```

- [ ] **Step 2: Live-fetch campaigns in the loader**

In `app/routes/app.campaigns.tsx`, add imports:

```ts
import { metaClientForShop } from "~/lib/meta/client.server";
import { listCampaigns } from "~/lib/meta/campaigns.server";
```

Replace the loader's `client.campaigns.list(...)` usage so Meta campaigns are
sourced live when connected (fall back to the existing flat view otherwise):

```ts
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const meta = await metaClientForShop(session.shop);
    let campaigns: Campaign[];
    if (meta) {
      const live = await listCampaigns(meta.client, meta.adAccountId);
      campaigns = live.map((c) => ({
        id: c.id,
        name: c.name,
        platform: "Meta",
        status: c.status === "PAUSED" ? "paused" : "active",
        daily_budget_cents: c.dailyBudgetCents ?? 0,
        roas_7d: 0,
        contribution_margin: 0,
        spend_7d: 0,
      }));
    } else {
      campaigns = await client.campaigns.list(request.signal);
    }
    const alerts = await client.alerts.list({}, request.signal);
    return json<LoaderPayload>({ campaigns, alerts, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      campaigns: [],
      alerts: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};
```

- [ ] **Step 3: Call Meta in the pause/resume branch of the action**

In the same file's `action`, add the import:

```ts
import { metaClientForShop } from "~/lib/meta/client.server";
import { setCampaignStatus } from "~/lib/meta/campaigns.server";
```

Replace the `pause`/`resume` cases' shared `execute` so the Meta call happens
first and the prior/new status is recorded. After computing `kind`/`params` for
`pause`/`resume`, branch before `execute`:

```ts
  // For pause/resume, call Meta first, then record the real pre/post status.
  if (intent === "pause" || intent === "resume") {
    const desired = intent === "pause" ? "PAUSED" : "ACTIVE";
    const prior = intent === "pause" ? "ACTIVE" : "PAUSED";
    const meta = await metaClientForShop(session.shop);
    if (!meta) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "META_NOT_CONNECTED", message: "Connect Meta in Settings first." },
          toast: { message: "Meta not connected", isError: true },
        },
        { status: 400 },
      );
    }
    try {
      await setCampaignStatus(meta.client, campaignId, desired);
      await client.actions.execute(
        {
          alertId: null,
          kind,
          params,
          idempotencyKey,
          preState: { status: prior, campaign_id: campaignId },
          postState: { status: desired, campaign_id: campaignId },
        },
        request.signal,
      );
      return json<ActionPayload>({
        ok: true,
        toast: { message: intent === "pause" ? `Paused ${campaignName}` : `Resumed ${campaignName}` },
      });
    } catch (err) {
      const e = err as CalderynError;
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: e.code ?? "META_ACTION_FAILED", message: e.message },
          toast: { message: e.message, isError: true },
        },
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    }
  }
```

Leave the existing `edit_budget` path (and its `execute`) unchanged.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Run the full test suite (no regressions)**

Run: `npm test`
Expected: PASS (all prior tests green).

- [ ] **Step 6: Commit**

```bash
git add app/lib/calderyn.server.ts app/routes/app.campaigns.tsx
git commit -m "feat(meta): live-fetch campaigns + real pause/resume via Marketing API"
```

---

## Task 9: Real Undo (re-call Meta to restore status)

**Files:**
- Modify: `app/lib/calderyn.server.ts` (`audit.undo`)

- [ ] **Step 1: Re-call Meta for ad-platform pause actions before writing the inverse row**

In `audit.undo`, after loading `orig` and before inserting the inverse row, add:

```ts
          // For real ad-platform pauses, restore the prior status on Meta first.
          if (orig.action_kind === "pause_campaign") {
            const priorStatus = (orig.pre_state as { status?: string } | null)?.status;
            const campaignId = (orig.post_state as { campaign_id?: string } | null)?.campaign_id;
            if (priorStatus === "ACTIVE" || priorStatus === "PAUSED") {
              const { metaClientForShop } = await import("./meta/client.server");
              const { setCampaignStatus } = await import("./meta/campaigns.server");
              const meta = await metaClientForShop(shop);
              if (!meta || !campaignId) {
                throw new CalderynError({
                  code: "UNDO_META_UNAVAILABLE",
                  status: 400,
                  message: "Cannot undo: Meta is not connected or campaign id missing.",
                });
              }
              await setCampaignStatus(meta.client, campaignId, priorStatus);
            }
          }
```

(Dynamic `import` avoids a static cycle between `calderyn.server.ts` and the meta
modules; the modules don't import `calderyn.server.ts`, so a static import is also
fine — use whichever the linter prefers.)

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/calderyn.server.ts
git commit -m "feat(meta): undo re-calls Meta to restore prior campaign status"
```

---

## Task 10: Env, pre-commit gate, and manual e2e (creds-gated)

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the new env vars**

Add to `.env.example`:

```
# Meta (Facebook) Marketing API — developer app in Development mode is enough to
# test pause/resume on your own ad account (no App Review).
META_APP_ID=
META_APP_SECRET=

# 32-byte hex key for encrypting stored OAuth tokens at rest (AES-256-GCM).
INTEGRATION_ENCRYPTION_KEY=replace-with-32-byte-random-hex
```

- [ ] **Step 2: Run the full pre-commit gate (CLAUDE.md)**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Paste results; all green. Then run `/code-review` on the working tree and resolve
blockers. `npx prisma validate` not required (no `prisma/schema.prisma` change);
`graphql-codegen` not required (no `.graphql`/Admin query added).

- [ ] **Step 3: Commit env + any gate fixes**

```bash
git add .env.example
git commit -m "chore(meta): document META_APP_ID/SECRET + INTEGRATION_ENCRYPTION_KEY"
```

- [ ] **Step 4: Manual e2e (deferred until creds — needs a Meta dev app)**

1. Create a Meta app (Development mode), add `ads_management`,`ads_read`; add your
   user + ad account. Set `META_APP_ID/SECRET`, a real `INTEGRATION_ENCRYPTION_KEY`,
   `SUPABASE_*`, `DATABASE_URL` in `.env`. Apply the Task 1 migration (`supabase db push`).
2. Add `https://<app-url>/auth/meta` as a valid OAuth redirect URI in the Meta app.
3. `npm run dev`, open the app, Settings → Connect Meta → complete OAuth.
4. Verify a row in `integration_credentials` and `shop_integrations(kind=meta_ads, sync_status=ready)`.
5. Campaigns page lists your live Meta campaigns. Click Pause → confirm the campaign
   shows `PAUSED` in Meta Ads Manager and an `action_audit` row exists with
   `pre_state.status=ACTIVE`, `post_state.status=PAUSED`.
6. Undo from the audit log → confirm the campaign returns to `ACTIVE` in Meta.

---

## Self-Review

**Spec coverage:**
- §5/§6 Meta client (list/setStatus, error → throw) → Task 3. ✓
- §7 OAuth + token storage (auth URL, signed state, exchange, callback, integration_credentials) → Tasks 4, 7; startOAuth → Task 6. ✓
- §7.1 `integration_credentials` migration → Task 1. ✓
- §8 crypto AES-256-GCM → Task 2. ✓
- §4 live-fetch campaigns → Task 8 loader. ✓
- §9 real undo re-call → Task 9. ✓
- §10 Supabase migration carve-out → Task 1 note. ✓
- §11 new env vars → Tasks 6/7 read them, documented in Task 10. ✓
- §12 tests on client/crypto/oauth → Tasks 2,3,4; wiring verified by typecheck/build + manual e2e → Tasks 5–10. ✓
- §13 pre-commit gate → Task 10. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code.

**Type consistency:** `MetaClient`/`MetaResponse`/`MetaCampaign` (Task 3) reused in Tasks 5,8. `signState`/`verifyState`/`exchangeCodeForToken`/`buildAuthUrl` (Task 4) used in Tasks 6,7. `metaClientForShop` returns `{ client, adAccountId }` and is used identically in Tasks 8,9. `ExecuteActionOpts.preState/postState` (Task 8) consumed by undo in Task 9. Token format `iv:tag:data` consistent between encrypt/decrypt (Task 2).
```
