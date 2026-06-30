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

const GOAUTH_COOKIE = "__Host-calderyn_goauth";
const CLEAR_GOAUTH = `${GOAUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

function readGoauthCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GOAUTH_COOKIE) return rest.join("=") || null;
  }
  return null;
}

function redirectUri(): string {
  const base = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
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
  const cookieNonce = readGoauthCookie(request);

  // CSRF double-submit check. Both values must be present and equal.
  if (!state || !cookieNonce || state !== cookieNonce) {
    return redirect("/dashboard/signin?error=google_oauth_failed", {
      headers: { "Set-Cookie": CLEAR_GOAUTH },
    });
  }

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

  // Path 1: user already linked this Google account and has a shop.
  const byGoogleSub = await findUserByGoogleSub(sub);
  if (byGoogleSub && byGoogleSub.shopId) {
    const { raw } = await createSessionForUser(byGoogleSub.id, byGoogleSub.shopId);
    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookieHeader(raw));
    headers.append("Set-Cookie", CLEAR_GOAUTH);
    return redirect("/dashboard", { headers });
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
    headers.append("Set-Cookie", CLEAR_GOAUTH);
    return redirect("/dashboard", { headers });
  }

  // Path 3: brand-new user - send them to name-your-store with a signed token.
  const token = signGoogleSignup({ sub, email });
  return redirect(`/dashboard/auth/google/store?t=${encodeURIComponent(token)}`, {
    headers: { "Set-Cookie": CLEAR_GOAUTH },
  });
}
