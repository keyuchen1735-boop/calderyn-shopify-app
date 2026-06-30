import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getDashboardSessionAllowUnverified } from "~/lib/dashboard/session.server";
import { rateLimit, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { sendVerificationEmail } from "~/lib/auth/verify.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getDashboardSessionAllowUnverified(request);
  if (session.emailVerified || session.userId == null) {
    return { email: null as string | null };
  }
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  return { email: (data?.email as string | null) ?? null };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await getDashboardSessionAllowUnverified(request);
  if (session.userId == null) return jsonError(400, "not_first_party");
  if (!(await rateLimit(`verify-resend:${session.userId}`, 3, 15 * 60_000))) return jsonError(429, "rate_limited");
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  const email = data?.email as string | null;
  const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  if (email) await sendVerificationEmail(session.userId, email, baseUrl).catch(() => {});
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default function VerifyNeeded() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "28rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Verify your email</h1>
      <p>We sent a verification link{email ? ` to ${email}` : ""}. Click it to unlock your dashboard.</p>
      <form method="post" action="/dashboard/verify-needed">
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Resend the email</button>
      </form>
      <p style={{ marginTop: "1rem" }}>
        <form method="post" action="/dashboard/api/logout">
          <button type="submit" style={{ background: "none", border: "none", padding: 0, color: "inherit", cursor: "pointer", textDecoration: "underline" }}>Sign out</button>
        </form>
      </p>
    </main>
  );
}
