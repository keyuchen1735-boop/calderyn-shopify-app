import { describe, it, expect, vi, beforeEach } from "vitest";

const backfillShop = vi.fn();
vi.mock("~/lib/ingest/backfill.server", () => ({ backfillShop }));
const promoteShopFromMirror = vi.fn();
vi.mock("../promote.server", () => ({
  promoteShopFromMirror,
  buildImportReport: (
    counts: { orders?: number },
    customers: { imported: number; skipped: number; blocked: boolean },
    relink: { linked: number; unmatched: number } = { linked: 0, unmatched: 0 },
  ) => ({
    imported: [
      `${counts.orders ?? 0} orders`,
      `${customers.imported} customers`,
      ...(relink.linked > 0 ? [`${relink.linked} orders linked`] : []),
    ],
    notIncluded: ["customers"],
  }),
}));
const importCustomers = vi.fn();
vi.mock("../customers.server", () => ({ importCustomers }));
const relinkOrdersToBuyers = vi.fn();
vi.mock("../relink.server", () => ({ relinkOrdersToBuyers }));

// Supabase query-builder mock: every builder method is chainable AND the builder is
// awaitable (thenable), matching supabase-js where `.eq()` etc. both chain and resolve.
type Row = Record<string, unknown>;
let selectRows: Row[] = [];
let singleReturn: { data: Row | null; error: unknown } = { data: null, error: null };
const updates: Row[] = [];

interface Chain {
  select: () => Chain;
  insert: (p: Row) => Chain;
  update: (p: Row) => Chain;
  eq: () => Chain;
  in: () => Chain;
  order: () => Chain;
  limit: () => Chain;
  single: () => Promise<{ data: Row | null; error: unknown }>;
  maybeSingle: () => Promise<{ data: Row | null; error: unknown }>;
  then: (resolve: (v: { data: Row[]; error: unknown }) => void) => void;
}

function chain(): Chain {
  const c = {} as Chain;
  Object.assign(c, {
    select: () => c,
    insert: () => c,
    update: (p: Row) => { updates.push(p); return c; },
    eq: () => c,
    in: () => c,
    order: () => c,
    limit: () => c,
    single: () => Promise.resolve(singleReturn),
    maybeSingle: () => Promise.resolve({ data: selectRows[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: unknown }) => void) => resolve({ data: selectRows, error: null }),
  });
  return c;
}
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => chain() }) }));

beforeEach(() => {
  backfillShop.mockReset();
  promoteShopFromMirror.mockReset();
  importCustomers.mockReset();
  importCustomers.mockResolvedValue({ imported: 0, skipped: 0, blocked: false });
  relinkOrdersToBuyers.mockReset();
  relinkOrdersToBuyers.mockResolvedValue({ linked: 0, unmatched: 0 });
  selectRows = [];
  singleReturn = { data: null, error: null };
  updates.length = 0;
});

describe("drainImports", () => {
  it("pulls sinceDays, promotes, and marks the run done", async () => {
    selectRows = [{ id: "r1", shop_id: "shop1", since_days: 365, shops: { shop_domain: "d.myshopify.com" } }];
    backfillShop.mockResolvedValue({ orders: 1100 });
    promoteShopFromMirror.mockResolvedValue({ products: 5, variants: 12, collections: 2, balances: 12, orders: 1100, refunds: 30 });

    const { drainImports } = await import("../run.server");
    const r = await drainImports();

    expect(backfillShop).toHaveBeenCalledWith("d.myshopify.com", { sinceDays: 365 });
    expect(promoteShopFromMirror).toHaveBeenCalledWith("shop1");
    expect(r.processed).toBe(1);
    expect(updates.some((u) => u.state === "promoting")).toBe(true);
    expect(updates.some((u) => u.state === "done")).toBe(true);
  });

  it("runs the customer stage and feeds its counts into the report", async () => {
    selectRows = [{ id: "r1", shop_id: "shop1", since_days: 365, shops: { shop_domain: "d.myshopify.com" } }];
    // The pull count (777) differs from the promoted count (1100): the report must
    // read the PROMOTED count, so this proves run feeds counts.orders, not backfill.orders.
    backfillShop.mockResolvedValue({ orders: 777 });
    promoteShopFromMirror.mockResolvedValue({ products: 5, variants: 12, collections: 2, balances: 12, orders: 1100, refunds: 30 });
    importCustomers.mockResolvedValueOnce({ imported: 3, skipped: 0, blocked: false });

    const { drainImports } = await import("../run.server");
    await drainImports();

    expect(importCustomers).toHaveBeenCalledWith("d.myshopify.com", "shop1");
    const done = updates.find((u) => u.state === "done");
    expect((done?.report as { imported: string[] }).imported).toContain("3 customers");
    expect((done?.report as { imported: string[] }).imported).toContain("1100 orders");
  });

  it("relinks orders to buyers after promote and surfaces the count in the report", async () => {
    selectRows = [{ id: "r1", shop_id: "shop1", since_days: 365, shops: { shop_domain: "d.myshopify.com" } }];
    backfillShop.mockResolvedValue({ orders: 1100 });
    promoteShopFromMirror.mockResolvedValue({ products: 5, variants: 12, collections: 2, balances: 12, orders: 1100, refunds: 30 });
    importCustomers.mockResolvedValueOnce({ imported: 3, skipped: 0, blocked: false });
    relinkOrdersToBuyers.mockResolvedValueOnce({ linked: 900, unmatched: 200 });

    const { drainImports } = await import("../run.server");
    await drainImports();

    // Relink runs with the same 12-month window the pull used.
    expect(relinkOrdersToBuyers).toHaveBeenCalledTimes(1);
    expect(relinkOrdersToBuyers.mock.calls[0][0]).toBe("d.myshopify.com");
    expect(relinkOrdersToBuyers.mock.calls[0][1]).toBe("shop1");
    const done = updates.find((u) => u.state === "done");
    expect((done?.report as { imported: string[] }).imported).toContain("900 orders linked");
  });

  it("skips relink when the customer stage is blocked (protected-customer-data pending)", async () => {
    selectRows = [{ id: "r1", shop_id: "shop1", since_days: 365, shops: { shop_domain: "d.myshopify.com" } }];
    backfillShop.mockResolvedValue({ orders: 1100 });
    promoteShopFromMirror.mockResolvedValue({ products: 5, variants: 12, collections: 2, balances: 12, orders: 1100, refunds: 0 });
    importCustomers.mockResolvedValueOnce({ imported: 0, skipped: 0, blocked: true });

    const { drainImports } = await import("../run.server");
    const r = await drainImports();

    // No buyers were imported, so there is nothing to link — the pass (and its PCD-gated query) is skipped.
    expect(relinkOrdersToBuyers).not.toHaveBeenCalled();
    expect(r.processed).toBe(1);
    expect(updates.some((u) => u.state === "done")).toBe(true);
  });

  it("marks the run error and skips promote when the pull throws", async () => {
    selectRows = [{ id: "r1", shop_id: "shop1", since_days: 365, shops: { shop_domain: "d.myshopify.com" } }];
    backfillShop.mockRejectedValue(new Error("shopify 500"));

    const { drainImports } = await import("../run.server");
    const r = await drainImports();

    expect(promoteShopFromMirror).not.toHaveBeenCalled();
    // A failed pull must short-circuit the customer stage too (same offline token).
    expect(importCustomers).not.toHaveBeenCalled();
    expect(r.processed).toBe(0);
    expect(updates.some((u) => u.state === "error")).toBe(true);
  });
});

describe("startImport", () => {
  it("inserts a pulling run and returns its id", async () => {
    selectRows = []; // no in-progress run
    singleReturn = { data: { id: "imp_123" }, error: null };
    const { startImport } = await import("../run.server");
    const r = await startImport("shop1");
    expect(r.importId).toBe("imp_123");
  });

  it("returns the existing run instead of starting a duplicate", async () => {
    selectRows = [{ id: "in_progress" }]; // an in-progress run exists
    const { startImport } = await import("../run.server");
    const r = await startImport("shop1");
    expect(r.importId).toBe("in_progress");
  });
});
