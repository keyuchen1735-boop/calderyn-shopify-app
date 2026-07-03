import type { HeadersFunction, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { consumeVerifyToken, markEmailVerified } from "~/lib/auth/verify.server";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import { AuthShell } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Verify your email — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export async function loader({ request }: LoaderFunctionArgs) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  const consumed = await consumeVerifyToken(t);
  if (!consumed) {
    // The resend page needs a session; an expired link opened on another
    // device has none, so its CTA must route through sign-in instead.
    const session = await getSessionFromRequest(request);
    return { ok: false, hasSession: session != null };
  }
  await markEmailVerified(consumed.userId);
  return redirect("/dashboard", { headers: { "Referrer-Policy": "no-referrer" } });
}

export default function VerifyRoute() {
  const { hasSession } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Link expired</h1>
      <p className="cd-auth-sub">This link no longer works.</p>
      <div className="cd-auth-links">
        {hasSession ? (
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
