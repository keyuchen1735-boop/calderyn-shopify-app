// app/routes/login.tsx
// The sign-in page for the Calderyn dashboard, served on the app origin
// (app.calderyncompany.com/login). The form posts to /dashboard/signin, which
// owns credentials, rate limits, and session minting; this page owns the UI
// and the friendly error states (?error= codes set by that action).
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import {
  AuthShell,
  AuthError,
  AuthNotice,
  AuthForm,
  AuthSubmit,
  PasswordField,
  GoogleButton,
  ShopifyButton,
} from "~/components/auth/AuthCard";
import { safeDashboardReturnTo, publicBaseUrl } from "~/lib/dashboard/http.server";
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
    // OAuth provider flows must start on the public apex (their callback host),
    // not this app.* origin — see GoogleButton / ShopifyButton.
    authBase: publicBaseUrl(),
  };
}

export default function LoginPage() {
  const { error, notice, email, returnTo, authBase } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Sign in</h1>
      <p className="cd-auth-sub">Welcome back.</p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      <GoogleButton label="Continue with Google" returnTo={returnTo} baseUrl={authBase} />
      <ShopifyButton label="Continue with Shopify" returnTo={returnTo} baseUrl={authBase} mode="signup" />
      <div className="cd-auth-divider">or</div>
      <AuthForm action="/dashboard/signin">
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
          autoFocus
        />
        <label className="cd-auth-label" htmlFor="password">
          Password
        </label>
        <PasswordField id="password" autoComplete="current-password" />
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
        <AuthSubmit label="Sign in" pendingLabel="Signing in…" />
      </AuthForm>
      <div className="cd-auth-links">
        <a href="/reset">Forgot password?</a>
        <a href="/signup">Create an account</a>
      </div>
    </AuthShell>
  );
}
