// app/lib/__tests__/mcp_oauth_tokens.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponse,
  setSupabaseResponses,
  getRecorded,
  resetRecorded,
} from "./_supabase_chain_mock";

import { mintAccessToken, rotateRefreshToken, listOauthGrants, revokeOauthGrant } from "../mcp_tokens.server";

vi.mock("../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn().mockResolvedValue("shopuuid"),
}));

process.env.MCP_TOKEN_PEPPER = "x".repeat(64);

beforeEach(resetRecorded);

// ---------------------------------------------------------------------------
// 4.1 mintAccessToken
// ---------------------------------------------------------------------------

describe("mintAccessToken", () => {
  it("returns raw access + refresh tokens and inserts a row with auth_type='oauth'", async () => {
    setSupabaseResponse({
      data: {
        id: "tokenrow-uuid",
        shop_id: "shopuuid",
        name: "Claude (workspace abc)",
        token_prefix: "cala_xxxx",
        scopes: ["read"],
        created_at: new Date().toISOString(),
      },
      error: null,
    });

    const out = await mintAccessToken({
      client_id: "cal_client_x",
      client_name: "Claude",
      shop_id: "shopuuid",
      scopes: ["read"],
    });

    expect(out.access_token).toMatch(/^cala_[a-z2-7]{32}$/);
    expect(out.refresh_token).toMatch(/^calr_[a-z2-7]{32}$/);
    expect(out.expires_in).toBe(60 * 60 * 24 * 90);
    expect(out.token_type).toBe("Bearer");
    expect(out.scope).toBe("read");

    const inserts = getRecorded("insert");
    expect(inserts.length).toBe(1);
    const row = inserts[0][0] as Record<string, unknown>;
    expect(row.auth_type).toBe("oauth");
    expect(row.client_id).toBe("cal_client_x");
    expect(row.scopes).toEqual(["read"]);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 89 * 86400 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 4.2 rotateRefreshToken
// ---------------------------------------------------------------------------

describe("rotateRefreshToken", () => {
  it("returns a new pair and replaces hashes on the same row", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "tokenuuid",
          shop_id: "shopuuid",
          client_id: "cal_client_x",
          scopes: ["read"],
          revoked_at: null,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        error: null,
      },
      { data: [{ id: "tokenuuid" }], error: null }, // atomic update succeeds (1 row)
    ]);
    const out = await rotateRefreshToken({ refresh_token: "calr_xxx", client_id: "cal_client_x" });
    expect(out.access_token).toMatch(/^cala_/);
    expect(out.refresh_token).toMatch(/^calr_/);
    expect(out.access_token).not.toBe("calr_xxx");
    expect(out.token_type).toBe("Bearer");
  });

  it("rejects unknown refresh_token", async () => {
    setSupabaseResponse({ data: null, error: null });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when client_id doesn't match", async () => {
    setSupabaseResponse({
      data: { id: "x", shop_id: "s", client_id: "other", scopes: [], revoked_at: null, expires_at: null },
      error: null,
    });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("rejects revoked token", async () => {
    setSupabaseResponse({
      data: { id: "x", shop_id: "s", client_id: "c", scopes: [], revoked_at: new Date().toISOString() },
      error: null,
    });
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when atomic update returns zero rows (concurrent rotation)", async () => {
    setSupabaseResponses([
      { data: { id: "x", shop_id: "s", client_id: "c", scopes: ["read"], revoked_at: null }, error: null },
      { data: [], error: null }, // race lost
    ]);
    await expect(rotateRefreshToken({ refresh_token: "x", client_id: "c" })).rejects.toThrow(/invalid_grant/);
  });

  it("detects refresh-token reuse: revokes the still-active grant and rejects", async () => {
    setSupabaseResponses([
      { data: null, error: null }, // main lookup: token matches no CURRENT grant
      { data: { id: "reusedrow", revoked_at: null }, error: null }, // ...but matches a grant's prev_refresh_hash → replay
      { data: null, error: null }, // the revoke update (then-able)
    ]);
    await expect(
      rotateRefreshToken({ refresh_token: "calr_consumed", client_id: "cal_client_x" }),
    ).rejects.toThrow(/reuse detected/);

    // The grant was revoked: an update setting revoked_at + null refresh_hash on the reused row.
    const updates = getRecorded("update");
    expect(updates.length).toBe(1);
    const patch = updates[0][0] as Record<string, unknown>;
    expect(patch.revoked_at).toBeTypeOf("string");
    expect(patch.refresh_hash).toBeNull();
    const eqCalls = getRecorded("eq");
    expect(eqCalls.some((c) => c[0] === "prev_refresh_hash")).toBe(true);
    expect(eqCalls.some((c) => c[0] === "id" && c[1] === "reusedrow")).toBe(true);
  });

  it("on reuse of an already-revoked grant, rejects without re-revoking", async () => {
    setSupabaseResponses([
      { data: null, error: null }, // no current grant
      { data: { id: "r", revoked_at: new Date().toISOString() }, error: null }, // prev match, already revoked
    ]);
    await expect(
      rotateRefreshToken({ refresh_token: "calr_consumed", client_id: "c" }),
    ).rejects.toThrow(/reuse detected/);
    expect(getRecorded("update").length).toBe(0); // no redundant revoke issued
  });
});

// ---------------------------------------------------------------------------
// 4.3 listOauthGrants + revokeOauthGrant
// ---------------------------------------------------------------------------

describe("listOauthGrants", () => {
  it("returns oauth rows for the shop", async () => {
    setSupabaseResponse({
      data: [
        {
          id: "g1",
          name: "Claude (workspace 1)",
          client_id: "cal_client_a",
          scopes: ["read"],
          created_at: "2026-06-08T00:00:00Z",
          last_used_at: null,
          expires_at: null,
        },
        {
          id: "g2",
          name: "Claude (workspace 2)",
          client_id: "cal_client_b",
          scopes: ["read"],
          created_at: "2026-06-07T00:00:00Z",
          last_used_at: "2026-06-08T01:00:00Z",
          expires_at: null,
        },
      ],
      error: null,
    });
    const out = await listOauthGrants("myshop.myshopify.com");
    expect(out.length).toBe(2);
    expect(out[0].id).toBe("g1");
    // Verify filter calls happened on the right columns
    const eqCalls = getRecorded("eq");
    expect(eqCalls.some((c) => c[0] === "shop_id" && c[1] === "shopuuid")).toBe(true);
    expect(eqCalls.some((c) => c[0] === "auth_type" && c[1] === "oauth")).toBe(true);
  });

  it("returns empty when no grants", async () => {
    setSupabaseResponse({ data: [], error: null });
    const out = await listOauthGrants("myshop.myshopify.com");
    expect(out).toEqual([]);
  });
});

describe("revokeOauthGrant", () => {
  it("updates the row with revoked_at + null refresh_hash, scoped by shop + token + auth_type", async () => {
    setSupabaseResponse({ data: null, error: null });
    await revokeOauthGrant({ shopDomain: "myshop.myshopify.com", tokenId: "g1" });
    const updates = getRecorded("update");
    expect(updates.length).toBe(1);
    const patch = updates[0][0] as Record<string, unknown>;
    expect(patch.revoked_at).toBeTypeOf("string");
    expect(patch.refresh_hash).toBeNull();
    const eqCalls = getRecorded("eq");
    expect(eqCalls.some((c) => c[0] === "shop_id" && c[1] === "shopuuid")).toBe(true);
    expect(eqCalls.some((c) => c[0] === "id" && c[1] === "g1")).toBe(true);
    expect(eqCalls.some((c) => c[0] === "auth_type" && c[1] === "oauth")).toBe(true);
  });
});
