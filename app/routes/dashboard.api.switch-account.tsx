// app/routes/dashboard.api.switch-account.tsx
// Activates (or forgets) an entry from the /login account chooser. The posted
// `sid` only selects which remembered entry to use — the session token itself
// always comes from the HttpOnly accounts cookie, so a forged form body can
// never smuggle a token in. A dead selection (expired/revoked between render
// and click) falls back to the password form with the email prefilled.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  jsonError,
  requireSameOrigin,
  rateLimit,
  clientIpKey,
  safeDashboardReturnTo,
} from "~/lib/dashboard/http.server";
import { sessionCookieHeader } from "~/lib/dashboard/session.server";
import {
  activateRememberedAccount,
  forgetRememberedAccount,
  rememberOnSignIn,
} from "~/lib/auth/remembered-accounts.server";

export async function loader(_: LoaderFunctionArgs) {
  return redirect("/login");
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  if (!(await rateLimit(clientIpKey(request, "switch-account"), 30, 60_000))) {
    return redirect("/login?error=rate_limited");
  }

  const fd = await request.formData();
  const sid = String(fd.get("sid") ?? "");
  const intent = String(fd.get("intent") ?? "switch");
  const returnTo = safeDashboardReturnTo(String(fd.get("return_to") ?? ""));
  const loginUrl = (params?: Record<string, string>) => {
    const qs = new URLSearchParams(params ?? {});
    if (returnTo) qs.set("return_to", returnTo);
    const s = qs.toString();
    return s ? `/login?${s}` : "/login";
  };

  if (!/^[0-9a-f]{16}$/.test(sid)) return redirect(loginUrl());

  if (intent === "remove") {
    const cookieHeader = await forgetRememberedAccount(request, sid);
    return redirect(loginUrl(), cookieHeader ? { headers: { "Set-Cookie": cookieHeader } } : undefined);
  }

  const result = await activateRememberedAccount(request, sid);
  // Unknown sid: the cookie changed under the form (another tab). Re-render.
  if (!result) return redirect(loginUrl());

  if (!result.ok) {
    // Session died since render — prune it and hand off to the password form.
    return redirect(loginUrl({ error: "session_expired", ...(result.email ? { email: result.email } : {}) }), {
      headers: { "Set-Cookie": result.cookieHeader },
    });
  }

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(result.raw));
  // Bump the picked account to the front of the list (most-recent-first).
  headers.append("Set-Cookie", rememberOnSignIn(request, result.raw));
  return redirect(returnTo ?? "/dashboard", { headers });
}
