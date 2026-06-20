import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
// Importing the shared chain mock also registers its beforeEach state reset.
import {
  setSupabaseResponse,
  setSupabaseResponses,
  getRecorded,
} from "../../lib/__tests__/_supabase_chain_mock";
import { action, loader } from "../app.alerts.$id";

// Spies for the boundaries; the real route `action` logic runs against them.
const { executeSpy, alertsGetSpy, guardrailsGetSpy } = vi.hoisted(() => ({
  executeSpy: vi.fn(),
  alertsGetSpy: vi.fn(),
  guardrailsGetSpy: vi.fn(),
}));

// Stub Polaris so importing the route module doesn't pull the real UI lib.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  const Modal = Object.assign(() => null, { Section: Stub });
  return {
    Badge: Stub,
    BlockStack: Stub,
    Banner: Stub,
    Button: Stub,
    Card: Stub,
    InlineStack: Stub,
    Layout: Stub,
    Modal,
    Page: Stub,
    Text: Stub,
    TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));
vi.mock("~/components/calderyn", () => ({
  DetectorTag: () => null,
  EvidencePanel: () => null,
  GuardrailMeter: () => null,
  NarrativeCard: () => null,
  SeverityBadge: () => null,
}));

vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: async () => ({ admin: {}, session: { shop: "peak-pine.myshopify.com" } }),
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
      actions: { execute: (...a: unknown[]) => executeSpy(...a) },
    }),
  };
});

vi.mock("~/lib/actions/execute.server", () => ({
  executeAction: vi.fn(),
}));
vi.mock("~/lib/supabase.server", async () => {
  const { buildChain } = await import("../../lib/__tests__/_supabase_chain_mock");
  return {
    getSupabase: () => buildChain(),
    resolveShopId: vi.fn(async () => "shop-uuid-1"),
  };
});
vi.mock("~/lib/shopify/inventory.server", () => ({
  inventoryAdjustQuantities: vi.fn(),
}));

const ALERT = {
  id: "0f3b2a1c-9d8e-4f00-aaaa-bbbbccccdddd",
  detector_id: "reorder_timing",
  severity: "high",
  status: "open",
  dollar_impact: 412_00,
  claude_rank: 1,
  created_at: "2026-06-08T12:00:00Z",
  title: "Reorder window is closing",
  narrative: "Lead time exceeds cover.",
  campaign: null,
  sku: "WND-BRK-S",
  evidence: {
    days_of_cover: "4.0",
    lead_time_days: 14,
    gap_days: "10.0",
    daily_velocity_units: "5.71",
    unit_margin_usd: "18.20",
    title: "Trailhead Windbreaker — S",
  },
};

function poRequest(fields: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.set("kind", "create_po_draft");
  fd.set("alertId", ALERT.id);
  fd.set("idempotencyKey", "k-po-1");
  fd.set("po_quantity", "120");
  fd.set("po_unit_cost", "23.50");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request(`http://localhost/app/alerts/${ALERT.id}`, {
    method: "POST",
    body: fd,
  });
}

function call(request: Request) {
  return action({ request, params: { id: ALERT.id } } as unknown as ActionFunctionArgs);
}

beforeEach(() => {
  executeSpy.mockReset();
  alertsGetSpy.mockReset();
  guardrailsGetSpy.mockReset();
  alertsGetSpy.mockResolvedValue(ALERT);
  guardrailsGetSpy.mockResolvedValue({ dollar_cap_cents: 10_000_00 });
  executeSpy.mockResolvedValue({ id: "aud-po-1", outcome: "succeeded" });
});

describe("alert action — create_po_draft snapshots the PO into the audit params", () => {
  it("builds the PO from the alert + submitted qty/price and records it", async () => {
    const res = await call(poRequest());
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        alertId: ALERT.id,
        kind: "create_po_draft",
        idempotencyKey: "k-po-1",
        params: expect.objectContaining({
          target: "WND-BRK-S",
          po: expect.objectContaining({
            po_number: expect.stringMatching(/^PO-\d{8}-0F3B2A1C$/),
            shop_domain: "peak-pine.myshopify.com",
            alert_id: ALERT.id,
            detector_id: "reorder_timing",
            lines: [
              {
                sku: "WND-BRK-S",
                title: "Trailhead Windbreaker — S",
                quantity: 120,
                unit_cost_cents: 2350,
              },
            ],
            subtotal_cents: 282_000,
            total_cents: 282_000,
          }),
        }),
      }),
    );
  });

  it("treats a blank unit cost as TBD (null), not $0", async () => {
    const res = await call(poRequest({ po_unit_cost: "" }));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    const params = (executeSpy.mock.calls[0][0] as { params: { po: Record<string, unknown> } })
      .params;
    expect((params.po.lines as Array<Record<string, unknown>>)[0].unit_cost_cents).toBeNull();
    expect(params.po.total_cents).toBeNull();
  });

  it("rejects a non-positive or non-integer quantity with 422 and records nothing", async () => {
    for (const bad of ["0", "-5", "12.5", "abc", ""]) {
      executeSpy.mockClear();
      const res = await call(poRequest({ po_quantity: bad }));
      expect(res.status).toBe(422);
      expect(executeSpy).not.toHaveBeenCalled();
    }
  });

  it("rejects an absurdly large quantity with 422 and records nothing", async () => {
    const res = await call(poRequest({ po_quantity: "1000001" }));
    expect(res.status).toBe(422);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("rejects a negative unit cost with 422 and records nothing", async () => {
    const res = await call(poRequest({ po_unit_cost: "-1" }));
    expect(res.status).toBe(422);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("alert action — reallocate_budget guard", () => {
  const AD_TAX_ALERT = {
    ...ALERT,
    detector_id: "ad_tax_overload",
    sku: null,
    campaign: "camp-abc",
    evidence: {},
  };

  it("returns 400 UNSUPPORTED_HERE for reallocate_budget on the alert page", async () => {
    alertsGetSpy.mockResolvedValue(AD_TAX_ALERT);
    const fd = new FormData();
    fd.set("kind", "reallocate_budget");
    fd.set("alertId", AD_TAX_ALERT.id);
    const req = new Request(`http://localhost/app/alerts/${AD_TAX_ALERT.id}`, {
      method: "POST",
      body: fd,
    });
    const res = await call(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNSUPPORTED_HERE");
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("alert action — acknowledges the alert after success", () => {
  it("flips the alert open → acknowledged after a successful execution", async () => {
    const res = await call(poRequest());
    const body = (await res.json()) as { ok: boolean; toast: { message: string } };

    expect(body.ok).toBe(true);
    expect(body.toast.message).toBe("Created PO draft executed");
    expect(getRecorded("from")).toContainEqual(["alerts"]);
    expect(getRecorded("update")).toContainEqual([{ status: "acknowledged" }]);
    expect(getRecorded("eq")).toEqual(
      expect.arrayContaining([
        ["shop_id", "shop-uuid-1"],
        ["id", ALERT.id],
      ]),
    );
    // acknowledge matches open OR a re-surfaced (lapsed) snooze.
    expect(getRecorded("in")).toContainEqual(["status", ["open", "snoozed"]]);
  });

  it("surfaces an acknowledge failure in the toast without failing the action", async () => {
    // The action hits TWO Supabase calls in sequence:
    //   1. resolveSkuForDiscontinue — maybeSingle() on sku_dim (the Phase 2 gate)
    //   2. acknowledgeAlert         — .then() on the alerts UPDATE
    // setSupabaseResponse() is too coarse — it returns the same error for BOTH,
    // causing the gate to throw and the action to return ok:false before it ever
    // reaches the acknowledge path.  Use the queue form so the gate gets a valid
    // unflagged-SKU result (passes) and only the acknowledge UPDATE sees the error.
    setSupabaseResponses([
      // sku_dim SELECT (gate): SKU exists, not discontinued → gate passes.
      { data: { id: "sku-1", product_id: "gid://shopify/Product/1", do_not_reorder: false }, error: null },
      // alerts UPDATE (acknowledge): simulate a DB error — the action must still
      // return ok:true and surface the failure in the toast message.
      { data: null, error: { message: "update blew up" } },
    ]);
    const res = await call(poRequest());
    const body = (await res.json()) as { ok: boolean; toast: { message: string } };

    expect(body.ok).toBe(true);
    expect(body.toast.message).toContain("alert couldn't be acknowledged");
  });

  it("does not acknowledge when the action is rejected", async () => {
    await call(poRequest({ po_quantity: "0" }));
    expect(getRecorded("update")).toEqual([]);
  });

  it("snoozes instead of acknowledging — defers the alert without resolving it", async () => {
    const fd = new FormData();
    fd.set("kind", "snooze_alert");
    fd.set("alertId", ALERT.id);
    fd.set("idempotencyKey", "k-snooze-1");
    const res = await call(
      new Request(`http://localhost/app/alerts/${ALERT.id}`, { method: "POST", body: fd }),
    );
    const body = (await res.json()) as { ok: boolean; toast: { message: string } };

    expect(body.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(body.toast.message).toBe("Snoozed alert executed");
    // Hides the alert (status -> snoozed + deadline), guarded on still-open;
    // never flips it to acknowledged/resolved.
    expect(getRecorded("update")).toContainEqual([
      expect.objectContaining({ status: "snoozed", snoozed_until: expect.any(String) }),
    ]);
    expect(getRecorded("update")).not.toContainEqual([{ status: "acknowledged" }]);
    expect(getRecorded("eq")).toEqual(
      expect.arrayContaining([
        ["shop_id", "shop-uuid-1"],
        ["id", ALERT.id],
      ]),
    );
    expect(getRecorded("in")).toContainEqual(["status", ["open", "snoozed"]]);
  });
});

describe("alert loader — duplicate PO draft warning", () => {
  function loaderCall() {
    return loader({
      request: new Request(`http://localhost/app/alerts/${ALERT.id}`),
      params: { id: ALERT.id },
    } as unknown as LoaderFunctionArgs);
  }

  it("warns when a successful draft exists", async () => {
    setSupabaseResponses([
      { data: null, error: null }, // sku_dim lookup (getCurrentUnitCostCents) misses
      { data: [{ id: "d1", undo_of: null }], error: null },
    ]);
    const body = (await (await loaderCall()).json()) as { existingPoDraft: boolean };
    expect(body.existingPoDraft).toBe(true);
  });

  it("suppresses the warning when the only draft was undone", async () => {
    setSupabaseResponses([
      { data: null, error: null }, // sku_dim lookup misses
      {
        // The undo row shares the original's action_kind with undo_of
        // pointing back at it — the original is no longer an active draft.
        data: [
          { id: "d1", undo_of: null },
          { id: "u1", undo_of: "d1" },
        ],
        error: null,
      },
    ]);
    const body = (await (await loaderCall()).json()) as { existingPoDraft: boolean };
    expect(body.existingPoDraft).toBe(false);
  });
});
