import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  getSessionFromRequest,
  revokeSession,
  authClearCookieHeaders,
  readSessionTokenFromCookie,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { ACCOUNTS_COOKIE_NAME } from "~/lib/dashboard/cookies.server";
import { rememberOnSignOut } from "~/lib/auth/remembered-accounts.server";

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

  // Logout means the browser keeps no auth-adjacent state for THIS account: an
  // abandoned authorize tab must not be able to re-mint a session after an
  // explicit sign-out. authClearCookieHeaders() is the teardown shared with
  // account deletion, with one deliberate swap: the remembered-accounts list
  // keeps the OTHER accounts (their one-click chooser entry survives a
  // sign-out, like Shopify's account picker) — only the just-revoked token is
  // dropped from it.
  const activeRaw = readSessionTokenFromCookie(request);
  const headers = new Headers();
  for (const cookie of authClearCookieHeaders()) {
    if (cookie.startsWith(`${ACCOUNTS_COOKIE_NAME}=`)) continue;
    headers.append("Set-Cookie", cookie);
  }
  headers.append("Set-Cookie", await rememberOnSignOut(request, activeRaw));

  // Document form POSTs need a page to land on, not a JSON body; fetch callers
  // (Accept: */* or application/json) keep the JSON contract.
  if (request.headers.get("Accept")?.includes("text/html")) {
    return redirect("/login?notice=signed_out", { headers });
  }

  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
