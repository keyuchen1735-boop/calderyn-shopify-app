# Claude Connector — OAuth 2.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the native Claude.ai "Add connector" experience for Calderyn: a merchant pastes the MCP URL into Claude.ai, sees a Polaris consent screen on `app.calderyncompany.com`, clicks Allow, and starts asking Claude questions about their shop — no copy-pasted tokens.

**Architecture:** OAuth 2.1 authorization code grant with PKCE and dynamic client registration (RFC 7591). Three OAuth endpoints (`/oauth/authorize`, `/oauth/token`, `/oauth/register`) plus the discovery doc live in **this repo** (`shopify-app`), because the merchant's Shopify session lives here. The resource discovery doc (`/.well-known/oauth-protected-resource`) and the introspection middleware live in the sibling **`calderyn-mcp`** repo. Two new Supabase tables (`mcp_oauth_clients`, `mcp_oauth_codes`) plus four new columns on `mcp_tokens` are the only schema additions. Existing `mcp_live_*` bearer tokens keep working unchanged.

**Tech Stack:** Remix v2 (Vite), `@shopify/shopify-app-remix`, Polaris, Supabase (`@supabase/supabase-js`), Vitest, Node 20+, `jose` for JWT cookie signing.

**Spec reference:** [`docs/superpowers/specs/2026-06-08-claude-connector-oauth-design.md`](../specs/2026-06-08-claude-connector-oauth-design.md) — read this first. Section numbers (§N) below refer to that spec.

**Prerequisite:** `calderyn-mcp` source must be recovered or rebuilt before Phase 16 runs (those cross-repo tasks edit calderyn-mcp source). The existing 2026-05-25 plan covers a from-spec rebuild. The first 15 phases (this repo) are unblocked and can ship behind a feature flag without touching calderyn-mcp.

---

## File Structure

### New in `shopify-app/`

```
shopify-app/
├── supabase/migrations/
│   ├── 20260608120000_mcp_oauth_clients.sql       # Phase 1
│   ├── 20260608120100_mcp_oauth_codes.sql         # Phase 1
│   └── 20260608120200_mcp_tokens_oauth_columns.sql # Phase 1
├── app/lib/
│   ├── mcp_oauth.server.ts                        # Phases 2–3 — clients, codes, tokens CRUD + PKCE
│   └── __tests__/
│       ├── mcp_oauth_pkce.test.ts                 # Phase 2
│       ├── mcp_oauth_clients.test.ts              # Phase 3
│       ├── mcp_oauth_codes.test.ts                # Phase 3
│       └── mcp_oauth_tokens.test.ts               # Phases 11–12
├── app/routes/
│   ├── [.]well-known.oauth-authorization-server.tsx # Phase 5
│   ├── oauth.register.tsx                          # Phase 6
│   ├── oauth.authorize.tsx                         # Phases 7–9
│   ├── oauth.consent.tsx                           # Phase 10
│   ├── oauth.token.tsx                             # Phases 11–12
│   └── api.cron.mcp-oauth-cleanup.tsx              # Phase 15
├── app/components/
│   └── McpConnectCards.tsx                        # Phase 13
├── docs/adr/
│   └── 0002-mcp-oauth-2-1.md                       # Phase 0
└── .env.example                                    # Phase 0 — add MCP_OAUTH_ENABLED, MCP_OAUTH_COOKIE_SECRET
```

### Modified in `shopify-app/`

- `app/lib/mcp_tokens.server.ts` — extend for new columns, add OAuth list/revoke (Phase 4)
- `app/routes/app._index.tsx` — pending-OAuth cookie short-circuit (Phase 9)
- `app/routes/app.mcp.tsx` — two-column banner + connected workspaces card (Phase 13)
- Wherever the app nav is defined — add "Claude connections" link (Phase 14)
- `vercel.json` — add cron schedule for cleanup (Phase 15)
- `package.json` — add `jose` dependency (Phase 0)

### Net-new in `calderyn-mcp/` (Phase 16)

Two surgical additions to the rebuilt source:

- `src/routes/oauth-protected-resource.ts` — well-known doc per §6.2
- `src/auth/token.ts` — extend introspection with `expires_at` check (§6.8)

---

## Phase 0 — Preamble

### Task 0.1: Branch off main

**Files:** none.

- [ ] **Step 1:** Stash any unrelated dirty work.

```bash
git status
# If anything other than .vercel/remix-build-result.json is dirty, commit or stash first.
git stash push -m "wip: pre-mcp-oauth" || true
```

- [ ] **Step 2:** Update main and branch.

```bash
git fetch origin
git checkout -b calderyn/claude-connector-oauth origin/main
```

- [ ] **Step 3:** Verify clean.

Run: `git status`
Expected: `On branch calderyn/claude-connector-oauth ... working tree clean`

### Task 0.2: Add the `jose` dependency

**Files:** `package.json`, `package-lock.json`.

- [ ] **Step 1:** Install.

```bash
npm install jose@^5.9.6
```

- [ ] **Step 2:** Verify it's in `dependencies`.

Run: `grep '"jose"' package.json`
Expected: `"jose": "^5.9.6",`

- [ ] **Step 3:** Commit.

```bash
git add package.json package-lock.json
git commit -m "deps: add jose for OAuth state-cookie signing"
```

### Task 0.3: Add the env vars to `.env.example`

**Files:** `.env.example`.

- [ ] **Step 1:** Append.

```dotenv

# === MCP OAuth 2.1 (Claude.ai connector flow) ===
# Master flag. When false, /oauth/* routes 404 and the discovery doc is not served.
MCP_OAUTH_ENABLED=false
# 64+ character hex secret used to sign the pending-OAuth state cookie.
# Generate with: openssl rand -hex 32
MCP_OAUTH_COOKIE_SECRET=
```

- [ ] **Step 2:** Verify locally.

Run: `grep MCP_OAUTH .env.example`
Expected: both lines present.

- [ ] **Step 3:** Commit.

```bash
git add .env.example
git commit -m "env: declare MCP_OAUTH_ENABLED + MCP_OAUTH_COOKIE_SECRET"
```

### Task 0.4: Draft ADR 0002

**Files:** Create `docs/adr/0002-mcp-oauth-2-1.md`.

- [ ] **Step 1:** Write the file.

```markdown
# ADR 0002: Native Claude.ai connector via OAuth 2.1 (with bearer kept as escape hatch)

**Status:** Accepted — 2026-06-08
**Spec:** `docs/superpowers/specs/2026-06-08-claude-connector-oauth-design.md`
**Supersedes/extends:** [ADR 0001](0001-mcp-server-split.md) v2 stub.

## Context

The 2026-05-25 spec deferred OAuth 2.1 to a v2 workstream. v1 shipped a bearer-token paste flow that few merchants will complete (copy a long string from one tab, paste into Claude.ai's connector dialog). Anthropic's MCP connector UX expects discoverable OAuth + dynamic client registration; without it, "Add connector" looks broken in Claude.ai.

## Decision

**Implement OAuth 2.1 (authorization code + PKCE + DCR + refresh rotation) across both repos, with the authorize/token/register endpoints in `shopify-app` and a single well-known resource doc in `calderyn-mcp`. Keep the bearer-token flow at `/app/mcp` as an escape hatch for custom MCP clients.**

Specifically:
- The four OAuth endpoints live in `shopify-app` because the Shopify offline session — the only authoritative shop-identity source — lives there. Putting `/oauth/authorize` anywhere else requires a cross-repo redirect dance that adds two hops with no upside.
- Dynamic Client Registration (RFC 7591) is open; clients are public (`token_endpoint_auth_method: "none"`), with PKCE S256 as the security boundary. Claude.ai is a public client; this matches the connector spec.
- Refresh tokens rotate on use. Replay of a stolen refresh produces a detectable failure on the next legitimate use.
- The `mcp_tokens` table is extended (`auth_type`, `client_id`, `expires_at`, `refresh_hash`) rather than duplicated. The introspection middleware in `calderyn-mcp` already keys on `token_hash`; adding one `expires_at IS NULL OR expires_at > now()` predicate is the entire functional change on the server side.
- Bearer-token flow remains. Two auth modes → one `{shop_id, scopes}` context → tool handlers don't distinguish.

## Consequences

**Positive.**
- Merchants get a one-click connector flow.
- The bulk of the OAuth machinery is colocated with the Shopify session, where it's easy to reason about.
- The bearer flow stays available for power users and custom agents.

**Negative.**
- Two repos to coordinate during a single OAuth release (small — only one route + one middleware change in `calderyn-mcp`).
- DCR is an open endpoint, so it gets a basic IP rate limit. Worth it for the connector UX.
- The "which shop?" prompt at `/oauth/authorize` is a small UX wart when the merchant arrives with no Shopify session. Acceptable for v1; can be smoothed later.

## Alternatives considered

- **Static client registration (no DCR).** Rejected: requires pre-provisioning a `client_id` for Claude.ai, and the connector UX expects DCR. Locks out other agents.
- **`/oauth/authorize` in `calderyn-mcp`, redirect to `shopify-app` for consent then back.** Rejected: two extra hops, two domains in the URL bar mid-auth, harder to debug.
- **OAuth replaces the bearer flow entirely.** Rejected per user choice — bearer stays for custom MCP clients.
```

- [ ] **Step 2:** Commit.

```bash
git add docs/adr/0002-mcp-oauth-2-1.md
git commit -m "adr: 0002 native Claude.ai connector via OAuth 2.1"
```

---

## Phase 1 — Supabase migrations

All three RLS-enabled, no policy, service-role only. Mirrors the 2026-06-04 hardening posture.

### Task 1.1: Migration — `mcp_oauth_clients`

**Files:** Create `supabase/migrations/20260608120000_mcp_oauth_clients.sql`.

- [ ] **Step 1:** Write the migration.

```sql
-- mcp_oauth_clients: one row per OAuth client (Claude.ai workspace, custom agent, etc.)
-- registered via RFC 7591 dynamic client registration.

create table mcp_oauth_clients (
  client_id                  text primary key,             -- 'cal_client_' + 16 random base32
  client_name                text not null,                -- from DCR payload
  redirect_uris              jsonb not null,               -- jsonb array of strings; validated against at issue + exchange
  token_endpoint_auth_method text not null default 'none',
  software_id                text,                         -- DCR optional
  software_version           text,
  created_at                 timestamptz not null default now(),
  last_used_at               timestamptz
);

alter table mcp_oauth_clients enable row level security;
revoke all on table mcp_oauth_clients from anon, authenticated;
```

- [ ] **Step 2:** Apply against prod Supabase via the MCP tool.

Run: invoke `mcp__supabase__apply_migration` with project_id of the live Supabase, name `mcp_oauth_clients`, query equal to the SQL above.
Expected: success, no error.

- [ ] **Step 3:** Verify with `list_tables`.

Run: invoke `mcp__supabase__list_tables` filtered to `mcp_oauth_clients`.
Expected: table exists, RLS enabled, no policies.

- [ ] **Step 4:** Commit.

```bash
git add supabase/migrations/20260608120000_mcp_oauth_clients.sql
git commit -m "db: mcp_oauth_clients (DCR-registered OAuth clients)"
```

### Task 1.2: Migration — `mcp_oauth_codes`

**Files:** Create `supabase/migrations/20260608120100_mcp_oauth_codes.sql`.

- [ ] **Step 1:** Write the migration.

```sql
-- mcp_oauth_codes: short-lived (60s) one-time authorization codes.
-- Stored only as sha256(code); raw code never persisted.

create table mcp_oauth_codes (
  code_hash      text primary key,                                                 -- sha256(code)
  client_id      text not null references mcp_oauth_clients(client_id) on delete cascade,
  shop_id        uuid not null references shops(id) on delete cascade,
  redirect_uri   text not null,                                                    -- bound at issue, verified at exchange
  code_challenge text not null,                                                    -- PKCE S256 challenge
  scopes         jsonb not null default '["read"]'::jsonb,
  state_hint     text,                                                             -- last 8 chars of client state (logging only)
  expires_at     timestamptz not null,                                             -- now() + 60s
  consumed_at    timestamptz,                                                      -- single-use marker
  created_at     timestamptz not null default now()
);

create index mcp_oauth_codes_cleanup_idx on mcp_oauth_codes (expires_at);

alter table mcp_oauth_codes enable row level security;
revoke all on table mcp_oauth_codes from anon, authenticated;
```

- [ ] **Step 2:** Apply via `mcp__supabase__apply_migration`.

- [ ] **Step 3:** Verify via `list_tables`.

Expected: `mcp_oauth_codes` present, FK to `mcp_oauth_clients` and `shops`, RLS enabled.

- [ ] **Step 4:** Commit.

```bash
git add supabase/migrations/20260608120100_mcp_oauth_codes.sql
git commit -m "db: mcp_oauth_codes (one-time PKCE-bound authorization codes)"
```

### Task 1.3: Migration — extend `mcp_tokens`

**Files:** Create `supabase/migrations/20260608120200_mcp_tokens_oauth_columns.sql`.

- [ ] **Step 1:** Write the migration.

```sql
-- Extend mcp_tokens with OAuth-flow columns. Existing rows keep working
-- (auth_type defaults to 'bearer', other columns NULL).

alter table mcp_tokens
  add column auth_type    text not null default 'bearer' check (auth_type in ('bearer','oauth')),
  add column client_id    text references mcp_oauth_clients(client_id) on delete set null,
  add column expires_at   timestamptz,
  add column refresh_hash text;

create unique index mcp_tokens_refresh_hash_uq
  on mcp_tokens (refresh_hash)
  where refresh_hash is not null;

create index mcp_tokens_oauth_lookup_idx
  on mcp_tokens (client_id, shop_id)
  where auth_type = 'oauth' and revoked_at is null;
```

- [ ] **Step 2:** Apply via `mcp__supabase__apply_migration`.

- [ ] **Step 3:** Verify the alter took effect.

Run: invoke `mcp__supabase__execute_sql` with `select column_name, data_type from information_schema.columns where table_name = 'mcp_tokens' order by ordinal_position;`
Expected: includes `auth_type`, `client_id`, `expires_at`, `refresh_hash`.

- [ ] **Step 4:** Commit.

```bash
git add supabase/migrations/20260608120200_mcp_tokens_oauth_columns.sql
git commit -m "db: mcp_tokens add auth_type, client_id, expires_at, refresh_hash"
```

---

## Phase 2 — PKCE math + token generators

Test-first, pure functions, no Supabase dependency. Lives in `app/lib/mcp_oauth.server.ts`.

### Task 2.1: PKCE S256 verifier→challenge

**Files:**
- Create: `app/lib/mcp_oauth.server.ts`
- Create: `app/lib/__tests__/mcp_oauth_pkce.test.ts`

- [ ] **Step 1:** Write the failing test.

```typescript
// app/lib/__tests__/mcp_oauth_pkce.test.ts
import { describe, it, expect } from "vitest";
import { pkceChallenge, verifyPkce } from "../mcp_oauth.server";

describe("pkceChallenge (S256)", () => {
  it("produces a 43-char base64url challenge from a 43-128 char verifier", () => {
    // RFC 7636 §4.6 reference vector
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = pkceChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("verifyPkce", () => {
  it("returns true when verifier matches challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("returns false when verifier does not match challenge", () => {
    expect(verifyPkce("wrong-verifier", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });

  it("returns false for too-short verifier (< 43 chars)", () => {
    expect(verifyPkce("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });
});
```

- [ ] **Step 2:** Run the test, confirm it fails for the right reason.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_pkce.test.ts`
Expected: FAIL — `pkceChallenge` / `verifyPkce` not exported.

- [ ] **Step 3:** Implement.

```typescript
// app/lib/mcp_oauth.server.ts
//
// Server-only OAuth 2.1 helpers for the Claude.ai connector flow.
// PKCE math + token/code generators here; CRUD helpers in later phases.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Constant-time PKCE verification. Rejects verifiers shorter than 43 chars (RFC §4.1). */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const expected = Buffer.from(pkceChallenge(verifier));
  const actual = Buffer.from(challenge);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4:** Run, confirm pass.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_pkce.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5:** Commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_pkce.test.ts
git commit -m "lib: pkce S256 challenge + verify (constant-time)"
```

### Task 2.2: Random ID generators (client_id, auth code, opaque token)

**Files:** Extend `app/lib/mcp_oauth.server.ts`, extend `app/lib/__tests__/mcp_oauth_pkce.test.ts`.

- [ ] **Step 1:** Add tests.

Append to `mcp_oauth_pkce.test.ts`:

```typescript
import { newClientId, newAuthCode, newAccessToken, newRefreshToken } from "../mcp_oauth.server";

describe("id generators", () => {
  it("newClientId has 'cal_client_' prefix and 16 base32 body", () => {
    const id = newClientId();
    expect(id).toMatch(/^cal_client_[a-z2-7]{16}$/);
  });

  it("newAuthCode has 'calc_' prefix and 32 base32 body", () => {
    const c = newAuthCode();
    expect(c).toMatch(/^calc_[a-z2-7]{32}$/);
  });

  it("newAccessToken has 'cala_' prefix and 32 base32 body", () => {
    const t = newAccessToken();
    expect(t).toMatch(/^cala_[a-z2-7]{32}$/);
  });

  it("newRefreshToken has 'calr_' prefix and 32 base32 body", () => {
    const t = newRefreshToken();
    expect(t).toMatch(/^calr_[a-z2-7]{32}$/);
  });

  it("generators produce unique values", () => {
    const xs = new Set<string>();
    for (let i = 0; i < 1000; i++) xs.add(newAccessToken());
    expect(xs.size).toBe(1000);
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_pkce.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3:** Implement.

Append to `mcp_oauth.server.ts`:

```typescript
function base32(len: number): string {
  const bytes = randomBytes(len);
  let body = "";
  for (let i = 0; i < bytes.length; i++) body += BASE32_ALPHA[bytes[i] % 32];
  return body;
}

export function newClientId(): string {
  return `cal_client_${base32(16)}`;
}

export function newAuthCode(): string {
  return `calc_${base32(32)}`;
}

export function newAccessToken(): string {
  return `cala_${base32(32)}`;
}

export function newRefreshToken(): string {
  return `calr_${base32(32)}`;
}
```

- [ ] **Step 4:** Run, confirm pass.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_pkce.test.ts`
Expected: all PASS.

- [ ] **Step 5:** Commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_pkce.test.ts
git commit -m "lib: prefixed base32 id generators (client/code/access/refresh)"
```

### Task 2.3: SHA256 hash helper (for codes + access tokens)

Reuse the existing `hashToken` from `mcp_tokens.server.ts` for tokens (HMAC w/ pepper). Codes are short-lived so a plain SHA256 (no pepper) is enough — the rows expire in 60s.

**Files:** Extend `app/lib/mcp_oauth.server.ts` and the test file.

- [ ] **Step 1:** Add test.

```typescript
import { sha256hex } from "../mcp_oauth.server";

describe("sha256hex", () => {
  it("matches a known vector", () => {
    expect(sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_pkce.test.ts`
Expected: FAIL.

- [ ] **Step 3:** Implement.

Append to `mcp_oauth.server.ts`:

```typescript
/** Plain SHA256 (hex). Used for short-lived auth codes; access tokens use the pepper'd HMAC from mcp_tokens.server.ts. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
```

- [ ] **Step 4:** Pass, commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_pkce.test.ts
git commit -m "lib: sha256hex helper for short-lived OAuth codes"
```

---

## Phase 3 — Data layer (clients, codes)

### Task 3.1: `registerClient(payload)` — DCR write

**Files:**
- Modify: `app/lib/mcp_oauth.server.ts`
- Create: `app/lib/__tests__/mcp_oauth_clients.test.ts`

- [ ] **Step 1:** Write the test (fakes Supabase).

```typescript
// app/lib/__tests__/mcp_oauth_clients.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn();
const selectSingleMock = vi.fn();

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== "mcp_oauth_clients") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: unknown) => {
          insertMock(row);
          return { select: () => ({ single: () => selectSingleMock(row) }) };
        },
      };
    },
  }),
  resolveShopId: vi.fn(),
}));

import { registerClient } from "../mcp_oauth.server";

beforeEach(() => {
  insertMock.mockReset();
  selectSingleMock.mockReset();
});

describe("registerClient", () => {
  it("inserts a row with a generated client_id and returns DCR response shape", async () => {
    selectSingleMock.mockResolvedValue({
      data: {
        client_id: "cal_client_abcdefghijklmnop",
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      },
      error: null,
    });
    const out = await registerClient({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    expect(insertMock).toHaveBeenCalledOnce();
    const inserted = insertMock.mock.calls[0][0] as { client_id: string };
    expect(inserted.client_id).toMatch(/^cal_client_[a-z2-7]{16}$/);
    expect(out.client_id).toMatch(/^cal_client_/);
    expect(out.token_endpoint_auth_method).toBe("none");
    expect(out.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("rejects non-HTTPS redirect URIs", async () => {
    await expect(
      registerClient({ client_name: "x", redirect_uris: ["http://evil/cb"] }),
    ).rejects.toThrow(/INVALID_REDIRECT_URI/);
  });

  it("rejects empty redirect_uris", async () => {
    await expect(registerClient({ client_name: "x", redirect_uris: [] })).rejects.toThrow(
      /INVALID_REDIRECT_URI/,
    );
  });

  it("caps redirect_uris at 5", async () => {
    const uris = Array.from({ length: 6 }, (_, i) => `https://x.example/cb${i}`);
    await expect(registerClient({ client_name: "x", redirect_uris: uris })).rejects.toThrow(
      /TOO_MANY_REDIRECT_URIS/,
    );
  });

  it("rejects empty client_name", async () => {
    await expect(
      registerClient({ client_name: "", redirect_uris: ["https://x.example/cb"] }),
    ).rejects.toThrow(/INVALID_CLIENT_NAME/);
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_clients.test.ts`
Expected: FAIL — `registerClient` not exported.

- [ ] **Step 3:** Implement.

Append to `mcp_oauth.server.ts`:

```typescript
import { getSupabase } from "./supabase.server";

export interface DcrRequest {
  client_name: string;
  redirect_uris: string[];
  software_id?: string;
  software_version?: string;
}

export interface DcrResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
}

function isHttpsUri(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function err(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export async function registerClient(req: DcrRequest): Promise<DcrResponse> {
  const name = (req.client_name ?? "").trim();
  if (!name) throw err("INVALID_CLIENT_NAME", "client_name is required");
  if (!Array.isArray(req.redirect_uris) || req.redirect_uris.length === 0) {
    throw err("INVALID_REDIRECT_URI", "redirect_uris must be a non-empty array");
  }
  if (req.redirect_uris.length > 5) {
    throw err("TOO_MANY_REDIRECT_URIS", "at most 5 redirect_uris allowed");
  }
  for (const u of req.redirect_uris) {
    if (!isHttpsUri(u)) throw err("INVALID_REDIRECT_URI", `redirect_uri must be https: ${u}`);
  }

  const client_id = newClientId();
  const { data, error } = await getSupabase()
    .from("mcp_oauth_clients")
    .insert({
      client_id,
      client_name: name,
      redirect_uris: req.redirect_uris,
      token_endpoint_auth_method: "none",
      software_id: req.software_id ?? null,
      software_version: req.software_version ?? null,
    })
    .select("client_id, client_name, redirect_uris, token_endpoint_auth_method")
    .single();
  if (error) throw error;
  const row = data as DcrResponse;
  return row;
}
```

- [ ] **Step 4:** Run, confirm pass.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_clients.test.ts`
Expected: all PASS.

- [ ] **Step 5:** Commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_clients.test.ts
git commit -m "lib: registerClient (RFC 7591 DCR, public clients only)"
```

### Task 3.2: `getClient(clientId)` — DCR lookup

**Files:** Modify `app/lib/mcp_oauth.server.ts` + same test file.

- [ ] **Step 1:** Add test.

Append to `mcp_oauth_clients.test.ts` (above the `beforeEach` reset the mocks need a fresh fake — update the mock):

Adjust the `vi.mock` block to support `select` chains, then add tests:

```typescript
// Replace the prior vi.mock with this richer one:
const supabaseFake = {
  insert: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  update: vi.fn(),
};

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const chain = {
        insert: (row: unknown) => {
          supabaseFake.insert(row);
          return {
            select: () => ({ single: () => supabaseFake.single() }),
          };
        },
        select: (cols: string) => {
          supabaseFake.select(cols);
          return {
            eq: (col: string, val: unknown) => {
              supabaseFake.eq(col, val);
              return {
                maybeSingle: () => supabaseFake.maybeSingle(),
              };
            },
          };
        },
      };
      return chain;
    },
  }),
  resolveShopId: vi.fn(),
}));

import { getClient } from "../mcp_oauth.server";

describe("getClient", () => {
  it("returns the row when found", async () => {
    supabaseFake.maybeSingle.mockResolvedValue({
      data: { client_id: "cal_client_x", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] },
      error: null,
    });
    const row = await getClient("cal_client_x");
    expect(row?.client_id).toBe("cal_client_x");
    expect(supabaseFake.eq).toHaveBeenCalledWith("client_id", "cal_client_x");
  });

  it("returns null when not found", async () => {
    supabaseFake.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getClient("nope")).toBeNull();
  });
});
```

(Existing `registerClient` tests need a small mock-shape update; rewrite as needed so `insert(...).select().single()` flows through `supabaseFake.single`.)

- [ ] **Step 2:** Run, confirm fail.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_clients.test.ts`
Expected: FAIL — `getClient` undefined.

- [ ] **Step 3:** Implement.

Append to `mcp_oauth.server.ts`:

```typescript
export interface OauthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
}

export async function getClient(clientId: string): Promise<OauthClientRow | null> {
  const { data, error } = await getSupabase()
    .from("mcp_oauth_clients")
    .select("client_id, client_name, redirect_uris, token_endpoint_auth_method")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return (data as OauthClientRow | null) ?? null;
}
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_clients.test.ts
git commit -m "lib: getClient (oauth client lookup by id)"
```

### Task 3.3: `issueAuthCode({...})` — write a code row

**Files:** Modify `app/lib/mcp_oauth.server.ts` + create `app/lib/__tests__/mcp_oauth_codes.test.ts`.

- [ ] **Step 1:** Write the test.

```typescript
// app/lib/__tests__/mcp_oauth_codes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn();
vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: (row: unknown) => {
        insertMock(row);
        return Promise.resolve({ data: null, error: null });
      },
    }),
  }),
  resolveShopId: vi.fn(),
}));

import { issueAuthCode } from "../mcp_oauth.server";

beforeEach(() => insertMock.mockReset());

describe("issueAuthCode", () => {
  it("returns a calc_-prefixed raw code and writes only the hash + metadata", async () => {
    const raw = await issueAuthCode({
      client_id: "cal_client_x",
      shop_id: "00000000-0000-0000-0000-000000000001",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: "challenge",
      scopes: ["read"],
      state: "abcdefghijklmnop",
    });
    expect(raw).toMatch(/^calc_[a-z2-7]{32}$/);
    expect(insertMock).toHaveBeenCalledOnce();
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(raw); // never persists raw
    expect(row.client_id).toBe("cal_client_x");
    expect(row.state_hint).toBe("ijklmnop"); // last 8 chars
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(row.expires_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement.

```typescript
export interface IssueCodeReq {
  client_id: string;
  shop_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  state: string;
}

const CODE_TTL_SEC = 60;

export async function issueAuthCode(req: IssueCodeReq): Promise<string> {
  const raw = newAuthCode();
  const code_hash = sha256hex(raw);
  const expires_at = new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString();
  const state_hint = req.state.slice(-8);
  const { error } = await getSupabase().from("mcp_oauth_codes").insert({
    code_hash,
    client_id: req.client_id,
    shop_id: req.shop_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    scopes: req.scopes,
    state_hint,
    expires_at,
  });
  if (error) throw error;
  return raw;
}
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_codes.test.ts
git commit -m "lib: issueAuthCode (60s TTL, sha256 at rest)"
```

### Task 3.4: `consumeAuthCode({code, verifier, redirect_uri, client_id})` — atomic claim

This is the single most security-sensitive function in the OAuth flow. It must: look up by hash, verify expiry/consumed, verify PKCE, verify redirect_uri + client_id match, then atomically flip `consumed_at`. Any failure between lookup and flip leaves the row consumable; we use a conditional update with `.is("consumed_at", null)` and check `rowCount`.

**Files:** Modify `app/lib/mcp_oauth.server.ts` and `app/lib/__tests__/mcp_oauth_codes.test.ts`.

- [ ] **Step 1:** Extend the mock to support `select(...).eq(...).maybeSingle()` and `update(...).eq(...).is(...).select()` chains. Then add the tests.

(Update the `vi.mock` block to richer chain support — see Task 3.2 — and append:)

```typescript
const selectMock = vi.fn();
const eqMock = vi.fn();
const maybeSingleMock = vi.fn();
const updateMock = vi.fn();
const updateEqMock = vi.fn();
const updateIsMock = vi.fn();
const updateSelectMock = vi.fn();

// Replace vi.mock with chain-aware version supporting both flows.

import { consumeAuthCode } from "../mcp_oauth.server";

describe("consumeAuthCode", () => {
  const VALID_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const VALID_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("returns the bound context on a fresh, valid code", async () => {
    // Arrange row lookup, then atomic update returning 1 row
    maybeSingleMock.mockResolvedValue({
      data: {
        client_id: "cal_client_x",
        shop_id: "shopuuid",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: VALID_CHALLENGE,
        scopes: ["read"],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        consumed_at: null,
      },
      error: null,
    });
    updateSelectMock.mockResolvedValue({ data: [{ code_hash: "x" }], error: null });

    const res = await consumeAuthCode({
      raw_code: "calc_zzz",
      code_verifier: VALID_VERIFIER,
      redirect_uri: "https://claude.ai/cb",
      client_id: "cal_client_x",
    });
    expect(res).toEqual({ shop_id: "shopuuid", scopes: ["read"] });
  });

  it("rejects when code not found", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    await expect(
      consumeAuthCode({ raw_code: "x", code_verifier: VALID_VERIFIER, redirect_uri: "u", client_id: "c" }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects expired code", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: null,
              client_id: "c", redirect_uri: "u", code_challenge: VALID_CHALLENGE, scopes: ["read"], shop_id: "s" },
      error: null,
    });
    await expect(
      consumeAuthCode({ raw_code: "x", code_verifier: VALID_VERIFIER, redirect_uri: "u", client_id: "c" }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects consumed code", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: new Date().toISOString(),
              client_id: "c", redirect_uri: "u", code_challenge: VALID_CHALLENGE, scopes: ["read"], shop_id: "s" },
      error: null,
    });
    await expect(
      consumeAuthCode({ raw_code: "x", code_verifier: VALID_VERIFIER, redirect_uri: "u", client_id: "c" }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects PKCE mismatch", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null,
              client_id: "c", redirect_uri: "u", code_challenge: "WRONG", scopes: ["read"], shop_id: "s" },
      error: null,
    });
    await expect(
      consumeAuthCode({ raw_code: "x", code_verifier: VALID_VERIFIER, redirect_uri: "u", client_id: "c" }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when redirect_uri doesn't match the issued one", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null,
              client_id: "c", redirect_uri: "https://claude.ai/cb", code_challenge: VALID_CHALLENGE,
              scopes: ["read"], shop_id: "s" },
      error: null,
    });
    await expect(
      consumeAuthCode({
        raw_code: "x", code_verifier: VALID_VERIFIER,
        redirect_uri: "https://evil.example/cb", client_id: "c",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when client_id doesn't match the issued one", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null,
              client_id: "other", redirect_uri: "u", code_challenge: VALID_CHALLENGE,
              scopes: ["read"], shop_id: "s" },
      error: null,
    });
    await expect(
      consumeAuthCode({ raw_code: "x", code_verifier: VALID_VERIFIER, redirect_uri: "u", client_id: "c" }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when atomic update returns zero rows (race lost)", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null,
              client_id: "c", redirect_uri: "u", code_challenge: VALID_CHALLENGE, scopes: ["read"], shop_id: "s" },
      error: null,
    });
    updateSelectMock.mockResolvedValue({ data: [], error: null });
    await expect(
      consumeAuthCode({ raw_code: "x", code_verifier: VALID_VERIFIER, redirect_uri: "u", client_id: "c" }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement.

```typescript
export interface ConsumeCodeReq {
  raw_code: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
}

export interface ConsumedContext {
  shop_id: string;
  scopes: string[];
}

function invalidGrant(detail: string): Error {
  return err("invalid_grant", detail);
}

export async function consumeAuthCode(req: ConsumeCodeReq): Promise<ConsumedContext> {
  const code_hash = sha256hex(req.raw_code);
  const { data, error } = await getSupabase()
    .from("mcp_oauth_codes")
    .select("client_id, shop_id, redirect_uri, code_challenge, scopes, expires_at, consumed_at")
    .eq("code_hash", code_hash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw invalidGrant("code not found");
  if (data.consumed_at) throw invalidGrant("code already used");
  if (new Date(data.expires_at as string).getTime() < Date.now()) throw invalidGrant("code expired");
  if (data.client_id !== req.client_id) throw invalidGrant("client_id mismatch");
  if (data.redirect_uri !== req.redirect_uri) throw invalidGrant("redirect_uri mismatch");
  if (!verifyPkce(req.code_verifier, data.code_challenge as string)) throw invalidGrant("PKCE mismatch");

  // Atomically claim the code. Only succeeds if consumed_at is still null.
  const { data: updated, error: uerr } = await getSupabase()
    .from("mcp_oauth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code_hash", code_hash)
    .is("consumed_at", null)
    .select("code_hash");
  if (uerr) throw uerr;
  if (!Array.isArray(updated) || updated.length === 0) throw invalidGrant("code race lost");

  return { shop_id: data.shop_id as string, scopes: data.scopes as string[] };
}
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_codes.test.ts
git commit -m "lib: consumeAuthCode (PKCE+redirect+client_id verify, atomic claim)"
```

---

## Phase 4 — Extend `mcp_tokens.server.ts`

The existing module is OAuth-naive. We add: OAuth-token mint, refresh-token rotation, OAuth-row revoke, and a list variant filtered by `auth_type`.

### Task 4.1: `mintAccessToken({client_id, shop_id, scopes})` returns raw access + refresh

**Files:** Modify `app/lib/mcp_tokens.server.ts`, create `app/lib/__tests__/mcp_oauth_tokens.test.ts`.

- [ ] **Step 1:** Write the test.

```typescript
// app/lib/__tests__/mcp_oauth_tokens.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn();
const insertSingleMock = vi.fn();

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: (row: unknown) => {
        insertMock(row);
        return { select: () => ({ single: () => insertSingleMock() }) };
      },
    }),
  }),
  resolveShopId: vi.fn(),
}));

process.env.MCP_TOKEN_PEPPER = "x".repeat(64);

import { mintAccessToken } from "../mcp_tokens.server";

beforeEach(() => {
  insertMock.mockReset();
  insertSingleMock.mockReset();
});

describe("mintAccessToken", () => {
  it("returns raw access + refresh tokens and inserts a row with auth_type='oauth'", async () => {
    insertSingleMock.mockResolvedValue({
      data: {
        id: "tokenrow-uuid",
        shop_id: "shopuuid",
        name: "Claude (workspace abc)",
        token_prefix: "cala_xxxx",
        scopes: ["read"],
        created_at: new Date().toISOString(),
      },
      error: null,
    });

    const out = await mintAccessToken({
      client_id: "cal_client_x",
      client_name: "Claude",
      shop_id: "shopuuid",
      scopes: ["read"],
    });

    expect(out.access_token).toMatch(/^cala_[a-z2-7]{32}$/);
    expect(out.refresh_token).toMatch(/^calr_[a-z2-7]{32}$/);
    expect(out.expires_in).toBe(60 * 60 * 24 * 90);

    expect(insertMock).toHaveBeenCalledOnce();
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.auth_type).toBe("oauth");
    expect(row.client_id).toBe("cal_client_x");
    expect(row.scopes).toEqual(["read"]);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 89 * 86400 * 1000);
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

Run: `npx vitest run app/lib/__tests__/mcp_oauth_tokens.test.ts`
Expected: FAIL — `mintAccessToken` not exported.

- [ ] **Step 3:** Implement.

Append to `app/lib/mcp_tokens.server.ts`:

```typescript
import { newAccessToken, newRefreshToken } from "./mcp_oauth.server";

export interface MintAccessTokenReq {
  client_id: string;
  client_name: string;
  shop_id: string;
  scopes: string[];
}

export interface MintAccessTokenResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
}

const ACCESS_TTL_SEC = 60 * 60 * 24 * 90;   // 90d

export async function mintAccessToken(req: MintAccessTokenReq): Promise<MintAccessTokenResult> {
  const access_token = newAccessToken();
  const refresh_token = newRefreshToken();
  const token_hash = hashToken(access_token);
  const refresh_hash = hashToken(refresh_token);
  const expires_at = new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString();
  const prefix = access_token.slice(0, 9); // "cala_" + first 4 body chars

  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .insert({
      shop_id: req.shop_id,
      name: `${req.client_name} (${req.client_id.slice(-8)})`,
      token_hash,
      token_prefix: prefix,
      scopes: req.scopes,
      auth_type: "oauth",
      client_id: req.client_id,
      expires_at,
      refresh_hash,
    })
    .select("id")
    .single();
  if (error) throw error;
  void data;

  return {
    access_token,
    refresh_token,
    expires_in: ACCESS_TTL_SEC,
    token_type: "Bearer",
    scope: req.scopes.join(" "),
  };
}
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/lib/mcp_tokens.server.ts app/lib/__tests__/mcp_oauth_tokens.test.ts
git commit -m "lib: mintAccessToken (90d access + refresh, oauth row)"
```

### Task 4.2: `rotateRefreshToken({refresh_token, client_id})`

Rotation rule: look up by `refresh_hash`, verify `client_id`, then replace `token_hash`, `refresh_hash`, `expires_at`, `token_prefix` on the same row. Old hashes gone — any replay of the old refresh fails.

**Files:** Modify `app/lib/mcp_tokens.server.ts`, extend test file.

- [ ] **Step 1:** Add a richer mock supporting `.select().eq().maybeSingle()` and `.update().eq().select()` chains. Then add tests.

(Use the same chain-fake pattern as Task 3.2.)

```typescript
import { rotateRefreshToken } from "../mcp_tokens.server";

describe("rotateRefreshToken", () => {
  it("returns a new pair and replaces hashes on the same row", async () => {
    // lookup returns an active OAuth row
    maybeSingleMock.mockResolvedValue({
      data: {
        id: "tokenuuid",
        shop_id: "shopuuid",
        client_id: "cal_client_x",
        scopes: ["read"],
        revoked_at: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      error: null,
    });
    updateSelectMock.mockResolvedValue({ data: [{ id: "tokenuuid" }], error: null });

    const out = await rotateRefreshToken({ refresh_token: "calr_xxx", client_id: "cal_client_x" });
    expect(out.access_token).toMatch(/^cala_/);
    expect(out.refresh_token).toMatch(/^calr_/);
    expect(out.access_token).not.toBe("calr_xxx");
  });

  it("rejects unknown refresh_token", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when client_id doesn't match", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: "x", shop_id: "s", client_id: "other", scopes: [], revoked_at: null, expires_at: null },
      error: null,
    });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("rejects revoked token", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: "x", shop_id: "s", client_id: "c", scopes: [], revoked_at: new Date().toISOString() },
      error: null,
    });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when atomic update returns zero rows (concurrent rotation)", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: "x", shop_id: "s", client_id: "c", scopes: ["read"], revoked_at: null },
      error: null,
    });
    updateSelectMock.mockResolvedValue({ data: [], error: null });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement.

```typescript
export interface RotateRefreshReq {
  refresh_token: string;
  client_id: string;
}

export async function rotateRefreshToken(
  req: RotateRefreshReq,
): Promise<MintAccessTokenResult> {
  const old_refresh_hash = hashToken(req.refresh_token);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .select("id, shop_id, client_id, scopes, revoked_at")
    .eq("refresh_hash", old_refresh_hash)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const e = new Error("invalid_grant: unknown refresh_token") as Error & { code: string };
    e.code = "invalid_grant";
    throw e;
  }
  if (data.client_id !== req.client_id) {
    const e = new Error("invalid_grant: client_id mismatch") as Error & { code: string };
    e.code = "invalid_grant";
    throw e;
  }
  if (data.revoked_at) {
    const e = new Error("invalid_grant: revoked") as Error & { code: string };
    e.code = "invalid_grant";
    throw e;
  }

  const new_access = newAccessToken();
  const new_refresh = newRefreshToken();
  const new_token_hash = hashToken(new_access);
  const new_refresh_hash = hashToken(new_refresh);
  const new_expires_at = new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString();
  const new_prefix = new_access.slice(0, 9);

  // Atomic rotation: only update if refresh_hash still matches the old one we read.
  const { data: updated, error: uerr } = await getSupabase()
    .from("mcp_tokens")
    .update({
      token_hash: new_token_hash,
      refresh_hash: new_refresh_hash,
      token_prefix: new_prefix,
      expires_at: new_expires_at,
    })
    .eq("id", data.id)
    .eq("refresh_hash", old_refresh_hash)
    .select("id");
  if (uerr) throw uerr;
  if (!Array.isArray(updated) || updated.length === 0) {
    const e = new Error("invalid_grant: concurrent rotation") as Error & { code: string };
    e.code = "invalid_grant";
    throw e;
  }

  return {
    access_token: new_access,
    refresh_token: new_refresh,
    expires_in: ACCESS_TTL_SEC,
    token_type: "Bearer",
    scope: (data.scopes as string[]).join(" "),
  };
}
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/lib/mcp_tokens.server.ts app/lib/__tests__/mcp_oauth_tokens.test.ts
git commit -m "lib: rotateRefreshToken (atomic, replay-detectable)"
```

### Task 4.3: `listOauthGrants(shop)` + `revokeOauthGrant(token_id)`

These power the "Connected Claude.ai workspaces" card in §8.5.

**Files:** Modify `app/lib/mcp_tokens.server.ts` + test file.

- [ ] **Step 1:** Add tests.

```typescript
import { listOauthGrants, revokeOauthGrant } from "../mcp_tokens.server";

describe("listOauthGrants", () => {
  it("filters by shop and auth_type='oauth' and revoked_at IS NULL", async () => {
    selectMock.mockReset();
    eqMock.mockReset();
    // call signature for chained eq()s, then order()
    // mock as needed
    // (For brevity, assume chain returns a final orderMock that resolves to {data: [...]})
  });
});
```

(Test bodies will mirror the existing `listMcpTokens` test patterns.)

- [ ] **Step 2:** Implement.

```typescript
export interface OauthGrantRow {
  id: string;
  name: string;
  client_id: string | null;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export async function listOauthGrants(shopDomain: string): Promise<OauthGrantRow[]> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .select("id, name, client_id, scopes, created_at, last_used_at, expires_at")
    .eq("shop_id", shopId)
    .eq("auth_type", "oauth")
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OauthGrantRow[];
}

export async function revokeOauthGrant(opts: { shopDomain: string; tokenId: string }): Promise<void> {
  const shopId = await resolveShopId(opts.shopDomain);
  const { error } = await getSupabase()
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString(), refresh_hash: null })
    .eq("shop_id", shopId)
    .eq("id", opts.tokenId)
    .eq("auth_type", "oauth")
    .is("revoked_at", null);
  if (error) throw error;
}
```

(Setting `refresh_hash = null` on revoke makes any in-flight rotation attempt fail by `unknown refresh_token`.)

- [ ] **Step 3:** Pass + commit.

```bash
git add app/lib/mcp_tokens.server.ts app/lib/__tests__/mcp_oauth_tokens.test.ts
git commit -m "lib: listOauthGrants + revokeOauthGrant (workspace mgmt)"
```

---

## Phase 5 — Discovery endpoint

Static JSON exposing the AS metadata. Gated on `MCP_OAUTH_ENABLED=true` so the rollout can flip atomically.

### Task 5.1: `.well-known/oauth-authorization-server` route

**Files:** Create `app/routes/[.]well-known.oauth-authorization-server.tsx`.

- [ ] **Step 1:** Write the file.

```tsx
// app/routes/[.]well-known.oauth-authorization-server.tsx
//
// RFC 8414 Authorization Server Metadata.
// Gated on MCP_OAUTH_ENABLED — when disabled, 404 so the rollout flag is total.
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request: _ }: LoaderFunctionArgs) => {
  if (process.env.MCP_OAUTH_ENABLED !== "true") {
    return new Response("Not Found", { status: 404 });
  }
  const issuer = process.env.SHOPIFY_APP_URL || "https://app.calderyncompany.com";
  return json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read"],
  });
};
```

- [ ] **Step 2:** Smoke test against dev server.

```bash
MCP_OAUTH_ENABLED=true npm run dev
# in a second terminal:
curl -sS http://localhost:3000/.well-known/oauth-authorization-server | head -20
```
Expected: JSON document with the eight fields above.

- [ ] **Step 3:** Confirm 404 when flag is off.

```bash
MCP_OAUTH_ENABLED=false npm run dev
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/.well-known/oauth-authorization-server
```
Expected: `404`.

- [ ] **Step 4:** Commit.

```bash
git add "app/routes/[.]well-known.oauth-authorization-server.tsx"
git commit -m "routes: .well-known/oauth-authorization-server (flag-gated)"
```

---

## Phase 6 — DCR endpoint

### Task 6.1: `/oauth/register` POST action

**Files:** Create `app/routes/oauth.register.tsx`, create `app/routes/__tests__/oauth-register.test.ts`.

- [ ] **Step 1:** Write the test.

```typescript
// app/routes/__tests__/oauth-register.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/mcp_oauth.server", () => ({
  registerClient: vi.fn(),
}));

import { registerClient } from "../../lib/mcp_oauth.server";
import { action } from "../oauth.register";

describe("/oauth/register POST", () => {
  it("404s when MCP_OAUTH_ENABLED is not true", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const res = await action({
      request: new Request("http://x/oauth/register", { method: "POST", body: "{}" }),
    } as never);
    expect(res.status).toBe(404);
  });

  it("400s on non-JSON body", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    const res = await action({
      request: new Request("http://x/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    } as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe("invalid_client_metadata");
  });

  it("returns 201 with DCR response on valid body", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    (registerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const res = await action({
      request: new Request("http://x/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: ["https://claude.ai/cb"],
        }),
      }),
    } as never);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.client_id).toBe("cal_client_x");
  });

  it("maps INVALID_REDIRECT_URI to 400 invalid_redirect_uri", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    const err = Object.assign(new Error("bad"), { code: "INVALID_REDIRECT_URI" });
    (registerClient as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const res = await action({
      request: new Request("http://x/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["http://insecure/cb"] }),
      }),
    } as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe("invalid_redirect_uri");
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement.

```tsx
// app/routes/oauth.register.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { registerClient } from "~/lib/mcp_oauth.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "body must be valid JSON" }, { status: 400 });
  }

  const payload = body as {
    client_name?: string;
    redirect_uris?: string[];
    software_id?: string;
    software_version?: string;
  };

  try {
    const out = await registerClient({
      client_name: payload.client_name ?? "",
      redirect_uris: payload.redirect_uris ?? [],
      software_id: payload.software_id,
      software_version: payload.software_version,
    });
    return json(out, { status: 201 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = err.code ?? "invalid_client_metadata";
    const mapped =
      code === "INVALID_REDIRECT_URI"
        ? "invalid_redirect_uri"
        : code === "TOO_MANY_REDIRECT_URIS"
        ? "invalid_redirect_uri"
        : code === "INVALID_CLIENT_NAME"
        ? "invalid_client_metadata"
        : "invalid_client_metadata";
    return json({ error: mapped, error_description: err.message ?? "registration failed" }, { status: 400 });
  }
};

export const loader = () => new Response("Method Not Allowed", { status: 405 });
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/routes/oauth.register.tsx app/routes/__tests__/oauth-register.test.ts
git commit -m "routes: /oauth/register (RFC 7591 DCR)"
```

### Task 6.2: Simple per-IP rate limit on DCR (Vercel KV-backed)

Skip for now if no KV is provisioned; document in the rollout phase. The data layer for it lives at `app/lib/rate_limit.server.ts` and can be added later without spec churn. For this plan, add a comment in `oauth.register.tsx` action body:

```typescript
// TODO(post-ship): add per-IP rate limit (10/hr) via Vercel KV before public launch.
//   See docs/superpowers/specs/2026-06-08-claude-connector-oauth-design.md §8.3.
```

- [ ] **Step 1:** Add the comment.
- [ ] **Step 2:** Commit.

```bash
git add app/routes/oauth.register.tsx
git commit -m "routes: dcr todo for post-ship rate limit"
```

---

## Phase 7 — Authorize endpoint: param validation

The authorize endpoint is large enough that we build it in three slices. Phase 7 handles **only** param validation and the "render which-shop form" path. Phase 8 adds the signed cookie + Shopify-OAuth handoff. Phase 9 wires the post-auth pickup.

### Task 7.1: Authorize loader — validate inputs

**Files:** Create `app/routes/oauth.authorize.tsx`, create `app/routes/__tests__/oauth-authorize.test.ts`.

- [ ] **Step 1:** Write the test.

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/mcp_oauth.server", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "../../lib/mcp_oauth.server";
import { loader } from "../oauth.authorize";

const VALID_PARAMS = {
  response_type: "code",
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  scope: "read",
  state: "abc",
};

function reqWith(params: Record<string, string>): { request: Request } {
  const url = new URL("http://x/oauth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { request: new Request(url.toString()) };
}

describe("/oauth/authorize loader", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_ENABLED = "true";
    (getClient as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("404 when MCP_OAUTH_ENABLED is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(404);
  });

  it("400 on missing required params (no redirect since redirect_uri unknown)", async () => {
    const r = await loader(reqWith({ ...VALID_PARAMS, response_type: "" }) as never);
    expect(r.status).toBe(400);
  });

  it("400 on unknown client_id", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(400);
  });

  it("400 when redirect_uri not in client whitelist (no redirect)", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x", client_name: "Claude",
      redirect_uris: ["https://other.example/cb"], token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(400);
  });

  it("302 to redirect_uri with error=invalid_request on bad code_challenge_method", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x", client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith({ ...VALID_PARAMS, code_challenge_method: "plain" }) as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(r.headers.get("location")).toContain("error=invalid_request");
    expect(r.headers.get("location")).toContain("state=abc");
  });

  it("renders the which-shop page when no ?shop= and all params are valid", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x", client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(200); // json with phase: 'pick-shop'
    const j = await r.json();
    expect(j.phase).toBe("pick-shop");
    expect(j.client_name).toBe("Claude");
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement (loader only; action comes in Phase 8/10).

```tsx
// app/routes/oauth.authorize.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { getClient } from "~/lib/mcp_oauth.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
  shop?: string;
}

function readParams(url: URL): AuthorizeParams {
  const p = (k: string) => url.searchParams.get(k) ?? "";
  return {
    response_type: p("response_type"),
    client_id: p("client_id"),
    redirect_uri: p("redirect_uri"),
    code_challenge: p("code_challenge"),
    code_challenge_method: p("code_challenge_method") || "S256",
    scope: p("scope") || "read",
    state: p("state"),
    shop: url.searchParams.get("shop") ?? undefined,
  };
}

function redirectError(
  params: AuthorizeParams,
  code: "invalid_request" | "unsupported_response_type" | "access_denied",
  detail: string,
): Response {
  const url = new URL(params.redirect_uri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", detail);
  if (params.state) url.searchParams.set("state", params.state);
  return redirect(url.toString(), 302);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const params = readParams(url);

  // Before we can safely redirect to redirect_uri with an error, we must validate
  // client_id + redirect_uri. Other errors get redirected per OAuth.
  if (!params.response_type || !params.client_id || !params.redirect_uri ||
      !params.code_challenge || !params.state) {
    return new Response("invalid_request: missing required parameter", { status: 400 });
  }

  const client = await getClient(params.client_id);
  if (!client) return new Response("invalid_request: unknown client_id", { status: 400 });
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return new Response("invalid_request: redirect_uri not registered", { status: 400 });
  }

  // From here on, redirect_uri is safe to redirect to.
  if (params.response_type !== "code") {
    return redirectError(params, "unsupported_response_type", "only 'code' is supported");
  }
  if (params.code_challenge_method !== "S256") {
    return redirectError(params, "invalid_request", "code_challenge_method must be S256");
  }
  if (params.scope && params.scope.split(" ").some((s) => s !== "read")) {
    return redirectError(params, "invalid_request", "only scope=read is supported in v1");
  }

  // Phase 7 stops here: render the which-shop pick-up page.
  // Phases 8–10 add the cookie + consent action.
  return json({
    phase: "pick-shop",
    client_name: client.client_name,
    client_id: client.client_id,
  });
};
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/routes/oauth.authorize.tsx app/routes/__tests__/oauth-authorize.test.ts
git commit -m "routes: /oauth/authorize loader (param validation only)"
```

---

## Phase 8 — Authorize endpoint: shop identity via signed cookie

The signed cookie pattern: when we redirect off to `/auth/login`, we stash the OAuth context in a `__cal_pending_oauth` cookie (10-min TTL, HMAC-signed using `MCP_OAUTH_COOKIE_SECRET`). After Shopify OAuth completes, the user lands on `/app/_index.tsx`; that loader checks the cookie and 302s to `/oauth/consent`.

### Task 8.1: Cookie sign/verify helpers

**Files:** Modify `app/lib/mcp_oauth.server.ts` + the pkce test file.

- [ ] **Step 1:** Test.

```typescript
// in mcp_oauth_pkce.test.ts
import { signPendingOauth, verifyPendingOauth } from "../mcp_oauth.server";

const ctx = {
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "ch",
  scope: "read",
  state: "abc",
  shop: "myshop.myshopify.com",
};

describe("pending OAuth cookie", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  });

  it("round-trips a signed payload", async () => {
    const jwt = await signPendingOauth(ctx);
    expect(typeof jwt).toBe("string");
    const decoded = await verifyPendingOauth(jwt);
    expect(decoded).toMatchObject(ctx);
  });

  it("rejects a tampered payload", async () => {
    const jwt = await signPendingOauth(ctx);
    const tampered = jwt.slice(0, -1) + (jwt.endsWith("a") ? "b" : "a");
    await expect(verifyPendingOauth(tampered)).rejects.toThrow();
  });

  it("rejects an expired payload", async () => {
    const jwt = await signPendingOauth(ctx, { ttlSec: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    await expect(verifyPendingOauth(jwt)).rejects.toThrow();
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement.

```typescript
import { SignJWT, jwtVerify } from "jose";

export interface PendingOauthCtx {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  state: string;
  shop: string;
}

function cookieKey(): Uint8Array {
  const hex = process.env.MCP_OAUTH_COOKIE_SECRET ?? "";
  if (hex.length < 64) throw new Error("MCP_OAUTH_COOKIE_SECRET must be 64+ hex chars");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

const PENDING_TTL_SEC = 10 * 60;

export async function signPendingOauth(
  ctx: PendingOauthCtx,
  opts: { ttlSec?: number } = {},
): Promise<string> {
  const ttl = opts.ttlSec ?? PENDING_TTL_SEC;
  return new SignJWT({ ...ctx })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(cookieKey());
}

export async function verifyPendingOauth(token: string): Promise<PendingOauthCtx> {
  const { payload } = await jwtVerify(token, cookieKey(), { algorithms: ["HS256"] });
  return {
    client_id: String(payload.client_id),
    redirect_uri: String(payload.redirect_uri),
    code_challenge: String(payload.code_challenge),
    scope: String(payload.scope),
    state: String(payload.state),
    shop: String(payload.shop),
  };
}

export const PENDING_COOKIE_NAME = "__cal_pending_oauth";
export const PENDING_COOKIE_OPTS = `Path=/; Max-Age=${PENDING_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/lib/mcp_oauth.server.ts app/lib/__tests__/mcp_oauth_pkce.test.ts
git commit -m "lib: pending-oauth jwt cookie (HS256, 10m ttl)"
```

### Task 8.2: Authorize action — pick-shop POST sets cookie + redirects to /auth/login

**Files:** Modify `app/routes/oauth.authorize.tsx`, extend `app/routes/__tests__/oauth-authorize.test.ts`.

- [ ] **Step 1:** Add tests.

```typescript
import { action } from "../oauth.authorize";

describe("/oauth/authorize POST (pick-shop)", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_ENABLED = "true";
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x", client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "none",
    });
  });

  it("400s when shop is empty", async () => {
    const form = new FormData();
    form.set("shop", "");
    for (const [k, v] of Object.entries(VALID_PARAMS)) form.set(k, v);
    const res = await action({
      request: new Request("http://x/oauth/authorize", { method: "POST", body: form }),
    } as never);
    expect(res.status).toBe(400);
  });

  it("400s on non-myshopify.com shop", async () => {
    const form = new FormData();
    form.set("shop", "not-shopify");
    for (const [k, v] of Object.entries(VALID_PARAMS)) form.set(k, v);
    const res = await action({
      request: new Request("http://x/oauth/authorize", { method: "POST", body: form }),
    } as never);
    expect(res.status).toBe(400);
  });

  it("sets pending cookie and redirects to /auth/login on valid shop", async () => {
    const form = new FormData();
    form.set("shop", "myshop.myshopify.com");
    for (const [k, v] of Object.entries(VALID_PARAMS)) form.set(k, v);
    const res = await action({
      request: new Request("http://x/oauth/authorize", { method: "POST", body: form }),
    } as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login?shop=myshop.myshopify.com");
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("__cal_pending_oauth=");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Secure");
  });
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Implement.

Append to `app/routes/oauth.authorize.tsx`:

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { signPendingOauth, PENDING_COOKIE_NAME, PENDING_COOKIE_OPTS } from "~/lib/mcp_oauth.server";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const params: AuthorizeParams = {
    response_type: String(form.get("response_type") ?? ""),
    client_id: String(form.get("client_id") ?? ""),
    redirect_uri: String(form.get("redirect_uri") ?? ""),
    code_challenge: String(form.get("code_challenge") ?? ""),
    code_challenge_method: String(form.get("code_challenge_method") ?? "S256"),
    scope: String(form.get("scope") ?? "read"),
    state: String(form.get("state") ?? ""),
    shop: String(form.get("shop") ?? "").trim().toLowerCase(),
  };

  // Re-validate (this endpoint is also reachable via direct POST)
  const client = await getClient(params.client_id);
  if (!client) return new Response("invalid_request", { status: 400 });
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return new Response("invalid_request", { status: 400 });
  }
  if (!params.shop || !SHOP_RE.test(params.shop)) {
    return new Response("invalid_shop", { status: 400 });
  }

  const jwt = await signPendingOauth({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    state: params.state,
    shop: params.shop,
  });

  const headers = new Headers();
  headers.append("set-cookie", `${PENDING_COOKIE_NAME}=${jwt}; ${PENDING_COOKIE_OPTS}`);
  headers.set("location", `/auth/login?shop=${encodeURIComponent(params.shop)}`);
  return new Response(null, { status: 302, headers });
};
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/routes/oauth.authorize.tsx app/routes/__tests__/oauth-authorize.test.ts
git commit -m "routes: /oauth/authorize POST sets pending cookie, hands off to /auth/login"
```

### Task 8.3: Authorize loader — `?shop=` shortcut

If the loader sees `?shop=...`, skip the pick-shop form and behave as if the POST had been submitted (set cookie, redirect to /auth/login).

- [ ] **Step 1:** Add test.

```typescript
it("with ?shop=...: sets cookie and 302s to /auth/login", async () => {
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    client_id: "cal_client_x", client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "none",
  });
  const r = await loader(reqWith({ ...VALID_PARAMS, shop: "myshop.myshopify.com" }) as never);
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toContain("/auth/login?shop=myshop.myshopify.com");
  expect(r.headers.get("set-cookie") ?? "").toContain("__cal_pending_oauth=");
});
```

- [ ] **Step 2:** Implement.

In the loader, before the final `return json({phase:"pick-shop", ...})`, insert:

```typescript
const shop = url.searchParams.get("shop")?.toLowerCase();
if (shop && SHOP_RE.test(shop)) {
  const jwt = await signPendingOauth({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    state: params.state,
    shop,
  });
  const headers = new Headers();
  headers.append("set-cookie", `${PENDING_COOKIE_NAME}=${jwt}; ${PENDING_COOKIE_OPTS}`);
  headers.set("location", `/auth/login?shop=${encodeURIComponent(shop)}`);
  return new Response(null, { status: 302, headers });
}
```

- [ ] **Step 3:** Pass + commit.

```bash
git add app/routes/oauth.authorize.tsx app/routes/__tests__/oauth-authorize.test.ts
git commit -m "routes: /oauth/authorize ?shop= shortcut skips pick-shop form"
```

### Task 8.4: Render the pick-shop Polaris page

**Files:** Modify `app/routes/oauth.authorize.tsx`.

- [ ] **Step 1:** Add the default export.

```tsx
import { useState } from "react";
import { Form, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export default function AuthorizePickShop() {
  const data = useLoaderData<typeof loader>() as {
    phase: "pick-shop"; client_name: string; client_id: string;
  };
  const [shop, setShop] = useState("");
  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title="Connect Claude.ai">
        <Card>
          <Form method="post">
            <FormLayout>
              <Text variant="bodyMd" as="p">
                <b>{data.client_name}</b> is asking to connect to your Calderyn data.
                Enter your shop domain to sign in and approve.
              </Text>
              <TextField
                type="text"
                name="shop"
                label="Shop domain"
                helpText="example.myshopify.com"
                value={shop}
                onChange={setShop}
                autoComplete="on"
              />
              {/* Re-forward the OAuth params so the action knows what to bind */}
              {(["response_type","client_id","redirect_uri","code_challenge",
                 "code_challenge_method","scope","state"] as const).map((k) => (
                <input key={k} type="hidden" name={k} value={
                  new URLSearchParams(globalThis.location?.search ?? "").get(k) ?? ""
                } />
              ))}
              <Button submit>Continue</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
```

(Hidden inputs reading `globalThis.location.search` works because Polaris pick-shop pages render client-side; for SSR alignment, prefer rendering them from loader data. See Phase 9 cleanup.)

- [ ] **Step 2:** Manual smoke.

```bash
MCP_OAUTH_ENABLED=true MCP_OAUTH_COOKIE_SECRET=$(openssl rand -hex 32) npm run dev
# In browser:
# open http://localhost:3000/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&code_challenge=x&state=y
# (first register a client_id via /oauth/register manually)
```

- [ ] **Step 3:** Commit.

```bash
git add app/routes/oauth.authorize.tsx
git commit -m "routes: /oauth/authorize Polaris pick-shop UI"
```

---

## Phase 9 — Post-auth handoff

### Task 9.1: app/_index.tsx — pending-OAuth short-circuit

**Files:** Modify `app/routes/app._index.tsx`.

- [ ] **Step 1:** Read existing loader.

Run: `head -40 app/routes/app._index.tsx`

- [ ] **Step 2:** Add at the top of the loader, before any data fetching:

```typescript
import { PENDING_COOKIE_NAME, verifyPendingOauth } from "~/lib/mcp_oauth.server";

// Inside the existing loader, right after `const { session } = await authenticate.admin(request);`:
const cookieHeader = request.headers.get("cookie") ?? "";
const m = cookieHeader.match(new RegExp(`${PENDING_COOKIE_NAME}=([^;]+)`));
if (m) {
  try {
    const ctx = await verifyPendingOauth(m[1]);
    if (ctx.shop === session.shop) {
      return redirect("/oauth/consent");
    }
  } catch {
    // expired / tampered / wrong shop — fall through to normal dashboard load
  }
}
```

- [ ] **Step 3:** Run the existing dashboard test to confirm no regression.

Run: `npx vitest run app/routes/__tests__/`
Expected: PASS (any dashboard-loader test should still pass; the new branch is exercised only when the cookie is present).

- [ ] **Step 4:** Commit.

```bash
git add app/routes/app._index.tsx
git commit -m "routes: app._index short-circuits to /oauth/consent when pending OAuth cookie matches session"
```

---

## Phase 10 — Consent endpoint

### Task 10.1: `/oauth/consent` loader — render consent screen

**Files:** Create `app/routes/oauth.consent.tsx`, create `app/routes/__tests__/oauth-consent.test.ts`.

- [ ] **Step 1:** Test loader.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PENDING_COOKIE_NAME, signPendingOauth } from "../../lib/mcp_oauth.server";

vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));
vi.mock("../../lib/mcp_oauth.server", async (original) => {
  const actual = await (original as () => Promise<unknown>)();
  return { ...(actual as Record<string, unknown>), getClient: vi.fn() };
});

import { authenticate } from "../../shopify.server";
import { getClient } from "../../lib/mcp_oauth.server";
import { loader } from "../oauth.consent";

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
});

describe("/oauth/consent loader", () => {
  it("404s when flag off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = await loader({ request: new Request("http://x/oauth/consent") } as never);
    expect(r.status).toBe(404);
  });

  it("redirects to /app when no pending cookie", async () => {
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    const r = await loader({ request: new Request("http://x/oauth/consent") } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("renders consent JSON when cookie + session match", async () => {
    const jwt = await signPendingOauth({
      client_id: "cal_client_x", redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch", scope: "read", state: "abc",
      shop: "myshop.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });

    const r = await loader({
      request: new Request("http://x/oauth/consent", {
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.shop).toBe("myshop.myshopify.com");
    expect(j.scopes).toEqual(["read"]);
  });

  it("redirects to /app when shop in cookie != session.shop", async () => {
    const jwt = await signPendingOauth({
      client_id: "cal_client_x", redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch", scope: "read", state: "abc",
      shop: "OTHER.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    const r = await loader({
      request: new Request("http://x/oauth/consent", {
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
      }),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });
});
```

- [ ] **Step 2:** Run, fail.

- [ ] **Step 3:** Implement loader.

```tsx
// app/routes/oauth.consent.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  PENDING_COOKIE_NAME,
  verifyPendingOauth,
  getClient,
} from "~/lib/mcp_oauth.server";
import { authenticate } from "../shopify.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  const m = h.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);

  const raw = readCookie(request, PENDING_COOKIE_NAME);
  if (!raw) return redirect("/app");

  let ctx;
  try {
    ctx = await verifyPendingOauth(raw);
  } catch {
    return redirect("/app");
  }
  if (ctx.shop !== session.shop) return redirect("/app");

  const client = await getClient(ctx.client_id);
  if (!client) return redirect("/app");

  return json({
    client_name: client.client_name,
    client_id: client.client_id,
    shop: session.shop,
    scopes: ctx.scope.split(" ").filter(Boolean),
  });
};
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/routes/oauth.consent.tsx app/routes/__tests__/oauth-consent.test.ts
git commit -m "routes: /oauth/consent loader (verifies cookie + session match)"
```

### Task 10.2: Consent action — Allow/Deny

**Files:** Modify `app/routes/oauth.consent.tsx`, extend test file.

- [ ] **Step 1:** Add tests.

```typescript
import { action } from "../oauth.consent";

describe("/oauth/consent action", () => {
  it("Allow mints code, clears cookie, 302s to redirect_uri with code+state", async () => {
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
    const jwt = await signPendingOauth({
      client_id: "cal_client_x", redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch", scope: "read", state: "abc",
      shop: "myshop.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com", id: "sess-1" },
    });
    // Mock issueAuthCode to return a fixed code
    const issueAuthCodeMock = vi.fn().mockResolvedValue("calc_zzz");
    vi.doMock("../../lib/mcp_oauth.server", async (original) => {
      const actual = await (original as () => Promise<unknown>)();
      return { ...(actual as Record<string, unknown>), issueAuthCode: issueAuthCodeMock };
    });
    // resolveShopId returns the merchant shop UUID
    vi.doMock("../../lib/supabase.server", () => ({
      resolveShopId: vi.fn().mockResolvedValue("shopuuid"),
    }));

    const form = new FormData();
    form.set("intent", "allow");
    const r = await action({
      request: new Request("http://x/oauth/consent", {
        method: "POST",
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
        body: form,
      }),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(r.headers.get("location")).toContain("code=calc_zzz");
    expect(r.headers.get("location")).toContain("state=abc");
    expect(r.headers.get("set-cookie") ?? "").toContain(`${PENDING_COOKIE_NAME}=;`);
  });

  it("Deny redirects with error=access_denied", async () => {
    // setup like Allow case but submit intent=deny
    // expect location includes error=access_denied&state=abc
  });
});
```

- [ ] **Step 2:** Implement.

```tsx
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const raw = readCookie(request, PENDING_COOKIE_NAME);
  if (!raw) return redirect("/app");
  let ctx;
  try { ctx = await verifyPendingOauth(raw); } catch { return redirect("/app"); }
  if (ctx.shop !== session.shop) return redirect("/app");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const clearCookie = `${PENDING_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

  if (intent === "deny") {
    const url = new URL(ctx.redirect_uri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "merchant denied authorization");
    if (ctx.state) url.searchParams.set("state", ctx.state);
    const headers = new Headers({ location: url.toString() });
    headers.append("set-cookie", clearCookie);
    return new Response(null, { status: 302, headers });
  }

  if (intent !== "allow") return new Response("invalid_intent", { status: 400 });

  // resolveShopId is the existing helper used by mcp_tokens.server.ts
  const { resolveShopId } = await import("~/lib/supabase.server");
  const { issueAuthCode } = await import("~/lib/mcp_oauth.server");
  const shop_id = await resolveShopId(session.shop);

  const code = await issueAuthCode({
    client_id: ctx.client_id,
    shop_id,
    redirect_uri: ctx.redirect_uri,
    code_challenge: ctx.code_challenge,
    scopes: ctx.scope.split(" ").filter(Boolean),
    state: ctx.state,
  });

  const url = new URL(ctx.redirect_uri);
  url.searchParams.set("code", code);
  if (ctx.state) url.searchParams.set("state", ctx.state);
  const headers = new Headers({ location: url.toString() });
  headers.append("set-cookie", clearCookie);
  return new Response(null, { status: 302, headers });
};
```

- [ ] **Step 3:** Pass + commit.

```bash
git add app/routes/oauth.consent.tsx app/routes/__tests__/oauth-consent.test.ts
git commit -m "routes: /oauth/consent action (allow/deny + code mint + cookie clear)"
```

### Task 10.3: Polaris consent UI

**Files:** Modify `app/routes/oauth.consent.tsx`.

- [ ] **Step 1:** Add the default export.

```tsx
import { Form, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Page,
  Text,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export default function Consent() {
  const { client_name, shop, scopes } = useLoaderData<typeof loader>() as {
    client_name: string; shop: string; scopes: string[];
  };
  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title={`Connect ${client_name} to Calderyn`}>
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              <b>{client_name}</b> is requesting access to your Calderyn data for <b>{shop}</b>.
            </Text>
            <Text as="p" variant="bodyMd">
              Permissions requested:
            </Text>
            <Text as="p" variant="bodyMd">
              {scopes.includes("read") &&
                "• Read your alerts, audit log, campaigns, SKUs, guardrails, and integration status."}
            </Text>
            <Banner tone="info">
              <p>You can disconnect this at any time from <b>Settings → Claude connections</b>.</p>
            </Banner>
            <Form method="post">
              <ButtonGroup>
                <Button submit name="intent" value="allow" variant="primary">Allow</Button>
                <Button submit name="intent" value="deny">Deny</Button>
              </ButtonGroup>
            </Form>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
```

- [ ] **Step 2:** Manual smoke end-to-end:
  1. Start dev server with flags.
  2. POST to `/oauth/register` to get a `client_id`.
  3. Open `/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=abc&scope=read` in browser.
  4. Pick shop, complete Shopify OAuth, land on consent, click Allow → expect 302 to redirect_uri with `code=…&state=abc`.

- [ ] **Step 3:** Commit.

```bash
git add app/routes/oauth.consent.tsx
git commit -m "routes: /oauth/consent Polaris UI"
```

---

## Phase 11 — Token endpoint: `authorization_code` grant

### Task 11.1: `/oauth/token` POST action — code exchange

**Files:** Create `app/routes/oauth.token.tsx`, create `app/routes/__tests__/oauth-token.test.ts`.

- [ ] **Step 1:** Test.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../lib/mcp_oauth.server", () => ({
  consumeAuthCode: vi.fn(),
}));
vi.mock("../../lib/mcp_tokens.server", () => ({
  mintAccessToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
}));
import { consumeAuthCode } from "../../lib/mcp_oauth.server";
import { mintAccessToken } from "../../lib/mcp_tokens.server";
import { action } from "../oauth.token";

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  (consumeAuthCode as unknown as ReturnType<typeof vi.fn>).mockReset();
  (mintAccessToken as unknown as ReturnType<typeof vi.fn>).mockReset();
});

function form(body: Record<string, string>): Request {
  const f = new URLSearchParams(body);
  return new Request("http://x/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: f.toString(),
  });
}

describe("/oauth/token POST (authorization_code)", () => {
  it("400s when grant_type missing", async () => {
    const r = await action({ request: form({}) } as never);
    expect(r.status).toBe(400);
  });

  it("400s on unsupported grant_type", async () => {
    const r = await action({ request: form({ grant_type: "password" }) } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("unsupported_grant_type");
  });

  it("exchanges code + verifier for access + refresh", async () => {
    (consumeAuthCode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop_id: "s1", scopes: ["read"],
    });
    (mintAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "cala_x", refresh_token: "calr_x", expires_in: 7776000,
      token_type: "Bearer", scope: "read",
    });
    // Need getClient to resolve the client name for mintAccessToken;
    // mock through the mcp_oauth.server module
    const r = await action({
      request: form({
        grant_type: "authorization_code",
        code: "calc_zzz",
        code_verifier: "v".repeat(43),
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_x",
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.access_token).toBe("cala_x");
    expect(j.refresh_token).toBe("calr_x");
    expect(j.token_type).toBe("Bearer");
  });

  it("400 invalid_grant on bad code", async () => {
    const err = Object.assign(new Error("nope"), { code: "invalid_grant" });
    (consumeAuthCode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const r = await action({
      request: form({
        grant_type: "authorization_code", code: "x",
        code_verifier: "v".repeat(43), redirect_uri: "u", client_id: "c",
      }),
    } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("invalid_grant");
  });
});
```

- [ ] **Step 2:** Run, fail.

- [ ] **Step 3:** Implement.

```tsx
// app/routes/oauth.token.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { consumeAuthCode, getClient } from "~/lib/mcp_oauth.server";
import { mintAccessToken, rotateRefreshToken } from "~/lib/mcp_tokens.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const grant_type = String(form.get("grant_type") ?? "");
  if (!grant_type) return json({ error: "invalid_request" }, { status: 400 });

  try {
    if (grant_type === "authorization_code") {
      const code = String(form.get("code") ?? "");
      const code_verifier = String(form.get("code_verifier") ?? "");
      const redirect_uri = String(form.get("redirect_uri") ?? "");
      const client_id = String(form.get("client_id") ?? "");
      if (!code || !code_verifier || !redirect_uri || !client_id) {
        return json({ error: "invalid_request" }, { status: 400 });
      }
      const client = await getClient(client_id);
      if (!client) return json({ error: "invalid_client" }, { status: 401 });

      const ctx = await consumeAuthCode({ raw_code: code, code_verifier, redirect_uri, client_id });
      const out = await mintAccessToken({
        client_id,
        client_name: client.client_name,
        shop_id: ctx.shop_id,
        scopes: ctx.scopes,
      });
      return json(out, {
        status: 200,
        headers: { "cache-control": "no-store", "pragma": "no-cache" },
      });
    }

    if (grant_type === "refresh_token") {
      const refresh_token = String(form.get("refresh_token") ?? "");
      const client_id = String(form.get("client_id") ?? "");
      if (!refresh_token || !client_id) return json({ error: "invalid_request" }, { status: 400 });
      const out = await rotateRefreshToken({ refresh_token, client_id });
      return json(out, {
        status: 200,
        headers: { "cache-control": "no-store", "pragma": "no-cache" },
      });
    }

    return json({ error: "unsupported_grant_type" }, { status: 400 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = err.code === "invalid_grant" ? "invalid_grant" : "invalid_request";
    return json({ error: code, error_description: err.message ?? "" }, { status: 400 });
  }
};

export const loader = () => new Response("Method Not Allowed", { status: 405 });
```

- [ ] **Step 4:** Pass + commit.

```bash
git add app/routes/oauth.token.tsx app/routes/__tests__/oauth-token.test.ts
git commit -m "routes: /oauth/token (authorization_code grant)"
```

---

## Phase 12 — Token endpoint: `refresh_token` grant

### Task 12.1: Refresh path test + verification

`rotateRefreshToken` is already imported in Phase 11. Add coverage and verify the response shape.

**Files:** Extend `app/routes/__tests__/oauth-token.test.ts`.

- [ ] **Step 1:** Add tests.

```typescript
import { rotateRefreshToken } from "../../lib/mcp_tokens.server";

describe("/oauth/token POST (refresh_token)", () => {
  it("rotates refresh and returns new pair", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    (rotateRefreshToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "cala_new", refresh_token: "calr_new", expires_in: 7776000,
      token_type: "Bearer", scope: "read",
    });
    const r = await action({
      request: form({
        grant_type: "refresh_token",
        refresh_token: "calr_old",
        client_id: "cal_client_x",
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.access_token).toBe("cala_new");
    expect(j.refresh_token).toBe("calr_new");
  });

  it("400 invalid_grant on rotation failure", async () => {
    const err = Object.assign(new Error("revoked"), { code: "invalid_grant" });
    (rotateRefreshToken as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const r = await action({
      request: form({ grant_type: "refresh_token", refresh_token: "x", client_id: "c" }),
    } as never);
    expect(r.status).toBe(400);
  });

  it("400 invalid_request on missing refresh_token", async () => {
    const r = await action({
      request: form({ grant_type: "refresh_token", client_id: "c" }),
    } as never);
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2:** Run.

Expected: all PASS (implementation already exists from Phase 11).

- [ ] **Step 3:** Commit.

```bash
git add app/routes/__tests__/oauth-token.test.ts
git commit -m "test: /oauth/token refresh_token grant coverage"
```

---

## Phase 13 — Revise `/app/mcp` page

### Task 13.1: Loader — also fetch OAuth grants

**Files:** Modify `app/routes/app.mcp.tsx`.

- [ ] **Step 1:** In the loader, add a parallel fetch:

```typescript
import { listOauthGrants } from "~/lib/mcp_tokens.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const [tokens, oauthGrants] = await Promise.all([
      listMcpTokens(session.shop),
      listOauthGrants(session.shop),
    ]);
    return json<LoaderPayload>({ tokens, oauthGrants, error: null });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json<LoaderPayload>({
      tokens: [], oauthGrants: [],
      error: { code: e.code ?? "ERROR", message: e.message ?? String(err) },
    });
  }
};
```

- [ ] **Step 2:** Extend `LoaderPayload` type with `oauthGrants: OauthGrantRow[]`.

- [ ] **Step 3:** Commit.

```bash
git add app/routes/app.mcp.tsx
git commit -m "routes: /app/mcp loader fetches oauth grants alongside bearer tokens"
```

### Task 13.2: Two-column connect banner

**Files:** Create `app/components/McpConnectCards.tsx`.

- [ ] **Step 1:** Write component.

```tsx
// app/components/McpConnectCards.tsx
import { Banner, BlockStack, Button, Card, InlineGrid, Text, TextField } from "@shopify/polaris";
import { useCallback } from "react";

const MCP_URL = "https://calderyn-mcp.vercel.app/mcp";

export function McpConnectCards() {
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(MCP_URL);
  }, []);

  return (
    <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Connect via Claude.ai (recommended)</Text>
          <Text as="p" variant="bodyMd">
            In Claude.ai, open <b>Add connector</b>, paste the URL below, then approve the Calderyn
            consent screen that appears.
          </Text>
          <TextField label="MCP URL" value={MCP_URL} autoComplete="off" readOnly />
          <Button onClick={copy}>Copy URL</Button>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Connect via bearer token (advanced)</Text>
          <Text as="p" variant="bodyMd">
            For custom MCP clients that don't speak OAuth. Generate a token below and paste it as a
            <code> Authorization: Bearer …</code> header. Read-only.
          </Text>
          <Banner tone="info">
            <p>If your client speaks OAuth, use the recommended path on the left.</p>
          </Banner>
        </BlockStack>
      </Card>
    </InlineGrid>
  );
}
```

- [ ] **Step 2:** Import and render at top of `app.mcp.tsx`, above the existing `<Banner tone="info" title="How to connect">` (and delete that old banner).

- [ ] **Step 3:** Manual smoke — open `/app/mcp` in dev, confirm side-by-side layout and copy-button works.

- [ ] **Step 4:** Commit.

```bash
git add app/components/McpConnectCards.tsx app/routes/app.mcp.tsx
git commit -m "ui: /app/mcp two-column connect cards (oauth-first, bearer fallback)"
```

### Task 13.3: Connected Claude.ai workspaces card + Disconnect action

**Files:** Modify `app/routes/app.mcp.tsx`.

- [ ] **Step 1:** Add an `oauth-revoke` intent to the action handler:

```typescript
if (intent === "oauth-revoke") {
  const tokenId = String(formData.get("token_id") || "");
  if (!tokenId) return json<ActionPayload>(/* error */, { status: 400 });
  await revokeOauthGrant({ shopDomain: session.shop, tokenId });
  return json<ActionPayload>({
    ok: true, intent, toast: { message: "Claude.ai workspace disconnected" },
  });
}
```

- [ ] **Step 2:** Render the card below the connect banner.

```tsx
{oauthGrants.length > 0 && (
  <Layout.Section>
    <Card>
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">Connected Claude.ai workspaces</Text>
        <DataTable
          columnContentTypes={["text", "text", "text", "text"]}
          headings={["Name", "Connected", "Last used", ""]}
          rows={oauthGrants.map((g) => [
            g.name,
            new Date(g.created_at).toLocaleString(),
            g.last_used_at ? new Date(g.last_used_at).toLocaleString() : "—",
            <Form method="post" key={`oauth-revoke-${g.id}`}>
              <input type="hidden" name="intent" value="oauth-revoke" />
              <input type="hidden" name="token_id" value={g.id} />
              <Button submit tone="critical">Disconnect</Button>
            </Form>,
          ])}
        />
      </BlockStack>
    </Card>
  </Layout.Section>
)}
```

- [ ] **Step 3:** Manual smoke — complete a full OAuth flow, refresh `/app/mcp`, see the connection listed, click Disconnect, confirm the next MCP request returns 401.

- [ ] **Step 4:** Commit.

```bash
git add app/routes/app.mcp.tsx
git commit -m "ui: /app/mcp connected claude.ai workspaces card + disconnect"
```

---

## Phase 14 — Nav link

### Task 14.1: Add "Claude connections" to the app nav

**Files:** Locate the nav definition (most likely `app/routes/app.tsx` — the parent route with `<NavMenu>`).

- [ ] **Step 1:** Find it.

Run: `grep -nE "NavMenu|<Link" app/routes/app.tsx | head -10`

- [ ] **Step 2:** Add the link inside the `<NavMenu>` block. Example shape (adjust to local style):

```tsx
<Link to="/app/mcp">Claude connections</Link>
```

- [ ] **Step 3:** Verify in dev — sidebar shows the link, click navigates.

- [ ] **Step 4:** Commit.

```bash
git add app/routes/app.tsx
git commit -m "nav: add 'Claude connections' link to /app/mcp"
```

---

## Phase 15 — Cleanup cron

### Task 15.1: Reaper endpoint

**Files:** Create `app/routes/api.cron.mcp-oauth-cleanup.tsx`.

- [ ] **Step 1:** Write.

```tsx
// app/routes/api.cron.mcp-oauth-cleanup.tsx
//
// Daily reaper for expired/consumed mcp_oauth_codes rows. Vercel cron.
// Auth: must include x-vercel-cron header (Vercel verifies, only its scheduler can send).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (process.env.MCP_OAUTH_ENABLED !== "true") return json({ ok: true, skipped: true });
  if (!request.headers.get("x-vercel-cron")) {
    return new Response("Forbidden", { status: 403 });
  }
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await getSupabase()
    .from("mcp_oauth_codes")
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  if (error) throw error;
  return json({ ok: true, deleted: count ?? 0 });
};
```

- [ ] **Step 2:** Schedule in `vercel.json`. Open and add to `crons`:

```json
{
  "crons": [
    { "path": "/api/cron/mcp-oauth-cleanup", "schedule": "0 4 * * *" }
  ]
}
```

(Merge with existing crons array — don't overwrite it.)

- [ ] **Step 3:** Commit.

```bash
git add app/routes/api.cron.mcp-oauth-cleanup.tsx vercel.json
git commit -m "cron: daily cleanup of expired mcp_oauth_codes"
```

---

## Phase 16 — `calderyn-mcp` cross-repo additions

**Prereq:** the `calderyn-mcp` repo must exist locally with rebuilt source (per the 2026-05-25 plan).

### Task 16.1: Add `/.well-known/oauth-protected-resource`

**Files (in `calderyn-mcp`):** Create `src/routes/oauth-protected-resource.ts`, register in the Hono app.

- [ ] **Step 1:** Write the handler.

```typescript
// src/routes/oauth-protected-resource.ts
import type { Hono } from "hono";

export function registerOauthProtectedResource(app: Hono): void {
  app.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json({
      resource: "https://calderyn-mcp.vercel.app/mcp",
      authorization_servers: ["https://app.calderyncompany.com"],
      scopes_supported: ["read"],
      bearer_methods_supported: ["header"],
    });
  });
}
```

- [ ] **Step 2:** Wire it in `src/server.ts` (whichever file constructs the Hono app):

```typescript
import { registerOauthProtectedResource } from "./routes/oauth-protected-resource";

// ... inside Hono construction
registerOauthProtectedResource(app);
```

- [ ] **Step 3:** Test by curl after local boot.

Run: `curl -sS http://localhost:3000/.well-known/oauth-protected-resource`
Expected: the JSON above.

- [ ] **Step 4:** Commit.

```bash
git add src/routes/oauth-protected-resource.ts src/server.ts
git commit -m "routes: .well-known/oauth-protected-resource (RFC 9728)"
```

### Task 16.2: Extend introspection middleware with `expires_at` check + `WWW-Authenticate` 401

**Files (in `calderyn-mcp`):** Modify `src/auth/token.ts`.

- [ ] **Step 1:** Locate the current introspection function. Update the SQL/Supabase query to include `expires_at, revoked_at`, and reject when expired:

```typescript
// inside the lookup function
const { data, error } = await sb
  .from("mcp_tokens")
  .select("shop_id, scopes, revoked_at, expires_at")
  .eq("token_hash", hash)
  .maybeSingle();
if (error || !data) return null;
if (data.revoked_at) return null;
if (data.expires_at && new Date(data.expires_at as string).getTime() < Date.now()) return null;
return { shop_id: data.shop_id as string, scopes: data.scopes as string[] };
```

- [ ] **Step 2:** Update the 401 path to include the RFC 9728 hint:

```typescript
// in the middleware
if (!ctx) {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate":
        'Bearer realm="calderyn-mcp", resource_metadata="https://calderyn-mcp.vercel.app/.well-known/oauth-protected-resource"',
    },
  });
}
```

- [ ] **Step 3:** Add tests (mirror the existing token-middleware tests in that repo).

- [ ] **Step 4:** Commit.

```bash
git add src/auth/token.ts src/auth/__tests__/token.test.ts
git commit -m "auth: enforce expires_at + return WWW-Authenticate resource_metadata"
```

---

## Phase 17 — Manual end-to-end smoke + flag flip

### Task 17.1: Deploy with flag OFF, verify nothing changes for merchants

- [ ] **Step 1:** Push the branch.

```bash
git push -u origin calderyn/claude-connector-oauth
```

- [ ] **Step 2:** Preview deploy in Vercel. Visit `/app/mcp` — expect existing behavior unchanged because no env var is set on the preview.

- [ ] **Step 3:** Confirm `/.well-known/oauth-authorization-server` returns 404 (flag off).

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<preview-url>/.well-known/oauth-authorization-server
```
Expected: `404`.

### Task 17.2: Flip flag in Vercel env vars (per environment)

- [ ] **Step 1:** Set on the **preview** environment first:
  - `MCP_OAUTH_ENABLED=true`
  - `MCP_OAUTH_COOKIE_SECRET=<openssl rand -hex 32 output>`

- [ ] **Step 2:** Trigger a redeploy.

- [ ] **Step 3:** Walk through a real Claude.ai Pro account:
  1. Add connector with the preview MCP URL.
  2. Confirm Claude.ai 401s, then redirects to consent.
  3. Pick shop, sign in via Shopify, land on consent screen.
  4. Allow → connector connected.
  5. Ask Claude.ai "what are my open alerts?" → expect a real answer from `list_alerts`.

- [ ] **Step 4:** Disconnect from `/app/mcp` → confirm next Claude.ai request 401s.

### Task 17.3: Flip flag in production

- [ ] **Step 1:** Set the same env vars on **production** Vercel env.

- [ ] **Step 2:** Redeploy production.

- [ ] **Step 3:** Re-run §17.2 step 3–4 on the prod URL with a different merchant account.

- [ ] **Step 4:** Open a PR for the branch.

```bash
gh pr create --title "Claude.ai connector via OAuth 2.1" --body "$(cat <<'EOF'
## Summary
- Adds OAuth 2.1 + PKCE + DCR + refresh-rotation to the MCP token surface
- New routes: /oauth/{authorize,token,register,consent} + /.well-known/oauth-authorization-server
- /app/mcp shows two-column connect cards (Claude.ai-first, bearer as advanced)
- Existing bearer flow unchanged; both auth modes resolve to {shop_id, scopes}

## Test plan
- [x] PKCE math (vector from RFC 7636)
- [x] DCR register/lookup
- [x] Code consume (PKCE, redirect_uri, client_id, expiry, single-use)
- [x] Refresh rotation (replay-detectable)
- [x] Manual: full Claude.ai connector flow on preview
- [x] Manual: full Claude.ai connector flow on prod
- [x] Manual: disconnect → next request 401s
EOF
)"
```

---

## Spec coverage check

| Spec §  | What it requires                                | Where implemented |
|---------|-------------------------------------------------|-------------------|
| §4      | Topology: three OAuth endpoints in shopify-app, well-known doc in calderyn-mcp | Phases 5, 6, 7–10, 11, 16 |
| §5      | Merchant flow                                   | Phases 7–11 end-to-end |
| §6.1    | RFCs followed                                   | Phases 2, 6, 7, 10, 11 |
| §6.2    | Discovery JSON shape                            | Phase 5 + Phase 16.1 |
| §6.3    | Endpoint map                                    | Phases 5–11 + 16 |
| §6.4    | PKCE S256                                       | Phases 2.1, 3.4, 7.1 |
| §6.5    | Lifetimes + rotation                            | Phases 2, 3.3, 4.1, 4.2 |
| §6.6    | Read-only scopes                                | Phases 7.1, 4.1 |
| §6.7    | Public clients                                  | Phases 3.1, 5 |
| §6.8    | Bearer compat                                   | Phase 1.3 (schema defaults), Phase 16.2 (introspection) |
| §7.1    | mcp_oauth_clients                               | Phase 1.1 |
| §7.2    | mcp_oauth_codes                                 | Phase 1.2 |
| §7.3    | mcp_tokens extension                            | Phase 1.3 |
| §8.1    | /oauth/authorize Polaris UI                     | Phases 7, 8, 10 |
| §8.2    | /oauth/token                                    | Phases 11, 12 |
| §8.3    | /oauth/register                                 | Phase 6 |
| §8.4    | well-known                                      | Phase 5 |
| §8.5    | Revised /app/mcp                                | Phase 13 |
| §8.6    | Nav link                                        | Phase 14 |
| §9      | Error mapping                                   | Throughout (each endpoint) |
| §10     | Testing                                         | Throughout (TDD steps) |
| §11     | Rollout                                         | Phase 17 |
| §12     | Forward-compat for Piece C                      | Schema choices in Phase 1, scope handling in Phases 3–11 |
| §13     | DoD                                             | Phase 17.2–17.3 |

No gaps. Two known follow-ups (per spec): DCR rate-limit (Phase 6.2 TODO) and the eventual Piece C write tools (separate workstream).

---

## Plan complete

Saved to [`docs/superpowers/plans/2026-06-08-claude-connector-oauth.md`](2026-06-08-claude-connector-oauth.md).

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — run tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

Which approach?
