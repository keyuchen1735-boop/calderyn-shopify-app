// Browser-facing legs of Stripe-hosted Express onboarding (#11).
//   /dashboard/payouts/stripe/return  — merchant came back: pull API truth, land in the dashboard
//   /dashboard/payouts/stripe/refresh — expired/invalid link: mint a fresh one, bounce to Stripe
// The dashboard session cookie authenticates both (top-level GET on our origin);
// no nonce needed — nothing here trusts query params.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { onboardingOrigin, startOnboarding, syncAccountStatus } from "~/lib/payments/connect.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);
  const leg = params["*"];

  if (leg === "return") {
    await syncAccountStatus(session.shopId);
    return redirect("/dashboard?payouts=updated");
  }
  if (leg === "refresh") {
    const { url } = await startOnboarding(session.shopId, onboardingOrigin(request));
    return redirect(url);
  }
  throw new Response("Not found", { status: 404 });
};
