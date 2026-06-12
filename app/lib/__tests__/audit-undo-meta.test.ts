import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";

// Spies for the IO boundaries we mock. vi.hoisted runs before the (hoisted)
// vi.mock factories that reference these. The real audit.undo logic runs.
const { insertSpy, setStatusSpy, metaForShopSpy, tiktokAdapter, actionAdapterForShop, sbState } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  setStatusSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
  // Platform-aware adapter the gateway undo path resolves. Default: a TikTok
  // adapter, so the legacy undo proves it reverses through the real platform
  // (not the Meta client) for non-Meta campaigns.
  tiktokAdapter: {
    platform: "tiktok",
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    setDailyBudget: vi.fn(async () => {}),
    getState: vi.fn(),
  },
  actionAdapterForShop: vi.fn(),
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
      select: (cols?: string) => {
        const b = {
          eq: () => b,
          limit: () => b,
          // The already-undone guard probes with .select("id")...maybeSingle()
          // (no existing undo row); the orig lookup uses .select("*").
          maybeSingle: async () =>
            cols === "id"
              ? { data: null, error: null }
              : { data: sbState.origRow, error: null },
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

vi.mock("../ads/action-registry.server", () => ({
  actionAdapterForShop: (...args: unknown[]) => actionAdapterForShop(...args),
}));

beforeEach(() => {
  insertSpy.mockReset();
  setStatusSpy.mockReset();
  metaForShopSpy.mockReset();
  tiktokAdapter.pause.mockClear();
  tiktokAdapter.resume.mockClear();
  tiktokAdapter.setDailyBudget.mockClear();
  actionAdapterForShop.mockReset();
  actionAdapterForShop.mockResolvedValue(tiktokAdapter);
  sbState.origRow = {};
  sbState.updates = [];
});

describe("audit.undo platform-aware reversal (not Meta-only)", () => {
  it("undoes a TikTok pause through the platform adapter, never the Meta client", async () => {
    sbState.origRow = {
      id: "tt1",
      action_kind: "pause_campaign",
      pre_state: { status: "active", daily_budget_cents: 5000 },
      post_state: { status: "paused", daily_budget_cents: 5000 },
      alert_id: null,
      params: { campaign_id: "dim-tt", external_id: "tt-ext-1", platform: "tiktok", daily_budget_cents: null },
      dollar_impact_at_exec: 0,
      outcome: "succeeded",
    };

    const client = calderynClient("acme.myshopify.com");
    await client.audit.undo("tt1");

    // Reversed via the resolved TikTok adapter, restoring pre-state "active".
    expect(actionAdapterForShop).toHaveBeenCalledWith("shop-uuid", "tiktok");
    expect(tiktokAdapter.resume).toHaveBeenCalledWith("tt-ext-1");
    // The Meta-only legacy path must NOT be used for a TikTok campaign.
    expect(setStatusSpy).not.toHaveBeenCalled();
  });
});

describe("audit.undo safety", () => {
  it("does NOT write an inverse audit row when the platform reversal fails", async () => {
    // pre_state "ACTIVE" (legacy uppercase) → undo resumes; make that throw.
    tiktokAdapter.resume.mockRejectedValueOnce(new Error("platform error: Permission denied"));
    sbState.origRow = {
      id: "a1",
      action_kind: "pause_campaign",
      pre_state: { status: "ACTIVE", daily_budget_cents: 5000 },
      post_state: { status: "paused", daily_budget_cents: 5000 },
      alert_id: null,
      params: { external_id: "120", platform: "meta" },
      dollar_impact_at_exec: 0,
      outcome: "succeeded",
    };

    const client = calderynClient("acme.myshopify.com");

    await expect(client.audit.undo("a1")).rejects.toThrow(/Permission denied/);
    // The reversal was attempted before any DB write...
    expect(tiktokAdapter.resume).toHaveBeenCalledWith("120");
    // ...and because it threw, the inverse row was never inserted.
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("audit.undo platform restore", () => {
  it("restores the prior status for an orchestrator-shape pause row via the adapter", async () => {
    // executeAction snapshots lowercase statuses from ad_campaign_dim and keeps
    // the platform campaign id in params.external_id. Undo resolves the campaign's
    // own adapter (here TikTok) and reverses through it — never the Meta client.
    sbState.origRow = {
      id: "a3",
      action_kind: "pause_campaign",
      pre_state: { status: "active", daily_budget_cents: 5000 },
      post_state: { status: "paused", daily_budget_cents: 5000 },
      alert_id: null,
      params: { campaign_id: "dim-uuid-1", external_id: "120", platform: "tiktok", daily_budget_cents: null },
      dollar_impact_at_exec: 0,
      outcome: "succeeded",
    };

    const client = calderynClient("acme.myshopify.com");
    await client.audit.undo("a3");

    expect(tiktokAdapter.resume).toHaveBeenCalledWith("120");
    expect(setStatusSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalled();
  });

  it("re-pauses the campaign when undoing a resume_campaign row", async () => {
    sbState.origRow = {
      id: "a4",
      action_kind: "resume_campaign",
      pre_state: { status: "paused", daily_budget_cents: 5000 },
      post_state: { status: "active", daily_budget_cents: 5000 },
      alert_id: null,
      params: { campaign_id: "dim-uuid-2", external_id: "121", platform: "tiktok", daily_budget_cents: null },
      dollar_impact_at_exec: 0,
      outcome: "succeeded",
    };

    const client = calderynClient("acme.myshopify.com");
    await client.audit.undo("a4");

    expect(tiktokAdapter.pause).toHaveBeenCalledWith("121");
    expect(setStatusSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalled();
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
      outcome: "succeeded",
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
