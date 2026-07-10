import type { ConversationSummary } from "./types";

export interface ParsedAssistantRequest {
  conversationId: string | null;
  message: string;
}

export type ParseResult =
  | { ok: true; value: ParsedAssistantRequest }
  | { ok: false; code: string; message: string };

const MAX_MESSAGE_LEN = 4000;

/** Shared validation core: the slideout posts FormData, the dashboard JSON. */
export function validateAssistantInput(
  rawMessage: unknown,
  rawConversationId: unknown,
): ParseResult {
  const message = String(rawMessage ?? "").trim();
  if (!message) return { ok: false, code: "MESSAGE_REQUIRED", message: "Message is required" };
  if (message.length > MAX_MESSAGE_LEN) {
    return {
      ok: false,
      code: "MESSAGE_TOO_LONG",
      message: `Message must be ${MAX_MESSAGE_LEN} characters or fewer`,
    };
  }
  const cid = String(rawConversationId ?? "").trim();
  return { ok: true, value: { conversationId: cid || null, message } };
}

export function parseAssistantRequest(form: FormData): ParseResult {
  return validateAssistantInput(form.get("message"), form.get("conversationId"));
}

// A thread untouched for a workday-plus reads as a new visit to the merchant;
// resuming it silently would make stale advice look current, so we start a
// fresh chat instead once a conversation has been idle this long.
export const RESUME_WINDOW_MS = 8 * 60 * 60 * 1000;

/**
 * Which conversation (if any) the assistant panel should resume on open.
 * An explicit `requested` id (deep link) always wins, even if that
 * conversation is stale. Otherwise the most recent conversation resumes only
 * if it was touched within RESUME_WINDOW_MS of `now`; older threads are left
 * alone in the DB and the panel opens to a fresh, empty chat.
 */
export function pickActiveConversation(
  conversations: ConversationSummary[],
  requested: string | null,
  now: Date,
): string | null {
  if (requested) return requested;
  const latest = conversations[0];
  if (!latest) return null;
  const age = now.getTime() - new Date(latest.updatedAt).getTime();
  return age <= RESUME_WINDOW_MS ? latest.id : null;
}
