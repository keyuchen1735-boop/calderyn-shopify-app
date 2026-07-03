// app/lib/social/__tests__/linkedin-connection.test.ts
//
// TDD: tests written BEFORE implementation.
// Mocks: getSupabase, refreshAccessToken (from linkedin.server).
// All DB interactions are via the Supabase mock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decrypt } from "~/lib/crypto.server";
import {
  saveConnection,
  getValidConnection,
  getValidConnectionFor,
  signState,
  verifyState,
} from "../linkedin-connection.server";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before module evaluation, so the mock
// factories are in place before the imports above resolve.
// ---------------------------------------------------------------------------

const { getSupabase, refreshAccessToken } = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/social/linkedin.server", () => ({ refreshAccessToken }));

// Tokens are encrypted at rest (crypto.server, aes-256-gcm). A fixed 32-byte
// (64 hex char) key makes encrypt/decrypt deterministic enough to assert on.
beforeEach(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a DB row for linkedin_connection. expires_at is ISO string. */
function makeRow(overrides: Partial<{
  id: string;
  member_urn: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  refresh_expires_at: string | null;
  scope: string | null;
  connected_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: "row-uuid-1",
    member_urn: "urn:li:person:ABC123",
    access_token: "valid-access-token",
    refresh_token: null,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), // 1h in future
    refresh_expires_at: null,
    scope: "openid profile w_member_social",
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Wire getSupabase select chain to return one row (or null). */
function mockSelect(row: ReturnType<typeof makeRow> | null, error?: { message: string }) {
  getSupabase.mockReturnValue({
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            single: async () => ({ data: row, error: error ?? null }),
          }),
        }),
      }),
    }),
  });
}

// ---------------------------------------------------------------------------
// saveConnection
// ---------------------------------------------------------------------------

describe("saveConnection", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls upsert with access_token, expires_at derived from expiresInSec, scope, and updated_at", async () => {
    const upsertFn = vi.fn().mockReturnValue({
      select: async () => ({ error: null }),
    });
    getSupabase.mockReturnValue({
      from: () => ({ upsert: upsertFn }),
    });

    const before = Date.now();
    await saveConnection({
      tokens: {
        accessToken: "tok-abc",
        expiresInSec: 7200,
        scope: "openid profile w_member_social",
      },
      memberUrn: "urn:li:person:XYZ",
    });
    const after = Date.now();

    expect(upsertFn).toHaveBeenCalledTimes(1);
    const [payload, opts] = upsertFn.mock.calls[0] as [Record<string, unknown>, { onConflict: string }];

    // Confirm field values — access_token is encrypted at rest: it must NOT be
    // the plaintext, and must decrypt back to it.
    expect(payload.access_token).not.toBe("tok-abc");
    expect(decrypt(payload.access_token as string)).toBe("tok-abc");
    expect(payload.member_urn).toBe("urn:li:person:XYZ");
    expect(payload.scope).toBe("openid profile w_member_social");

    // expires_at must equal Date.now() + 7200*1000 (within the test window)
    const expiresAt = new Date(payload.expires_at as string).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 7200 * 1000);

    // updated_at must be a recent ISO string
    const updatedAt = new Date(payload.updated_at as string).getTime();
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);

    // onConflict must be member_urn for upsert
    expect(opts?.onConflict).toBe("member_urn");
  });

  it("includes refresh_token and refresh_expires_at when present in tokens", async () => {
    const upsertFn = vi.fn().mockReturnValue({
      select: async () => ({ error: null }),
    });
    getSupabase.mockReturnValue({
      from: () => ({ upsert: upsertFn }),
    });

    await saveConnection({
      tokens: {
        accessToken: "tok",
        expiresInSec: 3600,
        refreshToken: "rt-abc",
        refreshExpiresInSec: 86400,
      },
      memberUrn: "urn:li:person:R1",
    });

    const [payload] = upsertFn.mock.calls[0] as [Record<string, unknown>];
    expect(payload.refresh_token).not.toBe("rt-abc");
    expect(decrypt(payload.refresh_token as string)).toBe("rt-abc");
    expect(typeof payload.refresh_expires_at).toBe("string");
  });

  it("does not set refresh_expires_at when refreshExpiresInSec is absent", async () => {
    const upsertFn = vi.fn().mockReturnValue({
      select: async () => ({ error: null }),
    });
    getSupabase.mockReturnValue({
      from: () => ({ upsert: upsertFn }),
    });

    await saveConnection({
      tokens: { accessToken: "tok", expiresInSec: 3600 },
      memberUrn: "urn:li:person:R2",
    });

    const [payload] = upsertFn.mock.calls[0] as [Record<string, unknown>];
    expect(payload.refresh_expires_at).toBeUndefined();
  });

  it("throws when the DB returns an error", async () => {
    getSupabase.mockReturnValue({
      from: () => ({
        upsert: () => ({
          select: async () => ({ error: { message: "unique constraint" } }),
        }),
      }),
    });

    await expect(
      saveConnection({
        tokens: { accessToken: "tok", expiresInSec: 3600 },
        memberUrn: "urn:li:person:ERR",
      }),
    ).rejects.toThrow(/unique constraint/);
  });
});

// ---------------------------------------------------------------------------
// getValidConnection
// ---------------------------------------------------------------------------

describe("getValidConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no LINKEDIN env — set in individual tests as needed
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
  });

  it("returns null when no row exists in the DB", async () => {
    // Supabase returns null data + PGRST116 (no rows) when using .single()
    // but our impl handles null data gracefully
    getSupabase.mockReturnValue({
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              single: async () => ({ data: null, error: { code: "PGRST116", message: "no rows" } }),
            }),
          }),
        }),
      }),
    });

    const result = await getValidConnection();
    expect(result).toBeNull();
  });

  it("returns { accessToken, memberUrn } when token is more than 60s in the future", async () => {
    const row = makeRow({
      access_token: "still-valid-token",
      member_urn: "urn:li:person:VALID",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), // 1h in future
    });
    mockSelect(row);

    const result = await getValidConnection();
    expect(result).toEqual({
      accessToken: "still-valid-token",
      memberUrn: "urn:li:person:VALID",
    });
  });

  it("returns null when token is expired and there is no refresh_token", async () => {
    const row = makeRow({
      access_token: "expired-token",
      expires_at: new Date(Date.now() - 1000).toISOString(), // in the past
      refresh_token: null,
    });
    mockSelect(row);

    const result = await getValidConnection();
    expect(result).toBeNull();
  });

  it("returns null when token is expired, refresh_token exists, but env creds are missing", async () => {
    // No LINKEDIN_CLIENT_ID / SECRET in env
    const row = makeRow({
      access_token: "expired",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      refresh_token: "rt-exists",
    });
    mockSelect(row);

    const result = await getValidConnection();
    expect(result).toBeNull();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes token, saves, and returns new accessToken when expired with valid refresh + env creds", async () => {
    process.env.LINKEDIN_CLIENT_ID = "cid-test";
    process.env.LINKEDIN_CLIENT_SECRET = "csec-test";

    const row = makeRow({
      access_token: "old-expired",
      expires_at: new Date(Date.now() - 5000).toISOString(), // expired
      refresh_token: "rt-valid",
      member_urn: "urn:li:person:REFRESH",
    });
    mockSelect(row);

    const newTokens = {
      accessToken: "new-fresh-token",
      expiresInSec: 7200,
      refreshToken: "rt-new",
      refreshExpiresInSec: 31536000,
    };
    refreshAccessToken.mockResolvedValue(newTokens);

    // After the refresh, saveConnection will call upsert — wire a second mock
    const upsertFn = vi.fn().mockReturnValue({
      select: async () => ({ error: null }),
    });
    // Override getSupabase after the first select to handle upsert
    // We need both select and upsert on the same mock instance
    let callCount = 0;
    getSupabase.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: the select
        return {
          from: () => ({
            select: () => ({
              order: () => ({
                limit: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      // Second call: saveConnection upsert
      return {
        from: () => ({ upsert: upsertFn }),
      };
    });

    const result = await getValidConnection();

    expect(refreshAccessToken).toHaveBeenCalledWith({
      refreshToken: "rt-valid",
      clientId: "cid-test",
      clientSecret: "csec-test",
    });
    expect(upsertFn).toHaveBeenCalled();
    expect(result).toEqual({
      accessToken: "new-fresh-token",
      memberUrn: "urn:li:person:REFRESH",
    });
  });

  it("returns null (and console.errors) when refreshAccessToken throws", async () => {
    process.env.LINKEDIN_CLIENT_ID = "cid";
    process.env.LINKEDIN_CLIENT_SECRET = "csec";

    const row = makeRow({
      expires_at: new Date(Date.now() - 1000).toISOString(),
      refresh_token: "rt-bad",
    });
    mockSelect(row);
    refreshAccessToken.mockRejectedValue(new Error("refresh network error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getValidConnection();
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns null when the DB row has a malformed expires_at (type-guard path)", async () => {
    // expires_at is a number instead of a string — should not crash, return null
    const badRow = {
      id: "row-1",
      member_urn: "urn:li:person:BAD",
      access_token: "tok",
      refresh_token: null,
      expires_at: 12345 as unknown as string, // malformed
      refresh_expires_at: null,
      scope: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    getSupabase.mockReturnValue({
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              single: async () => ({ data: badRow, error: null }),
            }),
          }),
        }),
      }),
    });

    const result = await getValidConnection();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// signState / verifyState
// ---------------------------------------------------------------------------

describe("signState / verifyState", () => {
  beforeEach(() => {
    // Ensure a stable secret is available
    process.env.SOCIAL_ACTION_SECRET = "test-hmac-secret-32-chars-xxxxxxx";
    delete process.env.CRON_SECRET;
  });

  afterEach(() => {
    delete process.env.SOCIAL_ACTION_SECRET;
    delete process.env.CRON_SECRET;
  });

  it("signState + verifyState round-trip succeeds", () => {
    const state = signState("founder@example.com");
    const result = verifyState(state);
    expect(result).not.toBeNull();
    expect(result?.owner).toBe("founder@example.com");
  });

  it("verifyState returns null for a tampered state", () => {
    const state = signState("founder@example.com");
    // Flip the char actually being replaced — keying off a different position made
    // the "tampered" string byte-identical ~1/64 runs (flaky CI failure).
    const tampered = state.slice(0, -2) + (state.at(-2) === "a" ? "b" : "a") + state.at(-1);
    expect(verifyState(tampered)).toBeNull();
  });

  it("verifyState returns null for a completely invalid string", () => {
    expect(verifyState("not-a-valid-state")).toBeNull();
  });

  it("verifyState returns null for an empty string", () => {
    expect(verifyState("")).toBeNull();
  });

  it("verifyState returns null for an expired state", () => {
    vi.useFakeTimers();
    try {
      const state = signState("founder@example.com");
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(verifyState(state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifyState falls back to CRON_SECRET when SOCIAL_ACTION_SECRET is absent", () => {
    delete process.env.SOCIAL_ACTION_SECRET;
    process.env.CRON_SECRET = "cron-secret-value-32-chars-xxxxx";
    const state = signState("other@example.com");
    const result = verifyState(state);
    expect(result).not.toBeNull();
    expect(result?.owner).toBe("other@example.com");
  });
});

// ---------------------------------------------------------------------------
// saveConnection — ownerEmail path
// ---------------------------------------------------------------------------

describe("saveConnection — ownerEmail path", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("upserts on owner_email when ownerEmail is provided", async () => {
    const upsertFn = vi.fn().mockReturnValue({
      select: async () => ({ error: null }),
    });
    getSupabase.mockReturnValue({
      from: () => ({ upsert: upsertFn }),
    });

    await saveConnection({
      tokens: { accessToken: "tok-abc", expiresInSec: 3600 },
      memberUrn: "urn:li:person:XYZ",
      ownerEmail: "founder@example.com",
    });

    expect(upsertFn).toHaveBeenCalledTimes(1);
    const [payload, opts] = upsertFn.mock.calls[0] as [Record<string, unknown>, { onConflict: string }];
    expect(payload.owner_email).toBe("founder@example.com");
    expect(payload.member_urn).toBe("urn:li:person:XYZ");
    expect(opts?.onConflict).toBe("owner_email");
  });
});

// ---------------------------------------------------------------------------
// getValidConnectionFor
// ---------------------------------------------------------------------------

describe("getValidConnectionFor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
  });

  it("returns the token for the specific owner when row exists and is valid", async () => {
    const row = makeRow({
      member_urn: "urn:li:person:FOUNDER_A",
      access_token: "founder-a-token",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    getSupabase.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          }),
        }),
      }),
    });

    const result = await getValidConnectionFor("founder-a@example.com");
    expect(result).toEqual({
      accessToken: "founder-a-token",
      memberUrn: "urn:li:person:FOUNDER_A",
    });
  });

  it("returns null when no row exists for that owner", async () => {
    getSupabase.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({ data: null, error: { code: "PGRST116", message: "no rows" } }),
            }),
          }),
        }),
      }),
    });

    const result = await getValidConnectionFor("nobody@example.com");
    expect(result).toBeNull();
  });

  it("refreshes and returns new token when expired but refresh token + env creds exist", async () => {
    process.env.LINKEDIN_CLIENT_ID = "cid-test";
    process.env.LINKEDIN_CLIENT_SECRET = "csec-test";

    const row = makeRow({
      member_urn: "urn:li:person:REFRESH_OWNER",
      access_token: "expired-tok",
      expires_at: new Date(Date.now() - 5000).toISOString(),
      refresh_token: "rt-owner",
    });

    const upsertFn = vi.fn().mockReturnValue({
      select: async () => ({ error: null }),
    });
    let callCount = 0;
    getSupabase.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: () => ({
            select: () => ({
              eq: () => ({
                limit: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { from: () => ({ upsert: upsertFn }) };
    });

    refreshAccessToken.mockResolvedValue({
      accessToken: "fresh-owner-token",
      expiresInSec: 7200,
    });

    const result = await getValidConnectionFor("owner@example.com");
    expect(result).toEqual({
      accessToken: "fresh-owner-token",
      memberUrn: "urn:li:person:REFRESH_OWNER",
    });
    expect(upsertFn).toHaveBeenCalled();
  });
});
