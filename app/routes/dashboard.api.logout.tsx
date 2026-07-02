import type { ActionFunctionArgs } from "@remix-run/node";
import {
  getSessionFromRequest,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Idempotent: always clear the cookie, even when the session is already
  // expired/revoked/missing (getSessionFromRequest returns null then), so a stale
  // token can never linger on the wire. Best-effort server-side revoke.
  try {
    const session = await getSessionFromRequest(request);
    if (session) await revokeSession(session.sessionId);
  } catch {
    /* best effort — the cookie is cleared regardless */
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}
