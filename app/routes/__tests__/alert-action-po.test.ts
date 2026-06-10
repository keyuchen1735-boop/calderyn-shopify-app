import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import { action } from "../app.alerts.$id";

// Spies for the boundaries; the real route `action` logic runs against them.
const { executeSpy, alertsGetSpy, guardrailsGetSpy, supabaseState } = vi.hoisted(() => ({
  executeSpy: vi.fn(),
  alertsGetSpy: vi.fn(),
  guardrailsGetSpy: vi.fn(),
  // Chainable Supabase stub state: records builder calls (for the
  // acknowledge-after-success assertions) and resolves with `response`.
  supabaseState: {
    calls: [] as Array<[string, ...unknown[]]>,
    response: { data: null as unknown, error: null as unknown },
  },
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
vi.mock("~/lib/supabase.server", () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "update", "select", "eq", "is", "limit"]) {
      c[m] = (...args: unknown[]) => {
        supabaseState.calls.push([m, ...args]);
        return c;
      };
    }
    // Awaiting the builder resolves with the queued response.
    c.then = (resolve: (v: unknown) => unknown) => resolve(supabaseState.response);
    return c;
  };
  return {
    getSupabase: () => chain(),
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
  supabaseState.calls = [];
  supabaseState.response = { data: null, error: null };
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

describe("alert action — acknowledges the alert after success", () => {
  it("flips the alert open → acknowledged after a successful execution", async () => {
    const res = await call(poRequest());
    const body = (await res.json()) as { ok: boolean; toast: { message: string } };

    expect(body.ok).toBe(true);
    expect(body.toast.message).toBe("Created PO draft executed");
    expect(supabaseState.calls).toEqual(
      expect.arrayContaining([
        ["from", "alerts"],
        ["update", { status: "acknowledged" }],
        ["eq", "shop_id", "shop-uuid-1"],
        ["eq", "id", ALERT.id],
        ["eq", "status", "open"],
      ]),
    );
  });

  it("surfaces an acknowledge failure in the toast without failing the action", async () => {
    supabaseState.response = { data: null, error: { message: "update blew up" } };
    const res = await call(poRequest());
    const body = (await res.json()) as { ok: boolean; toast: { message: string } };

    expect(body.ok).toBe(true);
    expect(body.toast.message).toContain("alert couldn't be acknowledged");
  });

  it("does not acknowledge when the action is rejected", async () => {
    await call(poRequest({ po_quantity: "0" }));
    expect(supabaseState.calls).not.toEqual(
      expect.arrayContaining([["update", { status: "acknowledged" }]]),
    );
  });
});
