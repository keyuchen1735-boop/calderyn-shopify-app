// app/lib/actions/__tests__/undo-discontinue.test.ts
import { describe, it, expect, vi } from "vitest";
import { undoAction } from "../undo.server";

// Admin client whose productUpdate(ACTIVE) succeeds.
const ADMIN_OK = {
  graphql: vi.fn(async () => ({
    json: async () => ({
      data: { productUpdate: { product: { id: "gid://shopify/Product/9", status: "ACTIVE" }, userErrors: [] } },
    }),
  }) as unknown as Response),
};

// Supabase mock: the original discontinue_sku audit row, no existing undo, in-window;
// captures the flag-clear update + the inserted undo row + the alert re-open.
function makeSb() {
  const origRow = {
    id: "au1",
    shop_id: "shop-1",
    alert_id: "a1",
    action_kind: "discontinue_sku",
    params: { sku_id: "sku-1", product_id: "gid://shopify/Product/9" },
    pre_state: {},
    post_state: {},
    dollar_impact_at_exec: 500,
    undo_of: null,
    outcome: "succeeded",
    created_at: new Date().toISOString(),
  };
  const skuUpdate = vi.fn(() => ({ eq: () => ({ eq: () => ({ error: null }) }) }));
  const calls: string[] = [];
  const sb = {
    from: vi.fn((table: string) => {
      calls.push(table);
      if (table === "action_audit") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                // orig row lookup: .maybeSingle()
                maybeSingle: async () => ({ data: origRow, error: null }),
                // existing-undo check: .limit(1).maybeSingle()
                limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "undo1" }, error: null }) }) }),
        };
      }
      if (table === "sku_dim") return { update: skuUpdate };
      if (table === "alerts") return { update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }) };
      return {};
    }),
    _skuUpdate: skuUpdate,
  };
  return sb as never;
}

describe("undoAction — discontinue_sku", () => {
  it("re-activates the product, clears the flag, and writes an undo row", async () => {
    const sb = makeSb();
    const res = await undoAction("shop-1", "au1", sb, { admin: ADMIN_OK });
    expect(ADMIN_OK.graphql).toHaveBeenCalled();
    expect((sb as never as { _skuUpdate: ReturnType<typeof vi.fn> })._skuUpdate).toHaveBeenCalledWith({ do_not_reorder: false });
    expect(res.id).toBe("undo1");
  });

  it("refuses without an admin client (rule 12 — no fake undo)", async () => {
    const sb = makeSb();
    await expect(undoAction("shop-1", "au1", sb, {})).rejects.toThrow(/admin/i);
  });
});
