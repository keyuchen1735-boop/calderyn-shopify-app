// GET /dashboard/api/audit/:id/po.pdf → renders the PO draft snapshotted in the
// action_audit row as a PDF. Dashboard twin of app.audit.$id.po[.]pdf.tsx; the
// only difference is the auth boundary (requireDashboardSession, which already
// carries the shop_id) — the row is shop-scoped, so a cross-shop id 404s.

import type { LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { getSupabase } from "~/lib/supabase.server";
import { renderPoPdf } from "~/lib/po/pdf.server";
import type { PoDraft } from "~/lib/po/draft.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);

  const { data, error } = await getSupabase()
    .from("action_audit")
    .select("id, action_kind, params")
    .eq("id", params.id!)
    .eq("shop_id", session.shopId)
    .maybeSingle();
  if (error) throw error;

  const po = (data?.params as { po?: PoDraft } | null)?.po;
  if (!data || data.action_kind !== "create_po_draft" || !po) {
    throw new Response("Not found", { status: 404 });
  }

  const bytes = await renderPoPdf(po);
  // pdf-lib types its output as Uint8Array<ArrayBufferLike>, not a valid BodyInit;
  // the copy constructor yields an ArrayBuffer-backed view.
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${po.po_number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
