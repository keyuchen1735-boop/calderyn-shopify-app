// app/lib/actions/__tests__/reallocate-sku.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeReallocateSpendSku } from "../reallocate-sku.server";

const executeReallocation = vi.hoisted(() => vi.fn());
vi.mock("../reallocate.server", () => ({
  executeReallocation: (...a: unknown[]) => executeReallocation(...a),
}));
const enrichRemediation = vi.hoisted(() => vi.fn());
vi.mock("../../remediation/enrich.server", () => ({
  enrichRemediation: (...a: unknown[]) => enrichRemediation(...a),
}));
const acknowledgeAlert = vi.hoisted(() => vi.fn());
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: never[]) => acknowledgeAlert(...a),
}));

const LOSER_CAMP = "camp-loser";
const WINNER_CAMP = "camp-winner";

function eligiblePlan() {
  return {
    moves: [
      {
        kind: "reallocate_to_winner",
        dollarImpactCents: 530449,
        executor: "reallocate_spend_sku",
        label: "Move ad budget to Hydration Bottle",
        target: { loserCampaignId: LOSER_CAMP, winnerCampaignId: WINNER_CAMP, winnerLabel: "Hydration Bottle", amountCents: 22500 },
      },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "reallocate_to_winner",
    structurallyDead: false,
  };
}

const baseAlert = {
  id: "al-1", detector_id: "negative_unit_economics", severity: "high", status: "open",
  dollar_impact: 50000, claude_rank: 1, created_at: "2026-06-20T00:00:00Z",
  title: "Summit Tee", narrative: "", campaign: null, campaign_id: null,
  campaign_external_id: null, sku: "SUMMIT-TEE-M", evidence: { sku_id: "sku-loser" },
};

const alertsGet = vi.fn(async () => baseAlert);
const guardrailsGet = vi.fn(async () => ({ dollar_cap_cents: 100000 }));
const client = { alerts: { get: alertsGet }, guardrails: { get: guardrailsGet } } as never;
const SB = { mocked: true } as never;

function run(over: Record<string, unknown> = {}) {
  return executeReallocateSpendSku({
    client, sb: SB, shopId: "shop-1", alertId: "al-1", idempotencyKey: "idem-1", ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enrichRemediation.mockResolvedValue(eligiblePlan());
  executeReallocation.mockResolvedValue({ id: "aud-1", outcome: "succeeded" });
  acknowledgeAlert.mockResolvedValue(true);
});

describe("executeReallocateSpendSku", () => {
  it("delegates to executeReallocation with the server-resolved loser→winner pair + amount", async () => {
    const res = await run();
    expect(executeReallocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        alertId: "al-1",
        sourceCampaignId: LOSER_CAMP,
        destCampaignId: WINNER_CAMP,
        amountCents: 22500,
        idempotencyKey: "idem-1",
      }),
      SB,
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("rejects when the alert is not open (409)", async () => {
    alertsGet.mockResolvedValueOnce({ ...baseAlert, status: "resolved" });
    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("rejects when the enriched plan has no executable reallocate (advisory) (422)", async () => {
    enrichRemediation.mockResolvedValueOnce({
      moves: [{ kind: "reallocate_to_winner", dollarImpactCents: 1, executor: null, ineligibleReason: "served by a shared campaign", label: "x" }],
      recommended: null, structurallyDead: false,
    });
    await expect(run()).rejects.toMatchObject({ status: 422 });
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("rejects when dollar impact exceeds the per-action cap (403)", async () => {
    guardrailsGet.mockResolvedValueOnce({ dollar_cap_cents: 100 }); // alert impact 50000 > cap
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("acknowledges the alert on success", async () => {
    await run();
    expect(acknowledgeAlert).toHaveBeenCalledWith(SB, "shop-1", "al-1");
  });
});
