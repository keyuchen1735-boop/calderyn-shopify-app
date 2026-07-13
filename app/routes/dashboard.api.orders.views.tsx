// Saved order-list views (Phase 2 Task 2): GET list / POST create / DELETE ?id= against the
// order_view table via app/lib/order/views.server.ts. Writes go through requireSameOrigin +
// body/param validation at the boundary, same convention as the other orders API routes.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  createOrderView,
  deleteOrderView,
  listOrderViews,
  TooManyViewsError,
  ViewNameTakenError,
} from "~/lib/order/views.server";
import { isValidViewFilters } from "~/lib/order/view-filters";
import { isUuid } from "~/lib/ids";

const MAX_NAME_LENGTH = 60;

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ views: await listOrderViews(session.shopId) }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  if (request.method === "DELETE") {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!isUuid(id)) return jsonError(422, "invalid_id", "id must be a uuid.");
    return dashboardJson(async () => {
      const deleted = await deleteOrderView(session.shopId, id);
      if (!deleted) throw jsonError(404, "view_not_found");
      return { deleted: true };
    });
  }

  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    return jsonError(422, "invalid_name", `name must be 1-${MAX_NAME_LENGTH} characters.`);
  }

  const filters = isValidViewFilters(body.filters);
  if (!filters) {
    return jsonError(422, "invalid_filters", "filters must be a flat object of known keys with primitive/array-of-string values.");
  }

  return dashboardJson(async () => {
    try {
      const view = await createOrderView(session.shopId, name, filters);
      return { view };
    } catch (err) {
      if (err instanceof TooManyViewsError) throw jsonError(422, "too_many_views", err.message);
      if (err instanceof ViewNameTakenError) throw jsonError(409, "view_name_taken", err.message);
      throw err;
    }
  });
}
