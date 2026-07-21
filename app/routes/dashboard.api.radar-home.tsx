// app/routes/dashboard.api.radar-home.tsx
// Home "moves ready" card data (journey-card pattern: loader = data +
// dismissed flag, action = dismiss intent persisted server-side). The card
// self-revives when a move newer than the dismissal is drafted, and the Home
// screen hides it at readyCount 0.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listMoves, readRadarState, stampRadarState } from "~/lib/radar/store.server";
import { isUuid } from "~/lib/ids";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    if (!isUuid(session.shopId)) return { readyCount: 0, dismissed: false };
    const [moves, state] = await Promise.all([
      listMoves(session.shopId, ["draft"]),
      readRadarState(session.shopId),
    ]);
    const newest = moves[0]?.createdAt ?? null; // listMoves orders created_at desc
    const dismissed = Boolean(
      state.homeCardDismissedAt && (!newest || state.homeCardDismissedAt >= newest),
    );
    return { readyCount: moves.length, dismissed };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const body = await parseJsonObjectBody(request);
  if (!body || body.intent !== "dismiss") return jsonError(422, "invalid_intent");
  return dashboardJson(async () => {
    await stampRadarState(session.shopId, { homeCardDismissedAt: new Date().toISOString() });
    return { ok: true };
  });
}
