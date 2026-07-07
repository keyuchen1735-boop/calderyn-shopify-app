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
      // Mirror real Postgres `ON CONFLICT (...) DO UPDATE SET <listed cols>`: a
      // partial-column upsert (e.g. upsertSeoSettings's patch) must only touch the
      // columns present in `row`, preserving any other already-stored columns.
      const existing = store[table].find((r) => keys.every((k) => r[k] === row[k]));
      const merged = existing ? { ...existing, ...row } : row;
      store[table] = store[table].filter((r) => !keys.every((k) => r[k] === row[k]));
      store[table].push(merged);
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
const DEFAULTS = { allowAiCrawlers: true, orgName: null, orgDescription: null };

beforeEach(() => { store.seo_settings = []; store.seo_page = []; forcedError = null; });

describe("getSeoSettings", () => {
  it("returns defaults when there is no row", async () => {
    expect(await getSeoSettings(SHOP)).toEqual(DEFAULTS);
  });
  it("returns defaults for a non-uuid (demo) shop without touching the DB", async () => {
    expect(await getSeoSettings("demo-shop")).toEqual(DEFAULTS);
  });
  it("maps a stored row and ignores the dormant allow_ai_training column", async () => {
    store.seo_settings.push({ shop_id: SHOP, allow_ai_crawlers: false, allow_ai_training: true, org_name: "Ember", org_description: "Candles" });
    expect(await getSeoSettings(SHOP)).toEqual({ allowAiCrawlers: false, orgName: "Ember", orgDescription: "Candles" });
  });
});

describe("upsertSeoSettings", () => {
  it("writes only the patched columns and returns the merged settings", async () => {
    const out = await upsertSeoSettings(SHOP, { allowAiCrawlers: false, orgName: "Ember" });
    expect(out).toEqual({ allowAiCrawlers: false, orgName: "Ember", orgDescription: null });
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
