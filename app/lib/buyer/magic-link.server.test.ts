import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for buyer_dim (unique shop_id,email_normalized upsert) + buyer_magic_link
// (single-use consume via the consumed_at IS NULL claim).
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { buyer_dim: [], buyer_magic_link: [] };

  class Builder {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row = {};
    private vals: Row = {};
    private onConflict: string[] = [];
    private filters: Array<[string, unknown]> = [];
    private nullFilters: string[] = [];
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
    select(_c?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    is(col: string, _val: null) {
      this.nullFilters.push(col);
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
    private match(r: Row) {
      return this.filters.every(([c, v]) => r[c] === v) && this.nullFilters.every((c) => r[c] == null);
    }
    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "upsert") {
        const existing = t.find((r) => this.onConflict.every((c) => r[c] === this.payload[c]));
        if (existing) {
          Object.assign(existing, this.payload);
          return this.wrap([existing]);
        }
        const row: Row = { id: `${this.table}-${t.length + 1}`, phone: null, created_at: new Date().toISOString(), ...this.payload };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "insert") {
        const row: Row = { id: `${this.table}-${t.length + 1}`, consumed_at: null, created_at: new Date().toISOString(), ...this.payload };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.match(r));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      return this.wrap(t.filter((r) => this.match(r)));
    }
  }
  return { db, client: { from: (table: string) => new Builder(table) } };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

const sends: Array<{ to: string | string[]; subject: string; text: string }> = [];
vi.mock("~/lib/email/send.server", () => ({
  sendEmail: vi.fn(async (opts: { to: string | string[]; subject: string; text: string }) => {
    sends.push({ to: opts.to, subject: opts.subject, text: opts.text });
    return { sent: true, id: "test-email" };
  }),
}));

process.env.BUYER_SESSION_PEPPER = "buyer-session-pepper-for-tests-000000";

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes register first
import { createMagicLink, consumeMagicLink, requestBuyerMagicLink } from "./magic-link.server";

beforeEach(() => {
  store.db.buyer_dim.length = 0;
  store.db.buyer_magic_link.length = 0;
  sends.length = 0;
});

function tokenFromLastSend(): string {
  const link = sends.at(-1)!.text.match(/\?t=([^\s]+)/)![1];
  return decodeURIComponent(link);
}

describe("createMagicLink", () => {
  it("stores only the hash and a ~15-minute expiry, never the raw token", async () => {
    const { raw } = await createMagicLink("shop-1", "buyer-1");
    const row = store.db.buyer_magic_link[0];
    expect(row.token_hash).not.toBe(raw);
    expect(row.token_hash).toHaveLength(64); // sha256 hex
    const ttl = new Date(row.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("consumeMagicLink", () => {
  it("is single-use: succeeds once then rejects the same token", async () => {
    const { raw } = await createMagicLink("shop-1", "buyer-1");
    expect(await consumeMagicLink("shop-1", raw)).toEqual({ buyerId: "buyer-1" });
    expect(await consumeMagicLink("shop-1", raw)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { raw } = await createMagicLink("shop-1", "buyer-1");
    store.db.buyer_magic_link[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await consumeMagicLink("shop-1", raw)).toBeNull();
  });

  it("does not consume a token issued for another shop", async () => {
    const { raw } = await createMagicLink("shop-1", "buyer-1");
    expect(await consumeMagicLink("shop-2", raw)).toBeNull();
    // still consumable in the correct shop (the wrong-shop attempt did not claim it)
    expect(await consumeMagicLink("shop-1", raw)).toEqual({ buyerId: "buyer-1" });
  });
});

describe("requestBuyerMagicLink (non-enumerable signup+login)", () => {
  it("upserts the buyer and emails a verify link that consumes to that buyer", async () => {
    await requestBuyerMagicLink("shop-1", "Casey@Shop.com", "https://store.example.com");
    expect(store.db.buyer_dim).toHaveLength(1);
    expect(store.db.buyer_dim[0].email_normalized).toBe("casey@shop.com");
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe("casey@shop.com");
    expect(sends[0].text).toContain("/storefront/account/login/verify?t=");
    const raw = tokenFromLastSend();
    expect(await consumeMagicLink("shop-1", raw)).toEqual({ buyerId: store.db.buyer_dim[0].id });
  });

  it("behaves identically for a brand-new vs an already-registered email (no enumeration)", async () => {
    // First request creates the buyer.
    await requestBuyerMagicLink("shop-1", "known@shop.com", "https://store.example.com");
    const afterFirst = { buyers: store.db.buyer_dim.length, sends: sends.length };
    // Second request for the SAME email: still one buyer (idempotent upsert), still a send.
    await requestBuyerMagicLink("shop-1", "known@shop.com", "https://store.example.com");
    expect(store.db.buyer_dim).toHaveLength(afterFirst.buyers); // no duplicate buyer
    expect(sends).toHaveLength(afterFirst.sends + 1); // same observable "a link was sent"
  });
});
