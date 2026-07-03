// app/routes/login.tsx
// The sign-in page for the Calderyn dashboard, served on the app origin
// (app.calderyncompany.com/login). The form posts to /dashboard/signin, which
// owns credentials, rate limits, and session minting; this page owns the UI
// and the friendly error states (?error= codes set by that action).
//
// Never redirects into Shopify OAuth: entering the Shopify flow is always an
// explicit click on the footer link (/dashboard/login pre-fills the store
// domain from the remembered hint instead).
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError, AuthNotice, GoogleButton } from "~/components/auth/AuthCard";
import { safeDashboardReturnTo } from "~/lib/dashboard/http.server";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";

export const meta: MetaFunction = () => [{ title: "Sign in — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  // Already signed in? Straight to the dashboard.
  const session = await getSessionFromRequest(request);
  if (session) return redirect("/dashboard");

  const url = new URL(request.url);
  return {
    error: url.searchParams.get("error"),
    notice: url.searchParams.get("notice"),
    email: url.searchParams.get("email") ?? "",
    // Validated here AND at the action; a hostile value never reaches the form.
    returnTo: safeDashboardReturnTo(url.searchParams.get("return_to")),
  };
}

export default function LoginPage() {
  const { error, notice, email, returnTo } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Sign in</h1>
      <p className="cd-auth-sub">Welcome back. Your store's engine is waiting.</p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      <GoogleButton label="Continue with Google" returnTo={returnTo} />
      <div className="cd-auth-divider">or</div>
      <form method="post" action="/dashboard/signin">
        <label className="cd-auth-label" htmlFor="email">
          Email
        </label>
        <input
          className="cd-auth-input"
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={email}
        />
        <label className="cd-auth-label" htmlFor="password">
          Password
        </label>
        <input
          className="cd-auth-input"
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
        <button className="cd-auth-submit" type="submit">
          Sign in
        </button>
      </form>
      <div className="cd-auth-links">
        <a href="/reset">Forgot password?</a>
        <a href="/signup">Create an account</a>
      </div>
      <p className="cd-auth-foot">
        Store connected through Shopify? <a href="/dashboard/login">Sign in with Shopify</a>
      </p>
    </AuthShell>
  );
}
