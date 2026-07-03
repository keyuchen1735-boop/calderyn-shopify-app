// app/routes/reset.tsx
// Forgot-password page on the app origin. The form posts to /dashboard/reset,
// which sends the email (silently, never revealing account existence) and
// redirects back here with ?notice=sent.
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError, AuthNotice, AuthForm, AuthSubmit } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Reset your password — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return {
    error: url.searchParams.get("error"),
    notice: url.searchParams.get("notice"),
  };
}

export default function ResetPage() {
  const { error, notice } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Reset password</h1>
      <p className="cd-auth-sub">We'll email you a link.</p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      <AuthForm action="/dashboard/reset">
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
          autoFocus
        />
        <AuthSubmit label="Send reset link" pendingLabel="Sending…" />
      </AuthForm>
      <div className="cd-auth-links">
        <a href="/login">Back to sign in</a>
        <a href="/signup">Create an account</a>
      </div>
    </AuthShell>
  );
}
