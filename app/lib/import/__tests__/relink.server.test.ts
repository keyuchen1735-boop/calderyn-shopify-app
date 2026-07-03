// Order<->customer relink (#13.customers). The behaviors that matter: an order's customer
// email is matched to buyer_dim by NORMALIZED email (case/whitespace-insensitive); an order
// whose customer has no imported buyer (or no email) is left unlinked and counted, never
// silently attributed; the UPDATE only fills a NULL buyer_id so a re-run converges; and the
// email itself is only ever resolved in memory — the write carries a buyer_id UUID, not PII.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminOrderCustomerEmail } from "~/lib/ingest/shopify-admin.server";

const orders: AdminOrderCustomerEmail[] = [];
vi.mock("~/lib/ingest/shopify-admin.server", () => ({
  fetchOrderCustomerEmails: async function* () {
    yield* orders;
  },
}));

// A recording supabase mock: buyer_dim lookups return `buyerRows`; imported_order UPDATEs are
// captured (payload + IN gids + whether the NULL guard was applied); the two count queries
// resolve `linkedCount` / `unmatchedCount` distinguished by their NOT-NULL vs IS-NULL terminal.
type BuyerRow = { id: string; email_normalized: string };
interface UpdateCall {
  buyerId: unknown;
  gids: unknown;
  nullGuard: boolean;
}
const state = {
  buyerRows: [] as BuyerRow[],
  linkedCount: 0,
  unmatchedCount: 0,
  updateCalls: [] as UpdateCall[],
};

function builder(table: string) {
  const op = {
    table,
    kind: "select" as "select" | "update",
    count: false,
    update: null as Record<string, unknown> | null,
    inVals: null as unknown,
    nullGuard: false,
    notNull: false,
    isNull: false,
  };
  const b = {
    select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) op.count = true;
      return b;
    },
    update: (p: Record<string, unknown>) => {
      op.kind = "update";
      op.update = p;
      return b;
    },
    eq: () => b,
    in: (_col: string, vals: unknown) => {
      op.inVals = vals;
      return b;
    },
    is: (col: string, val: unknown) => {
      if (col === "buyer_id" && val === null) {
        if (op.kind === "update") op.nullGuard = true;
        else op.isNull = true;
      }
      return b;
    },
    not: (col: string, _o: string, val: unknown) => {
      if (col === "buyer_id" && val === null) op.notNull = true;
      return b;
    },
    then: (resolve: (v: unknown) => void) => {
      if (op.kind === "update") {
        state.updateCalls.push({ buyerId: op.update?.buyer_id, gids: op.inVals, nullGuard: op.nullGuard });
        return resolve({ error: null });
      }
      if (op.table === "buyer_dim") return resolve({ data: state.buyerRows, error: null });
      if (op.count) {
        const count = op.notNull ? state.linkedCount : op.isNull ? state.unmatchedCount : 0;
        return resolve({ count, error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return b;
}
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));

// eslint-disable-next-line import/first -- must follow the vi.mock factories above
import { relinkOrdersToBuyers } from "../relink.server";

beforeEach(() => {
  orders.length = 0;
  state.buyerRows = [];
  state.linkedCount = 0;
  state.unmatchedCount = 0;
  state.updateCalls = [];
});

describe("relinkOrdersToBuyers", () => {
  it("links promoted orders to a buyer matched by NORMALIZED email", async () => {
    orders.push(
      { id: "gid://shopify/Order/1", email: "A@Example.com" },
      { id: "gid://shopify/Order/2", email: "a@example.com  " },
    );
    state.buyerRows = [{ id: "buyer-1", email_normalized: "a@example.com" }];
    state.linkedCount = 2;

    const r = await relinkOrdersToBuyers("s.myshopify.com", "shop-1", "2025-07-03T00:00:00Z");

    // Both orders normalize to the same buyer → one grouped UPDATE, buyer_id UUID only.
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].buyerId).toBe("buyer-1");
    expect(state.updateCalls[0].gids).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/2"]);
    expect(r).toEqual({ linked: 2, unmatched: 0 });
  });

  it("leaves an order unlinked when its customer has no imported buyer or no email", async () => {
    orders.push(
      { id: "gid://shopify/Order/1", email: "ghost@example.com" }, // no buyer_dim row
      { id: "gid://shopify/Order/2", email: null }, // guest / no customer
    );
    state.buyerRows = []; // nothing resolves
    state.unmatchedCount = 2;

    const r = await relinkOrdersToBuyers("s.myshopify.com", "shop-1", "2025-07-03T00:00:00Z");

    expect(state.updateCalls).toHaveLength(0); // never attributes an order to a non-buyer
    expect(r).toEqual({ linked: 0, unmatched: 2 });
  });

  it("only fills a NULL buyer_id and converges on a re-run (idempotent)", async () => {
    orders.push({ id: "gid://shopify/Order/1", email: "a@example.com" });
    state.buyerRows = [{ id: "buyer-1", email_normalized: "a@example.com" }];
    state.linkedCount = 1;

    const first = await relinkOrdersToBuyers("s.myshopify.com", "shop-1", "2025-07-03T00:00:00Z");
    const second = await relinkOrdersToBuyers("s.myshopify.com", "shop-1", "2025-07-03T00:00:00Z");

    // Every write is guarded by `is('buyer_id', null)`, so a re-run cannot clobber or double-link.
    expect(state.updateCalls.every((c) => c.nullGuard)).toBe(true);
    expect(second).toEqual(first); // stable counts
  });
});
