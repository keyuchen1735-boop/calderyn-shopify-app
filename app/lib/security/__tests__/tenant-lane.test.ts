// Unit coverage for the non-service-role tenant read lane (getTenantSupabase).
// No database: mocks @supabase/supabase-js so we can assert HOW the client is
// built — it must authenticate as the app_web role via a JWT signed with the
// project secret, and must never fall back to the service-role key.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { getTenantSupabase } from "../../supabase.server";

// vitest hoists vi.mock / vi.hoisted above the imports above at runtime.
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ mock: "client" })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

const SHOP = "11111111-2222-3333-4444-555555555555";
const SECRET = "test-jwt-secret-value";

function lastCall() {
  const call = createClient.mock.calls.at(-1);
  if (!call) throw new Error("createClient was not called");
  const [url, apiKey, opts] = call as unknown as [string, string, { global?: { headers?: Record<string, string> } }];
  const auth = opts?.global?.headers?.Authorization ?? "";
  const token = auth.replace(/^Bearer /, "");
  const [, payloadB64] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  return { url, apiKey, token, payload };
}

describe("getTenantSupabase", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    createClient.mockClear();
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_JWT_SECRET = SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "SERVICE-ROLE-DO-NOT-USE";
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("rejects a non-UUID shop id before minting anything", () => {
    expect(() => getTenantSupabase("acme.myshopify.com")).toThrow(/UUID/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("throws when the JWT secret is not configured", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => getTenantSupabase(SHOP)).toThrow(/not configured/i);
  });

  it("authenticates as the app_web role, not service-role", () => {
    getTenantSupabase(SHOP);
    const { token, payload } = lastCall();
    expect(payload.role).toBe("app_web");
    expect(payload.shop_id).toBe(SHOP);
    expect(payload.exp).toBeGreaterThan(payload.iat);
    // The bearer token is the minted JWT, never the service-role key.
    expect(token).not.toContain("SERVICE-ROLE-DO-NOT-USE");
  });

  it("signs the JWT with the project secret so PostgREST accepts it", () => {
    getTenantSupabase(SHOP);
    const { token } = lastCall();
    const [header, payload, sig] = token.split(".");
    const expected = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
    expect(sig).toBe(expected);
  });

  it("uses the publishable key as the gateway apikey when present", () => {
    process.env.SUPABASE_PUBLISHABLE_KEY = "pub-anon-key";
    getTenantSupabase(SHOP);
    const { apiKey, token } = lastCall();
    expect(apiKey).toBe("pub-anon-key");
    expect(apiKey).not.toBe(token);
  });
});
