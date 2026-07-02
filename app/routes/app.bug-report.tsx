// app/routes/app.bug-report.tsx
// Resource route (no UI): backend for the embedded "Report a bug" launcher.
// POST multipart form-data { description, email, screen, screenshots[] }.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { rateLimit } from "~/lib/rate-limit.server";
import { parseBugReportForm, submitBugReport } from "~/lib/bug-report/submit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // One email + screenshot upload per submit; cap per shop to blunt inbox/storage spam.
  if (!(await rateLimit(`bug-report:${session.shop}`, 5, 15 * 60_000))) {
    return json(
      { error: { code: "RATE_LIMITED", message: "Too many reports. Please wait a few minutes." } },
      { status: 429 },
    );
  }
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
