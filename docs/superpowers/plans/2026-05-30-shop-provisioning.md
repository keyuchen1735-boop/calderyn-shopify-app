# Shop Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-create a `shops` row in Supabase when a merchant installs/authenticates, so `resolveShopId` never throws "Shop not found" for an installed shop.

**Architecture:** A `provisionShop()` helper (ensure-exists + reactivate-if-uninstalled) and a `markShopUninstalled()` helper are added to `app/lib/supabase.server.ts`. An `afterAuth` hook in `app/shopify.server.ts` calls `provisionShop` on every token-exchange (log-and-continue on failure). The uninstall webhook calls `markShopUninstalled`. A one-time `.mjs` script backfills already-installed shops from the Prisma `Session` table.

**Tech Stack:** Remix + `@shopify/shopify-app-remix`, `@supabase/supabase-js` (service-role client), Prisma (session storage), TypeScript (strict). No test framework in repo — verification is via Supabase MCP SQL checks, `npm run typecheck/lint/build`, and a real backfill run.

**Spec:** `docs/superpowers/specs/2026-05-30-shop-provisioning-design.md`
**Supabase project:** `ajgrmnvzxfxxlwrxcgnu` (Calderyn-SHOPIFY). `shop_domain` is the only NOT-NULL column without a default; it is UNIQUE.

---

## File Structure

- **Modify** `app/lib/supabase.server.ts` — add `provisionShop`, `markShopUninstalled` next to existing `getSupabase`/`resolveShopId`. One responsibility: Supabase access for shop identity.
- **Modify** `app/shopify.server.ts` — add `hooks.afterAuth` to the `shopifyApp({...})` config.
- **Modify** `app/routes/webhooks.app.uninstalled.tsx` — call `markShopUninstalled` in the handler.
- **Create** `scripts/backfill-shops.mjs` — standalone one-time backfill (plain ESM, no new dependency).

---

## Task 1: `provisionShop` and `markShopUninstalled` helpers

**Files:**
- Modify: `app/lib/supabase.server.ts` (append after `resolveShopId`, ends at line 35)

- [ ] **Step 1: Add the two helpers**

Append to `app/lib/supabase.server.ts` (after the closing `}` of `resolveShopId`):

```ts
/**
 * Ensure a shops row exists for this domain. Idempotent.
 * If the shop was previously uninstalled, reactivate it (clear uninstalled_at,
 * bump updated_at) — guarded so routine token-exchanges don't churn updated_at.
 */
export async function provisionShop(shopDomain: string): Promise<void> {
  const sb = getSupabase();
  const ins = await sb
    .from("shops")
    .upsert({ shop_domain: shopDomain }, { onConflict: "shop_domain", ignoreDuplicates: true });
  if (ins.error) throw ins.error;

  const react = await sb
    .from("shops")
    .update({ uninstalled_at: null, updated_at: new Date().toISOString() })
    .eq("shop_domain", shopDomain)
    .not("uninstalled_at", "is", null);
  if (react.error) throw react.error;
}

/** Soft-mark a shop uninstalled. Inverse of provisionShop's reactivation. */
export async function markShopUninstalled(shopDomain: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getSupabase()
    .from("shops")
    .update({ uninstalled_at: now, updated_at: now })
    .eq("shop_domain", shopDomain);
  if (error) throw error;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Verify SQL semantics against the live schema (Supabase MCP)**

These run the exact operations the helpers issue, on a throwaway domain, proving the schema accepts them. Use `mcp__plugin_supabase_supabase__execute_sql` with `project_id: ajgrmnvzxfxxlwrxcgnu`.

3a. ensure-exists (provisionShop insert half):
```sql
insert into shops (shop_domain) values ('plan-verify.myshopify.com')
on conflict (shop_domain) do nothing;
select shop_domain, onboarding_step, uninstalled_at from shops where shop_domain='plan-verify.myshopify.com';
```
Expected: one row, `onboarding_step='shopify'`, `uninstalled_at=null`.

3b. idempotent (run 3a's insert again): no error, still one row.

3c. markShopUninstalled:
```sql
update shops set uninstalled_at=now(), updated_at=now() where shop_domain='plan-verify.myshopify.com';
select uninstalled_at from shops where shop_domain='plan-verify.myshopify.com';
```
Expected: `uninstalled_at` is set (non-null).

3d. reactivate (provisionShop update half):
```sql
update shops set uninstalled_at=null, updated_at=now()
where shop_domain='plan-verify.myshopify.com' and uninstalled_at is not null;
select uninstalled_at from shops where shop_domain='plan-verify.myshopify.com';
```
Expected: `uninstalled_at=null`, exactly one row updated.

3e. cleanup:
```sql
delete from shops where shop_domain='plan-verify.myshopify.com';
```
Expected: row removed.

- [ ] **Step 4: Commit**

```bash
git add app/lib/supabase.server.ts
git commit -m "lib/supabase.server: add provisionShop + markShopUninstalled

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `afterAuth` hook provisions the shop

**Files:**
- Modify: `app/shopify.server.ts:8` (import) and `app/shopify.server.ts:10-26` (config object)

- [ ] **Step 1: Add the import**

In `app/shopify.server.ts`, after line 8 (`import prisma from "./db.server";`) add:

```ts
import { provisionShop } from "./lib/supabase.server";
```

- [ ] **Step 2: Add the `hooks.afterAuth` block**

In the `shopifyApp({...})` call, add a `hooks` property. Insert it immediately after the `sessionStorage` line (`sessionStorage: new PrismaSessionStorage(prisma),`) so it sits among the other top-level options:

```ts
  hooks: {
    afterAuth: async ({ session }) => {
      try {
        await provisionShop(session.shop);
      } catch (err) {
        console.error(
          `[afterAuth] failed to provision shop ${session.shop} in Supabase`,
          err,
        );
      }
    },
  },
```

The hook must never throw — a failed provision is logged, not propagated, so a Supabase blip can't break the app shell. `resolveShopId` remains the visible backstop.

- [ ] **Step 3: Verify it typechecks and builds**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. (`build` confirms the `.server` import doesn't leak into a client bundle.)

- [ ] **Step 4: Commit**

```bash
git add app/shopify.server.ts
git commit -m "shopify.server: provision shops row in afterAuth hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Uninstall webhook marks the shop uninstalled

**Files:**
- Modify: `app/routes/webhooks.app.uninstalled.tsx` (import at top; handler body)

- [ ] **Step 1: Add the import**

After the existing `import { CalderynError, calderynClient } from "~/lib/calderyn.server";` line, add this exact line (matching the `~/lib/...` alias already used in this file):

```ts
import { markShopUninstalled } from "~/lib/supabase.server";
```

- [ ] **Step 2: Call `markShopUninstalled` in the handler**

In `app/routes/webhooks.app.uninstalled.tsx`, after the existing Prisma cleanup block:

```ts
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
```

insert:

```ts
  try {
    await markShopUninstalled(shop);
  } catch (err) {
    console.error(`Failed to mark shop ${shop} uninstalled in Supabase`, err);
  }
```

This sits before the existing `calderynClient(shop).internal.forwardWebhook(...)` try/catch and follows the same log-and-continue pattern. The webhook still returns `new Response()`.

- [ ] **Step 3: Verify it typechecks and builds**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/webhooks.app.uninstalled.tsx
git commit -m "webhooks.app.uninstalled: soft-mark shop uninstalled in Supabase

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: One-time backfill script

**Files:**
- Create: `scripts/backfill-shops.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/backfill-shops.mjs`:

```js
// One-time backfill: ensure a shops row exists in Supabase for every shop that
// already has a Prisma session. Idempotent. Run once after deploying the
// afterAuth provisioning hook.
//
//   node scripts/backfill-shops.mjs
//
// Requires env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const prisma = new PrismaClient();
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let ok = 0;
let failed = 0;
try {
  const shops = await prisma.session.findMany({
    select: { shop: true },
    distinct: ["shop"],
  });
  console.log(`Found ${shops.length} distinct shop(s) in Prisma sessions.`);
  for (const { shop } of shops) {
    const { error } = await sb
      .from("shops")
      .upsert({ shop_domain: shop }, { onConflict: "shop_domain", ignoreDuplicates: true });
    if (error) {
      failed++;
      console.error(`FAIL ${shop}: ${error.message}`);
    } else {
      ok++;
      console.log(`ok   ${shop}`);
    }
  }
} finally {
  await prisma.$disconnect();
}

console.log(`Done. ${ok} ok, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Verify lint passes on the new file**

Run: `npm run lint`
Expected: exit 0, no warnings on `scripts/backfill-shops.mjs`.
(If ESLint does not lint `scripts/`, this is a no-op — confirm no new errors are introduced.)

- [ ] **Step 3: Run the backfill against real data**

Ensure `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` are exported in the shell, then:

Run: `node scripts/backfill-shops.mjs`
Expected: prints the distinct shop count, an `ok <shop>` line per shop, and `Done. N ok, 0 failed.` Exit 0.

- [ ] **Step 4: Verify idempotency**

Run: `node scripts/backfill-shops.mjs` (again)
Expected: same `ok` lines, `0 failed`, exit 0 — no duplicate-key errors.

- [ ] **Step 5: Confirm rows exist (Supabase MCP)**

`execute_sql` on `ajgrmnvzxfxxlwrxcgnu`:
```sql
select count(*) from shops;
select shop_domain, onboarding_step from shops order by created_at desc limit 10;
```
Expected: every domain that had a Prisma session now has a `shops` row with `onboarding_step='shopify'`.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-shops.mjs
git commit -m "scripts: one-time backfill of shops rows from Prisma sessions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Pre-commit gate (full eval pipeline) + code review

This is a "major commit" per CLAUDE.md (auth/webhook edits, `app/lib/` changes). Run the mandatory gate before opening a PR.

- [ ] **Step 1: `/code-review` on the working tree**

Run the `/code-review` slash command. Resolve every blocker; downgrade any nit explicitly with a one-line justification.

- [ ] **Step 2: Patch sanity**

Run: `git diff --check` and `git diff --stat main...HEAD`
Expected: no whitespace errors; no stray `console.log` (the intentional `console.error` calls are expected), no `.only`, no `TODO(me)`, no commented-out blocks.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: exit 0, no warnings on touched files.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exit 0, Remix + Vite build completes.

(No `prisma/schema.prisma`, migration, or `.graphql` changes in this plan, so `prisma validate` / `migrate diff` / `graphql-codegen` are N/A.)

- [ ] **Step 6: Final verification summary**

Confirm and record evidence (rule 12 — no asserting success without output):
- Task 1 SQL checks passed (ensure-exists, idempotent, mark, reactivate, cleanup).
- afterAuth + uninstall webhook compile and build.
- Backfill ran clean and is idempotent; rows confirmed in Supabase.

- [ ] **Step 7: Open PR (only when the user asks)**

Per environment rules, push/PR only on explicit request. When asked:
```bash
git push -u origin feat/shop-provisioning
gh pr create --fill
```

---

## Notes for the implementer

- **Import paths:** `app/shopify.server.ts` is at `app/`, so it imports `./lib/supabase.server`. The webhook route uses the `~/lib/...` alias (already present in the file) — match it.
- **Do not** add a lazy fallback to `resolveShopId` — it stays read-only by design.
- **Do not** add a test framework, `tsx`, or any new dependency. The backfill is deliberately plain `.mjs`.
- **Runtime trigger (a real Shopify install firing afterAuth)** cannot be exercised in this loop; it is verified by build + the SQL-semantics checks + post-deploy smoke. State that honestly — do not claim the live hook was triggered if it wasn't.
