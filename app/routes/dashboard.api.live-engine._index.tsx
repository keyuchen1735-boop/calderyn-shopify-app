// GET → LiveEnginePageData (autopilot features + money, engine pipeline, live
// trace, predictions, calibration headline). Dashboard mirror of the embedded
// app.engine loader: both call the same shared builder so the contract cannot
// drift. Auth via requireDashboardSession (shop from the session, never the
// request). Read-only.
import type { LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { buildLiveEnginePageData } from "~/lib/calibration/live-engine-page.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopId);
    return buildLiveEnginePageData(client, request.signal);
  });
}
