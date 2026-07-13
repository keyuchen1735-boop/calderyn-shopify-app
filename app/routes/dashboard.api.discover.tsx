// app/routes/dashboard.api.discover.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listDiscoverFeed, pickProduct } from "~/lib/sourcing/discover.server";
import { quotaTrusted } from "~/lib/ai-quota.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireDashboardSession(request); // auth gate; the feed is global reference data
  return dashboardJson(async () => ({ items: await listDiscoverFeed(40) }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request); // throws a 403 Response on a cross-origin post
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as
    | { action?: string; sourceProductId?: string }
    | null;
  if (body?.action !== "pick" || !body.sourceProductId) {
    return jsonError(422, "bad_request", "pick requires sourceProductId");
  }

  return dashboardJson(async () => pickProduct(session.shopId, body.sourceProductId!, { trusted: quotaTrusted(session) }));
}
