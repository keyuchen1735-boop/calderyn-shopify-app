import type { ActionFunctionArgs } from "@remix-run/node";
import { dashboardJson, jsonError, parseJsonObjectBody, rateLimit } from "~/lib/dashboard/http.server";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import { buildCatalogRoutingEvidence } from "~/lib/storefront-bundle/routing-evidence.server";
import { parseStoreDesignRequest, resolveStoreDesign } from "~/lib/storefront-bundle/routing";

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  if (!(await rateLimit(`store-design-resolve:${session.shopId}`, 30, 60_000))) {
    return jsonError(429, "rate_limited");
  }
  const body = await parseJsonObjectBody(request);
  const parsed = parseStoreDesignRequest(body, STORE_TEMPLATE_REGISTRY);
  if (!parsed.ok) return jsonError(422, parsed.error);
  return dashboardJson(async () => {
    const evidence = await buildCatalogRoutingEvidence(session.shopId);
    return resolveStoreDesign(parsed.value, evidence, STORE_TEMPLATE_REGISTRY);
  });
}
