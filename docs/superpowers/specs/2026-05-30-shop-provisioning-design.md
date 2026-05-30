# Shop row provisioning on install/auth

**Date:** 2026-05-30
**Status:** Approved (design); pending implementation plan

## Problem

`resolveShopId(shopDomain)` (`app/lib/supabase.server.ts:24`) reads `shops` by
`shop_domain` and throws `Shop not found in Supabase: <domain>` when the row is
absent. Nothing in the repo ever inserts into `shops` — there is no `afterAuth`
hook and no install webhook that creates it. A freshly-installed merchant
therefore hits that throw on every Supabase-backed read: dashboard, alerts, MCP
token page, onboarding, and every webhook forward (`calderyn.server.ts:160`).
This is a hard functional blocker, invisible in dev only because the developer
hand-seeded their own shop row.

The Calderyn HTTP backend is dead (`.env.example`: "legacy; superseded by
Supabase"), so provisioning belongs in this app, writing directly to Supabase
via the service-role client.

## Goal / success criteria

A real merchant who installs the app gets a `shops` row created automatically,
so `resolveShopId` never throws "Shop not found" for an installed shop.
Specifically:

- New install / token-exchange provisions the `shops` row.
- Re-install after uninstall reactivates the existing row.
- Shops already installed before this ships are backfilled.
- No regression to the read path; failures are visible in logs.

## Authoritative `shops` schema

Introspected live from project `ajgrmnvzxfxxlwrxcgnu` (Calderyn-SHOPIFY):

| column | nullable | default |
|---|---|---|
| `id` uuid | NO | `gen_random_uuid()` (PK) |
| `shop_domain` text | NO | *(none)* — **UNIQUE** |
| `installed_at` timestamptz | NO | `now()` |
| `uninstalled_at` timestamptz | YES | null |
| `peer_data_consent` bool | NO | `false` |
| `super_admin_disabled` bool | NO | `false` |
| `created_at` timestamptz | NO | `now()` |
| `updated_at` timestamptz | NO | `now()` |
| `onboarding_started_at` timestamptz | YES | null |
| `onboarding_completed_at` timestamptz | YES | null |
| `onboarding_step` text | NO | `'shopify'` |
| `creative_mapping_nudge_dismissed_at` timestamptz | YES | null |

`shop_domain` is the **only** `NOT NULL` column without a default, and it is
`UNIQUE`. A minimal valid insert is `insert into shops (shop_domain) values ($1)`;
everything else self-populates. Idempotency keys on `on conflict (shop_domain)`.

## Decisions

- **Trigger:** `afterAuth` hook (canonical Shopify pattern), not a lazy upsert
  inside `resolveShopId`. `resolveShopId` stays read-only and unchanged, and
  remains the visible UI backstop if a row is somehow absent.
- **Re-install:** reactivate — clear `uninstalled_at` and bump `updated_at`, but
  only when `uninstalled_at` was non-null, so routine token-exchanges don't
  churn `updated_at`. Preserve onboarding progress. Wire the uninstall webhook
  to set `uninstalled_at` so reactivation is meaningful.
- **Failure mode:** log loudly, do not block. afterAuth and the uninstall
  webhook catch + `console.error`; they never throw. afterAuth fires on every
  token exchange, so blocking on a transient Supabase blip would break the whole
  app shell.
- **Backfill:** one-time script provisioning existing `Session.shop` domains.
- **Upsert mechanism:** two app-code Supabase calls (no Postgres RPC function, no
  migration). Simplest surface that solves it; the operation is trivial and the
  non-atomicity is harmless because both halves are idempotent.

## Architecture & data flow

```
Install / token-exchange ─► afterAuth hook ─► provisionShop(shop)
                                               ├─ INSERT … ON CONFLICT(shop_domain) DO NOTHING        (ensure-exists)
                                               └─ UPDATE … SET uninstalled_at=null, updated_at=now()
                                                    WHERE shop_domain=$ AND uninstalled_at IS NOT NULL (reactivate)

Uninstall webhook ────────► markShopUninstalled(shop) ─► UPDATE … SET uninstalled_at=now(), updated_at=now()

One-time (post-deploy) ───► scripts/backfill-shops.mjs ─► ensure-exists for every distinct Session.shop

Reads (dashboard/alerts/MCP/onboarding) ─► resolveShopId(shop)  ── UNCHANGED (throws if absent = backstop)
```

## Components

### 1. `app/lib/supabase.server.ts` — two new functions

```ts
// Ensure a shops row exists for this domain; reactivate if previously uninstalled.
export async function provisionShop(shopDomain: string): Promise<void> {
  const sb = getSupabase();
  const ins = await sb.from("shops")
    .upsert({ shop_domain: shopDomain }, { onConflict: "shop_domain", ignoreDuplicates: true });
  if (ins.error) throw ins.error;
  const react = await sb.from("shops")
    .update({ uninstalled_at: null, updated_at: new Date().toISOString() })
    .eq("shop_domain", shopDomain)
    .not("uninstalled_at", "is", null);
  if (react.error) throw react.error;
}

// Soft-mark a shop uninstalled (inverse of reactivation).
export async function markShopUninstalled(shopDomain: string): Promise<void> {
  const { error } = await getSupabase().from("shops")
    .update({ uninstalled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("shop_domain", shopDomain);
  if (error) throw error;
}
```

### 2. `app/shopify.server.ts` — `hooks.afterAuth`

```ts
hooks: {
  afterAuth: async ({ session }) => {
    try {
      await provisionShop(session.shop);
    } catch (err) {
      console.error(`[afterAuth] failed to provision shop ${session.shop} in Supabase`, err);
    }
  },
},
```

Never throws. `provisionShop` imported from `./lib/supabase.server`.

### 3. `app/routes/webhooks.app.uninstalled.tsx`

Add `await markShopUninstalled(shop)` alongside the existing backend forward,
wrapped in the same catch + `console.error` style already used in that handler.
Ordering and the existing Prisma `session.deleteMany` are unchanged.

### 4. `scripts/backfill-shops.mjs`

Plain ESM (no new dependency, no `tsx`). Instantiates `PrismaClient` and
`@supabase/supabase-js` directly, reads `distinct Session.shop`, runs the
ensure-exists upsert per shop, logs `ok`/`FAIL <shop>: <msg>` per row, never
skips silently. Run once post-deploy:

```
node scripts/backfill-shops.mjs   # env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
```

Duplicates only the single ensure-exists upsert line; reactivation is not needed
for backfill because currently-installed shops have `uninstalled_at` null.

## Error handling (rule 12 — fail visibly)

- `provisionShop` / `markShopUninstalled` throw on any Supabase error.
- afterAuth and the uninstall webhook catch + `console.error` and continue; the
  request still returns 200. `resolveShopId`'s throw surfaces the broken state in
  the UI if provisioning ever failed.
- Backfill logs each row's outcome; non-zero failures are visible in stdout.

## Verification — and a surfaced conflict (rule 7)

The repo has **no test framework** and the pre-commit gate defines no test step.
Global rule 9 wants behavior tests; repo convention (rules 3, 11) says don't
introduce tooling the project doesn't use. Resolution — verify behavior without
scaffolding a framework:

1. **Eval pipeline** (the repo's actual gate, per `CLAUDE.md`):
   `npm run typecheck` → `npm run lint` → `npm run build`, all exit 0. No
   Prisma/GraphQL/migration changes, so those gate steps are N/A.
2. **Live behavior check via Supabase MCP** on throwaway domain
   `brainstorm-test.myshopify.com`, then delete it:
   - `provisionShop` → row exists, `onboarding_step='shopify'`, `uninstalled_at` null.
   - call again → no duplicate, no error (idempotent).
   - `markShopUninstalled` → `uninstalled_at` set.
   - `provisionShop` again → `uninstalled_at` cleared, `updated_at` bumped.
   - `DELETE` the throwaway row.
3. **Backfill dry-run:** run against current Prisma sessions, confirm existing
   shop(s) provisioned, idempotent on a second run.

## Out of scope / known limitations

- No lazy fallback in `resolveShopId` (by decision). Already-installed shops are
  covered by the backfill; absent that, a row would only appear on the shop's
  next token exchange.
- No `shops` schema change — the table is owned out-of-band (only `mcp_tokens`
  exists in this repo's migrations, referencing `shops(id)`).
- Onboarding state, consent, and other `shops` columns are left at their DB
  defaults on provision; managing them is existing functionality, untouched here.

## Deployment (mandatory order)

`afterAuth` fires only on token exchange — i.e. when no active offline session
exists (verified against `@shopify/shopify-app-remix` token-exchange strategy:
the hook runs inside the `if (!session || !session.isActive())` branch). A shop
installed *before* this ships, whose Prisma session is still valid, never
triggers a token exchange and so is **not** provisioned by the live hook. The
backfill is therefore the sole mechanism covering those shops:

1. Deploy the app (afterAuth hook live).
2. **Run `node scripts/backfill-shops.mjs` once** — mandatory release-gate step,
   not optional. Until it runs, pre-existing valid-session shops keep hitting
   "Shop not found" on reads.

## Files touched

- `app/lib/supabase.server.ts` (add `provisionShop`, `markShopUninstalled`)
- `app/shopify.server.ts` (add `hooks.afterAuth`)
- `app/routes/webhooks.app.uninstalled.tsx` (call `markShopUninstalled`)
- `scripts/backfill-shops.mjs` (new, one-time)
