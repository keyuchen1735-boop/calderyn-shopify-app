// app/routes/dashboard.signin.tsx
// First-party email + password sign-in ENDPOINT. The user-facing page moved to
// /login; GETs here redirect there (params preserved). The POST contract is
// stable for programmatic clients (Accept: application/json → JSON error
// codes); plain form posts get a redirect back to /login with the error code
// in the query string so the browser never renders a raw JSON body.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
import { verifyUserCredentials, normalizeEmail } from "~/lib/auth/users.server";
import { resolveShopForUser } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/login${url.search}`);
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");

  const fail = (status: number, code: string) =>
    wantsJson(request)
      ? jsonError(status, code)
      : redirect(`/login?error=${code}&email=${encodeURIComponent(email)}`);

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
  return redirect("/dashboard", { headers: { "Set-Cookie": sessionCookieHeader(raw) } });
}
