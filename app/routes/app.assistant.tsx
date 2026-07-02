// Resource route (no UI): the slideout's backend. loader = history, action = one turn.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { authenticate } from "../shopify.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { listConversations, getMessages } from "~/lib/assistant/conversations.server";
import { parseAssistantRequest } from "~/lib/assistant/request.server";
import { AssistantTurnError, runConversationTurn } from "~/lib/assistant/turn.server";
import type { ChatMessage, ConversationSummary } from "~/lib/assistant/types";

type LoaderPayload = {
  conversations: ConversationSummary[];
  conversationId: string | null;
  messages: ChatMessage[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requested = url.searchParams.get("conversationId");
  const conversations = await listConversations(session.shop);
  const conversationId = requested ?? conversations[0]?.id ?? null;
  const messages = conversationId ? await getMessages(session.shop, conversationId) : [];
  return json<LoaderPayload>({ conversations, conversationId, messages });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = parseAssistantRequest(form);
  if (!parsed.ok) {
    return json({ error: { code: parsed.code, message: parsed.message } }, { status: 400 });
  }

  try {
    const { conversationId, assistantMessage } = await runConversationTurn({
      shopDomain: session.shop,
      message: parsed.value.message,
      conversationId: parsed.value.conversationId,
      deps: {
        flagAlert: async (alertId) =>
          acknowledgeAlert(getSupabase(), await resolveShopId(session.shop), alertId),
      },
    });
    return json({
      conversationId,
      assistantMessage,
      draftedAction: assistantMessage.draftedAction,
    });
  } catch (err) {
    if (err instanceof AssistantTurnError) {
      return json(
        {
          conversationId: err.conversationId,
          error: { code: "ASSISTANT_ERROR", message: err.message },
        },
        { status: 502 },
      );
    }
    throw err;
  }
};
