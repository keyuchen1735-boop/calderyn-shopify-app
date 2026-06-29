// app/routes/dashboard.signin.tsx
// Door B: first-party email + password sign-in. Lives next to the existing
// Shopify-OAuth login (/dashboard/login), which is unchanged.
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { verifyUserCredentials } from "~/lib/auth/users.server";
import { resolveShopForUser } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-signin"), 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");

  // Per-account throttle beyond the per-IP limit: stops credential-stuffing a
  // single account from rotating IPs. 5 attempts / 15 min per email.
  if (!(await rateLimit(`signin-acct:${email.trim().toLowerCase()}`, 5, 15 * 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const user = await verifyUserCredentials(email, password);
  if (!user) return jsonError(401, "invalid_credentials");

  const shopId = await resolveShopForUser(user.id);
  if (!shopId) return jsonError(409, "no_shop"); // account exists but no store linked yet

  const { raw } = await createSessionForUser(user.id, shopId);
  return redirect("/dashboard", { headers: { "Set-Cookie": sessionCookieHeader(raw) } });
}

export default function SigninRoute() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Sign in to Calderyn</h1>
      <form method="post" action="/dashboard/signin">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Sign in</button>
      </form>
      <p><a href="/dashboard/reset">Forgot password?</a> · <a href="/dashboard/signup">Create an account</a></p>
    </main>
  );
}
