import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
import { normalizeEmail } from "~/lib/auth/users.server";
import { requestPasswordReset } from "~/lib/auth/reset.server";

// Referrer-Policy: no-referrer prevents the form submission URL from leaking
// any partial token data via the Referer header on subsequent navigations.
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

// The user-facing page moved to /reset; GETs here redirect there.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/reset${url.search}`);
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fail = (status: number, code: string) =>
    wantsJson(request) ? jsonError(status, code) : redirect(`/reset?error=${code}`);

  if (!(await rateLimit(clientIpKey(request, "dash-reset"), 5, 60_000))) return fail(429, "rate_limited");
  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");

  // Per-email limit to block email-bombing a single address from rotating IPs.
  // Keyed on the submitted email regardless of whether an account exists so
  // this check never reveals account existence. 3 requests / 15 min per address.
  if (!(await rateLimit(`reset-acct:${normalizeEmail(email)}`, 3, 15 * 60_000))) {
    return fail(429, "rate_limited");
  }

  const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  await requestPasswordReset(email, baseUrl);
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  return redirect("/reset?notice=sent", { headers: { "Referrer-Policy": "no-referrer" } });
}
