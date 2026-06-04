import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { drainActionRetries } from "~/lib/actions/retry.server";

// Suggested schedule: every 15 minutes — `*/15 * * * *`.
//
// CAVEAT: the executor registry is empty (see retry.server.ts), so this
// currently REPLAYS NOTHING. The drain is INERT — every due row is left
// untouched and counted as `skipped`; no row is mutated until executors
// are ported. (It must not fail rows out: `failed` is terminal.)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = await drainActionRetries(getSupabase());
  return json(summary);
};
