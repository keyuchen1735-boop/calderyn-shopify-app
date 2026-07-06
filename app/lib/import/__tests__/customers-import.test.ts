// Customer import: Shopify customers → the buyer PII store. The behaviors that
// matter: no-email customers are counted (not silently dropped), the
// protected-customer-data denial — in either the plain API-message form the
// merchant sees or the ACCESS_DENIED code form — classifies as blocked
// (approval pending) rather than failing the run, addresses are only added once
// (re-import idempotency), marketing consent is recorded only for explicit
// SUBSCRIBED/UNSUBSCRIBED states.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminCustomer } from "~/lib/ingest/shopify-admin.server";

// vi.hoisted ensures these mocks are initialized before vi.mock factories run,
// which is needed for mocks with implementations (closures over input values).
const { upsertGuestBuyer, addBuyerAddress, recordConsent, existingShippingAddress } = vi.hoisted(() => ({
  upsertGuestBuyer: vi.fn(async (_shopId: string, input: { email: string }) => ({
    id: `buyer-${input.email}`,
    shopId: "shop-1",
    emailNormalized: input.email.toLowerCase(),
    phone: null,
    createdAt: "2026-07-03T00:00:00Z",
  })),
  addBuyerAddress: vi.fn(async () => ({})),
  recordConsent: vi.fn(async () => ({})),
  existingShippingAddress: vi.fn(async () => false as boolean),
}));

const customers: AdminCustomer[] = [];
let fetchError: Error | null = null;
vi.mock("~/lib/ingest/shopify-admin.server", () => ({
  fetchCustomers: async function* () {
    if (fetchError) throw fetchError;
    yield* customers;
  },
}));

vi.mock("~/lib/buyer/identity.server", () => ({
  upsertGuestBuyer,
  addBuyerAddress,
  recordConsent,
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => ({
                data: (await existingShippingAddress()) ? [{ id: "addr-1" }] : [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

// eslint-disable-next-line import/first -- must follow the vi.mock factories above
import { importCustomers } from "../customers.server";

function customer(over: Partial<AdminCustomer>): AdminCustomer {
  return {
    id: "gid://shopify/Customer/1",
    email: "a@example.com",
    phone: null,
    defaultAddress: null,
    emailMarketingConsent: null,
    ...over,
  };
}

describe("importCustomers", () => {
  beforeEach(() => {
    customers.length = 0;
    fetchError = null;
    existingShippingAddress.mockResolvedValue(false);
    vi.clearAllMocks();
  });

  it("upserts each emailed customer as a buyer and counts them", async () => {
    customers.push(customer({ email: "a@example.com" }), customer({ id: "2", email: "b@example.com" }));
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r).toEqual({ imported: 2, skipped: 0, blocked: false });
    expect(upsertGuestBuyer).toHaveBeenCalledTimes(2);
  });

  it("counts customers without an email as skipped — never silently dropped", async () => {
    customers.push(customer({ email: null }), customer({ id: "2", email: "b@example.com" }));
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r).toEqual({ imported: 1, skipped: 1, blocked: false });
  });

  it("classifies the protected-customer-data denial (plain API message) as blocked, not an error", async () => {
    // The exact message Shopify's Admin client throws when the app lacks
    // protected-customer-data approval — no "ACCESS_DENIED" substring in it.
    fetchError = new Error(
      "This app is not approved to use the email field. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.",
    );
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r.blocked).toBe(true);
  });

  it("also classifies the ACCESS_DENIED code form as blocked", async () => {
    fetchError = new Error('Admin GraphQL error: [{"extensions":{"code":"ACCESS_DENIED"}}]');
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r.blocked).toBe(true);
  });

  it("rethrows non-access errors so the run lands in state=error", async () => {
    fetchError = new Error("ECONNRESET");
    await expect(importCustomers("s.myshopify.com", "shop-1")).rejects.toThrow("ECONNRESET");
  });

  it("does not misclassify a buyer-WRITE failure as blocked, even if its message looks PCD-ish", async () => {
    // Protected-customer-data denial can only come from the Shopify pull; a
    // buyer-write (Supabase) error must fail the run loudly, never masquerade as
    // `blocked` (which would silently swallow it and file a dishonest report).
    customers.push(customer({ email: "a@example.com" }));
    upsertGuestBuyer.mockRejectedValueOnce(new Error("ACCESS_DENIED: buyer_dim row-level security"));
    await expect(importCustomers("s.myshopify.com", "shop-1")).rejects.toThrow("ACCESS_DENIED");
  });

  it("adds the default address once and skips it on re-import", async () => {
    customers.push(
      customer({ defaultAddress: { name: "A", address1: "1 Main St", address2: null, city: "NY", province: "NY", zip: "10001", country: "US", phone: null } }),
    );
    await importCustomers("s.myshopify.com", "shop-1");
    expect(addBuyerAddress).toHaveBeenCalledTimes(1);
    existingShippingAddress.mockResolvedValue(true);
    await importCustomers("s.myshopify.com", "shop-1");
    expect(addBuyerAddress).toHaveBeenCalledTimes(1); // unchanged
  });

  it("records marketing consent only for explicit states", async () => {
    customers.push(
      customer({ emailMarketingConsent: { marketingState: "SUBSCRIBED", consentUpdatedAt: "2026-01-01T00:00:00Z" } }),
      customer({ id: "2", email: "b@example.com", emailMarketingConsent: { marketingState: "NOT_SUBSCRIBED", consentUpdatedAt: null } }),
    );
    await importCustomers("s.myshopify.com", "shop-1");
    expect(recordConsent).toHaveBeenCalledTimes(1);
    // version + capturedAt are the append-only ledger's provenance proof — pin them.
    expect(recordConsent).toHaveBeenCalledWith("shop-1", "buyer-a@example.com", {
      policy: "marketing",
      version: "shopify-import-2026-07",
      accepted: true,
      capturedAt: "2026-01-01T00:00:00Z",
    });
  });
});
