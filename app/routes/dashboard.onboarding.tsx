// app/routes/dashboard.onboarding.tsx
// Post-signup onboarding for first-party (email/Google) users: a required phone
// number + "how did you hear about us", plus an optional hand-off to the existing
// Shopify OAuth + #13 import/cutover flow. Runs right after signup, before the
// email-verify gate; the onboarding gate in session.server redirects here.
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
import { normalizePhone, isReferralSource, setOnboardingProfile } from "~/lib/auth/onboarding.server";
import { AuthShell, AuthError, AuthForm, AuthSubmit } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Almost there — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

// Where a first-party user goes once onboarding is done: unverified email users
// still owe the verify gate; verified (Google) users land on the dashboard.
function nextAfterOnboarding(emailVerified: boolean): string {
  return emailVerified ? "/dashboard" : "/dashboard/verify-needed";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/login");
  // Shopify (shop-based) sessions and already-onboarded users don't belong here.
  if (session.userId == null || session.onboardedAt != null) {
    return redirect(nextAfterOnboarding(session.emailVerified));
  }
  return { error: new URL(request.url).searchParams.get("error") };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fail = (status: number, code: string) =>
    wantsJson(request) ? jsonError(status, code) : redirect(`/dashboard/onboarding?error=${code}`);

  const session = await getSessionFromRequest(request);
  // No live session (expired/revoked while this first-post-signup screen sat open):
  // HTML posts go to /login, JSON clients get a 401 — never a raw JSON body painted
  // into the browser tab (mirrors the loader's graceful handling).
  if (!session) return wantsJson(request) ? jsonError(401, "unauthenticated") : redirect("/login");

  // Only first-party users onboard; a shop-based session has no users row to write.
  if (session.userId == null) return fail(400, "not_first_party");
  if (!(await rateLimit(clientIpKey(request, "dash-onboarding"), 10, 60_000))) return fail(429, "rate_limited");

  const fd = await request.formData().catch(() => new FormData());
  const intent = String(fd.get("intent") ?? "finish");
  const phone = normalizePhone(String(fd.get("phone") ?? ""));
  const referral = String(fd.get("referral_source") ?? "");
  // Clamp the free text at the boundary — never trust the browser maxLength.
  const referralOther = String(fd.get("referral_source_other") ?? "").trim().slice(0, 120) || null;

  if (!phone) return fail(422, "invalid_phone");
  if (!isReferralSource(referral)) return fail(422, "invalid_referral");

  try {
    await setOnboardingProfile(session.userId, {
      phone,
      referralSource: referral,
      referralOther: referral === "other" ? referralOther : null,
    });
  } catch (err) {
    console.error("[onboarding] save failed", err);
    return fail(500, "save_failed");
  }

  // Optional Shopify port: hand off to the existing OAuth → callback → #13 import
  // machine (it runs startImport + kickDrainSoon and steers to the store/import
  // screen). The required fields are already saved above.
  if (intent === "connect") return redirect("/dashboard/login");
  return redirect(nextAfterOnboarding(session.emailVerified));
}

export default function Onboarding() {
  const { error } = useLoaderData<typeof loader>();
  const [referral, setReferral] = useState("");
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Almost there</h1>
      <p className="cd-auth-sub">Two quick things, then your dashboard.</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/onboarding">
        <label className="cd-auth-label" htmlFor="phone">
          Phone
        </label>
        <input
          className="cd-auth-input"
          id="phone"
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          placeholder="+1 415 555 0123"
          autoFocus
        />
        <label className="cd-auth-label" htmlFor="referral_source">
          How'd you hear about us?
        </label>
        <select
          className="cd-auth-input"
          id="referral_source"
          name="referral_source"
          required
          value={referral}
          onChange={(e) => setReferral(e.target.value)}
        >
          <option value="" disabled>
            Select one
          </option>
          <option value="google_search">Google / search</option>
          <option value="shopify_app_store">Shopify App Store</option>
          <option value="twitter_x">X (Twitter)</option>
          <option value="linkedin">LinkedIn</option>
          <option value="youtube">YouTube</option>
          <option value="tiktok_instagram">TikTok / Instagram</option>
          <option value="friend_colleague">Friend or colleague</option>
          <option value="other">Other</option>
        </select>
        {referral === "other" && (
          <input
            className="cd-auth-input"
            name="referral_source_other"
            type="text"
            maxLength={120}
            placeholder="Tell us more"
            aria-label="How you heard about us"
          />
        )}
        <AuthSubmit label="Continue" pendingLabel="Saving…" />
        <button
          className="cd-auth-linkbtn"
          type="submit"
          name="intent"
          value="connect"
          style={{ marginTop: 12 }}
        >
          Connect Shopify — bring your data over
        </button>
      </AuthForm>
    </AuthShell>
  );
}
