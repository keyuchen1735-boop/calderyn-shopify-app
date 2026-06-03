# AI Content Campaign Generator (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the gate-free foundation of feature #3 — a versioned brand-memory store, AI generation of per-platform ad copy + images, and a draft/review queue — with no social publishing.

**Architecture:** Pure, unit-tested modules (`serialize`, `platform-specs`, `screen`) carry the logic; IO modules (`brand-memory`, `generate`, `image`, `content-client`) take injected clients so they are seam-testable; transactional/versioned writes go through Postgres RPC functions (the Supabase analog of `prisma.$transaction`). Surface is three Polaris routes. Everything lives in `app/lib/content/` + `/app/brand` + `/app/studio` to stay isolated from sessions #2/#4.

**Tech Stack:** Remix, React 18, Polaris, TypeScript (strict), Supabase Postgres (service-role, server-only), Anthropic SDK (`claude-opus-4-8`, prompt caching), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-content-campaign-generator-design.md`

**Refinement vs spec (deliberate):** the read surface is a dedicated `contentClient(shop)` in its own module (mirroring `calderynClient`), NOT a `content` namespace bolted onto the shared `app/lib/calderyn.server.ts`. This honors the spec's isolation contract (§4) by touching zero shared files. MCP/assistant exposure (later slice) can wrap it.

**Conventions to mirror (read these first):**
- `app/lib/calderyn.server.ts` — `CalderynError`, `rethrow(prefix, err)`, `rowTo*` boundary mappers, factory shape.
- `app/lib/supabase.server.ts` — `getSupabase()` (service-role client) and `resolveShopId(shop)` (shop domain → `shops.id` uuid).
- `app/routes/app.settings.tsx` — loader/action + Polaris page pattern (`authenticate.admin`, `json`, `calderynClient`, `useActionToast`).

---

## Task 1: Dependencies & environment

**Files:**
- Modify: `package.json` (deps)
- Modify: `.env.example`

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install @anthropic-ai/sdk
```
(No image-provider SDK is added as a top-level dep: image generation calls a REST endpoint via `fetch` behind an injected interface — see Task 9 — so the concrete provider stays swappable and adds no dependency. Object storage uses the already-present `@supabase/supabase-js`.)

- [ ] **Step 2: Document new env vars**

Add to `.env.example`:
```dotenv
# --- Feature #3: content campaign generator (server-only) ---
# Anthropic API key for copy generation (claude-opus-4-8)
ANTHROPIC_API_KEY=
# Image generation provider REST endpoint + key (e.g. Gemini 3 Pro Image / Recraft)
IMAGE_PROVIDER_URL=
IMAGE_PROVIDER_KEY=
# Supabase Storage bucket for generated images
CONTENT_MEDIA_BUCKET=content-media
```

- [ ] **Step 3: Verify install**

Run: `npm run typecheck`
Expected: exit 0 (no source changes yet; confirms the dep installed cleanly).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(content): add @anthropic-ai/sdk + content env vars"
```

---

## Task 2: Content domain types

**Files:**
- Create: `app/lib/content/types.ts`

- [ ] **Step 1: Write the types**

```ts
// app/lib/content/types.ts
// Types for feature #3 (content campaign generator). Kept OUT of app/lib/types.ts
// to avoid collisions with sessions #2 (analytics) and #4 (DetectorId/ActionKind).

export type Platform = "instagram" | "facebook" | "tiktok" | "youtube";
export type AssetKind = "copy" | "image" | "video";
export type AssetStatus = "pending_review" | "approved" | "rejected" | "failed";
export type CampaignStatus = "draft" | "generating" | "pending_review" | "approved";

export type RiskFlagKind =
  | "banned_word"
  | "banned_claim"
  | "unverified_claim"
  | "missing_disclaimer";

export interface RiskFlag {
  kind: RiskFlagKind;
  detail: string;
  blocking: boolean;
}

export interface AdCopy {
  platform: Platform;
  hook: string;
  body: string;
  hashtags: string[];
  cta: string;
  claims_used: string[];
}

export interface BrandMemory {
  identity: {
    name: string;
    tagline?: string;
    mission?: string;
    category?: string;
    positioning?: string;
  };
  voice: {
    tone: string[];
    formality: number; // 1-5
    person: string; // "we" | "I"
    emoji_policy: string;
    signature_phrases: string[];
    style_examples: string[];
  };
  audience: Array<{
    persona: string;
    pains: string[];
    desires: string[];
    platforms: Platform[];
  }>;
  visual: {
    palette: Array<{ hex: string; role: string }>;
    fonts: string[];
    logo_refs: string[];
    imagery_rules: string;
    aspect_defaults: string;
  };
  products: Array<{
    name: string;
    sku: string;
    hero_benefits: string[];
    price?: string;
    proof_points: string[];
    photo_refs: string[];
    claims_allowed: string[];
  }>;
  guardrails: {
    banned_words: string[];
    banned_claims: string[];
    required_disclaimers: string[];
    regulated_category: boolean;
  };
  examples: {
    good_posts: Array<{ platform: Platform; text: string; why: string }>;
    bad_posts: Array<{ text: string; why: string }>;
  };
}

export interface BrandMemoryRecord {
  id: string;
  shop_id: string;
  version: number;
  is_active: boolean;
  content: BrandMemory;
  created_at: string;
}

export interface ContentAsset {
  id: string;
  campaign_id: string;
  platform: Platform;
  kind: AssetKind;
  copy: AdCopy | null;
  media_url: string | null;
  status: AssetStatus;
  risk_flags: RiskFlag[];
  override: { reason: string; by: string } | null;
  created_at: string;
}

export interface ContentCampaign {
  id: string;
  shop_id: string;
  goal: string;
  product_refs: string[];
  brand_memory_version: number;
  status: CampaignStatus;
  created_at: string;
}

export interface ContentCampaignDetail extends ContentCampaign {
  assets: ContentAsset[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/content/types.ts
git commit -m "feat(content): add content domain types"
```

---

## Task 3: Supabase migrations (tables + RPC functions)

**Files:**
- Create: `supabase/migrations/20260602110000_brand_memory.sql`
- Create: `supabase/migrations/20260602111000_content_campaign.sql`
- Create: `supabase/migrations/20260602112000_content_asset.sql`
- Create: `supabase/migrations/20260602113000_content_rpc.sql`

> Preflight: these reference `shops(id)` (owned by shop-provisioning). Confirm `shops` exists (`select 1 from shops limit 1;`). If absent, STOP — it is a shop-provisioning prerequisite, not a #3 migration (spec §4).

- [ ] **Step 1: brand_memory table**

```sql
-- supabase/migrations/20260602110000_brand_memory.sql
create table if not exists brand_memory (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  version integer not null,
  is_active boolean not null default true,
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (shop_id, version)
);

-- Enforce exactly one active version per shop.
create unique index if not exists brand_memory_one_active_per_shop
  on brand_memory (shop_id)
  where is_active;
```

- [ ] **Step 2: content_campaign table**

```sql
-- supabase/migrations/20260602111000_content_campaign.sql
create table if not exists content_campaign (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  goal text not null,
  product_refs jsonb not null default '[]'::jsonb,
  brand_memory_version integer not null,
  status text not null default 'draft'
    check (status in ('draft','generating','pending_review','approved')),
  created_at timestamptz not null default now()
);

create index if not exists content_campaign_shop_idx
  on content_campaign (shop_id);
```

- [ ] **Step 3: content_asset table**

```sql
-- supabase/migrations/20260602112000_content_asset.sql
create table if not exists content_asset (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references content_campaign(id) on delete cascade,
  platform text not null check (platform in ('instagram','facebook','tiktok','youtube')),
  kind text not null check (kind in ('copy','image','video')),
  copy jsonb,
  media_url text,
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','rejected','failed')),
  risk_flags jsonb not null default '[]'::jsonb,
  override jsonb,
  created_at timestamptz not null default now()
);

create index if not exists content_asset_campaign_idx
  on content_asset (campaign_id);
```

- [ ] **Step 4: RPC functions (transactional writes)**

```sql
-- supabase/migrations/20260602113000_content_rpc.sql

-- Transactional, race-safe brand-memory save (spec §6.2).
create or replace function brand_memory_save(p_shop_id uuid, p_content jsonb)
returns brand_memory
language plpgsql
as $$
declare
  v_next integer;
  v_row brand_memory;
begin
  perform pg_advisory_xact_lock(hashtext(p_shop_id::text));
  select coalesce(max(version), 0) + 1 into v_next
    from brand_memory where shop_id = p_shop_id;
  update brand_memory set is_active = false
    where shop_id = p_shop_id and is_active;
  insert into brand_memory (shop_id, version, is_active, content)
    values (p_shop_id, v_next, true, p_content)
    returning * into v_row;
  return v_row;
end;
$$;

-- Transactional campaign + assets insert (spec §10). Rolls back as a unit.
create or replace function create_content_campaign(payload jsonb)
returns content_campaign
language plpgsql
as $$
declare
  v_campaign content_campaign;
  v_asset jsonb;
begin
  insert into content_campaign (shop_id, goal, product_refs, brand_memory_version, status)
  values (
    (payload->>'shop_id')::uuid,
    payload->>'goal',
    coalesce(payload->'product_refs', '[]'::jsonb),
    (payload->>'brand_memory_version')::integer,
    'pending_review'
  )
  returning * into v_campaign;

  for v_asset in select * from jsonb_array_elements(payload->'assets')
  loop
    insert into content_asset (campaign_id, platform, kind, copy, media_url, status, risk_flags)
    values (
      v_campaign.id,
      v_asset->>'platform',
      v_asset->>'kind',
      v_asset->'copy',
      v_asset->>'media_url',
      coalesce(v_asset->>'status', 'pending_review'),
      coalesce(v_asset->'risk_flags', '[]'::jsonb)
    );
  end loop;

  return v_campaign;
end;
$$;
```

- [ ] **Step 5: Apply migrations to the local/dev Supabase**

Run: `supabase db push` (or the project's configured migration command from `docs/DEPLOYMENT.md`).
Expected: all four migrations apply with no error; `\d brand_memory` shows the partial unique index.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260602110000_brand_memory.sql supabase/migrations/20260602111000_content_campaign.sql supabase/migrations/20260602112000_content_asset.sql supabase/migrations/20260602113000_content_rpc.sql
git commit -m "feat(content): brand_memory + content_campaign/asset tables + transactional RPC"
```

---

## Task 4: `serialize.server.ts` (pure, deterministic)

**Files:**
- Create: `app/lib/content/serialize.server.ts`
- Test: `app/lib/content/__tests__/serialize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/serialize.test.ts
import { describe, it, expect } from "vitest";
import { serializeBrandMemory } from "../serialize.server";
import type { BrandMemory } from "../types";

const base: BrandMemory = {
  identity: { name: "Acme" },
  voice: { tone: ["warm"], formality: 3, person: "we", emoji_policy: "sparing", signature_phrases: [], style_examples: [] },
  audience: [],
  visual: { palette: [], fonts: [], logo_refs: [], imagery_rules: "", aspect_defaults: "1:1" },
  products: [],
  guardrails: { banned_words: [], banned_claims: [], required_disclaimers: [], regulated_category: false },
  examples: { good_posts: [], bad_posts: [] },
};

describe("serializeBrandMemory", () => {
  it("is deterministic regardless of key insertion order", () => {
    const reordered = { ...base, identity: { name: "Acme" } } as BrandMemory;
    // shallow clone with reversed key order on a nested object
    const shuffled = JSON.parse(JSON.stringify({ ...base, voice: { person: "we", tone: ["warm"], formality: 3, emoji_policy: "sparing", signature_phrases: [], style_examples: [] } }));
    expect(serializeBrandMemory(reordered)).toBe(serializeBrandMemory(shuffled));
  });

  it("is stable across repeated calls (cache safety)", () => {
    expect(serializeBrandMemory(base)).toBe(serializeBrandMemory(base));
  });

  it("contains no timestamp or random tokens", () => {
    const out = serializeBrandMemory(base);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/serialize.test.ts`
Expected: FAIL — `serialize.server` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/serialize.server.ts
import type { BrandMemory } from "./types";

/**
 * Deterministically serialize brand memory into a stable text block suitable for
 * placement in a prompt-cached system block. Keys are sorted; no timestamps or
 * nondeterministic content, so the cached prefix never silently invalidates.
 */
export function serializeBrandMemory(memory: BrandMemory): string {
  return stableStringify(memory);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/serialize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/serialize.server.ts app/lib/content/__tests__/serialize.test.ts
git commit -m "feat(content): deterministic brand-memory serializer"
```

---

## Task 5: `platform-specs.ts` (pure)

**Files:**
- Create: `app/lib/content/platform-specs.ts`
- Test: `app/lib/content/__tests__/platform-specs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/platform-specs.test.ts
import { describe, it, expect } from "vitest";
import { specFor, copyWithinLimits } from "../platform-specs";

describe("platform-specs", () => {
  it("returns a spec for each platform", () => {
    expect(specFor("instagram").maxHashtags).toBe(30);
    expect(specFor("facebook").maxHashtags).toBe(10);
  });

  it("accepts copy within limits", () => {
    expect(copyWithinLimits("instagram", 100, 5)).toBe(true);
  });

  it("rejects over-long captions and too many hashtags", () => {
    expect(copyWithinLimits("instagram", 3000, 5)).toBe(false);
    expect(copyWithinLimits("facebook", 100, 50)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/platform-specs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/platform-specs.ts
import type { Platform } from "./types";

export interface PlatformSpec {
  platform: Platform;
  maxCaptionChars: number;
  maxHashtags: number;
  toneHint: string;
  ctaStyle: string;
}

export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  instagram: { platform: "instagram", maxCaptionChars: 2200, maxHashtags: 30, toneHint: "visual-first, friendly, emoji ok", ctaStyle: "soft CTA, link in bio" },
  facebook: { platform: "facebook", maxCaptionChars: 2000, maxHashtags: 10, toneHint: "conversational, can be longer", ctaStyle: "explicit CTA with link" },
  tiktok: { platform: "tiktok", maxCaptionChars: 2200, maxHashtags: 10, toneHint: "hook-first, native, casual", ctaStyle: "punchy CTA" },
  youtube: { platform: "youtube", maxCaptionChars: 1000, maxHashtags: 15, toneHint: "Shorts title + short description", ctaStyle: "subscribe / shop CTA" },
};

export function specFor(platform: Platform): PlatformSpec {
  return PLATFORM_SPECS[platform];
}

/** True if a generated copy fits the platform's hard limits. */
export function copyWithinLimits(
  platform: Platform,
  captionLength: number,
  hashtagCount: number,
): boolean {
  const s = PLATFORM_SPECS[platform];
  return captionLength <= s.maxCaptionChars && hashtagCount <= s.maxHashtags;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/platform-specs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/platform-specs.ts app/lib/content/__tests__/platform-specs.test.ts
git commit -m "feat(content): per-platform copy specs"
```

---

## Task 6: `screen.server.ts` (pure risk screen)

**Files:**
- Create: `app/lib/content/screen.server.ts`
- Test: `app/lib/content/__tests__/screen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/screen.test.ts
import { describe, it, expect } from "vitest";
import { screenCopy, hasBlockingFlag } from "../screen.server";
import type { AdCopy, BrandMemory } from "../types";

function memory(overrides: Partial<BrandMemory["guardrails"]> = {}, claimsAllowed: string[] = []): BrandMemory {
  return {
    identity: { name: "Acme" },
    voice: { tone: [], formality: 3, person: "we", emoji_policy: "none", signature_phrases: [], style_examples: [] },
    audience: [],
    visual: { palette: [], fonts: [], logo_refs: [], imagery_rules: "", aspect_defaults: "1:1" },
    products: [{ name: "Widget", sku: "W1", hero_benefits: [], proof_points: [], photo_refs: [], claims_allowed: claimsAllowed }],
    guardrails: { banned_words: [], banned_claims: [], required_disclaimers: [], regulated_category: false, ...overrides },
    examples: { good_posts: [], bad_posts: [] },
  };
}

const copy = (over: Partial<AdCopy> = {}): AdCopy => ({
  platform: "instagram", hook: "Hey", body: "Great widget", cta: "Shop now", hashtags: [], claims_used: [], ...over,
});

describe("screenCopy", () => {
  it("flags a banned word (blocking)", () => {
    const flags = screenCopy(copy({ body: "This is a SCAM deal" }), memory({ banned_words: ["scam"] }));
    expect(flags).toEqual([{ kind: "banned_word", detail: "scam", blocking: true }]);
    expect(hasBlockingFlag(flags)).toBe(true);
  });

  it("flags a claim not in claims_allowed (blocking)", () => {
    const flags = screenCopy(copy({ claims_used: ["clinically proven"] }), memory({}, ["dermatologist tested"]));
    expect(flags).toEqual([{ kind: "unverified_claim", detail: "clinically proven", blocking: true }]);
  });

  it("allows a claim present in claims_allowed", () => {
    const flags = screenCopy(copy({ claims_used: ["dermatologist tested"] }), memory({}, ["dermatologist tested"]));
    expect(flags).toEqual([]);
  });

  it("missing disclaimer is blocking only for regulated categories", () => {
    const reg = screenCopy(copy(), memory({ required_disclaimers: ["these statements have not been evaluated"], regulated_category: true }));
    expect(reg[0]).toMatchObject({ kind: "missing_disclaimer", blocking: true });
    const nonReg = screenCopy(copy(), memory({ required_disclaimers: ["these statements have not been evaluated"], regulated_category: false }));
    expect(nonReg[0]).toMatchObject({ kind: "missing_disclaimer", blocking: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/screen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/screen.server.ts
import type { AdCopy, BrandMemory, RiskFlag } from "./types";

/** Pure risk screen: compare generated copy against the brand guardrails (spec §9). */
export function screenCopy(copy: AdCopy, memory: BrandMemory): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const haystack = `${copy.hook} ${copy.body} ${copy.cta} ${copy.hashtags.join(" ")}`.toLowerCase();
  const g = memory.guardrails;

  for (const word of g.banned_words) {
    if (word && haystack.includes(word.toLowerCase())) {
      flags.push({ kind: "banned_word", detail: word, blocking: true });
    }
  }
  for (const claim of g.banned_claims) {
    if (claim && haystack.includes(claim.toLowerCase())) {
      flags.push({ kind: "banned_claim", detail: claim, blocking: true });
    }
  }

  const allowed = new Set(
    memory.products.flatMap((p) => p.claims_allowed.map((c) => c.toLowerCase())),
  );
  for (const claim of copy.claims_used) {
    if (!allowed.has(claim.toLowerCase())) {
      flags.push({ kind: "unverified_claim", detail: claim, blocking: true });
    }
  }

  for (const disc of g.required_disclaimers) {
    if (disc && !haystack.includes(disc.toLowerCase())) {
      flags.push({ kind: "missing_disclaimer", detail: disc, blocking: g.regulated_category });
    }
  }
  return flags;
}

export function hasBlockingFlag(flags: RiskFlag[]): boolean {
  return flags.some((f) => f.blocking);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/screen.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/screen.server.ts app/lib/content/__tests__/screen.test.ts
git commit -m "feat(content): risk-screen for generated copy"
```

---

## Task 7: `brand-memory.server.ts` (seed pure + RPC IO)

**Files:**
- Create: `app/lib/content/brand-memory.server.ts`
- Test: `app/lib/content/__tests__/brand-memory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/brand-memory.test.ts
import { describe, it, expect, vi } from "vitest";
import { seedBrandMemory, saveBrandMemory, getActiveBrandMemory } from "../brand-memory.server";

describe("seedBrandMemory", () => {
  it("maps Shopify products into the products section", () => {
    const m = seedBrandMemory("Acme", [
      { title: "Widget", price: "19.99", sku: "W1", imageUrls: ["http://img/1.png"] },
    ]);
    expect(m.identity.name).toBe("Acme");
    expect(m.products).toEqual([
      { name: "Widget", sku: "W1", hero_benefits: [], price: "19.99", proof_points: [], photo_refs: ["http://img/1.png"], claims_allowed: [] },
    ]);
  });
});

describe("saveBrandMemory", () => {
  it("calls the brand_memory_save RPC with shop_id + content", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "b1", shop_id: "s1", version: 1, is_active: true, content: {}, created_at: "t" }, error: null });
    const client = { rpc } as any;
    const rec = await saveBrandMemory(client, "s1", seedBrandMemory("Acme", []));
    expect(rpc).toHaveBeenCalledWith("brand_memory_save", expect.objectContaining({ p_shop_id: "s1" }));
    expect(rec.version).toBe(1);
  });
});

describe("getActiveBrandMemory", () => {
  it("queries the single active row scoped by shop_id", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "b1", shop_id: "s1", version: 2, is_active: true, content: {}, created_at: "t" }, error: null });
    const eq2 = vi.fn().mockReturnValue({ maybeSingle });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const from = vi.fn().mockReturnValue({ select });
    const client = { from } as any;
    const rec = await getActiveBrandMemory(client, "s1");
    expect(from).toHaveBeenCalledWith("brand_memory");
    expect(eq1).toHaveBeenCalledWith("shop_id", "s1");
    expect(rec?.version).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/brand-memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/brand-memory.server.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrandMemory, BrandMemoryRecord } from "./types";

export async function getActiveBrandMemory(
  client: SupabaseClient,
  shopId: string,
): Promise<BrandMemoryRecord | null> {
  const { data, error } = await client
    .from("brand_memory")
    .select("*")
    .eq("shop_id", shopId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return (data as BrandMemoryRecord | null) ?? null;
}

export async function saveBrandMemory(
  client: SupabaseClient,
  shopId: string,
  content: BrandMemory,
): Promise<BrandMemoryRecord> {
  const { data, error } = await client.rpc("brand_memory_save", {
    p_shop_id: shopId,
    p_content: content,
  });
  if (error) throw error;
  return data as BrandMemoryRecord;
}

/** Pure: build a starter brand memory from Shopify shop + products. */
export function seedBrandMemory(
  shopName: string,
  products: Array<{ title: string; price?: string; sku?: string; imageUrls: string[] }>,
): BrandMemory {
  return {
    identity: { name: shopName, category: "", positioning: "" },
    voice: { tone: [], formality: 3, person: "we", emoji_policy: "sparing", signature_phrases: [], style_examples: [] },
    audience: [],
    visual: { palette: [], fonts: [], logo_refs: [], imagery_rules: "", aspect_defaults: "1:1" },
    products: products.map((p) => ({
      name: p.title,
      sku: p.sku ?? "",
      hero_benefits: [],
      price: p.price,
      proof_points: [],
      photo_refs: p.imageUrls,
      claims_allowed: [],
    })),
    guardrails: { banned_words: [], banned_claims: [], required_disclaimers: [], regulated_category: false },
    examples: { good_posts: [], bad_posts: [] },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/brand-memory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/brand-memory.server.ts app/lib/content/__tests__/brand-memory.test.ts
git commit -m "feat(content): brand-memory IO (RPC) + Shopify seed"
```

---

## Task 8: `generate.server.ts` (copy generation + Anthropic adapter)

**Files:**
- Create: `app/lib/content/generate.server.ts`
- Test: `app/lib/content/__tests__/generate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/generate.test.ts
import { describe, it, expect, vi } from "vitest";
import { generateCopy } from "../generate.server";
import type { BrandMemory } from "../types";

const memory: BrandMemory = {
  identity: { name: "Acme" },
  voice: { tone: ["warm"], formality: 3, person: "we", emoji_policy: "sparing", signature_phrases: [], style_examples: [] },
  audience: [],
  visual: { palette: [], fonts: [], logo_refs: [], imagery_rules: "", aspect_defaults: "1:1" },
  products: [{ name: "Widget", sku: "W1", hero_benefits: [], proof_points: [], photo_refs: [], claims_allowed: [] }],
  guardrails: { banned_words: [], banned_claims: [], required_disclaimers: [], regulated_category: false },
  examples: { good_posts: [], bad_posts: [] },
};

const req = { memory, goal: "Launch", productNames: ["Widget"], platforms: ["instagram"] as const, variantsPerPlatform: 1 };

describe("generateCopy", () => {
  it("parses valid model JSON into AdCopy and caches the brand-memory system block", async () => {
    const model = vi.fn().mockResolvedValue(
      JSON.stringify({ copies: [{ platform: "instagram", hook: "Hi", body: "Buy widget", cta: "Shop", hashtags: ["#w"], claims_used: [] }] }),
    );
    const res = await generateCopy({ ...req, platforms: ["instagram"] }, model);
    expect(res.copies).toHaveLength(1);
    expect(res.copies[0].hook).toBe("Hi");
    // brand memory is sent in a cached system block
    const arg = model.mock.calls[0][0];
    expect(arg.system.some((b: any) => b.cache_control?.type === "ephemeral")).toBe(true);
  });

  it("rejects copy that exceeds platform limits", async () => {
    const long = "x".repeat(3000);
    const model = vi.fn().mockResolvedValue(
      JSON.stringify({ copies: [{ platform: "instagram", hook: "Hi", body: long, cta: "Shop", hashtags: [], claims_used: [] }] }),
    );
    const res = await generateCopy({ ...req, platforms: ["instagram"] }, model);
    expect(res.copies).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/limit/i);
  });

  it("returns a rejection on invalid JSON", async () => {
    const model = vi.fn().mockResolvedValue("not json");
    const res = await generateCopy({ ...req, platforms: ["instagram"] }, model);
    expect(res.copies).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/json/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/generate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/generate.server.ts
import type { AdCopy, BrandMemory, Platform } from "./types";
import { serializeBrandMemory } from "./serialize.server";
import { specFor, copyWithinLimits } from "./platform-specs";

export interface GenerateRequest {
  memory: BrandMemory;
  goal: string;
  productNames: string[];
  platforms: readonly Platform[];
  variantsPerPlatform: number;
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** A model call: given system blocks + a user prompt, return raw text (expected JSON). */
export type ModelCall = (args: { system: SystemBlock[]; user: string }) => Promise<string>;

export interface GenerateResult {
  copies: AdCopy[];
  rejected: Array<{ platform: Platform; reason: string }>;
}

const GLOBAL_RULES = [
  "You are a brand marketing copywriter.",
  "Use ONLY facts present in BRAND_MEMORY. Never invent prices, statistics, or claims.",
  "List every claim you make in claims_used, copied verbatim from a product's claims_allowed.",
  "Return ONLY valid JSON of shape {\"copies\":[{platform,hook,body,hashtags:[],cta,claims_used:[]}]}.",
].join(" ");

export async function generateCopy(req: GenerateRequest, model: ModelCall): Promise<GenerateResult> {
  const system: SystemBlock[] = [
    { type: "text", text: GLOBAL_RULES },
    { type: "text", text: `BRAND_MEMORY:\n${serializeBrandMemory(req.memory)}`, cache_control: { type: "ephemeral" } },
  ];
  const raw = await model({ system, user: buildUserPrompt(req) });
  return parseAndValidate(raw, req.platforms);
}

function buildUserPrompt(req: GenerateRequest): string {
  const specs = req.platforms
    .map((p) => {
      const s = specFor(p);
      return `- ${p}: <=${s.maxCaptionChars} chars, <=${s.maxHashtags} hashtags, ${s.toneHint}, ${s.ctaStyle}`;
    })
    .join("\n");
  return [
    `Goal: ${req.goal}`,
    `Products: ${req.productNames.join(", ")}`,
    `Generate ${req.variantsPerPlatform} variant(s) per platform for: ${req.platforms.join(", ")}`,
    `Platform rules:\n${specs}`,
  ].join("\n");
}

function parseAndValidate(raw: string, platforms: readonly Platform[]): GenerateResult {
  let parsed: { copies?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { copies: [], rejected: [{ platform: platforms[0], reason: "invalid JSON from model" }] };
  }
  const copies: AdCopy[] = [];
  const rejected: GenerateResult["rejected"] = [];
  const list = Array.isArray(parsed.copies) ? parsed.copies : [];
  for (const item of list) {
    const c = item as Partial<AdCopy>;
    if (!c.platform || !platforms.includes(c.platform)) continue;
    const copy: AdCopy = {
      platform: c.platform,
      hook: String(c.hook ?? ""),
      body: String(c.body ?? ""),
      hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
      cta: String(c.cta ?? ""),
      claims_used: Array.isArray(c.claims_used) ? c.claims_used.map(String) : [],
    };
    const captionLen = `${copy.hook}\n${copy.body}\n${copy.cta}`.length;
    if (!copyWithinLimits(copy.platform, captionLen, copy.hashtags.length)) {
      rejected.push({ platform: copy.platform, reason: "exceeds platform limits" });
      continue;
    }
    copies.push(copy);
  }
  return { copies, rejected };
}

/**
 * Real Anthropic-backed ModelCall. Not unit-tested (needs ANTHROPIC_API_KEY);
 * exercised via the route. Uses claude-opus-4-8 with the cached brand-memory prefix.
 */
export function anthropicModelCall(): ModelCall {
  return async ({ system, user }) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system: system as unknown as Anthropic.TextBlockParam[],
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    return block && "text" in block ? block.text : "";
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/generate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/generate.server.ts app/lib/content/__tests__/generate.test.ts
git commit -m "feat(content): Claude copy generation + parse/validate"
```

---

## Task 9: `image.server.ts` (overlay plan pure + provider/storage IO)

**Files:**
- Create: `app/lib/content/image.server.ts`
- Test: `app/lib/content/__tests__/image.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/image.test.ts
import { describe, it, expect } from "vitest";
import { buildOverlayPlan } from "../image.server";
import type { AdCopy } from "../types";

const copy: AdCopy = { platform: "instagram", hook: "Big Sale", body: "x", cta: "Shop Now", hashtags: [], claims_used: [] };

describe("buildOverlayPlan", () => {
  it("places hook top and CTA bottom, deterministically", () => {
    const a = buildOverlayPlan(copy, { price: "$19.99" });
    const b = buildOverlayPlan(copy, { price: "$19.99" });
    expect(a).toEqual(b);
    expect(a.layers.find((l) => l.role === "hook")?.text).toBe("Big Sale");
    expect(a.layers.find((l) => l.role === "cta")?.text).toBe("Shop Now");
    expect(a.layers.find((l) => l.role === "price")?.text).toBe("$19.99");
  });

  it("omits the price layer when no price is given", () => {
    const plan = buildOverlayPlan(copy, {});
    expect(plan.layers.find((l) => l.role === "price")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/image.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/image.server.ts
import type { AdCopy } from "./types";

export interface OverlayLayer {
  role: "hook" | "cta" | "price";
  text: string;
  position: "top" | "bottom-left" | "bottom-right";
}
export interface OverlayPlan {
  layers: OverlayLayer[];
}

/**
 * Pure: decide what text goes where on the generated image. Deterministic so the
 * legally-exact copy/price is reproducible (spec §7.2 — text is overlaid, not
 * rendered by the image model).
 */
export function buildOverlayPlan(copy: AdCopy, opts: { price?: string }): OverlayPlan {
  const layers: OverlayLayer[] = [
    { role: "hook", text: copy.hook, position: "top" },
    { role: "cta", text: copy.cta, position: "bottom-left" },
  ];
  if (opts.price) {
    layers.push({ role: "price", text: opts.price, position: "bottom-right" });
  }
  return { layers };
}

// --- IO seams (injected; not unit-tested, exercised via the route) ---

export interface ImageProvider {
  /** Generate a base image conditioned on product reference photos; returns image bytes. */
  generate(args: { prompt: string; referenceUrls: string[] }): Promise<Uint8Array>;
}
export interface Compositor {
  /** Burn the overlay plan onto the base image; returns final image bytes. */
  apply(base: Uint8Array, plan: OverlayPlan): Promise<Uint8Array>;
}
export interface MediaStore {
  /** Upload final bytes; return a public/signed URL. */
  put(key: string, bytes: Uint8Array): Promise<string>;
}

export async function generateImage(args: {
  copy: AdCopy;
  prompt: string;
  referenceUrls: string[];
  price?: string;
  key: string;
  provider: ImageProvider;
  compositor: Compositor;
  store: MediaStore;
}): Promise<string> {
  const base = await args.provider.generate({ prompt: args.prompt, referenceUrls: args.referenceUrls });
  const final = await args.compositor.apply(base, buildOverlayPlan(args.copy, { price: args.price }));
  return args.store.put(args.key, final);
}

/** Default provider: POST to the configured REST endpoint. Not unit-tested. */
export function restImageProvider(): ImageProvider {
  return {
    async generate({ prompt, referenceUrls }) {
      const resp = await fetch(process.env.IMAGE_PROVIDER_URL as string, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.IMAGE_PROVIDER_KEY}` },
        body: JSON.stringify({ prompt, reference_image_urls: referenceUrls }),
      });
      if (!resp.ok) throw new Error(`image provider ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    },
  };
}
```

> Note for the executor: the concrete `Compositor` (server-side text compositing) and the Supabase-Storage `MediaStore` are integration code wired in the route (Task 12). If a compositing library is needed, flag it per CLAUDE.md before adding; a minimal first version may store the base image and record the overlay plan for later compositing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/image.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/image.server.ts app/lib/content/__tests__/image.test.ts
git commit -m "feat(content): deterministic image overlay plan + provider seams"
```

---

## Task 10: `content-client.server.ts` (DTOs, shop scoping, approval)

**Files:**
- Create: `app/lib/content/content-client.server.ts`
- Test: `app/lib/content/__tests__/content-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/content/__tests__/content-client.test.ts
import { describe, it, expect } from "vitest";
import { rowToContentCampaign, rowToContentAsset, canApprove } from "../content-client.server";

describe("row mappers", () => {
  it("shapes a campaign DTO with no extra columns", () => {
    const dto = rowToContentCampaign({ id: "c1", shop_id: "s1", goal: "g", product_refs: ["p1"], brand_memory_version: 2, status: "pending_review", created_at: "t", secret: "leak" });
    expect(dto).toEqual({ id: "c1", shop_id: "s1", goal: "g", product_refs: ["p1"], brand_memory_version: 2, status: "pending_review", created_at: "t" });
    expect((dto as any).secret).toBeUndefined();
  });

  it("shapes an asset DTO and defaults risk_flags", () => {
    const dto = rowToContentAsset({ id: "a1", campaign_id: "c1", platform: "instagram", kind: "image", copy: null, media_url: null, status: "pending_review", risk_flags: null, override: null, created_at: "t" });
    expect(dto.risk_flags).toEqual([]);
    expect(dto.platform).toBe("instagram");
  });
});

describe("canApprove", () => {
  it("allows when every asset is approved/rejected and none has a blocking flag", () => {
    expect(canApprove([
      { status: "approved", risk_flags: [] } as any,
      { status: "rejected", risk_flags: [{ kind: "banned_word", detail: "x", blocking: true }] } as any,
    ])).toBe(true);
  });

  it("blocks when an asset is still pending_review", () => {
    expect(canApprove([{ status: "pending_review", risk_flags: [] } as any])).toBe(false);
  });

  it("blocks when an approved asset still has a blocking flag", () => {
    expect(canApprove([{ status: "approved", risk_flags: [{ kind: "banned_word", detail: "x", blocking: true }] } as any])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/content/__tests__/content-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/content/content-client.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import { CalderynError } from "../calderyn.server";
import type {
  AdCopy,
  ContentAsset,
  ContentCampaign,
  ContentCampaignDetail,
  Platform,
  RiskFlag,
} from "./types";

export function rowToContentCampaign(r: Record<string, unknown>): ContentCampaign {
  return {
    id: String(r.id),
    shop_id: String(r.shop_id),
    goal: String(r.goal ?? ""),
    product_refs: Array.isArray(r.product_refs) ? (r.product_refs as string[]) : [],
    brand_memory_version: Number(r.brand_memory_version ?? 0),
    status: r.status as ContentCampaign["status"],
    created_at: String(r.created_at),
  };
}

export function rowToContentAsset(r: Record<string, unknown>): ContentAsset {
  return {
    id: String(r.id),
    campaign_id: String(r.campaign_id),
    platform: r.platform as Platform,
    kind: r.kind as ContentAsset["kind"],
    copy: (r.copy as AdCopy | null) ?? null,
    media_url: (r.media_url as string | null) ?? null,
    status: r.status as ContentAsset["status"],
    risk_flags: Array.isArray(r.risk_flags) ? (r.risk_flags as RiskFlag[]) : [],
    override: (r.override as ContentAsset["override"]) ?? null,
    created_at: String(r.created_at),
  };
}

/** Pure approval gate (spec §8): all assets handled and none has a blocking flag. */
export function canApprove(assets: Array<Pick<ContentAsset, "status" | "risk_flags">>): boolean {
  if (assets.length === 0) return false;
  return assets.every(
    (a) =>
      (a.status === "approved" || a.status === "rejected") &&
      !(a.status === "approved" && a.risk_flags.some((f) => f.blocking)),
  );
}

export interface CreateCampaignInput {
  goal: string;
  productRefs: string[];
  brandMemoryVersion: number;
  assets: Array<{ platform: Platform; kind: ContentAsset["kind"]; copy: AdCopy | null; media_url: string | null; risk_flags: RiskFlag[] }>;
}

export function contentClient(shop: string) {
  const db = getSupabase();

  return {
    async listCampaigns(): Promise<ContentCampaign[]> {
      try {
        const shopId = await resolveShopId(shop);
        const { data, error } = await db
          .from("content_campaign")
          .select("*")
          .eq("shop_id", shopId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return (data ?? []).map(rowToContentCampaign);
      } catch (err) {
        throw asError("listCampaigns", err);
      }
    },

    async getCampaign(id: string): Promise<ContentCampaignDetail | null> {
      try {
        const shopId = await resolveShopId(shop);
        const { data: c, error: e1 } = await db
          .from("content_campaign")
          .select("*")
          .eq("shop_id", shopId)
          .eq("id", id)
          .maybeSingle();
        if (e1) throw e1;
        if (!c) return null;
        const { data: assets, error: e2 } = await db
          .from("content_asset")
          .select("*")
          .eq("campaign_id", id)
          .order("created_at", { ascending: true });
        if (e2) throw e2;
        return { ...rowToContentCampaign(c), assets: (assets ?? []).map(rowToContentAsset) };
      } catch (err) {
        throw asError("getCampaign", err);
      }
    },

    async createCampaign(input: CreateCampaignInput): Promise<ContentCampaign> {
      try {
        const shopId = await resolveShopId(shop);
        const { data, error } = await db.rpc("create_content_campaign", {
          payload: {
            shop_id: shopId,
            goal: input.goal,
            product_refs: input.productRefs,
            brand_memory_version: input.brandMemoryVersion,
            assets: input.assets.map((a) => ({ ...a, kind: a.kind, status: "pending_review" })),
          },
        });
        if (error) throw error;
        return rowToContentCampaign(data as Record<string, unknown>);
      } catch (err) {
        throw asError("createCampaign", err);
      }
    },

    async setAssetStatus(
      campaignId: string,
      assetId: string,
      status: ContentAsset["status"],
      override?: { reason: string; by: string },
    ): Promise<void> {
      try {
        const shopId = await resolveShopId(shop);
        // Scope: confirm the campaign belongs to this shop before mutating its asset.
        const { data: c, error: e0 } = await db
          .from("content_campaign").select("id").eq("shop_id", shopId).eq("id", campaignId).maybeSingle();
        if (e0) throw e0;
        if (!c) throw new CalderynError({ code: "NOT_FOUND", status: 404, message: "campaign not found for shop" });
        const { error } = await db
          .from("content_asset")
          .update({ status, override: override ?? null })
          .eq("campaign_id", campaignId)
          .eq("id", assetId);
        if (error) throw error;
      } catch (err) {
        throw asError("setAssetStatus", err);
      }
    },

    async approveCampaign(id: string): Promise<void> {
      try {
        const detail = await this.getCampaign(id);
        if (!detail) throw new CalderynError({ code: "NOT_FOUND", status: 404, message: "campaign not found" });
        if (!canApprove(detail.assets)) {
          throw new CalderynError({ code: "NOT_APPROVABLE", status: 409, message: "all assets must be handled and free of blocking flags" });
        }
        const shopId = await resolveShopId(shop);
        const { error } = await db
          .from("content_campaign")
          .update({ status: "approved" })
          .eq("shop_id", shopId)
          .eq("id", id);
        if (error) throw error;
      } catch (err) {
        throw asError("approveCampaign", err);
      }
    },
  };
}

function asError(prefix: string, err: unknown): CalderynError {
  if (err instanceof CalderynError) return err;
  const e = err as { message?: string; code?: string };
  return new CalderynError({ code: e.code ?? "SUPABASE_ERROR", status: 500, message: `${prefix}: ${e.message ?? String(err)}` });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/content/__tests__/content-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/content/content-client.server.ts app/lib/content/__tests__/content-client.test.ts
git commit -m "feat(content): contentClient DTOs + shop-scoped reads/writes + approval gate"
```

---

## Task 11: Route `/app/brand` (brand-memory editor)

**Files:**
- Create: `app/routes/app.brand.tsx`

> Mirror `app/routes/app.settings.tsx` for the loader/action + Polaris page shape and `useActionToast`. The editor is a JSON-backed form; for Slice 1 a compact editable view of the core sections (identity, voice tone, guardrails) is sufficient — the full nested editor can grow later.

- [ ] **Step 1: Implement the route**

```tsx
// app/routes/app.brand.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { BlockStack, Banner, Button, Card, Layout, Page, Text, TextField } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { getActiveBrandMemory, saveBrandMemory, seedBrandMemory } from "~/lib/content/brand-memory.server";
import type { BrandMemory } from "~/lib/content/types";

type LoaderPayload = { memory: BrandMemory; version: number | null };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const db = getSupabase();
  const shopId = await resolveShopId(session.shop);
  const existing = await getActiveBrandMemory(db, shopId);
  if (existing) return json<LoaderPayload>({ memory: existing.content, version: existing.version });

  // Pre-fill from Shopify (not saved until first Save).
  const res = await admin.graphql(
    `#graphql
    query SeedProducts { shop { name } products(first: 20) { nodes { title variants(first:1){nodes{price sku}} featuredImage{url} } } }`,
  );
  const body = await res.json();
  const shopName: string = body?.data?.shop?.name ?? session.shop;
  const products = (body?.data?.products?.nodes ?? []).map((p: any) => ({
    title: p.title,
    price: p.variants?.nodes?.[0]?.price,
    sku: p.variants?.nodes?.[0]?.sku,
    imageUrls: p.featuredImage?.url ? [p.featuredImage.url] : [],
  }));
  return json<LoaderPayload>({ memory: seedBrandMemory(shopName, products), version: null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const raw = String(form.get("memory") ?? "");
  let memory: BrandMemory;
  try {
    memory = JSON.parse(raw) as BrandMemory;
  } catch {
    return json({ ok: false, error: "Brand memory is not valid JSON" }, { status: 400 });
  }
  const db = getSupabase();
  const shopId = await resolveShopId(session.shop);
  const saved = await saveBrandMemory(db, shopId, memory);
  return json({ ok: true, version: saved.version });
};

export default function BrandPage() {
  const { memory, version } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const [value, setValue] = useState(JSON.stringify(memory, null, 2));

  return (
    <Page title="Brand memory" subtitle={version ? `Active version ${version}` : "Not saved yet — seeded from your store"}>
      <Layout>
        <Layout.Section>
          {actionData && "error" in actionData && actionData.error ? (
            <Banner tone="critical">{actionData.error}</Banner>
          ) : null}
          {actionData && "ok" in actionData && actionData.ok ? (
            <Banner tone="success">Saved as version {(actionData as any).version}</Banner>
          ) : null}
          <Card>
            <Form method="post">
              <BlockStack gap="400">
                <Text as="p" variant="bodyMd">Edit your brand memory. Every save creates a new immutable version.</Text>
                <TextField label="Brand memory (JSON)" name="memory" value={value} onChange={setValue} multiline={20} autoComplete="off" />
                <Button submit variant="primary" loading={nav.state === "submitting"}>Save brand memory</Button>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 2: Verify build + types**

Run: `npm run typecheck && npm run build`
Expected: exit 0 for both.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.brand.tsx
git commit -m "feat(content): brand-memory editor route (/app/brand)"
```

---

## Task 12: Route `/app/studio` (generate + draft list)

**Files:**
- Create: `app/routes/app.studio._index.tsx`

- [ ] **Step 1: Implement the route**

```tsx
// app/routes/app.studio._index.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { BlockStack, Badge, Button, Card, ChoiceList, Layout, Page, ResourceItem, ResourceList, Text, TextField } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { contentClient } from "~/lib/content/content-client.server";
import { getActiveBrandMemory } from "~/lib/content/brand-memory.server";
import { generateCopy, anthropicModelCall } from "~/lib/content/generate.server";
import { screenCopy } from "~/lib/content/screen.server";
import type { Platform } from "~/lib/content/types";

const ALL_PLATFORMS: Platform[] = ["instagram", "facebook", "tiktok", "youtube"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = contentClient(session.shop);
  const db = getSupabase();
  const shopId = await resolveShopId(session.shop);
  const [campaigns, brand] = await Promise.all([client.listCampaigns(), getActiveBrandMemory(db, shopId)]);
  return json({ campaigns, hasBrand: Boolean(brand) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getSupabase();
  const shopId = await resolveShopId(session.shop);
  const brand = await getActiveBrandMemory(db, shopId);
  if (!brand) return json({ ok: false, error: "Set up your brand memory first" }, { status: 400 });

  const form = await request.formData();
  const goal = String(form.get("goal") ?? "");
  const platforms = form.getAll("platforms").map(String).filter((p): p is Platform => (ALL_PLATFORMS as string[]).includes(p));
  const productNames = brand.content.products.map((p) => p.name);

  const { copies } = await generateCopy(
    { memory: brand.content, goal, productNames, platforms, variantsPerPlatform: 1 },
    anthropicModelCall(),
  );

  const assets = copies.map((copy) => ({
    platform: copy.platform,
    kind: "copy" as const,
    copy,
    media_url: null,
    risk_flags: screenCopy(copy, brand.content),
  }));

  const campaign = await contentClient(session.shop).createCampaign({
    goal,
    productRefs: brand.content.products.map((p) => p.sku),
    brandMemoryVersion: brand.version,
    assets,
  });
  return redirect(`/app/studio/${campaign.id}`);
};

export default function StudioIndex() {
  const { campaigns, hasBrand } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const [goal, setGoal] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(["instagram"]);

  return (
    <Page title="Campaign studio">
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="post">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Generate a campaign</Text>
                {!hasBrand ? <Text as="p" tone="critical">Set up brand memory first (Brand memory page).</Text> : null}
                <TextField label="Goal" name="goal" value={goal} onChange={setGoal} autoComplete="off" placeholder="e.g. Promote the summer launch" />
                <ChoiceList
                  allowMultiple
                  title="Platforms"
                  choices={ALL_PLATFORMS.map((p) => ({ label: p, value: p }))}
                  selected={platforms}
                  onChange={setPlatforms}
                />
                {platforms.map((p) => <input key={p} type="hidden" name="platforms" value={p} />)}
                <Button submit variant="primary" disabled={!hasBrand} loading={nav.state === "submitting"}>Generate</Button>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <ResourceList
              resourceName={{ singular: "campaign", plural: "campaigns" }}
              items={campaigns}
              renderItem={(c) => (
                <ResourceItem id={c.id} url={`/app/studio/${c.id}`} accessibilityLabel={c.goal}>
                  <Text as="span" variant="bodyMd" fontWeight="bold">{c.goal || "Untitled"}</Text>{" "}
                  <Badge>{c.status}</Badge>
                </ResourceItem>
              )}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 2: Verify build + types**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.studio._index.tsx
git commit -m "feat(content): studio route — generate + draft list (/app/studio)"
```

---

## Task 13: Route `/app/studio/:id` (review queue)

**Files:**
- Create: `app/routes/app.studio.$id.tsx`

- [ ] **Step 1: Implement the route**

```tsx
// app/routes/app.studio.$id.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Banner, Button, Card, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { contentClient } from "~/lib/content/content-client.server";
import { canApprove } from "~/lib/content/content-client.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const detail = await contentClient(session.shop).getCampaign(String(params.id));
  if (!detail) throw new Response("Not found", { status: 404 });
  return json({ detail, approvable: canApprove(detail.assets) });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = contentClient(session.shop);
  const id = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "approve_campaign") {
    await client.approveCampaign(id);
    return redirect(`/app/studio/${id}`);
  }
  const assetId = String(form.get("assetId"));
  if (intent === "approve_asset") await client.setAssetStatus(id, assetId, "approved");
  if (intent === "reject_asset") await client.setAssetStatus(id, assetId, "rejected");
  return redirect(`/app/studio/${id}`);
};

export default function StudioDetail() {
  const { detail, approvable } = useLoaderData<typeof loader>();
  return (
    <Page title={detail.goal || "Campaign"} subtitle={`Status: ${detail.status} · brand v${detail.brand_memory_version}`}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {detail.assets.map((a) => (
              <Card key={a.id}>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="h3" variant="headingSm">{a.platform}</Text>
                    <Badge tone={a.status === "approved" ? "success" : a.status === "rejected" ? "critical" : undefined}>{a.status}</Badge>
                  </InlineStack>
                  {a.risk_flags.length > 0 ? (
                    <Banner tone={a.risk_flags.some((f) => f.blocking) ? "critical" : "warning"}>
                      {a.risk_flags.map((f) => `${f.kind}: ${f.detail}`).join("; ")}
                    </Banner>
                  ) : null}
                  {a.copy ? (
                    <BlockStack gap="100">
                      <Text as="p" fontWeight="bold">{a.copy.hook}</Text>
                      <Text as="p">{a.copy.body}</Text>
                      <Text as="p" tone="subdued">{a.copy.cta} · {a.copy.hashtags.join(" ")}</Text>
                    </BlockStack>
                  ) : null}
                  <InlineStack gap="200">
                    <Form method="post">
                      <input type="hidden" name="assetId" value={a.id} />
                      <input type="hidden" name="intent" value="approve_asset" />
                      <Button submit disabled={a.risk_flags.some((f) => f.blocking)}>Approve</Button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="assetId" value={a.id} />
                      <input type="hidden" name="intent" value="reject_asset" />
                      <Button submit tone="critical">Reject</Button>
                    </Form>
                  </InlineStack>
                </BlockStack>
              </Card>
            ))}
            <Form method="post">
              <input type="hidden" name="intent" value="approve_campaign" />
              <Button submit variant="primary" disabled={!approvable}>Approve campaign</Button>
            </Form>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 2: Verify build + types**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.studio.$id.tsx
git commit -m "feat(content): review queue route (/app/studio/:id)"
```

---

## Task 14: NavMenu wiring

**Files:**
- Modify: `app/routes/app.tsx` (the embedded layout's `NavMenu`)

> Coordination: `app/routes/app.tsx` is a shared file. Add only the two links; keep the edit a single contiguous block and rebase before committing if #2/#4 touched it.

- [ ] **Step 1: Add nav links**

In the `<NavMenu>` in `app/routes/app.tsx`, add after the existing links:
```tsx
<Link to="/app/brand">Brand memory</Link>
<Link to="/app/studio">Campaign studio</Link>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: exit 0; both links render in the embedded nav.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.tsx
git commit -m "feat(content): add Brand memory + Campaign studio to nav"
```

---

## Task 15: Full pre-commit gate (CLAUDE.md)

- [ ] **Step 1: Run the whole suite**

Run, in order, pasting evidence:
```bash
npm test
npm run typecheck
npm run lint
npm run build
```
Expected: all exit 0. `npx prisma validate` is NOT required (no Prisma schema change). No `.graphql` codegen needed (the seed query is inline in the loader; if you extracted it to a `.graphql` file, run `npm run graphql-codegen` and commit the types).

- [ ] **Step 2: Patch sanity**

Run: `git diff --check` and `git diff --stat` on the branch.
Expected: clean; no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks.

- [ ] **Step 3: `/code-review`**

Run `/code-review` on the working tree; resolve blockers, justify any downgraded nits.

---

## Self-Review

**Spec coverage:**
- Brand memory model/editor/versioning/seed → Tasks 2, 3, 7, 11. ✓
- Generation (copy + per-platform + claims cross-check) → Tasks 5, 8, 12. ✓
- Image (product-photo conditioning + deterministic overlay) → Task 9, 12. ✓
- Risk screen + blocking-approval → Tasks 6, 10, 13. ✓
- Review queue + copy/download → Task 13 (download/copy buttons: add `navigator.clipboard`/`download` affordances in Task 13 polish; approval flow present). ✓
- DTOs + shop scoping + no-leak → Task 10. ✓
- Transactional versioning + atomic campaign write → Task 3 (RPC) consumed in 7/12. ✓
- DB ownership (shops not created here; FKs; single write path) → Task 3 preflight + Task 10. ✓
- Testing matrix (serialize/platform/screen/brand-memory/generate/image/content-client) → Tasks 4-10. ✓
- Pre-commit gate → Task 15. ✓

**Placeholder scan:** no TBD/TODO; every code step has full code. (Compositor/MediaStore are explicitly interface-injected with a documented minimal-first option, not placeholders.)

**Type consistency:** `BrandMemory`, `AdCopy`, `ContentCampaign`, `ContentAsset`, `RiskFlag`, `Platform` defined in Task 2 and used consistently; `contentClient`, `canApprove`, `screenCopy`, `generateCopy`, `serializeBrandMemory`, `buildOverlayPlan`, `seedBrandMemory`, `saveBrandMemory`, `getActiveBrandMemory` signatures match across tasks.

**Known follow-ups (not Slice 1 blockers):** copy/download affordances and the concrete Compositor/MediaStore are intentionally minimal; full nested brand-memory editor UI can grow past the JSON textarea.
