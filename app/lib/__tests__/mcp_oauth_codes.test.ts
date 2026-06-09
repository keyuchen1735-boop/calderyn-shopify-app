import { vi, describe, it, expect } from "vitest";
import { buildChain, setSupabaseResponse, setSupabaseResponses, getRecorded } from "./_supabase_chain_mock";

vi.mock("../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(),
}));

import { issueAuthCode, consumeAuthCode } from "../mcp_oauth.server";

describe("issueAuthCode", () => {
  it("returns a calc_-prefixed raw code and writes only the hash + metadata", async () => {
    setSupabaseResponse({ data: null, error: null });
    const raw = await issueAuthCode({
      client_id: "cal_client_x",
      shop_id: "00000000-0000-0000-0000-000000000001",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: "challenge",
      scopes: ["read"],
      state: "abcdefghijklmnop",
    });
    expect(raw).toMatch(/^calc_[a-z2-7]{32}$/);
    const inserts = getRecorded("insert");
    expect(inserts.length).toBe(1);
    const row = inserts[0][0] as Record<string, unknown>;
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof row.code_hash).toBe("string");
    expect(row.client_id).toBe("cal_client_x");
    expect(row.state_hint).toBe("ijklmnop");
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(row.expires_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe("consumeAuthCode", () => {
  const VALID_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const VALID_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  function setupValid(rowOverrides: Record<string, unknown> = {}): void {
    const row = {
      client_id: "cal_client_x",
      shop_id: "shopuuid",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: VALID_CHALLENGE,
      scopes: ["read"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
      ...rowOverrides,
    };
    setSupabaseResponse({ data: row, error: null });
  }

  it("returns the bound context on a fresh, valid code", async () => {
    setSupabaseResponses([
      {
        data: {
          client_id: "cal_client_x",
          shop_id: "shopuuid",
          redirect_uri: "https://claude.ai/cb",
          code_challenge: VALID_CHALLENGE,
          scopes: ["read"],
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          consumed_at: null,
        },
        error: null,
      },
      { data: [{ code_hash: "x" }], error: null },
    ]);
    const res = await consumeAuthCode({
      raw_code: "calc_zzz",
      code_verifier: VALID_VERIFIER,
      redirect_uri: "https://claude.ai/cb",
      client_id: "cal_client_x",
    });
    expect(res).toEqual({ shop_id: "shopuuid", scopes: ["read"] });
  });

  it("rejects when code not found", async () => {
    setSupabaseResponse({ data: null, error: null });
    await expect(
      consumeAuthCode({
        raw_code: "x",
        code_verifier: VALID_VERIFIER,
        redirect_uri: "u",
        client_id: "c",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects expired code", async () => {
    setupValid({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(
      consumeAuthCode({
        raw_code: "x",
        code_verifier: VALID_VERIFIER,
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_x",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects consumed code", async () => {
    setupValid({ consumed_at: new Date().toISOString() });
    await expect(
      consumeAuthCode({
        raw_code: "x",
        code_verifier: VALID_VERIFIER,
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_x",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects PKCE mismatch", async () => {
    setupValid({ code_challenge: "WRONG" });
    await expect(
      consumeAuthCode({
        raw_code: "x",
        code_verifier: VALID_VERIFIER,
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_x",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when redirect_uri doesn't match the issued one", async () => {
    setupValid();
    await expect(
      consumeAuthCode({
        raw_code: "x",
        code_verifier: VALID_VERIFIER,
        redirect_uri: "https://evil.example/cb",
        client_id: "cal_client_x",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects when client_id doesn't match the issued one", async () => {
    setupValid({ client_id: "other" });
    await expect(
      consumeAuthCode({
        raw_code: "x",
        code_verifier: VALID_VERIFIER,
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_x",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
