// app/routes/storefront.account.login.verify.tsx
// Magic-link verification (platform pivot #1b). The emailed link is a GET; email clients and
// security scanners PRE-FETCH GET links, which would burn a single-use token before the buyer
// clicks. So the GET loader only checks the token is PRESENT and renders a "Complete sign in"
// button — the token is CONSUMED on the POST, an explicit human action. On success we mint a
// buyer session and set the __Host- cookie; a bad/expired/used token sends the buyer back to
// request a fresh link.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { consumeMagicLink } from "~/lib/buyer/magic-link.server";
import { createBuyerSession, buyerSessionCookieHeader } from "~/lib/buyer/session.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
import { storeNameFromMatches } from "~/lib/storefront/meta";

export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export const meta: MetaFunction = ({ matches }) => [
  { title: `Complete sign in — ${storeNameFromMatches(matches)}` },
  { name: "robots", content: "noindex" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");
  const token = new URL(request.url).searchParams.get("t") ?? "";
  // Do NOT consume here — a missing token is the only thing we can decide on a GET.
  return json({ hasToken: token.length > 0, token });
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");

  if (!(await rateLimit(clientIpKey(request, "buyer-verify"), 10, 60_000))) {
    return redirect("/storefront/account/login?error=rate_limited");
  }

  const form = await request.formData();
  const token = typeof form.get("t") === "string" ? String(form.get("t")) : "";
  const consumed = token ? await consumeMagicLink(shopId, token) : null;
  if (!consumed) {
    // Unknown / expired / already-used — send the buyer to request a fresh link (fail visibly).
    return redirect("/storefront/account/login?error=link_invalid");
  }

  const { raw } = await createBuyerSession(shopId, consumed.buyerId);
  return redirect("/storefront/account", {
    headers: { "Set-Cookie": buyerSessionCookieHeader(raw), "Referrer-Policy": "no-referrer" },
  });
}

export default function VerifyMagicLink() {
  const { hasToken, token } = useLoaderData<typeof loader>();
  if (!hasToken) {
    return (
      <section className="cd-account cd-account--narrow">
        <h1>This sign-in link is invalid</h1>
        <p className="cd-account__lead">The link is missing or malformed.</p>
        <a className="cd-account__submit" href="/storefront/account/login">
          Request a new link
        </a>
      </section>
    );
  }
  return (
    <section className="cd-account cd-account--narrow">
      <h1>You&apos;re almost in</h1>
      <p className="cd-account__lead">Confirm below to finish signing in.</p>
      <form method="post" className="cd-account__form">
        <input type="hidden" name="t" value={token} />
        <button type="submit" className="cd-account__submit">
          Complete sign in
        </button>
      </form>
    </section>
  );
}
