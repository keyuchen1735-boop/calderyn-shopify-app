import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { enrichRemediation } from "~/lib/remediation/enrich.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const raw = await calderynClient(session.shopDomain).alerts.get(String(params.id));
    // Enrich only on the detail read (lists skip it — per architecture seam).
    // Best-effort: enrichRemediation self-falls-back to advisory on any DB error.
    if (raw.remediation) {
      raw.remediation = await enrichRemediation(raw, raw.remediation, getSupabase(), session.shopId);
    }
    return { alert: raw };
  });
}
