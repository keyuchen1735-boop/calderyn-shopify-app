import type { ActionFunctionArgs } from "@remix-run/node";
import {
  getDashboardSessionAllowUnverified,
  authClearCookieHeaders,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { rateLimit } from "~/lib/rate-limit.server";
import { deleteAccount } from "~/lib/auth/delete-account.server";
import { isShowcaseShop } from "~/lib/demo/showcase.server";

// POST { intent: "delete", confirm: "DELETE" }: permanently delete the signed-in
// first-party account. Frees the email for re-registration and, when the user is
// the shop's sole member, tears down the store and all its data (Postgres
// cascades handle the ~90 shop-scoped tables). Irreversible; the typed "DELETE"
// confirmation is re-validated here so a regressed UI can never trigger it by
// accident.
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Allow-unverified: someone who signed up but never verified their email (or
  // is still mid-onboarding) must be able to bail out and re-register.
  const session = await getDashboardSessionAllowUnverified(request);

  // First-party accounts only. Legacy Shopify (shop-based) sessions have no
  // users row to delete and manage their store through the embedded admin.
  if (session.userId == null) {
    return jsonError(400, "not_first_party", "This account type can't be deleted here.");
  }

  // Never let a demo/showcase store be self-destructed. It is reached through a
  // SHARED public login (the sole member), so deleting "the account" would free
  // that shared email and cascade-delete the demo store for everyone. Deletion is
  // never the right op on a demo shop — resetDemoShowcase is (409 not_demo_shop
  // guards the reverse). Mirrors resetDemoShowcase's demo_mode hard gate.
  if (await isShowcaseShop(session.shopId)) {
    return jsonError(403, "demo_shop_protected", "The demo account can't be deleted.");
  }

  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== "DELETE") {
    return jsonError(400, "confirmation_required", "Type DELETE to confirm.");
  }

  // Throttle keyed on the user: absorbs a double-click racing two deletes and
  // caps abuse. Retries are safe — a re-run just no-ops on already-gone rows.
  if (!(await rateLimit(`delete-account:${session.userId}`, 3, 60_000))) {
    return jsonError(429, "rate_limited", "Too many attempts. Try again in a minute.");
  }

  await deleteAccount(session.userId, session.shopId);

  // The account's sessions are already gone (cascade), but the browser still
  // holds the cookies — clear every auth-adjacent one so no stale token can
  // linger on the wire (same teardown as logout).
  const headers = new Headers();
  for (const cookie of authClearCookieHeaders()) headers.append("Set-Cookie", cookie);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
