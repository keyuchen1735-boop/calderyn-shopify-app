// app/routes/dashboard.onboarding.tsx
// Post-signup onboarding for first-party (email/Google) users, in two steps run
// before the dashboard on every path:
//   1. contact — required phone + "how did you hear about us"
//   2. import  — bring a Shopify store over, or explicitly skip
// Only step 2 marks the user onboarded (onboarded_at), so the session gate in
// session.server holds the user here until the import step is answered. A
// validated return_to is threaded through so a flow interrupted by the gate
// (e.g. the connector consent ?t=…) resumes at its original destination.
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson, safeDashboardReturnTo } from "~/lib/dashboard/http.server";
import {
  normalizePhone,
  isReferralSource,
  saveOnboardingContact,
  completeOnboarding,
  getOnboardingProgress,
} from "~/lib/auth/onboarding.server";
import { AuthShell, AuthError, AuthForm, AuthSubmit } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Almost there — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

// Where a first-party user goes once onboarding is done: a threaded return_to
// wins (resume the interrupted flow); otherwise unverified email users owe the
// verify gate and verified (Google) users land on the dashboard.
function nextAfterOnboarding(emailVerified: boolean): string {
  return emailVerified ? "/dashboard" : "/dashboard/verify-needed";
}

// This screen's own URL, carrying return_to so it survives the step-1 → step-2 hop.
function onboardingHref(returnTo: string | null): string {
  return returnTo ? `/dashboard/onboarding?return_to=${encodeURIComponent(returnTo)}` : "/dashboard/onboarding";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/login");
  // Shopify (shop-based) sessions and already-onboarded users don't belong here.
  if (session.userId == null || session.onboardedAt != null) {
    return redirect(nextAfterOnboarding(session.emailVerified));
  }
  const url = new URL(request.url);
  // Phone saved ⇒ contact step done ⇒ show the import step; otherwise start at contact.
  const { phone } = await getOnboardingProgress(session.userId);
  const step: "contact" | "import" = phone ? "import" : "contact";
  return {
    step,
    error: url.searchParams.get("error"),
    returnTo: safeDashboardReturnTo(url.searchParams.get("return_to")),
  };
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
  // Already onboarded (stale tab / replayed POST): the loader would have bounced a
  // GET; guard the write side too so a replay can't overwrite a completed profile.
  if (session.onboardedAt != null) {
    return wantsJson(request)
      ? jsonError(409, "already_onboarded")
      : redirect(nextAfterOnboarding(session.emailVerified));
  }
  if (!(await rateLimit(clientIpKey(request, "dash-onboarding"), 10, 60_000))) return fail(429, "rate_limited");

  const fd = await request.formData().catch(() => new FormData());
  const intent = String(fd.get("intent") ?? "");
  const returnTo = safeDashboardReturnTo(fd.get("return_to") == null ? null : String(fd.get("return_to")));

  // Every onboarding form posts an explicit intent (contact | connect | skip).
  // A missing/unknown one must fail visibly, not silently fall through to the
  // contact handler with an empty phone — that silent default is what turned a
  // dropped-intent submit into a confusing bounce loop instead of a clear error
  // (rule 12: fail visibly, not silently).
  if (intent !== "contact" && intent !== "connect" && intent !== "skip") {
    return fail(400, "invalid_intent");
  }

  // Step 2 — the import choice completes onboarding. Guard: contact must already be
  // saved, so we never mark a user onboarded with a blank phone/referral profile.
  if (intent === "connect" || intent === "skip") {
    let phone: string | null;
    try {
      ({ phone } = await getOnboardingProgress(session.userId));
    } catch (err) {
      console.error("[onboarding] progress read failed", err);
      return fail(500, "save_failed");
    }
    if (!phone) {
      return wantsJson(request) ? jsonError(400, "contact_required") : redirect(onboardingHref(returnTo));
    }
    try {
      await completeOnboarding(session.userId);
    } catch (err) {
      console.error("[onboarding] complete failed", err);
      return fail(500, "save_failed");
    }
    // Connect hands off to the existing Shopify OAuth → callback → #13 import machine
    // (it runs startImport + kickDrainSoon and steers to the store/import screen).
    if (intent === "connect") return redirect("/dashboard/login");
    // Skip: resume the interrupted flow if one was threaded, else the default target.
    return redirect(returnTo ?? nextAfterOnboarding(session.emailVerified));
  }

  // Step 1 — contact (phone + how-heard). Saved WITHOUT marking onboarded, so the
  // gate holds the user on the import step next.
  const phone = normalizePhone(String(fd.get("phone") ?? ""));
  const referral = String(fd.get("referral_source") ?? "");
  // Clamp the free text at the boundary — never trust the browser maxLength.
  const referralOther = String(fd.get("referral_source_other") ?? "").trim().slice(0, 120) || null;

  if (!phone) return fail(422, "invalid_phone");
  if (!isReferralSource(referral)) return fail(422, "invalid_referral");

  try {
    await saveOnboardingContact(session.userId, {
      phone,
      referralSource: referral,
      referralOther: referral === "other" ? referralOther : null,
    });
  } catch (err) {
    console.error("[onboarding] save failed", err);
    return fail(500, "save_failed");
  }
  return redirect(onboardingHref(returnTo));
}

function ContactStep({ error, returnTo }: { error: string | null; returnTo: string | null }) {
  const [referral, setReferral] = useState("");
  return (
    <>
      <h1 className="cd-auth-title">Almost there</h1>
      <p className="cd-auth-sub">Two quick things, then bring your store over.</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/onboarding">
        <input type="hidden" name="intent" value="contact" />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
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
      </AuthForm>
    </>
  );
}

function ImportStep({ error, returnTo }: { error: string | null; returnTo: string | null }) {
  // connect and skip each get their own form with the intent as a hidden field.
  // A submit button's own name/value is an unreliable carrier (it's dropped
  // unless the button is the recognized submitter); a hidden input always
  // serializes — the same pattern the contact step above relies on.
  return (
    <>
      <h1 className="cd-auth-title">Bring your store over</h1>
      <p className="cd-auth-sub">Connect Shopify to import your products, orders, and customers.</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/onboarding">
        <input type="hidden" name="intent" value="connect" />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <button className="cd-auth-submit" type="submit">
          Connect Shopify
        </button>
      </AuthForm>
      <AuthForm action="/dashboard/onboarding" style={{ marginTop: 12 }}>
        <input type="hidden" name="intent" value="skip" />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <button className="cd-auth-linkbtn" type="submit">
          Skip for now
        </button>
      </AuthForm>
    </>
  );
}

export default function Onboarding() {
  const { step, error, returnTo } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      {step === "import" ? (
        <ImportStep error={error} returnTo={returnTo} />
      ) : (
        <ContactStep error={error} returnTo={returnTo} />
      )}
    </AuthShell>
  );
}
