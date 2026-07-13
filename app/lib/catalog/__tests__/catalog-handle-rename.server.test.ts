// updateProduct handle-rename path: every guard that can reject the save runs
// BEFORE any write; a changed handle must (1) record the OLD handle's redirect
// row FIRST (retryable ordering), (2) land the new handle via a compare-and-set
// conditional on the handle read earlier (concurrent rename → 409
// editing_conflict), (3) reclaim any redirect row squatting on the NEW handle,
// and (4) map the unique(shop_id, handle) 23505 to a 409 handle_conflict.
// Unchanged/absent handles are no-ops. createProduct must honor an explicitly
// supplied handle (no retry loop; 23505 → 409). Both writers persist input.seo.
import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));
vi.mock("../../inventory/engine.server", () => ({ seedInitialStock: vi.fn().mockResolvedValue(undefined) }));
const applySeo = vi.hoisted(() => vi.fn());
vi.mock("../product-seo.server", () => ({ applySeoOverrideInput: (...a: unknown[]) => applySeo(...a) }));

interface Op {
  verb: "select" | "update" | "insert" | "delete" | "upsert";
  table: string;
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
}
const ops: Op[] = [];
let currentHandle = "old-handle";
let parentUpdateError: { code?: string; message?: string } | null = null;
let parentUpdateMatches = true;
let productInsertError: { code?: string; message?: string } | null = null;
let removedVariantRows: Array<{ id: string }> = [];
let balanceRows: Array<Record<string, unknown>> = [];

function builder(table: string) {
  let verb: Op["verb"] = "select";
  let payload: Record<string, unknown> | undefined;
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {
    update(p: Record<string, unknown>) { verb = "update"; payload = p; return b; },
    insert(p: Record<string, unknown>) { verb = "insert"; payload = Array.isArray(p) ? undefined : p; return b; },
    delete() { verb = "delete"; return b; },
    upsert(p: Record<string, unknown>) {
      ops.push({ verb: "upsert", table, payload: p, filters });
      return Promise.resolve({ error: null });
    },
    select() { return b; },
    eq(col: string, val: unknown) { filters[col] = val; return b; },
    in() { return b; },
    notIn() { return b; },
    maybeSingle() {
      if (table === "product_dim") return Promise.resolve({ data: { handle: currentHandle }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    single() {
      ops.push({ verb, table, payload, filters });
      if (table === "product_dim" && verb === "insert" && productInsertError) {
        return Promise.resolve({ data: null, error: productInsertError });
      }
      return Promise.resolve({ data: { id: "new-row" }, error: null });
    },
    then(res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) {
      ops.push({ verb, table, payload, filters });
      if (verb === "delete") return Promise.resolve({ data: null, error: null }).then(res, rej);
      if (table === "product_dim" && verb === "update") {
        const r = parentUpdateError
          ? { data: null, error: parentUpdateError }
          : { data: parentUpdateMatches ? [{ id: "p1" }] : [], error: null };
        return Promise.resolve(r).then(res, rej);
      }
      if (table === "variant_dim" && verb === "select") {
        return Promise.resolve({ data: removedVariantRows, error: null }).then(res, rej);
      }
      if (table === "inventory_balance" && verb === "select") {
        return Promise.resolve({ data: balanceRows, error: null }).then(res, rej);
      }
      if (verb === "update") return Promise.resolve({ data: [{ id: filters.id ?? "row" }], error: null }).then(res, rej);
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    },
  };
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));

beforeEach(() => {
  project.mockClear();
  applySeo.mockReset();
  applySeo.mockResolvedValue(undefined);
  ops.length = 0;
  currentHandle = "old-handle";
  parentUpdateError = null;
  parentUpdateMatches = true;
  productInsertError = null;
  removedVariantRows = [];
  balanceRows = [];
});

const edit = (handle?: string, seo?: { metaTitle: string; metaDescription: string }) => ({
  title: "Tee", status: "active" as const, handle, seo,
  variants: [{ id: "v1", sku: "K", retailPriceCents: 2000, requiresShipping: false }],
});

const parentUpdate = () => ops.find((o) => o.table === "product_dim" && o.verb === "update");
const redirectUpserts = () => ops.filter((o) => o.table === "product_handle_redirect" && o.verb === "upsert");
const redirectDeletes = () => ops.filter((o) => o.table === "product_handle_redirect" && o.verb === "delete");

describe("updateProduct handle rename", () => {
  it("writes the new handle, records a redirect for the old one, and reclaims the new one", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit("new-handle"));
    expect(parentUpdate()?.payload?.handle).toBe("new-handle");
    expect(redirectUpserts().map((o) => o.payload)).toEqual([
      { shop_id: "shop1", old_handle: "old-handle", product_id: "p1" },
    ]);
    expect(redirectDeletes().map((o) => o.filters)).toEqual([
      { shop_id: "shop1", old_handle: "new-handle" },
    ]);
  });

  it("orders the rename: redirect row FIRST, then the handle flip, then the reclaim", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit("new-handle"));
    const upsertAt = ops.findIndex((o) => o.table === "product_handle_redirect" && o.verb === "upsert");
    const updateAt = ops.findIndex((o) => o.table === "product_dim" && o.verb === "update");
    const reclaimAt = ops.findIndex((o) => o.table === "product_handle_redirect" && o.verb === "delete");
    expect(upsertAt).toBeGreaterThanOrEqual(0);
    expect(upsertAt).toBeLessThan(updateAt);
    expect(updateAt).toBeLessThan(reclaimAt);
  });

  it("makes the handle flip conditional on the handle it read (compare-and-set)", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit("new-handle"));
    expect(parentUpdate()?.filters).toMatchObject({ shop_id: "shop1", id: "p1", handle: "old-handle" });
  });

  it("throws 409 editing_conflict when a concurrent rename won the compare-and-set", async () => {
    parentUpdateMatches = false;
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit("new-handle"))).rejects.toMatchObject({
      code: "editing_conflict",
      status: 409,
    });
    // Nothing after the failed flip: no reclaim, no child writes.
    expect(redirectDeletes()).toHaveLength(0);
    expect(ops.some((o) => o.table === "product_option" && o.verb === "delete")).toBe(false);
  });

  it("still 404s an unmatched update when no rename was requested", async () => {
    parentUpdateMatches = false;
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit(undefined))).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("runs the stock guard BEFORE any write — a 409 leaves the handle and redirects untouched", async () => {
    removedVariantRows = [{ id: "vx" }];
    balanceRows = [{ variant_id: "vx", on_hand: 3, reserved: 0 }];
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit("new-handle"))).rejects.toMatchObject({
      code: "variant_has_stock",
      status: 409,
    });
    expect(parentUpdate()).toBeUndefined();
    expect(redirectUpserts()).toHaveLength(0);
    expect(redirectDeletes()).toHaveLength(0);
  });

  it("is a no-op when the handle is unchanged", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit("old-handle"));
    expect(parentUpdate()?.payload).not.toHaveProperty("handle");
    expect(parentUpdate()?.filters).not.toHaveProperty("handle");
    expect(redirectUpserts()).toHaveLength(0);
    expect(redirectDeletes()).toHaveLength(0);
  });

  it("is a no-op when no handle is sent", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit(undefined));
    expect(parentUpdate()?.payload).not.toHaveProperty("handle");
    expect(redirectUpserts()).toHaveLength(0);
    expect(redirectDeletes()).toHaveLength(0);
  });

  it("maps the unique-violation 23505 on a handle change to 409 handle_conflict without reclaiming", async () => {
    parentUpdateError = { code: "23505", message: "duplicate key" };
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit("taken-handle"))).rejects.toMatchObject({
      code: "handle_conflict",
      status: 409,
    });
    // The redirect row was written first BY DESIGN (retryable ordering): a
    // stale row for a still-live handle is harmless (the PDP checks the live
    // product first) and self-heals on a later rename. Only the reclaim must
    // not have run.
    expect(redirectDeletes()).toHaveLength(0);
  });

  it("rethrows a 23505 raw when no handle change was requested (not a handle conflict)", async () => {
    parentUpdateError = { code: "23505", message: "duplicate key" };
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit(undefined))).rejects.toMatchObject({ code: "23505" });
  });
});

describe("updateProduct seo pass-through", () => {
  it("persists input.seo via applySeoOverrideInput as the last step", async () => {
    const { updateProduct } = await import("../catalog.server");
    const seo = { metaTitle: "T", metaDescription: "D" };
    await updateProduct("shop1", "p1", edit(undefined, seo));
    expect(applySeo).toHaveBeenCalledWith("shop1", "p1", seo);
  });

  it("does not touch seo_page when input.seo is absent", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit(undefined));
    expect(applySeo).not.toHaveBeenCalled();
  });
});

describe("createProduct handle + seo", () => {
  const create = (handle?: string, seo?: { metaTitle: string; metaDescription: string }) => ({
    title: "Tee", status: "draft" as const, handle, seo,
    variants: [{ sku: "K", requiresShipping: false }],
  });
  const productInserts = () => ops.filter((o) => o.table === "product_dim" && o.verb === "insert");

  it("honors an explicitly supplied handle instead of generating one", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", create("my-clean-handle"));
    expect(productInserts()).toHaveLength(1);
    expect(productInserts()[0].payload?.handle).toBe("my-clean-handle");
  });

  it("maps a 23505 on an explicit handle to 409 handle_conflict with no retry", async () => {
    productInsertError = { code: "23505", message: "duplicate key" };
    const { createProduct } = await import("../catalog.server");
    await expect(createProduct("shop1", create("taken-handle"))).rejects.toMatchObject({
      code: "handle_conflict",
      status: 409,
    });
    expect(productInserts()).toHaveLength(1);
  });

  it("still generates (and retries) a suffixed handle when none is supplied", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", create(undefined));
    expect(String(productInserts()[0].payload?.handle)).toMatch(/^tee-[0-9a-f]{6}$/);

    ops.length = 0;
    productInsertError = { code: "23505", message: "duplicate key" };
    await expect(createProduct("shop1", create(undefined))).rejects.toMatchObject({ code: "23505" });
    expect(productInserts()).toHaveLength(3); // generated-handle collisions retry
  });

  it("rejects input.seo on create before any write (search listing is edit-only)", async () => {
    const { createProduct } = await import("../catalog.server");
    const seo = { metaTitle: "T", metaDescription: "" };
    await expect(createProduct("shop1", create(undefined, seo))).rejects.toMatchObject({
      code: "seo_requires_existing_product",
      status: 422,
    });
    expect(productInserts()).toHaveLength(0);
    expect(applySeo).not.toHaveBeenCalled();
  });
});
