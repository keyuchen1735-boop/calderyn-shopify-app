import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponses,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";

import {
  newSessionToken,
  hashSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readSessionTokenFromCookie,
  createSession,
  getSessionFromRequest,
  requireDashboardSession,
  revokeAllSessionsForShop,
  SESSION_COOKIE_NAME,
} from "../session.server";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(async (domain: string) => `shop-id-for-${domain}`),
}));

const resurfaceAllSnoozes = vi.fn();
vi.mock("../../actions/snooze.server", () => ({
  resurfaceAllSnoozes: (...a: unknown[]) => resurfaceAllSnoozes(...a),
}));

beforeEach(() => {
  process.env.DASHBOARD_SESSION_PEPPER = "test-pepper-that-is-at-least-32-chars!!";
});

describe("token mint + hash", () => {
  it("mints dash_live_ tokens with 32-char base32 bodies, unique per call", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toMatch(/^dash_live_[a-z2-7]{32}$/);
    expect(a).not.toEqual(b);
  });

  it("hashes deterministically with the pepper and changes when pepper changes", () => {
    const t = newSessionToken();
    const h1 = hashSessionToken(t);
    expect(h1).toEqual(hashSessionToken(t));
    process.env.DASHBOARD_SESSION_PEPPER = "another-pepper-that-is-32-chars-long!!!";
    expect(hashSessionToken(t)).not.toEqual(h1);
  });

  it("throws when the pepper is missing or short", () => {
    process.env.DASHBOARD_SESSION_PEPPER = "short";
    expect(() => hashSessionToken("dash_live_x")).toThrow();
  });
});

describe("cookie round-trip", () => {
  it("serializes a __Host- cookie and reads it back from a Request", () => {
    const raw = newSessionToken();
    const header = sessionCookieHeader(raw);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=${raw}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");

    const req = new Request("https://calderyncompany.com/dashboard/api/me", {
      headers: { Cookie: `foo=bar; ${SESSION_COOKIE_NAME}=${raw}; baz=qux` },
    });
    expect(readSessionTokenFromCookie(req)).toEqual(raw);
  });

  it("returns null when the cookie is absent", () => {
    const req = new Request("https://calderyncompany.com/dashboard/api/me");
    expect(readSessionTokenFromCookie(req)).toBeNull();
  });

  it("clear header expires the cookie", () => {
    expect(clearSessionCookieHeader()).toContain("Max-Age=0");
  });
});

describe("createSession", () => {
  it("inserts a hashed row and returns the raw token once", async () => {
    setSupabaseResponses([{ data: { id: "sess-1" }, error: null }]);
    const { raw } = await createSession("x.myshopify.com");
    expect(raw).toMatch(/^dash_live_/);
    const inserts = getRecorded("insert");
    expect(inserts.length).toBe(1);
    const row = inserts[0][0] as Record<string, unknown>;
    expect(row.shop_domain).toBe("x.myshopify.com");
    expect(row.token_hash).toEqual(hashSessionToken(raw));
    expect(row.token_hash).not.toContain(raw.slice(10)); // raw never stored
  });

  it("re-surfaces the shop's snoozed alerts on a fresh login", async () => {
    setSupabaseResponses([{ data: { id: "sess-1" }, error: null }]);
    await createSession("x.myshopify.com");
    // "next login" trigger: snoozes don't survive a login boundary.
    expect(resurfaceAllSnoozes).toHaveBeenCalledWith(
      expect.anything(),
      "shop-id-for-x.myshopify.com",
    );
  });
});

describe("getSessionFromRequest / requireDashboardSession", () => {
  function reqWithToken(raw: string) {
    return new Request("https://calderyncompany.com/dashboard/api/me", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${raw}` },
    });
  }

  it("returns the shop for a live session and bumps last_seen_at", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "sess-1",
          shop_id: "shop-1",
          shop_domain: "x.myshopify.com",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          revoked_at: null,
        },
        error: null,
      },
      { data: null, error: null }, // last_seen_at update
    ]);
    const s = await getSessionFromRequest(reqWithToken(newSessionToken()));
    expect(s).toEqual({ shopId: "shop-1", shopDomain: "x.myshopify.com", sessionId: "sess-1" });
  });

  it("returns null for expired sessions", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "sess-1",
          shop_id: "shop-1",
          shop_domain: "x.myshopify.com",
          expires_at: new Date(Date.now() - 1000).toISOString(),
          revoked_at: null,
        },
        error: null,
      },
    ]);
    expect(await getSessionFromRequest(reqWithToken(newSessionToken()))).toBeNull();
  });

  it("returns null for revoked sessions and missing cookies", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "sess-1",
          shop_id: "shop-1",
          shop_domain: "x.myshopify.com",
          expires_at: new Date(Date.now() + 1000).toISOString(),
          revoked_at: new Date().toISOString(),
        },
        error: null,
      },
    ]);
    expect(await getSessionFromRequest(reqWithToken(newSessionToken()))).toBeNull();
    expect(
      await getSessionFromRequest(new Request("https://calderyncompany.com/x")),
    ).toBeNull();
  });

  it("requireDashboardSession throws a 401 JSON Response when unauthenticated", async () => {
    const req = new Request("https://calderyncompany.com/dashboard/api/me");
    try {
      await requireDashboardSession(req);
      expect.unreachable("should have thrown");
    } catch (e) {
      const res = e as Response;
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
  });
});

describe("revokeAllSessionsForShop", () => {
  it("marks every live session for the shop revoked", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    await revokeAllSessionsForShop("x.myshopify.com");
    const updates = getRecorded("update");
    expect(updates.length).toBe(1);
    expect((updates[0][0] as Record<string, unknown>).revoked_at).toBeTruthy();
    const eqs = getRecorded("eq").flat();
    expect(eqs).toContain("x.myshopify.com");
  });
});
