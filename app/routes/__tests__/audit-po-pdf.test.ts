import { describe, it, expect, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
// Importing the shared chain mock also registers its beforeEach state reset.
import { setSupabaseResponse } from "../../lib/__tests__/_supabase_chain_mock";
import { loader } from "../app.audit.$id.po[.]pdf";

vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: async () => ({ admin: {}, session: { shop: "peak-pine.myshopify.com" } }),
  },
}));

vi.mock("~/lib/supabase.server", async () => {
  const { buildChain } = await import("../../lib/__tests__/_supabase_chain_mock");
  return {
    getSupabase: () => buildChain(),
    resolveShopId: vi.fn(async () => "shop-uuid-1"),
  };
});

const PO = {
  po_number: "PO-20260609-0F3B2A1C",
  issued_at: "2026-06-09T12:00:00.000Z",
  shop_domain: "peak-pine.myshopify.com",
  alert_id: "0f3b2a1c-9d8e-4f00-aaaa-bbbbccccdddd",
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
};

const AUDIT_ROW = {
  id: "aud-po-1",
  action_kind: "create_po_draft",
  params: { po: PO },
};

function call(id = "aud-po-1") {
  return loader({
    request: new Request(`http://localhost/app/audit/${id}/po.pdf`),
    params: { id },
    context: {},
  } as unknown as LoaderFunctionArgs);
}

describe("GET /app/audit/:id/po.pdf", () => {
  it("re-renders the snapshotted PO as a downloadable PDF", async () => {
    setSupabaseResponse({ data: AUDIT_ROW, error: null });

    const res = (await call()) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="PO-20260609-0F3B2A1C.pdf"',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("404s when no audit row matches this shop and id", async () => {
    setSupabaseResponse({ data: null, error: null });
    await expect(call("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("404s when the row is not a create_po_draft action", async () => {
    setSupabaseResponse({
      data: { ...AUDIT_ROW, action_kind: "pause_campaign" },
      error: null,
    });
    await expect(call()).rejects.toMatchObject({ status: 404 });
  });

  it("404s when a create_po_draft row has no PO snapshot (legacy rows)", async () => {
    setSupabaseResponse({
      data: { ...AUDIT_ROW, params: { target: "WND-BRK-S" } },
      error: null,
    });
    await expect(call()).rejects.toMatchObject({ status: 404 });
  });
});
