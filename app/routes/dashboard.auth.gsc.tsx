// app/routes/dashboard.auth.gsc.tsx
// Start the Google Search Console connect flow. Session-gated; sets a
// short-lived CSRF state cookie and forwards to Google's consent screen.
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { randomBytes } from "node:crypto";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { buildGscAuthUrl, GSC_STATE_COOKIE, gscRedirectUri } from "~/lib/seo/gsc.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireDashboardSession(request);
  const state = randomBytes(16).toString("hex");
  return redirect(buildGscAuthUrl({ redirectUri: gscRedirectUri(), state }), {
    headers: {
      "set-cookie": `${GSC_STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
};
