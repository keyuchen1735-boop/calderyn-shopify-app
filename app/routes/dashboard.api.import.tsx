import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { latestImport, startImport, kickDrainSoon } from "~/lib/import/run.server";

// GET: the latest import run for the signed-in shop (dashboard poll).
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ run: await latestImport(session.shopId) }));
}

// POST: start an import for the signed-in shop (idempotent — returns the in-progress
// run if one already exists). The drain is nudged to run right away; the cron
// tick remains the guarantee for the pull + promote.
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  return dashboardJson(async () => {
    const run = await startImport(session.shopId);
    await kickDrainSoon();
    return run;
  });
}
