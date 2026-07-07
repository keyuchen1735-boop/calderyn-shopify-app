import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useEffect, useState } from "react";
import dashboard from "~/styles/dashboard.css?url";
import {
  getSessionFromRequest,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { rateLimit, checkSameOrigin, jsonError, wantsJson, publicBaseUrl } from "~/lib/dashboard/http.server";
import { sendVerificationEmail } from "~/lib/auth/verify.server";
import { getSupabase } from "~/lib/supabase.server";
import { AuthShell, AuthError, AuthNotice, AuthForm, useAuthFormPending } from "~/components/auth/AuthCard";
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

// Compensating decrement of a just-consumed rate-limit token when the action it
// gated failed. Targets the current window row (rate_limit_touch upserts the
// newest window_start for a bucket), so only successful sends net-count against
// the resend limit. Best-effort and never throws — the limiter fails open.
async function refundResendHit(bucket: string): Promise<void> {
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("rate_limit_hits")
      .select("window_start, count")
      .eq("bucket", bucket)
      .order("window_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return;
    await sb
      .from("rate_limit_hits")
      .update({ count: Math.max(0, Number(data.count) - 1) })
      .eq("bucket", bucket)
      .eq("window_start", data.window_start as string);
  } catch (err) {
    console.error("[verify-resend] rate-limit refund failed", err);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;
  // A signed-out visitor (expired session) should land on /login for a form POST,
  // matching the loader — not a raw 401 JSON that paints into the tab.
  const session = await getSessionFromRequest(request);
  if (!session) return wantsJson(request) ? jsonError(401, "unauthenticated") : redirect("/login");
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
  const resendBucket = `verify-resend:${session.userId}`;
  if (!(await rateLimit(resendBucket, 3, 15 * 60_000))) return fail(429, "rate_limited");
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  const email = data?.email as string | null;
  const baseUrl = publicBaseUrl();
  // Honest result: "Email sent" only when the mailer accepted it.
  const delivery = email
    ? await sendVerificationEmail(session.userId, email, baseUrl).catch(() => ({ sent: false }))
    : { sent: false };
  if (!delivery.sent) {
    // A failed send must NOT consume the resend budget — otherwise a transient
    // mailer outage locks a new merchant out of the gate with no recovery.
    // Refund the token so the merchant can retry once the mailer recovers.
    await refundResendHit(resendBucket);
    return fail(502, "send_failed");
  }
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return redirect("/dashboard/verify-needed?notice=sent");
}

const RESEND_COOLDOWN_S = 30;
const VERIFIED_POLL_MS = 4000;

/** Resend button: pending while submitting, counting down after a fresh send. */
function ResendButton({ cooldown }: { cooldown: number }) {
  const pending = useAuthFormPending();
  const label = pending
    ? "Sending…"
    : cooldown > 0
      ? `Resend in ${cooldown}s`
      : "Resend the email";
  return (
    <button className="cd-auth-submit" type="submit" disabled={pending || cooldown > 0}>
      {label}
    </button>
  );
}

export default function VerifyNeeded() {
  const { email, error, notice } = useLoaderData<typeof loader>();

  // Auto-advance: the link is often opened in another tab or on the phone, so
  // poll the session until it reports verified and move this tab along. A
  // setTimeout chain (not setInterval) so slow responses can't overlap, with
  // every await followed by a stop-flag re-check so a torn-down page can't
  // fire a stray navigation. Backs off after ~2 minutes: an abandoned tab
  // shouldn't hit the session table every 4s forever.
  useEffect(() => {
    let stopped = false;
    let attempts = 0;
    let timer: number | undefined;
    const ctrl = new AbortController();
    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(tick, attempts < 30 ? VERIFIED_POLL_MS : 30000);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.hidden) {
        schedule();
        return;
      }
      attempts += 1;
      try {
        const res = await fetch("/dashboard/api/session-status", {
          credentials: "same-origin",
          signal: ctrl.signal,
        });
        if (!stopped && res.ok) {
          const data = (await res.json()) as { verified?: boolean };
          if (!stopped && data.verified) {
            stopped = true;
            // replace, not assign: this is an automatic advance, and Back must
            // not land on a gate page whose poll would immediately bounce again.
            location.replace("/dashboard");
            return;
          }
        }
      } catch {
        // Network blip or abort; the next tick retries.
      }
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // The resend round-trip is a full document POST, so client state resets on
  // return; key the cooldown off the ?notice=sent the redirect carries.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (notice === "sent") setCooldown(RESEND_COOLDOWN_S);
  }, [notice]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  return (
    <AuthShell>
      <h1 className="cd-auth-title">Check your email</h1>
      <p className="cd-auth-sub">
        We sent a link{email ? ` to ${email}` : ""}.
      </p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      <AuthForm action="/dashboard/verify-needed">
        <ResendButton cooldown={cooldown} />
      </AuthForm>
      <form method="post" action="/dashboard/verify-needed" style={{ marginTop: 16 }}>
        <input type="hidden" name="intent" value="signout" />
        <button className="cd-auth-linkbtn" type="submit">
          Sign out
        </button>
      </form>
    </AuthShell>
  );
}
