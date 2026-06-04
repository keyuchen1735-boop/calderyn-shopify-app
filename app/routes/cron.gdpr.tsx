import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { runGdprAndRetentionSweep } from "~/lib/gdpr/sweep.server";

// Suggested schedule: daily at 04:00 UTC — `0 4 * * *`.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = {
    shopsRedacted: [] as string[],
    shopsFailed: [] as { id: string; error: string }[],
    rawWebhookRowsDeleted: 0,
    error: null as string | null,
  };

  try {
    const result = await runGdprAndRetentionSweep(getSupabase());
    summary.shopsRedacted = result.shopsRedacted;
    summary.shopsFailed = result.shopsFailed;
    summary.rawWebhookRowsDeleted = result.rawWebhookRowsDeleted;
  } catch (err) {
    // Surface the failure in the response — never silently pass (rule 12).
    summary.error = err instanceof Error ? err.message : String(err);
    console.error("[cron.gdpr] sweep failed", err);
  }

  return json(summary);
};
