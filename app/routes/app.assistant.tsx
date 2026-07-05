// Resource route (no UI): the slideout's backend. loader = history, action = one turn.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { rateLimit } from "~/lib/rate-limit.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { listConversations, getMessages } from "~/lib/assistant/conversations.server";
import { parseAssistantRequest } from "~/lib/assistant/request.server";
import { AssistantTurnError, runConversationTurn } from "~/lib/assistant/turn.server";
import { checkAiQuota } from "~/lib/ai-quota.server";
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
  // Each turn is a paid Anthropic call; cap per shop to bound LLM spend abuse.
  if (!(await rateLimit(`assistant:${session.shop}`, 10, 60_000))) {
    return json(
      { error: { code: "RATE_LIMITED", message: "Too many messages. Please wait a moment." } },
      { status: 429 },
    );
  }
  const form = await request.formData();
  const parsed = parseAssistantRequest(form);
  if (!parsed.ok) {
    return json({ error: { code: parsed.code, message: parsed.message } }, { status: 400 });
  }
  // Daily cap + cooldown, keyed by shop UUID so both assistant surfaces share
  // one allowance; checked after validation so rejected requests never burn
  // the day's allowance. Installed Shopify shops are trusted tier by
  // construction.
  let quotaKey = session.shop;
  try {
    quotaKey = await resolveShopId(session.shop);
  } catch {
    // Transient mapping failure: fall back to the domain key rather than
    // blocking the turn (the limiter itself also fails open by design).
  }
  const quota = await checkAiQuota({ shopId: quotaKey, feature: "assistant", trusted: true });
  if (!quota.allowed) {
    return json(
      { error: { code: quota.code.toUpperCase(), message: quota.message } },
      { status: 429 },
    );
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
