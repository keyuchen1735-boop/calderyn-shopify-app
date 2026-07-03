import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import {
  getDashboardSessionAllowUnverified,
  getSessionFromRequest,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { rateLimit, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
import { sendVerificationEmail } from "~/lib/auth/verify.server";
import { getSupabase } from "~/lib/supabase.server";
import { AuthShell, AuthError, AuthNotice } from "~/components/auth/AuthCard";
import { clearShopHintCookieHeader } from "~/lib/dashboard/cookies.server";

export const meta: MetaFunction = () => [{ title: "Verify your email — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // Signed-out visitors (stale bookmark, expired session) go to the login
  // page — not a raw 401 JSON error.
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/login");
  const params = {
    error: url.searchParams.get("error"),
    notice: url.searchParams.get("notice"),
  };
  if (session.emailVerified || session.userId == null) {
    return { email: null as string | null, ...params };
  }
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  return { email: (data?.email as string | null) ?? null, ...params };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;
  const session = await getDashboardSessionAllowUnverified(request);
  // Tolerate bodyless/non-form POSTs (fetch clients): formData() throws a
  // TypeError on a missing content type, which surfaced as a 500.
  const fd = await request.formData().catch(() => new FormData());

  // "Sign out" from the verification gate: revoke + clear cookies + land on
  // /login. (A form posting to the JSON logout API would paint {"ok":true}
  // into the tab instead.)
  if (String(fd.get("intent") ?? "") === "signout") {
    await revokeSession(session.sessionId).catch(() => {});
    const headers = new Headers();
    headers.append("Set-Cookie", clearSessionCookieHeader());
    headers.append("Set-Cookie", clearShopHintCookieHeader());
    return redirect("/login?notice=signed_out", { headers });
  }

  const fail = (status: number, code: string) =>
    wantsJson(request)
      ? jsonError(status, code)
      : redirect(`/dashboard/verify-needed?error=${code}`);

  if (session.userId == null) return fail(400, "not_first_party");
  if (!(await rateLimit(`verify-resend:${session.userId}`, 3, 15 * 60_000))) return fail(429, "rate_limited");
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  const email = data?.email as string | null;
  const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  // Honest result: "Email sent" only when the mailer accepted it.
  const delivery = email
    ? await sendVerificationEmail(session.userId, email, baseUrl).catch(() => ({ sent: false }))
    : { sent: false };
  if (!delivery.sent) return fail(502, "send_failed");
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return redirect("/dashboard/verify-needed?notice=sent");
}

export default function VerifyNeeded() {
  const { email, error, notice } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Check your email</h1>
      <p className="cd-auth-sub">
        We sent a link{email ? ` to ${email}` : ""}.
      </p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      <form method="post" action="/dashboard/verify-needed">
        <button className="cd-auth-submit" type="submit">
          Resend the email
        </button>
      </form>
      <form method="post" action="/dashboard/verify-needed" style={{ marginTop: 16 }}>
        <input type="hidden" name="intent" value="signout" />
        <button className="cd-auth-linkbtn" type="submit">
          Sign out
        </button>
      </form>
    </AuthShell>
  );
}
