// app/lib/__tests__/mcp_oauth_tokens.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponse,
  setSupabaseResponses,
  getRecorded,
  resetRecorded,
} from "./_supabase_chain_mock";

vi.mock("../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn().mockResolvedValue("shopuuid"),
}));

process.env.MCP_TOKEN_PEPPER = "x".repeat(64);

import { mintAccessToken } from "../mcp_tokens.server";
import { resolveShopId } from "../supabase.server";

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
