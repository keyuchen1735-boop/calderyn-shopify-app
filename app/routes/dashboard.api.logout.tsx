import type { ActionFunctionArgs } from "@remix-run/node";
import {
  getSessionFromRequest,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { SHOP_HINT_COOKIE_NAME } from "./dashboard.login";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Idempotent: always clear the cookies, even when the session is already
  // expired/revoked/missing (getSessionFromRequest returns null then), so a stale
  // token can never linger on the wire. Best-effort server-side revoke.
  try {
    const session = await getSessionFromRequest(request);
    if (session) await revokeSession(session.sessionId);
  } catch {
    /* best effort — the cookies are cleared regardless */
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", clearSessionCookieHeader());
  // Also drop the Shopify shop hint: leaving it meant "Sign out" bounced
  // straight back through Shopify OAuth and silently re-signed the merchant in.
  headers.append(
    "Set-Cookie",
    `${SHOP_HINT_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
