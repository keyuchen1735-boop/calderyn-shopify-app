// app/routes/dashboard.auth.google.callback.tsx
// Google sign-in callback dispatcher. Validates the CSRF state cookie, exchanges
// the code for an id_token, verifies it, then routes the identity to either a
// direct session (known user), or the name-your-store step (new user).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  exchangeCodeForIdToken,
  verifyIdToken,
  type IdTokenFetcher,
  type TokenInfoFetcher,
} from "~/lib/auth/google-signin.server";
import { signGoogleSignup } from "~/lib/auth/google-signup-token.server";
import {
  findUserByGoogleSub,
  findUserByEmail,
  setGoogleSub,
} from "~/lib/auth/users.server";
import { resolveShopForUser } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { safeDashboardReturnTo, publicBaseUrl } from "~/lib/dashboard/http.server";
import { GOAUTH_COOKIE, expireCookieHeader } from "~/lib/dashboard/cookies.server";
import { rememberOnSignIn } from "~/lib/auth/remembered-accounts.server";

const CLEAR_GOAUTH = expireCookieHeader(GOAUTH_COOKIE);

// Cookie format is `nonce[:enc(returnTo)]` (see dashboard.auth.google). Only
// the returnTo segment is URL-encoded, so split first and decode that segment
// once — decoding the whole value would double-decode returnTo.
function readGoauthCookie(request: Request): { nonce: string; returnTo: string | null } | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GOAUTH_COOKIE) {
      const [nonce, ...ret] = rest.join("=").split(":");
      if (!nonce) return null;
      let returnTo: string | null = null;
      if (ret.length) {
        try {
          returnTo = decodeURIComponent(ret.join(":"));
        } catch {
          returnTo = null; // malformed encoding — fall back to /dashboard
        }
      }
      return { nonce, returnTo };
    }
  }
  return null;
}

function redirectUri(): string {
  const base = publicBaseUrl();
  return `${base}/dashboard/auth/google/callback`;
}

const idTokenFetcher: IdTokenFetcher = (url, init) =>
  fetch(url, init).then((r) => r.json()) as ReturnType<IdTokenFetcher>;

const tokenInfoFetcher: TokenInfoFetcher = (url) =>
  fetch(url).then((r) => r.json()) as ReturnType<TokenInfoFetcher>;

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookie = readGoauthCookie(request);

  // CSRF double-submit check. Both values must be present and equal.
  if (!state || !cookie || state !== cookie.nonce) {
    return redirect("/dashboard/signin?error=google_oauth_failed", {
      headers: { "Set-Cookie": CLEAR_GOAUTH },
    });
  }

  // Validated post-login destination (re-checked here, never trusted straight
  // from the cookie) so the connector consent flow resumes at /dashboard/connect?t=….
  const dest = safeDashboardReturnTo(cookie.returnTo) ?? "/dashboard";

  const clientId = process.env.GOOGLE_SIGNIN_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_SIGNIN_CLIENT_SECRET ?? "";
  const ruri = redirectUri();

  let sub: string;
  let email: string;
  let emailVerified: boolean;

  try {
    const idToken = await exchangeCodeForIdToken(idTokenFetcher, {
      clientId,
      clientSecret,
      redirectUri: ruri,
      code,
    });
    // Do not log idToken - it carries verified identity claims.
    ({ sub, email, emailVerified } = await verifyIdToken(tokenInfoFetcher, idToken, clientId));
  } catch {
    return redirect("/dashboard/signin?error=google_oauth_failed", {
      headers: { "Set-Cookie": CLEAR_GOAUTH },
    });
  }

  if (!emailVerified) {
    return redirect("/dashboard/signin?error=google_unverified_email", {
      headers: { "Set-Cookie": CLEAR_GOAUTH },
    });
  }

  // A user who has not finished onboarding must land on it regardless of the
  // requested `dest` — enforcing the gate at the auth boundary, not delegating to
  // whatever route return_to happens to point at (some don't re-check onboarding).
  // `dest` is preserved through onboarding as return_to so an interrupted flow
  // (e.g. the connector consent ?t=…) resumes once onboarding completes.
  const onboardingDest =
    dest === "/dashboard" ? "/dashboard/onboarding" : `/dashboard/onboarding?return_to=${encodeURIComponent(dest)}`;
  const afterAuth = (onboardedAt: string | null) => (onboardedAt ? dest : onboardingDest);

  // Path 1: user already linked this Google account and has a shop.
  const byGoogleSub = await findUserByGoogleSub(sub);
  if (byGoogleSub && byGoogleSub.shopId) {
    const { raw } = await createSessionForUser(byGoogleSub.id, byGoogleSub.shopId);
    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookieHeader(raw));
    headers.append("Set-Cookie", rememberOnSignIn(request, raw));
    headers.append("Set-Cookie", CLEAR_GOAUTH);
    return redirect(afterAuth(byGoogleSub.onboardedAt), { headers });
  }

  // Path 2: user exists by email (signed up with password) - link the Google sub.
  const byEmail = await findUserByEmail(email);
  if (byEmail) {
    await setGoogleSub(byEmail.id, sub);
    const shopId = await resolveShopForUser(byEmail.id);
    if (!shopId) {
      return redirect("/dashboard/signin?error=no_shop", {
        headers: { "Set-Cookie": CLEAR_GOAUTH },
      });
    }
    const { raw } = await createSessionForUser(byEmail.id, shopId);
    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookieHeader(raw));
    headers.append("Set-Cookie", rememberOnSignIn(request, raw));
    headers.append("Set-Cookie", CLEAR_GOAUTH);
    return redirect(afterAuth(byEmail.onboardedAt), { headers });
  }

  // Path 3: brand-new user - send them to name-your-store with a signed token.
  // Carry the validated destination through so a first-time Google user's
  // connector-consent (or any) deep link still resumes after they name their
  // store and finish onboarding — it was only preserved for returning users.
  const token = signGoogleSignup({ sub, email });
  const storeUrl =
    dest === "/dashboard"
      ? `/dashboard/auth/google/store?t=${encodeURIComponent(token)}`
      : `/dashboard/auth/google/store?t=${encodeURIComponent(token)}&return_to=${encodeURIComponent(dest)}`;
  return redirect(storeUrl, {
    headers: { "Set-Cookie": CLEAR_GOAUTH },
  });
}
