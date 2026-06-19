// app/lib/linkedin-digest/validate.ts
//
// Validates the payload POSTed to /api/linkedin-digest by the Claude cloud
// routine "Daily LinkedIn Post Writer". The routine writes the day's LinkedIn
// posts and hands them here so the endpoint can send them via Resend (the
// RESEND_API_KEY never leaves the server).
//
// Recipients are restricted to the calderyncompany.com domain: even though the
// endpoint is bearer-protected, this fails closed so a leaked
// LINKEDIN_DIGEST_SECRET can never be used to relay mail to arbitrary inboxes.

export interface DigestEmail {
  to: string;
  subject: string;
  text: string;
}

export type ParseResult =
  | { ok: true; value: { emails: DigestEmail[] } }
  | { ok: false; error: string };

const ALLOWED_DOMAIN = "@calderyncompany.com";
const MAX_EMAILS = 5;
const MAX_SUBJECT = 200;
const MAX_TEXT = 20_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseDigestInput(body: unknown): ParseResult {
  if (!isRecord(body)) return { ok: false, error: "body: expected an object" };
  const { emails } = body;
  if (!Array.isArray(emails)) return { ok: false, error: "emails: expected an array" };
  if (emails.length === 0) return { ok: false, error: "emails: must not be empty" };
  if (emails.length > MAX_EMAILS) return { ok: false, error: `emails: at most ${MAX_EMAILS}` };

  const value: DigestEmail[] = [];
  for (let i = 0; i < emails.length; i++) {
    const e: unknown = emails[i];
    if (!isRecord(e)) return { ok: false, error: `emails[${i}]: expected an object` };

    const { to, subject, text } = e;
    if (typeof to !== "string" || !to.trim()) return { ok: false, error: `emails[${i}].to: required string` };
    const toNorm = to.trim().toLowerCase();
    // Single-address shape only: no spaces, commas, or extra "@" (blocks header
    // injection and multi-recipient smuggling).
    if (!/^[^\s@,]+@[^\s@,]+$/.test(toNorm)) {
      return { ok: false, error: `emails[${i}].to: not a valid single email address` };
    }
    if (!toNorm.endsWith(ALLOWED_DOMAIN)) {
      return { ok: false, error: `emails[${i}].to: recipient must be a ${ALLOWED_DOMAIN} address` };
    }
    if (typeof subject !== "string" || !subject.trim()) return { ok: false, error: `emails[${i}].subject: required string` };
    if (subject.length > MAX_SUBJECT) return { ok: false, error: `emails[${i}].subject: too long (max ${MAX_SUBJECT})` };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: `emails[${i}].text: required string` };
    if (text.length > MAX_TEXT) return { ok: false, error: `emails[${i}].text: too long (max ${MAX_TEXT})` };

    value.push({ to: to.trim(), subject: subject.trim(), text });
  }
  return { ok: true, value: { emails: value } };
}
