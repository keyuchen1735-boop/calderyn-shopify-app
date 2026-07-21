import { beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.fn();
vi.mock("../../shopify.server", () => ({ unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql } })) } }));
const replaceSellingPlanSnapshot = vi.fn();
vi.mock("~/lib/storefront/selling-plan-sync.server", () => ({ replaceSellingPlanSnapshot }));

describe("Shopify selling-plan ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graphql.mockReset();
    replaceSellingPlanSnapshot.mockResolvedValue({ groups: 1, plans: 1, eligibility: 2 });
  });

  it("paginates variant associations, maps stable IDs, and commits only after complete success", async () => {
    graphql
      .mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: {
        pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [{ id: "v-1", price: "10.00", sellingPlanGroups: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "g-1", name: "Subscribe", sellingPlans: {
            pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "p-1", name: "Monthly", options: ["Every month"], pricingPolicies: [{ __typename: "SellingPlanFixedPricingPolicy", adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 10 } }] }],
          } }],
        } }] } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "v-2", price: "20.00", sellingPlanGroups: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "g-1", name: "Subscribe", sellingPlans: {
            pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "p-1", name: "Monthly", options: ["Every month"], pricingPolicies: [] }],
          } }],
        } }] } } }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await syncShopifySellingPlans("store.myshopify.com", "shop-a");
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1].variables).toEqual({ cursor: "next" });
    expect(replaceSellingPlanSnapshot).toHaveBeenCalledOnce();
    expect(replaceSellingPlanSnapshot).toHaveBeenCalledWith("shop-a", "shopify", {
      groups: [{ externalId: "g-1", name: "Subscribe" }],
      plans: [{ externalId: "p-1", groupExternalId: "g-1", name: "Monthly", cadence: "Every month" }],
      eligibility: [
        { variantExternalId: "v-1", planExternalId: "p-1", priceCents: 900, currency: "USD" },
        { variantExternalId: "v-2", planExternalId: "p-1" },
      ],
    });
  });

  it("does not replace the prior snapshot after a later page error", async () => {
    graphql.mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [] } } }) })
      .mockResolvedValueOnce({ json: async () => ({ errors: [{ message: "throttled" }] }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await expect(syncShopifySellingPlans("store.myshopify.com", "shop-a")).rejects.toThrow(/throttled/);
    expect(replaceSellingPlanSnapshot).not.toHaveBeenCalled();
  });

  it("paginates nested groups and plans before replacing the snapshot", async () => {
    graphql
      .mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "v-1", price: "10.00", sellingPlanGroups: {
          pageInfo: { hasNextPage: true, endCursor: "groups-next" }, nodes: [{ id: "g-1", name: "Subscribe", sellingPlans: {
            pageInfo: { hasNextPage: true, endCursor: "plans-next" }, nodes: [{ id: "p-1", name: "Monthly", options: ["Every month"], pricingPolicies: [] }],
          } }],
        } }] } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { sellingPlanGroup: { sellingPlans: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "p-2", name: "Quarterly", options: ["Every 3 months"], pricingPolicies: [] }],
      } } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { productVariant: { sellingPlanGroups: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "g-2", name: "Preorder", sellingPlans: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "p-3", name: "Launch", options: ["Ships at launch"], pricingPolicies: [] }],
        } }],
      } } } }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await syncShopifySellingPlans("store.myshopify.com", "shop-a");
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[1][1].variables).toEqual({ groupId: "g-1", cursor: "plans-next" });
    expect(graphql.mock.calls[2][1].variables).toEqual({ variantId: "v-1", cursor: "groups-next" });
    expect(replaceSellingPlanSnapshot).toHaveBeenCalledWith("shop-a", "shopify", {
      groups: [{ externalId: "g-1", name: "Subscribe" }, { externalId: "g-2", name: "Preorder" }],
      plans: [
        { externalId: "p-1", groupExternalId: "g-1", name: "Monthly", cadence: "Every month" },
        { externalId: "p-2", groupExternalId: "g-1", name: "Quarterly", cadence: "Every 3 months" },
        { externalId: "p-3", groupExternalId: "g-2", name: "Launch", cadence: "Ships at launch" },
      ],
      eligibility: [
        { variantExternalId: "v-1", planExternalId: "p-1" },
        { variantExternalId: "v-1", planExternalId: "p-2" },
        { variantExternalId: "v-1", planExternalId: "p-3" },
      ],
    });
  });

  it("fails closed when a nested page errors", async () => {
    graphql
      .mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "v-1", price: "10.00", sellingPlanGroups: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "g-1", name: "Subscribe", sellingPlans: {
            pageInfo: { hasNextPage: true, endCursor: "plans-next" }, nodes: [],
          } }],
        } }] } } }) })
      .mockResolvedValueOnce({ json: async () => ({ errors: [{ message: "nested throttled" }] }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await expect(syncShopifySellingPlans("store.myshopify.com", "shop-a")).rejects.toThrow(/nested throttled/);
    expect(replaceSellingPlanSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when nested pagination does not provide a cursor", async () => {
    graphql.mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "v-1", price: "10.00", sellingPlanGroups: {
        pageInfo: { hasNextPage: true, endCursor: null }, nodes: [],
      } }] } } }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await expect(syncShopifySellingPlans("store.myshopify.com", "shop-a")).rejects.toThrow(/made no progress/);
    expect(replaceSellingPlanSnapshot).not.toHaveBeenCalled();
  });

  it("keeps catalog price when fixed and recurring policies cannot be represented exactly", async () => {
    graphql.mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "v-1", price: "10.00", sellingPlanGroups: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "g-1", name: "Subscribe", sellingPlans: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "p-1", name: "Monthly", options: ["Every month"], pricingPolicies: [
            { __typename: "SellingPlanFixedPricingPolicy", adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 10 } },
            { __typename: "SellingPlanRecurringPricingPolicy" },
          ] }],
        } }],
      } }] } } }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await syncShopifySellingPlans("store.myshopify.com", "shop-a");
    expect(replaceSellingPlanSnapshot.mock.calls[0][2].eligibility).toEqual([{ variantExternalId: "v-1", planExternalId: "p-1" }]);
  });

  it("commits an empty successful snapshot for a merchant with no plans", async () => {
    graphql.mockResolvedValueOnce({ json: async () => ({ data: { shop: { currencyCode: "USD" }, productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }) });
    const { syncShopifySellingPlans } = await import("./shopify-selling-plans.server");
    await syncShopifySellingPlans("store.myshopify.com", "shop-a");
    expect(replaceSellingPlanSnapshot).toHaveBeenCalledWith("shop-a", "shopify", { groups: [], plans: [], eligibility: [] });
  });
});
