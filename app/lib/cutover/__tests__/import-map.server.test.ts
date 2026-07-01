import { describe, it, expect, vi } from "vitest";
import {
  lookupOwnedId,
  recordImportMapEntry,
  getImportMapCounts,
} from "../import-map.server";

// getSupabase is swapped per-test via this holder so each test supplies its own stub.
// (vitest hoists vi.mock above imports, so the mock still applies to the import above.)
let currentSb: unknown = null;
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => currentSb }));

/**
 * In-memory import_map stub. Holds rows keyed nowhere special; the builder filters by the
 * accumulated eq() predicates. upsert() replaces a row matching the unique key or appends.
 */
function makeSb(seed: Array<Record<string, unknown>> = []) {
  const rows = [...seed];
  const captured = { upserts: [] as Array<{ row: unknown; opts: unknown }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
  const builder = (): any => {
    const filters: Array<[string, unknown]> = [];
    const match = () => rows.filter((r) => filters.every(([k, v]) => r[k] === v));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return b;
      },
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        captured.upserts.push({ row, opts });
        const i = rows.findIndex(
          (r) =>
            r.shop_id === row.shop_id &&
            r.entity_type === row.entity_type &&
            r.external_id === row.external_id,
        );
        if (i >= 0) rows[i] = { ...rows[i], ...row };
        else rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      // getImportMapCounts awaits select().eq() directly (thenable) -> filtered rows.
      then: (res: (r: { data: unknown; error: null }) => unknown) =>
        res({ data: match(), error: null }),
    };
    return b;
  };
  return { client: { from: () => builder() }, captured, rows };
}

describe("lookupOwnedId", () => {
  it("returns the owned id on a hit", async () => {
    const sb = makeSb([
      { shop_id: "s1", entity_type: "variant", external_id: "gid://v/1", owned_id: "owned-1" },
    ]);
    currentSb = sb.client;
    expect(await lookupOwnedId("s1", "variant", "gid://v/1")).toBe("owned-1");
  });

  it("returns null on a miss", async () => {
    currentSb = makeSb().client;
    expect(await lookupOwnedId("s1", "variant", "gid://v/nope")).toBeNull();
  });

  it("is shop-scoped — a foreign shop's mapping never leaks", async () => {
    const sb = makeSb([
      { shop_id: "other", entity_type: "variant", external_id: "gid://v/1", owned_id: "owned-x" },
    ]);
    currentSb = sb.client;
    expect(await lookupOwnedId("s1", "variant", "gid://v/1")).toBeNull();
  });
});

describe("recordImportMapEntry", () => {
  it("upserts on the (shop, entity_type, external_id) unique key", async () => {
    const sb = makeSb();
    currentSb = sb.client;
    await recordImportMapEntry("s1", "product", "gid://p/1", "owned-p1", 42);
    expect(sb.captured.upserts).toHaveLength(1);
    expect(sb.captured.upserts[0].row).toMatchObject({
      shop_id: "s1",
      entity_type: "product",
      external_id: "gid://p/1",
      owned_id: "owned-p1",
      source_version: 42,
    });
    expect(sb.captured.upserts[0].opts).toMatchObject({
      onConflict: "shop_id,entity_type,external_id",
    });
  });

  it("is idempotent — re-recording replaces in place, never duplicates", async () => {
    const sb = makeSb();
    currentSb = sb.client;
    await recordImportMapEntry("s1", "product", "gid://p/1", "owned-p1");
    await recordImportMapEntry("s1", "product", "gid://p/1", "owned-p1");
    expect(sb.rows).toHaveLength(1);
  });

  it("records a null source_version when omitted", async () => {
    const sb = makeSb();
    currentSb = sb.client;
    await recordImportMapEntry("s1", "location", "gid://l/1", "owned-l1");
    expect(sb.captured.upserts[0].row).toMatchObject({ source_version: null });
  });
});

describe("getImportMapCounts", () => {
  it("returns per-entity counts, shop-scoped", async () => {
    const sb = makeSb([
      { shop_id: "s1", entity_type: "product", external_id: "gid://p/1", owned_id: "op1" },
      { shop_id: "s1", entity_type: "variant", external_id: "gid://v/1", owned_id: "ov1" },
      { shop_id: "s1", entity_type: "variant", external_id: "gid://v/2", owned_id: "ov2" },
      { shop_id: "other", entity_type: "location", external_id: "gid://l/9", owned_id: "ol9" },
    ]);
    currentSb = sb.client;
    expect(await getImportMapCounts("s1")).toEqual({ product: 1, variant: 2, location: 0 });
  });

  it("returns zeros for a shop with no entries", async () => {
    currentSb = makeSb().client;
    expect(await getImportMapCounts("s1")).toEqual({ product: 0, variant: 0, location: 0 });
  });
});
