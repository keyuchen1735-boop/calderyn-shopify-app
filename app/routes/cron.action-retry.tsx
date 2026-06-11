import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { drainActionRetries } from "~/lib/actions/retry.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Suggested schedule: every 15 minutes — `*/15 * * * *`.
//
// Drains due `retrying` rows from action_audit: re-resolves the per-shop
// adapter and replays the campaign action (pause/resume/budget) via
// EXECUTOR_REGISTRY (see retry.server.ts). Success marks the row
// `succeeded`; a transient failure bumps `attempts` and stays `retrying`
// until the attempt cap, at which point it terminally `failed`s. Kinds with
// no platform executor (e.g. snooze_alert) are skipped untouched.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = await drainActionRetries(getSupabase());
  return json(summary);
};
