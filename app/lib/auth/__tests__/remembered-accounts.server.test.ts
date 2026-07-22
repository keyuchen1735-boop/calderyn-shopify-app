import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponse,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";

import {
  ACCOUNTS_COOKIE_NAME,
  readRememberedTokens,
  rememberedAccountsCookieHeader,
  rememberOnSignIn,
  rememberOnSignOut,
  resolveRememberedAccounts,
  activateRememberedAccount,
  forgetRememberedAccount,
  sidForToken,
} from "../remembered-accounts.server";
import { hashSessionToken } from "../../dashboard/session.server";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(),
}));
vi.mock("../../actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn() }));

beforeEach(() => {
  process.env.DASHBOARD_SESSION_PEPPER = "test-pepper-that-is-at-least-32-chars!!";
});

// A well-formed token whose 32-char body repeats `c` (base32 alphabet only).
const tok = (c: string) => `dash_live_${c.repeat(32)}`;

function req(cookie?: string): Request {
  return new Request("https://app.calderyncompany.com/login", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function cookieOf(tokens: string[]): string {
  return `${ACCOUNTS_COOKIE_NAME}=${tokens.join("|")}`;
}

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

type RowInit = {
  raw: string;
  user_id?: string | null;
  shop_id?: string;
  revoked?: boolean;
  expired?: boolean;
  email?: string | null;
  display_name?: string | null;
  domain?: string | null;
};
function row(init: RowInit) {
  return {
    token_hash: hashSessionToken(init.raw),
    user_id: init.user_id ?? null,
    shop_id: init.shop_id ?? "shop-1",
    shop_domain: init.domain ?? null,
    expires_at: init.expired ? past : future,
    revoked_at: init.revoked ? past : null,
    user: init.email === undefined ? null : { email: init.email },
    shop: { display_name: init.display_name ?? null, shop_domain: init.domain ?? null },
  };
}

describe("cookie parsing", () => {
  it("reads |-separated tokens and drops junk that is not a session token", () => {
    const good = tok("a");
    const cookie = cookieOf([good, "garbage", "dash_live_SHORT", tok("b")]);
    expect(readRememberedTokens(req(cookie))).toEqual([good, tok("b")]);
  });

  it("returns [] with no cookie and caps the stored list", () => {
    expect(readRememberedTokens(req())).toEqual([]);
    const many = "abcdefghij".split("").map(tok); // 10 valid tokens
    expect(readRememberedTokens(req(cookieOf(many)))).toHaveLength(8);
  });

  it("serializes a __Host- HttpOnly cookie and expires it when empty", () => {
    const header = rememberedAccountsCookieHeader([tok("a")]);
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${tok("a")}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(rememberedAccountsCookieHeader([])).toContain("Max-Age=0");
  });
});

describe("rememberOnSignIn", () => {
  it("prepends the fresh token and drops an exact duplicate", () => {
    const header = rememberOnSignIn(req(cookieOf([tok("b"), tok("a")])), tok("a"));
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${tok("a")}|${tok("b")}`);
  });
});

describe("resolveRememberedAccounts", () => {
  it("resolves live sessions to accounts and reports no rewrite when unchanged", async () => {
    const a = tok("a");
    setSupabaseResponse({
      data: [row({ raw: a, user_id: "u1", email: "a@b.co", display_name: "Peak & Pine", domain: "peak.example" })],
      error: null,
    });
    const { accounts, cookieHeader } = await resolveRememberedAccounts(req(cookieOf([a])));
    expect(accounts).toEqual([
      { sid: sidForToken(a), email: "a@b.co", storeName: "Peak & Pine", storeDomain: "peak.example" },
    ]);
    expect(cookieHeader).toBeNull();
  });

  it("prunes dead sessions and duplicate identities, rewriting the cookie", async () => {
    const fresh = tok("a");
    const stale = tok("b"); // same user as fresh — earlier sign-in
    const revoked = tok("c");
    const expired = tok("d");
    setSupabaseResponse({
      data: [
        row({ raw: fresh, user_id: "u1", email: "a@b.co", display_name: "Store A" }),
        row({ raw: stale, user_id: "u1", email: "a@b.co", display_name: "Store A" }),
        row({ raw: revoked, user_id: "u2", email: "c@d.co", revoked: true }),
        row({ raw: expired, user_id: "u3", email: "e@f.co", expired: true }),
      ],
      error: null,
    });
    const { accounts, cookieHeader } = await resolveRememberedAccounts(
      req(cookieOf([fresh, stale, revoked, expired])),
    );
    expect(accounts.map((a) => a.sid)).toEqual([sidForToken(fresh)]);
    expect(cookieHeader).toContain(`${ACCOUNTS_COOKIE_NAME}=${fresh};`);
  });

  it("keeps distinct accounts and falls back to the shop domain as the name", async () => {
    const a = tok("a");
    const b = tok("b");
    setSupabaseResponse({
      data: [
        row({ raw: a, user_id: "u1", email: "a@b.co", display_name: "Store A" }),
        row({ raw: b, shop_id: "shop-2", domain: "acme.myshopify.com" }), // shop-only session
      ],
      error: null,
    });
    const { accounts } = await resolveRememberedAccounts(req(cookieOf([a, b])));
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toEqual({
      sid: sidForToken(b),
      email: null,
      storeName: "acme.myshopify.com",
      storeDomain: "acme.myshopify.com",
    });
  });
});

describe("activateRememberedAccount", () => {
  it("returns the raw token for a live selection", async () => {
    const a = tok("a");
    setSupabaseResponse({ data: [row({ raw: a, user_id: "u1", email: "a@b.co" })], error: null });
    const result = await activateRememberedAccount(req(cookieOf([a])), sidForToken(a));
    expect(result).toEqual({ ok: true, raw: a, cookieHeader: null });
  });

  it("returns the email + a prune header when the selection died", async () => {
    const a = tok("a");
    const b = tok("b");
    setSupabaseResponse({ data: [row({ raw: a, user_id: "u1", email: "a@b.co", revoked: true })], error: null });
    const result = await activateRememberedAccount(req(cookieOf([a, b])), sidForToken(a));
    expect(result && !result.ok && result.email).toBe("a@b.co");
    expect(result && !result.ok && result.cookieHeader).toContain(`${ACCOUNTS_COOKIE_NAME}=${b};`);
  });

  it("returns null for a sid not in the cookie — the form can never inject a token", async () => {
    const result = await activateRememberedAccount(req(cookieOf([tok("a")])), sidForToken(tok("z")));
    expect(result).toBeNull();
  });
});

describe("forgetRememberedAccount", () => {
  it("revokes the session server-side and rewrites the cookie without it", async () => {
    const a = tok("a");
    const b = tok("b");
    setSupabaseResponse({ data: null, error: null });
    const header = await forgetRememberedAccount(req(cookieOf([a, b])), sidForToken(a));
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${b};`);
    // The revoke targeted exactly the forgotten token's hash.
    expect(getRecorded("update").length).toBeGreaterThan(0);
    expect(getRecorded("eq").some(([col, val]) => col === "token_hash" && val === hashSessionToken(a))).toBe(true);
  });

  it("is a no-op for an unknown sid", async () => {
    expect(await forgetRememberedAccount(req(cookieOf([tok("a")])), sidForToken(tok("z")))).toBeNull();
  });
});

describe("rememberOnSignOut", () => {
  it("drops every token of the signed-out identity, keeping other accounts", async () => {
    const active = tok("a");
    const sameUserOlder = tok("b");
    const other = tok("c");
    setSupabaseResponse({
      data: [
        row({ raw: active, user_id: "u1", email: "a@b.co", revoked: true }),
        row({ raw: sameUserOlder, user_id: "u1", email: "a@b.co" }),
        row({ raw: other, user_id: "u2", email: "c@d.co" }),
      ],
      error: null,
    });
    const header = await rememberOnSignOut(req(cookieOf([active, sameUserOlder, other])), active);
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${other};`);
  });

  it("expires the cookie when the signed-out account was the only one", async () => {
    const active = tok("a");
    const header = await rememberOnSignOut(req(cookieOf([active])), active);
    expect(header).toContain("Max-Age=0");
  });
});
