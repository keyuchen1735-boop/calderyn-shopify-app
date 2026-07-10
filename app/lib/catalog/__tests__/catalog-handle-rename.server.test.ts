// updateProduct handle-rename path: a changed handle must (1) land on
// product_dim, (2) leave a redirect row for the OLD handle, (3) reclaim any
// redirect row squatting on the NEW handle, and (4) map the unique(shop_id,
// handle) 23505 to a 409 handle_conflict. Unchanged/absent handles are no-ops.
import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));
vi.mock("../../inventory/engine.server", () => ({ seedInitialStock: vi.fn().mockResolvedValue(undefined) }));

const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
const deletes: Array<{ table: string; filters: Record<string, unknown> }> = [];
let currentHandle = "old-handle";
let parentUpdateError: { code?: string; message?: string } | null = null;

function builder(table: string) {
  let verb: "select" | "update" | "insert" | "delete" = "select";
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {
    update(payload: Record<string, unknown>) { verb = "update"; updates.push({ table, payload }); return b; },
    insert() { verb = "insert"; return b; },
    delete() { verb = "delete"; return b; },
    upsert(payload: Record<string, unknown>) { upserts.push({ table, payload }); return Promise.resolve({ error: null }); },
    select() { return b; },
    eq(col: string, val: unknown) { filters[col] = val; return b; },
    in() { return b; },
    notIn() { return b; },
    maybeSingle() {
      if (table === "product_dim") return Promise.resolve({ data: { handle: currentHandle }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    single() { return Promise.resolve({ data: { id: "new-row" }, error: null }); },
    then(res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) {
      if (verb === "delete") {
        deletes.push({ table, filters });
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      }
      if (table === "product_dim" && verb === "update") {
        const r = parentUpdateError
          ? { data: null, error: parentUpdateError }
          : { data: [{ id: "p1" }], error: null };
        return Promise.resolve(r).then(res, rej);
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
  updates.length = 0; upserts.length = 0; deletes.length = 0;
  currentHandle = "old-handle";
  parentUpdateError = null;
});

const edit = (handle?: string) => ({
  title: "Tee", status: "active" as const, handle,
  variants: [{ id: "v1", sku: "K", retailPriceCents: 2000, requiresShipping: false }],
});

const parentUpdate = () => updates.find((u) => u.table === "product_dim")?.payload;
const redirectUpserts = () => upserts.filter((u) => u.table === "product_handle_redirect");
const redirectDeletes = () => deletes.filter((d) => d.table === "product_handle_redirect");

describe("updateProduct handle rename", () => {
  it("writes the new handle, records a redirect for the old one, and reclaims the new one", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit("new-handle"));
    expect(parentUpdate()?.handle).toBe("new-handle");
    expect(redirectUpserts()).toEqual([
      { table: "product_handle_redirect", payload: { shop_id: "shop1", old_handle: "old-handle", product_id: "p1" } },
    ]);
    expect(redirectDeletes()).toEqual([
      { table: "product_handle_redirect", filters: { shop_id: "shop1", old_handle: "new-handle" } },
    ]);
  });

  it("is a no-op when the handle is unchanged", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit("old-handle"));
    expect(parentUpdate()).not.toHaveProperty("handle");
    expect(redirectUpserts()).toHaveLength(0);
    expect(redirectDeletes()).toHaveLength(0);
  });

  it("is a no-op when no handle is sent", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", edit(undefined));
    expect(parentUpdate()).not.toHaveProperty("handle");
    expect(redirectUpserts()).toHaveLength(0);
    expect(redirectDeletes()).toHaveLength(0);
  });

  it("maps the unique-violation 23505 on a handle change to 409 handle_conflict, leaving no redirect row", async () => {
    parentUpdateError = { code: "23505", message: "duplicate key" };
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit("taken-handle"))).rejects.toMatchObject({
      code: "handle_conflict",
      status: 409,
    });
    expect(redirectUpserts()).toHaveLength(0);
  });

  it("rethrows a 23505 raw when no handle change was requested (not a handle conflict)", async () => {
    parentUpdateError = { code: "23505", message: "duplicate key" };
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "p1", edit(undefined))).rejects.toMatchObject({ code: "23505" });
  });
});
