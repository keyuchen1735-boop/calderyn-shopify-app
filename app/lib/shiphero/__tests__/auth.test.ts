import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshShipHeroToken } from "../auth.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SHIPHERO_API_BASE;
});

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("refreshShipHeroToken", () => {
  it("POSTs the refresh token to /auth/refresh and maps access_token + expires_in", async () => {
    const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ access_token: "acc_fresh", expires_in: 2419200 }),
    );
    const out = await refreshShipHeroToken("ref_long_lived", mockFetch as unknown as typeof fetch);
    expect(out).toEqual({ accessToken: "acc_fresh", expiresIn: 2419200 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://public-api.shiphero.com/auth/refresh");
    expect(init!.method).toBe("POST");
    // The refresh token travels in the JSON body, never a header/query (no leak path).
    expect(JSON.parse(String(init!.body))).toEqual({ refresh_token: "ref_long_lived" });
  });

  it("maps a missing expires_in to null (token still usable)", async () => {
    const mockFetch = vi.fn(async () => okResponse({ access_token: "acc_only" }));
    const out = await refreshShipHeroToken("r", mockFetch as unknown as typeof fetch);
    expect(out).toEqual({ accessToken: "acc_only", expiresIn: null });
  });

  it("derives /auth/refresh from a SHIPHERO_API_BASE that points at the GraphQL endpoint", async () => {
    // SHIPHERO_API_BASE conventionally points at ".../graphql" (the cost adapter's base);
    // /auth/refresh lives at the API root, so the trailing /graphql segment is stripped.
    process.env.SHIPHERO_API_BASE = "https://public-api.shiphero.com/graphql";
    const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ access_token: "a" }),
    );
    await refreshShipHeroToken("r", mockFetch as unknown as typeof fetch);
    expect(mockFetch.mock.calls[0][0]).toBe("https://public-api.shiphero.com/auth/refresh");
  });

  it("throws with status + snippet on a non-2xx (expired/invalid refresh token)", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "invalid refresh token",
    } as Response));
    await expect(
      refreshShipHeroToken("bad", mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/ShipHero token refresh 401 Unauthorized: invalid refresh token/);
  });

  it("throws when the body carries no access_token (2xx but malformed)", async () => {
    const mockFetch = vi.fn(async () => okResponse({ error_description: "scope missing" }));
    await expect(
      refreshShipHeroToken("r", mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/ShipHero token refresh returned no access_token: scope missing/);
  });

  it("never includes the refresh token in the thrown error message (no leak)", async () => {
    const secret = "ref_SUPER_SECRET_value";
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    } as Response));
    let message = "";
    try {
      await refreshShipHeroToken(secret, mockFetch as unknown as typeof fetch);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBeTruthy(); // it DID throw
    expect(message).not.toContain(secret);
  });
});
