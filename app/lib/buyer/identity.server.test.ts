import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the buyer PII tables. It enforces the constraints that the
// migration enforces so the helpers are tested against REAL behavior, not bare mocks:
//   - buyer_dim: unique(shop_id, email_normalized) -> upsert merges instead of duplicating.
//   - buyer_address: buyer_address_one_default partial unique index -> a second is_default
//     row for the same (buyer_id, kind) is rejected, proving the helper must clear first.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { buyer_dim: [], buyer_address: [], buyer_consent: [] };

  class Builder {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row = {};
    private vals: Row = {};
    private onConflict: string[] = [];
    private filters: Array<[string, unknown]> = [];
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }

    upsert(payload: Row, opts?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = payload;
      this.onConflict = (opts?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
      return this;
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
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }

    private rows() {
      return db[this.table];
    }
    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private run(): { data: unknown; error: unknown } {
      const t = this.rows();
      if (this.op === "upsert") {
        const existing = t.find((r) => this.onConflict.every((c) => r[c] === this.payload[c]));
        if (existing) {
          Object.assign(existing, this.payload);
          return this.wrap([existing]);
        }
        const row: Row = {
          id: `${this.table}-${t.length + 1}`,
          phone: null,
          created_at: new Date().toISOString(),
          ...this.payload,
        };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "insert") {
        if (this.table === "buyer_address" && this.payload.is_default) {
          const dup = t.find(
            (r) => r.buyer_id === this.payload.buyer_id && r.kind === this.payload.kind && r.is_default,
          );
          if (dup) {
            return { data: null, error: { message: "duplicate key value: buyer_address_one_default" } };
          }
        }
        const row: Row = {
          id: `${this.table}-${t.length + 1}`,
          created_at: new Date().toISOString(),
          captured_at: new Date().toISOString(),
          ...this.payload,
        };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
        for (const r of matched) Object.assign(r, this.vals);
        return { data: matched, error: null };
      }
      const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered first
import {
  normalizeEmail,
  upsertGuestBuyer,
  addBuyerAddress,
  recordConsent,
  recordCheckoutConsent,
} from "./identity.server";

beforeEach(() => {
  store.db.buyer_dim.length = 0;
  store.db.buyer_address.length = 0;
  store.db.buyer_consent.length = 0;
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo.Bar@Example.COM ")).toBe("foo.bar@example.com");
  });
  it("rejects empty / shapeless input", () => {
    expect(() => normalizeEmail("   ")).toThrow();
    expect(() => normalizeEmail("not-an-email")).toThrow();
  });
});

describe("upsertGuestBuyer", () => {
  it("normalizes the email before persisting", async () => {
    const buyer = await upsertGuestBuyer("shop-1", { email: "  Casey@SHOP.com " });
    expect(buyer.emailNormalized).toBe("casey@shop.com");
    expect(store.db.buyer_dim).toHaveLength(1);
    expect(store.db.buyer_dim[0].email_normalized).toBe("casey@shop.com");
  });

  it("is idempotent: same email + shop (any case) returns the same buyer, one row", async () => {
    const a = await upsertGuestBuyer("shop-1", { email: "casey@shop.com" });
    const b = await upsertGuestBuyer("shop-1", { email: "CASEY@shop.com" });
    expect(b.id).toBe(a.id);
    expect(store.db.buyer_dim).toHaveLength(1);
  });

  it("scopes uniqueness per shop: same email in two shops are distinct buyers", async () => {
    const a = await upsertGuestBuyer("shop-1", { email: "casey@shop.com" });
    const b = await upsertGuestBuyer("shop-2", { email: "casey@shop.com" });
    expect(b.id).not.toBe(a.id);
    expect(store.db.buyer_dim).toHaveLength(2);
  });

  it("does not clobber a previously captured phone when re-upserted without one", async () => {
    await upsertGuestBuyer("shop-1", { email: "casey@shop.com", phone: "+15551234567" });
    const again = await upsertGuestBuyer("shop-1", { email: "casey@shop.com" });
    expect(again.phone).toBe("+15551234567");
  });

  it("distinguishes undefined (preserve) from explicit null (clear) for phone", async () => {
    await upsertGuestBuyer("shop-1", { email: "casey@shop.com", phone: "+15551234567" });
    const cleared = await upsertGuestBuyer("shop-1", { email: "casey@shop.com", phone: null });
    expect(cleared.phone).toBeNull();
    expect(store.db.buyer_dim[0].phone).toBeNull();
  });
});

describe("addBuyerAddress", () => {
  const base = { line1: "1 Main St", city: "Austin", country: "US" };

  it("rejects an invalid kind and a missing line1/country (fail visibly)", async () => {
    await expect(
      // @ts-expect-error — invalid kind is the thing under test
      addBuyerAddress("shop-1", "buyer-1", { kind: "home", ...base }),
    ).rejects.toThrow();
    await expect(addBuyerAddress("shop-1", "buyer-1", { kind: "shipping", country: "US" })).rejects.toThrow();
    await expect(addBuyerAddress("shop-1", "buyer-1", { kind: "shipping", line1: "1 Main St" })).rejects.toThrow();
  });

  it("threads shop_id + buyer_id onto the stored row", async () => {
    const addr = await addBuyerAddress("shop-1", "buyer-1", { kind: "shipping", ...base });
    expect(addr.buyerId).toBe("buyer-1");
    expect(store.db.buyer_address[0]).toMatchObject({ shop_id: "shop-1", buyer_id: "buyer-1", kind: "shipping" });
  });

  it("clears the prior default so only one default exists per (buyer, kind)", async () => {
    await addBuyerAddress("shop-1", "buyer-1", { kind: "shipping", line1: "1 Main St", country: "US", isDefault: true });
    const second = await addBuyerAddress("shop-1", "buyer-1", {
      kind: "shipping",
      line1: "2 Oak Ave",
      country: "US",
      isDefault: true,
    });

    const shippingDefaults = store.db.buyer_address.filter(
      (r) => r.buyer_id === "buyer-1" && r.kind === "shipping" && r.is_default,
    );
    expect(shippingDefaults).toHaveLength(1);
    expect(shippingDefaults[0].id).toBe(second.id);
  });

  it("scopes the default-clear to (shop, buyer, kind): other shops' and buyers' defaults survive", async () => {
    // Pre-existing defaults the shop-A/buyer-A call must NOT touch.
    store.db.buyer_address.push(
      { id: "other-shop", shop_id: "shop-B", buyer_id: "buyer-B", kind: "shipping", is_default: true },
      { id: "same-shop-other-buyer", shop_id: "shop-A", buyer_id: "buyer-X", kind: "shipping", is_default: true },
      { id: "same-buyer-old-default", shop_id: "shop-A", buyer_id: "buyer-A", kind: "shipping", is_default: true },
    );

    const fresh = await addBuyerAddress("shop-A", "buyer-A", {
      kind: "shipping",
      line1: "9 New St",
      country: "US",
      isDefault: true,
    });

    const byId = (id: string) => store.db.buyer_address.find((r) => r.id === id);
    expect(byId("other-shop")!.is_default).toBe(true); // different shop — untouched
    expect(byId("same-shop-other-buyer")!.is_default).toBe(true); // same shop, different buyer — untouched
    expect(byId("same-buyer-old-default")!.is_default).toBe(false); // same (shop,buyer,kind) — cleared
    // The only buyer-A shipping default is now the freshly inserted row.
    const buyerADefaults = store.db.buyer_address.filter(
      (r) => r.shop_id === "shop-A" && r.buyer_id === "buyer-A" && r.kind === "shipping" && r.is_default,
    );
    expect(buyerADefaults.map((r) => r.id)).toEqual([fresh.id]);
  });

  it("keeps shipping and billing defaults independent", async () => {
    await addBuyerAddress("shop-1", "buyer-1", { kind: "shipping", line1: "1 Main St", country: "US", isDefault: true });
    await addBuyerAddress("shop-1", "buyer-1", { kind: "billing", line1: "1 Main St", country: "US", isDefault: true });
    const defaults = store.db.buyer_address.filter((r) => r.is_default);
    expect(defaults).toHaveLength(2);
  });
});

describe("recordConsent", () => {
  it("captures version + accepted + source_ip + ua as proof", async () => {
    const c = await recordConsent("shop-1", "buyer-1", {
      policy: "tos",
      version: "2026-06-01",
      accepted: true,
      sourceIp: "203.0.113.7",
      ua: "Mozilla/5.0",
    });
    expect(c).toMatchObject({
      buyerId: "buyer-1",
      policy: "tos",
      version: "2026-06-01",
      accepted: true,
      sourceIp: "203.0.113.7",
      ua: "Mozilla/5.0",
    });
    expect(c.capturedAt).toBeTruthy();
  });

  it("rejects an unknown policy and a blank version", async () => {
    await expect(
      // @ts-expect-error — invalid policy is the thing under test
      recordConsent("shop-1", "buyer-1", { policy: "cookies", version: "1", accepted: true }),
    ).rejects.toThrow();
    await expect(
      recordConsent("shop-1", "buyer-1", { policy: "tos", version: "  ", accepted: true }),
    ).rejects.toThrow();
  });

  it("models withdrawal as a new append-only row, not an update", async () => {
    await recordConsent("shop-1", "buyer-1", { policy: "marketing", version: "v1", accepted: true });
    await recordConsent("shop-1", "buyer-1", { policy: "marketing", version: "v1", accepted: false });
    const marketing = store.db.buyer_consent.filter((r) => r.policy === "marketing");
    expect(marketing).toHaveLength(2);
    expect(marketing.map((r) => r.accepted)).toEqual([true, false]);
  });
});

describe("recordCheckoutConsent", () => {
  it("records tos + privacy accepted and marketing as the opt-in boolean", async () => {
    const rows = await recordCheckoutConsent("shop-1", "buyer-1", {
      version: "2026-06-01",
      marketingOptIn: false,
      sourceIp: "203.0.113.7",
      ua: "UA",
    });
    expect(rows).toHaveLength(3);
    const byPolicy = Object.fromEntries(rows.map((r) => [r.policy, r.accepted]));
    expect(byPolicy).toEqual({ tos: true, privacy: true, marketing: false });
    // Proof fields are carried onto every row.
    expect(rows.every((r) => r.sourceIp === "203.0.113.7" && r.ua === "UA")).toBe(true);
  });
});
