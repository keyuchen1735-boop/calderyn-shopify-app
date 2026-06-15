// app/lib/pilot-invite/validate.ts
// Validates the send-invite request body at the action boundary (never trust input).
// API JSON is snake_case (matches `waitlist`/merge-tag naming); internal type is camelCase.

export interface InviteInput {
  email: string;       // lowercased
  firstName: string;
  storeName: string;
  skipIfInvited: boolean;
}

export type ParseResult = { ok: true; value: InviteInput } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseInviteInput(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body: expected a JSON object" };
  const b = body as Record<string, unknown>;

  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "email: invalid" };

  const firstName = typeof b.first_name === "string" ? b.first_name.trim() : "";
  if (!firstName || firstName.length > 80) return { ok: false, error: "first_name: required, max 80 chars" };

  const storeName = typeof b.store_name === "string" ? b.store_name.trim() : "";
  if (!storeName || storeName.length > 120) return { ok: false, error: "store_name: required, max 120 chars" };

  return { ok: true, value: { email: email.toLowerCase(), firstName, storeName, skipIfInvited: b.skip_if_invited === true } };
}
