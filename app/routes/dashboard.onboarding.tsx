// app/routes/dashboard.onboarding.tsx
// Post-signup onboarding for first-party (email/Google) users, in three steps run
// before the dashboard on every path:
//   1. contact - optional phone (skippable) + required "how did you hear about us"
//   2. import  - bring a Shopify store over, or explicitly skip
//   3. products - if import is skipped, find dropshipping products to add
// Only the final choice marks the user onboarded (onboarded_at), so the session gate in
// session.server holds the user here until the catalog path is answered. A
// validated return_to is threaded through so a flow interrupted by the gate
// resumes at its original destination.
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import {
  rateLimit,
  clientIpKey,
  checkSameOrigin,
  jsonError,
  wantsJson,
  safeDashboardReturnTo,
  publicBaseUrl,
} from "~/lib/dashboard/http.server";
import {
  normalizePhone,
  isReferralSource,
  saveOnboardingContact,
  completeOnboarding,
  getOnboardingProgress,
} from "~/lib/auth/onboarding.server";
import { listDiscoverFeed, pickProduct } from "~/lib/sourcing/discover.server";
import type { DiscoverFeedItem } from "~/lib/sourcing/types";
import { AuthShell, AuthError, AuthForm, AuthSubmit } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Almost there - Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

function nextAfterOnboarding(emailVerified: boolean): string {
  return emailVerified ? "/dashboard" : "/dashboard/verify-needed";
}

function onboardingHref(
  returnTo: string | null,
  error?: string | null,
  step?: "products",
  selling?: string,
): string {
  const parts: string[] = [];
  if (error) parts.push(`error=${encodeURIComponent(error)}`);
  if (step) parts.push(`step=${step}`);
  if (selling) parts.push(`selling=${encodeURIComponent(selling)}`);
  if (returnTo) parts.push(`return_to=${encodeURIComponent(returnTo)}`);
  return parts.length ? `/dashboard/onboarding?${parts.join("&")}` : "/dashboard/onboarding";
}

function dashboardLoginHref(): string {
  const authBase = publicBaseUrl();
  return authBase ? `${authBase.replace(/\/+$/, "")}/dashboard/login` : "/dashboard/login";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/login");
  if (session.userId == null || session.onboardedAt != null) {
    return redirect(nextAfterOnboarding(session.emailVerified));
  }
  const url = new URL(request.url);
  const { contactDone } = await getOnboardingProgress(session.userId);
  const selling = url.searchParams.get("selling")?.trim().slice(0, 80) ?? "";
  const step: "contact" | "import" | "products" = contactDone
    ? url.searchParams.get("step") === "products"
      ? "products"
      : "import"
    : "contact";
  return {
    step,
    error: url.searchParams.get("error"),
    returnTo: safeDashboardReturnTo(url.searchParams.get("return_to")),
    selling,
    products: step === "products" && selling ? await listDiscoverFeed(8, selling) : [],
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  // Parse the body up front so every error branch can preserve the threaded
  // return_to — otherwise a single validation slip (mistyped phone, a rate-limit)
  // strips it and the interrupted deep-link / connector-consent flow never
  // resumes. JSON callers get a code (return_to lives in the URL for them).
  const fd = await request.formData().catch(() => new FormData());
  const intent = String(fd.get("intent") ?? "");
  const returnTo = safeDashboardReturnTo(fd.get("return_to") == null ? null : String(fd.get("return_to")));

  const fail = (status: number, code: string) => {
    if (wantsJson(request)) return jsonError(status, code);
    const productStep = intent === "import_products";
    const selling = String(fd.get("selling") ?? "").trim().slice(0, 80);
    return redirect(onboardingHref(returnTo, code, productStep ? "products" : undefined, selling));
  };

  const session = await getSessionFromRequest(request);
  if (!session) return wantsJson(request) ? jsonError(401, "unauthenticated") : redirect("/login");

  if (session.userId == null) return fail(400, "not_first_party");
  if (session.onboardedAt != null) {
    return wantsJson(request)
      ? jsonError(409, "already_onboarded")
      : redirect(nextAfterOnboarding(session.emailVerified));
  }
  if (!(await rateLimit(clientIpKey(request, "dash-onboarding"), 10, 60_000))) return fail(429, "rate_limited");

  if (
    intent !== "contact" &&
    intent !== "connect" &&
    intent !== "skip" &&
    intent !== "import_products" &&
    intent !== "finish_without_products"
  ) {
    return fail(400, "invalid_intent");
  }

  if (intent !== "contact") {
    let contactDone: boolean;
    try {
      ({ contactDone } = await getOnboardingProgress(session.userId));
    } catch (err) {
      console.error("[onboarding] progress read failed", err);
      return fail(500, "save_failed");
    }
    if (!contactDone) {
      return wantsJson(request) ? jsonError(400, "contact_required") : redirect(onboardingHref(returnTo));
    }
    if (intent === "skip") return redirect(onboardingHref(returnTo, null, "products"));
    if (intent === "import_products") {
      const sourceProductIds = [
        ...new Set(
          fd
            .getAll("source_product_id")
            .map(String)
            .filter((id) => id.length > 0 && id.length <= 100),
        ),
      ].slice(0, 8);
      if (!sourceProductIds.length) return fail(422, "select_product");
      // Import each pick independently. pickProduct is not idempotent — it mints a
      // fresh product per call — so aborting the whole batch on one failure and
      // sending the user back with the same items still checked would duplicate
      // the picks that already committed once they retry. Complete onboarding as
      // long as at least one product landed; only a total failure surfaces.
      let imported = 0;
      for (const sourceProductId of sourceProductIds) {
        try {
          await pickProduct(session.shopId, sourceProductId);
          imported += 1;
        } catch (err) {
          console.error(`[onboarding] product import failed for ${sourceProductId}`, err);
        }
      }
      if (imported === 0) return fail(500, "product_import_failed");
    }
    try {
      await completeOnboarding(session.userId);
    } catch (err) {
      console.error("[onboarding] complete failed", err);
      return fail(500, "save_failed");
    }
    if (intent === "connect") return redirect(dashboardLoginHref());
    if (intent === "import_products" && session.emailVerified) {
      return redirect(returnTo ?? "/dashboard/products/inventory");
    }
    return redirect(returnTo ?? nextAfterOnboarding(session.emailVerified));
  }

  // Phone is optional: an empty field is a deliberate skip and saves null. A
  // non-empty but unparseable number is still a validation error.
  const phoneRaw = String(fd.get("phone") ?? "").trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const referral = String(fd.get("referral_source") ?? "");
  const referralOther = String(fd.get("referral_source_other") ?? "").trim().slice(0, 120) || null;

  if (phoneRaw && !phone) return fail(422, "invalid_phone");
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
      <p className="cd-auth-sub">A few quick details, then set up your catalog.</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/onboarding">
        <input type="hidden" name="intent" value="contact" />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <label className="cd-auth-label" htmlFor="phone">
          Phone <span className="cd-auth-hint">(optional)</span>
        </label>
        <input
          className="cd-auth-input"
          id="phone"
          name="phone"
          type="tel"
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
        <AuthSubmit label="Continue" pendingLabel="Saving..." />
        <div style={{ marginTop: 12, textAlign: "center" }}>
          {/* type="button" so the click can clear the field first and never carries
              the intent itself — the hidden input above is the only carrier. Without
              JS it is inert; leaving the optional field blank does the same thing. */}
          <button
            className="cd-auth-linkbtn"
            type="button"
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (!form) return;
              const field = form.elements.namedItem("phone");
              if (field instanceof HTMLInputElement) field.value = "";
              form.requestSubmit();
            }}
          >
            Skip phone for now
          </button>
        </div>
      </AuthForm>
    </>
  );
}

function ImportStep({ error, returnTo }: { error: string | null; returnTo: string | null }) {
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
          I don’t have a Shopify store
        </button>
      </AuthForm>
    </>
  );
}

function ProductsStep({
  error,
  returnTo,
  selling,
  products,
}: {
  error: string | null;
  returnTo: string | null;
  selling: string;
  products: DiscoverFeedItem[];
}) {
  return (
    <>
      <h1 className="cd-auth-title">Find your first products</h1>
      <p className="cd-auth-sub">Tell us what you sell and we’ll find matching dropshipping products.</p>
      <AuthError code={error} />
      <form method="get" action="/dashboard/onboarding">
        <input type="hidden" name="step" value="products" />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <label className="cd-auth-label" htmlFor="selling">
          What are you selling?
        </label>
        <input
          className="cd-auth-input"
          id="selling"
          name="selling"
          type="text"
          defaultValue={selling}
          maxLength={80}
          placeholder="e.g. fitness gear"
          required
          autoFocus
        />
        <button className="cd-auth-submit" type="submit">
          Find products
        </button>
      </form>
      {selling && products.length > 0 && (
        <AuthForm action="/dashboard/onboarding" style={{ marginTop: 20 }}>
          <input type="hidden" name="intent" value="import_products" />
          <input type="hidden" name="selling" value={selling} />
          {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
          <fieldset style={{ border: 0, margin: "0 0 16px", padding: 0 }}>
            <legend className="cd-auth-label">Choose products</legend>
            {products.map((product) => (
              <label
                key={product.sourceProductId}
                style={{ display: "flex", gap: 10, alignItems: "center", margin: "10px 0" }}
              >
                <input type="checkbox" name="source_product_id" value={product.sourceProductId} />
                {product.imageUrl && (
                  <img
                    src={product.imageUrl}
                    alt=""
                    width={48}
                    height={48}
                    style={{ borderRadius: 8, objectFit: "cover" }}
                  />
                )}
                <span>
                  <strong>{product.title}</strong>
                  <small style={{ display: "block", color: "var(--text-2)" }}>
                    {product.supplierName} · ${(product.suggestedRetailCents / 100).toFixed(2)} retail
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <AuthSubmit label="Add to inventory" pendingLabel="Adding products..." />
        </AuthForm>
      )}
      {selling && products.length === 0 && (
        <p className="cd-auth-sub" style={{ marginTop: 16 }}>
          No matching products found. Try a broader description.
        </p>
      )}
      <AuthForm action="/dashboard/onboarding" style={{ marginTop: 12 }}>
        <input type="hidden" name="intent" value="finish_without_products" />
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <button className="cd-auth-linkbtn" type="submit">
          Skip product suggestions
        </button>
      </AuthForm>
    </>
  );
}

export default function Onboarding() {
  const { step, error, returnTo, selling, products } = useLoaderData<typeof loader>();
  return (
    <AuthShell>
      {step === "products" ? (
        <ProductsStep error={error} returnTo={returnTo} selling={selling} products={products} />
      ) : step === "import" ? (
        <ImportStep error={error} returnTo={returnTo} />
      ) : (
        <ContactStep error={error} returnTo={returnTo} />
      )}
    </AuthShell>
  );
}
