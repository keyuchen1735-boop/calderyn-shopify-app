import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";

// Spies for the IO boundaries we mock. vi.hoisted runs before the (hoisted)
// vi.mock factories that reference these. The real audit.undo logic runs.
const { insertSpy, setStatusSpy, metaForShopSpy, sbState } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  setStatusSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
  // Configurable fake-Supabase state: each test sets the orig audit row;
  // updates (e.g. the alert re-open) are recorded for assertions.
  sbState: {
    origRow: {} as Record<string, unknown>,
    updates: [] as Array<{
      table: string;
      payload: Record<string, unknown>;
      filters: Array<[string, unknown]>;
    }>,
  },
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      select: () => {
        const b = {
          eq: () => b,
          // orig lookup: .select("*").eq(shop_id).eq(id).maybeSingle()
          maybeSingle: async () => ({ data: sbState.origRow, error: null }),
          // v_audit_view re-read of the inserted undo row
          single: async () => ({
            data: { id: "undo-1", action_kind: sbState.origRow.action_kind, outcome: "succeeded" },
            error: null,
          }),
        };
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        insertSpy(row);
        return {
          select: () => ({
            single: async () => ({ data: { ...row, id: "undo-1" }, error: null }),
          }),
        };
      },
      // Chainable + thenable so the multi-filter alert re-open records here.
      update: (payload: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const b = {
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            return b;
          },
          then: (resolve: (v: unknown) => unknown) => {
            sbState.updates.push({ table, payload, filters });
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return b;
      },
    }),
  }),
  resolveShopId: async () => "shop-uuid",
}));

vi.mock("../meta/client.server", () => ({
  metaClientForShop: (...args: unknown[]) => metaForShopSpy(...args),
}));

vi.mock("../meta/campaigns.server", () => ({
  setCampaignStatus: (...args: unknown[]) => setStatusSpy(...args),
}));

beforeEach(() => {
  insertSpy.mockReset();
  setStatusSpy.mockReset();
  metaForShopSpy.mockReset();
  sbState.origRow = {};
  sbState.updates = [];
});

describe("audit.undo Meta safety", () => {
  it("does NOT write an inverse audit row when the Meta restore call fails", async () => {
    metaForShopSpy.mockResolvedValue({ client: { get: vi.fn(), post: vi.fn() }, adAccountId: "act_1" });
    setStatusSpy.mockRejectedValue(new Error("Meta API error: Permission denied"));
    sbState.origRow = {
      id: "a1",
      action_kind: "pause_campaign",
      pre_state: { status: "ACTIVE" },
      post_state: { campaign_id: "120" },
      alert_id: null,
      params: {},
      dollar_impact_at_exec: 0,
    };

    const client = calderynClient("acme.myshopify.com");

    await expect(client.audit.undo("a1")).rejects.toThrow(/Permission denied/);
    // The prior status was restore-attempted before any DB write...
    expect(setStatusSpy).toHaveBeenCalledWith(expect.anything(), "120", "ACTIVE");
    // ...and because it threw, the inverse row was never inserted.
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("audit.undo alert re-open", () => {
  it("puts the acknowledged alert back in the open queue when its action is undone", async () => {
    // Undo revives the underlying problem: the acknowledge-on-execute flow
    // closed the alert, so reversing the action must re-open it.
    sbState.origRow = {
      id: "a2",
      action_kind: "create_po_draft",
      pre_state: null,
      post_state: null,
      alert_id: "al-1",
      params: { po: { po_number: "PO-1" } },
      dollar_impact_at_exec: 0,
    };

    const client = calderynClient("acme.myshopify.com");
    await client.audit.undo("a2");

    const reopen = sbState.updates.find((u) => u.table === "alerts");
    expect(reopen?.payload).toEqual({ status: "open" });
    expect(reopen?.filters).toEqual(
      expect.arrayContaining([
        ["shop_id", "shop-uuid"],
        ["id", "al-1"],
        ["status", "acknowledged"],
      ]),
    );
  });
});
