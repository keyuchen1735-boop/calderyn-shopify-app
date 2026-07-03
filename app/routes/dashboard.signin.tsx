// app/routes/dashboard.signin.tsx
// First-party email + password sign-in ENDPOINT. The user-facing page lives at
// /login; GETs here redirect there (params preserved). This is the default
// signed-out entry and never redirects into Shopify OAuth — the Shopify entry
// (/dashboard/login) serves the embedded-app "Open dashboard" button and goes
// straight into shop-less Shopify OAuth for "Continue with Shopify".
//
// The POST contract is stable for programmatic clients (Accept:
// application/json → JSON error codes); plain form posts get a redirect back
// to /login with the error code in the query string so the browser never
// renders a raw JSON body.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  rateLimit,
  clientIpKey,
  checkSameOrigin,
  jsonError,
  wantsJson,
  safeDashboardReturnTo,
} from "~/lib/dashboard/http.server";
import { verifyUserCredentials, normalizeEmail } from "~/lib/auth/users.server";
import { resolveShopForUser } from "~/lib/auth/tenant.server";
import {
  createSessionForUser,
  getSessionFromRequest,
  sessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { clearShopHintCookieHeader } from "~/lib/dashboard/cookies.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Already signed in? Straight to the dashboard — re-submitting the form
  // would mint a second session row and orphan the first (the cookie overwrite
  // leaves the old token live but unrevocable from this browser).
  const session = await getSessionFromRequest(request);
  if (session) return redirect("/dashboard");
  const url = new URL(request.url);
  return redirect(`/login${url.search}`);
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const returnTo = safeDashboardReturnTo(String(fd.get("return_to") ?? ""));

  const fail = (status: number, code: string) => {
    if (wantsJson(request)) return jsonError(status, code);
    const params = new URLSearchParams({ error: code, email });
    if (returnTo) params.set("return_to", returnTo);
    return redirect(`/login?${params.toString()}`);
  };

  if (!(await rateLimit(clientIpKey(request, "dash-signin"), 10, 60_000))) {
    return fail(429, "rate_limited");
  }

  const password = String(fd.get("password") ?? "");

  // Per-account throttle beyond the per-IP limit: stops credential-stuffing a
  // single account from rotating IPs. 5 attempts / 15 min per email.
  if (!(await rateLimit(`signin-acct:${normalizeEmail(email)}`, 5, 15 * 60_000))) {
    return fail(429, "rate_limited");
  }

  const user = await verifyUserCredentials(email, password);
  if (!user) return fail(401, "invalid_credentials");

  const shopId = await resolveShopForUser(user.id);
  if (!shopId) return fail(409, "no_shop"); // account exists but no store linked yet

  const { raw } = await createSessionForUser(user.id, shopId);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(raw));
  // A stale Shopify shop hint from a past OAuth login has no business outliving
  // a first-party sign-in — drop it so /dashboard/login pre-fill can't drift.
  headers.append("Set-Cookie", clearShopHintCookieHeader());
  // Honour a validated destination (e.g. /dashboard/connect?t=…) so the
  // connector consent flow survives the sign-in round-trip.
  return redirect(returnTo ?? "/dashboard", { headers });
}
