// Contract tests for checkout address verification (shipping deferred D3). The one
// invariant everything else bends to: this is ADVISORY — no code path may throw or
// block checkout. Suggestions appear only when the carrier verified the address AND
// the standardized form meaningfully differs from what the buyer typed.
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: table === "integration_credentials" ? (rows[0] ?? null) : null,
                error: null,
              }),
          }),
        }),
      }),
    }),
  };
  return { rows, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: (v: string) => `decrypted:${v}` }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { verifyCheckoutAddress } from "../address-verify.server";

const TYPED = { street1: "99 elm street", city: "Seattle", state: "wa", zip: "98101", country: "US" };

const VERIFIED_DIFFERENT = {
  street1: "99 ELM ST",
  street2: null,
  city: "SEATTLE",
  state: "WA",
  zip: "98101-1234",
  country: "US",
  verifications: { delivery: { success: true } },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  store.rows.length = 0;
  store.rows.push({ access_token_encrypted: "enc" });
});

describe("verifyCheckoutAddress", () => {
  it("returns the standardized form when the carrier verified it and it differs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, VERIFIED_DIFFERENT));
    const s = await verifyCheckoutAddress("shop-1", TYPED, fetchImpl as unknown as typeof fetch);
    expect(s).toEqual({
      line1: "99 ELM ST",
      line2: null,
      city: "SEATTLE",
      region: "WA",
      postal: "98101-1234",
    });
  });

  it("returns null when the standardized form matches what the buyer typed (case/spacing-insensitive)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...VERIFIED_DIFFERENT, street1: "99 ELM STREET", zip: "98101" }),
    );
    const s = await verifyCheckoutAddress("shop-1", TYPED, fetchImpl as unknown as typeof fetch);
    expect(s).toBeNull();
  });

  it("returns null (never a block) without a carrier credential — and never calls the API", async () => {
    store.rows.length = 0;
    const fetchImpl = vi.fn();
    const s = await verifyCheckoutAddress("shop-1", TYPED, fetchImpl as unknown as typeof fetch);
    expect(s).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the carrier could not verify delivery", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...VERIFIED_DIFFERENT, verifications: { delivery: { success: false } } }),
    );
    expect(await verifyCheckoutAddress("shop-1", TYPED, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null on API failure, network error, and malformed body — NEVER throws", async () => {
    const err500 = vi.fn(async () => jsonResponse(500, { error: { message: "boom" } }));
    expect(await verifyCheckoutAddress("shop-1", TYPED, err500 as unknown as typeof fetch)).toBeNull();

    const network = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await verifyCheckoutAddress("shop-1", TYPED, network as unknown as typeof fetch)).toBeNull();

    const garbage = vi.fn(async () => new Response("not json", { status: 200 }));
    expect(await verifyCheckoutAddress("shop-1", TYPED, garbage as unknown as typeof fetch)).toBeNull();
  });

  it("returns null when the verified form is missing load-bearing fields (no half-suggestions)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ...VERIFIED_DIFFERENT, street1: "" }));
    expect(await verifyCheckoutAddress("shop-1", TYPED, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
