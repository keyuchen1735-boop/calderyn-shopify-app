// Daily reaper for expired mcp_oauth_codes rows (60s TTL each; old rows linger).
// Authed with CRON_SECRET via the shared isAuthorizedCron helper.
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
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

  // The connector consent flow no longer persists pending-OAuth rows — the
  // pending state is a short-lived signed JWT carried in the URL, so there is
  // nothing to reap here beyond expired auth codes.
  return json({
    ok: true,
    deleted_codes: codes.count ?? 0,
  });
};
