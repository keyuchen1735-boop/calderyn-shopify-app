// app/routes/dashboard.signup.tsx
// Door B: first-party merchant signup (email + password). Creates the user, an
// owned shop, the membership link, and a session (no Shopify involved).
import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { isValidEmail, normalizeEmail, findUserByEmail, createUser, deleteUser } from "~/lib/auth/users.server";
import { provisionOwnedShop, linkMembership } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { sendVerificationEmail } from "~/lib/auth/verify.server";

export const meta: MetaFunction = () => [{ title: "Create your account — Calderyn" }];

const MIN_PASSWORD = 10;

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "dash-signup"), 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");
  const store = String(fd.get("store") ?? "").trim();

  if (!isValidEmail(email)) return jsonError(422, "invalid_email");

  // Per-email limit after we know the address is syntactically valid. Keyed on
  // the normalized form so casing variants share a bucket. 5 attempts / hour.
  if (!(await rateLimit(`signup-acct:${normalizeEmail(email)}`, 5, 60 * 60_000))) {
    return jsonError(429, "rate_limited");
  }

  if (password.length < MIN_PASSWORD) return jsonError(422, "weak_password", `Use at least ${MIN_PASSWORD} characters`);
  if (!store) return jsonError(422, "missing_store");

  if (await findUserByEmail(email)) return jsonError(409, "email_taken");

  // Race-safe: the check above plus the unique(email) constraint. If two signups
  // for the same email collide, the loser's insert violates the constraint;
  // map that (Postgres 23505) to the same clean 409, not a 500.
  let userId: string;
  try {
    ({ id: userId } = await createUser(email, password));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return jsonError(409, "email_taken");
    throw err;
  }
  // Compensating cleanup: if anything after createUser fails, delete the just-
  // created user so the email is not permanently locked and a retry can succeed.
  try {
    const { shopId } = await provisionOwnedShop(store);
    await linkMembership(userId, shopId, "owner");

    const { raw } = await createSessionForUser(userId, shopId);
    const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
    await sendVerificationEmail(userId, normalizeEmail(email), baseUrl).catch(() => {});
    return redirect("/dashboard", {
      headers: { "Set-Cookie": sessionCookieHeader(raw) },
    });
  } catch (err) {
    await deleteUser(userId).catch(() => {});
    throw err;
  }
}

export default function SignupRoute() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Create your Calderyn account</h1>
      <p>
        <a href="/dashboard/auth/google" style={{ display: "inline-block", padding: ".6rem 1rem", fontWeight: 600, border: "1px solid #cbd2e0", borderRadius: ".5rem", textDecoration: "none", color: "inherit" }}>
          Continue with Google
        </a>
      </p>
      <form method="post" action="/dashboard/signup">
        <label htmlFor="store">Store name</label>
        <input id="store" name="store" type="text" required style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" style={{ display: "block", width: "100%", margin: ".25rem 0 1rem", padding: ".6rem .75rem", boxSizing: "border-box" }} />
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Create account</button>
      </form>
      <p><a href="/dashboard/signin">Already have an account? Sign in</a></p>
    </main>
  );
}
