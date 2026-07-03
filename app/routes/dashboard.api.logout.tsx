import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  getSessionFromRequest,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  expireCookieHeader,
  clearShopHintCookieHeader,
  STATE_COOKIE_NAME,
  GOAUTH_COOKIE,
} from "~/lib/dashboard/cookies.server";
import { SHOP_HINT_COOKIE_NAME as CONNECT_SHOP_HINT } from "~/lib/connect-deeplink.server";

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

  // Logout means the browser keeps no auth-adjacent state: the session token,
  // both remembered-shop hints (dashboard + connector surfaces), and any
  // in-flight OAuth state nonces — an abandoned authorize tab must not be able
  // to re-mint a session after an explicit sign-out.
  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookieHeader());
  headers.append("Set-Cookie", clearShopHintCookieHeader());
  headers.append("Set-Cookie", expireCookieHeader(CONNECT_SHOP_HINT));
  headers.append("Set-Cookie", expireCookieHeader(STATE_COOKIE_NAME));
  headers.append("Set-Cookie", expireCookieHeader(GOAUTH_COOKIE));

  // Document form POSTs need a page to land on, not a JSON body; fetch callers
  // (Accept: */* or application/json) keep the JSON contract.
  if (request.headers.get("Accept")?.includes("text/html")) {
    return redirect("/login?notice=signed_out", { headers });
  }

  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
