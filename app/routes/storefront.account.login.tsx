// app/routes/storefront.account.login.tsx
// Buyer login — request a passwordless magic link (platform pivot #1b). Scoped to the shop's
// storefront (buyer identity is per-shop). The action is NON-ENUMERABLE: it returns the same
// "check your email" notice whether or not the email has an account, and it never reveals which
// emails are registered. Rate-limited per-IP and per-email to blunt link-bombing.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { requestBuyerMagicLink } from "~/lib/buyer/magic-link.server";
import { normalizeEmail } from "~/lib/buyer/identity.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
import { storeNameFromMatches } from "~/lib/storefront/meta";

// Keep the emailed link out of the Referer header on any onward navigation.
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const meta: MetaFunction = ({ matches }) => [
  { title: `Sign in — ${storeNameFromMatches(matches)}` },
  { name: "robots", content: "noindex" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // The demo shell has no real tenant, so no accounts — send browsers back to the storefront.
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");
  const url = new URL(request.url);
  return json({
    sent: url.searchParams.get("notice") === "sent",
    error: url.searchParams.get("error"),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");

  // Per-IP throttle across all addresses, plus a per-address throttle to block bombing one inbox
  // from rotating IPs. The per-email key is hashed via normalizeEmail regardless of existence, so
  // it never reveals whether an account exists.
  if (!(await rateLimit(clientIpKey(request, "buyer-login"), 5, 60_000))) {
    return redirect("/storefront/account/login?error=rate_limited");
  }

  const form = await request.formData();
  const emailRaw = typeof form.get("email") === "string" ? String(form.get("email")).trim() : "";
  if (!EMAIL_RE.test(emailRaw) || emailRaw.length > 320) {
    return redirect("/storefront/account/login?error=invalid_email");
  }
  if (!(await rateLimit(`buyer-login-acct:${normalizeEmail(emailRaw)}`, 3, 15 * 60_000))) {
    return redirect("/storefront/account/login?error=rate_limited");
  }

  // Per-shop base: the storefront is served per-tenant-host, so the request origin is the correct
  // absolute base for the emailed link (it lands the buyer back on THIS shop's storefront).
  const baseUrl = new URL(request.url).origin;
  await requestBuyerMagicLink(shopId, emailRaw, baseUrl);
  // Always the same response, regardless of whether the email had an account (no enumeration).
  return redirect("/storefront/account/login?notice=sent", {
    headers: { "Referrer-Policy": "no-referrer" },
  });
}

export default function BuyerLogin() {
  const { sent, error } = useLoaderData<typeof loader>();
  return (
    <section className="cd-account cd-account--narrow">
      <h1>Sign in</h1>
      {sent ? (
        <p className="cd-account__notice">
          If an account exists for that email, we&apos;ve sent a sign-in link. Check your inbox — the
          link is valid for 15 minutes.
        </p>
      ) : (
        <>
          <p className="cd-account__lead">
            Enter your email and we&apos;ll send you a link to sign in. No password needed.
          </p>
          {error === "invalid_email" ? (
            <p className="cd-account__error">Please enter a valid email address.</p>
          ) : null}
          {error === "rate_limited" ? (
            <p className="cd-account__error">Too many attempts. Please wait a moment and try again.</p>
          ) : null}
          <form method="post" className="cd-account__form">
            <label className="cd-account__field">
              <span>Email</span>
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <button type="submit" className="cd-account__submit">
              Email me a sign-in link
            </button>
          </form>
        </>
      )}
    </section>
  );
}
