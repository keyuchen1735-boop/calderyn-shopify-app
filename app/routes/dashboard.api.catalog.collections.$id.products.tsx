import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  listCollectionProducts,
  addProductToCollection,
  removeProductFromCollection,
} from "~/lib/catalog/catalog.server";
import { signMediaPaths } from "~/lib/catalog/sign-media.server";

/**
 * Collection membership. GET lists the members with batch-signed thumbnail
 * URLs (private bucket — same signing lane as the catalog list); POST adds a
 * product, DELETE removes one. Ownership is checked on BOTH the collection and
 * the product inside the server fns (404 collection_not_found /
 * product_not_found), so tenancy never rides the request body.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const members = await listCollectionProducts(session.shopId, id);
    const signed = await signMediaPaths(
      members.map((m) => m.primaryImagePath).filter((p): p is string => Boolean(p)),
    );
    return {
      products: members.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        imageUrl: m.primaryImagePath ? signed.get(m.primaryImagePath) ?? null : null,
      })),
    };
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  const id = String(params.id);

  if (request.method !== "POST" && request.method !== "DELETE") {
    return jsonError(405, "method_not_allowed");
  }
  let body: { productId?: unknown };
  try { body = (await request.json()) as { productId?: unknown }; } catch { return jsonError(422, "invalid_json"); }
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) return jsonError(422, "missing_product");

  const method = request.method;
  return dashboardJson(async () => {
    if (method === "POST") await addProductToCollection(session.shopId, id, productId);
    else await removeProductFromCollection(session.shopId, id, productId);
    return { ok: true };
  });
}
