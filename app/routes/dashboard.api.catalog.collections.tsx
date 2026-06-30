import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listCollections, createCollection } from "~/lib/catalog/catalog.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ collections: await listCollections(session.shopId) }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: { title?: unknown };
  try { body = (await request.json()) as { title?: unknown }; } catch { return jsonError(422, "invalid_json"); }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return jsonError(422, "missing_title");
  return dashboardJson(() => createCollection(session.shopId, title));
}
