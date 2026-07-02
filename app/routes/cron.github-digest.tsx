import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { runGithubDigest } from "~/lib/github-digest/run.server";

// Daily GitHub progress digest. Suggested schedule: 14:00 UTC (10:00 ET during
// EDT) — `0 14 * * *`, registered in vercel.json.
//
// Emits 500 (not a quiet 200) when the digest could not be produced or
// delivered, so a missing secret or a Resend failure shows up red in the Vercel
// cron dashboard instead of looking like a successful no-op (rule 12).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = await runGithubDigest();
  const ok = summary.error === null && summary.delivery.sent;
  if (!ok) {
    console.error("[cron.github-digest] digest not delivered", summary);
  }
  return json(summary, { status: ok ? 200 : 500 });
};
