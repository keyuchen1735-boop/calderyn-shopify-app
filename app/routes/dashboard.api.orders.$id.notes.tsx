import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, nativeOrderExists, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { isValidNoteBody, resolveAuthorEmail } from "~/lib/order/notes.server";
import { getSupabase } from "~/lib/supabase.server";

/** Staff note on a native order's timeline (Task 10). Native only — imported orders are read-only. */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be annotated here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  if (!isValidNoteBody(body.body)) {
    return jsonError(422, "invalid_note", "body must be between 1 and 2000 characters.");
  }
  const noteBody = body.body;

  return dashboardJson(async () => {
    const sb = getSupabase();
    if (!(await nativeOrderExists(session.shopId, orderId, sb))) {
      throw jsonError(404, "order_not_found");
    }

    const authorEmail = await resolveAuthorEmail(sb, session.userId);
    const ins = await sb
      .from("order_note")
      .insert({ shop_id: session.shopId, order_id: orderId, author_email: authorEmail, body: noteBody })
      .select("id")
      .single();
    if (ins.error) throw ins.error;
    return { note_id: String((ins.data as Record<string, unknown>).id) };
  });
}
