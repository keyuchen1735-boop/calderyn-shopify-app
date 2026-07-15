// Guided-journey progress for the dashboard Home setup card. GET returns the
// merchant's milestone completion state; POST {intent} dismisses one of the
// two one-shot cards (the "you're live" banner and the setup recap).

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  getJourneyProgress,
  dismissJourneyCard,
  setJourneyActiveStep,
} from "~/lib/onboarding/journey.server";
import { isMilestoneKey } from "~/lib/dashboard/journey-model";

// Loader note: getJourneyProgress materializes derived milestone rows
// (insert-only, idempotent). This is lazy cache-fill of derived state, not a
// user-data mutation — the documented exception to loaders-read-only.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => getJourneyProgress(session.shopId));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (body === null) return jsonError(400, "bad_body");
  if (
    body.intent !== "dismiss_live_card" &&
    body.intent !== "dismiss_recap" &&
    body.intent !== "set_active_step"
  ) {
    return jsonError(422, "invalid_intent");
  }
  const intent = body.intent;

  if (intent === "set_active_step") {
    const step = body.step;
    if (!isMilestoneKey(step)) return jsonError(422, "invalid_step");
    return dashboardJson(async () => {
      await setJourneyActiveStep(session.shopId, step);
      return { ok: true };
    });
  }

  return dashboardJson(async () => {
    await dismissJourneyCard(
      session.shopId,
      intent === "dismiss_live_card" ? "live_card_dismissed" : "recap_dismissed",
    );
    return { ok: true };
  });
}
