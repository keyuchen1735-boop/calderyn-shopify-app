// app/routes/dashboard.api.bug-report.tsx
// POST multipart form-data { description, email, screen, screenshots[] } -> files
// the bug report (email + durable row). Dashboard cookie auth + same-origin CSRF
// guard, mirroring dashboard.api.assistant.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { parseBugReportForm, submitBugReport } from "~/lib/bug-report/submit.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(422, "invalid_form");
  }

  const parsed = await parseBugReportForm(form, {
    shopDomain: session.shopDomain ?? session.shopId,
    surface: "dashboard",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!parsed.ok) return jsonError(422, parsed.code.toLowerCase(), parsed.message);

  return dashboardJson(async () => {
    const result = await submitBugReport(parsed.value);
    return { ok: true, id: result.id, email_status: result.emailStatus };
  });
}
