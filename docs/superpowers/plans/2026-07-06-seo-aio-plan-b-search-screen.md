# Search (SEO & AIO) — Plan B: merchant Search screen + override/settings persistence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merchants a dead-simple **Search** dashboard screen that shows how every storefront page looks to Google and AI assistants, lets them hand-edit a page's title/description (a stored override) or hand it back to the app, and toggle AI-crawler access + store description — all persisted per shop.

**Architecture:** Plan A already generates optimized meta + JSON-LD live for every storefront page, so coverage is automatic — there is NO auto-write-on-save and NO batch backfill here. Plan B adds two shop-scoped tables (`seo_page` override-only, `seo_settings`), a thin persistence layer (`seo-store.server.ts`), read-model builders that compose the Plan A engine over the owned catalog (`overview.server.ts`), a pure `applyOverride` layer that the three storefront loaders + `robots.txt` consult, one dashboard API route (`dashboard.api.search`) with a browser client (`search-client.ts`), and the `Search.tsx` screen wired into the SPA (nav, routes, screen-cache, prefetch).

**Tech Stack:** TypeScript (strict), Remix 2.17.5 (`meta()` supports `script:ld+json`), React 18, Supabase Postgres, Vitest 4 (`environment: "node"`; component smoke tests render via `react-dom/server`).

## Global Constraints

Copied verbatim from Plan A. Every task implicitly includes these.

- Node.js 20.10+, ES modules (`"type": "module"`).
- TypeScript only. No `any` without written justification; prefer `unknown` + narrowing. `tsc --noEmit` is authoritative.
- Files ending `.server.ts` are server-only; never import them from a client module.
- Storefront is public and multi-tenant with NO Postgres RLS on that surface: every catalog/DB read is scoped by the `shopId` returned from `resolveStorefrontShop(request)`.
- Server reads Supabase via `getSupabase()` (uses `SUPABASE_SECRET_KEY`). Never reference env in client bundles.
- Browser-visible source hygiene: no comments/strings/identifiers implying AI generation, no dev overlays/debug panels, no client source maps. Keep browser-facing comments technical and product-neutral.
- No em dashes (`—`/`–`) in any user-facing copy this feature emits (titles, descriptions, alt text, screen copy). Use a middot `·`, comma, or period.
- Schema changes ship as a checked-in SQL migration in `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`, every table shop-scoped with RLS using `public.current_shop_id()`, plus `grant select ... to app_web`, plus a one-line classification in `app/lib/security/tenant-tables.ts`. Applied to prod (project `ajgrmnvzxfxxlwrxcgnu`) via the supabase MCP `apply_migration`.
- Pre-commit gate before any commit that touches routes/lib/schema: `npm run typecheck` (exit 0) -> `npm run lint` (exit 0) -> `npm run build` (exit 0). Never `--no-verify`, never silence `tsc`/eslint.
- Match existing file layout: shared logic in `app/lib/`, colocated tests in `__tests__/`.

### Plan B delta to the Global Constraints (schema bullet)

The schema bullet above says "plus a one-line classification in `app/lib/security/tenant-tables.ts`." **That does NOT apply to `seo_page` / `seo_settings`.** These are storefront-facing tenant tables and follow the frozen-census precedent already set by `storefront_event` and `seo_ai_crawl_daily`: RLS is fully self-contained in the migration (`enable row level security` + a `current_shop_id()` policy + `revoke ... from anon, authenticated` + `grant select ... to app_web`), and the table is **not** added to the `tenant-tables.ts` census. Verified: neither `storefront_event` nor `seo_ai_crawl_daily` appears in `tenant-tables.ts` — do not add these two either. Everything else in the schema bullet (migration file, `current_shop_id()`, `app_web` grant, prod apply via MCP) still holds.

---

## Shared interface contract (used across tasks)

New/changed signatures the later tasks depend on. Plan A's engine surface (`buildProductDraft`, `buildHomeDraft`, `buildCollectionDraft`, `scoreDraft`, `metaFromDraft`, `buildRobotsTxt`, `getCatalog`, `getStoreSettings`, `SeoDraft`, `HealthReport`) is assumed present and unchanged except `buildRobotsTxt`, which gains a second argument.

```ts
// app/lib/seo/override.ts  (pure — no I/O, structural override type so it needs no .server import)
export function applyOverride(
  draft: SeoDraft,
  override: { metaTitle: string | null; metaDescription: string | null } | null,
): SeoDraft;

// app/lib/seo/seo-store.server.ts
export type SeoEntityType = "product" | "home" | "collection";
export interface SeoSettings {
  allowAiCrawlers: boolean;
  allowAiTraining: boolean;
  orgName: string | null;
  orgDescription: string | null;
}
export interface SeoOverride {
  entityType: string;
  entityId: string;
  metaTitle: string | null;
  metaDescription: string | null;
}
export function getSeoSettings(shopId: string): Promise<SeoSettings>;                 // defaults if no row / non-uuid
export function upsertSeoSettings(shopId: string, patch: Partial<SeoSettings>): Promise<SeoSettings>;
export function getSeoOverride(shopId: string, entityType: string, entityId: string): Promise<SeoOverride | null>;
export function listSeoOverrides(shopId: string): Promise<Map<string, SeoOverride>>;   // key `${type}:${id}`
export function upsertSeoOverride(shopId: string, input: { entityType: string; entityId: string; metaTitle: string | null; metaDescription: string | null; updatedBy?: string | null }): Promise<void>;
export function deleteSeoOverride(shopId: string, entityType: string, entityId: string): Promise<void>;

// app/lib/seo/overview.server.ts
export interface NeedsAttentionRow { id: string; handle: string; title: string; score: number; topIssue: string | null; hasOverride: boolean; }
export interface AiCrawlRow { botName: string; hits: number; }
export interface SeoOverviewVM { storeHealth: number; productCount: number; needsAttention: NeedsAttentionRow[]; aiCrawls: AiCrawlRow[]; aiCrawlTotal: number; settings: SeoSettings; }
export interface GooglePreview { title: string; url: string; description: string; }
export interface ProductSeoDetailVM { id: string; handle: string; title: string; googlePreview: GooglePreview; health: HealthReport; override: { metaTitle: string | null; metaDescription: string | null } | null; aiSummary: string; }
export function getShopStorefrontOrigin(shopId: string): Promise<string>;   // "" when the org_slug is unknown
export function buildSeoOverview(shopId: string, storefrontOrigin: string): Promise<SeoOverviewVM>;
export function getProductSeoDetail(shopId: string, handle: string, storefrontOrigin: string): Promise<ProductSeoDetailVM>;

// app/lib/seo/site-files.server.ts (CHANGED signature)
export function buildRobotsTxt(origin: string, allowAiCrawlers?: boolean): string;   // default true

// app/lib/dashboard/search-client.ts (browser-safe mirrors of the VMs above)
export const fetchSearch: () => Promise<SeoOverviewVM>;
export const loadProductDetail: (handle: string) => Promise<ProductSeoDetailVM>;
export const saveOverride: (payload: { entityId: string; metaTitle: string; metaDescription: string }) => Promise<{ ok: true }>;
export const resetOverride: (entityId: string) => Promise<{ ok: true }>;
export const updateSettings: (patch: Partial<SeoSettings>) => Promise<{ settings: SeoSettings }>;

// app/components/dashboard/screens/Search.tsx
export default function Search({ app }: { app: DashboardCtx }): JSX.Element;
```

**Entity-id convention (must match the storefront):** product overrides key on the product's `id` (`entity_type="product"`, `entity_id=product.id`); home on `("home","home")`; collection on `("collection", collection.handle)`. The dashboard editor edits **products only** in v1; home/collection overrides are still layered by the storefront when present.

**Override semantics:** `applyOverride` replaces only `draft.title` / `draft.description`. `render.server.metaFromDraft` derives `og:title` / `og:description` from those, so the OG tags stay consistent for free. JSON-LD (schema.org `name`/`description`) stays engine-generated by design — only the human-facing SERP title/description are merchant-editable.

**Known perf cost (follow-up, not a blocker):** the storefront override lookup adds ONE indexed query per product/home/collection page view, and `robots.txt` adds one `seo_settings` read per request. Both are failure-isolated (fall back to the live draft / allow-crawlers default). A future task can memoize `seo_settings` per shop and batch the override read into the catalog query.

---

### Task B1: Migration — `seo_page` + `seo_settings`

**Files:**
- Create: `supabase/migrations/20260706194500_seo_page_settings.sql`

**Interfaces:**
- Produces: two shop-scoped tables the later tasks read/write via `seo-store.server.ts`. No app code in this task.
- Consumes: `public.current_shop_id()`, `public.shops`, the `app_web` role (all pre-existing).

Per the **Plan B delta** above: self-contained RLS in the migration; do NOT touch `app/lib/security/tenant-tables.ts`.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260706194500_seo_page_settings.sql`:

```sql
-- Merchant SEO overrides (seo_page) + per-shop SEO/AIO settings (seo_settings), Plan B.
-- seo_page is OVERRIDE-ONLY: a row exists only when a merchant hand-edited a page's
-- meta title/description. No row => the storefront serves the live engine draft (Plan A).
-- Both tables follow the storefront_event / seo_ai_crawl_daily tenant-isolation
-- convention: self-contained RLS via public.current_shop_id(); intentionally NOT added
-- to the frozen app/lib/security/tenant-tables.ts census.

create table if not exists public.seo_page (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  entity_type      text not null,
  entity_id        text not null,
  meta_title       text,
  meta_description text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  unique (shop_id, entity_type, entity_id)
);
create index if not exists seo_page_shop_idx on public.seo_page (shop_id);

alter table public.seo_page enable row level security;
drop policy if exists seo_page_shop_scope on public.seo_page;
create policy seo_page_shop_scope on public.seo_page
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_page from anon, authenticated;
grant select on table public.seo_page to app_web;

create table if not exists public.seo_settings (
  shop_id           uuid primary key references public.shops(id) on delete cascade,
  allow_ai_crawlers boolean not null default true,
  allow_ai_training boolean not null default false,
  org_name          text,
  org_description   text,
  updated_at        timestamptz not null default now()
);

alter table public.seo_settings enable row level security;
drop policy if exists seo_settings_shop_scope on public.seo_settings;
create policy seo_settings_shop_scope on public.seo_settings
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_settings from anon, authenticated;
grant select on table public.seo_settings to app_web;

-- Self-test: RLS must be enabled on both tables, or fail the apply (mirrors the
-- storefront_event / seo_ai_crawl_daily convention).
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'seo_page' and rowsecurity = true) then
    raise exception 'seo_page is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'seo_settings' and rowsecurity = true) then
    raise exception 'seo_settings is missing RLS';
  end if;
end $$;
```

- [ ] **Step 2: Confirm the census is NOT touched**

Do not edit `app/lib/security/tenant-tables.ts`. Verify (read-only) that neither `storefront_event` nor `seo_ai_crawl_daily` is present there — that is the precedent these two tables follow.

- [ ] **Step 3: Commit the migration** (applied to prod in Step 4)

```bash
git add supabase/migrations/20260706194500_seo_page_settings.sql
git commit -m "seo: add seo_page (overrides) + seo_settings tables with self-contained RLS"
```

- [ ] **Step 4: Apply the migration to prod** (OUTWARD, hard-to-reverse — confirm before running)

Writes to prod Supabase `ajgrmnvzxfxxlwrxcgnu`. Apply via the supabase MCP `mcp__supabase__apply_migration` with name `seo_page_settings` and the SQL from Step 1. Then confirm both tables exist and report RLS enabled:

Run (supabase MCP `execute_sql`):
```sql
select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('seo_page','seo_settings');
```
Expected: two rows, both `rowsecurity = true`.

Note: apply this before deploying B4/B5/B6. The storefront override lookups added in B4 are failure-isolated (a missing table degrades to the live draft), but the dashboard overview (B5/B6) reads these tables directly, so they must exist first.

---

### Task B2: Persistence layer — `seo-store.server.ts`

**Files:**
- Create: `app/lib/seo/seo-store.server.ts`
- Test: `app/lib/seo/__tests__/seo-store.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase` from `~/lib/supabase.server`.
- Produces: `SeoSettings`, `SeoOverride`, `SeoEntityType`, and `getSeoSettings`, `upsertSeoSettings`, `getSeoOverride`, `listSeoOverrides`, `upsertSeoOverride`, `deleteSeoOverride` (signatures in the shared contract).

Non-uuid (demo) shops never hit the DB — mirrors `settings.server.ts` / `crawlers.server.ts`. Every query is scoped by `shop_id`.

- [ ] **Step 1: Write the failing test** (chainable Supabase fake, extending the `events.server.test.ts` mock idiom to `select/eq/maybeSingle`, `upsert`, and `delete`)

```ts
// app/lib/seo/__tests__/seo-store.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = { seo_settings: [], seo_page: [] };
let forcedError: { message: string } | null = null;

const matches = (row: Row, filters: Record<string, unknown>) =>
  Object.entries(filters).every(([k, v]) => row[k] === v);

function makeBuilder(table: string, op: "select" | "delete") {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    select() { return builder; },
    eq(col: string, val: unknown) { filters[col] = val; return builder; },
    async maybeSingle() {
      return { data: store[table].filter((r) => matches(r, filters))[0] ?? null, error: forcedError };
    },
    // Thenable so a bare `await from().select().eq()` (list) and
    // `await from().delete().eq()...` both resolve like a real PostgREST builder.
    then(resolve: (v: { data: Row[] | null; error: unknown }) => void) {
      if (op === "delete") {
        store[table] = store[table].filter((r) => !matches(r, filters));
        resolve({ data: null, error: forcedError });
      } else {
        resolve({ data: store[table].filter((r) => matches(r, filters)), error: forcedError });
      }
    },
  };
  return builder;
}

function tableApi(table: string) {
  return {
    select() { return makeBuilder(table, "select"); },
    delete() { return makeBuilder(table, "delete"); },
    async upsert(row: Row, opts: { onConflict: string }) {
      const keys = opts.onConflict.split(",");
      store[table] = store[table].filter((r) => !keys.every((k) => r[k] === row[k]));
      store[table].push(row);
      return { error: forcedError };
    },
  };
}

vi.mock("../../supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => tableApi(t) }) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import {
  getSeoSettings, upsertSeoSettings, getSeoOverride, listSeoOverrides, upsertSeoOverride, deleteSeoOverride,
} from "../seo-store.server";

const SHOP = "11111111-2222-3333-4444-555555555555";
const DEFAULTS = { allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null };

beforeEach(() => { store.seo_settings = []; store.seo_page = []; forcedError = null; });

describe("getSeoSettings", () => {
  it("returns defaults when there is no row", async () => {
    expect(await getSeoSettings(SHOP)).toEqual(DEFAULTS);
  });
  it("returns defaults for a non-uuid (demo) shop without touching the DB", async () => {
    expect(await getSeoSettings("demo-shop")).toEqual(DEFAULTS);
  });
  it("maps a stored row", async () => {
    store.seo_settings.push({ shop_id: SHOP, allow_ai_crawlers: false, allow_ai_training: true, org_name: "Ember", org_description: "Candles" });
    expect(await getSeoSettings(SHOP)).toEqual({ allowAiCrawlers: false, allowAiTraining: true, orgName: "Ember", orgDescription: "Candles" });
  });
});

describe("upsertSeoSettings", () => {
  it("writes only the patched columns and returns the merged settings", async () => {
    const out = await upsertSeoSettings(SHOP, { allowAiCrawlers: false, orgName: "Ember" });
    expect(out).toEqual({ allowAiCrawlers: false, allowAiTraining: false, orgName: "Ember", orgDescription: null });
    const out2 = await upsertSeoSettings(SHOP, { orgDescription: "Small-batch candles" });
    expect(out2.orgDescription).toBe("Small-batch candles");
    expect(out2.allowAiCrawlers).toBe(false); // preserved from the first patch
  });
  it("throws for a non-uuid shop", async () => {
    await expect(upsertSeoSettings("demo-shop", { allowAiCrawlers: false })).rejects.toThrow();
  });
});

describe("seo_page overrides", () => {
  it("getSeoOverride is null when absent, the row when present", async () => {
    expect(await getSeoOverride(SHOP, "product", "p1")).toBeNull();
    await upsertSeoOverride(SHOP, { entityType: "product", entityId: "p1", metaTitle: "T", metaDescription: "D", updatedBy: "u1" });
    expect(await getSeoOverride(SHOP, "product", "p1")).toEqual({ entityType: "product", entityId: "p1", metaTitle: "T", metaDescription: "D" });
  });
  it("upsert replaces on the (shop,type,id) conflict key", async () => {
    await upsertSeoOverride(SHOP, { entityType: "product", entityId: "p1", metaTitle: "One", metaDescription: "D" });
    await upsertSeoOverride(SHOP, { entityType: "product", entityId: "p1", metaTitle: "Two", metaDescription: "D" });
    expect(store.seo_page.filter((r) => r.entity_id === "p1")).toHaveLength(1);
    expect((await getSeoOverride(SHOP, "product", "p1"))?.metaTitle).toBe("Two");
  });
  it("listSeoOverrides keys by `${type}:${id}`", async () => {
    await upsertSeoOverride(SHOP, { entityType: "product", entityId: "p1", metaTitle: "T", metaDescription: "D" });
    await upsertSeoOverride(SHOP, { entityType: "home", entityId: "home", metaTitle: "H", metaDescription: "D" });
    const map = await listSeoOverrides(SHOP);
    expect(map.get("product:p1")?.metaTitle).toBe("T");
    expect(map.get("home:home")?.metaTitle).toBe("H");
  });
  it("deleteSeoOverride removes the row", async () => {
    await upsertSeoOverride(SHOP, { entityType: "product", entityId: "p1", metaTitle: "T", metaDescription: "D" });
    await deleteSeoOverride(SHOP, "product", "p1");
    expect(await getSeoOverride(SHOP, "product", "p1")).toBeNull();
  });
  it("skips the DB for non-uuid shops (list empty, get null, delete no-op)", async () => {
    expect((await listSeoOverrides("demo-shop")).size).toBe(0);
    expect(await getSeoOverride("demo-shop", "product", "p1")).toBeNull();
    await expect(deleteSeoOverride("demo-shop", "product", "p1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/seo-store.server.test.ts`
Expected: FAIL (`Cannot find module '../seo-store.server'`).

- [ ] **Step 3: Implement `seo-store.server.ts`**

```ts
// app/lib/seo/seo-store.server.ts
// Persistence for merchant SEO overrides (seo_page) + per-shop SEO/AIO settings
// (seo_settings). Service-role client; every query is scoped by shop_id. seo_page
// is OVERRIDE-ONLY: a row exists only when a merchant hand-edited a page's meta;
// absence means the storefront serves the live engine draft. Non-uuid (demo)
// shops never touch the DB (mirrors settings.server.ts / crawlers.server.ts).
import { getSupabase } from "~/lib/supabase.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SeoEntityType = "product" | "home" | "collection";

export interface SeoSettings {
  allowAiCrawlers: boolean;
  allowAiTraining: boolean;
  orgName: string | null;
  orgDescription: string | null;
}

export interface SeoOverride {
  entityType: string;
  entityId: string;
  metaTitle: string | null;
  metaDescription: string | null;
}

const DEFAULT_SETTINGS: SeoSettings = {
  allowAiCrawlers: true,
  allowAiTraining: false,
  orgName: null,
  orgDescription: null,
};

export async function getSeoSettings(shopId: string): Promise<SeoSettings> {
  if (!UUID_RE.test(shopId)) return { ...DEFAULT_SETTINGS };
  const { data, error } = await getSupabase()
    .from("seo_settings")
    .select("allow_ai_crawlers, allow_ai_training, org_name, org_description")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_SETTINGS };
  return {
    // Present-but-false must survive; only a truly missing column falls to default.
    allowAiCrawlers: data.allow_ai_crawlers !== false,
    allowAiTraining: data.allow_ai_training === true,
    orgName: (data.org_name as string | null) ?? null,
    orgDescription: (data.org_description as string | null) ?? null,
  };
}

export async function upsertSeoSettings(shopId: string, patch: Partial<SeoSettings>): Promise<SeoSettings> {
  if (!UUID_RE.test(shopId)) throw new Error(`upsertSeoSettings requires a real (uuid) shop_id, got ${shopId}`);
  const row: Record<string, unknown> = { shop_id: shopId, updated_at: new Date().toISOString() };
  if (patch.allowAiCrawlers !== undefined) row.allow_ai_crawlers = patch.allowAiCrawlers;
  if (patch.allowAiTraining !== undefined) row.allow_ai_training = patch.allowAiTraining;
  if (patch.orgName !== undefined) row.org_name = patch.orgName;
  if (patch.orgDescription !== undefined) row.org_description = patch.orgDescription;
  const { error } = await getSupabase().from("seo_settings").upsert(row, { onConflict: "shop_id" });
  if (error) throw error;
  return getSeoSettings(shopId);
}

function mapOverride(row: Record<string, unknown>): SeoOverride {
  return {
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    metaTitle: (row.meta_title as string | null) ?? null,
    metaDescription: (row.meta_description as string | null) ?? null,
  };
}

export async function getSeoOverride(shopId: string, entityType: string, entityId: string): Promise<SeoOverride | null> {
  if (!UUID_RE.test(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("seo_page")
    .select("entity_type, entity_id, meta_title, meta_description")
    .eq("shop_id", shopId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapOverride(data) : null;
}

export async function listSeoOverrides(shopId: string): Promise<Map<string, SeoOverride>> {
  const out = new Map<string, SeoOverride>();
  if (!UUID_RE.test(shopId)) return out;
  const { data, error } = await getSupabase()
    .from("seo_page")
    .select("entity_type, entity_id, meta_title, meta_description")
    .eq("shop_id", shopId);
  if (error) throw error;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const o = mapOverride(row);
    out.set(`${o.entityType}:${o.entityId}`, o);
  }
  return out;
}

export async function upsertSeoOverride(
  shopId: string,
  input: { entityType: string; entityId: string; metaTitle: string | null; metaDescription: string | null; updatedBy?: string | null },
): Promise<void> {
  if (!UUID_RE.test(shopId)) throw new Error(`upsertSeoOverride requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("seo_page").upsert(
    {
      shop_id: shopId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      meta_title: input.metaTitle,
      meta_description: input.metaDescription,
      updated_by: input.updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id,entity_type,entity_id" },
  );
  if (error) throw error;
}

export async function deleteSeoOverride(shopId: string, entityType: string, entityId: string): Promise<void> {
  if (!UUID_RE.test(shopId)) return;
  const { error } = await getSupabase()
    .from("seo_page")
    .delete()
    .eq("shop_id", shopId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (error) throw error;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/seo-store.server.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/seo-store.server.ts app/lib/seo/__tests__/seo-store.server.test.ts
git commit -m "seo: add seo-store persistence for overrides + settings"
```

---

### Task B3: Read-model builders — `overview.server.ts` (+ `getShopStorefrontOrigin`)

**Files:**
- Create: `app/lib/seo/overview.server.ts`
- Test: `app/lib/seo/__tests__/overview.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`; `getCatalog` (`~/lib/storefront/catalog.server`); `getStoreSettings` (`~/lib/storefront/settings.server`); `tenantDomain` (`~/lib/storefront/vercel-domain.server`); `buildProductDraft`, `scoreDraft`, `applyOverride` (from B4's `override.ts`), `getSeoOverride`, `listSeoOverrides`, `getSeoSettings`, `SeoSettings` (from B2); `CalderynError` (`~/lib/calderyn.server`); `HealthReport` from `./types`.
- Produces: `buildSeoOverview`, `getProductSeoDetail`, `getShopStorefrontOrigin` and the VM types (signatures in the shared contract).

> **Ordering note:** `overview.server.ts` imports `applyOverride` from `./override`, which is created in Task B4 Step 3. If you execute strictly in order, create `app/lib/seo/override.ts` (B4 Step 3's code) first, or run B4 before B3. The B3 test does not import `override.ts` directly, but the module import chain does.

- [ ] **Step 1: Write the failing test** (mock catalog + settings + seo-store + supabase; keep the real writer/score/override so the score math is exercised)

```ts
// app/lib/seo/__tests__/overview.server.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const ORIGIN = "https://ember.calderyncompany.com";
const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "minimal" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
// Product A is complete (scores 100); Product B has no image + empty description
// (share-image and meta-description checks fail => below 100).
const good: StoreProduct = {
  id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle",
  description: "Hand-poured cedar and bergamot soy candle, made in small batches in Amsterdam.",
  images: [{ url: "https://img/1.webp", alt: "Cedar" }],
  variants: [{ id: "v1", sku: "CB", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
  collections: [],
};
const weak: StoreProduct = {
  id: "p2", handle: "plain", title: "Plain",
  description: "",
  images: [],
  variants: [{ id: "v2", sku: null, title: "x", priceCents: 0, currency: "EUR", available: false }],
  collections: [],
};

vi.mock("../../storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => [good, weak],
    getProduct: async (_s: string, h: string) => [good, weak].find((p) => p.handle === h) ?? null,
    listCollections: async () => [],
  }),
}));
vi.mock("../../storefront/settings.server", () => ({ getStoreSettings: async () => store }));
vi.mock("../seo-store.server", () => ({
  listSeoOverrides: async () => new Map(),
  getSeoOverride: async () => null,
  getSeoSettings: async () => ({ allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null }),
}));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select() { return b; },
        eq() { return b; },
        gte() { return b; },
        async maybeSingle() { return table === "shops" ? { data: { org_slug: "ember" }, error: null } : { data: null, error: null }; },
        then(res: (v: { data: unknown[]; error: null }) => void) {
          if (table === "seo_ai_crawl_daily") {
            res({ data: [{ bot_name: "GPTBot", hits: 3 }, { bot_name: "PerplexityBot", hits: 2 }, { bot_name: "GPTBot", hits: 4 }], error: null });
          } else {
            res({ data: [], error: null });
          }
        },
      };
      return b;
    },
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { buildSeoOverview, getProductSeoDetail, getShopStorefrontOrigin } from "../overview.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

describe("getShopStorefrontOrigin", () => {
  it("builds the tenant origin from org_slug", async () => {
    expect(await getShopStorefrontOrigin(SHOP)).toBe("https://ember.calderyncompany.com");
  });
  it("returns a relative base for a non-uuid shop", async () => {
    expect(await getShopStorefrontOrigin("demo-shop")).toBe("");
  });
});

describe("buildSeoOverview", () => {
  it("averages product health and lists only sub-100 pages worst-first", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.productCount).toBe(2);
    expect(vm.storeHealth).toBe(86); // round((100 + 71) / 2)
    expect(vm.needsAttention.map((r) => r.id)).toEqual(["p2"]);
    expect(vm.needsAttention[0].score).toBeLessThan(100);
    expect(vm.needsAttention[0].topIssue).toBeTruthy();
    expect(vm.needsAttention[0].hasOverride).toBe(false);
  });
  it("summarizes AI crawls per bot, descending, with a total", async () => {
    const vm = await buildSeoOverview(SHOP, ORIGIN);
    expect(vm.aiCrawls).toEqual([{ botName: "GPTBot", hits: 7 }, { botName: "PerplexityBot", hits: 2 }]);
    expect(vm.aiCrawlTotal).toBe(9);
  });
});

describe("getProductSeoDetail", () => {
  it("returns a SERP preview, health report and a plain AI summary", async () => {
    const d = await getProductSeoDetail(SHOP, "cedar-bloom", ORIGIN);
    expect(d.id).toBe("p1");
    expect(d.googlePreview.title).toBe("Cedar Bloom Candle · Ember House");
    expect(d.googlePreview.url).toBe("https://ember.calderyncompany.com/storefront/products/cedar-bloom");
    expect(d.health.score).toBe(100);
    expect(d.override).toBeNull();
    expect(d.aiSummary).toContain("Ember House");
  });
  it("throws a 404 CalderynError for an unknown handle", async () => {
    await expect(getProductSeoDetail(SHOP, "nope", ORIGIN)).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/overview.server.test.ts`
Expected: FAIL (module not found). (If `override.ts` does not yet exist, the import chain also fails — create it via B4 Step 3 first, or run B4 before B3.)

- [ ] **Step 3: Implement `overview.server.ts`**

```ts
// app/lib/seo/overview.server.ts
// Read-models for the merchant Search screen. Composes the Plan A engine
// (writer -> score) over the owned catalog with the merchant's stored overrides +
// settings (seo-store) and the AI-crawler counters (seo_ai_crawl_daily). Every
// read is scoped by shop_id; service-role client.
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { CalderynError } from "~/lib/calderyn.server";
import { buildProductDraft } from "./writer.server";
import { scoreDraft } from "./score.server";
import { applyOverride } from "./override";
import { getSeoOverride, listSeoOverrides, getSeoSettings, type SeoSettings } from "./seo-store.server";
import type { HealthReport } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRAWL_WINDOW_DAYS = 28;
const NEEDS_ATTENTION_CAP = 12;

export interface NeedsAttentionRow {
  id: string;
  handle: string;
  title: string;
  score: number;
  topIssue: string | null;
  hasOverride: boolean;
}
export interface AiCrawlRow { botName: string; hits: number; }
export interface SeoOverviewVM {
  storeHealth: number;
  productCount: number;
  needsAttention: NeedsAttentionRow[];
  aiCrawls: AiCrawlRow[];
  aiCrawlTotal: number;
  settings: SeoSettings;
}
export interface GooglePreview { title: string; url: string; description: string; }
export interface ProductSeoDetailVM {
  id: string;
  handle: string;
  title: string;
  googlePreview: GooglePreview;
  health: HealthReport;
  override: { metaTitle: string | null; metaDescription: string | null } | null;
  aiSummary: string;
}

/** Absolute storefront origin for a shop, resolved from shops.org_slug. Falls back
 *  to a relative base ("") when the slug is unknown (e.g. an import-only Shopify
 *  shop): canonical/preview URLs then render relative, never with a wrong host. */
export async function getShopStorefrontOrigin(shopId: string): Promise<string> {
  if (!UUID_RE.test(shopId)) return "";
  const { data, error } = await getSupabase().from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (error) throw error;
  const slug = typeof data?.org_slug === "string" ? data.org_slug.trim() : "";
  return slug ? `https://${tenantDomain(slug)}` : "";
}

async function summariseAiCrawls(shopId: string): Promise<{ rows: AiCrawlRow[]; total: number }> {
  if (!UUID_RE.test(shopId)) return { rows: [], total: 0 };
  const since = new Date(Date.now() - CRAWL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await getSupabase()
    .from("seo_ai_crawl_daily")
    .select("bot_name, hits")
    .eq("shop_id", shopId)
    .gte("day", since);
  if (error) throw error;
  const byBot = new Map<string, number>();
  let total = 0;
  for (const r of (data ?? []) as { bot_name: string; hits: number }[]) {
    const hits = Number(r.hits) || 0;
    total += hits;
    byBot.set(String(r.bot_name), (byBot.get(String(r.bot_name)) ?? 0) + hits);
  }
  const rows = [...byBot.entries()].map(([botName, hits]) => ({ botName, hits })).sort((a, b) => b.hits - a.hits);
  return { rows, total };
}

/** First failing check's plain-language label, or null when everything passes. */
function topIssue(report: HealthReport): string | null {
  const bad = report.checks.find((c) => c.status !== "pass");
  return bad ? bad.label : null;
}

export async function buildSeoOverview(shopId: string, storefrontOrigin: string): Promise<SeoOverviewVM> {
  const [products, overrides, settings, crawls, store] = await Promise.all([
    getCatalog().listProducts(shopId),
    listSeoOverrides(shopId),
    getSeoSettings(shopId),
    summariseAiCrawls(shopId),
    getStoreSettings(shopId),
  ]);

  let scoreSum = 0;
  const rows: NeedsAttentionRow[] = [];
  for (const p of products) {
    const override = overrides.get(`product:${p.id}`) ?? null;
    const draft = applyOverride(buildProductDraft(p, store, storefrontOrigin), override);
    const report = scoreDraft(draft);
    scoreSum += report.score;
    if (report.score < 100) {
      rows.push({ id: p.id, handle: p.handle, title: p.title, score: report.score, topIssue: topIssue(report), hasOverride: override != null });
    }
  }
  rows.sort((a, b) => a.score - b.score);

  return {
    storeHealth: products.length ? Math.round(scoreSum / products.length) : 0,
    productCount: products.length,
    needsAttention: rows.slice(0, NEEDS_ATTENTION_CAP),
    aiCrawls: crawls.rows,
    aiCrawlTotal: crawls.total,
    settings,
  };
}

export async function getProductSeoDetail(shopId: string, handle: string, storefrontOrigin: string): Promise<ProductSeoDetailVM> {
  const product = await getCatalog().getProduct(shopId, handle);
  if (!product) throw new CalderynError({ code: "not_found", status: 404, message: "Product not found" });
  const [store, override] = await Promise.all([
    getStoreSettings(shopId),
    getSeoOverride(shopId, "product", product.id),
  ]);
  const draft = applyOverride(buildProductDraft(product, store, storefrontOrigin), override);
  const health = scoreDraft(draft);

  const sellable = product.variants.filter((v) => v.priceCents > 0);
  const priceCents = sellable.length ? Math.min(...sellable.map((v) => v.priceCents)) : 0;
  const currency = sellable[0]?.currency ?? "";
  const inStock = product.variants.some((v) => v.available);
  const aiSummary = priceCents
    ? `${product.title} from ${store.storeName}. Priced at ${(priceCents / 100).toFixed(2)} ${currency}, ${inStock ? "in stock" : "out of stock"}.`
    : `${product.title} from ${store.storeName}. Not currently for sale.`;

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    googlePreview: { title: draft.title, url: draft.canonical, description: draft.description },
    health,
    override: override ? { metaTitle: override.metaTitle, metaDescription: override.metaDescription } : null,
    aiSummary,
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/overview.server.test.ts`
Expected: PASS. If `storeHealth` is not 86, confirm Product B scores 71 (5 of 7 checks pass: title, canonical, structured data, breadcrumb, alt; description + share-image fail) and Product A scores 100.

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/overview.server.ts app/lib/seo/__tests__/overview.server.test.ts
git commit -m "seo: add Search overview + product-detail read-models"
```

---

### Task B4: Override layering — `applyOverride`, storefront loaders, `robots.txt` AI flag

**Files:**
- Create: `app/lib/seo/override.ts`
- Test: `app/lib/seo/__tests__/override.test.ts`
- Test: `app/lib/seo/__tests__/override-meta.test.ts` (composition guard: writer -> applyOverride -> render)
- Modify: `app/lib/seo/site-files.server.ts` (`buildRobotsTxt` gains `allowAiCrawlers`)
- Modify: `app/lib/seo/__tests__/site-files.server.test.ts` (assert the disallow path)
- Modify: `app/routes/[robots.txt].tsx` (resolve tenant, read `seo_settings`, pass the flag)
- Modify: `app/routes/storefront.products.$handle.tsx` (apply product override)
- Modify: `app/routes/storefront._index.tsx` (apply home override)
- Modify: `app/routes/storefront.collections.$handle.tsx` (apply collection override)

**Interfaces:**
- Consumes: `SeoDraft` from `./types`; `getSeoOverride`, `getSeoSettings` from `./seo-store.server`; existing storefront-loader helpers.
- Produces: `applyOverride`; the changed `buildRobotsTxt` signature; three storefront loaders that layer overrides.

- [ ] **Step 1: Write the failing `applyOverride` test**

```ts
// app/lib/seo/__tests__/override.test.ts
import { describe, it, expect } from "vitest";
import { applyOverride } from "../override";
import type { SeoDraft } from "../types";

const base: SeoDraft = {
  title: "Gen Title · Store",
  description: "Generated description that is long enough to pass.",
  canonical: "https://x/storefront/products/p",
  ogImage: "https://img/1.webp", ogType: "product", imageAlts: [],
  jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "P" }],
};

describe("applyOverride", () => {
  it("returns the draft unchanged when the override is null", () => {
    expect(applyOverride(base, null)).toEqual(base);
  });
  it("overrides title and description, leaving canonical + JSON-LD untouched", () => {
    const d = applyOverride(base, { metaTitle: "My Title", metaDescription: "My description." });
    expect(d.title).toBe("My Title");
    expect(d.description).toBe("My description.");
    expect(d.canonical).toBe(base.canonical);
    expect(d.jsonLd).toBe(base.jsonLd);
  });
  it("overrides only the provided field, keeping the other generated", () => {
    const d = applyOverride(base, { metaTitle: "Only Title", metaDescription: null });
    expect(d.title).toBe("Only Title");
    expect(d.description).toBe(base.description);
  });
  it("ignores blank override strings", () => {
    expect(applyOverride(base, { metaTitle: "   ", metaDescription: "" })).toEqual(base);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/override.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `override.ts`**

```ts
// app/lib/seo/override.ts
// Pure override layering. A merchant's stored meta_title/meta_description win over
// the engine-generated draft. render.server derives og:title/og:description from
// draft.title/description, so overriding those keeps the OG tags consistent for
// free. JSON-LD (schema.org name/description) stays engine-generated by design:
// only the human-facing SERP title/description are merchant-editable in v1.
// The override argument is structural (metaTitle/metaDescription) so this module
// stays pure and needs no import from seo-store.server.
import type { SeoDraft } from "./types";

export function applyOverride(
  draft: SeoDraft,
  override: { metaTitle: string | null; metaDescription: string | null } | null,
): SeoDraft {
  if (!override) return draft;
  const title = override.metaTitle?.trim();
  const description = override.metaDescription?.trim();
  if (!title && !description) return draft;
  return {
    ...draft,
    title: title || draft.title,
    description: description || draft.description,
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/override.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the composition guard test** (proves render keeps OG consistent with the override)

```ts
// app/lib/seo/__tests__/override-meta.test.ts
import { describe, it, expect } from "vitest";
import { buildProductDraft } from "../writer.server";
import { applyOverride } from "../override";
import { metaFromDraft } from "../render.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Candles.", vibe: "minimal" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const product: StoreProduct = {
  id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle", description: "Soy candle.",
  images: [{ url: "https://img/1.webp", alt: null }],
  variants: [{ id: "v1", sku: "CB", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
  collections: [],
};
const ORIGIN = "https://ember.calderyncompany.com";

describe("override + render", () => {
  it("og:title/description follow the overridden values", () => {
    const draft = applyOverride(
      buildProductDraft(product, store, ORIGIN),
      { metaTitle: "Custom Title", metaDescription: "Custom description that sells." },
    );
    const m = metaFromDraft(draft);
    expect(m).toContainEqual({ title: "Custom Title" });
    expect(m).toContainEqual({ property: "og:title", content: "Custom Title" });
    expect(m).toContainEqual({ name: "description", content: "Custom description that sells." });
    expect(m).toContainEqual({ property: "og:description", content: "Custom description that sells." });
    // Canonical is engine-owned and unchanged by an override.
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: `${ORIGIN}/storefront/products/cedar-bloom` });
  });
});
```

Run: `npx vitest run app/lib/seo/__tests__/override-meta.test.ts`
Expected: PASS.

- [ ] **Step 6: Change `buildRobotsTxt` to honor an AI-crawler flag**

In `app/lib/seo/site-files.server.ts`, replace the existing `buildRobotsTxt` (currently `export function buildRobotsTxt(origin: string): string { ... "Allow: /" ... }`) with:

```ts
export function buildRobotsTxt(origin: string, allowAiCrawlers = true): string {
  // Standard search crawlers are always welcome (Allow: /). Only the AI-bot
  // blocks flip: allow => cite this store; deny => ask them not to crawl.
  const aiRule = allowAiCrawlers ? "Allow: /" : "Disallow: /";
  const aiBlocks = AI_BOTS_ALLOWED.map((b) => `User-agent: ${b}\n${aiRule}`).join("\n\n");
  const heading = allowAiCrawlers
    ? "# AI assistants are welcome to read and cite this store."
    : "# AI assistants are asked not to crawl this store.";
  return [
    "User-agent: *",
    "Allow: /",
    "",
    heading,
    aiBlocks,
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}
```

(`AI_BOTS_ALLOWED` already exists at the top of the file.)

- [ ] **Step 7: Extend the site-files test for the disallow path**

In `app/lib/seo/__tests__/site-files.server.test.ts`, add to the `describe("buildRobotsTxt", ...)` block:

```ts
  it("disallows the AI bots when allowAiCrawlers is false, keeping generic crawlers allowed", () => {
    const txt = buildRobotsTxt(ORIGIN, false);
    expect(txt).toContain("User-agent: GPTBot\nDisallow: /");
    expect(txt).toContain("User-agent: *\nAllow: /");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });
```

Run: `npx vitest run app/lib/seo/__tests__/site-files.server.test.ts`
Expected: PASS (existing default-true cases + the new disallow case).

- [ ] **Step 8: Wire `robots.txt` to per-shop settings**

Replace the whole body of `app/routes/[robots.txt].tsx` with:

```ts
// app/routes/[robots.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { buildRobotsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const origin = storefrontOrigin(request);
  // Failure-isolated: a settings hiccup must still return a valid robots.txt.
  // Default to allowing AI crawlers (the product default) if the lookup fails.
  let allowAiCrawlers = true;
  try {
    const shopId = await resolveStorefrontShop(request);
    allowAiCrawlers = (await getSeoSettings(shopId)).allowAiCrawlers;
  } catch (err) {
    console.error("[storefront] robots.txt settings lookup failed:", err);
  }
  return new Response(buildRobotsTxt(origin, allowAiCrawlers), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
```

- [ ] **Step 9: Layer the product override in the PDP loader**

In `app/routes/storefront.products.$handle.tsx`, add two imports next to the existing seo imports:

```ts
import { getSeoOverride } from "~/lib/seo/seo-store.server";
import { applyOverride } from "~/lib/seo/override";
```

Then, inside the existing `try` block, replace this line:

```ts
    seoMeta = metaFromDraft(buildProductDraft(product, settings, storefrontOrigin(request)));
```

with:

```ts
    const draft = buildProductDraft(product, settings, storefrontOrigin(request));
    const override = await getSeoOverride(shopId, "product", product.id);
    seoMeta = metaFromDraft(applyOverride(draft, override));
```

(The surrounding `try/catch` failure isolation and the `catch` fallback `seoMeta = [{ title: product.title }]` stay exactly as they are: a failed override lookup degrades to the live draft.)

- [ ] **Step 10: Layer the home override in the index loader**

In `app/routes/storefront._index.tsx`, add:

```ts
import { getSeoOverride } from "~/lib/seo/seo-store.server";
import { applyOverride } from "~/lib/seo/override";
```

Inside the existing `try` block, replace:

```ts
    seoMeta = metaFromDraft(buildHomeDraft(settings, storefrontOrigin(request)));
```

with:

```ts
    const draft = buildHomeDraft(settings, storefrontOrigin(request));
    const override = await getSeoOverride(shopId, "home", "home");
    seoMeta = metaFromDraft(applyOverride(draft, override));
```

- [ ] **Step 11: Layer the collection override in the collection loader**

In `app/routes/storefront.collections.$handle.tsx`, add:

```ts
import { getSeoOverride } from "~/lib/seo/seo-store.server";
import { applyOverride } from "~/lib/seo/override";
```

Inside the existing `try` block, replace:

```ts
    seoMeta = metaFromDraft(buildCollectionDraft({ handle, title, description: null }, settings, storefrontOrigin(request)));
```

with:

```ts
    const draft = buildCollectionDraft({ handle, title, description: null }, settings, storefrontOrigin(request));
    const override = await getSeoOverride(shopId, "collection", handle);
    seoMeta = metaFromDraft(applyOverride(draft, override));
```

- [ ] **Step 12: Typecheck the wired routes**

Run: `npm run typecheck`
Expected: exit 0. (The route edits are pure composition of already-tested units; the automated coverage is the `override` + `override-meta` + `site-files` tests above.)

- [ ] **Step 13: Commit**

```bash
git add app/lib/seo/override.ts app/lib/seo/__tests__/override.test.ts app/lib/seo/__tests__/override-meta.test.ts \
  app/lib/seo/site-files.server.ts app/lib/seo/__tests__/site-files.server.test.ts \
  "app/routes/[robots.txt].tsx" app/routes/storefront.products.\$handle.tsx app/routes/storefront._index.tsx app/routes/storefront.collections.\$handle.tsx
git commit -m "storefront: layer merchant SEO overrides + robots AI-crawler toggle"
```

---

### Task B5: Dashboard API route + browser client — `dashboard.api.search`

**Files:**
- Create: `app/routes/dashboard.api.search.tsx`
- Create: `app/lib/dashboard/search-client.ts`
- Test: `app/routes/__tests__/dashboard.api.search.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession` (`~/lib/dashboard/session.server`); `dashboardJson`, `jsonError`, `requireSameOrigin` (`~/lib/dashboard/http.server`); `buildSeoOverview`, `getProductSeoDetail`, `getShopStorefrontOrigin` (B3); `upsertSeoOverride`, `deleteSeoOverride`, `upsertSeoSettings` (B2); `apiGet`, `apiSend` (`~/lib/dashboard/client`).
- Produces: the `/dashboard/api/search` loader + action; the client `fetchSearch` / `loadProductDetail` / `saveOverride` / `resetOverride` / `updateSettings`.

- [ ] **Step 1: Write the failing route test** (mirrors `dashboard.api.catalog.collections.test.ts`)

```ts
// app/routes/__tests__/dashboard.api.search.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1", userId: "u1", shopDomain: null, sessionId: "s1" }),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string, m?: string) => new Response(JSON.stringify({ error: e, message: m }), { status: s }),
}));
const buildSeoOverview = vi.fn().mockResolvedValue({ storeHealth: 82, productCount: 3, needsAttention: [], aiCrawls: [], aiCrawlTotal: 0, settings: { allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null } });
const getProductSeoDetail = vi.fn().mockResolvedValue({ id: "p1", handle: "cedar", title: "Cedar", googlePreview: { title: "t", url: "u", description: "d" }, health: { score: 100, checks: [] }, override: null, aiSummary: "s" });
const getShopStorefrontOrigin = vi.fn().mockResolvedValue("https://ember.calderyncompany.com");
vi.mock("~/lib/seo/overview.server", () => ({ buildSeoOverview, getProductSeoDetail, getShopStorefrontOrigin }));
const upsertSeoOverride = vi.fn().mockResolvedValue(undefined);
const deleteSeoOverride = vi.fn().mockResolvedValue(undefined);
const upsertSeoSettings = vi.fn().mockResolvedValue({ allowAiCrawlers: false, allowAiTraining: false, orgName: "Ember", orgDescription: null });
vi.mock("~/lib/seo/seo-store.server", () => ({ upsertSeoOverride, deleteSeoOverride, upsertSeoSettings }));

import { loader, action } from "../dashboard.api.search";
import { requireSameOrigin } from "~/lib/dashboard/http.server";

function req(body?: unknown, method = "POST") {
  return new Request("https://app.x/dashboard/api/search", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("dashboard.api.search loader", () => {
  it("returns the overview for the session shop + resolved origin", async () => {
    const res = (await loader({ request: req(undefined, "GET") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(buildSeoOverview).toHaveBeenCalledWith("shop1", "https://ember.calderyncompany.com");
    expect((await res.json()).storeHealth).toBe(82);
  });
});

describe("dashboard.api.search action", () => {
  it("runs the same-origin CSRF check before anything else", async () => {
    await action({ request: req({ action: "detail", handle: "cedar" }) } as never);
    expect(requireSameOrigin).toHaveBeenCalled();
  });
  it("405s a non-POST method", async () => {
    const res = (await action({ request: req({ action: "detail" }, "PUT") } as never)) as Response;
    expect(res.status).toBe(405);
  });
  it("detail resolves the product detail with the origin", async () => {
    const res = (await action({ request: req({ action: "detail", handle: "cedar" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(getProductSeoDetail).toHaveBeenCalledWith("shop1", "cedar", "https://ember.calderyncompany.com");
  });
  it("saveOverride persists trimmed fields scoped to the session user + product entity", async () => {
    const res = (await action({ request: req({ action: "saveOverride", entityId: "p1", metaTitle: " Title ", metaDescription: " Desc " }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoOverride).toHaveBeenCalledWith("shop1", { entityType: "product", entityId: "p1", metaTitle: "Title", metaDescription: "Desc", updatedBy: "u1" });
  });
  it("saveOverride 422s a blank title without touching the store", async () => {
    const res = (await action({ request: req({ action: "saveOverride", entityId: "p1", metaTitle: "   ", metaDescription: "Desc" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(upsertSeoOverride).not.toHaveBeenCalled();
  });
  it("resetOverride deletes the product override", async () => {
    const res = (await action({ request: req({ action: "resetOverride", entityId: "p1" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(deleteSeoOverride).toHaveBeenCalledWith("shop1", "product", "p1");
  });
  it("updateSettings forwards only the provided flags", async () => {
    const res = (await action({ request: req({ action: "updateSettings", allowAiCrawlers: false }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(upsertSeoSettings).toHaveBeenCalledWith("shop1", { allowAiCrawlers: false });
  });
  it("422s an unknown action", async () => {
    const res = (await action({ request: req({ action: "nope" }) } as never)) as Response;
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.search.test.ts`
Expected: FAIL (route module not found).

- [ ] **Step 3: Implement `dashboard.api.search.tsx`**

```ts
// app/routes/dashboard.api.search.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { buildSeoOverview, getProductSeoDetail, getShopStorefrontOrigin } from "~/lib/seo/overview.server";
import { upsertSeoOverride, deleteSeoOverride, upsertSeoSettings } from "~/lib/seo/seo-store.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request); // auth gate; overview is this shop's own data
  return dashboardJson(async () =>
    buildSeoOverview(session.shopId, await getShopStorefrontOrigin(session.shopId)),
  );
}

interface SearchBody {
  action?: string;
  handle?: string;
  entityId?: string;
  metaTitle?: string;
  metaDescription?: string;
  allowAiCrawlers?: boolean;
  allowAiTraining?: boolean;
  orgName?: string | null;
  orgDescription?: string | null;
}

// Generous bounds so a merchant is never blocked mid-edit (the engine's own
// validator uses tighter SERP limits for scoring, not gating).
const TITLE_MAX = 70;
const DESC_MAX = 200;

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request); // throws a 403 Response on a cross-origin post
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as SearchBody | null;
  if (!body || typeof body.action !== "string") return jsonError(422, "bad_request", "action is required");

  switch (body.action) {
    case "detail": {
      if (!body.handle) return jsonError(422, "bad_request", "handle is required");
      const handle = body.handle;
      return dashboardJson(async () =>
        getProductSeoDetail(session.shopId, handle, await getShopStorefrontOrigin(session.shopId)),
      );
    }
    case "saveOverride": {
      if (!body.entityId) return jsonError(422, "bad_request", "entityId is required");
      if (typeof body.metaTitle !== "string" || typeof body.metaDescription !== "string") {
        return jsonError(422, "bad_request", "metaTitle and metaDescription are required");
      }
      const metaTitle = body.metaTitle.trim();
      const metaDescription = body.metaDescription.trim();
      if (!metaTitle || metaTitle.length > TITLE_MAX) return jsonError(422, "bad_request", `title must be 1 to ${TITLE_MAX} characters`);
      if (!metaDescription || metaDescription.length > DESC_MAX) return jsonError(422, "bad_request", `description must be 1 to ${DESC_MAX} characters`);
      const entityId = body.entityId;
      return dashboardJson(async () => {
        await upsertSeoOverride(session.shopId, {
          entityType: "product",
          entityId,
          metaTitle,
          metaDescription,
          updatedBy: session.userId,
        });
        return { ok: true };
      });
    }
    case "resetOverride": {
      if (!body.entityId) return jsonError(422, "bad_request", "entityId is required");
      const entityId = body.entityId;
      return dashboardJson(async () => {
        await deleteSeoOverride(session.shopId, "product", entityId);
        return { ok: true };
      });
    }
    case "updateSettings": {
      const patch: Record<string, unknown> = {};
      if (typeof body.allowAiCrawlers === "boolean") patch.allowAiCrawlers = body.allowAiCrawlers;
      if (typeof body.allowAiTraining === "boolean") patch.allowAiTraining = body.allowAiTraining;
      if (body.orgName === null || typeof body.orgName === "string") patch.orgName = body.orgName;
      if (body.orgDescription === null || typeof body.orgDescription === "string") patch.orgDescription = body.orgDescription;
      if (Object.keys(patch).length === 0) return jsonError(422, "bad_request", "no settings to update");
      return dashboardJson(async () => ({ settings: await upsertSeoSettings(session.shopId, patch) }));
    }
    default:
      return jsonError(422, "bad_request", `unknown action: ${body.action}`);
  }
}
```

- [ ] **Step 4: Implement `search-client.ts`**

```ts
// app/lib/dashboard/search-client.ts
// Browser data layer for the Search screen. The interfaces below are browser-safe
// mirrors of the VMs returned by app/lib/seo/overview.server.ts (a .server module
// cannot be imported into the client bundle) — keep them in sync by hand when the
// server VM changes.
import { apiGet, apiSend } from "./client";

export interface NeedsAttentionRow {
  id: string;
  handle: string;
  title: string;
  score: number;
  topIssue: string | null;
  hasOverride: boolean;
}
export interface AiCrawlRow { botName: string; hits: number; }
export interface SeoSettings {
  allowAiCrawlers: boolean;
  allowAiTraining: boolean;
  orgName: string | null;
  orgDescription: string | null;
}
export interface SeoOverviewVM {
  storeHealth: number;
  productCount: number;
  needsAttention: NeedsAttentionRow[];
  aiCrawls: AiCrawlRow[];
  aiCrawlTotal: number;
  settings: SeoSettings;
}
export interface GooglePreview { title: string; url: string; description: string; }
export interface HealthCheckVM { id: string; label: string; status: "pass" | "warn" | "fail"; hint?: string; }
export interface ProductSeoDetailVM {
  id: string;
  handle: string;
  title: string;
  googlePreview: GooglePreview;
  health: { score: number; checks: HealthCheckVM[] };
  override: { metaTitle: string | null; metaDescription: string | null } | null;
  aiSummary: string;
}

export const fetchSearch = () => apiGet<SeoOverviewVM>("/dashboard/api/search");

export const loadProductDetail = (handle: string) =>
  apiSend<ProductSeoDetailVM>("POST", "/dashboard/api/search", { action: "detail", handle });

export const saveOverride = (payload: { entityId: string; metaTitle: string; metaDescription: string }) =>
  apiSend<{ ok: true }>("POST", "/dashboard/api/search", { action: "saveOverride", ...payload });

export const resetOverride = (entityId: string) =>
  apiSend<{ ok: true }>("POST", "/dashboard/api/search", { action: "resetOverride", entityId });

export const updateSettings = (patch: Partial<SeoSettings>) =>
  apiSend<{ settings: SeoSettings }>("POST", "/dashboard/api/search", { action: "updateSettings", ...patch });
```

- [ ] **Step 5: Run it, verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.api.search.test.ts`
Expected: PASS (loader + 8 action cases).

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.search.tsx app/lib/dashboard/search-client.ts app/routes/__tests__/dashboard.api.search.test.ts
git commit -m "dashboard/search: add /dashboard/api/search route + browser client"
```

---

### Task B6: `Search.tsx` screen + SPA registration

**Files:**
- Create: `app/components/dashboard/screens/Search.tsx`
- Modify: `app/components/dashboard/context.ts` (add `"search"` to the `Screen` union)
- Modify: `app/components/dashboard/DashboardApp.tsx` (`SCREENS` entry + nav item + import)
- Modify: `app/components/dashboard/routes.ts` (`seg` + `parsePath` cases)
- Modify: `app/lib/dashboard/screen-cache.ts` (`SCREEN_CACHE_KEYS.search`)
- Modify: `app/lib/dashboard/prefetch.ts` (`WARM_TARGETS` entry)
- Test: `app/components/dashboard/__tests__/Search.test.tsx`

**Interfaces:**
- Consumes: `DashboardCtx` (`../context`); `Card`, `Btn`, `Toggle`, `Pill`, `Placeholder`, `TableSkeleton` (`../ui`); `CDIcon` (`../icons`); `cachedScreenData`, `cacheScreenData`, `SCREEN_CACHE_KEYS` (`~/lib/dashboard/screen-cache`); `fetchSearch`, `loadProductDetail`, `saveOverride`, `resetOverride`, `updateSettings` + VM types (`~/lib/dashboard/search-client`).
- Produces: the default-export `Search` screen, registered as the `"search"` screen.

**DESIGN DIRECTIVE (mandatory for this task):** Before writing JSX, invoke the `design-taste-frontend` skill (taste-skill v2; falls back to `design-taste-frontend-v1` if it misbehaves) and let it compose with `emil-design-eng`. Build the screen **only** from the existing `cd-*` design-system primitives in `app/components/dashboard/` (`Card`, `Btn`, `Toggle`, `Pill`, `Placeholder`, `TableSkeleton`) plus Lucide icons via `CDIcon`. No Polaris, no CSS frameworks, no new icon sets. Target the approved mockups: calm, uncluttered, editorial, plain language (the merchant is new to web dev). Must include a skeleton loading state (`TableSkeleton`, like `Discover.tsx`) and, on an empty catalog, the exact copy: "Add a product and it's automatically optimized for search and AI." Any new visual styling goes in `app/styles/dashboard.css` under `cd-seo*` / `cd-serp` / `cd-field` classes; do not inline a design framework. The reference implementation below is complete and correct for behavior + wiring — refine its layout/spacing/typography with the skill, but preserve the structure, the three views, the client calls, and the cache seed/write-through.

**Component structure (three views in one screen):**
1. **Overview** (default) — header "Search" + big "Health {n}/100"; two cards ("On Google" with a disabled "Connect Google" placeholder wired in Plan C, "On AI assistants" showing the `aiCrawls` summary); "Pages that need a look" list of `needsAttention` rows (title + plain top issue + `[Fix it]`), or a calm "Every page looks good." state; a Settings section (AI toggle + store name/description).
2. **Product editor** (on `[Fix it]`) — product title; a rendered Google SERP snippet; the health score + checks as plain check/x lines with hints; `[Let the app write it]` (resets = deletes the override) and `[Edit myself]` (reveals Title + Description fields with live character counters + a live-updating preview + Save).
3. Settings lives inline on the overview (a small section), matching "a small section or sub-tab".

- [ ] **Step 1: Write the reference `Search.tsx`**

```tsx
// app/components/dashboard/screens/Search.tsx
// Search - the merchant SEO/AIO surface. Every storefront page is already
// optimized live (the engine writes meta + structured data on each render); this
// screen shows how each page looks to Google and AI assistants, and lets a
// merchant hand-edit a page's title/description (an override) or hand it back to
// the app. Seeds from the screen cache for instant paint, then refetches.
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Toggle, Pill, Placeholder, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  fetchSearch, loadProductDetail, saveOverride, resetOverride, updateSettings,
  type SeoOverviewVM, type ProductSeoDetailVM, type SeoSettings,
} from "~/lib/dashboard/search-client";

const TITLE_MAX = 60;
const DESC_MAX = 160;

function healthTone(score: number): "success" | "warn" | "neutral" {
  return score >= 90 ? "success" : score >= 70 ? "warn" : "neutral";
}

export default function Search({ app }: { app: DashboardCtx }) {
  const [data, setData] = useState<SeoOverviewVM | null>(() =>
    cachedScreenData<SeoOverviewVM>(SCREEN_CACHE_KEYS.search),
  );
  const [editing, setEditing] = useState<string | null>(null); // product handle

  useEffect(() => {
    let live = true;
    fetchSearch()
      .then((state) => {
        if (!live) return;
        cacheScreenData(SCREEN_CACHE_KEYS.search, state);
        setData(state);
      })
      .catch(() => {
        /* the skeleton / empty state covers a failed first fetch */
      });
    return () => { live = false; };
  }, []);

  function refresh() {
    fetchSearch()
      .then((state) => { cacheScreenData(SCREEN_CACHE_KEYS.search, state); setData(state); })
      .catch(() => {});
  }

  if (!data) return <TableSkeleton />;

  if (editing) {
    return (
      <ProductEditor
        app={app}
        handle={editing}
        onBack={() => setEditing(null)}
        onSaved={() => { setEditing(null); refresh(); }}
      />
    );
  }

  return (
    <div className="cd-screen cd-seo">
      <header className="cd-seo__head">
        <h1 className="cd-seo__title">Search</h1>
        <div className="cd-seo__health" data-tone={healthTone(data.storeHealth)}>
          <span className="cd-seo__health-num">{data.storeHealth}</span>
          <span className="cd-seo__health-max">/100</span>
          <span className="cd-seo__health-label">Health</span>
        </div>
      </header>

      {data.productCount === 0 ? (
        <Placeholder
          icon="search"
          title="Nothing to optimize yet"
          sub="Add a product and it's automatically optimized for search and AI."
        />
      ) : (
        <>
          <div className="cd-seo__cards">
            <Card>
              <div className="cd-seo__card-head">
                <CDIcon name="search" size={18} strokeWidth={1.8} />
                <span>On Google</span>
              </div>
              <p className="cd-seo__card-sub">See how your pages rank on Google.</p>
              <Btn kind="secondary" small disabled>Connect Google</Btn>
            </Card>
            <Card>
              <div className="cd-seo__card-head">
                <CDIcon name="sparkle" size={18} strokeWidth={1.8} />
                <span>On AI assistants</span>
              </div>
              {data.aiCrawlTotal > 0 ? (
                <p className="cd-seo__card-sub">
                  Seen {data.aiCrawlTotal.toLocaleString()} times by{" "}
                  {data.aiCrawls.slice(0, 3).map((c) => c.botName).join(", ")}.
                </p>
              ) : (
                <p className="cd-seo__card-sub">
                  No AI assistant visits yet. Your store is set up to be read and cited.
                </p>
              )}
            </Card>
          </div>

          <section className="cd-seo__section">
            <h2 className="cd-seo__h2">Pages that need a look</h2>
            {data.needsAttention.length === 0 ? (
              <Card>
                <div className="cd-seo__allgood">
                  <CDIcon name="check" size={18} strokeWidth={1.8} />
                  <span>Every page looks good.</span>
                </div>
              </Card>
            ) : (
              <Card pad={false}>
                {data.needsAttention.map((row) => (
                  <div key={row.id} className="cd-seo__row">
                    <div className="cd-seo__row-main">
                      <span className="cd-seo__row-title">{row.title}</span>
                      <span className="cd-seo__row-issue">
                        {row.topIssue ?? "Could be stronger"}
                        {row.hasOverride && <em className="cd-seo__edited"> · edited by you</em>}
                      </span>
                    </div>
                    <Pill tone={healthTone(row.score)}>{row.score}</Pill>
                    <Btn small kind="primary" onClick={() => setEditing(row.handle)}>Fix it</Btn>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <SettingsPanel app={app} settings={data.settings} onSaved={refresh} />
        </>
      )}
    </div>
  );
}

function ProductEditor({
  app, handle, onBack, onSaved,
}: { app: DashboardCtx; handle: string; onBack: () => void; onSaved: () => void }) {
  const [detail, setDetail] = useState<ProductSeoDetailVM | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    loadProductDetail(handle)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setTitle(d.override?.metaTitle ?? d.googlePreview.title);
        setDescription(d.override?.metaDescription ?? d.googlePreview.description);
      })
      .catch(() => app.toast("Could not load that page"));
    return () => { live = false; };
  }, [handle]);

  if (!detail) return <TableSkeleton rows={4} />;

  const preview =
    mode === "edit"
      ? { title: title || detail.googlePreview.title, url: detail.googlePreview.url, description: description || detail.googlePreview.description }
      : detail.googlePreview;

  async function onSave() {
    setSaving(true);
    try {
      await saveOverride({ entityId: detail!.id, metaTitle: title.trim(), metaDescription: description.trim() });
      app.toast("Saved. Your storefront is updated.", "check");
      onSaved();
    } catch {
      app.toast("Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function onLetAppWrite() {
    setSaving(true);
    try {
      await resetOverride(detail!.id);
      app.toast("Back to the auto-written version.", "sparkle");
      onSaved();
    } catch {
      app.toast("Could not reset");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cd-screen cd-seo cd-seo--editor">
      <button type="button" className="cd-seo__back" onClick={onBack}>
        <CDIcon name="chevronDown" size={16} strokeWidth={1.9} /> Back
      </button>
      <h1 className="cd-seo__title">{detail.title}</h1>

      <section className="cd-seo__section">
        <h2 className="cd-seo__h2">How you look on Google</h2>
        <Card>
          <div className="cd-serp">
            <div className="cd-serp__url">{preview.url}</div>
            <div className="cd-serp__title">{preview.title}</div>
            <div className="cd-serp__desc">{preview.description}</div>
          </div>
        </Card>
      </section>

      <section className="cd-seo__section">
        <div className="cd-seo__health-inline" data-tone={healthTone(detail.health.score)}>
          Health {detail.health.score}/100
        </div>
        <Card pad={false}>
          {detail.health.checks.map((c) => (
            <div key={c.id} className="cd-seo__check" data-status={c.status}>
              <CDIcon name={c.status === "pass" ? "check" : "x"} size={15} strokeWidth={2} />
              <span className="cd-seo__check-label">{c.label}</span>
              {c.status !== "pass" && c.hint && <span className="cd-seo__check-hint">{c.hint}</span>}
            </div>
          ))}
        </Card>
      </section>

      {mode === "view" ? (
        <div className="cd-seo__actions">
          <Btn kind="secondary" onClick={onLetAppWrite} disabled={saving || !detail.override}>
            Let the app write it
          </Btn>
          <Btn kind="primary" onClick={() => setMode("edit")}>Edit myself</Btn>
        </div>
      ) : (
        <section className="cd-seo__section cd-seo__edit">
          <label className="cd-field">
            <span className="cd-field__label">Title</span>
            <input
              className="cd-field__input"
              value={title}
              maxLength={TITLE_MAX + 20}
              onChange={(e) => setTitle(e.target.value)}
            />
            <span className="cd-field__count" data-over={title.length > TITLE_MAX ? "1" : "0"}>
              {title.length}/{TITLE_MAX}
            </span>
          </label>
          <label className="cd-field">
            <span className="cd-field__label">Description</span>
            <textarea
              className="cd-field__input cd-field__area"
              value={description}
              rows={3}
              maxLength={DESC_MAX + 40}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="cd-field__count" data-over={description.length > DESC_MAX ? "1" : "0"}>
              {description.length}/{DESC_MAX}
            </span>
          </label>
          <div className="cd-seo__actions">
            <Btn kind="secondary" onClick={() => setMode("view")} disabled={saving}>Cancel</Btn>
            <Btn kind="primary" onClick={onSave} disabled={saving || !title.trim() || !description.trim()}>
              {saving ? "Saving…" : "Save"}
            </Btn>
          </div>
        </section>
      )}
    </div>
  );
}

function SettingsPanel({
  app, settings, onSaved,
}: { app: DashboardCtx; settings: SeoSettings; onSaved: () => void }) {
  const [orgName, setOrgName] = useState(settings.orgName ?? "");
  const [orgDescription, setOrgDescription] = useState(settings.orgDescription ?? "");
  const [savingCrawl, setSavingCrawl] = useState(false);

  async function toggleCrawlers(next: boolean) {
    setSavingCrawl(true);
    try {
      await updateSettings({ allowAiCrawlers: next });
      app.toast(next ? "AI assistants can read your store." : "AI assistants asked not to crawl.", "check");
      onSaved();
    } catch {
      app.toast("Could not update");
    } finally {
      setSavingCrawl(false);
    }
  }

  async function saveOrg() {
    try {
      await updateSettings({ orgName: orgName.trim() || null, orgDescription: orgDescription.trim() || null });
      app.toast("Saved.", "check");
      onSaved();
    } catch {
      app.toast("Could not save");
    }
  }

  return (
    <section className="cd-seo__section cd-seo__settings">
      <h2 className="cd-seo__h2">Settings</h2>
      <Card>
        <div className="cd-seo__setrow">
          <div>
            <div className="cd-seo__setlabel">Let AI assistants read and cite my store</div>
            <div className="cd-seo__sethint">On by default. Turn off to ask ChatGPT, Perplexity and others not to crawl.</div>
          </div>
          <Toggle value={settings.allowAiCrawlers} onChange={toggleCrawlers} disabled={savingCrawl} ariaLabel="Allow AI assistants" />
        </div>
        <div className="cd-seo__setblock">
          <div className="cd-seo__setlabel">How your store is described</div>
          <label className="cd-field">
            <span className="cd-field__label">Store name</span>
            <input className="cd-field__input" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </label>
          <label className="cd-field">
            <span className="cd-field__label">One-line description</span>
            <input className="cd-field__input" value={orgDescription} onChange={(e) => setOrgDescription(e.target.value)} />
          </label>
          <Btn kind="primary" small onClick={saveOrg}>Save</Btn>
        </div>
      </Card>
    </section>
  );
}
```

- [ ] **Step 2: Register the screen — `context.ts`**

In `app/components/dashboard/context.ts`, add `"search"` to the `Screen` union. Place it in the growth group near `analytics`, e.g. after the `| "analytics"` line add:

```ts
  // Search - the merchant SEO/AIO surface (storefront discoverability on Google + AI).
  | "search"
```

- [ ] **Step 3: Register the screen — `DashboardApp.tsx`**

1. Add the import next to the other screen imports:
```ts
import ScreenSearch from "./screens/Search";
```
2. Add the nav item to the `"Grow"` group's `items` array (after the `analytics` entry):
```ts
      { id: "search", label: "Search", icon: "search" },
```
3. Add the `SCREENS` map entry:
```ts
  search: ScreenSearch,
```

- [ ] **Step 4: Register the route path — `routes.ts`**

1. In `seg`, add a case (near the growth screens):
```ts
    case "search":
      return "search";
```
2. In `parsePath`'s `switch (a)`, add a case:
```ts
    case "search":
      return b ? null : { screen: "search", param: null, sub: null };
```
(`seg` and `parsePath` are exact inverses: `pathFor({screen:"search",...})` -> `/dashboard/search` -> parses back to the same NavState.)

- [ ] **Step 5: Register the cache key + warm target**

1. In `app/lib/dashboard/screen-cache.ts`, add to `SCREEN_CACHE_KEYS`:
```ts
  search: "search",
```
2. In `app/lib/dashboard/prefetch.ts`, add the import and the warm target:
```ts
import { fetchSearch } from "./search-client";
```
and add to `WARM_TARGETS` (place near `discover`, which shares the BUILD/GROW umbrella):
```ts
  [SCREEN_CACHE_KEYS.search, fetchSearch],
```

- [ ] **Step 6: Write the render + wiring smoke test**

```tsx
// app/components/dashboard/__tests__/Search.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No real network: renderToStaticMarkup does not run effects, but mock anyway so
// an accidental call is inert.
vi.mock("~/lib/dashboard/search-client", () => ({
  fetchSearch: vi.fn().mockResolvedValue(null),
  loadProductDetail: vi.fn(),
  saveOverride: vi.fn(),
  resetOverride: vi.fn(),
  updateSettings: vi.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search from "../screens/Search";
// eslint-disable-next-line import/first
import { cacheScreenData, clearScreenCache, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
// eslint-disable-next-line import/first
import { parsePath, pathFor } from "../routes";
// eslint-disable-next-line import/first
import type { DashboardCtx } from "../context";

const app = { toast: () => {}, navigate: () => {} } as unknown as DashboardCtx;
const overview = {
  storeHealth: 82,
  productCount: 3,
  needsAttention: [{ id: "p1", handle: "cedar", title: "Cedar Bloom", score: 71, topIssue: "Meta description", hasOverride: false }],
  aiCrawls: [{ botName: "GPTBot", hits: 1200 }, { botName: "PerplexityBot", hits: 40 }],
  aiCrawlTotal: 1240,
  settings: { allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null },
};

beforeEach(() => clearScreenCache());

describe("Search screen (smoke)", () => {
  it("renders the seeded overview without crashing", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, overview);
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Search");
    expect(html).toContain("82");
    expect(html).toContain("Cedar Bloom");
    expect(html).toContain("GPTBot");
  });
  it("shows the skeleton before any data is cached", () => {
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("cd-skel");
  });
  it("shows the empty-catalog copy at zero products", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, { ...overview, productCount: 0, needsAttention: [] });
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("automatically optimized for search and AI");
  });
});

describe("search route registration", () => {
  it("seg and parsePath are exact inverses for the search screen", () => {
    expect(pathFor({ screen: "search", param: null, sub: null })).toBe("/dashboard/search");
    expect(parsePath("/dashboard/search")).toEqual({ screen: "search", param: null, sub: null });
  });
  it("exposes a stable cache key", () => {
    expect(SCREEN_CACHE_KEYS.search).toBe("search");
  });
});
```

- [ ] **Step 7: Run the smoke test**

Run: `npx vitest run app/components/dashboard/__tests__/Search.test.tsx`
Expected: PASS (render smoke + route round-trip). If the seeded render throws, confirm `Search.tsx` reads `cachedScreenData(SCREEN_CACHE_KEYS.search)` in its `useState` initializer (so the seeded overview paints synchronously under `renderToStaticMarkup`).

- [ ] **Step 8: Acceptance criteria (verify before committing)**

- `npm run typecheck` -> exit 0 (screen + registration compile; the `Screen` union, `SCREENS` map, and nav item all include `"search"`).
- `npm run lint` -> exit 0 on the touched files (`--max-warnings=0`).
- `npm run build` -> exit 0 (the client bundle builds; `Search.tsx` never imports a `.server` module — it only touches `search-client.ts`).
- The smoke test passes (renders without crashing, seeds + reads the cache, shows skeleton/empty states).
- Design directive honored: only `cd-*` primitives + `CDIcon`; calm/editorial; plain language; no Polaris/CSS framework; new styles live under `cd-seo*` in `dashboard.css`.

- [ ] **Step 9: Commit**

```bash
git add app/components/dashboard/screens/Search.tsx app/components/dashboard/context.ts app/components/dashboard/DashboardApp.tsx \
  app/components/dashboard/routes.ts app/lib/dashboard/screen-cache.ts app/lib/dashboard/prefetch.ts \
  app/components/dashboard/__tests__/Search.test.tsx app/styles/dashboard.css
git commit -m "dashboard/search: add Search screen + SPA registration"
```

---

### Final gate (run before opening a PR)

- [ ] **Whole SEO suite green**

Run: `npx vitest run app/lib/seo app/routes/__tests__/dashboard.api.search.test.ts app/components/dashboard/__tests__/Search.test.tsx`
Expected: PASS (B2..B6 tests + Plan A's still-green suite).

- [ ] **Pre-commit gate**

Run in order, each exit 0: `npm run typecheck` -> `npm run lint` -> `npm run build`.

- [ ] **Live smoke (drive the real dashboard + storefront)**

Against the running app (local dev recipe or a preview deploy), with the migration applied (B1 Step 4):
- `/dashboard/search` paints the overview (Health + two cards + needs-attention list + Settings); a `[Fix it]` opens the editor with a Google SERP snippet + checks.
- Edit a product's title/description, Save -> reload `GET /storefront/products/<handle>` and confirm `<title>` + `<meta name="description">` (+ `og:title`/`og:description`) now show the merchant text, while the JSON-LD `Product` block is unchanged. Then "Let the app write it" -> the storefront reverts to the generated meta.
- Toggle "Let AI assistants read and cite my store" off -> `GET /robots.txt` shows `User-agent: GPTBot\nDisallow: /` while `User-agent: *` stays `Allow: /`; toggle back on -> `Allow: /`.

---

## Self-review (author check against the spec + controller directives)

**Spec / directive coverage:**
- Two override-only tables, own migration, self-contained RLS via `current_shop_id()`, revoke anon/authenticated, grant `app_web`, NOT in `tenant-tables.ts` (verified `storefront_event`/`seo_ai_crawl_daily` precedent) -> **B1**. ✓
- No auto-write-on-save, no batch backfill (coverage already automatic) -> intentionally absent; called out in the Architecture + Plan B delta. ✓
- `applyOverride` pure layer; three storefront loaders apply the override with try/catch failure isolation; one indexed query/page noted as a cost -> **B4** (+ perf note). ✓
- `robots.txt` honors `allow_ai_crawlers` via the new `buildRobotsTxt(origin, allowAiCrawlers)`; route resolves tenant + reads `seo_settings`; site-files test updated -> **B4**. ✓
- `seo-store.server.ts` with all six functions, `shop_id`-scoped, non-uuid skip, defaults -> **B2**. ✓
- `overview.server.ts`: `buildSeoOverview` (avg health, productCount, needsAttention worst-first cap 12 with topIssue + hasOverride, aiCrawls 28-day desc + total, settings), `getProductSeoDetail` (SERP preview, health, override, aiSummary, `id` for saves), `getShopStorefrontOrigin` (org_slug -> tenantDomain, "" fallback) -> **B3**. ✓
- `dashboard.api.search` loader + action (requireDashboardSession, requireSameOrigin, 405, boundary validation, the four action branches) + `search-client.ts` + a route test mirroring an existing dashboard-api test -> **B5**. ✓
- `Search.tsx` (overview + per-product editor + inline settings) + full registration (`Screen` union, `SCREENS`, nav item, `seg`/`parsePath`, `SCREEN_CACHE_KEYS.search`, `WARM_TARGETS`) + design directive + light render/registration smoke test -> **B6**. ✓
- Easy-user-flow mockups (plain-language health, two cards, "Pages that need a look" with `[Fix it]`, "Every page looks good", `[Let the app write it]` / `[Edit myself]` with counters + live preview, AI toggle + store description, empty-catalog copy) -> **B6** reference component. ✓

**Placeholder scan:** every code step shows complete code; every test shows complete assertions; every command has an exact path + expected result. No TBD/TODO/"similar to". ✓

**Type consistency:** `SeoSettings` / `SeoOverride` (B2) flow unchanged into `overview.server.ts` (B3), the route (B5), and the browser mirror (B6). `SeoOverviewVM` / `ProductSeoDetailVM` fields match across `overview.server.ts`, `search-client.ts`, the route test, and the screen (`id`, `handle`, `googlePreview`, `health.checks[].status`, `override`, `aiSummary`). `applyOverride`'s structural argument accepts a `SeoOverride`. `buildRobotsTxt`'s new arg is optional (default `true`) so existing Plan A callers/tests keep compiling. `getShopStorefrontOrigin` returns the origin the route feeds to `buildSeoOverview`/`getProductSeoDetail`. ✓

**Cross-task ordering flagged:** `overview.server.ts` (B3) imports `override.ts` (created in B4 Step 3). The B3 note tells the implementer to create `override.ts` first or run B4 before B3; the two are otherwise independent. ✓

**Known follow-up (not a blocker):** per-page-view override read + per-request `seo_settings` read add one indexed query each; memoize `seo_settings` per shop and fold the override read into the catalog query in a later pass. Noted in the Architecture header and the B4 perf note.
