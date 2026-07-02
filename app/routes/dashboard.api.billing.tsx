// Payouts / billing status for the dashboard Settings screen (#11 Stripe Connect).
// GET returns the BillingDTO; POST {intent} starts hosted onboarding or re-syncs
// account status. All Stripe/DB work lives in connect.server — this is the boundary.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  billingStatus,
  startOnboarding,
  syncAccountStatus,
  onboardingOrigin,
} from "~/lib/payments/connect.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => billingStatus(session.shopId));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  if (body.intent === "start-onboarding") {
    return dashboardJson(() => startOnboarding(session.shopId, onboardingOrigin(request)));
  }
  if (body.intent === "refresh-status") {
    return dashboardJson(async () => {
      await syncAccountStatus(session.shopId);
      return billingStatus(session.shopId);
    });
  }
  return jsonError(422, "invalid_intent");
}
