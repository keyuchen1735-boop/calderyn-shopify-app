// One full assistant conversation turn for a shop: create/validate the
// conversation, persist the user message, run the tool loop, persist the
// reply. Shared by the embedded slideout route (app/routes/app.assistant.tsx)
// and the dashboard API route (app/routes/dashboard.api.assistant.tsx) so the
// two surfaces cannot drift.
import type Anthropic from "@anthropic-ai/sdk";
import { calderynClient } from "../calderyn.server";
import { getAnthropic, assistantModel } from "./anthropic.server";
import { buildSnapshot } from "./snapshot.server";
import { buildSystemPrompt } from "./prompt.server";
import { ASSISTANT_TOOLS, READ_TOOLS, makeToolDispatcher, type ToolDispatcherDeps } from "./tools.server";
import { runAssistantTurn } from "./loop.server";
import { appendMessage, createConversation, getMessages } from "./conversations.server";
import type { ChatMessage } from "./types";

const HISTORY_WINDOW = 20;

/**
 * The Claude call failed AFTER the user turn was persisted. Carries the
 * conversation id so callers can hand it back and retries stay in-thread.
 */
export class AssistantTurnError extends Error {
  readonly conversationId: string;

  constructor(message: string, conversationId: string) {
    super(message);
    this.name = "AssistantTurnError";
    this.conversationId = conversationId;
  }
}

export interface ConversationTurnInput {
  shopDomain: string;
  message: string;
  conversationId: string | null;
  deps?: ToolDispatcherDeps;
  /**
   * Opts into the write-tool registry (actionCtx + registry tool names
   * advertised to the model). The registry is dashboard-only: the legacy
   * embedded surface (app/routes/app.assistant.tsx) receives a shop DOMAIN,
   * not a session-derived shop id, and must never be able to execute writes.
   * Its calls must never set this — default is false/unset, which keeps
   * actionCtx unbuilt and drops write tools from the advertised toolset.
   */
  allowActions?: boolean;
}

export interface ConversationTurnResult {
  conversationId: string;
  assistantMessage: ChatMessage;
}

export async function runConversationTurn(
  input: ConversationTurnInput,
): Promise<ConversationTurnResult> {
  const { shopDomain, message } = input;
  const conversationId =
    input.conversationId ?? (await createConversation(shopDomain, message.slice(0, 80)));

  // History BEFORE this message (model context). The user turn is persisted only AFTER a
  // successful turn (below), never before the Claude call: persisting it up front left an
  // orphaned, unanswered user row on failure, so a retry into the same conversation (the
  // route hands conversationId back for exactly that) re-appended the message and sent two
  // consecutive user-role turns to the Messages API.
  const prior = await getMessages(shopDomain, conversationId);

  const history: Anthropic.MessageParam[] = prior
    .slice(-HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }));

  const client = calderynClient(shopDomain);
  const snapshot = await buildSnapshot(client);

  const allowActions = input.allowActions === true;

  let result;
  try {
    const anthropic = getAnthropic();
    result = await runAssistantTurn({
      createMessage: (params) => anthropic.messages.create(params),
      model: assistantModel(),
      system: buildSystemPrompt(snapshot),
      tools: allowActions ? ASSISTANT_TOOLS : READ_TOOLS,
      dispatchTool: makeToolDispatcher(client, {
        ...input.deps,
        ...(allowActions ? { actionCtx: { shopId: shopDomain, conversationId } } : {}),
      }),
      history,
      userMessage: message,
    });
  } catch (err) {
    const e = err as { message?: string };
    // Nothing was persisted this turn (the user turn is saved only on success, below), so a
    // retry into the same conversation starts clean — no duplicated/unanswered user row.
    console.error("[assistant] turn failed", {
      shop: shopDomain,
      conversationId,
      message: e.message,
    });
    throw new AssistantTurnError(e.message ?? "Could not reach Claude", conversationId);
  }

  // The turn succeeded. When allowActions is set, execute-tier registry actions may have
  // ALREADY committed real side effects (a paused campaign, a price change) inside
  // runAssistantTurn, so a persistence failure here must never surface as a failed turn and
  // hide them (same stance the confirm route takes). Persist the user turn, then the assistant
  // reply; on a reply-persist failure, log loudly and return the receipts anyway.
  try {
    await appendMessage(shopDomain, conversationId, { role: "user", content: message });
  } catch (err) {
    console.error("[assistant] failed to persist user turn after a successful reply", {
      shop: shopDomain,
      conversationId,
    }, err);
  }

  let assistantMessage: ChatMessage;
  try {
    assistantMessage = await appendMessage(shopDomain, conversationId, {
      role: "assistant",
      content: result.text,
      draftedAction: result.draftedAction,
      receipts: result.receipts,
      pendingAction: result.pendingAction,
    });
  } catch (err) {
    console.error(
      "[assistant] failed to persist assistant reply; returning receipts anyway so executed actions aren't reported as failed",
      { shop: shopDomain, conversationId },
      err,
    );
    assistantMessage = {
      id: "",
      role: "assistant",
      content: result.text,
      draftedAction: result.draftedAction ?? null,
      receipts: result.receipts ?? [],
      pendingAction: result.pendingAction ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  return { conversationId, assistantMessage };
}
