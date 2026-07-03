// app/routes/dashboard.signup.tsx
// Door B: first-party merchant signup (email + password). Creates the user, an
// owned shop, the membership link, and a session (no Shopify involved).
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson, publicBaseUrl } from "~/lib/dashboard/http.server";
import { isValidEmail, normalizeEmail, findUserByEmail, createUser, deleteUser } from "~/lib/auth/users.server";
import { provisionOwnedShop, linkMembership } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { sendVerificationEmail } from "~/lib/auth/verify.server";

const MIN_PASSWORD = 10;

// The user-facing page moved to /signup; GETs here redirect there.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/signup${url.search}`);
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;

  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");
  const store = String(fd.get("store") ?? "").trim();

  // JSON for programmatic clients; plain form posts bounce back to /signup
  // with the error code and the non-secret fields preserved.
  const fail = (status: number, code: string, message?: string) =>
    wantsJson(request)
      ? jsonError(status, code, message)
      : redirect(
          `/signup?error=${code}&email=${encodeURIComponent(email)}&store=${encodeURIComponent(store)}`,
        );

  if (!(await rateLimit(clientIpKey(request, "dash-signup"), 10, 60_000))) {
    return fail(429, "rate_limited");
  }

  if (!isValidEmail(email)) return fail(422, "invalid_email");

  // Per-email limit after we know the address is syntactically valid. Keyed on
  // the normalized form so casing variants share a bucket. 5 attempts / hour.
  if (!(await rateLimit(`signup-acct:${normalizeEmail(email)}`, 5, 60 * 60_000))) {
    return fail(429, "rate_limited");
  }

  if (password.length < MIN_PASSWORD) return fail(422, "weak_password", `Use at least ${MIN_PASSWORD} characters`);
  if (!store) return fail(422, "missing_store");

  if (await findUserByEmail(email)) return fail(409, "email_taken");

  // Race-safe: the check above plus the unique(email) constraint. If two signups
  // for the same email collide, the loser's insert violates the constraint;
  // map that (Postgres 23505) to the same clean 409, not a 500.
  let userId: string;
  try {
    ({ id: userId } = await createUser(email, password));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return fail(409, "email_taken");
    console.error("[signup] account creation failed", err);
    return fail(500, "account_creation_failed");
  }
  // Compensating cleanup: if anything after createUser fails, delete the just-
  // created user so the email is not permanently locked and a retry can succeed.
  try {
    const { shopId } = await provisionOwnedShop(store);
    await linkMembership(userId, shopId, "owner");

    const { raw } = await createSessionForUser(userId, shopId);
    const baseUrl = publicBaseUrl();
    // Best-effort: a delivery failure must not fail the signup, but the user
    // should land on a resend prompt that tells the truth instead of waiting
    // on an email that never left.
    const delivery = await sendVerificationEmail(userId, normalizeEmail(email), baseUrl).catch(
      () => ({ sent: false }),
    );
    // A brand-new email account is always unverified, and /dashboard would just
    // bounce it to the verification gate anyway; go there directly.
    const dest = delivery.sent
      ? "/dashboard/verify-needed"
      : "/dashboard/verify-needed?error=send_failed";
    return redirect(dest, {
      headers: { "Set-Cookie": sessionCookieHeader(raw) },
    });
  } catch (err) {
    await deleteUser(userId).catch(() => {});
    // The rollback leaves a retry able to succeed, so bounce back to the form
    // with a retryable error instead of a raw 500.
    console.error("[signup] account creation failed", err);
    return fail(500, "account_creation_failed");
  }
}
