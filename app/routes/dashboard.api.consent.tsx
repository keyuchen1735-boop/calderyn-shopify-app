// Peer-baseline consent for the web dashboard. GET returns the current value;
// PUT sets it. Mirrors the embedded Settings consent toggle — both flow through
// calderynClient.consent, which is the single writer of shops.peer_data_consent
// that the engine's moat emitter reads.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    consent: await calderynClient(session.shopDomain).consent.get(),
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  if (typeof body.consent !== "boolean") return jsonError(422, "invalid_consent");

  await calderynClient(session.shopDomain).consent.set(body.consent);
  return dashboardJson(async () => ({ consent: body.consent as boolean }));
}
