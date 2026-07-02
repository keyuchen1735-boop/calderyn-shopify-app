import type { ActionFunctionArgs } from "react-router";
import {
  getDashboardSessionAllowUnverified,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await getDashboardSessionAllowUnverified(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  await revokeSession(session.sessionId);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}
