// app/routes/dashboard.auth.google.tsx
// Google sign-in start: mints a state nonce, stores it in a double-submit cookie,
// and redirects the browser to Google's OAuth consent page.
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { randomBytes } from "node:crypto";
import { buildSigninAuthUrl } from "~/lib/auth/google-signin.server";
import { rateLimit, clientIpKey } from "~/lib/dashboard/http.server";

const GOAUTH_COOKIE = "__Host-calderyn_goauth";
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

  return redirect(authUrl, {
    headers: {
      "Set-Cookie": `${GOAUTH_COOKIE}=${nonce}; Max-Age=${NONCE_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
