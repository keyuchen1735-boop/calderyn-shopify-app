// Lightweight session probe for the verification gate: the verify-needed page
// polls this until the email is confirmed (possibly from another device/tab)
// and then advances itself. Deliberately uses the allow-unverified session read
// — requireDashboardSession would 403 exactly the callers this exists for.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { getDashboardSessionAllowUnverified } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getDashboardSessionAllowUnverified(request);
  return dashboardJson(async () => ({ verified: session.emailVerified }));
}
