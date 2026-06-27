// app/lib/actions/__tests__/po-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCreatePoDraft } from "../po-action.server";
import type { Alert, AuditEntry } from "../../types";

const acknowledgeAlert = vi.fn();
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: never[]) => acknowledgeAlert(...a),
}));

const resolveSkuForDiscontinue = vi.fn();
vi.mock("../discontinue.server", () => ({
  resolveSkuForDiscontinue: (...a: never[]) => resolveSkuForDiscontinue(...a),
}));

function alert(p: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    detector_id: "reorder_timing",
    severity: "high",
    status: "open",
    dollar_impact: 50000,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Trail Runner — 9",
    narrative: "n",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "TRAIL-9",
    evidence: { title: "Trail Runner — 9", shortfall_units: 40 },
    remediation: null,
    rec_detail: "",
    ...p,
  } as Alert;
}

type ExecOpts = {
  alertId: string | null;
  kind: string;
  params: { po?: Record<string, unknown> };
  idempotencyKey: string;
};

function client(a: Alert) {
  return {
    alerts: { get: vi.fn(async () => a) },
    actions: {
      execute: vi.fn(
        async (_opts: ExecOpts) => ({ id: "au-po-1", outcome: "succeeded" }) as unknown as AuditEntry,
      ),
    },
  };
}

const SB = {} as never;
const base = {
  shopId: "shop-1",
  shopDomain: "peak.myshopify.com",
  alertId: "a1",
  idempotencyKey: "idem-po",
};

describe("executeCreatePoDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeAlert.mockResolvedValue(true);
    resolveSkuForDiscontinue.mockResolvedValue({ skuId: "sku-1", productGid: "gid://x", alreadyFlagged: false });
  });

  it("builds a PO draft from the alert + merchant qty/cost, records it, and acknowledges", async () => {
    const c = client(alert());
    const res = await executeCreatePoDraft({
      ...base,
      client: c as never,
      sb: SB,
      quantity: "40",
      unitCost: "12.50",
    });
    const call = c.actions.execute.mock.calls[0][0] as { kind: string; params: { po?: Record<string, unknown> } };
    expect(call.kind).toBe("create_po_draft");
    expect(call.params.po).toMatchObject({
      shop_domain: "peak.myshopify.com",
      lines: [expect.objectContaining({ sku: "TRAIL-9", quantity: 40, unit_cost_cents: 1250 })],
    });
    expect(res).toMatchObject({ auditId: "au-po-1", outcome: "succeeded", acknowledged: true });
  });

  it("treats a blank unit cost as TBD (null), still drafting", async () => {
    const c = client(alert());
    await executeCreatePoDraft({ ...base, client: c as never, sb: SB, quantity: "40", unitCost: "" });
    const call = c.actions.execute.mock.calls[0][0] as { params: { po?: { lines: Array<{ unit_cost_cents: number | null }> } } };
    expect(call.params.po?.lines[0].unit_cost_cents).toBeNull();
  });

  it("rejects a non-positive / non-integer quantity (422)", async () => {
    for (const q of ["0", "-3", "1.5", "abc", ""]) {
      await expect(
        executeCreatePoDraft({ ...base, client: client(alert()) as never, sb: SB, quantity: q, unitCost: "" }),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it("defaults an empty (one-click) quantity to the suggested reorder qty", async () => {
    // velocity 2.0, lead 14, no cover -> ceil(2 * (14 + 14)) = 56
    const c = client(alert({ evidence: { title: "Trail Runner — 9", daily_velocity_units: "2.0", lead_time_days: 14 } }));
    const res = await executeCreatePoDraft({ ...base, client: c as never, sb: SB, quantity: "", unitCost: "" });
    const call = c.actions.execute.mock.calls[0][0] as { params: { po?: { lines: Array<{ quantity: number }> } } };
    expect(call.params.po?.lines[0].quantity).toBe(56);
    expect(res).toMatchObject({ outcome: "succeeded" });
  });

  it("refuses to draft a PO for a discontinued (Do-Not-Reorder) SKU (409)", async () => {
    resolveSkuForDiscontinue.mockResolvedValue({ skuId: "sku-1", productGid: "gid://x", alreadyFlagged: true });
    await expect(
      executeCreatePoDraft({ ...base, client: client(alert()) as never, sb: SB, quantity: "40", unitCost: "" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a non-open alert (409)", async () => {
    await expect(
      executeCreatePoDraft({ ...base, client: client(alert({ status: "acknowledged" })) as never, sb: SB, quantity: "40", unitCost: "" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
