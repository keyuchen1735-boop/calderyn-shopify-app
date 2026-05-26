# `calderyn-mcp` v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hosted, read-only MCP server (`calderyn-mcp`) that lets external agents query a merchant's calderyn state (alerts, audit, campaigns, SKUs, guardrails, integrations) via per-shop bearer tokens minted from the Shopify admin app.

**Architecture:** Two repos, one Supabase project. `shopify-app` gets a new Polaris token-management page + an ADR; **a new sibling repo `calderyn-mcp/`** (Hono on Vercel Fluid Compute) carries the MCP server. Both authenticate against the same Supabase project; the MCP service-role client closes over `shop_id` to enforce per-tenant scoping in code. Mappers/types are *copied* from `shopify-app` with sync-comment headers; promotion to a shared package is deferred until a third consumer appears.

**Tech Stack:** Node 20, TypeScript strict, ESM. **`shopify-app` side:** Remix + Polaris (existing). **`calderyn-mcp` side:** Hono, `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, Vitest. Vercel Fluid Compute deployment.

**Spec reference:** `docs/superpowers/specs/2026-05-25-mcp-server-design.md` — read this first. Section numbers (§N) below refer to that spec.

---

## Working Directories

Tasks alternate between two repos. Each phase explicitly states the `cwd`.

- **`shopify-app/`** — `/Users/ericchen/Developer/shopify-app` (this repo). Phases A, B, C touch only this repo.
- **`calderyn-mcp/`** — `/Users/ericchen/Developer/calderyn-mcp` (sibling, created in Phase D). Phases D–I happen here.

---

## File Structure

### Net-new in `shopify-app/`

```
shopify-app/
├── supabase/
│   └── migrations/
│       └── 20260525120000_mcp_tokens.sql       # Phase A — first Supabase-tracked migration
├── app/
│   ├── lib/
│   │   └── mcp_tokens.server.ts                # Phase B — create/list/revoke + HMAC
│   └── routes/
│       └── app.mcp.tsx                         # Phase B — Polaris token-management page
├── docs/
│   └── adr/
│       └── 0001-mcp-server-split.md            # Phase C — first ADR
└── .env.example                                # Phase B — add MCP_TOKEN_PEPPER
```

### Net-new sibling repo `calderyn-mcp/`

(per spec §3.2)

```
calderyn-mcp/
├── api/
│   └── [[...slug]].ts        # Vercel entry — re-exports the Hono app
├── src/
│   ├── server.ts             # Hono app: /mcp (Streamable HTTP), /healthz
│   ├── mcp/
│   │   ├── server.ts         # createMcpServer() — registers tools + resources
│   │   ├── tools.ts          # 7 read-only tool definitions
│   │   └── resources.ts      # 7 resource definitions
│   ├── data/
│   │   ├── supabase.ts       # createClient() singleton per Fluid instance
│   │   ├── calderyn.ts       # calderynReader(shopId) — read-only queries
│   │   └── mappers.ts        # rowTo* — copied from shopify-app with header
│   ├── auth/
│   │   ├── token.ts          # bearer middleware → {shop_id, scopes}
│   │   └── oauth.ts          # v2 stub
│   ├── types.ts              # mirrored domain types
│   └── errors.ts             # CalderynError + MCP error mapping
├── package.json
├── tsconfig.json
├── vercel.json
├── vitest.config.ts
├── .gitignore
├── CLAUDE.md                 # per-repo pre-commit gate (§8.4)
└── README.md                 # connection flow + smoke instructions
```

**Responsibility split:**
- `src/auth/token.ts` is the **only** path that turns a bearer token into a `shop_id`.
- `src/data/calderyn.ts` is the **only** module that holds a Supabase client *and* a `shop_id` at the same time — the constructor closes over `shopId` so tool handlers cannot bypass scoping.
- `src/mcp/{tools,resources}.ts` define the catalog; `src/mcp/server.ts` wires them onto an `Mcp.Server` instance.
- `src/server.ts` is HTTP-only — bearer auth, route dispatch, healthcheck. It calls `createMcpServer(ctx)` with `ctx.shopId` already resolved.

---

## Phase A — Supabase migration (shopify-app)

**cwd:** `/Users/ericchen/Developer/shopify-app`

### Task A1: Create `mcp_tokens` migration and apply it

**Files:**
- Create: `supabase/migrations/20260525120000_mcp_tokens.sql`

- [ ] **Step 1: Create the migrations directory**

```bash
mkdir -p supabase/migrations
```

- [ ] **Step 2: Write the migration SQL** (mirrors spec §4.2 exactly)

`supabase/migrations/20260525120000_mcp_tokens.sql`:

```sql
-- mcp_tokens: per-shop bearer tokens for the calderyn-mcp server.
-- Raw token shown to merchant once; hash stored at rest via HMAC-SHA256(raw, MCP_TOKEN_PEPPER).

create table mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes jsonb not null default '["read"]'::jsonb,
  created_by_user text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_user_agent text,
  revoked_at timestamptz
);

create index mcp_tokens_active_shop_idx
  on mcp_tokens (shop_id)
  where revoked_at is null;
```

- [ ] **Step 3: Apply to the linked Supabase project**

Apply via the Supabase MCP tool — paste the SQL above into a single call:

```
mcp__plugin_supabase_supabase__apply_migration(name="mcp_tokens", query=<sql from step 2>)
```

Verify by listing tables:

```
mcp__plugin_supabase_supabase__list_tables(schemas=["public"])
```

Expected: `mcp_tokens` in the list. Confirm columns match the SQL above.

- [ ] **Step 4: Smoke insert + select (sanity, no commit)**

```
mcp__plugin_supabase_supabase__execute_sql(query="select count(*) from mcp_tokens")
```

Expected: `[{"count": 0}]`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260525120000_mcp_tokens.sql
git commit -m "supabase/migrations: add mcp_tokens for per-shop MCP bearer tokens"
```

---

## Phase B — Token management UI in shopify-app

**cwd:** `/Users/ericchen/Developer/shopify-app`

### Task B1: Add the `MCP_TOKEN_PEPPER` env var

**Files:**
- Modify: `.env.example`
- Modify: `.env.local` (locally, not committed)

- [ ] **Step 1: Append to `.env.example`**

Append at end:

```
# HMAC pepper for hashing MCP bearer tokens. 32+ random bytes; rotate by re-issuing all tokens.
MCP_TOKEN_PEPPER=replace-with-32-byte-random-hex
```

- [ ] **Step 2: Generate a local pepper and add to `.env.local`** (DO NOT commit)

```bash
node -e "console.log('MCP_TOKEN_PEPPER=' + require('crypto').randomBytes(32).toString('hex'))" >> .env.local
```

Verify `.env.local` already in `.gitignore`:

```bash
grep -E "^\.env\.local$" .gitignore
```

Expected: `.env.local` appears. If missing, append it.

- [ ] **Step 3: Commit (only `.env.example`)**

```bash
git add .env.example
git commit -m ".env.example: add MCP_TOKEN_PEPPER for hashing mcp_tokens"
```

### Task B2: Token storage helper

**Files:**
- Create: `app/lib/mcp_tokens.server.ts`

- [ ] **Step 1: Write the helper**

```ts
// app/lib/mcp_tokens.server.ts
//
// Server-only CRUD for the mcp_tokens table.
// The raw token is returned ONCE from createMcpToken(); thereafter only the
// prefix and hash live in the DB.

import { createHmac, randomBytes } from "node:crypto";
import { getSupabase, resolveShopId } from "./supabase.server";

export interface McpTokenRow {
  id: string;
  shop_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_by_user: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedToken {
  row: McpTokenRow;
  raw: string; // mcp_live_<32-char-base32> — shown once, never persisted.
}

function pepper(): string {
  const p = process.env.MCP_TOKEN_PEPPER;
  if (!p || p.length < 32) {
    throw new Error("MCP_TOKEN_PEPPER must be set to a 32+ char secret");
  }
  return p;
}

export function hashToken(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

function generateRaw(): { raw: string; prefix: string } {
  const bytes = randomBytes(20); // 20 bytes → 32 base32 chars
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += BASE32_ALPHA[bytes[i] % 32];
  }
  // pad/trim to exactly 32 chars
  body = (body + body).slice(0, 32);
  const raw = `mcp_live_${body}`;
  const prefix = raw.slice(0, 13); // "mcp_live_" + first 4 body chars
  return { raw, prefix };
}

export async function listMcpTokens(shopDomain: string): Promise<McpTokenRow[]> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .select("id, shop_id, name, token_prefix, scopes, created_by_user, created_at, last_used_at, revoked_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as McpTokenRow[];
}

export async function createMcpToken(opts: {
  shopDomain: string;
  name: string;
  createdByUser: string | null;
  scopes?: string[];
}): Promise<CreatedToken> {
  const shopId = await resolveShopId(opts.shopDomain);
  const { raw, prefix } = generateRaw();
  const token_hash = hashToken(raw);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .insert({
      shop_id: shopId,
      name: opts.name,
      token_hash,
      token_prefix: prefix,
      scopes: opts.scopes ?? ["read"],
      created_by_user: opts.createdByUser,
    })
    .select("id, shop_id, name, token_prefix, scopes, created_by_user, created_at, last_used_at, revoked_at")
    .single();
  if (error) throw error;
  return { row: data as McpTokenRow, raw };
}

export async function revokeMcpToken(opts: {
  shopDomain: string;
  tokenId: string;
}): Promise<void> {
  const shopId = await resolveShopId(opts.shopDomain);
  const { error } = await getSupabase()
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", opts.tokenId)
    .is("revoked_at", null);
  if (error) throw error;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0, no errors.

- [ ] **Step 3: Lint touched file**

```bash
npm run lint -- app/lib/mcp_tokens.server.ts
```

Expected: exit 0, no warnings.

- [ ] **Step 4: Commit**

```bash
git add app/lib/mcp_tokens.server.ts
git commit -m "app/lib: add mcp_tokens.server CRUD with HMAC-hashed tokens"
```

### Task B3: Polaris token-management route

**Files:**
- Create: `app/routes/app.mcp.tsx`

- [ ] **Step 1: Write loader + action + UI**

```tsx
// app/routes/app.mcp.tsx
import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigate, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type McpTokenRow,
} from "~/lib/mcp_tokens.server";
import { useActionToast } from "~/lib/toast";

type LoaderPayload = {
  tokens: McpTokenRow[];
  error: { code: string; message: string } | null;
};

type ActionPayload = {
  ok: boolean;
  intent: "create" | "revoke" | "unknown";
  rawToken?: string;
  rawTokenName?: string;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const tokens = await listMcpTokens(session.shop);
    return json<LoaderPayload>({ tokens, error: null });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json<LoaderPayload>({
      tokens: [],
      error: { code: e.code ?? "ERROR", message: e.message ?? String(err) },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "") as ActionPayload["intent"];

  try {
    if (intent === "create") {
      const name = String(formData.get("name") || "").trim();
      if (!name) {
        return json<ActionPayload>(
          {
            ok: false,
            intent,
            error: { code: "NAME_REQUIRED", message: "Token name is required" },
            toast: { message: "Token name is required", isError: true },
          },
          { status: 400 },
        );
      }
      const created = await createMcpToken({
        shopDomain: session.shop,
        name,
        createdByUser: null, // wire to session.onlineAccessInfo when online tokens land
      });
      return json<ActionPayload>({
        ok: true,
        intent,
        rawToken: created.raw,
        rawTokenName: created.row.name,
        toast: { message: `Token "${name}" created` },
      });
    }

    if (intent === "revoke") {
      const tokenId = String(formData.get("token_id") || "");
      if (!tokenId) {
        return json<ActionPayload>(
          {
            ok: false,
            intent,
            error: { code: "TOKEN_ID_REQUIRED", message: "token_id is required" },
            toast: { message: "Missing token_id", isError: true },
          },
          { status: 400 },
        );
      }
      await revokeMcpToken({ shopDomain: session.shop, tokenId });
      return json<ActionPayload>({
        ok: true,
        intent,
        toast: { message: "Token revoked" },
      });
    }

    return json<ActionPayload>(
      {
        ok: false,
        intent: "unknown",
        error: { code: "INVALID_INTENT", message: `Unknown intent: ${intent}` },
        toast: { message: "Unknown intent", isError: true },
      },
      { status: 400 },
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json<ActionPayload>(
      {
        ok: false,
        intent,
        error: { code: e.code ?? "ERROR", message: e.message ?? String(err) },
        toast: { message: e.message ?? "Failed", isError: true },
      },
      { status: 500 },
    );
  }
};

export default function McpTokens() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const { tokens, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  useActionToast(actionData);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");

  // Reveal modal shows the raw token exactly once.
  const [revealOpen, setRevealOpen] = useState(false);
  useEffect(() => {
    if (actionData?.ok && actionData.intent === "create" && actionData.rawToken) {
      setRevealOpen(true);
      setCreateOpen(false);
      setName("");
    }
  }, [actionData]);

  const rows = tokens.map((t) => [
    t.name,
    `${t.token_prefix}…`,
    (t.scopes ?? []).join(", "),
    t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "—",
    new Date(t.created_at).toLocaleString(),
    t.revoked_at ? (
      <Badge tone="critical" key={`status-${t.id}`}>Revoked</Badge>
    ) : (
      <Form method="post" key={`revoke-${t.id}`}>
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="token_id" value={t.id} />
        <Button submit tone="critical" loading={submitting} disabled={submitting}>
          Revoke
        </Button>
      </Form>
    ),
  ]);

  return (
    <Page
      title="MCP tokens"
      subtitle="Bearer tokens for the calderyn MCP server"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "Generate token", onAction: () => setCreateOpen(true) }}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load tokens">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              {tokens.length === 0 ? (
                <BlockStack gap="200">
                  <Text as="p">No MCP tokens yet. Click "Generate token" to create one.</Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    A token authenticates an external MCP client (e.g. Claude.ai connector)
                    against this shop's read-only data surface.
                  </Text>
                </BlockStack>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Name", "Prefix", "Scopes", "Last used", "Created", ""]}
                  rows={rows}
                />
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Generate MCP token"
        primaryAction={{
          content: "Generate",
          loading: submitting,
          disabled: submitting || !name.trim(),
          // The actual submit is handled by the inner form; close on success via the effect above.
          onAction: () => {
            (document.getElementById("mcp-token-create-form") as HTMLFormElement | null)?.requestSubmit();
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setCreateOpen(false) }]}
      >
        <Modal.Section>
          <Form id="mcp-token-create-form" method="post">
            <input type="hidden" name="intent" value="create" />
            <TextField
              label="Token name"
              name="name"
              value={name}
              onChange={setName}
              autoComplete="off"
              helpText="A label so you can recognize this token in the list."
            />
          </Form>
        </Modal.Section>
      </Modal>

      <Modal
        open={revealOpen}
        onClose={() => setRevealOpen(false)}
        title={`Token: ${actionData?.rawTokenName ?? ""}`}
        primaryAction={{ content: "Done", onAction: () => setRevealOpen(false) }}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Banner tone="warning" title="Copy this token now — it will not be shown again.">
              <p>Calderyn stores only a hash. If you lose it, revoke and regenerate.</p>
            </Banner>
            <TextField
              label="Bearer token"
              value={actionData?.rawToken ?? ""}
              autoComplete="off"
              readOnly
              monospaced
            />
            <ButtonGroup>
              <Button
                onClick={() => {
                  if (actionData?.rawToken) navigator.clipboard.writeText(actionData.rawToken);
                }}
              >
                Copy to clipboard
              </Button>
            </ButtonGroup>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Lint touched file**

```bash
npm run lint -- app/routes/app.mcp.tsx
```

Expected: exit 0, no warnings.

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: exit 0 — Remix + Vite build completes, new route `app.mcp` shows up in the build manifest.

- [ ] **Step 5: Manual smoke**

Start the dev server:

```bash
npm run dev
```

In the admin embed, navigate to `/app/mcp` (or visit the page via direct URL through the Shopify admin frame). Verify:
- Empty-state copy renders.
- "Generate token" opens modal; submitting with a name reveals the raw token in a follow-up modal.
- Refresh: the new token row appears with prefix only.
- Revoke button flips the row to a "Revoked" badge.

- [ ] **Step 6: Verify token reaches DB hashed (not raw)**

```
mcp__plugin_supabase_supabase__execute_sql(query="select name, token_prefix, length(token_hash), revoked_at from mcp_tokens order by created_at desc limit 5")
```

Expected: `length(token_hash) = 64` (SHA-256 hex), raw token NOT present in any column.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.mcp.tsx
git commit -m "routes/app.mcp: Polaris UI to mint/list/revoke MCP bearer tokens"
```

---

## Phase C — ADR (shopify-app)

**cwd:** `/Users/ericchen/Developer/shopify-app`

### Task C1: Write ADR 0001

**Files:**
- Create: `docs/adr/0001-mcp-server-split.md`

- [ ] **Step 1: Create the file**

```bash
mkdir -p docs/adr
```

`docs/adr/0001-mcp-server-split.md`:

```markdown
# ADR 0001: Ship `calderyn-mcp` as a separate Vercel project

**Status:** Accepted — 2026-05-25
**Spec:** `docs/superpowers/specs/2026-05-25-mcp-server-design.md`

## Context

We need to expose calderyn's per-shop operational data (alerts, audit, campaigns,
SKUs, guardrails, integrations) over the Model Context Protocol so external
agents (Claude.ai connectors, custom agents) can ground themselves in a
merchant's calderyn state. The first version is read-only; write tools are
designed-for but not implemented.

Three placement options were on the table:
1. **Inline in the Remix app** as additional routes.
2. **Supabase Edge Function**.
3. **Separate Vercel project** sharing the same Supabase backend.

## Decision

**Option 3.** A new repo `calderyn-mcp` deployed as a sibling Vercel project,
talking to the same Supabase project via service-role key.

We also commit to:

- **Type and mapper duplication** between `shopify-app` and `calderyn-mcp` for v1.
  Both files (`src/types.ts`, `src/data/mappers.ts`) carry a header comment
  pointing at the source-of-truth in `shopify-app`. Promotion to a shared
  `@calderyn/types` package happens when **a third consumer appears** OR
  **the types remain stable for 60 days** without churn.
- **Service-role + mandatory `shopId` closure** as the data-access posture.
  The reader factory `calderynReader(shopId)` is the only module that holds
  a Supabase client and a `shop_id` at once; tool handlers cannot bypass
  scoping. RLS as a defense-in-depth layer is deferred to v2.
- **Mutation guardrails live in exactly one place.** `calderyn-mcp` will
  **not** reimplement 2FA, daily budget caps, cooldowns, business hours, or
  idempotency. Because `calderyn-mcp` is a separate repo and cannot import
  `shopify-app` source directly, the v2 implementation choice is deferred:
  - (a) `shopify-app` exposes an internal authenticated HTTP endpoint that
    `calderyn-mcp` calls to execute actions; guardrails stay co-located with
    `calderynClient(shop).actions.execute`.
  - (b) Guardrail logic is factored out into a shared `@calderyn/actions`
    package consumed by both repos.
  v1 commits only to the rule. The (a) vs (b) decision is taken when the
  write-tools workstream begins.

## Consequences

**Positive.**
- No bundle bloat in the Remix admin app; the MCP server scales independently.
- Hono streaming gives clean Streamable HTTP transport without forcing Remix.
- Promotes the Supabase project to true source-of-truth — `shopify-app` is
  no longer the only consumer.

**Negative.**
- Two repos to keep in sync for shared shapes. Mitigated by the duplication
  policy above + drift-detector tests in `calderyn-mcp` mappers.
- Two Vercel projects to deploy and observe. Acceptable; Vercel logs and
  project URLs cover v1 observability.
- The write-tools choice (a) vs (b) is deferred, which is a known unknown.

## Alternatives considered

- **Inline in Remix.** Rejected: MCP streaming and Remix loader/action
  patterns are mismatched; adding `@modelcontextprotocol/sdk` to the admin
  bundle is wrong, and Shopify admin auth would have to be bypassed
  per-request anyway.
- **Supabase Edge Function.** Rejected: cold-start variance hurts streaming;
  Deno runtime constrains library choice; logging/observability is weaker
  than Vercel Fluid Compute for this use case.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0001-mcp-server-split.md
git commit -m "docs/adr: 0001 — calderyn-mcp as separate Vercel project"
```

---

## Phase D — Bootstrap the `calderyn-mcp` repo

**cwd:** changes to `/Users/ericchen/Developer/calderyn-mcp` starting with Task D1.

### Task D1: Create the repo skeleton

**Files (all created in this task):**
- `package.json`, `tsconfig.json`, `vercel.json`, `vitest.config.ts`, `.gitignore`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Create the directory and init git**

```bash
cd /Users/ericchen/Developer
mkdir calderyn-mcp
cd calderyn-mcp
git init -b main
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "calderyn-mcp",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint --cache --cache-location ./node_modules/.cache/eslint 'src/**/*.ts' 'api/**/*.ts'",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@supabase/supabase-js": "^2.106.1",
    "hono": "^4.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@typescript-eslint/eslint-plugin": "^8.20.0",
    "@typescript-eslint/parser": "^8.20.0",
    "eslint": "^8.57.1",
    "typescript": "^5.7.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src", "api"]
}
```

- [ ] **Step 4: Write `vercel.json`**

```json
{
  "functions": {
    "api/[[...slug]].ts": {
      "runtime": "nodejs20.x"
    }
  }
}
```

Vercel Fluid Compute is the default; region pinning is set in the Vercel project settings post-deploy (Phase H), not in `vercel.json`.

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
```

- [ ] **Step 6: Write `.gitignore`**

```
node_modules/
.env
.env.local
.vercel/
dist/
.cache/
*.log
.DS_Store
```

- [ ] **Step 7: Write `README.md`**

```markdown
# calderyn-mcp

Hosted Model Context Protocol server for [calderyn](https://github.com/ericchen/shopify-app). Read-only v1: exposes a merchant's calderyn state (alerts, audit, campaigns, SKUs, guardrails, integrations) over a Streamable HTTP MCP transport, authenticated by per-shop bearer tokens minted from the calderyn admin app.

**Design spec:** `shopify-app/docs/superpowers/specs/2026-05-25-mcp-server-design.md`.

## Quick start

```bash
npm install
npm run typecheck && npm run lint && npm run test
```

## Environment

Copy `.env.example` (if present) or set directly:

- `SUPABASE_URL` — same project as `shopify-app`.
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key.
- `MCP_TOKEN_PEPPER` — **must match** the value in `shopify-app/.env.local` so hashes line up.

## Local smoke

After deploying a preview URL, run the inspector:

```bash
npx @modelcontextprotocol/inspector
```

Connect to `https://<preview-url>/mcp` with an `Authorization: Bearer mcp_live_...` header. Mint the token in the calderyn admin at `/app/mcp`.

## Pre-commit gate

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run test        # exit 0
```
```

- [ ] **Step 8: Write `CLAUDE.md`** (per spec §8.4)

```markdown
# Project: calderyn-mcp

Hosted MCP server exposing read-only calderyn state. Sibling of `shopify-app`.
Same Supabase project; different Vercel project.

## Language & style
- Node 20, TypeScript strict, ESM.
- Hono for HTTP; `@modelcontextprotocol/sdk` for MCP primitives.
- No `any` without written justification; prefer `unknown` + narrowing.
- Server-only — there is no client bundle. All `src/**` is server.

## Hard architectural rules
1. The **only** module that holds a Supabase client and a `shop_id` at the
   same time is `src/data/calderyn.ts`. Tool handlers never see the raw
   client. Per-tenant isolation is enforced by closing the reader over
   `shopId`.
2. `src/auth/token.ts` is the **only** path from a bearer token to a
   `shop_id`. No tool handler bypasses it.
3. **No write tools in v1.** v2 mutation tools will not reimplement
   guardrails (2FA, budget caps, cooldowns, business hours, idempotency) —
   they go through calderyn, see ADR 0001 in `shopify-app/docs/adr/`.
4. `src/types.ts` and `src/data/mappers.ts` are **copied** from
   `shopify-app/app/lib/types.ts` and `app/lib/calderyn.server.ts`. Header
   comment in each file points at the source. Mapper tests act as a drift
   detector.

## Pre-commit gate (MANDATORY)
A "major commit" = anything beyond a typo/comment/doc nit.

Run in this order, paste output, do not assert success without evidence:

1. `npm run typecheck` → exit 0
2. `npm run lint` → exit 0 (`--max-warnings=0` for new code)
3. `npm run test` (vitest run) → exit 0

Vercel handles the build at deploy time — no local `build` step.

If any step fails: stop, surface the failure, fix the root cause. Do not
`--no-verify`, do not silence with `// eslint-disable`, do not narrow types
to silence `tsc`.

## Commit hygiene
- One logical change per commit.
- Never commit `.env`, `.env.local`, `.vercel/`.
```

- [ ] **Step 9: Install dependencies**

```bash
npm install
```

Expected: no peer-dep errors. (If `@vercel/remix` peer issues appear here, they shouldn't — this repo has no Remix dep. If they do, the install failed for an unrelated reason.)

- [ ] **Step 10: Typecheck (empty src)**

```bash
mkdir -p src api
echo "export {};" > src/_placeholder.ts
npm run typecheck
rm src/_placeholder.ts
```

Expected: exit 0.

- [ ] **Step 11: Initial commit**

```bash
git add .
git commit -m "init: calderyn-mcp scaffold (package, tsconfig, vercel, vitest, CLAUDE.md)"
```

### Task D2: Mirrored domain types

**Files:**
- Create: `calderyn-mcp/src/types.ts`

- [ ] **Step 1: Copy types from `shopify-app/app/lib/types.ts` with sync header**

```ts
// src/types.ts
//
// MIRRORED from shopify-app/app/lib/types.ts.
// When the source changes, copy it here and re-run mapper drift tests.
// Promotion to a shared @calderyn/types package: third consumer OR 60-day stability.

export type Severity = "critical" | "high" | "medium" | "low";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type ActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "snooze_alert";
export type DetectorId =
  | "ad_tax_overload"
  | "campaign_below_breakeven"
  | "cogs_drift"
  | "margin_erosion"
  | "negative_unit_economics"
  | "regional_shortage_risk"
  | "regional_spend_starved_stock"
  | "reorder_timing"
  | "return_rate_hidden_loss"
  | "scaling_sku_fulfillment_risk"
  | "sku_stockout_vs_spend"
  | "wrong_location_concentration";

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
  sku: string | null;
  evidence: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  action_kind: ActionKind;
  outcome: "succeeded" | "failed";
  target: string;
  dollar_impact_at_exec: number;
  pre_state: unknown;
  post_state: unknown;
  created_at: string;
  actor: string;
  undo_eligible: boolean;
  alert_id: string | null;
  detector_id: DetectorId;
  requires_2fa?: boolean;
  failure_code?: string;
  failure_reason?: string;
  undo_of?: string;
}

export interface Campaign {
  id: string;
  name: string;
  platform: "Meta" | "Google";
  status: "active" | "paused";
  daily_budget_cents: number;
  roas_7d: number;
  contribution_margin: number;
  spend_7d: number;
}

export interface SKU {
  id: string;
  title: string;
  on_hand: number;
  days_of_cover: number;
  velocity: number;
  locations: Record<string, number>;
}

export interface Integration {
  name: string;
  status: "connected" | "pending" | "disconnected";
  detail: string;
  logoCls: string;
}

export interface GuardrailConfig {
  daily_action_budget_cents: number;
  daily_action_budget_used_cents: number;
  dollar_cap_cents: number;
  cooldown_minutes: number;
  business_hours: { start: string; end: string; tz: string };
  in_business_hours: boolean;
}

export interface AuthContext {
  shopId: string;
  scopes: string[];
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "src/types: mirror domain types from shopify-app (sync-header)"
```

### Task D3: Errors

**Files:**
- Create: `calderyn-mcp/src/errors.ts`

- [ ] **Step 1: Write the error class**

```ts
// src/errors.ts
//
// Public-facing error codes for tool responses. `code` is the contract; the
// MCP client sees the code, never the inner Supabase diagnostic.

export type CalderynErrorCode =
  | "UNAUTHORIZED"
  | "ALERT_NOT_FOUND"
  | "AUDIT_NOT_FOUND"
  | "GUARDRAILS_NOT_FOUND"
  | "INVALID_INPUT"
  | "SUPABASE_ERROR"
  | "INTERNAL";

export class CalderynError extends Error {
  code: CalderynErrorCode;
  details?: unknown;
  constructor(opts: { code: CalderynErrorCode; message: string; details?: unknown }) {
    super(opts.message);
    this.name = "CalderynError";
    this.code = opts.code;
    this.details = opts.details;
  }
}

export function toMcpToolError(err: unknown): { code: string; message: string } {
  if (err instanceof CalderynError) return { code: err.code, message: err.message };
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/errors.ts
git commit -m "src/errors: CalderynError + MCP tool-error mapper"
```

### Task D4: Supabase singleton

**Files:**
- Create: `calderyn-mcp/src/data/supabase.ts`

- [ ] **Step 1: Write the factory**

```ts
// src/data/supabase.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return _client;
}

// Test-only: reset the singleton between tests.
export function _resetSupabaseForTests(): void {
  _client = null;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/data/supabase.ts
git commit -m "src/data/supabase: singleton service-role client per Fluid instance"
```

### Task D5: Row mappers + drift-detector tests

**Files:**
- Create: `calderyn-mcp/src/data/mappers.ts`
- Create: `calderyn-mcp/src/data/mappers.test.ts`

- [ ] **Step 1: Write the failing tests first (TDD red)**

`src/data/mappers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rowToAlert, rowToAudit, rowToCampaign, rowToGuardrails, rowToSku } from "./mappers";

describe("rowToAlert", () => {
  it("maps full row", () => {
    const r = {
      id: 42,
      detector_id: "margin_erosion",
      severity: "high",
      status: "open",
      dollar_impact: "150.50",
      claude_rank: 3,
      created_at: "2026-05-25T12:00:00Z",
      title: "T",
      narrative: "N",
      campaign: "C1",
      sku: "SKU1",
      evidence: { a: 1 },
    };
    expect(rowToAlert(r)).toEqual({
      id: "42",
      detector_id: "margin_erosion",
      severity: "high",
      status: "open",
      dollar_impact: 150.5,
      claude_rank: 3,
      created_at: "2026-05-25T12:00:00Z",
      title: "T",
      narrative: "N",
      campaign: "C1",
      sku: "SKU1",
      evidence: { a: 1 },
    });
  });

  it("defaults missing fields", () => {
    const r = { id: 1, detector_id: "cogs_drift", severity: "low", status: "open", created_at: "x" };
    const a = rowToAlert(r);
    expect(a.dollar_impact).toBe(0);
    expect(a.claude_rank).toBe(999);
    expect(a.title).toBe("");
    expect(a.narrative).toBe("");
    expect(a.campaign).toBeNull();
    expect(a.sku).toBeNull();
    expect(a.evidence).toEqual({});
  });
});

describe("rowToAudit", () => {
  it("maps required fields", () => {
    const r = {
      id: "a1",
      action_kind: "pause_campaign",
      outcome: "succeeded",
      target: "C1",
      dollar_impact_at_exec: "10",
      pre_state: { x: 1 },
      post_state: { x: 2 },
      created_at: "2026-05-25T00:00:00Z",
      actor: "user@example.com",
      undo_eligible: true,
      alert_id: "alert1",
      detector_id: "margin_erosion",
    };
    const e = rowToAudit(r);
    expect(e.id).toBe("a1");
    expect(e.dollar_impact_at_exec).toBe(10);
    expect(e.undo_eligible).toBe(true);
    expect(e.actor).toBe("user@example.com");
  });

  it("defaults actor to 'system'", () => {
    const r = {
      id: "a2",
      action_kind: "pause_campaign",
      outcome: "failed",
      created_at: "x",
      undo_eligible: 0,
      detector_id: "cogs_drift",
    };
    expect(rowToAudit(r).actor).toBe("system");
    expect(rowToAudit(r).undo_eligible).toBe(false);
  });
});

describe("rowToCampaign", () => {
  it("normalises platform casing", () => {
    expect(rowToCampaign({ id: "1", name: "n", platform: "GOOGLE", status: "active" }).platform).toBe("Google");
    expect(rowToCampaign({ id: "1", name: "n", platform: "meta", status: "active" }).platform).toBe("Meta");
    expect(rowToCampaign({ id: "1", name: "n", platform: "unknown", status: "active" }).platform).toBe("Meta");
  });

  it("reads spend_7d from spend_7d_cents", () => {
    const c = rowToCampaign({ id: "1", name: "n", platform: "meta", status: "active", spend_7d_cents: 1234 });
    expect(c.spend_7d).toBe(1234);
  });
});

describe("rowToSku", () => {
  it("defaults locations to {}", () => {
    expect(rowToSku({ id: "s1", title: "t" }).locations).toEqual({});
  });
});

describe("rowToGuardrails", () => {
  it("converts dollars→cents and zero-pads business hours", () => {
    const g = rowToGuardrails({
      daily_action_budget: 50,
      dollar_impact_cap_without_2fa: 12.34,
      cooldown_minutes_per_campaign: 15,
      business_hours_start_utc: 9,
      business_hours_end_utc: 17,
      timezone: "America/New_York",
    });
    expect(g.daily_action_budget_cents).toBe(5000);
    expect(g.dollar_cap_cents).toBe(1234);
    expect(g.cooldown_minutes).toBe(15);
    expect(g.business_hours).toEqual({ start: "09:00", end: "17:00", tz: "America/New_York" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test
```

Expected: FAIL — `Cannot find module './mappers'`.

- [ ] **Step 3: Implement `mappers.ts`** (copied with adaptation from `shopify-app/app/lib/calderyn.server.ts` lines 67–141)

`src/data/mappers.ts`:

```ts
// src/data/mappers.ts
//
// MIRRORED from shopify-app/app/lib/calderyn.server.ts rowTo* (~lines 67–141).
// When the source changes, copy it here. Tests in mappers.test.ts act as a
// drift detector against the published view shapes.

import type { Alert, AuditEntry, Campaign, GuardrailConfig, SKU } from "../types";

export function rowToAlert(r: Record<string, unknown>): Alert {
  return {
    id: String(r.id),
    detector_id: r.detector_id as Alert["detector_id"],
    severity: r.severity as Alert["severity"],
    status: r.status as Alert["status"],
    dollar_impact: Number(r.dollar_impact ?? 0),
    claude_rank: Number(r.claude_rank ?? 999),
    created_at: String(r.created_at),
    title: String(r.title ?? ""),
    narrative: String(r.narrative ?? ""),
    campaign: (r.campaign as string | null) ?? null,
    sku: (r.sku as string | null) ?? null,
    evidence: (r.evidence as Record<string, unknown>) ?? {},
  };
}

export function rowToAudit(r: Record<string, unknown>): AuditEntry {
  return {
    id: String(r.id),
    action_kind: r.action_kind as AuditEntry["action_kind"],
    outcome: r.outcome as AuditEntry["outcome"],
    target: String(r.target ?? ""),
    dollar_impact_at_exec: Number(r.dollar_impact_at_exec ?? 0),
    pre_state: r.pre_state,
    post_state: r.post_state,
    created_at: String(r.created_at),
    actor: String(r.actor ?? "system"),
    undo_eligible: Boolean(r.undo_eligible),
    alert_id: (r.alert_id as string | null) ?? null,
    detector_id: r.detector_id as AuditEntry["detector_id"],
    failure_reason: (r.failure_reason as string | undefined) ?? undefined,
    undo_of: (r.undo_of as string | undefined) ?? undefined,
  };
}

export function rowToCampaign(r: Record<string, unknown>): Campaign {
  const platform = String(r.platform ?? "").toLowerCase();
  return {
    id: String(r.id),
    name: String(r.name),
    platform: platform === "google" ? "Google" : "Meta",
    status: r.status === "paused" ? "paused" : "active",
    daily_budget_cents: Number(r.daily_budget_cents ?? 0),
    roas_7d: Number(r.roas_7d ?? 0),
    contribution_margin: Number(r.contribution_margin ?? 0),
    spend_7d: Number(r.spend_7d_cents ?? 0),
  };
}

export function rowToSku(r: Record<string, unknown>): SKU {
  return {
    id: String(r.id),
    title: String(r.title),
    on_hand: Number(r.on_hand ?? 0),
    days_of_cover: Number(r.days_of_cover ?? 0),
    velocity: Number(r.velocity ?? 0),
    locations: (r.locations as Record<string, number>) ?? {},
  };
}

export function rowToGuardrails(r: Record<string, unknown>): GuardrailConfig {
  return {
    daily_action_budget_cents: Number(r.daily_action_budget ?? 0) * 100,
    daily_action_budget_used_cents: 0,
    dollar_cap_cents: Math.round(Number(r.dollar_impact_cap_without_2fa ?? 0) * 100),
    cooldown_minutes: Number(r.cooldown_minutes_per_campaign ?? 30),
    business_hours: {
      start: `${String(r.business_hours_start_utc ?? 14).padStart(2, "0")}:00`,
      end: `${String(r.business_hours_end_utc ?? 0).padStart(2, "0")}:00`,
      tz: String(r.timezone ?? "America/New_York"),
    },
    in_business_hours: true,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test
```

Expected: all `rowTo*` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/mappers.ts src/data/mappers.test.ts
git commit -m "src/data/mappers: mirror rowTo* with drift-detector tests"
```

---

## Phase E — Auth middleware

**cwd:** `/Users/ericchen/Developer/calderyn-mcp`

### Task E1: Bearer-token middleware

**Files:**
- Create: `calderyn-mcp/src/auth/token.ts`
- Create: `calderyn-mcp/src/auth/token.test.ts`

- [ ] **Step 1: Write the failing tests (TDD red)**

`src/auth/token.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateBearer, hashTokenForTests } from "./token";

// Fake supabase client. .from().select().eq().is().maybeSingle() chain.
function makeFakeSupabase(row: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.is = vi.fn().mockReturnValue(builder);
  builder.maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  builder.update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  return { from: vi.fn().mockReturnValue(builder) } as unknown as Parameters<typeof authenticateBearer>[1];
}

const PEPPER = "x".repeat(40);

describe("authenticateBearer", () => {
  beforeEach(() => {
    process.env.MCP_TOKEN_PEPPER = PEPPER;
  });

  it("rejects missing header", async () => {
    const r = await authenticateBearer(null, makeFakeSupabase(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("rejects non-Bearer scheme", async () => {
    const r = await authenticateBearer("Basic abc", makeFakeSupabase(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects unknown token", async () => {
    const r = await authenticateBearer("Bearer mcp_live_unknown", makeFakeSupabase(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown");
  });

  it("rejects revoked token", async () => {
    const raw = "mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = makeFakeSupabase({
      id: "t1",
      shop_id: "shop1",
      scopes: ["read"],
      revoked_at: "2026-05-01T00:00:00Z",
      last_used_at: null,
      token_hash: hashTokenForTests(raw),
    });
    const r = await authenticateBearer(`Bearer ${raw}`, fake);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("revoked");
  });

  it("accepts active token and returns shop_id + scopes", async () => {
    const raw = "mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = makeFakeSupabase({
      id: "t1",
      shop_id: "shop1",
      scopes: ["read"],
      revoked_at: null,
      last_used_at: null,
      token_hash: hashTokenForTests(raw),
    });
    const r = await authenticateBearer(`Bearer ${raw}`, fake);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ctx.shopId).toBe("shop1");
      expect(r.ctx.scopes).toEqual(["read"]);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test
```

Expected: FAIL — `Cannot find module './token'`.

- [ ] **Step 3: Implement `token.ts`**

`src/auth/token.ts`:

```ts
// src/auth/token.ts
//
// The ONLY path that resolves a bearer token to a shop_id. Tool handlers
// receive the resulting AuthContext via request state; they cannot bypass
// this middleware.

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "../types";

export type AuthResult =
  | { ok: true; ctx: AuthContext; tokenId: string; lastUsedAt: string | null }
  | { ok: false; reason: "missing" | "malformed" | "unknown" | "revoked" };

function pepper(): string {
  const p = process.env.MCP_TOKEN_PEPPER;
  if (!p || p.length < 32) throw new Error("MCP_TOKEN_PEPPER must be set to a 32+ char secret");
  return p;
}

function hashToken(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

// Exported for tests only.
export const hashTokenForTests = hashToken;

const LAST_USED_DEBOUNCE_MS = 60_000;

export async function authenticateBearer(
  authHeader: string | null,
  supabase: SupabaseClient,
): Promise<AuthResult> {
  if (!authHeader) return { ok: false, reason: "missing" };
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!m) return { ok: false, reason: "malformed" };
  const raw = m[1];
  if (!raw.startsWith("mcp_live_")) {
    // v2 OAuth opaque tokens fall through to a different code path; v1 only honors mcp_live_*.
    return { ok: false, reason: "malformed" };
  }
  const hash = hashToken(raw);
  const { data, error } = await supabase
    .from("mcp_tokens")
    .select("id, shop_id, scopes, revoked_at, last_used_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "unknown" };
  if (data.revoked_at) return { ok: false, reason: "revoked" };
  return {
    ok: true,
    tokenId: String(data.id),
    lastUsedAt: (data.last_used_at as string | null) ?? null,
    ctx: {
      shopId: String(data.shop_id),
      scopes: (data.scopes as string[] | null) ?? ["read"],
    },
  };
}

export async function maybeUpdateLastUsed(
  supabase: SupabaseClient,
  tokenId: string,
  previousLastUsedAt: string | null,
  userAgent: string | null,
): Promise<void> {
  const now = Date.now();
  if (previousLastUsedAt) {
    const prev = Date.parse(previousLastUsedAt);
    if (Number.isFinite(prev) && now - prev < LAST_USED_DEBOUNCE_MS) return;
  }
  const updates: Record<string, unknown> = { last_used_at: new Date(now).toISOString() };
  if (userAgent) updates.last_user_agent = userAgent.slice(0, 64);
  // Fire-and-forget; do not await in caller's hot path.
  await supabase.from("mcp_tokens").update(updates).eq("id", tokenId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test
```

Expected: all `authenticateBearer` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/token.ts src/auth/token.test.ts
git commit -m "src/auth/token: bearer middleware → {shop_id, scopes} with tests"
```

### Task E2: OAuth stub

**Files:**
- Create: `calderyn-mcp/src/auth/oauth.ts`

- [ ] **Step 1: Write the stub**

```ts
// src/auth/oauth.ts
//
// Placeholder for v2 OAuth 2.1 authorization-server integration. v1 has no
// runtime path through this module. Kept as a file so the v2 PR is a pure
// addition, not a structural change.

export const OAUTH_V2_NOT_IMPLEMENTED = "calderyn-mcp v1 supports mcp_live_* bearer tokens only";
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/auth/oauth.ts
git commit -m "src/auth/oauth: v2 placeholder"
```

---

## Phase F — Read-only data layer

**cwd:** `/Users/ericchen/Developer/calderyn-mcp`

### Task F1: `calderynReader(shopId)`

**Files:**
- Create: `calderyn-mcp/src/data/calderyn.ts`
- Create: `calderyn-mcp/src/data/calderyn.test.ts`

- [ ] **Step 1: Write the failing tests (TDD red)**

`src/data/calderyn.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { calderynReader } from "./calderyn";
import { CalderynError } from "../errors";

// Build a fake supabase whose .from(view) returns a chainable builder ending
// in a resolved value. We assert on what was passed to .eq() to verify scoping.
function makeBuilder(rows: unknown[] | unknown | null) {
  const calls: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};
  b.select = vi.fn(() => b);
  b.eq = vi.fn((col: string, val: unknown) => {
    calls.push([col, val]);
    return b;
  });
  b.order = vi.fn(() => b);
  b.limit = vi.fn(() => b);
  b.maybeSingle = vi.fn().mockResolvedValue({ data: rows, error: null });
  // Awaiting the builder resolves to a select() result.
  (b as unknown as { then: Function }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: Array.isArray(rows) ? rows : [rows].filter(Boolean), error: null });
  return { builder: b, calls };
}

describe("calderynReader", () => {
  it("scopes alerts.list by shopId", async () => {
    const { builder, calls } = makeBuilder([
      { id: "1", detector_id: "margin_erosion", severity: "high", status: "open", created_at: "x" },
    ]);
    const supabase = { from: vi.fn(() => builder) } as unknown as Parameters<typeof calderynReader>[1];
    const reader = calderynReader("shop-abc", supabase);
    const alerts = await reader.alerts.list({});
    expect(alerts).toHaveLength(1);
    expect(calls.some(([c, v]) => c === "shop_id" && v === "shop-abc")).toBe(true);
  });

  it("alerts.get throws ALERT_NOT_FOUND when missing", async () => {
    const { builder } = makeBuilder(null);
    const supabase = { from: vi.fn(() => builder) } as unknown as Parameters<typeof calderynReader>[1];
    const reader = calderynReader("shop-abc", supabase);
    await expect(reader.alerts.get("missing")).rejects.toBeInstanceOf(CalderynError);
    await expect(reader.alerts.get("missing")).rejects.toMatchObject({ code: "ALERT_NOT_FOUND" });
  });

  it("audit.list respects limit cap", async () => {
    const { builder, calls } = makeBuilder([]);
    const supabase = { from: vi.fn(() => builder) } as unknown as Parameters<typeof calderynReader>[1];
    const reader = calderynReader("shop-abc", supabase);
    await reader.audit.list({ limit: 500 });
    // Should clamp to 200.
    expect(builder.limit).toHaveBeenCalledWith(200);
    expect(calls.some(([c, v]) => c === "shop_id" && v === "shop-abc")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test
```

Expected: FAIL — `Cannot find module './calderyn'`.

- [ ] **Step 3: Implement `calderyn.ts`**

`src/data/calderyn.ts`:

```ts
// src/data/calderyn.ts
//
// THE ONLY MODULE that holds a Supabase client and a shop_id together.
// `shopId` is closed over by the factory; tool handlers receive the
// returned reader and cannot bypass tenant scoping.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../errors";
import {
  rowToAlert,
  rowToAudit,
  rowToCampaign,
  rowToGuardrails,
  rowToSku,
} from "./mappers";
import type { Alert, AuditEntry, Campaign, GuardrailConfig, Integration, SKU } from "../types";

const HARD_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampLimit(n: number | undefined): number {
  if (n === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), HARD_LIMIT);
}

function rethrow(prefix: string, err: unknown): never {
  if (err instanceof CalderynError) throw err;
  const e = err as { message?: string };
  throw new CalderynError({
    code: "SUPABASE_ERROR",
    message: `${prefix}: ${e.message ?? String(err)}`,
    details: err,
  });
}

const INTEGRATION_DISPLAY_NAME: Record<string, string> = {
  shopify: "Shopify",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  quickbooks: "QuickBooks",
};
const INTEGRATION_LOGO_CLS: Record<string, string> = {
  shopify: "logo-shopify",
  meta_ads: "logo-meta",
  google_ads: "logo-google",
  quickbooks: "logo-quickbooks",
};

export function calderynReader(shopId: string, supabase: SupabaseClient) {
  return {
    alerts: {
      async list(opts: { status?: string; severity?: string; detector_id?: string; limit?: number }): Promise<Alert[]> {
        try {
          let q = supabase
            .from("v_alerts_view")
            .select("*")
            .eq("shop_id", shopId)
            .order("claude_rank", { ascending: true })
            .limit(clampLimit(opts.limit));
          if (opts.status) q = q.eq("status", opts.status);
          if (opts.severity) q = q.eq("severity", opts.severity);
          if (opts.detector_id) q = q.eq("detector_id", opts.detector_id);
          const { data, error } = await q;
          if (error) throw error;
          return (data ?? []).map(rowToAlert);
        } catch (e) {
          rethrow("alerts.list", e);
        }
      },
      async get(id: string): Promise<Alert> {
        try {
          const { data, error } = await supabase
            .from("v_alerts_view")
            .select("*")
            .eq("shop_id", shopId)
            .eq("id", id)
            .maybeSingle();
          if (error) throw error;
          if (!data) {
            throw new CalderynError({ code: "ALERT_NOT_FOUND", message: `Alert ${id} not found` });
          }
          return rowToAlert(data as Record<string, unknown>);
        } catch (e) {
          rethrow("alerts.get", e);
        }
      },
    },

    audit: {
      async list(opts: { limit?: number; since?: string; detector_id?: string }): Promise<AuditEntry[]> {
        try {
          let q = supabase
            .from("v_audit_view")
            .select("*")
            .eq("shop_id", shopId)
            .order("created_at", { ascending: false })
            .limit(clampLimit(opts.limit));
          if (opts.since) q = q.gte("created_at", opts.since);
          if (opts.detector_id) q = q.eq("detector_id", opts.detector_id);
          const { data, error } = await q;
          if (error) throw error;
          return (data ?? []).map(rowToAudit);
        } catch (e) {
          rethrow("audit.list", e);
        }
      },
    },

    campaigns: {
      async list(opts: { status?: "active" | "paused" }): Promise<Campaign[]> {
        try {
          let q = supabase
            .from("v_campaigns_flat")
            .select("*")
            .eq("shop_id", shopId)
            .order("spend_7d_cents", { ascending: false });
          if (opts.status) q = q.eq("status", opts.status);
          const { data, error } = await q;
          if (error) throw error;
          return (data ?? []).map(rowToCampaign);
        } catch (e) {
          rethrow("campaigns.list", e);
        }
      },
    },

    skus: {
      async list(opts: { sku_id?: string; low_cover_only?: boolean }): Promise<SKU[]> {
        try {
          let q = supabase
            .from("v_skus_flat")
            .select("*")
            .eq("shop_id", shopId)
            .order("on_hand", { ascending: false });
          if (opts.sku_id) q = q.eq("id", opts.sku_id);
          if (opts.low_cover_only) q = q.lt("days_of_cover", 14);
          const { data, error } = await q;
          if (error) throw error;
          return (data ?? []).map(rowToSku);
        } catch (e) {
          rethrow("skus.list", e);
        }
      },
    },

    guardrails: {
      async get(): Promise<GuardrailConfig> {
        try {
          const { data, error } = await supabase
            .from("guardrail_config")
            .select("*")
            .eq("shop_id", shopId)
            .maybeSingle();
          if (error) throw error;
          if (!data) {
            throw new CalderynError({
              code: "GUARDRAILS_NOT_FOUND",
              message: `No guardrail config for shop ${shopId}`,
            });
          }
          return rowToGuardrails(data as Record<string, unknown>);
        } catch (e) {
          rethrow("guardrails.get", e);
        }
      },
    },

    integrations: {
      async list(): Promise<Integration[]> {
        try {
          const { data, error } = await supabase
            .from("shop_integrations")
            .select("kind, sync_status, sync_error, connected_at, external_account_id")
            .eq("shop_id", shopId);
          if (error) throw error;
          const out: Record<string, Integration> = {
            shopify: { name: "Shopify", status: "connected", detail: "Embedded app", logoCls: "logo-shopify" },
            meta_ads: { name: "Meta Ads", status: "disconnected", detail: "Not connected", logoCls: "logo-meta" },
            google_ads: { name: "Google Ads", status: "disconnected", detail: "Not connected", logoCls: "logo-google" },
            quickbooks: { name: "QuickBooks", status: "disconnected", detail: "Not connected", logoCls: "logo-quickbooks" },
          };
          for (const r of (data ?? []) as Array<Record<string, unknown>>) {
            const kind = String(r.kind);
            const status: Integration["status"] =
              r.sync_status === "ready" || r.sync_status === "ok"
                ? "connected"
                : r.sync_status === "pending"
                  ? "pending"
                  : "disconnected";
            out[kind] = {
              name: INTEGRATION_DISPLAY_NAME[kind] ?? kind,
              status,
              detail: String(r.sync_error ?? r.external_account_id ?? "Pending"),
              logoCls: INTEGRATION_LOGO_CLS[kind] ?? "logo-default",
            };
          }
          return Object.values(out);
        } catch (e) {
          rethrow("integrations.list", e);
        }
      },
    },
  };
}

export type CalderynReader = ReturnType<typeof calderynReader>;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test
```

Expected: PASS on `calderynReader` tests; previous mapper + token tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/calderyn.ts src/data/calderyn.test.ts
git commit -m "src/data/calderyn: read-only reader closed over shopId with tests"
```

---

## Phase G — MCP server, tools, resources, HTTP transport

**cwd:** `/Users/ericchen/Developer/calderyn-mcp`

### Task G1: Resource definitions

**Files:**
- Create: `calderyn-mcp/src/mcp/resources.ts`

- [ ] **Step 1: Write the resource registrar**

```ts
// src/mcp/resources.ts
//
// Resources expose calderyn state by URI. Per spec §5.1, all v1 resources
// return application/json. The handler is closed over a reader so per-shop
// scoping is automatic.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CalderynReader } from "../data/calderyn";

export function registerResources(server: Server, reader: CalderynReader): void {
  server.setRequestHandler({ method: "resources/list" } as never, async () => ({
    resources: [
      { uri: "calderyn://alerts", name: "Open alerts", mimeType: "application/json" },
      { uri: "calderyn://audit", name: "Recent audit entries", mimeType: "application/json" },
      { uri: "calderyn://campaigns", name: "Campaigns", mimeType: "application/json" },
      { uri: "calderyn://skus", name: "SKUs", mimeType: "application/json" },
      { uri: "calderyn://guardrails", name: "Guardrail config + today's usage", mimeType: "application/json" },
      { uri: "calderyn://integrations", name: "Integration connection status", mimeType: "application/json" },
    ],
  }));

  server.setRequestHandler({ method: "resources/read" } as never, async (req: { params: { uri: string } }) => {
    const uri = req.params.uri;
    const contents = async () => {
      switch (true) {
        case uri === "calderyn://alerts":
          return await reader.alerts.list({ status: "open", limit: 50 });
        case uri.startsWith("calderyn://alerts/"):
          return await reader.alerts.get(uri.slice("calderyn://alerts/".length));
        case uri === "calderyn://audit":
          return await reader.audit.list({ limit: 50 });
        case uri === "calderyn://campaigns":
          return await reader.campaigns.list({});
        case uri === "calderyn://skus":
          return await reader.skus.list({});
        case uri === "calderyn://guardrails":
          return await reader.guardrails.get();
        case uri === "calderyn://integrations":
          return await reader.integrations.list();
        default:
          throw new Error(`Unknown resource URI: ${uri}`);
      }
    };
    const payload = await contents();
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
      ],
    };
  });
}
```

**Note for engineer:** The `as never` casts on `setRequestHandler` are because the MCP SDK's request schemas live in `@modelcontextprotocol/sdk/types.js` and require importing schema constants (`ListResourcesRequestSchema`, `ReadResourceRequestSchema`). If your installed SDK version errors on the cast, replace with the schema imports:

```ts
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ ... }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({ ... }));
```

Verify the schema names by running:

```bash
node -e "console.log(Object.keys(require('@modelcontextprotocol/sdk/types.js')))" | tr ',' '\n' | grep -i Schema
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

If types complain about the `as never` shape, swap to the schema-import form above.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/resources.ts
git commit -m "src/mcp/resources: register 7 read-only resources"
```

### Task G2: Tool definitions

**Files:**
- Create: `calderyn-mcp/src/mcp/tools.ts`

- [ ] **Step 1: Write the tool registrar**

Tools per spec §5.2. Descriptions are first-class — they decide whether the agent reaches for the tool. Each description tells the agent **when** to call it vs. an alternative, and **how** to interpret the output.

```ts
// src/mcp/tools.ts
//
// All v1 tools are read-only. Inputs validated with Zod; outputs match
// shapes in ../types.ts. Tool descriptions are first-class — the agent
// uses them to choose between tools.

import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CalderynReader } from "../data/calderyn";
import { toMcpToolError } from "../errors";

const LIMIT_HARD_CAP = 200;
const LIMIT_DEFAULT = 50;

const TOOLS = [
  {
    name: "list_alerts",
    description:
      "Returns calderyn alerts (anomalies in margin, inventory, ad spend) for the authenticated shop. " +
      "Use this to ground a session in the merchant's open issues before suggesting actions. " +
      "Default returns the 50 highest-priority open alerts (lowest claude_rank first). " +
      "Each alert has a `dollar_impact` and a `narrative` explaining why it fired. " +
      "Prefer `get_alert` if you already have a specific id.",
    inputSchema: z.object({
      status: z.enum(["open", "acknowledged", "resolved"]).optional(),
      severity: z.enum(["critical", "high", "medium", "low"]).optional(),
      detector_id: z.string().optional(),
      limit: z.number().int().positive().max(LIMIT_HARD_CAP).optional().default(LIMIT_DEFAULT),
    }),
    handler: async (reader: CalderynReader, input: Record<string, unknown>) => {
      const args = input as { status?: string; severity?: string; detector_id?: string; limit?: number };
      const alerts = await reader.alerts.list(args);
      return { alerts };
    },
  },
  {
    name: "get_alert",
    description:
      "Returns a single alert including its full evidence payload. Use when investigating a specific id; " +
      "list_alerts returns a leaner shape suitable for browsing many alerts.",
    inputSchema: z.object({ id: z.string().min(1) }),
    handler: async (reader: CalderynReader, input: Record<string, unknown>) => {
      const args = input as { id: string };
      const alert = await reader.alerts.get(args.id);
      return { alert };
    },
  },
  {
    name: "list_audit",
    description:
      "Returns recent calderyn action audit entries (newest first). Use to understand what actions have " +
      "already been taken before recommending a new one — avoids suggesting actions that were just undone. " +
      "Filter with `since` (ISO 8601) for a time window or `detector_id` for a specific anomaly class.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(LIMIT_HARD_CAP).optional().default(LIMIT_DEFAULT),
      since: z.string().datetime().optional(),
      detector_id: z.string().optional(),
    }),
    handler: async (reader: CalderynReader, input: Record<string, unknown>) => {
      const args = input as { limit?: number; since?: string; detector_id?: string };
      const entries = await reader.audit.list(args);
      return { entries };
    },
  },
  {
    name: "list_campaigns",
    description:
      "Returns all ad campaigns (Meta and Google) for the shop with 7-day spend, ROAS, and contribution " +
      "margin. Use to ground budget or pause recommendations. Filter `status=active` to ignore paused.",
    inputSchema: z.object({ status: z.enum(["active", "paused"]).optional() }),
    handler: async (reader: CalderynReader, input: Record<string, unknown>) => {
      const args = input as { status?: "active" | "paused" };
      const campaigns = await reader.campaigns.list(args);
      return { campaigns };
    },
  },
  {
    name: "list_skus",
    description:
      "Returns SKUs with on-hand inventory, days-of-cover, velocity, and per-location stock. " +
      "Use `low_cover_only=true` to focus on SKUs with <14 days of cover. " +
      "Use `sku_id` to look up one SKU.",
    inputSchema: z.object({
      sku_id: z.string().optional(),
      low_cover_only: z.boolean().optional(),
    }),
    handler: async (reader: CalderynReader, input: Record<string, unknown>) => {
      const args = input as { sku_id?: string; low_cover_only?: boolean };
      const skus = await reader.skus.list(args);
      return { skus };
    },
  },
  {
    name: "get_guardrails",
    description:
      "Returns the merchant's guardrail config: daily action budget (and today's used amount), per-action " +
      "dollar cap, cooldown minutes, business hours. Always check this before recommending an action " +
      "that costs money — the action gateway will reject anything beyond these caps.",
    inputSchema: z.object({}),
    handler: async (reader: CalderynReader, _input: Record<string, unknown>) => {
      const guardrails = await reader.guardrails.get();
      return { guardrails };
    },
  },
  {
    name: "list_integrations",
    description:
      "Returns connection status for Shopify, Meta Ads, Google Ads, QuickBooks. Use to verify that the " +
      "data you're about to ground on is fresh — a disconnected Meta integration means stale campaign data.",
    inputSchema: z.object({}),
    handler: async (reader: CalderynReader, _input: Record<string, unknown>) => {
      const integrations = await reader.integrations.list();
      return { integrations };
    },
  },
] as const;

export function registerTools(server: Server, reader: CalderynReader): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ code: "UNKNOWN_TOOL", message: `No tool: ${name}` }) }],
      };
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code: "INVALID_INPUT", message: parsed.error.message }),
          },
        ],
      };
    }
    try {
      const structuredContent = await tool.handler(reader, parsed.data as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (err) {
      const e = toMcpToolError(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(e) }],
      };
    }
  });
}

// Minimal Zod → JSON Schema shim. The MCP SDK expects a JSON-Schema-shaped
// inputSchema; full conversion (zod-to-json-schema package) is overkill for
// the shallow shapes used here.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    const out: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  return {};
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0. If the SDK version exposes different type names (e.g. `Server` lives at a different path), update the imports — the MCP SDK has moved subpath exports between versions.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "src/mcp/tools: 7 read-only tools with descriptions + Zod input validation"
```

### Task G3: MCP server factory + catalog test

**Files:**
- Create: `calderyn-mcp/src/mcp/server.ts`
- Create: `calderyn-mcp/src/mcp/server.test.ts`

- [ ] **Step 1: Write the failing catalog test (TDD red)**

`src/mcp/server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server";
import type { CalderynReader } from "../data/calderyn";

const fakeReader = {
  alerts: { list: async () => [], get: async () => ({}) as never },
  audit: { list: async () => [] },
  campaigns: { list: async () => [] },
  skus: { list: async () => [] },
  guardrails: { get: async () => ({}) as never },
  integrations: { list: async () => [] },
} as unknown as CalderynReader;

describe("MCP server catalog", () => {
  it("exposes 7 tools and 6 resource entries", async () => {
    const server = createMcpServer(fakeReader);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "get_alert",
      "get_guardrails",
      "list_alerts",
      "list_audit",
      "list_campaigns",
      "list_integrations",
      "list_skus",
    ]);

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri).sort()).toEqual([
      "calderyn://alerts",
      "calderyn://audit",
      "calderyn://campaigns",
      "calderyn://guardrails",
      "calderyn://integrations",
      "calderyn://skus",
    ]);

    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test -- src/mcp/server.test.ts
```

Expected: FAIL — `createMcpServer` not exported.

- [ ] **Step 3: Implement `server.ts`**

`src/mcp/server.ts`:

```ts
// src/mcp/server.ts
//
// Factory: build a fresh MCP server bound to a per-request reader. The reader
// is already closed over shopId by src/data/calderyn.ts, so the registered
// tools and resources inherit per-tenant scoping automatically.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CalderynReader } from "../data/calderyn";
import { registerResources } from "./resources";
import { registerTools } from "./tools";

export function createMcpServer(reader: CalderynReader): Server {
  const server = new Server(
    { name: "calderyn-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerTools(server, reader);
  registerResources(server, reader);
  return server;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test
```

Expected: catalog test PASSES; all earlier tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/server.test.ts
git commit -m "src/mcp/server: createMcpServer factory + catalog round-trip test"
```

### Task G4: Hono HTTP app

**Files:**
- Create: `calderyn-mcp/src/server.ts`

- [ ] **Step 1: Write the Hono app**

```ts
// src/server.ts
//
// HTTP edge: bearer auth → resolve {shopId, scopes} → build per-request
// reader + MCP server → stream the response. Also /healthz.

import { Hono } from "hono";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { getSupabase } from "./data/supabase";
import { authenticateBearer, maybeUpdateLastUsed } from "./auth/token";
import { calderynReader } from "./data/calderyn";
import { createMcpServer } from "./mcp/server";

export const app = new Hono();

app.get("/healthz", async (c) => {
  const started = Date.now();
  try {
    const { error } = await getSupabase().from("mcp_tokens").select("id", { head: true, count: "exact" }).limit(1);
    if (error) throw error;
    return c.json({ ok: true, ts: new Date().toISOString(), elapsed_ms: Date.now() - started });
  } catch (err) {
    const e = err as { message?: string };
    return c.json({ ok: false, error: e.message ?? String(err), elapsed_ms: Date.now() - started }, 503);
  }
});

app.all("/mcp", async (c) => {
  const requestId = randomUUID();
  const started = Date.now();
  const authHeader = c.req.header("authorization") ?? null;
  const supabase = getSupabase();

  const auth = await authenticateBearer(authHeader, supabase);
  if (!auth.ok) {
    return c.json({ error: { code: "UNAUTHORIZED", reason: auth.reason, request_id: requestId } }, 401);
  }

  // Fire-and-forget last_used update; do not block the response.
  void maybeUpdateLastUsed(supabase, auth.tokenId, auth.lastUsedAt, c.req.header("user-agent") ?? null).catch(() => {});

  const reader = calderynReader(auth.ctx.shopId, supabase);
  const server = createMcpServer(reader);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => requestId });

  // Convert Hono → Node-style req/res. The MCP SDK transport expects raw
  // IncomingMessage/ServerResponse. On Vercel Functions (Node runtime) we
  // get those off the underlying request; check the SDK README for the exact
  // adapter pattern for the version installed.
  // The pseudo-code below is the intended shape; finalise against the SDK
  // version in package.json.

  await server.connect(transport);
  const response = await transport.handleRequest(
    // @ts-expect-error: adapter shape depends on SDK version; finalise below.
    c.req.raw,
    {} as never,
  );

  const durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      request_id: requestId,
      shop_id: auth.ctx.shopId,
      duration_ms: durationMs,
      ok: true,
    }),
  );

  return response as unknown as Response;
});

export default app;
```

**Engineer note — finalise transport adapter:** The MCP SDK's `StreamableHTTPServerTransport.handleRequest` signature differs between minor versions. Two patterns are common:

1. **Node-style:** takes `(IncomingMessage, ServerResponse)` and writes to `res` directly. In that case, use `@hono/node-server` and call `serve()`-style adapters, or use `c.env.incoming` / `c.env.outgoing` on Vercel.
2. **Fetch-style:** takes a `Request` and returns a `Response`. Pass `c.req.raw` directly.

Check which pattern your installed SDK uses:

```bash
node -e "console.log(require('@modelcontextprotocol/sdk/package.json').version)"
```

Look at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js` for `handleRequest`'s actual signature. Adjust the call above and remove the `@ts-expect-error`. Add a smoke test that hits `/mcp` with a fake bearer (mocking the supabase client) and asserts a 401 → mint a real token in step H2 for the live check.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

If the `@ts-expect-error` is unused (because the SDK signature matches), remove it. Address other errors by adapting to the actual signature — do not silence with broader `as any`.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "src/server: Hono app with /mcp (Streamable HTTP) and /healthz"
```

### Task G5: Vercel entry

**Files:**
- Create: `calderyn-mcp/api/[[...slug]].ts`

- [ ] **Step 1: Write the entry**

```ts
// api/[[...slug]].ts
//
// Vercel Functions catch-all. Hono runs on the Web Fetch handler shape that
// Vercel's Node runtime exposes for the @vercel/node adapter; if your Vercel
// Node runtime expects (req, res) instead, switch to `@hono/node-server`'s
// `serve` adapter. Keep this file thin — all logic in src/server.ts.

import app from "../src/server";

export default app.fetch;

// Vercel routes /mcp, /healthz, etc. to this catch-all when no other
// api/*.ts matches. Hono handles routing inside.
export const config = {
  runtime: "nodejs",
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run the full pre-commit gate (one more time before deploy)**

```bash
npm run typecheck && npm run lint && npm run test
```

Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/[[...slug]].ts
git commit -m "api: Vercel catch-all entry → Hono fetch handler"
```

---

## Phase H — Deploy

**cwd:** `/Users/ericchen/Developer/calderyn-mcp`

### Task H1: Link to Vercel + set env vars

- [ ] **Step 1: Create a Vercel project for this repo**

```bash
vercel link
```

When prompted, create a new project named `calderyn-mcp` under the same Vercel team as `shopify-app`.

- [ ] **Step 2: Set environment variables for all three Vercel environments**

```bash
vercel env add SUPABASE_URL                 # paste from shopify-app/.env.local; set for Production, Preview, Development
vercel env add SUPABASE_SERVICE_ROLE_KEY    # same source
vercel env add MCP_TOKEN_PEPPER             # MUST match shopify-app/.env.local; set for all three envs
```

- [ ] **Step 3: Pin the deployment region to the Supabase region**

In the Vercel dashboard → calderyn-mcp project → Settings → Functions → Default Region, pick the same region as the Supabase project (check Supabase dashboard → Project Settings → General). This is one click; not script-able from the CLI cleanly.

### Task H2: Preview deploy + mcp-inspector smoke

- [ ] **Step 1: Deploy a preview**

```bash
vercel
```

Note the preview URL.

- [ ] **Step 2: Health check**

```bash
curl -fsS https://<preview-url>/healthz
```

Expected: `{ "ok": true, ... }`. If 503, check Vercel logs (`vercel logs <preview-url>`) — most likely a missing env var.

- [ ] **Step 3: Mint a token in calderyn**

Run `shopify-app` dev (`cd /Users/ericchen/Developer/shopify-app && npm run dev`), navigate to `/app/mcp`, generate a token, copy the raw `mcp_live_...` value.

- [ ] **Step 4: Connect with mcp-inspector**

```bash
npx @modelcontextprotocol/inspector
```

In the inspector UI:
- Transport: `Streamable HTTP`.
- URL: `https://<preview-url>/mcp`.
- Custom header: `Authorization: Bearer mcp_live_...`.
- Connect.

Verify:
- `tools/list` returns 7 tools.
- `resources/list` returns 6 resources.
- `call_tool list_alerts` returns the dev shop's alerts (compare against `shopify-app` `/app/alerts`).
- `call_tool get_alert` with an invalid id returns `{isError: true, code: ALERT_NOT_FOUND}`.

- [ ] **Step 5: Cross-tenant isolation check**

In Supabase, find a second shop's `shop_id` and a real alert `id` that belongs to it:

```
mcp__plugin_supabase_supabase__execute_sql(query="select shop_id, id, title from v_alerts_view where shop_id != (select shop_id from mcp_tokens where token_prefix = 'mcp_live_<your prefix>' limit 1) limit 1")
```

In mcp-inspector, call `get_alert` with that other-shop alert id. Expected: `{isError: true, code: ALERT_NOT_FOUND}` — even though the alert exists in DB, it is not visible because the reader is closed over your `shopId`.

If this returns the alert: STOP, this is a tenant-isolation bug. Audit `src/data/calderyn.ts` until fixed before promoting.

### Task H3: Production promotion

- [ ] **Step 1: Promote to production**

```bash
vercel --prod
```

- [ ] **Step 2: Attach custom domain (optional, per spec §10 step 4)**

In the Vercel dashboard → calderyn-mcp project → Domains, add `mcp.calderyn.app` (or the chosen stable domain). Update DNS as instructed by Vercel.

- [ ] **Step 3: Final health check against prod URL**

```bash
curl -fsS https://mcp.calderyn.app/healthz
```

Expected: `{ "ok": true, ... }`.

---

## Phase I — Definition of Done verification

**cwd:** either repo, end-to-end.

### Task I1: Walk the v1 DoD (spec §11)

- [ ] **Step 1: Confirm the merchant happy path**

1. Open `shopify-app` admin → MCP page → mint a fresh token.
2. Configure a custom MCP client (e.g. Claude Desktop config, or mcp-inspector) pointing at the prod URL with the new token.
3. Call `list_alerts`. Expected: alerts for this shop only.
4. Compare to the same shop's `/app/alerts` page in the admin. Expected: same alert ids.

- [ ] **Step 2: Cross-tenant negative test (final)**

Already covered by H2 step 5. Re-verify against prod with two distinct test shops if possible.

- [ ] **Step 3: Token revocation latency**

Revoke the token in the admin UI. Immediately call `list_alerts` again in the inspector. Expected: 401. There is no caching layer in v1, so revocation is effective on the next request.

- [ ] **Step 4: Confirm artefacts**

```bash
ls /Users/ericchen/Developer/calderyn-mcp/CLAUDE.md
ls /Users/ericchen/Developer/shopify-app/docs/adr/0001-mcp-server-split.md
```

Both present.

- [ ] **Step 5: Document the connection flow on the admin page**

In `shopify-app/app/routes/app.mcp.tsx`, add a `Banner` (info tone) above the table with the production MCP URL and a one-paragraph "How to connect" pointing at Claude.ai's MCP connector config. Commit as a follow-up to Task B3 in `shopify-app`:

```bash
cd /Users/ericchen/Developer/shopify-app
# edit app/routes/app.mcp.tsx — add Banner above the Layout.Section
npm run typecheck && npm run lint && npm run build
git add app/routes/app.mcp.tsx
git commit -m "routes/app.mcp: add connection-flow banner with prod MCP URL"
```

- [ ] **Step 6: Update `shopify-app/README.md` with a one-paragraph "MCP server" section**

Append to `README.md`:

```markdown
## MCP server

External agents can query this shop's read-only calderyn state via
[`calderyn-mcp`](../calderyn-mcp) (hosted at `mcp.calderyn.app`). Merchants
mint per-shop bearer tokens at `/app/mcp` and paste them into any MCP client
(Claude.ai connectors, custom agents). See
`docs/adr/0001-mcp-server-split.md` for the split rationale.
```

Commit:

```bash
git add README.md
git commit -m "README: link to calderyn-mcp + admin token page"
```

---

## Self-Review Notes

**Spec coverage check (against `docs/superpowers/specs/2026-05-25-mcp-server-design.md`):**

| Spec section | Task(s) |
|---|---|
| §3.1 Stack | D1 |
| §3.2 Repo layout | D1, D2–G5 build the layout |
| §3.3 Type duplication | D2, D5 (mappers + drift tests) |
| §4.1 Token format | B2 (`generateRaw`) |
| §4.2 `mcp_tokens` table | A1 |
| §4.3 Middleware | E1 (matches steps 1–5) |
| §4.4 Token UI | B3 |
| §4.5 OAuth forward-compat | E1 (mcp_live_ prefix check + branch) + E2 (stub) |
| §4.6 What's not in v1 | acknowledged; no rate limiting/audit log tasks |
| §5.1 Resources (7) | G1 |
| §5.2 Tools (7) | G2 |
| §5.3 Forward-compat for admin block | not implemented (correctly — spec defers); no task |
| §5.4 Write-tool forward-compat | ADR (C1) captures the rule and deferred (a)/(b) choice |
| §6.1 Tables read | F1 |
| §6.2 Service-role + shopId closure | F1 (`calderynReader(shopId, supabase)`) |
| §6.3 No resolveShopId | F1 (none used; shopId comes from token row) |
| §6.4 Output shape | D5 |
| §6.5 Connection management | D4 (singleton) |
| §6.6 No caching | nothing built — correctly deferred |
| §7.1 Error taxonomy | D3 (errors), G2 (tool error mapping), G4 (401) |
| §7.2 Logging | G4 (structured log line) |
| §7.3 Healthcheck | G4 (`/healthz`) |
| §7.4 Observability deferrals | none built |
| §8.1–8.4 Testing | D5, E1, F1, G3 + CLAUDE.md (D1) for pre-commit gate |
| §9 ADR + token UI | B3, C1 |
| §10 Rollout | A1, B3, H2, H3, I1 |
| §11 DoD | I1 |

**Type-consistency check:**
- `AuthContext` (defined in D2) referenced in E1 ✓
- `CalderynReader` (defined in F1) consumed by G1, G2, G3 ✓
- `createMcpServer(reader)` (G3) called from G4 with reader from F1 ✓
- `authenticateBearer` return shape (E1) consumed in G4 — match (`auth.tokenId`, `auth.lastUsedAt`, `auth.ctx.shopId`) ✓

**Placeholder scan:** no TODO/TBD strings; the SDK adapter call in G4 step 1 carries an explicit "finalise this" instruction with a verification command, not a hand-wave.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-calderyn-mcp.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration. Best fit because this plan spans two repos (with a `cd` between phases) and several independently-verifiable units; subagents keep the main context lean while you review each chunk.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, with batch checkpoints for review.

Which approach?
