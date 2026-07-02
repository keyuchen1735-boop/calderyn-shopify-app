// app/routes/dashboard.auth.google.store.tsx
// "Name your store" step for brand-new Google sign-in users. GET renders the
// form; POST validates the signup token, creates the user+shop atomically.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { verifyGoogleSignup } from "~/lib/auth/google-signup-token.server";
import { createGoogleUser, deleteUser } from "~/lib/auth/users.server";
import { provisionOwnedShop, linkMembership } from "~/lib/auth/tenant.server";
import { createSessionForUser, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const t = url.searchParams.get("t") ?? "";
  const expired = !t || !verifyGoogleSignup(t);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Name your store</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.5rem">` +
      (expired
        ? `<h1 style="font-size:1.25rem">Link expired</h1><p>Your sign-in link has expired. <a href="/dashboard/signin">Try again</a>.</p>`
        : `<h1 style="font-size:1.25rem">Name your store</h1>` +
          `<form method="post" action="/dashboard/auth/google/store">` +
          `<input type="hidden" name="t" value="${escHtml(t)}">` +
          `<label for="store">Store name</label>` +
          `<input id="store" name="store" type="text" required style="display:block;width:100%;margin:.25rem 0 1rem;padding:.6rem .75rem;box-sizing:border-box">` +
          `<button type="submit" style="padding:.6rem 1rem;font-weight:600">Continue</button>` +
          `</form>`) +
      `</body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (!(await rateLimit(clientIpKey(request, "google-store"), 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const fd = await request.formData();
  const t = String(fd.get("t") ?? "");
  const store = String(fd.get("store") ?? "").trim();

  const id = verifyGoogleSignup(t);
  if (!id) return jsonError(400, "invalid_or_expired");
  if (!store) return jsonError(422, "missing_store");

  // Atomic creation: if shop provisioning or membership fails, roll back the
  // user row so the email is not permanently locked and a retry can succeed.
  const { id: userId } = await createGoogleUser(id.email, id.sub);
  try {
    const { shopId } = await provisionOwnedShop(store);
    await linkMembership(userId, shopId, "owner");
    const { raw } = await createSessionForUser(userId, shopId);
    return redirect("/dashboard", { headers: { "Set-Cookie": sessionCookieHeader(raw) } });
  } catch (err) {
    await deleteUser(userId).catch(() => {});
    throw err;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
