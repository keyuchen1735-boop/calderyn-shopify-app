import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { runSocialDigest } from "~/lib/social-digest/run.server";

// Weekly LinkedIn + Instagram carousel drop, emailed to the founders. Schedule:
// Fridays 14:00 UTC (10:00 ET during EDT) — `0 14 * * 5`, registered in vercel.json.
//
// Renders slides with headless chromium, so this function needs more memory and
// time than a plain loader (config below). Emits 500 (not a quiet 200) when the
// digest could not be produced or delivered, so a missing secret or a render/
// Resend failure shows up red in the Vercel cron dashboard (rule 12).
export const config = { maxDuration: 120, memory: 1769 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = await runSocialDigest();
  const ok = summary.error === null && summary.delivery.sent;
  if (!ok) {
    console.error("[cron.social-digest] digest not delivered", summary);
  }
  return json(summary, { status: ok ? 200 : 500 });
};
