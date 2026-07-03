// app/routes/dashboard.auth.google.tsx
// Google sign-in start: mints a state nonce, stores it in a double-submit cookie,
// and redirects the browser to Google's OAuth consent page.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { randomBytes } from "node:crypto";
import { buildSigninAuthUrl } from "~/lib/auth/google-signin.server";
import {
  rateLimit,
  clientIpKey,
  safeDashboardReturnTo,
} from "~/lib/dashboard/http.server";
import { GOAUTH_COOKIE } from "~/lib/dashboard/cookies.server";

const NONCE_TTL = 900; // 15 minutes

function redirectUri(): string {
  const base = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  return `${base}/dashboard/auth/google/callback`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!(await rateLimit(clientIpKey(request, "google-signin"), 20, 60_000))) {
    return redirect("/dashboard/signin?error=rate_limited");
  }

  const clientId = process.env.GOOGLE_SIGNIN_CLIENT_ID;
  if (!clientId) {
    return redirect("/dashboard/signin?error=google_unavailable");
  }

  const nonce = randomBytes(32).toString("base64url");
  const authUrl = buildSigninAuthUrl({ clientId, redirectUri: redirectUri(), state: nonce });

  // Carry a validated post-login destination (e.g. /dashboard/connect?t=…)
  // through the round-trip as `nonce:enc(returnTo)` — same pattern as the
  // Shopify state cookie in dashboard.login. Plain `nonce` when absent.
  const returnTo = safeDashboardReturnTo(new URL(request.url).searchParams.get("return_to"));
  const cookieValue = returnTo ? `${nonce}:${encodeURIComponent(returnTo)}` : nonce;

  return redirect(authUrl, {
    headers: {
      "Set-Cookie": `${GOAUTH_COOKIE}=${cookieValue}; Max-Age=${NONCE_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
