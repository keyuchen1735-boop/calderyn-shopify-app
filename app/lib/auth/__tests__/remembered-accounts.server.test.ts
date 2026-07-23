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
  it("resolves live sessions to one-click accounts, no rewrite when unchanged", async () => {
    const a = tok("a");
    setSupabaseResponse({
      data: [row({ raw: a, user_id: "u1", email: "a@b.co", display_name: "Peak & Pine", domain: "peak.example" })],
      error: null,
    });
    const { accounts, cookieHeader } = await resolveRememberedAccounts(req(cookieOf([a])));
    expect(accounts).toEqual([
      { sid: sidForToken(a), email: "a@b.co", storeName: "Peak & Pine", storeDomain: "peak.example", live: true },
    ]);
    expect(cookieHeader).toBeNull();
  });

  it("keeps signed-out sessions listed as live:false — Shopify-picker style", async () => {
    const revoked = tok("c");
    const expired = tok("d");
    setSupabaseResponse({
      data: [
        row({ raw: revoked, user_id: "u2", email: "c@d.co", display_name: "Store C", revoked: true }),
        row({ raw: expired, user_id: "u3", email: "e@f.co", display_name: "Store E", expired: true }),
      ],
      error: null,
    });
    const { accounts, cookieHeader } = await resolveRememberedAccounts(req(cookieOf([revoked, expired])));
    expect(accounts.map((a) => [a.sid, a.live])).toEqual([
      [sidForToken(revoked), false],
      [sidForToken(expired), false],
    ]);
    expect(cookieHeader).toBeNull();
  });

  it("dedupes per identity preferring a live token, prunes rowless tokens", async () => {
    const deadNewest = tok("a"); // same user's just-signed-out token
    const liveOlder = tok("b"); // same user, earlier sign-in, still live
    const gone = tok("c"); // row deleted entirely
    setSupabaseResponse({
      data: [
        row({ raw: deadNewest, user_id: "u1", email: "a@b.co", revoked: true }),
        row({ raw: liveOlder, user_id: "u1", email: "a@b.co" }),
      ],
      error: null,
    });
    const { accounts, cookieHeader } = await resolveRememberedAccounts(
      req(cookieOf([deadNewest, liveOlder, gone])),
    );
    expect(accounts.map((a) => [a.sid, a.live])).toEqual([[sidForToken(liveOlder), true]]);
    expect(cookieHeader).toContain(`${ACCOUNTS_COOKIE_NAME}=${liveOlder};`);
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
      live: true,
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

  it("returns the email without pruning when the selection is signed out", async () => {
    const a = tok("a");
    const b = tok("b");
    setSupabaseResponse({ data: [row({ raw: a, user_id: "u1", email: "a@b.co", revoked: true })], error: null });
    const result = await activateRememberedAccount(req(cookieOf([a, b])), sidForToken(a));
    expect(result).toEqual({ ok: false, email: "a@b.co", cookieHeader: null });
  });

  it("prunes an entry whose session row vanished entirely", async () => {
    const a = tok("a");
    const b = tok("b");
    setSupabaseResponse({ data: [], error: null });
    const result = await activateRememberedAccount(req(cookieOf([a, b])), sidForToken(a));
    expect(result && !result.ok && result.email).toBeNull();
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
  it("keeps the signed-out account listed but drops its older duplicate tokens", async () => {
    const active = tok("a");
    const sameUserOlder = tok("b"); // still-live earlier sign-in of the same user
    const other = tok("c");
    setSupabaseResponse({
      data: [
        row({ raw: active, user_id: "u1", email: "a@b.co", revoked: true }),
        row({ raw: sameUserOlder, user_id: "u1", email: "a@b.co" }),
        row({ raw: other, user_id: "u2", email: "c@d.co" }),
      ],
      error: null,
    });
    const header = await rememberOnSignOut(req(cookieOf([active, sameUserOlder, other])), active, true);
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${active}|${other};`);
  });

  it("keeps a sole signed-out account in the cookie (still listed, password required)", async () => {
    const active = tok("a");
    setSupabaseResponse({ data: [row({ raw: active, user_id: "u1", email: "a@b.co", revoked: true })], error: null });
    const header = await rememberOnSignOut(req(cookieOf([active])), active, true);
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${active};`);
    expect(header).not.toContain("Max-Age=0");
  });

  it("drops the signed-out token when the revoke failed — no one-click re-entry", async () => {
    const active = tok("a");
    const other = tok("c");
    // revoked=false means the session row is still LIVE server-side. If the
    // token were kept, the /login chooser would resolve it to a one-click
    // entry and switch-account would re-mint a session with no password.
    const header = await rememberOnSignOut(req(cookieOf([active, other])), active, false);
    expect(header).toContain(`${ACCOUNTS_COOKIE_NAME}=${other};`);
    expect(header).not.toContain(active);
  });

  it("clears the cookie when the sole account's revoke failed", async () => {
    const active = tok("a");
    const header = await rememberOnSignOut(req(cookieOf([active])), active, false);
    expect(header).not.toContain(active);
    expect(header).toContain("Max-Age=0");
  });
});
