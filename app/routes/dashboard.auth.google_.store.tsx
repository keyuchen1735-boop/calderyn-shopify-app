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
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
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
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fd = await request.formData();
  const t = String(fd.get("t") ?? "");
  const store = String(fd.get("store") ?? "").trim();

  const fail = (status: number, code: string) =>
    wantsJson(request)
      ? jsonError(status, code)
      : redirect(`/dashboard/auth/google/store?t=${encodeURIComponent(t)}&error=${code}`);

  if (!(await rateLimit(clientIpKey(request, "google-store"), 10, 60_000))) {
    return fail(429, "rate_limited");
  }

  const id = verifyGoogleSignup(t);
  if (!id) return fail(400, "invalid_or_expired_token");
  if (!store) return fail(422, "missing_store");

  // Atomic creation: if shop provisioning or membership fails, roll back the
  // user row so the email is not permanently locked and a retry can succeed.
  const { id: userId } = await createGoogleUser(id.email, id.sub);
  try {
    const { shopId } = await provisionOwnedShop(store);
    await linkMembership(userId, shopId, "owner");
    const { raw } = await createSessionForUser(userId, shopId);
    // New Google users go through onboarding (phone + how-heard, optional Shopify
    // port) before the dashboard — same gate as email signups. Google emails are
    // pre-verified, so onboarding-finish lands them straight on /dashboard.
    return redirect("/dashboard/onboarding", { headers: { "Set-Cookie": sessionCookieHeader(raw) } });
  } catch (err) {
    await deleteUser(userId).catch(() => {});
    // The rollback leaves a retry able to succeed, so surface a retryable
    // error page instead of a raw 500.
    console.error("[google-store] account creation failed", err);
    return fail(500, "account_creation_failed");
  }
}

export default function GoogleStoreRoute() {
  const { t, expired, error } = useLoaderData<typeof loader>();
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
