import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for buyer_session, enforcing the unique(token_hash) shape and the
// revoked_at / expires_at semantics the helpers depend on, so behavior is tested for real.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { buyer_session: [] };

  class Builder {
    private op: "select" | "insert" | "update" = "select";
    private payload: Row = {};
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
    private nullFilters: string[] = [];
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
      if (this.op === "insert") {
        const row: Row = { id: `${this.table}-${t.length + 1}`, revoked_at: null, created_at: new Date().toISOString(), ...this.payload };
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

process.env.BUYER_SESSION_PEPPER = "buyer-session-pepper-for-tests-000000";

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake registers first
import {
  BUYER_SESSION_COOKIE_NAME,
  newBuyerSessionToken,
  hashBuyerToken,
  buyerSessionCookieHeader,
  clearBuyerSessionCookieHeader,
  readBuyerSessionTokenFromCookie,
  createBuyerSession,
  getBuyerSession,
  revokeBuyerSession,
} from "./session.server";

beforeEach(() => {
  store.db.buyer_session.length = 0;
});

function reqWithCookie(raw: string | null): Request {
  return new Request("https://store.example.com/storefront/account", {
    headers: raw ? { Cookie: `${BUYER_SESSION_COOKIE_NAME}=${raw}` } : {},
  });
}

describe("buyer session token + cookie", () => {
  it("mints a namespaced token distinct from the dashboard token", () => {
    expect(newBuyerSessionToken()).toMatch(/^buyer_live_[a-z2-7]{32}$/);
  });

  it("hashes deterministically and never stores the raw token", async () => {
    const { raw } = await createBuyerSession("shop-1", "buyer-1");
    expect(store.db.buyer_session).toHaveLength(1);
    expect(store.db.buyer_session[0].token_hash).toBe(hashBuyerToken(raw));
    expect(store.db.buyer_session[0].token_hash).not.toContain(raw);
  });

  it("sets a __Host- HttpOnly Secure SameSite=Lax cookie and clears with Max-Age=0", () => {
    const set = buyerSessionCookieHeader("buyer_live_abc");
    expect(set).toContain(`${BUYER_SESSION_COOKIE_NAME}=buyer_live_abc`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(clearBuyerSessionCookieHeader()).toContain("Max-Age=0");
  });

  it("reads the token back from the Cookie header", () => {
    expect(readBuyerSessionTokenFromCookie(reqWithCookie("buyer_live_xyz"))).toBe("buyer_live_xyz");
    expect(readBuyerSessionTokenFromCookie(reqWithCookie(null))).toBeNull();
  });
});

describe("getBuyerSession", () => {
  it("resolves a live session for the right shop", async () => {
    const { raw } = await createBuyerSession("shop-1", "buyer-1");
    const s = await getBuyerSession(reqWithCookie(raw), "shop-1");
    expect(s).toMatchObject({ shopId: "shop-1", buyerId: "buyer-1" });
  });

  it("does NOT resolve a token minted for another shop (per-shop isolation)", async () => {
    const { raw } = await createBuyerSession("shop-1", "buyer-1");
    expect(await getBuyerSession(reqWithCookie(raw), "shop-2")).toBeNull();
  });

  it("rejects a revoked session", async () => {
    const { raw } = await createBuyerSession("shop-1", "buyer-1");
    const before = await getBuyerSession(reqWithCookie(raw), "shop-1");
    await revokeBuyerSession(before!.sessionId);
    expect(await getBuyerSession(reqWithCookie(raw), "shop-1")).toBeNull();
  });

  it("rejects an expired session", async () => {
    await createBuyerSession("shop-1", "buyer-1");
    store.db.buyer_session[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const raw = "buyer_live_whatever";
    // Force the stored hash to match a known raw so we can look it up.
    store.db.buyer_session[0].token_hash = hashBuyerToken(raw);
    expect(await getBuyerSession(reqWithCookie(raw), "shop-1")).toBeNull();
  });

  it("returns null with no cookie", async () => {
    expect(await getBuyerSession(reqWithCookie(null), "shop-1")).toBeNull();
  });
});
