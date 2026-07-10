// Route tests for storefront.recover.$token.tsx (orders phase 3, Task 4). Same convention as
// storefront.invoice.pay.test.ts: fake the tenant resolver + the shared recoverability rule
// (isRecoverableOrderState is unit-tested in recovery.server.test.ts), plus an in-memory Supabase
// stand-in for the order/order_line reads and the cart origin-stamp UPDATE this route performs
// directly. buildCart/addCartLine are faked (their own behavior is unit-tested in
// cart.server.test.ts); the cart-cookie helpers stay REAL (pure, no DB) so the route exercises the
// actual signed-cookie commit it relies on.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";

type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const db: Record<string, Row[]> = { orders: [], order_line: [], cart: [] };
  return { db };
});

class Builder {
  private op: "select" | "update" = "select";
  private vals: Row = {};
  private filters: Array<[string, unknown]> = [];
  private wantSingle = false;
  private readonly table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(_cols?: string) {
    return this;
  }
  update(vals: Row) {
    this.op = "update";
    this.vals = vals;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
  private run(): { data: unknown; error: unknown } {
    const t = store.db[this.table];
    const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.op === "update") {
      for (const r of matched) Object.assign(r, this.vals);
      return { data: matched, error: null };
    }
    if (this.wantSingle) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => new Builder(t) }) }));

const resolveStorefrontShop = vi.fn();
const isRecoverableOrderState = vi.fn();
const buildCart = vi.fn();
const addCartLine = vi.fn();

// Real class so the route's `err instanceof VariantUnavailableError` branch is exercised.
const { VariantUnavailableError } = vi.hoisted(() => ({
  VariantUnavailableError: class VariantUnavailableError extends Error {
    readonly variantId: string;
    constructor(variantId: string, reason: "not_found" | "unavailable") {
      super(`variant ${variantId} ${reason}`);
      this.name = "VariantUnavailableError";
      this.variantId = variantId;
    }
  },
}));

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/order/recovery.server", () => ({
  isRecoverableOrderState: (...a: unknown[]) => isRecoverableOrderState(...a),
}));
vi.mock("~/lib/order/cart.server", () => ({
  buildCart: (...a: unknown[]) => buildCart(...a),
  addCartLine: (...a: unknown[]) => addCartLine(...a),
  VariantUnavailableError,
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { loader } from "../storefront.recover.$token";

const SECRET = "test-app-secret-0000000000000000000000000000";

const args = (token: string | undefined) =>
  ({
    request: new Request(`https://shop.example/storefront/recover/${token ?? ""}`),
    params: { token },
    context: {},
  }) as unknown as LoaderFunctionArgs;

function seedOrder(overrides: Partial<Row> = {}) {
  store.db.orders.push({
    id: "order-1",
    shop_id: "shop-1",
    channel: "storefront",
    state: "checkout_pending",
    confirmation_token: "tok-abc",
    ...overrides,
  });
}
function seedLines(lines: Array<{ variant_id: string; quantity: number }>) {
  for (const l of lines) store.db.order_line.push({ shop_id: "shop-1", order_id: "order-1", ...l });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  resolveStorefrontShop.mockResolvedValue("shop-1");
  isRecoverableOrderState.mockResolvedValue(true);
  buildCart.mockImplementation(async (shopId: string) => {
    const row = { id: "cart-99", shop_id: shopId, buyer_id: null, state: "cart", created_at: "2026-01-01T00:00:00.000Z" };
    store.db.cart.push(row);
    return { id: row.id, shopId, buyerId: null, state: "cart", createdAt: row.created_at };
  });
  addCartLine.mockResolvedValue({
    id: "cl-1",
    cartId: "cart-99",
    variantId: "v1",
    quantity: 2,
    unitPriceCents: 1999,
    currency: "usd",
    titleSnapshot: "Tee",
  });
});

describe("storefront.recover.$token loader", () => {
  it("builds a fresh cart, re-prices every line, stamps recovery origin, commits the cookie, and redirects to the cart", async () => {
    seedOrder();
    seedLines([{ variant_id: "v1", quantity: 2 }, { variant_id: "v2", quantity: 1 }]);

    const res = (await loader(args("tok-abc"))) as Response;

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/cart");
    expect(buildCart).toHaveBeenCalledWith("shop-1");
    expect(addCartLine).toHaveBeenCalledWith("shop-1", "cart-99", "v1", 2);
    expect(addCartLine).toHaveBeenCalledWith("shop-1", "cart-99", "v2", 1);
    // origin stamped on the FRESH cart, keyed to the original order.
    expect(store.db.cart.find((c) => c.id === "cart-99")!.origin).toBe("recovery:order-1");
    // The cart cookie is committed on the redirect.
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("cd_cart");
  });

  it("skips a line whose variant no longer exists/purchasable, still resuming the rest", async () => {
    seedOrder();
    seedLines([{ variant_id: "v1", quantity: 2 }, { variant_id: "v-gone", quantity: 1 }]);
    addCartLine.mockImplementation(async (_shopId: string, _cartId: string, variantId: string) => {
      if (variantId === "v-gone") throw new VariantUnavailableError(variantId, "unavailable");
      return { id: "cl-1", cartId: "cart-99", variantId, quantity: 2, unitPriceCents: 1999, currency: "usd", titleSnapshot: "Tee" };
    });

    const res = (await loader(args("tok-abc"))) as Response;

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/cart");
    expect(store.db.cart.find((c) => c.id === "cart-99")!.origin).toBe("recovery:order-1");
  });

  it("renders the all-gone page (200, no redirect, no cookie) when every line is unavailable", async () => {
    seedOrder();
    seedLines([{ variant_id: "v-gone", quantity: 1 }]);
    addCartLine.mockRejectedValue(new VariantUnavailableError("v-gone", "unavailable"));

    const res = (await loader(args("tok-abc"))) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.json()).toEqual({ allGone: true });
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(store.db.cart.find((c) => c.id === "cart-99")!.origin).toBeUndefined();
  });

  it("404s on an unknown token", async () => {
    const err = await loader(args("no-such-token")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    expect(buildCart).not.toHaveBeenCalled();
  });

  it("404s on a foreign-shop token (shop-scoped lookup)", async () => {
    seedOrder({ shop_id: "other-shop" });
    seedLines([{ variant_id: "v1", quantity: 1 }]);
    const err = await loader(args("tok-abc")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
  });

  it("404s on a non-storefront channel order (e.g. invoice)", async () => {
    seedOrder({ channel: "invoice" });
    const err = await loader(args("tok-abc")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
  });

  it("404s when the shared recoverability rule says no (e.g. merchant-cancelled)", async () => {
    seedOrder({ state: "cancelled" });
    isRecoverableOrderState.mockResolvedValue(false);
    const err = await loader(args("tok-abc")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    expect(isRecoverableOrderState).toHaveBeenCalledWith("shop-1", "order-1", "cancelled");
  });

  it("404s on a missing token without resolving the tenant's order at all", async () => {
    const err = await loader(args(undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
  });

  it("404s for the demo shell instead of 500ing on a non-uuid shop id", async () => {
    resolveStorefrontShop.mockResolvedValue("demo-shop");
    const err = await loader(args("tok-abc")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    expect(buildCart).not.toHaveBeenCalled();
  });
});
