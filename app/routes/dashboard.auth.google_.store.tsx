// app/routes/dashboard.auth.google.store.tsx
// "Name your store" step for brand-new Google sign-in users. GET renders the
// form; POST validates the signup token, creates the user+shop atomically.
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { verifyGoogleSignup } from "~/lib/auth/google-signup-token.server";
import { createGoogleUser, deleteUser } from "~/lib/auth/users.server";
import { provisionOwnedShop, linkMembership } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { rememberOnSignIn } from "~/lib/auth/remembered-accounts.server";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson, safeDashboardReturnTo } from "~/lib/dashboard/http.server";
import { AuthShell, AuthError, AuthForm, AuthSubmit } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Name your store — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const t = url.searchParams.get("t") ?? "";
  return {
    t,
    expired: !t || !verifyGoogleSignup(t),
    error: url.searchParams.get("error"),
    // Carried from the sign-in callback so an interrupted deep-link (connector
    // consent) resumes after the store is named and onboarding completes.
    returnTo: safeDashboardReturnTo(url.searchParams.get("return_to")),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fd = await request.formData();
  const t = String(fd.get("t") ?? "");
  const store = String(fd.get("store") ?? "").trim();
  const returnTo = safeDashboardReturnTo(fd.get("return_to") == null ? null : String(fd.get("return_to")));

  const fail = (status: number, code: string) =>
    wantsJson(request)
      ? jsonError(status, code)
      : redirect(
          `/dashboard/auth/google/store?t=${encodeURIComponent(t)}&error=${code}` +
            (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""),
        );

  if (!(await rateLimit(clientIpKey(request, "google-store"), 10, 60_000))) {
    return fail(429, "rate_limited");
  }

  const id = verifyGoogleSignup(t);
  if (!id) return fail(400, "invalid_or_expired_token");
  if (!store) return fail(422, "missing_store");

  // New Google users go through onboarding (phone + how-heard, optional Shopify
  // port) before the dashboard — same gate as email signups. return_to rides
  // through onboarding so an interrupted deep-link resumes at the end.
  const onboardingDest = returnTo
    ? `/dashboard/onboarding?return_to=${encodeURIComponent(returnTo)}`
    : "/dashboard/onboarding";

  // Atomic creation. createGoogleUser is INSIDE the try so a replayed/double-
  // submitted signup token (the JWT is stateless, not single-use) doesn't 500 on
  // the unique(email/google_sub) violation from the first submit's account.
  let userId: string | null = null;
  try {
    ({ id: userId } = await createGoogleUser(id.email, id.sub));
    const { shopId } = await provisionOwnedShop(store);
    await linkMembership(userId, shopId, "owner");
    const { raw } = await createSessionForUser(userId, shopId);
    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookieHeader(raw));
    headers.append("Set-Cookie", rememberOnSignIn(request, raw));
    return redirect(onboardingDest, { headers });
  } catch (err) {
    if (userId == null) {
      // createGoogleUser itself failed. A duplicate means the token was replayed
      // after the first submit already created the account — send them to sign in
      // rather than 500; anything else is a genuine error.
      if ((err as { code?: string }).code === "23505") {
        return wantsJson(request) ? jsonError(409, "account_exists") : redirect("/dashboard/signin");
      }
      console.error("[google-store] user creation failed", err);
      return fail(500, "account_creation_failed");
    }
    // The user was created but a later step failed — roll it back so the email
    // isn't locked and a retry can succeed.
    await deleteUser(userId).catch(() => {});
    console.error("[google-store] account creation failed", err);
    return fail(500, "account_creation_failed");
  }
}

export default function GoogleStoreRoute() {
  const { t, expired, error, returnTo } = useLoaderData<typeof loader>();
  if (expired) {
    return (
      <AuthShell>
        <h1 className="cd-auth-title">Link expired</h1>
        <p className="cd-auth-sub">Your sign-in link has expired. Start again and it'll only take a moment.</p>
        <div className="cd-auth-links">
          <a href="/login">Back to sign in</a>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Name your store</h1>
      <p className="cd-auth-sub">You're signed in with Google. One last thing: what should we call your store?</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/auth/google/store">
        <input type="hidden" name="t" value={t} />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <label className="cd-auth-label" htmlFor="store">
          Store name
        </label>
        <input
          className="cd-auth-input"
          id="store"
          name="store"
          type="text"
          required
          autoComplete="organization"
          placeholder="e.g. Northbound Supply"
          autoFocus
        />
        <AuthSubmit label="Continue" pendingLabel="Creating account…" />
      </AuthForm>
    </AuthShell>
  );
}
