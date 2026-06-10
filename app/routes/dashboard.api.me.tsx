import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const onboarding = await calderynClient(session.shopDomain).onboarding.getState();
    return { shop_domain: session.shopDomain, onboarding };
  });
}
