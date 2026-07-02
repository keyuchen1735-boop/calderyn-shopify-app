// Browser-facing legs of Stripe-hosted Express onboarding (#11).
//   /dashboard/payouts/stripe/return  — merchant came back: pull API truth, land in the dashboard
//   /dashboard/payouts/stripe/refresh — expired/invalid link: mint a fresh one, bounce to Stripe
// The dashboard session cookie authenticates both (top-level GET on our origin);
// no nonce needed — nothing here trusts query params.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  getConnectedAccount,
  onboardingOrigin,
  startOnboarding,
  syncAccountStatus,
} from "~/lib/payments/connect.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);
  const leg = params["*"];

  if (leg === "return") {
    // Best-effort: a Stripe blip at redirect-return time must not error-page the
    // merchant at the flow's highest-visibility moment — Settings re-syncs on load.
    try {
      await syncAccountStatus(session.shopId);
    } catch (err) {
      console.warn(
        `[stripe-connect] return-leg status sync failed for shop ${session.shopId}: ${(err as Error).message}`,
      );
    }
    return redirect("/dashboard?payouts=updated");
  }
  if (leg === "refresh") {
    // A refresh URL only exists inside a link minted AFTER the row was created,
    // so a missing row means this GET is not a real Stripe callback (bookmark,
    // prefetch, scanner) — never CREATE an account from a GET; provisioning
    // belongs to the POST intent on dashboard.api.billing.
    const acct = await getConnectedAccount(session.shopId);
    if (!acct) return redirect("/dashboard");
    const { url } = await startOnboarding(session.shopId, onboardingOrigin(request));
    return redirect(url);
  }
  throw new Response("Not found", { status: 404 });
};
