import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { qboApiBase, quickbooksClientForShop } from "../client.server";
import { encrypt, decrypt } from "../../crypto.server";

// 32-byte key as 64 hex chars, required by crypto.server.
process.env.INTEGRATION_ENCRYPTION_KEY = "11".repeat(32);
process.env.QBO_CLIENT_ID = "cid";
process.env.QBO_CLIENT_SECRET = "sec";
process.env.QBO_ENV = "sandbox";

describe("qboApiBase", () => {
  it("selects production vs sandbox base", () => {
    expect(qboApiBase("production")).toBe("https://quickbooks.api.intuit.com");
    expect(qboApiBase("sandbox")).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(qboApiBase(undefined)).toBe("https://sandbox-quickbooks.api.intuit.com");
  });
});

// Minimal Supabase fake: records the update() patch and returns one credential row.
function fakeSb(credRow: Record<string, unknown> | null) {
  const updatePatch: { value: Record<string, unknown> | null } = { value: null };
  const credChain = {
    select: vi.fn(() => credChain),
    eq: vi.fn(() => credChain),
    maybeSingle: vi.fn(async () => ({ data: credRow, error: null })),
    update: vi.fn((patch: Record<string, unknown>) => {
      updatePatch.value = patch;
      return { eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) };
    }),
  };
  const sb = { from: vi.fn(() => credChain) } as unknown as SupabaseClient;
  return { sb, updatePatch };
}

describe("quickbooksClientForShop", () => {
  it("returns null when there is no credential row", async () => {
    const { sb } = fakeSb(null);
    expect(await quickbooksClientForShop("s1", { sb })).toBeNull();
  });

  it("refreshes, persists the ROTATED refresh token, and exposes a working queryItems", async () => {
    const { sb, updatePatch } = fakeSb({
      access_token_encrypted: encrypt("ref1"),
      external_account_id: "realm-9",
    });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const httpFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ QueryResponse: { Item: [{ Id: "1", Sku: "MUG", PurchaseCost: 8 }] } }),
    });

    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    expect(conn).not.toBeNull();
    expect(conn!.realmId).toBe("realm-9");

    // Rotated refresh token persisted (encrypted).
    expect(updatePatch.value).not.toBeNull();
    expect(decrypt(updatePatch.value!.access_token_encrypted as string)).toBe("ref2");

    const items = await conn!.client.queryItems();
    expect(items).toEqual({ QueryResponse: { Item: [{ Id: "1", Sku: "MUG", PurchaseCost: 8 }] } });
    const calledUrl = httpFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v3/company/realm-9/query");
    expect((httpFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer acc");
  });

  it("paginates: keeps fetching while a full page (1000) returns, then stops", async () => {
    const { sb } = fakeSb({ access_token_encrypted: encrypt("ref1"), external_account_id: "realm-9" });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i), Sku: `S${i}`, PurchaseCost: 1 }));
    const lastPage = [{ Id: "x", Sku: "LAST", PurchaseCost: 2 }];
    const httpFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ QueryResponse: { Item: fullPage } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ QueryResponse: { Item: lastPage } }) });

    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    const result = (await conn!.client.queryItems()) as { QueryResponse: { Item: unknown[] } };

    expect(result.QueryResponse.Item).toHaveLength(1001); // 1000 + 1, aggregated across pages
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(httpFetch.mock.calls[0][0] as string).toContain("STARTPOSITION%201%20"); // page 1
    expect(httpFetch.mock.calls[1][0] as string).toContain("STARTPOSITION%201001%20"); // page 2
  });

  it("queryHomeCurrency reads the company home currency from Preferences", async () => {
    const { sb } = fakeSb({ access_token_encrypted: encrypt("ref1"), external_account_id: "realm-9" });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const httpFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" } } }] } }),
    });
    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    expect(await conn!.client.queryHomeCurrency()).toBe("USD");
    expect(httpFetch.mock.calls[0][0] as string).toContain("Preferences");
  });

  it("queryHomeCurrency returns null when the currency can't be determined", async () => {
    const { sb } = fakeSb({ access_token_encrypted: encrypt("ref1"), external_account_id: "realm-9" });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const httpFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ QueryResponse: {} }) });
    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    expect(await conn!.client.queryHomeCurrency()).toBeNull();
  });

  it("throws when the QBO query returns a non-ok status", async () => {
    const { sb } = fakeSb({ access_token_encrypted: encrypt("ref1"), external_account_id: "realm-9" });
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const httpFetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ Fault: { Error: [{ Message: "AuthenticationFailed" }] } }),
    });
    const conn = await quickbooksClientForShop("s1", { sb, fetcher, httpFetch: httpFetch as unknown as typeof fetch });
    await expect(conn!.client.queryItems()).rejects.toThrow(/AuthenticationFailed/);
  });
});
