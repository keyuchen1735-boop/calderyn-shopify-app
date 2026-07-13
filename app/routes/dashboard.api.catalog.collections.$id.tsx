import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { updateCollection, deleteCollection } from "~/lib/catalog/catalog.server";

/**
 * Single-collection writes: PUT { title } renames (the handle never changes, so
 * storefront links stay stable); DELETE removes the collection and its
 * memberships — products themselves are untouched. Both are shop-scoped through
 * the server fns, which 404 (collection_not_found) on a foreign/missing id.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  const id = String(params.id);

  if (request.method === "DELETE") {
    return dashboardJson(async () => {
      await deleteCollection(session.shopId, id);
      return { ok: true };
    });
  }
  if (request.method === "PUT") {
    let body: { title?: unknown };
    try { body = (await request.json()) as { title?: unknown }; } catch { return jsonError(422, "invalid_json"); }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return jsonError(422, "missing_title");
    return dashboardJson(async () => {
      await updateCollection(session.shopId, id, title);
      return { ok: true };
    });
  }
  return jsonError(405, "method_not_allowed");
}
