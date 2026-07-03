// app/routes/login.tsx
// The sign-in page for the Calderyn dashboard, served on the app origin
// (app.calderyncompany.com/login). The form posts to /dashboard/signin, which
// owns credentials, rate limits, and session minting; this page owns the UI
// and the friendly error states (?error= codes set by that action).
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError, AuthNotice, GoogleButton } from "~/components/auth/AuthCard";
import { isValidShopDomain } from "~/lib/dashboard/shopify-oauth.server";
import { SHOP_HINT_COOKIE_NAME } from "./dashboard.login";

export const meta: MetaFunction = () => [{ title: "Sign in — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const notice = url.searchParams.get("notice");
  const email = url.searchParams.get("email") ?? "";

  // A returning Shopify-identity merchant carries the __Host-dash_shop hint
  // from their last OAuth login — send their expired-session bounce straight
  // into Shopify authorize instead of stranding them on the password form.
  // Never when the visit carries state (?email/?error/?notice): a stale hint
  // must not trap a first-party user away from the form or eat an error.
  if (!error && !notice && !email) {
    const header = request.headers.get("Cookie") ?? "";
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SHOP_HINT_COOKIE_NAME) {
        const hint = rest.join("=").trim().toLowerCase();
        if (hint && isValidShopDomain(hint)) return redirect("/dashboard/login");
      }
    }
  }
  return { error, notice, email };
}

export default function LoginPage() {
  const { error, notice, email } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Sign in</h1>
      <p className="cd-auth-sub">Welcome back. Your store's engine is waiting.</p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      <GoogleButton label="Continue with Google" />
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
