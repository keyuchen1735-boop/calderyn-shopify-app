// app/routes/dashboard.api.designer.tsx
// Chat endpoint for the from-scratch designer engine (hidden Labs). One POST
// per merchant message; the server decides whether it's the first build
// (attach to a template) or a direct edit turn on the existing documents.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { quotaTrusted } from "~/lib/ai-quota.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { designerTurn } from "~/lib/designer/engine.server";
import type { DesignerRoute } from "~/lib/designer/types";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";

export const config = { maxDuration: 300 };

const MESSAGE_MAX = 4_000;
const ROUTES = new Set(["home", "collection", "product", "search", "cart"]);

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonError(422, "invalid_body");
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_body");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MESSAGE_MAX) {
    return jsonError(422, "invalid_message", "Describe the change in up to 4,000 characters.");
  }
  if (body.model !== undefined && body.model !== "sonnet" && body.model !== "opus") {
    return jsonError(422, "invalid_model", "Model must be sonnet or opus.");
  }
  if (body.page !== undefined && (typeof body.page !== "string" || !ROUTES.has(body.page))) {
    return jsonError(422, "invalid_page");
  }

  const settings = await getStoreSettings(session.shopId);
  if (!settings.composerEnabled) {
    return jsonError(409, "designer_disabled", "The designer engine is not enabled for this store.");
  }
  if (!(await rateLimit(`designer-chat:${session.shopId}`, 20, 60_000))) {
    return jsonError(429, "rate_limited", "Too many designer messages. Please wait a moment.");
  }
  await assertCanGenerate(session.shopId, message, { trusted: quotaTrusted(session) });

  return dashboardJson(() => designerTurn({
    shopId: session.shopId,
    message,
    route: body.page as DesignerRoute | undefined,
    model: body.model as StudioDesignModel | undefined,
    signal: request.signal,
  }));
}
