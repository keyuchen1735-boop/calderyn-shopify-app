export interface ParsedAssistantRequest {
  conversationId: string | null;
  message: string;
}

export type ParseResult =
  | { ok: true; value: ParsedAssistantRequest }
  | { ok: false; code: string; message: string };

const MAX_MESSAGE_LEN = 4000;

export function parseAssistantRequest(form: FormData): ParseResult {
  const message = String(form.get("message") ?? "").trim();
  if (!message) return { ok: false, code: "MESSAGE_REQUIRED", message: "Message is required" };
  if (message.length > MAX_MESSAGE_LEN) {
    return {
      ok: false,
      code: "MESSAGE_TOO_LONG",
      message: `Message must be ${MAX_MESSAGE_LEN} characters or fewer`,
    };
  }
  const cid = String(form.get("conversationId") ?? "").trim();
  return { ok: true, value: { conversationId: cid || null, message } };
}
