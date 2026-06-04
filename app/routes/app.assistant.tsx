// Resource route (no UI): the slideout's backend. loader = history, action = one turn.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";
import { buildSnapshot } from "~/lib/assistant/snapshot.server";
import { buildSystemPrompt } from "~/lib/assistant/prompt.server";
import { ASSISTANT_TOOLS, makeToolDispatcher } from "~/lib/assistant/tools.server";
import { runAssistantTurn } from "~/lib/assistant/loop.server";
import {
  appendMessage,
  createConversation,
  getMessages,
  listConversations,
} from "~/lib/assistant/conversations.server";
import { parseAssistantRequest } from "~/lib/assistant/request.server";
import type { ChatMessage, ConversationSummary } from "~/lib/assistant/types";
import type Anthropic from "@anthropic-ai/sdk";

const HISTORY_WINDOW = 20;

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
  const { conversationId: incoming, message } = parsed.value;

  const conversationId =
    incoming ?? (await createConversation(session.shop, message.slice(0, 80)));

  // History BEFORE this message (model context), then persist the user turn.
  const prior = await getMessages(session.shop, conversationId);
  await appendMessage(session.shop, conversationId, { role: "user", content: message });

  const history: Anthropic.MessageParam[] = prior
    .slice(-HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }));

  const client = calderynClient(session.shop);
  const snapshot = await buildSnapshot(client);

  let result;
  try {
    const anthropic = getAnthropic();
    result = await runAssistantTurn({
      createMessage: (params) => anthropic.messages.create(params),
      model: assistantModel(),
      system: buildSystemPrompt(snapshot),
      tools: ASSISTANT_TOOLS,
      dispatchTool: makeToolDispatcher(client),
      history,
      userMessage: message,
    });
  } catch (err) {
    const e = err as { message?: string };
    // User turn already saved; do not persist a broken assistant turn (clean retry).
    console.error("[assistant] turn failed", { shop: session.shop, conversationId, message: e.message });
    return json(
      {
        conversationId,
        error: { code: "ASSISTANT_ERROR", message: e.message ?? "Could not reach Claude" },
      },
      { status: 502 },
    );
  }

  const assistantMessage = await appendMessage(session.shop, conversationId, {
    role: "assistant",
    content: result.text,
    draftedAction: result.draftedAction,
  });

  return json({ conversationId, assistantMessage, draftedAction: result.draftedAction });
};
