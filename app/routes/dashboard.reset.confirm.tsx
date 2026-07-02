import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect , useLoaderData } from "react-router";

import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { setPasswordWithToken } from "~/lib/auth/reset.server";

const MIN_PASSWORD = 10;

// Referrer-Policy: no-referrer is critical here because the reset token appears
// in the URL (?t=...). Without this header, clicking an external link while on
// this page would send the token in the Referer header to a third party.
export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export async function loader({ request }: LoaderFunctionArgs) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  return { t };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-reset-confirm"), 10, 60_000))) return jsonError(429, "rate_limited");
  const fd = await request.formData();
  const token = String(fd.get("t") ?? "");
  const password = String(fd.get("password") ?? "");
  if (password.length < MIN_PASSWORD) return jsonError(422, "weak_password", `Use at least ${MIN_PASSWORD} characters`);
  const ok = await setPasswordWithToken(token, password);
  if (!ok) return jsonError(400, "invalid_or_expired_token");
  return redirect("/dashboard/signin", { headers: { "Referrer-Policy": "no-referrer" } });
}

export default function ResetConfirm() {
  const { t } = useLoaderData<typeof loader>();
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Set a new password</h1>
      <form method="post" action="/dashboard/reset/confirm">
        <input type="hidden" name="t" value={t} />
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Save password</button>
      </form>
    </main>
  );
}
