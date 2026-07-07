import type { ActionFunctionArgs, HeadersFunction, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { consumeVerifyToken, markEmailVerified, peekVerifyToken } from "~/lib/auth/verify.server";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import { checkSameOrigin } from "~/lib/dashboard/http.server";
import { AuthShell, AuthForm } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Verify your email — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

// GET must be SAFE: an email scanner / link prefetcher follows this URL before
// the human does, so consuming the single-use token here would burn it and leave
// the user staring at "Link expired". Instead the GET only PEEKS the token and
// renders a one-tap confirm button; the token is consumed on the POST, which a
// scanner never issues.
export async function loader({ request }: LoaderFunctionArgs) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  if (await peekVerifyToken(t)) {
    return { ok: true as const, token: t, hasSession: false };
  }
  // The resend page needs a session; an expired link opened on another device
  // has none, so its CTA must route through sign-in instead.
  const session = await getSessionFromRequest(request);
  return { ok: false as const, token: "", hasSession: session != null };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;
  const fd = await request.formData().catch(() => new FormData());
  const t = String(fd.get("token") ?? "");
  const consumed = await consumeVerifyToken(t);
  if (!consumed) {
    const session = await getSessionFromRequest(request);
    return { ok: false as const, token: "", hasSession: session != null };
  }
  await markEmailVerified(consumed.userId);
  return redirect("/dashboard", { headers: { "Referrer-Policy": "no-referrer" } });
}

export default function VerifyRoute() {
  const data = useLoaderData<typeof loader>();
  if (data.ok) {
    return (
      <AuthShell>
        <h1 className="cd-auth-title">Confirm your email</h1>
        <p className="cd-auth-sub">One tap to verify this address and open your dashboard.</p>
        <AuthForm action="/dashboard/verify">
          <input type="hidden" name="token" value={data.token} />
          <button className="cd-auth-submit" type="submit">
            Verify my email
          </button>
        </AuthForm>
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Link expired</h1>
      <p className="cd-auth-sub">This link no longer works.</p>
      <div className="cd-auth-links">
        {data.hasSession ? (
          <>
            <a href="/dashboard/verify-needed">Request a new one</a>
            <a href="/login">Back to sign in</a>
          </>
        ) : (
          <a href="/login">Sign in to resend the link</a>
        )}
      </div>
    </AuthShell>
  );
}
