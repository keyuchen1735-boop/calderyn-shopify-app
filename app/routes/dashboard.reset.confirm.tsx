import type { ActionFunctionArgs, HeadersFunction, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
import { setPasswordWithToken } from "~/lib/auth/reset.server";
import { AuthShell, AuthError, AuthForm, AuthSubmit, PasswordField } from "~/components/auth/AuthCard";

const MIN_PASSWORD = 10;

export const meta: MetaFunction = () => [{ title: "Set a new password — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

// Referrer-Policy: no-referrer is critical here because the reset token appears
// in the URL (?t=...). Without this header, clicking an external link while on
// this page would send the token in the Referer header to a third party.
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return { t: url.searchParams.get("t") ?? "", error: url.searchParams.get("error") };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fd = await request.formData();
  const token = String(fd.get("t") ?? "");
  const password = String(fd.get("password") ?? "");

  const fail = (status: number, code: string, message?: string) =>
    wantsJson(request)
      ? jsonError(status, code, message)
      : redirect(`/dashboard/reset/confirm?t=${encodeURIComponent(token)}&error=${code}`, {
          headers: { "Referrer-Policy": "no-referrer" },
        });

  if (!(await rateLimit(clientIpKey(request, "dash-reset-confirm"), 10, 60_000))) return fail(429, "rate_limited");
  if (password.length < MIN_PASSWORD) return fail(422, "weak_password", `Use at least ${MIN_PASSWORD} characters`);
  const ok = await setPasswordWithToken(token, password);
  if (!ok) return fail(400, "invalid_or_expired_token");
  return redirect("/login?notice=reset", { headers: { "Referrer-Policy": "no-referrer" } });
}

export default function ResetConfirm() {
  const { t, error } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Set a new password</h1>
      <p className="cd-auth-sub">Choose a new password for your account.</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/reset/confirm">
        <input type="hidden" name="t" value={t} />
        <label className="cd-auth-label" htmlFor="password">
          New password
        </label>
        <PasswordField id="password" autoComplete="new-password" minLength={10} autoFocus />
        <p className="cd-auth-hint">At least 10 characters.</p>
        <AuthSubmit label="Save password" pendingLabel="Saving…" />
      </AuthForm>
      <div className="cd-auth-links">
        <a href="/reset">Request a new link</a>
        <a href="/login">Back to sign in</a>
      </div>
    </AuthShell>
  );
}
