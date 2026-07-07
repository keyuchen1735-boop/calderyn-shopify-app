// updateProduct must refuse to remove a variant that still holds stock: the
// inventory_balance FK is ON DELETE CASCADE, so a blind delete would wipe live
// on-hand and orphan held reservations. The guard must run before any
// destructive child write, so a block leaves the variant (and its stock) intact.
import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));

const deleted: string[] = [];
let removedIds: string[] = [];
let balances: Array<{ variant_id: string; on_hand: number; reserved: number }> = [];

function resolveFor(table: string, verb: string) {
  if (table === "product_dim" && verb === "update") return { data: [{ id: "p1" }], error: null };
  if (table === "variant_dim" && verb === "select") return { data: removedIds.map((id) => ({ id })), error: null };
  if (table === "inventory_balance") return { data: balances, error: null };
  return { data: [], error: null };
}

function builder(table: string) {
  let verb = "select";
  const b = {
    update() { verb = "update"; return b; },
    insert() { verb = "insert"; return b; },
    delete() { verb = "delete"; deleted.push(table); return b; },
    select() { return b; },
    eq() { return b; },
    in() { return b; },
    notIn() { return b; },
    upsert() { return Promise.resolve({ error: null }); },
    single() { return Promise.resolve(resolveFor(table, "single")); },
    then(res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(resolveFor(table, verb)).then(res, rej);
    },
  };
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));

beforeEach(() => { project.mockClear(); deleted.length = 0; removedIds = []; balances = []; });

const editKeepingOnly = (kept: string) => ({
  title: "Tee", status: "active" as const, variants: [{ id: kept, sku: "K", retailPriceCents: 2000 }],
});

describe("updateProduct variant-removal stock guard", () => {
  it("blocks removing a variant that still has on-hand stock and never deletes it", async () => {
    removedIds = ["v-removed"];
    balances = [{ variant_id: "v-removed", on_hand: 40, reserved: 0 }];
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", editKeepingOnly("v-keep"))).rejects.toMatchObject({
      code: "variant_has_stock",
      status: 409,
    });
    expect(deleted).not.toContain("variant_dim");
  });

  it("blocks on a held reservation (reserved > 0) even with zero on-hand", async () => {
    removedIds = ["v-removed"];
    balances = [{ variant_id: "v-removed", on_hand: 0, reserved: 3 }];
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", editKeepingOnly("v-keep"))).rejects.toMatchObject({
      code: "variant_has_stock",
    });
    expect(deleted).not.toContain("variant_dim");
  });

  it("allows removing a variant with no balance rows (proceeds to delete)", async () => {
    removedIds = ["v-removed"];
    balances = [];
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", editKeepingOnly("v-keep"));
    expect(deleted).toContain("variant_dim");
  });
});
