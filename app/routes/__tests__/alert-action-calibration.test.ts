import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import { action } from "../app.alerts.$id";

// Hoisted spies
const { recordApprovalSpy, recordActionFailureSpy, alertsGetSpy, guardrailsGetSpy, executeSpy, clientExecuteSpy, executeReallocateSpendSkuSpy } =
  vi.hoisted(() => ({
    recordApprovalSpy: vi.fn(),
    recordActionFailureSpy: vi.fn(),
    alertsGetSpy: vi.fn(),
    guardrailsGetSpy: vi.fn(),
    executeSpy: vi.fn(),     // executeAction (gateway)
    clientExecuteSpy: vi.fn(), // calderynClient.actions.execute (legacy)
    executeReallocateSpendSkuSpy: vi.fn(),
  }));

// UI stubs
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  const Modal = Object.assign(() => null, { Section: Stub });
  return {
    Badge: Stub,
    BlockStack: Stub,
    Banner: Stub,
    Box: Stub,
    Button: Stub,
    Card: Stub,
    InlineStack: Stub,
    Modal,
    Page: Stub,
    Text: Stub,
    TextField: Stub,
    Tooltip: Stub,
    useBreakpoints: () => ({ smDown: false }),
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));
vi.mock("~/components/calderyn", () => ({
  DetectorTag: () => null,
  EvidencePanel: () => null,
  GuardrailMeter: () => null,
  IMPACT_LABEL: "Impact",
  IMPACT_METHODOLOGY: "",
  NarrativeCard: () => null,
  SeverityBadge: () => null,
}));
vi.mock("../lib/embedded-nav", () => ({ useEmbeddedNavigate: () => () => {} }));

vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: async () => ({ admin: {}, session: { shop: "test.myshopify.com" } }),
  },
}));

vi.mock("~/lib/calderyn.server", () => {
  class CalderynError extends Error {
    code: string;
    status: number;
    constructor(opts: { code: string; status: number; message: string }) {
      super(opts.message);
      this.code = opts.code;
      this.status = opts.status;
    }
  }
  return {
    CalderynError,
    calderynClient: () => ({
      alerts: { get: (...a: unknown[]) => alertsGetSpy(...a) },
      guardrails: { get: (...a: unknown[]) => guardrailsGetSpy(...a) },
      actions: { execute: (...a: unknown[]) => clientExecuteSpy(...a) },
    }),
  };
});

// Mock the calibration approval — this is what we are asserting.
vi.mock("~/lib/calibration/approval.server", () => ({
  recordApproval: (...a: unknown[]) => recordApprovalSpy(...a),
}));
vi.mock("~/lib/calibration/failure.server", () => ({
  recordActionFailure: (...a: unknown[]) => recordActionFailureSpy(...a),
}));

vi.mock("~/lib/actions/execute.server", () => ({
  executeAction: (...a: unknown[]) => executeSpy(...a),
}));
vi.mock("~/lib/actions/reallocate-sku.server", () => ({
  executeReallocateSpendSku: (...a: unknown[]) => executeReallocateSpendSkuSpy(...a),
}));

vi.mock("~/lib/alerts.server", () => ({
  acknowledgeAlert: vi.fn(async () => true),
}));

vi.mock("~/lib/actions/snooze.server", () => ({
  snoozeAlert: vi.fn(async () => {}),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: vi.fn(() => ({})),
  resolveShopId: vi.fn(async () => "shop-uuid-1"),
}));

vi.mock("~/lib/shopify/inventory.server", () => ({
  transferPlanFromEvidence: vi.fn(() => null),
}));
vi.mock("~/lib/demo/showcase.server", () => ({
  inventoryAdjustQuantitiesForShop: vi.fn(async () => ({ operationId: "op-1" })),
}));
vi.mock("~/lib/po/draft.server", () => ({
  buildPoDraft: vi.fn(() => ({})),
  derivePoQuantity: vi.fn(() => 10),
  getCurrentUnitCostCents: vi.fn(async () => null),
}));
vi.mock("~/lib/assistant/action-param", () => ({
  resolveActionParam: vi.fn(() => null),
}));

// A simple open alert that allows pause_campaign and snooze_alert.
const ALERT = {
  id: "alert-cal-1",
  detector_id: "campaign_below_breakeven",
  severity: "high",
  status: "open",
  dollar_impact: 1000, // cents
  claude_rank: 1,
  created_at: "2026-06-20T00:00:00Z",
  title: "Campaign below breakeven",
  narrative: "ROAS has been below breakeven for 7 days.",
  campaign: "Camp A",
  campaign_id: "camp-dim-uuid",
  campaign_external_id: "ext-123",
  sku: null,
  evidence: { campaign_id: "camp-dim-uuid" },
};

function makeRequest(kind: string, alertId = ALERT.id): Request {
  const fd = new FormData();
  fd.set("kind", kind);
  fd.set("alertId", alertId);
  fd.set("idempotencyKey", "test-idem-key-1");
  return new Request(`http://localhost/app/alerts/${alertId}`, {
    method: "POST",
    body: fd,
  });
}

function call(request: Request) {
  return action({ request, params: { id: ALERT.id } } as unknown as ActionFunctionArgs);
}

beforeEach(() => {
  recordApprovalSpy.mockReset();
  recordApprovalSpy.mockResolvedValue(undefined);
  recordActionFailureSpy.mockReset();
  recordActionFailureSpy.mockResolvedValue(undefined);
  alertsGetSpy.mockReset();
  alertsGetSpy.mockResolvedValue(ALERT);
  guardrailsGetSpy.mockReset();
  guardrailsGetSpy.mockResolvedValue({ dollar_cap_cents: 100_000_00 });
  clientExecuteSpy.mockReset();
  clientExecuteSpy.mockResolvedValue({ id: "aud-1", outcome: "succeeded" });
  executeSpy.mockReset();
  executeSpy.mockResolvedValue({ id: "aud-exec-1", outcome: "succeeded" });
  executeReallocateSpendSkuSpy.mockReset();
  executeReallocateSpendSkuSpy.mockResolvedValue({ auditId: "aud-rs-1", outcome: "succeeded", acknowledged: true });
});

describe("alert action — calibration signal fires on approval", () => {
  it("calls recordApproval with detector_id + kind on executeAction success", async () => {
    // pause_campaign with campaign_id in evidence hits the executeAction gateway path.
    const res = await call(makeRequest("pause_campaign"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(recordApprovalSpy).toHaveBeenCalledTimes(1);
    expect(recordApprovalSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      "campaign_below_breakeven",
      "pause_campaign",
      expect.anything(), // supabase client
      // Once-per-audit dedup opts: the succeeded audit id keys the approve
      // ledger so a double-submit never double-bumps alpha.
      expect.objectContaining({ auditId: "aud-exec-1", alertId: ALERT.id }),
    );
  });

  it("does NOT call recordApproval when executeAction outcome is not succeeded", async () => {
    executeSpy.mockResolvedValue({ outcome: "failed" });
    const res = await call(makeRequest("pause_campaign"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });

  it("records a negative failure signal when executeAction outcome is failed (spec §7)", async () => {
    executeSpy.mockResolvedValue({ id: "aud-fail-1", outcome: "failed" });
    await call(makeRequest("pause_campaign"));
    expect(recordActionFailureSpy).toHaveBeenCalledTimes(1);
    expect(recordActionFailureSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      "campaign_below_breakeven",
      "pause_campaign",
      expect.anything(),
      // Once-per-audit dedup: the failed audit id keys the signal so an
      // idempotency replay can never double-bump beta.
      expect.objectContaining({ auditId: "aud-fail-1", alertId: ALERT.id }),
    );
  });

  it("does NOT record a failure signal for a transient retrying outcome", async () => {
    executeSpy.mockResolvedValue({ outcome: "retrying" });
    await call(makeRequest("pause_campaign"));
    expect(recordActionFailureSpy).not.toHaveBeenCalled();
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });

  it("records a failure signal on the reallocate_spend_sku gateway path when the executor fails", async () => {
    alertsGetSpy.mockResolvedValue({
      ...ALERT,
      detector_id: "ad_tax_overload",
      campaign_id: null,
      campaign_external_id: null,
      evidence: {},
    });
    executeReallocateSpendSkuSpy.mockResolvedValue({ auditId: "aud-rs-1", outcome: "failed", acknowledged: false });
    await call(makeRequest("reallocate_spend_sku"));
    expect(recordActionFailureSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      "ad_tax_overload",
      "reallocate_spend_sku",
      expect.anything(),
      expect.objectContaining({ auditId: "aud-rs-1", alertId: ALERT.id }),
    );
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });

  it("does NOT phantom-succeed for a kind with no wired executor (rule 12)", async () => {
    // raise_free_ship_threshold has no executor. The legacy recorder must NOT
    // write outcome:"succeeded" or acknowledge the alert for it — that would be a
    // phantom success. free_shipping_leakage allows the kind (DETECTOR_TO_ACTIONS).
    alertsGetSpy.mockResolvedValue({
      ...ALERT,
      detector_id: "free_shipping_leakage",
      campaign_id: null,
      campaign_external_id: null,
      evidence: {},
    });
    const res = await call(makeRequest("raise_free_ship_threshold"));
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    // No fake audit row written, no approval signal recorded.
    expect(clientExecuteSpy).not.toHaveBeenCalled();
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });

  it("scales budget through executeAction (not the legacy recorder) for increase_campaign_budget", async () => {
    // campaign_scaling_opportunity allows increase_campaign_budget; evidence carries
    // the current daily budget + the engine's suggested increase percent.
    alertsGetSpy.mockResolvedValue({
      ...ALERT,
      detector_id: "campaign_scaling_opportunity",
      campaign_id: "camp-dim-uuid",
      // REAL evidence shape: campaign_scaling_opportunity carries the budget as
      // daily_budget_usd (dollars), matching loadScaleOpportunity — NOT *_cents.
      evidence: { campaign_id: "camp-dim-uuid", daily_budget_usd: 100, increase_pct: 25 },
    });
    const res = await call(makeRequest("increase_campaign_budget"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      expect.objectContaining({
        kind: "increase_campaign_budget",
        campaignId: "camp-dim-uuid",
        dailyBudgetCents: 12500, // $100 → 10000c → * (1 + 25/100)
      }),
      expect.anything(),
    );
    // Must NOT fall to the phantom recorder.
    expect(clientExecuteSpy).not.toHaveBeenCalled();
  });

  it("does NOT apply the per-action dollar cap to increase_campaign_budget (upside, not risk)", async () => {
    // dollar_impact is the projected UPSIDE for a scaling alert, not downside
    // risk; an upside well above the cap must still execute, not 403.
    alertsGetSpy.mockResolvedValue({
      ...ALERT,
      detector_id: "campaign_scaling_opportunity",
      campaign_id: "camp-dim-uuid",
      dollar_impact: 500_000_00, // $500k upside, far above the $100k cap
      evidence: { campaign_id: "camp-dim-uuid", daily_budget_usd: 100, increase_pct: 20 },
    });
    const res = await call(makeRequest("increase_campaign_budget"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true); // not GUARDRAIL_DOLLAR_CAP 403
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("resumes a campaign through executeAction and records approval for sku_stockout_cleared (Slice B warm-up)", async () => {
    // A merchant approving the resume suggestion must execute resume_campaign AND
    // record the approval, so the (sku_stockout_cleared, resume_campaign) pair can
    // accrue clean approvals toward graduation. campaign_id comes from evidence.
    alertsGetSpy.mockResolvedValue({
      ...ALERT,
      detector_id: "sku_stockout_cleared",
      campaign_id: "camp-dim-uuid",
      dollar_impact: 5000, // cents; recovered upside, well under the cap
      evidence: { campaign_id: "camp-dim-uuid" },
    });
    const res = await call(makeRequest("resume_campaign"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      expect.objectContaining({ kind: "resume_campaign", campaignId: "camp-dim-uuid" }),
      expect.anything(),
    );
    expect(recordApprovalSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      "sku_stockout_cleared",
      "resume_campaign",
      expect.anything(),
      expect.objectContaining({ auditId: "aud-exec-1", alertId: ALERT.id }),
    );
    // Resume is upside, not downside — the legacy phantom recorder must not run.
    expect(clientExecuteSpy).not.toHaveBeenCalled();
  });

  it("does NOT 403 a high-recovered-value resume on the per-action dollar cap (upside, not risk)", async () => {
    alertsGetSpy.mockResolvedValue({
      ...ALERT,
      detector_id: "sku_stockout_cleared",
      campaign_id: "camp-dim-uuid",
      dollar_impact: 500_000_00, // far above the $100k cap
      evidence: { campaign_id: "camp-dim-uuid" },
    });
    const res = await call(makeRequest("resume_campaign"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT call recordApproval for snooze_alert", async () => {
    // snooze_alert is in DETECTOR_TO_ACTIONS for every detector; allow it here.
    const alertWithSnooze = {
      ...ALERT,
      detector_id: "campaign_below_breakeven",
      evidence: {}, // no campaign_id -> legacy path
      campaign_id: null,
    };
    alertsGetSpy.mockResolvedValue(alertWithSnooze);
    const res = await call(makeRequest("snooze_alert"));
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });

  it("calls recordApproval on the reallocate_spend_sku early-return path", async () => {
    const alertWithSkuBudgetMove = {
      ...ALERT,
      detector_id: "ad_tax_overload",
      campaign_id: null,
      campaign_external_id: null,
      evidence: {},
    };
    alertsGetSpy.mockResolvedValue(alertWithSkuBudgetMove);

    const res = await call(makeRequest("reallocate_spend_sku"));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(recordApprovalSpy).toHaveBeenCalledTimes(1);
    expect(recordApprovalSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      "ad_tax_overload",
      "reallocate_spend_sku",
      expect.anything(),
      expect.objectContaining({ auditId: "aud-rs-1", alertId: ALERT.id }),
    );
  });
});
