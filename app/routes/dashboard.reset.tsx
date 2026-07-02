import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { normalizeEmail } from "~/lib/auth/users.server";
import { requestPasswordReset } from "~/lib/auth/reset.server";

// Referrer-Policy: no-referrer prevents the form submission URL from leaking
// any partial token data via the Referer header on subsequent navigations.
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-reset"), 5, 60_000))) return jsonError(429, "rate_limited");
  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");

  // Per-email limit to block email-bombing a single address from rotating IPs.
  // Keyed on the submitted email regardless of whether an account exists so
  // this check never reveals account existence. 3 requests / 15 min per address.
  if (!(await rateLimit(`reset-acct:${normalizeEmail(email)}`, 3, 15 * 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  await requestPasswordReset(email, baseUrl);
  return new Response(
    "<!doctype html><meta charset=utf-8><main style='font:16px/1.5 system-ui;max-width:26rem;margin:12vh auto;padding:0 1.5rem'><h1 style='font-size:1.25rem'>Check your email</h1><p>If an account exists for that address, a reset link is on its way.</p></main>",
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

export default function ResetRequest() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Reset your password</h1>
      <form method="post" action="/dashboard/reset">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Send reset link</button>
      </form>
    </main>
  );
}
