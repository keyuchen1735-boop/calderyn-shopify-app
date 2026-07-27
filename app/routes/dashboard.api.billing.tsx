// Payouts / billing status for the dashboard Settings screen (#11 Stripe Connect).
// GET returns the BillingDTO; POST {intent} starts hosted onboarding or re-syncs
// account status. All Stripe/DB work lives in connect.server — this is the boundary.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin, rateLimit } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import {
  billingStatus,
  expressLoginLink,
  startOnboarding,
  syncAccountStatus,
  onboardingOrigin,
} from "~/lib/payments/connect.server";
import { PayoutAccountError } from "~/lib/payments/errors";

/**
 * A Stripe-side refusal is upstream truth, not a bug in this handler: re-throw it
 * as a CalderynError so the merchant reads what Stripe said instead of the generic
 * `internal_error` dashboardJson gives an unrecognized throw.
 */
async function surfacingPayoutErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PayoutAccountError) {
      throw new CalderynError({ status: 502, code: err.code, message: err.message });
    }
    throw err;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => billingStatus(session.shopId));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Bound live Stripe account/link creation per shop: start-onboarding hits the
  // billable Stripe API on every POST, so an authenticated client must not be able
  // to loop it (sibling write routes rate-limit for the same reason).
  if (!(await rateLimit(`billing:${session.shopId}`, 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  if (body.intent === "start-onboarding") {
    return dashboardJson(() =>
      surfacingPayoutErrors(() => startOnboarding(session.shopId, onboardingOrigin(request))),
    );
  }
  if (body.intent === "refresh-status") {
    return dashboardJson(() =>
      surfacingPayoutErrors(async () => {
        await syncAccountStatus(session.shopId);
        return billingStatus(session.shopId);
      }),
    );
  }
  if (body.intent === "login-link") {
    // Minted on demand only — a login link is single-use and almost always
    // discarded when fetched eagerly with the status DTO.
    return dashboardJson(() =>
      surfacingPayoutErrors(async () => {
        const link = await expressLoginLink(session.shopId);
        if (!link) {
          throw new CalderynError({ status: 409, code: "not_onboarded", message: "Payouts account is not onboarded yet." });
        }
        return link;
      }),
    );
  }
  return jsonError(422, "invalid_intent");
}
