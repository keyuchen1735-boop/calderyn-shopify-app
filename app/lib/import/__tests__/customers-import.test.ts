// Customer import: Shopify customers → the buyer PII store. The behaviors that
// matter: no-email customers are counted (not silently dropped), ACCESS_DENIED
// classifies as blocked (protected-customer-data approval pending), addresses
// are only added once (re-import idempotency), marketing consent is recorded
// only for explicit SUBSCRIBED/UNSUBSCRIBED states.
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

  it("classifies ACCESS_DENIED as blocked, not an error", async () => {
    fetchError = new Error('Admin GraphQL error: [{"extensions":{"code":"ACCESS_DENIED"}}]');
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r.blocked).toBe(true);
  });

  it("rethrows non-access errors so the run lands in state=error", async () => {
    fetchError = new Error("ECONNRESET");
    await expect(importCustomers("s.myshopify.com", "shop-1")).rejects.toThrow("ECONNRESET");
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
    expect(recordConsent).toHaveBeenCalledWith("shop-1", "buyer-a@example.com", expect.objectContaining({ policy: "marketing", accepted: true }));
  });
});
