// app/lib/actions/__tests__/undo-adjust-price.test.ts
import { describe, it, expect, vi } from "vitest";
import { undoAction } from "../undo.server";

const VARIANT = "gid://shopify/ProductVariant/123";
const PRODUCT = "gid://shopify/Product/9";

// Admin client whose productVariantsBulkUpdate echoes the requested price.
function adminEcho() {
  return {
    graphql: vi.fn(async (_q: string, opts?: { variables?: { variants?: Array<{ id: string; price: string }> } }) => {
      const v = opts?.variables?.variants?.[0] ?? { id: VARIANT, price: "0.00" };
      return {
        json: async () => ({
          data: { productVariantsBulkUpdate: { productVariants: [v], userErrors: [] } },
        }),
      } as unknown as Response;
    }),
  };
}

function makeSb() {
  const origRow = {
    id: "au1",
    shop_id: "shop-1",
    alert_id: "a1",
    action_kind: "adjust_price",
    params: { variant_id: VARIANT, product_id: PRODUCT, prior_price_cents: 1500, new_price_cents: 1700 },
    pre_state: {},
    post_state: {},
    dollar_impact_at_exec: 500,
    undo_of: null,
    outcome: "succeeded",
    created_at: new Date().toISOString(),
  };
  return {
    from: vi.fn((table: string) => {
      if (table === "action_audit") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: origRow, error: null }),
                limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "undo1" }, error: null }) }) }),
        };
      }
      if (table === "alerts") return { update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }) };
      return {};
    }),
  } as never;
}

describe("undoAction — adjust_price", () => {
  it("restores the prior price on Shopify and writes an undo row", async () => {
    const admin = adminEcho();
    const res = await undoAction("shop-1", "au1", makeSb(), { admin });
    // The reverse write sets the price back to the prior $15.00.
    const [, opts] = admin.graphql.mock.calls[0];
    expect(opts).toMatchObject({
      variables: { productId: PRODUCT, variants: [{ id: VARIANT, price: "15.00" }] },
    });
    expect(res.id).toBe("undo1");
  });

  it("refuses without an admin client (rule 12 — no fake undo)", async () => {
    await expect(undoAction("shop-1", "au1", makeSb(), {})).rejects.toThrow(/admin/i);
  });
});
