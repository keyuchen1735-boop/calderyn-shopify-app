import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Mock the action adapter the same way undo.test.ts does.
const { actionAdapterForShop } = vi.hoisted(() => {
  const adapter = {
    platform: "meta",
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    setDailyBudget: vi.fn(async () => {}),
    getState: vi.fn(),
  };
  const actionAdapterForShop = vi.fn(async () => adapter);
  return { actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

const SHOP = "00000000-0000-0000-0000-000000000020";

/**
 * Builds a fake SupabaseClient that:
 * - Returns `original` for the main action_audit full-column lookup
 * - Returns null for the double-undo guard (select("id"))
 * - Returns `alertRow` for alerts selects (detector_id lookup)
 * - Records all .rpc() calls
 */
function fakeDemoteSb(
  original: Record<string, unknown>,
  alertRow: { detector_id: string } | null,
) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    return { data: null, error: null };
  });

  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    let selected = "";

    chain.select = vi.fn((cols: string) => {
      selected = cols;
      return chain;
    });
    chain.eq = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);

    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_audit") {
        // double-undo guard selects only "id"
        if (selected === "id") return { data: null, error: null };
        // main orig lookup
        return { data: original, error: null };
      }
      if (table === "alerts") {
        return { data: alertRow, error: null };
      }
      return { data: null, error: null };
    });

    chain.update = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));

    return chain;
  }

  const sb = {
    from: vi.fn((t: string) => builder(t)),
    rpc,
  } as unknown as SupabaseClient;

  return { sb, rpc, rpcCalls };
}

const autopilotPauseAudit = {
  id: "aud-auto-1",
  shop_id: SHOP,
  action_kind: "pause_campaign",
  params: { external_id: "c1", platform: "meta" },
  pre_state: { status: "active", daily_budget_cents: 5000 },
  post_state: { status: "paused", daily_budget_cents: 5000 },
  dollar_impact_at_exec: 5000,
  outcome: "succeeded",
  actor_user_id: "autopilot",
  alert_id: "al1",
  undo_of: null,
  created_at: new Date().toISOString(), // fresh, within undo window
};

const merchantPauseAudit = {
  ...autopilotPauseAudit,
  id: "aud-merch-1",
  actor_user_id: "merchant",
  alert_id: "al2",
};

describe("undoAction · calibration demote signal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records an undone autopilot action as an autonomous undo (beta +1.5 flavor)", async () => {
    const { sb, rpc } = fakeDemoteSb(autopilotPauseAudit, {
      detector_id: "campaign_below_breakeven",
    });

    await undoAction(SHOP, "aud-auto-1", sb);

    expect(rpc).toHaveBeenCalledWith("calibration_record_undo", {
      p_shop_id: SHOP,
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
      p_autonomous: true,
    });
  });

  // Spec §7: an undone merchant APPROVAL is a revoked endorsement — it must
  // write the +1 beta / clean_approvals-take-back flavor, or three
  // approve-then-undo cycles would still satisfy the 3-clean-approvals
  // graduation bar with evidence the merchant explicitly reversed.
  it("records an undone merchant-approved action as a non-autonomous undo (beta +1 flavor)", async () => {
    const { sb, rpc } = fakeDemoteSb(merchantPauseAudit, {
      detector_id: "campaign_below_breakeven",
    });

    await undoAction(SHOP, "aud-merch-1", sb);

    expect(rpc).toHaveBeenCalledWith("calibration_record_undo", {
      p_shop_id: SHOP,
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
      p_autonomous: false,
    });
  });
});
