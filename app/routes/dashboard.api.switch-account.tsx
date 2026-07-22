// app/routes/dashboard.api.switch-account.tsx
// Activates (or forgets) an entry from the /login and /signup account
// chooser. The posted `sid` only selects which remembered entry to use — the
// session token itself always comes from the HttpOnly accounts cookie, so a
// forged form body can never smuggle a token in. A dead selection (signed
// out, or expired between render and click) falls back to the password form
// with the email prefilled; the entry stays listed.
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
  // Which auth page hosted the chooser — a remove round-trips back to it.
  // Allow-listed, never a raw redirect target.
  const back = String(fd.get("back") ?? "") === "/signup" ? "/signup" : "/login";
  const backUrl = (params?: Record<string, string>) => {
    const qs = new URLSearchParams(params ?? {});
    if (returnTo) qs.set("return_to", returnTo);
    const s = qs.toString();
    return s ? `${back}?${s}` : back;
  };

  if (!/^[0-9a-f]{16}$/.test(sid)) return redirect(backUrl());

  if (intent === "remove") {
    const cookieHeader = await forgetRememberedAccount(request, sid);
    return redirect(backUrl(), cookieHeader ? { headers: { "Set-Cookie": cookieHeader } } : undefined);
  }

  const result = await activateRememberedAccount(request, sid);
  // Unknown sid: the cookie changed under the form (another tab). Re-render.
  if (!result) return redirect(backUrl());

  if (!result.ok) {
    // Dead selection — hand off to the password form with the email
    // prefilled. Only a vanished entry (no session row) gets pruned.
    const dest = `/login?${new URLSearchParams({
      ...(result.email ? { email: result.email } : { error: "session_expired" }),
      ...(returnTo ? { return_to: returnTo } : {}),
    }).toString()}`;
    return redirect(
      dest,
      result.cookieHeader ? { headers: { "Set-Cookie": result.cookieHeader } } : undefined,
    );
  }

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(result.raw));
  // Bump the picked account to the front of the list (most-recent-first).
  headers.append("Set-Cookie", rememberOnSignIn(request, result.raw));
  return redirect(returnTo ?? "/dashboard", { headers });
}
