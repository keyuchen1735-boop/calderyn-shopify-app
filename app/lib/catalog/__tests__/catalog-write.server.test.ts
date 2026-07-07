import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));

// The ledger seed is exercised in inventory-seed.server.test.ts; here we only
// assert createProduct wires the variant's starting stock through to it.
const seedInitialStock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../inventory/engine.server", () => ({ seedInitialStock }));

const single = vi.fn().mockResolvedValue({ data: { id: "p1" }, error: null });
// One insert mock that supports both `.insert(x).select("id").single()` (product /
// option / variant) and `await .insert(x)` (link tables), so the create path's
// variant insert (which chains select().single()) works.
const insert = vi.fn((_payload?: Record<string, unknown>) => ({
  select: () => ({ single }),
  then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ insert, upsert: () => Promise.resolve({ error: null }), delete: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
  }),
}));

beforeEach(() => { project.mockClear(); insert.mockClear(); seedInitialStock.mockClear(); });

describe("validateProductInput", () => {
  it("rejects a product with no variants", async () => {
    const { validateProductInput } = await import("../validate");
    const r = validateProductInput({ title: "Tee", status: "active", variants: [] });
    expect(r.ok).toBe(false);
  });
});

// The variant_dim insert is the one insert payload that carries inventory_tracked.
function variantInsertPayload(): Record<string, unknown> {
  const call = insert.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((a) => a && "inventory_tracked" in a);
  if (!call) throw new Error("no variant insert captured");
  return call;
}

describe("createProduct", () => {
  it("creates the product and re-projects sku_dim", async () => {
    const { createProduct } = await import("../catalog.server");
    const res = await createProduct("shop1", {
      title: "Tee", status: "active", variants: [{ sku: "T-S", retailPriceCents: 1999, inventoryOnHand: 5 }],
    });
    expect(res.id).toBe("p1");
    expect(project).toHaveBeenCalledWith("p1");
  });

  it("seeds the new variant's starting stock into the owned inventory ledger", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Tee", status: "active", variants: [{ sku: "T-S", retailPriceCents: 1999, inventoryOnHand: 5 }],
    });
    // The variant insert mock returns id "p1"; its starting stock must flow to the ledger.
    expect(seedInitialStock).toHaveBeenCalledWith("shop1", "p1", 5);
  });

  it("tracks a new physical variant that was given a stock number, so entered stock gates availability", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Tee", status: "active",
      variants: [{ retailPriceCents: 1999, inventoryOnHand: 5, requiresShipping: true }],
    });
    expect(variantInsertPayload().inventory_tracked).toBe(true);
  });

  it("tracks a physical variant whose stock is explicitly 0 (so it shows sold out, not always-available)", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Tee", status: "active",
      variants: [{ retailPriceCents: 1999, inventoryOnHand: 0, requiresShipping: true }],
    });
    expect(variantInsertPayload().inventory_tracked).toBe(true);
  });

  it("leaves a digital (no-shipping) variant untracked — stays always available", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Ebook", status: "active",
      variants: [{ retailPriceCents: 999, requiresShipping: false }],
    });
    expect(variantInsertPayload().inventory_tracked).toBe(false);
  });

  it("leaves a variant with blank stock untracked (make-to-order)", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Mug", status: "active",
      variants: [{ retailPriceCents: 1500, requiresShipping: true }],
    });
    expect(variantInsertPayload().inventory_tracked).toBe(false);
  });

  it("honours an explicit inventoryTracked from the caller", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Tee", status: "active",
      variants: [{ retailPriceCents: 1999, inventoryOnHand: 5, requiresShipping: true, inventoryTracked: false }],
    });
    expect(variantInsertPayload().inventory_tracked).toBe(false);
  });
});
