import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";

// In-memory stand-in for cart/cart_line, same convention as cart.server.test.ts (composite FK +
// unique-per-variant enforcement) plus a bare `.delete()` for deleteMerchantDraft.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { cart: [], cart_line: [] };

  class Builder {
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: Row = {};
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
    private sorts: Array<[string, boolean]> = [];
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }
    insert(payload: Row) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    update(vals: Row) {
      this.op = "update";
      this.vals = vals;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    order(col: string, opts: { ascending: boolean }) {
      this.sorts.push([col, opts.ascending]);
      return this;
    }
    limit(_n: number) {
      // Cap not modeled (test rows never approach it) — present only so the real query chain
      // (listMerchantDrafts' .limit(50)) doesn't throw "not a function" against this fake.
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }

    private matches(r: Row) {
      return this.filters.every(([c, v]) => r[c] === v);
    }
    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        if (this.table === "cart_line") {
          const parent = t !== db.cart_line ? undefined : db.cart.find(
            (c) => c.shop_id === this.payload.shop_id && c.id === this.payload.cart_id,
          );
          if (!parent) {
            return { data: null, error: { message: "composite FK (shop_id, cart_id) -> cart violated" } };
          }
          const dup = db.cart_line.find(
            (r) =>
              r.shop_id === this.payload.shop_id &&
              r.cart_id === this.payload.cart_id &&
              r.variant_id === this.payload.variant_id,
          );
          if (dup) {
            return { data: null, error: { message: "duplicate key: cart_line (shop_id, cart_id, variant_id)" } };
          }
        }
        const row: Row = { id: `${this.table}-${t.length + 1}`, created_at: new Date().toISOString(), ...this.payload };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      if (this.op === "delete") {
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) t.splice(t.indexOf(r), 1);
        // Mirror the migration's ON DELETE CASCADE from cart -> cart_line.
        if (this.table === "cart") {
          for (const r of matched) {
            for (const line of [...db.cart_line]) {
              if (line.shop_id === r.shop_id && line.cart_id === r.id) {
                db.cart_line.splice(db.cart_line.indexOf(line), 1);
              }
            }
          }
        }
        return this.wrap(matched);
      }
      let result = t.filter((r) => this.matches(r));
      for (const [col, asc] of [...this.sorts].reverse()) {
        result = [...result].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      return this.wrap(result);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

const PRISTINE: StoreProduct[] = [
  {
    id: "p-tee",
    handle: "cotton-tee",
    title: "Cotton Tee",
    description: "",
    images: [],
    variants: [{ id: "v-tee-s", sku: "TEE-S", title: "Small", priceCents: 1999, currency: "USD", available: true }],
    collections: ["apparel"],
  },
  {
    id: "p-hoodie",
    handle: "zip-hoodie",
    title: "Zip Hoodie",
    description: "",
    images: [],
    variants: [{ id: "v-hoodie-l", sku: "HOOD-L", title: "Large", priceCents: 5499, currency: "USD", available: true }],
    collections: ["apparel"],
  },
];

const catalog = vi.hoisted(() => ({ products: [] as StoreProduct[] }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => catalog.products,
    getProduct: async (_s: string, h: string) => catalog.products.find((p) => p.handle === h) ?? null,
    listCollections: async () => [],
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import {
  listMerchantDrafts,
  createMerchantDraft,
  replaceMerchantDraftLines,
  deleteMerchantDraft,
} from "./merchant-drafts.server";
// eslint-disable-next-line import/first -- follows vi.mock like the import above
import { VariantUnavailableError } from "./cart.server";

beforeEach(() => {
  store.db.cart.length = 0;
  store.db.cart_line.length = 0;
  catalog.products = structuredClone(PRISTINE);
});

describe("createMerchantDraft", () => {
  it("creates a merchant-draft cart seeded with the given lines", async () => {
    const draft = await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 2 }]);
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ variantId: "v-tee-s", quantity: 2, unitPriceCents: 1999 });
    expect(draft.subtotalCents).toBe(3998);
    expect(store.db.cart[0]).toMatchObject({ shop_id: "shop-1", origin: "merchant_draft", state: "cart" });
  });

  it("rejects an unavailable/unknown variant (fail visibly, VariantUnavailableError)", async () => {
    await expect(createMerchantDraft("shop-1", [{ variantId: "v-missing", quantity: 1 }])).rejects.toBeInstanceOf(
      VariantUnavailableError,
    );
  });
});

describe("listMerchantDrafts", () => {
  it("lists only open (state='cart') merchant-draft carts for the shop, newest first", async () => {
    await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 1 }]);
    await createMerchantDraft("shop-1", [{ variantId: "v-hoodie-l", quantity: 1 }]);
    // A regular (non-draft) cart in the same shop must not appear.
    store.db.cart.push({ id: "cart-plain", shop_id: "shop-1", state: "cart", origin: null, created_at: new Date().toISOString() });
    // An already-invoiced draft (state advanced past 'cart') must not appear.
    store.db.cart.push({
      id: "cart-invoiced",
      shop_id: "shop-1",
      state: "checkout_pending",
      origin: "merchant_draft",
      created_at: new Date().toISOString(),
    });
    // A different shop's draft must not appear.
    await createMerchantDraft("shop-2", [{ variantId: "v-tee-s", quantity: 1 }]);

    const drafts = await listMerchantDrafts("shop-1");
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.lines.length === 1)).toBe(true);
  });

  it("returns an empty list when the shop has no drafts", async () => {
    expect(await listMerchantDrafts("shop-1")).toEqual([]);
  });
});

describe("replaceMerchantDraftLines", () => {
  it("clears existing lines and adds the new ones fresh", async () => {
    const draft = await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 1 }]);
    const replaced = await replaceMerchantDraftLines("shop-1", draft.id, [{ variantId: "v-hoodie-l", quantity: 3 }]);
    expect(replaced.lines).toHaveLength(1);
    expect(replaced.lines[0]).toMatchObject({ variantId: "v-hoodie-l", quantity: 3 });
    expect(store.db.cart_line.filter((l) => l.cart_id === draft.id)).toHaveLength(1);
  });

  it("422s (unknown_variant) on a bad variant id and leaves the ORIGINAL lines untouched", async () => {
    const draft = await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 1 }]);

    await expect(
      replaceMerchantDraftLines("shop-1", draft.id, [
        { variantId: "v-tee-s", quantity: 2 },
        { variantId: "v-missing", quantity: 1 },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "unknown_variant" });

    // Nothing cleared: the original line (and only the original line) is still there, at its
    // original quantity — the bad id must never wipe the draft mid-edit.
    const lines = store.db.cart_line.filter((l) => l.cart_id === draft.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ variant_id: "v-tee-s", quantity: 1 });
  });

  it("404s (draft_not_found) on an unknown cart id", async () => {
    await expect(
      replaceMerchantDraftLines("shop-1", "no-such-cart", [{ variantId: "v-tee-s", quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404, code: "draft_not_found" });
  });

  it("404s on a cart that exists but is not a merchant draft (cross-shop or non-draft origin)", async () => {
    store.db.cart.push({ id: "cart-plain", shop_id: "shop-1", state: "cart", origin: null, created_at: new Date().toISOString() });
    await expect(
      replaceMerchantDraftLines("shop-1", "cart-plain", [{ variantId: "v-tee-s", quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404, code: "draft_not_found" });

    const draft = await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 1 }]);
    await expect(
      replaceMerchantDraftLines("other-shop", draft.id, [{ variantId: "v-tee-s", quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404, code: "draft_not_found" });
  });
});

describe("deleteMerchantDraft", () => {
  it("deletes the cart (and cascades its lines)", async () => {
    const draft = await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 1 }]);
    await deleteMerchantDraft("shop-1", draft.id);
    expect(store.db.cart.find((c) => c.id === draft.id)).toBeUndefined();
    expect(store.db.cart_line.some((l) => l.cart_id === draft.id)).toBe(false);
  });

  it("404s on an unknown id", async () => {
    await expect(deleteMerchantDraft("shop-1", "no-such-cart")).rejects.toMatchObject({
      status: 404,
      code: "draft_not_found",
    });
  });

  it("is scoped: cannot delete another shop's draft", async () => {
    const draft = await createMerchantDraft("shop-1", [{ variantId: "v-tee-s", quantity: 1 }]);
    await expect(deleteMerchantDraft("other-shop", draft.id)).rejects.toMatchObject({
      status: 404,
      code: "draft_not_found",
    });
    expect(store.db.cart.find((c) => c.id === draft.id)).toBeDefined();
  });
});
