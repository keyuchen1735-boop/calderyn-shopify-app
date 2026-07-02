// GET → conversation history; POST { message, conversation_id? } → one
// assistant turn. Same brain as the embedded slideout (shared
// app/lib/assistant/turn.server.ts); auth is the dashboard cookie session
// instead of Shopify admin, and the envelope follows the dashboard API's
// snake_case.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, jsonOk, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import { getSupabase } from "~/lib/supabase.server";
import { listConversations, getMessages } from "~/lib/assistant/conversations.server";
import { validateAssistantInput } from "~/lib/assistant/request.server";
import { AssistantTurnError, runConversationTurn } from "~/lib/assistant/turn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const url = new URL(request.url);
    const requested = url.searchParams.get("conversation_id");
    const conversations = await listConversations(session.shopId);
    const conversationId = requested ?? conversations[0]?.id ?? null;
    const messages = conversationId
      ? await getMessages(session.shopId, conversationId)
      : [];
    return { conversations, conversation_id: conversationId, messages };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  // Each turn is a paid Anthropic call; cap per shop to bound LLM spend abuse.
  if (!(await rateLimit(`assistant:${session.shopId}`, 10, 60_000))) {
    return jsonError(429, "rate_limited", "Too many messages. Please wait a moment.");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const parsed = validateAssistantInput(body.message, body.conversation_id);
  if (!parsed.ok) return jsonError(422, parsed.code.toLowerCase(), parsed.message);

  return dashboardJson(async () => {
    try {
      const { conversationId, assistantMessage } = await runConversationTurn({
        shopDomain: session.shopId,
        message: parsed.value.message,
        conversationId: parsed.value.conversationId,
        deps: {
          flagAlert: (alertId) => acknowledgeAlert(getSupabase(), session.shopId, alertId),
        },
      });
      return { conversation_id: conversationId, message: assistantMessage };
    } catch (err) {
      if (err instanceof AssistantTurnError) {
        // Thrown Responses pass through dashboardJson untouched (same pattern
        // as requireDashboardSession's 401). The conversation_id rides along
        // so the client retries into the same thread.
        throw jsonOk(
          { error: "assistant_error", message: err.message, conversation_id: err.conversationId },
          { status: 502 },
        );
      }
      throw err;
    }
  });
}
