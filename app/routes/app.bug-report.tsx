// app/routes/app.bug-report.tsx
// Resource route (no UI): backend for the embedded "Report a bug" launcher.
// POST multipart form-data { description, email, screen, screenshots[] }.
import type { ActionFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { authenticate } from "../shopify.server";
import { parseBugReportForm, submitBugReport } from "~/lib/bug-report/submit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = await parseBugReportForm(form, {
    shopDomain: session.shop,
    surface: "app",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!parsed.ok) {
    return json({ error: { code: parsed.code, message: parsed.message } }, { status: 422 });
  }
  const result = await submitBugReport(parsed.value);
  return json({ ok: true, emailStatus: result.emailStatus });
};
