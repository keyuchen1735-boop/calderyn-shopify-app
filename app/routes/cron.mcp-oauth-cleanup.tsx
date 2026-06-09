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
  const sb = getSupabase();

  const codes = await sb
    .from("mcp_oauth_codes")
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  if (codes.error) {
    console.error("[cron.mcp-oauth-cleanup] codes delete failed", codes.error);
    return json({ ok: false, error: codes.error.message ?? String(codes.error) }, { status: 500 });
  }

  // Pending-OAuth rows also expire; reap anything past TTL (already +24h grace).
  const pending = await sb
    .from("mcp_pending_oauth")
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  if (pending.error) {
    console.error("[cron.mcp-oauth-cleanup] pending delete failed", pending.error);
    return json({ ok: false, error: pending.error.message ?? String(pending.error) }, { status: 500 });
  }

  return json({
    ok: true,
    deleted_codes: codes.count ?? 0,
    deleted_pending: pending.count ?? 0,
  });
};
