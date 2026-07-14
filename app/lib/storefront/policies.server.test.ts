import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStorefrontPolicy,
  loadStorefrontPolicy,
  loadStorefrontPolicyLinks,
  loadStorefrontPolicies,
  resolveStorefrontPolicyPath,
  saveStorefrontPolicy,
  storefrontPolicyPath,
} from "./policies.server";

const { fromMock, purgeTagMock } = vi.hoisted(() => ({ fromMock: vi.fn(), purgeTagMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("@vercel/functions", () => ({ dangerouslyDeleteByTag: purgeTagMock }));

const SHOP = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  fromMock.mockReset();
  purgeTagMock.mockReset();
  purgeTagMock.mockResolvedValue(undefined);
  vi.stubEnv("VERCEL", "1");
});

describe("merchant storefront policies", () => {
  it("loads only this tenant's published policy links in platform order", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        { policy_id: "shipping", title: "Delivery details" },
        { policy_id: "privacy", title: "How we use data" },
        { policy_id: "unknown", title: "Ignore me" },
      ],
      error: null,
    });
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    fromMock.mockReturnValue({ select });

    await expect(loadStorefrontPolicyLinks(SHOP)).resolves.toEqual([
      { id: "privacy", title: "How we use data", href: "/storefront/policies/privacy" },
      { id: "shipping", title: "Delivery details", href: "/storefront/policies/shipping" },
    ]);
    expect(fromMock).toHaveBeenCalledWith("store_policy");
    expect(eq).toHaveBeenCalledWith("shop_id", SHOP);
  });

  it("loads policy content with the same tenant and policy key", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        policy_id: "refund",
        title: "Returns and refunds",
        body: "Return unopened items within 30 days.\n\nRefunds return to the original payment method.",
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      error: null,
    });
    const policyEq = vi.fn(() => ({ maybeSingle }));
    const shopEq = vi.fn(() => ({ eq: policyEq }));
    fromMock.mockReturnValue({ select: () => ({ eq: shopEq }) });

    await expect(loadStorefrontPolicy(SHOP, "refund")).resolves.toEqual({
      id: "refund",
      title: "Returns and refunds",
      body: "Return unopened items within 30 days.\n\nRefunds return to the original payment method.",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(shopEq).toHaveBeenCalledWith("shop_id", SHOP);
    expect(policyEq).toHaveBeenCalledWith("policy_id", "refund");
  });

  it("rejects unknown policy routes before accessing tenant data", async () => {
    expect(storefrontPolicyPath("privacy")).toBe("/storefront/policies/privacy");
    expect(resolveStorefrontPolicyPath("/storefront/policies/shipping")).toBe("shipping");
    expect(resolveStorefrontPolicyPath("/storefront/policies/shipping/extra")).toBeNull();
    await expect(loadStorefrontPolicy(SHOP, "admin")).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("hard-purges every tenant-tagged public page after save and delete", async () => {
    const saved = {
      policy_id: "privacy",
      title: "Privacy",
      body: "Merchant-authored privacy terms.",
      updated_at: "2026-07-14T12:00:00.000Z",
    };
    const single = vi.fn().mockResolvedValue({ data: saved, error: null });
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select }));
    const deletePolicyEq = vi.fn().mockResolvedValue({ error: null });
    const deleteShopEq = vi.fn(() => ({ eq: deletePolicyEq }));
    const remove = vi.fn(() => ({ eq: deleteShopEq }));
    fromMock
      .mockReturnValueOnce({ upsert })
      .mockReturnValueOnce({ delete: remove });

    await saveStorefrontPolicy(SHOP, { id: "privacy", title: "Privacy", body: "Merchant-authored privacy terms." });
    await deleteStorefrontPolicy(SHOP, "privacy");

    expect(purgeTagMock).toHaveBeenNthCalledWith(1, `storefront-shop-${SHOP}`);
    expect(purgeTagMock).toHaveBeenNthCalledWith(2, `storefront-shop-${SHOP}`);
  });

  it("lists only persisted merchant policies without fabricating defaults", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [{
        policy_id: "shipping",
        title: "Delivery details",
        body: "Orders ship after payment clears.",
        updated_at: "2026-07-14T12:00:00.000Z",
      }],
      error: null,
    });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ order }) }) });

    await expect(loadStorefrontPolicies(SHOP)).resolves.toEqual([{
      id: "shipping",
      title: "Delivery details",
      body: "Orders ship after payment clears.",
      updatedAt: "2026-07-14T12:00:00.000Z",
    }]);
  });

  it("saves a trimmed policy through a tenant-scoped upsert", async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        policy_id: "privacy",
        title: "How we use data",
        body: "We use order details only to fulfill purchases.",
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select }));
    fromMock.mockReturnValue({ upsert });

    await expect(saveStorefrontPolicy(SHOP, {
      id: "privacy",
      title: "  How we use data  ",
      body: "  We use order details only to fulfill purchases.\n",
    })).resolves.toMatchObject({ id: "privacy", title: "How we use data" });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      shop_id: SHOP,
      policy_id: "privacy",
      title: "How we use data",
      body: "We use order details only to fulfill purchases.",
    }), { onConflict: "shop_id,policy_id" });
  });

  it("rejects invalid policy bounds before touching storage", async () => {
    await expect(saveStorefrontPolicy(SHOP, { id: "privacy", title: "", body: "Body" }))
      .rejects.toMatchObject({ code: "invalid_storefront_policy_title", status: 422 });
    await expect(saveStorefrontPolicy(SHOP, { id: "privacy", title: "Title", body: "x".repeat(50_001) }))
      .rejects.toMatchObject({ code: "invalid_storefront_policy_body", status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("deletes only the requested tenant policy", async () => {
    const policyEq = vi.fn().mockResolvedValue({ error: null });
    const shopEq = vi.fn(() => ({ eq: policyEq }));
    const remove = vi.fn(() => ({ eq: shopEq }));
    fromMock.mockReturnValue({ delete: remove });

    await expect(deleteStorefrontPolicy(SHOP, "refund")).resolves.toBeUndefined();
    expect(shopEq).toHaveBeenCalledWith("shop_id", SHOP);
    expect(policyEq).toHaveBeenCalledWith("policy_id", "refund");
  });
});
