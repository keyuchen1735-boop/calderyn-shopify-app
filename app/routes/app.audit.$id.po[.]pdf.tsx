// Resource route: GET /app/audit/:id/po.pdf
// Re-renders the PO draft PDF from the PoDraft snapshot in
// action_audit.params.po — no blob storage, reproducible forever.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import type { PoDraft } from "~/lib/po/draft.server";
import { renderPoPdf } from "~/lib/po/pdf.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);

  const { data, error } = await getSupabase()
    .from("action_audit")
    .select("id, action_kind, params")
    .eq("id", params.id!)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;

  const po = (data?.params as { po?: PoDraft } | null)?.po;
  if (!data || data.action_kind !== "create_po_draft" || !po) {
    throw new Response("Not found", { status: 404 });
  }

  const bytes = await renderPoPdf(po);
  // Copy: pdf-lib types its output as Uint8Array<ArrayBufferLike>, which is
  // not a valid BodyInit; the copy constructor yields an ArrayBuffer-backed view.
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${po.po_number}.pdf"`,
    },
  });
};
