# Slice 0 — First-Party Auth (Foundation + Door B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a brand-new merchant sign up with email + password, log into the Calderyn dashboard, and land on an (empty) store — with Shopify never involved.

**Architecture:** Add a first-party login *next to* the existing Shopify-OAuth path (dual-run, nothing removed). New `users` + `membership` tables hold identity; the existing `dashboard_sessions` token machinery is reused verbatim with a new `createSessionForUser` entry point and a nullable `user_id` column. The internal `shops.id` UUID stays the universal tenant key, so no `*_fact`/`*_dim` table changes — only the *lookup key* and the *login* are new.

**Tech Stack:** Remix (Vite) routes, `@supabase/supabase-js` (service-role client), `node:crypto` `scrypt` for password hashing (no new dependency), Resend for email (existing `sendEmail`), vitest for tests.

## Global Constraints

- TypeScript only; `tsc --noEmit` is authoritative. No `any` without written justification — prefer `unknown` + narrowing.
- `.server.ts` files are server-only; never import them from a client module.
- All schema changes go through a migration file; never hand-edit `migrations/`. Add the migration to BOTH `supabase/migrations/` AND `tests/engine/schema/migrations/` (the repo mirrors schema in both).
- Wrap multi-step writes in a single logical transaction where the data layer supports it; otherwise order writes so a partial failure leaves no orphaned login.
- Tables holding credentials/PII (`users`, `membership`, `password_reset_token`) get `enable row level security` with NO policies (service-role-only, matching `dashboard_sessions`).
- Secrets from `process.env` server-side only; update `.env.example` when adding a key.
- Browser-visible source stays product-neutral: no AI/provenance/dev-tool markers in any served HTML or comment.
- Pre-commit gate before any commit of route/schema/lib changes: `npm run typecheck` → `npm run lint` (`--max-warnings=0` on touched files) → `npm run build`, all exit 0; `npx prisma validate` not needed (no Prisma schema change).
- The `shops.id` UUID contract is unchanged. Do NOT alter any downstream `*_fact`/`*_dim` table or `v_*` view.

---

### Task 1: Schema — users, membership, reset tokens, owned shop identity, session user link

**Files:**
- Create: `supabase/migrations/20260628120000_first_party_auth.sql`
- Create: `tests/engine/schema/migrations/20260628120000_first_party_auth.sql` (identical copy — repo mirrors schema)

**Interfaces:**
- Produces (tables/columns later tasks rely on):
  - `public.users(id uuid pk, email text unique, password_hash text, created_at, updated_at)`
  - `public.membership(id uuid pk, user_id→users, shop_id→shops, role text, created_at, unique(user_id,shop_id))`
  - `public.password_reset_token(id uuid pk, user_id→users, token_hash text unique, purpose text, expires_at, used_at, created_at)`
  - `public.shops` + columns `org_slug text` (unique where not null), `display_name text`, `custom_domain text`, `billing_customer_id text`; `shop_domain` now NULLABLE
  - `public.dashboard_sessions.user_id uuid` (nullable, →users)

- [ ] **Step 1: Write the migration SQL** (write the same content to both file paths above)

```sql
-- First-party auth (Slice 0): users + membership + reset tokens, owned shop
-- identity decoupled from *.myshopify.com, and a user link on dashboard sessions.
-- Dual-run: existing Shopify-keyed rows/sessions keep working (shop_domain stays,
-- just no longer required; session.user_id is null for Shopify-path sessions).

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.users enable row level security;

create table if not exists public.membership (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  unique (user_id, shop_id)
);
create index if not exists membership_user_id_idx on public.membership(user_id);
create index if not exists membership_shop_id_idx on public.membership(shop_id);
alter table public.membership enable row level security;

create table if not exists public.password_reset_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null default 'reset' check (purpose in ('reset','set_password')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_token_user_id_idx on public.password_reset_token(user_id);
alter table public.password_reset_token enable row level security;

-- Owned shop identity.
alter table public.shops add column if not exists org_slug text;
alter table public.shops add column if not exists display_name text;
alter table public.shops add column if not exists custom_domain text;
alter table public.shops add column if not exists billing_customer_id text;
create unique index if not exists shops_org_slug_key on public.shops(org_slug) where org_slug is not null;
alter table public.shops alter column shop_domain drop not null;

-- First-party sessions link to a user; Shopify-path sessions leave it null.
alter table public.dashboard_sessions add column if not exists user_id uuid references public.users(id) on delete cascade;
create index if not exists dashboard_sessions_user_id_idx on public.dashboard_sessions(user_id);
```

- [ ] **Step 2: Apply to the local engine test DB and verify**

Run:
```bash
bash tests/engine/scripts/test-db.sh up   # spins up disposable local Postgres on :5433
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test \
  -f tests/engine/schema/migrations/20260628120000_first_party_auth.sql
PGPASSWORD=test psql -h localhost -p 5433 -U postgres -d calderyn_test \
  -c "select column_name, is_nullable from information_schema.columns where table_name='shops' and column_name in ('shop_domain','org_slug','display_name');"
```
Expected: `shop_domain` → `YES` (nullable); `org_slug`, `display_name` present.

- [ ] **Step 3: Validate the SQL parses against the prod schema definition (no apply)**

Run: `npx prisma validate` — not applicable here (no Prisma schema change). Instead confirm idempotency by re-running Step 2's `psql -f` once more; expected: no errors (every statement is `if not exists` / `drop not null` idempotent).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260628120000_first_party_auth.sql tests/engine/schema/migrations/20260628120000_first_party_auth.sql
git commit -m "feat(auth): schema for first-party users, membership, owned shop identity"
```

---

### Task 2: Password hashing utility (node:crypto scrypt, zero-dependency)

**Files:**
- Create: `app/lib/auth/password.server.ts`
- Test: `app/lib/auth/__tests__/password.server.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): string` — returns `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
  - `verifyPassword(plain: string, stored: string): boolean` — constant-time compare; `false` on malformed `stored`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../password.server";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different hash each call (random salt)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("returns false for malformed stored values instead of throwing", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "not-a-scrypt-hash")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/password.server.test.ts`
Expected: FAIL — cannot find module `../password.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/auth/password.server.ts
//
// Password hashing with node:crypto scrypt — no third-party dependency. Stored
// format encodes the parameters so they can be tuned later without breaking old
// hashes: `scrypt$<N>$<r>$<p>$<saltHex>$<derivedHex>`.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length === 0) return false;
    const derived = scryptSync(plain, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/password.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/password.server.ts app/lib/auth/__tests__/password.server.test.ts
git commit -m "feat(auth): scrypt password hashing helper"
```

---

### Task 3: Users data layer (create / find / verify credentials)

**Files:**
- Create: `app/lib/auth/users.server.ts`
- Test: `app/lib/auth/__tests__/users.server.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword` (Task 2); `getSupabase` (`app/lib/supabase.server.ts`).
- Produces:
  - `normalizeEmail(raw: string): string`
  - `isValidEmail(raw: string): boolean`
  - `createUser(email: string, password: string): Promise<{ id: string }>`
  - `findUserByEmail(email: string): Promise<{ id: string; passwordHash: string } | null>`
  - `verifyUserCredentials(email: string, password: string): Promise<{ id: string } | null>` — runs a hash even when the user is absent (anti-enumeration timing)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const single = vi.fn();
const insert = vi.fn(() => ({ select: () => ({ single }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
    }),
  }),
}));

beforeEach(() => {
  maybeSingle.mockReset();
  single.mockReset();
});

describe("users data layer", () => {
  it("normalizes and validates email", async () => {
    const { normalizeEmail, isValidEmail } = await import("../users.server");
    expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
  });

  it("verifyUserCredentials returns null for an unknown email", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { verifyUserCredentials } = await import("../users.server");
    expect(await verifyUserCredentials("ghost@x.co", "pw")).toBeNull();
  });

  it("verifyUserCredentials returns the id for a correct password", async () => {
    const { hashPassword } = await import("../password.server");
    maybeSingle.mockResolvedValue({
      data: { id: "u1", password_hash: hashPassword("hunter2") },
      error: null,
    });
    const { verifyUserCredentials } = await import("../users.server");
    expect(await verifyUserCredentials("a@b.co", "hunter2")).toEqual({ id: "u1" });
    expect(await verifyUserCredentials("a@b.co", "wrong")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/users.server.test.ts`
Expected: FAIL — cannot find module `../users.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/auth/users.server.ts
import { getSupabase } from "../supabase.server";
import { hashPassword, verifyPassword } from "./password.server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A fixed valid hash used to spend ~the same CPU when the email is unknown, so
// login timing does not reveal whether an account exists.
const DUMMY_HASH = hashPassword("calderyn-anti-enumeration-placeholder");

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

export async function findUserByEmail(
  email: string,
): Promise<{ id: string; passwordHash: string } | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, password_hash")
    .eq("email", normalizeEmail(email))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: String(data.id), passwordHash: String(data.password_hash) };
}

export async function createUser(
  email: string,
  password: string,
): Promise<{ id: string }> {
  const { data, error } = await getSupabase()
    .from("users")
    .insert({ email: normalizeEmail(email), password_hash: hashPassword(password) })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id) };
}

export async function verifyUserCredentials(
  email: string,
  password: string,
): Promise<{ id: string } | null> {
  const user = await findUserByEmail(email);
  if (!user) {
    verifyPassword(password, DUMMY_HASH); // burn comparable CPU; ignore result
    return null;
  }
  return verifyPassword(password, user.passwordHash) ? { id: user.id } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/users.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/users.server.ts app/lib/auth/__tests__/users.server.test.ts
git commit -m "feat(auth): users data layer with anti-enumeration credential check"
```

---

### Task 4: Owned-tenant helpers (provision an owned shop + membership; resolve a user's shop)

**Files:**
- Create: `app/lib/auth/tenant.server.ts`
- Test: `app/lib/auth/__tests__/tenant.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`, `seedShippedAutopilotFeatures` (`app/lib/supabase.server.ts`).
- Produces:
  - `slugify(displayName: string): string` — lowercase, hyphenated, with a short random suffix for uniqueness
  - `provisionOwnedShop(displayName: string): Promise<{ shopId: string; orgSlug: string }>` — inserts a `shops` row with owned identity (no `shop_domain`), seeds baseline autopilot features
  - `linkMembership(userId: string, shopId: string, role?: string): Promise<void>`
  - `resolveShopForUser(userId: string): Promise<string | null>` — the user's single membership shop_id (v1: at most one)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const single = vi.fn();
const maybeSingle = vi.fn();
const insertMembership = vi.fn().mockResolvedValue({ error: null });
const seedSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "membership") {
        return {
          insert: insertMembership,
          select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle }) }) }) }),
        };
      }
      // shops
      return { insert: () => ({ select: () => ({ single }) }) };
    },
  }),
  seedShippedAutopilotFeatures: seedSpy,
}));

beforeEach(() => {
  single.mockReset();
  maybeSingle.mockReset();
  insertMembership.mockClear();
  seedSpy.mockClear();
});

describe("owned-tenant helpers", () => {
  it("slugify produces a url-safe slug with a suffix", async () => {
    const { slugify } = await import("../tenant.server");
    expect(slugify("Acme Goods!")).toMatch(/^acme-goods-[a-z0-9]{6}$/);
  });

  it("provisionOwnedShop inserts a shop and seeds autopilot features", async () => {
    single.mockResolvedValue({ data: { id: "shop1", org_slug: "acme-abc123" }, error: null });
    const { provisionOwnedShop } = await import("../tenant.server");
    const res = await provisionOwnedShop("Acme");
    expect(res.shopId).toBe("shop1");
    expect(seedSpy).toHaveBeenCalledWith("shop1", expect.anything());
  });

  it("resolveShopForUser returns the membership shop_id", async () => {
    maybeSingle.mockResolvedValue({ data: { shop_id: "shop1" }, error: null });
    const { resolveShopForUser } = await import("../tenant.server");
    expect(await resolveShopForUser("u1")).toBe("shop1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/tenant.server.test.ts`
Expected: FAIL — cannot find module `../tenant.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/auth/tenant.server.ts
import { randomBytes } from "node:crypto";
import { getSupabase, seedShippedAutopilotFeatures } from "../supabase.server";

export function slugify(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "store";
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${base}-${suffix}`;
}

export async function provisionOwnedShop(
  displayName: string,
): Promise<{ shopId: string; orgSlug: string }> {
  const sb = getSupabase();
  const orgSlug = slugify(displayName);
  const { data, error } = await sb
    .from("shops")
    .insert({ org_slug: orgSlug, display_name: displayName })
    .select("id, org_slug")
    .single();
  if (error) throw error;
  const shopId = String(data.id);
  await seedShippedAutopilotFeatures(shopId, sb);
  return { shopId, orgSlug: String(data.org_slug) };
}

export async function linkMembership(
  userId: string,
  shopId: string,
  role: string = "owner",
): Promise<void> {
  const { error } = await getSupabase()
    .from("membership")
    .insert({ user_id: userId, shop_id: shopId, role });
  if (error) throw error;
}

export async function resolveShopForUser(userId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("membership")
    .select("shop_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? String(data.shop_id) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/tenant.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/tenant.server.ts app/lib/auth/__tests__/tenant.server.test.ts
git commit -m "feat(auth): owned-shop provisioning + membership resolution"
```

---

### Task 5: Session subject — add `createSessionForUser`, carry `userId` on the session

**Files:**
- Modify: `app/lib/dashboard/session.server.ts` (add a function + extend a type + add a revoke variant; do NOT change existing `createSession`)
- Test: `app/lib/dashboard/__tests__/session-user.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase` (`app/lib/supabase.server.ts`), existing `newSessionToken`, `hashSessionToken`.
- Produces:
  - `createSessionForUser(userId: string, shopId: string): Promise<{ raw: string }>`
  - `DashboardSession` extended to `{ shopId: string; shopDomain: string | null; userId: string | null; sessionId: string }`
  - `revokeAllSessionsForUser(userId: string): Promise<void>`
- Back-compat: existing `createSession(shopDomain)` and `revokeAllSessionsForShop` stay unchanged (the Shopify path still calls them).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn(() => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "sess1" }, error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert }) }),
  resolveShopId: vi.fn(),
}));
vi.mock("~/lib/actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => { insert.mockClear(); });

describe("createSessionForUser", () => {
  it("inserts a session row carrying user_id and shop_id", async () => {
    process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);
    const { createSessionForUser } = await import("../session.server");
    const { raw } = await createSessionForUser("u1", "shop1");
    expect(raw.startsWith("dash_live_")).toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "u1", shop_id: "shop1" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/session-user.server.test.ts`
Expected: FAIL — `createSessionForUser` is not exported.

- [ ] **Step 3: Add the implementation** (append to `session.server.ts`; do not touch existing functions except the `DashboardSession` type + the `getSessionFromRequest` return)

```typescript
export async function createSessionForUser(
  userId: string,
  shopId: string,
): Promise<{ raw: string }> {
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .insert({
      user_id: userId,
      shop_id: shopId,
      token_hash: hashSessionToken(raw),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  await resurfaceAllSnoozes(getSupabase(), shopId);
  return { raw };
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw error;
}
```

Change the `DashboardSession` type to:

```typescript
export type DashboardSession = {
  shopId: string;
  shopDomain: string | null;
  userId: string | null;
  sessionId: string;
};
```

In `getSessionFromRequest`, add `user_id` to the `.select(...)` list and to the returned object:

```typescript
    .select("id, shop_id, shop_domain, user_id, expires_at, revoked_at")
```
```typescript
  return {
    shopId: String(data.shop_id),
    shopDomain: data.shop_domain == null ? null : String(data.shop_domain),
    userId: data.user_id == null ? null : String(data.user_id),
    sessionId: String(data.id),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/session-user.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the `shopDomain: string | null` ripple**

Run: `npm run typecheck`
Expected: exit 0. If any consumer assumed `shopDomain: string`, fix it to handle `null` (the Shopify path always has a domain; owned shops are null). Record each fixed file in the commit body.

- [ ] **Step 6: Commit**

```bash
git add app/lib/dashboard/session.server.ts app/lib/dashboard/__tests__/session-user.server.test.ts
git commit -m "feat(auth): user-subject session (createSessionForUser, nullable shopDomain)"
```

---

### Task 6: Door B — signup route (`/dashboard/signup`)

**Files:**
- Create: `app/routes/dashboard.signup.tsx`
- Test: `app/routes/__tests__/dashboard.signup.test.ts`

**Interfaces:**
- Consumes: `isValidEmail`, `normalizeEmail`, `findUserByEmail`, `createUser` (Task 3); `provisionOwnedShop`, `linkMembership` (Task 4); `createSessionForUser`, `sessionCookieHeader` (Task 5 / existing); `rateLimit`, `clientIpKey`, `requireSameOrigin`, `jsonError` (existing `http.server.ts`).
- Produces: a route. On success: a `dash_live_` session cookie + `redirect("/dashboard")`.

- [ ] **Step 1: Write the failing test** (action behavior; mock the data layers)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const findUserByEmail = vi.fn();
const createUser = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({
  isValidEmail: (e: string) => /@/.test(e),
  normalizeEmail: (e: string) => e.toLowerCase(),
  findUserByEmail,
  createUser,
}));
vi.mock("~/lib/auth/tenant.server", () => ({
  provisionOwnedShop: vi.fn().mockResolvedValue({ shopId: "shop1", orgSlug: "acme-x" }),
  linkMembership: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/",
}));

beforeEach(() => { findUserByEmail.mockReset(); createUser.mockReset(); });

function form(fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  return new Request("https://app.calderyncompany.com/dashboard/signup", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("signup action", () => {
  it("rejects an invalid email with 422", async () => {
    const { action } = await import("../dashboard.signup");
    const res = await action({ request: form({ email: "bad", password: "longenough12", store: "Acme" }) } as never);
    expect((res as Response).status).toBe(422);
  });

  it("rejects a short password with 422", async () => {
    const { action } = await import("../dashboard.signup");
    const res = await action({ request: form({ email: "a@b.co", password: "short", store: "Acme" }) } as never);
    expect((res as Response).status).toBe(422);
  });

  it("rejects a duplicate email with 409", async () => {
    findUserByEmail.mockResolvedValue({ id: "u0", passwordHash: "h" });
    const { action } = await import("../dashboard.signup");
    const res = await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never);
    expect((res as Response).status).toBe(409);
  });

  it("creates user+shop+membership+session and redirects on success", async () => {
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u1" });
    const { action } = await import("../dashboard.signup");
    const res = (await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.signup.test.ts`
Expected: FAIL — cannot find module `../dashboard.signup`.

- [ ] **Step 3: Write the route**

```tsx
// app/routes/dashboard.signup.tsx
// Door B: first-party merchant signup (email + password). Creates the user, an
// owned shop, the membership link, and a session — no Shopify involved.
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { isValidEmail, findUserByEmail, createUser } from "~/lib/auth/users.server";
import { provisionOwnedShop, linkMembership } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";

const MIN_PASSWORD = 10;

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-signup"), 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");
  const store = String(fd.get("store") ?? "").trim();

  if (!isValidEmail(email)) return jsonError(422, "invalid_email");
  if (password.length < MIN_PASSWORD) return jsonError(422, "weak_password", `Use at least ${MIN_PASSWORD} characters`);
  if (!store) return jsonError(422, "missing_store");

  if (await findUserByEmail(email)) return jsonError(409, "email_taken");

  const { id: userId } = await createUser(email, password);
  const { shopId } = await provisionOwnedShop(store);
  await linkMembership(userId, shopId, "owner");

  const { raw } = await createSessionForUser(userId, shopId);
  return redirect("/dashboard", {
    headers: { "Set-Cookie": sessionCookieHeader(raw) },
  });
}

export default function SignupRoute() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Create your Calderyn account</h1>
      <form method="post" action="/dashboard/signup">
        <label htmlFor="store">Store name</label>
        <input id="store" name="store" type="text" required style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Create account</button>
      </form>
      <p><a href="/dashboard/signin">Already have an account? Sign in</a></p>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.signup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.signup.tsx app/routes/__tests__/dashboard.signup.test.ts
git commit -m "feat(auth): Door B signup route (user + owned shop + session)"
```

---

### Task 7: Door B — sign-in route (`/dashboard/signin`)

**Files:**
- Create: `app/routes/dashboard.signin.tsx`
- Test: `app/routes/__tests__/dashboard.signin.test.ts`

**Interfaces:**
- Consumes: `verifyUserCredentials` (Task 3); `resolveShopForUser` (Task 4); `createSessionForUser`, `sessionCookieHeader` (Task 5); `rateLimit`, `clientIpKey`, `requireSameOrigin`, `jsonError` (existing).
- Produces: a route. On success: session cookie + `redirect("/dashboard")`. On bad credentials: 401 `invalid_credentials` (uniform — no account-existence leak).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const verifyUserCredentials = vi.fn();
const resolveShopForUser = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({ verifyUserCredentials }));
vi.mock("~/lib/auth/tenant.server", () => ({ resolveShopForUser }));
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/",
}));

beforeEach(() => { verifyUserCredentials.mockReset(); resolveShopForUser.mockReset(); });

function form(fields: Record<string, string>) {
  return new Request("https://app.calderyncompany.com/dashboard/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("signin action", () => {
  it("returns 401 invalid_credentials on a bad password", async () => {
    verifyUserCredentials.mockResolvedValue(null);
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "nope" }) } as never)) as Response;
    expect(res.status).toBe(401);
  });

  it("signs in and redirects on success", async () => {
    verifyUserCredentials.mockResolvedValue({ id: "u1" });
    resolveShopForUser.mockResolvedValue("shop1");
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "right" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.signin.test.ts`
Expected: FAIL — cannot find module `../dashboard.signin`.

- [ ] **Step 3: Write the route**

```tsx
// app/routes/dashboard.signin.tsx
// Door B: first-party email + password sign-in. Lives next to the existing
// Shopify-OAuth login (/dashboard/login), which is unchanged.
//
// REDIRECT FIX (Task 5 follow-on): `getSessionOrRedirect` in session.server.ts
// currently sends expired/absent sessions to /dashboard/login (the SHOPIFY
// page). Once first-party login exists, point its default redirect at
// /dashboard/signin instead, so a first-party merchant whose session lapsed
// lands on the email/password page, not the Shopify one. (The Shopify-OAuth
// route itself stays; only the default redirect target moves.)
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { verifyUserCredentials } from "~/lib/auth/users.server";
import { resolveShopForUser } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-signin"), 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");

  const user = await verifyUserCredentials(email, password);
  if (!user) return jsonError(401, "invalid_credentials");

  const shopId = await resolveShopForUser(user.id);
  if (!shopId) return jsonError(409, "no_shop"); // account exists but no store linked yet

  const { raw } = await createSessionForUser(user.id, shopId);
  return redirect("/dashboard", { headers: { "Set-Cookie": sessionCookieHeader(raw) } });
}

export default function SigninRoute() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Sign in to Calderyn</h1>
      <form method="post" action="/dashboard/signin">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Sign in</button>
      </form>
      <p><a href="/dashboard/reset">Forgot password?</a> · <a href="/dashboard/signup">Create an account</a></p>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.signin.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.signin.tsx app/routes/__tests__/dashboard.signin.test.ts
git commit -m "feat(auth): Door B sign-in route (email + password)"
```

---

### Task 8: Password reset (request email + confirm new password)

**Files:**
- Create: `app/lib/auth/reset.server.ts`
- Create: `app/routes/dashboard.reset.tsx` (request: GET form + POST emails a link)
- Create: `app/routes/dashboard.reset.confirm.tsx` (GET form with `?t=`, POST sets the new password)
- Test: `app/lib/auth/__tests__/reset.server.test.ts`
- Modify: `.env.example` (document `DASHBOARD_PUBLIC_URL` reuse for the reset link; no new key — reuse `RESEND_API_KEY` + `PILOT_FROM`)

**Interfaces:**
- Consumes: `getSupabase`; `findUserByEmail`, `hashPassword` (Tasks 2-3); `sendEmail` (`app/lib/email/send.server.ts`); `newSessionToken`/`hashSessionToken` (reuse the opaque-token + HMAC pattern from `session.server.ts` — export them if not already exported).
- Produces:
  - `createResetToken(userId: string, purpose?: "reset" | "set_password"): Promise<{ raw: string }>`
  - `consumeResetToken(raw: string): Promise<{ userId: string } | null>` — single-use, expiry-checked, marks `used_at`
  - `requestPasswordReset(email: string, baseUrl: string): Promise<void>` — looks up user, mints token, emails link; **always resolves** (never reveals whether the email exists)
  - `setPasswordWithToken(raw: string, newPassword: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const single = vi.fn();
const maybeSingle = vi.fn();
const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
const insert = vi.fn(() => ({ select: () => ({ single }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ insert, select: () => ({ eq: () => ({ maybeSingle }) }), update }),
  }),
}));
const sendEmail = vi.fn().mockResolvedValue({ sent: true, id: "e1" });
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));
const findUserByEmail = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({ findUserByEmail, normalizeEmail: (e: string) => e.toLowerCase() }));

beforeEach(() => { single.mockReset(); maybeSingle.mockReset(); insert.mockClear(); sendEmail.mockClear(); findUserByEmail.mockReset(); });

describe("password reset", () => {
  it("requestPasswordReset stays silent (resolves) for an unknown email and sends nothing", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    findUserByEmail.mockResolvedValue(null);
    const { requestPasswordReset } = await import("../reset.server");
    await expect(requestPasswordReset("ghost@x.co", "https://app.x")).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("requestPasswordReset emails a link for a known email", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    findUserByEmail.mockResolvedValue({ id: "u1", passwordHash: "h" });
    single.mockResolvedValue({ data: { id: "tok1" }, error: null });
    const { requestPasswordReset } = await import("../reset.server");
    await requestPasswordReset("a@b.co", "https://app.x");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toBe("a@b.co");
    expect(arg.text).toContain("https://app.x/dashboard/reset/confirm?t=");
  });

  it("consumeResetToken returns null for an expired token", async () => {
    maybeSingle.mockResolvedValue({ data: { user_id: "u1", expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }, error: null });
    const { consumeResetToken } = await import("../reset.server");
    expect(await consumeResetToken("dash_live_x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/reset.server.test.ts`
Expected: FAIL — cannot find module `../reset.server`.

- [ ] **Step 3: Export the token helpers from `session.server.ts`** (if not already exported)

Confirm `newSessionToken` and `hashSessionToken` are `export`ed in `app/lib/dashboard/session.server.ts` (they are). Reuse them — do not duplicate the token logic.

- [ ] **Step 4: Write `reset.server.ts`**

```typescript
// app/lib/auth/reset.server.ts
import { getSupabase } from "../supabase.server";
import { findUserByEmail } from "./users.server";
import { hashPassword } from "./password.server";
import { newSessionToken, hashSessionToken } from "../dashboard/session.server";
import { sendEmail } from "../email/send.server";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function createResetToken(
  userId: string,
  purpose: "reset" | "set_password" = "reset",
): Promise<{ raw: string }> {
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("password_reset_token")
    .insert({
      user_id: userId,
      token_hash: hashSessionToken(raw),
      purpose,
      expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

export async function consumeResetToken(raw: string): Promise<{ userId: string } | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("password_reset_token")
    .select("id, user_id, expires_at, used_at")
    .eq("token_hash", hashSessionToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.used_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;
  await sb.from("password_reset_token").update({ used_at: new Date().toISOString() }).eq("id", data.id);
  return { userId: String(data.user_id) };
}

export async function requestPasswordReset(email: string, baseUrl: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) return; // silent: never reveal whether the email exists
  const { raw } = await createResetToken(user.id, "reset");
  const link = `${baseUrl}/dashboard/reset/confirm?t=${encodeURIComponent(raw)}`;
  await sendEmail({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.PILOT_FROM ?? "Calderyn <onboarding@calderyncompany.com>",
    to: email,
    subject: "Reset your Calderyn password",
    text: `Use this link to set a new password (valid for 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}

export async function setPasswordWithToken(raw: string, newPassword: string): Promise<boolean> {
  const consumed = await consumeResetToken(raw);
  if (!consumed) return false;
  const { error } = await getSupabase()
    .from("users")
    .update({ password_hash: hashPassword(newPassword), updated_at: new Date().toISOString() })
    .eq("id", consumed.userId);
  if (error) throw error;
  return true;
}
```

- [ ] **Step 5: Write the two routes**

`app/routes/dashboard.reset.tsx` — GET renders a request form; POST calls `requestPasswordReset` and ALWAYS shows the same "check your email" confirmation (no existence leak):

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { requestPasswordReset } from "~/lib/auth/reset.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-reset"), 5, 60_000))) return jsonError(429, "rate_limited");
  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  await requestPasswordReset(email, baseUrl);
  return new Response(
    "<!doctype html><meta charset=utf-8><main style='font:16px/1.5 system-ui;max-width:26rem;margin:12vh auto;padding:0 1.5rem'><h1 style='font-size:1.25rem'>Check your email</h1><p>If an account exists for that address, a reset link is on its way.</p></main>",
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export default function ResetRequest() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Reset your password</h1>
      <form method="post" action="/dashboard/reset">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Send reset link</button>
      </form>
    </main>
  );
}
```

`app/routes/dashboard.reset.confirm.tsx` — GET reads `?t=` into a hidden field; POST calls `setPasswordWithToken` and redirects to sign-in on success:

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { setPasswordWithToken } from "~/lib/auth/reset.server";

const MIN_PASSWORD = 10;

export async function loader({ request }: LoaderFunctionArgs) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  return { t };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-reset-confirm"), 10, 60_000))) return jsonError(429, "rate_limited");
  const fd = await request.formData();
  const token = String(fd.get("t") ?? "");
  const password = String(fd.get("password") ?? "");
  if (password.length < MIN_PASSWORD) return jsonError(422, "weak_password", `Use at least ${MIN_PASSWORD} characters`);
  const ok = await setPasswordWithToken(token, password);
  if (!ok) return jsonError(400, "invalid_or_expired_token");
  return redirect("/dashboard/signin");
}

export default function ResetConfirm() {
  const { t } = useLoaderData<typeof loader>();
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Set a new password</h1>
      <form method="post" action="/dashboard/reset/confirm">
        <input type="hidden" name="t" value={t} />
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Save password</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Run the reset lib test**

Run: `npx vitest run app/lib/auth/__tests__/reset.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add app/lib/auth/reset.server.ts app/routes/dashboard.reset.tsx app/routes/dashboard.reset.confirm.tsx app/lib/auth/__tests__/reset.server.test.ts
git commit -m "feat(auth): password reset (silent request email + single-use token confirm)"
```

---

### Task 9: Dual-run safety — audit `shopDomain` readers + full gate

**Files:**
- Modify: any consumer of `DashboardSession.shopDomain` flagged by typecheck (Task 5 already surfaces these); apply the minimal `null`-handling fix per file.
- No test file of its own — this task's deliverable is "the existing Shopify path still works AND `tsc` is clean."

**Interfaces:**
- Consumes: the whole app's session readers.
- Produces: a green gate and a verified dual-run (Shopify login + first-party login both functional).

- [ ] **Step 1: Find every `shopDomain` reader**

Run: `npx grep -rn "\.shopDomain" app/ || rg -n "\.shopDomain" app/`
Expected: a list. For each, confirm it tolerates `null` (owned shops). The Shopify-OAuth path (`dashboard.auth.callback.tsx` → `createSession`) always sets a domain, so those readers stay correct; only code that would now receive a first-party (null-domain) session needs a guard.

- [ ] **Step 2: Confirm the existing Shopify login is untouched**

Verify `app/routes/dashboard.login.tsx` and `app/routes/dashboard.auth.callback.tsx` are unchanged in this branch (they still call `createSession(shop)`), and `revokeAllSessionsForShop` still exists. Run: `git diff --name-only origin/main -- app/routes/dashboard.login.tsx app/routes/dashboard.auth.callback.tsx`
Expected: no output (both unchanged).

- [ ] **Step 3: Run the full pre-commit gate**

Run, in order, and paste results:
```bash
npm run typecheck   # exit 0
npm run lint        # exit 0, no warnings on touched files
npm run build       # exit 0
npx vitest run      # all green
```
Expected: every command exits 0.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(auth): handle nullable session shopDomain across readers; gate green"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-28-slice-0-first-party-auth-design.md`):**
- "First-party login (email+password now)" → Tasks 2, 3, 6, 7. ✅
- "users + membership tables; shops owned columns; shop_domain nullable; dashboard_sessions.user_id" → Task 1. ✅
- "createSession(userId); DashboardSession {userId,…}; token lifecycle unchanged; revokeAllSessionsForUser" → Task 5. ✅
- "generalize resolveShopId/provisionShop off domain" → Task 4 adds the owned-shop path (`provisionOwnedShop`); the legacy `resolveShopId(shopDomain)` stays for the Shopify path (dual-run). ✅ (Full rename/audit of `resolveShopId` callers is deferred to the Shopify-bridge plan, where the Shopify path is retired — noted below.)
- "Reuse app/lib/email/send.server.ts for reset" → Task 8. ✅
- "Security: scrypt/hash, single-use short-TTL reset tokens, rate-limit, no enumeration" → Tasks 2, 3 (dummy-hash), 7 (uniform 401), 8 (silent request, single-use token). ✅
- "Dual-run — nothing ripped out" → Task 5 keeps `createSession`; Task 9 verifies the Shopify path. ✅
- "Multi-store-ready data model, one-store UI" → `membership` table is multi-store-capable (Task 1/4); UI resolves the single membership, no picker (Task 7). ✅

**Out of scope here (in the Shopify-bridge follow-on plan):** Door A "Connect to Calderyn" + set-password email (the `set_password` token purpose is already in the Task 1 schema, ready for it), the "Connect Shopify" button, and retiring the Shopify-OAuth login + renaming `resolveShopId`.

**Placeholder scan:** none — every step has concrete SQL/code/commands.

**Type consistency:** `DashboardSession.shopDomain` is `string | null` everywhere after Task 5; `createSessionForUser(userId, shopId)`, `resolveShopForUser(userId): string | null`, `verifyUserCredentials → {id} | null`, `provisionOwnedShop → {shopId, orgSlug}` are used consistently across Tasks 4–8.

**Reset email link path** (`/dashboard/reset/confirm?t=`) matches the route file `dashboard.reset.confirm.tsx`. ✅
