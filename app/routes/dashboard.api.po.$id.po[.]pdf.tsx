// GET /dashboard/api/po/:id/po.pdf → renders a REAL purchase order as a PDF by
// mapping it into the shared renderer's shape (renderPoPdf). Sibling of the
// audit-snapshot route (dashboard.api.audit.$id.po[.]pdf.tsx), which keeps
// serving the legacy Autopilot drafts. Shop-scoped via the session; a
// cross-shop or unknown id 404s.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { getPurchaseOrder, type PoStatus } from "~/lib/po/purchase-orders.server";
import { renderPoPdf, type PoPdfData } from "~/lib/po/pdf.server";

const STATUS_LABELS: Record<PoStatus, string> = {
  draft: "Draft",
  ordered: "Ordered",
  partial: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);

  let detail;
  try {
    detail = await getPurchaseOrder(session.shopId, params.id ?? "");
  } catch (err) {
    if (err instanceof CalderynError && err.status === 404) {
      throw new Response("Not found", { status: 404 });
    }
    throw err;
  }

  // Buyer label: the shop domain for imported shops, the sign-up display name
  // for native ones (their shop_domain is null).
  let buyer = session.shopDomain ?? "";
  if (!buyer) {
    const { data, error } = await getSupabase()
      .from("shops")
      .select("display_name")
      .eq("id", session.shopId)
      .maybeSingle();
    if (error) throw error;
    buyer = typeof data?.display_name === "string" && data.display_name.trim()
      ? data.display_name.trim()
      : "Your store";
  }

  const pdfData: PoPdfData = {
    po_number: detail.poNumber,
    issued_at: detail.orderedAt ?? detail.createdAt,
    shop_domain: buyer,
    lines: detail.lines.map((line) => ({
      // The sku/title snapshots survive variant deletion (variantId null).
      sku: line.sku ?? line.variantId?.slice(0, 8).toUpperCase() ?? "—",
      title: line.title ?? line.sku ?? "Item",
      quantity: line.qtyOrdered,
      unit_cost_cents: line.unitCostCents,
    })),
    subtotal_cents: detail.totalCents,
    total_cents: detail.totalCents,
    supplier_name: detail.supplierName,
    status_label: STATUS_LABELS[detail.status],
    expected_at: detail.expectedAt,
    notes: detail.notes,
  };

  const bytes = await renderPoPdf(pdfData);
  // pdf-lib types its output as Uint8Array<ArrayBufferLike>, not a valid BodyInit;
  // the copy constructor yields an ArrayBuffer-backed view.
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${detail.poNumber}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
