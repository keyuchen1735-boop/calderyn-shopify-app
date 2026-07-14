// app/lib/contact/validate.ts
//
// Pure validation for a contact-us message. No I/O, no secrets — trivially
// testable. Mirrors bug-report/validate.ts minus attachments.

export const MAX_MESSAGE_CHARS = 5000;
export const MAX_EMAIL_CHARS = 320;

export interface ValidatedContactMessage {
  message: string;
  senderEmail: string;
}

export type ValidationResult =
  | { ok: true; value: ValidatedContactMessage }
  | { ok: false; code: string; message: string };

// Deliberately simple: one @, a dot in the domain, no spaces. Also excludes
// , and ; because the address becomes the reply_to HEADER of the team email —
// list separators must not smuggle in extra recipients. Not a deliverability
// check — Resend is the real validator.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function validateContactInput(raw: {
  message: unknown;
  email: unknown;
}): ValidationResult {
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    return { ok: false, code: "EMPTY_MESSAGE", message: "Please write a message." };
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, code: "MESSAGE_TOO_LONG", message: "That message is too long." };
  }

  const senderEmail = typeof raw.email === "string" ? raw.email.trim() : "";
  if (!senderEmail) {
    return { ok: false, code: "EMPTY_EMAIL", message: "Please add an email so we can reply." };
  }
  if (senderEmail.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(senderEmail)) {
    return { ok: false, code: "INVALID_EMAIL", message: "That email doesn't look right." };
  }

  return { ok: true, value: { message, senderEmail } };
}
