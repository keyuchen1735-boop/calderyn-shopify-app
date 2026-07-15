import { json, type ActionFunctionArgs } from "@remix-run/node";

import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { recordProductTourOutcome } from "~/lib/dashboard/product-tour.server";
import type { ProductTourOutcome } from "~/lib/dashboard/product-tour";

function isOutcome(value: unknown): value is ProductTourOutcome {
  return value === "complete" || value === "skip";
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const session = await requireDashboardSession(request);
  if (!session.userId) {
    return jsonError(
      400,
      "not_first_party",
      "This account does not use the product tour.",
    );
  }

  const body = (await request.json().catch(() => null)) as {
    intent?: unknown;
  } | null;
  if (!isOutcome(body?.intent)) return jsonError(400, "invalid_intent");

  try {
    await recordProductTourOutcome(session.userId, body.intent);
  } catch (error) {
    console.error("[product-tour] outcome write failed", error);
    return jsonError(
      500,
      "save_failed",
      "Your tour choice could not be saved.",
    );
  }

  return json({ ok: true });
}
