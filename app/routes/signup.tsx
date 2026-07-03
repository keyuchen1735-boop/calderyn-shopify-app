// app/routes/signup.tsx
// Account creation page on the app origin. The form posts to /dashboard/signup
// (user + owned shop + session + verification email); this page owns the UI
// and friendly error states.
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import {
  AuthShell,
  AuthError,
  AuthForm,
  AuthSubmit,
  PasswordField,
  GoogleButton,
} from "~/components/auth/AuthCard";

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
      <AuthForm action="/dashboard/signup">
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
          defaultValue={store}
          placeholder="e.g. Northbound Supply"
          autoFocus
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
        <PasswordField id="password" autoComplete="new-password" minLength={10} />
        <p className="cd-auth-hint">At least 10 characters.</p>
        <AuthSubmit label="Create account" pendingLabel="Creating account…" />
      </AuthForm>
      <p className="cd-auth-foot">We'll email you a link to verify your address.</p>
      <p className="cd-auth-foot">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </AuthShell>
  );
}
