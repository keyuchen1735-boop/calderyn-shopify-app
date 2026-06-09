// Daily reaper for expired mcp_oauth_codes rows (60s TTL each; old rows linger).
// Authed with CRON_SECRET via the shared isAuthorizedCron helper.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (process.env.MCP_OAUTH_ENABLED !== "true") {
    return json({ ok: true, skipped: true });
  }

  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await getSupabase()
    .from("mcp_oauth_codes")
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  if (error) {
    console.error("[cron.mcp-oauth-cleanup] delete failed", error);
    return json({ ok: false, error: error.message ?? String(error) }, { status: 500 });
  }
  return json({ ok: true, deleted: count ?? 0 });
};
