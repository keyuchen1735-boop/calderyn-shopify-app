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
