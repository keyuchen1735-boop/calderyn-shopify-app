// app/routes/signup.tsx
// Account creation page on the app origin. The form posts to /dashboard/signup
// (user + owned shop + session + verification email); this page owns the UI
// and friendly error states.
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError, GoogleButton } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Create your account — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return {
    error: url.searchParams.get("error"),
    email: url.searchParams.get("email") ?? "",
    store: url.searchParams.get("store") ?? "",
  };
}

export default function SignupPage() {
  const { error, email, store } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Create your account</h1>
      <p className="cd-auth-sub">Set up your store on Calderyn in about a minute.</p>
      <AuthError code={error} />
      <GoogleButton label="Sign up with Google" />
      <div className="cd-auth-divider">or</div>
      <form method="post" action="/dashboard/signup">
        <label className="cd-auth-label" htmlFor="store">
          Store name
        </label>
        <input
          className="cd-auth-input"
          id="store"
          name="store"
          type="text"
          required
          defaultValue={store}
          placeholder="e.g. Northbound Supply"
        />
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
          minLength={10}
          autoComplete="new-password"
        />
        <p className="cd-auth-hint">At least 10 characters.</p>
        <button className="cd-auth-submit" type="submit">
          Create account
        </button>
      </form>
      <p className="cd-auth-foot">
        We'll email you a link to verify your address. Already have an account?{" "}
        <a href="/login">Sign in</a>
      </p>
    </AuthShell>
  );
}
